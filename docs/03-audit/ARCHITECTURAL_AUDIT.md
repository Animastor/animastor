# 02. Архитектурный аудит — Animastor

> Аудит проведён чтением исходного кода (не только документации), на основе `01_System_Map.md`.
> Дата: 2026-06-25.
> Контекст: проект на **малое число одновременных пользователей**. Поэтому критерий — не масштабируемость,
> а **простота, понятность и надёжность**.
> Рекомендации в этом файле минимальны — основная задача найти и доказать проблемы.
>
> **Источник:** Оригинальный анализ `docs-claude/02_Claude_Audit.md`.
> **Статус:** Исторический аудит. Все находки C1-C4, M1-M5, §5.1 закрыты (см. `M5_COMPETING_WRITERS.md`, `ORCHESTRATOR_FACADE_PR.md`, `ARCHITECTURAL_DEBT.md`).

## Шкала Severity

- **Critical** — уже сейчас способно приводить к потере/искажению состояния, «залипанию» генерации или к расходящимся источникам истины.
- **Medium** — устойчиво работает в счастливом пути, но ломается на гонках, рестартах, повторных колбэках или усложняет сопровождение настолько, что баги почти неизбежны.
- **Low** — мусор/несогласованность, которая пока не вредит, но повышает когнитивную нагрузку и риск будущих ошибок.

---

## Сводная таблица

| # | Severity | Проблема | Где | Статус |
|---|---|---|---|---|
| C1 | Critical | Двойной декремент quota-счётчика | `dispatch-engine.js`, `scene-callbacks.js`, `task-handler.cjs` | ✅ Закрыт (Н.2) |
| C2 | Critical | PG `scene_assets.status` не переводится в `ready` | `scene-callbacks.js`, `services/scene-asset-registry.js` | ✅ Закрыт (Н.5) |
| C3 | Critical | Два registry с одинаковыми именами функций | `storage/asset-registry.js` vs `services/scene-asset-registry.js` | ✅ Закрыт (Н.8) |
| C4 | Critical | `/gpu/task/result` неидемпотентен | `generation-routes.cjs`, `task-handler.cjs` | ✅ Закрыт (Н.1) |
| M1 | Medium | Неатомарный read-modify-write per-asset state | `state/scene-state.js` | ✅ Закрыт (Н.6) |
| M2 | Medium | Неатомарный check-then-incr в quota | `dispatch-engine.js` | ✅ Закрыт (Н.3) |
| M3 | Medium | Диск как источник истины | `runtime/scene-window.js`, `services/startup-recovery.js` | ✅ Закрыт (Д.3) |
| M4 | Medium | Две параллельные системы лимитов | `runtime-scheduler.js` vs `dispatch-engine.js` | ✅ Закрыт (Н.9) |
| M5 | Medium | Несколько центров записи состояния | `scene-callbacks.js`, `scene-window.js`, `reconciliation`, `recovery` | ✅ Закрыт (M5) |
| L1 | Low | 18 из 36 модулей `runtime/` — debug-only | `runtime/*` | ✅ Закрыт (Д.3) |
| L2 | Low | Массовые inline `require()` внутри функций | `scene-callbacks.js` и др. | ⏳ Отложено (Д.4) |
| L3 | Low | Dual state model + `syncLinearState` | `state/scene-state.js` | ⏳ Отложено (Д.2) |

[Далее следует полный текст оригинального аудита из docs-claude/02_Claude_Audit.md]
