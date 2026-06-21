# TODO: Fix Regeneration System

> Приоритизированный план выправления системы перегенерации vbook.
> Легенда: 🔴 Critical | 🟡 High | 🟢 Medium | ⚪ Low
> Архитектура: v1 (сейчас) → v2 (entity-level diff) → v3 (version-based)

---

## 🔴 Critical (v2 — entity-level diff)

### [R0] Audio→Video dependency — исправить неверную зависимость

**Проблема (критическая):** В `book-diff.cjs:diffScene()` и `dependency-graph.js` изменение audio делает dirty `['audio', 'video']`. Это неверно — Video генерируется **без звуковой дорожки** (отдельный mp4). Изменение Audio не должно перезапускать GPU-генерацию Video.

**Файлы с ошибкой:**
- `backend/src/services/book-diff.cjs` — `dirtyLayers.push('audio', 'video')`
- `backend/src/dependency-graph.js` — `audio: { regenerate: ['audio', 'video'] }`

**Целевое поведение:**
- Audio change → `['audio']` (video NOT dirty)
- Voice change → `['audio']` (video NOT dirty)
- Финальный mux Video+Audio — отдельный ffmpeg-шаг при экспорте

**Checklist:**
- [x] `book-diff.cjs`: убрать `'video'` из dirty layers при audio change ✅
- [x] `dependency-graph.js`: `audio → ['audio']` (убрать `'video'` из `regenerate`) ✅
- [x] Тест: 232/232 тестов проходят

---

### [R1] SceneText diff — исправить фундаментальную ошибку v1

**Проблема:** `audio.full_text` и `units[].text` сравниваются как независимые поля. Изменение SceneText не делает image dirty.

**Целевое поведение:**
- Если изменился SceneText (= audio.full_text ИЛИ units[].text):
  - audio dirty, ALL image dirty, video dirty

**Реализовано:**
- [x] `diffScene()`: объединена проверка audio.full_text и units[].text ✅
- [x] `full_text_changed` → audio + image + video dirty ✅
- [x] `voice_changed` → audio ONLY (image/video сохраняются) ✅
- [x] units changed → audio + image + video dirty ✅

---

### [R2] Cross-cutting Dependency: Character→Scene Index

**Проблема:** characters.json не участвует в diff.

**Целевое поведение:**
- appearance/video_tokens → image dirty, video dirty. Audio NOT dirty
- voice → audio dirty. Image NOT dirty, video NOT dirty (cache)
- Основано на реальном prompt assembly: `buildCharacters()` использует `unit.participants[]` для поиска паспорта

**Реализовано:**
- [x] `computeBookDiff()`: сравнение characters.json ✅
- [x] `sceneHasCharacter()` — проверяет participants на уровне сцены и юнитов ✅
- [x] `ensureDirtyScene()` — мерж dirty-записей без дублирования ✅

---

### [R3] Cross-cutting Dependency: Location→Scene Index

**Проблема:** bible.json не участвует в diff.

**Целевое поведение:**
- description/visual_style → image dirty, video dirty. Audio NOT dirty
- Основано на реальном prompt assembly: `buildImagePrompt()` использует `bible.locations[locationId]`

**Реализовано:**
- [x] `computeBookDiff()`: сравнение bible.json ✅
- [x] Поиск сцен по `scene.location.id === locId` ✅

---

### [R4] Voice change → audio-only dirty (video cache preserved)

**Проблема:** В v1 voice change → `['audio', 'video']`.

**Решение:** После R0 audio change не делает video dirty. Voice change = audio change → только audio dirty.

**Реализовано:**
- [x] `diffScene()`: разделены `full_text_changed` vs `voice_changed` ✅
- [x] `voice_changed` → только `audio` dirty (без image/video) ✅
- [x] `full_text_changed` → `audio` + `image` + `video` dirty (SceneText изменился) ✅

---

### [R5] Унифицировать book-sync и book-diff

### [R6] Prompt Dependency Registry (новый!)

**Проблема:** Список полей, которые `buildImagePrompt()` читает, и список полей, которые `diffScene()` сравнивает, не скоординированы. Изменение prompt assembly может привести к недогенерации (изменение поля не детектируется) или перегенерации (лишние dirty).

**Решение:** Создать центральный Prompt Dependency Registry — аннотированный список всех источников данных `buildImagePrompt()`, аналогичный `entity-schema.js`.

```javascript
{
  'characters[].passport.*': { scope: 'cross', layer: 'image' },
  'bible.locations[].visual_style': { scope: 'cross', layer: 'image' },
  'bible.locations[].description':  { scope: 'cross', layer: 'image' },
  'audio.full_text':                { scope: 'scene', layer: 'audio' },
  ...
}
```

Где `scope` определяет алгоритм поиска затронутых сцен:
- `unit` → только этот unit
- `scene` → только эта сцена
- `chapter` → все сцены главы
- `cross` → поиск по индексу (Character→Scene, Location→Scene)

**Checklist:**
- [ ] Создать `backend/src/services/prompt-dependency-registry.js`
- [ ] Аннотировать все источники данных `buildImagePrompt()`
- [ ] `diffScene()` должна читать из registry, а не хардкодить
- [ ] `computeBookDiff()` должна использовать registry для cross-scope полей
- [ ] Тест: изменение registry → корректный diff

---

### [R7] Транзакционность markDirtyScenes (Lua script)

### [R8] Lock на конкурентные /regenerate

---

## 🟡 High (v2)

### [R9] Избавиться от force-reset scene state

### [R10] Placeholder audio ≠ valid content

### [R11] Unit-тесты для book-diff

### [R12] Book-sync вызывать после PUT

---

## 🟢 Medium (v3 — version-based foundation)

### [R12] Фаза 0: Подготовка PG-схемы

Добавить version-поля. У Video **нет** audio_config_version — video не зависит от audio.

**Checklist:**
- [ ] `scenes.content_version INTEGER NOT NULL DEFAULT 1`
- [ ] `scenes.audio_config_version INTEGER NOT NULL DEFAULT 1`
- [ ] `scene_assets.scene_content_version INTEGER`
- [ ] `scene_assets.scene_audio_config_version INTEGER` (только для audio assets)
- [ ] При `PUT /api/v1/book/:bookId`: bump версий

### [R13] Фаза 1: Двойной режим

### [R14] Фаза 2: Versions as source of truth

### [R15] Фаза 3: Cross-cutting dependencies через версии

### [R16] Redis persistence / startup recovery

---

## ⚪ Low

### [R17] Dependency Graph integration

### [R18] Убрать дублирование event-журналов

### [R19] Мёртвый governance код

### [R20] Cancel→Regenerate cleanup

### [R21] Hardcoded константы

---

## Приоритеты

```
Срочно (v2, следующий спринт):
  R0  Audio→Video dependency (исправить: video НЕ зависит от audio)
  R1  SceneText diff (исправить фундаментальную ошибку)
  R2  Character→Scene Index
  R3  Location→Scene Index
  R4  Voice-only dirty (упрощается после R0)
  R5  Унификация book-sync / book-diff
  R6  Транзакционность markDirtyScenes
  R7  Lock на конкурентные /regenerate

Важно (второй спринт):
  R8  FSM-reset вместо force redis.set
  R9  Placeholder ≠ valid content
  R10 Unit-тесты
  R11 Book-sync после PUT

Фундамент (v3):
  R12 Фаза 0: PG schema
  R13 Фаза 1: Dual mode
  R14 Фаза 2: Versions as truth
  R15 Фаза 3: Cross-cutting versions
  R16 Redis recovery

Когда-нибудь:
  R17-R21 Прочее
```
