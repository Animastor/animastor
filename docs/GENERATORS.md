# Generators: Animastor

## Общее описание

В проекте Animastor термин "генератор" как формальная абстракция (базовый класс Generator, интерфейс IGenerator, фабрика генераторов) **не обнаружен**. Генерация реализована через **сервисы** (`audio/`, `image/`, `video/`), которые используют **workflow builders** для создания ComfyUI-совместимых JSON и отправляют их в **GPU Hub** через **gpu-dispatcher**.

## Типы генерации

### Audio Generator (`backend/src/audio/audio-service.js`)

**Способ подключения:** Модуль подключается через `require('./audio')` в backend.cjs. Экспортирует `generateSceneAudio()`, `mergeAllAudio()`, `isSceneAudioReady()`.

**Интерфейс:**
```js
async generateSceneAudio(redis, sceneData, loadedBook, buildId, bookId)
async mergeAllAudio(buildId, bookId, sceneCount)
async isSceneAudioReady(buildId, bookId, chapterId, sceneId)
```

**Формат запросов (вход sceneData):**
```json
{
  "chapter_id": "string",
  "scene_id": "string",
  "segments": [{ "segment_type": "narration|dialogue", "text": "...", "voice": "..." }]
}
```

**Формат результатов:**
- MP3-файлы на диске: `data/output/<buildId>/audio/<bookId>/<chapterId>/<sceneId>_<index>.mp3`
- Merged audio: `data/output/<buildId>/audio/<bookId>/<chapterId>/<sceneId>.mp3`
- Книга audio: `data/output/<buildId>/audio/<bookId>.mp3`

**Особенности реализации:**
- Разбивка текста сцены на narration/dialogue сегменты
- Для narration: `tts-qwen-narrator` workflow
- Для dialogue: `tts-qwen-dialogue` workflow (два голоса)
- Использует `ffmpeg` для мержа аудиочанков
- Silent trimming после генерации
- Placeholder audio (тишина) если реальный TTS ещё не готов

---

### Image Generator (`backend/src/image/image-service.js`)

**Способ подключения:** Модуль подключается через `require('./image')`.

**Интерфейс:**
```js
async generateSceneIUImages(redis, sceneData, loadedBook, buildId, bookId)
async buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload)
```

**Формат запросов:**
```json
{
  "iu": [{ "unit_id": "string", "description": "..." }],
  "prompt_context": {"characters": [...], "location": {...}, "environment": "..."}
}
```

**Формат результатов:**
- PNG-файлы: `data/output/<buildId>/images/<bookId>/<chapterId>/<sceneId>/<unitId>.png`
- Превью: `.../preview/<unitId>.png`

**Особенности реализации:**
- Промпты строятся из: внешность персонажа + локация + IU description
- Кэширование: если изображение уже существует — пропускается
- Использует `img-qwen-image` workflow
- Параллельная отправка нескольких IU через GPU Hub

---

### Video Generator (`backend/src/video/video-service.js`)

**Способ подключения:** Модуль подключается через `require('./video')`.

**Интерфейс:**
```js
async generateVideoAnimation(sceneData, loadedBook, buildId, workflows)
```

**Формат запросов:**
```json
{
  "units": [{ "unit_id": "string", "duration": 5.0 }],
  "iu_durations": {"<unitId>": 5.0}
}
```

**Формат результатов:**
- MP4-файлы: `data/output/<buildId>/video/<bookId>/<chapterId>/<sceneId>.mp4`
- Групповые видео: `.../<sceneId>_group_<n>.mp4`
- Book video (merged): `data/output/<buildId>/video/<bookId>.mp4`

**Особенности реализации:**
- Группировка IU: максимум 4 изображения на группу (LTX limitation)
- Выбор workflow: `video-ltx-1p`, `2p`, `3p`, `4p` по количеству IU в группе
- FPS: 24, выравнивание кадров: 8n+1 (LTX requirement)
- Видео-промпт включает: персонажи, timecode, окружение (из book.bible)

---

### AI Text Generator (`backend/src/services/ai-service.js`)

**Способ подключения:** Модуль подключается через `require('./services/ai-service')`.

**Интерфейс:**
```js
async callAI(model, messages, options)
async parseJsonResponse(text)
```

**Формат запросов:**
```json
{
  "model": "qwen/qwen3.5-122b-a10b",
  "messages": [
    { "role": "system", "content": "system prompt" },
    { "role": "user", "content": "user prompt" }
  ],
  "max_tokens": 2048,
  "temperature": 0.3
}
```

**Формат результатов:**
- JSON-ответ от OpenRouter API
- Парсится через `parseJsonResponse()` (извлекает JSON из markdown-блоков)

**Особенности реализации:**
- Timeout: 180s
- Retries: 3
- Поддержка OpenRouter и NVIDIA API
- Не абстрагирован: модель задаётся строкой, нет фабрики провайдеров

---

### Placeholder Audio Generator (`backend/src/services/placeholder-audio.js`)

**Способ подключения:** Модуль подключается через `require('./services/placeholder-audio')`.

**Интерфейс:**
```js
async ensureAllPlaceholderAudio(buildId, bookId, scenes)
async recoverMissingPlaceholders(buildId, bookId)
async getScenesNeedingPlaceholder(bookId)
```

**Формат результатов:**
- MP3-файлы тишины (длительность соответствует сцене)
- Используется для структуры тайминга до генерации реального TTS

---

## Общий слой абстракции генераторов

**Формального абстрактного слоя не обнаружено.** Каждый генератор:
- Имеет собственный интерфейс (разные имена функций, разные параметры)
- Использует разные workflow (audio/image/video)
- По-разному обрабатывает результаты (audio → MP3 merge, image → PNG cache, video → group merge)

Тем не менее, все генераторы следуют общему паттерну:
1. Получить данные сцены
2. Построить workflow (через workflow builder)
3. Вызвать `gpu.send()` / `gpu.sendVideo()`
4. Обработать callback через task-handler
5. Сохранить результат на диск + зарегистрировать в asset registry

### Можно ли заменить любой генератор без изменения остальной системы?

**Нет, замена любого генератора без изменения остальной системы невозможна.** Причины:

1. **Уникальные интерфейсы:** Каждый генератор имеет свой набор параметров и возвращаемых значений. Нет общего контракта.

2. **Жёсткая связь с type system:** Orchestrator явно проверяет типы (`'audio'`, `'image'`, `'video'`) в `determineNextStage()`, `executeAudioDispatch()`, и т.д.

3. **Специфичные workflow builders:** Каждый тип генерации использует свой набор workflow (audio-workflows, image-workflows, video-workflows) с разными Node ID.

4. **Разная обработка результатов:** Audio → merge чанков, Image → кэширование PNG, Video → групповой merge + mux с audio.

5. **Жёсткая привязка к слоям:** Layer config явно перечисляет `audio`, `image`, `video` как ключи.

6. **Dispatch engine захардкожен:** Quota (`maxAudio=3`, `maxImage=2`, `maxVideo=1`), lease TTL (30/60/120 min), circuit breaker thresholds — всё захардкожено под эти три типа.

**Для замены потребуется:**
- Рефакторинг orchestrator для работы через абстрактный интерфейс генератора
- Создание registry генераторов
- Добавление нового типа в dispatch-engine, layer-config, scene-state (AssetState)
- Новый workflow builder + шаблоны
- Обновление GPU Hub и worker для поддержки нового job_type
