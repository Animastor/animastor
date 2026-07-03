# Regeneration System: Animastor

> Система частичной/полной перегенерации контента после редактирования vbook.
> Последнее обновление: июнь 2026

---

## 1. Общая схема

```
Edit → Save → PUT /api/v1/book/:bookId → disk
         ↓
Regenerate → POST /api/v1/book/:bookId/regenerate
         ↓
   computeBookDiff(oldBook, newBook)
         ↓
   filterDirtyScenesByScope(scope)
         ↓
   Cover check → prepend if needed
         ↓
   markDirtyScenes()
     ├── Reset Redis chunks (pending)
     ├── Reset scene state (FSM force)
     ├── Reset per-asset states
     └── Add to active scenes index
         ↓
   restoreChunkStatusForScene() × N
     └── If content on disk → skip GPU
         ↓
   Runtime Scheduler picks up dirty scenes
     └── Audio dispatch → TTS
     └── Image dispatch → IU generation
     └── Video dispatch → LTX pipeline
         ↓
   Window system slides on completion
```

---

## 2. Участники системы

### 2.1 Frontend (Android)

| Компонент | Роль |
|---|---|
| `EditFragment.kt` | Редактор сцены — сохранение через `repository.updateBook()` |
| `GenerateViewModel.kt` | `regenerateFromSnapshot()`, `snapshotCurrentBook()`, `markUnsavedChanges()` |
| `Repository.kt` | `regenerateBookScoped()` → `POST /regenerate` |

### 2.2 Backend Routes

| Эндпоинт | Файл | Роль |
|---|---|---|
| `PUT /api/v1/book/:bookId` | `book-routes.cjs` | Сохранение отредактированной книги на диск (полная замена) |
| `PATCH /api/v1/book/:bookId/scene/:chapterId/:sceneId` | `book-routes.cjs` | Точечное обновление полей юнита (Mode A) или полная замена сцены (Mode B) без round-trip потери данных |
| `POST /api/v1/book/:bookId/regenerate` | `book-routes.cjs` | Запуск перегенерации |

### 2.3 Core Services

| Сервис | Файл | Роль |
|---|---|---|
| **Book Diff** | `book-diff.cjs` | Сравнение old/new book JSON, diff сцен, пометка dirty |
| **Book Sync** | `book-sync.js` | Альтернативный детект изменений через SHA256-хэши |
| **Gen Scope** | `gen-scope.js` | Scope-менеджмент (whole_book / chapter / scene) |
| **Layer Config** | `layer-config.js` | Профили генерации (full / audio_only / video_only / storyboard) |
| **Dependency Graph** | `dependency-graph.js` | Каскадные зависимости между слоями |

### 2.4 Runtime

| Компонент | Файл | Роль |
|---|---|---|
| **Scene Window** | `scene-window.js` | Slide-окно, reconciliation статусов, cancel-флаг |
| **Scene State** | `scene-state.js` | Dual state model (FSM + per-asset) |
| **Runtime Scheduler** | `runtime-scheduler.js` | Tick-based dispatch (5s), per-asset dispatch |
| **Dispatch Engine** | `dispatch-engine.js` | Lease, quota, governance |

### 2.5 Storage

| Хранилище | Роль в регенерации |
|---|---|
| **Redis** | Chunk metadata, scene states, asset states, gen scope, active scenes |
| **Postgres** | Scene hashes, scene_assets, generation_tasks, book snapshots |
| **Filesystem** | Book JSON, output files (.mp3, .png, .mp4) |

---

## 3. Происхождение данных внутри сцены (Data Provenance)

### 3.1 Как на самом деле собирается Final Image Prompt

Функция `buildImagePrompt()` в `image-service.js` конструирует финальный промпт из нескольких источников. Ниже — точная карта того, какие поля откуда читаются.

**Функция:** `buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload)`

```
Final Image Prompt =
    [renderMode]              ← scene.visual.render || book.manifest.render.mode
  + [style]                   ← resolveVisualStyle()  (см. ниже)
  + [location_visual_style]   ← bible.locations[locationId].visual_style   ← bible.json
  + [location_description]    ← bible.locations[locationId].description     ← bible.json
  + [env_epoch]               ← scene.location.environment.epoch
  + [env_time]                ← scene.location.environment.time
  + [env_season]              ← scene.location.environment.season
  + [env_weather]             ← scene.location.environment.weather
  + [env_mood]                ← scene.location.environment.mood
  + [env_atmosphere]          ← scene.location.environment.atmosphere
  + [env_lighting]            ← scene.location.environment.lighting
  + [shot_type]               ← unit.visual.shot
  + [character_passport]      ← book.characters[id].passport              ← characters.json
  + [character_state]         ← scene.state[id] || chapter.state[id]
  + [visual_prompt]           ← unit.visual.prompt
  + [quality]                 ← unit.visual.quality || scene.visual.quality
```

**`resolveVisualStyle()` — цепочка fallback:**
```
unit.visual.style → scene.visual.style → scene.style (если не типографский) → bible.render_rules.style
```
Типографские стили (`soviet_book_page`, `book_style`, `typography_only`, `chapter_title`, `cover`) фильтруются — они не должны попадать в нарративные промпты.

**Локация: `resolveLocationFromPrompt()` — fallback если у сцены нет `location.id`:**
Если `scene.location` отсутствует, но direct prompt упоминает локацию, система
пытается сопоставить текст промпта с `bible.locations`:
1. **Exact substring match** — оригинальное поведение
2. **Word overlap via Cyr→Lat transliteration** — проверяет, какие слова из названия локации
   встречаются в промпте (с транслитерацией кириллицы)
3. **Prefix match** — если слово из локации и слово из промпта имеют общий префикс ≥4 символов
   (например, "patriarch" ↔ "patriarshie" через "patri"), засчитывается 0.5 балла
4. **Порог совпадения:** 0.25 — достаточно 1 частичного совпадения для 2-словной локации

**Персонажи: `inferCharactersFromPrompt()` — fallback если `participants` пуст:**
Если `scene.participants` и `unit.participants` пусты (проблема AI-генерации),
но direct prompt содержит `character_id` (например, `mikhail_alexandrovich_berlioz`),
система находит этих персонажей в `characters.json` и inject-ит их паспорта.

**Character Passport собирается так (`buildCharacters()` → `resolvePassport()`):**

```javascript
const participants = unit?.participants || []
const chars = participants
    .map(id => book.characters?.find(c => c.id === id))
    .filter(Boolean)

// + fallback: inferCharactersFromPrompt() если participants пуст
//   (сканирует direct prompt на character_id и inject-ит паспорта)

// Паспорт = слияние трёх уровней:
// 1) c.passport.*                    — глобальный (characters.json)
// 2) chapter.character[c.id].*       — переопределение в главе
// 3) scene.visual.character[c.id].*  — переопределение в сцене
//
// Поля: base_appearance, detailed_appearance,
//       clothing_base, clothing_details

// Состояние персонажа:
// scene.state[c.id] || chapter.state[c.id]
```

**Из этого следует:**

1. Единственный способ, которым `characters.json` влияет на Image Prompt — через `unit.participants[]`. Если персонаж не указан в `participants` ни одного юнита сцены, его паспорт **по умолчанию не используется**. **НО** — новый fallback `inferCharactersFromPrompt()` сканирует direct prompt на наличие `character_id` и inject-ит паспорт даже при пустом `participants[]`.

2. Единственный способ, которым `bible.locations` влияет на Image Prompt — через `scene.location.id`. Если у сцены нет `location`, **новый fallback** `resolveLocationFromPrompt()` пытается сопоставить текст промпта с bible-локациями через транслитерацию + prefix matching.

3. **Текущая R2/R3 имплементация корректна.**
   - R2 (`sceneHasCharacter`) проверяет `unit.participants.includes(charId)` — это именно то, что `buildImagePrompt()` использует для поиска паспорта (основной путь; fallback — `inferCharactersFromPrompt`).
   - R3 проверяет `scene.location.id === locId` — это именно то, что `buildImagePrompt()` использует для поиска описания локации (основной путь; fallback — `resolveLocationFromPrompt`).

---

### 3.2 Проблема: зависимости размазаны по двум местам

Текущая проблема не в том, ЧТО проверяет R2/R3, а в том, ЧТО список полей, которые `buildImagePrompt()` читает, и список полей, которые `diffScene()` сравнивает, **не скоординированы**. Если завтра `buildImagePrompt()` начнёт читать новое поле (например, `unit.visual.color_palette`), разработчик может забыть обновить `diffScene()` — и изменение `color_palette` не вызовет перегенерацию.

**Идеальная архитектура — Prompt Dependency Registry:**

```javascript
// Единый источник истины: какие поля → какие dirty layers
const IMAGE_PROMPT_SOURCES = {
  'unit.visual.prompt':              { scope: 'unit',    layer: 'image' },
  'unit.visual.style':               { scope: 'unit',    layer: 'image' },
  'unit.visual.shot':                { scope: 'unit',    layer: 'image' },
  'unit.visual.lighting':            { scope: 'unit',    layer: 'image' },
  'unit.visual.quality':             { scope: 'unit',    layer: 'image' },
  'unit.participants[]':             { scope: 'unit',    layer: 'image' },  // → character passport

  'scene.visual.style':              { scope: 'scene',   layer: 'image' },
  'scene.visual.lighting':           { scope: 'scene',   layer: 'image' },
  'scene.visual.quality':            { scope: 'scene',   layer: 'image' },
  'scene.location.id':               { scope: 'scene',   layer: 'image' },  // → bible location
  'scene.location.environment.*':    { scope: 'scene',   layer: 'image' },

  'bible.locations[].visual_style':  { scope: 'cross',   layer: 'image' },
  'bible.locations[].description':   { scope: 'cross',   layer: 'image' },

  'characters[].passport.*':         { scope: 'cross',   layer: 'image' },
  'characters[].voice':              { scope: 'cross',   layer: 'audio' },

  'chapter.character[].*':           { scope: 'chapter', layer: 'image' },
  'chapter.state[].*':               { scope: 'chapter', layer: 'image' },

  'scene.state[].*':                 { scope: 'scene',   layer: 'image' },

  'audio.full_text':                 { scope: 'scene',   layer: 'audio' },
  'audio.voice':                     { scope: 'scene',   layer: 'audio' },
}
```

**Где scope определяет алгоритм поиска затронутых сцен:**

| Scope | Алгоритм | Пример |
|---|---|---|
| `unit` | Только этот unit | `unit.visual.prompt` |
| `scene` | Только эта сцена | `scene.visual.style` |
| `chapter` | Все сцены главы | `chapter.character[c].*` |
| `cross` | Поиск по индексу (характер → сцены, локация → сцены) | `characters[].passport.*` |

Тогда `computeBookDiff()` мог бы:
1. Для каждого изменившегося поля посмотреть его `scope`
2. Если `cross` — запустить Character→Scene или Location→Scene индекс
3. Автоматически определить, какие `layer`'ы стали dirty

Это делает dependency graph **самодокументированным** и **защищённым от рассинхронизации** между prompt assembly и diff logic.

### 3.3 Полный граф зависимостей

```
                    ┌──────────────────────────────────────────┐
                    │              SceneText                    │
                    │  (полный нарративный текст сцены)         │
                    └──────────────┬───────────────┬───────────┘
                                   │               │
                     ┌─────────────┘               └──────────────┐
                     ▼                                            ▼
          ┌─────────────────────┐                  ┌─────────────────────────┐
          │       Audio         │                  │     UnitText[1..N]      │
          │  (озвучка сцены)    │                  │  (разбиение SceneText   │
          │                     │                  │   на смысловые          │
          │  отдельный mp3      │                  │   фрагменты)            │
          └─────────────────────┘                  └───────────┬─────────────┘
                                                               │
                                                               ▼
                                                    ┌─────────────────────┐
                                                    │   ImagePrompt[1..N]  │
                                                    │  (визуальный промпт  │
                                                    │   каждого юнита)     │
                                                    │                     │
                                                    │  Зависит ОТ:         │
                                                    │  ├── UnitText        │
                                                    │  └── SceneText       │
                                                    │      (global context)│
                                                    └──────────┬──────────┘
                                                               │
                                                    ┌──────────▼──────────┐
                                                    │   Image[1..N]        │
                                                    │  (сгенерированные    │
                                                    │   изображения)       │
                                                    │  отдельные png       │
                                                    └──────────┬──────────┘
                                                               │
                                                    ┌──────────▼──────────┐
                                                    │   Video              │
                                                    │  (видеоряд из        │
                                                    │   изображений)      │
                                                    │                     │
                                                    │  mp4 БЕЗ звука      │
                                                    │  Не зависит от Audio │
                                                    └─────────────────────┘

                                                         Экспорт:
                                              ┌───────────────────────┐
                                              │  FinalVideo.mp4       │
                                              │  = Video.mp4          │
                                              │  ✚ Audio.mp3         │
                                              │  (ffmpeg mux,         │
                                              │   не GPU-задача)      │
                                              └───────────────────────┘
```

### 3.2 Ключевые правила

1. **SceneText → UnitText — жёсткая зависимость.** UnitText — результат разбиения SceneText на фрагменты, не самостоятельная сущность.

2. **ImagePrompt зависит от двух уровней контекста:**
   - **Локальный:** текст конкретного юнита (UnitText)
   - **Глобальный:** полный текст сцены (SceneText), общий смысл, контекст

   ```
   SceneText ────────────────────┐
     │                           │
     ├──► UnitText[1] ──┐       │
     ├──► UnitText[2] ──┤──► ImagePrompt
     ├──► UnitText[3] ──┘       ▲
     └──► ...              (global context)
   ```

3. **Audio НЕ зависит от Image, Image НЕ зависит от Audio.** Две независимые ветки от SceneText.

4. **⚠️ Video НЕ зависит от Audio.** Video генерируется БЕЗ звуковой дорожки (отдельный mp4 без аудио). Финальный mux (Video + Audio → FinalVideo) — лёгкая ffmpeg-операция на этапе экспорта/скачивания, не GPU-задача.

5. **Video зависит от Image.** Для генерации видео нужны готовые изображения всех юнитов сцены.

6. **Image зависит от ImagePrompt.** А ImagePrompt зависит от SceneText + UnitText.

### 3.3 Практические следствия

| Изменение | Audio | Image | Video | Экспорт (mux) |
|---|---|---|---|---|
| SceneText | dirty | dirty (все) | dirty (через image) | нужно |
| UnitText[K] (ручное редактирование) | NOT dirty | Image[K] dirty | dirty | нужно |
| Voice (только) | dirty | NOT dirty | **NOT dirty** ✅ | нужно |
| Character appearance | NOT dirty | dirty | dirty | NOT нужно |
| Location | NOT dirty | dirty | dirty | NOT нужно |
| Image перегенерировано | NOT dirty | — | dirty | NOT нужно |
| Audio перегенерировано | — | NOT dirty | **NOT dirty** ✅ | нужно |

**Ключевое отличие от предыдущих версий документа:** Audio изменение НЕ делает Video dirty. Video перегенерируется только когда меняется визуальная ветка (SceneText, UnitText, ImagePrompt, Image, Character, Location).

---

## 4. Детальный протокол перегенерации

### 4.1 Trigger: Save → Regenerate

**Frontend flow:**

1. `EditFragment.saveToBackend()` → `PUT /api/v1/book/:bookId`
2. `GenerateViewModel.regenerateFromSnapshot()` → `POST /api/v1/book/:bookId/regenerate`

### 4.2 Backend: POST /regenerate

**Файл:** `book-routes.cjs:1482`

1. Очистка состояния (cancel flag, leases)
2. Применение scope (`genScope.setScope()`)
3. Применение profile (`bookDiff.applyProfileToLayerConfig()`)
4. Сбор всех сцен
5. **Diff** (`bookDiff.computeBookDiff(existingBook, loadedBook)`)
6. Фильтрация по scope
7. Cover check
8. **Mark dirty** (`bookDiff.markDirtyScenes()`)
9. **Restore valid content** (`restoreChunkStatusForScene()`)

### 4.3 Scene Diff (book-diff.cjs) — v1 (с ошибками)

**`diffScene(oldScene, newScene)` сравнивает (v1):**

| Поле | Dirty layers (v1, СЕЙЧАС) | Правильные dirty layers |
|---|---|---|
| `audio.full_text` | `audio`, `video` ❌ | `audio` (SceneText → image тоже должно быть dirty, см. R1) |
| `audio.voice` | `audio`, `video` ❌ | `audio` (video НЕ зависит от audio) |
| `units[]` | `image`, `video` | `image`, `video` ✅ |
| `location`, `participants`, `style` | `image`, `video` | `image`, `video` ✅ |

**⚠️ Две ошибки v1:**
1. **SceneText split:** `audio.full_text` и `units[].text` сравниваются как независимые — это одна сущность
2. **Audio→Video dependency:** `audio` change не должно делать `video` dirty — видео генерируется без звука

### 4.4 Правильный Dependency Graph

```
SceneText
  ├──► Audio (mp3, отдельно)
  │
  └──► UnitText
          └──► ImagePrompt (SceneText также влияет напрямую)
                  └──► Image (png, отдельно)
                          └──► Video (mp4 без звука)

External (cross-cutting):
  Character.appearance ──► Image
  Character.voice ──────► Audio
  Location ─────────────► Image
  Video ✚ Audio ───────► FinalVideo (export/mux, не генерация)
```

### 4.5 Mark Dirty Scenes

Для каждой dirty сцены: SCAN chunks → reset статусов → force-reset scene state → reset per-asset states → add to active index.

### 4.6 Window System

`scene-window.js`: init → slide → trySlideOnComplete → reconcileWindowStatuses.

### 4.7 Book Sync

Хэш-ориентированный детект изменений. **Не вызывается** после `PUT /book/:bookId`.

### 4.8 Scene Hash (scene-hash.js)

`computeSceneHash(scene) → sha256(JSON.stringify(extractSceneFingerprint(scene)))`

---

## 5. Архитектурный фундамент: разделение ответственности

### 5.1 Текущая проблема

В текущей системе:

- **Redis** хранит: scene states, asset states, chunk metadata, gen scope — всё runtime-состояние
- **Postgres** хранит: scene_assets (status), scenes (scene_hash), generation_tasks
- dirty-флаги живут **только в Redis**
- При падении Redis все dirty-флаги теряются

### 5.2 Целевая архитектура

**Redis = transient (текущее состояние):**
- Очереди генерации
- Блокировки
- Прогресс
- Кэш для scheduler'а

**Postgres = source of truth (истина):**
- Сущности и их версии
- Статусы asset'ов
- Связи (Scene → Character, Scene → Location)

### 5.3 Version-based dirty detection

Dirty **вычисляется** сравнением версий, а не explicit флагами.

### 5.4 Multi-version схема (с учётом Audio↔Video независимости)

```
Scene
  ├── content_version           # SceneText → audio, ALL image, video
  ├── audio_config_version      # voice → audio (video НЕ трогает)
  └── dependency_hash           # character appearance + location

Image
  ├── scene_content_version     # для проверки SceneText
  └── scene_dependency_hash     # для проверки character/location

Audio
  ├── scene_content_version     # для проверки SceneText
  └── scene_audio_config_version # для проверки voice

Video
  ├── scene_content_version     # для проверки SceneText (через image)
  └── scene_dependency_hash     # для проверки character/location
  [НЕТ audio_config_version — video не зависит от audio!]
```

**Правила dirty:**

| Условие | Что dirty |
|---|---|
| `Image.scene_content_version < Scene.content_version` **OR** `Image.scene_dependency_hash ≠ Scene.dependency_hash` | Image dirty |
| `Audio.scene_content_version < Scene.content_version` **OR** `Audio.scene_audio_config_version < Scene.audio_config_version` | Audio dirty |
| `Video.scene_content_version < Scene.content_version` **OR** `Video.scene_dependency_hash ≠ Scene.dependency_hash` | Video dirty |
| `Audio.scene_audio_config_version < Scene.audio_config_version` | **НЕ** делает Video dirty ✅ |

### 5.5 Экспорт (FinalVideo)

Финальная склейка Video + Audio — отдельный шаг, не часть генерации:

```
Video.mp4 (без звука)
  ✚
Audio.mp3
  │
  ▼
ffmpeg -i video.mp4 -i audio.mp3 -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 final.mp4
  │
  ▼
FinalVideo.mp4
```

- Это **не GPU-задача**, а лёгкая ffmpeg-операция
- Не требует повторной генерации видео при изменении аудио
- Выполняется при скачивании/экспорте

---

## 6. Gap Analysis: v1 → v2 → v3

### 6.1 Что меняется на каждом этапе

| Аспект | v1 (сейчас, с ошибками) | v2 (следующий) | v3 (цель) |
|---|---|---|---|
| SceneText diff | audio.full_text отдельно от units[] | По единому SceneText | Через bump content_version |
| Audio→Video dependency | **Есть** (`['audio', 'video']`) ❌ | **Нет** ✅ | **Нет** (по архитектуре) |
| Character dependency | Не детектируется | Character→Scene index | Через dependency_hash |
| Location dependency | Не детектируется | Location→Scene index | Через dependency_hash |
| Voice-only dirty | Всегда audio+video ❌ | audio, video NOT dirty | Через audio_config_version |
| Dirty хранение | Redis только | Redis + PG | PG source of truth |

### 6.2 Что построить на каждом этапе

```
v2 (entity-level diff):
  ├── SceneText → audio, ALL image, video (исправить фундаментальную ошибку)
  ├── Audio → audio (УБРАТЬ video из dirty layers — видео без звука)
  ├── Character→Scene index
  ├── Location→Scene index
  └── Voice → audio (video NOT dirty)

v3 (version-based):
  ├── content_version, audio_config_version, dependency_hash
  ├── scene_assets.scene_content_version
  ├── Normalized characters, locations tables
  ├── Redis → PG (source of truth)
  └── Video не проверяет audio_config_version
```

---

## 7. Redis Key Space (current)

```
animastor:gen-scope:<bookId>
animastor:layer-config:<bookId>
animastor:scene-state:<bookId>:<ch>:<sc>
animastor:asset-state:<bookId>:<ch>:<sc>
animastor:chunk:<bookId>_<ch>_<sc>_<idx>
animastor:chunks:<bookId>
animastor:book-scenes:<bookId>:total
animastor:book-scenes:<bookId>:next-index
animastor:book-scenes:<bookId>:window-start
animastor:generation:cancel:<bookId>
animastor:dispatch-lease:<bookId>:<...>
animastor:dispatch-meta:<bookId>:<...>
animastor:runtime:active-audio
animastor:runtime:active-image
animastor:runtime:active-video
animastor:concurrent-audio
animastor:concurrent-image
animastor:concurrent-video

# Per-unit progress (Redis counter — не filesystem PNG count)
animastor:iu-progress:<bookId>:<ch>:<sc>:image   # Счётчик подтверждённых GPU-завершений IU (INCR, TTL=14400s).
                                                  # Используется в /assets-state вместо fs.readdirSync(),
                                                  # чтобы stale PNG от предыдущей генерации не искажали прогресс.

# Per-unit regeneration (GPU dedup + in-flight)
animastor:job:<job_id>                     # GPU hub dedup key (SET NX EX 3600) — очищается перед dispatch dirty unit
animastor:iu-in-flight:<imageIUId>         # Redis marker (EX 1200) — предотвращает duplicate dispatch на след. tick

# GPU hub heartbeat (shared Redis)
animastor:worker:heartbeat:<type>:<id>     # Текущий job_id (обновляется каждые 10с для running задач)
animastor:running                          # Running tasks (hset)
animastor:queue:<type>                     # Очереди GPU hub (image/audio/video)
```

---

## 8. Файлы

| Файл | Размер | Роль |
|---|---|---|
| `backend/src/routes/book-routes.cjs` | ~1800 строк | POST /regenerate |
| `backend/src/services/book-diff.cjs` | ~360 строк | Diff, mark dirty |
| `backend/src/services/book-sync.js` | ~200 строк | Hash-based sync |
| `backend/src/services/gen-scope.js` | ~130 строк | Scope management |
| `backend/src/services/layer-config.js` | ~120 строк | Profile management |
| **`backend/src/dependency-graph.js`** | ~80 строк | **⚠️ Содержит ошибку: audio→['audio','video']** |
| `backend/src/utils/scene-hash.js` | ~120 строк | SHA256 fingerprint |
| `backend/src/runtime/scene-window.js` | ~680 строк | Window slide |
| `backend/src/state/scene-state.js` | ~250 строк | FSM + per-asset |
| `backend/src/runtime/runtime-scheduler.js` | ~300 строк | Tick dispatch |
| `backend/src/video/video-service.js` | ~200 строк | Видео БЕЗ аудио |
| `backend/src/video/video-merge.js` | ~190 строк | Mux Video+Audio (экспорт) |
| `frontend/.../EditFragment.kt` | ~900 строк | Editor |
| `frontend/.../GenerateViewModel.kt` | ~900 строк | Regeneration |
