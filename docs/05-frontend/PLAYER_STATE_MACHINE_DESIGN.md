# Player State Machine — Design (T6)

> **Статус:** 🟢 Design (not yet implemented). Источник: `docs/03-audit/PLAYER_AUDIO_MASTER_TIMELINE.md` §4.
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

## Инвариант (из §5)

В любой момент `selectedUnit` — индекс объекта, идентифицированного `unitId` из
`resolveUnitIndexForSequence` (unitId-first). Инвариант проверяется после каждого перехода
(seek, pause, resume, rotation, scene transition, Navigator).

## Маппинг флагов → состояния (план рефактора)

| Флаг сегодня | Куда переезжает |
|---|---|
| `currentIuSequence` + `currentIuIndex` | `selectedUnit` (единый источник истины) |
| `pendingRevealPosMs` + `videoSeekInFlight` | состояние `SEEKING` |
| `videoReadyToShow` | `VIDEO_READY` |
| `isPaused` | `PAUSED` |
| `currentPlayerSceneKey` | свойство `selectedUnit.sceneKey` |
| `advancePending` | guard перехода PLAYING → LOADING_SCENE (idempotent) |
| `pendingLoad` | свойство состояния (positioned & paused) |
| `videoPlayerGeneration`/`videoCurrentGen`/`pendingRevealGen` | остаются (guard событий от освобождённых плееров) |
| `videoSurfaceAlive` | свойство surface, не состояние Player |

## Правило на будущее

Не добавлять новые независимые флаги. Любое новое поведение выражается через:
1. переход между состояниями, ИЛИ
2. свойство существующего состояния.

## Следующие шаги

- [ ] Описать переходы как таблицу событий (event → state transition) для обеих платформ.
- [ ] Android: заменить флаги на `MutableStateFlow<PlayerState>`; Web: `signal<PlayerState>`.
- [ ] Убрать/задепрекейтить флаги после покрытия регрессом T4.