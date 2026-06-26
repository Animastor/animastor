# TODO — Ближайшие дни (26–30 июня 2026)

> Основано на `06_Roadmap.md` (Неделя — «стоп кровотечению» + безопасность),
> `02_Claude_Audit.md` (C1–C4, M1–M2) и `04_Migration_Plan.md` (Шаги 0–3).

Приоритет: сначала тесты (сеть безопасности), затем критичные баги (C1, C4), затем квоты (C1/M2).

---

## ✅ Н.0: Сеть безопасности (тесты) — выполнено

**Коммит:** `15978e6` — создан `backend/tests/happy-path.test.js` (30+ тестов)

- Lease lifecycle (9 тестов): acquire/release/duplicate/parallel stages/cleanup
- Quota lifecycle (8 тестов): limits, cycle to zero, checkQuota
- Per-asset state (6 тестов): get/set/fallback/independence
- Scene callbacks (8 тестов): каждый callback + valid/invalid state guards
- Scheduler tick lock (4 теста): acquire/release/isRunning
- KNOWN BUG тесты: C1, C2, M1, §5.1

---

## ✅ Н.1: Идемпотентность `/gpu/task/result` (C4) — выполнено

**Коммит:** `d804a77`

- SET NX dedup по ключу `animastor:result-processed:<job_id>:<build_id>` (TTL 3600s)
- `build_id` в ключе — force-regen не блокируется
- 5 тестов на идемпотентность

---

## ✅ Н.2: Один владелец release квоты (C1) — выполнено

**Коммит:** `4e007e2`

- Удалены все 9 `releaseQuota` из `scene-callbacks.js`
- `markDispatchCompleted` — единственный владелец release
- C1-тесты обновлены на single-release

---

## ✅ Н.3: Атомарность квот (M2) — выполнено

**Коммит:** `636da04`

- `acquireQuota` заменён на Lua EVAL: атомарный GET + check + INCR
- Добавлен `FakeRedis.eval` для тестов
- 3 теста FIXED M2 (атомарность, первый вызов, per-stage limits)

---

## ✅ Н.4: Error-safe markDispatchCompleted — выполнено

**Коммит:** `fbb6493`

- Все 6 callback+markDispatchCompleted пар обёрнуты в `try/finally`
- Image (3 пути): all IUs, totalIUs===0, PG fallback
- Video (1 путь): scene_video
- Audio (2 пути): early return, normal merge

---

## ✅ Н.5: Запись PG `status='ready'` (C2) — выполнено

**Коммит:** `cf0a48a`

- `handleAudioCompleted` → `markReady(..., 'audio', audioPath)`
- `handleImageCompleted` → `markReady(..., 'image', sceneImage, {width, height})`
- `handleVideoCompleted` → `markReady(..., 'video', videoPath, {duration, width, height})`
- C2 docs marker → FIXED C2 verification tests

---

## 📋 Текущие и следующие шаги

### 🔜 Н.6: Атомарность per-asset RMW (M1)
**Цель:** Убрать гонку GET→merge→SET в `setAssetState`.

**Что сделать:**
- Перевести `setAssetState` с JSON-RMW на Redis HSET (поле `audio`/`image`/`video` обновляется атомарно)
- `setAssetStates` → `HMSET` для множественных полей
- `getAssetStates` → `HGETALL` (остаётся без изменений)

**Файлы:** `backend/src/state/scene-state.js`

### 🔜 Н.7: GENERATING per-asset при диспатче (§5.1)
**Цель:** `executeAudioDispatch` / `executeImageDispatch` / `executeVideoDispatch` пишут `setAssetState(..., 'generating')`.

### 🔜 Н.8: Развести два registry (C3)
**Цель:** `storage/asset-registry.js` (Redis) → `redisAssetCache`, `services/scene-asset-registry.js` (PG) → `pgAssetRepo`.

### 🔜 Н.9: Убрать мертвый дубль MAX_CONCURRENT (M4)
**Цель:** Удалить `MAX_CONCURRENT_AUDIO/IMAGE/VIDEO`, `incrementConcurrent/decrementConcurrent/canScheduleStage` из `runtime-scheduler.js`.

---

## Сводка зависимостей

```
Н.0 (тесты) ─── фундамент для всего
    │
    ├──→ Н.1 (идемпотентность) ───→ Н.2 (один release) ───→ Н.4 (error-safe)
    │
    ├──→ Н.3 (атомарность квот)
    │
    ├──→ Н.5 (PG status=ready)
    │
    ├──→ Н.6 (per-asset RMW) ─── независим
    │
    └──→ Н.7 (generating per-asset)

Н.8 (rename registries) ─── можно в любой момент
Н.9 (dead code) ─── можно в любой момент
```

**Каждый шаг:** отдельный коммит → npm test → git push.

---

*Дата: 2026-06-26. Обновлено после Н.0–Н.5. Основано на `docs/06_Roadmap.md` (Неделя A) и `docs/04_Migration_Plan.md` (Шаги 0–3).*