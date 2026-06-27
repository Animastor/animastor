# TODO — Сегодня (26 июня 2026)

> Фокус: закрыть остаток аудита — **M3** (диск как факт, не решение) и **M5** (свести писателей состояния к одному арбитру).
> Основано на `04_Migration_Plan.md` (Шаги 9–11) и наблюдении из ревью Н.0–Н.10.

## Контекст

C1–C4, M1, M2, M4, §5.1 — закрыты (Н.0–Н.9). Н.10 — доработки по ревью.
Остались **M3** и **M5**. По плану это Релиз C, который требует Orchestrator-фасада
(`markDirty`/`reconcile`/`completeStage`) — а его пока нет. Поэтому сегодня — подготовительные,
низкорисковые шаги к M3/M5: каждый самодостаточен, с тестом, в духе Н.0–Н.9.

**Правило:** каждый шаг = отдельный коммит → `npm test` → push. Высокий риск у Д.3 — только после Д.0.

---

## ✅ Д.0: Карта писателей состояния (инвентаризация) — выполнено

**Риск:** нет (только чтение). **Фундамент для Д.2, Д.3.**

Результат → `docs/STATE_WRITERS_MAP.md`:
- **8 per-asset writers** (P1–P8) с точными строками; P8 уже за фасадом.
- **7 linear-state writers** (L1–L7) — производная проекция, вывод позже.
- **3 disk-derived chunk writers** (D1–D3) — цель Д.3 (M3).
- Порядок безопасного перевода к фасаду: P3 (Д.2) → D1–D3 (Д.3) → P5/P6 → P4 → P2.

---

## ✅ Д.1: `markDispatchCompleted` идемпотентен — выполнено

**Риск:** низкий. **Прямое продолжение ревью.** Не зависит от Д.0.

Из ревью: `markDispatchCompleted` безусловно делал `releaseQuota` → целостность квот
держалась только на C4-dedup. Двойной вызов в обход dedup (истёкший TTL, reconciliation,
force-regen) давал двойной декремент квоты.

Сделано:
- `SET NX animastor:dispatch-completed:<scene>:<stage>` (TTL = lease TTL) в начале
  `markDispatchCompleted`; при повторе — ранний `return`, release пропускается.
- Маркер снимается в `dispatchStage` (шаг 4, после lease) → force-regen/re-dispatch
  завершается заново. Плюс маркеры чистятся в `clearAllLeasesForBook` (cancel/regen).
- Экспортирован `getDispatchCompletedKey` для тестов.
- +2 теста: двойной вызов декрементит ровно раз; после снятия маркера release снова работает.
- **365 passing** (было 363).

---

## ✅ Д.2: `planScene`/`shouldScheduleAssets` — чистая (Шаг 9, часть M5) — выполнено

**Риск:** средний. **После Д.0.**

`shouldScheduleAssets` при version-stale **сама** писала Redis READY→DIRTY — побочный эффект
в функции планирования (P3 в карте писателей).

Сделано:
- `shouldScheduleAssets` теперь ЧИСТАЯ: только читает per-asset + layer-config, возвращает
  `{ stages, allDone }`, без единой записи.
- Version-stale разделён на два: `detectVersionStale` (чистый PG-read → bool) и
  `markVersionStaleDirty` (явная запись READY→DIRTY).
- Пред-проход в `attemptDispatch`: detect → mark → plan, **в том же тике** (без лага регена).
- Оба экспортированы; facade `planScene` JSDoc обновлён.
- +4 теста: pure (no mutation) ×2, markVersionStaleDirty reset ×2. **369 passing** (было 365).

---

## ✅ Д.3: Диск-проверки возвращают факты, не решения (M3) — выполнено

**Риск:** высокий. **Опора истины — PG-ready (Н.5) + version-gate.**

**Коммиты:** `91f104f` (fix) + `cc7d706` (tests)

`restoreChunkStatusForScene` и `reconcileWindowStatuses` больше не пишут 'ready'
просто по наличию файла — перед записью проверяют PG `content_version`.

Что сделано:
- `_checkAssetVersionStale` — новый хелпер в scene-window.js, сравнивает
  `scene_assets.scene_content_version` с `scenes.content_version` для audio/image/video
- `restoreChunkStatusForScene` — version-gate: если версия устарела, chunk stays 'pending'
- `reconcileWindowStatuses` — version-gate с per-scene cache (избегает N+1 PG-запросов)
- `scene-restoration.js` — version-gate перед `setAssetState(audio, READY)` (P6)

**Тесты (5, SECTION 8, 381 passing):**
1. Force-regen: stale version → old PNG не отменяет регенерацию, chunk stays 'pending'
2. Рестарт: current version → chunk пишет 'ready' (без массовой перегенерации)
3. reconcileWindowStatuses stale → 0 reconciled
4. reconcileWindowStatuses current → reconciled, chunk → ready

---

## ✅ M5: Свести писателей состояния к одному арбитру — выполнено

**Риск:** средний. **После Д.0–Д.3.** Получилось закрыть в тот же день (фасад уже был, `a092f44`).

### Per-asset writers → orchestrator-фасад
- **P2** — `task-handler.cjs`: 7 мест прямого `callback + markDispatchCompleted` сведены
  к `orchestrator.completeStage` (включая отсутствовавший `handleSceneImageCompleted`).
  ✅ `5d5e1a3`
- **P4/P5/P6** — прямые `setAssetState` в `reconciliation-engine`, `scene-restoration`,
  `startup-recovery` → через фасад. ✅ `2807a38`

### Linear-state writers (L1–L7) → `deriveLinearState` (производная проекция)
- L1–L2 ✅ `3562778` · L3 (reconciliation-engine) ✅ `84fa8da` · L4 (scene-window) ✅ `58a24a0`
- L5 (book-routes + window-generator + redis-helpers) ✅ `908207f`
- L6 (runtime-persistence `recoverActiveScenes`) ✅ `5b2a11a`
- L7 (debug-routes → recover-video через per-asset + `syncLinearState`) ✅ `cadad04`

### Сопутствующее
- **O2** — Prometheus-метрики: quota utilisation, lease age, tick duration. ✅ `40acaf4`
- Чистка мёртвого кода (`backend.cjs` wrappers, asset-registry exports). ✅ `d713e20`
- Fix: 500 в `/regenerate` — циркулярная зависимость на `restoreSceneChunkStatus`
  (импорт напрямую из leaf-модуля `scene-restoration.js`). ✅ `968d1f6`

---

## Итог дня

| Шаг | Что закрывает | Риск | Зависит от |
|---|---|---|---|
| Д.0 | инвентаризация (M5) | нет | ✅ `8369a04` |
| Д.1 | идемпотентность квот | низкий | ✅ `58a8577` |
| Д.2 | чистый planScene (M5) | средний | ✅ `b485c73` |
| Д.3 | диск как факт (M3) | высокий | ✅ `91f104f` + `cc7d706` |
| M5 | единый арбитр (P2/P4/P5/P6 + L1–L7) | средний | ✅ `5d5e1a3` … `cadad04` |
| O2 | Prometheus-метрики | низкий | ✅ `40acaf4` |

**M3 и M5 закрыты.** Все прямые `setAssetState` / `callback+markDispatchCompleted`
проходят через Orchestrator-фасад (`a092f44`); linear-state — производная (`deriveLinearState`).

---

*Дата: 2026-06-26. Д.0–Д.3, M5 и O2 выполнены. Тесты: 381 passing, 0 failing.
Основано на `docs/04_Migration_Plan.md` (Шаги 9–11).*
