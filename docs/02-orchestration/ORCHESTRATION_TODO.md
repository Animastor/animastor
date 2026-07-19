# TODO: Система оркестрации — сводный статус

> **Дата:** 19 июля 2026
> **Основание:** `docs/02-orchestration/ORCHESTRATION.md`
> Все исторические TODO сведены в единый список. Выполненные задачи — ✅,
> невыполненные/отложенные — 🔴.

---

## ✅ T0–T10: Core стабилизация — ВСЁ ВЫПОЛНЕНО

| Этап | Статус | Результат |
|------|--------|-----------|
| T0: Worker + syntax-smoke | ✅ | `worker.cjs` проходит `node --check`. `pretest` проверяет все JS/CJS. Версия worker в beacon. |
| T1: Callback result contract | ✅ | `completeStage` проверяет `handler.ok`. Обязательный return format `{ ok, retryable, reason, artifact }`. |
| T2: Один finalization path | ✅ | `failStage` → `finalizeDispatch('failure')` с `recordFailure` + `consumeRetryBudget`. НЕ recordSuccess. |
| T3: Честный executor | ✅ | `execute*Dispatch` возвращает `{ dispatched, jobs, reason }`. Lease/quota освобождаются при `dispatched:false`. |
| T4: dispatchId + stale callback | ✅ | `verifyDispatchIdentity` в каждом колбэке. `dispatch_id` сквозной. |
| T5: Force reset + quota ownership | ✅ | `resetScenes` освобождает только ресурсы сброшенных сцен. |
| T6: Lease renewal | ✅ | Стартует после `dispatched:true`. Останавливается в `finalizeDispatch`. |
| T7: Non-overlapping runtime loop | ✅ | Tick (5s) без reconcile. Reconcile (60s) с distributed lock. |
| T8: Единый владелец asset state | ✅ | Facade `orchestrator.js` — единственный писатель. `unsafe*` методы для restore/debug. |
| T9: GPU Hub contract + auth | ✅ | `x-api-key` пробрасывается во все callers. `GPU_HUB_API_KEY` env. Версия в heartbeat. |
| T10: Проверка worker | ✅ | Syntax-smoke проходит. Версия логируется при старте. |

---

## ✅ S1: Dead-code resilience — ЗАВЕРШЁН

| Подэтап | Статус | Коммит | Эффект |
|---------|--------|--------|--------|
| S1.1: Удалить `fairness-engine.js` | ✅ | `45b2485` | −618 строк |
| S1.2: Сократить `failure-taxonomy.js` + удалить `retry-manager.js` | ✅ | `d4444cb` | −736 строк |
| S1.3: Сократить `retry-budget-manager.js` | ✅ | `dba7298` | −296 строк |
| S1.4: Удалить Phase C3 | ✅ | `10ecf33` | −32 строки |

> **Итого S1:** −1682 строки (план −580). **Перевыполнение.**
> Уточнение: C4/C5 не удалены — они живые (PG deps и resumeIncompleteSessions передаются из `backend.cjs`).
> `retry-budget` не выкинут целиком — `consumeRetryBudget` зашит в production finalization.

---

## ✅ S2: restore/debug state writes — ЗАВЕРШЁН

| Подэтап | Статус |
|---------|--------|
| S2.1: Переименовать `setAssetState` → `unsafeRestoreAssetState` | ✅ |
| S2.2: Изолировать writes внутри фасада | ✅ (упрощено — не вводить `_writeAssetState`, просто фасад) |
| S2.3: Перевести restore/debug callers на `unsafe*` | ✅ (7 файлов, 11 вызовов) |
| S2.4: JSDoc whitelist | ✅ |

---

## ✅ S3: Production-readiness — ЗАВЕРШЁН

| Подэтап | Статус |
|---------|--------|
| S3.1: Graceful shutdown (SIGTERM/SIGINT) в `backend.cjs` | ✅ |
| S3.2: `/health` endpoint (200/503, loop + redis ping) | ✅ |
| S3.3: `/readiness` (опционально) | ⚠️ skipped (достаточно `/health`) |
| S3.4: `GPU_TIMEOUT` env config | ✅ (`.env.example`, docker-compose) |
| S3.5: `GPU_HUB_API_KEY` для prod | ✅ (deployment-only — секрет не коммитится) |

---

## ✅ S4: Тест-моки — ЗАВЕРШЁН

| Подэтап | Статус |
|---------|--------|
| S4.1: Mock audioOrch (initPlaceholderReady и др.) | ✅ zero warnings |
| S4.2: Очистить пустые тест-файлы | ✅ |

---

## ✅ M5: Единый фасад — ВСЕ ШАГИ ВЫПОЛНЕНЫ

| Шаг | Статус | Риск |
|-----|--------|------|
| Шаг 1: `completeStage` — единый READY | ✅ | Низкий |
| Шаг 2: `scene-window` → facade | ✅ | Средний |
| Шаг 3: `syncLinearState` — побочный эффект facade | ✅ | Средний |
| Шаг 4: Reconciliation → audit-only (через facade) | ✅ | Низкий |
| Шаг 5: Version gate на READY | ✅ | Средний (graceful fallback) |

---

## ✅ Regeneration System — ВСЕ ЗАДАЧИ ВЫПОЛНЕНЫ

| Задача | Статус |
|--------|--------|
| R0: Audio→Video dependency fix | ✅ |
| R1: SceneText diff | ✅ |
| R2: Character→Scene Index | ✅ |
| R3: Location→Scene Index | ✅ |
| R4: Voice-only dirty (video NOT dirty) | ✅ |
| R5: Унификация book-sync / book-diff | ✅ |
| R6: Prompt Dependency Registry | ✅ |
| R7: Lua-транзакции markDirtyScenes | ✅ |
| R8: Lock на /regenerate | ✅ |
| R9: FSM-reset вместо force redis.set | ✅ |
| R10: Placeholder ≠ valid content | ✅ |
| R11: Unit-тесты (295+ tests) | ✅ |
| R12: Book-sync после PUT | ✅ |
| R13: PG schema (content_version, audio_config_version) | ✅ |
| R14: Dual mode (versions + flags) | ✅ |
| R15: Versions as source of truth | ✅ |
| R16: Cross-cutting через версии | ✅ |
| R17: Redis persistence / startup recovery | ✅ |
| R18: Callback chain repair | ✅ |
| R19: Frontend audio cache invalidation | ✅ |

> **Bugfixes (per-unit regeneration):** Worker toggle fix, `ensureSceneRow`, GPU hub dedup key cleanup, in-flight tracking, progress display — все выполнены.

---

## 🔴 Фазы 2–11: Convergence (audio-orch через фасад) — НЕ ВЫПОЛНЕНЫ

| Фаза | Приоритет | Статус | Описание |
|------|-----------|--------|----------|
| 1: DONE guard в фасаде | HIGH | 🟡 **Частично** | Guard в `scene-orchestrator.js` есть, но не перенесён в `orchestrator.setSceneGenerating()` |
| 2: completeStage синхронизирует audio-orch | HIGH | ✅ **Готово** | `completeChunk` → `completeStage` → asset READY + audio-orch DONE синхронно |
| 3: failStage синхронизирует audio-orch | HIGH | ✅ **Готово** | `failStage` → asset FAILED + audio-orch FAILED |
| 4: markDirtyScene чистит audio-orch | HIGH | ✅ **Готово** | DONE → deleteState |
| 5: setScenePending чистит audio-orch | MED | 🔴 | DONE → deleteState (нужен тест) |
| 6: setSceneAllReady ставит DONE | LOW | 🔴 | Cache hit → audio-orch DONE (нужен тест) |
| 7: Reconciliation enforce invariants | MED | 🟡 **Частично** | checkStalledAudioScenes работает. checkAudioOrchInvariants без auto-fix. |
| 8: task-handler через фасад | MED | 🔴 | `audioOrch.completeChunk()` напрямую |
| 9: reconciliation через фасад | LOW | 🔴 | `audioOrch.*()` напрямую в reconciliation-engine |
| 10: scene-orchestrator через фасад | MED | 🟡 **Частично** | DONE guard есть, остальное — через фасад |
| 11: debug-логи | LOW | 🟡 **Частично** | `/gpu/task/result` логирует, `completeChunk`/`transitionState` — не все |

> **Итог:** Фазы 1–4 (HIGH) в основном готовы. Фазы 5–11 — TODO с приоритетом MED/LOW.

---

## ✅ Что НЕ нужно делать (согласовано)

| Задача | Вердикт |
|--------|---------|
| Kafka, RabbitMQ, BullMQ | 🔴 Не добавлять |
| Второй state-machine поверх asset FSM | 🔴 Не вводить |
| Перенос lifecycle в PG одним PR | 🔴 Не делать |
| Rewrite audio/image/video pipeline | 🔴 Не делать |
| Новый reconciliation service | 🔴 Не добавлять |
| Расширение facade >13 команд | 🔴 Не нужно |

---

## Финальный Definition of Done

| Критерий | Статус |
|----------|--------|
| Все production JS проходят `node --check` (syntax-smoke) | ✅ |
| `npm test` > 570 passing, zero warnings | ✅ (576 passing) |
| `completeStage` NEVER пишет `READY` без `handler.ok` | ✅ |
| `failStage` NEVER пишет `recordSuccess` | ✅ |
| `executor` NEVER `dispatched:true` без реального job | ✅ |
| Renewal стартует после `dispatched:true`, останавливается в `finalizeDispatch` | ✅ |
| Runtime-loop НЕ гоняет полный `reconcileAll` каждые 5s | ✅ |
| `active-scenes` — один API (`active-scenes-index.js`) | ✅ |
| Прямые asset-state writes только через `unsafe*` restore-methods | ✅ |
| Graceful shutdown + `/health` | ✅ |
| `GPU_HUB_API_KEY` задан в прод-.env | ⚠️ (deployment-only) |
| Audio-orch фазы 5–11 полный рефакторинг | 🔴 (MED/LOW) |

<!-- === Footer === -->
---
*Сводный TODO. Все исторические списки сведены в один. 19 июля 2026.*
