# 09. Миграция Mobile Web → Desktop

Раздел посвящён десктопной презентации существующего мобильного веб-приложения
Animastor (`frontends/mobile/`, Preact + TS + Vite). Десктоп **не** является
вторым продуктом: он переиспользует те же маршруты, API-клиент, сторы, переводы,
темы и доменные компоненты, добавляя десктопную оболочку и десктопные варианты
workspace-лейаутов.

> **Статус:** план утверждён (этап 1 аудита завершён). Десктопный shell-прототип
> реализован за 8 коммитов (создан по плану §15 как «Immediate next step») —
> см. [`02-PROGRESS.md`](02-PROGRESS.md). Следующий приоритет — десктопный
> **Editor workspace** (Phase 5 плана).

---

## Ключевое решение (из плана, §1.4 и §14)

`frontends/main/` содержит только статичный `index.html` — это **не** десктопное
приложение. Поэтому десктоп реализуется **внутри `frontends/mobile/`** как
адаптивное представление на определённом брейкпоинте ширины; мобильная
композиция остаётся fallback'ом ниже этого брейкпоинта. Строить второе
десктопное приложение запрещено (дублирование состояния и расхождение
поведения).

## Основная модель

Контекстуальный workspace:

```text
┌──────────── File rail ────────────┬────────────── Main workspace ──────────────┬──── Navigator ────┐
│ book actions / import / export    │  [Generator] [Player] [Editor]              │ chapters / scenes │
│ visible on first run, collapsible │  selected mode; state remains in stores     │ units / position  │
│                                   │  optional mode-specific panes               │ persistent/collap.│
└───────────────────────────────────┴─────────────────────────────────────────────┴───────────────────┘
                                                   ▲
                                  AI Assistant: contextual overlay / docked panel
```

Generator, Player и Editor — это три **режима workspace**, а не три смежные
панели: сегментированный mode-бар в десктопном header'е, состояние — в
существующих общих сторах (`generateStore`, `playbackStore`, `positionStore`).

## Брейкпоинты (Phase 2 — валидировать реальным контентом)

| Layout state | Viewport | Shell behaviour |
|---|---:|---|
| Wide desktop | `>= 1440px` | header + File-панель 264–304px + центр + Navigator 280–336px |
| Standard laptop | `1100–1439px` | File → rail 56–64px после открытия книги; Navigator открыт, в Editor сжимается |
| Narrow desktop | `900–1099px` | центр + один overlay/коллапсируемый сайдбар |
| Mobile | `< 900px` | текущий mobile-шелл (toolbar + tab bar), без десктопных панелей |

Текущий shell-прототип работает от брейкпоинта **`min-width: 1180px`**
(`DESKTOP_SHELL_QUERY` в `AppShell.tsx`) с laptop-адаптацией `<= 1359px` —
значения предстоит сверить с планом после визуальных прототипов.

## Структура раздела

| Документ | Содержание |
|---|---|
| [`01-MIGRATION-PLAN.md`](01-MIGRATION-PLAN.md) | Полный план миграции: аудит мобильного UI, десктопные принципы, информационная архитектура, десктопный Editor/Generator/Player, AI Assistant, фазы 1–10, definition of done |
| [`02-PROGRESS.md`](02-PROGRESS.md) | Трекер прогресса по фазам: что реализовано (shell-прототип), что в работе, что дальше |

## Связанные документы

- [`docs/08-mobile-web-migration/README.md`](../08-mobile-web-migration/README.md) — предшествующая миграция Android → Mobile Web (`frontends/mobile/`)
- [`docs/05-frontend/PLAYER_STATE.md`](../05-frontend/PLAYER_STATE.md) — состояние плеера (контракт, переиспользуется без изменений)
- [`docs/01-overview/PROJECT_STRUCTURE.md`](../01-overview/PROJECT_STRUCTURE.md) — место `frontends/mobile/` в проекте
- [`docs/DONT_DO.md`](../DONT_DO.md) — антипаттерны, не воспроизводить в десктопной оболочке
