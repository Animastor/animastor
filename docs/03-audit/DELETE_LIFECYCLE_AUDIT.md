# 03. Delete Lifecycle Audit — Chapter / Scene / Module (Unit)

> Full audit of the Chapter / Scene / Module deletion lifecycle across the entire stack:
> JSON/persistence → filesystem (OUTPUT_DIR) → PostgreSQL → Redis →
> generation queues/workers → recovery/anti-duplicate → local cache
> (web Cache API + Android SimpleDiskCache/VideoCache) → dirty/regeneration →
> frontend state (position, playback queue).
>
> **READ-ONLY** audit: nothing was fixed. Based on source code review.
> Date: 2026-08-19. Context: commit `305e2cd` introduced manual chapter/scene/unit
> add/delete via `entity-crud-routes.cjs` (web + Android).
>
> Legend: **Current** — what happens today, **Expected** — expected behavior
> (modeled after `DELETE /book/:bookId`, considered the gold standard for
> complete cleanup), **Gap** — the difference.

---

## Executive Summary

Deleting a Chapter/Scene/Unit in the editor today **touches only the JSON layer**
(`book.loadBook` → array filtering → `book.saveBookBundle`). None of the other
book state layers — PostgreSQL, Redis, files in `OUTPUT_DIR`, GPU hub queues,
in-flight dispatch, local client caches — are invalidated when
`DELETE /chapters/:id`, `DELETE /scenes/:id`, or `DELETE /units/:id` is called.

A complete proper cleanup example exists only for deleting **an entire book**
(`DELETE /api/v1/book/:bookId`, `core-routes.cjs:694-819`): resetBook + deletion
of snapshot/build directories + Redis (`cancelled-workers`, cancel flag, active
counters, `cleanBookRedisKeys`) + clearing ~27 PG tables + `GPU /queue/clear`.
There is no equivalent for deleting a single chapter/scene/unit anywhere.

Most critical consequences:

1. **Ghost scenes in the playback queue**: Redis chunks of the deleted scene
   are not removed, and `GET /book/:bookId/chunks` builds the queue exclusively
   from Redis (`chunks-routes.cjs:25-87`) **without filtering by book JSON** —
   the deleted scene continues to play on web and Android and appears in
   `/assets-state`.
2. **PG row leak**: the only purge mechanism
   (`book-sync.reconcileFromDiff` → `purgeRemovedSceneRows`) is only called from
   `PUT /book/:bookId`, where it physically cannot detect entity-CRUD deletions
   (the deletion is already saved to disk before PUT → diff doesn't see "removed").
3. **In-flight generation is not cancelled**: GPU jobs already dispatched for the
   deleted scene complete and write files + PG rows + Redis state
   for a scene that no longer exists.
4. **Orphan files in OUTPUT_DIR** (mp3/chunks/png/video) are neither cleaned up at
   deletion time nor by background GC; `recover*` doesn't delete them (and doesn't
   "resurrect" them, which provides partial protection), but also doesn't clean them.

Positive findings (controls that prevent the worst outcomes):

- Executors **self-heal**: `executeAudioDispatch/Image/VideoDispatch` check
  `book.findSceneRuntimeData` and on `scene_not_found` remove the scene from the
  active index (`scene-orchestrator.js:63-73, 205-214, 277-286`) — the scheduler
  won't infinitely regenerate a deleted scene.
- Recovery mechanisms (`recoverAllBooksFromDisk`, `recoverMissingRedisChunks`,
  `recoverMissingPlaceholders`) use book JSON as the source of truth —
  deleted entities are not "resurrected" from disk/Redis.
- JSON layer is clean: `saveBookBundle` synchronizes `chapters_order`, removes
  the orphan file of the deleted chapter from `chapters/`, and protects against
  an empty book (guards on last chapter/scene).

---

## 1. Current Architecture (how deletion works today)

**Deletion entry points:**

| Caller | Endpoint | File |
|---|---|---|
| Web EditPage / Android EditFragment | `DELETE /api/v1/book/:bookId/chapters/:chapterId` | `entity-crud-routes.cjs:331` |
| Web EditPage / Android EditFragment | `DELETE /api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId` | `entity-crud-routes.cjs:407` |
| Web EditPage / Android EditFragment | `DELETE /api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units/:unitId` | `entity-crud-routes.cjs:477` |
| (gold standard) | `DELETE /api/v1/book/:bookId` | `core-routes.cjs:694` |

**What entity-delete does:**

```
loadBook(bookId)
→ filter(chapters | scenes | units)
→ saveBookBundle(oldBook, null)
→ { saved: true }
```

Plus guards: cannot delete the last chapter (`entity-crud-routes.cjs:337`) and
the last scene in a chapter (`:416`). When deleting a character, `voices[characterId]`
is additionally cleaned (`:137-143`). Nothing else.

**What the gold-standard book deletion does** (`core-routes.cjs:694-819`) — the full
checklist we reference in the tables below:

- FS: `book.resetBook(bookId)`, snapshot, build directories, and files with the
  bookId prefix in `OUTPUT_DIR` (`:699-727`);
- Redis: `animastor:cancelled-workers:{bookId}`, `setCancelFlag` (window), active
  counters, `cleanBookRedisKeys` (`:737-757`);
- PG: 27 tables by `book_id` with per-table try/catch (`:762-801`);
- GPU Hub: `DELETE {HUB}/queue/clear?book_id=` (`:803-811`).

---

## 2. Module/Scene/Chapter Deletion Lifecycle (by layer)

### 2.1 JSON / Persistence — ✅ clean

- `saveBookBundle` (`book/index.js:256-454`) writes manifest.json, book.json
  (`chapters_order` is synchronized from `book.chapters`, `:376-383`), bible /
  locations / voices / characters (removed when empty), chapters in `chapters/`.
- Orphan files of the deleted chapter are removed from `chapters/`, but **only when
  `chapterFilenames.length > 0`** (`:436-453`) — the "cannot delete last chapter"
  invariant makes this safe.
- Data model: chapters are files `chapters/ch-<hex8>.json`, scenes and units are inline
  within the chapter JSON (`lazy-book/paths.js`: `chapterId()`→`ch-<hex8>`,
  `sceneId()`→`sc-<hex8>`, `unitId()`→`iu-<hex8>`).

### 2.2 Files / Assets (OUTPUT_DIR) — ❌ not cleaned

Naming (`filesystem-store.js:25-47`):
`{bookId}_{chapterId}_{sceneId}.mp3` (scene audio), `_<chunk>.mp3`,
`_<chunk>.png` (chunk image), `_iu<uid>.png` (IU image), `_pr<uid>.png`
(preview), `{bookId}_{ch}_{sc}.mp4` (video).

- When deleting a scene/chapter/unit, files are **not removed**.
- The only related mechanism — `resetScenes` with `cleanPngUnitIds`
  (`orchestrator.js:571-591`) pre-deletes stale PNGs **only for dirty units**
  during `/regenerate` — not called by entity-delete.
- `cleanupService.cleanupBuild` removes only an **entire build directory**
  (`cleanup-service.cjs:56-81`), used when deleting a book.
- No background GC for orphan files at scene/chapter level (see §9).

### 2.3 PostgreSQL — ❌ not cleaned (Critical C1)

Tables: `scenes`, `scene_assets`, `generation_tasks`, `image_units`,
`asset_states`, `cache_entries`, `output_manifests`, `book_events`,
`reconciliation_events`, `book_source`, `book_generation_sessions`,
`ai_chat_sessions`, `chat_messages`, `sentence_resolutions`,
`character_mentions`, etc.

- FK/cascade: only `books → book_snapshots | scenes | storyboard_elements |
  audio_layers ON DELETE CASCADE` (`schema.js:39,51,200,215`). `scenes` has FK
  on `books`, but there is **no** cascade from `scenes` to `scene_assets`/`image_units`/
  `generation_tasks`/`asset_states` — they reference book_id as text without FK.
- Entity-delete does not touch PG at all.
- `purgeRemovedSceneRows` (`book-sync.js:293-313`) deletes for removed scenes:
  `scene_assets`, `generation_tasks`, `image_units`, `storyboard_elements`,
  `audio_layers`, `scenes`. Does **NOT** delete: `asset_states`, `cache_entries`,
  `output_manifests`, `book_events`, `reconciliation_events`, `book_source`,
  `book_generation_sessions`, `chat_*`, `sentence_resolutions`,
  `character_mentions`, `ai_chat_sessions`.
- And critically: `reconcileFromDiff` is called **only from `PUT /book/:bookId`**
  (`core-routes.cjs:235,398,533,595,653`). For entity-CRUD deletions, the diff path
  doesn't trigger: `oldBook` is loaded from disk **after** entity-delete,
  so "removed" is not detected. See C1.

### 2.4 Redis — ❌ not cleaned (Critical C2)

Keys of the deleted scene/chapter persist forever:

- Chunks: `animastor:chunk:{bookId}_{ch}_{sc}_*` + set `animastor:chunks:{bookId}`
  (`redis-helpers.cjs:38-39`).
- Per-asset states: `animastor:asset-state:{bookId}:{ch}:{sc}`
  (`scene-state.js:11`).
- Active index: set `animastor:active-scenes` → `{bookId}:{ch}:{sc}`
  (`active-scenes-index.js:9`).
- Asset registry: hash `animastor:assets:{bookId}:{ch}:{sc}`
  (`asset-registry.js:24`).
- Dispatch: `animastor:dispatch-lease:{bookId}:*`, `dispatch-meta:*`,
  `retry:*`, `audio-orch:{bookId}:*`, `iu-progress:*`, `iu-in-flight:*`,
  `job:{bookId}_*` (GPU dedup), `result:{bookId}_*`, `scene-video:{bookId}:*`.

Scene-level cleanup exists only at the book level —
`cleanBookRedisKeys` (`redis-helpers.cjs:314-422`) — and only for `DELETE /book`.
There is no scene/chapter-level Redis cleanup anywhere. Consequence — see C2: the
playback queue is built from Redis and includes deleted scenes.

### 2.5 Generation queue / workers — ❌ not cancelled (Critical C3)

- Entity-delete does not call `clearLeasesForScenes`, `clearHubDispatches`,
  `setCancelFlag`, `cancelled-workers`. The GPU hub queue for the deleted scene
  remains; workers complete and write results (see §7 Race Conditions).
- `runtime-persistence.js` snapshot/restore can "restore" active
  leases/dispatch-metadata of the deleted scene after restart, if the snapshot was
  taken before deletion (`runtime-persistence.js:583-708`) — but executor self-heal
  (see §10) limits the consequences.

### 2.6 Recovery / anti-duplicate — ✅ doesn't resurrect, but doesn't clean either

- `recoverAllBooksFromDisk`/`recoverChunksFromDisk`
  (`redis-helpers.cjs:158-290`): takes the scene list from book JSON and restores
  only those → deleted scenes don't "resurrect" (good), but stale chunks of deleted
  scenes are not cleaned (bad — amplifies C2).
- `recoverMissingRedisChunks` (`recover-chunks.cjs:11-59`): only creates
  missing chunks for scenes from JSON, never deletes anything.
- `recoverMissingPlaceholders` (`placeholder-audio.js:474-560`): only for scenes
  in `draft.chapters`, does not overwrite/delete the deleted scene's file.
- `book-diff.markDirtyScenes` (RESET_SCENE_LUA, `book-diff.cjs:217-316`) for
  "removed" scenes **recreates** the chunk, sets PENDING and **adds the scene to
  the active index** (`:312-313`) — but this path is unreachable from entity-delete (see C1);
  manual invocation would "resurrect" the scene in Redis.

### 2.7 Local cache (web + Android) — ✅ invalidated (Medium M2, fixed)

**Fixed** as part of Local Cache Invalidation (§7).

- **Web**: `confirmDeleteStructure` now calls `invalidateDeletedScene/Chapter`
  (`playbackStore.ts`) → `evictSceneMedia/evictChapterMedia` (`mediaCache.ts`)
  + `clearPreloadCache()` + removal from `sceneQueue` **before** re-fetch.
  Cache API key `/${buildId}/${chapterId}:${sceneId}/${kind}` is always valid.
- **Android**: `Repository.deleteChapter/Scene/Unit` now calls `clearCache()`
  (LruCache evictAll + SimpleDiskCache evictAll) after the API delete.
  `EditFragment` calls `playbackViewModel.removeDeletedScenesFromQueue()`
  to clear the player queue.
- Details in §7.

### 2.8 Dirty / Regeneration — ❌ not triggered (Medium M3)

- Entity-delete does not bump `content_version`, does not set `dirty_unit_ids`, does not
  call `book-sync`, and does not mark scenes dirty (unlike
  `PUT /book/:bookId` → `bumpSceneVersions`, `core-routes.cjs:239`).
- Content correctness is preserved only because user-initiated generations
  use `rebuild_all` (`generateStore.startGeneration`,
  `generateStore.ts:734-744`), which iterates **all scenes from JSON** —
  deleted scenes are not included. But intermediate statuses (assets-state,
  queue) remain "ghostly" until full regeneration.

### 2.9 Frontend state — ✅ fixed

**Fixed** as part of Local Cache Invalidation (§7).

- **Web**: after deletion: `invalidateDeletedScene/Chapter` → cache + player queue
  cleanup → re-fetch → `navigateTo` with clamp. The deleted scene is removed from
  `sceneQueue` and `preloadCache`; the current scene is marked `needsContentRefresh`.
- **Android**: `removeDeletedScenesFromQueue` → queue + preload cache cleanup →
  `reloadStructureAndReposition` → fresh JSON → `SharedPositionManager.navigateTo`.
  `Repository.deleteChapter/Scene/Unit` calls `clearCache()`.
- Details in §7.

---

## 3. Invalidation Matrix

`❌` — nothing is done, `⚠️` — partial/indirect, `✅` — done.

| Operation | JSON (book) | Chapter files (`chapters/`) | OUTPUT_DIR (audio/chunk/IU/pr/video) | PG (scenes, scene_assets, tasks, image_units, asset_states, ...) | Redis (chunks, asset-state, active-index, registry, dispatch) | GPU queue / in-flight | Web media cache | Android SimpleDiskCache/VideoCache | Dirty / version |
|---|---|---|---|---|---|---|---|---|---|---|
| **Delete Unit** | ✅ (units inline) | ✅ (n/a) | ❌ `_iu<uid>.png`/`_pr<uid>.png` | ❌ (image_units, scene_assets) | ❌ (chunks/registry remain) | ❌ | ✅ (evictSceneMedia + queue) | ✅ (clearCache) | ❌ |
| **Delete Scene** | ✅ | ✅ (chapter rewritten) | ❌ `.mp3`, chunks, `_iu*`, `_pr*`, `.mp4` | ❌ (all scene rows) | ❌ (chunks, asset-state, active, registry, audio-orch, iu-progress) | ❌ | ✅ (evictSceneMedia + queue) | ✅ (clearCache + queue) | ❌ |
| **Delete Chapter** | ✅ | ✅ (orphan file removed) | ❌ (all scene files in chapter) | ❌ (all scene rows in chapter) | ❌ | ❌ | ✅ (evictChapterMedia + queue) | ✅ (clearCache + queue) | ❌ |
| **Delete Book** (gold standard) | ✅ (`resetBook`) | ✅ | ✅ (build dir + prefix) | ✅ (27 tables) | ✅ (`cleanBookRedisKeys` + cancel) | ✅ (`/queue/clear`) | ✅ (`clearMediaCache` on client) | ✅ (client-side `clearCache`) | ✅ |

**Summary:** For Chapter/Scene/Unit, only the **JSON layer, chapter file, local web cache
(Cache API + player queue), and Android (LruCache + SimpleDiskCache + player queue)** are cleaned.
All other server-side layers (OUTPUT_DIR, PG, Redis, GPU queue) are not (see §4).

---

## 4. Findings

| # | Severity | Component | Current | Expected | Risk | Fix (направление) |
|---|---|---|---|---|---|---|
| **C1** | **Critical** | `entity-crud-routes.cjs` + `book-sync.js` | Удаление сцены/главы/юнита не удаляет PG-строки. `purgeRemovedSceneRows` вызывается только из `PUT /book` и для entity-delete физически не детектирует «removed» (JSON уже сохранён). Даже при вызове не покрывает `asset_states`, `cache_entries`, `output_manifests`, `book_events`, `book_source`, `book_generation_sessions`, `chat_*`, `sentence_resolutions`, `character_mentions`. | Удаление сущности синхронно чистит все её PG-строки (по образцу `DELETE /book`). | Утечка данных, рост таблиц, «призрачные» задачи/ассеты в статусах и метриках; version-stale проверки видят удалённые сцены. | Выделить scene/chapter-level purge (аналог `purgeRemovedSceneRows`, расширить список таблиц) и вызывать его из DELETE-хендлеров после `saveBookBundle`. |
| **C2** | **Critical** | Redis + `chunks-routes.cjs` | Чанки, per-asset states, active-index, asset-registry, dispatch/audio-orch ключи удалённой сцены не чистятся. `GET /chunks` и `/assets-state` строят очередь/статус из Redis без фильтра по JSON → удалённая сцена остаётся в очереди воспроизведения (web+Android) и в статусах. | Удаление сцены убирает её Redis-ключи и исключает из очереди/статусов. | Пользователь «видит» и может проигрывать удалённые сцены; путаница в UI; рост Redis. | Scene-level Redis cleanup (chunks+set, asset-state, active-index, registry, audio-orch, iu-progress/in-flight, dispatch) + фильтр `GET /chunks` по book JSON. |
| **C3** | **Critical** | Dispatch / workers | При удалении не отменяются in-flight dispatch (leases), GPU job'ы и cancel-флаги. Воркеры дорабатывают и пишут файлы+PG+Redis для удалённой сцены. | Удаление отменяет in-flight генерацию удаляемых сцен (как `DELETE /book`: cancelled-workers + setCancelFlag + clearHubDispatches). | Orphan-файлы и строки, лишние GPU-затраты, «воскрешение» состояния удалённой сцены через колбэки. | В DELETE-хендлерах: `clearLeasesForScenes`/`clearHubDispatches` для удаляемых сцен, `setCancelFlag`, GPU `/queue/clear` с фильтром сцены. |
| **H1** | **High** | filesystem-store / cleanup-service | Файлы удалённой сцены/главы (mp3, чанки, `_iu*`, `_pr*`, mp4) остаются в OUTPUT_DIR навсегда; GC на уровне сцены отсутствует. | Удаление сцены удаляет её файлы; фоновый sweep чистит orphan-файлы (нет ссылок из JSON). | Дисковый мусор, риск путаницы при восстановлении, лишняя площадь под «воскрешение». | Удалять файлы по префиксу `{bookId}_{ch}_{sc}`/`{bookId}_{ch}` при delete; или фоновый GC по book JSON. |
| **H2** | **High** | generation-routes.cjs / resetScenes | Pre-delete stale PNG (dirty-unit path) работает только при `/regenerate` через `cleanPngUnitIds`; для entity-delete не выполняется. IU/preview PNG удалённого юнита остаются. | Удаление юнита удаляет его `_iu<uid>.png`/`_pr<uid>.png` и чистит `image_units`/`scene_assets` строки. | Orphan-изображения, повторное использование id исключено, но мусор растёт. | Добавить unit-level cleanup (файлы + PG) в DELETE unit. |
| **M1** | **Medium** | runtime-persistence / reconciliation | Снапшот runtime (leases/dispatch metadata/retry) может «восстановить» active-состояние удалённой сцены после рестарта (снапшот снят до удаления). Recovery не вычищает stale-данные удалённых сцен. | После рестарта удалённые сцены не возвращаются в runtime. | Временный «призрак» в runtime до self-heal. | В reconcile/startup проверять сцены снапшота против book JSON и отбрасывать отсутствующие. |
| **M2** | **Medium** | mediaCache.ts (web) / Repository.kt + SimpleDiskCache + VideoCache (Android) | ✅ **Исправлено** (§7). Web: `evictSceneMedia/evictChapterMedia` + `clearPreloadCache` + queue. Android: `clearCache()` + `removeDeletedScenesFromQueue`. | — | — | — |
| **M3** | **Medium** | book-diff / book-sync / generateStore | Entity-delete не помечает затронутые сцены dirty и не bump'ит версии; dirty-индикатор и регенерация живут только через `/regenerate` (rebuild_all). | Удаление юнита/сцены помечает соседние/затронутые сцены dirty (согласованный regen). | UI показывает «чисто», хотя структура изменилась; статусы «призрачные» до следующей генерации. | Вызывать diff/version-bump после delete (по образцу `PUT /book`). |
| **M4** | **Medium** | asset-registry.js | `deleteChapterAssetsRedis`/`deleteBookAssetsRedis` зовут `storage.scanKeys(...)`, которого нет в filesystem-store → TypeError при вызове. Ни одна из трёх delete-функций нигде не вызывается. | Scene/chapter/book asset-registry чистка работает и вызывается. | Латентный баг, «мёртвый» код. | Внедрить `scanKeys` или использовать `redis.scan`; вызвать из DELETE-хендлеров (см. C2). |
| **M5** | **Medium** | EditPage.tsx / EditFragment.kt / playbackStore | ✅ **Исправлено** (§7). Web: `invalidateDeletedScene/Chapter` обновляет queue + `needsContentRefresh`. Android: `removeDeletedScenesFromQueue` + `reloadStructureAndReposition`. | — | — | — |
| **L1** | **Low** | book/index.js | Orphan-очистка файлов глав выполняется только при `chapterFilenames.length > 0`; guard «последняя глава» защищает инвариант. | — (инвариант держится). | Нет практического риска; стоит зафиксировать инвариант в коде. | — |
| **L2** | **Low** | redis-helpers / recover-chunks | `recover*` только добавляют (create) чанки/плейсхолдеры по book JSON, никогда не удаляют stale-данные удалённых сцен. | — (не воскрешает, но и не чистит). | Усиливает C2/H1: stale-данные накапливаются. | Sweep stale-чанков/файлов в reconcile (см. C2/H1). |
| **L3** | **Low** | scene-orchestrator.js | `loadedBook || book.loadBook(bookId)` — если `loadedBook` устарел (кэш тика), self-heal может не сработать до следующего тика. | — (self-heal обычно срабатывает). | Кратковременный лишний dispatch-цикл. | Свежевать book кэш перед dispatch. |

---

## 5. Race Conditions

| # | Scenario | Current Behavior | Risk |
|---|---|---|---|
| R1 | Delete scene during in-flight generation | Worker completes, writes files + PG + Redis for the deleted scene | Orphan files/rows/state, "ghost" in statuses (C2+C3) |
| R2 | Delete ‖ `PUT /book` (editor save) on web/two devices | PUT with stale `bookData` can overwrite JSON and "restore" the just-deleted scene (TOCTOU; delete is not blocked on client) | Deleted scene reappears in JSON |
| R3 | Delete ‖ scheduler tick | Tick sees scene in active index → dispatch → executor `scene_not_found` → removes from active index | Extra cycle, but self-heal works (safe) |
| R4 | Delete ‖ backend restart | Runtime snapshot from before deletion "restores" lease/metadata of the deleted scene; recovery by book JSON doesn't filter it out | Temporary ghost until self-heal (M1) |
| R5 | Delete ‖ `recoverMissingPlaceholders` | Recovery follows book JSON — doesn't touch the deleted scene | Safe |

---

## 6. Recommendations (prioritized)

1. **Scene/Chapter/Unit-level cleanup function** (modeled after `DELETE /book`):
   - PG: purge by `book_id+chapter_id(+scene_id)` for all book tables;
   - Redis: delete chunks + set, asset-state, active-index, asset-registry,
     audio-orch, iu-progress/in-flight, dispatch lease/meta/retry for deleted scenes;
   - FS: delete files by prefix;
   - GPU: cancel in-flight (leases + hub queue) for deleted scenes;
   - call from DELETE handlers in `entity-crud-routes.cjs` **after** `saveBookBundle`.
2. **Filter `GET /chunks` and `/assets-state` by book JSON** — remove
   "ghost" scenes from the playback queue (C2) without waiting for Redis cleanup.
3. **Call book-diff/reconcile** after delete (M3) — bump versions of adjacent scenes
   so UI and regeneration are coordinated.
4. **✅ Local cache invalidation (M2/M5)** — implemented (§7): web — `evictSceneMedia`/`evictChapterMedia` + player queue; Android — `clearCache()` + `removeDeletedScenesFromQueue`.
5. **Fix `asset-registry.js`** (scanKeys) or remove dead functions (M4).
6. **Background GC** of orphan files/chunks per book JSON in reconcileCycle (H1/H2/L2).

---

## 7. Local Cache Invalidation (implemented)

> Section added after implementing cache invalidation in both frontends.
> Covers M2/M5 from §4 Findings.

### 7.1 Goal

After a successful DELETE Chapter/Scene/Unit on the server:
- Local cache (Cache API / SimpleDiskCache) contains no data for the deleted entity.
- Player queue does not reference deleted scenes.
- Navigator / Editor reflect the current server state.
- The deleted entity cannot "resurrect" from cache.

### 7.2 Cache Mechanisms (audit)

| Mechanism | Key | Stores | Cache Type |
|---|---|---|---|
| **Web Cache API** (`animastor-media`) | `/${buildId}/${chapterId}:${sceneId}/${kind}` | audio/video/image/preview/iu blobs | book-level + scene-level |
| **Web Preload Cache** (Map) | `${buildId}_${chapterId}:${sceneId}` | PreloadedScene (audio + IU blobs) | book-level + scene-level |
| **Web In-flight Assets** (Map) | `${buildId}_${chapterId}:${sceneId}` | Fetch promises (dedup) | book-level + scene-level |
| **Web localStorage** | `animastor:currentBook` | `{id, build}` — book session | book-level |
| **Android LruCache** (50MB) | `audio_${id}_${buildId}`, `iu_${bookId}_${ch}_${sc}_${iuId}_${buildId}` | audio/video/image blobs | entity-level + build-level |
| **Android storyboardCache** (500) | `${sceneKey}_${buildId}` | StoryboardResponse JSON | scene-level |
| **Android chunkCache** (500) | `${id}_${buildId}` | ChunkResponse JSON | entity-level |
| **Android SimpleDiskCache** | `audio/video/image/preview/iu/${sanitized(key)}` | files on disk | entity-level |
| **Android SharedPreferences** | `bookId`, `buildId` | current book | book-level |

### 7.3 Invalidation Matrix (local cache)

| Operation | Web Cache API | Web Preload Cache | Web Player Queue | Android LruCache | Android SimpleDiskCache | Android Player Queue | Navigator | Editor |
|---|---|---|---|---|---|---|---|---|
| **Delete Module** | `evictSceneMedia(ch, sc)` | `clearPreloadCache()` | — (unit within scene) | `clearCache()` | `clearCache()` (evictAll) | — (unit within scene) | refresh (server fetch) | refresh |
| **Delete Scene** | `evictSceneMedia(ch, sc)` | `clearPreloadCache()` | remove scene from queue | `clearCache()` | `clearCache()` (evictAll) | `removeDeletedScenesFromQueue()` | refresh | refresh |
| **Delete Chapter** | `evictChapterMedia(ch)` | `clearPreloadCache()` | remove all ch scenes | `clearCache()` | `clearCache()` (evictAll) | `removeDeletedScenesFromQueue()` | refresh | refresh |

### 7.4 Implementation — Web

**mediaCache.ts** — new functions:
- `evictSceneMedia(buildId, chapterId, sceneId)` — removes Cache API entries for a scene.
- `evictChapterMedia(buildId, chapterId)` — removes entries for all scenes in a chapter.
- Cache key format: `/${buildId}/${chapterId}:${sceneId}/${kind}` — always a valid URL.

**playbackStore.ts** — new functions:
- `invalidateDeletedScene(chapterId, sceneId, buildId)` — removes from preloadCache, sceneQueue, calls `evictSceneMedia`.
- `invalidateDeletedChapter(chapterId, sceneIds, buildId)` — equivalent for a chapter.
- `invalidateDeletedBook()` — full cleanup (book delete).
- When deleting the current scene: `stopAll()` or `needsContentRefresh = true`.

**EditPage.tsx** — `confirmDeleteStructure`:
1. `await deleteJson(path)` — server deletes.
2. `invalidateDeletedScene/Chapter(...)` — targeted cache + queue invalidation.
3. `getJson<BookData>(...)` — fresh data from server.
4. `navigateTo(...)` — re-anchor position.

### 7.5 Implementation — Android

**Repository.kt** — `deleteChapter/Scene/Unit`:
- After `api.deleteChapter/Scene/Unit(...)`, `clearCache()` is called (LruCache + SimpleDiskCache).
- Guarantees stale blobs of the deleted entity cannot be loaded from cache.

**PlaybackViewModel.kt** — `removeDeletedScenesFromQueue(deletedSceneKeys)`:
- Removes scenes from `preloadCache` and `sceneQueue`.
- Clamps `currentIndex`.
- If queue is empty → `clearCache()` + IDLE.
- If current phase is PLAYING/PAUSED → `needsContentRefresh = true`.

**EditFragment.kt** — `showDeleteStructureConfirm`:
1. Collects `deletedSceneKeys` before the API call (from current `chapters`).
2. `viewModel.repository.deleteChapter/Scene/Unit(...)` — server + cache clear.
3. `playbackViewModel.removeDeletedScenesFromQueue(deletedSceneKeys)` — queue cleanup.
4. `reloadStructureAndReposition()` — fresh data + position.

### 7.6 Failure Behavior

| Scenario | Behavior |
|---|---|
| DELETE server succeeded + cache invalidation succeeded | Full sync: cache empty, queue current, position anchored |
| DELETE server succeeded + cache invalidation failed | Cache may contain stale data, but server JSON is the source of truth; next `getJson<BookData>` overwrites local state |
| DELETE server failed | Local cache untouched; error shown in UI |
| App restart after DELETE | On boot: `restoreBookSession` loads book from localStorage → `ensureInitialized` fetches fresh JSON → stale cache not used |

### 7.7 Key Invariants

1. **Server = source of truth**: after DELETE, server JSON is authoritative; local cache is a derived copy.
2. **Targeted invalidation**: `evictSceneMedia` removes only entries for a specific scene; not a full wipe (saves traffic).
3. **Android: full wipe**: `clearCache()` after delete — simplified approach since `SimpleDiskCache.remove()` doesn't support prefix-based deletion.
4. **Player queue**: always reflects current JSON; deleted scene is removed from queue before next `playNext`.
5. **Cache key format**: always a valid URL (`/buildId/chapterId:sceneId/kind`); never `//ch-...` or invalid key.

---

## 8. Dirty / Invalidation / Regeneration Audit

> READ-ONLY audit: production code was not changed.
> Date: 2026-08-19. Continuation of DELETE Lifecycle Audit (§1-7).

### 8.1 Current Architecture — Dirty-State Flow

**CANONICAL dirty-state pipeline** (PUT /book → regenerate):

```
PUT /book/:bookId
  → saveBookBundle (JSON to disk)
  → loadBook (read new)
  → bookDiff.computeBookDiff(old, new)
      → promptDependencyRegistry.computeSceneDirtyLayers(oldScene, newScene)
      → cross-field diff (characters.passport, characters.voice, bible.locations, book.voices)
  → bookSync.reconcileFromDiff(bookId, dirtyScenes, newBook)
      → updateSceneHashes (PG)
      → markSceneAssetsStale (PG scene_assets.status → 'stale')
      → markGenerationTasksStale (PG generation_tasks.status → 'cancelled')
      → purgeRemovedSceneRows (PG DELETE for removed scenes)
  → sceneAssetsRepo.bumpSceneVersions(bookId, dirtyScenes)
      → content_version++ (if image or video dirty)
      → audio_config_version++ (if audio dirty)
      → is_dirty = TRUE
  → sceneAssetsRepo.setDirtyUnitIds(bookId, chapterId, sceneId, unitIds)
      → dirty_unit_ids = [list of changed unit IDs]
  → markDirtyScenes (Redis: chunk status → pending, asset states → pending)
```

**Entity-delete paths** (entity-crud-routes.cjs):

| Operation | saveBookBundle | book-diff | reconcileFromDiff | bumpSceneVersions | setDirtyUnitIds | markDirtyScenes | entity-cleanup |
|---|---|---|---|---|---|---|---|
| DELETE Chapter | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| DELETE Scene | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (purgeScene) |
| DELETE Unit | ✅ | ❌ | ❌ | ✅ (via invalidateScene) | ✅ (remove deleted) | ✅ (via invalidateScene) | ✅ (purgeUnit) |

**Key difference**: entity-delete paths SKIP the book-diff pipeline entirely. Only DELETE Unit triggers dirty marking (via `entity-cleanup.invalidateScene`). DELETE Chapter and DELETE Scene do NOT mark any remaining entities dirty.

### 8.2 Dirty Sources

| Source | Where set | When cleared | Who reads |
|---|---|---|---|
| **is_dirty** (PG scenes table) | `bumpSceneVersions` (PUT, delete unit) | Generation completion callback | runtime-scheduler, reconciliation-engine |
| **content_version** (PG scenes) | `bumpSceneVersions` (PUT, delete unit) | Never (monotonic) | scene-assets-repo (staleness check), scene-window, orchestrator |
| **audio_config_version** (PG scenes) | `bumpSceneVersions` (PUT) | Never (monotonic) | scene-assets-repo (staleness check), scene-window |
| **dirty_unit_ids** (PG scenes) | `setDirtyUnitIds` (PUT, delete unit callback) | `clearDirtyUnitIdsAfterImageDispatch` (image callback) | executeImageDispatch (granular force-regen), reconciliation-engine |
| **scene_assets.status** (PG) | `markSceneAssetsStale` (PUT, delete unit invalidateScene) | Generation completion (scene_assets.status → 'ready') | runtime-scheduler (dispatch decision) |
| **Redis chunk status** | `markDirtyScenes` (PUT) | Generation executor | audio/image/video orchestrators |
| **Redis per-asset states** | `markDirtyScenes` (PUT), `fallbackMarkSceneDirty` | Generation executor | runtime-scheduler |
| **Redis active-scenes** | `addActiveScene` (PUT markDirty), `removeSceneFromActiveIndex` | Scheduler (post-generation) | runtime-scheduler (dispatch scan) |

### 8.3 Version Semantics

| Entity | Version Field | Who bumps | Trigger | Consumers |
|---|---|---|---|---|
| Scene | `content_version` (INTEGER, default 1) | `bumpSceneVersions` | image or video layer dirty (PUT, delete unit) | scene-assets-repo (staleness: asset.scene_content_version < scene.content_version), scene-window, orchestrator, reconciliation-engine |
| Scene | `audio_config_version` (INTEGER, default 1) | `bumpSceneVersions` | audio layer dirty (PUT) | scene-assets-repo (staleness: asset.scene_audio_config_version < scene.audio_config_version), scene-window |
| Scene | `is_dirty` (BOOLEAN) | `bumpSceneVersions` | Same as content_version bump | runtime-scheduler (secondary dirty detection after Redis flush) |
| Scene | `dirty_unit_ids` (TEXT[]) | `setDirtyUnitIds` | Unit content changed (PUT), unit deleted (cleanup) | executeImageDispatch (granular force-regen of specific IUs), reconciliation-engine |
| Scene | `scene_hash` (TEXT) | `updateSceneHashes` (PUT only) | Content hash changed | reconcileFromDiff (hash-based staleness detection) |
| Scene_asset | `scene_content_version` (INTEGER) | Asset generation callback | Written when asset is generated | scene-assets-repo (staleness comparison with scene.content_version) |
| Scene_asset | `scene_audio_config_version` (INTEGER) | Asset generation callback | Written when audio asset is generated | scene-assets-repo (staleness comparison with scene.audio_config_version) |
| Scene_asset | `status` (TEXT) | markSceneAssetsStale / generation callback | Content changed / generation completed | runtime-scheduler (dispatch decision: 'stale' → PENDING) |

### 8.4 Module (Unit) Deletion

**Scenario**: Scene has Units A, B, C. Unit B is deleted.

**What is deleted**:
- Unit B from JSON (in-memory + saved via saveBookBundle)
- PG: `image_units` row for unit B
- PG: `dirty_unit_ids` entry for unit B removed from parent scene
- Redis: `iu-registry`, `iu-in-flight`, `job`, `result` keys for unit B
- Redis: dispatch leases + GPU hub jobs for unit B (cancelled)
- Filesystem: IU image PNG + preview PNG for unit B

**What is marked dirty (via `invalidateScene` in entity-cleanup)**:
- Parent scene: `dirty_layers: ['audio', 'image', 'video']`
- `reconcileFromDiff`: scene hash updated, scene_assets → stale, generation_tasks → cancelled
- `bumpSceneVersions`: `content_version++`, `is_dirty = TRUE`

**What is NOT marked dirty**:
- Sibling units (A, C) — NOT dirty
- Other scenes — NOT dirty
- Other chapters — NOT dirty

**Audio dependency chain analysis**:

```
Unit B deleted
  → units array changes (prompt-dependency-registry detects)
  → dirty_layers includes 'audio' (unit order/content changed)
  → content_version++ (image or video dirty)
  → scene regenerated
```

**Critical finding — narration scene audio**:
- `buildSegments` reads `scene.audio.full_text` (explicit field, NOT derived from units)
- When Unit B is deleted, `audio.full_text` may still contain Unit B's text
- The dirty marking triggers audio regeneration, but `audio.full_text` is not automatically updated
- **Consequence**: narration scene audio may re-generate with stale text (including deleted unit's content)
- **Mitigation**: dialogue scenes read from `units[].audio.text` directly — deletion works correctly
- **GAP**: no mechanism to auto-update `audio.full_text` when units are added/removed

**Image dependency chain analysis**:

```
Unit B deleted
  → units array changes
  → dirty_layers includes 'image' (unit content changed)
  → dirty_unit_ids set to [B] (if via PUT) OR full scene marked dirty (via delete)
  → image dispatch reads current units array
  → Unit B is absent from units → no image generated for it
  → Scene IU composition correct
```

**Video dependency chain analysis**:

```
Image regenerated → video depends on images → video dirty
  → dirty_layers includes 'video' (cascading from image)
  → video regenerated with new IU composition
```

**Verdict**: Unit deletion → parent scene correctly invalidated for all three layers. Sibling units NOT affected. Narration scene `audio.full_text` may be stale (GAP-1).

### 8.5 Scene Deletion

**Scenario**: Chapter has Scenes A, B, C. Scene B is deleted.

**What is deleted**:
- Scene B from JSON
- PG: `scene_assets`, `generation_tasks`, `image_units`, `storyboard_elements`, `audio_layers`, `asset_states`, `cache_entries`, `scenes` rows
- Redis: chunks, chunk set, asset-state, asset-registry, active-index, audio/video orchestrator, dispatch leases, iu-progress/registry/in-flight, GPU job/result keys
- Filesystem: scene audio, chunks, IU images, previews, video
- Active index: scene removed
- In-flight: dispatch leases + GPU hub jobs cancelled

**What is NOT marked dirty**:
- Sibling scenes (A, C) — NOT dirty
- Chapter — NOT dirty (no chapter-level dirty mechanism exists)
- Book — NOT dirty

**Minimal regeneration scope**: NONE. The deleted scene is gone; remaining scenes have unchanged content.

**GAP-2**: Scene A's image prompts may use lookahead context from Scene B (`nextScene` parameter in `stepCreateScenes`). After Scene B is deleted, Scene A's visual prompt context changes — but Scene A is NOT marked dirty. This is a minor issue because:
- Lookahead context is advisory (character disambiguation), not core content
- The dirty marking system does not track cross-scene dependencies
- Visual quality may be slightly affected but content is correct

### 8.6 Chapter Deletion

**Scenario**: Book has Chapters 1, 2, 3. Chapter 2 is deleted.

**What is deleted**:
- Chapter 2 from JSON
- Chapter 2 orphan file removed from `chapters/` directory
- Guard: cannot delete last chapter (HTTP 400)

**What is NOT done**:
- No PG cleanup (scene_assets, generation_tasks, etc. for chapter 2's scenes remain)
- No Redis cleanup (chunks, asset-state, active-index for chapter 2's scenes remain)
- No filesystem cleanup (audio/video/image files for chapter 2's scenes remain)
- No dispatch cancellation (in-flight generation for chapter 2's scenes continues)
- No version bump for any remaining entity
- No dirty marking for any remaining entity
- No book-diff computation

**GAP-3 (Critical)**: Chapter deletion performs ONLY JSON save. No derived state is cleaned up. Chapter 2's scenes leave orphan PG rows, Redis keys, filesystem files, and potentially in-flight GPU jobs.

**What SHOULD happen** (per DELETE /book ethalon): For each scene in the deleted chapter, call `purgeScene` (PG + Redis + FS + dispatch cancel).

**Minimal regeneration scope**: NONE for remaining chapters (their content hasn't changed).

### 8.7 Audio Dependencies

```
Scene Text (audio.full_text)
  → buildSegments (TTS input)
  → generateSceneAudio (GPU dispatch)
  → audio chunks (Redis + filesystem)
  → mergeSceneAudioChunks (FFmpeg)
  → scene audio file
  → waveform
  → player
```

| DELETE | Scene Text | buildSegments | Audio Regen Needed? |
|---|---|---|---|
| Unit B | `audio.full_text` NOT auto-updated (narration) / Units[].audio.text changed (dialogue) | Reads `full_text` (narration) or `units[].audio.text` (dialogue) | YES (dirty marked) |
| Scene B | Deleted | N/A | NO (scene gone) |
| Chapter 2 | Deleted scenes' text gone; remaining scenes unchanged | N/A for deleted; unchanged for remaining | NO |

**GAP-1 detail**: For narration scenes, `audio.full_text` is an explicit field set by the AI during scene generation. It is NOT derived from unit texts. When a unit is deleted, `full_text` remains stale unless manually edited. The dirty marking triggers audio regeneration, but the regenerated audio reads the stale `full_text`. This means narration audio may contain the deleted unit's text.

For dialogue scenes, `buildSegments` reads `units[].audio.text` directly — deletion correctly excludes the deleted unit's dialogue.

### 8.7a audio.full_text — VERIFIED (code-level audit)

**Canonical pipeline** (traced from source):

```
scene-orchestrator.executeAudioDispatch
  → book.findSceneRuntimeData(bookData, ch, sc)
      returns { runtime_type: 'scene', scene_type: scene.type || 'narration', payload: scene }
  → audio.generateSceneAudio(redis, sceneData, loadedBook, buildId, ...)
      → segments.buildSegments(sceneData)
```

**buildSegments (segments.js:200+)** — two paths:

| Path | Condition | Text Source | full_text used? |
|---|---|---|---|
| **Narration** | `runtime_type === 'scene'` AND `scene_type ∈ {narration, chapter_intro, cover}` | `runtimeEntry.payload?.audio?.full_text` | ✅ YES — ONLY source |
| **Dialogue** | `runtime_type === 'scene'` AND `scene_type === 'dialogue'` | `units[].audio.text` (dialogue) + `units[].text` (narration units within dialogue) | ❌ NO — not used for TTS |
| **Other** | Neither of the above | Returns `[]` (no segments) | N/A |

**Key finding**: For narration scenes, `buildSegments` reads `audio.full_text` EXCLUSIVELY. It does NOT read `unit.text` at all. The `assignNarrationUnitIds` call at the end is research-only (binds segment→unit mapping), not a text source.

**Semantics of `audio.full_text`**:
- Initially set by AI during scene generation (`pipeline-steps.js:1163`)
- Editable in the Editor Audio tab (PATCH endpoint)
- `rebuildFullText()` (scene-patch-utils.cjs) syncs it from unit texts after mutations
- Acts as **derived field with manual override**: normally matches unit texts, but user can diverge
- After unit mutation, `rebuildFullText` overwrites to match current units (correct: units are the structural source)

**Unit.type dependency**:
- `Unit.type` does NOT affect narration text source (all unit texts joined regardless of type)
- `Unit.type` IS significant in dialogue path (determines dialogue vs narration segment type)
- `rebuildFullText` triggers on type change as safety measure (structural change → rebuild)
- Verified correct: rebuild produces identical text for type-only changes, but handles edge cases (type change from dialogue→narration within mixed scene)

**Mutation matrix** (verified against code):

| Mutation | full_text change? | Triggered by | Audio dirty? |
|---|---|---|---|
| Delete Unit | ✅ rebuilt from remaining units | `entity-crud-routes.cjs` → `rebuildFullText(sc)` | YES (via purgeUnit → invalidateScene) |
| Edit Unit.text | ✅ rebuilt from updated units | `core-routes.cjs` PATCH → `rebuildFullText(targetScene)` | YES (via book-diff → bumpSceneVersions) |
| Add Unit | ✅ rebuilt with new unit | `entity-crud-routes.cjs` → `rebuildFullText(sc)` | YES (via book-diff) |
| Edit Unit.type | ✅ rebuilt (safety measure) | `core-routes.cjs` PATCH → `rebuildFullText(targetScene)` | YES (if type changes affect generation) |
| Replace scene (full) | ✅ rebuilt from incoming units | `core-routes.cjs` PATCH → `rebuildFullText(incomingScene)` | YES (via book-diff) |
| Edit audio.full_text directly | ✅ set by user (no rebuild) | `core-routes.cjs` PATCH → `setDeep(targetScene, 'audio.full_text', value)` | YES (via book-diff) |
| Reorder units | N/A — no reorder endpoint | — | — |

**Dialogue scene verification**: `buildSegments` for dialogue scenes reads `units[].audio.text` (dialogue) and `units[].text` (narration-perception units). `audio.full_text` is NOT used for TTS. `rebuildFullText` correctly skips dialogue scenes. VERIFIED.

### 8.8 Image Dependencies

```
Scene payload (units, participants, location, passport)
  → buildImagePrompt (per IU)
  → GPU dispatch (image generation)
  → IU images
  → scene composition
```

| DELETE | Units Array | Participants | Location | Image Regen? |
|---|---|---|---|---|
| Unit B | Array changes (B removed) | Unchanged | Unchanged | YES (parent scene) |
| Scene B | Deleted | Deleted | Deleted | NO (scene gone) |
| Chapter 2 | Deleted scenes' units gone; remaining unchanged | Unchanged | Unchanged | NO |

**Image reads units directly**: `iu-processor.js:178` calls `promptBuilder.buildImagePrompt(unit, sceneData.payload, ...)` — reads current units array. Deleted unit absent → no image generated. Correct behavior.

### 8.9 Video Dependencies

```
Audio (timeline) + Images (IU sequence) + Timing + Scene structure
  → video generation (GPU dispatch)
  → scene video
```

| DELETE | Audio Changed? | Images Changed? | Timing Changed? | Video Regen? |
|---|---|---|---|---|
| Unit B | YES (dirty marked) | YES (dirty marked) | YES (waveform changes) | YES (cascading from image) |
| Scene B | N/A | N/A | N/A | NO (scene gone) |
| Chapter 2 | N/A | N/A | N/A | NO |

**Video depends on images** (pipeline dependency): when images are regenerated, video is automatically marked dirty via cascading dirty layers.

### 8.10 Generation Race Conditions

| Scenario | Current Behavior | Risk |
|---|---|---|
| DELETE Unit during in-flight generation | `purgeUnit` cancels dispatch leases + GPU hub jobs via `clearLeasesForScenes` + `clearHubDispatches`. Stale GPU result keys deleted. | LOW — properly handled |
| DELETE Scene during in-flight generation | `purgeScene` cancels dispatch leases + GPU hub jobs. | LOW — properly handled |
| DELETE Chapter during in-flight generation | ✅ **FIXED**: Each scene in the deleted chapter is now purged via `purgeScene`, which cancels in-flight dispatch leases + GPU hub jobs. | LOW — handled |
| Generation started with version N → entity deleted → generation finishes → stale result lands back? | **Unit delete**: dispatch cancelled before result lands; `purgeUnit` deletes result keys. **Scene delete**: dispatch cancelled. **Chapter delete**: ✅ dispatch cancelled via `purgeScene` per scene. | LOW — handled |
| Version-stale protection after delete | `detectVersionStale` in runtime-scheduler checks `asset.scene_content_version < scene.content_version`. After delete-unit, `content_version` is bumped → stale assets detected. After delete-scene/chapter, no version bump → no staleness signal. | CORRECT for unit delete; N/A for scene/chapter (entities are gone) |

### 8.11 Recovery / Reconciliation

| Scenario | Current Behavior | Risk |
|---|---|---|
| App restart after DELETE Unit | JSON saved → book loads without deleted unit. PG has `is_dirty=TRUE` + bumped `content_version` → reconciliation detects stale assets → regenerates. | LOW — self-heals |
| App restart after DELETE Scene | JSON saved → book loads without scene. PG rows purged by `purgeScene`. Redis cleaned. Remaining scenes unchanged. | LOW if purge succeeded; MEDIUM if purge partial (pending-purge retry mechanism exists) |
| App restart after DELETE Chapter | JSON saved → book loads without chapter. PG rows NOT purged (GAP-3). Redis NOT cleaned. Orphan state remains. | HIGH — orphan PG/Redis/FS state persists until manual cleanup |
| Old dirty_unit_ids after restart | `reconciliation-engine.js:1960-1965` reads `dirty_unit_ids` from PG and marks image PENDING. Correctly restores regeneration intent. | LOW — properly handled |
| Old is_dirty after restart | runtime-scheduler reads `is_dirty` from PG as secondary detection. Correctly re-activates dispatch. | LOW — properly handled |

### 8.12 Minimal Regeneration Matrix

| Operation | Deleted | Must Dirty | Must Version Bump | Must Regenerate | Must NOT Regenerate |
|---|---|---|---|---|---|
| **Delete Unit** | Unit from scene | Parent scene (audio+image+video) | Parent scene content_version++ | Parent scene audio, image, video | Sibling units, other scenes, other chapters |
| **Delete Scene** | Scene from chapter | NONE (remaining scenes unchanged) | NONE | NONE | Sibling scenes, chapter, book |
| **Delete Chapter** | Chapter from book | NONE (remaining chapters unchanged) | NONE | NONE | Other chapters, book |

**Key principle**: DELETE ≠ regenerate everything. Only the deleted entity's parent needs regeneration (for unit delete). Scene/chapter delete requires NO regeneration of remaining content.

### 8.13 Findings

| # | Severity | Component | Current | Expected | Gap | Consequence |
|---|---|---|---|---|---|---|
| **G1** | **Critical** | entity-crud-routes.cjs (DELETE Chapter) | ✅ **FIXED**: DELETE Chapter now iterates all scenes and calls `cleanup.purgeScene()` for each, with per-scene error handling and cleanup result reporting. Reuses existing canonical `purgeScene` — no new mechanism. | — | — | — |
| **G2** | **High** | entity-crud-routes.cjs (DELETE Scene) | `purgeScene` called — PG+Redis+FS+dispatch properly cleaned. | — (handled) | — | — |
| **G3** | **High** | entity-cleanup.cjs (DELETE Unit) | `invalidateScene` marks parent scene dirty for audio+image+video, bumps content_version, cancels tasks. | — (handled) | — | — |
| **G4** | **Medium** | audio/segments.js + pipeline-steps.js + scene-patch-utils.cjs | ✅ **FIXED**: `rebuildFullText(scene)` in `scene-patch-utils.cjs` joins remaining unit texts into `audio.full_text` after unit add/delete/field-edit. Called from entity-crud-routes (add/delete unit) and core-routes (PATCH unit fields). Dialogue scenes preserved. | — | — | — |
| **G5** | **Medium** | prompt-dependency-registry.js | Cross-scene dependencies (lookahead context) not tracked. Deleting Scene B does not mark Scene A dirty even though A's visual prompt used B as nextScene context. | Scene A marked dirty when adjacent scene deleted (for image layer only). | Visual prompt context for Scene A changes but Scene A is not regenerated. | Minor visual quality impact — character disambiguation context changes. Content correct. |
| **G6** | **Low** | book-diff.cjs + entity-crud-routes.cjs | Entity-delete paths skip book-diff entirely. Only unit delete triggers dirty marking via entity-cleanup. | Chapter/scene delete should at minimum mark remaining scenes' reindex status. | No `reindex_needed` signal for remaining scenes after chapter/scene delete. | Display indices may be stale until next regeneration. |
| **G7** | **Low** | reconciliation-engine.js | Reconciliation properly handles dirty_unit_ids and is_dirty flags after restart. | — (handled) | — | — |

### 8.14 Recommended Fix Plan

**✅ Priority 1 (Critical) — FIXED**:
1. **DELETE Chapter cleanup**: ✅ Each scene in the deleted chapter is now purged via `cleanup.purgeScene()`. Per-scene error handling with cleanup result reporting. Reuses existing canonical mechanism.

**Priority 2 (High)**:
2. **DELETE Chapter dirty marking**: After purging chapter scenes, remaining chapters need NO dirty marking (their content is unchanged). However, the book's `chapters_order` changes — consider bumping a book-level version if one exists.

**✅ Priority 3 (Medium) — FIXED**:
3. **`audio.full_text` sync**: ✅ `rebuildFullText(scene)` in `scene-patch-utils.cjs` joins remaining unit texts into `audio.full_text` after unit add/delete/field-edit. Called from entity-crud-routes and core-routes PATCH handler.
4. **Cross-scene dirty propagation**: When a scene is deleted, mark the preceding scene's image layer dirty if it used lookahead context. Low priority — visual quality is minorly affected.

**Priority 4 (Low)**:
5. **Reindex signal**: After scene/chapter delete, set a `reindex_needed` flag so the frontend display indices update on next load.

---

## 9. Cross-Scene Dependency / nextScene Audit

> READ-ONLY audit. Production code was not changed.
> Date: 2026-08-19.

### 9.1 Pipeline — Traced from Source

**Execution path** (verified from code):

```
pipeline-runner.js:580,984
  → nextScene = windowScenes[si + 1] || null
  → pipelineSteps.stepCreateVisuals(..., nextScene, ...)

pipeline-steps.js:1080 (stepCreateVisuals)
  → builds contextParts[] with scene info, characters, full_text
  → if (nextScene && (nextScene.text || nextScene.audio?.full_text)):
       nextText = nextScene.audio?.full_text || nextScene.text || ''
       contextParts.push('## Context from next scene (character name disambiguation)')
       contextParts.push(nextText.substring(0, 1000))
  → contextStr → SYSTEM_PROMPTS.visuals → AI call → visual prompts per unit
```

**What nextScene IS**:
- Advisory text context for the LLM (character name disambiguation)
- Only the TEXT of the next scene is used (`audio.full_text` or `text`)
- NOT characters, location, modules, images, or any generated content
- Optional: when null, the lookahead section is simply omitted from the prompt

**Where nextScene is NOT used**:
- `audio/` directory — no reference to nextScene
- `image/prompt-builder.js` — no reference to nextScene
- `image/iu-processor.js` — no reference to nextScene
- `video/` directory — no reference to nextScene
- `state/` / `playbackStore` — no reference to nextScene
- `orchestration/` — no reference to nextScene

### 9.2 Chapter Boundaries

**How windowScenes is built**:
- `pipeline-runner.js` processes scenes in windows (chunks of text)
- `windowScenes` is the array of scenes within ONE processing window
- `nextScene = windowScenes[si + 1]` — ONLY looks within the same window
- If the current scene is the last in the window, `nextScene = null`

**Cross-chapter lookahead**: DOES NOT EXIST.
- Each window is processed independently
- The last scene of Chapter 1 does NOT use the first scene of Chapter 2 as nextScene
- When a window ends, nextScene is null for the last scene

**Verification**: `pipeline-runner.js:580` and `:984` both use `windowScenes[si + 1]` — a local array index, not a global scene list traversal.

### 9.3 Delete Scene — What Happens to Predecessor

**Scenario**: Chapter has Scenes A → B → C. Delete Scene B.

**During AI generation** (nextScene determined at generation time):
- Scene A was generated with nextScene = B's text (character disambiguation context)
- After B is deleted, Scene A's images still exist with the old prompt
- Scene A is NOT marked dirty by the delete

**During regeneration** (rebuild from current book JSON):
- `windowScenes` is rebuilt from current book JSON (no B)
- `nextScene = windowScenes[si + 1]` → for Scene A, this is now Scene C
- Scene A would get correct nextScene context if regenerated

**Conclusion**: nextScene is a READ-TIME dependency, not a stored dependency. It resolves from the current book JSON at generation/regeneration time. Deleting B does NOT leave A with stale nextScene — the next regeneration will correctly use C.

### 9.4 Edit Scene — Dependency Matrix

| Changed field in Scene B | Affects Scene A's nextScene? | Why |
|---|---|---|
| B.text | YES (if A is regenerated) | nextScene reads `nextScene.text` as fallback |
| B.audio.full_text | YES (if A is regenerated) | nextScene reads `nextScene.audio?.full_text` first |
| B.characters/participants | NO | Not used by nextScene |
| B.location | NO | Not used by nextScene |
| B.units (structure) | NO | Not used by nextScene |
| B.image prompt | NO | Not used by nextScene |
| B.video action | NO | Not used by nextScene |
| B.type | NO | Not used by nextScene |

**Key insight**: Only `audio.full_text` and `text` fields of the next scene are used. All other fields are irrelevant to the cross-scene dependency.

### 9.5 Dirty Propagation — Current Behavior

**prompt-dependency-registry.js** tracks:
- Scene-level fields (audio.full_text, voice, visual.style, location, participants, etc.)
- Cross-cutting entities (characters, locations, voices)
- Unit changes (add/delete/reorder/text)

**NOT tracked**:
- Cross-scene dependencies (nextScene text dependency)
- When Scene B changes, Scene A is NOT marked dirty

**GAP**: Cross-scene dirty propagation does not exist in the current canonical dirty pipeline. When Scene B's text changes, Scene A's visual prompt (which used B's text for character disambiguation) is NOT invalidated.

### 9.6 Generation Race

**Scenario**: Scene A visual generation started → Scene B changed/deleted → Scene A generation finishes.

**Protection**:
- `buildId` is set at generation start; stale results use old buildId
- `content_version` bump on scene change → stale assets detected by `detectVersionStale`
- Redis generation locks prevent duplicate dispatch
- `sceneEpoch` discard mechanism in playbackStore (web)

**For nextScene specifically**: The nextScene text is embedded in the LLM prompt at generation time. A stale result from before B's change would contain B's old text in the context. However:
- The visual prompts themselves are per-unit, not per-nextScene
- The disambiguation context affects prompt quality, not correctness
- No data corruption occurs from stale nextScene context

### 9.7 Sequential Delete

**Scenario**: A → B → C → D. Delete B.

**Result**: A → C → D.
- A's nextScene was B; after deletion, nextScene resolves to C (at next regeneration)
- C's nextScene was D; unchanged (B was before C, not after)
- D's nextScene was null; unchanged

**Delete last scene**: A → B. Delete B.
- A's nextScene was B; after deletion, nextScene = null (B was the last scene)
- A's visual prompt context simply omits the lookahead section

### 9.8 Severity Assessment

| GAP | Severity | Impact | Justification |
|---|---|---|---|
| Cross-scene dirty propagation absent | **Low** | Stale character disambiguation context in visual prompts after neighbor scene edit/delete | The dependency is advisory (LLM context), not structural (actual image data). Characters are already correctly bound in the prompt. The visual quality impact is minimal — context helps the LLM name unnamed characters more accurately, but does not change which characters appear or their visual appearance. |
| No re-regeneration of predecessor after neighbor delete | **Low** | Scene A keeps old prompt with B's text context | Correct behavior per the "minimal regeneration" principle. The generated images for A are still valid. B's text served as disambiguation, not as image content. |

### 9.9 Confirmed Dependencies

- **nextScene.text / nextScene.audio.full_text** → Scene A visual prompt LLM context (advisory)
- **nextScene is READ-TIME only** — resolves from current book JSON at generation time
- **No stored cross-scene dependency** — no version bump, no dirty marking

### 9.10 False Dependencies

- Scene B characters → Scene A visual prompt: NOT a dependency (characters are resolved from global book characters, not from nextScene)
- Scene B location → Scene A visual prompt: NOT a dependency
- Scene B generated image/video → Scene A: NOT a dependency

### 9.11 Recommended Fixes

**None required for this audit scope.** The cross-scene dependency is advisory text context for the LLM, not a structural dependency that affects generated content correctness. The current behavior (no dirty propagation) is acceptable.

If future requirements demand stricter cross-scene invalidation:
1. Add a `nextScene` field to `prompt-dependency-registry` SCENE_FIELDS
2. When a scene changes, mark the preceding scene's image layer dirty
3. Scope: image layer only (audio and video are not affected by nextScene)

---

## Appendix: Areas Audited

- Backend: `entity-crud-routes.cjs`, `core-routes.cjs` (DELETE book — gold standard),
  `book/index.js` (saveBookBundle/loadBook/findSceneRuntimeData),
  `lazy-book/paths.js`, `filesystem-store.js`, `asset-registry.js`,
  `redis-helpers.cjs`, `cleanup-service.cjs`, `placeholder-audio.js`,
  `recover-chunks.cjs`, `scene-restoration.js`, `book-diff.cjs`,
  `book-sync.js`, `postgres/schema.js` (+repos), `runtime-scheduler.js`,
  `active-scenes-index.js`, `dispatch-engine.js`, `scene-orchestrator.js`,
  `reconciliation-engine.js`, `runtime-persistence.js`, `startup-resume.js`,
  `chunks-routes.cjs`, `generation-routes.cjs`, `recovery-routes.cjs`,
  `book-routes.cjs` (wiring).
  - Dirty/invalidation: `prompt-dependency-registry.js`, `entity-cleanup.cjs`,
    `scene-assets-repo.js` (bumpSceneVersions, setDirtyUnitIds),
    `versions-routes.cjs`.
  - Audio: `audio/generation.js`, `audio/segments.js` (buildSegments),
    `agent/pipeline-steps.js` (sceneFullText derivation).
- Web: `EditPage.tsx`, `generateStore.ts`, `playbackStore.ts`, `mediaCache.ts`,
  `entityEditor.tsx`, `idgen.ts`.
  - Tests: `playbackCacheInvalidation.test.ts`, `mediaCache.test.ts`.
- Android: `EditFragment.kt`, `GenerateViewModel.kt`, `PlaybackViewModel.kt`,
  `Repository.kt`, `BackendApi.kt`, `SimpleDiskCache.kt`, `VideoCache.kt`,
  `PositionManager.kt`.