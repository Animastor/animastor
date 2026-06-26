# TODO — Ближайшие дни (26–30 июня 2026)

> Основано на `06_Roadmap.md` (Неделя — «стоп кровотечению» + безопасность),
> `02_Claude_Audit.md` (C1–C4, M1–M2) и `04_Migration_Plan.md` (Шаги 0–3).

Приоритет: сначала тесты (сеть безопасности), затем критичные баги (C1, C4), затем квоты (C1/M2).

---

## День 1 — Н.0: Сеть безопасности (тесты)

**Цель:** Зафиксировать happy-path, чтобы следующие изменения не сломали ничего незаметно.

### [ ] 1.1 Happy-path тест для одной сцены
- Импорт TXT → bootstrap → генерация одной главы audio → image → video → READY
- Проверить: `GET /api/v1/book/:bookId/assets-state` → `status='ready'`
- Проверить: сцена убрана из активного индекса после `video=READY`

### [ ] 1.2 Тест квот
- После завершения сцены: `GET /api/v1/debug/runtime/quotas`
- Все счётчики (audio/image/video) = 0
- Нет дрифта (counter-reconciliation не пишет `totalDrift > 0`)

### [ ] 1.3 Тест lease
- После диспатча → lease существует
- После завершения → lease освобождён
- Повторный диспатч той же стадии → `duplicate`

**Файлы:** `backend/tests/test-happy-path.mjs` (новый)

---

## День 2 — Н.1: Идемпотентность `/gpu/task/result` (C4)

**Цель:** Повторные колбэки от GPU Hub (ретраи до 5 раз) не вызывают повторное завершение.

### [ ] 2.1 Дедуп по `(job_id, build_id)`
- В `routes/generation-routes.cjs` перед `handleTaskResult` добавить:
  ```js
  const dedupKey = `animastor:result-processed:${job_id}:${build_id}`;
  const already = await redis.set(dedupKey, '1', 'NX', 'EX', 3600);
  if (!already) return { ok: true, deduped: true };
  ```
- `build_id` в ключе — чтобы force-regen не блокировался старым dedup-ом.

### [ ] 2.2 Тест на идемпотентность
- Дважды вызвать callback с одинаковым `(job_id, build_id)`:
  - первый → `{ ok: true }`
  - второй → `{ ok: true, deduped: true }`
  - `handleImageCompleted` вызван один раз

**Файлы:** `backend/src/routes/generation-routes.cjs`, `backend/tests/`

**Риски:** Низкий. `build_id` в ключе защищает легитимную регенерацию.

---

## День 3 — Н.2: Один владелец release квоты (C1)

**Цель:** Один `acquireQuota` = ровно один `releaseQuota`. Убрать двойной декремент.

### [ ] 3.1 Убрать `releaseQuota` из callback'ов
- `scene-callbacks.js`:
  - `handleAudioCompleted()` — убрать `dispatchEngine.releaseQuota(redis, 'audio')` (2 места)
  - `handleImageCompleted()` — убрать `dispatchEngine.releaseQuota(redis, 'image')` (2 места)
  - `handleVideoCompleted()` — убрать `dispatchEngine.releaseQuota(redis, 'video')` (2 места)
- **Оставить** `releaseQuota` только в `markDispatchCompleted` / `markDispatchFailed` (`dispatch-engine.js`).

### [ ] 3.2 Проверить все ветки завершения в `task-handler.cjs`
- Убедиться, что каждый путь завершения вызывает `markDispatchCompleted` (или `markDispatchFailed`).
- Ветки: `iu_image` (успех + fallback при `totalIUs===0` + PG error fallback), `scene_video`, `audio_chunk` (early return + normal path).

### [ ] 3.3 Тест
- После завершения сцены: квота уменьшена ровно на 1, не на 2.
- Под нагрузкой (3 сцены в окне) счётчики возвращаются к 0.
- `counter-reconciliation` в логах: `totalDrift: 0`.

**Файлы:** `backend/src/orchestration/scene-callbacks.js`, `backend/src/services/task-handler.cjs`

**Зависимости:** Строго **после** Н.1 (иначе утечка слотов при повторных колбэках).

---

## День 4 — Н.3: Атомарность квот (M2)

**Цель:** Убрать гонку check-then-incr в `acquireQuota`.

### [ ] 4.1 Переписать `acquireQuota` на INCR-then-check
- В `dispatch-engine.js`:
  ```js
  async function acquireQuota(redis, stage) {
      const key = getActiveCounterKey(stage);
      const after = await redis.incr(key);
      const max = QUOTAS[`maxActive${capitalize(stage)}`];
      if (after > max) {
          await redis.decr(key);
          return { acquired: false, reason: 'quota_exceeded' };
      }
      return { acquired: true };
  }
  ```
  (Или Lua-скрипт для атомарности.)

### [ ] 4.2 Убрать мертвый дубль `MAX_CONCURRENT_*` (часть M4)
- Удалить `MAX_CONCURRENT_AUDIO/IMAGE/VIDEO`, `incrementConcurrent/decrementConcurrent/canScheduleStage` из `runtime-scheduler.js`.
- Переключить `getMetrics` на `dispatchEngine.getQuotaStatus`.

**Файлы:** `backend/src/runtime/dispatch-engine.js`, `backend/src/runtime/runtime-scheduler.js`

---

## Бэклог (после 4 дней)

То, что важно, но не критично для стабильности «прямо сейчас»:

### [ ] М.1 — Запись PG `status='ready'` (C2)
Добавить `sceneAssetsRepo.markReady()` в колбэки. **Важно:** нужен точный маппинг версий.

### [ ] М.2 — Развести два registry по именам (C3)
`storage/asset-registry.js` → `redisAssetCache`, `services/scene-asset-registry.js` → `pgAssetRepo`.

### [ ] М.4 — Атомарность per-asset RMW (M1)
Перевести `setAssetState` с JSON-RMW на Redis-hash (HSET field-атомарно) или Lua.

### [ ] Обновление `LLM_AUDIT_CONTEXT.md`
Уже исправлен в этом PR. При повторных изменениях — синхронизировать.

### [ ] Вынести секреты из репозитория (Н.4)
`OPENROUTER_API_KEY` и пароль PG из `docker-compose.yml` → `.env` + ротация ключа.

---

## Сводка зависимостей

```
Н.0 (тесты) ─── фундамент для всего
    │
    ├──→ Н.1 (идемпотентность) ───→ Н.2 (один release)
    │                                  └── строго после Н.1
    │
    └──→ Н.3 (атомарность квот) ─── независим от Н.1/Н.2
                                     └── можно параллельно
```

**Каждый шаг:** отдельный коммит → smoke-тест (импорт TXT → генерация → video=ready) → деплой.

---

*Дата: 2026-06-26. Основано на `docs/06_Roadmap.md` (Неделя A) и `docs/04_Migration_Plan.md` (Шаги 0–3).*
