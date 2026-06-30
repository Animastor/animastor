# PR: Orchestrator facade — единый арбитр состояния (Релизы A/B/C + security/cleanup)

**Branch:** `feat/orchestrator-facade` → `master`
**Tests:** 381 passing, 0 failing
**Net diff:** +1.9k / −13.7k LOC (большая часть удаления — мёртвый governance-кластер)

---

## Что и зачем

Ветка закрывает диагноз аудита: система имела **7 писателей состояния, 3 хранилища и 3
определения «готово»**. Здесь они сведены к **одному арбитру** (Orchestrator-фасад) с PG как
каноном lifecycle, Redis и диском — производными. Плюс закрыт просроченный security-долг и
удалён мёртвый код. Принцип: каждый шаг автономен, проект деплоится после любого коммита.

Соответствие плану `docs-claude/04_Migration_Plan.md`: Релизы **A** (стоп кровотечению),
**B** (единая истина), **C** (единый владелец), частично **D** (уборка).

---

## По блокам

### Релиз A — критические баги квот/завершений
- **C4** идемпотентность `/gpu/task/result` (`SET NX` по `job_id+build_id`) — `d804a77`
- **C1** один владелец release квоты (`markDispatchCompleted`) — `4e007e2`
- **M2** атомарные квоты (Lua EVAL) — `636da04`

### Релиз B — единая истина PG↔Redis
- **C2** запись `scene_assets.status='ready'` в PG — `cf0a48a`
- **C3** разведены два registry по именам — `5182455`
- **§5.1** per-asset `GENERATING` при диспатче — `f0b81de`
- **M1** атомарный per-asset RMW (HSET/HGETALL) — `1a0867d`

### Релиз C — единый владелец состояния
- **Шаг 8** Orchestrator-фасад (`markDirty/planScene/beginStage/completeStage/reconcile`) — `a092f44`
- **M5** все писатели через фасад: P2 (`5d5e1a3`), P4/P5/P6 (`2807a38`),
  linear-state L1–L7 → `deriveLinearState` (`3562778`…`cadad04`)
- **M3** диск — факт, не решение: version-gate перед disk-based `ready` — `91f104f`, `cc7d706`

### Security + Observability + Cleanup
- **S.1 / Н.4** секреты из `docker-compose.yml` → gitignored `.env` (+ `.env.example`) — `6dca53a`
  ⚠️ **требуется ротация** утёкшего ключа/пароля (в истории git с `380a777`)
- **O2** Prometheus-метрики (quota/lease-age/tick-duration) — `40acaf4`
- **D.3 / L1** удалён мёртвый governance-кластер + dead `api/runtime.js`;
  `runtime/`: 37 → 21 модуль, битых `require` не осталось — `311f44a`

---

## Проверка (smoke)
1. Импорт TXT → bootstrap → одна глава доходит до `video=ready`.
2. Плеер играет сцену (audio + image + video).
3. `GET /api/v1/debug/runtime/quotas` — счётчики возвращаются к 0 после простоя.
4. force-regen: правка текста → старый файл на диске НЕ отменяет регенерацию (M3).
5. Рестарт + flush Redis: восстановление по PG, без массовой перегенерации.

## Инвариант
`grep -rn "setAssetState" backend/src` → записи только внутри orchestrator-пути.

## После мёрджа (вне этого PR)
- **Ротация** `OPENROUTER_API_KEY` + пароля PG (S.1, ручной шаг).
- Д.2 (вывод linear-проекции, блокирует frontend), Д.4 (циклические зависимости),
  Д.5 (недостающие доки) — отдельными PR.
