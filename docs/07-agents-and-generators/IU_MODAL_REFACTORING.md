# IU Modal Refactoring: Audio / Image / Video

> **Дата:** 2026-07-12
> **Основание:** ChatGPT sketch + полный аудит текущей архитектуры
> **Статус:** Phase 1 (Audio) ✅ | Phase 2 (Image) ✅

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

### 1.2 Ключевые проблемы

1. **`visual.prompt` — один на всё** — используется и для image, и для video
2. **`unit.text` — два назначения** — и аудио-текст, и контекст для visual
3. **Нет точной dirty-логики** — изменение video-action регенерирует image
4. **Video prompt строится из image prompt** — нет отдельного описания движения
5. **`speaker` терялся при сохранении** — create.js не копировал поле

---

## 2. Целевая архитектура IU

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

  // ─── Phase 3: Video — запланировано ────────────
  video?: {
    action?: string;
    camera?: string;
    negative?: string;
  };
}
```

### 2.1 Derived information (что НЕ дублируем)

| Данные | Источник | Derived для |
|---|---|---|
| Active video speaker | `type=dialogue` + `audio.speaker` | Video prompt: lip movement |
| IU participants | `participants` или `scene.participants` | Passport injection |
| IU duration | `audio.text` → word count | Timing, video frames |
| Character binding | `participants?.length > 0` | Passport injection |

---

## 3. Phase 1: Audio — реализовано

### 3.1 Что сделано

| Файл | Изменение |
|---|---|
| `backend/src/audio/segments.js` | `buildSegments()` читает только `audio.speaker` / `audio.text` |
| `backend/src/services/agent/pipeline-steps.js` | `stepCreateUnits()` пишет `audio: { speaker, text }` dual-write |
| `backend/src/book/lazy-book/create.js` | Исправлен баг: `speaker` и `audio` сохраняются в JSON |
| `backend/src/image/iu-processor.js` | Длительность IU из `audio.text` |
| `backend/src/services/prompt-dependency-registry.js` | Отслеживает `u.audio` для dirty-детекции |
| `backend/src/services/agent/pipeline-runner.js` | `audio` поле через reconciliation/polish проходы |

---

## 4. Phase 2: Image — реализовано

### 4.1 Что сделано

| Файл | Изменение |
|---|---|
| `backend/src/image/prompt-builder.js` | `resolveImageField()` читает `image.*` с fallback `visual.*` |
| `backend/src/services/agent/pipeline-steps.js` | `stepCreateVisuals()` dual-write `image: { shot, prompt }` |
| `backend/src/services/agent/pipeline-steps.js` | Reconciliation & polish обновляют `image.prompt` |
| `backend/src/services/agent/pipeline-runner.js` | Обратное mapping reconciliation/polish → `unit.image` |
| `backend/src/book/lazy-book/create.js` | Сохраняет `image` поле в JSON |
| `backend/src/workflows/video/video-workflows.js` | Читает `image.*` с fallback `visual.*` |
| `backend/src/services/prompt-dependency-registry.js` | Отслеживает `u.image` для dirty-детекции |

### 4.2 Архитектура data flow

```
AI pipeline (stepCreateVisuals)
  → unit.image = { shot, prompt }     // dual-write с visual
  → reconciliation/polish обновляют image.prompt
  → create.js сохраняет image в JSON
  → buildImagePrompt() читает image.* (fallback visual.*)
  → buildVideoPrompt() читает image.* (fallback visual.*)
  → prompt-dependency-registry отслеживает image
```

---

## 5. Changelog

| Date | Commit | Description |
|---|---|---|
| 2026-07-12 | `d5d59a4` | **Phase 1: Audio** — `unit.audio` field for dialogue TTS |
| 2026-07-12 | HEAD | **Phase 2: Image** — `unit.image` field, dual-write with visual |

---

## 6. План следующих фаз

### Фаза 3: Video (следующий шаг)
- [ ] `video-workflows.js` — добавить `video.action` для описания движения
- [ ] `pipeline-steps.js` — AI пишет `video.action` 
- [ ] Agent prompts — обновить output format
- [ ] `prompt-dependency-registry.js` — `video.action` dirty-детекция
- [ ] `dependency-graph.js` — video → только video (не image)

### Фаза 4: Frontend
- [ ] `BookModels.kt` — SceneUnit: audio/image/video поля
- [ ] `EditFragment.kt` — UI для модального редактирования
- [ ] `VisualConfigAdapter` — новый десериализатор

### Фаза 5: Чистка legacy
- [ ] `unit.text` → удалить (audio.text)
- [ ] `unit.speaker` → удалить (audio.speaker)
- [ ] `unit.visual` → удалить (image + video)

---

## 7. Ключевые файлы

### Backend Core:
- `backend/src/book/index.js` — валидация IU
- `backend/src/book/lazy-book/create.js` ✅
- `backend/src/image/prompt-builder.js` ✅
- `backend/src/image/iu-processor.js` ✅

### Agent Pipeline:
- `backend/src/services/agent-prompts.js` — system prompts
- `backend/src/services/agent/pipeline-steps.js` ✅
- `backend/src/services/agent/pipeline-runner.js` ✅
- `backend/src/services/ai-service.js` — инструкции

### Dependencies:
- `backend/src/services/prompt-dependency-registry.js` ✅
- `backend/src/dependency-graph.js` — video chain

### Audio:
- `backend/src/audio/segments.js` ✅

### Video:
- `backend/src/workflows/video/video-workflows.js` ✅

### Storage:
- `backend/src/storage/postgres/repositories/iu-repo.js`

### Frontend:
- `frontend/.../BookModels.kt` — SceneUnit + VisualConfig
- `frontend/.../EditFragment.kt` — редактирование
