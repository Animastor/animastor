# System Overview: Animastor

## Назначение проекта

Animastor — AI-powered animated storytelling platform. Система преобразует текстовые книги в мультимедийный опыт с аудионаррацией, изображениями и видео. Проект реализует конвейер от импорта текста до генерации анимационного видеоряда.

## Основные сценарии использования

1. **Импорт книги** — пользователь загружает TXT-файл или вводит текст; система через AI-агентов анализирует структуру, извлекает персонажей, локации, сцены.
2. **Просмотр и редактирование** — пользователь просматривает структуру книги (главы, сцены), редактирует метаданные, персонажей, локации.
3. **Генерация мультимедиа** — система последовательно генерирует аудио (TTS), изображения, видео для каждой сцены.
4. **Воспроизведение** — Android-приложение воспроизводит сгенерированный контент (аудио + видео) с навигацией по сценам.
5. **AI-ассистент** — чат с AI-моделью для помощи в написании и редактировании.

## Задачи, решаемые системой

- Извлечение структуры из неформатированного текста (главы, сцены).
- Идентификация и характеристика персонажей и локаций через AI.
- Разбиение повествования на визуальные единицы (кадры/IU).
- Генерация TTS-аудио с поддержкой диалогов (разные голоса).
- Генерация изображений для каждой визуальной единицы.
- Генерация видео через анимацию последовательностей изображений (LTX).
- Оркестрация пайплайна генерации с контролем состояния, очередями, повторными попытками.
- Управление жизненным циклом книги: импорт → AI-анализ → генерация → воспроизведение.

## Ключевые подсистемы

### Backend (Node.js/Express)
Центральный сервер API + оркестратор. Управляет состоянием книги, сценами, dispatching задач на GPU.

### Frontend (Android/Kotlin)
Мобильное приложение с bottom-навигацией: файлы, редактор, плеер, навигация, AI-ассистент.

### Orchestration Engine
Планировщик (tick-based), диспетчер (dispatch engine), оркестратор сцен (scene orchestrator). Управляет пайплайном AUDIO → IMAGE → VIDEO.

### Agent Service (AI Pipeline)
6-шаговый AI-пайплайн анализа текста: структура → персонажи → локации → сцены → units → визуальные промпты.

### GPU Hub (Node.js)
Центральный диспетчер задач на GPU. Принимает задачи от backend, ставит в Redis-очереди, распределяет по воркерам.

### Workers (Node.js + ComfyUI)
GPU-воркеры, выполняющие генерацию через ComfyUI: image (SD), audio (TTS), video (LTX).

### Workflow Loader
Загружает JSON-шаблоны ComfyUI из `/data/workflows/` и адаптирует их под конкретные задачи.

### Storage
- **PostgreSQL** — каноническое состояние (книги, сцены, assets, чаты, события, сессии агентов)
- **Redis** — runtime-состояние, очереди задач, heartbeat воркеров, кэш, активные сцены, dispatch-аренда
- **Filesystem** — файлы книг (JSON), аудио, изображения, видео

### AI Knowledge Base
Markdown-файлы правил, навыков и JSON-примеры для промптинга AI-моделей.

## Поток данных: от входа до результата

```
TXT / VBook
  │
  ▼
┌─────────────────┐
│  TXT Importer   │  → Декодирование, создание draft-книги
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Agent Service  │  → 6-шаговый AI-анализ (окнами по 3 сцены)
│  (bootstrap)    │  → Извлечение: структура, персонажи, локации,
└────────┬────────┘    сцены, IU, визуальные промпты
         │
         ▼
┌─────────────────┐
│  Scene State    │  → Инициализация состояния сцен
│  Orchestrator   │  → Добавление в active-scenes index
└────────┬────────┘
         │
    ╔══════════════════════════════════════════╗
    ║      Runtime Scheduler (tick 5s)         ║
    ║  ┌──────────┐  ┌─────────────┐          ║
    ║  │ Dispatch  │→│  Orchestrator│          ║
    ║  │ Engine    │  │  dispatch   │          ║
    ║  └─────┬────┘  └──────┬──────┘          ║
    ║        │              │                  ║
    ║  ┌─────┴──────────────┴──────────┐       ║
    ║  │    GPU Dispatcher              │       ║
    ║  └──────────────┬─────────────────┘       ║
    ╚═════════════════╪═════════════════════════╝
                      │ HTTP POST /task
                      ▼
              ┌──────────────┐
              │   GPU Hub    │ → Redis Queue
              └──────┬───────┘
                     │ poll
              ┌──────┴───────┐
              │   Worker     │ → ComfyUI → Результат (base64)
              └──────┬───────┘
                     │ POST /task/result
                     ▼
              ┌──────────────┐
              │ Task Handler │ → orchestrator.handle*Completed()
              └──────┬───────┘
                     │
              ┌──────┴───────┐
              │ Save Asset   │ → Filesystem (MP3, PNG, MP4)
              │ Register     │ → Registry (PostgreSQL + Redis)
              │ Update State │ → SceneState → AUDIO_READY / IMAGE_READY / VIDEO_READY
              └──────────────┘
```

## Список основных компонентов и их роли

| Компонент | Файл | Роль |
|-----------|------|------|
| Backend entry | `backend/src/backend.cjs` | Инициализация сервера, DI, монтирование роутов |
| Book routes | `backend/src/routes/book-routes.cjs` | REST API для книг, импорт, статус |
| AI routes | `backend/src/routes/ai-routes.cjs` | REST API для AI-ассистента |
| Generation routes | `backend/src/routes/generation-routes.cjs` | REST API для запуска генерации |
| Scene orchestrator | `backend/src/orchestration/scene-orchestrator.js` | Центральный оркестратор сцен |
| Runtime scheduler | `backend/src/runtime/runtime-scheduler.js` | Tick-based планировщик прогресса сцен |
| Dispatch engine | `backend/src/runtime/dispatch-engine.js` | Диспетчер с арендой/квотами/CB |
| GPU dispatcher | `backend/src/runtime/gpu-dispatcher.js` | HTTP-клиент для отправки задач в GPU Hub |
| Scene window | `backend/src/runtime/scene-window.js` | Оконный менеджер генерации сцен |
| Active scenes index | `backend/src/runtime/active-scenes-index.js` | Redis-индекс активных сцен |
| Audio service | `backend/src/audio/audio-service.js` | TTS-генерация, мерж аудио |
| Image service | `backend/src/image/image-service.js` | Генерация изображений IU |
| Video service | `backend/src/video/video-service.js` | Видеогенерация (LTX) |
| Video merge | `backend/src/video/video-merge.js` | Мерж видео + аудио через ffmpeg |
| Agent service | `backend/src/services/agent-service.js` | AI-пайплайн анализа текста |
| TXT importer | `backend/src/services/txt-importer.js` | Импорт и парсинг TXT |
| Window generator | `backend/src/services/window-generator.cjs` | Фоновая оконная генерация |
| Workflow loader | `backend/src/workflows/workflow-loader.js` | Загрузчик шаблонов ComfyUI |
| Workflow builders | `backend/src/workflows/*/` | Построители workflow под задачу |
| Task handler | `backend/src/services/task-handler.cjs` | Обработчик результатов GPU задач |
| Layer config | `backend/src/services/layer-config.js` | Профили генерации (audio/image/video) |
| Gen scope | `backend/src/services/gen-scope.js` | Область генерации (сцена/глава/книга) |
| GPU Hub | `gpu-hub/gpu-hub.js` | Диспетчер GPU-очередей |
| Worker | `worker/worker/worker.js` | GPU-воркер ComfyUI |
| Database | `backend/src/storage/postgres/` | PostgreSQL ORM |
| Runtime config | `backend/src/config/runtime-config.js` | Централизованная конфигурация |
| Event journal | `backend/src/orchestration/event-journal.js` | Аудит событий сцены |
| Circuit breaker | `backend/src/runtime/circuit-breaker.js` | Защита от каскадных отказов |
| Retry budget | `backend/src/runtime/retry-budget-manager.js` | Бюджет повторных попыток |
| Fairness engine | `backend/src/runtime/fairness-engine.js` | Предотвращение голодания сцен |
| Policy engine | `backend/src/runtime/policy-engine.js` | Политики диспетчеризации |
| Governance modules | `backend/src/runtime/governance-*.js` | Мониторинг стабильности и здоровья |
| AI Loader | `backend/src/services/ai-loader.js` | Загрузка правил/навыков для AI |
| Context builder | `backend/src/services/context-builder.js` | Построитель контекста для AI |
| Book load/save | `backend/src/book/` | Загрузка и сохранение книг |
| Lazy book | `backend/src/book/lazy-book.js` | Ленивая загрузка draft-книги |
| Placeholder audio | `backend/src/services/placeholder-audio.js` | Генерация заглушек аудио |
| Waveform service | `backend/src/services/waveform-service.js` | Вычисление waveform для плеера |
| Chat engine | `backend/src/services/chat-engine.cjs` | AI-чат ассистент |
| Scene state | `backend/src/state/scene-state.js` | Машина состояний сцены |
| Redis helpers | `backend/src/helpers/redis-helpers.cjs` | Хелперы Redis |
| PostgreSQL schema | `backend/src/storage/postgres/schema.js` | DDL схемы БД |
| Repositories | `backend/src/storage/postgres/repositories/` | Репозитории PG |
| Nginx proxy | `proxy/conf/default.conf` | Обратный прокси с SSL |
| Landing page | `site/index.html` | Статическая страница |
