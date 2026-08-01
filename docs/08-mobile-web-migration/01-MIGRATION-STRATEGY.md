# 01. Общая стратегия переноса Android UI на Mobile Web

> Цель: получить мобильную веб-версию на `https://m.animastor.in/`, визуально и
> поведенчески неотличимую от Android-приложения, с переиспользованием того же
> backend API `/api/v1/...`.

---

## 1. Базовые факты об Android-приложении

- Стек: Kotlin + Jetpack (Fragment, ViewBinding, ViewModel, `activityViewModels`),
  Material 3, `ConstraintLayout`, `BottomNavigationView`, `MediaPlayer` (Android),
  Retrofit + OkHttp.
- Навигация: **нижняя панель из 5 вкладок** (`res/menu/bottom_nav.xml`):
  `File` → `Generate` → `Play` → `Edit` → `Navigate`. Стартовый экран — `File`.
  Навигация реализована вручную через `FragmentTransaction` `hide/show` по тегам
  (`MainActivity.kt`), **без** Navigation Component / nav graph.
- Доп. экраны открываются поверх底部-нав вкладок как отдельные фрагменты с
  `addToBackStack`: `Settings`, `AiAssistant`, `WorkflowManager`,
  `WorkflowDetails`, `WorkflowTypeList`, `DeveloperView`, `VBookSettings`,
  `WorkerSettings`, `Library`. `Generate` имеет индикатор статуса генерации
  (пульсация иконки).
- Тема: Material 3 Dark/Light «кинозал» (`themes.xml`). Точка входа — тёмная.
  Палитра `cinema_*`, скругления 12/18/28dp, чипы-слои плеера.
- Локализация: `ru` / `en` / `auto`.
- Координация: `MainActivity.setupPlaybackCoordination()` слушает
  `GenerateViewModel.playbackPrepared` и вызывает `PlaybackViewModel.preparePlayback()`
  — единый канал «генерация → плеер».

## 2. Стратегия переноса

### 2.1. Платформа веб-фронтенда

Веб-версия будет **тонким клиентом** поверх того же backend API, что и Android:
- Тот же API `/api/v1/...` (Retrofit-интерфейс → HTTP-клиент на TS/JS).
- Те же модели данных (`BookData`, `StoryboardResponse`, `SceneStatus`, …).
- Та же последовательность экранов и сценарии.

Подбор стека фреймворка зафиксируется в
[`03-MOBILE-WEB-ARCHITECTURE.md`](03-MOBILE-WEB-ARCHITECTURE.md). До выбора
стека учитывается: SPA-навигация «вкладки как страницы», реактивное состояние
(эквивалент `StateFlow`), маршрутизация по hash/path, обязательная поддержка
мобильных браузеров (Safari iOS, Chrome Android), работа оффлайн/слабого
соединения (preloading).

### 2.2. Принцип «один экран — одна страница»

- Каждый Android `Fragment` → отдельный **маршрут (page)** веб-приложения:
  `/file`, `/generate`, `/play`, `/edit`, `/navigate` для нижней панели;
  `/settings`, `/ai`, `/library`, `/workflows`, … для вторичных.
- Нижняя панель = фиксированный нижний `tab bar`, переключающий маршруты и
  сохраняющий состояние каждой вкладки (эквивалент `hide/show` по тегам).
- Вторичные экраны = маршруты с возвратом (`back` stack), аналог
  `addToBackStack`.

### 2.3. Перенос в три потока

| Поток | Что | Когда |
|---|---|---|
| **A. Каркас** | shell-приложение: роутер, tab bar, тема/токены, i18n, HTTP-клиент, маппинг моделей | до экранов |
| **B. Простые экраны** | Settings, Library, Workflow*, VBook/Worker settings, AiAssistant, File | первыми |
| **C. Сложные экраны** | Generate (SSE-прогресс, чипы), Edit (waveform, таймлайн), Navigate (карта «закладок»), **Play (мультиплеер)** | по графику в [`05-SCREEN-IMPLEMENTATION-ORDER.md`](05-SCREEN-IMPLEMENTATION-ORDER.md) |

### 2.4. Порядок проектирования каждого экрана

1. Прочитать `layout/*.xml` фрагмента → зафиксировать структуру DOM и停靠ку.
2. Снять токены дизайна из `themes.xml`/`colors.xml` → CSS design tokens.
3. Перенести строки из `strings.xml` (ru/en) → словари i18n.
4. Перенести логику: `ViewModel.uiState.collect` → стор/подписки; `observe` →
   эквивалент реактивных подписок.
5. Перенести вызовы `BackendApi` → методы HTTP-клиента (те же пути/параметры).
6. Зафиксировать отклонения (если есть) в
   [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) с обоснованием.

### 2.5. Что переносим один-в-один

- Визуальные токены (цвета `cinema_*`, скругления 12/18/28dp, высоты,
  иконографию — векторные `ic_*.xml` перекодировать в SVG).
- Текстовые сценарии: импорт книги → генерация → play → edit → navigate.
- API-контракты (endpoints, query-параметры, payload модели).
- Поведение нижней панели (5 вкладок, индикатор статуса генерации).
- Локализацию ru/en + `auto`.

### 2.6. Что заведомо меняется (фиксируется как обоснованное отклонение)

- `MediaPlayer` (Android) → `HTMLMediaElement` / Web Audio — см. раздел Player.
- `SurfaceView` для видеоoverlay → `<video>`/`<canvas>`.
- Дисковый кэш `SimpleDiskCache` → Cache API / IndexedDB.
- Файловые ассоциации (`.vbook` ACTION_VIEW) → загрузка файла через `<input
  type=file>` / drag-drop.
- `MediaDecoder.decodeBitmap` → нативный декодинг браузера (`<img>`, `createImageBitmap`).

Полный перечень рисков и альтернатив — в
[`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md).

---

## 3. Источник правды

При расхождении между этим разделом и кодом Android **источником правды является
код** (`frontend/app/src/main/`). Этот раздел описывает перенос, а не меняет
Android; все ссылки на классы/методы даны для сопоставления.
