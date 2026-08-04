# Changelog

All notable changes to Animastor are documented here.

---

## [Unreleased] — 2026-08-01

### Removed

- **`location.cinematic_space` — мёртвый дубликат `name` убран полностью**
  (`backend/src/book/lazy-book/create.js`,
  `backend/src/image/prompt-builder.js`,
  `backend/ai/rules/locations.md`,
  `frontend/.../EditFragment.kt`, `frontend/.../BookModels.kt`,
  `frontend/.../values/strings.xml`, `frontend/.../values-ru/strings.xml`,
  `backend/tests/coreference-image.test.js`, `backend/tests/book-metadata-patch.test.js`):
  - **Проблема:** `cinematic_space` всегда был равен `name` — `locations.md` запрещал LLM
    его выдавать, а `create.js` писал его с фоллбэком `loc.cinematic_space || loc.name`.
    Смысловой нагрузки ноль: поле не несло информации сверх имени.
  - **Фикс:** `create.js` больше не пишет `cinematic_space`; `resolveLocationFromPrompt`
    матчит локацию по `id` + `description` (английской, категория C) вместо
    `cinematic_space`; поле убрано из модели `Location` (BookModels.kt), редактора
    локаций (EditFragment.kt) и строк `field_cinematic_space`; фикстуры тестов очищены.
  - **Строка запрета лишних полей в `locations.md` удалена целиком** (вместе с
    `default_mood` — тоже давно мёртвое поле): LLM больше не видит имена dead-полей
    (`visual_style`, `cinematic_space`, `default_mood`) ни в одном системном промпте —
    упоминание несуществующих полей в запрете только «заражает» модель.
  - Матчинг не деградировал: description теперь содержит кинематографическое описание
    (проверено тестом `matches location via transliteration word overlap` — score ≥ 0.25
    по id и description).

- **`location.visual_style` — мёртвый код убран полностью**
  (`backend/src/image/prompt-builder.js`,
  `backend/src/services/prompt-dependency-registry.js`,
  `frontend/.../EditFragment.kt`, `frontend/.../BookModels.kt`,
  `frontend/.../values/strings.xml`, `frontend/.../values-ru/strings.xml`,
  `backend/tests/coreference-image.test.js`, `docs/02-orchestration/ORCHESTRATION.md`):
  - **Проблема:** поле `visual_style` у локаций — dead code. `locations.md` запрещает LLM
    его выдавать (`do NOT add extra fields like visual_style, cinematic_space, default_mood`),
    `create.js` не пишет его в `locations.json` (CHANGELOG 2026-07: «убраны поля-пустышки»).
    Но оставались хвосты: `prompt-builder.js` читал `loc.visual_style` (ветка никогда не
    срабатывала — чистое dead code в сборке image-промпта), а редактор локаций показывал
    всегда пустое поле «визуальный стиль».
  - **Фикс:** удалены `loc.visual_style`-ветка из `buildImagePrompt` (оставлен только
    `loc.description`), поле `visual_style` из `Location` (BookModels.kt), inputCard
    «визуальный стиль» из вкладки «Локации» (EditFragment.kt), строки `field_visual_style`
    (values/values-ru), комментарий `bible.locations[locId].visual_style` из реестра
    зависимостей и `[location_visual_style]` из формулы промпта в ORCHESTRATION.md,
    фикстуры `visual_style` из тестов. Упоминание `visual_style` также убрано из
    промпт-правила `locations.md` (строка запрета лишних полей) — LLM больше не видит
    это поле ни в одном системном промпте.
  - **НЕ тронут `cinematic_space`:** он жив — `create.js` пишет его с фоллбэком
    `loc.name`, а `resolveLocationFromPrompt` использует для fuzzy-матчинга локации.

### Changed

- **Дефолтные `country`/`epoch` книги проброшены агенту разбивки сцен; редактор сцены получил поля `env.country`/`env.epoch`**
  (`backend/ai/rules/scenes.md`,
  `backend/src/services/agent/pipeline-steps.js`,
  `backend/src/services/agent/pipeline-runner.js`,
  `backend/src/services/agent/bootstrap.js`,
  `frontend/.../EditFragment.kt`,
  `frontend/.../BookModels.kt`,
  `docs/07-agents-and-generators/SYSTEM_PROMPT_RULES_MIGRATION.md`):
  - **Проблема 1 (backend):** правило в `scenes.md` гласило «пиши `country`/`epoch`
    только когда они отличаются от дефолта книги», но дефолт книги (`bible.country` /
    `bible.epoch`) агенту не передавался — он должен был угадывать его из окна текста.
  - **Фикс 1:** новый плейсхолдер `%BOOK_DEFAULT%` в `scenes.md` (секция «Book default
    setting»). `stepCreateScenes` принимает `bookDefault` и подставляет его в промпт;
    когда дефолт неизвестен — пишет «not specified — infer from the text».
    `pipeline-runner.js` строит `bookDefault` из `options.country`/`options.epoch`
    (оба вызова `stepCreateScenes` — включая retry по coverage); `bootstrap.js`
    передаёт `country`/`epoch` из `structure` (шаг 0) в оба вызова `runPipeline`
    (первое окно + последующие). `processCachedScenes` не вызывает `stepCreateScenes`
    (сцены приходят из кеша) — там проброс не нужен.
  - **Проблема 2 (frontend):** в редакторе сцены (селектор → вкладка «Сцена» → секция
    «Локация») не было полей `env.country`/`env.epoch` — задать флешбек/другую страну
    на уровне сцены вручную было нельзя (только глобально, вкладка «Мир»).
  - **Фикс 2:** поля `env.country` и `env.epoch` добавлены в `buildSceneFields`
    (список env-ключей), `readField` и `fieldLabel`; `EnvironmentData` в
    `BookModels.kt` получил поля `country`/`epoch`. Бэкенд уже был готов:
    `PATCH env.X → location.environment.X` (`core-routes.cjs`) и строки
    `field_country`/`field_epoch` уже существовали.

- **`location.description` теперь всегда на английском (категория C)**
  (`backend/ai/rules/locations.md`,
  `backend/tests/lang-instruction.test.js`,
  `docs/07-agents-and-generators/LANGUAGE_ARCHITECTURE.md`):
  - **Проблема:** `locations.md` требовал `description` в `%LANGUAGE%` (русский для
    `language=ru`), но `description` инжектится **verbatim** в финальные промпты:
    `prompt-builder.js` (image) и `video-workflows.js` (video). Русский текст попадал
    в English-only модели (LTX 2.3, Qwen Image).
  - **Фикс:** `description` переведён в категорию C — мандат
    `description` values MUST be written in ENGLISH (вместе с `environment.*`).
    `name` остаётся user-facing (`%LANGUAGE%`). В редакторе пользователь видит
    английское описание — документированный трейд-офф (см. LANGUAGE_ARCHITECTURE.md,
    раздел 7 — будущая кнопка перевода).
  - Fallback `create.js` (`${loc.name} — location from the source text`) уже был
    на английском — не менялся.

- **Отдельный этап Scene Enrichment удалён — обогащение перенесено в разбивку сцен**
  (`backend/ai/rules/scenes.md`,
  `backend/src/services/agent/pipeline-steps.js`,
  `backend/src/services/agent/pipeline-runner.js`,
  `backend/src/services/agent-prompts.js`,
  `backend/ai/rules/enrich_scenes.md` → удалён,
  `backend/tests/lang-instruction.test.js`):
  - **Зачем:** `stepEnrichScenes()` дублировал работу шага разбивки: title и location.id
    уже генерирует `stepCreateScenes()` (scenes.md: title REQUIRED, location.id REQUIRED),
    а env-override по первым 500 символам текста сцены давал слабый сигнал без контекста
    (сезон/погода часто задаются несколькими сценами раньше). Убран лишний LLM-проход
    (~1 вызов на окно) и риск замены хорошего title на худший по 500 символам.
  - **`scenes.md`:** добавлена секция «Scene environment — override the location's global
    template»: агент разбивки получает глобальные шаблоны локаций (уже были в контексте)
    и для каждой сцены пишет `location.environment` только для отличающихся полей
    (правило «только переопределения», перенесено из enrich_scenes.md; значения —
    ENGLISH, country/epoch — только при отличии от дефолта книги).
  - **`pipeline-steps.js`:** `stepEnrichScenes` удалён; `stepCreateScenes` нормализует
    `location.environment` (только известные поля, непустые значения) и логирует
    `env.override=N/len` — метрика срабатывания override.
  - **`pipeline-runner.js`:** вызовы `stepEnrichScenes` удалены из `runPipeline`
    и `processCachedScenes` (fallback-сцены: title через `extractSceneTitle`, location null
    обрабатывается `resolveSceneLocation` — деградация приемлема на аварийном пути).
  - **`agent-prompts.js`:** `enrich_scenes` убран из RULES, `enriching_scenes` из
    PROGRESS_STAGES.
  - **`lang-instruction.test.js`:** мандат ENGLISH для `environment` проверяется на
    `scenes.md` (вместо удалённого enrich_scenes.md).
  - **Документация:** AGENTS.md, SYSTEM_MAP.md, DATA_FLOW.md, ARCHITECTURE.md,
    SYSTEM_OVERVIEW.md, SCENE_PIPELINE.md, LANGUAGE_ARCHITECTURE.md,
    SYSTEM_PROMPT_RULES_MIGRATION.md, COREFERENCE_RESOLUTION.md, DIALOGUE_TTS_PIPELINE.md
    — упоминания enrichment-шага заменены на environment-override в шаге 3.
  - Принцип: каждый LLM-проход должен окупаться; информация, получаемая в существующем
    вызове, не требует отдельного этапа.

### Added

- **Архитектура языков: язык книги как параметр генерации**
  (`docs/07-agents-and-generators/LANGUAGE_ARCHITECTURE.md`,
  `backend/src/services/agent-prompts.js`,
  `backend/src/services/agent/pipeline-steps.js`,
  `backend/src/services/agent/pipeline-runner.js`,
  `backend/src/services/agent/bootstrap.js`):
  - **Правило (RFC, docs/LANGUAGE_ARCHITECTURE.md):** все данные, используемые как вход
    AI-моделей (image.prompt, video.action, паспорта персонажей, environment, voice/TTS
    инструкции), всегда хранятся на английском. Локализуются только user-facing поля
    (scene.title, имена, описания) — по параметру `language` из book.json. Категории
    A (контент/verbatim — не переводится), B (пользовательские — локализуются),
    C (AI-facing — English). Исключение: текст TTS (audio.full_text) — на языке книги.
  - **`agent-prompts.js`:** новые хелперы — `buildLangInstruction(lang)` (значение для
    плейсхолдера `%LANGUAGE%`, напр. `Russian (ru)`), `resolveBookLanguage(draft)`
    (book.language → defaults.language → detectLanguage(sourceText) → 'ru').
  - **`ai/rules/*.md`:** плейсхолдер `%LANGUAGE%` расставлен **точечно** у user-facing
    полей UI-правил (structure: author/title/части/главы; characters: name/description/
    traits; locations: name/description; scenes: title; enrich_scenes: title), а GPU-поля
    внутри них (characters.appearance, locations.environment, enrich.environment)
    получили явный мандат `MUST be written in ENGLISH`. GPU-facing правила (visuals,
    storyboard_polish, video_action_*, passport_reconciliation) — фиксированная
    `Result language: English (en)`; `voice_generation.md` — English для инструкции голоса
    + `TTS output language: %LANGUAGE%` для маркера «Native <Lang> pronunciation».
  - **`pipeline-steps.js`:** 6 текстовых шагов (structure, characters, locations,
    scenes, enrich_scenes, voice_generation) принимают `language` и заменяют плейсхолдер
    `%LANGUAGE%` при сборке промпта (`.replace`). Визуальные шаги (visuals, polish,
    reconcile) параметр не получают — их выход всегда English.
  - **`pipeline-runner.js`:** `runPipeline` и `processCachedScenes` читают
    `options.language` (default 'ru') и пробрасывают в шаги.
  - **`bootstrap.js`:** `resolveBookLanguage(draft)` на входе обоих бутстрапов
    (первое + последующие окна, cached scenes) → `language` в options.
  - Никаких каталогов примеров на каждый язык — KISS, новые языки добавляются
    без изменения кода.
  - Тесты проходят, syntax check OK.

### Fixed

- **Фантомные статусы на экране Generator: зелёный 100% бар давно завершённых задач при открытии страницы**
  (`frontends/mobile/src/state/generateStore.ts`,
  `frontend/app/src/main/java/com/example/animastor/ui/GenerateViewModel.kt`):
  - **Проблема:** при открытии экрана Generator иногда на несколько секунд появлялся
    зелёный прогресс-бар 100% для задачи, завершённой ранее (например, аудио из прошлого
    запуска), затем он исчезал и начинал отображаться прогресс реально активной генерации
    (например, изображений).
  - **Причина:** бэкенд `/progress-panel` намеренно держит недавно завершённые задачи
    ~30с (TERMINAL_RETENTION_MS) и может отдавать активную задачу с готовыми ассетами
    как done — это нужно для показа состояния «Готово». Но клиентский
    `computeProgressRows` (идентичный порт на web и Android) считал ЛЮБОЙ done-ряд,
    увиденный впервые, «только что завершённым» и показывал его зелёным 100% баром 10с
    (COMPLETED_TASK_DISPLAY_MS). На свежем открытии страницы клиент не знал, что задача
    завершилась в ПРОШЛОЙ сессии, и флешил её как свежую. Существующий new-gen gate
    закрывал только флеш сразу после старта новой генерации с этой страницы.
  - **Фикс (клиент, web + Android зеркально):** STALE-DONE GATE в `addFromServer` —
    done-ряд отображается только если задача началась в ТЕКУЩЕЙ сессии просмотра:
    если сессия не стартовала (`timerStartedAt <= 0`) или `started_at` задачи раньше
    старта сессии (с допуском 3с на рассинхрон часов клиент/сервер), ряд пропускается
    ДО записи в ready-floor/completedAt. На открытии страницы показываются только
    активные процессы; зелёный «Done» остаётся только для задач, завершившихся на
    глазах пользователя. Строго отфильтрованные панели уходят в Hidden без финализации
    (SUCCESS/refresh не срабатывают ложно).
  - `tsc --noEmit` + `vite build` — OK.

- **Генерация обложки не запускалась для современных книг (mobile web vs Android расхождение)**
  (`backend/src/routes/book/generation-routes.cjs`,
  `backend/src/routes/book/chunks-routes.cjs`,
  `backend/src/routes/book/progress-panel.cjs`,
  `backend/src/book/index.js`,
  `backend/src/services/chat-engine.cjs`,
  `backend/src/services/source-coverage-audit.js`,
  `backend/tests/generation-routes.test.js`):
  - **Проблема:** при генерации изображений выбранной сцены, если обложка книги отсутствует, её
    генерация не запускалась: не появлялась отдельная строка статуса/прогресса обложки на экране
    «Генератор». Расхождение с Android (там обложка генерировалась) объясняется форматом книги:
    современные lazy-book главы (chapter-utils.js/create.js) хранят id в поле `chapter_id`, а
    legacy parse.js-главы — в поле `chapter`.
  - **Причина:** cover check в `/regenerate` читал только `coverCh.chapter` → для современных книг
    `coverChapterId = undefined` → обложка добавлялась в dirty scenes с `chapter_id: undefined` →
    `targetsForType` отфильтровывал сцену без chapter_id → задача для обложки вообще не создавалась.
    Android выглядел «работающим», потому что тестировался на книгах legacy-формата с полем `chapter`.
  - **Фикс (бэкенд — единое поведение для всех клиентов):** нормализация поля id главы
    `chapter_id ?? chapter` во всех местах чтения глав книги: cover check `/regenerate`,
    cover-подсчёт в `chunks-routes` (assets-state scope), `resolveLabels` в progress-panel (метки
    сцен, включая Cover), `collectScenes`/`collectSceneList` (book/index.js), контекст позиции в
    chat-engine, source-coverage-audit.
  - 2 новых regression-теста (modern `chapter_id` + legacy `chapter`); 723 теста проходят.

- **Кнопка «Генератор» в нижней навигации: зелёная индикация SUCCESS больше не зависает навсегда**
  (`frontends/mobile/src/state/generateStore.ts`,
  `frontends/mobile/src/app/AppShell.tsx`):
  - **Проблема:** после завершения генерации зелёная индикация (пульс 12с → сплошной
    зелёный 10с) иногда оставалась навсегда и сбрасывалась только при повторном
    открытии экрана «Генератор».
  - **Причина:** web-порт скопировал Android-воркараунд `updateNavIconStatus`
    (пере-применение статуса на переключении вкладок, нужное там из-за того, что
    Material Components теряет кастомный tint/pulse при re-layout). В вебе CSS-пульс
    при навигации не теряется, но `rearmSuccessStatusTimer` при каждом переключении
    вкладки перезапускал 22-секундный таймер авто-сброса, продлевая зелёный индикатор
    бесконечно. Плюс единственный `setTimeout` мог задерживаться/теряться в фоновой
    вкладке.
  - **Фикс:** авто-сброс SUCCESS→IDLE привязан к метке времени `successSince`
    (момент перехода в SUCCESS), а не к «сейчас» при каждом arm — плюс
    self-healing watchdog (интервал 1с) возвращает иконку в IDLE в течение ~1с после
    окончания окна 22с, даже если таймер был задержан браузером. Эффект re-arm на
    смене маршрута убран из `AppShell` (в вебе пульс не теряется при навигации).
    Дополнительно: в ветке `computeProgressRows` «нет воркеров» статус RUNNING
    сбрасывается в IDLE, если генерация завершилась, пока страница была закрыта
    (иконка не остаётся пульсировать с пустым прогрессом).
  - `tsc --noEmit` + `vite build` — OK.

---

## [Unreleased] — 2026-07-31

### Added

- **Scene Character Overrides — перекрытие паспортов персонажей на уровне сцены**
  (`frontend/.../EditFragment.kt`, `frontend/.../BookModels.kt`,
  `backend/src/services/prompt-dependency-registry.js`,
  `backend/src/workflows/video/video-workflows.js`,
  `backend/tests/scene-passport-patch.test.js`):
  - **Паттерн:** тот же принцип, что у локаций — у сцены появилось поле
    `passport: { <charId>: { base_appearance, detailed_appearance, clothing_base,
    clothing_details, video_tokens } }`. При генерации `resolvePassport()` берёт
    перекрытие сцены с наивысшим приоритетом; неперекрытые поля остаются из
    глобального паспорта персонажа.
  - **`prompt-dependency-registry.js`:** `scene.passport` добавлен в `SCENE_FIELDS`
    (layers image + video, без audio) — изменение перекрытия помечает сцену на
    перегенерацию image+video.
  - **`video-workflows.js`:** `buildVideoPrompt` читает `scene.passport[id].video_tokens`
    с приоритетом над глобальным `passport.video_tokens` персонажа.
  - **Frontend (вкладка «Сцена» селектора):**
    - Таб разделён на логические секции: **Общие** (chapter_id, chapter_title, scene_id,
      scene_title, type, style) → **Персонажи** (participants + перекрытия) →
      **Локация** (location.id, env.*).
    - В секции «Персонажи» — блоки **«Перекрытия персонажей»**: поле `character id`
      + 5 полей паспорта. Блок считается использованным, когда заполнен ID **и** хотя
      бы одно поле — тогда ниже авто-добавляется следующий пустой блок; всегда остаётся
      один свободный; лишние пустые схлопываются; количество заполненных блоков
      ограничено числом участников сцены (`participants`).
    - Сохранение: ключи `passport.<charId>.<field>` уходят **отдельным** PATCH-запросом
      **без `unit_id`** (основной PATCH с `unit_id` маршрутизирует поля в юнит);
      diff против текущих перекрытий сцены, очищенные поля отправляются как `''`
      и становятся `null` на сервере (фоллбэк на глобальный паспорт); оптимистичное
      локальное обновление без перезагрузки.
  - **`BookModels.kt`:** `Scene.passport: Map<String, CharPassport>?`.
  - 7 новых тестов (PATCH-флоу, bookDiff dirty layers, resolvePassport override/fallback);
    687 тестов проходят, frontend `compileDebugKotlin` OK.

- **Система локаций: глобальный `environment` как fallback + редактор локаций на фронте**
  (`backend/src/image/prompt-builder.js`,
  `backend/src/workflows/video/video-workflows.js`,
  `backend/ai/rules/locations.md`,
  `backend/ai/rules/enrich_scenes.md`,
  `backend/src/services/agent/pipeline-steps.js`,
  `backend/src/book/lazy-book/create.js`,
  `backend/src/routes/book/core-routes.cjs`,
  `backend/src/services/prompt-dependency-registry.js`,
  `frontend/.../BookModels.kt`,
  `frontend/.../EditFragment.kt`,
  `frontend/.../BackendApi.kt`,
  `frontend/.../Repository.kt`,
  `frontend/.../strings.xml`, `frontend/.../values-ru/strings.xml`):
  - **Паттерн:** у каждой локации в `locations.json` появился глобальный `environment`
    (time, season, lighting, weather, mood, atmosphere) — шаблон типичного состояния.
    При генерации промпта он работает как фоллбэк, а `scene.location.environment`
    перекрывает его **по-полю** (тот же принцип, что с паспортами персонажей).
  - **`prompt-builder.js` / `video-workflows.js`:** мёрж `locations[locId].environment`
    + `scene.location.environment` на этапе чтения промпта (read-only, дешёвый).
  - **`locations.md`:** агент извлекает `name` + `environment` локаций.
  - **`enrich_scenes.md`:** правило «писать только переопределения» — если поле сцены
    совпадает с шаблоном локации, оно опускается (система подставит фоллбэк).
  - **`pipeline-steps.js`:** `buildLocationsContext()` показывает агенту дефолтный
    environment каждой локации (в 4 шагах пайплайна).
  - **`create.js`:** локации сохраняют `name` + `environment` (бэкфилл имени для
    существующих локаций без него).
  - **`core-routes.cjs`:** новый `PATCH /api/v1/book/:bookId/locations/:locationId`
    с `setDeep`, `bookDiff`-reconcile и bump версий затронутых сцен — изменение
    шаблона локации перегенерирует image+video всех её сцен.
  - **`prompt-dependency-registry.js`:** label `bible.locations` уточнён (включает
    `environment` локаций).
  - **Frontend:**
    - `BookModels.kt` — `Location.environment: EnvironmentData?`, `EnvironmentData.season`,
      удалено мёртвое `default_mood`.
    - `EditFragment.kt` — вкладка «Локации»: **name жирным**, секция «Окружение»
      с 6 полями (time/season/lighting/weather/mood/atmosphere), сохранение по каждой
      локации через `patchLocation` (ключи `loc.<id>.*`), оптимистичный апдейт
      с корректной очисткой полей (`'' → null`).
    - `BackendApi.kt` / `Repository.kt` — метод `patchLocation`.
    - Строки: добавлены `field_environment/time/season/lighting/weather/mood/atmosphere`,
      удалён `field_default_mood`.
  - 3 новых теста на фоллбэк environment; 676 тестов проходят, frontend
    `compileDebugKotlin` OK.

---

## [Unreleased] — 2026-07-29

### Fixed

- **AI Editor mode: сырые `<tool_call>` теги в чате + пустой ответ при tool calls**
  (`backend/src/routes/ai-routes.cjs`,
  `frontend/.../AiAssistantFragment.kt`,
  `frontend/.../AiChatModels.kt`,
  `frontend/.../ChatMessage.kt`):
  - **Проблема:** AI-модели при вызове `edit_book` возвращали `content: null`
    и `<tool_call>` маркеры. Фронтенд отображал пустую строку или сырые
    `tool_call>` теги. `edit_book` выполнялся, но пользователь не видел ни
    результата, ни ошибки.
  - **Фикс (backend):** стриппинг `<tool_call>` тегов из reply; при пустом
    content генерируется понятное сообщение (`✅ Changes applied: N patch(es)`
    или `⚠️ Edit error: ...`). Устранена двойная валидация `applyPatches`.
  - **Фикс (frontend AiChatModels.kt):** добавлены `toolResults` и
    `patchesApplied` в `AiChatResponse`.
  - **Фикс (frontend AiAssistantFragment.kt):** обработка tool_results —
    если reply пустой, формируется сообщение из результатов вызова
    инструментов.
  - **Фикс (frontend ChatMessage.kt):** fallback-стриппинг `<tool_call>`
    тегов в markdown-рендерере.
  - Syntax check OK.

- **F1: sync asset.audio → FAILED in recoverAudioOrchStates (2 missing branches)**
  (`backend/src/runtime/reconciliation-engine.js`):
  - **Проблема:** R3-патч синхронизировал asset.audio после `setDone` (MERGING→DONE),
    но две другие ветки recoverAudioOrchStates (GENERATING/WAITING_CHUNKS→FAILED
    и MERGING→FAILED) не синхронизировали asset.audio → FAILED после `setFailed`.
    При рестарте backend сцена оказывалась в DIRTY без записи об AUDIO_FAILED в
    журнале — расследовать инциденты было сложно.
  - **Фикс:** добавлен `unsafeRestoreAssetState('audio', FAILED)` после каждого
    `audioOrch.setFailed()` в recoverAudioOrchStates — по аналогии с R3.
  - 598 тестов проходят.

- **F2: redundant raw audioOrch.setFailed removed from /gpu/task/error + added in failStage**
  (`backend/src/routes/generation-routes.cjs`,
  `backend/src/orchestration/orchestrator.js`):
  - **Проблема:** в `/gpu/task/error` был прямой вызов `audioOrch.setFailed()`
    перед `orchestrator.failStage()`. Между ними — окно, где audio-orch FAILED,
    а asset.audio ещё GENERATING. chunk-specific причина терялась, в journal
    писался только общий `worker_error`.
  - **Фикс:** raw `audioOrch.setFailed` удалён из роута. `failStage` фасада
    теперь сам синхронизирует audio-orch phase → FAILED для stage='audio'.
  - 598 тестов проходят.

- **F4: legacy workers field comment in progress-panel.cjs header**
  (`backend/src/routes/book/progress-panel.cjs`):
  - Добавлен комментарий, что JSON-поле "workers" в API-ответе legacy,
    retained for backward compatibility — предотвращает случайное переименование.
  - 598 тестов проходят.

- **W1: resetScenes — try/catch гарантирует addSceneToActiveIndex при ошибке markDirty**
  (`backend/src/orchestration/orchestrator.js`):
  - **Проблема:** `markDirty` (шаг 8) бросал исключение → `addSceneToActiveIndex`
    (шаг 9) не выполнялся → сцены исчезали из active index → scheduler их не видел →
    сцены зависали навсегда.
  - **Фикс:** `markDirty` обёрнут в try/catch. При runtime-ошибке (PG failure, Redis
    timeout) логируется `warn`, `marked` = `{ marked: 0 }`, и выполнение продолжается.
    `addSceneToActiveIndex` (шаг 9) и journal (шаг 10) выполняются всегда.
    Проверка `bookDiff` оставлена снаружи try/catch — programming error падает жёстко.
  - 598 тестов проходят.

### Added

- **R1: validateAssetTransition + journal events в setScene* (4 функции)**
  (`backend/src/orchestration/orchestrator.js`, `backend/src/orchestration/event-journal.js`):
  - `setScenePending`, `setSceneGenerating`, `setSceneAllReady`, `setScenePlaceholder`:
    каждая теперь читает текущее состояние, вызывает `validateAssetTransition`, при
    невалидном переходе пишет `INVALID_STATE_CALLBACK` в journal, после успешной записи —
    `SCENE_PENDING/GENERATING/ALL_READY/PLACEHOLDER`.
  - Добавлены 4 новых EventType: `SCENE_PENDING`, `SCENE_GENERATING`, `SCENE_ALL_READY`,
    `SCENE_PLACEHOLDER`.
  - Все callers продолжают звать те же методы — контракт не сломан.

- **R3: sync asset state после audioOrch.setDone() в recoverAudioOrchStates**
  (`backend/src/runtime/reconciliation-engine.js`):
  - При MERGING→DONE recovery: после `audioOrch.setDone()` теперь вызывается
    `state.unsafeRestoreAssetState(audio, READY)`. Закрывает пробел в инварианте
    `audio-orch.DONE ⇔ asset.audio.READY`.

- **R6: Тест на audio-orch инвариант**
  (`backend/tests/orchestration-stabilization.test.js`):
  - 3 теста: (1) completeStage(audio) с ok → asset READY, (2) failStage(audio) → asset
    FAILED→PENDING, (3) completeStage(audio) с ok:false → ноль writes.
  - 598 тестов проходят.

### Changed

- **R7: bookDiff обязательный в resetScenes**
  (`backend/src/orchestration/orchestrator.js`):
  - Удалён неатомарный fallback (markDirtyScene в цикле).
  - Теперь `if (!bookDiff) throw new Error(...)` — жёсткий контракт.

---

## [Unreleased] — 2026-07-24

### Fixed

- **Worker icon logic: неверное отображение иконок в GenerateFragment**
  (`frontend/.../GenerateFragment.kt`):
  - **Проблема:** когда worker есть (total > 0) но не активен (active == 0), иконка показывалась
    перечёркнутой (iconInactiveRes), будто worker отсутствует.
  - **Фикс:** `updateSectionHeader()` теперь принимает `isEnabled`. Показывает normal-иконку
    (без пульсации) когда `total > 0 && isEnabled`. Перечёркнутая иконка только при `total == 0`
    или выключенном переключателе.

- **Pulse-анимация продолжалась после потери соединения с GPU**
  (`frontend/.../MainActivity.kt`):
  - **Проблема:** при ошибке `getWorkerCounts()` catch-блок только выставлял "?", но не
    отменял pulse-анимацию — иконки продолжали пульсировать.
  - **Фикс:** catch отменяет все pulseAnimators + сбрасывает tint/alpha чипов.

- **Cover-воркеры не отображались в секции Image; Video шёл в Image контейнер**
  (`frontend/.../GenerateFragment.kt`):
  - **Проблема:** `renderWorkersToSections()` не маршрутизировал "cover" тип никуда (отбрасывался),
    а "video" ошибочно шёл в imageContainer.
  - **Фикс:** `"cover" → imageContainer` (теперь "Генерация обложки" и "Генерация изображений"
    показываются в одной секции); `"video" → videoContainer`.

- **VBook button text теперь зависит от реального содержимого книги**
  (`frontend/.../GenerateFragment.kt`):
  - **Проблема:** `updateVBookButtonText()` использовал локальный `_vbookWindowGenerated` флаг,
    который становился true только после первого клика. При открытии книги с уже готовыми сценами
    кнопка всё равно показывала "Generate VBook" вместо "Generate VBook Next".
  - **Фикс:** проверка `bookData?.chapters?.any { has scenes }` — реальное содержимое.
    Удалён мёртвый `_vbookWindowGenerated`.

- **VBook секция пульсировала при генерации аудио**
  (`frontend/.../GenerateFragment.kt`, `backend/.../generation-routes.cjs`,
  `backend/.../ai-service.js`, `frontend/.../WorkerCounts.kt`):
  - **Проблема:** VBook header использовал `counts.audio` / `counts.active_audio` — при генерации
    аудио VBook иконка пульсировала, хотя VBook не был запущен.
  - **Фикс (бэкенд):** `/api/v1/worker/counts` теперь возвращает `vbook` и `active_vbook`.
    `vbook` = 1 если LLM API жив (ключ + квота), 0 если нет. `active_vbook` = 1 если есть
    running agent session.
  - **Фикс (ai-service.js):** добавлена `checkAIHealth()` — минимальный `POST /chat/completions`
    с `max_tokens=1` для реальной проверки валидности ключа и наличия квоты. Кеш 60s.
  - **Фикс (WorkerCounts.kt):** добавлены поля `vbook`, `active_vbook`.
  - **Фикс (GenerateFragment.kt):** VBook читает `counts.vbook`/`counts.active_vbook` с бэкенда.

- **Пропал диалог выбора Scope перед генерацией**
  (`frontend/.../GenerateFragment.kt`, `frontend/.../dialog_generate_scope.xml`):
  - **Проблема:** Generate на Audio/Image/Video сразу запускал `whole_book` без диалога.
  - **Фикс:** `showScopeDialog()` восстановлен. Показывает: Current Scene → Current Chapter →
    **From This Scene Onward** (новый) → Whole Book.
  - Scope `from_current_scene` добавлен в RadioGroup, маппинг на бэкендовое значение.
  - Также добавлен вызов диалога в `onGenerateAllClicked()`.

- **cancelGeneration не закрывал SSE-канал**
  (`frontend/.../GenerateViewModel.kt`):
  - **Проблема:** `cancelGeneration()` не вызывал `stopProgressStream()` — SSE оставался открыт.
  - **Фикс:** добавлены `stopProgressStream()` + `resetWorkerState()` в cancelGeneration.

- **Kotlin warning: неиспользуемые параметры `_chId`, `_scId`**
  (`frontend/.../GenerateFragment.kt`):
  - **Фикс:** переименованы в `_, _` (стандартная Kotlin конвенция).

### Added

- **Новый экран Generate — вся генерация на отдельном экране**
  (`frontend/.../GenerateFragment.kt`, `frontend/.../fragment_generate.xml`,
  `frontend/.../GenerateViewModel.kt`, `frontend/.../MainActivity.kt`,
  `frontend/.../FileFragment.kt`, `frontend/.../strings.xml`):
  - **Экран Generate** — новый фрагмент с секциями VBook, Audio, Image, Video.
    Верхняя панель: Book / Chapter / Scene / Imagination Unit (как на других экранах).
  - **Глобальная секция** — кнопки Generate All / Stop All в самом верху.
  - **Generate VBook Next** — после первого окна кнопка меняет текст на «Generate VBook Next».
    Каждое следующее нажатие запускает следующее окно сцен вручную.
  - **Worker-тогглы** — VBook Switch (всегда включён), Audio / Image / Video Switch
    с пульсацией иконок при активных воркерах.
  - **Кнопка Generate в тулбаре** — всегда активна, открывает экран Generate (не запускает генерацию).
  - **TXT импорт больше не запускает авто-генерацию** — после импорта пользователь переходит
    на экран Generate и сам решает, когда нажимать Generate VBook / Generate All.
  - **WindowTriggerManager отключён** — автоматический запуск следующего окна при активации
    последнего IU удалён. Только ручное нажатие Generate VBook Next.
  - Build: frontend BUILD SUCCESSFUL.

- **Per-worker stop buttons + Cancel All + backend per-type cancel API**
  (`frontend/.../item_worker_progress.xml`, `frontend/.../activity_main.xml`,
  `frontend/.../strings.xml`, `frontend/.../GenerateViewModel.kt`,
  `frontend/.../MainActivity.kt`, `frontend/.../BookModels.kt`,
  `frontend/.../BackendApi.kt`, `frontend/.../Repository.kt`,
  `backend/src/routes/book/generation-routes.cjs`,
  `backend/src/routes/book/progress-panel.cjs`,
  `backend/src/runtime/dispatch-engine.js`):
  - **Backend: per-type cancel API** (`POST /api/v1/book/{bookId}/cancel-worker`):
    - Cancels only the specified worker type (audio/image/video/cover/vbook) without affecting others.
    - Stores cancelled type in Redis set `animastor:cancelled-workers:{bookId}`.
    - For GPU types: clears dispatch leases + quotas only for that stage via
      `clearLeasesForBookByStage()`. Does NOT clear GPU hub queues (non-cancelled types keep jobs).
    - For cover: cancels audio+image dispatches.
    - For vbook: sets agent_sessions status to 'cancelled' in Postgres.
    - /regenerate now clears the cancelled-workers set.
  - **Backend: progress-panel returns `cancelled` flag** — reads `animastor:cancelled-workers:{bookId}`
    and sets `cancelled: true` on each worker entry.
  - **Backend: `clearLeasesForBookByStage()`** in dispatch-engine.js — cancels leases for a specific
    stage across all active scenes, leaving other stages intact.
  - **Frontend: simplified state management** — `_cancelledWorkers` set and `isWorkerCancelled()`
    removed from `GenerateViewModel`. Frontend no longer tracks cancellation state locally.
    `cancelWorker(type)` calls the backend API and lets the server handle cancellation.
  - **Frontend: per-row stop button** — each worker progress row has a small square ImageButton
    with stop icon (tinted cinema_error). Click opens PopupMenu with «Отменить». Row highlights
    semi-transparent red while popup is open. ProgressWorker model now includes `cancelled: Boolean`.
  - **Frontend: cancelled state rendering** — cancelled workers show muted red "Done — WorkerName"
    row with 0% progress, hidden stop button. `WorkerUi` has `cancelled: Boolean` field.
  - **Frontend: Generate button simplified** — always shows "GENERATE", never toggles to CANCEL.
    Can start new generation while another is running (no `_isRegenerating` guard).
  - **Frontend: Cancel All button** — red-outlined MaterialButton with stop icon appears right of
    Generate button when any generation is active. Shows confirm dialog before calling `cancelGeneration()`.
  - Build: frontend BUILD SUCCESSFUL, 577/578 backend tests pass (1 pre-existing failure).

- **trigger-next-window создавал бесконечный цикл — возвращал triggered:true после cancelled, фронт вызывал снова**
  (`backend/src/routes/book/import-routes.cjs`):
  - **Проблема:** trigger-next-window проверял статус ПОСЛЕДНЕЙ agent_session. Если cancel-worker отменил старые сессии, но bootstrapNextWindow создал новую (status=running), проверка `=== 'cancelled'` не срабатывала. Код вызывал bootstrapNextWindow через setImmediate (которая возвращала all_done через Redis check), НО ответ фронту уже был отправлен как `triggered: true`. Фронт видел `triggered: true` и вызывал trigger-next-window снова — бесконечный цикл.
  - **Фикс:** Redis `cancelled-workers:{bookId}` проверка для 'vbook' добавлена в ОБА пути trigger-next-window (TXT agent path + VBook/windowGenerator path) ДО вызова bootstrapNextWindow или создания gen_session. При cancelled возвращает `{ triggered: false, all_done: true }`, разрывая цикл.

- **VBook агент не убиваем — window-generator.cjs перезаписывал cancelled на failed и не передавал redis в bootstrapNextWindow**
  (`backend/src/services/window-generator.cjs`):
  - **Проблема:** `window-generator.cjs` вызывал `bootstrapNextWindow(bookId, progress)` БЕЗ `redis`, из-за чего Redis cancelled-workers проверка в bootstrap.js пропускалась. Хуже того: catch-блок ВСЕГДА ставил `status='failed'`, перезаписывая `cancelled`. После этого `trigger-next-window` не находил cancelled сессии и запускал новые окна — бесконечный цикл.
  - **Фикс:** импортирован `isBookCancelled` из agent-session. `redis` передаётся в `bootstrapNextWindow(bookId, progress, null, redis)`. Catch-блок проверяет `err.code === 'SESSION_CANCELLED' || isBookCancelled(bookId)` — если cancelled, сохраняет `status='cancelled'`.

### Fixed

- **Stale cancelled sessions убивали новую VBook генерацию — isBookCancelled находил старую cancelled сессию**
  (`backend/src/services/agent/bootstrap.js`):
  - **Проблема:** `isBookCancelled()` в `checkCancelled()` (LEVEL 2) искал ЛЮБУЮ сессию
    со `status='cancelled'` для этой книги в PostgreSQL. Если пользователь когда-то нажал Stop,
    cancelled-статус оставался в БД навсегда. При новом старте VBook после извлечения персонажей
    `checkCancelled()` находил старую cancelled-сессию → SESSION_CANCELLED → агент падал.
    Фронтенд видел `active: false`, через 2 поллинга ставил COMPLETED (100%),
    `applyGenerationResults()` запускался без сцен → тихий return. Пользователь видел
    100% прогресс и пустую структуру.
  - **Фикс:** перед созданием новой сессии в `bootstrapWithAgent()` чищу старые cancelled-сессии:
    `UPDATE agent_sessions SET status='failed' WHERE book_id=$1 AND status='cancelled'`.
  - Фронтенд: убран `VBookStage.FAILED` (вызывал краш приложения).

- **VBook Stop не останавливал агента — checkCancelled проверял sessionId, а новая сессия имела status=running**
  (`backend/src/services/agent-session.js`,
  `backend/src/services/agent/pipeline-runner.js`,
  `backend/src/services/agent/bootstrap.js`,
  `backend/src/routes/book/import-routes.cjs`):
  - **Проблема:** `checkCancelled()` проверял `isSessionCancelled(sessionId)` — статус ТЕКУЩЕЙ сессии. Но cancel-worker отменяет ВСЕ сессии book_id. Если `bootstrapNextWindow` создавал НОВУЮ сессию ПОСЛЕ cancel, новая сессия имела status='running', и `checkCancelled()` не видел отмены.
  - **Фикс (agent-session.js):** добавлена `isBookCancelled(bookId)` — проверяет наличие ЛЮБОЙ cancelled сессии для книги.
  - **Фикс (pipeline-runner.js):** `checkCancelled()` проверяет ДВА условия: `isSessionCancelled(sessionId)` И `isBookCancelled(bookId)`. Если найдена отмена на уровне книги — обновляет и текущую сессию до 'cancelled'.
  - **Фикс (bootstrap.js):** `bootstrapNextWindow()` проверяет Redis `cancelled-workers:{bookId}` на 'vbook' ДО создания новой сессии.
  - **Фикс (import-routes.cjs):** `trigger-next-window` проверяет `status === 'cancelled'` наравне с `'completed'`.
  - 578/578 тестов проходят.

### Fixed

- **VBook Stop/Cancel All не останавливали VBook генерацию — агент продолжал работу**
  (`backend/src/services/agent-session.js`,
  `backend/src/services/agent/pipeline-runner.js`,
  `backend/src/services/agent/bootstrap.js`,
  `backend/src/routes/book/generation-routes.cjs`):
  - **Проблема:** per-worker stop и Cancel All не останавливали VBook генерацию.
    Cancel-worker проставлял `status='cancelled'` в БД, но агент не проверял этот статус
    между шагами AI пайплайна. `bootstrapNextWindow` не проверял cancelled-статус предыдущей
    сессии и создавал новую с `status='running'`, которая игнорировала отмену. Глобальный
    cancel-generation вообще не отменял VBook.
  - **Фикс (`agent-session.js`):** добавлена `isSessionCancelled(sessionId)`.
  - **Фикс (`pipeline-runner.js`):** `checkCancelled()` между ВСЕМИ шагами пайплайна.
    При cancelled статусе кидает `SESSION_CANCELLED`.
  - **Фикс (`bootstrap.js`):** catch-блоки не перезаписывают `cancelled` на `failed`.
    `bootstrapNextWindow` проверяет `prevStatus === 'cancelled'`.
  - **Фикс (`generation-routes.cjs`):** глобальный `cancel-generation` теперь тоже отменяет
    VBook agent sessions.
  - 578/578 тестов проходят.

- **Cancel All кнопка — красная подсветка строки держится только мгновение**
  (`frontend/.../MainActivity.kt`):
  - **Проблема:** при открытии PopupMenu красная подсветка строки пропадала через ~1.5с
    при следующем цикле поллера (`renderWorkers()` сбрасывал фон в TRANSPARENT).
  - **Фикс:** добавлены `_highlightedWorkerType` и `_highlightColor`. `renderWorkers()`
    восстанавливает подсветку в каждом цикле для строки с открытым поп-апом.

### Changed

- **Cancel All кнопка переделана на квадратную тёпло-красную с иконкой стоп**
  (`frontend/.../activity_main.xml`, `frontend/.../colors.xml`,
  `frontend/app/src/main/res/drawable/ic_cancel_bg.xml`):
  - **Проблема:** Cancel All была текстовой кнопкой с красным контуром (MaterialButton).
    Не вписывалась в общий дизайн.
  - **Фикс:** FrameLayout 36х36dp со скруглённой прямоугольной тёпло-красной подложкой
    (ic_cancel_bg.xml, cinema_cancel = #E55353), иконка ■ Stop (18dp, белая).
    Ripple-эффект через selectableItemBackgroundBorderless.

- **Prompt Profiles — model-specific правила промптинга вынесены из хардкода в скилл-файлы**
  (`backend/src/services/ai-loader.js`, `backend/src/services/prompt-profile-loader.js`,
  `backend/src/services/agent/pipeline-steps.js`,
  `backend/src/services/agent/pipeline-runner.js`,
  `backend/src/routes/connector-routes.cjs`,
  `data/connectors/*.json`,
  `frontend/.../SettingsFragment.kt`, `frontend/.../fragment_settings.xml`,
  `frontend/.../strings.xml`, `frontend/.../BackendApi.kt`, `frontend/.../ConnectorModels.kt`):
  - **Проблема:** правила промптинга для LTX 2.3 (temporal/dynamic, reference image = identity)
    были зашиты в JS-константы `SYSTEM_PROMPTS.video_action_reconciliation` и
    `video_action_polish` в `agent-prompts.js`. При добавлении новой модели (Veo, V1, Kling, Wan)
    требовалось менять код агента.
  - **Решение:** модель-специфичные правила промптинга хранятся как markdown-файлы в
    `backend/ai/skills/{type}/{profile}.md` и загружаются агентом перед генерацией промпта.
  - **Скилл-файлы (новые):**
    - `backend/ai/skills/video/ltx-2.3.md` — LTX 2.3 I2V: temporal-only, camera vocabulary,
      motion vocabulary, reference image = identity.
    - `backend/ai/skills/image/qwen-image.md` — Qwen Image: natural language, spatial arrangement,
      composition-first ordering.
    - `backend/ai/skills/audio/qwen-tts.md` — Qwen TTS: clean text, proper punctuation.
  - **ai-loader.js:** рекурсивный обход поддиректорий (".md" в `video/`, `image/`, `audio/`),
    ключи вида `"video/ltx-2.3"`. `getDirMtime` теперь рекурсивный.
  - **prompt-profile-loader.js:** новый модуль — `getVideoProfile()`, `getImageProfile()`,
    `buildSkillSection()` для инъекции скилла в system prompt.
  - **pipeline-steps.js:** 4 шага (`stepCreateVisuals`, `stepReconcileVideoActions`,
    `stepPolishStoryboard`, `stepPolishVideoActions`) — читают `promptProfiles` из параметров
    и inject скилл-секцию перед основным промптом.
  - **pipeline-runner.js:** передаёт `options.promptProfiles` во все шаги (по умолчанию
    `undefined` — система работает без изменений, постепенный rollout).
  - **Connector profile:** в каждый `data/connectors/*.json` добавлено поле `profile`:
    `videoProfile: "ltx-2.3"`, `imageProfile: "qwen-image"`, `audioProfile: "qwen-tts"`.
  - **API endpoint:** `GET /api/v1/connectors/profiles` — агрегированные профили по типам.
  - **Frontend:**
    - `fragment_settings.xml` — секция Prompt Profiles (Audio → Image → Video) над Workflow Manager.
    - `SettingsFragment.kt` — загрузка профилей через API при открытии настроек.
    - `BackendApi.kt` / `ConnectorModels.kt` — модель `ConnectorProfilesResponse`.
  - **Design doc:** `docs/07-agents-and-generators/AGENT_PROMPT_PROFILES.md`.
  - 577/578 тестов проходят (1 pre-existing failure).

### Fixed

- **IU тайминги диалоговых юнитов: text_length считался от audio.text вместо unit.text**
  (`backend/src/image/iu-processor.js`):
  - **Проблема:** `saveIUMetadata()` использовал `unit.audio?.text || unit.text || ''` для `iuText`.
    Для диалоговых юнитов `audio.text` содержал только реплику без атрибуции ("Дайте нарзану" = 13 символов),
    а `unit.text` — полный текст с репликой ("— Дайте нарзану, — попросил Берлиоз." = 39 символов).
  - **Следствие:** `text_length` в PG был в 3-4 раза короче реального → при пересчёте IU таймингов
    в `handleAudioCompleted()` диалоговые юниты получали непропорционально мало времени (5% вместо 9.5%,
    4.6% вместо 16.1% и т.д.). Первый нарративный юнит забирал 78.2% длительности сцены вместо 49.9%.
  - **Почему баг проявлялся не сразу:** `saveIUMetadata` вызывается при генерации IU image (асинхронный
    шаг, может выполняться через часы после импорта). До этого момента сториборд/timings endpoint
    держал в PG правильные значения из `unit.text`. После IU image generation данные перезаписывались
    неправильными — тайминги ломались.
  - **Фикс:** `const iuText = unit.text || '';` — всегда использовать `unit.text` (полный текст).
    Комментарий с объяснением добавлен.
  - Баг жил с 12 июля 2026 (коммит `d5d59a4` — «iu.audio: first phase of modal refactoring»).
  - 577/578 тестов проходят (1 pre-existing failure в audio stall detection).

### Added

- **Разделение post-processing: два новых шага для video.action**
  (`backend/src/services/agent-prompts.js`,
  `backend/src/services/agent/pipeline-steps.js`,
  `backend/src/services/agent/pipeline-runner.js`):
  - **Проблема:** `video.action` всегда равнялся `image.prompt` — оба пост-процессинговых шага
    (`stepReconcilePassports`, `stepPolishStoryboard`) перезаписывали `video.action` значением
    `image.prompt`, полностью теряя семантику temporal/dynamic.
  - **Фикс бага:** в `stepReconcilePassports` и `stepPolishStoryboard` `video.action` теперь
    сохраняется: `original.video?.action || mergedPrompt` вместо `mergedPrompt`.
  - **Шаг A — `stepReconcileVideoActions` (новый):** Простой положительный промпт.
    Исправляет `video.action`: убирает static composition, оставляет только temporal/dynamic
    (жесты, движения, camera motion, delivery cues). Работает по одному юниту.
  - **Шаг B — `stepPolishVideoActions` (новый):** Перепроверка концепции + согласование ряда.
    Смотрит последовательность video.actions: непрерывность жестов, соответствие сюжету,
    эмоциональная дуга, кросс-сценные переходы. Работает со всеми юнитами окна (≥2).
  - **Новые системные промпты:** `video_action_reconciliation` и `video_action_polish`
    в `agent-prompts.js`.
  - **Итоговый поток:** `createVisuals` → `passportReconcile (image)` → `videoReconcile` →
    `storyboardPolish (image)` → `videoPolish`.
  - 577/578 тестов проходят (1 pre-existing failure в audio stall detection).

- **Аудио-прогресс: expected_count-based total + таймер выполнения**
  (`backend/src/routes/book/progress-panel.cjs`,
  `frontend/.../GenerateViewModel.kt`, `frontend/.../MainActivity.kt`,
  `frontend/.../activity_main.xml`):
  - **Проблема:** прогресс генерации аудио считался по количеству GPU-чанков (TTS сегментов).
    Total = количество всех chunk ID в Redis. Каждый новый чанк увеличивал total на 1
    (напр. 25 → 30 → 34), прогресс дёргался, в конце показывал некорректные значения.
  - **Фикс (backend):** Прогресс аудио переведён на `expected_count`-базу.
    Каждая сцена при диспатче сохраняет `expected_chunk_count` в чанк-метаданных
    (устанавливается один раз, не меняется). В `/progress-panel`:
    `total = сумма expected_count по уникальным сценам` — растёт только при появлении
    НОВОЙ сцены (напр. +5 за раз), а не на каждый отдельный чанк.
    `ready = количество готовых чанков` (как было).
    Добавлена защита от NaN в `parseInt`.
  - **Фикс (frontend):** Добавлен клиентский таймер выполнения — `elapsedSeconds` StateFlow
    в `GenerateViewModel.kt`. Стартует при `startGeneration().onSuccess`, стопается при
    `applyGenerationResults()` / `cancelGeneration()` / `closeBook()`.
    `resetWorkerState()` не трогает таймер. В `MainActivity.kt` — lifecycleScope-подписка,
    формат `HH:MM:SS`, показывается в `generationTimerRow` над списком воркеров.
  - **Layout:** `activity_main.xml` — `generationTimerRow` с `generationTimer` TextView
    внутри `generationProgressContainer`.
  - 12/12 тестов проходят, syntax check OK.

- **Таймер: переезд в строку воркера + переделка на прямой polling**
  (`frontend/.../GenerateViewModel.kt`, `frontend/.../MainActivity.kt`,
  `frontend/.../item_worker_progress.xml`):
  - **Проблема 1:** таймер висел отдельной строкой (`generationTimerRow`) над воркерами,
    слева. Должен быть в правом углу каждой строки воркера.
  - **Проблема 2:** таймер всегда показывал `00:00:00` — корутина в ViewModel (StateFlow +
    `timerJob`) отменялась до первого инкремента, значение застывало на 0.
  - **Фикс (таймер):** Вся логика таймера перенесена из ViewModel в MainActivity.
    `_elapsedSeconds` StateFlow + корутина заменены на `@Volatile var timerStartedAt: Long`.
    `startTimer()` просто сохраняет `System.currentTimeMillis()`, `stopTimer()` сбрасывает в 0.
    MainActivity в `lifecycleScope` запускает `while(true) { delay(500); elapsed = (now - start) / 1000 }`
    — читает `viewModel.timerStartedAt` напрямую, без промежуточных корутин и StateFlow.
    Таймер не может быть отменён, так как MainActivity владеет циклом.
  - **Фикс (позиция):** `item_worker_progress.xml` — добавлен `workerTimer` TextView справа от
    `workerPercent`. `generationTimerRow` скрыт при показе воркеров (оставлен для DoneRow).
    Timer observer обновляет `workerTimer` во всех видимых строках каждые 500ms.
  - **Фикс (шрифт):** `workerTimer` согласован с `workerCount` — 12sp, без кастомного
    fontFamily/letterSpacing.
  - Syntax check OK, code review OK.
  - Syntax check OK, code review OK.

- **DoneRow: таймер справа на строке при 100% + финальное время + bold**
  (`frontend/.../activity_main.xml`, `frontend/.../GenerateViewModel.kt`,
  `frontend/.../MainActivity.kt`):
  - **Проблема:** при глобальном прогрессе 100% (DoneRow) таймер висел на отдельной
    строке слева под статусом. Должен быть справа на строке, как в обычных воркерах.
  - **Фикс (позиция):** `generationTimerRow` удалён из `activity_main.xml`.
    `generationTimer` перенесён внутрь `generationDoneRow`, после `100%` — справа.
    DoneRow: `[Готово — Audio ...] [100%] [00:01:42]`.
  - **Фикс (финальное время):** в `GenerateViewModel.kt` добавлено
    `@Volatile finalElapsedSeconds: Long`. `stopTimer()` сохраняет elapsed до остановки.
    `timerStartedAt = -1L` как sentinel «остановлен». Таймер показывает итоговое
    время, а не 00:00:00.
  - **Фикс (bold):** в `MainActivity.kt` timer loop ставит `typeface = DEFAULT_BOLD`
    на `generationTimer` и все `workerTimer` при `timerStartedAt == -1L`.
  - Syntax check OK, code review OK.

- **Таймер: старт до API-вызова + bold только при реальной остановке**
  (`frontend/.../GenerateViewModel.kt`, `frontend/.../MainActivity.kt`):
  - **Проблема:** `startTimer()` вызывался только внутри `.onSuccess` API-вызова.
    После `closeBook()` в `onCreate` `timerStartedAt = -1L`. В промежутке между кликом
    Generate и ответом API (секунды) таймер-луп читал `-1L` → `00:00:00` + bold
    (`isStopped = true`). Если API-вызов падал — `startTimer()` вообще не вызывался.
  - **Фикс:** `startTimer()` перенесён в начало `startGeneration()` — вызывается
    **синхронно** перед корутиной API-вызова. Таймер стартует немедленно при клике.
  - **Bold:** `shouldBold = isStopped && finalElapsedSeconds > 0L` — жирный шрифт
    только когда таймер был реально остановлен после работы, а не при холодном старте.
  - `stopTimer()` добавлен в `.onFailure` — останавливает таймер при ошибке API.
  - Syntax check OK, code review OK.

- **Таймер: запуск при VBook-импорте (txt → AI-агент)**
  (`frontend/.../GenerateViewModel.kt`):
  - **Проблема:** `startTimer()` вызывался только в `startGeneration()` (GPU-генерация
    audio/image/video). При VBook-импорте txt-файла `startTimer()` никогда не вызывался →
    таймер всегда показывал `00:00:00` (`timerStartedAt == -1L` после `closeBook()`).
  - **Фикс:** три добавления в `importBookFromFile()`:
    (1) `startTimer()` перед `bootstrapBook()` — таймер стартует при начале VBook-обработки;
    (2) `stopTimer()` после `pollAgentProgress()` — останавливается при завершении;
    (3) `stopTimer()` в catch-блоке — останавливается при ошибке импорта.
  - `stopTimer()` идемпотентен (двойной вызов при cancel безопасен).
  - Syntax check OK, code review OK.

- **A0: Детерминированное перечисление чанков — enumeration вместо readdir**
  (`backend/src/audio/chunks.js`):
  - `findExistingSceneChunks()` теперь принимает опциональный `expectedCount`.
    Когда известен — перечисляет `1..expectedCount` детерминированно (никакого readdir).
    Когда не известен — fallback к readdir + .sort().
  - Callers (generation.js, pipeline.js) передают `expectedChunkCount`.
  - filesystem-store.js имеет свою копию (не в аудио-пути, не тронута).

- **A2: Таймауты через формулу — GPU_TIMEOUT_MS как single source of truth**
  (`backend/src/config/runtime-config.js`, `gpu-hub/gpu-hub.js`):
  - `GPU_TIMEOUT_MS` (env, default 600000) → `STALL_FAILSAFE_MS = GPU_TIMEOUT_MS * 3`
    → `LEASE_TTL_S.AUDIO = ceil(STALL/1000) + 60`.
  - Инвариант GPU_TIMEOUT < STALL < LEASE теперь гарантирован математически.
  - Backend + gpu-hub синхронизированы (оба читают `GPU_TIMEOUT_MS`,
    fallback к старому `GPU_TIMEOUT`).
  - Startup warning при изменении env.
  - Тесты переписаны на проверку формул (8/8).

- **A3: Phase guard удалён — dispatch-engine lease + timeout formula**
  (`backend/src/orchestration/scene-orchestrator.js`):
  - WAITING_CHUNKS/MERGING guard удалён: A2 гарантирует LEASE > STALL > GPU_TIMEOUT,
    так что lease переживает watchdog, и stale re-dispatch невозможен.
  - Stale recovery WAITING_CHUNKS/MERGING теперь падает через deleteState+reinit
    (не оставляет сцены зависшими навсегда).

### Changed

- **batch dispatch commit message** was already in the changelog from 2026-07-20

## [Unreleased] — 2026-07-20

### Added

- **Batch dispatch: narration → dialogue — минимизация переключения моделей ComfyUI**
  (`backend/src/audio/generation.js`):
  - `sendPerSegmentAudio()` группирует сегменты: сначала все narration чанки, затем все dialogue.
    Narration workflow загружает 1 модель (VoiceDesign 1.7B), dialogue — 2 (VoiceDesign + Base).
    При чередовании N→D→N→D модель перезагружалась 4 раза за сцену; батч сократил до 1 переключения.
  - Оригинальные `chunkIndex` сохраняются (`idx = i + 1`) — мердж не зависит от порядка отправки.
  - Коммит: `1ce49ee`

### Fixed

- **IU timing calculation — narration/perception units получали `text_proportion=0` в смешанных сценах (диалог + нарратив)**
  (`backend/src/image/iu-processor.js`):
  - **Проблема:** `saveIUMetadata()` использовал только `unit.audio?.text` для расчёта пропорции текста юнита.
    Поле `audio.text` устанавливается ТОЛЬКО для диалоговых юнитов (`type: "dialogue"` с `audio.speaker`).
    Для нарративных/перцептивных юнитов `audio.text == undefined` → `iuText = ''` →
    `text_length = 0` → `text_proportion = 0` → `estimated_duration_sec = 0`.
  - **Следствие:** `needsDuration` в сториборде становился `false` (диалоговые юниты имели ненулевые
    значения), fallback-пересчёт из `u.text` не срабатывал. Вся длительность сцены уходила только
    в диалоговые юниты. Нарративные юниты схлопывались до 200ms, диалоговые получали
    непропорционально большие тайминги (напр. 21.7s на одном юните), захватывая аудио соседних
    юнитов → рассинхрон.
  - **Фикс:** `unit.audio?.text || unit.text || ''` — добавлен fallback на `unit.text` для юнитов
    без `audio.text`. Все 576 тестов проходят.
  - Сравнение с бэкапом `animastor-src-2026-07-14_05-33-26-Dialogue-Good.zip` подтвердило:
    код `saveIUMetadata` идентичен, баг существовал всегда, но не проявлялся в чисто-нарративных
    сценах (там все юниты имели `estimated_duration_sec = 0` → `needsDuration = true` →
    fallback из `u.text`).

### Refactored

- **Аудио-оркестрация: retry-таймер заменён на event-driven модель + watchdog (T-A1…T-A7)**
  - **T-A1** (`197f838`): `completeChunk` при неполном наборе чанков больше не заводит `setTimeout`-цепочку — пишет `chunks_received`/`last_chunk_at` и выходит. Merge триггерит приход последнего чанка (event-driven). Новая `failWaitingScene()` — единственный владелец `WAITING_CHUNKS → FAILED` (чистка hub-dedup, сброс metadata, `orchestrator.failStage`). Удалены `animastor:audio-merge-retry:*` ключи.
  - **T-A3** (`134db6a`): 4 retry-константы заменены на `AUDIO_CHUNK_STALL_MS=300000` (5 мин). Обновлены инварианты.
  - **T-A2** (`b7ad7fc`): watchdog `checkStalledAudioScenes` в `reconcileCycle` (фаза B1). Сканирует audio-orch states в `WAITING_CHUNKS`, при застое > STALL_MS вызывает `failWaitingScene()`.
  - **T-A5** (`19eb680`): `[DEBUG-*]` console.logs удалены из 4 файлов (заменены на `helpers.log`/`warn`).
  - **T-A6** (`74e2f45`): 5 новых тестов, 576 passing.
  - Подробный план: `docs/03-audit/AUDIO_ORCH_INTEGRATION_TODO.md`

### Fixed

- **Qwen3-TTS выдавал 0-секундное аудио для voice instruction с "Hoarse, raspy" через API**
  (`backend/src/audio/generation.js`):
  - **Проблема:** голосовая инструкция `ivan_ponyrev` содержала `"Hoarse, raspy tenor"`.
    Ручная загрузка workflow в ComfyUI UI работала нормально, но через API — стабильно 0 секунд.
    Эксперимент подтвердил: замена спикера на `mikhail_berlioz` с той же фразой "Пиво есть?"
    работала; замена обратно с голосом Берлиоза тоже работала. Проблема именно в комбинации
    "raspy" + API-вызов, не в тексте, не в позиции батча, не в содержимом workflow.
  - **Вывод:** Qwen3-TTS через ComfyUI API не умеет корректно синтезировать хрипоту (raspy).
    Через UI — выдаёт без хрипоты, через API — 0 секунд. Систематический глюк, не race condition.
  - **Debug:** workflow dump `wf_dump_*.json` подтвердил 100% идентичность реального и ручного workflow.

- **8/9 audio generation loop — retry timer race condition with GPU hub**
  (`backend/src/config/runtime-config.js`):
  - **Проблема:** `AUDIO_MERGE_RETRY_DELAY_MS: 15000` (15с между retry) × 5 попыток = 75с.
    При 9 чанках и 1 воркере (~10-15с на чанк ComfyUI TTS) GPU hub требовалось 90-135с
    для полной обработки. Retry исчерпывался до завершения всех чанков → `failStage`
    → `cancelActiveDispatch` очищал `animastor:running:{dispatch_id}` → все последующие
    результаты от воркеров получали **HTTP 409** → scene → PENDING → re-dispatch → ∞.
  - **Дополнительно:** `AUDIO_MERGE_RETRY_DEDUP_TTL_S: 30` был меньше нового retry delay,
    из-за чего dedup key протухал до срабатывания таймера и промежуточные чанки создавали
    конкурирующие retry-цепочки, ускоряя исчерпание budget.
  - **Фикс:** DELAY 15000→60000 (60с), DEDUP 30→120с, COUNTER 180→600с.
    Новый budget: 5 × 60с = 300с (5 минут) — покрывает 9 чанков × 10-15с = 90-135с.
  - Все инварианты соблюдены: 5×60с=300с < lease_audio 900с; counter 600с > 300с; dedup 120с >= 60с.
  - 571 тест проходит.
  - Подробный post-mortem: `docs/03-audit/AUDIO_8_9_RACE_CONDITION.md`

- **voices.json терял голоса персонажей при генерации второго окна vbook**
  (`backend/src/book/lazy-book/create.js`):
  - **Проблема:** `voices.json` перезаписывался целиком из `mergedCharacters`. `characters.json`
    хранит персонажей без поля `voice` (оно вырезается при сохранении — голоса живут только
    в `voices.json`). При загрузке старых персонажей с диска для второго окна `ch.voice`
    отсутствовал → они не попадали в новый `voices.json`. Оставался только narrator.
  - **Фикс:** `voices.json` — единственный source of truth. При записи: загружается существующий
    `voices.json` как база (спред), итерация только по `analysis.characters` (персонажи
    текущего окна). Старые голоса сохраняются из spread, новые/уточнённые — перезаписываются.
  - 571 тест проходит.

- **voices.json содержал только narrator после первой генерации — stepGenerateVoices пишет voice как строку, не как объект**
  (`backend/src/book/lazy-book/create.js`):
  - **Проблема:** `stepGenerateVoices` устанавливает `ch.voice = voices[ch.id].instruction` —
    где `instruction` это строка. Код сохранения проверял `ch.voice?.instruction`, но на строке
    это `undefined` → все персонажи пропускались, оставался только narrator.
  - **Фикс:** нормализация: `typeof ch.voice === 'string' ? ch.voice : ch.voice?.instruction`.
  - 571 тест проходит.

- **Race condition: чанки прилетали до WAITING_CHUNKS → completeChunk skip → retry exhaustion → цикл**
  (`backend/src/orchestration/scene-orchestrator.js`, `backend/src/services/audio-orchestrator.js`):
  - **Проблема:** `setWaitingChunks()` вызывался **после** `generateSceneAudio()` в `executeAudioDispatch`.
    При быстрых TTS (5-10s на чанк) GPU hub возвращал результаты быстрее, чем выполнялся переход
    GENERATING → WAITING_CHUNKS. `completeChunk` видел фазу GENERATING → early return (чанк на диске,
    но не обрабатывался). Из 9 чанков приходили только 3 → retry exhaustion → `failStage` →
    `cancelActiveDispatch` чистил GPU hub → воркеры для чанков 4-9 получали HTTP 409 →
    re-dispatch → бесконечный цикл.
  - **Фикс 1 — `scene-orchestrator.js`:** `setWaitingChunks` перенесён **до** `generateSceneAudio`.
  - **Фикс 2 — `scene-orchestrator.js`:** `already_ready` path fast-track: WAITING_CHUNKS→MERGING→DONE
    (все transitions валидны).
  - **Фикс 3 — `audio-orchestrator.js`:** Safety net: если `completeChunk` вызван на фазе GENERATING,
    самостоятельно перейти в WAITING_CHUNKS и продолжить. Локальная переменная `orchState`
    синхронизируется после Redis-перехода.
  - 571 тест проходит.

## [Unreleased] — 2026-07-16

### Removed

- **Dead code — 5 orphaned файлов + legacy scene-state функции полностью зачищены**
  (`backend/src/services/context-builder.js`, `backend/src/services/chat-store.js`,
  `backend/src/services/book-integrity.js`, `backend/src/runtime/feedback-recorder.js`,
  `backend/src/runtime/feedback-config.js`, `backend/src/state/scene-state.js`):
  - **5 orphaned файлов удалены:** `context-builder.js`, `chat-store.js`, `book-integrity.js`,
    `feedback-recorder.js`, `feedback-config.js` — не импортировались ни одним production-файлом.
  - **Legacy scene-state функции удалены из `scene-state.js`:** `getSceneState()`,
    `setSceneState()`, `setSceneStateWithBuildId()`, `transitionSceneState()`,
    `deriveAssetStatesFromLinear()`, `SCENE_STATE_KEY_PREFIX`.
  - **`SCENE_STATE_KEY_PREFIX`** удалён из `runtime-config.js` (был `animastor:scene-state`).
  - **17 файлов очищены** от self-referencing закомментированных `require()` строк.
  - **13 production-файлов** мигрированы с legacy scene-state на per-asset state.
  - **Lua-скрипт в `book-diff.cjs`** исправлен: KEYS сдвинуты (удалён sceneStateKey),
    `numKeys` с 4→3.
  - **Тесты:** `scene-state.test.js`, `asset-state.test.js`, `happy-path.test.js` — очищены.
  - **`runtime-persistence.js`:** удалён scan `animastor:scene-state:*`.
  - **`backend.cjs`:** удалён TTL cleanup для legacy scene-state ключей.
  - **Документация:** ARCHITECTURE.md, PROJECT_STRUCTURE.md, SYSTEM_OVERVIEW.md,
    SYSTEM_MAP.md, AGENTS.md — очищены от упоминаний удалённых файлов и функций.
  - 139 тестов проходят (все зелёные).

### Added

- **T7: Аудио-машина внутрь оркестра (R2/К1)**
  (`backend/src/services/audio-orchestrator.js`, `backend/src/services/task-handler.cjs`,
  `backend/src/orchestration/orchestrator.js`, `backend/src/orchestration/scene-orchestrator.js`,
  `backend/src/audio/generation.js`, `backend/src/runtime/reconciliation-engine.js`):
  - `completeChunk()` в audio-orchestrator.js — приём чанка, проверка комплектности,
    retry-логика, recovery позднего чанка FAILED→WAITING_CHUNKS, MERGING→DONE + `completeStage`.
  - `task-handler.cjs`: удалён мёртвый `triggerAudioMerge` (вся логика в completeChunk).
  - `orchestrator.setSceneGenerating()` — единый фасад для перехода в GENERATING.
  - `scene-orchestrator.js`: прямые `state.setAssetState(audio, PENDING/GENERATING)` →
    `orchestrator.setScenePending()` / `setSceneGenerating()`. Убран файловый сигнал
    (delete placeholder merged audio before TTS).
  - `checkAudioOrchInvariants()` в reconciliation-engine.js: проверка DONE⇔READY,
    FAILED⇒FAILED/PENDING, промежуточные⇒не READY. Вызывается из `reconcileScene()`.
  - `AUDIO_ORCHESTRATOR.md` обновлён с инвариантами и документацией completeChunk.
  - 574 теста проходят.

- **T8: Убрать linear state (R7 / К7)**
  (`backend/src/state/scene-state.js`, `backend/src/runtime/scene-window.js`,
  `backend/src/runtime/runtime-scheduler.js`, `backend/src/runtime/active-scenes-index.js`):
  - `syncLinearState` → no-op (возвращает derived state без записи в Redis).
  - Удалены 11 вызовов `syncLinearState` из orchestrator.js.
  - Удалены вызовы из book-diff, scene-restoration, window-generator, runtime-persistence, debug-routes.
  - reconciliation-engine.js: 4 orphan-check функции переведены на `getAssetStates()`.
  - scene-callbacks.js, scene-orchestrator.js: удалены/мигрированы чтения `getSceneState()`.
  - scene-window.js: `isWindowComplete` переведена на `getAssetStates()` (вместо чтения linear state поля).
  - runtime-scheduler.js: `attemptDispatch` больше не падает с `'no_state'` при отсутствии scene-state ключа.
  - active-scenes-index.js: `isGenerating/isPending/isTerminal` переведены на `getAssetStates()`.
  - tests/scope-slide.test.js: исправлен на проверку asset-state + добавлен `makeSceneReady()` helper.
  - 574 теста проходят.

### Removed

- **SceneState enum, syncLinearState, deriveLinearState — полная зачистка**
  (`backend/src/state/scene-state.js`, 10 production-файлов, 4 тестовых файла):
  - `SceneState` enum (20 констант: `AUDIO_PENDING`, `VIDEO_READY`, `FAILED` и т.д.) удалён.
  - `syncLinearState()` — больше не существует (был no-op с T8).
  - `deriveLinearState()` — больше не экспортируется (логика fallback встроена в `getAssetStates`).
  - `getSceneBuildId()` — удалён (build_id читается из manifest).
  - 10 production-файлов: `state.SceneState.*` → inline-строки ('audio_pending', 'video_ready' и т.д.).
  - runtime-config.js: удалена stale JSDoc typedef `SceneStateValue`.
  - runtime-scheduler.js: удалён deprecated `SceneState: null` из exports.
  - Тесты: scene-state.test.js, asset-state.test.js, scope-slide.test.js, book-diff-unit.test.js,
    happy-path.test.js — очищены от syncLinearState и SceneState.
  - Frontend: `SceneStatusResponse` уже использует per-asset поля `audio_ready`/`video_ready`/`image_ready`,
    бэкендовый `/api/v1/scene/.../status` определяет готовность по файлам — изменений не требуется.
  - 551 тест проходит.

- **T6: Единый reconciliation-контур (R4/К4)**
  (`backend/src/runtime/reconciliation-engine.js`, `backend/src/backend.cjs`,
  `backend/src/services/startup-recovery.js`, `backend/src/services/cleanup-service.cjs`):
  - Единый `reconcileCycle()` с 4 фазами: A (result/error recovery), B (lock cleanup),
    C (startup: version staleness, audio-orch, chunk recovery, session resume),
    D (full reconcile + auto-fix).
  - Распределённый CLEANUP_LOCK + RECOVERY_STARTED/RECOVERY_COMPLETED в journal.
  - `backend.cjs`: startup-recovery → reconcileCycle({startup: true}).
  - `startup-recovery.js`: retain для обратной совместимости.
  - `cleanup-service.cjs`: startCleanupInterval → no-op.
  - 574 теста проходят.

- **T5: Инвалидация статусов только через фасад (R8/К5)**
  (`backend/src/orchestration/orchestrator.js`, `backend/src/services/scene-asset-registry.js`,
  `backend/src/services/placeholder-audio.js`, `backend/src/services/task-handler.cjs`):
  - `markDirtyScene` теперь пишет PG `scene_assets.status='stale'` как side-effect.
  - `invalidateSceneAssets`, `markAssetStale`, `markPlaceholderStale` — переведены на вызов
    `orchestrator.markDirtyScene(redis, ...)` (сигнатуры изменены: добавлен `redis`).
  - `task-handler.cjs`: ручной `state.setAssetState(PENDING)` + очистка lease заменён на
    `orchestrator.failStage()`. `audioOrch.setFailed()` сохранён для отдельной phase-машины.
  - Создан `tests/mocks/redis-mock.js` — минимальный Redis mock для тестов фасада.
  - `STATE_WRITERS_MAP.md` обновлён: PG статусы пишутся через `completeStage` (ready),
    `markDirtyScene` (stale), `failStage` (failed).
  - 574 теста проходят.

- **T4: Команда `resetScenes` в фасаде оркестратора (R3/К3)**
  (`backend/src/orchestration/orchestrator.js`, `backend/src/routes/book/generation-routes.cjs`):
  - Единая команда `resetScenes()` в orchestrator.js, собирающая весь ритуал регенерации:
    force-dispatch, gen-scope, active-index, dispatch-lease, GPU hub queues (HTTP),
    stale PNG pre-delete, iu-progress/in-flight, markDirty, event-journal.
  - `/regenerate` роут сокращён: бизнес-логика (scope, diff, cover) остаётся,
    state management — через `resetScenes`. Force-dispatch и gen-scope убраны из route.
  - `cancel-generation`: переведён на HTTP `DELETE /queue/clear?book_id=` gpu-hub
    с fallback на прямой `clearGpuHubQueues`.
  - Новые события `SCENE_RESET`/`SCENE_RESET_COMPLETED` в event-journal.
  - 574 теста проходят.

## [Unreleased] — 2026-07-15

### Fixed

- **Agent bootstrap: агент больше не начинает сборку с offset 0 после потери windowData**
  (`backend/src/services/agent/bootstrap.js`, `backend/src/services/agent/pipeline-runner.js`):
  - **Проблема:** `bootstrapNextWindow()` использовал `windowData?.currentOffset || 0` для определения
    стартовой позиции следующего окна. Если `windowData` терялся (сброс сессии в БД, перезапись,
    race condition), `|| 0` бесшумно падал в offset 0 → агент начинал обработку с самого начала
    книги, создавая полные дубликаты уже существующих сцен с `source_start` от 0.
    Конкретный случай: сцена `sc-3e27f84a` в `ch-20df51b4.json` получила `source_start: 3318`,
    но реальный текст на этом offset — середина другого абзаца, не тот диалог, который в сцене.
    Сцены 7-9 — полные дубликаты сцен 0-3 с `source_start: 0, 631, 1242`.
  - **Фикс 1 — `getLastSourceEnd(bookId)`:** Новая функция читает `source_end` последней сцены
    из файлов глав на диске (единственный source of truth). Offset определяется по приоритету:
    диск > windowData из БД > throw. Никогда не падает в 0.
  - **Фикс 2 — guard против walk backwards:** Три проверки:
    (а) `windowStartOffset < currentOffset - 50` → throw (шаг назад),
    (б) `sceneConsumedOffset < lastSourceEnd` после pipeline → throw (повторная обработка),
    (в) `currentOffset <= 0` → throw (защита от fallback в 0).
  - **Фикс 3 — `getWindowText()` для window>0:** Если `startOffset` не передан → throw
    (раньше молча падал в 0). Добавлены guard: `startOffset < 100` для window>0,
    `computedActualStart << startOffset` — всё throw с описанием проблемы.
  - Все 550 тестов проходят.

- **Placeholder re-created after deletion — race condition в `startScene()`**
  (`backend/src/services/task-handler.cjs`):
  - **Проблема:** `startScene()` в `scene-window.js` запускает `ensurePlaceholderAudio()` через
    `setImmediate()` (fire-and-forget, non-blocking). Если `generateSceneAudio()` успевает удалить
    старый placeholder и отправить TTS до того, как `setImmediate` callback отработает, callback
    **создаёт новый placeholder MP3 уже после удаления**. Прибывающие TTS-чанки вызывают
    `triggerAudioMerge()`, который видит `fs.existsSync(merged.mp3) → true` (новый placeholder)
    и выходит ранним return, думая что merge уже выполнен. `completeStage()` вызывается в любом
    случае — аудио сцены помечается как готовое, но на диске остаётся 2-секундная тишина.
  - **Фикс 1 — placeholder detection в early-return:** при `fs.existsSync(mergedAudioPath)`
    проверяется, является ли файл реальным аудио (heuristic: размер > 32KB, если меньше —
    проверка PG через `placeholderAudio.hasRealAudio()`). Если это placeholder — continue
    к retry-логике, не exit early.
  - **Фикс 2 — completeStage только при успешном merge:** раньше `completeStage()` вызывался
    всегда, даже если `mergeSceneAudioChunks()` вернул null и fallback не применился. Теперь
    при неудачном merge функция возвращается без вызова `completeStage`, оставляя сцену
    в PENDING для retry/передиспатча.

- **Audio merge — per-chunk `padded_text` больше не обрезает все чанки**
  (`backend/src/services/task-handler.cjs`):
  - **Проблема:** `triggerAudioMerge()` проверял `chunk.padded_text` на **одном** чанке
    (последнем прилетевшем). Если последний чанк (например, пост-нарратив с коротким текстом)
    имел `padded_text=true`, `trimPaddedSceneAudio()` обрезала **все** чанки (narration +
    dialogue), отрезая ~45% каждого. Диалоговые чанки теряли вторую половину содержания.
  - **Корень:** при гибридной сцене (9 сегментов: нарратив + 7 диалогов + пост-нарратив)
    чанк 9 прилетает последним → `chunk.padded_text === true` → цикл режет все 9.
  - **Фикс:** `padded_text` проверяется для каждого чанка индивидуально через
    `deps.getChunk()`. Только чанки с реальным паддингом (< 40 символов, продублированный
    текст) получают trim. Обычные нарратив и диалоги остаются нетронутыми.
  - `generateSceneAudio` в `generation.js` и логика stale cache не затронуты.

- **Placeholder merged audio блокировал multi-chunk merge**
  (`backend/src/audio/generation.js`):
  - **Проблема:** после «Удалить Сториборд» + reopen + GENERATE, `recoverMissingPlaceholders()`
    создавал placeholder MP3 на диске. `generateSceneAudio()` обнаруживал placeholder и
    запускал TTS для 9 сегментов, но старый placeholder-файл не удалялся. Каждый прибывающий
    чанк вызывал `triggerAudioMerge()`, который видел `fs.existsSync(merged.mp3) → true`
    (старый placeholder) и выходил без merge. Multi-chunk merge никогда не стартовал.
  - **Фикс:** при обнаружении placeholder (`asset.status === 'placeholder'`) `generateSceneAudio()`
    удаляет старый merged placeholder-файл перед отправкой TTS. `triggerAudioMerge()` больше
    не находит его и нормально ждёт все чанки.

- **Per-chunk stale `padded_text` detection**
  (`backend/src/audio/generation.js`):
  - **Проблема:** cover-сцена sc-12a6ff03 с `expected_chunk_count=1` не перегенерировалась
    после изменения паддинга, потому что count-based stale check не срабатывал (count не
    изменился). Старый чанк с `padded_text=false` оставался, новый паддинг не применялся.
  - **Фикс:** в цикле обработки существующих чанков добавлена проверка
    `existing.padded_text !== expectPadded`. При несовпадении флага: удаление файла + Redis
    метаданных + создание свежих метаданных с `audio_status:'pending'`, затем fall-through
    к TTS. Все 522 теста проходят.

### Added

- **Тесты на паддинг и гибридные сегменты**
  (`backend/tests/audio-segments.test.js`, 49 тестов):
  - `padShortText` — граничные условия (< 40, ≥ 40, пунктуация).
  - `extractNarrationFromDialogueUnit` — Pattern A (post), Pattern B (pre), оба,
    pure dialogue, null, word-boundary guard (substring collision), мультиязык.
  - `buildSegments` narration — паддинг короткого текста, cover, chapter_intro.
  - `buildSegments` dialogue — гибрид pre/post/оба, fallback для substring collision,
    interleaving, typography skip, пустые юниты, паддинг short embedded narration.
  - `narratorVoice` — voices.narrator, bible fallback, voice override.

### Fixed

- **Гибридные сцены (narration + dialogue в одной scene) — narration юниты больше не игнорируются**

- **Гибридные сцены (narration + dialogue в одной scene) — narration юниты больше не игнорируются**
  (`backend/src/audio/segments.js`):
  - **Проблема:** `buildSegments()` для dialogue-сцен фильтровал только `type === 'dialogue'` юниты.
    Если AI создавал гибридную сцену с narration + dialogue юнитами (например, пейзажное описание,
    затем диалог), narration юниты бесшумно отбрасывались. Диалог генерировался, нарратив терялся →
    рассинхрон аудио с визуальным рядом.
  - **Фикс:** dialogue-ветка `buildSegments()` теперь итерируется по ВСЕМ юнитам сцены в порядке
    следования. Каждый юнит становится отдельным TTS-сегментом:
      - `type === 'dialogue'` → `segment_type: "dialogue"` → TTS workflow с character voices
      - `type === 'narration' | perception | description | action | transition | performance`
        → `segment_type: "narration"` → Narrator TTS workflow (голос диктора)
      - `type === 'typography'` → skip (не озвучивается)
  - Паддинг коротких narration-текстов (`padShortText`) и чанкинг длинных (`splitTextIntoChunks`)
    работают стандартно для narration-сегментов в гибридной сцене.
  - Вся audio генерация (`generateSceneAudio()`) уже поддерживает миксы — каждый сегмент
    проверяется по `segment.segment_type` и маршрутится на правильный TTS workflow.
    Изменение только в `buildSegments()`, остальной пайплайн не тронут.
  - 473/473 тестов проходят.

### Added

- **Диалоговые TTS: литературный `full_text`, TTS-скрипт из `units[].speaker`**
  (`backend/src/book/lazy-book/create.js`, `backend/src/audio/segments.js`,
  `backend/ai/examples/ch-319c798a.json`):
  - `audio.full_text` теперь хранится в **литературном формате** (`— Но ведь Иисуса не существовало!`).
    Ранее был формат скрипта (`bezdomny: текст`).
  - `buildSegments()` строит TTS-скрипт из `units[].speaker`: ищет юниты с `type='dialogue'` и `speaker`,
    собирает `speaker: текст`. Fallback на парсинг `audio.full_text` для обратной совместимости.
  - `ai/examples/ch-319c798a.json`: `full_text` диалоговой сцены переведён в литературный формат.
  - Все 473 теста проходят.

- **TODO doc** (`docs/07-agents-and-generators/DIALOGUE_TTS_PIPELINE.md`):
  - Документ-план с архитектурой, списком изменений и тестирования.

- **Выделенный AI-шаг генерации голосов персонажей** (`backend/src/services/agent-prompts.js`,
  `backend/src/services/agent/pipeline-steps.js`, `backend/src/services/agent/pipeline-runner.js`):
  - Добавлен `stepGenerateVoices()` — отдельный шаг в AI pipeline, вызываемый после character extraction
    и перед scene creation.
  - Новый системный промпт `voice_generation` с цепочкой приоритетов: explicit voice description →
    inference из appearance (возраст, пол, телосложение, конституция) → role/traits → default profile.
  - Голоса генерируются ТОЛЬКО для персонажей, у которых есть диалоговые реплики в тексте.
  - Narrator добавляется программно (не AI), стандартный шаблонный профиль.
  - В последующих окнах (subsequent windows) голоса НЕ перезаписываются — voice drift исключён.
  - При failure шага голоса не теряются (keep existing).
  - Все 473 теста проходят.

### Changed

- **Character extraction промпт очищен от voice-логики** (`backend/src/services/agent-prompts.js`):
  - Удалено поле `voice` из character extraction — это был dead code, так как voice уже перезаписывался
    отдельным шагом. Теперь character extraction отвечает только за: id, name, role, description, appearance, traits.
  - Single responsibility: character extraction → извлечение персонажей; voice generation → создание голосов.

### Removed

- **Fallback в `buildSegments()` для старых vbook** (`backend/src/audio/segments.js`):
  Убран мёртвый код, который парсил `audio.full_text` как TTS-скрипт при отсутствии `units[].speaker`.
  Теперь если dialogue-сцена не имеет юнитов со speaker — возвращается `[]` с warning в логах.
  Старых vbook с форматом скрипта в `full_text` не существует.

### Fixed

- **Два прогресс-бара после повторного открытия .txt** (`frontend/.../GenerateViewModel.kt`):
  - **Проблема:** при повторном открытии уже импортированной .txt книги показывалось два
    прогресс-бара по 10 секунд каждый: первый «100/100 100%» (VBook COMPLETED), второй
    «100%» зелёный (generic DoneRow). Если плеер уже играл — после завершения цикла
    `applyGenerationResults()` сбрасывал плеер в IDLE.
  - **Причина 1 — Race condition:** в dedup-пути `vbookProgress = ANALYZING` ставился
    *до* проверки `if (importRes.dedup)`. Распараллеленный поллер успевал увидеть ANALYZING,
    вызвать `checkVBookAgentStatus()` → агент неактивен → перевести в COMPLETED → VBook
    DoneRow на 10 секунд.
  - **Причина 2 — Stale worker state:** `_workerPermanentlyDone` и `workerCompletedAt`
    хранили данные от предыдущей сессии (если процесс Android жив). При вызове
    `computeWorkers(null, IDLE, ...)` workers пуст, но `_workerPermanentlyDone` не пуст →
    generic DoneRow ещё на 10 секунд.
  - **Фикс 1:** `shouldRefresh = panel != null` — рефреш только при наличии GPU-данных.
  - **Фикс 2:** `resetWorkerState()` + `vbookProgress = IDLE` в начале `importBookFromFile()`
    — чистит stale tracking данные при любом импорте.
  - **Фикс 3:** `vbookProgress = ANALYZING` и `startProgressStream()` перенесены в
    non-dedup ветку (после `return@launch` в dedup). Для dedup vbookProgress никогда
    не становится ANALYZING → поллер не может перевести в COMPLETED.

- **Сториборд возвращал пустые IU после DELETE /cache** (`backend/src/routes/generation-routes.cjs`):
  - **Корень:** в scene-based `/api/v1/scene/:bookId/:chapterId/:sceneId/storyboard` fallback на
    книжный JSON использовал shorthand `scene_id` в `ius.push({...})`, но такой переменной нет —
    параметр роута называется `sceneId` (camelCase). `ReferenceError` ловился внутренним catch,
    `ius` оставался пустым → API возвращал `ius: []`.
  - **Фикс:** `scene_id` → `scene_id: sceneId` (explicit key-value). Fallback теперь переписан на
    `book.findSceneRuntimeData()` + `book.collectSceneUnits()`.
  - **Дополнительно:** scene status endpoint читал `sc.scene_type` → исправлено на `sc.type || sc.scene_type`
    (в book.json поле называется `type`, не `scene_type`). Cover сцены теперь корректно возвращают
    `scene_type: "cover"` вместо `"narration"`.

- **Сториборд игнорировал PG-строки с null text после DELETE /cache** (`backend/src/routes/generation-routes.cjs`):
  - **Проблема:** после очистки кеша у сцены `sc-4bb4f750` в PG остались 3 строки с `text: null`
    (созданные старым кодом `scene_id` → ReferenceError, который не дал записать текст).
    Сториборд читал PG первой → находил 3 строки → возвращал `ius: [{text: null}, ...]`.
    Fallback на книжный JSON не вызывался, так как `pgRows.length > 0`.
  - **Фикс:** PG-строки используются только если `pgRows.some(r => r.text != null && r.text !== '')`.
    Если все строки имеют null/пустой текст — фоллбэк на book JSON, где есть реальные тексты юнитов.
  - `sc-9806baf1` работал потому что у него PG-строки имели реальный текст (has_text: true),
    а `sc-4bb4f750` — нет (has_text: false).

### Removed

- **Mёртвый код старой chunk-архитектуры** — полная зачистка (`frontend/.../GenerateViewModel.kt`,
  `frontend/.../PlaybackViewModel.kt`, `frontend/.../PlayFragment.kt`,
  `frontend/.../Repository.kt`, `frontend/.../BackendApi.kt`,
  `frontend/.../ChunkListResponse.kt`):
  - **`ChunkListResponse.kt`** (включая `ChunkPosition`) — удалён целиком. Больше не используется
    ни одним компонентом.
  - **`Repository.getAllChunks()` и `BackendApi.getAllChunks()`** — удалены. Фронт больше не ходит
    на `/api/v1/book/:id/chunks` за навигацией. Навигация строится из book JSON.
  - **`GenUiState.chunkIds`** — удалён из data class. Ни один UI-компонент не читал это поле;
    все `_uiState.update { it.copy(chunkIds = ...) }` убраны.
  - **`PlaybackViewModel.getCurrentChunkId()`** — удалён deprecated alias. Все вызовы заменены на
    `getCurrentSceneKey()`.
  - **`PlaybackViewModel.currentChunkIndex`** → переименован в `currentSceneIndex`.
  - **`PlaybackViewModel.chunkQueueSize`** → переименован в `sceneQueueSize`.
  - **Внутренние переменные** `pendingChunkAudio/Video/IuSequence` → `pendingScene*`,
    `chunkSeqCounter` → `sceneSeqCounter`, `lastProcessedChunkSequence` → `lastProcessedSceneSequence`.
  - **`emitChunk()`** → переименован в `emitScene()`.
  - **`importBookFromFile`** — оба пути (vbook dedup + txt new import) больше не вызывают
    `getAllChunks()` для навигации. Навигация строится из book JSON напрямую.
  - Бэкенд (`getAllChunks` в `redis-helpers.cjs` и 40+ references) **не тронут** — это внутренняя
    инфраструктура TTS пайплайна, прогресс-панели, кеша и восстановления.

### Added

- **Android cache invalidation on placeholder→ready transition**
  (`backend/src/routes/generation-routes.cjs`,
  `frontend/.../repository/ChunkResponse.kt`,
  `frontend/.../repository/Repository.kt`,
  `frontend/.../util/SimpleDiskCache.kt`):
  - **Backend**: `audio_status` добавлен в `/api/v1/chunk/:id` response. Позволяет Android
    отличать `placeholder` (тишина) от `ready` (реальное TTS-аудио).
  - **Android ChunkResponse**: добавлено поле `audio_status: String?`.
  - **Android SimpleDiskCache**: добавлен метод `remove(key, type)`.
  - **Android Repository.getChunk()**:
    - Metadata с `audio_status='placeholder'` **не кешируется** (нестабильна — заменится
      при генерации реального аудио).
    - При детекте перехода `placeholder→ready` инвалидируется audio cache (in-memory + disk)
      для chunk audio и scene audio. Следующий вызов `getChunkAudio()`/`getSceneAudio()`
      пойдёт в сеть и скачает свежее реальное аудио вместо кешированной тишины.
  - В паре с фиксом `expected_chunk_count` в `startScene()` решает проблему:
    «после генерации в локальном кеше остались плэйсхолдеры, аудио не обновилось».

- **Scene duration validation loop with targeted retries**
  (`backend/src/services/agent/pipeline-runner.js`,
  `backend/src/services/agent/pipeline-steps.js`,
  `backend/src/services/agent-prompts.js`):
  - **Программная валидация длительности** — после сплита сцен каждая сцена проверяется
    через `estimateSpeechDurationSec()` (существующий single source of truth, ~0.3s/word).
    Если estimated duration превышает `SCENE_MAX_SEC=30s`, запускается targeted retry.
  - **Цикл до 3 retry** (`MAX_DURATION_RETRIES=3`) — каждая попытка даёт агенту конкретную
    обратную связь: точная длительность каждой too-long сцены, hard limit, и опция
    (A) SHORTEN — сократить, или (B) SPLIT — разделить на две+ сцены.
  - **Retry exhaustion** — после исчерпания всех попыток логируется `console.error`
    с деталями, а не молчаливое принятие. Бесконечный цикл исключён.
  - **Усилен base prompt** — в начало промпта сцен добавлен заметный баннер
    `⚠️ DURATION LIMITS — HARD REQUIREMENTS` с hard limit 30s и target 20s.
  - **Исправлен баг** — в `pipeline-steps.js` не были импортированы `SCENE_TARGET_SEC`
    и `SCENE_MAX_SEC` (ReferenceError при duration retry).
  - `duration_retry_count` добавлен в лог `agent_window_coverage`.
  - Все 473 теста проходят.

### Changed

- **Playback queue и TTS pipeline развязаны** (`backend/src/routes/book/chunks-routes.cjs`,
  `backend/src/audio/generation.js`, `backend/src/services/task-handler.cjs`,
  `backend/src/helpers/redis-helpers.cjs`):
  - **Проблема:** `getAllChunks()` возвращал сегменты TTS-пайплайна (`_0002`, `_0003`) как
    отдельные треки для плеера. Длинные сцены (сплит на 3 части по 250 символов) игрались
    3 раза подряд, так как все чанки одной сцены вели к одному merged-аудиофайлу.
  - **Архитектура:** `animastor:chunks:` — внутренний сет для пайплайна (может содержать
    любое количество entry). `/api/v1/book/:bookId/chunks` — дедуплицирует ответ по
    `(chapter_id, scene_id)`, возвращая ровно 1 entry на сцену для плеера.
  - `progress-panel` использует `getAllChunks()` напрямую (все entry), показывая
    гранулярный прогресс 0/9, 1/9... по реальным сегментам TTS.
  - `getAllChunks()` улучшен: вторичная сортировка по `chunk_index` для одинаковых сцен.
  - **Результат:** плеер играет 5 сцен по JSON-порядку, прогресс показывает 0/9 → 9/9.

### Fixed

- **DELETE book и DELETE cache — полная очистка всех PG таблиц**
  (`backend/src/routes/book/core-routes.cjs`, `backend/src/routes/book/cache-routes.cjs`):
  - **Было:** один try/catch на 14 DELETE запросов. Если одна таблица не существовала
    (например, `scene_assets_state` — реальное имя `asset_states`), SQL ошибка прерывала
    весь блок, и **ни одна PG таблица не очищалась**.
  - **Стало:** каждый DELETE обёрнут в индивидуальный try/catch. Несуществующие таблицы
    просто логируют warning и не блокируют остальные.
  - Удалены несуществующие таблицы: `scene_assets_cache`, `scene_assets_state`
    (реальная: `asset_states`), `scene_images`, `scene_videos`.
  - Добавлены реальные пропущенные таблицы (25 шт.): `image_units`, `scenes`,
    `asset_states`, `asset_dependencies`, `generation_tasks`, `reconciliation_events`,
    `output_manifests`, `storyboard_elements`, `audio_layers`, `ai_chat_sessions`,
    `character_resolution_runs`, `character_window_candidates`, `sentence_resolutions`,
    `character_mentions`, `character_aliases` и другие.
  - `books` удаляется **последним** (его FK каскады на `book_snapshots`,
    `storyboard_elements`, `audio_layers`).
  - `agent_sessions` удаляется явно → каскад на `agent_steps`, `agent_conversations`,
    `agent_messages`.
  - `DELETE /cache` теперь тоже чистит все 24 таблицы (без `books` — книга сохраняется).

- **Cache clear теперь удаляет все PG-таблицы книги** (`backend/src/routes/book/cache-routes.cjs`):
  - `DELETE /api/v1/book/:bookId/cache` теперь удаляет все 13 PG-таблиц для книги (аналогично `DELETE /book`),
    включая `scene_assets`, `book_events`, `book_source`, `chat_messages`, `agent_sessions` и другие.
  - Ранее не удалялась таблица `scene_assets`, из-за чего после очистки кэша в PG оставался
    `status='ready'`, блокируя создание placeholder-аудио через `recoverMissingPlaceholders()`.
  - Это вызывало цепочку: Audio not ready → плеер играет одну сцену по кругу → Navigator крашится.

- **Плеер больше не зависает на одной сцене после перегенерации** (`frontend/.../PlaybackViewModel.kt`,
  `frontend/.../PlayFragment.kt`):
  - **`playNext()`** — при достижении конца очереди чанков теперь сбрасывает `currentIndex = 0` вместо
    того, чтобы оставлять index за границами массива. После этого пользователь может нажать Play
    и начать воспроизведение с начала.
  - **Play button handler** — добавлена проверка `currentChunkIndex >= chunkQueueSize`: если индекс
    вышел за границы очереди, вызывается `playSceneQueue()` (рестарт с начала) вместо
    `resumeFromCurrentScene()` (который пытался играть с невалидного индекса и сразу возвращал
    SCENE_READY, ничего не играя).
  - **`fetchSceneData()`** — если `audio_ready = true` но загрузка аудио вернула пустой массив,
    теперь выбрасывается исключение (с ретраем через `retryWithBackoff`), а не передаётся пустое
    аудио в `handleSilentChunk()`, который вызывал бесконечный цикл IU-изображений одной сцены.
    Ранее: скачанное пустое аудио → `handleSilentChunk` → `startSilentIuCycling` →
    `(currentIuIndex + 1) % ius.size` → вечное прокручивание IU одной сцены без вызова
    `onAudioCompleted()`. Теперь: пустое аудио при `audio_ready=true` → Exception → retry.

- **Audio merge — `expected_chunk_count` not updated for existing chunks** (`backend/src/audio/generation.js`):
  - `generateSceneAudio()` now always updates `expected_chunk_count` when refreshing existing chunk metadata.
    During import, chunk `_0001` was created with `expected_chunk_count: 1`, but `buildSegments()` may produce
    more segments. Without this update, `_0001` retained `expected_chunk_count=1`, causing `triggerAudioMerge`
    to merge prematurely (single chunk) instead of waiting for all chunks to arrive.
  - Added Redis asset state check in the `isReady` path: if audio state is `PENDING` (marked dirty for
    regeneration), `generateSceneAudio()` now regenerates even if the merged audio file exists on disk.
    Previously, Dirty regeneration was stuck because the old merged file made `isSceneAudioReady()` return true.
  - Both code paths (isReady and not-isReady) now consistently set `existing.expected_chunk_count`.

- **Audio merge retry exhaustion — re-dispatch missing chunks** (`backend/src/services/task-handler.cjs`):
  - When `triggerAudioMerge` exhausts `MAX_RETRIES=5`, it no longer silently gives up. Instead:
    1. Identifies which chunk indices are missing from disk.
    2. Clears GPU hub dedup keys (`animastor:job:`, `animastor:result-processed:`) for missing chunks.
    3. Resets missing chunk metadata to `audio: false, audio_status: 'pending'`.
    4. Clears dispatch lease, metadata, and completion markers for audio stage.
    5. Resets asset state to `PENDING` so the scheduler re-dispatches audio on the next tick.
  - On re-dispatch, `generateSceneAudio()` skips existing chunks on disk (cache hit) and only sends
    the missing chunks to ComfyUI, avoiding redundant TTS generation for already-completed segments.

- **DELETE /cache больше не удаляет book_source и chat-историю**
  (`backend/src/routes/book/cache-routes.cjs`):
  - Из списка PG-таблиц, очищаемых при DELETE /cache, убраны `book_source`, `book_snapshots`,
    `chat_messages`, `chat_sessions`, `book_events`. Эти таблицы содержат идентификационные
    данные книги (book_source для dedup), историю чатов пользователя и логи событий —
    они не являются сгенерированным кешем.
  - При повторном импорте того же `.txt` файла dedup теперь срабатывает корректно:
    находит существующую книгу в `book_source` и не запускает генерацию vbook заново.

- **«Удалить Сториборд» больше не закрывает книгу**
  (`frontend/.../SettingsFragment.kt`):
  - **Было:** кнопка «Удалить Сториборд с сервера» (`clearCacheButton`) вызывала
    `viewModel.clearBookCache()`, который обнулял `bookId` → Navigator показывал
    «Книга не загружена».
  - **Стало:** кнопка вызывает `viewModel.repository.clearBookCache(bookId)` напрямую,
    что очищает только сгенерированные ассеты на сервере (DELETE /cache), но **не закрывает
    книгу**. Navigator продолжает показывать структуру книги (главы, сцены).
  - `playbackViewModel.closeBook()` — сбрасывает плеер (аудио/видео/состояние).
  - `viewModel.resetWorkerState()` — сбрасывает tracking генерации.

## [Unreleased] — 2026-07-10

### Added

- **Book export/download backend endpoints** (`backend/src/routes/book/export-routes.cjs`):
  - `GET /api/v1/book/:bookId/export` — упаковка книги в ZIP: book JSON, audio, images, video.
  - `GET /api/v1/book/:bookId/download` — скачивание book.json напрямую.
  - Коммит: `d2d3a75`

- **Cinema-styled layer toggle chips for player controls** (`frontend/app/.../fragment_play.xml`,
  `frontend/app/.../layer_chip_*.xml`):
  - Переключатели слоёв (audio, image, video) в стиле cinema-панели.
  - Коммит: `6ae65a3`

### Fixed

- **Regenerate cleanup — только dirty-сцены** (`backend/src/routes/book/generation-routes.cjs`,
  `backend/src/runtime/runtime-scheduler.js`, `backend/src/runtime/dispatch-engine.js`):
  - `removeScenesFromActiveIndex()` — удаляет из active index только указанные сцены (SREM).
  - `clearLeasesForScenes()` — batch DELETE lease/meta/completed ключей для указанных сцен.
  - `clearGpuHubQueues()` — централизованная очистка GPU hub очередей и dedup-ключей.
  - Ранее `clearBookFromActiveIndex()` и `clearAllLeasesForBook()` удаляли **все** сцены книги,
    убивая параллельную генерацию других сцен в той же книге. Теперь очистка точечная.
  - Счётчики quota больше не сбрасываются при регенерации (force-dispatch сам корректирует).
  - Коммит: `89fb6c4`
  - См. также: `docs/02-orchestration/GPU_HUB_CLEANUP.md`

- **TTS chunk size reduced to 250 chars** (`backend/src/audio/audio-service.js`,
  `backend/src/audio/chunks.js`):
  - Уменьшен размер TTS-чанков с 500 до 250 символов для предотвращения
    обрезания (truncation) моделью Qwen.
  - Исправлен race condition при мерже аудио — добавлен retry-цикл.
  - Коммит: `c042a7b`

- **build_id now resolved from book manifest.json** (`backend/src/routes/generation-routes.cjs`,
  `backend/src/routes/debug-routes.cjs`):
  - Все read-эндпоинты (waveform, timings, audio) теперь читают build_id из
    `manifest.json` книги через `getEffectiveBuildId()` вместо хардкода `'default'`.
  - Коммиты: `1fbd0c8`, `c9f7df5`

- **AI <think> reasoning blocks stripped on backend** (`backend/src/routes/ai-routes.cjs`,
  `backend/src/helpers/utils.cjs`):
  - Теперь stripping происходит на бэкенде, а не на фронтенде, чтобы <think>-блоки
    не попадали в историю чата вообще.
  - Коммиты: `48a1954`, `c2f37e4`

- **Hardcoded Russian UI strings replaced with English** (`frontend/.../GenerateViewModel.kt`,
  `frontend/.../MainActivity.kt`):
  - Заменены хардкодные русские строки на английские в GenerateViewModel и MainActivity.
  - Изменён лейбл таба редактирования с множественного "Units/Модули" на единственное
    "Unit/Модуль".
  - Коммиты: `951c980`, `8b626fa`

### Documentation

- **GPU_HUB_CLEANUP.md** (`docs/02-orchestration/GPU_HUB_CLEANUP.md`):
  - Новая документация по очистке stale-задач GPU Hub при регенерации.
  - Описаны все 5 шагов очистки: dedup-ключи, очереди, running, result-кэш.
  - Описаны scene-specific функции `removeScenesFromActiveIndex` и `clearLeasesForScenes`.
  - Полный протокол регенерации и cancel-generation.

- **REGENERATION_SYSTEM.md updated** (`docs/02-orchestration/REGENERATION_SYSTEM.md`):
  - Добавлен раздел про scene-specific очистку.
  - Обновлён протокол POST /regenerate с новыми шагами 8–10.
  - Обновлён Redis Key Space.
  - Исправлен pre-existing issue в шаге очистки.

- **ARCHITECTURE.md updated** (`docs/01-overview/ARCHITECTURE.md`):
  - Упомянуты новые функции в Runtime Scheduler, Dispatch Engine, Generation Routes.
  - Ссылка на GPU_HUB_CLEANUP.md.

## [Unreleased] — 2026-07-09

### Fixed

- **IU timings теперь рассчитываются от реальной длительности аудио, а не от плэйсхолдера**
  (`backend/src/image/iu-processor.js`, `backend/src/orchestration/scene-callbacks.js`):
  - `getSceneDuration()` — новый приоритет: mp3-файл → scene_assets (ready) → image_units (stale) → scene_assets (placeholder).
    Раньше первым был `image_units.scene_duration_sec` (устаревшее значение от плэйсхолдера), из-за чего IU тайминги
    (start_ms/end_ms) были пропорциональны плэйсхолдеру (~0.3s/word), а не реальному TTS-аудио.
  - `handleAudioCompleted()` — при приходе реального аудио пересчитывает все IU тайминги пропорционально новой
    длительности, если Δ > 1s. Обновляет `scene_duration_sec`, `estimated_duration_sec`, `start_ms`, `end_ms`.
  - Все 473 теста проходят.
  - Решает проблему: «реальные IU имеют больший тайминг, чем расчётные; при ручной правке 3 юнитов остальные
    сдвигаются и не помещаются полностью».

- **build_id теперь всегда записывается в манифест при создании книги**
  (`backend/src/book/lazy-book/draft.js`):
  - `createDraftBook()` теперь добавляет `build_id: build_<bookId>` в манифест.
  - Раньше манифест не содержал build_id, и все роуты фоллбечились на `'default'`,
    из-за чего IU создавались под build_id='default' вместо реального билда.
  - Все 473 теста проходят.

### Chore

- **Очистка БД, Redis и диска** — удалены все остатки старых книг:
  - PostgreSQL: TRUNCATE всех 30 таблиц (данные, схема сохранена)
  - Redis: FLUSHALL
  - /data/books/ и /data/output/ очищены

## [Unreleased] — 2026-07-08

### Added

- **Storyboard Polish — continuity correction step** (`backend/src/services/agent-prompts.js`,
  `backend/src/services/agent/pipeline-steps.js`, `backend/src/services/agent/pipeline-runner.js`):
  Новый этап постобработки визуальных юнитов. После генерации всех IU для окна вызывается
  `stepPolishStoryboard` — AI в роли Storyboard Supervisor согласовывает последовательность
  кадров: правило 180°, прогрессия крупности планов, непрерывность позиционирования
  персонажей, отсутствие телепортаций. Меняет только `visual.prompt` и `visual.shot`.

- **Passport Reconciliation — Сверка паспортов** (`backend/src/services/agent-prompts.js`,
  `backend/src/services/agent/pipeline-steps.js`, `backend/src/services/agent/pipeline-runner.js`):
  Новый этап перед Storyboard Polish. AI удаляет семантические дубликаты описаний из
  `visual.prompt`, которые конфликтуют с автоматически инжектимыми паспортами персонажей
  (base_appearance, clothing_base и т.д.). Убирает «две шляпы» — повторяющиеся признаки.
  Step type `reconcile_passports` добавлен в check constraint БД.

- **scene.passport override mechanism** (`backend/src/image/prompt-builder.js`):
  `resolvePassport` теперь проверяет `scene?.passport?.[c.id]` с наивысшим приоритетом.
  Позволяет переопределить поля глобального паспорта (clothing_base, appearance и т.д.)
  на уровне конкретной сцены — для смены одежды, ранений, временных изменений.

### Changed

- **MAX_WINDOW_CHARS теперь вычисляется из MAX_SCENES_PER_CHUNK** (`agent-prompts.js`):
  `MAX_WINDOW_CHARS = 100 + MAX_SCENES_PER_CHUNK × 1300` вместо хардкода 4000.
  При изменении количества сцен на окно символьный бюджет подстраивается автоматически.

- **VBook progress — циклический индикатор** (`frontend/.../GenerateViewModel.kt`,
  `frontend/.../MainActivity.kt`): `WorkerUi.indeterminate` для VBook-этапов (ANALYZING,
  CREATING_SCENES). Скрывает x/y и z%, показывает циклический spinner.

- **locations.json больше не содержит visual_style и default_mood** (`lazy-book/create.js`):
  Убраны поля-пустышки, которые не несли смысловой нагрузки. `cinematic_space` оставлен
  (используется для fuzzy-матчинга в prompt-builder.js).

### Removed

- **voice из characters.json** (`ai/examples/characters.json`, `lazy-book/create.js`):
  Поле `voice` удалено из character-объектов при записи в `characters.json`.
  Голоса хранятся только в `voices.json`.

---

## [Unreleased] — 2026-07-07

### Changed

- **Scene title generation moved to enrichment step** (`backend/src/services/agent/pipeline-steps.js`):
  `stepEnrichScenes()` теперь отвечает за генерацию заголовков сцен (title).
  Убран конфликт между chapter-title и scene-title в промпте создания сцен.

- **Locations prompt — запрет создания локаций из персонажей** (`agent-prompts.js`):
  Добавлено явное правило: "Do NOT create locations for characters, people, groups,
  or their actions/descriptions". Запрещены лишние поля (visual_style, cinematic_space,
  default_mood) в locations prompt.

- **Visual prompt — AI больше не пишет location** (`agent-prompts.js`):
  Из guiding question убран `WHERE`. AI пишет только `character_id`; location
  inject-ится автоматически в `buildImagePrompt`.

- **Generic nouns — строгое правило** (`agent-prompts.js`):
  Добавлено: "STRICT RULE — ALWAYS write character_id, never generic noun".
  Если в Characters in scene есть character_id, AI обязан использовать exact ID,
  а не generic nouns ("the editor", "the bald man").

- **Визуальный промпт — запрет location в grounding** (`agent-prompts.js`):
  Grounding rule: "Do NOT name the scene's setting (city, street, park, room) —
  it is set by scene.location.id."

- **Hardcoded 3 заменён на MAX_SCENES_PER_CHUNK** (`pipeline-steps.js`):
  В repair-текстах возврата "at most 3" заменено на `at most ${MAX_SCENES_PER_CHUNK}`
  и "stop after scene 3" → "stop after scene ${MAX_SCENES_PER_CHUNK}".

### Fixed

- **Progress messages in chat** (`agent-routes.cjs`):
  `pollDuringBootstrap` теперь захватывает промежуточные стадии прогресса.
  Исправлен дубликат через `initialLastMsg`.

- **VBook progress messages in chat** (`agent-service.js`, `window-generator.cjs`):
  Первое окно показывает детальные стадии; последующие окна — минимальный summary.

- **Coverage comparison — нормализация кавычек/тире/пробелов** (`source-coverage.js`):
  Нормализует `\r\n`→`\n`, NBSP→space, кавычки и тире перед сравнением coverage.
  Добавлен `gap_preview` для отладки.

- **Debug `gap_preview` log removed** (`source-coverage.js`):
  Убран избыточный debug-лог.

---

## [Unreleased] — 2026-07-02

### Fixed

- **VBook progress uses actual generated-block counters** — backend SSE events now
  include `window_scene_index`, `window_total_scenes`, and `window_start_scene`.
  `/agent-status` exposes the same block metadata when it can be derived from
  `agent_sessions.window_data`. Android uses those exact counters first and treats
  `window_size` only as a legacy fallback cap. This fixes incorrect modulo-based
  progress after a previous block produced fewer than 3 scenes.

- **Generic scene titles from fallback splitter** (`backend/src/services/agent-service.js`,
  `backend/src/book/lazy-book/index.js`): `buildFallbackScenes()` no longer assigns
  `"Scene N"` titles — instead `extractSceneTitle()` extracts a meaningful title from
  the scene text (first sentence, ~8 words max). `createOrAppendScenes()` also detects
  and replaces generic AI-generated titles like `"Scene 1"` / `"Сцена 2"` with
  text-extracted titles. This fixes scenes 2–4 in the first VBook window showing
  placeholder names instead of descriptive Russian titles.

- **Backtick syntax error in agent-prompts.js** — unescaped `` `.` `` backtick
  literals inside a template literal (line 156) caused `SyntaxError`.

- **Scene splitting duration validation** — scenes are now validated against
  `SCENE_MAX_SEC=30s` (soft) and `SCENE_TARGET_SEC=20s` during the split,
  not only after persistence. Oversized scenes trigger one AI retry with
  duration feedback, then are accepted with a warning to avoid coverage gaps.

- **Scene coverage no longer forces full-buffer consumption** — the splitter now
  validates that generated scenes form a contiguous verbatim prefix of the
  1500-character buffer. Unused buffer tail is left for the next call instead of
  being skipped by advancing to the planned buffer end.

- **Deterministic fallback is sentence-aware** — `buildFallbackScenes()` now
  uses `splitIntoSentences()` to group whole sentences into ~20s scenes,
  falling back to paragraph-even split only when no sentence boundaries exist.
  The old fallback split by paragraphs regardless.

### Changed

- **Agent prompt (scenes):** Replaced `"EXACTLY 3 scenes"` with "up to 3 scenes"
  over the provided buffer. The prompt keeps the ~20s target and ~30s soft
  ceiling, but allows the agent to stop before consuming all buffered text.

- **Unified validation in runPipeline:** Coverage (hard) and duration (soft)
  validated in a single post-AI loop with one repair retry. Coverage is checked
  for the generated prefix; `currentOffset` advances from `next_offset` /
  last-scene coverage, not from `MAX_WINDOW_CHARS`.

- **Cross-window seam diagnostic:** `bootstrapNextWindow()` logs a warning if
  visible (non-header, non-whitespace) text exists between the previous
  window's covered end and the next window's narrative start.

### Added

- **`estimateSpeechDurationSec(text)`** — pure function in
  `placeholder-audio.js`, 0.3s/word, min 2s. Replaces inline word counting
  and is usable at scene-split time (no DB access).

- **`splitIntoSentences(text)`** — sentence tokenizer in `agent-service.js`
  that splits on `. ! ? …` with closing-quote consumption, plus paragraph
  breaks. Exported for testing.

- **Constants in agent-prompts.js:** `SCENE_TARGET_SEC=20`, `SCENE_MAX_SEC=30`,
  `SCENE_MIN_SEC=5`, `MAX_SCENES_PER_CHUNK=3`.

- **Unit tests** (`tests/scene-split.test.js`, 21 tests) for
  `estimateSpeechDurationSec`, `splitIntoSentences`, and
  `buildFallbackScenes`.

- **Audit script** (`scripts/audit-scenes.js`) — scans all books on disk,
  checks scene durations against targets and verifies source coverage
  continuity per chapter.

---

## [Unreleased] — 2026-07-01

### Fixed

- **Chapter title duplication (frontend)** — When `chapter_title` already contains
  `"Глава 1 — Name"`, frontend no longer prepends another `"Глава 1 — "` prefix.
  4 methods in AiAssistantFragment.kt (updateContextBar, addContextualPosition,
  addContextualWelcome, sendMessage), 2 in NavigateFragment.kt (updatePositionBar,
  rebuildStructure), 1 in EditFragment.kt (updatePositionLabel).

- **chapter_intro scene_title shortened** — Backend lazy-book/index.js:
  programmatic chapter_intro scene now uses short `"Глава 1"` as scene_title
  instead of full `"Глава 1 — НИКОГДА НЕ РАЗГОВАРИВАЙТЕ..."`.

### Changed

- **AI prompt: EXACTLY 3 scenes + ~65 word guideline** — agent-prompts.js
  scenes prompt: `"Split the text into EXACTLY 3 scenes"` with ~65 word limit
  (≈20s audio at Russian speech rate). Natural boundaries preferred over
  equal-length chunks. If a sentence ends slightly over ~65 words, finish it
  — do NOT cut mid-sentence.

- **Progress shows real scene count** — frontend GenerateViewModel.kt:
  `totalInWindow` tracks actual scene count per window (via `lastSceneWindowMax`)
  instead of hardcoded `windowSize = 3`. Shows accurate progress like 2/2 or 3/3.

### Removed

- **Programmatic scene splitting** — agent-service.js: removed while-loop that
  artificially split large scenes by paragraphs. AI now handles scene division
  via prompt instruction alone.

---

## [Unreleased] — 2026-07-05

### Removed

- **`unit.participants` from entire system** — LLM no longer generates `participants`
  for units. `coreference.js` (unit-level validation) and `applyScenePairParticipantFallback`
  removed. `inferCharactersFromPrompt` promoted from fallback to primary method for
  character passport injection — passports are now injected ONLY for characters mentioned
  in the unit's visual prompt text, never from `scene.participants`.
  
  Affected files:
  - `agent-prompts.js` — cleaned units/visuals prompts
  - `pipeline-steps.js` — removed unit.participants processing
  - `pipeline-runner.js` — removed coreference resolution step
  - `coreference.js` — reduced to stub
  - `visual-utils.js` — removed 2 unused functions
  - `prompt-builder.js` — `buildCharacters()` now uses `inferCharactersFromPrompt` only
  - `prompt-dependency-registry.js` — `sceneReferencesCharacter` scene-level only
  - `video-workflows.js` — removed unit.participants from storyboard
  - `book/lazy-book/parse.js`, `create.js` — removed unit.participants
  - `agent-service.js` — cleaned exports
  - Frontend `AiAssistantFragment.kt` — removed unit.participants display
  - Examples `ch-*.json` — removed unit-level participants
  - Tests updated (485 passing, 0 failing)

---

## [2026-06-27]

### Security

- **S.1 / Н.4: Секреты вынесены из git** (`docker-compose.yml`, `.env`, `.env.example`) —
  боевые `OPENROUTER_API_KEY` и пароль PG больше не хранятся в открытом виде в отслеживаемом
  файле; читаются из gitignored `.env` через `${VAR:?...}`-ссылки (fail-fast при отсутствии).
  ⚠️ Старые значения остаются в истории git с `380a777` — **требуется ротация**.
  Коммит: `6dca53a`

### Removed

- **D.3 / L1: Удалён мёртвый governance-кластер** — `src/api/runtime.js` (1758 строк, нигде
  не импортировался) + 16 debug-only модулей `runtime/`, шесть из которых делали `require()`
  на несуществующие файлы (потенциальные 500-е на debug-эндпоинтах). `runtime/`: 37 → 21 модуль.
  Живые `circuit-breaker`/`fairness-engine`/`retry-budget-manager` сохранены. Коммит: `311f44a`

### Changed

- **M5: Единый арбитр состояния** — все прямые `setAssetState` / `callback+markDispatchCompleted`
  заведены через Orchestrator-фасад (`completeStage`); P2 (task-handler), P4/P5/P6 (reconciliation,
  scene-restoration, startup-recovery). Linear-state (L1–L7) → производная `deriveLinearState`.
  Коммиты: `5d5e1a3`, `2807a38`, `3562778`…`cadad04`

- **M3: Диск — факт, не решение** — `restoreChunkStatusForScene`/`reconcileWindowStatuses` пишут
  `ready` только при актуальной PG-версии (version-gate); stale-файлы не отменяют force-regen.
  Коммиты: `91f104f`, `cc7d706`

### Added

- **O2: Prometheus-метрики** — quota utilisation, lease age, tick duration. Коммит: `40acaf4`

---

## [Unreleased] — 2026-06-26

### Fixed

#### Н.0–Н.9: Критические баги closed

- **Н.0: Happy path tests** (`backend/tests/happy-path.test.js`) — 30+ тестов на lease, quota, per-asset state, callbacks, scheduler.
  Коммит: `15978e6`

- **Н.1: Идемпотентность /gpu/task/result (C4)** (`backend/src/services/task-handler.cjs`) — SET NX dedup по ключу с build_id, TTL 3600s.
  Коммит: `d804a77`

- **Н.2: Один владелец release квоты (C1)** (`backend/src/runtime/dispatch-engine.js`) — удалены все releaseQuota из scene-callbacks, markDispatchCompleted — единственный владелец.
  Коммит: `4e007e2`

- **Н.3: Атомарные квоты (M2)** (`backend/src/runtime/dispatch-engine.js`) — acquireQuota на Lua EVAL: атомарные GET+check+INCR.
  Коммит: `636da04`

- **Н.4: Error-safe markDispatchCompleted** (`backend/src/services/task-handler.cjs`) — 6 callback+markDispatchCompleted пар в try/finally.
  Коммит: `fbb6493`

- **Н.5: PG status=ready (C2)** (`backend/src/orchestration/scene-callbacks.js`, `backend/src/storage/postgres/repositories/scene-assets-repo.js`) — markReady добавлен во все три completion-колбэка.
  Коммит: `cf0a48a`

- **Н.6: Атомарный per-asset RMW (M1)** (`backend/src/state/scene-state.js`) — JSON (GET+merge+SET) → Redis Hash (HSET/HGETALL).
  Коммит: `1a0867d`

- **Н.7: GENERATING per-asset при диспатче (§5.1)** (`backend/src/orchestration/scene-orchestrator.js`) — setAssetState(..., GENERATING) во всех execute*Dispatch.
  Коммит: `f0b81de`

- **Н.8: Развести два registry (C3)** (`backend/src/storage/asset-registry.js`, callers) — Redis registry функции переименованы с суффиксом `Redis`.
  Коммит: `5182455`

- **Н.9: Убрать dead MAX_CONCURRENT counters (M4)** (`backend/src/runtime/runtime-scheduler.js`) — удалены дублирующие quota функции и константы.
  Коммит: `0adc930`

### Fixed

- **AI chat errors & VBook progress polling** (`backend/src/routes/ai-routes.cjs`, `backend/src/services/ai-service.js`, `frontend/.../GenerateViewModel.kt`):
  - Fixed AI chat error handling and trigger endpoint.
  - Fixed VBook progress polling from frontend.
  - Fixed missing `gpuProgressDoneAt` reset after `clearVBookProgress`.

- **Trigger dedup & background loop** (`frontend/.../WindowTriggerManager.kt`, `frontend/.../MainActivity.kt`):
  - Fixed trigger deduplication to prevent duplicate window triggers.
  - Fixed background polling loop for VBook progress.
  - Fixed position label rendering in EditFragment.

- **AI JSON parse error — CoT think tags** (`backend/src/services/ai-service.js`):
  - Strip chain-of-thought XML tags (`<think>`, `<reasoning>`) from AI responses before JSON parsing.
  - Increased `maxTokens` from 2048 to 4096 for analysis steps.

- **VBook agent status polling** (`frontend/.../GenerateViewModel.kt`, `frontend/.../AiAssistantFragment.kt`):
  - Fixed `poll checkVBookAgentStatus` to work in the active VBook branch.
  - Fixed chapter numbering for special types (cover, prologue) in `AiAssistantFragment`.

### Chore

- **Dead code removal** (`backend/src/helpers/utils.cjs`): Removed unused `safeBuildPath` and `safeBuildPathAbsolute` functions (duplicated in `cleanup-service.cjs`).

---

## [2026-06-24]

### Fixed

- **Infinite window-trigger loop** (`frontend/.../WindowTriggerManager.kt`, `backend/src/services/agent-service.js`):
  - Frontend: removed `isLastChapterScene` condition that fired on every last scene of a chapter, not just window boundaries. Added 60s cooldown between triggers. Added one-shot guard per unit position.
  - Backend (`bootstrapNextWindow`): added dedup check — if the latest session is 'completed' or 'paused' with no remaining text/scenes, return `all_done`. Added offset dedup via DB query to prevent processing the same text offset twice.

- **Cover chapter ordering** (`backend/src/book/lazy-book/index.js`): `createOrAppendScenes()` no longer overwrites `chapters_order` with a simple `readdirSync().sort()`. Now scans chapter files for `type: 'cover'` and ensures the cover chapter stays at position 0.

- **`bootstrapNextWindow()` window_data lookup** (`backend/src/services/agent-service.js`): The function creates a *new* `agent_sessions` row for each window, which has null `window_data`. Now it queries the previous session's `window_data` (`SELECT ... WHERE window_data IS NOT NULL ORDER BY created_at DESC LIMIT 1`) to recover `currentOffset`, `all_characters`, and `all_locations`. Previously each new window restarted from offset 0, overwriting already-processed scenes.

- **CHECK constraint: `'paused'` status** (`backend/src/storage/postgres/schema.js`): Added `'paused'` to the `agent_sessions.status` CHECK constraint (`IN ('running','paused','completed','failed')`). A `runMigrations()` step drops and recreates the constraint on existing tables. Previously `updateSession()` with `status = 'paused'` failed atomically, preventing `progress_msg` from being saved — the chat showed only three dots instead of generation stages.

- **Null-preserving IU timing insert** (`backend/src/storage/postgres/repositories/iu-repo.js`): Changed `data.start_ms || 0` → `data.start_ms != null ? Number(data.start_ms) : null` so that null timings remain null in PostgreSQL instead of being stored as `0`. This fixed downstream checks that treat `0` as a valid timing value.

- **Timing persistence** (`backend/src/routes/generation-routes.cjs`):
  - **Storyboard endpoint**: After computing `estimated_duration_sec`, now also computes cumulative `start_ms`/`end_ms` boundaries and persists them to `image_units` immediately.
  - **GET /timings endpoint**: After computing timing boundaries in memory, persists them via `upsertIuTiming()` so subsequent calls don't recompute from scratch.

- **End-of-window trigger restored** (`frontend/app/src/main/java/com/example/animastor/ui/EditFragment.kt`): Recreated `checkEndOfWindowAndTrigger()` — detects the user selecting one of the last 3 units of the last scene in a window and calls `repository.triggerNextWindow()`. The function was previously removed during a refactor with a note that it was moved to `PlaybackViewModel`, but was never re-implemented there.

### Feat

- **Per-window reconnaissance** (`backend/src/services/agent-service.js`, `backend/src/book/lazy-book/parser.js`):
  - Characters and locations are now extracted and merged from each window, not just the first.
  - ALL-CAPS chapter headings detection without explicit `Глава` marker.
  - `injectChapterMarkers()` auto-inserts `[ГЛАВА: TITLE]` markers into source text.

- **Unified GPU+VBook progress panel** (`frontend/.../MainActivity.kt`, `frontend/.../GenerateViewModel.kt`):
  - VBook agent shown alongside GPU workers in the same progress panel.
  - Each worker type gets its own row (name + count + percent + progress bar).
  - Completed workers auto-hide after 10 seconds.

- **Global window trigger** (`frontend/.../WindowTriggerManager.kt`):
  - `WindowTriggerManager` observes `SharedPositionManager` from any screen.
  - Triggers next-window generation when user navigates to last 3 units of the last scene in a window.
  - 60s cooldown, dedup per window, one-shot per unit position.

### Chore

- **TTL 14400 for iu-progress** (`backend/src/.../iu-repo.js`): TTL increased from 3600 to 14400 seconds.
- **Remove shouldGenerateIUImage dead code**: Removed unused function that was already dead.
- **PATCH snapshot-based diff**: Updated diff algorithm to work with PATCH endpoint.
- **Update docs**: CHANGELOG.md, PROJECT_STRUCTURE.md.
