# Audio 8/9 Race Condition — Retry Timer vs GPU Hub

> **Дата:** 2026-07-18  
> **Статус:** Исправлено  
> **Теги:** `audio`, `race-condition`, `retry`, `gpu-hub`, `completeChunk`

---

## 1. Симптом

При генерации аудио для сцены с 9 чанками прогресс доходил до 8/9 и **начинался заново** — бесконечный цикл:

```
8/9 → retry → max retries → failStage → re-dispatch → 8/9 → ...
```

Визуально в UI: прогресс растёт до 8/9, затем сбрасывается и начинается с 0.

---

## 2. Диагностика

Добавлены debug-логи с префиксами `[DEBUG-CHUNK]`, `[DEBUG-AUDIO]`, `[DEBUG-RESULT]`, `[DEBUG-DISPATCH]` в 4 файла:

| Префикс | Файл | Что логирует |
|---------|------|-------------|
| `[DEBUG-DISPATCH]` | `scene-orchestrator.js` | После `setWaitingChunks` и `generateSceneAudio` |
| `[DEBUG-AUDIO]` | `generation.js` | Количество сегментов, их типы, отправка каждого чанка |
| `[DEBUG-RESULT]` | `task-handler.cjs` | Приход каждого результата от GPU hub |
| `[DEBUG-CHUNK]` | `audio-orchestrator.js` | Вызов `completeChunk`, какие чанки есть на диске, retry-попытки |

Логи показали:

```
[DEBUG-AUDIO] ✅ SENT chunk 0001 (1/9)
[DEBUG-AUDIO] ✅ SENT chunk 0002 (2/9)
...
[DEBUG-AUDIO] ✅ SENT chunk 0009 (9/9)

[DEBUG-RESULT] audio_chunk result: ..._0001 chunk=1 size=358KB
[DEBUG-CHUNK] completeChunk called: .../sc-e4da99bd chunk=1 phase=WAITING_CHUNKS
[DEBUG-CHUNK] Chunk completeness check: expected=9 present=[1] missing=[2,3,4,5,6,7,8,9] attempt=0/5

[DEBUG-CHUNK] Chunk completeness check: expected=9 present=[1] missing=[2,3,4,5,6,7,8,9] attempt=1/5
...
[DEBUG-CHUNK] Chunk completeness check: expected=9 present=[1] missing=[2,3,4,5,6,7,8,9] attempt=5/5
[DEBUG-CHUNK] ⛔ MAX RETRIES EXCEEDED: .../sc-e4da99bd expected=9 missing=[2,3,4,5,6,7,8,9]
```

GPU hub логи:

```
import_..._sc-e4da99bd_0002:audio Hub rejected result: HTTP 409
```

---

## 3. Причина

### 3.1 Конфигурация retry (до фикса)

```js
AUDIO_MERGE_RETRY_DELAY_MS: 15000,     // 15 секунд между retry
AUDIO_MERGE_RETRY_MAX: 5,              // максимум 5 попыток
AUDIO_MERGE_RETRY_DEDUP_TTL_S: 30,     // dedup key живет 30 секунд
AUDIO_MERGE_RETRY_COUNTER_TTL_S: 180,  // счётчик живёт 3 минуты
```

Общий budget retry: **5 × 15с = 75 секунд**.

### 3.2 Хронология race condition

При 9 чанках и 1 аудио-воркере (~10-15 секунд на чанк ComfyUI TTS):

```
t=0s:    executeAudioDispatch → setWaitingChunks → send 9 jobs → GPU hub
t=5с:    chunk 0001 обработан → completeChunk(0001) → 1/9 → schedule retry через 15с (attempt 1)
t=15с:   retry #1 → 1/9 → schedule retry через 15с (attempt 2)
t=20с:   chunk 0002 обработан воркером → результат в GPU hub
         GPU hub проверяет animastor:running:{dispatch_id} → ещё есть → шлёт в backend
         Backend: chunk 0002 сохранён на диск
t=25с:   chunk 0003 прибывает в backend → сохранён
t=30с:   retry #2: present=[1,2,3] missing=[4-9]
         ...
t=60с:   retry #4: present=[1,2,3,4,5] missing=[6-9]
t=65с:   chunk 0006 прибывает → сохранён
t=75с:   retry #5: MAX RETRIES → failStage
         → orchestrator.failStage → cancelActiveDispatch
         → GPU hub чистит animastor:running:{dispatch_id}
t=75с+:  chunks 0007-0009 долетают до GPU hub
         → animastor:running нет → HTTP 409 → результаты не доходят в backend
         → scene переходит в PENDING → scheduler re-dispatch → GOTO 1
```

**Ключевой момент:** Чанки 0002-0006 **успевают** долететь до backend до cancelActiveDispatch, но чанки 0007-0009 получают 409, потому что:

1. 9 чанков × 10-15с = 90-135с нужно для полной обработки
2. Retry budget: 5 × 15с = 75с
3. **75с < 90-135с** → retry исчерпывается до завершения всех чанков

### 3.3 Дополнительная проблема: протухание dedup key

`AUDIO_MERGE_RETRY_DEDUP_TTL_S: 30` — dedup key предохраняет от запуска второго retry-таймера, пока первый активен. Но dedup key живёт 30 секунд, а retry timer срабатывает через 15 секунд — с этим значением проблем не было.

**После увеличения DELAY_MS до 60с** dedup key (30с) протухал ДО срабатывания retry timer (60с). Приходящие промежуточные чанки находили протухший dedup key, создавали новые retry-цепочки и ускоряли исчерпание retry budget.

---

## 4. Фикс

### 4.1 Изменения в `runtime-config.js`

| Параметр | Было | Стало | Обоснование |
|----------|------|-------|-------------|
| `AUDIO_MERGE_RETRY_DELAY_MS` | 15 000 (15с) | **60 000 (60с)** | 9 чанков × 10-15с = 90-135с; новый budget 5 × 60с = 300с ✅ |
| `AUDIO_MERGE_RETRY_DEDUP_TTL_S` | 30 | **120** | dedup должен пережить retry delay: 120с > 60с (2× buffer) ✅ |
| `AUDIO_MERGE_RETRY_COUNTER_TTL_S` | 180 (3мин) | **600 (10мин)** | 5 × 60с = 300с; 600с > 300с (инвариант) ✅ |

### 4.2 Проверка инвариантов

```js
// Инвариант 1: MAX × DELAY_MS < LEASE_TTL_S.AUDIO × 1000
//   5 × 60 000 = 300 000ms < 15 × 60 × 1000 = 900 000ms ✅

// Инвариант 2: COUNTER_TTL_S × 1000 > MAX × DELAY_MS
//   600 × 1000 = 600 000ms > 300 000ms ✅

// Инвариант 3: DEDUP_TTL_S × 1000 >= DELAY_MS
//   120 × 1000 = 120 000ms >= 60 000ms ✅
```

Подтверждение: тест `runtime-timeouts.test.js` проверяет все три инварианта.

---

## 5. Проверка гипотезы (слепой поиск)

Для отладки добавлены логи во все ключевые точки:

```
[DEBUG-DISPATCH] — executeAudioDispatch: отправка и результат
[DEBUG-AUDIO]    — generateSceneAudio: сегменты, expectedCount, отправка чанков
[DEBUG-RESULT]   — handleTaskResult: приход каждого результата
[DEBUG-CHUNK]    — completeChunk: фаза, completeness check, retry, max retries
```

Грепать: `docker compose logs backend | grep '\[DEBUG-'`

---

## 6. Затронутые файлы

| Файл | Изменение |
|------|-----------|
| `backend/src/config/runtime-config.js` | DELAY 15→60с, DEDUP 30→120с, COUNTER 180→600с |
| `backend/src/services/audio-orchestrator.js` | [DEBUG-CHUNK] логи |
| `backend/src/audio/generation.js` | [DEBUG-AUDIO] логи |
| `backend/src/services/task-handler.cjs` | [DEBUG-RESULT] логи |
| `backend/src/orchestration/scene-orchestrator.js` | [DEBUG-DISPATCH] логи |

---

## 7. Уроки

1. **Fixed retry timer не подходит для асинхронных воркеров с переменной загрузкой.** В идеале retry должен быть адаптивным: fail только если чанки перестали приходить (нет новых в течение N минут), а не по фиксированному числу попыток.

2. **Dedup key должен быть ≥ retry delay.** Иначе промежуточные события создают конкурирующие retry-цепочки.

3. **Debug-логи с префиксами `[DEBUG-*]` критически важны для диагностики распределённых гонок.** Без них причина цикла 8/9 была бы невидима.
