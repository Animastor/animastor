# Аудит временных файлов ComfyUI в worker

> Полный аудит lifecycle временных файлов ComfyUI (input/output), создаваемых
> worker.cjs при генерации image / audio / video. Исследование проведено
> перед реализацией cleanup after job.
>
> **Read-only**: ничего не исправлялось. Основан на чтении исходного кода.
> Дата: 2026-08-24. Ветка: `master` (`90b9d22`).
>
> ## Статус реализации
>
> Аудит реализован в двух коммитах:
> - **`b860162`** — per-job точечный cleanup (`cleanupJobArtifacts`, try/finally):
>   input+output удаляются после успешной доставки результата.
> - **`e874761`** — crash-safe recovery через worker-local journal
>   (`worker-cleanup-journal.cjs`): lifecycle CREATED→GENERATED→DELIVERED→CLEANED
>   сохраняется на persistent-диске worker'а; при restart `recoverCleanupJournal()`
>   дочищает файлы job, результат которой уже доставлен в hub (delivered), и
>   убирает input-файлы недоставленных job (output сохраняется). Детали — в
>   `COMFYUI_CLEANUP_RECOVERY_AUDIT.md` и самом коде.

---

## 1. Исполнители

**Один универсальный worker**: `worker/worker/worker.cjs` (657 строк, CJS).

Тип задаётся `WORKER_TYPE` (image | audio | video) и влияет только на:
- таймауты (`VIDEO_RESULT_TIMEOUT_MS` vs `RESULT_TIMEOUT_MS`);
- логику поиска результата в `waitResult` (fs-scan для video).

Отдельных worker-файлов под каждый тип нет.

---

## 2. Конфигурация путей

| Переменная | Значение по умолчанию | Назначение |
|---|---|---|
| `COMFY_INPUT_DIR` | `/home/jovyan/ComfyUI/input` | Куда worker кладёт reference images |
| `COMFY_OUTPUT_DIR` | `path.resolve(COMFY_INPUT_DIR, "../output")` | Откуда worker читает результаты |

---

## 3. Полный lifecycle задачи

### 3.1 Image (IU Image)

```
Job received (task.assets.image: base64)
  → saveBase64ImageSafe(base64, "{baseId}.png") → COMFY_INPUT_DIR/{baseId}.png
  → waitForFileReady(inputPath, expectedSize)
  → runWorkflow(task.params) → ComfyUI /prompt → prompt_id
  → waitResult(prompt_id)
      → /history/{prompt_id} → outputs[SaveImage].images[0] → {filename, subfolder: "", type}
  → downloadResult(meta)
      → читает COMFY_OUTPUT_DIR/{filename} (локально, OOM-safe)
      → base64 → data URL
  → sendResult(task, base64) → hub → backend
      → backend пишет в /data/output/{buildId}/{bookId}_{chapterId}_{sceneId}_{iuId}.png
  → Done
```

**Input-файл**: `COMFY_INPUT_DIR/{baseId}.png`  
**Output-файл**: `COMFY_OUTPUT_DIR/ComfyUI_XXXXX_.png`  
**Backend-файл**: `/data/output/{buildId}/{bookId}_{chapterId}_{sceneId}_{iuId}.png`

### 3.2 Audio (Audio Chunk)

```
Job received (no assets)
  → runWorkflow(task.params) → ComfyUI /prompt → prompt_id
  → waitResult(prompt_id)
      → /history/{prompt_id} → outputs[SaveAudioMP3].audio → {filename, subfolder: "audio", type}
  → downloadResult(meta)
      → читает COMFY_OUTPUT_DIR/audio/{filename}
      → base64 → data URL
  → sendResult(task, base64) → hub → backend
      → backend пишет в /data/output/{buildId}/{bookId}_{chapterId}_{sceneId}_{chunkIndex}.mp3
  → Done
```

**Input-файл**: нет  
**Output-файл**: `COMFY_OUTPUT_DIR/audio/tts_XXXXX_.mp3` или `COMFY_OUTPUT_DIR/audio/dialogue_XXXXX_.mp3`

### 3.3 Video (Scene Video, multi-image I2V)

```
Job received (task.assets.images: { [unitId]: base64 })
  → для каждого unitId: saveBase64ImageSafe(base64, "{scenePrefix}_{unitId}.png")
      → COMFY_INPUT_DIR/{scenePrefix}_{unitId}.png  (×N)
  → waitForFileReady для каждого
  → runWorkflow(task.params) → ComfyUI /prompt → prompt_id
  → waitResult(prompt_id)
      → 1) /history → outputs[SaveVideo].videos[0].filename
      → или 2) outputs[*].[*].filename where .endsWith('.mp4')
      → или 3) fs-scan: output/video/ → новые .mp4 → фильтр по prefix "LTX-2"
  → downloadResult(meta)
      → читает COMFY_OUTPUT_DIR/video/{filename}
      → base64 → data URL
  → sendResult(task, base64) → hub → backend
      → backend пишет в /data/output/{buildId}/{bookId}_{chapterId}_{sceneId}_gN.mp4
  → Done
```

**Input-файлы**: `COMFY_INPUT_DIR/{scenePrefix}_{unitId}.png` (столько же, сколько IU)  
**Output-файл**: `COMFY_OUTPUT_DIR/video/LTX-2_XXXXX_.mp4`  
**Backend-файл**: `/data/output/{buildId}/{bookId}_{chapterId}_{sceneId}_gN.mp4`

---

## 4. Формирование имён файлов в input

```js
// job_id examples:
//   "bookId_chapterId_sceneId_iu1:iu_image"  — IU image
//   "bookId_chapterId_sceneId_0001:audio"     — audio chunk
//   "bookId_chapterId_sceneId_g1:video"      — video group

// Базовый ID (без суффикса типа):
const [baseId] = task.job_id.split(/:(iu_image|image|audio|video)$/);

// Для multi-image (video) — срезается _gN суффикс группы:
const scenePrefix = baseId.replace(/_g\d+$/, '');

// Итоговое имя файла в input:
//   single image:  "{baseId}.png"
//   multi-image:   "{scenePrefix}_{unitId}.png"
```

Input-имена содержат `job_id` → уникальны per task.

---

## 5. Определение output-файла

### Image
`/history/{prompt_id}` → `outputs[nodeId].images[0]`:
```json
{ "filename": "ComfyUI_00001_.png", "subfolder": "", "type": "output" }
```
→ `COMFY_OUTPUT_DIR/ComfyUI_00001_.png`

### Audio
`/history/{prompt_id}` → `outputs[nodeId].audio`:
```json
{ "filename": "tts_00001_.mp3", "subfolder": "audio", "type": "output" }
```
→ `COMFY_OUTPUT_DIR/audio/tts_00001_.mp3`

### Video (3 механизма)
1. `/history` → `outputs[nodeId].videos[0].filename`:
   ```json
   { "filename": "LTX-2_00001_.mp4", "subfolder": "video", "type": "output" }
   ```
2. Fallback: `outputs[*].[*].filename` где `.endsWith('.mp4')`
3. Fs-scan: `output/video/` → новые `.mp4` → `prefix` = `path.basename("video/LTX-2")` = `"LTX-2"`

---

## 6. Что удаляется сейчас

**Worker.cjs: НИЧЕГО.** Ни input, ни output не удаляются ни после успеха, ни после ошибки, ни в `finally`.

**Backend (не относится к ComfyUI):**
- `cleanupService.cleanupBuild(buildId)` — удаляет `/data/output/{buildId}` целиком (REST API / регенерация / reconciliation).
- Pre-delete stale PNG при dirty-регенерации (`iu-processor.js:145-163`, `scene-orchestrator.js:381-387`).

**Итог**: каждая задача оставляет после себя на диске worker-машины:
- 1 PNG в `input/` (image) или N PNG (video multi-image)
- 1 PNG/MP3/MP4 в `output/` (или `output/audio/`, `output/video/`)

Мусор накапливается бесконечно.

---

## 7. Output-файлы: формат и subfolder

| Тип | Node | filename_prefix | Фактический путь | subfolder |
|---|---|---|---|---|
| Image | `SaveImage` | `ComfyUI` | `output/ComfyUI_XXXXX_.png` | `""` |
| Audio | `SaveAudioMP3` | `audio/tts` | `output/audio/tts_XXXXX_.mp3` | `audio` |
| Audio (dialogue) | `SaveAudioMP3` | `audio/dialogue` | `output/audio/dialogue_XXXXX_.mp3` | `audio` |
| Video | `SaveVideo` | `video/LTX-2` | `output/video/LTX-2_XXXXX_.mp4` | `video` |

---

## 8. Конкуренция и безопасность имён

| Сценарий | Риск | Комментарий |
|---|---|---|
| Один worker, последовательные задачи | Нет | Worker.cjs обрабатывает задачи в цикле, по одной. Имена содержат job_id → уникальны. |
| Два worker на одной машине | Нет | Каждый — отдельный процесс с уникальным job_id. |
| image + video worker на одной ComfyUI | Нет | Разные имена файлов (разные unitId). |
| Две задачи с одинаковым job_id | Нет | job_id уникален — содержит bookId + chapterId + sceneId + chunkIndex/IUId. |
| Worker restart во время задачи | Да | Orphaned файлы остаются. Не критично, но накапливается. |
| Одна задача, несколько групп (video _g1, _g2) | Нет | Каждая группа — отдельный job с уникальным job_id. |

---

## 9. Обработка ошибок

| Ситуация | Что происходит | Output существует? | Cleanup нужен |
|---|---|---|---|
| ComfyUI error (no prompt_id) | `runWorkflow` → throw | Нет | Input cleanup |
| Timeout в waitResult | `waitResult` → throw (60s / 2h) | Возможно частично | Input cleanup |
| Output не найден в history | Timeout → throw | Нет | Input cleanup |
| Worker restart | Процесс убит → orphan | Да, всё | Orphan cleanup (startup) |
| Отмена задачи (backend) | Worker узнаёт через timeout | Возможно | Input cleanup |
| Download error | `downloadResult` → throw | Да (ComfyUI создал) | Input + output cleanup |

---

## 10. Предлагаемая архитектура cleanup

### 10.1 Где разместить

В `workerLoop()`, в блоке `try { ... } finally { ... }`:

```js
async function workerLoop() {
  while (true) {
    const task = await getTask();
    // ...
    const createdInputFiles = [];
    let outputFile = null;

    try {
      // save input files → push to createdInputFiles
      if (task.assets?.images) { /* ... push each path */ }
      else if (task.assets?.image) { /* ... push path */ }

      const prompt_id = await runWorkflow(task.params);
      const result = await waitResult(prompt_id, task.params, task.timeout_ms);
      const base64 = await downloadResult(result);

      // remember output for cleanup
      outputFile = {
        path: path.resolve(COMFY_OUTPUT_DIR, result.meta.subfolder || '', result.meta.filename),
        meta: result.meta,
      };

      await sendResult(task, base64);
    } catch (err) {
      await sendTaskError(task, err.message);
    } finally {
      // cleanup input files
      for (const fp of createdInputFiles) {
        await fsp.unlink(fp).catch(() => {});
      }
      // cleanup output file
      if (outputFile) {
        await fsp.unlink(outputFile.path).catch(() => {});
      }
    }
  }
}
```

### 10.2 Что удалять

**Input-файлы**: только те, что worker сам создал (список `createdInputFiles`).  
**Output-файл**: только один конкретный файл, полученный из `downloadResult`.

### 10.3 Чего НЕ делать

- `rm -rf COMFY_INPUT_DIR/*` — удалит чужие файлы (другой worker, другая задача).
- `rm -rf COMFY_OUTPUT_DIR/video/*` — удалит все видео, включая чужие.
- Удалять output до `sendResult` — `sendResult` может упасть, и результат будет потерян.
- Удалять output при ошибке до `downloadResult` — output может не существовать.

### 10.4 Привязка к job

- **Input**: имена содержат `baseId` / `scenePrefix` из `job_id` → уникальны per task.
- **Output**: определяется через `waitResult` → `{filename, subfolder}` → полный путь.
- **Ключевой принцип**: удаляем только то, что сами создали (input) и только то, что сами прочитали (output).

### 10.5 Edge cases

| Edge case | Обработка |
|---|---|
| Файл уже удалён (другим процессом) | `unlink` в `catch` → игнорируем |
| Worker restart во время задачи | Файлы остаются (orphan) — решается startup sweep |
| Два worker на одной машине, одна задача | Невозможно — job_id уникален |
| Output в subfolder `audio` или `video` | Полный путь = `COMFY_OUTPUT_DIR/subfolder/filename` |
| Video multi-image (N input файлов) | Все N запоминаются в `createdInputFiles` |
| Audio (нет input файлов) | `createdInputFiles` пуст → cleanup только output |
| Error после waitResult, до downloadResult | Output существует, но не прочитан. Удалять? **Нет** — если ошибка временная, re-dispatch найдёт файл. |
| Error до waitResult | Output не существует → только input cleanup |

### 10.6 Дополнительно (startup sweep)

При старте worker можно добавить sweep orphaned файлов старше N часов.
Осторожно: sweep должен удалять только файлы, чей `job_id` неактивен (нет в `animastor:running`).
Эта опция — вне рамок cleanup after job, но рекомендуется для production.

### 10.7 Graceful shutdown

При `SIGTERM`/`SIGINT`:
- Удалить input-файлы текущей задачи (если есть).
- Output-файл не трогать — результат может быть полезен для recovery.
- Не ждать завершения генерации.