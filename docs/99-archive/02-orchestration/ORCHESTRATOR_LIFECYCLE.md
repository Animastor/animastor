# 03. Единый Orchestrator — жизненный цикл генерации

> Фокус строго на жизненном цикле генерации ассетов (audio / image / video).
> Импорт, AI-анализ книги, чат-ассистент и плеер — вне рамок этого документа.
> Часть 1 (§1–§7) — анализ «как есть» по коду. Часть 2 (§8–§13) — предлагаемая архитектура.
> Дата: 2026-06-25. Основано на чтении исходного кода, а не документации.

---

## 1. Что вообще считается «жизненным циклом генерации»

Речь об одной сцене и трёх её ассетах. Каждый ассет проходит независимый путь состояний
(per-asset модель, канон с v2.1.0):

```
NEW → DIRTY → PENDING → GENERATING → READY
                                   ↘ FAILED
audio дополнительно: → PLACEHOLDER (временная заглушка до реального TTS)
```

Зависимость между ассетами ровно одна, функциональная:
**video можно собрать только когда image = READY** (видео клеится из IU-картинок).
audio и image идут параллельно и независимо.

Сцена «жива», пока хотя бы один её ассет не в терминальном состоянии (READY/FAILED).
Признак «жива» физически выражен членством в Redis-множестве `animastor:active-scenes`.

---

## 2. Как сейчас принимается решение «что нужно генерировать»

Решение принимается **в момент тика** (раз в 5 сек), для каждой сцены из активного индекса.

**Путь решения:**

```
runtime-loop.executeTick (каждые 5с, setInterval в backend)
  └─ runtime-scheduler.tick(redis)
       ├─ acquireSchedulerTickLock   ← single-flight: один тик на инстанс
       ├─ getActiveSceneKeys         ← SMEMBERS animastor:active-scenes
       └─ для каждой сцены: attemptDispatch
            ├─ shouldScheduleAssets  ← РЕШАЕТ что генерировать
            └─ dispatchEngine.dispatchStage(stage) для каждой нужной стадии
```

**`shouldScheduleAssets()` (`runtime-scheduler.js:222`) — единственное место, где вычисляется
список стадий к запуску.** Логика:

1. Читает per-asset состояния из Redis (`state.getAssetStates`).
2. Читает layer-config книги (включены ли audio/image/video).
3. **Дополнительно лезет в PG** (`scenes` JOIN `scene_assets`) и сравнивает версии:
   если `scene_assets.scene_content_version < scenes.content_version` (или audio_config),
   считает ассет устаревшим и **прямо здесь переписывает Redis-состояние READY → DIRTY**
   (строки 274–289). То есть функция «решает» и одновременно «пишет состояние».
4. Возвращает `{ stages: [...], allDone }`:
   - `audio` — если включён и не в (READY/FAILED/GENERATING/PLACEHOLDER);
   - `image` — если включён и не в (READY/FAILED/GENERATING);
   - `video` — если включён, не в (READY/FAILED/GENERATING) **и** image=READY.

**Вывод:** решение «что генерировать» формально принадлежит планировщику, но фактически
размазано: планировщик читает Redis, при этом сам же чинит Redis по данным PG, попутно
дёргая запись состояния. Чтение и запись состояния в одной функции — первый признак
размытого владения.

---

## 3. Как определяется «что готово» и «что dirty»

Здесь — корень проблемы. **«Готово» и «dirty» вычисляются из разных хранилищ разными модулями,
и они не согласованы между собой.**

### 3.1 «Готово» (READY) — три независимых сигнала

> **T8:** Линейное состояние (`animastor:scene-state:*`) больше не пишется.
> Per-asset (`animastor:asset-state:*`) — единственный runtime source of truth.

| Сигнал готовности | Где хранится | Кто пишет |
|---|---|---|
| per-asset `READY` | Redis `animastor:asset-state:*` | оркестратор (`completeStage`) |
| Redis asset registry | Redis hash `storage.registry.*` | колбэки завершения |
| `scene_assets.status='ready'` | **PostgreSQL** | **T5:** `markDirtyScene/stale`, `completeStage/ready`, `failStage/failed` |
| наличие файла на диске | `data/output/<buildId>/*` | воркер пишет, Orchestrator проверяет наличие (не диктует lifecycle) |

Колбэк завершения пишет первые два сигнала + сбрасывает `is_dirty` в PG, **но не ставит
`scene_assets.status='ready'`**. Значит PG-статус остаётся `placeholder`/`stale`/пусто.
Планировщик при этом считает PG «каноном dirty-детекции» (§2 п.3) — то есть читает поле,
которое боевой код не заполняет.

### 3.2 «Dirty» — пять независимых писателей

`DIRTY` (нужна регенерация) выставляется из пяти разных мест:

1. **regenerate-роут** (`book-routes.cjs` → `book-diff.markDirtyScenes`) — пользователь
   нажал «перегенерировать». Атомарный Lua-reset per-asset → PENDING + добавление в активный индекс.
2. **shouldScheduleAssets** (планировщик) — version-stale из PG → READY становится DIRTY.
3. **startup-recovery** (`startup-recovery.js:285`) — на старте по version-stale ставит DIRTY.
4. **reconciliation-engine** (`:610,672`) — авто-фикс рассинхрона (сейчас по ручному эндпоинту).
5. **scene-restoration** (`:71`) — image → DIRTY при восстановлении сцены.

### 3.3 Чем это плохо

«Готово» по Redis ≠ «готово» по PG ≠ «готово» по диску. Пять писателей dirty работают
по разным триггерам и разным хранилищам. Никто не арбитрирует конфликт, если два писателя
в одном окне времени приняли противоположные решения (например, колбэк ставит READY,
а параллельный version-check — DIRTY). Порядок применения недетерминирован.

---

## 4. Как работает очередь и backpressure

Здесь две разные сущности, которые легко спутать.

### 4.1 Транспортная очередь (GPU Hub) — работает корректно

`dispatchStage` → orchestrator → `gpu.send()/sendUnified()` → **GPU Hub кладёт задачу
в Redis-список** `animastor:queue:{audio|image|video}`. Воркер делает polling, выполняет
ComfyUI, возвращает результат колбэком. Hub дедуплицирует (`job:* SET NX`), реквеуит по
таймауту (10 мин). Это простая и устойчивая часть — её менять не нужно.

### 4.2 Backpressure (квоты) — здесь баги

Backpressure живёт **в backend, до отправки в Hub**, как целочисленные счётчики Redis
`animastor:runtime:active-{audio,image,video}` с лимитами `QUOTAS` (audio 3 / image 2 / video 1).

Путь одного слота:
- **acquire** (`+1`): ровно один раз, `dispatchStage` шаг 2 (`acquireQuota`, `dispatch-engine.js:435`).
- **release** (`-1`): **дважды** на одно завершение:
  1. колбэк сам зовёт `releaseQuota` (`scene-callbacks.js:105,225,295`);
  2. сразу следом `task-handler.cjs` зовёт `markDispatchCompleted`, который **тоже** делает
     `releaseQuota` (`dispatch-engine.js:564`).

**Итог: один `incr`, два `decr`.** Счётчик систематически уползает вниз → `checkQuota` чаще
показывает «свободно» → диспатч превышает заявленные лимиты GPU. Существование отдельного
`counter-reconciliation` в живом тике — косвенное доказательство, что счётчики уже дрейфуют
и их приходится постоянно чинить.

Дополнительно: `acquireQuota` неатомарен (`checkQuota` GET, затем `incrementActiveCounter`
INCR — две операции). Тик защищён single-flight локом, но `dispatchStage` вызывается **и вне
тика** (см. §5), поэтому два параллельных диспатча могут оба пройти проверку и оба сделать INCR.

### 4.3 Мёртвый дубль лимитов

В `runtime-scheduler.js` есть **второй**, параллельный аппарат лимитов: `MAX_CONCURRENT_*`,
ключи `animastor:concurrent-*`, функции `incrementConcurrent/canScheduleStage`. Значения
совпадают (3/2/1), но **никто их не инкрементит в боевом пути** — `attemptDispatch` их не
трогает. При этом `getMetrics()` планировщика рапортует именно эти мёртвые счётчики (всегда 0),
вводя в заблуждение при отладке «почему висит».

---

## 5. Кто меняет статусы (полная карта писателей)

Per-asset состояние одной сцены пишут **семь** разных мест. Это и есть главный диагноз.

| # | Писатель | Что пишет | Триггер |
|---|---|---|---|
| 1 | `book-diff.markDirtyScenes` | → PENDING (Lua, атомарно) | regenerate-роут |
| 2 | `scene-callbacks.handle*Completed` | → READY | колбэк GPU |
| 3 | `runtime-scheduler.shouldScheduleAssets` | READY → DIRTY | тик (version-stale) |
| 4 | `startup-recovery` | → DIRTY / READY | старт сервера |
| 5 | `reconciliation-engine` | → DIRTY | ручной фикс |
| 6 | `scene-restoration` | image → DIRTY, audio → READY | восстановление |
| 7 | `scene-window` (placeholder) | audio → PLACEHOLDER | оконная генерация |

Плюс отдельно **линейное** состояние (`SceneState`) — производная проекция, которую пишут
`scene-orchestrator.execute*Dispatch` (через `transitionSceneState`) и `syncLinearState`.

### 5.1 Дыра: `GENERATING` не выставляется в per-asset (FIXED в Н.7, июнь 2026)

> **Исправлено:** `Н.7` (коммит `f0b81de`, июнь 2026) — `executeAudioDispatch/Image/VideoDispatch`
> теперь вызывают `setAssetState(..., 'generating')` сразу после `transitionSceneState`.
> Per-asset проходит через GENERATING. Защита от дублей больше не висит только на lease.
> Подтверждение: тест `FIXED §5.1 (Н.7): GENERATING IS set in per-asset after dispatch`
> в `happy-path.test.js`.

### 5.2 Кто кого «будит» (вход в активный индекс)

В `animastor:active-scenes` сцену добавляют: `scene-orchestrator.startScene` (первый диспатч),
`markDirtyScenes` (Lua, regenerate), `reconciliation-engine`, `book-routes.cjs:1960`
(restart-resume), `scene-window` (оконная генерация). Убирает из индекса — **только**
`handleVideoCompleted` (и `completeSceneWithout*`) + `attemptDispatch`, когда `allDone`.

---

## 6. Как обновляется прогресс

Прогресс генерации собирается из нескольких источников, ни один из которых не является
единым счётчиком:

- **IU-прогресс картинок** — счётчик `animastor:iu-progress:<scene>:image`, инкрементится
  в `task-handler.cjs:75` на каждый пришедший IU. Завершение сцены по картинкам, однако,
  определяется **не им**, а подсчётом PNG-файлов на диске (`fs.readdirSync`, `:89`) против
  числа IU в PG. Счётчик прогресса и условие завершения — разные механизмы.
- **chunk-статусы аудио** — `animastor:chunk:*` с полями `audio_status/image_status`,
  обновляются в колбэках и при merge.
- **per-asset state** — Redis `asset-state:*`, читается планировщиком.
- **линейное state** — `scene-state:*`, читается плеером и debug-эндпоинтами.

«Сцена завершена» вычисляется в трёх местах по-разному: планировщик — по терминальным
per-asset (`allDone`); task-handler для картинок — по числу файлов на диске; видео — по
валидности mp4. Завершение по диску (`task-handler.cjs:93`) **неидемпотентно**: повторный
колбэк по последнему IU снова видит «все файлы на месте» и снова запускает `handleImageCompleted`
+ `markDispatchCompleted` (повторный release квоты, повторный авто-слайд окна).

---

## 7. Кто владелец состояния сейчас — короткий ответ

**Единого владельца нет.** Формально владельцем объявлен `runtime-scheduler`
(комментарий в коде: «The ONLY authority for scene lifecycle progression»). Фактически:

| Вопрос | Кто реально решает |
|---|---|
| что генерировать | scheduler (`shouldScheduleAssets`), но по данным из PG+Redis вперемешку |
| можно ли диспатчить | dispatch-engine (lease + quota + circuit/retry/fairness) |
| что готово | колбэки (Redis), но НЕ PG; + диск-проверки |
| что dirty | 5 писателей (regenerate / scheduler / recovery / reconciliation / restoration) |
| что в работе | lease (Redis NX), а НЕ per-asset GENERATING |
| прогресс | счётчики IU + chunks + файлы на диске, рассогласованно |
| завершение | 3 разных условия (per-asset / файлы / валидность mp4) |

Это распределённая система принятия решений на одном сервере, где простого арбитра хватило бы.
Канон (PG) рассинхронизирован с runtime (Redis), а диск местами переопределяет оба.

---

# Часть 2. Единый Orchestrator

## 8. Принципы (что меняем, чего НЕ трогаем)

Цель: **один модуль владеет жизненным циклом генерации**. Не переписываем проект —
вводим арбитра и сводим к нему всех писателей состояния.

**НЕ трогаем** (работает и не относится к владению состоянием):
- GPU Hub, очереди Redis, воркеры, ComfyUI — транспорт оставляем как есть;
- генераторы `audio/image/video/*` — сборку задач не меняем;
- AI-анализ, чат, плеер.

**Меняем только слой принятия решений:**
1. Один владелец перехода состояния — `Orchestrator`.
2. Один источник истины для lifecycle — PG (`scene_assets`). Redis — кэш/координация. Диск — только байты.
3. Остальные модули не пишут состояние напрямую, а **поставляют факты** Orchestrator'у.

**Три инварианта, которые арбитр обязан держать:**
- I1. Состояние ассета меняется только через `Orchestrator` (единственная точка записи).
- I2. На каждый `acquire` слота квоты ровно один `release` (идемпотентно по dispatch-token).
- I3. Завершение ассета идемпотентно по `(scene, asset, build_id)` — повторный колбэк безвреден.

---

## 9. Граница Orchestrator: единственный API записи

Вводим один модуль `orchestration/orchestrator.js` с узким командным API. **Только он**
пишет per-asset состояние и трогает квоты/lease. Все остальные модули вызывают его команды,
а не Redis/PG напрямую.

```
                 ┌──────────────────────────────────────────────┐
   факты  ──────►│              ORCHESTRATOR                     │
 (события)       │  единственный писатель lifecycle-состояния   │
                 │                                              │
 regenerate ───► │  markDirty(scene, layers, reason)            │
 scheduler ────► │  planScene(scene) → stages[]   (чистая ф-я)  │
 dispatch  ◄──── │  beginStage(scene, stage, buildId)          │
 callbacks ────► │  completeStage(scene, stage, buildId)       │
 callbacks ────► │  failStage(scene, stage, err)               │
 recovery  ────► │  reconcile(scene)  (факты диска/PG → команды)│
                 └──────────────────────────────────────────────┘
                          │ пишет            │ читает
                          ▼                  ▼
                    PG scene_assets     Redis (lease/quota/cache)
                    (КАНОН lifecycle)   (производное)
```

**Команды (контракт):**

- `markDirty(scene, layers[], reason)` — единственный способ объявить «нужна регенерация».
  Заменяет всех пятерых писателей DIRTY из §3.2. Внутри: PG `status='dirty'`/version-bump +
  Redis-кэш + добавление в активный индекс. Атомарно.
- `planScene(scene) → { stages, allDone }` — **чистая функция решения** (бывший
  `shouldScheduleAssets`), но без побочных записей. Только читает, ничего не чинит.
- `beginStage(scene, stage, buildId)` — атомарно: lease(NX) + quota(+1) + per-asset→GENERATING +
  PG status. Возвращает dispatch-token. Только отсюда стартует генерация.
- `completeStage(scene, stage, buildId)` — идемпотентно по token: per-asset→READY +
  PG `status='ready'` + version-stamp + lease release + quota(-1, ровно один). Чинит C1/C2/C4.
- `failStage` / `reconcile` — симметрично.

---

## 10. Источник истины и роль каждого хранилища

После введения Orchestrator роли фиксируются жёстко:

| Хранилище | Роль | Кто пишет |
|---|---|---|
| **PG `scene_assets`** | КАНОН lifecycle: status + версии + dirty | только Orchestrator |
| **Redis `asset-state:*`** | производный кэш состояния (быстрое чтение в тике) | только Orchestrator |
| **Redis lease/quota** | координация конкурентности | только Orchestrator |
| **Диск `data/output`** | байты результата | воркер пишет, Orchestrator только проверяет наличие |

Ключевое правило: **диск больше не диктует lifecycle.** `sceneHasValidContent`,
`restoreChunkStatusForScene`, `recoverIuImagesFromDisk` перестают писать READY/DIRTY.
Они становятся источником **фактов** для `reconcile()`: «файл существует / не существует».
Решение по факту принимает Orchestrator, сверяясь с версией (`build_id` + `scene_hash`),
а не просто «файл есть → готово». Это закрывает M3 (force-regen не отменяется старым файлом).

При расхождении PG ↔ Redis **PG выигрывает**: Redis-кэш перестраивается из PG, никогда наоборот.

---

## 11. Жизненный цикл через Orchestrator (целевой поток)

```
1. Пользователь / window-generator
      └─ orchestrator.markDirty(scene, [audio,image]) 
            → PG: status=dirty, version bump; Redis-кэш=PENDING; +active-index

2. Tick (scheduler стал тонким — только перебор активных)
      └─ stages = orchestrator.planScene(scene)   // чистое решение, без записи
      └─ для каждой stage: orchestrator.beginStage(scene, stage, buildId)
            → lease(NX)+quota(+1)+state=GENERATING (одной атомарной операцией)
            → orchestrator зовёт генератор → gpu.send()

3. Worker → ComfyUI → callback → task-handler
      └─ orchestrator.completeStage(scene, stage, buildId)   // идемпотентно по token
            → state=READY, PG status=ready+version stamp
            → lease release, quota(-1) РОВНО один раз
            → если allDone: убрать из active-index + slide window

4. Сбой/рестарт
      └─ orchestrator.reconcile(scene)  // факты PG+диск → команды, без прямых записей
```

Что изменилось по сравнению с §2–§7:
- решение (`planScene`) отделено от записи — больше нет «решаю и чиню одновременно»;
- `GENERATING` реально выставляется → защита от дублей не висит только на lease (закрывает §5.1);
- release квоты ровно один (token-идемпотентность) → C1/C4 закрыты;
- PG получает `status=ready` → C2 закрыт; PG и Redis больше не «две истины» → C3 теряет остроту.

---

## 12. Путь внедрения без переписывания проекта

Orchestrator вводится поверх существующего кода: тонкий фасад + перенаправление писателей.
Никакой замены GPU Hub, генераторов или плеера. Порядок шагов — от самых дешёвых к крупным.

**Шаг 0 (фундамент, без поведенческих изменений).**
Создать `orchestration/orchestrator.js` с пятью командами. Внутри он сначала просто
оборачивает уже существующие функции (`setAssetState`, `dispatchEngine.*`, `markDirtyScenes`).
Это даёт единую точку, но пока ничего не ломает.

**Шаг 1 — закрыть квоты (C1/C4).**
`completeStage` делает release ровно один раз, идемпотентно по dispatch-token.
Убрать `releaseQuota` из `scene-callbacks` ИЛИ из `markDispatchCompleted` — оставить один.
Добавить дедуп `/gpu/task/result` по `(job_id)` перед `handleTaskResult`.

**Шаг 2 — закрыть PG-канон (C2/C3).**
`completeStage` пишет `scene_assets.status='ready'` + version stamp. Развести два registry
по именам (`redisAssetCache` vs `pgAssetRepo`), чтобы исключить путаницу.

**Шаг 3 — ввести GENERATING (§5.1).**
`beginStage` атомарно выставляет per-asset `GENERATING` вместе с lease+quota. Защита от
дублей перестаёт зависеть только от lease.

**Шаг 4 — сделать `planScene` чистой.**
Вынести version-stale запись из `shouldScheduleAssets` в `markDirty`. Планировщик только читает.

**Шаг 5 — свести писателей к одному (M3/M5).**
`scene-window` / `startup-recovery` / `reconciliation` / `scene-restoration` перестают писать
состояние напрямую — вызывают `orchestrator.reconcile/markDirty`. Диск становится фактом, не решением.

**Шаг 6 — уборка.**
Удалить мёртвый дубль `MAX_CONCURRENT_*` / `animastor:concurrent-*`, починить `getMetrics`,
запланировать вывод линейной проекции (плеер переводится на per-asset).

Каждый шаг автономен, проверяем и откатываем независимо. Проект остаётся рабочим между шагами.

---

## 13. Итог

Сейчас жизненным циклом генерации управляют **семь писателей состояния, три хранилища
и три разных определения «готово»**, без арбитра. Это распределённая модель на одном
сервере — её сложность работает против надёжности и порождает наблюдаемые баги:
дрейф квот, «двойную истину» Redis↔PG, несрабатывающий force-regen, повторные завершения.

Предложение — не переписывать, а **ввести единственного владельца** (`Orchestrator`) с узким
командным API, сделать **PG каноном lifecycle**, а Redis и диск — производными. Пять команд
(`markDirty / planScene / beginStage / completeStage / reconcile`) и три инварианта (I1–I3)
заменяют семь разрозненных писателей. Внедрение пошаговое (§12), каждый шаг закрывает
конкретные находки аудита (C1–C4, M1–M5) и оставляет систему работоспособной.

---

*Конец документа. Анализ «как есть» подтверждён чтением исходного кода; ссылки на файлы и
строки приведены для проверки. Архитектура Orchestrator — предложение, не реализация.*
