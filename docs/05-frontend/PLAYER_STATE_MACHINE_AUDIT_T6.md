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

### P2-3. Web: `preparePlayback` не чистит `selectedUnit`/`currentIuBlobUrl` при смене книги

При открытии книги B поверх играющей A `selectedUnit` (и blob-URL картинок A,
которые `clearPreloadCache` считает «живыми») переживают `preparePlayback` →
`SHOWING_STORYBOARD` с картинкой старой книги на экране SCENE_READY. Android
очищается через `stopAll()` при переходе PLAYING→SCENE_READY (collector L578).
На web такого collector-эквивалента нет — проверить в T4 (возможен «чужой» кадр при
переключении книги).

### P2-4. Web: «проскок» мимо конца юнита — видео остаётся скрытым

Если между `timeupdate`-событиями позиция перескочила за конец выбранного юнита,
`withinUnit=false` → reveal не срабатывает, гейт остаётся вооружённым (SEEKING), и
видео скрыто до смены состояния. Комментарий в коде прямо говорит, что в этом случае
показ кадра следующего юнита **корректен** (сториборд уже переключился), но код этого
не делает. Пред-существующее поведение (не регрессия T6/T2.2), но противоречит
собственному комментарию.

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
- **P2-4:** reveal при «проскоке» за конец юнита — раскрывать (позиция ≥ гейта,
  даже если `withinUnit=false`), приведя код в соответствие с собственным комментарием.
- **P2-1 (DONE):** `enginePaused` удалён как write-only legacy mirror (объявление +
  7 записей); тест P1-1 проверяет `getPlayerState()==PAUSED` + `phase==PAUSED`.
  Полный список write/read sites — в §4.
- **P2-2:** Android `handleSilentChunk` — убрать дубль `transition(ShowingStoryboard)`.
- **P2-3:** web `preparePlayback` при смене книги — чистить `selectedUnit`/
  `currentIuBlobUrl` (сверка с Android-поведением; проверить в T4).
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
