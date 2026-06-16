# Project Structure: Animastor

```
/home/sureg/animastor/
├── README.md                                    # Документация проекта
├── docker-compose.yml                           # Оркестрация сервисов (postgres, redis, backend, gpu-hub, nginx)
├── build-apk.sh                                 # Сборка Android APK
├── backend-rebuild.sh                           # Пересборка backend
├── front-backend-rebuild.sh                     # Пересборка frontend + backend
├── master_margarita_demo.vbook                  # Демо-книга
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
│   │   │   ├── scene_example.json               #   Пример сцены
│   │   │   └── master_margarita_demo/           #   Демо-данные "Мастер и Маргарита"
│   │   ├── rules/                               # Правила для AI
│   │   │   ├── general.md                       #   Общие правила
│   │   │   ├── import_rules.md                  #   Правила импорта
│   │   │   ├── json_rules.md                    #   Правила JSON-форматирования
│   │   │   ├── json_schema.md                   #   JSON Schema
│   │   │   ├── naming.md                        #   Соглашения именования
│   │   │   ├── extraction_rules.md              #   Правила извлечения сущностей
│   │   │   ├── edit_mode.md                     #   Правила редактирования
│   │   │   └── validation.md                    #   Правила валидации
│   │   └── skills/                              # Навыки AI
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
│   │   ├── startup-resume.js                    # Возобновление прерванных сессий
│   │   ├── dependency-graph.js                  # Граф зависимостей (утилита)
│   │   ├── api/
│   │   │   └── runtime.js                       # API runtime-статуса
│   │   ├── audio/
│   │   │   ├── index.js                         # Экспорт audio-сервиса
│   │   │   └── audio-service.js                 # TTS-генерация, мерж аудио
│   │   ├── book/
│   │   │   ├── index.js                         # Экспорт book-сервиса
│   │   │   └── lazy-book.js                     # Ленивая загрузка draft-книги
│   │   ├── config/
│   │   │   └── runtime-config.js                # Централизованная конфигурация
│   │   ├── helpers/
│   │   │   ├── redis-helpers.cjs                # Хелперы Redis (чанки, восстановление)
│   │   │   └── utils.cjs                        # Общие утилиты
│   │   ├── image/
│   │   │   ├── index.js                         # Экспорт image-сервиса
│   │   │   └── image-service.js                 # Генерация изображений IU
│   │   ├── orchestration/
│   │   │   ├── index.js                         # Экспорт оркестрации
│   │   │   ├── scene-orchestrator.js            # [CORE] Оркестратор сцен
│   │   │   └── event-journal.js                 # Redis event journal
│   │   ├── routes/
│   │   │   ├── book-routes.cjs                  # REST API книг (CRUD, импорт, статус)
│   │   │   ├── generation-routes.cjs            # REST API генерации
│   │   │   ├── ai-routes.cjs                    # REST API AI-ассистента
│   │   │   └── debug-routes.cjs                 # REST API отладки
│   │   ├── runtime/
│   │   │   ├── index.js                         # Экспорт runtime
│   │   │   ├── runtime-loop.js                  # Heartbeat tick loop
│   │   │   ├── runtime-scheduler.js             # [CORE] Планировщик сцен (tick 5s)
│   │   │   ├── runtime-persistence.js           # Персистентность runtime
│   │   │   ├── runtime-metrics.js               # Метрики runtime
│   │   │   ├── active-scenes-index.js           # Redis-индекс активных сцен
│   │   │   ├── scene-window.js                  # Оконный менеджер генерации
│   │   │   ├── dispatch-engine.js               # [CORE] Диспетчер (lease/quota/CB)
│   │   │   ├── lease-manager.js                 # Управление арендой dispatch
│   │   │   ├── gpu-dispatcher.js                # HTTP-клиент GPU Hub
│   │   │   ├── worker-health.js                 # Мониторинг здоровья воркеров
│   │   │   ├── reconciliation-engine.js         # Сверка stuck-сцен
│   │   │   ├── counter-reconciliation.js        # Сверка счетчиков backpressure
│   │   │   ├── retry-manager.js                 # Менеджер повторных попыток
│   │   │   ├── retention-manager.js             # Управление удержанием
│   │   │   ├── failure-taxonomy.js              # Таксономия ошибок
│   │   │   ├── failure-replay.js                # Воспроизведение ошибок
│   │   │   ├── snapshot-manager.js              # Менеджер снепшотов
│   │   │   ├── circuit-breaker.js               # [CORE] Размыкатель цепи
│   │   │   ├── priority-manager.js              # Приоритезация сцен
│   │   │   ├── fairness-engine.js               # [CORE] Предотвращение голодания
│   │   │   ├── retry-budget-manager.js          # [CORE] Бюджет повторных попыток
│   │   │   ├── policy-engine.js                 # [CORE] Оценка политик
│   │   │   ├── policy-simulator.js              # Симулятор политик
│   │   │   ├── workload-classifier.js           # Классификация нагрузки
│   │   │   ├── cost-estimator.js                # Оценка стоимости GPU
│   │   │   ├── decision-trace.js                # Трассировка решений
│   │   │   ├── feedback-engine.js               # Адаптивная обратная связь
│   │   │   ├── governance-health.js             # Мониторинг здоровья
│   │   │   ├── governance-metrics.js            # Метрики управления
│   │   │   ├── governance-sandbox.js            # Песочница политик
│   │   │   ├── governance-stability.js          # Мониторинг стабильности
│   │   │   ├── governance-validator.js          # Валидация политик
│   │   │   ├── adaptation-controller.js         # Адаптивное управление
│   │   │   └── execution-semantics.js           # Семантика выполнения
│   │   ├── services/
│   │   │   ├── agent-service.js                 # [CORE] AI-пайплайн (6 шагов)
│   │   │   ├── ai-loader.js                     # Загрузка базы знаний AI
│   │   │   ├── ai-service.js                    # Клиент OpenRouter API
│   │   │   ├── audio-recovery.cjs               # Восстановление аудио
│   │   │   ├── book-diff.cjs                    # Diff книг (редактирование)
│   │   │   ├── book-event-log.js                # Лог событий книги
│   │   │   ├── book-integrity.js                # Проверка целостности книги
│   │   │   ├── book-source.js                   # Управление источниками книги
│   │   │   ├── book-sync.js                     # Синхронизация книги
│   │   │   ├── chat-engine.cjs                  # AI-чат ассистент
│   │   │   ├── chat-store.js                    # Хранилище чатов
│   │   │   ├── cleanup-service.cjs              # Периодическая очистка
│   │   │   ├── context-builder.js               # Сборка контекста для AI
│   │   │   ├── encoding-detect.js               # Детекция кодировки
│   │   │   ├── gen-scope.js                     # Область генерации
│   │   │   ├── layer-config.js                  # Профили генерации
│   │   │   ├── placeholder-audio.js             # Генерация MP3-заглушек
│   │   │   ├── scene-asset-registry.js          # Реестр asset'ов сцены
│   │   │   ├── task-handler.cjs                 # [CORE] Обработчик callback'ов GPU
│   │   │   ├── txt-importer.js                  # [CORE] Импорт TXT
│   │   │   ├── waveform-service.js              # Вычисление waveform
│   │   │   └── window-generator.cjs             # Фоновая оконная генерация
│   │   ├── state/
│   │   │   ├── index.js                         # Экспорт состояния
│   │   │   └── scene-state.js                   # [CORE] Машина состояний сцены
│   │   ├── storage/
│   │   │   ├── index.js                         # Экспорт хранилища
│   │   │   ├── asset-registry.js                # Регистр asset'ов
│   │   │   ├── filesystem-store.js              # Файловое хранилище
│   │   │   ├── manifest.js                      # Манифест файлов
│   │   │   └── postgres/
│   │   │       ├── database.js                  # Подключение к PG
│   │   │       ├── index.js                     # Экспорт PG
│   │   │       ├── schema.js                    # DDL (15+ таблиц)
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
│   │       ├── video-service.js                 # Видеогенерация
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
│       ├── build.gradle.kts                     # Билд приложения
│       ├── proguard-rules.pro                   # ProGuard
│       └── src/main/
│           ├── AndroidManifest.xml              # Манифест Android
│           ├── java/com/example/animastor/
│           │   ├── model/BookItem.kt            # Модель книги
│           │   ├── network/RetrofitClient.kt    # HTTP-клиент (Retrofit)
│           │   ├── repository/
│           │   │   ├── BackendApi.kt            # [CORE] Определение API-методов
│           │   │   ├── Repository.kt            # Слой репозитория
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
│           │       ├── PlaybackViewModel.kt     # [CORE] VM плеера
│           │       ├── AssistantMode.kt         # Режимы ассистента
│           │       ├── ChatAdapter.kt           # Адаптер чата
│           │       ├── ChatHistoryManager.kt    # Менеджер истории чата
│           │       ├── ChatMessage.kt           # Модель сообщения чата
│           │       ├── ChatTopic.kt             # Тема чата
│           │       ├── PositionManager.kt       # Менеджер позиции
│           │       ├── SceneAudioPlayer.kt      # [CORE] Плеер аудио (ExoPlayer)
│           │       ├── WaveformView.kt          # Waveform View
│           │       └── adapter/BookAdapter.kt   # Адаптер списка книг
│           └── res/                             # Ресурсы Android (layouts, drawables, values)
│
├── worker/                                      # GPU-воркеры
│   ├── worker/
│   │   ├── package.json                         # Зависимости (node-fetch)
│   │   └── worker.js                            # [CORE] GPU-воркер (ComfyUI)
│   └── image/worker/
│       ├── package.json                         # Зависимости image-воркера
│       └── worker.js                            # Image-воркер
│
├── gpu-hub/                                     # Центральный диспетчер GPU
│   ├── package.json                             # Зависимости (express, ioredis, cors)
│   ├── Dockerfile                               # Контейнеризация
│   ├── server.js                                # [ENTRY] Сервер GPU Hub
│   └── gpu-hub.js                               # [CORE] Логика диспетчера
│
├── proxy/                                       # Обратный прокси
│   ├── docker-compose.yml                       # Docker для nginx
│   └── conf/default.conf                        # Конфигурация nginx
│
├── site/                                        # Статическая landing page
│   └── index.html                               # HTML-страница
│
├── data/                                        # Данные (runtime)
│   ├── books/                                   # Книги на диске
│   ├── output/                                  # Сгенерированные файлы (MP3, PNG, MP4)
│   └── workflows/                               # Шаблоны ComfyUI (.json)
│
├── docs/                                        # Документация
│   └── architectural-essence.md                 # Архитектурная эссенция
│
└── backups/                                     # Бекапы (.tar.gz)
```
