# Миграция Android → Mobile Web — список задач

Источник плана: [`08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md`](08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md)
Правило проекта: [`08-mobile-web-migration/README.md`](08-mobile-web-migration/README.md)

Статусы: `[ ]` pending · `[~]` in_progress · `[x]` done

## Этап 0 — Каркас (до экранов)

- [x] **Каркас `frontends/mobile`**: Preact + Vite + TS (стек зафиксирован). Роутер (`preact-router`), `TabBar` (5 вкладок), `Toolbar` (Settings/AI), сохранение состояния вкладок; design tokens `tokens.css`/`theme-dark.css`/`theme-light.css` из `colors.xml`/`themes.xml` + `auto` по часу (pre-paint скрипт в `index.html`); i18n ru/en/auto из `strings.xml`; `api/client.ts` (fetch base `/api/v1/`, SSE, `retryWithBackoff`, streaming-Blob); `cache/mediaCache.ts` (Cache API + `clearCache(buildId?)`); `state/*` (`positionStore`, `generateStore`, `playbackStore`); SVG-иконки из `res/drawable/ic_*.xml`. ✅ `tsc --noEmit` + `vite build` + dev-server smoke — OK.

## Этап 1 — Простейшие статичные/диалоговые экраны

- [x] **Settings** (`/settings`) — тема dark/light/auto + язык ru/en/auto (segmented control, `localStorage` = `SharedPreferences`), через `applyTheme`/`applyLanguage`. VBook/Worker секции — заглушки в том же файле.
- [x] **VBookSettings** (`/settings/vbook`) — chunk size (scenes per pass), layer-config `GET/PUT`
- [x] **WorkerSettings** (`/settings/worker`) — `/worker/counts`, профили (`/connectors/profiles`), таймауты (layer-config), workflow (`/connectors/grouped`)
- [x] **Library** (`/library`) — iframe справки/релиз-ноутсов (`animastor.in`)

## Этап 2 — Сетевые списки/детали (без плеера и генерации)

- [x] **WorkflowManager** (`/workflows`) — карточки audio/image/video + активные счётчики из `/connectors/grouped` (F12), Reload → `/connectors/reload`
- [x] **WorkflowDetails** (`/workflows/:name`) — header-карточка + 4 таба (Inputs/Outputs/Parameters/Compatibility), edit-режим (`?edit` → `routeState.detailsEditMode`), правка параметров (`PUT /connectors/{name}/parameters`) и биндингов/гайд-нод (`PUT .../bindings`), dev-чип `</>`
- [x] **WorkflowTypeList** (`/workflows/type/:type`) — список коннекторов типа, enable-переключатель (`PUT .../status`), кнопка Details, Add Workflow (JSON-файл → `POST /connectors`)
- [x] **DeveloperView** (`/dev`) — табы Raw JSON (`/connectors/{name}/raw`) / Bindings (из ConnectorDetail), переход по dev-чипу с `routeState.devConnector`
- [x] **AiAssistant** (`/ai`) — чат: сессии (`/ai/sessions*`), 6 режимов (AssistantMode), typing-индикатор, position-bar, markdown-бабблы, копирование, голосовой ввод (Web Speech API)

### Завершение этапа 2 (2026-08-02) ✅

- Все 5 экранов реализованы; `tsc --noEmit` + `vite build` — OK; code-review пройден.
- Отклонения и решения — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §11.

---

## Этап 3 — File (импорт/экспорт)

- [x] **File** (`/file`) — импорт `.vbook`/txt (`POST /book/import` multipart), список книг, экспорт/скачивание, deep link `?book=`

### Завершение этапа 3 (2026-08-02) ✅

- Импорт: карточки Import/Create/Library 1:1 с `fragment_file.xml`; `<input type=file>`
  (`accept=".vbook,.epub,text/plain,.txt"`) + drag-drop → `POST /book/import`
  multipart; статус импорта как в Android (статус-текст из `importProgressMessages.take(4)`,
  фазы `file_status_*`); по завершении — `navigationEvent` → `/play` или `/generate`
  (логика `importBookFromFile`: vbook → Play при сценах, txt → Play при `has_assets`).
- Скачивание: `GET /book/{id}/download` (.vbook — только bookId), `/storyboard`,
  `/audio`, `/export` (нужны bookId+buildId+фаза SCENE_READY/PLAYING);
  прогресс из Content-Length (`getBlob` onProgress), статусы `export_*`/`export_saved`.
- Deep link `?book=<id>` (и `?open=<id>`) — загрузка книги с сервера (`GET /book/{id}`),
  параметр снимается после обработки; подробнее — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §12.
- Отклонения и решения — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §12.

## Этап 4 — Generate (прогресс и координация)

- [x] **Generate** (`/generate`) — SSE-прогресс, статус по scope (`/progress-panel`), чипы режимов/тем/воркеров, индикатор статуса на tab-иконке (running/error/success + авто-сброс), emits `playbackPrepared` → `playbackStore.preparePlayback()`

### Завершение этапа 4 (2026-08-02) ✅

- 4 секции воркеров (VBook/Audio/Image/Video) 1:1 с `fragment_generate.xml`:
  header-строка (акцент-бар, икона, счётчик `Worker counts`, шестерёнка
  настроек, toggle-чип Вкл./Выкл.), прогресс-ряды `item_worker_progress`,
  кнопки Generate/Stop. `updateHeaderPanelStyle`/`updateToggleText` перенесены.
- Worker counts poll 5s (`/worker/counts`) → `updateSectionHeader`: икона
  error (генерит, нужен, но 0 воркеров), active (пульс `gen-pulse` 1.6s),
  normal, off (перечёркнутая).
- Прогресс-панель poll 1.5s (`/progress-panel`) → `computeProgressRows` 1:1:
  new-gen gate (анти-флеш stale 100%), monotonic floor, 10s done-window,
  все-cancelled скрытие, финализация (SUCCESS + `playbackPrepared` soft
  refresh). VBook-ряд из SSE + `/agent-status` poll (2s, 5min timeout).
- Таймер 500ms (заморозка done-рядов / live-подсчёт активных), как
  `refreshTimerDisplay`.
- Запуск генерации: Generate All → scope dialog → VBook; Audio/Image/Video →
  scope dialog (`DialogGenerateScope`, позиция-зависимые опции disabled без
  позиции) → `POST /regenerate {worker_types, scope, chapter_id, scene_id}`;
  VBook → `bootstrap`/`bootstrap-next-window` + poll `/agent-status`.
  Stop All → `/cancel-generation`; Stop секции → `/cancel-worker {type}`;
  stop ряда → popup «Отменить» (`worker_stop_menu_cancel`) →
  `/cancel-worker {type, task_id}`.
- SSE `/progress-stream` (ProgressEvent: vbook/import_complete/generation_complete)
  с reconnect-экспонентой 1s→2s→4s→8s→15s и epoch-guard;
  `import_complete` завершает VBook-поллер раньше.
- `checkAndRestoreGenerationState` (2.5s после mount) — восстановление
  активной генерации после restart backend (R11).
- Индикатор на tab-иконке: RUNNING/ERROR/SUCCESS → цвет+пульс (`tabbar__pulse*`),
  SUCCESS авто-сброс 22s (как `updateNavIconStatus`), сброс при входе на
  Generate без активной работы.
- `playbackPrepared` → `playbackStore.wirePlaybackCoordination()`
  (`setupPlaybackCoordination`): `preparePlayback`/`refreshContent(softRefresh)`.
- Отклонения и решения — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §13.

## Этап 5 — Navigate (карта-закладки → seek)

- [x] **Navigate** (`/navigate`) — дерево глав→сцен→юнитов → `positionStore.navigateTo()` + `router.push('/play')` + `playbackStore.seekToPosition()` (refresh book JSON если нет → `missingIuPosition` overlay)

### Завершение этапа 5 (2026-08-02) ✅

- Дерево 1:1 с `fragment_navigate.xml` + `BookStructureAdapter`: position-bar
  (label-only, `updatePositionBar` 1:1: special-главы Cover/Prologue,
  `display_number`-префикс, «Глава N — Заголовок»), loading-индикатор,
  empty-state, список глав→сцен→юнитов.
- Лейблы: главы — accent/bold/15sp (indent 8), сцены — `… — type (style)` /
  `… (type)` на surfaceVariant (indent 24), юниты — `[type] Unit N — текст`
  13sp + активный (accent bold + secondaryContainer).
- Авто-раскрытие текущей сцены по позиции (`expandedScenes` следует за
  `positionStore`, `lastPositionKey`), раскрытие глав по правилу
  «текущая глава или ≤3 глав».
- Preview-миниатюры юнитов: `<img loading=lazy>` → `GET /preview/{…}?build_id=`
  (эквивалент `getIuPreview`), fallback `ic_image_off` на ошибке.
- Клик по юниту: `positionStore.navigateTo` + `playbackStore.seekToPosition`
  (1:1 с `PlaybackViewModel.seekToPosition`: refresh book JSON если сцены нет в
  очереди → `missingIuPosition`) + переход на `/play` (`switchToPlayTab`).
- `PlayPage` показывает overlay `missingIuPosition` («Не сгенерировано», как
  `showMissingChunkOverlay`) — каркас плеера на этапе 7.
- Перезагрузка дерева при `playbackPrepared` (генерация завершена).
- Отклонения и решения — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §14.

## Этап 6 — Edit (таймлайн + waveform)

- [x] **Edit** (`/edit`) — таймлайн сцен/юнитов, waveform (`getSceneWaveform` → Canvas), IU-предпросмотр, `GET/PUT /scene/.../timings`, `GET/PUT /book/{id}/layer-config`, переход в Play по seek

### Завершение этапа 6 (2026-08-02) ✅

- Layout 1:1 с `fragment_edit.xml`: position-bar (label + unitCount, tap →
  `/navigate`), unit-карусель prev/current/next (preview `GET /preview` +
  aspect-ratio высоты карточек как в Android, оверлей «Не сгенерировано»),
  аудио-таймлайн-панель (Play/Stop + waveform + Reset), 7 скроллящихся
  property-табов со стрелками (дефолт — Unit, как в Android), контент-область,
  кнопка Save (48dp, radius 18dp), dirty-индикатор, error-текст, empty-state.
- Waveform: `lib/waveform.tsx` — Canvas-порт `WaveformView.kt` (R10): бары по
  peaks, selection + перетаскиваемые handle'ы (touchSlop 24, клампинг −50ms/
  +50ms), playhead с треугольником, тайм-лейблы `M:SS.d`, «No waveform data».
- Тайминги: параллельная загрузка `GET /waveform` + `GET /timings` (как
  `loadTimelineData`), `computeInitialTimings` (clamp в длительность аудио),
  drag-preview локально (N2) → `PUT /scene/.../timings` по отпусканию,
  ответ сервера перезаписывает границы; Reset возвращает оригинальные
  тайминги и сохраняет.
- Плейбек: `<audio>` (src `/scene/.../audio?build_id=`) + rAF-курсор по
  `currentTime` (playhead через signal — без ре-рендера страницы), стоп по
  `end_ms`/длительности, icon play↔stop.
- Карусель навигации: `navigateUnit(±1)` 1:1 (переходы между сценами/главами)
  → `positionStore.navigateTo` + `playbackStore.seekToPosition` (переход в Play
  по seek, как требуется планом).
- Сохранение полей: по табам (Scene/Audio/Unit/Locations/Global), passport
  overrides отдельным PATCH без `unit_id`; после сохранения — re-fetch
  `GET /book/{id}` (thin-client).
- Dirty-индикатор: `dirtySummary` из ответа `/regenerate` (`res.summary`,
  серверный diff) + «Save *» при локальных правках.
- Отклонения и решения — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §15.

## Этап 7 — Play (мультиплеер) — высший риск

- [x] **Play** (`/play`) — UI-каркас (`fragment_play.xml` 1:1); `playbackStore` (`PlaybackUiState`, `sceneQueue`, preloadCache, layer toggles, `needsContentRefresh`); движок: 2×`<audio>` (gapless −200ms) + `<video>` overlay + IU-cycling (RAF по `currentTime`) + silent IU-режим + seek по `unitIndex` (sum `durationMs`) + `preloadAhead(3)` retry/backoff + `fetchSceneData` (status→audio→video→IU) + soft-refresh; seek/навигация (`seekToPosition`/`executePendingSeek`/`missingIuPosition`); lifecycle (Page Visibility, sessionStorage savedPosition). Антипаттерны `DONT_DO.md` не воспроизводить.

### Завершение этапа 7 (2026-08-02) ✅

- `playbackStore` — полный порт `PlaybackViewModel` + движка `PlayFragment`:
  очередь сцен (sceneRefs → `ch:sc`), `currentIndex`/`currentUnitIndex`,
  `preparePlayback` (clearCache при смене buildId, DONT_DO #5) и
  `refreshContent` (soft refresh: needsContentRefresh, PLAYING→SCENE_READY +
  stopAll, PAUSED остаётся), `playSceneQueue`/`resumeFromCurrentScene`/
  `resumePlayback`/`pausePlayback`, `handlePlaybackError`/`handleNullPlayer`,
  `executePendingSeek` (DOWNLOADING→playNext), `ensureInitialized` +
  `loadCoverIntoState` (5× retry 1s→5s как loadCoverBitmap).
- Движок (модульные элементы, переживают переключение вкладок): 2 `<audio>`
  в скрытом host-div (первый → `preloadNext` → chain) + `<video>`, принятый из
  PlayPage. Gapless-переход −200ms через RAF (`sceneTransitionPending`,
  `switchToNextPlayer`), fallback — нативный `ended` (`onTrackEnd`).
- `fetchSceneData`: `/scene/.../status` → audio/video/storyboard → каждый IU
  (`/iu-image`), параллельно; retryWithBackoff(3, 1s→2→5s) в playNext;
  Blob-кэш Cache API (`mediaCache`, ключ `${buildId}_${sceneKey}` +
  `kind`, IU — `ch:sc:unit`), clearCache по смене buildId и в refreshContent.
- IU-cycling: RAF по `audio.currentTime` + bisect суммы `duration_ms` (R3 A),
  silent-режим для сцен без аудио (Cover) — таймер `duration_ms`; `showIu`
  показывает плэйсхолдер при `NOT_GENERATED` без skip'а индекса (DONT_DO #3),
  аудио никогда не ждёт картинку (DONT_DO #1).
- PlayPage — `fragment_play.xml` 1:1: media-вьюпорт (curtains/cover/result/
  video/scrim/placeholder/`iuMissing`/subtitle), 4 layer-чипа (audio → volume,
  image → видимость, video → overlay, subtitles), big-play-button (56dp/18dp,
  PLAY↔PAUSE), progress (indeterminate), status (11sp), fullscreen-кнопка
  (44dp, anchorFullscreenToImage: letterbox-перевод + подъём над субтитрами),
  Fullscreen API на media-контейнер.
- Lifecycle (R8): пауза по `document.hidden` (`onPause`), сохранение позиции
  в sessionStorage на `pagehide`, восстановление (`needsRotationResume` +
  `pendingSeekPositionMs`) на `pageshow`/mount (reload) — `wirePlaybackLifecycle`.
- Seek из Navigate/Edit: `seekToPosition` → `pendingExternalSeek` → на mount
  PlayPage `checkPendingExternalSeek` (pendingLoad → плейер подготовлен на
  позиции и поставлен на паузу, как `executePendingSeek` в Android);
  `missingIuPosition` → overlay «Не сгенерировано» 1:1.
- Отклонения и решения — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §16.
- `tsc --noEmit` + `vite build` — OK; code-review пройден.

## Финал

- [ ] Снять Basic Auth с `m.animastor.in` (`proxy/conf/default.conf`) перед публичным запуском

---

## Прогресс

Обновлять статусы скобками по мере выполнения; при завершении этапа — краткая заметка в
[`08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md`](08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md)
и фиксация отклонений в
[`08-mobile-web-migration/06-RISKS-AND-ALTERNATIVES.md`](08-mobile-web-migration/06-RISKS-AND-ALTERNATIVES.md).
