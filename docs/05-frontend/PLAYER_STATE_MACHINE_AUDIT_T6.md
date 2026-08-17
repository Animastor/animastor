# Аудит Player после T6 (state machine)

Дата: 2026-08-17. Чисто чтение кода + документация; поведение плеера не менялось,
кроме одного явного контрактного бага (см. P0-1 — исправлен отдельной правкой).

Охвачено:

- Web: `frontends/app/src/state/playbackStore.ts` (1939 строк) + `playbackGate.ts` (чистый модуль гейта).
- Android: `frontends/android/.../ui/PlayFragment.kt` (1845 строк) + `PlayerGate.kt`
  + `PlaybackViewModel.kt` (фаза — единый источник для UI).
- Точки входа UI: `PlayPage.tsx` (потребляет `videoVisible`, `currentIuBlobUrl`, `uiState`).

---

## 1. Краткая схема текущей архитектуры

Два независимых «движка» с одинаковым контрактом (порты 1:1, отклонения в docs/06 §16):

```
Web (module-level)                              Android (fragment + VM)
─────────────────────                          ─────────────────────────
playerState: PlayerStateInternal               playerState: PlayerState
  (7 состояний, хранимое,                    (sealed class, 7 состояний,
   меняется ТОЛЬКО через transition())         меняется ТОЛЬКО через transition())
        │                                              │
        ├─ 4 семантических флага (accessors):          ├─ те же 4 флага (val-getters):
        │   isPaused / videoHasFrame /                  isPaused / videoReadyToShow /
        │   videoSeekInFlight / pendingVideoRevealSec   videoSeekInFlight / pendingRevealPosMs
        │        │                                       │
uiState.phase (signal)                      PlaybackViewModel.uiState.phase (StateFlow)
  — UI-фаза, пишется независимо                 — пишется независимо (preparePlayback,
  (emitScene, pausePlayback,                    pausePlayback, enterBuffering, playNext…)
  enterVideoBuffering…)                          — единственный источник для кнопки/статуса
        │
enginePaused (signal, write-only!)
        │
videoVisible (signal → PlayPage)            videoSurface.visibility (прямой UI)
```

Ключевая особенность: **`playerState` и `uiState.phase` пишутся из разных мест и
никак не синхронизируются автоматически** — согласованность держится на том, что
каждый переход сопровождается подходящей записью фазы. Часть комбинаций
«playerState + phase» намеренно не согласована (см. §4).

`selectedUnit` — единый источник истины для выбранного юнита (замена пары
`currentIuSequence`/`currentIuIndex`, корень N−1-багов). `currentIuBlobUrl` /
`playbackViewModel.currentIuSequence` — display/session-зеркала, пишутся как выходы.

---

## 2. Таблица состояний

Запрошенная таблица `PLAYER STATE | UI PHASE | ENGINE PAUSED | VIDEO LAYER | СМЫСЛ`.
`ENGINE PAUSED` — web-сигнал (на Android его нет: роль играет производный `isPaused`
и фаза VM). `VIDEO LAYER` — `videoVisible` (web) / `videoSurface` (Android).

| playerState | uiState.phase (типовые) | enginePaused (web) | VIDEO LAYER | СМЫСЛ |
|---|---|---|---|---|
| `IDLE` | IDLE / SCENE_READY | false | off | Стоп/старт: сцены нет, игрок освобождён (stopAll, closeBook, onDestroyView, showMissingChunkOverlay). |
| `LOADING_SCENE` | DOWNLOADING (или PLAYING до handleChunk) | false (true при pendingLoad) | off | Сцена скачивается/эмитится (playSceneQueue, playNext, executePendingSeek, onTrackEnd, resumePlayback без таргета). |
| `SHOWING_STORYBOARD` | PLAYING / SCENE_READY / PAUSED | false | off | Аудио играет (или готово), видео не раскрыто: нет кадра, слой выкл, fresh src без таргета, audio-only сцена. **НЕ означает «пауза»** — семантическая перегрузка имени (см. §4). |
| `SEEKING` | PLAYING (норма) / PAUSED (pendingLoad) | false / true | off | Unit-seek: видео вооружено гейтом раскрытия (position-гейт по аудио-шкале, кламп на выбранный юнит), сториборд закрывает поверхность до позиции внутри юнита. |
| `VIDEO_READY` | PAUSED / BUFFERING | true / false | on | Видео раскрыто, но стоит: пауза с раскрытым видео, буфер-гейт держит видео видимым под «Загрузка…». |
| `PLAYING` | PLAYING | false | on | Видео раскрыто и играет (первый кадр / reveal-гейт / выход из буфера). |
| `PAUSED` | PAUSED / BUFFERING | true | off | Пауза со сторибордом (видео не раскрыто), буфер без кадра. |

### Payload состояния `SEEKING`

| поле | web | Android | кто ставит | кто очищает |
|---|---|---|---|---|
| `revealGateSec` / `revealGateMs` | сек (web), мс (Android) | вооружение: `attachVideo`, `seekAttachedVideo`, `playVideoOverlay` (web); `targetScene` same-scene и full-rebuild (Android) | выход из SEEKING: reveal, pause, buffering, stop, detach, scene-change. Никто не «очищает» поле отдельно — гейт живёт внутри состояния. |
| `seekLanded` | **web: false всегда при вооружении, true — только по фиксу P0-1 (пересечение позицией гейта)** | Android: false при same-scene seek, true сразу при full-rebuild; false→true — STATE_READY watchdog (L1391) и onPositionDiscontinuity (L1461) | — | — |
| `paused` | `isPaused()` на момент вооружения; true — pendingLoad (handleChunk L1204); false — resumePlayback (L510) | то же | — | — |

Завершители SEEKING (callbacks):
- web: `onVideoTimeUpdate` (позиция ≥ гейта + кадр + внутри юнита) → `VIDEO_READY`/`PLAYING`. Других завершителей нет (первый кадр намеренно не раскрывает во время гейта).
- Android: `startIuCycling` (позиция ≥ гейта) → `VIDEO_READY`/`PLAYING`.
- Прерыватели (обе платформы): пауза (гейт дропается — безопасно, seek уже применён к элементу), буфер, stop, detach, новый seek (пере-вооружение), конец сцены.

Устаревший callback после нового seek: на web `timeupdate` статичен (читает текущее
состояние) — повторный/устаревший вызов просто пере-оценивает новый гейт; на Android
discontinuity/watchdog идемпотентны (читают текущий SEEKING). **Единственный реальный
источник устаревших callbacks — накопившиеся `loadedmetadata`-листенеры (см. R2).**

---

## 3. Все источники состояния

### 3.1 Web — `transition()` (26 мест, включая определение)

| № | Место (строка) | Кто вызывает / сценарий | Состояние |
|---|---|---|---|
| 1 | L326 | `preparePlayback` — открытие книги / рестарт | `SHOWING_STORYBOARD` (если есть selectedUnit) / `IDLE` |
| 2 | L385 | `refreshContent` (не-играющая ветка) — soft refresh | `SHOWING_STORYBOARD` / `IDLE` |
| 3 | L457 | `playSceneQueue` — Start с начала | `LOADING_SCENE` |
| 4 | L483 | `rotationRecovery` — восстановление после ротации | `SHOWING_STORYBOARD` / `IDLE` |
| 5 | L489 | `pausePlayback` — пауза | `VIDEO_READY` (раскрыто) / `PAUSED` |
| 6 | L510 | `resumePlayback` — рестарт | `SEEKING{paused:false}` (если seek) / `PLAYING` / `SHOWING_STORYBOARD` |
| 7 | L579 | `pauseIfPlaying` — скрытие вкладки, silent-сцена (currentPlayer==null) | `PAUSED` |
| 8 | L671 | `executePendingSeek` — внешний unit-seek | `LOADING_SCENE` |
| 9 | L804 | `attachVideo` с `pendingVideoTargetSec≥0` — ре-аттач элемента | `SEEKING` (гейт) |
| 10 | L815 | `attachVideo` без таргета | `PAUSED` / `SHOWING_STORYBOARD` |
| 11 | L840 | `detachVideo` — размонтирование PlayPage | `PAUSED` / `SHOWING_STORYBOARD` |
| 12 | L855 | `playNext` — конец очереди | `SHOWING_STORYBOARD` / `IDLE` |
| 13 | L879 | `playNext` — fetch сцены | `LOADING_SCENE` |
| 14 | L1177 | `handleChunk` — audio-only сцена (нет видео/слой выкл) | `PAUSED` / `SHOWING_STORYBOARD` |
| 15 | L1204 | `handleChunk` — pendingLoad (positioned & paused) | `SEEKING{paused:true}` / `PAUSED` |
| 16 | L1249 | `handleSilentChunk` — сцена без аудио (Cover) | `SHOWING_STORYBOARD` |
| 17 | L1503 | `seekAttachedVideo` — same-scene unit-seek | `SEEKING` (гейт) |
| 18 | L1570 | `playVideoOverlay` — fresh src + явный таргет | `SEEKING` (гейт) |
| 19 | L1581 | `playVideoOverlay` — fresh src без таргета | `PAUSED` / `SHOWING_STORYBOARD` |
| 20 | L1633 | `onVideoFirstFrame` — первый кадр раскодирован | `VIDEO_READY` / `PLAYING` |
| 21 | L1669 | `onVideoTimeUpdate` — reveal-гейт (позиция внутри юнита) | `VIDEO_READY` / `PLAYING` |
| 22 | L1779 | `enterVideoBuffering` — буфер-гейт | `VIDEO_READY` (раскрыто) / `PAUSED` |
| 23 | L1818 | `resumeFromBuffering` — выход из буфера | `PLAYING` / `SHOWING_STORYBOARD` |
| 24 | L1836 | `stopAll` — стоп | `IDLE` |

### 3.2 Web — записи `uiState.phase`

| Место | Значение | Почему | Совпадает ли с playerState в этот момент |
|---|---|---|---|
| L319-321 `preparePlayback` | SCENE_READY / IDLE | книга готова, сцены загружены | SHOWING_STORYBOARD/IDLE — да (тот же if по selectedUnit) |
| L371-373 `refreshContent` (играет) | SCENE_READY | софт-рефреш при активном плеере | stopAll→IDLE внутри, фаза «ошибочно» SCENE_READY до следующего resume — намеренно |
| L379-381 `refreshContent` (не играет) | SCENE_READY / IDLE | ресет после регенерации | да (тот же if) |
| L482 `rotationRecovery` | SCENE_READY | экран пересоздан | SHOWING_STORYBOARD/IDLE — да |
| L494 `pausePlayback` | PAUSED | пауза | VIDEO_READY/PAUSED — да (синхронно с transition) |
| L503 `resumePlayback` (refresh) | DOWNLOADING | контент перегенерирован | stopAll→IDLE до playNext — транзиентно |
| L527 `resumePlayback` | PLAYING | рестарт | PLAYING/SEEKING/SHOWING_STORYBOARD — **нет**: фаза PLAYING при SEEKING и SHOWING_STORYBOARD (намеренно: UI «играет», видео может быть ещё скрыто) |
| L539/545 ошибки | SCENE_READY + error | ошибка медиа | stopAll→IDLE — транзиентно |
| L686 `executePendingSeek` | DOWNLOADING | загрузка сцены по тапу | LOADING_SCENE — да |
| L715 `closeBook` | IDLE (initial) | закрытие книги | IDLE — да |
| L853 `playNext` конец | SCENE_READY | очередь закончилась | SHOWING_STORYBOARD/IDLE — да |
| L878 `playNext` fetch | DOWNLOADING | загрузка сцены | LOADING_SCENE — да |
| L892 `playNext` error | SCENE_READY + error | fetch упал | LOADING_SCENE — транзиентно (без stopAll!) |
| L900 `emitScene` | PLAYING | сцена доставлена | **LOADING_SCENE** → затем handleChunk (SEEKING/SHOWING/PAUSED) — большой транзиентный разрыв «фаза уже PLAYING, плеер ещё не тронут» (намеренно, см. R3) |
| L1207 `handleChunk` pendingLoad | PAUSED | positioned & paused | SEEKING{paused:true}/PAUSED — да |
| L1780 `enterVideoBuffering` | BUFFERING | видео-андерран | VIDEO_READY/PAUSED — да (буфер держит плеер) |
| L1823 `resumeFromBuffering` | PLAYING | буфер накоплен | PLAYING/SHOWING_STORYBOARD — да |

### 3.3 Web — записи `enginePaused`

| Место | Значение | Сценарий |
|---|---|---|
| L490 | true | `pausePlayback` |
| L515 | false | `resumePlayback` |
| L580 | true | `pauseIfPlaying` silent-ветка |
| L1205 | true | `handleChunk` pendingLoad |
| L1250 | false | `handleSilentChunk` |
| L1423 | false | `onAudioError` |
| L1851 | false | `stopAll` |

**Ни одно место в коде не читает `enginePaused`** (только пишет; сигнал экспортирован
как API-зеркало `fragment.isPaused`). Все записи парные с `transition()`, при которых
`isPaused()` даёт то же значение — дрейфа нет.

### 3.4 Web — семантические проекции (accessors)

- `isPaused()`: `PAUSED|VIDEO_READY → true`; `SEEKING → paused`; иначе false.
- `videoHasFrame()`: `VIDEO_READY|PLAYING → true`.
- `videoSeekInFlight()`: `SEEKING && !seekLanded`.
- `pendingVideoRevealSec()`: `SEEKING.revealGateSec` (сек!) | −1.
- `getPlayerState()`: имя состояния (публичный выход).

### 3.5 Web — operational/one-shot поля

`pendingLoad`, `sceneTransitionPending`, `nextChainReady`, `needsContentRefresh`,
`needsRotationResume`, `savedPlaybackPositionMs`, `pendingSeekPositionMs`,
`isExecutingExternalSeek`, `pendingExplicitUnitTarget`, `pendingExternalUnitId`,
`pendingVideoTargetSec`, `videoEnded`, `videoBuffering` + таймеры буфера,
`resumeBufferTargetS`/`lastResumedAt`, `currentVideoSceneKey`, `videoSrcUrl`,
`preloadJobToken`, `sceneEpoch`, `sceneSeqCounter`/`lastProcessedSceneSequence`,
`selectedUnit`, элементы `currentPlayer`/`nextPlayer`/`videoEl`.

### 3.6 Android — `transition()` (24 места)

| Место | Сценарий | Состояние |
|---|---|---|
| L849 | `handleChunk` pendingLoad | `Paused` |
| L872 + **L884 (дубль!)** | `handleSilentChunk` | `ShowingStoryboard` |
| L1006 | `showMissingChunkOverlay` | `Idle` |
| L1148 | `startIuCycling` reveal (позиция ≥ гейта) | `VideoReady`/`Playing` |
| L1216 | `onTrackEnd` — конец сцены | `LoadingScene` |
| L1308 | `targetScene` same-scene unit-seek | `Seeking(landed=false)` |
| L1326 | `targetScene` full rebuild | `Seeking(landed=true)` (видео) / `Paused` / `ShowingStoryboard` |
| L1391 | STATE_READY watchdog (seek «уже на месте») | `Seeking(landed=true)` |
| L1400 | STATE_READY на скрытом экране | `VideoReady`/`Playing` |
| L1416 | STATE_READY первый кадр (не во время гейта) | `VideoReady`/`Playing` |
| L1425/1428 | STATE_READY выход из буфера | `Playing` / `VideoReady`/`Paused` |
| L1440 | STATE_BUFFERING | `VideoReady`/`Paused` |
| L1461 | onPositionDiscontinuity (SEEK) | `Seeking(landed=true)` |
| L1480 | onRenderedFirstFrame (gen-guarded) | `VideoReady`/`Playing` |
| L1511 | onPlayerError (реальная ошибка) | `Paused`/`ShowingStoryboard` |
| L1577/1589 | `revealVideoAfterReturn` (поверхность пересоздана) | `Paused`/`ShowingStoryboard` → `VideoReady`/`Playing` |
| L1617 | `pausePlayback` | `VideoReady`/`Paused` |
| L1635/1647 | `resumePlayback` (refresh / нет таргета) | `ShowingStoryboard` / `LoadingScene` |
| L1659 | `resumePlayback` | `Seeking(paused=false)` / `Playing` / `ShowingStoryboard` |
| L1718 | `stopAll(keepSurface)` | `Seeking(landed=true)` (keepSurface+гейт) / `ShowingStoryboard` / `Idle` |
| L1834 | `onDestroyView` | `Idle` |

Android VM фазы (`PlaybackViewModel`): SCENE_READY/IDLE (prepare/refresh), PAUSED
(pausePlayback), BUFFERING/PLAYING (enter/exitBuffering), DOWNLOADING/PLAYING
(resumePlayback), DOWNLOADING (executePendingSeek/playNext), SCENE_READY (ошибки),
PLAYING (emitScene). Всё то же семейство комбинаций, что и на web.

---

## 4. Найденные расхождения

### P0-1. Web: reveal-гейт мёртв после unit-seek (deadlock) — **ИСПРАВЛЕНО**

`onVideoTimeUpdate` (L1669):

```js
if (!videoSeekInFlight() || !videoEl || pendingVideoRevealSec() < 0) return;  // требует true
...
if (shouldRevealSeekVideo({ seekInFlight: videoSeekInFlight(), ... })) {      // требует false
```

- Guard требует `videoSeekInFlight()==true` (SEEKING && !seekLanded).
- AND-гейт `shouldRevealSeekVideo` требует `seekInFlight==false`.
- На web **никто не переключает `seekLanded` в true** (нет аналога Android watchdog
  L1391 / onPositionDiscontinuity L1461 — все вооружения пишут `seekLanded:false`).

Итог: после любого unit-seek, вооружившего SEEKING (same-scene seek L1503, fresh src
с таргетом L1570, ре-аттач L804), раскрытие **никогда не срабатывает** — сториборд
остаётся поверх видео до выхода из SEEKING (пауза/буфер/стоп/смена сцены). `onVideoFirstFrame`
тоже бьёт по `videoSeekInFlight()` и молчит.

Регрессия введена в T2.2 (коммит `3da6f27`): до рефакторинга (`7996b48`) условие было
`currentTime >= pendingVideoRevealSec && withinUnit`, а сам reveal очищал
`videoSeekInFlight=false` (пересечение позицией гейта И ЕСТЬ «посадка»). T6 перевёл
флаг в проекцию (работало), T2.2 добавил в AND-гейт условие «не в полёте» и передал
туда то же значение, что в guard, — deadlock.

**Фикс (минимальный, контракт восстановлен):** пересечение позицией гейта — это и
есть web-сигнал посадки (аналог Android-колбэков). В `onVideoTimeUpdate` перед
проверкой AND-гейта: `transition({ ...playerState, seekLanded: true })`, если
`videoEl.currentTime >= pendingVideoRevealSec()`. После этого `videoSeekInFlight()`
становится false, AND-гейт «не в полёте» выполняется, reveal срабатывает как раньше.

### P1-1. Web: silent-сцена + скрытие вкладки — `phase=PLAYING` при `playerState=PAUSED` — **DONE**

`pauseIfPlaying` (L579) в ветке `currentPlayer==null && selectedUnit!=null` делал
`transition('PAUSED')` + `enginePaused=true`, но **не писал `uiState.phase`** —
оставалось `PLAYING`. Кнопка/статус врали («Playing» при реальной паузе; повторный
тап по кнопке работал — `handlePlayButton` ветка `PLAYING && isPaused()` → resume).
Android-параллель (`autoPauseForBackground`) всегда идёт через `pausePlayback()` →
`PAUSED`. Разъезд платформ.

**Как исправлено:** ветка сведена к единому пути `pausePlayback()` — он безопасен
для silent-сценария (все player-touches внутри — null-safe no-op, `videoHasFrame()`
false → `PAUSED`) и дополнительно пишет `phase=PAUSED`. Оставлен только
silent-специфичный `cancelIuCycling()` (остановка таймерного цикла картинок).
State machine и reveal-gate не тронуты.

**Тест:** `frontends/app/src/state/playbackStore.test.ts` (2 теста) — реальный поток
`preparePlayback → playSceneQueue → handleSilentChunk`, затем
`pauseIfPlaying()`: `getPlayerState()==PAUSED`, `uiState.phase==PAUSED`,
`enginePaused==true`; второй тест — `resumePlayback()` после паузы возвращает
`SHOWING_STORYBOARD` + `phase=PLAYING` + `enginePaused=false`. Тест падает на
до-фиксовом коде (фаза оставалась `PLAYING`).

### P1-2. Web: устаревшие `loadedmetadata`-листенеры (stale callbacks) — **DONE**

`playVideoOverlay` регистрировал самоснимающийся `onMeta` при каждом вызове и не
снимал предыдущие (ни при смене сцены, ни в `detachVideo`, ни в `stopAll`): старый
листенер срабатывал на `loadedmetadata` НОВОЙ сцены и применял устаревший
`explicitSeekMs` (транзиентный wrong seek; финальное состояние всегда корректно —
полный анализ в §8).

**Как исправлено (вариант A, §8.4):** один module-level ref `pendingMetaListener` —
слот «последнего интента». Снятие предыдущего листенера перед регистрацией нового в
`playVideoOverlay` (до присвоения нового src), снятие в `detachVideo` и `stopAll`;
самоcнятие + очистка ref при срабатывании. Token/generation НЕ понадобился: слот
один, «последний интент» на элемент единственный (§8.2.7).

**Тест:** `frontends/app/src/state/playbackVideoListener.test.ts` (3 теста, реальный
поток preparePlayback→playSceneQueue→handleChunk→playVideoOverlay с fake-элементом):
A→B оставляет ТОЛЬКО listener B (A снят); сработавший listener снимает себя, а
`detachVideo` чистит слот; `stopAll` чистит слот. 2 из 3 падают на до-фиксовом коде.

### P2-1. Web: `enginePaused` — write-only сигнал — **DONE**

Никто не читает в production; держится как API-зеркало. Кандидат на удаление (после
проверки потребителей вне репозитория) или явную документацию «mirror for parity».

**Usage audit (полный список sites, `frontends/app`):**

| Тип | Место | Значение | Функция/контекст |
|---|---|---|---|
| write | `playbackStore.ts:112` | `signal(false)` | объявление + **export** (`fragment.isPaused` mirror) |
| write | `playbackStore.ts:496` | `true` | `pausePlayback()` |
| write | `playbackStore.ts:521` | `false` | `resumePlayback()` |
| write | `playbackStore.ts:1220` | `true` | `handleChunk` (pendingLoad — positioned & paused) |
| write | `playbackStore.ts:1265` | `false` | `handleSilentChunk()` |
| write | `playbackStore.ts:1438` | `false` | `onAudioError()` |
| write | `playbackStore.ts:1890` | `false` | `stopAll()` |
| read | `playbackStore.test.ts:42,61,89,103` | `enginePaused.value` | ТОЛЬКО тесты (P1-1 contract: pauseIfPlaying → PAUSED + phase + enginePaused; resume) |

**Production reads: 0.** Репозиторий-широкий поиск `enginePaused` находит только
`playbackStore.ts` (7 записей + экспорт), `playbackStore.test.ts` (4 чтения) и этот
документ. `PlayPage.tsx` импортирует `subtitleText`, `iuMissing`, `videoVisible`,
`pendingExternalSeek` — НЕ `enginePaused`. Косвенного использования нет: ни
destructuring, ни computed/watch, ни template bindings, ни object/state references.

**Android:** 0 совпадений — `enginePaused` отсутствует в android-коде и не является
частью общего контракта (Android-параллель — производный `isPaused` фрагмента и
фаза ViewModel).

**Вывод (классификация): C — только записывается, в production нигде не читается**
(формально экспортирован — «внешний символ», но реальных потребителей вне стора
нет; единственные читатели — тесты P1-1).

**Как исправлено (P2-1, удаление):** сигнал удалён полностью — объявление/export
(L112) и все 7 записей (`pausePlayback`, `resumePlayback`, `handleChunk`
pendingLoad, `handleSilentChunk`, `onAudioError`, `stopAll`). Тест P1-1
(`playbackStore.test.ts`) переведён на проверку `getPlayerState()==PAUSED` +
`uiState.phase==PAUSED` (контракт полностью покрыт этими двумя — `enginePaused`
дублировал `isPaused()`). PlayerState / transition() / uiState.phase / reveal gate /
video lifecycle / Android не тронуты. Repository-wide: 0 production references
(остались только исторические упоминания в этом документе и комментарий в тесте).

### P2-2. Android: двойной `transition(ShowingStoryboard)` в `handleSilentChunk`

L872 и L884 пишут одно и то же состояние подряд (между ними только установка
`selectedUnit` и пауза плеера). Безвредно, но шумит в аудите переходов.

### P2-3. Web: `preparePlayback` не чистит `selectedUnit`/`currentIuBlobUrl` при смене книги — **DONE**

При открытии книги B поверх играющей A `selectedUnit` (и blob-URL картинок A)
переживали `preparePlayback` → `SHOWING_STORYBOARD` с картинкой старой книги на
SCENE_READY новой; аудио A продолжало играть. Android очищается через `stopAll()`
(collector PLAYING→SCENE_READY); на web collector-эквивалента не было.

**Как исправлено (root cause и точка reset в §9):** в `preparePlayback`, в
существующей ветке `prevBookId !== bId` (перед `bumpSceneEpoch`), вызывается
`stopAll()` (владеет: selectedUnit, currentIuBlobUrl, subtitleText, iuMissing,
currentPlayer/nextPlayer, videoEl src, pendingMetaListener, videoSrcUrl,
currentVideoSceneKey, pendingVideoTargetSec, videoEnded, transition→IDLE,
updateLayers) + дополнительный сброс one-shot полей старой книги (НЕ покрыты
stopAll): `pendingLoad=false`, `pendingExternalUnitId=null`,
`needsContentRefresh=false`, `needsRotationResume=false`,
`savedPlaybackPositionMs=0`, `pendingSeekPositionMs=-1`,
`isExecutingExternalSeek=false`, `pendingExplicitUnitTarget=false`. Порядок
безопасен: очистка старого playback → подготовка состояния B (bookId/buildId/
sceneQueue/currentIndex/cover не трогаются stopAll) → SCENE_READY → первая сцена B.
Same-book ветка (soft re-prepare) не затрагивается.

**Тест:** `frontends/app/src/state/playbackBookSwitch.test.ts` (TEST A–D, реальный
поток preparePlayback→playSceneQueue→handleChunk с fake-элементами): A — PLAYING→B
(аудио остановлено, IDLE, currentIuBlobUrl null, B стартует); B — PAUSED→B;
C — SEEKING→B (stale seek/gate не выполняется против B, позиция аудио 0);
D — SCENE_READY книги B до первого handleChunk → `currentIuBlobUrl===null`.
Все 4 падают на до-фиксовом коде.

### P2-4. Web: «проскок» мимо конца юнита — видео остаётся скрытым — **DONE**

Если между `timeupdate`-событиями позиция перескочила за конец выбранного юнита,
`withinUnit=false` → reveal не срабатывал, и из-за одноразовой посадки (P0-1) +
guard-а `!videoSeekInFlight()` (T2.2) видео оставалось скрытым до выхода из SEEKING.

**Как исправлено (§10.7):** в `onVideoTimeUpdate` guard заменён с
`!videoSeekInFlight()` на `playerState.name !== 'SEEKING'` — после посадки каждый
tick пере-оценивает AND-гейт, и reveal срабатывает на первом тике, где
`withinUnit=true`. Инвариант подтверждён: `SEEKING + seekLanded=true + кадр готов +
гейт достигнут + withinUnit=true ⇒ reveal` (PLAYING при игре / VIDEO_READY при
паузе); при `withinUnit=false` видео НЕ раскрывается; в PAUSED (не SEEKING) guard
отсекает. State machine, gate math, seekLanded semantics, циклинг — не тронуты.

**Тест:** `frontends/app/src/state/playbackRevealOvershoot.test.ts` (5 тестов,
реальный поток arm-SEEKING через внешний unit-seek): (1) overshoot не раскрывает
и НЕ блокирует — reveal после переключения selectedUnit на следующий юнит
(регрессионный, падает на до-фиксовом коде); (2) негативный — при
`withinUnit=false` видео не раскрывается (несколько тиков); (3) happy path —
seek → gate → withinUnit → reveal в том же тике; (4) paused-seek → `VIDEO_READY`;
(5) pause до reveal → PAUSED, новый guard не раскрывает в PAUSED.

### Семантические перегрузки (не баги, но источник путаницы)

- `SHOWING_STORYBOARD` ≠ «пауза»: это «видео не раскрыто». Нормальная комбинация
  `SHOWING_STORYBOARD + phase=PLAYING` для audio-only сцен и до первого кадра.
- `SEEKING + phase=PLAYING` — норма (аудио играет, видео под гейтом).
- `VIDEO_READY + phase=BUFFERING` — норма (раскрытое видео под «Загрузка…»).
- `IDLE + любая фаза` — транзиентно между `stopAll()` и записью фазы (синхронно,
  без await, разрыва для UI нет).

### Комбинация, которую НЕ удалось получить (хорошая новость)

`playerState=PLAYING + phase=PAUSED` — не встречается: пауза синхронно пишет и
состояние, и фазу на обеих платформах. Аналогично `PLAYING + enginePaused=true`.

---

## 5. Потенциальные race conditions

- **R1 (устранена P0-1):** deadlock reveal-гейта.
- **R2:** накопившиеся `loadedmetadata`-листенеры (см. P1-2, investigation в §8) —
  устаревший seek-таргет транзиентно применяется к новой сцене; финальное состояние
  всегда корректно (доказано в §8); рекомендован вариант A (снятие предыдущего).
- **R3:** `emitScene` пишет `phase=PLAYING` ДО `handleChunk` — окно, где фаза уже
  PLAYING, а плеер ещё в LOADING_SCENE/SEEKING. Намеренно (UI «играет» сразу), но
  `handlePlayButton` в этом окне по тапу сделает паузу — корректно.
- **R4:** `attachVideo` во время unit-seek до `handleChunk` — `selectedUnit` может
  быть ещё null/stale → `unitRevealGateSec` без клампа (raw = target + tolerance).
  Редкий сценарий (ре-аттач поверх вооружённого гейта); безвреден для длинных юнитов.
- **R5:** web `stopAll()` перед `executePendingSeek` сбрасывает SEEKING — безвредно,
  гейт пере-вооружается из свежего таргета в `handleChunk`→`seekAttachedVideo`.
- **R6:** Android устаревший `onPositionDiscontinuity` после нового seek —
  идемпотентен (пишет `landed=true` в текущий SEEKING).
- **R7:** буфер во время SEEKING (web: `enterVideoBuffering` требует `phase==PLAYING`,
  что при unit-seek выполняется) — гейт дропается на `PAUSED`/`VIDEO_READY`; после
  `resumeFromBuffering` видео ре-синкается по аудио (`diff>0.5` → `applyVideoSeek`).
  Поведение сохранено относительно до-T6.

---

## 6. Рекомендации (по приоритету)

### P0
- **P0-1 (СДЕЛАНО):** web — посадить seek пересечением позицией гейта в
  `onVideoTimeUpdate` (`seekLanded=true`), иначе AND-гейт никогда не срабатывает.
  Правка: `frontends/app/src/state/playbackStore.ts` (~5 строк) + тест-покрытие на
  уровне сценария в `playbackGate.test.ts` (wiring не тестируется в чистом модуле —
  покрытие даёт ручной регресс T4).

### P1
- **P1-1 (DONE):** web `pauseIfPlaying` silent-ветка — сведена к единому пути
  `pausePlayback()` (пишет `phase=PAUSED`), тест в `playbackStore.test.ts`.
- **P1-2 (DONE):** `playVideoOverlay` — вариант A: один module-level ref
  `pendingMetaListener`, снятие предыдущего перед регистрацией нового + в
  `detachVideo`/`stopAll`. Тест в `playbackVideoListener.test.ts`.

### P2
- **P2-4 (DONE):** web `onVideoTimeUpdate` — guard `playerState.name !== 'SEEKING'`
  (пере-оценка после посадки; reveal на первом тике с `withinUnit=true`). Тест в
  `playbackRevealOvershoot.test.ts` (5 кейсов, регрессионный падает до фикса).
- **P2-1 (DONE):** `enginePaused` удалён как write-only legacy mirror (объявление +
  7 записей); тест P1-1 проверяет `getPlayerState()==PAUSED` + `phase==PAUSED`.
  Полный список write/read sites — в §4.
- **P2-2:** Android `handleSilentChunk` — убрать дубль `transition(ShowingStoryboard)`.
- **P2-3 (DONE):** web `preparePlayback` — в ветке `prevBookId !== bId` вызывается
  `stopAll()` + сброс one-shot полей старой книги. Тест в
  `playbackBookSwitch.test.ts` (TEST A–D).
- **P2-5:** унифицировать семантику `seekLanded` для fresh-src: Android вооружает
  `Seeking(landed=true)` сразу (L1326), web — `false` (L1570). После P0-1 результат
  одинаковый, но поле на web несёт другой смысл; привести к Android-варианту.

---

## 7. Что НЕ трогали (осознанно)

- Большой рефакторинг не предлагается: найденные пункты — точечные правки.
- Флаги/поля `pendingLoad`, `sceneTransitionPending`, `nextChainReady`, `videoEnded`,
  `pendingVideoTargetSec`, поколения — остаются operational/one-shot по таблице
  дизайн-дока; снос — после регресса T4.
- Полный снос `uiState.phase` в пользу производной от `playerState` — НЕ рекомендуется
  сейчас: фаза несёт UI-смысл (DOWNLOADING/BUFFERING/SCENE_READY), которого нет в
  7-состояниях, и пишется из GenerateViewModel (общая фаза на весь экран Play).

---

## 8. P1-2 — Investigation: stale `loadedmetadata`-листенеры (web)

Только исследование; код поведения не менялся. Нумерация — `playbackStore.ts` на
момент исследования.

### 8.1 Фактическая проблема

`playVideoOverlay(url, explicitSeekMs)` (L1552) при каждом вызове:

```js
videoEl.src = url;                    // L1591 — src присваивается ДО регистрации
applyVideoSeek(explicitSeekMs);
const onMeta = () => {
  videoEl?.removeEventListener('loadedmetadata', onMeta);
  applyVideoSeek(explicitSeekMs);     // применяет ИМЕННО этот вызов
};
videoEl.addEventListener('loadedmetadata', onMeta);   // L1599
```

Листенер самоснимающийся, но снимается ТОЛЬКО при срабатывании. Если `loadedmetadata`
для присвоенного src никогда не наступит (загрузку абортил новый src, элемент
отсоединён, src удалён через `removeAttribute`), листенер остаётся висеть на элементе
и срабатывает на следующем успешном `loadedmetadata` — уже другой сцены.

### 8.2 Ключевые lifecycle-факты

1. **`src` присваивается до `addEventListener` в одном и том же вызове** (L1591 → L1599).
   Гонки нет: `loadedmetadata` — это queued task (спека HTML: media events ставятся
   в очередь задач), он не может сработать синхронно внутри текущего скрипта.
2. **Новый `src` абортит текущую загрузку** (спека: media element load algorithm —
   старая загрузка отменяется при новой установке src). Одновременно существует
   **≤ 1 активная загрузка** → out-of-order `loadedmetadata` невозможен: метаданные
   могут прийти только для последнего присвоенного src.
3. **Путей присвоения `src` видео-элементу ровно два:** `playVideoOverlay` (L1591)
   и `attachVideo` (L798, ре-аттач после размонтирования PlayPage). Удаление src —
   `detachVideo` (L837) и `stopAll` (L1855). `seekAttachedVideo` (unit-seek в
   пределах сцены) src НЕ меняет.
4. **Листенер применяет только `explicitSeekMs`** своего вызова (замыкание).
   `currentVideoSceneKey`, `pendingVideoTargetSec`, `videoSrcUrl` в замыкании НЕТ.
   `applyVideoSeek(explicitSeekMs)` → `el.currentTime = explicitSeekMs/1000`
   (абсолютная позиция) или audio-sync при `null`.
5. **Готового token-а поколения на web нет:** `sceneEpoch` бьётся только на reset-ах
   (preparePlayback/playSceneQueue/executePendingSeek/refreshContent/closeBook), НЕ на
   каждой смене сцены; `sceneSeqCounter` — счётчик доставки чанков, не привязан к
   видео. `videoPlayerGeneration` (Android) на web отсутствует.
6. **`removeEventListener` корректен:** листенер именованный (`const onMeta`),
   самоснятие работает. Проблема не в механизме снятия, а в том, что он вызывается
   только на fire, а fire для абортнутой загрузки не наступает.
7. **Несколько `loadedmetadata`-листенеров одновременно не нужны:** существует ровно
   один «последний интент» на элемент. Одиночный слот корректен.

### 8.3 Race timeline

**Сценарий 8 (A → B):** `playVideoOverlay(A, targetA)` → `onMetaA`; src A ещё не
дошёл до metadata → `playVideoOverlay(B, targetB)` → `onMetaB` (зарегистрирован
ПОСЛЕ, src A абортирован) → `loadedmetadata B`:

```
dispatch loadedmetadata (один task, FIFO по регистрации):
  onMetaA: снимает себя, applyVideoSeek(targetA) → el.currentTime = targetA   ← stale
  onMetaB: снимает себя, applyVideoSeek(targetB) → el.currentTime = targetB   ← финал ✓
```

**Финальное состояние всегда корректно:** порядок вызова = порядок регистрации =
порядок вызовов `playVideoOverlay`, а последний вызов — это и есть текущая сцена.
Поэтому последним всегда применяется интент текущей сцены. Оба seek в одном task —
браузер, как правило, коалесцирует их в один (побеждает последнее значение).

**Остальные сценарии из запроса:**

- **A → B → A:** `onMetaA1`, `onMetaB`, `onMetaA2` → финал `targetA` (A2) ✓
  (повторное присвоение того же URL тоже запускает load → metadata снова сработает).
- **unit A → unit B в одной сцене:** `seekAttachedVideo` возвращает true раньше
  `playVideoOverlay` — src не меняется, новые листенеры не регистрируются, метаданные
  не переснимаются. Листенеры здесь вообще не участвуют ✓.
- **detach/stopAll между вызовами:** `videoEl = null` → stale-fire становится no-op
  (`applyVideoSeek` выходит на `!el`, `removeEventListener` пропускается — листенер
  остаётся на старом элементе и уходит в GC вместе с ним) ✓.
- **`attachVideo` re-src** — единственный путь присвоения src БЕЗ регистрации нового
  `onMeta`. Но он пере-присваивает `videoSrcUrl` = URL текущей сцены, а самый новый
  из выживших листенеров кодирует интент последнего `playVideoOverlay` текущей сцены
  → применяется корректный таргет ✓.

**Что реально остаётся (не «неверный финал»):**

1. **Транзиентный wrong seek:** `currentTime` на мгновение становится `targetA`
   (между `onMetaA` и `onMetaB`). При разнесённых во времени seek-ах (если браузер
   не коалесцирует) — лишний Range-fetch диапазона сцены A и, на медленных сетях,
   короткий вход в буфер-гейт («Загрузка…»), который самовылечивается монитором
   (200 ms poll → bufferedAhead → resume).
2. **Накопление листенеров:** при быстром churn сцен, чьи metadata так и не пришли,
   листенеры копятся, но каждый следующий успешный `loadedmetadata` снимает их все
   (FIFO) — накопление самоликвидируется и ограничено числом «оборванных» сцен.
3. **Чувствительность к будущим изменениям:** любой новый путь присвоения src или
   перестановка регистрации молча ломают инвариант «новейший — последний».

### 8.4 Решение

**Вариант A (рекомендован — РЕАЛИЗОВАН):** module-level ref на последний листенер
(`let pendingMetaListener: (() => void) | null`), снимать предыдущий перед
регистрацией нового в `playVideoOverlay` (до присвоения нового src) + в
`detachVideo` и `stopAll` (~4 строки, state machine и reveal-gate не затрагиваются).
При срабатывании `onMeta` снимает сам себя и очищает ref (`if (pendingMetaListener ===
onMeta) pendingMetaListener = null`).

**Почему A, а не B/D:**

- **A устраняет и накопление, и транзиентный seek полностью** — старый листенер
  снят ДО присвоения нового src, поэтому `loadedmetadata B` вызывает только `onMetaB`.
  Пункт 8.3.1 (единственный реальный риск) исчезает целиком.
- **A закрывает единственный «дырявый» путь** (`attachVideo` re-src без нового
  onMeta): снятие в `detachVideo` убирает выживших листенеров до ре-аттача.
- **B (token-гвард)** — рабочая альтернатива: `onMeta` сравнивает захваченный token
  с текущим и пропускает `applyVideoSeek` при устаревании. Устраняет транзиент, но
  листенеры продолжают копиться до срабатывания; требует нового счётчика (п. 8.2.5).
- **D (оставить как есть)** — формально допустим: доказано, что неверное финальное
  состояние невоспроизводимо (инвариант FIFO + одиночная активная загрузка). Но
  транзиентный seek остаётся, а инвариант хрупок к будущим правкам — риск дешевле
  устранить сейчас.

### 8.5 Регрессионный тест — добавлен вместе с фиксом

`frontends/app/src/state/playbackVideoListener.test.ts` (3 теста): вместо спая на
сеттер `currentTime` тест фиксирует сам слот — через fake `<video>`-элемент с
реестром листенеров (`listenerCount('loadedmetadata')`), получаемый через публичный
`attachVideo`, и реальный поток `preparePlayback → playSceneQueue → mocked fetch →
handleChunk → playVideoOverlay`:
1. `playVideoOverlay(A)` → `playVideoOverlay(B)` (смена сцены без срабатывания A):
   остаётся РОВНО один листенер (B) — ref-снятие A;
2. сработавший `onMeta` снимает себя; `detachVideo()` чистит слот;
3. `stopAll()` чистит слот.
2 из 3 падают на до-фиксовом коде (ref-снятие и stopAll-очистка — новые;
самоcнятие при fire существовало и раньше).

---

## 9. P2-3 — Investigation: смена книги и stale player state (web)

Только исследование; код не менялся.

### 9.1 Фактический lifecycle смены книги

Путь открытия книги B поверх играющей A (web): `openBookById(B)`
(`generateStore.ts:1124`) → `emitPlaybackPrepared` → `wirePlaybackCoordination`
(`playbackStore.ts:1951`) → **`preparePlayback(B)`**.

**`closePlayerBook()` на этом пути НЕ вызывается** — он используется только из
`generateStore.closeBook()` («Create New Book», logout) и SettingsPage. То есть
`preparePlayback(B)` при смене книги выполняется **без `stopAll()`** (stopAll зовётся
только внутри deferred-seek ветки — если в этот момент висел внешний тап).

Android-параллель: `PlaybackViewModel.preparePlayback` тоже НЕ вызывает stopAll, но
фрагмент-коллектор `observeState` (`PlayFragment.kt:580`) вызывает `stopAll()` при
переходе фазы PLAYING→SCENE_READY — именно он чистит `selectedUnit`/`currentIuSequence`
при открытии новой книги из PLAYING. (Из PAUSED→SCENE_READY коллектор не срабатывает —
на Android остаётся аналогичный латентный зазор; на web нет даже PLAYING-случая.)

### 9.2 Состояние полей ДО/ПОСЛЕ `preparePlayback(B)` (web)

| Поле | До (книга A играет) | После preparePlayback(B) | Пережило? |
|---|---|---|---|
| `selectedUnit` | A: sequence+index | **без изменений (A)** | ✅ пережило |
| `currentIuBlobUrl` | URL картинки юнита A | **без изменений (A)** | ✅ пережило |
| `currentVideoSceneKey` | ключ сцены A | без изменений (A) | ✅ |
| `videoSrcUrl` | URL видео A | без изменений (A) | ✅ |
| `videoVisible` | true (если играло) | false (playerState→SHOWING_STORYBOARD, videoHasFrame=false) | ✅ сброшено косвенно |
| `videoHasFrame()` | true (если раскрыто) | false (SHOWING_STORYBOARD) | ✅ сброшено косвенно |
| `pendingVideoTargetSec` | таргет seek-а A | без изменений | ✅ |
| `videoEnded` | false | без изменений | ✅ |
| `playerState` | PLAYING / SEEKING / PAUSED | **SHOWING_STORYBOARD** (если stale selectedUnit) / IDLE | ✅ частично (неверно при stale selectedUnit) |
| `uiState.phase` | PLAYING / PAUSED | SCENE_READY / IDLE | ✅ сброшено |
| `currentPlayer` / `nextPlayer` | аудио A (играет!) | **без изменений — аудио A продолжает играть** | ✅ пережило |
| `videoEl` | элемент с видео A | без изменений (src A) | ✅ |
| `coverImage` / `previewImage` | картинки A | **очищены** (revoke + null) | ❌ правильно сброшено |
| `bookId` / `buildId` / `sceneQueue` / `currentIndex` / `currentUnitIndex` | A | **B / 0 / 0** | ❌ правильно сброшено |
| `missingIuPosition` / `pendingExternalSeek` | — | очищены | ❌ сброшено |
| one-shots: `pendingLoad`, `pendingExternalUnitId`, `needsContentRefresh`, `needsRotationResume`, `savedPlaybackPositionMs`, `pendingSeekPositionMs`, `sceneTransitionPending`, `nextChainReady`, `isExecutingExternalSeek`, `pendingExplicitUnitTarget` | значения из жизни A | без изменений | ✅ пережили |

### 9.3 Сценарии A→B

- **A→B без stopAll (штатный путь, openBookById):** переживает всё из 9.2. Аудио A
  играет дальше (phase=SCENE_READY, но элемент жив), картинка A на экране.
- **A→B во время PLAYING:** RAF-циклинг (startIuCycling) продолжает крутить юниты A
  (isPaused=false, selectedUnit/currentPlayer всё ещё A) — `currentIuBlobUrl` меняется
  картинками A; когда аудио A доигрывает, `onAudioCompleted` → `playNext` запускает
  сцену 0 книги B «сама по себе».
- **A→B во время PAUSED:** аудио A приостановлено, но элемент и картинка A на месте;
  тап Play → SCENE_READY → `playSceneQueue` → handleChunk(B) перезаписывает всё.
- **A→B во время SEEKING:** гейт дропается на SHOWING_STORYBOARD; stale
  `pendingVideoTargetSec` (таргет A) может быть применён `attachVideo`/`resumePlayback`
  к элементу с URL видео A до того, как handleChunk(B) пере-вооружит всё.
- **A→B сразу после переключения unit:** selectedUnit/currentIuBlobUrl = новый юнит A
  — тот же утёк.

### 9.4 Визуальный сценарий (подтверждён рендером PlayPage)

`PlayPage.tsx:209`: `imgSrc = phase==='SCENE_READY' && previewImage ? previewImage :
currentIuBlobUrl.value` — на SCENE_READY книги B (previewImage очищен) рендерится
**старый `currentIuBlobUrl` книги A** до первого handleChunk(B). Старый video frame НЕ
показывается (videoVisible требует VIDEO_READY/PLAYING, а playerState после
preparePlayback — SHOWING_STORYBOARD), но «старая картинка A» и «аудио A играет» —
да. Окно утечки: от preparePlayback(B) до handleChunk(B) (загрузка первой сцены B).

### 9.5 Semantic ownership

| FIELD | BOOK CHANGE | SCENE CHANGE | UNIT CHANGE | WHY |
|---|---|---|---|---|
| `bookId` / `buildId` / `sceneQueue` / `currentIndex` / `currentUnitIndex` | **clear/replace** | replace | keep (index меняется) | владение книгой/очередью |
| `selectedUnit` | **clear** | replace (handleChunk) | replace (handleChunk/циклинг) | выбранный юнит принадлежит книге+сцене |
| `currentIuBlobUrl` / `subtitleText` / `iuMissing` | **clear** | replace (showIu) | replace (showIu) | display-выходы selectedUnit |
| `coverImage` / `previewImage` | **clear** (уже) | replace | keep | арт книги |
| `currentPlayer` / `nextPlayer` | **release/stop** | replace (gapless) | keep | аудио-элементы |
| `videoEl` | **stop/очистить src** | keep (adopted) | keep | единственный видео-элемент |
| `videoSrcUrl` / `currentVideoSceneKey` / `videoEnded` | **clear** | replace (playVideoOverlay) | keep | identity прикреплённого видео |
| `pendingVideoTargetSec` | **clear** | replace | set (per seek) | one-shot таргет видео |
| `playerState` | **IDLE** | LOADING_SCENE→…→SHOWING | SEEKING | состояние машины |
| `pendingLoad` / `pendingExternalUnitId` / `needsContentRefresh` / `needsRotationResume` / `savedPlaybackPositionMs` / `pendingSeekPositionMs` / `isExecutingExternalSeek` / `pendingExplicitUnitTarget` / `sceneTransitionPending` / `nextChainReady` | **clear** | clear/replace | set | one-shot интенты |
| `missingIuPosition` / `pendingExternalSeek` | **clear** (уже) | clear | set | внешние seek-команды |

### 9.6 Вывод и минимальная рекомендация

**Stale state ВОЗМОЖЕН** (подтверждён): при смене книги через `openBookById`
`preparePlayback(B)` не вызывает `stopAll()` → переживают `selectedUnit`,
`currentIuBlobUrl`, `subtitleText`, `iuMissing`, `videoSrcUrl`, `currentVideoSceneKey`,
`pendingVideoTargetSec`, `videoEnded`, аудио-элементы (играют дальше), playerState
(SHOWING_STORYBOARD от stale selectedUnit) и все one-shot интенты.

**Минимальная правка (в `preparePlayback`, в уже существующей ветке
`prevBookId !== bId` рядом с очисткой cover):**

```js
if (prevBookId !== bId) {
  // …существующая очистка cover/preview…
  stopAll();                                   // selectedUnit, currentIuBlobUrl, subtitleText,
                                               // iuMissing, videoSrcUrl, currentVideoSceneKey,
                                               // pendingVideoTargetSec, videoEnded, игроки,
                                               // transition→IDLE
  pendingLoad = false;
  pendingExternalUnitId = null;
  needsContentRefresh = false;
  needsRotationResume = false;
  savedPlaybackPositionMs = 0;
  pendingSeekPositionMs = -1;
  isExecutingExternalSeek = false;
  pendingExplicitUnitTarget = false;
}
```

После этого `transition(selectedUnit ? 'SHOWING_STORYBOARD' : 'IDLE')` даст IDLE,
SCENE_READY книги B покажет cover/шторки (не картинку A), аудио A остановится.
Same-book ветка (soft re-prepare) не затрагивается — позиция/выбор сохраняются.

**Реализовано** (фикс + тесты): см. §4 P2-3 → DONE. Точка reset — начало ветки
`prevBookId !== bId` в `preparePlayback`; `stopAll()` владеет engine/display/video
полями, one-shots сбрасываются отдельно (не дублируется то, что stopAll уже чистит).
Regression tests: `playbackBookSwitch.test.ts` (TEST A–D, падают на до-фиксовом коде).

---

## 10. P2-4 — Investigation: «проскок» мимо конца юнита — видео остаётся скрытым (web)

Только исследование; код не менялся.

### 10.1 Где определяется переход A→B

Переход A→B определяется в `startIuCycling` (RAF-циклинг по **audio**
`currentTime`): позиция аудио отображается на индекс юнита (по `start_ms`
сервера, иначе cumulative `durationMs`), и при `idx !== sel.index` —
`selectedUnit = { ...sel, index: idx }` + `showIu` + `navigateTo`. Смена
`selectedUnit` НЕ трогает PlayerState, `currentVideoSceneKey`, `videoSrcUrl`
(видео-источник тот же — сцена не менялась). Раскрытие видео при unit-seek
делает `onVideoTimeUpdate` (reveal-гейт, аудио-мастер-таймлайн).

### 10.2 Точный код reveal-гейта (текущий)

```js
function onVideoTimeUpdate(): void {
  if (!videoSeekInFlight() || !videoEl || pendingVideoRevealSec() < 0) return;  // GUARD
  if (videoEl.readyState < 2) return;
  const withinUnit = posMs < unitEndMs(ius, selectedUnit.index);                // проскок → false
  if (playerState.name === 'SEEKING' && pos >= pendingVideoRevealSec()) {
    transition({ ...playerState, seekLanded: true });                          // P0-1: посадка по позиции
  }
  if (shouldRevealSeekVideo({ seekInFlight: videoSeekInFlight(), withinUnit, ... })) {
    transition(isPaused() ? 'VIDEO_READY' : 'PLAYING');                        // reveal
  }
}
```

### 10.3 Root cause

P0-1 ввёл «посадку» по позиции: пересечение гейта делает `seekLanded=true`
ОДИН раз. Guard `!videoSeekInFlight()` ( = `SEEKING && !seekLanded`) после этого
навсегда отсекает все последующие тики. Если в ЕДИНСТВЕННЫЙ тик, где позиция
впервые ≥ гейта, `withinUnit=false` (позиция уже за концом выбранного юнита), то:

- flip происходит (pos ≥ gate), reveal НЕ происходит (withinUnit false);
- состояние остаётся `SEEKING{landed:true}`; видео скрыто (videoHasFrame=false);
- все следующие тики: guard `!videoSeekInFlight()` → return. **Перманентный лок**
  до выхода из SEEKING (pause/resume/буфер/stop/новый seek/смена сцены).

**Это регрессия T2.2+P0-1.** До T2.2 (`7996b48`) `videoSeekInFlight` оставался true
до reveal, и каждый следующий `timeupdate` пере-оценивал условие: как только
`selectedUnit` переключался на B (или позиция оказывалась внутри юнита),
`withinUnit` становился true → reveal срабатывал. «Проскок» давал лишь ОТЛОЖЕННЫЙ
reveal. Одноразовая посадка (P0-1) + одноразовый guard (T2.2) превратили «пропусти
и повтори» в «пропусти и заблокируй».

### 10.4 Условие воспроизведения (точное)

Тик, где одновременно: `SEEKING && !seekLanded` (guard прошёл), `pos >= gate`
(→ flip), `pos >= unitEnd(selectedUnit.index на этот тик)` (→ withinUnit false).
Гейт = `min(target + 150ms, unitEnd − 40ms)`. Так как гейт ≤ unitEnd − 40, тик
может «перепрыгнуть» гейт уже за концом юнита, когда:

- **короткий юнит** (длительность < каденса timeupdate ~250ms + дрейф): первый
  тик ≥ гейта уже после unitEnd;
- **видео опережает аудио** (дрейф/рассинхрон посадки seek-а): video pos ≥
  unitEnd, а audio pos (и `selectedUnit`) ещё в старом юните — циклинг идёт по
  аудио и не успел переключиться на B;
- **замороженный selectedUnit** (isPaused: циклинг выходит на `if (isPaused) return`).

### 10.5 State timeline

**A→B при PLAYING (норма):** seek → SEEKING{landed:false}; pos ≥ gate в окне
[gate, unitEnd) → flip + withinUnit true → reveal ✓.

**A→B при PLAYING, короткий юнит / видео впереди аудио (баг):** первый тик ≥ gate
уже ≥ unitEnd(A), `selectedUnit` ещё A → flip + withinUnit false → NO reveal;
следующие тики: guard отсекает → **видео скрыто до конца сцены** (даже после того,
как циклинг переключил `selectedUnit` на B).

**A→B при PAUSED:** пауза до reveal дропает гейт (`pausePlayback` → PAUSED,
SEEKING не сохраняется) — лок невозможен по этому пути; resume → первый кадр.

**На границе (audioTime == unitEnd) и при audioTime > unitEnd на несколько мс:**
если гейт ещё вооружён и тик посадки застаёт pos ≥ unitEnd — тот же лок.

### 10.6 Web vs Android

Android: reveal выполняется в цикле `startIuCycling` (poll ~50 мс) — каждый тик
независимо пере-оценивает `shouldRevealSeekVideo(seekInFlight, revealGateMs,
posMs, unitEndMs)`. `seekLanded` там переключается callbacks-ами (STATE_READY
watchdog / onPositionDiscontinuity), НЕ позицией, и poll не имеет одноразового
guard-а: тик с `withinUnit=false` просто пропускается, следующий (через 50 мс,
после переключения selectedUnit) сработает. **Android самовосстанавливается; лок
невозможен.** Семантика `seekLanded` на Android — «запрос seek-а выполнен браузером»,
на web (после P0-1) — «позиция пересекла гейт». Различие guard-ов и есть причина:
web-обработчик событийный (timeupdate) и одноразовый, Android-цикл — постоянный.

### 10.7 Минимальная рекомендуемая правка — РЕАЛИЗОВАНА

В `onVideoTimeUpdate` guard заменён с одноразового на «состояние SEEKING»:

```js
// было:
if (!videoSeekInFlight() || !videoEl || pendingVideoRevealSec() < 0) return;
// стало:
if (playerState.name !== 'SEEKING' || !videoEl || pendingVideoRevealSec() < 0) return;
```

Посадка (P0-1) осталась идемпотентной (`{...playerState, seekLanded:true}`),
AND-гейт по-прежнему требует `!seekInFlight` + `withinUnit` + `hasFrame`. Тик с
`withinUnit=false` не раскрывает, а следующий тик (selectedUnit уже B / позиция
внутри юнита) раскрывает: восстановлено самовосстановление из до-T2.2 и паритет
с Android-циклом. **Инвариант подтверждён** (проверка перед фиксом): SEEKING +
посадка + кадр + гейт + withinUnit ⇒ reveal на ближайшем тике; при
`withinUnit=false` — без reveal; в PAUSED guard отсекает (состояние не SEEKING).

**Регрессионный тест (реализован):** `playbackRevealOvershoot.test.ts` — см. §4
P2-4 → DONE (5 кейсов; кейс «overshoot → reveal после смены selectedUnit» падает
на до-фиксовом коде).

## 11. Integration Audit — post P2-4

Контрольная точка после цепочки фиксов **P0-1 → P1-1 → P1-2 → P2-1 → P2-3 →
P2-4** (web; Android-код в этом шаге не менялся, участвует только как эталон
контракта). Цель — убедиться, что последовательные исправления не создали
новый конфликт в цепочке
`audio position → selectedUnit → external seek → SEEKING → video seek → seekLanded
→ onVideoTimeUpdate → reveal gate → VIDEO_READY / PLAYING`.

Метод: перечитаны текущие (после всех фиксов) реализации `preparePlayback`
(P2-3), `executePendingSeek`/`checkPendingExternalSeek`, `handleChunk`,
`seekAttachedVideo`/`playVideoOverlay`/`attachVideo`/`detachVideo` (P1-2),
`pausePlayback`/`resumePlayback`/`pauseIfPlaying` (P1-1), `stopAll`,
`onVideoTimeUpdate` (P0-1+P2-4), `enterVideoBuffering`/`resumeFromBuffering`,
`setLayerVideo`, `updateLayers`, рендер PlayPage; Android-параллель по
`PlayFragment.kt` (poll-цикл startIuCycling, pause/resume, stopAll keepSurface).
Код не менялся.

### 11.1 Состояние цепочки фиксов

| Фикс | Что закрыл | Статус на момент аудита |
|---|---|---|
| P0-1 | одноразовая посадка `seekLanded` в `onVideoTimeUpdate` (дедлок reveal-гейта) | закрыт |
| P1-1 | `pauseIfPlaying` silent-ветка писала `phase=PLAYING` при `PAUSED` | закрыт |
| P1-2 | единый слот `pendingMetaListener` (stale loadedmetadata) | закрыт |
| P2-1 | удалён `enginePaused` (write-only) | закрыт |
| P2-3 | смена книги — `stopAll()` + очистка one-shots в `preparePlayback` | закрыт |
| P2-4 | overshoot-лок: guard `!videoSeekInFlight()` → `playerState.name !== 'SEEKING'` | закрыт |

### 11.2 Сценарии

Легенда ожидаемых значений: `PS` — playerState, `SU` — selectedUnit, `VV` —
videoVisible, `VK` — currentVideoSceneKey, `PT` — pendingVideoTargetSec,
`SL` — seekLanded.

| # | Сценарий | Ожидаемое | Факт | Вердикт |
|---|---|---|---|---|
| 1 | PLAYING, A→B (Navigator) | PS=PLAYING; SU=B; VV=true; VK=та же сцена; PT=target/1000 (живёт до resume — безвредно); SL=true | handleChunk: SU=B → `seekAttachedVideo` (та же сцена, без re-src) → SEEKING{gateB} → тик: посадка + withinUnit → PLAYING + updateLayers. showIu(B) синхронно в том же таске — старая картинка A не мелькает. | ✅ PASS |
| 2 | PAUSED, A→B | PS=VIDEO_READY (reveal в paused) либо SEEKING{paused:true} до reveal; VV=true после reveal | `pendingLoad`-ветка сохраняет гейт (`{...SEEKING, paused:true}`); seek завершается и во время паузы шлёт timeupdate → посадка + withinUnit → VIDEO_READY; на resume — то же. | ✅ PASS |
| 3 | PLAYING, A→B→C быстро, до metadata | финальный таргет C; stale B не применяется | P1-2: перед `src=C` старый onMetaB снят (единый слот), регистрируется onMetaC; новый src абортит загрузку B — metadata C применяет только target C. FIFO + «новейший — последний». | ✅ PASS |
| 4 | PLAYING, A→B→A быстро | финальный таргет A | та же сцена: каждый тап перевооружает SEEKING свежим payload-ом (transition целиком заменяет); между сценами — P1-2 слот. | ✅ PASS |
| 5 | SEEKING, A→B в момент незавершённого seek | старый seek не влияет на B | `checkPendingExternalSeek` → `stopAll()` (SEEKING→IDLE, PT=-1) → новый executePendingSeek вооружает свежий SEEKING{landed:false}. Старые timeupdate перечитывают ТЕКУЩИЙ playerState (новый гейт); старый onMeta снят (P1-2) либо не существует (та же сцена). | ✅ PASS |
| 6 | Unit-end overshoot (гейт пересечён после unitEnd) | без лока; reveal на первом тике с withinUnit=true | P2-4: каждый тик пере-оценивает AND-гейт; посадка идемпотентна. | ✅ PASS |
| 7 | Video OFF → seek → playback → ON | без лишнего seek; видео синхронизируется | layer off: handleChunk пропускает ensureSceneVideo (нет SEEKING, SHOWING_STORYBOARD); ON mid-scene: attached → re-show (seek только при |diff|>0.5); не attached → `ensureSceneVideo(key, null)` → audio-sync, reveal по loadeddata. Инвариант F соблюдён. | ✅ PASS |
| 8 | Video OFF во время SEEKING | скрыто (сториборд) до reveal; self-heal после ON | OFF: updateLayers прячет, SEEKING живёт (правильно — сториборд юнита поверх). ON: attached-ветка, re-align к аудио (дифф) → timeupdate: посадка + withinUnit → PLAYING. Теоретический угол «re-align к ещё не севшему аудио» недостижим — аудио локальный blob, seek мгновенный. | ✅ PASS |
| 9 | **Pause во время SEEKING → resume** | **PS=PLAYING/VIDEO_READY, VV=true** | **см. §11.3 — НАЙДЕН БАГ** | ❌ **FAIL (P1)** |
| 10 | Book switch во время SEEKING | без переноса состояния A | P2-3: `stopAll()` (SEEKING→IDLE, аудио A released, src снят, pendingMetaListener очищен) + one-shots; deferred seek из A обнуляется, если сцены нет в очереди B; stale fetch отбрасывается по sceneEpoch. | ✅ PASS |

Итог: **9 PASS / 1 FAIL**. Дополнительный вариант FAIL (тот же класс, другой вход) —
буферный гейт во время SEEKING, см. §11.3.2.

### 11.3 НОВАЯ ПРОБЛЕМА (P1) — SEEKING не «липкий»: пауза или буфер-гейт во время seek — РЕАЛИЗОВАНА (sticky SEEKING)

#### 11.3.1 Точный сценарий (web)

1. PLAYING, юнит B по Navigator → SEEKING{landed:false, paused:false}, видео
   seeked к B, сториборд B поверх, VV=false (корректно).
2. **Пауза до посадки** (тап паузы / `pauseIfPlaying` при tab-hide — на медленной
   сети окно seek = Range-fetch = сотни мс — реально):
   `pausePlayback()` L515: `transition(videoHasFrame() ? 'VIDEO_READY' : 'PAUSED')`
   → `videoHasFrame()` во время SEEKING = false → **PAUSED, payload гейта УНИЧТОЖЕН**.
3. Resume: `resumePlayback()` → не SEEKING → `SHOWING_STORYBOARD`; видео seeked к
   `pendingVideoTargetSec` и играет **скрытым**.
4. Путей reveal больше нет:
   - `onVideoTimeUpdate` L1692: guard `playerState.name !== 'SEEKING'` → return
     (состояние SHOWING_STORYBOARD);
   - `loadeddata` уже сработал для этого src (same-scene seek не пере-присваивает
     src → `onVideoFirstFrame` не придёт);
   - `updateLayers` не вызывается ни в pause, ни в resume;
   - буфер-гейт: `enterVideoBuffering` тоже пишет PAUSED (см. 11.3.2),
     `resumeFromBuffering` → SHOWING_STORYBOARD.

**Итог: видео навсегда скрыто** — аудио играет, сториборды циклится по юнитам,
кнопка/фаза = PLAYING, видео нет. Разблокировка только новым unit-seek (новый
SEEKING) или сменой сцены (loadeddata). Симптом тот же, что у P2-4.

#### 11.3.2 Буфер-гейт во время SEEKING (тот же класс)

`enterVideoBuffering` L1836: `transition(videoHasFrame() ? 'VIDEO_READY' : 'PAUSED')`
→ во время SEEKING тот же сброс payload; `resumeFromBuffering` → SHOWING_STORYBOARD
+ play. Видео скрыто до следующего seek/сцены. Вход: медленный Range-fetch после
unit-seek (штатный сценарий на медленных сетях — гейт как раз для этого и есть).

#### 11.3.3 Web vs Android

Android имеет ТУ ЖЕ семантику переходов (pausePlayback: `if (videoReadyToShow)
VideoReady else Paused` — гейт сбрасывается; resume → ShowingStoryboard), но
практически недостижим: ExoPlayer-seek по локальному merged-файлу мгновенный, а
reveal-проверка живёт в 50ms poll-цикле startIuCycling — посадка и reveal
происходят раньше, чем человеческий тап/переключение таба успевают попасть в
окно. Web: видео — 43MB прогрессивный стрим, seek = Range-fetch (сотни мс),
reveal — только по timeupdate (каденс ~250ms) → окно реальное. Расхождение
платформ: **семантически одинаковые переходы, но разная достижимость**.

#### 11.3.4 Минимальная рекомендуемая правка — РЕАЛИЗОВАНА (Вариант 1, sticky SEEKING)

**Root cause:** `pausePlayback` (L515) и `enterVideoBuffering` (L1836) писали
`transition(videoHasFrame() ? 'VIDEO_READY' : 'PAUSED')` — во время SEEKING
payload гейта (`revealGateSec`/`seekLanded`) уничтожался, resume уходил в
`SHOWING_STORYBOARD` без путей reveal (timeupdate-guard отсекает не-SEEKING,
`loadeddata` для same-scene seek уже сработал).

**Sticky SEEKING semantics:** пока гейт вооружён, пауза и буфер-гейт НЕ выводят
из SEEKING — только маркируют паузу:

```js
// pausePlayback / enterVideoBuffering (вход из SEEKING):
transition(playerState.name === 'SEEKING' ? { ...playerState, paused: true }
  : videoHasFrame() ? 'VIDEO_READY' : 'PAUSED');
// resumeFromBuffering (выход из буфер-гейта, вход из SEEKING):
transition(playerState.name === 'SEEKING' ? { ...playerState, paused: false }
  : videoHasFrame() ? 'PLAYING' : 'SHOWING_STORYBOARD');
```

- **Pause path:** SEEKING → SEEKING{paused:true}; resumePlayback уже был sticky
  (SEEKING → SEEKING{paused:false}) — правок не потребовал. Завершившийся seek
  шлёт timeupdate даже при паузе → посадка + reveal (VIDEO_READY) по контракту.
- **Buffering path:** SEEKING → буфер → SEEKING{paused:true} (вход) →
  SEEKING{paused:false} (выход, `resumeFromBuffering` адаптирован — иначе выход
  снова ронял payload в SHOWING_STORYBOARD).
- **Без новых seek:** resume не пере-сикает видео, уже стоящее на target
  (re-apply `pendingVideoTargetSec` — no-op при равенстве).
- **P2-4 остаётся рабочим:** guard `playerState.name !== 'SEEKING'` и AND-гейт
  не тронуты; overshoot-кейсы (включая переписанный кейс 5 — теперь он
  проверяет sticky-контракт вместо старого сброса) зелёные.

**Регрессионные тесты (реализованы):** `playbackStickySeeking.test.ts` — TEST A
(pause до посадки → SEEKING{paused:true} → resume → reveal PLAYING), TEST B
(paused seek → resume без SHOWING_STORYBOARD; paused-reveal → VIDEO_READY),
TEST C (буфер-гейт во время SEEKING → гейт жив на входе и выходе → reveal
PLAYING), TEST D (обычный PAUSED без изменений, негатив), TEST E (нет второго
seek после resume). Валидация: A/C/E падают на до-фиксовом коде; B/D —
контрактные гварды.

Вариант 2 (самовосстановление в `onVideoTimeUpdate` для не-SEEKING с
`readyState >= 2`) остаётся belt-and-suspenders на будущее — не реализован.

### 11.4 Инварианты

| Инвариант | Вердикт | Комментарий |
|---|---|---|
| A. PS != SEEKING ⇒ onVideoTimeUpdate не делает seek-reveal работу | ✅ | guard L1692 работает как задумано — НО именно он оставляет сценарий §11.3 без пути восстановления (корень проблемы) |
| B. SEEKING + landed + кадр + гейт + withinUnit ⇒ reveal на подходящем timeupdate | ✅ | P2-4, тесты 28/28 |
| C. withinUnit=false не раскрывает | ✅ | негативный тест P2-4 |
| D. Book switch не переносит состояние старой книги | ✅ | P2-3, тесты 23/23 до 28/28 |
| E. Unit switch не переносит stale pending seek | ✅ | свежий payload каждый seek; P2-3 TEST C |
| F. Video toggle OFF/ON не создаёт лишний seek | ✅ | re-show ветка, re-align только при |diff|>0.5 |
| G. detach/stopAll — старые metadata-листенеры не влияют | ✅ | P1-2, тесты 19/19 до 28/28 |

### 11.5 Найденные новые проблемы

| Severity | Проблема | Точка | Статус |
|---|---|---|---|
| **P1** | SEEKING не «липкий»: `pausePlayback`/`enterVideoBuffering` во время seek уничтожают payload гейта → видео навсегда скрыто (web; Android недостижимо практически) | playbackStore L515, L1836, L1874 | **закрыт** — §11.3 (sticky SEEKING, тесты 33/33) |
| P2 | `pendingVideoTargetSec` живёт после reveal до следующего `resumePlayback` (лишний re-seek к той же позиции — фактически no-op) | seekAttachedVideo/playVideoOverlay | открыт (косметика) |
| P2 | Unit-tap в ту же сцену перекачивает scene-ассеты заново (fetchSceneData после clearPreloadCache в executePendingSeek) — аудио/IU из Cache API, но повторный roundtrip | executePendingSeek | открыт (перф) |

### 11.6 Окончательно закрыто (этой цепочкой)

P0-1 (дедлок reveal), P1-1 (PAUSED+PLAYING), P1-2 (stale metadata), P2-1
(enginePaused), P2-3 (смена книги), P2-4 (overshoot-лок).

### 11.7 Рекомендации по приоритету

- **P1 — ✅ DONE**: sticky SEEKING (§11.3.4) — `pausePlayback`/
  `enterVideoBuffering` сохраняют payload (`{...SEEKING, paused:true}`),
  `resumeFromBuffering` возвращает в SEEKING{paused:false}; тесты
  `playbackStickySeeking.test.ts` (TEST A–E); весь набор 33/33;
- **P2 — ✅ DONE**: cleanup `pendingVideoTargetSec` при reveal — см. §12 (тесты 38/38);
- **P2**: (по желанию) same-scene unit-tap без полного clearPreloadCache.

## 12. P2 — Investigation: `pendingVideoTargetSec` после успешного reveal

### 12.1 Где устанавливается (3 места + объявление)

| Место | Строка | Что делает |
|---|---|---|
| объявление | L187 | `let pendingVideoTargetSec = -1;` (initial = «нет target») |
| `seekAttachedVideo` | L1527 | `explicitSeekMs != null ? explicitSeekMs/1000 : -1` — same-scene unit-seek |
| `playVideoOverlay` | L1597 | та же формула — fresh-src unit-seek / rotation-resume |
| `stopAll` | L1924 | сброс в `-1` (полный стоп) |

### 12.2 Где читается (2 места)

| Место | Строка | Что делает |
|---|---|---|
| `resumePlayback` | L551–553 | если `>= 0`: `videoEl.currentTime = target`, затем **потребляет** (`= -1`) |
| `attachVideo` | L831–842 | если `>= 0`: `el.currentTime = target` + пере-вооружение SEEKING с гейтом от target (L842) |

Больше нигде не читается — включая `onVideoTimeUpdate` (reveal) и
`onVideoFirstFrame`: после арма SEEKING reveal-логика живёт только на payload
(`revealGateSec`/`seekLanded`), target сам по себе не нужен.

### 12.3 Что происходит в момент успешного reveal

`onVideoTimeUpdate` (L1735–1740): `shouldRevealSeekVideo(...)` →
`transition(isPaused() ? 'VIDEO_READY' : 'PLAYING'); updateLayers();` —
**target НЕ сбрасывается**. Reveal требует `pos >= гейт`, гейт = target +
tolerance (кламп к unitEnd) ⇒ в момент reveal видео уже за пределами target —
позиция достигнута.

### 12.4 Нужен ли после reveal — НЕТ (stale state)

- **`resumePlayback`**: применяет target к видео, чтобы до-сикнуть его на
  не достигнутую ещё позицию (аудио right-after-seek может быть 0). После
  reveal видео уже позиционировано внутри юнита и могло уйти ВПЕРЁД → re-apply
  stale target = **реальный seek НАЗАД к началу юнита** (повтор фрагмента),
  а не no-op (уточнение к §12.4). Потребление происходит только при следующем
  resume — между reveal и ним target висит `>= 0` как stale.
- **`attachVideo`** (unmount/remount PlayPage после reveal): target `>= 0` →
  повторное позиционирование + **пере-вооружение SEEKING{landed:false}** (L842)
  → лишний gate-цикл (времяпдате снова посадит и раскроет). Не баг (self-heal),
  но лишняя работа + повторный скрытый-видео интервал.
- Reveal-логика target не использует (гейт — в payload). Других читателей нет.

### 12.5 Sticky-сценарий (SEEKING → pause → resume → reveal)

- pause (sticky): target не трогается — живёт. Это **нужно**: если seek ещё не
  посадился, `resumePlayback` применяет target (реальная работа — до-сик
  видео к целевому юниту, не no-op).
- resume: `resumePlayback` сам потребляет target (L553 → `-1`) **до** reveal.
  ⇒ cleanup при reveal этот сценарий не заденет (target уже `-1`).

### 12.6 Вывод и рекомендуемая точка cleanup — РЕАЛИЗОВАНО

**Stale после успешного reveal подтверждено** (прямой PLAYING-режим: seek →
reveal без resume между; в sticky-сценарии target уже потреблён resume до
reveal). Cleanup внесён в единственное место успешного reveal —
`onVideoTimeUpdate`, внутри reveal-ветки (одна строка):

```js
if (shouldRevealSeekVideo({ ... })) {
  // REVEAL — SEEKING → VIDEO_READY / PLAYING (position inside the unit).
  pendingVideoTargetSec = -1; // P2: target reached — no longer needed
  transition(isPaused() ? 'VIDEO_READY' : 'PLAYING');
  updateLayers();
}
```

Эффект: `resumePlayback` после reveal пропускает stale re-apply (нет seek назад
к началу юнита), `attachVideo` после reveal идёт в else-ветку (синк к аудио —
аудио уже на target, корректно) и не пере-вооружает SEEKING без необходимости.
State machine, гейт, sticky-семантика, seek-логика не меняются. Добавлен
read-only accessor `getPendingVideoTargetSec()` (для тестов/UI).

**Регрессионные тесты (реализованы):** `playbackTargetCleanup.test.ts` — TEST A
(direct seek → reveal → target -1), TEST B (seek → pause → resume → reveal:
target жив до потребления resume, -1 после reveal), TEST C (attachVideo после
reveal не пере-вооружает SEEKING), TEST D (resumePlayback после reveal не
пере-сикает видео назад — позиция сохраняется), плюс кейс «обычный playback
без seek — target никогда не вооружается». Валидация: A/C/D падают без
cleanup-строки; B и plain — контрактные гварды.
