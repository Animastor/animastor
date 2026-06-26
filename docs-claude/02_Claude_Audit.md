# 02. Архитектурный аудит — Animastor

> Аудит проведён чтением исходного кода (не только документации), на основе `01_System_Map.md`.
> Дата: 2026-06-25.
> Контекст: проект на **малое число одновременных пользователей**. Поэтому критерий — не масштабируемость,
> а **простота, понятность и надёжность**. Корпоративные паттерны (шардинг, очереди на Kafka, CQRS и т.п.) НЕ предлагаются.
> Рекомендации в этом файле минимальны — основная задача найти и доказать проблемы. Приоритезация — следующий этап.

## Шкала Severity

- **Critical** — уже сейчас способно приводить к потере/искажению состояния, «залипанию» генерации или к расходящимся источникам истины.
- **Medium** — устойчиво работает в счастливом пути, но ломается на гонках, рестартах, повторных колбэках или усложняет сопровождение настолько, что баги почти неизбежны.
- **Low** — мусор/несогласованность, которая пока не вредит, но повышает когнитивную нагрузку и риск будущих ошибок.

---

## Сводная таблица

| # | Severity | Проблема | Где |
|---|---|---|---|
| C1 | Critical | Двойной декремент quota-счётчика (release в callback + в `markDispatchCompleted`) | `dispatch-engine.js`, `scene-callbacks.js`, `task-handler.cjs` |
| C2 | Critical | PG `scene_assets.status` не переводится в `ready` в боевом пайплайне | `scene-callbacks.js`, `services/scene-asset-registry.js` |
| C3 | Critical | Два разных модуля «asset registry» с одинаковыми именами функций (Redis vs PG) | `storage/asset-registry.js` vs `services/scene-asset-registry.js` |
| C4 | Critical | `/gpu/task/result` неидемпотентен + IU-завершение по подсчёту файлов на диске | `generation-routes.cjs`, `task-handler.cjs` |
| M1 | Medium | Неатомарный read-modify-write per-asset state (потеря обновления) | `state/scene-state.js` |
| M2 | Medium | Неатомарный check-then-incr в quota (`acquireQuota`) | `dispatch-engine.js` |
| M3 | Medium | Диск как источник истины переопределяет намерение пользователя | `runtime/scene-window.js`, `services/startup-recovery.js` |
| M4 | Medium | Две параллельные системы лимитов конкурентности, одна — мёртвая | `runtime-scheduler.js` vs `dispatch-engine.js` |
| M5 | Medium | Несколько центров записи состояния сцены (4+) | window / recovery / reconciliation / dispatch |
| L1 | Low | 18 из 36 модулей `runtime/` — debug-only, часть ссылается на несуществующие файлы | `runtime/*` |
| L2 | Low | Массовые inline `require()` внутри функций (скрытые зависимости, риск циклов) | `scene-callbacks.js` и др. |
| L3 | Low | Dual state model + `syncLinearState` после каждого изменения | `state/scene-state.js` |

---

## C1 — Critical: двойной декремент quota-счётчика

**Где:** `runtime/dispatch-engine.js` (`releaseQuota`, `markDispatchCompleted:564`), `orchestration/scene-callbacks.js:105,225,295`, `services/task-handler.cjs:98,186,252,326`.

**Описание.**
Backpressure-квоты (`animastor:runtime:active-{audio,image,video}`) — это простые целочисленные счётчики в Redis. На один успешный диспатч приходится **ровно один** `acquireQuota` (инкремент, `dispatch-engine.js:435`). Но на завершении счётчик уменьшается **дважды**:

1. Колбэк-обработчик сам делает release:
   - `handleAudioCompleted` → `dispatchEngine.releaseQuota(redis, 'audio')` (`scene-callbacks.js:105`)
   - `handleImageCompleted` → `releaseQuota('image')` (`:225`)
   - `handleVideoCompleted` → `releaseQuota('video')` (`:295`)
2. Сразу после этого `task-handler.cjs` вызывает `markDispatchCompleted`, который **тоже** делает `releaseQuota` (`dispatch-engine.js:564`):
   - audio: `task-handler.cjs:326` (и ранний возврат `:252`)
   - image: `:98 / :107 / :125`
   - video: `:186`

Итог: `decr` срабатывает два раза на один `incr`.

**Почему это проблема.**
`decrementActiveCounter` (`dispatch-engine.js:235-245`) защищает от ухода в минус только если на момент чтения значение `> 0`. Но при гонке (несколько сцен завершаются почти одновременно) счётчик стабильно «съедает» лишние слоты: фактически активных задач, например, 2, а счётчик показывает 0. После серии завершений счётчик систематически занижается.

**Какие реальные баги уже может вызывать.**
- **Превышение лимитов GPU.** Заниженный счётчик → `checkQuota` всегда «свободно» → диспатчер шлёт на GPU больше задач, чем заявленные квоты (audio 3 / image 2 / video 1). Для одного-двух воркеров это перегруз и рост таймаутов.
- Симметрично, в других гонках возможен «застрявший» завышенный счётчик (если release-путь не дошёл из-за ошибки до второго release) → ложная backpressure, генерация «висит», хотя воркер свободен.
- Существование `counter-reconciliation` в живом пути (см. System Map) — косвенное подтверждение, что счётчики *уже* дрейфуют и их приходится чинить.

**Корень.** Ответственность за release размазана между двумя слоями (callback и dispatch-engine), и оба считают себя владельцем квоты. Нужен ровно один владелец release на стадию.

---

## C2 — Critical: PG `scene_assets.status` не переходит в `ready` в боевом пайплайне

**Где:** `orchestration/scene-callbacks.js` (все три `handle*Completed`), `storage/postgres/repositories/scene-assets-repo.js:85` (`markReady`), `services/scene-asset-registry.js`.

**Описание.**
В PG есть таблица `scene_assets` со статусами `pending/ready/stale/failed/missing/placeholder`. Функция, которая ставит `status='ready'` — `scene-assets-repo.markReady()` (и общий `upsertAsset`). Поиск по всему backend:

- `markReady` **не вызывается нигде** в боевом коде (только определён).
- `upsertAsset` со статусом `ready` идёт только из `services/scene-asset-registry.js`, а тот вызывается **только из тестов** (`backend/tests/*`), из `placeholder-audio` (пишет `placeholder`) и `book-sync` (пишет `stale`).

Завершающие колбэки (`handleAudioCompleted/Image/Video`) при успехе делают:
- запись в **Redis**-реестр (`storage.registry.*` → `storage/asset-registry.js`, это Redis-hash, см. C3),
- `state.setAssetState(... READY)` (Redis per-asset),
- `sceneAssetsRepo.clearDirtyFlag(...)` (только сбрасывает `is_dirty`),

но **никогда не вызывают `markReady`**. То есть PG-статус ассета остаётся тем, чем был до генерации: `placeholder` (для audio), `stale` (после regenerate) или вообще без строки.

**Почему это проблема.**
PG объявлен каноном фактов («то, что нельзя потерять», System Map §4.4), и планировщик это использует напрямую: `shouldScheduleAssets()` (`runtime-scheduler.js:237-289`) читает `scene_assets.status` и `scene_*_version` и трактует PG как **источник истины для dirty-детекции**. Но реальный статус ready туда не доезжает.

**Какие реальные баги уже может вызывать.**
- **Расхождение Redis ↔ PG как «двойная истина».** Redis говорит `ready`, PG говорит `placeholder/stale`. Любой эндпоинт/восстановление, читающий PG (например, сводки `getBookAssetSummary`, диагностика, будущее восстановление после flush Redis), увидит сцену как незавершённую.
- **Ложная регенерация после рестарта/flush Redis.** Если Redis-состояние теряется, восстановление по PG не найдёт `ready` → сцена будет перегенерирована, хотя файлы и Redis (до flush) считали её готовой. Это прямой источник лишней нагрузки на GPU и «почему оно опять всё генерирует».
- **`scene_audio_config_version`/`scene_content_version` в PG не обновляются на ready-строке**, т.к. ready-строка не пишется — значит version-stale проверка в планировщике работает на устаревших/отсутствующих данных.

**Корень.** Путь записи «ready» в PG существует (`markReady`/`scene-asset-registry`), но не подключён к боевым колбэкам — те эволюционировали в сторону Redis-only.

---

## C3 — Critical: два модуля «asset registry» с одинаковыми именами функций (Redis vs PG)

**Где:** `storage/asset-registry.js` (Redis) и `services/scene-asset-registry.js` (PostgreSQL).

**Описание.**
В проекте сосуществуют два модуля с почти идентичным API — `registerSceneAudio / registerSceneImage / registerSceneVideo / getSceneAssets / hasAudioAsset / hasAllAssets / getStoryboardAsset / ...` — но пишущие в **разные хранилища**:

| Функция | `storage/asset-registry.js` | `services/scene-asset-registry.js` |
|---|---|---|
| `registerSceneAudio(...)` | `redis.hset` в `animastor:...` (Redis hash) | `sceneAssetsRepo.upsertAsset` (PG `scene_assets`) |
| сигнатура | `(redis, bookId, ...)` | `(bookId, ...)` — **без** redis |
| кто использует | боевые колбэки (`scene-callbacks.js` через `storage.registry.*`) | только `tests/*`, `placeholder-audio`, `book-sync` |

`storage/index.js:25` экспортирует как `registry` именно **Redis**-вариант. PG-вариант (`services/scene-asset-registry.js`) в живом коде не вызывается вообще.

**Почему это проблема.**
- Это и есть механическая причина C2: разработчик, читая `storage.registry.registerSceneImage(...)`, разумно полагает, что «зарегистрировал ассет» — но запись ушла только в Redis, а PG-близнец с тем же именем остался в стороне.
- Одинаковые имена с **разными сигнатурами** (`redis` первым аргументом или нет) — ловушка: вызов не того модуля либо упадёт, либо тихо запишет не туда.
- Дублирование `toLegacyShape`, `getSceneAssets`, `hasAllAssets` в двух местах означает, что любая правка форматов/логики должна делаться дважды и легко рассинхронизируется.

**Какие реальные баги уже может вызывать.**
- Прямо порождает C2 (PG-статус не обновляется).
- При любой попытке «починить PG» правкой одного из модулей легко поправить не тот — и баг останется.
- Тесты (`scene-asset-registry.test.js`) проверяют PG-вариант, который в проде не используется → зелёные тесты создают ложную уверенность, что регистрация ассетов в PG работает.

**Корень.** Исторически слой Redis-кэша и слой PG-фактов получили одинаковую «вывеску» registry. Нужно развести имена (например, `redisAssetCache` vs `pgAssetRepo`) и решить, кто пишет ready в PG.

---

## C4 — Critical: `/gpu/task/result` неидемпотентен + IU-завершение по подсчёту файлов на диске

**Где:** `routes/generation-routes.cjs:728-739`, `services/task-handler.cjs:53-131` (ветка `iu_image`).

**Описание.**
GPU Hub ретраит возврат результата в backend **до 5 раз** (System Map §5). Эндпоинт `/gpu/task/result` при этом:
- не проверяет, обрабатывался ли уже этот `job_id` (нет ключа `processed`/дедупа),
- безусловно вызывает `handleTaskResult` и возвращает `ok:true`.

Для картинок завершение сцены определяется **подсчётом PNG-файлов в каталоге** (`task-handler.cjs:88-93`):
```js
iuFiles = fs.readdirSync(outputDir).filter(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
if (iuFiles.length >= totalIUs && totalIUs > 0) {
    await orchestrator.handleImageCompleted(...);
    await dispatchEngine.markDispatchCompleted(..., 'image');
}
```
Никакой блокировки/atomic-флага «scene image already completed» здесь нет. Условие «файлов на диске ≥ totalIUs» истинно для **каждого** колбэка, пришедшего после последнего IU.

**Почему это проблема.**
- Любой повторный колбэк по последнему IU (ретрай Hub, дубликат в очереди, повторная доставка) снова видит «все файлы на месте» и снова дергает `handleImageCompleted` + `markDispatchCompleted`. Это **повторный release квоты** (усугубляет C1) и повторный `trySlideWindowOnComplete` для video.
- Гонка при параллельных IU: два IU-колбэка одной сцены приходят почти одновременно, оба читают каталог, оба видят полный набор, оба запускают завершение.
- Запись результата на диск (`fs.writeFileSync`, `:48`) тоже не идемпотентна по версии — повторный колбэк затрёт файл (обычно тем же содержимым, но это лишний I/O и риск частичной записи).

**Какие реальные баги уже может вызывать.**
- **Двойной/тройной запуск video-стадии** для одной сцены и повторные авто-слайды окна → лишние GPU-задачи, «дёрганый» прогресс, гонки на video-merge.
- **Дрейф quota-счётчиков** (через повторный `markDispatchCompleted`), см. C1.
- При `totalIUs === 0` (PG пуст/недоступен) завершение триггерится **всегда** (`:102-111`) — то есть на каждый IU-колбэк, что многократно усиливает эффект.

**Корень.** Завершение сцены вычисляется из изменчивого состояния файловой системы вместо атомарного признака в Redis/PG, а транспортный слой колбэков не защищён от повторов.

---

## M1 — Medium: неатомарный read-modify-write per-asset state (потеря обновления)

**Где:** `state/scene-state.js:392-431` (`setAssetState`, `setAssetStates`).

**Описание.**
Per-asset state (канон, см. System Map §7.1) хранится как **один JSON в одном Redis-ключе** `animastor:asset-state:<scene>` со всеми тремя ассетами сразу. Обновление одного ассета делается так:
```js
const current = await getAssetStates(...);   // GET
const updated = { ...current, [asset]: status };
await redis.set(key, JSON.stringify(updated)); // SET
```
Это классический неатомарный read-modify-write без WATCH/Lua/optimistic-lock.

**Почему это проблема.**
Audio и image диспатчатся и завершаются **параллельно и независимо** (это сознательное решение v2.1.0). Значит два колбэка одновременно делают RMW над одним ключом:
- audio-callback читает `{audio:generating, image:generating}`, ставит `audio:ready`;
- image-callback в тот же момент читает то же `{audio:generating, image:generating}`, ставит `image:ready`;
- кто записал последним — затирает чужое обновление → один из `ready` теряется.

**Какие реальные баги уже может вызывать.**
- **Потерянный `ready`.** Сцена, у которой и audio, и image готовы, по Redis остаётся в `generating` по одному из ассетов → видео-стадия не стартует (ждёт `image=ready`), либо `allDone` никогда не наступает → сцена «висит» в активном индексе и крутится в тиках.
- Симметрично может потеряться переход в `dirty`, выставленный version-staleness-логикой планировщика (`runtime-scheduler.js:277-285`), которая тоже зовёт `setAssetState` — тогда регенерация не произойдёт.
- Вероятность невелика на 1-2 сценах, но растёт с числом одновременно активных сцен (окно WINDOW_SIZE=3 + параллельные стадии).

**Корень.** Несколько писателей одного составного ключа без атомарности. Для одного Redis-инстанса лечится Lua-скриптом или хранением ассетов в разных полях hash с `HSET` (поле-атомарно).

---

## M2 — Medium: неатомарный check-then-increment в quota

**Где:** `runtime/dispatch-engine.js:263-279` (`checkQuota` + `acquireQuota`).

**Описание.**
```js
async function acquireQuota(redis, stage) {
    const result = await checkQuota(redis, stage); // GET + сравнение
    if (result.exceeded) return { acquired: false, ... };
    await incrementActiveCounter(redis, stage);     // INCR
    return { acquired: true, ... };
}
```
Между `checkQuota` (GET) и `incrementActiveCounter` (INCR) нет атомарности. Хотя сам тик защищён `SCHEDULER_TICK_LOCK` (single-flight), `dispatchStage` вызывается ещё и из **колбэков** (`scene-callbacks.js`), **task-handler**, **book-routes** (force-regen) и **reconciliation-engine** — то есть вне тик-лока и параллельно тику.

**Почему это проблема.**
Два конкурентных диспатча одной стадии могут оба пройти `checkQuota` (оба видят `current < max`), затем оба сделать INCR → реальное число активных задач превышает квоту. Для video с `maxActiveVideo=1` это особенно чувствительно: два видео-merge параллельно конкурируют за ffmpeg и за один и тот же выходной файл.

**Какие реальные баги уже может вызывать.**
- Кратковременное превышение лимита GPU (вместе с C1 даёт устойчивое превышение).
- Параллельный video-dispatch на одну сцену при гонке force-regen и планового тика.

**Корень.** Проверка и резервирование слота — две операции вместо одной атомарной (`INCR` затем сравнение, либо Lua). Менее критично, чем C1/M1, т.к. часто прикрыто tick-локом и лизами, но дыра реальна на внетиковых путях.

---

## M3 — Medium: диск как источник истины переопределяет намерение пользователя

**Где:** `runtime/scene-window.js` (`getSceneFilesStatus:118`, `checkSceneContentCache:155`, `restoreChunkStatusForScene:251`), `services/startup-recovery.js:131` (`recoverIuImagesFromDisk`).

**Описание.**
Несколько путей делают выводы о готовности ассета по **наличию файла на диске**:
- `checkSceneContentCache` / `getSceneFilesStatus` — если на диске есть `*.mp3/*.png/*.mp4`, сцена считается имеющей контент и GPU-стадия может быть пропущена;
- `restoreChunkStatusForScene` — переписывает chunk-статусы `pending → ready`, если файлы найдены (`:486,509-532`);
- `recoverIuImagesFromDisk` на старте проставляет image-готовность по найденным PNG.

Это **четвёртый** независимый «писатель/решатель» состояния (помимо Redis per-asset, PG, dispatch-lease). System Map §9 уже отмечает это как «размывание источника истины».

**Почему это проблема.**
Файл на диске — это артефакт *прошлой* генерации, а не текущего намерения. После того как пользователь запросил force-regen и dirty-система выставила `pending/dirty`, disk-based проверка может «увидеть» старый файл и вернуть `ready`, отменив регенерацию. Старые файлы при этом физически могут быть не удалены (нет гарантии очистки `data/output/<oldBuildId>/`).

**Какие реальные баги уже может вызывать.**
- **Force-regen «не срабатывает»**: пользователь меняет промпт/текст, жмёт перегенерировать, но видит старую картинку/аудио, т.к. disk-check восстановил `ready` по старому файлу.
- **Старый buildId**: если проверка не привязана строго к актуальному `buildId`, восстанавливается ассет от предыдущей сборки.
- На старте `recoverIuImagesFromDisk` может «оживить» сцены, которые пользователь успел отменить до рестарта.

**Корень.** Файлы используются и как артефакт, и как сигнал состояния. Решение о готовности должно приниматься по версии (scene_hash/version) + явному статусу, а диск — только подтверждать наличие байтов, не диктовать lifecycle.

---

## M4 — Medium: две параллельные системы лимитов конкурентности, одна — мёртвая

**Где:** `runtime/runtime-scheduler.js:72-148` vs `runtime/dispatch-engine.js:49-54,263-288`.

**Описание.**
Лимиты «сколько стадий гнать одновременно» заданы **дважды**:
1. В `dispatch-engine`: `QUOTAS` (audio 3 / image 2 / video 1) + счётчики `animastor:runtime:active-*`. Это **реально работающая** backpressure.
2. В `runtime-scheduler`: константы `MAX_CONCURRENT_AUDIO/IMAGE/VIDEO`, ключи `animastor:concurrent-{audio,image,video}`, функции `incrementConcurrent / decrementConcurrent / canScheduleStage / getCountInState`. Значения совпадают (3/2/1), но эти счётчики **нигде в живом пути не инкрементируются/декрементируются** — `attemptDispatch` их не трогает, а `canScheduleStage` не вызывается перед диспатчем.

То есть `MAX_CONCURRENT_*` и `animastor:concurrent-*` — это **второй, мёртвый** механизм лимитов, дублирующий имена и смысл первого.

**Почему это проблема.**
- Две «истины» о лимитах: при изменении квоты легко поправить мёртвую константу `MAX_CONCURRENT_IMAGE` и решить, что лимит изменён, — а реально работает `QUOTAS` в другом файле.
- `getMetrics` планировщика (`:430-449`) рапортует `concurrent: {audio,image,video}` из мёртвых счётчиков — то есть диагностика показывает всегда 0/постоянный мусор, вводя в заблуждение при отладке «почему висит».

**Какие реальные баги уже может вызывать.**
- Неверные метрики конкурентности в debug-эндпоинтах (всегда нули) → ложные выводы при разборе зависаний.
- Риск регресса: правка не того лимита.

**Корень.** Лимиты переехали из scheduler в dispatch-engine, но старый аппарат не удалён. Низкий риск рантайм-бага, но прямой источник путаницы.

---

## M5 — Medium: несколько центров записи состояния сцены (4+ writers)

**Где:** `orchestration/scene-callbacks.js`, `runtime/scene-window.js`, `services/startup-recovery.js`, `runtime/reconciliation-engine.js`, `runtime/dispatch-engine.js` (lease).

**Описание.**
Состояние одной сцены меняют независимо как минимум:
1. **scene-callbacks** — `setAssetState(...READY)` на завершении (канон Redis).
2. **scene-window** — `restoreChunkStatusForScene` / `checkSceneContentCache` правят chunk- и asset-статусы по диску (M3).
3. **startup-recovery** — на старте ставит готовность по файлам.
4. **reconciliation-engine** — `applyFix` умеет перезаписывать состояние (сейчас по ручному эндпоинту, System Map §7.2).
5. **dispatch-engine** — lease может заблокировать/разблокировать повторный диспатч (force-regen).

Плюс linear-state (`syncLinearState`/`deriveLinearState`) как производная проекция и PG `scene_assets` как отдельный (фактически рассинхронизированный, см. C2) слой.

**Почему это проблема.**
Нет единого «владельца» перехода состояния сцены. Любые двое из перечисленных могут принять противоречивые решения в одном окне времени:
- callback ставит `ready`, а параллельный version-staleness в планировщике — `dirty`;
- recovery на старте «оживляет» то, что dispatch-lease считает уже отменённым.
Порядок применения недетерминирован (зависит от тайминга тиков, колбэков, рестарта).

**Какие реальные баги уже может вызывать.**
- Мерцание состояния сцены между `ready`/`dirty`/`pending` в логах (видно по обилию RX/SYNC-логов в `scene-state.js`).
- Сцена то попадает, то выпадает из активного индекса → лишние или пропущенные диспатчи.
- Трудновоспроизводимые «залипания» — классический симптом нескольких писателей без единого арбитра.

**Корень.** Историческое «лечение симптомов» добавляло по писателю на каждый наблюдавшийся сбой. Команда это осознаёт (R1.2/R1.3 уже свернули часть), но writer-ов всё ещё несколько. Цель — один арбитр перехода (планировщик), остальные только поставляют факты.

---

## L1 — Low: половина модулей `runtime/` — debug-only, часть ссылается на несуществующие файлы

**Где:** `runtime/` (36 модулей), `api/runtime.js` (debug-эндпоинты).

**Описание.**
Проверка достижимости из боевого пути: **18 модулей LIVE, 18 — DEBUG-ONLY** (грузятся только из `api/runtime.js`, т.е. debug-эндпоинты, либо ссылаются только друг на друга).

DEBUG-ONLY: `adaptation-controller`, `cost-estimator`, `decision-trace`, `execution-semantics`, `failure-replay`, `feedback-config`, `feedback-engine`, `feedback-recorder`, `governance-health`, `governance-metrics`, `governance-sandbox`, `governance-stability`, `governance-validator`, `policy-engine`, `policy-simulator`, `priority-manager`, `snapshot-manager`, `workload-classifier`.

Хуже: `execution-semantics`, `failure-replay`, `governance-health`, `governance-validator`, `policy-engine` **require несуществующие модули** (`state-graph/`, `trace-compactor`, `invariant-engine`, `safe-mode`, `admission-control`, `policies/`). Падения нет только потому, что эти ветки не вызываются.

**Почему это проблема.**
- ~50% самого «умного» с виду каталога — мёртвый груз. При онбординге читается как работающая governance-система, хотя в проде живут только `circuit-breaker`, `retry-budget`, `fairness`.
- Битые `require` — мина: достаточно случайно дёрнуть debug-эндпоинт, чтобы получить runtime-crash модуля.

**Какие реальные баги уже может вызывать.**
- 500 на debug-эндпоинтах, ссылающихся на сломанные модули.
- Потеря времени на отладку «governance», который не участвует в решениях.

**Корень.** Незавершённый Phase 6 cleanup. Уточняет System Map §7.3 числом: мёртвых модулей ровно половина.

---

## L2 — Low: массовые inline `require()` внутри функций

**Где:** `orchestration/scene-callbacks.js` (8+ inline-require), `task-handler.cjs`, и др.

**Описание.**
Зависимости подтягиваются не в шапке модуля, а внутри тел функций: `require('../runtime/dispatch-engine')`, `require('../runtime/scene-window')`, `require('../storage/postgres/repositories/scene-assets-repo')` — повторяются в нескольких функциях одного файла.

**Почему это проблема.**
- Inline-require обычно появляются как **обход циклических зависимостей** (`scene-callbacks` ↔ `scene-window` ↔ `runtime-scheduler`). Цикл никуда не делся, он просто спрятан — это скрытая связанность.
- Граф зависимостей нельзя увидеть по шапке файла → труднее рассуждать о том, что на что влияет.
- Чуть дороже на каждом вызове (хоть и кэшируется), но главное — маскирует архитектурную проблему.

**Какие реальные баги уже может вызывать.**
- При рефакторинге легко получить частично инициализированный модуль (cycle) с `undefined`-экспортом, проявляющийся только в рантайме на конкретной ветке.

**Корень.** Циклические зависимости между orchestration/runtime/storage, обойдённые lazy-require вместо развязки интерфейсом.

---

## L3 — Low: dual state model + `syncLinearState` после каждого изменения

**Где:** `state/scene-state.js:159-212` (`transitionSceneState`, `syncLinearState`, `deriveLinearState`).

**Описание.**
Канон — per-asset states. Но параллельно поддерживается **линейное** `SceneState` (`AUDIO_PENDING`...`VIDEO_READY`) как производная проекция: его читают плеер и debug-эндпоинты. После изменений per-asset вызывается `syncLinearState` (двунаправленный маппинг `deriveLinearState` ⇄ `deriveAssetStatesFromLinear`). `transitionSceneState` пишет линейное состояние **без валидации и без локов** (FSM-проверки удалены в v2.1.0).

**Почему это проблема.**
- Два представления одного состояния, которые надо держать согласованными вручную. `deriveLinearState` для параллельных стадий схлопывает реально-параллельное состояние (audio+image идут одновременно) в один линейный ярлык — проекция теряет информацию и может вводить плеер в заблуждение (например, image готов, но линейно показано `AUDIO_GENERATING`).
- `syncLinearState` страдает от той же неатомарности RMW, что и M1 (читает per-asset, пишет linear) — окно рассинхрона между двумя ключами.

**Какие реальные баги уже может вызывать.**
- Плеер/диагностика показывают «отстающее» или некорректное линейное состояние, хотя ассеты уже частично готовы.
- Лишний слой, который надо обновлять при каждом изменении — забытый `syncLinearState` ⇒ устаревший линейный статус.

**Корень.** Переходный слой совместимости со старыми потребителями (плеер/debug). Помечен в System Map §7.1 как осознанный временный компромисс; зафиксирован здесь как источник рассинхрона и сопроводительной сложности.

---

## Связи между проблемами (как они усиливают друг друга)

Проблемы не изолированы — они образуют один узел вокруг **расходящегося состояния генерации**:

- **C3 → C2.** Два одноимённых registry привели к тому, что боевой путь пишет только Redis, а PG-ready не пишется вовсе.
- **C2 + M3.** PG не знает про ready, а диск трактуется как истина → планировщик и восстановление принимают решения по двум разным «полуправдам». Отсюда «почему оно опять всё генерирует» и «почему force-regen не сработал».
- **C4 → C1.** Неидемпотентный колбэк дублирует `markDispatchCompleted`, что удваивает release квоты; C1 и сам по себе уже даёт двойной release. Вместе они систематически ломают backpressure.
- **C1 + M2.** Один путь занижает счётчик (двойной decr), другой допускает перебор (check-then-incr). Счётчик перестаёт отражать реальность в обе стороны → `counter-reconciliation` вынужден существовать в проде.
- **M1 + M5 + L3.** Несколько писателей + неатомарный RMW + дублирующая линейная проекция = трудновоспроизводимые «залипания» и мерцание состояния сцены.

Главный архитектурный диагноз для проекта на малое число пользователей: **система пытается быть распределённой (лизы, квоты, governance, reconciliation, multi-writer recovery) там, где хватило бы одного арбитра и одного источника истины.** Сложность здесь работает против надёжности.

## Что бьёт первым (без подробного плана — это следующий этап)

1. **C2/C3** — починить запись PG-ready и развести два registry: убирает «двойную истину» в корне.
2. **C1/C4** — один владелец release квоты + идемпотентность `/gpu/task/result`: чинит backpressure и двойные завершения.
3. **M1/M2** — атомарность Redis-операций состояния и квот.
4. **M3/M5** — свести писателей состояния к одному арбитру; диск только подтверждает байты.
5. **L1/L2/L3** — снять мёртвый governance, развязать циклы, спланировать вывод линейной проекции.

---

*Конец аудита. Все находки подтверждены чтением исходного кода; ссылки на файлы и строки приведены для проверки.*
