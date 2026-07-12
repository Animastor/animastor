# IU Modal Refactoring: Audio / Image / Video

> **Дата:** 2026-07-12
> **Основание:** ChatGPT sketch + полный аудит текущей архитектуры
> **Статус:** Phase 1 (Audio) ✅ — реализовано

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

  // ─── Phase 2: Image — в разработке ─────────────
  image?: {
    shot?: "wide" | "medium" | "close" | "detail";
    prompt: string;
    negative?: string;
    character_binding?: boolean;
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

## 3. Phase 1: Audio — реализация

### 3.1 Что сделано

| Файл | Изменение |
|---|---|
| `backend/src/audio/segments.js` | `buildSegments()` читает только `audio.speaker` / `audio.text` — без фоллбэков |
| `backend/src/services/agent/pipeline-steps.js` | `stepCreateUnits()` пишет `audio: { speaker, text }` dual-write |
| `backend/src/book/lazy-book/create.js` | Исправлен баг: `speaker` и `audio` сохраняются в JSON |
| `backend/src/image/iu-processor.js` | Длительность IU из `audio.text` |
| `backend/src/services/prompt-dependency-registry.js` | Отслеживает `u.audio` для dirty-детекции |

### 3.2 Архитектура data flow

```
AI pipeline (stepCreateUnits)
  → unit.audio = { speaker, text }  // dual-write
  → create.js сохраняет audio в JSON
  → buildSegments() читает только audio.*
  → iu-processor берёт длительность из audio.text
  → prompt-dependency-registry отслеживает изменения audio
```

### 3.3 Ключевые решения

- **Без фоллбэков** — старых vbook-книг нет, всё в разработке
- **Dual-write** — `unit.audio` + существующие `unit.text`/`unit.speaker` (для обратной совместимости в других подсистемах)
- **`scene-hash.js`** — `audio` уже в хеше через generic-ветку, изменений не требуется
- **All 473 тестов проходят**

---

## 4. План миграции

### Фаза 0: Подготовка
- [x] Добавить Character.video_tokens в passport (уже есть в create.js)
- [ ] Создать IU schema version в manifest
- [ ] Создать функцию migrateUnit() для однократной миграции

### Фаза 1: Backend data model ← (IU.AUDIO DONE)
- [x] `audio/segments.js` — чтение из audio.*
- [x] `pipeline-steps.js` — dual-write audio
- [x] `create.js` — сохранение audio в JSON
- [x] `iu-processor.js` — длительность из audio.text
- [x] `prompt-dependency-registry.js` — dirty-детекция audio
- [ ] `scene-hash.js` — проверено, не требуется
- [ ] `book/index.js` — валидация новых полей
- [ ] `lazy-book/parse.js` — парсинг IU

### Фаза 2: Image (следующий шаг)
- [ ] `image/prompt-builder.js` — читать `image.prompt`, `image.shot`, `image.negative`
- [ ] `workflows/video/video-workflows.js` — читать `image.prompt` + `video.action`
- [ ] `pipeline-steps.js` — AI пишет в `image`, а не в `visual`
- [ ] Agent prompts — обновить инструкции для AI
- [ ] `pipeline-runner.js` — обработка image/video структуры

### Фаза 3: Video
- [ ] `video-workflows.js` — `video.action` для описания движения
- [ ] `prompt-dependency-registry.js` — добавить `video.action`, `video.negative`
- [ ] `dependency-graph.js` — video → только video, не image

### Фаза 4: Frontend
- [ ] `BookModels.kt` — SceneUnit: audio/image/video поля
- [ ] `EditFragment.kt` — UI для модального редактирования
- [ ] `VisualConfigAdapter` — новый десериализатор

### Фаза 5: Чистка legacy
- [ ] `unit.text` → удалить (перенесено в audio)
- [ ] `unit.speaker` → удалить (перенесено в audio.speaker)
- [ ] `unit.visual` → удалить (перенесено в image + video)

---

## 5. Ключевые файлы для изменений

### Backend Core:
- `backend/src/book/index.js` — валидация IU
- `backend/src/book/lazy-book/create.js` — создание IU ✅
- `backend/src/book/lazy-book/parse.js` — парсинг IU

### Prompt Assembly:
- `backend/src/image/prompt-builder.js` — image.prompt
- `backend/src/image/iu-processor.js` — audio.text для длительности ✅
- `backend/src/workflows/video/video-workflows.js` — image.prompt + video.action

### Agent Pipeline:
- `backend/src/services/agent-prompts.js` — system prompts
- `backend/src/services/agent/pipeline-steps.js` — image/video поля ✅ (audio)
- `backend/src/services/agent/pipeline-runner.js` — обработка структуры
- `backend/src/services/ai-service.js` — инструкции

### Dependencies:
- `backend/src/services/prompt-dependency-registry.js` ✅ (audio)
- `backend/src/dependency-graph.js` — video chain

### Audio:
- `backend/src/audio/segments.js` ✅

### Frontend:
- `frontend/.../BookModels.kt` — SceneUnit + VisualConfig
- `frontend/.../EditFragment.kt` — редактирование
- `frontend/.../AiAssistantFragment.kt` — отображение

---

## 6. Риски и решения

| Риск | Решение |
|---|---|
| AI-агент продолжит писать в `visual` | Pipeline-runner пост-обработка: `visual` → `image` + `video` |
| Video workflow использует `visual.prompt` | После Фазы 2: `image.prompt` + `video.action` + derived speaker |
| Character video tokens — новое понятие | Уже в passport'е в create.js через fragmentAppearanceForVideo() |
