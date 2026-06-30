# Architectural Audit: Конфликтующие подсистемы

> Дата: июнь 2026
> Цель: Определить, где подсистемы конкурируют за управление состоянием, и наметить пути к единой координации.

---

## Статус Phase 1 (Passive Recovery)

> ✅ **R1.2** — Audio recovery: рантайм-цикл (setInterval 5s) убран. `recoverAudioResults()` сохранён для on-demand вызова.
> ✅ **R1.3** — Reconciliation engine: auto-fix убран из runtime-loop. Добавлен `POST /debug/runtime/apply-fix` для ручного вызова.

---

## 1. Карта подсистем и их "право вето"

### 1.1 Dirty-система (book-diff.cjs) — **Инициатор**

**Роль:** Сравнивает old/new book, вычисляет dirty-слои через Prompt Dependency Registry, запускает `markDirtyScenes()`.

**Реальное право вето:**
- Lua-скрипт `RESET_SCENE_LUA` атомарно сбрасывает chunk-метаданные и per-asset states в `pending`
- Добавляет сцены в active-scenes index
- Вызывает `syncLinearState()` после каждой dirty-сцены

**Где перебивается:**
- `scene-window.restoreChunkStatusForScene()` может восстановить `audio_status = 'ready'` сразу после того, как dirty-система поставила `'pending'`
- `dispatch-engine` может сказать "duplicate, lease still active"

---

### 1.2 Dispatch Engine (dispatch-engine.js) — **Контролёр доступа**

**Роль:** Единственный способ запустить stage. Проверяет lease, quota, circuit breaker, retry budget.

**Реальное право вето:**
- `DISPATCH_SKIPPED_DUPLICATE: lease still active` — если lease жив, диспатч блокируется
- Backpressure quotas (audio: 3, image: 2, video: 1)
- «Phase 9» governance (circuit breaker, retry budget, fairness)

**Проблема:** Lease — это одновременно защита от дублей И препятствие для force-regen. Если пользователь хочет перегенерировать, а lease ещё активен от предыдущей попытки, система скажет "дубликат". В `book-routes.cjs` есть pre-delete и очистка dedup-ключей для dirty units, но lease может остаться.

---

### 1.3 Scene Window (scene-window.js) — **Кеширующий оптимизатор**

**Роль:** Проверяет, есть ли контент на диске, и если есть — пропускает GPU.

**Реальное право вето:**
- `sceneHasValidContent()` → если аудио реальное (не placeholder), изображения и видео есть — возвращает `true`, и сцена НЕ отправляется на GPU
- `restoreChunkStatusForScene()` → переписывает `audio_status: 'pending'` обратно в `'ready'`/`'placeholder'` на основе файлов на диске
- `startScene()` → если `sceneHasValidContent() = true`, ставит `VIDEO_READY` и не диспатчит ничего

**Ключевой конфликт:** markDirtyScenes() сбрасывает всё в pending, а через несколько миллисекунд `startScene()` / `restoreChunkStatusForScene()` может вернуть всё обратно в ready, если файлы есть на диске. Это корректно для кеша, но может помешать force-regen.

---

### 1.4 Startup Recovery (startup-recovery.js) — **Восстановитель после падения**

**Роль:** На старте восстанавливает Redis-состояние из PG и файловой системы.

**Реальное право вето:**
- Step 2: `recoverIuImagesFromDisk()` — находит PNG на диске и ставит `image_status = 'ready'` в Redis. Если после падения dirty-флаги потеряны, а файлы остались — восстановление делает их ready, и система не узнает, что нужна перегенерация.
- Step 3: `reconcileMissingSceneState()` — восстанавливает scene counters, placeholder audio, scene_hashes в PG
- Step 4: `checkVersionStaleness()` — только логирует, не чинит

**Проблема:** Если книга была изменена, crash произошёл ДО того, как markDirtyScenes выполнился, то при старте recovery восстановит ВСЁ как ready (потому что файлы есть), и изменения не приведут к перегенерации. **Это потеря данных.**

---

### 1.5 Audio Recovery (audio-recovery.cjs) — **Активный восстановитель (every 5s)**

**Роль:** Каждые 5 секунд сканирует `animastor:result:*` в Redis и восстанавливает результаты GPU на диск.

**Реальное право вето:**
- Может перезаписать chunk metadata, установив `audio_status = 'ready'`
- Может вызвать `handleTaskResult()`, который триггерит `handleAudioCompleted()`

**Проблема:** Работает в рантайме, а не только на старте. Может "восстановить" результат, который пользователь явно отменил и хочет перегенерировать.

---

### 1.6 Reconciliation Engine (reconciliation-engine.js) — **Самоисцелятор**

**Роль:** Детектит несоответствия между state machine и реальными файлами, умеет чинить.

**Реальное право вето:**
- `checkOrphanVideoState()` / `checkOrphanImageState()` / `checkOrphanAudioState()` — находит READY-состояния без файлов
- `checkStaleDispatchLeases()` — находит stale leases
- `checkStuckScenes()` — находит stuck-состояния
- `applyFix()` — может применить `REGENERATE_MISSING_ASSET`, `MOVE_TO_PENDING`, `RELEASE_STALE_LEASE`, `PROGRESS_TO_IMAGE`, `RECONCILE_COUNTER_DRIFT` и другие фиксы

**Проблема:** Reconciliation engine — это ещё один центр принятия решений, который:
- Не знает о пользовательских намерениях (force-regen)
- Может "починить" состояние, которое было намеренно установлено dirty-системой
- Имеет свою модель "правильного" состояния, которая может не совпадать с моделью других подсистем

---

### 1.7 Image Service (image-service.js) — **Исполнитель с bypass-ами**

**Роль:** Генерирует изображения IU.

**Реальное право вето:**
- `processSingleIU()` — `dirtyUnitIds` bypass: если unit в dirty-списке, пропускает disk cache check и отправляет на GPU
- В том же месте чистит GPU hub dedup key (`animastor:job:{job_id}`) перед dispatch, чтобы regeneration не блокировался
- Устанавливает in-flight маркер (`iu-in-flight:{id}`, TTL 20 min) для предотвращения дублей на следующих tick-ах

**Это правильно:** image-service — единственное место, где dirty unit bypass работает корректно.

---

### 1.8 Scene Orchestrator (scene-orchestrator.js) — **Центральный дирижёр**

**Роль:** Dispatch execution, callback handling, stale state tolerance.

**Реальное право вето:**
- `executeImageDispatch()` — [VERSION-STALE CHECK] перед генерацией проверяет PG версии, и если `asset_ver < scene_ver` — форсирует реген
- `executeVideoDispatch()` — то же для видео
- `handleImageCompleted()` — stale state tolerance: если состояние не IMAGE_GENERATING, но файлы есть — всё равно завершает
- `handleAudioCompleted()` / `handleVideoCompleted()` — то же самое

**Проблема:** Stale state tolerance — это "лазейка", которая решает конкретные баги (callback пришёл после cancel→regenerate), но сигнализирует о том, что state machine не является единственным источником истины. Файлы на диске могут переопределить состояние.

---

### 1.9 Book Sync (book-sync.js) — **PG-аудитор**

**Роль:** Синхронизирует Book JSON с PG.

**Реальное право вето:**
- `markSceneAssetsStale()` — меняет status в PG с 'ready' на 'stale'
- `reconcileFromDiff()` — обновляет scene_hashes, отменяет generation_tasks

**Конфликт:** У book-sync есть версионная проверка (`getOutdatedByVersions`), которая может найти stale assets, но она только логирует — не инициирует перегенерацию. Это правильно (read-only auditor), но может сбивать с толку.

---

## 2. Матрица конфликтов

| Сценарий | Dirty | Dispatch | Window | Recovery | Recon Engine | Кто побеждает |
|---|---|---|---|---|---|---|
| **Regenerate после edit** | ставит pending | lease может блокировать | restore после dirty | — | может "починить" обратно | **Window** (восстанавливает ready) |
| **Crash после save до regenerate** | потерян | — | стартует с диска | восстанавливает всё как ready | не запущен | **Recovery** (файлы есть → ready) |
| **Callback после Cancel→Regenerate** | новая dirty, новый buildId | старый lease может блокировать | stale state tolerance | может обработать старый result | — | **Orchestrator** (stale state tolerance) |
| **Force-regen dirty unit** | dirty unit в PG | dedup cleared | cache bypass | — | — | **Image Service** (правильно) |
| **Audio recovery находит старый result** | — | — | — | восстанавливает файл | — | **Audio Recovery** (без контекста) |

---

## 3. Корень проблемы: четыре центра принятия решений

У нас есть **четыре независимых механизма**, каждый из которых может установить или переопределить состояние:

```
1. Dirty/Regenerate        — устанавливает PENDING (через Lua)
   (book-diff.cjs + markDirtyScenes)

2. Scene Window / Cache    — устанавливает READY (файлы есть)
   (sceneHasValidContent + restoreChunkStatus)

3. Startup Recovery        — устанавливает READY (файлы есть)
   (recoverIuImagesFromDisk + reconcileMissingSceneState)

4. Reconciliation Engine   — может установить PENDING или READY
   (applyFix: REGENERATE_MISSING_ASSET, MOVE_TO_PENDING, etc.)
```

Никто из них не знает о намерениях остальных. Dirty не знает, что Window только что восстановил ready. Recovery не знает, что пользователь нажал regenerate.

**Истина размазана по трём источникам:**
- **PG** — версии (content_version, audio_config_version), dirty_unit_ids, scene_hashes
- **Redis** — per-asset states, chunk metadata, scene states, leases
- **Файловая система** — .mp3, .png, .mp4 файлы

---

## 4. Что ChatGPT предложил — и что из этого применимо

### ✅ "User intent bypass" — частично реализовано

Dirty unit bypass через `dirtyUnitIds` в `processSingleIU()` — это именно user intent bypass. Пользователь отредактировал юнит → dirty_unit_ids сохраняется в PG → при dispatch этот unit force-генерируется, минуя кеш.

**Но:** это работает только для per-unit regeneration. Для сценарного force-regen (весь слой image/video) механизм менее надёжен — relies on version staleness check в scene-orchestrator.

### ✅ "Recovery как пассивная система" — НЕ реализовано

Audio recovery активен в рантайме (каждые 5с). Recovery при старте восстанавливает состояние без контекста о dirty. Reconciliation engine может изменять состояние в любой момент.

### ❌ "Единый UnitState" — НЕ реализовано

У нас dual model (linear FSM + per-asset), но это не единый источник истины. Настоящая истина — в PG + файлы + Redis одновременно.

### ❌ "Оркестратор принимает решения, остальные советуют" — НЕ реализовано

Window, Recovery, Reconciliation Engine — все могут принимать решения. Dispatch Engine имеет право вето.

---

## 5. Рекомендации по уменьшению сложности

### 5.1 Passive Recovery (высокий приоритет)

Сделать recovery пассивным:
- **Startup recovery:** только восстанавливает Redis из PG. Не устанавливает статусы на основе файлов на диске — только логирует расхождения.
- **Audio recovery:** убрать рантайм-цикл (5s). Заменить на триггер по callback от GPU Hub.
- **Reconciliation engine:** убрать auto-fix. Только логировать и предлагать фиксы. Применять их только по явному запросу (через эндпоинт /admin).

### 5.2 Dispatch Lease с учётом пользовательских намерений (средний)

Сейчас lease — это чистый "замок" с TTL. Если regenerate пришёл, lease должен форсированно освобождаться для этой сцены:
```
dispatchStage(..., { force: true }) → 
  1. Redis.DEL lease (если есть)
  2. Redis.DEL quota (если есть)  
  3. Acquire new lease
  4. Dispatch
```

Сейчас это делается для dirty units (dedup key очищается), но не для сценарных lease.

### 5.3 Версионный детект stale-состояний (уже внедрено, R13-R16) — **развивать**

Version-based подход (content_version, audio_config_version) — правильный путь. Он позволяет:
- Вычислить dirty как `asset_version < scene_version`, а не как explicit-флаг
- Persist версии в PG (переживают crash)
- Избежать флагов, которые могут быть потеряны

**Следующий шаг:** Перенести dirty-флаги из Redis в PG полностью. Redis хранит только runtime-состояние (прогресс, очереди). PG — истину (версии, dirty-ли).

### 5.4 Упрощение stale state tolerance (низкий)

5 мест в scene-orchestrator.js проверяют "state не совпадает, но файлы есть — всё равно завершаем". Если бы state machine была единственным источником истины, эти лазейки не понадобились бы.

---

## 6. Итоговая карта "кто есть кто"

| Подсистема | Сейчас | Должно быть |
|---|---|---|
| **book-diff** (dirty) | Инициатор | Единственный инициатор dirty |
| **dispatch-engine** | Контролёр (lease) | Исполнитель решений оркестратора |
| **scene-window** (cache) | Принимает решения (valid content) | Только советует (cache advisory) |
| **startup-recovery** | Восстанавливает с auto-fix | Только логирует расхождения |
| **audio-recovery** | Активный цикл (5s) | Только по callback |
| **reconciliation-engine** | Применяет auto-fix | Только аудит |
| **scene-orchestrator** | Центральный дирижёр | Единственный, кто изменяет состояние |

В идеале: система, где изменение состояния происходит в одном месте, по одному протоколу, с учётом контекста (user intent, current mode).

---

## 7. Избыточная сложность: 5 точек, требующих аккуратной расчистки

> Ниже — пять конкретных мест, где сложность не оправдана и создаёт риски при изменениях.
> Каждый пункт требует постепенного, тестируемого подхода: никаких "big bang" рефакторингов.

### 7.1 Dual State Model (linear FSM + per-asset)

**Проблема:** Per-asset состояния — канонический источник истины. Linear FSM — производная проекция для обратной совместимости. `syncLinearState()` вызывается ПОСЛЕ КАЖДОГО изменения per-asset состояния:

- `scene-orchestrator.js`: 11+ вызовов `syncLinearState()`
- `book-diff.cjs`: 1 вызов после `markDirtyScenes()`
- Каждый вызов = Redis GET + JSON.parse + Redis SET

**Риск:** Расхождение между per-asset и linear состояниями. Каждый баг вида "callback пришёл, а состояние не то" — это следствие расхождения.

**Подход к расчистке:**
1. Сначала сделать per-asset source of truth везде (уже сделано в теории)
2. Затем найти всех потребителей linear FSM и перевести их на per-asset
3. Удалить `syncLinearState()` — это будет финальным шагом, когда никто не зависит от linear

---

### 7.2 Четыре дублирующихся проверки файлов на диске

Все четыре делают одно и то же: сканируют output-директорию и сверяют с Redis:

| Функция | Где | Что делает |
|---|---|---|
| `sceneHasValidContent()` | scene-window.js | Проверяет .mp3, .png, .mp4 на диске для одной сцены |
| `restoreChunkStatusForScene()` | scene-window.js | Восстанавливает chunk status из файлов после dirty |
| `reconcileWindowStatuses()` | scene-window.js | Сканирует все chunk keys и сверяет с файлами |
| `recoverIuImagesFromDisk()` | startup-recovery.js | На старте сканирует PNG и ставит image_status='ready' |

**Проблема:** Разная логика в каждом месте. Одно может сказать "ready", другое "pending" для одного и того же файла.

**Подход к расчистке:**
1. Выделить единую функцию `getSceneFilesStatus(buildDir, bookId, chapterId, sceneId)` которая возвращает `{ audio: { exists, isReal }, image: { exists }, video: { exists } }`
2. Заменить все 4 проверки вызовами этой функции
3. Постепенно убрать дублирующиеся места

---

### 7.3 Audio recovery как активный цикл (every 5s)

**Проблема:** `audio-recovery.cjs` каждые 5 секунд сканирует все `animastor:result:*` ключи в Redis. Это:

- Лечит симптомы, а не причину (callback chain repair уже сделан в R18)
- Может "восстановить" результат, который пользователь отменил
- Создаёт лишнюю нагрузку на Redis (SCAN по всем ключам)

**Подход к расчистке:**
1. Сначала R18 уже починил callback chain — проверить, что recovery всё ещё нужен
2. Затем заменить цикл на триггерный механизм: recovery запускается только для конкретного job_id, если callback не пришёл в течение timeout
3. В конце — удалить `startRecoveryInterval()` и 5s цикл

---

### 7.4 Dispatch engine с 6 lazy-loaded governance-модулями

**Проблема:** `dispatch-engine.js` загружает через `safeRequire()`:

- `circuit-breaker.js`
- `retry-budget-manager.js`
- `fairness-engine.js`
- `policy-engine.js`
- `workload-classifier.js`
- `cost-estimator.js`

Все они — мёртвый код. Не используются в production. Загружаются только если файлы есть на диске. `safeRequire()` возвращает `null`, если модуль не найден — и dispatch-engine работает как обычно.

**Подход к расчистке:**
1. Решить: нужны эти модули или нет
2. Если нет — удалить файлы
3. Если да — активировать в core pipeline
4. Текущее состояние ("вроде есть, но не используются") — худшее из возможных

---

### 7.5 Stale state tolerance в трёх callback-ах

**Проблема:** Три callback-а в `scene-orchestrator.js` имеют одинаковый паттерн:

```javascript
if (!currentState || currentState.state !== EXPECTED_STATE) {
    if (filesExistOnDisk) {
        // Stale state tolerance: завершаем всё равно
    } else {
        // Отклоняем callback
    }
}
```

Это означает: **state machine не заслуживает доверия**. Если файлы есть — мы верим диску, а не state machine.

**Корень:** Cancel→Regenerate генерирует новый buildId, но callback от GPU может прийти со старым buildId. State machine уже сброшена, но GPU ещё работает над старым job.

**Подход к расчистке:**
1. Сначала R2 (force lease release) — гарантирует, что новый regenerate снимает старые leases
2. Затем R3 (unit in-flight tracking) — предотвращает dispatch для уже запущенных job-ов
3. Только после этого можно убрать stale state tolerance — потому что новой dirty будет предшествовать очистка старых job-ов

---

## 8. Постепенный подход к расчистке

```
Этап 1 (сейчас):   Осознать проблему ✅
                    Задокументировать ✅
                    
Этап 2 (ближайшие): Убрать активный recovery (R1.2)
                    Force lease release (R2.1)
                    
Этап 3 (среднесрочно): Убрать stale state tolerance (зависит от R2)
                        Консолидировать проверки файлов (7.2)
                        
Этап 4 (долгосрочно): Убрать dual state model
                       Почистить governance мертвый код
```

**Принцип:** Каждое изменение должно:
1. Иметь тесты (хотя бы интеграционные)
2. Быть отделяемым — можно откатить без каскада
3. Не менять поведение системы для пользователя (только внутреннюю архитектуру)

---

## 9. Целевая архитектура: источник истины для каждого вопроса

> Основано на обсуждении с ChatGPT: ключевая проблема — отсутствие единого ответственного за каждый вопрос.

### 9.1 Принцип разделения хранилищ

> **Redis хранит то, что можно потерять.**
> **База данных хранит то, что нельзя потерять.**

Если Redis завтра исчезнет (`redis flushall`), система должна восстановиться. Может быть медленно (пересборка кэшей), но **без потери проекта**. Если пропадёт PG — это катастрофа.

### 9.2 Таблица ответственности

| Вопрос | Кто отвечает | Где хранится | Тип |
|---|---|---|---|
| **Нужно ли регенерировать?** | **PG (версии)** | `scenes.content_version`, `scenes.audio_config_version` | **Факт** |
| **Какие юниты dirty?** | **PG** | `scenes.dirty_unit_ids` | **Факт** |
| **Есть ли задача на GPU?** | **Scheduler** | `dispatch-lease` в Redis | Производное |
| **Есть ли файл на диске?** | **Storage** | Файловая система | Производное |
| **Есть ли готовый результат?** | **PG** | `scene_assets.status` | **Факт** |
| **Какой прогресс (43%)?** | **Redis** | chunk metadata | Производное (кэш) |
| **Сцена в очереди?** | **Redis** | `active-scenes` | Производное |
| **Кэш промпта?** | **Redis** | (где-то в runtime) | Производное (кэш) |
| **Дубликат задачи?** | **Redis** | `animastor:job:*` | Производное (TTL) |

Отличия факта от производного состояния:

- **Факт** — хранится в PG, переживает crash, является источником истины
- **Производное** — хранится в Redis или файловой системе, может быть восстановлено из фактов

### 9.3 Что сейчас нарушает этот принцип

**В Redis хранятся факты:**
- `animastor:asset-state:*` — per-asset состояния (dirty/pending/generating/ready) — **это факт, должен быть в PG**
- `animastor:scene-state:*` — linear FSM — **производное** (вычисляется из per-asset), может быть в Redis

**В PG дублируются производные:**
- `scene_assets.status` — дублирует per-asset state из Redis. **Это правильно:** PG — факт, Redis — быстрый кэш.
  Но если Redis и PG расходятся — кто прав?

**Storage (файлы) принимает решения:**
- `sceneHasValidContent()` — проверяет файлы и на основе этого решает, пропустить ли GPU. **Файлы не должны быть источником истины для состояния генерации.**

### 9.4 Целевая архитектура: дирижёр

```
            ┌─────────────────────────────────────┐
            │          ОРКЕСТРАТОР                 │
            │  (принимает решения)                 │
            │                                      │
            │  ┌──────────────────────────────┐    │
            │  │  Источники информации:       │    │
            │  │  ├── PG: версии, статусы     │    │
            │  │  ├── Redis: прогресс, кэш   │    │
            │  │  ├── Storage: файлы          │    │
            │  │  └── GPU Hub: результат      │    │
            │  └──────────────────────────────┘    │
            │              │                        │
            │              ▼                        │
            │  ┌──────────────────────────────┐    │
            │  │  Исполнители:                │    │
            │  │  ├── dispatch-engine          │    │
            │  │  ├── audio/image/video service│    │
            │  │  └── scene-window (slide)     │    │
            │  └──────────────────────────────┘    │
            └─────────────────────────────────────┘

  Каждый модуль отвечает на СВОЙ вопрос и НЕ принимает решений.
  Решения принимает только оркестратор.
```

### 9.5 Что это меняет для каждого модуля

| Модуль | Сейчас | Цель |
|---|---|---|
| **PG версии** | Хранит версии, но dirty определяется через Redis | Единственный источник truth для "нужна ли регенерация" |
| **scene-window** | `sceneHasValidContent()` решает пропустить GPU | `getSceneFilesStatus()` возвращает информацию, оркестратор решает |
| **dispatch-engine** | Lease может блокировать dispatch | Lease — только информация, оркестратор может force |
| **startup-recovery** | Восстанавливает статусы (файлы есть → ready) | Логирует расхождения, не меняет состояния |
| **audio-recovery** | Активный цикл 5с, восстанавливает результаты | Только по таймауту для конкретного job |
| **scene-orchestrator** | Stale state tolerance (обходит state machine) | Доверяет state machine (после R2) |
| **reconciliation-engine** | Auto-fix (меняет состояние) | Только аудит + API /admin/apply-fix |

### 9.6 Критерий успеха

Система достигла цели, когда после `redis flushall`:

1. Backend стартует
2. Startup recovery логирует: "найдено N файлов на диске, K расхождений с PG"
3. **Ничего не меняется в состоянии**
4. Runtime scheduler начинает tick
5. `shouldScheduleAssets()` проверяет PG версии: `asset_version < scene_version?`
6. Для устаревших сцен — dispatch
7. Для актуальных — `sceneHasValidContent()` (уже advisory) предлагает пропустить
8. Оркестратор принимает решение

**Ни один файл на диске не может переопределить состояние без решения оркестратора.**
