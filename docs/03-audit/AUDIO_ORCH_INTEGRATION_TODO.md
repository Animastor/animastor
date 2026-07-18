# TODO: Завершение интеграции аудио-оркестрации (устранение костыля 8/9)

**Дата:** 2026-07-18
**Основание:**
- `docs/03-audit/AUDIO_8_9_RACE_CONDITION.md` — баг 8/9 «исправлен» подкруткой таймаутов (костыль)
- `docs/02-orchestration/AUDIO_ORCHESTRATOR.md` — миграция помечена ✅, но фактическая интеграция неполна
- `docs/03-audit/ORCHESTRATION_CONSOLIDATION_AUDIT.md` К1/R2 — «втянуть аудио-машину в оркестр»

---

## Диагноз: что на самом деле не так

### Д1. Retry-таймер — это НЕ оркестрация, это гонка со временем

`audio-orchestrator.js:completeChunk` при неполном наборе чанков заводит
in-process `setTimeout`-цепочку с фиксированным бюджетом
(`AUDIO_MERGE_RETRY_MAX × AUDIO_MERGE_RETRY_DELAY_MS`). Фикс из
`AUDIO_8_9_RACE_CONDITION.md` лишь увеличил бюджет 75с → 300с. Костыль остался:

1. **Fail по таймеру вместо fail по событию.** Чанки продолжают успешно
   генерироваться, а машина объявляет FAILED, потому что «время вышло».
   При медленном воркере / большем числе чанков / очереди из нескольких сцен
   бюджет снова исчерпается — баг вернётся с другими числами
   (сам документ признаёт это в «Уроках», п.1).
2. **Таймер вообще не нужен для happy path.** Каждый чанк, прибывая, вызывает
   `completeChunk` → проверку комплектности. Приход последнего чанка сам
   триггерит merge. Retry-таймер нужен только как страховка от «чанки
   ПЕРЕСТАЛИ приходить» — а это уже покрыто существующими механизмами:
   - gpu-hub watchdog: воркер молчит 10 мин → `POST /gpu/task/error` →
     `failStage` (T3);
   - dispatch lease TTL (15 мин audio) → reconciliation/scheduler;
   - `/gpu/task/error` при ошибке воркера → `failStage`.
3. **In-process setTimeout теряется при рестарте** — ещё один канал
   рассинхрона, который уже потребовал recovery-костыль (C1).
4. **FAILED от таймера дёргает `orchestrator.failStage` → re-dispatch всей
   сцены**, пока хвост чанков ещё в полёте → `cancelActiveDispatch` → hub 409
   на живые результаты → цикл 8/9. Подкрутка таймаутов отодвинула порог,
   не устранив механизм.

### Д2. Watchdog «чанки перестали приходить» отсутствует как класс

Единственный сценарий, который retry-таймер реально должен ловить: воркер жив
(heartbeat идёт), но конкретный чанк потерян (например, hub принял job, но
результат не дошёл и не попал в `animastor:result:*`). Для него нужен
**event-based staleness check** (нет новых чанков N минут), а не счётчик
попыток. Место такого чека — reconciliation-цикл (T6, раз в 60с), а не
setTimeout в обработчике колбэка.

### Д3. `chunks_received` / `last_chunk_at` не ведутся

В Redis-ключе audio-orch поле `chunks_received` объявлено, но никогда не
обновляется. Из-за этого невозможно отличить «прогресс идёт» от «прогресс
встал» — что и вынудило фиксированный таймер.

### Д4. Debug-логи `[DEBUG-*]` остались в проде

4 файла (`scene-orchestrator.js`, `generation.js`, `task-handler.cjs`,
`audio-orchestrator.js`) захламлены диагностическими `console.log` от слепого
поиска бага 8/9.

### Д5. Документация лжёт

`AUDIO_ORCHESTRATOR.md` описывает retry-политику как рабочую схему и помечает
миграцию ✅, хотя «Уроки» `AUDIO_8_9_RACE_CONDITION.md` прямо говорят, что
схема негодная. `AUDIO_8_9_RACE_CONDITION.md` помечен «Исправлено», хотя
исправлена только константа.

---

## План

### T-A1. Убрать retry-таймер из `completeChunk` — merge только по событию ✅

`services/audio-orchestrator.js`:

- [x] `completeChunk` при неполном наборе чанков: обновить
  `chunks_received` + `last_chunk_at` в audio-orch state и **выйти**
  (следующий чанк сам вызовет следующий чек). Никаких setTimeout,
  никаких счётчиков попыток, никакого `failStage` отсюда.
- [x] Удалить ключи `animastor:audio-merge-retry:*` (dedup + counter) из кода.
- [x] Ветку «MAX RETRIES EXCEEDED» (очистка hub-dedup, сброс chunk-metadata,
  `setFailed` + `failStage`) перенести в новую функцию
  `failWaitingScene(redis, ..., reason, deps)` — единственный владелец
  перевода WAITING_CHUNKS → FAILED. Вызывается только из watchdog (T-A2)
  и recovery.
- [x] `getChunk`-проверка в retry-callback уходит вместе с таймером.

### T-A2. Watchdog застоя чанков в reconciliation-цикле ✅

`runtime/reconciliation-engine.js` (периодический прогон каждые 60с,
`RECONCILE_INTERVAL_MS`), новая фаза B1 `checkStalledAudioScenes`:

- [x] `scanAllStates` → для phase=WAITING_CHUNKS: если
  `now - max(last_chunk_at, started_at) > TIMEOUTS.AUDIO_CHUNK_STALL_MS`
  и комплект неполон → `audioOrch.failWaitingScene(...)` → FAILED +
  `orchestrator.failStage` → PENDING → scheduler передиспатчит.
  Если комплект полон (пропущенный последний колбэк) → доиграть merge
  через `completeChunk`-путь.
- [x] Фаза работает и в periodic, и в startup прогоне.
- [x] Событие в журнал через `failStage` (AUDIO_FAILED) — контракт
  наблюдаемости сохраняется.

### T-A3. Конфиг: заменить retry-константы на stall-порог ✅

`config/runtime-config.js`:

- [x] Удалить `AUDIO_MERGE_RETRY_DELAY_MS`, `AUDIO_MERGE_RETRY_MAX`,
  `AUDIO_MERGE_RETRY_DEDUP_TTL_S`, `AUDIO_MERGE_RETRY_COUNTER_TTL_S`.
- [x] Добавить `AUDIO_CHUNK_STALL_MS` (5 мин: > gpu-hub GPU_TIMEOUT нет
  нужды — hub сам failит мёртвого воркера за 10 мин; stall-порог ловит
  только «воркер жив, чанк потерян», где 5 мин без ЕДИНОГО нового чанка —
  надёжный сигнал).
- [x] Инварианты: `AUDIO_CHUNK_STALL_MS < LEASE_TTL_S.AUDIO × 1000`
  (watchdog срабатывает раньше lease-протухания). Обновить
  `tests/runtime-timeouts.test.js`.

### T-A4. Вести `chunks_received` / `last_chunk_at` ✅

- [x] `completeChunk`: при каждом принятом чанке писать в audio-orch state
  фактический `chunks_received` (по числу файлов на диске — надёжно к
  дубликатам) и `last_chunk_at = Date.now()`.

### T-A5. Снять debug-логи `[DEBUG-*]` ✅

- [x] `orchestration/scene-orchestrator.js` — `[DEBUG-DISPATCH]`
- [x] `audio/generation.js` — `[DEBUG-AUDIO]`
- [x] `services/task-handler.cjs` — `[DEBUG-RESULT]`
- [x] `services/audio-orchestrator.js` — `[DEBUG-CHUNK]`
  (оставить обычные `log()`-строки уровня оркестрации)

### T-A6. Тесты ✅

- [x] `tests/audio-orchestrator.test.js`: completeChunk — приём неполного
  набора обновляет chunks_received/last_chunk_at и НЕ планирует таймер;
  приход последнего чанка → MERGING → DONE → completeStage;
  failWaitingScene → FAILED + failStage + очистка hub-dedup.
- [x] `tests/reconciliation-engine.test.js`: stalled-scene watchdog —
  застой → failWaitingScene; полный комплект при пропущенном колбэке →
  merge; свежий прогресс → не трогаем.
- [x] `tests/runtime-timeouts.test.js`: заменить retry-инварианты на
  stall-инвариант.
- [x] Полный прогон `npm test`.

### T-A7. Документация ✅

- [x] `AUDIO_ORCHESTRATOR.md`: секция Retry-логика переписана на
  event-driven модель + watchdog; таблица переходов — владелец
  WAITING_CHUNKS → FAILED теперь reconciliation watchdog.
- [x] `AUDIO_8_9_RACE_CONDITION.md`: статус «Исправлено» → «Костыль заменён
  оркестрацией», ссылка на этот TODO.
- [x] `docs/CHANGELOG.md` — запись.

---

## Что НЕ делаем (зафиксировано)

- Не переносим audio-orch фазы в asset-state HSET (T7.2 «максимум» из
  консолидации) — отдельная задача.
- Не трогаем плеер и frontend (`DONT_DO.md`).
- Не меняем gpu-hub watchdog / lease TTL — их цепочка согласована и покрыта
  инвариантами.
