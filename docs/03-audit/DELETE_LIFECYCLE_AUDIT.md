# 03. Аудит жизненного цикла удаления — Chapter / Scene / Module (Unit)

> Полный аудит lifecycle удаления Chapter / Scene / Module по всему стеку:
> JSON/persistence → filesystem (OUTPUT_DIR) → PostgreSQL → Redis →
> генерационные очереди/воркеры → recovery/anti-duplicate → локальный кеш
> (web Cache API + Android SimpleDiskCache/VideoCache) → dirty/regeneration →
> frontend state (позиция, очередь воспроизведения).
>
> Аудит **read-only**: ничего не исправлялось. Основан на чтении исходного кода.
> Дата: 2026-08-19. Контекст: коммит `305e2cd` ввёл ручное добавление/удаление
> глав/сцен/юнитов через `entity-crud-routes.cjs` (web + Android).
>
> Легенда оценок: **Current** — что происходит сегодня, **Expected** — ожидаемое
> поведение (по образцу `DELETE /book/:bookId`, который считается эталоном
> полного cleanup), **Gap** — разница.

---

## Executive Summary

Удаление Chapter/Scene/Unit в редакторе сегодня **трогает только JSON-слой**
(`book.loadBook` → фильтрация массива → `book.saveBookBundle`). Ни один из
остальных слоёв состояния книги — PostgreSQL, Redis, файлы в `OUTPUT_DIR`,
очереди GPU-хаба, in-flight dispatch, локальные кеши клиентов — при
`DELETE /chapters/:id`, `DELETE /scenes/:id`, `DELETE /units/:id` не
инвалидируется.

Полный пример правильного cleanup существует только для удаления **всей книги**
(`DELETE /api/v1/book/:bookId`, `core-routes.cjs:694-819`): resetBook + удаление
snapshot/build-директорий + Redis (`cancelled-workers`, cancel-флаг, active
counters, `cleanBookRedisKeys`) + очистка ~27 PG-таблиц + `GPU /queue/clear`.
Для удаления одной главы/сцены/юнита аналога нет нигде.

Самые серьёзные последствия:

1. **Призрачные сцены в очереди воспроизведения**: Redis-чанки удалённой сцены
   не удаляются, а `GET /book/:bookId/chunks` строит очередь исключительно из
   Redis (`chunks-routes.cjs:25-87`) **без фильтрации по JSON книги** — удалённая
   сцена продолжает воспроизводиться на web и Android и отображается в
   `/assets-state`.
2. **Утечка PG-строк**: единственный purge-механизм
   (`book-sync.reconcileFromDiff` → `purgeRemovedSceneRows`) вызывается только из
   `PUT /book/:bookId`, где для entity-CRUD-удалений он физически не срабатывает
   (удаление уже сохранено на диск до PUT → diff не видит «removed»).
3. **In-flight генерация не отменяется**: уже отправленные в GPU job'ы для
   удаляемой сцены дорабатывают и записывают файлы + PG-строки + Redis-state
   уже для несуществующей сцены.
4. **Orphan-файлы в OUTPUT_DIR** (mp3/чанки/png/video) не чистятся ни при
   удалении, ни фоновым GC; `recover*` их не удаляют (и не «воскрешают», что
   частично защищает), но и не вычищают.

Положительные находки (контроли, которые спасают от худшего):

- Executors **self-heal**: `executeAudioDispatch/Image/VideoDispatch` проверяют
  `book.findSceneRuntimeData` и при `scene_not_found` снимают сцену с active
  index (`scene-orchestrator.js:63-73, 205-214, 277-286`) — scheduler не будет
  бесконечно перегенерировать удалённую сцену.
- Recovery-механизмы (`recoverAllBooksFromDisk`, `recoverMissingRedisChunks`,
  `recoverMissingPlaceholders`) используют JSON книги как источник истины —
  удалённые сущности не «воскрешаются» с диска/из Redis.
- JSON-слой чист: `saveBookBundle` синхронизирует `chapters_order`, удаляет
  orphan-файл удалённой главы из `chapters/` и защищает от пустой книги
  (guards на последнюю главу/сцену).

---

## 1. Current Architecture (как устроено удаление сегодня)

**Входные точки удаления:**

| Кто | Endpoint | Файл |
|---|---|---|
| Web EditPage / Android EditFragment | `DELETE /api/v1/book/:bookId/chapters/:chapterId` | `entity-crud-routes.cjs:331` |
| Web EditPage / Android EditFragment | `DELETE /api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId` | `entity-crud-routes.cjs:407` |
| Web EditPage / Android EditFragment | `DELETE /api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units/:unitId` | `entity-crud-routes.cjs:477` |
| (эталон) | `DELETE /api/v1/book/:bookId` | `core-routes.cjs:694` |

**Что делает entity-delete:**

```
loadBook(bookId)
→ filter(chapters | scenes | units)
→ saveBookBundle(oldBook, null)
→ { saved: true }
```

Плюс guards: нельзя удалить последнюю главу (`entity-crud-routes.cjs:337`) и
последнюю сцену в главе (`:416`). При удалении персонажа дополнительно чистится
`voices[characterId]` (`:137-143`). Больше ничего.

**Что делает эталонное удаление книги** (`core-routes.cjs:694-819`) — полный
чек-лист, на который ориентируемся в таблицах ниже:

- FS: `book.resetBook(bookId)`, snapshot, build-директории и файлы с префиксом
  bookId в `OUTPUT_DIR` (`:699-727`);
- Redis: `animastor:cancelled-workers:{bookId}`, `setCancelFlag` (окно), active
  counters, `cleanBookRedisKeys` (`:737-757`);
- PG: 27 таблиц по `book_id` с per-table try/catch (`:762-801`);
- GPU Hub: `DELETE {HUB}/queue/clear?book_id=` (`:803-811`).

---

## 2. Module/Scene/Chapter Deletion lifecycle (по слоям)

### 2.1 JSON / Persistence — ✅ чисто

- `saveBookBundle` (`book/index.js:256-454`) пишет manifest.json, book.json
  (`chapters_order` синхронизируется из `book.chapters`, `:376-383`), bible /
  locations / voices / characters (удаляются при пустоте), главы в `chapters/`.
- Orphan-файлы удалённой главы удаляются из `chapters/`, но **только когда
  `chapterFilenames.length > 0`** (`:436-453`) — инвариант «последнюю главу не
  удалить» делает это безопасным.
- Модель данных: главы — файлы `chapters/ch-<hex8>.json`, сцены и юниты — inline
  внутри JSON главы (`lazy-book/paths.js`: `chapterId()`→`ch-<hex8>`,
  `sceneId()`→`sc-<hex8>`, `unitId()`→`iu-<hex8>`).

### 2.2 Files / Assets (OUTPUT_DIR) — ❌ не чистится

Именование (`filesystem-store.js:25-47`):
`{bookId}_{chapterId}_{sceneId}.mp3` (scene audio), `_<chunk>.mp3`,
`_<chunk>.png` (chunk image), `_iu<uid>.png` (IU image), `_pr<uid>.png`
(preview), `{bookId}_{ch}_{sc}.mp4` (video).

- При удалении сцены/главы/юнита файлы **не удаляются**.
- Единственная близкая механика — `resetScenes` c `cleanPngUnitIds`
  (`orchestrator.js:571-591`) pre-delete stale PNG **только для dirty-юнитов**
  при `/regenerate` — по entity-delete не вызывается.
- `cleanupService.cleanupBuild` удаляет только **целую build-директорию**
  (`cleanup-service.cjs:56-81`), используется при удалении книги.
- Фоновый GC orphan-файлов на уровне сцены/главы отсутствует (см. §9).

### 2.3 PostgreSQL — ❌ не чистится (Critical C1)

Таблицы: `scenes`, `scene_assets`, `generation_tasks`, `image_units`,
`asset_states`, `cache_entries`, `output_manifests`, `book_events`,
`reconciliation_events`, `book_source`, `book_generation_sessions`,
`ai_chat_sessions`, `chat_messages`, `sentence_resolutions`,
`character_mentions` и др.

- FK/cascade: только `books → book_snapshots | scenes | storyboard_elements |
  audio_layers ON DELETE CASCADE` (`schema.js:39,51,200,215`). У `scenes` есть FK
  на `books`, но **нет** каскада от `scenes` к `scene_assets`/`image_units`/
  `generation_tasks`/`asset_states` — они ссылаются на book_id текстом без FK.
- Entity-delete PG не трогает вообще.
- `purgeRemovedSceneRows` (`book-sync.js:293-313`) удаляет для removed-сцены:
  `scene_assets`, `generation_tasks`, `image_units`, `storyboard_elements`,
  `audio_layers`, `scenes`. **НЕ** удаляет: `asset_states`, `cache_entries`,
  `output_manifests`, `book_events`, `reconciliation_events`, `book_source`,
  `book_generation_sessions`, `chat_*`, `sentence_resolutions`,
  `character_mentions`, `ai_chat_sessions`.
- И главное: `reconcileFromDiff` вызывается **только из `PUT /book/:bookId`**
  (`core-routes.cjs:235,398,533,595,653`). Для entity-CRUD-удаления diff-путь
  не срабатывает: `oldBook` загружается с диска **уже после** entity-delete,
  поэтому «removed» не детектируется. См. C1.

### 2.4 Redis — ❌ не чистится (Critical C2)

Ключи удалённой сцены/главы остаются навсегда:

- Чанки: `animastor:chunk:{bookId}_{ch}_{sc}_*` + set `animastor:chunks:{bookId}`
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

Сценарный cleanup существует только на уровне книги —
`cleanBookRedisKeys` (`redis-helpers.cjs:314-422`) — и только для `DELETE /book`.
Scene/chapter-level чистки Redis нет нигде. Следствие — см. C2: очередь
воспроизведения строится из Redis и включает удалённые сцены.

### 2.5 Generation queue / workers — ❌ не отменяется (Critical C3)

- Entity-delete не вызывает `clearLeasesForScenes`, `clearHubDispatches`,
  `setCancelFlag`, `cancelled-workers`. Очередь GPU-хаба для удаляемой сцены
  остаётся, воркеры дорабатывают и пишут результат (см. §7 Race Conditions).
- `runtime-persistence.js` snapshot/restore может «восстановить» active
  leases/dispatch-metadata удалённой сцены после рестарта, если снапшот был
  снят до удаления (`runtime-persistence.js:583-708`) — но executor self-heal
  (см. §10) ограничит последствия.

### 2.6 Recovery / anti-duplicate — ✅ не воскрешает, но и не чистит

- `recoverAllBooksFromDisk`/`recoverChunksFromDisk`
  (`redis-helpers.cjs:158-290`): берёт список сцен из book JSON и восстанавливает
  только их → удалённые не «воскресают» (хорошо), но stale-чанки удалённых не
  вычищаются (плохо — усиливает C2).
- `recoverMissingRedisChunks` (`recover-chunks.cjs:11-59`): только создаёт
  недостающие чанки для сцен из JSON, ничего не удаляет.
- `recoverMissingPlaceholders` (`placeholder-audio.js:474-560`): только для сцен
  из `draft.chapters`, файл удалённой сцены не перезаписывает/не удаляет.
- `book-diff.markDirtyScenes` (RESET_SCENE_LUA, `book-diff.cjs:217-316`) для
  «removed»-сцены **пересоздаёт** чанк, ставит PENDING и **добавляет сцену в
  active index** (`:312-313`) — но этот путь недостижим из entity-delete (см. C1);
  при ручном вызове он бы «оживил» сцену в Redis.

### 2.7 Local cache (web + Android) — ✅ инвалидируется ( Medium M2, исправлено)

**Исправлено** в рамках Local Cache Invalidation (§7).

- **Web**: `confirmDeleteStructure` теперь вызывает `invalidateDeletedScene/Chapter`
  (`playbackStore.ts`) → `evictSceneMedia/evictChapterMedia` (`mediaCache.ts`)
  + `clearPreloadCache()` + удаление из `sceneQueue` **перед** re-fetch.
  Cache API ключ `/${buildId}/${chapterId}:${sceneId}/${kind}` всегда валидный.
- **Android**: `Repository.deleteChapter/Scene/Unit` теперь вызывает `clearCache()`
  (LruCache evictAll + SimpleDiskCache evictAll) после API delete.
  `EditFragment` вызывает `playbackViewModel.removeDeletedScenesFromQueue()`
  для очистки player queue.
- Подробности см. §7.

### 2.8 Dirty / Regeneration — ❌ не триггерится (Medium M3)

- Entity-delete не bump'ит `content_version`, не ставит `dirty_unit_ids`, не
  вызывает `book-sync` и не маркирует сцены dirty (в отличие от
  `PUT /book/:bookId` → `bumpSceneVersions`, `core-routes.cjs:239`).
- Корректность контента сохраняется только потому, что пользовательские
  генерации идут `rebuild_all` (`generateStore.startGeneration`,
  `generateStore.ts:734-744`), который перебирает **все сцены из JSON** —
  удалённые в него не попадают. Но промежуточные статусы (assets-state,
  очередь) остаются «призрачными» до полной регенерации.

### 2.9 Frontend state — ✅ исправлено

**Исправлено** в рамках Local Cache Invalidation (§7).

- **Web**: после удаления: `invalidateDeletedScene/Chapter` → очистка кеша +
  player queue → re-fetch → `navigateTo` с clamp. Удалённая сцена удаляется
  из `sceneQueue` и `preloadCache`; текущая сцена помечается `needsContentRefresh`.
- **Android**: `removeDeletedScenesFromQueue` → очистка queue + preload cache →
  `reloadStructureAndReposition` → свежий JSON → `SharedPositionManager.navigateTo`.
  `Repository.deleteChapter/Scene/Unit` вызывает `clearCache()`.
- Подробности см. §7.

---

## 3. Invalidation Matrix

`❌` — ничего не делается, `⚠️` — частично/косвенно, `✅` — делается.

| Операция | JSON (книга) | Файлы главы (`chapters/`) | OUTPUT_DIR (audio/chunk/IU/pr/video) | PG (scenes, scene_assets, tasks, image_units, asset_states, ...) | Redis (chunks, asset-state, active-index, registry, dispatch) | GPU queue / in-flight | Web media cache | Android SimpleDiskCache/VideoCache | Dirty / version |
|---|---|---|---|---|---|---|---|---|---|---|
| **Delete Unit** | ✅ (units inline) | ✅ (n/a) | ❌ `_iu<uid>.png`/`_pr<uid>.png` | ❌ (image_units, scene_assets) | ❌ (chunks/registry остаются) | ❌ | ✅ (evictSceneMedia + queue) | ✅ (clearCache) | ❌ |
| **Delete Scene** | ✅ | ✅ (глава перепишется) | ❌ `.mp3`, чанки, `_iu*`, `_pr*`, `.mp4` | ❌ (все строки сцены) | ❌ (chunks, asset-state, active, registry, audio-orch, iu-progress) | ❌ | ✅ (evictSceneMedia + queue) | ✅ (clearCache + queue) | ❌ |
| **Delete Chapter** | ✅ | ✅ (orphan-файл удаляется) | ❌ (все файлы сцен главы) | ❌ (все строки сцен главы) | ❌ | ❌ | ✅ (evictChapterMedia + queue) | ✅ (clearCache + queue) | ❌ |
| **Delete Book** (эталон) | ✅ (`resetBook`) | ✅ | ✅ (build-дир + префикс) | ✅ (27 таблиц) | ✅ (`cleanBookRedisKeys` + cancel) | ✅ (`/queue/clear`) | ✅ (`clearMediaCache` на клиенте) | ✅ (client-side `clearCache`) | ✅ |

**Итог:** для Chapter/Scene/Unit очищены **JSON-слой, файл главы, локальный кеш
web (Cache API + player queue) и Android (LruCache + SimpleDiskCache + player queue)**.
Остальные серверные слои (OUTPUT_DIR, PG, Redis, GPU queue) — нет (см. §4).

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

| # | Сценарий | Поведение сегодня | Риск |
|---|---|---|---|
| R1 | Delete сцены во время in-flight генерации | Воркер дорабатывает, пишет файлы + PG + Redis для удалённой сцены | Orphan-файлы/строки/состояние, «призрак» в статусах (C2+C3) |
| R2 | Delete ‖ `PUT /book` (редакторный save) на web/двух устройствах | PUT с устаревшим `bookData` может перезаписать JSON и «вернуть» только что удалённую сцену (TOCTOU; delete не блокируется на клиенте) | Повторное появление удалённой сцены в JSON |
| R3 | Delete ‖ scheduler tick | Tick видит сцену в active index → dispatch → executor `scene_not_found` → снимает с active index | Лишний цикл, но self-heal срабатывает (безопасно) |
| R4 | Delete ‖ рестарт backend | Снапшот runtime до удаления «восстанавливает» lease/метаданные удалённой сцены; recovery по book JSON их не отсекает | Временный призрак до self-heal (M1) |
| R5 | Delete ‖ `recoverMissingPlaceholders` | Recovery идёт по book JSON — удалённую сцену не трогает | Безопасно |

---

## 6. Recommendations (приоритизировано)

1. **Scene/Chapter/Unit-level cleanup-функция** (эталон — `DELETE /book`):
   - PG: purge по `book_id+chapter_id(+scene_id)` для всех таблиц книги;
   - Redis: удаление chunks + set, asset-state, active-index, asset-registry,
     audio-orch, iu-progress/in-flight, dispatch lease/meta/retry удаляемых сцен;
   - FS: удаление файлов по префиксу;
   - GPU: отмена in-flight (leases + hub queue) для удаляемых сцен;
   - вызвать из DELETE-хендлеров `entity-crud-routes.cjs` **после**
     `saveBookBundle`.
2. **Фильтрация `GET /chunks` и `/assets-state` по book JSON** — убрать
   «призрачные» сцены из очереди воспроизведения (C2) без ожидания очистки Redis.
3. **Вызов book-diff/reconcile** после delete (M3) — bump версий соседних сцен,
   чтобы UI и регенерация были согласованы.
4. **✅ Локальная инвалидация (M2/M5)** — реализована (§7): web — `evictSceneMedia`/`evictChapterMedia` + player queue; Android — `clearCache()` + `removeDeletedScenesFromQueue`.
5. **Починить `asset-registry.js`** (scanKeys) или удалить мёртвые функции (M4).
6. **Фоновый GC** orphan-файлов/чанков по book JSON в reconcileCycle (H1/H2/L2).

---

## 7. Local Cache Invalidation (реализовано)

> Раздел добавлен после реализации cache invalidation в обоих фронтендах.
> Покрывает M2/M5 из §4 Findings.

### 7.1 Цель

После успешного DELETE Chapter/Scene/Unit на сервере:
- Локальный кеш (Cache API / SimpleDiskCache) не содержит данных удалённой сущности.
- Player queue не ссылается на удалённые сцены.
- Navigator / Editor отражают актуальное состояние сервера.
- Удалённая сущность не может «воскреснуть» из cache.

### 7.2 Кеш-механизмы (аудит)

| Механизм | Ключ | Хранит | Тип кеша |
|---|---|---|---|
| **Web Cache API** (`animastor-media`) | `/${buildId}/${chapterId}:${sceneId}/${kind}` | audio/video/image/preview/iu blob'ы | book-level + scene-level |
| **Web Preload Cache** (Map) | `${buildId}_${chapterId}:${sceneId}` | PreloadedScene (audio + IU blobs) | book-level + scene-level |
| **Web In-flight Assets** (Map) | `${buildId}_${chapterId}:${sceneId}` | Fetch promises (dedup) | book-level + scene-level |
| **Web localStorage** | `animastor:currentBook` | `{id, build}` — book session | book-level |
| **Android LruCache** (50MB) | `audio_${id}_${buildId}`, `iu_${bookId}_${ch}_${sc}_${iuId}_${buildId}` | audio/video/image blob'ы | entity-level + build-level |
| **Android storyboardCache** (500) | `${sceneKey}_${buildId}` | StoryboardResponse JSON | scene-level |
| **Android chunkCache** (500) | `${id}_${buildId}` | ChunkResponse JSON | entity-level |
| **Android SimpleDiskCache** | `audio/video/image/preview/iu/${sanitized(key)}` | файлы на диске | entity-level |
| **Android SharedPreferences** | `bookId`, `buildId` | текущая книга | book-level |

### 7.3 Invalidation Matrix (локальный кеш)

| Операция | Web Cache API | Web Preload Cache | Web Player Queue | Android LruCache | Android SimpleDiskCache | Android Player Queue | Navigator | Editor |
|---|---|---|---|---|---|---|---|---|
| **Delete Module** | `evictSceneMedia(ch, sc)` | `clearPreloadCache()` | — (unit within scene) | `clearCache()` | `clearCache()` (evictAll) | — (unit within scene) | refresh (server fetch) | refresh |
| **Delete Scene** | `evictSceneMedia(ch, sc)` | `clearPreloadCache()` | remove scene from queue | `clearCache()` | `clearCache()` (evictAll) | `removeDeletedScenesFromQueue()` | refresh | refresh |
| **Delete Chapter** | `evictChapterMedia(ch)` | `clearPreloadCache()` | remove all ch scenes | `clearCache()` | `clearCache()` (evictAll) | `removeDeletedScenesFromQueue()` | refresh | refresh |

### 7.4 Реализация — Web

**mediaCache.ts** — новые функции:
- `evictSceneMedia(buildId, chapterId, sceneId)` — удаляет записи Cache API для сцены.
- `evictChapterMedia(buildId, chapterId)` — удаляет записи для всех сцен главы.
- Cache key format: `/${buildId}/${chapterId}:${sceneId}/${kind}` — всегда валидный URL.

**playbackStore.ts** — новые функции:
- `invalidateDeletedScene(chapterId, sceneId, buildId)` — удаляет из preloadCache, sceneQueue, вызывает `evictSceneMedia`.
- `invalidateDeletedChapter(chapterId, sceneIds, buildId)` — аналог для главы.
- `invalidateDeletedBook()` — полная очистка (book delete).
- При удалении текущей сцены: `stopAll()` или `needsContentRefresh = true`.

**EditPage.tsx** — `confirmDeleteStructure`:
1. `await deleteJson(path)` — сервер удаляет.
2. `invalidateDeletedScene/Chapter(...)` — точечная invalidation кеша + queue.
3. `getJson<BookData>(...)` — свежие данные с сервера.
4. `navigateTo(...)` — перепривязка позиции.

### 7.5 Реализация — Android

**Repository.kt** — `deleteChapter/Scene/Unit`:
- После `api.deleteChapter/Scene/Unit(...)` вызывается `clearCache()` (LruCache + SimpleDiskCache).
- Гарантирует, что stale blob'ы удалённой сущности не могут быть загружены из кеша.

**PlaybackViewModel.kt** — `removeDeletedScenesFromQueue(deletedSceneKeys)`:
- Удаляет сцены из `preloadCache` и `sceneQueue`.
- Clamp `currentIndex`.
- Если очередь пуста → `clearCache()` + IDLE.
- Если текущая фаза PLAYING/PAUSED → `needsContentRefresh = true`.

**EditFragment.kt** — `showDeleteStructureConfirm`:
1. Собирает `deletedSceneKeys` до вызова API (из текущего `chapters`).
2. `viewModel.repository.deleteChapter/Scene/Unit(...)` — сервер + cache clear.
3. `playbackViewModel.removeDeletedScenesFromQueue(deletedSceneKeys)` — queue cleanup.
4. `reloadStructureAndReposition()` — свежие данные + позиция.

### 7.6 Failure Behavior

| Сценарий | Поведение |
|---|---|
| DELETE сервер успешен + cache invalidation успешна | Полная синхронизация: кеш пуст, queue актуален, позиция якорена |
| DELETE сервер успешен + cache invalidation не удалась | Кеш может содержать stale данные, но серверный JSON является source of truth; следующий `getJson<BookData>` перезапишет локальное состояние |
| DELETE сервер не удалась | Локальный кеш не тронут; показывается ошибка в UI |
| App restart после DELETE | На boot: `restoreBookSession` загружает книгу из localStorage → `ensureInitialized` fetch свежего JSON → stale кеш не используется |

### 7.7 Ключевые инварианты

1. **Server = source of truth**: после DELETE серверный JSON является авторитетным; локальный кеш — производная копия.
2. **Точечная invalidation**: `evictSceneMedia` удаляет только записи конкретной сцены; не полная очистка (экономия траффика).
3. **Android: полная очистка**: `clearCache()` после delete — упрощённый подход, т.к. `SimpleDiskCache.remove()` не поддерживает prefix-based удаление.
4. **Player queue**: всегда отражает актуальный JSON; удалённая сцена удаляется из queue до следующего `playNext`.
5. **Cache key format**: всегда валидный URL (`/buildId/chapterId:sceneId/kind`); никогда `//ch-...` или невалидный ключ.

---

## 8. Dirty / Invalidation / Regeneration Audit

> READ-ONLY аудит: production-код не менялся.
> Дата: 2026-08-19. Продолжение DELETE Lifecycle Audit (§1-7).

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

## Приложение: проверенные области

- Backend: `entity-crud-routes.cjs`, `core-routes.cjs` (DELETE book — эталон),
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