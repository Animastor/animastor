# 05. Аудит документации против кода — Animastor

> Сравнение содержимого `docs/` с реальной реализацией. Цель — найти устаревшее,
> противоречия, отсутствующие разделы, неверные схемы.
> Основано на чтении исходного кода и документов. Дата: 2026-06-25.
>
> **Источник:** Оригинальный анализ `docs-claude/05_Documentation_Audit.md`.
> **Статус:** Исторический аудит. Сквозные противоречия (rate limit, lease TTL, sendVideo и др.) исправлены
> в ходе реструктуризации документации (июнь 2026).

---

## Шкала статусов

- **Актуален** — соответствует коду; мелкие неточности отсутствуют или некритичны.
- **Требует обновления** — в основе верен, но содержит конкретные расходящиеся с кодом факты/схемы.
- **Устарел** — описывает архитектуру/числа, которых в коде уже нет; опасен при онбординге.
- **Отсутствует** — раздел/документ, которого нет, но он нужен.

---

## Сводная таблица (25 документов)

| Документ | Статус | Главная проблема |
|---|---|---|
| `AGENTS.md` | Актуален | корректно поясняет модель/шаги агента (override в compose учтён) |
| `ARCHITECTURE.md` | ✅ Обновлён | rate limit 500, `sendVideo` убран, governance live, 6 routes |
| `SYSTEM_OVERVIEW.md` | ✅ Обновлён | те же числа; «6 шагов» пояснено |
| `DATA_FLOW.md` | ✅ Обновлён | lease TTL 15/20/30, version-stale в scheduler |
| `PROJECT_STRUCTURE.md` | ✅ Обновлён | упомянуты workflow-manager, startup-recovery |
| `ARCHITECTURAL_DEBT.md` | ✅ Обновлён | orchestrator 173 строки, rate limit 500 |
| `CONFLICTING_SUBSYSTEMS.md` | Актуален | «4 центра решений» подтверждается кодом |
| `ARCHITECTURAL_AUDIT_TODO.md` | ✅ Архивирован | все пункты выполнены |
| `ARCHITECTURE_REVIEW.md` | 🗄 Архив | момент-во-времени ревью |
| `architectural-essence.md` | Актуален | принципы, мало завязан на числа |
| `REGENERATION_SYSTEM.md` | Требует обновления | основной механизм описан верно |
| `ORCHESTRATOR_LIFECYCLE.md` | Актуален | соответствует текущей архитектуре |
| `PLAYER_AUDIT.md` | Требует обновления | аудит плеера на момент |
| `PLAYER_STATE.md` | Актуален | соответствует текущему коду |
| `CONNECTORS.md` | Актуален | слой коннекторов есть в коде |
| `CONNECTOR_ARCHITECTURE.md` | Актуален | дизайн-документ коннекторов |
| `WORKFLOWS.md` | Актуален | workflow-loader/manager присутствуют |
| `WORKFLOW_ARCHITECTURE.md` | Актуален | дизайн workflow-слоя |
| `WORKFLOW_ASSISTANT_VISION.md` | Требует обновления | vision/roadmap |
| `WORKFLOW_ROADMAP.md` | Требует обновления | roadmap, статусы пунктов |
| `GENERATORS.md` | Актуален | audio/image/video генераторы соответствуют |
| `DEPENDENCY_ANALYSIS.md` | Требует обновления | граф зависимостей мог сместиться |
| `LLM_AUDIT_CONTEXT.md` | 🗄 Архив | повторяет старые числа |
| `DONT_DO.md` | Актуален | запреты/анти-паттерны |
| `CHANGELOG.md` | Актуален | свежий (Jun 26) |

### Отсутствующие разделы (теперь добавлены)

1. **Жизненный цикл генерации / владение состоянием** — ✅ `ORCHESTRATOR_LIFECYCLE.md`
2. **Системная карта (as-is)** — ✅ `SYSTEM_MAP.md`
3. **Архитектурный аудит** — ✅ `ARCHITECTURAL_AUDIT.md`
4. **Фронтенд-хэндоф (GPU Progress)** — ✅ `PROGRESS_HANDOFF.md`

---

## Приоритет обновления (на момент аудита)

1. **LLM_AUDIT_CONTEXT.md** — 🗄 Архивирован. Его ошибки больше не тиражируются.
2. **DATA_FLOW.md** — ✅ Обновлён: lease TTL 15/20/30, version-stale в scheduler, callbacks без syncLinearState.
3. **ARCHITECTURE.md / SYSTEM_OVERVIEW.md** — ✅ Обновлены: rate limit 500, 6 routes, governance live.
4. **ARCHITECTURAL_DEBT.md** — ✅ Обновлён: orchestrator 173 строки, закрытые пункты помечены.
5. **ARCHITECTURAL_AUDIT_TODO.md** — 🗄 Архивирован (все пункты ✅).

---

## Сквозные противоречия (повторялись в нескольких документах)

| Неверный факт | Где встречалось | Исправлено |
|---|---|---|
| Rate limit 100 req/min | ARCHITECTURE, SYSTEM_OVERVIEW, LLM_AUDIT_CONTEXT | ✅ 500 |
| `gpu-dispatcher.sendVideo` | SYSTEM_OVERVIEW, ARCHITECTURE | ✅ нет такого метода |
| Lease TTL 30/60/120 мин | DATA_FLOW | ✅ 15/20/30 |
| orchestrator ~1200 строк | ARCHITECTURAL_DEBT | ✅ 173 |
| Все governance — мёртвый код | ARCHITECTURE, ARCHITECTURAL_DEBT | ✅ живы 3 из 6 |

---

*Конец аудита документации. Выполнен 2026-06-25, обновлён 2026-06-28.*
