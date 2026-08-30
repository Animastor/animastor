# TODO: Fix Regeneration System

> Приоритизированный план выправления системы перегенерации vbook.
> Легенда: 🔴 Critical | 🟡 High | 🟢 Medium | ⚪ Low
> Архитектура: v1 (сейчас) → v2 (entity-level diff) → v3 (version-based)

---

## 🔴 Critical (v2 — entity-level diff) — ALL COMPLETED ✅

### [R0] Audio→Video dependency ✅

**Checklist:**
- [x] `book-diff.cjs`: убрать `'video'` из dirty layers при audio change
- [x] `dependency-graph.js`: `audio → ['audio']` (убрать `'video'` из `regenerate`)
- [x] Тест: 232/232 тестов проходят

---

### [R1] SceneText diff ✅

**Checklist:**
- [x] `diffScene()`: объединена проверка audio.full_text и units[].text
- [x] `full_text_changed` → audio + image + video dirty
- [x] `voice_changed` → audio ONLY (image/video сохраняются)
- [x] units changed → audio + image + video dirty

---

### [R2] Cross-cutting Dependency: Character→Scene Index ✅

**Checklist:**
- [x] `computeBookDiff()`: сравнение characters.json
- [x] `sceneHasCharacter()` — проверяет participants на уровне сцены и юнитов
- [x] `ensureDirtyScene()` — мерж dirty-записей без дублирования

---

### [R3] Cross-cutting Dependency: Location→Scene Index ✅

**Checklist:**
- [x] `computeBookDiff()`: сравнение bible.json
- [x] Поиск сцен по `scene.location.id === locId`

---

### [R4] Voice change → audio-only dirty (video cache preserved) ✅

**Checklist:**
- [x] `diffScene()`: разделены `full_text_changed` vs `voice_changed`
- [x] `voice_changed` → только `audio` dirty (без image/video)
- [x] `full_text_changed` → `audio` + `image` + `video` dirty

---

### [R5] Унификация book-sync и book-diff ✅

**Checklist:**
- [x] `book-sync.js`: добавлен `reconcileFromDiff(bookId, dirtyScenes, loadedBook)`
- [x] `book-routes.cjs`: вызов `storage.bookSync.reconcileFromDiff()` в `/regenerate`
- [x] Тест: 232/232 тестов проходят

---

### [R6] Prompt Dependency Registry ✅

**Файл:** `backend/src/services/prompt-dependency-registry.js`

**Checklist:**
- [x] Создан `prompt-dependency-registry.js` с полным реестром
- [x] Аннотированы все источники данных `buildImagePrompt()`
- [x] `diffScene()` читает из registry вместо хардкода
- [x] `computeBookDiff()` использует registry для cross-scope полей
- [x] `dependency-graph.js` деривирует зависимости из registry
- [x] Тест: 232/232 тестов проходят

---

### [R7] Транзакционность markDirtyScenes (Lua script) ✅

**Checklist:**
- [x] Lua-скрипт `RESET_SCENE_LUA`: атомарный reset chunks + asset states + active scenes
- [x] SCAN + reset всех chunk'ов сцены (Phase 1)
- [x] Создание дефолтного chunk (Phase 2)
- [x] SADD active scenes (Phase 4)
- [x] Атомарная запись asset states (Phase 5)
- [x] Fallback `fallbackMarkSceneDirty()` при отсутствии EVAL

---

### [R8] Lock на конкурентные /regenerate ✅

**Checklist:**
- [x] Redis-based lock (`animastor:regenerate-lock:{bookId}`) с TTL 120s
- [x] Lock acquire/release в `book-routes.cjs` `/regenerate`
- [x] HTTP 429 при занятом lock

---

### [R9] Force-reset → FSM-reset для scene state ✅

**Checklist:**
- [x] Lua-скрипт: удалён force-set scene state (Phase 3)
- [x] Lua-скрипт: `transitionToPending()` — FSM-валидация в asset states
- [x] `markDirtyScenes()`: `state.syncLinearState()` после Lua (вывод из per-asset)
- [x] `fallbackMarkSceneDirty()`: валидированные transitions через FSM
- [x] `getAssetStates()` читается 1 раз (не в цикле)
- [x] Тест: 232/232 тестов проходят

---

## 🟡 High (v2) — ALL COMPLETED ✅

### [R10] Placeholder audio ≠ valid content ✅

**Checklist:**
- [x] `scene-window.js:sceneHasValidContent()` — placeholder не valid content (проверка `hasRealAudio()`)
- [x] `restoreChunkStatusForScene()` — `'placeholder'` вместо `'ready'` для placeholder файлов
- [x] `reconcileWindowStatuses()` — различaет placeholder от real через PG
- [x] `startScene()` — `audio_status = 'placeholder'` (было `'ready'`)
- [x] Тест: 295/295 тестов проходят

### [R11] Unit-тесты для book-diff + registry ✅

**Новые файлы:** `backend/tests/prompt-dependency-registry.test.js` (35 тестов), `backend/tests/book-diff-unit.test.js` (20 тестов)

**Checklist:**
- [x] `prompt-dependency-registry.js`: isEqual, extractPassport, sceneReferencesCharacter, computeSceneDirtyLayers, getLayerDependencies, getCrossFields
- [x] `book-diff.cjs`: diffScene (empty/full_text/voice), computeBookDiff (added/removed/changed/reorder), cross-cutting (character passport/voice/location, multi-char, new/removed char)
- [x] filterDirtyScenesByScope (whole_book/current_scene/current_chapter/from_current_scene)
- [x] Тест: 295/295 тестов проходят

### [R12] Book-sync вызывать после PUT ✅

**Checklist:**
- [x] `book-sync.js`: `reconcileFromDiff` добавлен в `module.exports` (баг из R5 — была dead code)
- [x] `book-routes.cjs` PUT `/api/v1/book/:bookId`: загрузка oldBook до save, `computeBookDiff()` после save, вызов `storage.bookSync.reconcileFromDiff()` при наличии dirty scenes
- [x] Non-fatal try/catch — ошибка PG не блокирует save

---

## 🟢 Medium (v3 — version-based foundation)

### [R13] Фаза 0: Подготовка PG-схемы ✅

**Checklist:**
- [x] `scenes.content_version INTEGER NOT NULL DEFAULT 1`
- [x] `scenes.audio_config_version INTEGER NOT NULL DEFAULT 1`
- [x] `scene_assets.scene_content_version INTEGER`
- [x] `scene_assets.scene_audio_config_version INTEGER` (только для audio assets)
- [x] При `PUT /api/v1/book/:bookId`: bump версий

### [R14] Фаза 1: Двойной режим (versions + flags) ✅
- [x] bump версий в /regenerate endpoint
- [x] version check в sceneHasValidContent (logging)
- [x] GET /api/v1/book/:bookId/versions diagnostic endpoint

### [R15] Фаза 2: Versions as source of truth ✅
- [x] markSceneAssetsStale — propagation versions from scenes table
- [x] sceneHasValidContent — version check drives invalidation
- [x] getOutdatedByVersions — version-based staleness in scene-assets-repo
- [x] placeholder-audio — version propagation on real audio upsert

### [R16] Фаза 3: Cross-cutting dependencies через версии ✅
- [x] getOutdatedByVersions integration in reconcileFromDiff
- [x] Cross-cutting source logging (Character/Location/passport/voice) in PUT + /regenerate
- [x] /versions endpoint uses getOutdatedByVersions

### [R17] Redis persistence / startup recovery ✅
- [x] startup-recovery.js — centralized 5-step recovery:
  - Step 1: recoverAllBooksFromDisk (existing)
  - Step 2: recoverIuImagesFromDisk (IU .png → chunk metadata)
  - Step 3: reconcileMissingSceneState (PG counters → Redis)
  - Step 4: checkVersionStaleness (PG JOIN version logging)
  - Step 5: resumeIncompleteSessions (existing, moved)
- [x] backend.cjs integration (replaces separate recoverAllBooksFromDisk + resumeIncompleteSessions)

### Polishing (R13-R17) ✅
- [x] `scene-assets-repo.js`: new `bumpSceneVersions()` — shared function eliminates duplicate inline SQL in PUT and /regenerate
- [x] `scene-window.js`: lazy `require('../storage/postgres/database')` moved from function body to module top
- [x] `startup-recovery.js`: Step 3 now restores `scene_hash` from book JSON after crash — prevents full regeneration
- [x] `book-routes.cjs`: PUT + /regenerate version bumps now call `bumpSceneVersions()` instead of inline SQL

---

### [R18] Callback Chain Repair (GPU hub → backend) ✅

**Files changed:** gpu-hub/gpu-hub.js, backend/src/ orc hestration/scene-orchestrator.js, backend/src/services/audio-recovery.cjs, backend/src/services/book-diff.cjs, backend/src/services/task-handler.cjs, backend/src/state/scene-state.js, backend/src/runtime/reconciliation-engine.js

**Checklist:**
- [x] `gpu-hub/gpu-hub.js`: Store results as JSON (`{job_id, result_base64, build_id}`) instead of raw data URL. Key format: `animastor:result:<buildId>:<bookId>:<chapterId>:<sceneId>:<type>`. Correct job_id parsing: pop chunkIndex → sceneId → chapterId → join rest as bookId.
- [x] `book-diff.cjs`: `markDirtyScenes()` — pass `buildId` to `syncLinearState()` (was silently dropping build_id). Same fix in `fallbackMarkSceneDirty()`.
- [x] `scene-state.js`: `syncLinearState()` accepts optional `overrideBuildId` parameter.
- [x] `scene-orchestrator.js`: All `syncLinearState` calls now pass `buildId` — in executeAudioDispatch, executeImageDispatch, executeVideoDispatch, and all handle*Completed callbacks.
- [x] `audio-recovery.cjs`: Handles both key formats (7+ parts JSON and 4-part data URL). Gracefully handles malformed keys.
- [x] `reconciliation-engine.js`: Guard against null `build_id` in `checkOrphanAudioState()`. Fixed `applyFix` REGENERATE_MISSING_ASSET — was crashing on undefined `scene.issue`.

### [R19] Frontend audio cache invalidation ✅

**Files changed:** Repository.kt, PlaybackViewModel.kt, GenerateViewModel.kt

**Checklist:**
- [x] `Repository.kt`: `getChunk(id)` → `getChunk(id, buildId)`. Cache key changed from `id` to `"${id}_${buildId}"`. Prevents stale `audio_ready=false` from cache when build changes.
- [x] All 5 callers updated to pass `buildId`.

---

## ⚪ Low

### [R20] Dependency Graph integration
### [R21] Remove Duplicate Event Journals
### [R22] Dead Governance Code
### [R23] Cancel→Regenerate Cleanup
### [R24] Hardcoded Constants

---

## Priorities (Current)

```
✅ ВЫПОЛНЕНО (v2 — все 13 задач):
  R0   Audio→Video dependency
  R1   SceneText diff
  R2   Character→Scene Index
  R3   Location→Scene Index
  R4   Voice-only dirty
  R5   Унификация book-sync / book-diff
  R6   Prompt Dependency Registry
  R7   Lua-транзакции markDirtyScenes
  R8   Lock на /regenerate
  R9   FSM-reset вместо force redis.set
  R10  Placeholder ≠ valid content
  R11  Unit-тесты (295 tests ✅)
  R12  Book-sync после PUT

✅ v3 COMPLETE:
  R13 PG schema
  R14 Dual mode
  R15 Versions as truth
  R16 Cross-cutting versions
  R17 Redis recovery

✅ R18 Callback chain repair
✅ R19 Frontend audio cache

### Bugfix: Image/Video dispatch cache bypassing version staleness ✅

**Files:** `scene-orchestrator.js`, `image-service.js`, `book-sync.js`, `scene-window.js`

**Checklist:**
- [x] `book-sync.js`: `markSceneAssetsStale()` changed to upsert (INSERT + ON CONFLICT UPDATE) — guarantees scene_assets rows exist after save
- [x] `scene-window.js`: `sceneHasValidContent()` — getAsset fallback: try with buildId, then without (synthetic row has build_id=NULL)
- [x] `scene-orchestrator.js`: `executeImageDispatch()` — added version-stale check (`sa.scene_content_version < sv.content_version`). If stale, passes `force=true` to `generateSceneIUImages()` which skips disk cache
- [x] `image-service.js`: `processSingleIU()` + `generateSceneIUImages()` — new `force` param. When true, skips `probeIUImage()` disk cache check and always sends to GPU
- [x] `scene-orchestrator.js`: `executeVideoDispatch()` — same version-stale check for video cache
- [x] `scene-orchestrator.js` + `entity-schema.js`: fixed connector validation warnings (added `language`, `temperature` entityTypes)

### Bugfix: GPU hub dedup key blocking per-unit regeneration ✅

**Files:** `image-service.js`, `scene-orchestrator.js`, `book-routes.cjs`

**Checklist:**
- [x] GPU hub uses `SET NX EX 3600 animastor:job:{job_id}` for dedup — same job_id from first generation blocks regeneration
- [x] `image-service.js`: `processSingleIU()` — clear GPU dedup key before dispatch in force=true path
- [x] `image-service.js`: Redis in-flight marker (`animastor:iu-in-flight:{imageIUId}`, TTL 1200s) instead of fs.existsSync check — prevents duplicate dispatches
- [x] `scene-orchestrator.js`: `executeImageDispatch()` — don't clear dirtyUnitIds in dispatch; defer to handleImageCompleted
- [x] `scene-orchestrator.js`: `handleImageCompleted()` — clear dirtyUnitIds + scan+delete in-flight markers on completion
- [x] `book-routes.cjs`: `/regenerate` handler — pre-delete stale PNGs + clear GPU dedup keys for dirty units before returning, so first frontend poll shows correct progress (e.g. 3/4 instead of 4/4)

### Bugfix: `ensureSceneRow` — scenes table rows never created ✅

**Files:** `scene-assets-repo.js`, `book-routes.cjs`

**Checklist:**
- [x] `bumpSceneVersions()` and `setDirtyUnitIds()` did UPDATE on `scenes` table — but no rows were ever INSERTed. UPDATE on non-existent row is silent no-op
- [x] `scene-assets-repo.js`: new `ensureSceneRow()` — INSERT INTO scenes … ON CONFLICT DO NOTHING
- [x] Called before UPDATE in both `bumpSceneVersions()` and `setDirtyUnitIds()`
- [x] `book-routes.cjs`: `/regenerate` restore loop — scenes with `hasDirtyUnits` stay in active index, not removed

### Bugfix: Worker toggle pulsing (heartbeat + lease) ✅

**Files:** `gpu-hub/gpu-hub.js`, `generation-routes.cjs`, `dispatch-engine.js`, `lease-manager.js`

**Checklist:**
- [x] `gpu-hub/gpu-hub.js`: heartbeat refresh for running tasks every 10s (before GPU timeout cleanup) — keeps `current_job_id` alive for entire generation duration
- [x] `generation-routes.cjs`: removed lease-as-fallback from `/worker/counts` — `active = status > 0 ? busy : 0` (lease doesn't affect toggle)
- [x] `generation-routes.cjs`: removed dead `countLeases()` function — eliminated 3 unnecessary Redis SCANs every 1.5-5s
- [x] `dispatch-engine.js`: `LEASE_TTLS` restored to real values (audio 15min, image 20min, video 30min)
- [x] `lease-manager.js`: `LEASE_TOTAL_TTLS` synchronized

🏗  LOW:
  R20-R24 Прочее

---

## General Fix Timeline

### 2026-06 — Mass per-unit regeneration fix

1. **Worker toggle fix:** GPU hub heartbeat refresh + lease fallback removal. Worker toggle shows only real GPU utilization, not lease lifetime.

2. **`ensureSceneRow`:** Rows in `scenes` table were never created — `bumpSceneVersions` and `setDirtyUnitIds` did UPDATE on non-existent row (silent no-op). `getDirtyUnitIds` returned null → all units cache hit → GPU did nothing.

3. **GPU hub dedup key:** GPU hub uses `SET NX EX 3600` for task deduplication. On regeneration `job_id` is identical (based on unit_id) → task silently ignored as `⚠️ Duplicate job ignored`. Backend now cleans dedup key before dispatch.

4. **In-flight tracking:** Redis marker `animastor:iu-in-flight:{id}` (TTL 20min) prevents duplicate dispatch on subsequent scheduler ticks.

5. **Progress display:** `/regenerate` handler synchronously removes stale PNG for dirty units before returning response. First frontend poll immediately sees 3/4, without false 4/4.

**Architectural lesson:** GPU hub should not have had a long-lived (1h) dedup key on job_id. For per-unit regeneration, job_id is identical when modifying the same unit — dedup blocks legitimate regeneration. Solution: clean dedup before dispatch for dirty units.
```
