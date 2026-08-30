# 📦 TODO — Next Days (June 26–30, 2026) — ALL COMPLETED

> **Status: ARCHIVE.** All tasks N.0–N.9, D.0–D.3 completed.
> Closed bugs: C1, C2, C3, C4, M1, M2, M3, M4, §5.1.
> Results integrated into main `docs/` documents. Kept as historical record.

> Based on `06_Roadmap.md` (Week — "stop the bleeding" + safety),
> `02_Claude_Audit.md` (C1–C4, M1–M2) and `04_Migration_Plan.md` (Steps 0–3).

Priority: tests first (safety net), then critical bugs (C1, C4), then quotas (C1/M2).

---

## ✅ N.0: Safety Net (Tests) — Completed

**Коммит:** `15978e6` — создан `backend/tests/happy-path.test.js` (30+ тестов)

- Lease lifecycle (9 тестов): acquire/release/duplicate/parallel stages/cleanup
- Quota lifecycle (8 тестов): limits, cycle to zero, checkQuota
- Per-asset state (6 тестов): get/set/fallback/independence
- Scene callbacks (8 тестов): каждый callback + valid/invalid state guards
- Scheduler tick lock (4 теста): acquire/release/isRunning
- KNOWN BUG тесты: C1, C2, M1, §5.1

---

## ✅ N.1: `/gpu/task/result` Idempotency (C4) — Completed

**Коммит:** `d804a77`

- SET NX dedup по ключу `animastor:result-processed:<job_id>:<build_id>` (TTL 3600s)
- `build_id` в ключе — force-regen не блокируется
- 5 тестов на идемпотентность

---

## ✅ N.2: Single Quota Release Owner (C1) — Completed

**Коммит:** `4e007e2`

- Удалены все 9 `releaseQuota` из `scene-callbacks.js`
- `markDispatchCompleted` — единственный владелец release
- C1-тесты обновлены на single-release

---

## ✅ N.3: Quota Atomicity (M2) — Completed

**Коммит:** `636da04`

- `acquireQuota` заменён на Lua EVAL: атомарный GET + check + INCR
- Добавлен `FakeRedis.eval` для тестов
- 3 теста FIXED M2 (атомарность, первый вызов, per-stage limits)

---

## ✅ N.4: Error-safe markDispatchCompleted — Completed

**Коммит:** `fbb6493`

- Все 6 callback+markDispatchCompleted пар обёрнуты в `try/finally`
- Image (3 пути): all IUs, totalIUs===0, PG fallback
- Video (1 путь): scene_video
- Audio (2 пути): early return, normal merge

---

## ✅ N.5: PG `status='ready'` Write (C2) — Completed

**Коммит:** `cf0a48a`

- `handleAudioCompleted` → `markReady(..., 'audio', audioPath)`
- `handleImageCompleted` → `markReady(..., 'image', sceneImage, {width, height})`
- `handleVideoCompleted` → `markReady(..., 'video', videoPath, {duration, width, height})`
- C2 docs marker → FIXED C2 verification tests

---

## ✅ N.6: Per-asset RMW Atomicity (M1) — Completed

**Коммит:** `1a0867d`

- `setAssetState` / `setAssetStates` / `getAssetStates` переведены с JSON-строк на Redis Hash (HSET/HGETALL)
- Устранена гонка GET→merge→SET
- `try/catch` вокруг HGETALL для backward compat со старыми JSON-ключами

---

## ✅ N.7: GENERATING Per-asset at Dispatch (§5.1) — Completed

**Коммит:** `f0b81de`

- `executeAudioDispatch` → `setAssetState(audio, generating)`
- `executeImageDispatch` → `setAssetState(image, generating)`
- `executeVideoDispatch` → `setAssetState(video, generating)`

---

## ✅ N.8: Separate Two Registries (C3) — Completed

**Коммит:** `5182455`

- `storage/asset-registry.js` (Redis): функции переименованы с суффиксом `Redis` (`registerSceneAudioRedis`, `getSceneAssetsRedis`, …)
- `services/scene-asset-registry.js` (PG): имена не изменены (канонический registry)
- Обновлены вызовы: `scene-callbacks.js`, `reconciliation-engine.js`, mock в тестах

---

## ✅ N.9: Remove Dead MAX_CONCURRENT Duplicate (M4) — Completed

**Коммит:** `0adc930`

- Удалены `MAX_CONCURRENT_AUDIO/IMAGE/VIDEO`, `*_IN_PROGRESS_KEY`, `getCountInState`, `incrementConcurrent`, `decrementConcurrent`, `canScheduleStage`
- `getMetrics` делегирует в `dispatchEngine.getQuotaStatus`
- `runtime.js` API — удалена мёртвая секция `limits`

---

## 🏆 Summary: All Critical Bugs Closed

| Проблема | Статус | Коммит |
|---|---|---|
| **C1** — двойной release квоты | ✅ | `4e007e2` |
| **C2** — PG `status='ready'` не пишется | ✅ | `cf0a48a` |
| **C3** — два registry с одинаковыми именами | ✅ | `5182455` |
| **C4** — неидемпотентность колбэков | ✅ | `d804a77` |
| **M1** — неатомарный RMW per-asset | ✅ | `1a0867d` |
| **M2** — check-then-incr в quota | ✅ | `636da04` |
| **M4** — две системы лимитов | ✅ | `0adc930` |
| **§5.1** — GENERATING не выставляется | ✅ | `f0b81de` |

---

## 🔧 N.10: Post-review Fixes — Completed

Audit N.0–N.9 revealed three issues; fixed:

1. **C4 — потеря результата при ошибке обработки.** Dedup-ключ ставился до `handleTaskResult` и не снимался при исключении → ретрай Hub'а молча отбрасывался (`deduped:true`), результат терялся на 1ч. Теперь при ошибке ключ удаляется (`redis.del`), и следующий ретрай переобрабатывает. +1 тест.
2. **M1 — пропадание fallback на linear-state.** `getAssetStates` после перехода на Hash трактовал пустой хэш `{}` (который ioredis возвращает для отсутствующего ключа) как авторитетный «всё new», минуя fallback на линейное состояние. Добавлена проверка `Object.keys(raw).length > 0`. Плюс самолечение: стейл JSON-ключ (старый формат) удаляется при `WRONGTYPE`. +1 тест.
3. **M4 — недочищенные мёртвые ключи.** В `book-routes.cjs` (2 места) остались `redis.del('animastor:concurrent-*')` со стейл-комментарием — удалены.

**Тесты:** 354 → 356 passing.

---

## ✅ D.0–D.3: Preparatory Steps for M3/M5 — Completed

### ✅ D.0: State Writers Map

**Коммит:** `8369a04` — создан `docs/STATE_WRITERS_MAP.md`

Инвентаризация всех мест, пишущих состояние: 8 per-asset writers (P1–P8),
7 linear-state writers (L1–L7), 3 disk-derived chunk writers (D1–D3).
Порядок безопасного перевода к фасаду: P3 → D1–D3 → P5/P6 → P4 → P2.

---

### ✅ D.1: markDispatchCompleted Idempotent per Dispatch

**Коммит:** `58a8577`

- SET NX `animastor:dispatch-completed:<scene>:<stage>` (TTL = lease TTL)
- Маркер снимается в `dispatchStage` (шаг 4, после lease) и в `clearAllLeasesForBook`
- +2 теста

---

### ✅ D.2: shouldScheduleAssets — Pure Function

**Коммит:** `b485c73`

- version-stale разделён на `detectVersionStale` (чистый PG-read) +
  `markVersionStaleDirty` (явная запись)
- shouldScheduleAssets теперь только читает, не пишет
- +4 теста (pure ×2, markVersionStaleDirty ×2)

---

### ✅ D.3: Disk — Fact, Not Decision (M3)

**Коммиты:** `91f104f` (fix) + `cc7d706` (tests)

- `_checkAssetVersionStale` — хелпер: сравнивает PG content_version для audio/image/video
- `restoreChunkStatusForScene` — version-gate перед записью 'ready'
- `reconcileWindowStatuses` — version-gate с per-scene cache
- `scene-restoration.js` — version-gate перед `setAssetState(audio, READY)` (P6)
- +5 тестов (force-regen не отменяется старым файлом; рестарт без массовой регенерации)
- **381 passing** (было 376)

---

## ✅ Итог: Закрытые проблемы

| Проблема | Статус | Коммит |
|---|---|---|
| **C1** — двойной release квоты | ✅ | `4e007e2` |
| **C2** — PG `status='ready'` не пишется | ✅ | `cf0a48a` |
| **C3** — два registry с одинаковыми именами | ✅ | `5182455` |
| **C4** — неидемпотентность колбэков | ✅ | `d804a77` |
| **M1** — неатомарный RMW per-asset | ✅ | `1a0867d` |
| **M2** — check-then-incr в quota | ✅ | `636da04` |
| **M3** — диск как факт, не решение | ✅ | `91f104f` |
| **M4** — две системы лимитов | ✅ | `0adc930` |
| **M5** — несколько центров записи | ⬜ | _частично: фасад (a092f44), чистый planScene (b485c73)_ |
| **§5.1** — GENERATING не выставляется | ✅ | `f0b81de` |

---

## 🔭 Future Plans

### 🔜 M5: Consolidate Writers to Orchestrator
- P2 (scene-callbacks: setAssetState READY) → `completeStage`
- P4 (reconciliation-engine: setAssetState DIRTY) → `reconcile`
- P5 (startup-recovery: setAssetStates DIRTY) → `reconcile`
- P6 (scene-restoration: setAssetState READY/DIRTY) → частично исправлено (Д.3)

### 🔜 O1: Adopt 03_Orchestrator.md as Architectural Standard
- Использовать концепцию Orchestrator как единого владельца lifecycle при новых изменениях
- Направлять новые изменения через фасад вместо прямого вызова state/scene-callbacks/...

### 🔜 O2: Improve Observability
- Добавить метрики (prometheus) по: quota utilisation, lease age, tick duration
- Мониторинг дрифта квот после каждого релиза

### 🔜 O3: Clean Up Documentation
- Синхронизировать `ARCHITECTURAL_DEBT.md`, `LLM_AUDIT_CONTEXT.md` с текущим состоянием кода
- Добавить диаграмму потоков для Orchestrator

---

## Dependency Summary (Historical)

```
Н.0 (тесты) ─── фундамент для всего
    │
    ├──→ Н.1 (идемпотентность) ───→ Н.2 (один release) ───→ Н.4 (error-safe)
    │
    ├──→ Н.3 (атомарность квот)
    │
    ├──→ Н.5 (PG status=ready)
    │
    ├──→ Н.6 (per-asset RMW)
    │
    ├──→ Н.7 (generating per-asset)
    │
    ├──→ Н.8 (rename registries)
    │
    └──→ Н.9 (dead code removal)
```

**Каждый шаг:** отдельный коммит → npm test → git push.

---

*Дата: 2026-06-26. Все Н.0–Н.9 выполнены. Основано на `docs/06_Roadmap.md` (Неделя A) и `docs/04_Migration_Plan.md` (Шаги 0–3).*