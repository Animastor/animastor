# Project Structure: Animastor

```
/home/sureg/animastor/
├── README.md                                    # Документация проекта
├── docker-compose.yml                           # Оркестрация сервисов (postgres, redis, backend, gpu-hub, nginx)
│                                                 # Redis: persisted через volume redis-data:/data
│                                                 # GPU_TIMEOUT: 10 min
├── build-apk.sh                                 # Сборка Android APK
├── backend-rebuild.sh                           # Пересборка backend
├── front-backend-rebuild.sh                     # Пересборка frontend + backend
├── apk-build.sh                                 # Альтернативная сборка APK
├── workflow.json                                # Workflow JSON (bind mount)
├── master_margarita_demo.vbook                  # Демо-книга
├── local.properties                             # Свойства Android SDK
│
├── backend/                                     # Backend-сервер (Node.js/Express)
│   ├── Dockerfile                               # Контейнеризация backend
│   ├── package.json                             # Зависимости (express, ioredis, pg, sharp, и др.)
│   ├── test_cover.js                            # Генерация обложки (тест)
│   ├── config/
│   │   └── ai-assistant-profile.md              # Профиль AI-ассистента (системный промпт)
│   ├── ai/                                      # База знаний AI
│   │   ├── examples/                            # JSON-примеры для few-shot промптинга
│   │   │   ├── book_example.json                #   Пример структуры книги
│   │   │   ├── character_example.json           #   Пример персонажа
│   │   │   ├── cover_example.json               #   Пример обложки
│   │   │   ├── import_example.json              #   Пример импорта
│   │   │   ├── location_example.json            #   Пример локации
│   │   │   └── scene_example.json               #   Пример сцены
│   │   ├── rules/                               # Правила для AI
│   │   │   ├── general.md                       #   Общие правила
│   │   │   ├── import_rules.md                  #   Правила импорта
│   │   │   ├── json_rules.md                    #   Правила JSON-форматирования
│   │   │   ├── json_schema.md                   #   JSON Schema
│   │   │   ├── naming.md                        #   Соглашения именования
│   │   │   ├── extraction_rules.md              #   Правила извлечения сущностей
│   │   │   ├── edit_mode.md                     #   Правила редактирования
│   │   │   └── validation.md                    #   Правила валидации
│   │   └── skills/                              # Навыки AI (не используются в промптах)
│   │       ├── camera_language.md               #   Язык камеры
│   │       ├── composition.md                   #   Композиция кадра
│   │       ├── continuity.md                    #   Непрерывность
│   │       ├── directing.md                     #   Режиссура
│   │       ├── entity_extraction.md             #   Извлечение сущностей
│   │       ├── lighting.md                      #   Освещение
│   │       ├── prompt_engineering.md            #   Инженерия промптов
│   │       └── storyboard.md                    #   Сториборд
│   ├── scripts/
│   │   └── import-iu-json.mjs                   # Сценарий импорта IU JSON
│   ├── src/
│   │   ├── backend.cjs                          # [ENTRY] Точка входа, DI, монтирование
│   │   ├── startup-resume.js                    # Возобновление прерванных сессий при старте
│   │   ├── dependency-graph.js                  # Граф зависимостей (утилита)
│   │   ├── api/
│   │   │   └── runtime.js                       # API runtime-статуса
│   │   ├── audio/
│   │   │   ├── index.js                         # Экспорт audio-сервиса
│   │   │   └── audio-service.js                 # TTS-генерация, мерж аудио, padded text trim
│   │   ├── book/
│   │   │   ├── index.js                         # [CORE] Загрузка/сохранение книг (v2.1 multi-file)
│   │   │   └── lazy-book.js                     # [CORE] Ленивая загрузка draft-книги (v2.0)
│   │   |── config/
│   │   │   └── runtime-config.js                # Централизованная конфигурация
│   │   ├── helpers/
│   │   │   ├── redis-helpers.cjs                # Хелперы Redis (чанки, восстановление)
│   │   │   └── utils.cjs                        # Общие утилиты
│   │   ├── image/
│   │   │   ├── index.js                         # Экспорт image-сервиса
│   │   │   └── image-service.js                 # Генерация изображений IU
│   │   ├── orchestration/
│   │   │   ├── index.js                         # Экспорт оркестрации
│   │   │   ├── scene-orchestrator.js            # [CORE] Оркестратор сцен (layer-aware)
│   │   │   └── event-journal.js                 # Redis event journal (TTL 7 дней)
│   │   ├── routes/
│   │   │   ├── book-routes.cjs                  # REST API книг (CRUD, импорт, статус)
│   │   │   ├── generation-routes.cjs            # REST API генерации
│   │   │   ├── ai-routes.cjs                    # REST API AI-ассистента
│   │   │   └── debug-routes.cjs                 # REST API отладки
│   │   ├── runtime/
│   │   │   ├── index.js                         # [CORE] Экспорт runtime (v2.0, slim)
│   │   │   ├── runtime-loop.js                  # Heartbeat tick loop (5s)
│   │   │   ├── runtime-scheduler.js             # [CORE] Планировщик сцен (per-asset dispatch)
│   │   │   ├── runtime-persistence.js           # Персистентность runtime
│   │   │   ├── runtime-metrics.js               # Метрики runtime
│   │   │   ├── active-scenes-index.js           # Redis-индекс активных сцен
│   │   │   ├── scene-window.js                  # [CORE] Оконный менеджер генерации (v2.0 scope-aware)
│   │   │   ├── dispatch-engine.js               # [CORE] Диспетчер (lease/quota/CB)
│   │   │   ├── lease-manager.js                 # Управление арендой dispatch
│   │   │   ├── gpu-dispatcher.js                # [CORE] HTTP-клиент GPU Hub
│   │   │   ├── worker-health.js                 # Мониторинг здоровья воркеров
│   │   │   ├── reconciliation-engine.js         # Сверка stuck-сцен
│   │   │   ├── counter-reconciliation.js        # Сверка счетчиков backpressure
│   │   │   ├── retry-manager.js                 # Менеджер повторных попыток
│   │   │   ├── retention-manager.js             # Управление удержанием
│   │   │   ├── failure-taxonomy.js              # Таксономия ошибок
│   │   │   ├── circuit-breaker.js               # [LIVE] Размыкатель цепи (used by dispatch-engine)
│   │   │   ├── fairness-engine.js               # [LIVE] Предотвращение голодания (used by dispatch-engine)
│   │   │   ├── retry-budget-manager.js          # [LIVE] Бюджет повторных попыток (used by dispatch-engine)
│   │   │   ├── feedback-config.js               # Конфиг адаптивной обратной связи
│   │   │   └── feedback-recorder.js             # Запись сигналов обратной связи
│   │   │   # NB: 16 debug-only governance-модулей + dead api/runtime.js удалены 2026-06-27 (D.3/L1, 311f44a):
│   │   │   #     snapshot/priority/policy-engine/policy-simulator/workload-classifier/cost-estimator/
│   │   │   #     decision-trace/feedback-engine/governance-{health,metrics,sandbox,stability,validator}/
│   │   │   #     adaptation-controller/execution-semantics/failure-replay. runtime/: 37 → 21 модуль.
│   │   ├── services/
│   │   │   ├── agent-service.js                 # [CORE] AI-пайплайн (6 шагов)
│   │   │   ├── ai-loader.js                     # Загрузка базы знаний AI (TTL 1 мин)
│   │   │   ├── ai-service.js                    # Клиент OpenRouter/Nvidia API (+ refineDraft)
│   │   │   ├── audio-recovery.cjs               # [CORE] Периодическое восстановление аудио (5s)
│   │   │   ├── book-diff.cjs                    # Diff книг, dirty scene marking
│   │   │   ├── book-event-log.js                # [CORE] PostgreSQL журнал событий книги
│   │   │   ├── book-integrity.js                # Проверка целостности (orphan detection)
│   │   │   ├── book-source.js                   # [CORE] Канонический индекс сцен
│   │   │   ├── book-sync.js                     # Синхронизация JSON ↔ DB (scene_hash)
│   │   │   ├── chat-engine.cjs                  # [CORE] AI-чат (tool-based, режимы)
│   │   │   ├── chat-store.js                    # Хранилище чатов (сессии, топики, поиск)
│   │   │   ├── cleanup-service.cjs              # [CORE] Периодическая очистка, distributed locks
│   │   │   ├── context-builder.js               # Сборка контекста для AI
│   │   │   ├── encoding-detect.js               # Детекция кодировки
│   │   │   ├── gen-scope.js                     # [CORE] Область генерации + scopeBounds
│   │   │   ├── knowledge-base.js                # Загрузка ai/ файлов (не используется в prompts)
│   │   │   ├── layer-config.js                  # [CORE] Профили генерации (5 профилей)
│   │   │   ├── placeholder-audio.js             # [CORE] Генерация MP3-заглушек + PG sync
│   │   │   ├── scene-asset-registry.js          # [CORE] PostgreSQL реестр asset'ов сцены
│   │   │   ├── task-handler.cjs                 # [CORE] Обработчик callback'ов GPU
│   │   │   ├── txt-importer.js                  # [CORE] Импорт TXT (v3.0)
│   │   │   ├── waveform-service.js              # Вычисление waveform
│   │   │   └── window-generator.cjs             # [CORE] Фоновая оконная генерация
│   │   ├── state/
│   │   │   ├── index.js                         # Экспорт состояния
│   │   │   └── scene-state.js                   # [CORE] Dual state model (v2.0)
│   │   ├── storage/
│   │   │   ├── index.js                         # Экспорт хранилища
│   │   │   ├── asset-registry.js                # Устаревший Redis-реестр asset'ов
│   │   │   ├── filesystem-store.js              # Файловое хранилище
│   │   │   ├── manifest.js                      # Манифест файлов
│   │   │   └── postgres/
│   │   │       ├── database.js                  # Подключение к PG
│   │   │       ├── index.js                     # Экспорт PG
│   │   │       ├── schema.js                    # DDL (25+ таблиц)
│   │   │       └── repositories/
│   │   │           ├── index.js                 # Экспорт репозиториев
│   │   │           ├── book-repo.js             # Репозиторий книг
│   │   │           ├── book-source-repo.js      # Репозиторий источников
│   │   │           ├── cache-repo.js            # Репозиторий кэша
│   │   │           ├── chat-repo.js             # Репозиторий чатов
│   │   │           ├── chat-session-repo.js     # Репозиторий сессий чатов
│   │   │           ├── events-repo.js           # Репозиторий событий
│   │   │           ├── gen-session-repo.js      # Репозиторий сессий генерации
│   │   │           ├── iu-repo.js               # Репозиторий IU
│   │   │           ├── scene-assets-repo.js     # Репозиторий asset'ов сцены
│   │   │           └── task-repo.js             # Репозиторий задач
│   │   ├── utils/
│   │   │   └── scene-hash.js                    # Хэширование сцен
│   │   └── video/
│   │       ├── index.js                         # Экспорт video-сервиса
│   │       ├── video-service.js                 # Видеогенерация (LTX)
│   │       └── video-merge.js                   # Мерж видео + аудио
│   └── tests/
│       ├── asset-state.test.js                  # Тесты состояния asset'ов
│       ├── book-event-log.test.js               # Тесты лога событий
│       ├── book-integrity.test.js               # Тесты целостности
│       ├── book-source.test.js                  # Тесты источника книги
│       ├── book-sync.test.js                    # Тесты синхронизации
│       ├── chat-store.test.js                   # Тесты хранилища чатов
│       ├── gen-scope.test.js                    # Тесты области генерации
│       ├── layer-config.test.js                 # Тесты конфигурации слоёв
│       ├── scene-asset-registry.test.js         # Тесты реестра asset'ов
│       ├── scene-hash.test.js                   # Тесты хэширования
│       ├── scene-state.test.js                  # Тесты состояния сцены
│       ├── scope-filter.test.js                 # Тесты фильтрации области
│       ├── scope-slide.test.js                  # Тесты слайда области
│       └── video-workflows.test.js              # Тесты video workflow
│
├── frontend/                                    # Android-приложение (Kotlin/Gradle)
│   ├── build.gradle.kts                         # Корневой билд
│   ├── settings.gradle.kts                      # Настройки Gradle
│   ├── gradle.properties                        # Свойства Gradle
│   ├── gradlew                                  # Gradle wrapper
│   ├── docker-compose.yml                       # Docker для сборки
│   ├── build-apk.sh                             # Сборка APK
│   └── app/
│       ├── build.gradle.kts                     # Билд приложения (compileSdk=35, minSdk=24, targetSdk=35)
│       ├── proguard-rules.pro                   # ProGuard
│       └── src/main/
│           ├── AndroidManifest.xml              # Манифест Android
│           ├── java/com/example/animastor/
│           │   ├── model/BookItem.kt            # Модель книги
│           │   ├── network/RetrofitClient.kt    # HTTP-клиент (Retrofit, OkHttp logging)
│           │   ├── repository/
│           │   │   ├── BackendApi.kt            # [CORE] Определение API-методов
│           │   │   ├── Repository.kt            # Слой репозитория (LruCache 50MB + SimpleDiskCache 256MB)
│           │   │   ├── BookModels.kt            # Модели данных книги
│           │   │   ├── AiChatModels.kt          # Модели AI-чата
│           │   │   ├── ChatSessionModels.kt     # Модели сессий чата
│           │   │   ├── ChunkListResponse.kt     # Ответ списка чанков
│           │   │   ├── ChunkResponse.kt         # Ответ чанка
│           │   │   ├── DiffModels.kt            # Модели diff
│           │   │   ├── GenerateResponse.kt      # Ответ генерации
│           │   │   ├── LayerConfig.kt           # Конфигурация слоёв
│           │   │   ├── LoadVbookResponse.kt     # Ответ загрузки vbook
│           │   │   ├── ReorderModels.kt         # Модели реордера
│           │   │   ├── SlideWindowResponse.kt   # Ответ слайд-окна
│           │   │   ├── StoryboardResponse.kt    # Ответ сториборда
│           │   │   ├── TimelineModels.kt        # Модели таймлайна
│           │   │   └── WorkerCounts.kt          # Счетчики воркеров
│           │   └── ui/
│           │       ├── MainActivity.kt          # [ENTRY] Single-activity
│           │       ├── PlayFragment.kt          # Фрагмент плеера
│           │       ├── EditFragment.kt          # Фрагмент редактора
│           │       ├── LibraryFragment.kt       # Фрагмент библиотеки
│           │       ├── FileFragment.kt          # Фрагмент файлов
│           │       ├── NavigateFragment.kt      # Фрагмент навигации
│           │       ├── SettingsFragment.kt      # Фрагмент настроек
│           │       ├── AiAssistantFragment.kt   # Фрагмент AI-ассистента
│           │       ├── GenerateViewModel.kt     # [CORE] VM генерации
│           │       ├── PlaybackViewModel.kt     # [CORE] VM плеера (preloadAhead=3)
│           │       ├── AssistantMode.kt         # Режимы ассистента
│           │       ├── ChatAdapter.kt           # Адаптер чата
│           │       ├── ChatHistoryManager.kt    # Менеджер истории чата
│           │       ├── ChatMessage.kt           # Модель сообщения чата
│           │       ├── ChatTopic.kt             # Тема чата
│           │       ├── PositionManager.kt       # Менеджер позиции
│           │       ├── SharedPositionManager.kt  # Глобальное состояние позиции
│           │       ├── WindowTriggerManager.kt   # [CORE] Глобальный триггер окон генерации
│           │       ├── SceneAudioPlayer.kt      # [CORE] Плеер аудио (ExoPlayer/Media3)
│           │       ├── WaveformView.kt          # Waveform View
│           │       └── adapter/BookAdapter.kt   # Адаптер списка книг
│           └── res/                             # Ресурсы Android (layouts, drawables, values, strings)
│               ├── layout/                      #   fragment_play, fragment_edit, fragment_library и др.
│               ├── drawable/                    #   Иконки (ic_play, ic_pause, и др.)
│               ├── values/                      #   strings.xml, colors.xml, themes.xml
│               └── values-ru/                   #   Русская локализация strings.xml
│
├── worker/                                      # GPU-воркеры (ESM modules)
│   ├── start-video.sh                           # Запуск video-воркера
│   ├── start-worker.sh                          # Запуск worker
│   ├── mc.sh                                    # Миграция/конфигурация
│   ├── bootstrap-video.sh                       # Bootstrap video-воркера
│   ├── bootstrap-light.sh                       # Bootstrap (light)
│   ├── fix-nodes-audio.sh                       # Фикс audio nodes
│   ├── fix-nodes-image.sh                       # Фикс image nodes
│   ├── worker/
│   │   ├── package.json                         # Зависимости (node-fetch)
│   │   └── worker.js                            # [CORE] GPU-воркер ComfyUI (ESM, multi-image)
│   └── image/worker/
│       ├── package.json                         # Зависимости image-воркера
│       └── package-lock.json
│
├── gpu-hub/                                     # Центральный диспетчер GPU
│   ├── package.json                             # Зависимости (express, ioredis, cors)
│   ├── Dockerfile                               # Контейнеризация
│   ├── server.js                                # [ENTRY] Сервер GPU Hub
│   └── gpu-hub.js                               # [CORE] Логика диспетчера (requeue, heartbeat)
│
├── proxy/                                       # Обратный прокси
│   ├── docker-compose.yml                       # Docker для nginx
│   └── conf/default.conf                        # Конфигурация nginx
│
├── site/                                        # Статическая landing page
│   └── index.html                               # HTML-страница
│
├── data/                                        # Данные (runtime)
│   ├── books/                                   # Книги на диске (multi-file format)
│   ├── output/                                  # Сгенерированные файлы (MP3, PNG, MP4)
│   └── workflows/                               # Шаблоны ComfyUI (.json)
│
├── docs/                                        # Документация (актуализируется по коммитам)
│   ├── SYSTEM_OVERVIEW.md                       # Обзор системы
│   ├── PROJECT_STRUCTURE.md                     # Структура проекта
│   ├── ARCHITECTURE.md                          # Архитектура
│   ├── ARCHITECTURAL_DEBT.md                    # Технический долг
│   ├── ARCHITECTURE_REVIEW.md                   # Architecture review
│   ├── DATA_FLOW.md                             # Потоки данных
│   ├── CONNECTORS.md                            # Интеграции
│   ├── GENERATORS.md                            # Генераторы
│   ├── AGENTS.md                                # AI-агенты (6 шагов)
│   ├── WORKFLOWS.md                             # Workflow система
│   ├── DEPENDENCY_ANALYSIS.md                   # Анализ зависимостей
│   ├── LLM_AUDIT_CONTEXT.md                     # Контекст для аудита LLM
│   ├── PLAYER_AUDIT.md                          # Аудит плеера
│   └── architectural-essence.md                 # Архитектурная эссенция
│
└── backups/                                     # Бекапы (.tar.gz)
```
