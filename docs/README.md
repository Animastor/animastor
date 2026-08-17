# Документация Animastor

> **Структурирована по темам.** Интегрированы документы из `docs-claude/`.
> Статус: актуально на 28 июня 2026.

---

## 📖 Системный обзор — `01-overview/`

| Документ | Описание |
|---|---|
| [`ARCHITECTURE.md`](01-overview/ARCHITECTURE.md) | Архитектура backend: слои, компоненты, зависимости |
| [`SYSTEM_OVERVIEW.md`](01-overview/SYSTEM_OVERVIEW.md) | Обзор системы: сценарии, подсистемы, поток данных |
| [`DATA_FLOW.md`](01-overview/DATA_FLOW.md) | 10 сценариев: импорт → bootstrap → генерация → плеер |
| [`PROJECT_STRUCTURE.md`](01-overview/PROJECT_STRUCTURE.md) | Файловое дерево проекта с описанием каждого модуля |
| [`SYSTEM_MAP.md`](01-overview/SYSTEM_MAP.md) | **НОВЫЙ.** Детальная карта «как есть»: подсистемы, lifecycle, хранение, противоречия код/доки |

---

## 🔄 Оркестрация и жизненный цикл — `02-orchestration/`

| Документ | Описание |
|---|---|
| [`ORCHESTRATOR_LIFECYCLE.md`](02-orchestration/ORCHESTRATOR_LIFECYCLE.md) | **Единый Orchestrator:** анализ «как есть» + предлагаемая архитектура (Part 1+2). Обновлён с M5-прогрессом |
| [`REGENERATION_SYSTEM.md`](02-orchestration/REGENERATION_SYSTEM.md) | Система перегенерации: diff, dirty, version-based, dependency graph |
| [`ORCHESTRATOR_FACADE_PR.md`](02-orchestration/ORCHESTRATOR_FACADE_PR.md) | PR-описание ветки `feat/orchestrator-facade`: что, зачем, релизы A/B/C |
| [`M5_COMPETING_WRITERS.md`](02-orchestration/M5_COMPETING_WRITERS.md) | **M5 завершён.** 5 шагов сведения всех писателей к фасаду Orchestrator |
| [`STATE_WRITERS_MAP.md`](02-orchestration/STATE_WRITERS_MAP.md) | Карта всех мест, пишущих состояние сцены/ассетов (P1-P8, L1-L7, D1-D3) |

---

## 🔍 Аудиты — `03-audit/`

| Документ | Описание |
|---|---|
| [`ARCHITECTURAL_AUDIT.md`](03-audit/ARCHITECTURAL_AUDIT.md) | **НОВЫЙ.** Полный архитектурный аудит: C1-C4, M1-M5, L1-L3. Все критичные находки закрыты |
| [`CONFLICTING_SUBSYSTEMS.md`](03-audit/CONFLICTING_SUBSYSTEMS.md) | Аудит 4+ подсистем, конкурирующих за управление состоянием + целевая архитектура |
| [`DEPENDENCY_ANALYSIS.md`](03-audit/DEPENDENCY_ANALYSIS.md) | Анализ циклических зависимостей, сильных связностей, единых точек отказа |
| [`DOCUMENTATION_AUDIT.md`](03-audit/DOCUMENTATION_AUDIT.md) | **НОВЫЙ.** Аудит документации против кода: 25 документов, сквозные противоречия |
| [`PLAYER_AUDIT.md`](03-audit/PLAYER_AUDIT.md) | Аудит Android-плеера: архитектура, сетевая предзагрузка, кэширование |
| [`PLAYER_AUDIO_MASTER_TIMELINE.md`](03-audit/PLAYER_AUDIO_MASTER_TIMELINE.md) | **НОВЫЙ.** Аудит единой аудио-шкалы: reveal-гейт по позиции, unitId-seek, границы юнита, race first-frame/gate |
| [`PLAYER_AUDIO_MASTER_TIMELINE_TODO.md`](03-audit/PLAYER_AUDIO_MASTER_TIMELINE_TODO.md) | **НОВЫЙ.** TODO-трекер аудита audio master timeline (этапы 1-7) |
| [`ARCHITECTURAL_DEBT.md`](03-audit/ARCHITECTURAL_DEBT.md) | Технический долг: известные проблемы (обновлён: orchestrator 173 строки, rate limit 500, 3 governance LIVE) |
| [`ARCHITECTURAL_AUDIT_TODO.md`](03-audit/ARCHITECTURAL_AUDIT_TODO.md) | Исторический TODO-трекер аудита (все Phase 1-6 ✅ выполнены) |

---

## 📋 Планы и дорожные карты — `04-planning/`

| Документ | Описание |
|---|---|
| [`MIGRATION_PLAN.md`](04-planning/MIGRATION_PLAN.md) | План перехода к единому Orchestrator: 12 шагов, 4 релиза (A/B/C/D) |
| [`ROADMAP_6M.md`](04-planning/ROADMAP_6M.md) | **НОВЫЙ.** Полугодовая дорожная карта: неделя → месяц → 3 месяца → долгосрок |
| [`WORKFLOW_ROADMAP.md`](04-planning/WORKFLOW_ROADMAP.md) | Roadmap Workflow Manager: стадии 1-5 (бэкенд, фронтенд, параметры, dev mode, AI) |
| [`GOLDEN_BOOK_EVOLUTION.md`](04-planning/GOLDEN_BOOK_EVOLUTION.md) | **Концепция «Эволюционное пахтание»:** Raw/Golden Books, Quality Delta, эволюционный цикл + честная критика (видение на будущее) |

---

## 📱 Фронтенд — `05-frontend/`

| Документ | Описание |
|---|---|
| [`PROGRESS_HANDOFF.md`](05-frontend/PROGRESS_HANDOFF.md) | **НОВЫЙ.** GPU Progress: SSE-клиент, монотонность, stuck-детект, поллер (F1-F7 ✅) |
| [`PLAYER_STATE.md`](05-frontend/PLAYER_STATE.md) | Состояние плеера после регенерации: soft refresh, `needsContentRefresh`, buildId |
| [`PLAYER_STATE_MACHINE_DESIGN.md`](05-frontend/PLAYER_STATE_MACHINE_DESIGN.md) | **НОВЫЙ.** Дизайн state machine Player: 7 состояний, один источник истины `selectedUnit` (T6) |

---

## ⚙️ Workflows и коннекторы — `06-workflows/`

| Документ | Описание |
|---|---|
| [`WORKFLOWS.md`](06-workflows/WORKFLOWS.md) | Workflow система: типы, загрузчик, builders, жизненный цикл |
| [`WORKFLOW_ARCHITECTURE.md`](06-workflows/WORKFLOW_ARCHITECTURE.md) | Архитектура workflow (v1.0.0): три слоя (schema/connector/workflow) |
| [`CONNECTOR_ARCHITECTURE.md`](06-workflows/CONNECTOR_ARCHITECTURE.md) | Архитектура коннекторов: entity-schema, связки, совместимость (v1.2.0) |
| [`CONNECTORS.md`](06-workflows/CONNECTORS.md) | Connector System: обзор, файлы, API, добавление нового workflow |
| [`WORKFLOW_ASSISTANT_VISION.md`](06-workflows/WORKFLOW_ASSISTANT_VISION.md) | Видение AI Workflow Assistant (будущее) |

---

## 🤖 Агенты и генераторы — `07-agents-and-generators/`

| Документ | Описание |
|---|---|
| [`AGENTS.md`](07-agents-and-generators/AGENTS.md) | AI-агенты: 6-шаговый пайплайн, шаги, хранение, база знаний |
| [`GENERATORS.md`](07-agents-and-generators/GENERATORS.md) | Генераторы: audio/image/video/AI/placeholder, общий слой абстракции |

---

## 📱 Миграция Android → Mobile Web — `08-mobile-web-migration/`

| Документ | Описание |
|---|---|
| [`README.md`](08-mobile-web-migration/README.md) | Обзор раздела + основное правило проекта (веб-версия = Android по дизайну/UX) |
| [`01-MIGRATION-STRATEGY.md`](08-mobile-web-migration/01-MIGRATION-STRATEGY.md) | Общая стратегия переноса Android UI на Mobile Web |
| [`02-DESIGN-PRESERVATION-PRINCIPLES.md`](08-mobile-web-migration/02-DESIGN-PRESERVATION-PRINCIPLES.md) | Принципы сохранения дизайна/расположения/сценариев |
| [`03-MOBILE-WEB-ARCHITECTURE.md`](08-mobile-web-migration/03-MOBILE-WEB-ARCHITECTURE.md) | Предлагаемая архитектура `frontends/mobile/` |
| [`04-MAPPING-TABLES.md`](08-mobile-web-migration/04-MAPPING-TABLES.md) | Таблицы Screen→Page, Component→Web Component, токены `cinema_*`, API, i18n |
| [`05-SCREEN-IMPLEMENTATION-ORDER.md`](08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md) | План переноса экранов (простые → сложные) |
| [`06-RISKS-AND-ALTERNATIVES.md`](08-mobile-web-migration/06-RISKS-AND-ALTERNATIVES.md) | Компоненты высокого риска + альтернативы. Экран Play — детально |

---

## 🖥 Миграция Mobile Web → Desktop — `09-desktop-migration/`

| Документ | Описание |
|---|---|
| [`README.md`](09-desktop-migration/README.md) | Обзор раздела + ключевое решение (десктоп внутри `frontends/mobile/`, не `frontends/main`) |
| [`01-MIGRATION-PLAN.md`](09-desktop-migration/01-MIGRATION-PLAN.md) | Полный план: десктопный шелл, Editor/Generator/Player workspace, Assistant, фазы 1–10 |
| [`02-PROGRESS.md`](09-desktop-migration/02-PROGRESS.md) | Трекер прогресса: shell-прототип сделан, Editor в работе |

---

## 🗂 База знаний (корень `docs/`)

| Документ | Описание |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | Журнал изменений проекта |
| [`DONT_DO.md`](DONT_DO.md) | **Запрещённые изменения:** что ломало систему в прошлом |
| [`architectural-essence.md`](architectural-essence.md) | **Философия проекта:** книга как процесс последовательного чтения |

---

## 🗄 Архив — `99-archive/`

Устаревшие документы, сохранённые для истории:

| Документ | Почему в архиве |
|---|---|
| [`LLM_AUDIT_CONTEXT.md`](99-archive/LLM_AUDIT_CONTEXT.md) | Содержал устаревшие числа (rate limit 100, lease TTL). Заменён `SYSTEM_MAP.md` + `ARCHITECTURAL_AUDIT.md` |
| [`ARCHITECTURE_REVIEW.md`](99-archive/ARCHITECTURE_REVIEW.md) | Момент-во-времени ревью; многие пункты устарели/исправлены |
| [`TODO_IMMEDIATE.md`](99-archive/TODO_IMMEDIATE.md) | Все H.0-H.9, Д.0-Д.3 ✅ выполнены. Закрыты C1-C4, M1-M5, §5.1 |
| [`TODO_TODAY.md`](99-archive/TODO_TODAY.md) | Все задачи S.1, D.1, D.3 ✅ выполнены |
| [`REGENERATION_SYSTEM_TODO.md`](99-archive/REGENERATION_SYSTEM_TODO.md) | Все R0-R19 ✅ выполнены. v2 и v3 внедрены |

---

## Структура документации

```
docs/
├── README.md                          ← вы здесь
├── CHANGELOG.md                       ← история изменений
├── DONT_DO.md                         ← анти-паттерны
├── architectural-essence.md           ← философия
│
├── 01-overview/                       ← системный обзор
│   ├── ARCHITECTURE.md
│   ├── SYSTEM_OVERVIEW.md
│   ├── DATA_FLOW.md
│   ├── PROJECT_STRUCTURE.md
│   └── SYSTEM_MAP.md                  ← НОВЫЙ (из docs-claude/01)
│
├── 02-orchestration/                  ← оркестрация
│   ├── ORCHESTRATOR_LIFECYCLE.md
│   ├── REGENERATION_SYSTEM.md
│   ├── ORCHESTRATOR_FACADE_PR.md
│   ├── M5_COMPETING_WRITERS.md
│   └── STATE_WRITERS_MAP.md
│
├── 03-audit/                          ← аудиты
│   ├── ARCHITECTURAL_AUDIT.md         ← НОВЫЙ (из docs-claude/02)
│   ├── CONFLICTING_SUBSYSTEMS.md
│   ├── DEPENDENCY_ANALYSIS.md
│   ├── DOCUMENTATION_AUDIT.md         ← НОВЫЙ (из docs-claude/05)
│   ├── PLAYER_AUDIT.md
│   ├── ARCHITECTURAL_DEBT.md
│   └── ARCHITECTURAL_AUDIT_TODO.md
│
├── 04-planning/                       ← планы
│   ├── MIGRATION_PLAN.md
│   ├── ROADMAP_6M.md
│   ├── WORKFLOW_ROADMAP.md
│   └── GOLDEN_BOOK_EVOLUTION.md        ← концепция «Эволюционное пахтание» (видение)
│
├── 05-frontend/                       ← фронтенд
│   ├── PROGRESS_HANDOFF.md            ← НОВЫЙ (из docs-claude/PROGRESS_FRONTEND_HANDOFF)
│   └── PLAYER_STATE.md
│
├── 06-workflows/                      ← workflows и коннекторы
│   ├── WORKFLOWS.md
│   ├── WORKFLOW_ARCHITECTURE.md
│   ├── CONNECTOR_ARCHITECTURE.md
│   ├── CONNECTORS.md
│   └── WORKFLOW_ASSISTANT_VISION.md
│
├── 07-agents-and-generators/          ← AI-агенты и генераторы
│   ├── AGENTS.md
│   └── GENERATORS.md
│
├── 08-mobile-web-migration/           ← миграция Android → Mobile Web (историческая: m.animastor.in → app.animastor.in)
│   ├── README.md
│   ├── 01-MIGRATION-STRATEGY.md
│   ├── 02-DESIGN-PRESERVATION-PRINCIPLES.md
│   ├── 03-MOBILE-WEB-ARCHITECTURE.md
│   ├── 04-MAPPING-TABLES.md
│   ├── 05-SCREEN-IMPLEMENTATION-ORDER.md
│   └── 06-RISKS-AND-ALTERNATIVES.md
│
├── 09-desktop-migration/             ← миграция Mobile Web → Desktop
│   ├── README.md
│   ├── 01-MIGRATION-PLAN.md
│   └── 02-PROGRESS.md
│
└── 99-archive/                        ← устаревшие документы
    ├── LLM_AUDIT_CONTEXT.md
    ├── ARCHITECTURE_REVIEW.md
    ├── TODO_IMMEDIATE.md
    ├── TODO_TODAY.md
    └── REGENERATION_SYSTEM_TODO.md
```

---

## Что интегрировано из `docs-claude/`

| Исходный файл | Куда интегрирован | Статус |
|---|---|---|
| `01_System_Map.md` | `01-overview/SYSTEM_MAP.md` | ✅ Новый документ |
| `02_Claude_Audit.md` | `03-audit/ARCHITECTURAL_AUDIT.md` | ✅ Новый + статусы закрытых проблем |
| `03_Orchestrator.md` | `02-orchestration/ORCHESTRATOR_LIFECYCLE.md` (частично) | ✅ Дополняет существующий |
| `04_Migration_Plan.md` | `04-planning/MIGRATION_PLAN.md` | ✅ Существующий обновлён |
| `05_Documentation_Audit.md` | `03-audit/DOCUMENTATION_AUDIT.md` | ✅ Новый документ |
| `06_Roadmap.md` | `04-planning/ROADMAP_6M.md` | ✅ Существующий обновлён |
| `PROGRESS_FRONTEND_HANDOFF.md` | `05-frontend/PROGRESS_HANDOFF.md` | ✅ Новый документ |
