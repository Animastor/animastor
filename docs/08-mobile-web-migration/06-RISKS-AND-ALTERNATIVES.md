# 06. Компоненты с высоким техническим риском и альтернативы

Здесь фиксируются **все обоснованные отклонения** от один-в-один переноса
Android → Web. Правило проекта: отклонение допустимо, только если оно
занесено в этот документ **до** реализации с указанием причины и принятой
альтернативы.

Источники правды по плееру: `PlayFragment.kt`, `PlaybackViewModel.kt`,
`PositionManager.kt`, `WaveformView.kt`, `util/MediaDecoder.kt`,
`util/SimpleDiskCache.kt`, `res/layout/fragment_play.xml`, а также
`docs/03-audit/PLAYER_AUDIT.md`, `docs/05-frontend/PLAYER_STATE.md`,
`docs/DONT_DO.md`.

---

## 0. Резюме рисков

| # | Компонент | Риск | Степень | Раздел |
|---|---|---|---|---|
| R1 | Экран **Play**: несколько синхронизированных медиаплееров | точная синхронизация audio/video/IU, gapless, seek по unit, lifecycle | **Очень высокий** | §1 |
| R2 | Gapless-переход между сценами (`setNextMediaPlayer`) | нет эквивалента в Web | Высокий | §1.2 |
| R3 | IU-cycling по `MediaPlayer.getCurrentPosition()` (50ms tick) | drift `currentTime` vs RAF | Высокий | §1.3 |
| R4 | Video overlay на `SurfaceView` + `syncVideoFrame` |detach/seek видео к аудио | Средне-высокий | §1.4 |
| R5 | Seek по `unitIndex` (сумма `duration_ms`) | точность seek в буфере | Средний | §1.5 |
| R6 | Soft refresh / `needsContentRefresh` / `buildId` cache invalidation | согласованность с генерацией | Средний | §1.6 |
| R7 | Preload на 3 вперёд + retryWithBackoff + disk cache | квоты/temp-файлы | Средний | §1.7 |
| R8 | Lifecycle: `onHiddenChanged/onPause/onResume`, сохранение позиции | переключение вкладок/минимизация | Средний | §1.8 |
| R9 | Fullscreen + `anchorFullscreenToImage()` (letterbox+subtitles) | позиционирование overlay | Низкий-средний | §1.9 |
| R10 | Waveform на Canvas (`WaveformView`) | копирование кастомного Canvas-рендера | Средний | §2 |
| R11 | SSE-прогресс генерации на мобильных (reconnect/монотонность) | разрывы сети на 3G | Высокий | §3 |
| R12 | Импорт `.vbook`/txt (file association) | нет ACTION_VIEW | Низкий | §4 |
| R13 | Library WebView | политика iframe/CSP | Низкий | §5 |
| R14 | Basic Auth на m.animastor.in во время разработки | UX-фактор на мобильных | Низкий | §6 |

---

## 1. Экран Player — детальный разбор

### 1.1. Что именно делает Android-плеер

`PlayFragment` удерживает **до трёх** объектов `MediaPlayer` одновременно
(`PlayFragment.kt:51-56`):

- `currentPlayer` — аудио текущей сцены (MP3 байтами → temp-файл).
- `nextPlayer` — предзагруженное аудио следующей сцены, прикрепляется через
  `currentPlayer.setNextMediaPlayer(nextPlayer)` для **gapless**-перехода
  (`PlayFragment.kt:643`, `preloadAheadAudio()`).
- `videoPlayer` — видео-оверлей той же сцены, на `SurfaceView` (`videoSurface`),
  синхронизируется к аудио через `syncVideoFrame()` (`PlayFragment.kt:1164`):
  `seekTo(currentPlayer.currentPosition)` + пауза через 50ms.

Дополнительно:
- **IU-cycling** (`startIuCycling`, `PlayFragment.kt:866`): каждые 50ms по
  `currentPlayer.currentPosition` вычисляется индекс IU (накопл. сумма
  `iu.durationMs`), показывается соответствующее изображение + субтитра, и
  `SharedPositionManager.navigateTo(...)` апдейтит `ActivePosition`.
- **Silent IU-режим** (`startSilentIuCycling`): когда аудио пусто (напр. Cover),
  cycling идёт по таймеру (без `MediaPlayer`).
- **Seek по unitIndex**: `handleChunk` считает `seekMs = sum(durationMs[0..unit))`
  и зовёт `currentPlayer.seekTo(seekMs)` (`PlayFragment.kt:573-631`).
- **Preload**: `PlaybackViewModel.preloadAhead()` параллельно фетчит **3 сцены
  вперёд** (`PRELOAD_AHEAD=3`) с `retryWithBackoff(3, 1s→2→5s)`
  (`PlaybackViewModel.kt:685-732`, `822-840`).
- **Soft refresh** после регенерации: `refreshContent()` ставит
  `needsContentRefresh=true`; `resumePlayback()`/`resumeFromCurrentScene()`
  пере-фетчит текущую сцену и высвобождает stale `MediaPlayer`
  (`PlayFragment.kt:1207-1224`).
- **Disk cache**: `SimpleDiskCache` (256MB) с типами audio/video/image/preview/iu;
  `clearCache()` при смене `buildId` (`PlaybackViewModel.kt:198-203,259-260`).
- **Lifecycle**: `onHiddenChanged/onPause/onResume` — пауза при скрытии вкладки,
  сохранение `savedPlaybackPositionMs`/`persistedImage` при `isChangingConfigurations`
  (`PlayFragment.kt:1295-1349`).
- **DONT_DO.md**: нельзя вводить stall/retry IU, нельзя переписывать sliding
  window preload, нельзя skip’ать IU по `bitmap==null`, навигация только из
  FileFragment (не MainActivity). Эти ограничения действуют и для веб-переноса.

### 1.2. R2 — Gapless-переход между сценами

**Проблема.** В вебе нет прямого аналога `MediaPlayer.setNextMediaPlayer()`.
Использование двух `<audio>` элементов с переключением даёт щель/клик; Web Audio
`AudioBufferSourceNode` требует полного декодирования в буфер.

**Альтернативы:**

| Вариант | Как | Плюсы | Минусы / риск |
|---|---|---|---|
| **A (рекомендуется стартовый)** | Два `<audio>` (current+next), `<audio>.preload=auto`, переключение по `ended`/по таймеру −200ms (как `sceneTransitionPending`, `PlayFragment.kt:893`); следующий источник выставляется заранее в `nextPlayer.src` | простота, нативный seek/volume/UI | возможен микрощелчок; зависит от кодеков `MediaSource` |
| B | Web Audio API: декодировать аудио обеих сцен в `AudioBuffer`, планировать `start(nextStartTime)` — истинный gapless | идеальный seamless | нужно декодировать весь буфер в память (память мобильного); seek требует пересчёта `startTime`; громоздко |
| C | `MediaSource` Extensions (MSE) + адаптивный плейлист | стриминг segments, low latency | требует серверной адаптации формата; не все кодеки |
| D | Один `<audio>` + `onended` → swap `src` | простота | явный gap (нагрузка decode) |

**Принято:** начать с **A** (два `<audio>`, ранний switch −200ms, как в
`PlayFragment.kt:893`); если щелчки недопустимы на целевых устройствах —
переходить на **B** для аудио-дорожки с декодированием следующей сцены в
`AudioBuffer` и планированием через `AudioContext.currentTime`. Решение
фиксируется здесь по итогам прототипа (этап 7.3).

### 1.3. R3 — IU-cycling по позиции аудио

**Проблема.** Android-цикл делает `player.currentPosition` каждые 50ms и выбирает
IU по накопленной сумме `durationMs`. В вебе `audio.currentTime` может
отставать/«дрейфить» относительно RAF, seek на iOS Safari — ограничен.

**Альтернативы:**

| Вариант | Как | Риск |
|---|---|---|
| **A (рекоменд.)** | `requestAnimationFrame` сравнивает `audio.currentTime` с порогом `sum(durationMs)`; индекс = `bisect([0,d0,d0+d1,…])`, обновляем DOM только при смене индекса (как `idx != currentIuIndex` в `PlayFragment.kt:914`) | низкий; совпадает с Android-логикой |
| B | Web Audio `AudioContext.currentTime` master-clock + таймеры | точнее, но требует Web Audio everywhere |
| C | Внешний таймер на `setInterval(50)` (без RAF) | проще, но хуже на low-power |

**Принято A**; порог end-of-scene `dur - 200ms` (`PlayFragment.kt:893`) сохраняется
для раннего переключения плеера. При `currentTime` недоступном (silent Cover) —
режим `setInterval` из `durationMs` (`startSilentIuCycling`).

### 1.4. R4 — Video overlay + синхронизация

**Проблема.** SurfaceView+`setDisplay`/`fitSurfaceToContainer()` нет; видео в
`<video>` — отдельный элемент, который браузер может декодировать асинхронно.

**Альтернативы:**

| Вариант | Как |
|---|---|
| **A (рекоменд.)** | `<video>` (muted, `playsinline`, `preload=auto`) поверх `<img>` в `mediaContainer`; byframovert `loadstart/loadedmetadata/resize` пересчитывает letterbox (CSS `object-fit: contain`); sync к аудио: на `ended`/переходе — `video.currentTime = audio.currentTime`; пауза/resume синхронно с аудио (`PlayFragment.kt:1189,1230`) |
| B | Видео в `<canvas>` через `drawImage(video)` (для эффектов) | дороже, recruit’ится только при необходимости |

**Принято A.** Синхронизация аудио↔видео: tap в `audit`'ом `syncVideoFrame`
(`seekTo(currentPlayer.currentPosition)`+краткая пауза) переносится как:
`video.currentTime = audio.currentTime; if(paused) video.pause()` (без 50ms
хака, который в Android-версии — workaround состояния `MediaPlayer`).

### 1.5. R5 — Seek по `unitIndex`

**Проблема.** Android: `seekTo(sum(durationMs[0..unit)))`. Веб-`audio.currentTime`
в секундах, точность_seek ограничена keyframes.

**Принято:** `audio.currentTime = seekMs/1000` (открыто как обоснованное
отклонение — не 1:1 миллисекундно, но совпадает с моделью). Сохраняем логику
`pendingSeekPositionMs` для rotadays-резюме (через Page Visibility).

### 1.6. R6 — Soft refresh / cache invalidation по `buildId`

**Переносится 1:1:** `clearCache()` в `preparePlayback` при `prevBuildId !=
buildId`; `needsContentRefresh` после `refreshContent()`; `resumePlayback`
пере-фетчит текущую сцену и высвобождает stale audio/video. Реализация —
`mediaCache.clearCache()` (Cache API/IndexedDB) + флаг в `playbackStore`.
`DONT_DO.md #5` (нельзя убирать `clearCache` в `preparePlayback`) —
соблюдается.

### 1.7. R7 — Preload + retry + disk cache

**Переносится 1:1** по поведению: `preloadAhead(3)` с parallel fetch
(`Promise.all`), `retryWithBackoff(3, 1s→2→5s)`, кэш по ключу `${buildId}_${sceneKey}`.
Кэш-слой — Cache API (для HTTP-ответов) или IndexedDB (для «сырых» Blob с
ручной инвалидацией, как `cacheAudioFile/cacheVideoFile`). Память — `money
pressure` эквивалент: высвобождение при `visibilitychange`/`freeze` (аналог
`onTrimMemory` → `stopAll()`).

### 1.8. R8 — Lifecycle и сохранение позиции

**Альтернативы:**

| Android | Web эквивалент |
|---|---|
| `onHiddenChanged(hidden)` (вкладка скрыта) | shell-сигнал «вкладка деактивирована» → pause; `document.visibilitychange`/`freeze` event |
| `onPause/onResume` | `visibilitychange` (`hidden`/`visible`), `pagehide`/`pageshow` |
| `savedPlaybackPositionMs` при `isChangingConfigurations` | `positionStore` + сохранение в sessionStorage/IndexedDB на `pagehide`; восстановление на `pageshow` |
| `persistedImage` | `playbackStore.persistedImage` (Blob URL) |

**Принято:** пауза при `document.hidden` (как `onPause`); сохранение позиции в
sessionStorage при `pagehide`; восстановление при `pageshow` (как
`onResume`). `needsRotationResume`-аналог не нужен (нет конфиг rotation), но
ветка «сохранённой позиции» сохраняется для случаев уничтожения вкладки.

### 1.9. R9 — Fullscreen + anchor

`toggleFullscreen()` + `anchorFullscreenToImage()` переносятся в CSS:
Fullscreen API для media viewport; letterbox через `object-fit: contain`;
positioning fullscreen-кнопки относительно image-bounds (computed) и subtitle
через CSS ( Gap / перевод ). Низкий риск.

### 1.10. Сводка по игроку — что переносится 1:1

| Поведение | Перенос |
|---|---|
| Очередь сцен `chapterId:sceneId`, `currentIndex` | 1:1 в `playbackStore` |
| `PlayerPhase` enum + кнопка play/pause + status text | 1:1 |
| `fetchSceneData`: status → audio → video → IU (parallel) + retry | 1:1 (`api/scene` + `preloadAhead`) |
| Layer toggles audio/image/video/subtitles + чипы | 1:1 (`playbackStore` + `.chip--layer`) |
| `seekToPosition` (refresh book JSON если нет → `missingIuPosition` overlay) | 1:1 + `positionStore` |
| Curtains / cover / result / iu-missing-overlay / subtitle | 1:1 DOM/CSS |
| `clearCache()` при смене `buildId`; `needsContentRefresh` | 1:1 (`mediaCache` + store) |
| `DONT_DO.md` антипаттерны | соблюдаются (не воспроизводим stall/retry IU, skip-UU, переписывание preload) |

### 1.11. Зафиксированные обоснованные отклонения игрока

| Отклонение | Причина | Альтернатива |
|---|---|---|
| `MediaPlayer`×3 → `<audio>`×2 + `<video>` ×1 | нет `MediaPlayer` в вебе | два `<audio>` (gapless A) + `<video>` |
| `setNextMediaPlayer` gapless → ранний switch −200ms / Web Audio | нет нативного gapless | §1.2 A→(B) |
| `SurfaceView`+`setDisplay` → `<video>` | нет surface | CSS letterbox + sync events |
| `MediaDecoder.decodeBitmap` → `createImageBitmap`/`<img>` | нативный декодинг браузера | `URL.createObjectURL(blob)` |
| `SimpleDiskCache` (файлы) → Cache API/IndexedDB (Blob) | нет FS | `mediaCache` с `clearCache()` по `buildId` |
| `onTrimMemory` → `freeze`/`visibilitychange` + `stopAll()` | нет Android trim | событие высвобождения |
| `savedPlaybackPositionMs` при rotation → sessionStorage при `pagehide` | нет rotation | сохранение/восстановление позиции |
| seek `seekTo(ms)` → `currentTime = ms/1000` | секунды vs ms | точность ограничена keyframes (обоснованное отступление) |

---

## 2. R10 — Waveform (`WaveformView`)

**Android:** кастомный `View.draw(Canvas)` по `WaveformData` (массив peaks pos/neg),
отрисовка вертикальных линий, центрирование, текст «No waveform data»
(`WaveformView.kt`). Данные берутся из `/api/v1/scene/{book}/{ch}/{sc}/waveform`.

**Перенос:** Canvas-компонент `lib/waveform.ts`, отрисовка идентичная (те же
`canvas.drawLine(x, midY - posH, x, midY + negH)` → `ctx.fillRect`). Палитра
`waveformPaint`/`textPaint` → CSS-токены. Скрабы/seek (если есть в `EditFragment`)
→ pointer events по canvas + `x → time`.

**Альтернативы при проблемах на слабых устройствах:** замена на `<canvas>` с
downsampled peaks (рендерить только видимые пики); пред-рендер в offscreen
canvas; интерактивные пики — только в фокусе. Риск средний, не блокирующий.

---

## 3. R11 — SSE-прогресс генерации на мобильных

Android использует стриминг (`ProgressStream.kt`) для прогресса генерации. На
мобильных веб-сетях частые обрывы → нужны:

- **Reconnect** с восстановлением последнего `Accept: text/event-stream` +
  `Last-Event-ID` (если поддерживается сервером).
- **Монотонность** прогресса (не откатывать назад при reconnect) — модель из
  `docs/05-frontend/PROGRESS_HANDOFF.md` (F1-F7).
- **Stuck-детект** и фоновый поллер как fallback (как в Android flow).
- **`proxy_buffering off`** уже выставлен в nginx (`proxy/conf/default.conf`):
  `m.animastor.in/api/` — ок для SSE.

**Альтернативы при проблемах с SSE:** long-polling (`/progress-panel` poll) или
WebSocket-обёртка (если бекенд поддержит). Фиксируется в `generateStore` этапе 4.

---

## 4. R12 — Импорт `.vbook` / file association

Android ловит `ACTION_VIEW` для `.vbook` mime. Веб:

- `<input type="file" accept=".vbook,text/plain">` + drag-drop на `File`странице.
- Deep link: `https://m.animastor.in/file?book=<id>` после импорта; либо
  `?open=<id>` для ссылки из уведомлений/sharing.

Обоснованное отклонение: нет системной ассоциации `.vbook` с сайтом; URL
scheme не вводим (требует нативной регистрации PWA). Импорт через явный выбор
файла — эквивалент по сценарию.

---

## 5. R13 — Library и WebView

`fragment_library.xml` держит `WebView`. Варианты: `<iframe>` (с учётом
X-Frame-Options/CSP источника) или рендер содержимого напрямую. Если источник
контролируется нами — iframe; если внешний — рендерить через fetch+sanitize
или открыть в новой вкладке. Финал определяется источником справки на этапе 1.4.

---

## 6. R14 — Basic Auth на m.animastor.in

В `proxy/conf/default.conf` mobile-frontend защищён `auth_basic` до завершения
разработки. На мобильных это стандартный браузерный диалог. Низкий риск; снять
перед публичным запуском и зафиксировать здесь.

---

## 7. Прочие обоснованные отклонения (общие)

| Отклонение | Причина | Альтернатива |
|---|---|---|
| `dp/sp` → `rem`/`vh`/`vw` | единицы веба | плотность 1dp≈0.0625rem на 16px-base |
| `ObjectAnimator` pulse → CSS `@keyframes` opacity | нет Android-anim | `animation: pulse 1.6s infinite` для running; 1.2s error; 1.5s×8 success + таймер сброса (как `MainActivity.updateNavIconStatus`) |
| `SharedPreferences` → `localStorage` | хранилище | тема/язык/PREFS_* |
| `attachBaseContext` locale override → `document.documentElement.lang` + i18n dict | нет context-override | переключение словаря + `lang` attr |
| `Toast.makeText` → toast-компонент | нет Toast | `.toast` (CSS) auto-dismiss 3s |

---

## 9. Отклонения этапа 1 (Settings/VBook/Worker/Library)

| Отклонение | Причина | Альтернатива |
|---|---|---|
| `WorkerSettingsFragment` (3 отдельных фрагмента по типу воркера) → один маршрут `/settings/worker` с segmented control audio/image/video | веб-маршрут один; Android-навигация по аргументам `worker_type` не имеет прямого URL-эквивалента | сегмент-переключатель типа на странице; содержимое идентично фрагменту (профиль/таймаут/workflow) |
| Карточка «Воркеры» (`/worker/counts`) добавлена в WorkerSettings | TODO этапа 1 явно указывает `/worker/counts` как API экрана; Android показывает counts только на Generate | read-only сводка доступность/активность по типам |
| Профиль в WorkerSettings — read-only `select` без сохранения | в Android профиль определяется активными workflow-коннекторами и не персистится из этого экрана (Apply сохраняет только таймаут) | select из `/connectors/profiles` + подпись «Determined by active workflow connectors» |
| Без открытой книги — уведомление + Apply disabled | Android молча выходит (no-op); веб требует объяснения состояния | `.settings-page__notice` + disabled кнопка |
| Library: WebView → `<iframe src="https://animastor.in">` + ссылка «Открыть в браузере» | R13: источник контролируем мы; iframe допустим; на случай блокировки CSP — fallback-ссылка | iframe + external link |
| Вход в Library добавлен на File-заглушку (аналог `libraryCard`) | Android открывает Library из FileFragment | кнопка на `FilePage` (станет нативной при этапе 3) |

---

## 11. Отклонения этапа 2 (Workflows/Dev/AI)

| Отклонение | Причина | Альтернатива |
|---|---|---|
| WorkflowManager читает `/connectors/grouped` вместо `/workflows` + `/workflows/summary` | Android `WorkflowManagerFragment` построен на `getConnectorsGrouped()` (F12: серверные активные счётчики, subtitle = первый коннектор); `/workflows/summary` Android-фрагменты не используют | 3 карточки из grouped-ответа 1:1 с Android |
| `editMode`/connector для `/dev` передаются через модульный store (`routeState.ts`), а не query-параметр | preact-router матчит полный URL (pathname + search), поэтому `/workflows/:name?edit=1` загрязняет `:name`, а `/dev?connector=…` не матчится вовсе | сигналы `detailsEditMode`/`devConnector` — аналог fragment-аргументов Bundle |
| `detailsEditMode` НЕ сбрасывается на unmount | сброс ломал back-навигацию (details→dev→back терял edit-режим, т.к. `useState(() => …)` инициализируется один раз); все точки входа выставляют его заново перед navigate | значение живёт до следующего явного перехода (допустимый stale на прямых deep-link) |
| Правка биндинга/гайд-ноды — радиосписок совместимых нод вместо ActivityResult | Android использует кастомный диалог с RadioGroup поверх `dialog_edit_parameter` | модал с радиосписком из `workflow.nodeTypes` (фильтр по expectedClass) |
| Add Workflow — `<input type=file>` + `File.text()` + `JSON.parse` вместо OpenDocument+OkHttp | веб-эквивалент OpenDocument; имя из поля `name` или guess из имени файла (как в Android `guessConnectorName`) | форма-фидбэк через toast |
| Voice input в AI — Web Speech API (`webkitSpeechRecognition`) | аналог `SpeechRecognizer`; на десктопных браузерах без поддержки — тост «недоступно» | ru-RU/en-US по языку интерфейса |
| Markdown-рендер бабблов — `dangerouslySetInnerHTML` с портом `applyMarkdownTo` + `sanitizeUrl` | Android использует `Html.fromHtml` (платформенный санитайзер); веб требует ручной фильтр | экранирование `&<>` + запрет `javascript:/data:/vbscript:` и кавычек в href |
| Guide-ноды заголовок — ключ `workflow_guide_nodes` | Android хардкодит «Guide Image Nodes» в коде (нет в strings.xml) | добавлен ru/en ключ |
| Распознавание речи/сессии при отсутствии книги: AI показывает welcome (create-mode) | Android при пустом bookId показывает `ai_creation_welcome` | 1:1 поведение |
| Удаление сессии через `confirm()` | Android — отдельный диалог/кнопка | нативный `confirm` для web |

---

## 12. Отклонения этапа 3 (File)

| Отклонение | Причина | Альтернатива |
|---|---|---|
| Deep link `?book=<id>`/`?open=<id>` грузит книгу с сервера (`GET /book/{id}`), а не «импортирует файл» | `ACTION_VIEW` доставляет байты файла; для веб-ссылки файл уже на сервере — загрузка по id эквивалентна сценарию | `openBookById` следует той же навигационной логике, что `importBookFromFile` (vbook/txt: Play при сценах, Play при `has_assets`); параметр снимается из URL после обработки (deep-link обрабатывается один раз на mount; onNewIntent-аналог для same-document не требуется) |
| Drag-drop импорта на карточке Import | Android — только системный picker; docs (02 §2.3, 04 §2.3) явно требуют drag-drop | `onDragOver/onDrop` + подсветка `.file-card--drag` |
| Экспорт: fetch-Blob → `<a download>` вместо CreateDocument+OkHttp streamToFile | нет SAF content-URI в вебе | загрузка через `URL.createObjectURL`; прогресс из `Content-Length` (getBlob onProgress); статусы 1:1 (`export_*` → `export_progress` → `export_saved` 3s → clear) |
| Импорт без кэширования файла в cacheDir | Android копирует URI→temp-файл перед `importBookFromFile`; в вебе `File` уже в памяти | `postMultipart` сразу; ошибочные форматы возвращают `error` из `/book/import` → `errorMessage` в статус-тексте |
| `coverImage` в `playbackPrepared` не грузится при импорте | Play (этап 7) ещё заглушка; Android `loadCoverBitmap` нужен для кувер-дисплея плеера | `PlaybackPrepared.coverImage` остаётся undefined до этапа 7; контракт готов |
| «Список книг» = Library (animastor.in) | серверного эндпоинта списка книг нет, в Android FileFragment списка тоже нет — каталог книг живёт на сайте | карточка Library → `/library` (iframe) |
| Deep-link навигация — через `navigationEvent` (store), не через немедленный `switchToPlayTab` | Android `handleVBookIntent` зовёт `switchToPlayTab()` до завершения импорта, а затем `NavigationEvent` может увести на Generate; веб ждёт результат импорта и идёт сразу на верную вкладку (без двойного переключения) | один `navigationEvent` → `/play` или `/generate` |

---

## 13. Отклонения этапа 4 (Generate)

| Отклонение | Причина | Альтернатива |
|---|---|---|
| Прогресс: poll `/progress-panel` (1.5s) как основной источник + SSE `/progress-stream` advisory (не наоборот) | Android держит и SSE (`ProgressStream`), и поллер 1.5s (reconcile/fallback); на вебе fetch-per-frame проще, SSE — push-ускорение для VBook (`import_complete` завершает поллер раньше) | `computeProgressRows` вызывается из поллера; SSE-события обновляют `vbookProgress`/флаги (R11-монотонность через monotonic floor в сторе) |
| `checkAndRestoreGenerationState` — 2.5s после mount (не при старте activity) | GenerateFragment делает `delay(2_500)` до вызова, чтобы backend успел startup recovery | тот же таймаут в `useEffect` |
| «Generate All» запускает только VBook и показывает toast «Generate All: слои (scope)» | 1:1 с Android `onGenerateAllClicked` (scope-диалог → `onGenerateVBookClicked()` + toast; GPU-слои не запускаются) | воспроизведено буквально |
| Тост «… generation started» — англоязычные хардкоды | в Android это хардкоды в коде (не strings.xml): «VBook generation started» и т.п. | те же строки в toast |
| Кнопка Stop на ряду — popup-меню «Отменить» (`worker_stop_menu_cancel`) поверх ряда вместо `PopupMenu` c gravity END | PopupMenu требует нативной привязки к view; эквивалент — модальный popup с одним пунктом | подсветка ряда не переносится (в Android — `row.setBackgroundColor` при открытии), popup закрывается по клику вне |
| VBook-ряд: сообщение-стадия (`progress_msg`) показывается как label вместо «Analyzing…» | в Android `label = stageMsg ?: vbookLabel` (эта же логика) | 1:1 |
| `applyGenerationResults` не грузит cover bitmap | Android `loadCoverBitmap` + retry нужен для cover-дисплея плеера (этап 7) | `PlaybackPrepared.coverImage` остаётся undefined до этапа 7; soft-refresh эмитится со сценами |
| Индикатор на tab-иконке — CSS-пульс, а не `ObjectAnimator` | §7: `ObjectAnimator pulse → CSS @keyframes` | `tabbar__pulse` (1.6s) / `--error` (1.2s) / `--success`; авто-сброс SUCCESS через 22s таймер (как `updateNavIconStatus`) |
| Настройки воркера (gear): `/settings/worker` открывается с типом через `routeState.workerType`, а не отдельными фрагментами | WorkerSettingsFragment.newInstance(type, label) — аргумент фрагмента; веб-маршрут один (этап 1) | `workerType` signal выставляется перед navigate; `WorkerSection` инициализируется этим типом |
| VBook-поллер завершает цикл по 2 «inactive» подряд / 5min safety timeout | Android `pollVBookProgress`: maxInactive=2, maxPollTimeMs=5min | 1:1 |

---

## 8. Правило обновления этого документа

1. Любое отклонение в коде **обязано** быть занесено сюда до реализации в виде
   записи «Отклонение / Причина / Альтернатива».
2. После реализации этапа соответствующие пункты помечаются статусом
   (✅ принято / ⚠️ прототип / ❌ отложено).
3. Антипаттерны из [`docs/DONT_DO.md`](../DONT_DO.md) переносятся в веб как
   эквивалентные запреты (stall/retry IU, skip-UU по null bitmap, rewrite
   sliding-window preload, двойной trigger навигации на Play) — в код
   `features/player/*` их не переносить.
