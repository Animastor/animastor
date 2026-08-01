# 08. Миграция Android → Mobile Web

Раздел посвящён переносу Android-приложения Animastor (`frontend/`, Kotlin) на
мобильную веб-версию (`frontends/mobile/`, домен `https://m.animastor.in/`).

> **Статус:** подготовка документации. Реализация экранов не начата.

---

## ✅ Основное правило проекта

Мобильная веб-версия должна **максимально повторять Android-приложение** по
дизайну, логике и пользовательскому опыту. Любые отклонения должны быть
**предварительно задокументированы и обоснованы** в этом разделе (см.
[`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md)) — прежде чем они
попадут в код.

---

## Структура раздела

| Документ | Содержание |
|---|---|
| [`01-MIGRATION-STRATEGY.md`](01-MIGRATION-STRATEGY.md) | Общая стратегия переноса Android UI на Mobile Web |
| [`02-DESIGN-PRESERVATION-PRINCIPLES.md`](02-DESIGN-PRESERVATION-PRINCIPLES.md) | Принципы сохранения дизайна и UX |
| [`03-MOBILE-WEB-ARCHITECTURE.md`](03-MOBILE-WEB-ARCHITECTURE.md) | Предлагаемая архитектура `frontends/mobile/` |
| [`04-MAPPING-TABLES.md`](04-MAPPING-TABLES.md) | Таблицы соответствия Screen→Page, Component→Web Component |
| [`05-SCREEN-IMPLEMENTATION-ORDER.md`](05-SCREEN-IMPLEMENTATION-ORDER.md) | План переноса экранов (простые → сложные) |
| [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) | Компоненты с высоким техническим риском + альтернативы. Игрок — детально |

---

## Связанные документы

- [`docs/01-overview/PROJECT_STRUCTURE.md`](../01-overview/PROJECT_STRUCTURE.md) — место `frontends/mobile/` в проекте
- [`docs/05-frontend/PLAYER_STATE.md`](../05-frontend/PLAYER_STATE.md) — состояние плеера Android (контракт для веб)
- [`docs/03-audit/PLAYER_AUDIT.md`](../03-audit/PLAYER_AUDIT.md) — аудит плеера Android
- [`docs/DONT_DO.md`](../DONT_DO.md) — антипаттерны плеера (актуальны и для веб-переноса)
- [`README.md`](../../README.md) — сервисы проекта (frontends/mobile)
