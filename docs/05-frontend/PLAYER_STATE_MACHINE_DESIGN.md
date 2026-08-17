# Player State Machine — Design (T6)

> **Статус:** 🔧 Implemented (T6). Источник: `docs/03-audit/PLAYER_AUDIO_MASTER_TIMELINE.md` §4.
> Правило: **не добавлять новые независимые флаги Player до этого рефактора.**

## Проблема

Накопилось много независимых флагов вместо одного источника истины:

```
videoReadyToShow, videoSeekInFlight, pendingRevealPosMs, pendingRevealGen,
videoPlayerGeneration, videoCurrentGen, videoSurfaceAlive,
currentPlayerVideoVersion, currentPlayerHasVideo, currentPlayerSceneKey,
currentIuSequence, currentIuIndex, advancePending, pendingLoad, ...
```

`PlayFragment.kt:85-140` (и зеркально `playbackStore.ts`). Именно такой код породил N−1
(цепочка `currentIuSequence → stopAll → null → SCENE_READY → другая картинка`).

## Целевая модель

Один `selectedUnit` = источник истины. Состояния:

```
IDLE / LOADING_SCENE / SHOWING_STORYBOARD / SEEKING / VIDEO_READY / PLAYING / PAUSED
```

| Состояние | Смысл | Вход | Выход |
|---|---|---|---|
| `IDLE` | Нет сцены, плеер свободен | init / stopAll / ошибка | LOADING_SCENE |
| `LOADING_SCENE` | Скачивание/подготовка сцены (audio+video+storyboard) | IDLE, seek в другую сцену | SHOWING_STORYBOARD / SEEKING |
| `SHOWING_STORYBOARD` | Сцена готова, поверх surface — storyboard выбранного юнита | LOADING_SCENE | SEEKING / PLAYING |
| `SEEKING` | Выполняется seek к юниту; reveal-гейт активен | SHOWING_STORYBOARD, unit tap | VIDEO_READY / PLAYING |
| `VIDEO_READY` | Позиция внутри юнита, видео раскрыто (позиционированная пауза) | SEEKING | PLAYING / PAUSED |
| `PLAYING` | Аудио-мастер шкала играет | VIDEO_READY, resume | PAUSED / SEEKING / IDLE |
| `PAUSED` | Позиционированная пауза | PLAYING / VIDEO_READY | PLAYING / SEEKING |

## Таблица переходов (event → state)

Обе платформы: состояние — **хранимое** (Android: приватное поле `playerState` +
`transition()`; Web: `playerState` + `transition()`, `getPlayerState()` возвращает имя).
Четыре семантических флага (`isPaused`, `videoReadyToShow`/`videoHasFrame`,
`videoSeekInFlight`, `pendingRevealPosMs`/`pendingVideoRevealSec`) сведены в состояние
как read-only accessors; каждая запись во флаг стала вызовом `transition()`.
`SEEKING` несёт payload: `revealGateMs` (гейт на аудио-шкале), `seekLanded`
(старый videoSeekInFlight), `paused` (старый isPaused). `BUFFERING` — не состояние,
а «игрок удержан буферным гейтом» → переходы гейта выражают его как `PAUSED`/
`VIDEO_READY`.

| Событие | Триггер (Android) | Триггер (Web) | Переход |
|---|---|---|---|
| `SCENE_LOADING` | playSceneQueue / executePendingSeek / playNext / resumeFromCurrentScene → phase DOWNLOADING | playSceneQueue / executePendingSeek / playNext / resumeFromCurrentScene | → `LOADING_SCENE` (selectedUnit == null) |
| `SCENE_TARGETED` | handleChunk / handleSilentChunk (storyboard выбранного юнита на surface) | handleChunk / handleSilentChunk | → `SHOWING_STORYBOARD` |
| `SEEK_START` | targetScene: sameScene instant-seek; full rebuild с видео (reveal-гейт вооружён) | seekAttachedVideo / playVideoOverlay / attachVideo (unit target) | → `SEEKING` (гейт `pendingRevealPosMs` / `pendingVideoRevealSec` ≥ 0, видео не раскрыто) |
| `REVEAL` | startIuCycling (pos ≥ гейт, pos < unitEnd) / STATE_READY без гейта / onRenderedFirstFrame / revealVideoAfterReturn | onVideoTimeUpdate (currentTime ≥ гейт, внутри юнита, readyState ≥ 2) / onVideoFirstFrame (без seek) | `SEEKING` → `VIDEO_READY` (paused) / `PLAYING` |
| `PAUSE` | pausePlayback / pendingLoad positioned-pause / STATE_BUFFERING | pausePlayback / handlePlayButton(BUFFERING) / enterVideoBuffering | → `PAUSED` (storyboard) / `VIDEO_READY` (видео раскрыто) |
| `PLAY` | resumePlayback / exitBuffering / playButton | resumePlayback / resumeFromBuffering | → `PLAYING` |
| `ENDED` | STATE_ENDED / iuCycling watchdog / конец silent-сцены | onTrackEnd / switchToNextPlayer / конец silent-сцены | → `LOADING_SCENE` (следующая сцена) / `IDLE` (конец очереди) |
| `ERROR` | onPlayerError (fallback на storyboard) | onVideoError / onAudioError / handlePlaybackError | → `SHOWING_STORYBOARD` |
| `STOP` | stopAll / closeBook / onDestroyView | stopAll / closeBook | → `IDLE` |

## Инвариант (из §5)

В любой момент `selectedUnit` — индекс объекта, идентифицированного `unitId` из
`resolveUnitIndexForSequence` (unitId-first). Инвариант проверяется после каждого перехода
(seek, pause, resume, rotation, scene transition, Navigator).

## Маппинг флагов → состояния (план рефактора)

| Флаг сегодня | Куда переезжает | Статус |
|---|---|---|
| `currentIuSequence` + `currentIuIndex` | `selectedUnit` (единый источник истины) | ✅ Done (обе платформы) |
| `pendingRevealPosMs` + `videoSeekInFlight` | состояние `SEEKING` (payload `revealGateMs` + `seekLanded`) | ✅ Done — accessors, записи → `transition()` |
| `videoReadyToShow` / `videoHasFrame` | `VIDEO_READY` | ✅ Done — accessor от состояния |
| `isPaused` | `PAUSED` / `VIDEO_READY` / `SEEKING.paused` | ✅ Done — accessor от состояния |
| `currentPlayerSceneKey` | свойство `selectedUnit.sceneKey` | ⚪ Остаётся полем плеера (identity медиа-итема) |
| `advancePending` | guard перехода PLAYING → LOADING_SCENE (idempotent) | ✅ Остаётся полем-гвардом (не состояние) |
| `pendingLoad` | свойство состояния (positioned & paused) | ✅ Остаётся one-shot полем (как `pendingExternalSeek`) |
| `videoPlayerGeneration`/`videoCurrentGen`/`pendingRevealGen` | остаются (guard событий от освобождённых плееров) | ✅ Остаются как есть |
| `videoSurfaceAlive` (Android) / `videoEnded`, `sceneTransitionPending`, `nextChainReady` (Web) | свойства surface/цепочки, не состояние Player | ✅ Остаются как есть |

## Правило на будущее

Не добавлять новые независимые флаги. Любое новое поведение выражается через:
1. переход между состояниями, ИЛИ
2. свойство существующего состояния.

## Статус реализации (T6)

- [x] Таблица переходов (event → state) для обеих платформ — см. выше.
- [x] `selectedUnit` — единый источник истины: Android `SelectedUnit(sequence, index)`
  (data class, `PlayFragment.kt`), Web `SelectedUnit` (интерфейс + модульная переменная,
  `playbackStore.ts`). Пара `currentIuSequence`/`currentIuIndex` удалена;
  `playbackViewModel.currentIuSequence`/`currentUnitIndex` остаются только зеркалом
  сессионного restore (выход, не источник).
- [x] 7 состояний в коде: Android — хранимое поле `playerState` + `transition()`;
  Web — `playerState: PlayerStateInternal` + `transition()`, `getPlayerState()`
  возвращает имя состояния. Вместо `MutableStateFlow`/`signal` — хранимое поле
  + единая функция переходов: состояние не может разойтись с accessor'ами, а
  реактивный flow добавляется при появлении потребителя (UI ведётся от `uiState.phase`).
- [x] Семантические флаги снесены: `isPaused`, `videoReadyToShow`/`videoHasFrame`,
  `videoSeekInFlight`, `pendingRevealPosMs`/`pendingVideoRevealSec` стали read-only
  accessor'ами состояния; все записи заменены на `transition()`. `SEEKING` несёт
  payload (`revealGateMs` / `seekLanded` / `paused`).
- [x] Guard/one-shot поля сознательно остаются полями: `advancePending` (guard
  ENDED → LOADING_SCENE), `pendingLoad` (one-shot intent positioned & paused),
  `pendingRevealGen` + поколения (guard от stale-плееров), `videoSurfaceAlive` /
  `videoEnded` / `sceneTransitionPending` / `nextChainReady` (surface/цепочка).
  Дальнейшее сворачивание — при появлении реального потребителя состояний.