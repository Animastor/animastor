# 03. Предлагаемая архитектура `frontends/mobile/`

> Каркас веб-версии.
>
> **Стек зафиксирован (этап 0):** **Preact + Vite + TypeScript**.
> Preact даёт React-совместимую модель компонентов при минимальном рантайме
> (~3KB) — подходит для мультиплеера/canvas и целевых мобильных браузеров.
> Реактивное состояние — `@preact/signals` (эквивалент `StateFlow.collect`).
> Роутер — `preact-router` (hash/history mode).
>
> **Деплой:** Vite собирает `frontends/mobile/src` → `frontends/mobile/dist`;
> содержимое `dist/` раздаётся nginx с `m.animastor.in` (см. §6 — единственное
> ожидаемое изменение proxy: SPA-fallback + MIME `application/javascript` для
> ESM-bundle). В репозитории остаются исходники; артефакты сборки (`dist/`,
> `node_modules/`) игнорируются (см. `.gitignore`).

---

## 1. Требования к каркасу

| Требование | Источник | Приоритет |
|---|---|---|
| SPA-навигация «вкладки как страницы» с сохранением состояния | `MainActivity` hide/show по тегам | высокий |
| Реактивное состояние (эквивалент `StateFlow.collect`) | `ViewModel.uiState` | высокий |
| SSE / streaming-ответы (прогресс генерации) | `ProgressStream.kt`, `/progress-panel` | высокий |
| Несколько синхронизированных медиа-источников с seek | `PlayFragment` 3×`MediaPlayer` | высокий |
| preloading сцен (3 вперёд) + retry/backoff | `PlaybackViewModel.preloadAhead` | высокий |
| i18n ru/en + auto | `strings.xml`/`values-ru` | высокий |
| Design tokens (dark/light/auto) | `themes.xml` | высокий |
| Кэш медиа локально | `SimpleDiskCache` | средний |
| Слабое соединение / offline placeholder | IU `NOT_GENERATED` overlay | средний |
| Тесты + типобезопасные модели API | `BackendApi`/`*Models.kt` | средний |

## 2. Слои архитектуры

```
frontends/mobile/
├── index.html                 ← SPA-точка входа, meta viewport, тема
├── assets/
│   └── fonts/                 ← (иконки — инлайн в src/app/icons.tsx, см. выше)
├── src/
│   ├── app/                   ← shell: роутер, tab bar, toolbar, темы
│   │   ├── router.ts          ← маршруты /file /generate /play /edit /navigate + вторичные
│   │   ├── icons.tsx          ← инлайн-SVG таб-иконок 1:1 из res/drawable (ic_*.xml), currentColor-тинт
│   │   ├── theme.ts           ← dark/light/auto (по часу, как в Android)
│   │   └── i18n.ts            ← ru/en/auto, словари из strings.xml
│   ├── pages/                 ← эквиваленты Fragment (по одному на экран)
│   │   ├── FilePage.*
│   │   ├── GeneratePage.*
│   │   ├── PlayPage.*         ← самый сложный, см. 06-RISKS §Player
│   │   ├── EditPage.*
│   │   ├── NavigatePage.*
│   │   ├── SettingsPage.*
│   │   ├── AiAssistantPage.*
│   │   ├── LibraryPage.*
│   │   ├── WorkflowManagerPage.* / WorkflowDetailsPage.* / WorkflowTypeListPage.*
│   │   ├── DeveloperViewPage.*
│   │   ├── VBookSettingsPage.*
│   │   └── WorkerSettingsPage.*
│   ├── features/              ← общие переиспользуемые UI-блоки (см. 04-MAPPING §2)
│   │   ├── player/            ← Player engine, IUCycling, layers, fullscreen
│   │   ├── timeline/          ← edit: waveform, scene units, timings
│   │   ├── navigate/          ← map: chapters/scenes/units → seek
│   │   ├── generation/        ← generate: SSE-progress, status indicator
│   │   └── ai-chat/           ← assistant: sessions, messages, typing
│   ├── api/                   ← HTTP-клиент + эндпоинты (1:1 с BackendApi.kt)
│   │   ├── client.ts          ← fetch-обёртка, base `/api/v1`, SSE, timeout/retry
│   │   ├── book.ts scene.ts ai.ts worker.ts connector.ts workflow.ts
│   │   └── types.ts           ← модели из repository/*Models.kt (BookData, StoryboardResponse, SceneStatus, WaveformData, …)
│   ├── state/                 ← стор приложения (эквивалент ViewModel/StateFlow)
│   │   ├── bookStore.ts
│   │   ├── generateStore.ts   ← playbackPrepared сигнал (координация, как в MainActivity)
│   │   ├── playbackStore.ts   ← PlaybackUiState, sceneQueue, phase, seek
│   │   └── positionStore.ts   ← SharedPositionManager (ActivePosition)
│   ├── cache/                 ← Cache API + IndexedDB (эквивалент SimpleDiskCache)
│   │   └── mediaCache.ts      ← audio/video/iuBlobs с TTL и clearCache()
│   ├── lib/
│   │   ├── waveform.ts        ← canvas-рендер WaveformView (WaveformData)
│   │   ├── bitmap.ts          ← createImageBitmap (MediaDecoder.decodeBitmap)
│   │   └── retry.ts           ← retryWithBackoff
│   └── styles/
│       ├── tokens.css         ← cinema_* из colors.xml
│       ├── theme-dark.css theme-light.css
│       └── components.css      ← button/chip/card/tab/toolbar
└── tests/
```

## 3. Состояние и реактивность

- Единый **стор** с подписками (аналог `StateFlow.collect`) для:
  - `generateStore` — отвечает за генерацию и emits `playbackPrepared`.
  - `playbackStore` — `PlaybackUiState{phase, coverImage, errorMessage,
    chunkSequence, missingIuPosition}`, `sceneQueue[]`, `currentIndex`,
    `currentUnitIndex`, `pendingSceneAudio/Video/IuSequence`, layer toggles,
    preload cache.
  - `positionStore` — `SharedPositionManager` (`ActivePosition`:
    `chapterId/sceneId/unitId/chunkId/unitIndex`).
- **Координация «генерация → плеер»** воспроизводит
  `MainActivity.setupPlaybackCoordination()`: при `playbackPrepared` зовём
  `playbackStore.preparePlayback(bookId, buildId, scenes)` (или `refreshContent`
  при soft refresh).
- Маппинг фаз игрока `PlayerPhase` (IDLE/LOADING_BOOK/GENERATING/DOWNLOADING/
  SCENE_READY/PLAYING/PAUSED/IMPORTING_TXT) сохраняется как enum стором и
  используется UI кнопкой play/pause и status text (1:1 со strings).

## 4. API-слой

- `api/client.ts` — единая обёртка над `fetch`:
  - base `/api/v1/` (проксировано nginxom `m.animastor.in/api/`).
  - SSE-клиент для прогресса (аналог `ProgressStream.kt`).
  - `retryWithBackoff` (3 попытки, 1s→2→5s) как в `PlaybackViewModel`.
  - streaming больших байтовых ответов (audio/video) в Blob с записью в
    `mediaCache`.
- `types.ts` — автогенерируемый/ручной набор TypeScript-типов на основе
  `repository/*Models.kt`. Все эндпоинты каталогизированы в
  [`04-MAPPING-TABLES.md`](04-MAPPING-TABLES.md) §4.

## 5. Маршрутизация

| Маршрут | Android | Тип |
|---|---|---|
| `/file` | `FileFragment` | вкладка #1 (старт) |
| `/generate` | `GenerateFragment` | вкладка #2 |
| `/play` | `PlayFragment` | вкладка #3 |
| `/edit` | `EditFragment` | вкладка #4 |
| `/navigate` | `NavigateFragment` | вкладка #5 |
| `/settings` | `SettingsFragment` | secondary (back stack) |
| `/ai` | `AiAssistantFragment` | secondary |
| `/library` | `LibraryFragment` | secondary (содержит WebView) |
| `/workflows` | `WorkflowManagerFragment` | secondary |
| `/workflows/:name` | `WorkflowDetailsFragment` | secondary |
| `/workflows/type/:type` | `WorkflowTypeListFragment` | secondary |
| `/dev` | `DeveloperViewFragment` | secondary |
| `/settings/vbook` | `VBookSettingsFragment` | secondary |
| `/settings/worker` | `WorkerSettingsFragment` | secondary |

Состояние вкладок сохраняется при переключении (как `hide/show`), а не
разрушается — для этого стор хранится вне компонента страницы (на уровне shell).

## 6. Инфраструктура деплоя

Уже настроено в `proxy/conf/default.conf`:
- `m.animastor.in` → `root /usr/share/nginx/frontends/mobile`, `index index.html`.
- `/api/` и `/gpu/` проксируются на те же upstream’и, что и desktop.
- `try_files $uri $uri/ =404` — для SPA нужен fallback на `index.html` при
  HTML5 route (controlled by router history mode). Это единственное ожидаемое
  изменение proxy — оформить **после** выбора роутера и зафиксировать здесь.
- Временная Basic Auth (до завершения разработки) — оставить.

## 7. Открытые вопросы (решаются при начале работ)

1. Выбор SPA-фреймворка/роутера (требование: тяжёлый плеер + реактивность).
2. SSE-клиент в условиях мобильных разрывов сети (reconnect, monotonicity из
   `docs/05-frontend/PROGRESS_HANDOFF.md`).
3. Стратегия кэша медиа: Cache API (HTTP-кэш) vs IndexedDB (byte-blob cache с
   ручной инвалидацией по `buildId` — как `clearCache()` в `preparePlayback`).
4. Поддержка фоновой паузы/отложенного seek по `Page Visibility` (аналог
   `onHiddenChanged` / `onPause` в `PlayFragment`).
