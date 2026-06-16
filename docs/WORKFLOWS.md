# Workflows: Animastor

## Общее описание

Workflow в Animastor — это JSON-шаблоны, совместимые с ComfyUI, которые определяют пайплайн GPU-обработки для генерации аудио, изображений и видео. Workflow загружаются из файлов `.json` в директории `/data/workflows/` при старте backend.

## Типы Workflow

| Тип | Файл шаблона | Назначение |
|-----|-------------|------------|
| `tts-qwen-narrator` | `data/workflows/tts-qwen-narrator.json` | TTS-наррация (один голос) |
| `tts-qwen-dialogue` | `data/workflows/tts-qwen-dialogue.json` | TTS-диалог (два голоса) |
| `img-qwen-image` | `data/workflows/img-qwen-image.json` | Генерация изображения |
| `video-ltx-1p` | `data/workflows/video-ltx-1p.json` | Видео из 1 изображения (LTX) |
| `video-ltx-2p` | `data/workflows/video-ltx-2p.json` | Видео из 2 изображений (LTX) |
| `video-ltx-3p` | `data/workflows/video-ltx-3p.json` | Видео из 3 изображений (LTX) |
| `video-ltx-4p` | `data/workflows/video-ltx-4p.json` | Видео из 4 изображений (LTX) |

## Способ построения

### Workflow Loader (`backend/src/workflows/workflow-loader.js`)

1. При старте backend сканирует `/data/workflows/*.json`
2. Каждый файл загружается как именованный шаблон: `workflows[filenameWithoutExt] = template`
3. API: `getWorkflow(name)` → возвращает **deep clone** шаблона (изменения не затрагивают оригинал)

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
2. **Service вызывает `gpu.send(jobId, workflow, type, buildId)`** → HTTP POST в GPU Hub
3. **GPU Hub** ставит задачу в Redis-очередь (`animastor:queue:audio|image|video`)
4. **Worker** забирает задачу, отправляет workflow в ComfyUI (`POST /prompt`)
5. **ComfyUI** выполняет ноды и генерирует результат
6. **Worker** скачивает base64-результат (`GET /history`), отправляет в GPU Hub
7. **GPU Hub** форвардит результат обратно в backend

```
Backend Service → [buildWorkflow] → JSON
               → [gpu.send()] → GPU Hub → Redis Queue
                                          → Worker → ComfyUI
                                          → Worker → result base64
                                          → GPU Hub → Backend Task Handler
```

## Точки расширения

1. **Новые шаблоны**: положить `.json` файл в `/data/workflows/` → автоматически загрузится
2. **Новые builders**: добавить файл в `backend/src/workflows/<type>/`, зарегистрировать в `index.js`
3. **Новые типы workflow**: добавить `job_type` поддержку в GPU Hub и Worker
4. **Подключение новых workflow**: через `workflow-loader.getWorkflow(name)` + builder

## Жизненный цикл workflow

```
                         ╔══════════════════════╗
                         ║    FILE ON DISK      ║
                         ║  /data/workflows/    ║
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
                                    │ gpu.send()
                                    ▼
                         ╔══════════════════════╗
                         ║   GPU Hub Queue      ║
                         ╚══════════╤═══════════╝
                                    │ Worker pop
                                    ▼
                         ╔══════════════════════╗
                         ║    ComfyUI Execute   ║
                         ╚══════════╤═══════════╝
                                    │ Result
                                    ▼
                         ╔══════════════════════╗
                         ║   Task Completed     ║
                         ╚══════════════════════╝
```

## Подключение нового workflow

1. Создать JSON-шаблон в `/data/workflows/<name>.json`
2. Перезапустить backend (или reload workflows)
3. Создать builder-функцию (опционально, для параметризации)
4. Использовать через `wfLoader.getWorkflow('<name>')` в нужном сервисе

## Ограничения

- Workflow загружаются только при старте (hot-reload не поддерживается)
- Все workflow специфичны для ComfyUI (не абстрагированы под другие платформы)
- Видео-workflow ограничены: максимум 4 изображения на группу (LTX limitation)

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
