# Forensic: Image Worker «0/9» — orphaned `image=generating` state (no_jobs_sent)

Дата расследования: 2026-08-28
Книга: `import_1786345731767_1786345734345`
Сцена: `ch-1bb5123c / sc-45c789c6`, stage=`image`

## Symptom in Production UI

- "Image workers: 0"
- task shows "0/9"
- progress "0%"
- time "00:00:00"
- generation block looks like an active/incomplete task

## Verdict

**Orphaned/ghost image-состояние. Реальной выполняемой задачи НЕТ — но это не глюк UI.**
UI честно отражает зомби-состояние asset state в backend: строка задачи синтезируется
legacyTasks()-fallback'ом progress-panel из active-scenes index + asset state `image=generating`.

## Source of Each UI Value

| UI | Source | Reality |
|---|---|---|
| «Воркеры изображений: 0» | `/worker/counts` → `image:0 + private_image:0` (`frontends/app/src/pages/GeneratePage.tsx:177,350`) | Реально 0 зарегистрированных image-воркеров (нет heartbeat), не stale |
| «0/9» | progress-panel: `total=9` = 9 строк `image_units` в PG для `sc-45c789c6` (созданы 2026-08-13 14:35:40 UTC); `ready=0` — нет counter'а `animastor:iu-progress:*` и нет `dirty_unit_ids` (`backend/src/routes/book/iu-progress-utils.cjs:26-39`) | Реально 9 IU, 0 готово |
| «0%» | `round(0*100/9)` (`backend/src/routes/book/progress-panel.cjs:298-300`) | Следствие 0/9 |
| «00:00:00» | `started_at: null` у синтезированной задачи + нет клиентской сессии → `timerStartedAt<=0` → elapsed зафиксирован на 0 (`frontends/app/src/state/generateStore.ts:457-459`) | Задача никогда не стартовала в этой сессии |

Почему задача отображается: `generationProgress.listTasks()` вернул 0 реальных задач →
progress-panel использует `legacyTasks()` (`progress-panel.cjs:339-382`): любой active scene
с asset state PENDING/GENERATING синтезирует строку с `task_id: null`, `started_at: null`,
`visible: true`, `done: false`.

## Facts from Runtime (Redis / PG / journal)

- PG `generation_tasks`: строки для image этой сцены НЕТ (только audio 2026-08-25, completed).
- Lease: нет. Dispatch metadata: нет. Worker: нет. Retry: нет. Stale lease: нет
  (lease-ключей `animastor:dispatch-lease:*` не существует вообще).
- Redis `animastor:queue:image`: 8 сиротских job от ДРУГИХ книг; для этой книги job нет.
- `animastor:iu-in-flight:*`: пусто (TTL 1200 с давно истёк).
- Asset state hash сцены: `audio=ready, image=generating` (video отсутствует → NEW).
- Сцена присутствует в `animastor:active-scenes`; scheduler каждый тик:
  `Active: 1, Dispatched: 0, Skipped: 1` (no_dispatchable_stages).
- Второй такой же призрак: `ch-1bb5123c/sc-5f18dd0f` — `image=generating`, тот же
  `no_jobs_sent` от 2026-08-19 03:55:27 UTC (dispatch `dispatch-1787060532026-orv4uo2o`);
  не виден в UI, т.к. не в active-index.
- Дополнительно: в очередях 214 сиротских audio-job и 8 image-job от старых книг — отдельный мусор.

## Breakage Timeline (scene event-journal, 2026-08-26 UTC)

1. `03:02:55.054` — DISPATCH_STARTED image, `dispatch-1787713375053-7e0e0124a551002a31a8f3158febcee3`.
   `03:02:55.056` — `INVALID_STATE_CALLBACK: image new→generating rejected` — гонка:
   конкурентный reset сцены (неатомарный `RESET_SCENE_LUA`, см. ниже) в окне DEL→HSET
   дал читателю все состояния как NEW. Dispatch #1 сорван.
2. `03:03:00.148` — DISPATCH_CANCELLED #1, reason `force_reset`
   (per-book флаг `animastor:force-dispatch:{bookId}`, TTL 120 с, выставлен regen'ом другой сцены книги).
3. `03:03:00.149` — DISPATCH_STARTED #2 `dispatch-1787713380147-4fb466dbc506ed58d593f0d4cabbe278`
   → `03:03:00.155` SCENE_PENDING (image) → `03:03:00.156` DISPATCH_CANCELLED: **`no_jobs_sent`**.
4. `03:03:05.166` — DISPATCH_STARTED #3 `dispatch-1787713385164-b314294528bb7d5ff5ba8879f62ad3a9`
   → `03:03:05.167` IMAGE_DISPATCHED + **SCENE_GENERATING (image→generating)**
   → `03:03:05.173` `INVALID_STATE_CALLBACK: generating→pending rejected`
   → `03:03:05.174` DISPATCH_CANCELLED: **`no_jobs_sent`**.
5. После этого — ни одной попытки dispatch. Состояние `generating` заморожено навсегда.

## Where the Chain Broke

`UI task created → backend queue → dispatch → [BREAK] → generation → result → completion`

The break is between **dispatch** and **generation**: the last dispatch transitioned state to GENERATING,
but sent zero GPU jobs, and on cancellation could not roll the state back.

## Root Cause (Mechanism)

1. **`no_jobs_sent`:** в dispatch #3 все 9 IU были пропущены по fast-path за 7 мс
   (сетевой сбой исключён — `gpu.send` имеет 30 с timeout × 3 retry): сработали маркеры
   `animastor:iu-in-flight:*`, оставшиеся от сорванного dispatch #1. Маркеры ставятся ДО
   `gpu.send` (`backend/src/image/iu-processor.js:190`) и НЕ очищаются ни в
   `cancelActiveDispatch`, ни в `finalizeDispatch` (`backend/src/runtime/dispatch-engine.js`).
2. **Невозврат состояния:** `no_jobs_sent` → `finalizeDispatch(cancelled)` корректно убрал
   lease/quota, но rollback состояния сломан: `backend/src/orchestration/scene-orchestrator.js:528`
   вызывает `setScenePending`, а переход **generating→pending запрещён FSM**
   (`backend/src/state/scene-state.js:50-58`) → rejection проглатывается → state остаётся GENERATING.
3. **Вечный пропуск:** scheduler считает GENERATING = «кто-то работает» →
   `no_dispatchable_stages` → skip каждый тик (`backend/src/runtime/runtime-scheduler.js:328-333,552-556`).
4. **Нет recovery-механизма:** `checkStaleDispatchLeases`/`shouldSkipDispatch` работают только
   при существующем lease — здесь lease нет. Stall-failsafe существует ТОЛЬКО для audio и video
   (`checkStalledAudioScenes`/`checkStalledVideoScenes`, `backend/src/runtime/reconciliation-engine.js:287/388`).
   Для image аналога нет. Reconciliation лишь повторно добавляет сцену в active-index (каждые 60 с),
   но задиспатчить не может.

### Contributing Defects

- **Неатомарный `RESET_SCENE_LUA`** (`backend/src/services/book-diff.cjs:307-310`):
  `DEL` asset-state hash + пошаговый `HSET` — конкурентный читатель в этом окне видит
  все состояния как NEW (зафиксировано в журнале dispatch #1).
- **Per-book force-флаг:** regen одной сцены ставит `animastor:force-dispatch:{bookId}`
  (TTL 120 с), который scheduler применяет ко ВСЕМ сценам книги — force-reset чужих
  активных dispatch становится возможным.

## Connection to Recent Lease Fix (37e21c22 / 487bc4a0)

**Not connected — proven:**

- Зависание произошло 2026-08-26 03:03 UTC; фикс задеплоен 2026-08-28 04:19+ UTC.
- Фикс меняет только liveness-детекцию ПРИ СУЩЕСТВУЮЩЕМ lease (TTL вместо `started_at`).
  Здесь lease нет вообще — ни `checkStaleDispatchLeases`, ни `shouldSkipDispatch`
  никогда не срабатывают для этого состояния.
- Косвенно фикс подтверждает пробел: в нём задокументировано, что «hung jobs ловит
  stall-failsafe», — а для image stage этот failsafe отсутствует. Это и есть дыра.

## What Needs to Be Fixed

1. **`no_jobs_sent` rollback:** при отмене dispatch после установки GENERATING откатывать
   состояние FSM-валидным путём `generating→dirty→pending` (сейчас прямой `setScenePending`
   молча отклоняется FSM).
2. **Image stall-failsafe** в reconciliation: `image=generating` без lease/metadata/queue-job
   старше порога → reset в dirty + re-dispatch (аналог checkStalledAudio/VideoScenes).
3. **Очистка `animastor:iu-in-flight:*`** при `finalizeDispatch(cancelled)` / force-reset —
   иначе re-dispatch после любого срыва гарантированно попадает в `no_jobs_sent`.
4. **Атомарность `RESET_SCENE_LUA`:** убрать окно DEL→HSET (например, HSET всех полей +
   HDEL лишних, либо запись во временный ключ + RENAME).
5. **Штатное устранение текущего призрака:** повторный «Generate Images» по этой сцене через UI —
   `resetScenes` → Lua `transitionToPending` явно обрабатывает `generating→pending`
   (`book-diff.cjs:291-301`) и переотправит. Безопасно.
6. (гигиена) Очистка сиротских очередей: 214 audio-job + 8 image-job от старых книг.

## Tests / runtime verification

- Ответ API сверен с UI 1:1: `progress-panel` вернул ровно
  `{task_id:null, type:image, scope:whole_book, total:9, ready:0, percent:0, started_at:null, visible:true, done:false}`,
  `worker/counts` → `image:0, private_image:0, active_image:0` — UI не врёт.
- Наблюдение вживую: каждый тик scheduler `Active: 1, Dispatched: 0, Skipped: 1` —
  сцена активно пропускается, dispatch не происходит, lease не создаётся.
- Полный lifecycle-тест (0/2 → generation → 1/2 → 2/2 → completed) на момент расследования
  провести невозможно: в системе 0 image-воркеров (heartbeat нет) — любая тестовая генерация
  ляжет в очередь мёртвым грузом и воспроизведёт тот же симптом. План: подключить image worker →
  очистить призрака штатным regen'ом → прогнать 1–2 IU.
