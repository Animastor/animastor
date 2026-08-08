# Workflows: Animastor

## Общее описание

Workflow в Animastor — это JSON-шаблоны, совместимые с ComfyUI, которые определяют пайплайн GPU-обработки для генерации аудио, изображений и видео. Workflow загружаются из файлов `.json` в директории `/app/ai/workflows/` при старте backend.

## Типы Workflow

| Тип | Файл шаблона | Назначение |
|-----|-------------|------------|
| `tts-qwen-narrator` | `backend/ai/workflows/tts-qwen-narrator.json` | TTS-наррация (один голос) |
| `tts-qwen-dialogue` | `backend/ai/workflows/tts-qwen-dialogue.json` | TTS-диалог (два голоса) |
| `img-qwen-image` | `backend/ai/workflows/img-qwen-image.json` | Генерация изображения |
| `video-ltx-1p` | `backend/ai/workflows/video-ltx-1p.json` | Видео из 1 изображения (LTX) |
| `video-ltx-2p` | `backend/ai/workflows/video-ltx-2p.json` | Видео из 2 изображений (LTX) |
| `video-ltx-3p` | `backend/ai/workflows/video-ltx-3p.json` | Видео из 3 изображений (LTX) |
| `video-ltx-4p` | `backend/ai/workflows/video-ltx-4p.json` | Видео из 4 изображений (LTX) |

## Способ построения

### Workflow Loader (`backend/src/workflows/workflow-loader.js`)

1. При старте backend сканирует `/app/ai/workflows/*.json`
2. Каждый файл загружается как именованный шаблон: `workflows[filenameWithoutExt] = template`
3. API: `getWorkflow(name)` → возвращает **deep clone** шаблона (`JSON.parse(JSON.stringify(template))`)

### Workflow Builders

Каждый тип workflow имеет свой builder-модуль:

**Audio Workflows** (`backend/src/workflows/audio/audio-workflows.js`):
- `buildNarrationTTSWorkflow(text, voiceInstruction)` — заполняет текстовый нод (108) и голосовые инструкции
- `buildDialogueTTSWorkflow(script, c1Voice, c2Voice, c1Role, c2Role)` — настраивает ноды диалога (108, 71, 80, 74)
- `buildNarratorVoice(scene, book)` — извлекает настройки голоса из manifest книги

**Image Workflows** (`backend/src/workflows/image/image-workflows.js`):
- `buildImageWorkflow(prompt, negativePrompt)` — заполняет ноды промпта (108) и негативного промпта (109)

**Video Workflows** (`backend/src/workflows/video/video-workflows.js`):
- `buildVideoWorkflows(sceneData, loadedBook, buildId, workflows)` — главный entry point
- `selectWorkflowGroups(unitCount)` — выбирает шаблоны (1p/2p/3p/4p) в зависимости от количества IU
- `calculateFrames(iuDurations)` — вычисляет индексы кадров с LTX-выравниванием (8n+1)
- `buildVideoPrompt(sceneData, loadedBook, units, iuDurations)` — собирает промпт с персонажами, временем, окружением
- `buildVideoNegativePrompt(sceneData, units)` — собирает негативный промпт

## Механизм исполнения

1. **Service вызывает builder** → получает готовый JSON workflow
2. **Service вызывает `gpu.send(job_id, workflow, type, buildId)`** или `gpu.sendUnified(taskSpec)` → HTTP POST в GPU Hub (3 retries, 30s timeout)
3. **GPU Hub** ставит задачу в Redis-очередь, дедуплицирует (NX EX 3600)
4. **Worker (ESM)** забирает задачу: сначала сохраняет assets (изображения) в COMFY_INPUT_DIR, затем отправляет workflow в ComfyUI (`POST /prompt`)
5. **ComfyUI** выполняет ноды и генерирует результат
6. **Worker** ждёт результат (long polling, timeout 10 min), скачивает base64-результат из ComfyUI, отправляет в GPU Hub
7. **GPU Hub** форвардит результат в backend (5 retries, 500ms delay)
8. **Worker может определять видео через filesystem** (сканирует COMFY_OUTPUT_DIR/video/ для новых .mp4 файлов)

```
Backend Service → [buildWorkflow] → JSON
               → [gpu.send/sendUnified] → GPU Hub → Redis Queue
                                          → Worker → save assets to COMFY_INPUT_DIR
                                          → Worker → ComfyUI POST /prompt
                                          → Worker → poll /history
                                          → Worker → download result base64
                                          → GPU Hub → 5× retry → Backend Task Handler
```

## Multi-image assets

Worker поддерживает загрузку нескольких изображений для LTX-видео:
```
task.assets.images = {
  "unitId_1": "base64...",
  "unitId_2": "base64...",
  ...
}
```
Каждое изображение сохраняется как `<scenePrefix>_<unitId>.png` в COMFY_INPUT_DIR.

## Точки расширения

1. **Новые шаблоны**: положить `.json` файл в `/app/ai/workflows/` → автоматически загрузится
2. **Новые builders**: добавить файл в `backend/src/workflows/<type>/`, зарегистрировать в `index.js`
3. **Новые типы workflow**: добавить `job_type` поддержку в GPU Hub и Worker
4. **Подключение новых workflow**: через `workflow-loader.getWorkflow(name)` + builder

## Жизненный цикл workflow

```
                         ╔══════════════════════╗
                         ║    FILE ON DISK      ║
                         ║  /app/ai/workflows/    ║
                         ╚══════════╤═══════════╝
                                    │ Startup
                                    ▼
                         ╔══════════════════════╗
                         ║   Workflow Loader    ║
                         ║ (deep clone on get)  ║
                         ╚══════════╤═══════════╝
                                    │ getWorkflow(name)
                                    ▼
                         ╔══════════════════════╗
                         ║    Template (JSON)   ║
                         ╚══════════╤═══════════╝
                                    │ builder(params)
                                    ▼
                         ╔══════════════════════╗
                         ║   Filled Workflow    ║
                         ║    (ready to send)   ║
                         ╚══════════╤═══════════╝
                                    │ gpu.send/sendUnified()
                                    ▼
                         ╔══════════════════════╗
                         ║   GPU Hub Queue      ║
                         ║   (dedup: NX EX 3600)║
                         ╚══════════╤═══════════╝
                                    │ Worker pop (poll)
                                    ▼
                         ╔══════════════════════╗
                         ║   ComfyUI Execute    ║
                         ║   (10 min timeout)   ║
                         ╚══════════╤═══════════╝
                                    │ Result
                                    ▼
                         ╔══════════════════════╗
                         ║   Task Completed     ║
                         ║   (5× retry to b/e)  ║
                         ╚══════════════════════╝
```

## Подключение нового workflow

1. Создать JSON-шаблон в `/app/ai/workflows/<name>.json`
2. Перезапустить backend (или reload workflows)
3. Создать builder-функцию (опционально, для параметризации)
4. Использовать через `wfLoader.getWorkflow('<name>')` в нужном сервисе

## Ограничения

- Workflow загружаются только при старте (hot-reload не поддерживается)
- Все workflow специфичны для ComfyUI (не абстрагированы под другие платформы)
- Видео-workflow ограничены: максимум 4 изображения на группу (LTX limitation)
- GPU_TIMEOUT: 10 min (конфигурируется через env)

## Node ID Map

**Image (img-qwen-image):**
- Node 108: положительный промпт
- Node 109: негативный промпт

**Audio TTS:**
- Node 108: текст наррации (narration) / первый голос (dialogue)
- Node 71: второй голос (dialogue)
- Node 80: роль второго голоса (dialogue)
- Node 74: роль первого голоса (dialogue)

**Video (video-ltx-*):**
- Node 112: total frames
- Node 121: положительный промпт
- Node 110: негативный промпт
- Nodes 149, 179, 187, 216: загрузка изображений (load image)
