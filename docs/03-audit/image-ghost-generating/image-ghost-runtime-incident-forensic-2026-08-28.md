# Forensic: Runtime Incident "Ghost Image Task 0/9" — 2026-08-28

Follow-up forensic investigation of a real runtime incident discovered after
deploying fix `226178f0` / `70e55fd3` (audit `6929ba5`).

## Symptoms

- Frontend: "Image workers: 0".
- Stuck task progress: "0/9".
- Task displayed after rebuild and backend restart.
- "Stop All" does not remove or complete the task.

## Task Identification

- book: `import_1786345731767_1786345734345`
- chapter: `ch-1bb5123c`
- scene: `sc-45c789c6`
- stage: **image**
- image units: 9 (`iu-0c92b6b9` … `iu-ec4410b8`, PG `image_units`)

## 1. Actual State (UI → DB → Redis → scheduler → dispatch → worker)

| Level | State |
|---|---|
| UI | "0/9", "Воркеры изображений: 0" — polls `/progress-panel` + `/worker/counts` |
| PG `generation_tasks` | **нет image-задачи** для sc-45c789c6 (только audio completed 25.08) |
| PG `image_units` | 9 units — знаменатель "9" |
| PG `scene_assets` | только audio ready; image-строк нет |
| PG `generation_cancellations` | tombstone от 2026-08-28 06:04:01 (Stop All) |
| Redis `asset-state` | **`image: generating`** ← ghost; `audio: ready` |
| Redis `active-scenes` | сцена присутствует |
| Redis queue / lease / dispatch-meta / iu-in-flight | **пусто** (0 lease, 0 meta, 0 маркеров, 0 записей книги в очередях) |
| Scheduler | каждый тик `Active: 1, Skipped: 1` — dispatch невозможен |
| Workers | 0 живых heartbeats (нет ни одного worker'а любого типа) |

## 2. Why UI Shows "0/9"

`progress-panel` (`backend/src/routes/book/progress-panel.cjs:387-389`): progress-задач
в Redis нет (Stop All их стёр через `generationProgress.clear`) → fallback `legacyTasks()`
(строки 339-382) **синтезирует** задачу из `active-scenes` + asset-state `GENERATING` →
`countImage` (строка 153) считает 9 units из PG `image_units`, 0 ready → "0/9".

Frontend ни при чём — он рендерит ответ backend.

## 3. Why the Task Survived Backend Restart

The ghost-creating event was recorded in the event journal сцены (3668 записей):

```
26.08 03:03:05.167  SCENE_GENERATING        (image, dispatch-1787713385164)
26.08 03:03:05.173  INVALID_STATE_CALLBACK  (image: generating→pending, ignored:true)
26.08 03:03:05.174  DISPATCH_CANCELLED      (reason=no_jobs_sent)
```

Старый код откатывал `no_jobs_sent` через `setScenePending`; FSM запретил
`GENERATING→PENDING` (`backend/src/state/scene-state.js:54`,
`GENERATING → [ready, failed, dirty]`); отказ был проглочен.

`asset-state` и `active-scenes` живут в persistent Redis (`redis-data` volume) →
состояние пережило все restart'ы. Каждый restart `rebuildWorkList` re-add'ил сцену
в active index (`needsWork=true`: image-файла на диске нет → PENDING-таргет).

## 4. What Happens on "Stop All"

The click was recorded in logs: `2026-08-28 06:04:01 POST /cancel-generation → 200`.

Выполнено (`backend/src/routes/book/generation-routes.cjs:226-302`):

- cancel flag `animastor:generation:cancel:<bookId>` (без TTL);
- PG tombstone `generation_cancellations`;
- `clearBookFromActiveIndex`;
- `clearAllLeasesForBook`;
- PG `generation_tasks` cancelled (video-строка sc-5f0068ca);
- GPU hub queue cleared via HTTP.

**Не выполнено: откат per-asset states.**

`clearAllLeasesForBook` (`backend/src/runtime/dispatch-engine.js:1295`) откатывает
GENERATING только через `cancelActiveDispatch` → `rollbackStageToPending` для
**найденных lease**. Lease ghost'а давно истёк → откатывать нечего →
`image: generating` остался.

## 5. Where Cancellation Breaks — Three Independent Defects

### 5.1 Stop All Does Not Clean orphan-GENERATING

Нет sweep'а asset-state'ов книги после очистки lease'ов: GENERATING без
lease/meta/in-flight маркера переживает cancel-generation.

### 5.2 Reconciliation Resurrects the Cancelled Scene

Fix-action `REGENERATE_MISSING_ASSET`
(`backend/src/runtime/reconciliation-engine.js:1044-1052`) делает
`addSceneToActiveIndex`, **не проверяя** ни cancel flag, ни PG tombstone —
в отличие от `rebuildWorkList`, который tombstone уважает (строка 1936).

Лог: сразу после cancel 06:04:01 → следующий 60s-цикл →
`[SCHEDULER] + ACTIVE: …sc-45c789c6 added to active index`.

Триггер воскрешения — ложный `orphan_audio_state`:
`checkOrphanAudioState` (строка 146) использует **hardcoded `buildId='default'`**
и ищет файл в `/data/output/default/…`, хотя файл существует в
`/data/output/build_import_1786345731767_1786345734345/…` → false positive
каждые 60 сек (3648 записей `INVALID_STATE_CALLBACK` audio ready→pending в journal).

### 5.3 Self-Heal Cannot Fix orphan-GENERATING

- rebuild-guard "GENERATING/PENDING не трогаем" (строка 2041) — корректен для
  живого dispatch, но блокирует ремонт orphan-состояния;
- `setScenePending` отклоняется FSM для GENERATING;
- action `MOVE_TO_PENDING` для `stuck_state` (строка 901-907) **не реализован**
  в `executeFix` — уходит в `default → unknown_action`.

## 6. Why Worker Count = 0

`/worker/counts` (`backend/src/routes/generation-routes.cjs:565`) считает по живым
heartbeats (`worker-health.getAvailability`, `scanFreshHeartbeats`). В Redis **нет
ни одного heartbeat-ключа**: после restart gpu-hub ни один GPU worker не
переподключился (0 audio / 0 image / 0 video; vbook=1 — AI API жив).
PG `workers` (5 строк) — регистрации, не liveness.

**Вариант A: и реальный ghost, и реальное отсутствие worker'ов — обе проблемы настоящие.**

## 7. Connection to Lifecycle 6929ba5 → 226178f0 → 70e55fd

Это **тот же bug** из audit `6929ba5` (no_jobs_sent → setScenePending rejected →
проглочен → вечный GENERATING). Ghost создан **26.08 — за 2 дня до деплоя фикса**
(`226178f0` / `70e55fd3`, 28.08).

Fix закрывает создание новых ghost'ов в dispatch cancel path
(`rollbackStageToPending`, GENERATING→DIRTY→PENDING), но данный инцидент показал:

1. pre-fix ghost не чинится ни одним self-heal'ом;
2. **новый cancellation gap**: Stop All не убирает GENERATING без lease;
3. **новый reconciliation gap**: fix-actions воскрешают отменённые сцены вопреки tombstone.

Regression tests проходили, потому что покрывают создание ghost'а, а не
выживание/воскрешение pre-fix ghost'а.

## 8. Root Cause

Pre-fix `no_jobs_sent` ghost (26.08) + отсутствие repair-пути:

- Stop All откатывает только lease-backed GENERATING;
- reconciliation fix-actions воскрешают сцену в active index, игнорируя tombstone;
- FSM-валидного self-heal для orphan-GENERATING нет;
- ложный `orphan_audio_state` (hardcoded `buildId='default'`) служит триггером воскрешения.

## 9. Minimal Fix Plan

1. **Одноразовая очистка ghost'а** (ops): `rollbackStageToPending(image)` для
   sc-45c789c6 (GENERATING→DIRTY→PENDING) + SREM из active-scenes; tombstone
   блокирует регенерацию до явного запуска пользователем.
2. **cancel-generation**: после `clearAllLeasesForBook` — sweep asset-state книги:
   каждый GENERATING без lease/dispatch-meta → `rollbackStageToPending`.
3. **Reconciliation**:
   - fix-actions проверяют tombstone/cancel flag перед `addSceneToActiveIndex`;
   - detector "GENERATING без lease/meta" (orphan generating) → repair через
     `rollbackStageToPending`;
   - реализовать `MOVE_TO_PENDING` через `rollbackStageToPending`.
4. **checkOrphanAudioState / checkOrphanImageState**: брать реальный `build_id`
   из manifest вместо `'default'`.

## 10. Required Regression Tests

- Stop All при GENERATING без lease → state откачен, сцена не воскресает,
  progress-panel пуст после N reconcile-циклов;
- reconcile fix-action не делает `addSceneToActiveIndex` для книги с tombstone;
- orphan-GENERATING (нет lease/meta/in-flight) детектируется и чинится через
  `rollbackStageToPending`, а не `setScenePending`;
- orphan-audio/image-check без false-positive при реальном build_id;
- end-to-end: ghost → restart → Stop All → reconcile ×3 → задача не возвращается.

## Appendix: Key Evidence

- Event journal сцены: `animastor:event-journal:import_1786345731767_1786345734345:ch-1bb5123c:sc-45c789c6`
  (3668 записей; ghost-создание ts=1787713385167-174; 3648 audio / 3 image INVALID_STATE_CALLBACK).
- Asset state: `animastor:asset-state:…:sc-45c789c6` = `{audio: ready, image: generating}`.
- Stop All в логах: `2026-08-28T06:04:01.331Z [CANCEL-GENERATION] … → 200 (72ms)`.
- Воскрешение: `[SCHEDULER] + ACTIVE: …sc-45c789c6 added to active index` в следующем
  reconcile-цикле после cancel.
- Scheduler ticks: `Active: 1, Dispatched: 0, Skipped: 1` непрерывно.
- `/worker/counts`: `{"audio":0,"image":0,"video":0,"vbook":1,"active_scenes":1}`.
