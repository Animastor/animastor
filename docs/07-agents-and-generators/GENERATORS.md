# Generators: Animastor

## Общее описание

В проекте Animastor термин "генератор" как формальная абстракция (базовый класс Generator, интерфейс IGenerator, фабрика генераторов) **не обнаружен**. Генерация реализована через **сервисы** (`audio/`, `image/`, `video/`), которые используют **workflow builders** для создания ComfyUI-совместимых JSON и отправляют их в **GPU Hub** через **gpu-dispatcher**.

## Типы генерации

### Audio Generator (`backend/src/audio/audio-service.js`)

**Способ подключения:** Модуль подключается через `require('./audio')` в backend.cjs. Экспортирует `generateSceneAudio()`, `mergeAllAudio()`, `isSceneAudioReady()`, `trimPaddedSceneAudio()`, `generateSilentAudio()`.

**Интерфейс:**
```js
async generateSceneAudio(redis, sceneData, loadedBook, buildId, bookId)
async mergeSceneAudioChunks(redis, bookId, chapterId, sceneId, buildId, expectedCount)
async mergeAllAudio(buildId, bookId, sceneCount)
async isSceneAudioReady(buildId, bookId, chapterId, sceneId)
async trimPaddedSceneAudio(audioPath)
async generateSilentAudio(audioPath, durationSec)
```

**Особенности реализации:**
- Разбивка текста сцены на narration/dialogue сегменты
- Для narration: `tts-qwen-narrator` workflow
- Для dialogue: `tts-qwen-dialogue` workflow (два голоса)
- Использует `ffmpeg` для мержа аудиочанков
- Silent trimming после генерации
- Padded text trimming (удаление дублированного аудио для коротких текстов)
- Placeholder audio (тишина) если реальный TTS ещё не готов

---

### Image Generator (`backend/src/image/image-service.js`)

**Интерфейс:**
```js
async generateSceneIUImages(redis, sceneData, loadedBook, buildId, bookId)
async buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload)
async resolveCanonicalSceneImage(outputDir, buildId, bookId, chapterId, sceneId)
```

**Особенности реализации:**
- Промпты строятся из: внешность персонажа + локация + IU description
- **`buildImagePrompt()`** — сборщик финального промпта из нескольких источников:
  `resolveVisualStyle()`, `resolveLocationFromPrompt()`, `inferCharactersFromPrompt()`
- **`resolveVisualStyle()`** — цепочка: IU→scene→root style (с фильтром типографики)→bible style
- **`resolveLocationFromPrompt()`** — если у сцены нет `location.id`, сопоставляет
  текст direct prompt с `bible.locations` через Cyr→Lat транслитерацию + prefix matching
- **`inferCharactersFromPrompt()`** — **первичный механизм** определения участников
  кадра (с июля 2026; `unit.participants` удалён). Сканирует `visual.prompt` на
  `character_id` и inject-ит паспорта из `characters.json`.
- Поддержка `epoch`, `season`, `atmosphere` из `scene.location.environment`
- `locations.json` содержит глобальный шаблон `environment` (time/season/lighting/weather/
  mood/atmosphere) — fallback для сцен. `scene.location.environment` перекрывает его по-полю
  (паттерн паспортов персонажей); мёрж выполняется в `buildImagePrompt()` и видео-билдере
- **Scene-level passport overrides** (`scene.passport[charId]`): `resolvePassport()`
  берёт перекрытие сцены (base_appearance, detailed_appearance, clothing_base,
  clothing_details) с наивысшим приоритетом над глобальным паспортом персонажа;
  неперекрытые поля — из `characters.json`. Аналогично видео-билдер читает
  `scene.passport[id].video_tokens` с приоритетом над глобальным. Изменение `scene.passport`
  помечает сцену на перегенерацию image+video (`prompt-dependency-registry.js`,
  `SCENE_FIELDS`).
- Кэширование: если изображение уже существует — пропускается
- Использует `img-qwen-image` workflow
- Параллельная отправка нескольких IU через GPU Hub

---

### Video Generator (`backend/src/video/video-service.js`)

**Интерфейс:**
```js
async generateVideoAnimation(sceneData, loadedBook, buildId, workflows)
async validateVideoFile(videoPath)
async updateSceneVideoStatus(redis, bookId, chapterId, sceneId, status)
```

**Особенности реализации:**
- Группировка IU: максимум 4 изображения на группу (LTX limitation)
- Выбор workflow: `video-ltx-1p`, `2p`, `3p`, `4p` по количеству IU в группе
- FPS: 24, выравнивание кадров: 8n+1 (LTX requirement)
- Видео-промпт включает: персонажи, timecode, окружение (из book.bible)
- Возвращает `jobSpecs` для отправки в GPU Hub

---

### AI Text Generator (`backend/src/services/ai-service.js`)

**Интерфейс:**
```js
async callAI(model, messages, options)       // общий вызов API
async parseJsonResponse(text)                // парсинг JSON из ответа
async refineDraft(chapterText)               // полный AI-анализ с примерами
```

**Особенности реализации:**
- Timeout: 60s (default) / 180s (refineDraft) / 180s (agent-service)
- Retries: 3 (backoff: 1s, 2s, 4s)
- Поддержка OpenRouter и Nvidia API (через AI_API_BASE_URL)
- `refineDraft()` загружает примеры из `ai/examples/` и включает в промпт
- Не абстрагирован: модель задаётся строкой, нет фабрики провайдеров

---

### Placeholder Audio Generator (`backend/src/services/placeholder-audio.js`)

**Интерфейс:**
```js
async ensurePlaceholderAudio(buildId, bookId, chapterId, sceneId)
async ensureAllPlaceholderAudio(buildId, bookId, scenes)
async hasRealAudio(bookId, chapterId, sceneId, buildId)
async replacePlaceholderWithRealAudio(bookId, chapterId, sceneId, buildId, realAudioPath, realDuration)
async recoverMissingPlaceholders(buildId, bookId)
```

**Формат результатов:**
- MP3-файлы тишины (длительность соответствует сцене — по IU или тексту)
- Регистрация в PostgreSQL scene_assets со статусом 'placeholder'
- Замена на real audio при завершении TTS (через `replacePlaceholderWithRealAudio`)

---

## Общий слой абстракции генераторов

**Формального абстрактного слоя не обнаружено.** Каждый генератор:
- Имеет собственный интерфейс (разные имена функций, разные параметры)
- Использует разные workflow (audio/image/video)
- По-разному обрабатывает результаты (audio → MP3 merge, Image → PNG cache, Video → group merge)

Тем не менее, все генераторы следуют общему паттерну:
1. Получить данные сцены
2. Построить workflow (через workflow builder)
3. Вызвать `gpu.send()` / `gpu.sendVideo()` / `gpu.sendUnified()`
4. Обработать callback через task-handler
5. Сохранить результат на диск + зарегистрировать в asset registry (PostgreSQL)

### Можно ли заменить любой генератор без изменения остальной системы?

**Нет, замена любого генератора без изменения остальной системы невозможна.** Причины:

1. **Уникальные интерфейсы:** Каждый генератор имеет свой набор параметров и возвращаемых значений. Нет общего контракта.

2. **Жёсткая связь с type system:** Orchestrator, dispatch-engine, scene-state имеют хардкодные ссылки на `'audio'`, `'image'`, `'video'`.

3. **Специфичные workflow builders:** Каждый тип генерации использует свой набор workflow с разными Node ID.

4. **Разная обработка результатов:** Audio → merge чанков + padded text trim, Image → кэширование PNG + IU completion check, Video → групповой merge + mux с audio.

5. **Жёсткая привязка к слоям:** Layer config явно перечисляет `audio`, `image`, `video` как ключи.

6. **Dispatch engine захардкожен:** Quota, lease TTL, circuit breaker thresholds — всё под эти три типа.

**Для замены потребуется:**
- Рефакторинг orchestrator для работы через абстрактный интерфейс генератора
- Создание registry генераторов
- Добавление нового типа в dispatch-engine, layer-config, scene-state (AssetState)
- Новый workflow builder + шаблоны
- Обновление GPU Hub и worker для поддержки нового job_type
