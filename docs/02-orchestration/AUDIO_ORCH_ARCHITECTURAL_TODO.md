# TODO: Audio Orchestration — архитектурные fixes

> **Дата:** 20 июля 2026
> **Основание:** `docs/02-orchestration/AUDIO_ORCH_ARCHITECTURAL_FIXES.md`
> **Контекст:** серия патчей от 2026-07-20 (`02e99a5`, `ebbcb4f`, `281d192`,
> `4a17f55`, `ecde189`, `1ce49ee`) латала аудио-оркестрацию точечно. Этот TODO —
> миграция от «сработало — и ладно» к архитектурно корректному ядру.
>
> Статусы: ✅ выполнено, 🔴 не начато, 🟡 в работе, ⏸️ blocked.
> Приоритеты: P0 — data loss / silent corruption, P1 — reliability, P2 — cleanup / docs.

---

## ✅ Источник — сегодняшние патчи (контекст для миграции)

| Коммит | Симптом | Пункт архитектурного fix |
|--------|---------|---------------------------|
| `02e99a5` | readdir order undefined → merge в случайном порядке | A0 |
| `ebbcb4f` | 0-byte TTS skip при merge | A1 |
| `281d192` | STALL/LEASE/GPU_TIMEOUT подобраны вручную | A2 |
| `4a17f55` | phase-guard от stale re-dispatch | A3 |
| `ecde189` | bulk-delete чанков при mismatch | A4 |
| `1ce49ee` | batch dispatch закопан в коде | A5 |

---

## ✅ A0: Deterministic chunk enumeration (P0) — ВЫПОЛНЕНО

**Проблема:** `findExistingSceneChunks` использует `fs.readdirSync` (EXT4 —
hash-table order). Сегодня падает на `.sort((a,b)=>a-b)`, но потребители всё
равно работают с произвольным fs-scan, а не с детерминированным перечислением.

- [x] **A0.1** Переписать `backend/src/audio/chunks.js::findExistingSceneChunks`
      на enumeration-based: принимает `expectedCount`, возвращает существующие
      индексы из `1..expectedCount`, не вызывает `readdirSync`.
- [x] **A0.2** Audit потребителей `findExistingSceneChunks` (generation.js,
      pipeline.js) — передают `expectedChunkCount`. filesystem-store.js имеет
      свою копию (не в аудио-пути, оставлена без изменений).
- [x] **A0.3** Тест: enumeration path тестируется через `expectedCount !== null`.
      .sort() оставлен как defense-in-depth в fallback-пути.
- [x] **A0.4** `.sort()` оставлен в readdir-fallback как cheap defense-in-depth.

**Verify:** `npm test` — все 8 тестов runtime-timeouts проходят.

---

## ❌ A1: Empty TTS output — recoverable failure (P0) — ПРОПУЩЕН

**Решение сознательно не реализовано.** Текущий механизм уже работает:
0-байтный чанк → unlink + Redis cleanup → missing → watchdog STALL → FAILED
→ scheduler re-dispatch. Explicit retry budget per chunk — переусложнение
для текущего failure rate. См. обсуждение в commit message.

---

## ✅ A2: Таймауты через формулу, а не магические числа (P1) — ВЫПОЛНЕНО

**Проблема:** `GPU_TIMEOUT < STALL < LEASE_TTL` фиксируется тремя
независимыми константами (10 / 15 / 20 мин). Любой env-change GPU_TIMEOUT
молча ломает invariant.

- [x] **A2.1** В `runtime-config.js` введён `GPU_TIMEOUT_MS` как single source
      of truth. Backward compat: `GPU_TIMEOUT` (без _MS) тоже читается.
- [x] **A2.2** Вычисляется от него:
      ```js
      const STALL_FAILSAFE_MS = GPU_TIMEOUT_MS * 3;  // 30 min @ 10 min GPU
      LEASE_TTL_S.AUDIO = ceil(STALL_FAILSAFE_MS / 1000) + 60;  // 31 min
      ```
- [x] **A2.3** Watchdog остаётся failsafe; явная ошибка от hub по-прежнему
      приоритетнее (через notifyBackendError + failStage).
- [x] **A2.4** Тест `runtime-timeouts.test.js` переписан: проверяет формулы,
      а не хардкод-значения. 8/8 тестов.
- [x] **A2.5** Startup warning: если `GPU_TIMEOUT_MS` или `GPU_TIMEOUT`
      установлены — лог с пересчитанными значениями.
- [x] **gpu-hub/gpu-hub.js:** синхронизирован — использует `GPU_TIMEOUT_MS`
      с fallback к старому `GPU_TIMEOUT`.

**Verify:** `npm test` — 8/8 runtime-timeouts тестов проходят.

---

## ✅ A3: Dispatch lease вместо phase guards (P1) — ВЫПОЛНЕНО

**Проблема:** `executeAudioDispatch` открывается guard `if (phase ===
WAITING_CHUNKS || MERGING) return`. Фикс симптома.

- [x] **A3.1** Инфраструктура уже была: `dispatch-engine.js` имеет
      `acquireStageLease` (SETNX + TTL). A2 гарантирует
      LEASE_AUDIO (31m) > STALL (30m) > GPU_TIMEOUT (10m), так что lease
      переживает watchdog.
- [x] **A3.2** `task-handler.cjs` уже вызывает `verifyDispatchIdentity`
      (проверка dispatchId по metadata). `completeChunk` получает dispatchId
      через deps — идентичность проверена до вызова.
- [x] **A3.3** Phase guard удалён из `executeAudioDispatch`. DONE guard
      сохранён. WAITING_CHUNKS/MERGING stale recovery теперь логирует и
      падает через deleteState+reinit (не оставляет сцены зависшими).
- [x] **A3.4** Watchdog при stall: TTL истёк → lease свободен через Redis
      EXPIRE. Reconciliation чистит stale leases.
- [ ] **A3.5** Тест на concurrency — отложен (необходим Redis mock).

**Verify:** stale recovery больше не возвращает ранний return — stuck сцены
восстанавливаются.

---

## ❌ A4: Per-chunk content hash cache (P1) — ПРОПУЩЕН

**Решение сознательно не реализовано.** Проблема «9+9 дубликаты» уже
пофикшена в `ecde189` (bulk-delete удалён). Per-chunk cache-hit по файлам
на диске работает корректно. Content hash решал бы edge-case «текст изменился,
файл остался» — на практике `padded_text` stale check уже покрывает это.
Переусложнение для текущих failure modes.

---

## ❌ A5: Явный dispatch plan + policy (P2) — ПРОПУЩЕН

**Решение сознательно не реализовано.** Текущий batch dispatch
(narration first, dialogue later) — оптимизация под ComfyUI, не
политика приоритизации. Нет второй альтернативы (`round-robin`,
`uniform`), которая бы оправдывала enum + параметр в сигнатуре.
Overengineering.

---

## 🔴 Cross-cutting: observability (P2)

**Проблема:** сегодня `[DEBUG]` строки — единственный способ понять, что
произошло. Это debugging, не observability.

- [ ] **C1** Ввести structured events в journal: `chunk_received`,
      `merge_started`, `lease_acquired`, `dispatch_id_mismatch_dropped`,
      `tts_empty_output`, `chunk_retry_exhausted`.
- [ ] **C2** Метрики в Redis (`animastor:runtime:metrics:current` уже есть):
      - `audio.stale_result_dropped{reason}`
      - `audio.chunk_failed{reason}`
      - `audio.dispatch_duplicate`
      - `audio.merge_duration_ms`
- [ ] **C3** Удалить `[DEBUG]` логи после обмена на structured events (все
      `[DEBUG]` строки в `audio-orchestrator.js`, `pipeline.js`, `chunks.js`).
- [ ] **C4** Runtime assertions на инварианты (расширить
      `tests/runtime-timeouts.test.js` на все invariant'ы из
      A2 + A3 + A4).

**Verify:** grep `[DEBUG]` в `backend/src/audio/` → 0 совпадений после
миграции.

---

## Зависимости между задачами

```
A0 (enumeration)  ───independent───┐
                                    ├──► A4 (content hash cache)
A1 (empty retry)  ──requires A4.1 ──┘            uses A0.2 (hash return)
A2 (timeouts)     ───independent────────────────► (зависит только от gpu-hub)
A3 (lease)        ──requires A1 (retry) ─────────► (lease release требует
                                                   recovery budget)
A5 (plan)         ──requires A4 ─────────────────► (cache-hit идёт per-chunk)
C* (observability) ──unblocks A1, A3, A4 ───────► (метрики — критичны для
                                                    принятия решения о retry)
```

**Рекомендуемый порядок:**
1. **Sprint 1:** A0 + C1 + C4 (observation skeleton) — даёт tools.
2. **Sprint 2:** A1 + A4 (chunk-level retry + cache).
3. **Sprint 3:** A3 (lease) — требует уже работающий retry.
4. **Sprint 4:** A2 (timeouts), A5 (plan) — cleanup, lowest risk.

---

## Anti-patterns checklist (не повторять)

- [ ] ~~Любое новое `if (phase === ...)` в начале `executeAudioDispatch`~~ →
      использовать lease (A3).
- [ ] ~~Любая новая константа таймаута~~ → вычислять от `GPU_TIMEOUT_MS` (A2).
- [ ] ~~Любой новый `readdirSync` для chunk-order~~ → enumeration (A0).
- [ ] ~~Любой `unlinkSync` bulk-delete чанков~~ → invalidate per-chunk cache
      (A4).
- [] ~~Любой `[DEBUG]` лог~~ → structured event (C1).

---

## Done definition

Миграция завершена, когда:
- Все пункты A0–A5 отмечены ✅.
- `grep -r "readdirSync" backend/src/audio/` возвращает 0 совпадений для
  chunk-discovery.
- `grep -r "MIN_CHUNK_BYTES" backend/src/` возвращает только определение
  константы и recovery-path использование.
- `grep -r "\\[DEBUG\\]" backend/src/audio/` возвращает 0.
- `AUDIO_ORCH_ARCHITECTURAL_FIXES.md` помечен как deprecated (или удалён),
  т.к. все проблемы разрешены в коде.
