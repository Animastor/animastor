# Project Structure: Animastor

```bash
/home/sureg/animastor/
├── README.md                                    # Документация проекта
├── docker-compose.yml                           # Оркестрация сервисов (postgres, redis, backend, gpu-hub, nginx)
│                                                 # Redis: persisted через volume redis-data:/data
│                                                 # GPU_TIMEOUT: 10 min
├── build-apk.sh                                 # Сборка Android APK
├── backend-rebuild.sh                           # Пересборка backend
├── front-backend-rebuild.sh                     # Пересборка frontend + backend
├── apk-build.sh                                 # Альтернативная сборка APK
├── data/
│   ├── books/                                   # Книги на диске (multi-file format v2.2)
│   │   └── <bookId>/
│   │       ├── manifest.json                    #   метаданные
│   │       ├── book.json                        #   структура (chapters_order)
│   │       ├── bible.json                       #   библеистика (country, epoch)
│   │       ├── characters.json                  #   персонажи
│   │       ├── locations.json                   #   локации (отдельно от bible)
│   │       ├── voices.json                      #   голоса персонажей (отдельно от bible)
│   │       └── chapters/
│   │           ├── ch-cover.json                #   обложка (всегда первая)
│   │           ├── ch-prologue.json             #   пролог (опционально)
│   │           ├── ch-00000001.json             #   главы
│   │           └── ...
│   ├── output/<buildId>/                        # Сгенерированные файлы (MP3, PNG, MP4)
│
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── ai/                                      # Вся конфигурация AI-системы
│   │   ├── ai-assistant-profile.md              # Профиль AI-ассистента (чат)
│   │   ├── workflows/                           # Шаблоны ComfyUI (.json)
│   │   │   └── img-qwen-image, tts-qwen-*, video-ltx-1p..4p
│   │   ├── connectors/                          # Декларативные описания задач
│   │   │   └── conn-*.json
│   │   ├── profiles/                            # Программные профили сборки промптов
│   │   │   └── image/{default,qwen-image}.json
│   │   ├── examples/                            # JSON-примеры для few-shot
│   │   │   ├── book_example.json
│   │   │   ├── character_example.json
│   │   │   ├── cover_example.json
│   │   │   ├── import_example.json
│   │   │   ├── location_example.json
│   │   │   └── scene_example.json
│   │   ├── rules/                               # Правила (md, SYSTEM_PROMPTS)
│   │   └── skills/                              # Скиллы промптинга моделей (md)
│   ├── scripts/
│   │   ├── audit-scenes.js                      # Аудит длительности/покрытия сцен
│   │   ├── dryrun-visuals-iu.js                 # Сухой прогон визуалов
│   │   └── import-iu-json.mjs                   # Импорт IU JSON
│   ├── src/
│   │   ├── backend.cjs                          # [ENTRY] Точка входа, DI, монтирование
│   │   ├── startup-resume.js                    # Возобновление прерванных сессий
│   │   ├── dependency-graph.js                  # Граф зависимостей
│   │   ├── config/
│   │   │   └── runtime-config.js                # Централизованная конфигурация
│   │   ├── routes/
│   │   │   ├── book/                            # [DECOMPOSED] Маршруты книг
│   │   │   │   ├── agent-routes.cjs             #   AI-агент (bootstrap, next-window, статус)
│   │   │   │   ├── chunks-routes.cjs            #   Чанки
│   │   │   │   ├── core-routes.cjs              #   CRUD книг
│   │   │   │   ├── generation-routes.cjs        #   Генерация
│   │   │   │   ├── import-routes.cjs            #   Импорт
│   │   │   │   └── recovery-routes.cjs          #   Восстановление
│   │   │   ├── ai-routes.cjs                    # AI-чат
│   │   │   ├── generation-routes.cjs            # Генерация (общие endpoints)
│   │   │   ├── debug-routes.cjs                 # Отладка
│   │   │   ├── connector-routes.cjs             # Коннекторы (13 эндпоинтов)
│   │   │   └── workflow-routes.cjs              # Workflow (4 эндпоинта)
│   │   ├── services/
│   │   │   ├── agent/                           # [DECOMPOSED] AI-пайплайн
│   │   │   │   ├── bootstrap.js                 #   Первое окно
│   │   │   │   ├── pipeline-runner.js           #   Запуск пайплайна
│   │   │   │   ├── pipeline-steps.js            #   Шаги 0–5
│   │   │   │   ├── coreference.js               #   Заглушка (удалён из пайплайна)
│   │   │   │   ├── ai-caller.js                 #   Вызов AI с ретраями
│   │   │   │   ├── text-utils.js                #   Текстовые утилиты
│   │   │   │   └── visual-utils.js              #   Утилиты визуалов
│   │   │   ├── agent-service.js                 # [BARREL] Экспорт + window-generator
│   │   │   ├── agent-prompts.js                 # System prompt'ы (все шаги)
│   │   │   ├── ai-service.js                    # Клиент AI API
│   │   │   ├── ai-loader.js                     # Загрузка базы знаний (TTL 1 мин)
│   │   │   ├── audio-recovery.cjs               # Recovery аудио (per-scene, on-demand)
│   │   │   ├── book-diff.cjs                    # Diff книг + dirty scene marking
│   │   │   ├── book-event-log.js                # PG журнал событий книги
│   │   │   ├── book-source.js                   # Канонический индекс сцен
│   │   │   ├── book-sync.js                     # Синхронизация JSON ↔ DB
│   │   │   ├── chat-engine.cjs                  # AI-чат (tool-based)
│   │   │   ├── cleanup-service.cjs              # Периодическая очистка
│   │   │   ├── encoding-detect.js               # Детекция кодировки
│   │   │   ├── gen-scope.js                     # Область генерации
│   │   │   ├── knowledge-base.js                # Загрузка ai/ файлов
│   │   │   ├── layer-config.js                  # Профили генерации (5)
│   │   │   ├── placeholder-audio.js             # MP3-заглушки
│   │   │   ├── prompt-dependency-registry.js    # Реестр зависимостей промптов
│   │   │   ├── scene-asset-registry.js          # PG реестр asset'ов
│   │   │   ├── source-coverage.js               # Покрытие исходного текста
│   │   │   ├── source-coverage-audit.js         # Аудит покрытия
│   │   │   ├── task-handler.cjs                 # Обработчик callback'ов GPU
│   │   │   ├── txt-importer.js                  # Импорт TXT
│   │   │   ├── waveform-service.js              # Waveform
│   │   │   ├── window-generator.cjs             # Фоновая оконная генерация
│   │   │   └── workflow-manager.js              # Менеджер workflow
│   │   ├── audio/                               # [DECOMPOSED] Аудио-подсистема
│   │   │   ├── index.js
│   │   │   └── audio-service.js
│   │   ├── image/                               # [DECOMPOSED] Изображения
│   │   │   ├── index.js
│   │   │   ├── image-service.js
│   │   │   ├── prompt-builder.js                #   Сборка визуальных промптов (по профилю)
│   │   │   ├── assembly-profile.js              #   Резолвер программных профилей сборки
│   │   │   ├── connector-utils.js               #   Инъекция в ComfyUI-воркфлоу
│   │   │   ├── iu-processor.js                  #   Обработка IU
│   │   ├── video/                               # [DECOMPOSED] Видео
│   │   │   ├── index.js
│   │   │   ├── video-service.js
│   │   │   └── video-merge.js
│   │   ├── book/                                # [DECOMPOSED] Книги
│   │   │   ├── index.js
│   │   │   └── lazy-book/
│   │   │       ├── index.js                     #   [CORE] Загрузка/сохранение
│   │   │       ├── create.js                    #   Создание книги
│   │   │       ├── parse.js                     #   Парсинг
│   │   │       ├── appearance.js                #   Фрагментация описаний внешности
│   │   │       ├── chapter-utils.js             #   Утилиты глав
│   │   │       ├── metadata.js                  #   Метаданные
│   │   │       └── scene-utils.js               #   Утилиты сцен
│   │   ├── orchestration/
│   │   │   ├── index.js
│   │   │   ├── orchestrator.js                  # [CORE] Фасад (11 команд, M5)
│   │   │   ├── scene-orchestrator.js            # [CORE] Исполнитель (layer-aware)
│   │   │   ├── scene-callbacks.js               #   Колбэки завершения
│   │   │   ├── scene-restoration.js             #   Восстановление сцен
│   │   │   ├── scene-utils.js                   #   Утилиты
│   │   │   └── event-journal.js                 #   Redis event journal
│   │   ├── runtime/                             # [SLIM v2.1, 21 модуля]
│   │   │   ├── index.js                         # [CORE] Экспорт (11 модулей)
│   │   │   ├── runtime-loop.js                  # Heartbeat (5s)
│   │   │   ├── runtime-scheduler.js             # [CORE] Планировщик (per-asset)
│   │   │   ├── dispatch-engine.js               # [CORE] Диспетчер (lease/quota/CB)
│   │   │   ├── scene-window.js                  # [CORE] Оконный менеджер
│   │   │   ├── active-scenes-index.js           # Redis-индекс
│   │   │   ├── lease-manager.js                 # Аренда dispatch
│   │   │   ├── gpu-dispatcher.js                # HTTP-клиент GPU Hub
│   │   │   ├── worker-health.js                 # Мониторинг воркеров
│   │   │   ├── reconciliation-engine.js         # Сверка stuck-сцен
│   │   │   ├── counter-reconciliation.js        # Сверка backpressure
│   │   │   ├── retry-manager.js                 # Повторные попытки
│   │   │   ├── retention-manager.js             # Удержание
│   │   │   ├── failure-taxonomy.js              # Таксономия ошибок
│   │   │   ├── circuit-breaker.js               # [LIVE] Размыкатель цепи
│   │   │   ├── fairness-engine.js               # [LIVE] Анти-голодание
│   │   │   ├── retry-budget-manager.js          # [LIVE] Бюджет ретраев

│   │   │   # NB: 16 dead governance-модулей удалены 2026-06-27 (D.3/L1, 311f44a)
│   │   ├── state/
│   │   │   ├── index.js
│   │   │   └── scene-state.js                   # [CORE] Dual state model
│   │   ├── storage/
│   │   │   ├── index.js
│   │   │   ├── asset-registry.js                # Redis-реестр (legacy)
│   │   │   ├── filesystem-store.js              # Файловое хранилище
│   │   │   ├── manifest.js                      # Манифест
│   │   │   └── postgres/
│   │   │       ├── database.js                  # Подключение
│   │   │       ├── schema.js                    # DDL (25+ таблиц)
│   │   │       └── repositories/
│   │   │           ├── book-repo.js
│   │   │           ├── book-source-repo.js
│   │   │           ├── cache-repo.js
│   │   │           ├── chat-repo.js
│   │   │           ├── chat-session-repo.js
│   │   │           ├── events-repo.js
│   │   │           ├── gen-session-repo.js
│   │   │           ├── iu-repo.js
│   │   │           ├── scene-assets-repo.js
│   │   │           └── task-repo.js
│   │   ├── utils/
│   │   │   ├── scene-title-utils.js             # Утилиты заголовков сцен
│   │   │   ├── scene-hash.js                    # Хэширование сцен
│   │   │   ├── character-identity.js            # Идентификация персонажей
│   │   │   └── string-utils.js                  # Строковые утилиты
│   │   └── workflows/
│   │       ├── index.js
│   │       ├── workflow-loader.js               # Загрузка JSON-шаблонов
│   │       ├── connector-loader.js              # Загрузка коннекторов
│   │       └── entity-schema.js                 # Схема сущностей
│   └── tests/
│       ├── asset-state.test.js
│       ├── book-diff-unit.test.js
│       ├── book-event-log.test.js
│       ├── book-source.test.js
│       ├── book-sync.test.js
│       ├── coreference-agent.test.js
│       ├── coreference-cleanup.test.js
│       ├── coreference-image.test.js
│       ├── gen-scope.test.js
│       ├── happy-path.test.js                   # 30+ тестов на lifecycle
│       ├── iu-progress-utils.test.js
│       ├── layer-config.test.js
│       ├── prompt-dependency-registry.test.js
│       ├── scene-asset-registry.test.js
│       ├── scene-hash.test.js
│       ├── scene-patch-utils.test.js
│       ├── scene-split.test.js                  # 21 тест на длительность/покрытие
│       ├── scene-state.test.js
│       ├── scope-filter.test.js
│       ├── scope-slide.test.js
│       ├── video-workflows.test.js
│       └── book-diff-unit.test.js               # (485 тестов всего, 0 failing)
│
├── worker/                                      # GPU-воркеры (ESM)
│   ├── worker/
│   │   ├── package.json
│   │   └── worker.js                            # [CORE] Polling → ComfyUI → result
│   ├── start-video.sh
│   ├── start-worker.sh
│   ├── mc.sh
│   ├── bootstrap-video.sh
│   ├── bootstrap-light.sh
│   ├── fix-nodes-audio.sh
│   └── fix-nodes-image.sh
│
├── gpu-hub/
│   ├── package.json
│   ├── Dockerfile
│   ├── server.js                                # [ENTRY]
│   └── gpu-hub.js                               # [CORE] Очереди, requeue, heartbeat
│
├── proxy/
│   ├── docker-compose.yml
│   └── conf/default.conf
│
├── frontends/
│   ├── website/
│   │   ├── index.html                       # Публичный сайт (animastor.in)
│   │   └── library/index.html               # Публичная Library (/library, без auth)
│   ├── app/                                 # Responsive веб-приложение (app.animastor.in)
│   │   └── src/
│   │       ├── layouts/                     # MobileShell / DesktopShell
│   │       ├── pages/                       # File, Generator, Player, Editor, Navigator…
│   │       ├── api/                         # /api/v1 (относительный base)
│   │       └── styles/
│   └── android/                             # Android-приложение (Kotlin, Gradle)
│       └── app/
│
├── docs/                                        # Документация
│   ├── 01-overview/
│   │   ├── SYSTEM_OVERVIEW.md
│   │   ├── SYSTEM_MAP.md
│   │   ├── ARCHITECTURE.md
│   │   ├── DATA_FLOW.md
│   │   └── PROJECT_STRUCTURE.md
│   ├── 02-orchestration/
│   │   ├── ORCHESTRATOR_LIFECYCLE.md
│   │   ├── ORCHESTRATOR_FACADE_PR.md
│   │   ├── M5_COMPETING_WRITERS.md
│   │   ├── REGENERATION_SYSTEM.md
│   │   └── STATE_WRITERS_MAP.md
│   ├── 03-audit/
│   │   ├── ARCHITECTURAL_AUDIT.md
│   │   ├── ARCHITECTURAL_AUDIT_TODO.md
│   │   ├── ARCHITECTURAL_DEBT.md
│   │   ├── CONFLICTING_SUBSYSTEMS.md
│   │   ├── DEPENDENCY_ANALYSIS.md
│   │   ├── DOCUMENTATION_AUDIT.md
│   │   └── PLAYER_AUDIT.md
│   ├── 04-planning/
│   │   ├── ROADMAP_6M.md
│   │   ├── WORKFLOW_ROADMAP.md
│   │   └── MIGRATION_PLAN.md
│   ├── 05-frontend/
│   │   ├── PROGRESS_HANDOFF.md
│   │   └── PLAYER_STATE.md
│   ├── 06-workflows/
│   │   ├── CONNECTOR_ARCHITECTURE.md
│   │   ├── CONNECTORS.md
│   │   ├── WORKFLOW_ARCHITECTURE.md
│   │   ├── WORKFLOW_ASSISTANT_VISION.md
│   │   └── WORKFLOWS.md
│   ├── 07-agents-and-generators/
│   │   ├── AGENTS.md
│   │   ├── COREFERENCE_RESOLUTION.md
│   │   ├── COREFERENCE_ARCHITECTURE_REVIEW.md
│   │   ├── COREFERENCE_TODO.md
│   │   ├── GENERATORS.md
│   │   ├── IMAGINATION_UNIT.md
│   │   ├── IMAGINATION_UNIT_VERIFICATION.md
│   │   └── VBOOK_GENERATION_COVERAGE_TODO.md
│   ├── 99-archive/                              # Устаревшие документы
│   ├── architectural-essence.md
│   └── CHANGELOG.md
│
├── docs/                                        # Документация (flat, legacy)
│   ├── README.md
│   ├── CHANGELOG.md
│   └── architectural-essence.md
│
└── backups/                                     # .tar.gz архивы
```
