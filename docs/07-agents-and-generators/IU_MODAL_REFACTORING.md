# IU Modal Refactoring: Audio / Image / Video

> **Дата:** 2026-07-12
> **Основание:** ChatGPT sketch + полный аудит текущей архитектуры
> **Статус:** Phase 1 (Audio) ✅ | Phase 2 (Image) ✅ | Phase 3 (Video) ✅ | Phase 4 (Frontend) ✅ | Phase 5 (Cleanup) ✅ | **Phase 6 (Agent prompts) ✅**

---

## 1. Аудит текущей архитектуры

### 1.1 Исходная структура IU (до рефакторинга)

```json
{
  "id": "iu-38d6e6ea",
  "type": "perception",
  "text": "content...",
  "speaker": "bezdomny",
  "visual": {
    "shot": "medium",
    "character_binding": true,
    "prompt": "description...",
    "negative": ""
  }
}
```

### 1.2 Ключевые проблемы (решены)

1. **`visual.prompt` — один на всё** — разделён на `image.prompt` + `video.action`
2. **`unit.text` — два назначения** — `audio.text` теперь канонический источник
3. **Нет точной dirty-логики** — `video.action` → только video (не image)
4. **Video prompt строился из image prompt** — теперь `video.action` + derived speaker
5. **`speaker` терялся при сохранении** — исправлено

---

## 2. Целевая архитектура IU ✅

```typescript
interface ImaginationUnit {
  id: string;
  type: "perception" | "dialogue" | "narration" | "typography" | "description" | "action" | "transition";

  participants?: string[];

  // ─── Phase 1: Audio ✅ ──────────────────────────
  audio?: {
    text: string;
    speaker?: string;
  };

  // ─── Phase 2: Image ✅ ──────────────────────────
  image?: {
    shot?: "wide" | "medium" | "close" | "detail" | "environment" | "reaction";
    prompt: string;
    negative?: string;
    character_binding?: boolean;
    style?: string;
    lighting?: string;
    quality?: string;
  };

  // ─── Phase 3: Video ✅ ──────────────────────────
  video?: {
    action?: string;
    camera?: string;
    negative?: string;
  };
}
```

### 2.1 Derived information (система НЕ дублирует)

| Данные | Источник | Derived для |
|---|---|---|
| Active video speaker | `type=dialogue` + `audio.speaker` | "speaking with lip movement" |
| IU participants | `participants` или `scene.participants` | Passport injection |
| IU duration | `audio.text` → word count | Timing, video frames |
| Character binding | `participants?.length > 0` | Passport injection |

---

## 3. Phase 1: Audio ✅

| Файл | Изменение |
|---|---|
| `backend/src/audio/segments.js` | `buildSegments()` читает только `audio.speaker` / `audio.text` |
| `backend/src/services/agent/pipeline-steps.js` | `stepCreateUnits()` пишет `audio: { speaker, text }` |
| `backend/src/book/lazy-book/create.js` | `speaker` и `audio` сохраняются в JSON |
| `backend/src/image/iu-processor.js` | Длительность IU из `audio.text` |
| `backend/src/services/prompt-dependency-registry.js` | `u.audio` dirty-детекция |
| `backend/src/services/agent/pipeline-runner.js` | `audio` поле через reconciliation/polish |

---

## 4. Phase 2: Image ✅

| Файл | Изменение |
|---|---|
| `backend/src/image/prompt-builder.js` | `resolveImageField()` читает `image.*` с fallback `visual.*` |
| `backend/src/services/agent/pipeline-steps.js` | `stepCreateVisuals()` dual-write `image: { shot, prompt }` |
| `backend/src/services/agent/pipeline-steps.js` | Reconciliation & polish обновляют `image.prompt` |
| `backend/src/services/agent/pipeline-runner.js` | Обратное mapping reconciliation/polish → `unit.image` |
| `backend/src/book/lazy-book/create.js` | Сохраняет `image` поле в JSON |
| `backend/src/workflows/video/video-workflows.js` | Читает `image.*` с fallback `visual.*` |
| `backend/src/services/prompt-dependency-registry.js` | `u.image` dirty-детекция + knownUnitKeys |

---

## 5. Phase 3: Video ✅

| Файл | Изменение |
|---|---|
| `backend/src/services/agent/pipeline-steps.js` | `stepCreateVisuals()` dual-write `video: { action }` |
| `backend/src/services/agent/pipeline-steps.js` | Reconciliation & polish обновляют `video.action` |
| `backend/src/services/agent/pipeline-runner.js` | `video` mapping через reconciliation/polish |
| `backend/src/book/lazy-book/create.js` | Сохраняет `video` поле в JSON |
| `backend/src/workflows/video/video-workflows.js` | `video.action` как temporal описание + derived speaker из `audio.speaker` |
| `backend/src/services/prompt-dependency-registry.js` | `u.video` tracking: video.action → только video (не image) |

---

## 6. Architecture Data Flow (финальное состояние)

```
AI pipeline (stepCreateUnits)
  → unit.audio = { speaker, text }     // канонический источник TTS
  → unit.text (legacy fallback через stepCreateUnits)

AI pipeline (stepCreateVisuals)
  → unit.visual (legacy fallback)
  → unit.image = { shot, prompt, style, negative }   // статическая композиция
  → unit.video = { action }                          // изменение во времени

buildSegments()
  → читает unit.audio.speaker + unit.audio.text
  → строит TTS script

buildImagePrompt()
  → читает unit.image.* только
  → собирает финальный image prompt

buildVideoPrompt()
  → читает unit.video.action || unit.image.prompt
  → добавляет derived speaker: "X speaking with lip movement"
  → собирает storyboard для LTX

prompt-dependency-registry
  → u.audio → dirty только audio
  → u.image → dirty image + video
  → u.video → dirty только video
```

---

## 7. Changelog

| Date | Commit | Description |
|---|---|---|
| 2026-07-12 | `d5d59a4` | **Phase 1: Audio** — `unit.audio` field |
| 2026-07-12 | `32c2bc9` | **Phase 2: Image** — `unit.image` field |
| 2026-07-12 | HEAD | **Phase 3: Video** — `unit.video` field + derived speaker |
| 2026-07-12 | HEAD | **Phase 4: Frontend** — `AudioSection`/`ImageSection`/`VideoSection` дата-классы, EditFragment UI |
| 2026-07-12 | HEAD | **Phase 5: Cleanup** — убраны `visual.*`, `text`, `speaker` фоллбэки; завершён dual-write `image.style`/`image.negative` |
| 2026-07-12 | HEAD | **Phase 6: Agent prompts** — AI пишет `image`/`video`/`audio` напрямую |

---

## 8. Оставшиеся фазы

### Фаза 4: Frontend ✅
- [x] `BookModels.kt` — AudioSection/ImageSection/VideoSection дата-классы, SceneUnit обновлён
- [x] `EditFragment.kt` — UI для модального редактирования: readUnitField/buildUnitFields/applyFieldValues
- [x] `strings.xml` — строковые ресурсы для секций (Audio/Visual/Image/Video)

### Фаза 5: Чистка legacy ✅
- [x] `prompt-builder.js` — `resolveImageField()` читает только `image.*`; `resolveVisualStyle` без `visual.style`; `resolveNegativePrompt` без unit-level legacy
- [x] `video-workflows.js` — `buildVideoPrompt()` без `visual.*` фоллбэков; `resolveNegativePrompt` без `visual.*`
- [x] `prompt-dependency-registry.js` — убраны `oldU.text/content/visual`; `knownUnitKeys = ['id', 'type', 'audio', 'image', 'video']`
- [x] `pipeline-steps.js` — завершён dual-write: добавлены `image.style`/`image.negative` во все проходы (stepCreateVisuals, reconciliation, polish)
- [x] Тесты обновлены: `coreference-image.test.js`, `video-workflows.test.js`

### Фаза 6: Agent prompts ✅
- [x] `SYSTEM_PROMPTS.visuals` — AI пишет `image` + `video` вместо `visual`
- [x] `SYSTEM_PROMPTS.units` — AI пишет `audio.speaker`/`audio.text` вместо `text`/`speaker`
- [x] `passport_reconciliation`, `storyboard_polish` — output format `image` вместо `visual`
- [x] `stepCreateVisuals` — читает `image`/`video` из AI (fallback `visual`)
- [x] `stepCreateUnits` — читает `audio` из AI (fallback `text`/`speaker`)
- [x] `dryrun-visuals-iu.js` — обновлён под `image`/`video` формат

---

## 9. Ключевые файлы

### Backend Core:
- `backend/src/book/index.js`
- `backend/src/book/lazy-book/create.js`
- `backend/src/image/prompt-builder.js`
- `backend/src/image/iu-processor.js`

### Agent Pipeline:
- `backend/src/services/agent-prompts.js`
- `backend/src/services/agent/pipeline-steps.js`
- `backend/src/services/agent/pipeline-runner.js`
- `backend/src/services/ai-service.js`

### Dependencies:
- `backend/src/services/prompt-dependency-registry.js`
- `backend/src/dependency-graph.js`

### Audio:
- `backend/src/audio/segments.js`

### Video:
- `backend/src/workflows/video/video-workflows.js`

### Frontend:
- `frontend/.../BookModels.kt`
- `frontend/.../EditFragment.kt`
