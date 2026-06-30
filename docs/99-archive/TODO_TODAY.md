# TODO — Сегодня (27 июня 2026)

> Контекст: Релизы A/B/C (`04_Migration_Plan.md`) закрыты — C1–C4, M1–M5, §5.1.
> M5 (P2/P4/P5/P6 + L1–L7) и O2 завершены 26 июня. См. вчерашний `TODO_TODAY` в git (`9668f4c`).
> Остаётся: **1 просроченный security-пункт** + **Релиз D «уборка»** (Долгосрок Д.1–Д.5 из `06_Roadmap.md`).
>
> **Правило:** каждый шаг = отдельный коммит → `npm test` (база 381 passing) → push.

---

## 🔴 S.1: Вынести секреты из git + ротация (Н.4 — ПРОСРОЧЕНО)

**Риск:** низкий технически, но **критичный по безопасности**. **Делать первым.**

В `docker-compose.yml` (отслеживается git) — боевые секреты в открытом виде:
- `OPENROUTER_API_KEY=sk-live-…bd0b` (строка 59)
- `POSTGRES_PASSWORD=animastor_secret_2026` (строка 22) + `PG_PASSWORD` (строка 57)

`.gitignore` уже покрывает `.env` / `*.env` — инфраструктура для выноса готова, `.env`-файлов пока нет.

Сделать:
- [ ] `.env` (не коммитится) + `.env.example` с плейсхолдерами.
- [ ] `docker-compose.yml` → `${OPENROUTER_API_KEY}` / `${POSTGRES_PASSWORD}` через `env_file`.
- [ ] **Ротировать утёкший ключ OpenRouter и пароль PG** — ключ в истории git, считается скомпрометированным.
- [ ] (опц.) почистить ключ из истории git или принять как «ротирован, старый мёртв».

---

## 🟢 D.1: Доуборка мёртвого дубля лимитов (M4 / Д.1) — проверить

**Риск:** низкий. M4 закрыт (`0adc930`), но roadmap Д.1 шире: убедиться, что `getMetrics`
планировщика отдаёт **реальные** счётчики dispatch-engine, а не мёртвые нули.

Проверено ✅ (изменений не потребовалось):
- [x] `grep` — мёртвых `MAX_CONCURRENT/concurrent-/canScheduleStage/incrementConcurrent` нет.
- [x] `getMetrics` (`runtime-scheduler.js:403`) делегирует `dispatchEngine.getQuotaStatus` —
  возвращает реальные per-stage счётчики (audio/image/video current+max), не нули.
- [x] Д.1 уже полностью закрыт в `0adc930` (Н.9). Дублировать нечего.

---

## ✅ D.3: Снять мёртвый governance и битые `require` (L1 / Д.3) — выполнено

**Коммит:** `311f44a`

Находка оказалась шире и **безопаснее**, чем в плане: `src/api/runtime.js` (1758 строк)
**нигде не импортируется** — мёртвый файл и единственный потребитель 16 debug-only
модулей `runtime/`. Шесть из них делали `require()` на несуществующие файлы
(trace-compactor, invariant-engine, safe-mode, state-graph/*, policies, admission-control) →
обращение к `/debug/runtime/governance-health` и `/execution-semantics` дало бы 500.
Живые debug-роуты (`debug-routes.cjs`) этот кластер **не трогают** (только `reconciliation`).

Сделано:
- [x] Удалён `src/api/runtime.js` (несвязанный dead-код).
- [x] Удалены 16 мёртвых модулей `runtime/` (snapshot/priority/policy-engine/workload/cost/
  decision-trace/feedback/governance-metrics/adaptation/governance-stability/governance-health/
  execution-semantics/policy-simulator/governance-sandbox/failure-replay/governance-validator).
- [x] Удалён `debug: { ... }` фасад из `runtime/index.js` (читал только `api/runtime.js`).
- [x] Оставлены живые `circuit-breaker`/`fairness-engine`/`retry-budget-manager` —
  они `require()`-ятся напрямую из `dispatch-engine`/`runtime-persistence`.
- [x] Проверено: битых require нет, `runtime/index.js`+`debug-routes` грузятся чисто, **381 passing**.

---

## ⚪ Отложено (не сегодня — большие/зависимые)

- **Д.2 — вывод линейной проекции (L3):** удалить `SceneState`/`syncLinearState`/`deriveLinearState`.
  Блокирует frontend — плеер и debug ещё читают `scene-state` ключи. Делать **после** стабилизации.
- **Д.4 — развязать циклические зависимости (L2):** убрать inline `require()` внутри функций
  (8+ мест в `scene-callbacks.js`). По roadmap — **после** К.4 (Orchestrator уже даёт границу).
- **Д.5 — недостающие docs:** backpressure/квоты/lease, per-asset vs linear, идемпотентность колбэков.

---

## 🟢 Док-хвост (быстро, low-risk)

- [ ] `ARCHITECTURAL_AUDIT_TODO.md` строки 32–34: снять предупреждение о R1.1-расхождении —
  version-stale в `startup-recovery.js:284-288` уже идёт через `orchestrator.markDirtyScene` (`2807a38`).

---

## Итог дня

| # | Шаг | Закрывает | Статус | Коммит |
|---|---|---|---|---|
| 1 | **S.1** секреты в `.env` + ротация | Н.4 | ✅ код / ⏳ ротация (ручная) | `6dca53a` |
| 2 | D.1 доуборка лимитов | M4/Д.1 | ✅ уже закрыт в `0adc930` | — |
| 3 | D.3 мёртвый governance + dead api/runtime.js | L1/Д.3 | ✅ выполнено | `311f44a` |
| — | док-хвост (R1.1 расхождение) | — | ✅ снято | (этот коммит) |

**Осталось вручную (вне кода):** ротировать утёкший `OPENROUTER_API_KEY` и пароль PG
(старые значения в истории git с `380a777`, 2026-06-09). После ротации — обновить `.env`.

**Отложено:** Д.2 (вывод linear-проекции, блокирует frontend), Д.4 (циклические зависимости,
после К.4), Д.5 (недостающие docs) — см. раздел «Отложено» выше.

---

*Дата: 2026-06-27. Релизы A/B/C закрыты. Сегодня — S.1 (security), D.3 (уборка L1), D.1 (проверен).
Тесты: 381 passing. Основано на `docs-claude/06_Roadmap.md` (Долгосрок) и `04_Migration_Plan.md` (Шаг 12).*
