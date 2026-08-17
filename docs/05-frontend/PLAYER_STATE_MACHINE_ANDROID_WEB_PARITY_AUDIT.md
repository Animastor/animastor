# Android/Web Player Parity Audit

Статус: 📝 Audit (код НЕ менялся).
Дата: после серии web-фиксов P0-1/P1-1/P1-2/P2-1/P2-3/P2-4/P1-sticky/P2-target.
Метод: сравнение семантики по текущему коду обеих платформ
(`playbackStore.ts` / `PlayFragment.kt` + `PlaybackViewModel.kt`), плюс сверка со
старыми Android-коммитами 83f7d1a (unit-switch reveal при паузе), 58680f2
(AND-frame gate T2.1/T3.1/T5), d52dc2d (unit-bounded gate), 413a841 (единая
аудио-шкала). Архитектурное различие НЕ считается багом — важен наблюдаемый
контракт.

Архитектуры:
- **Web:** `playbackStore` / `PlayerState` / `transition()` / `timeupdate` /
  `loadedmetadata` / буфер-гейт по `waiting`.
- **Android:** `PlayFragment` / `PlaybackViewModel` / единый ExoPlayer
  (MergingMediaSource: аудио+видео в одной шкале — не могут разойтись) /
  `STATE_READY`/`STATE_BUFFERING` / 50ms poll `startIuCycling` / generation-
  гварды (`videoPlayerGeneration`, `videoCurrentGen`, `pendingRevealGen`).

---

## 1. Сценарии

| # | SCENARIO | WEB BEHAVIOR | ANDROID BEHAVIOR | EQUIV? | ARCHITECTURAL DIFFERENCE | REAL RISK? |
|---|---|---|---|---|---|---|
| 1 | Unit A → B во время PLAYING | seekToPosition → checkPendingExternalSeek → stopAll → executePendingSeek → handleChunk: selectedUnit=B, showIu(B), seekAttachedVideo → SEEKING{landed:false, paused:true} (pendingLoad), phase PAUSED → Play → reveal по гейту | Navigator tap → pendingExternalSeek → stopAll(keepSurface=true) (сохраняет сцену+гейт) → handleChunk: selectedUnit=B, showIuImage(B) → pendingLoad: Paused → targetScene sameScene: seekTo(startPosMs) + Seeking{landed:false, paused:true} → Play → poll reveal по гейту | **YES** | Web: stopAll→IDLE + пере-арм SEEKING{landed:false} в seekAttachedVideo. Android: keepSurface-stopAll сохраняет гейт {landed:true}, targetScene пере-вооружает {landed:false}. Оба требуют Play после тапа (positioned-paused) | нет |
| 2 | Unit A → B во время PAUSED | positioned-paused: SEEKING{paused:true} → reveal в paused (времяпдате от завершённого seek) → VIDEO_READY | positioned-paused: Seeking{paused:true} → poll-проверка reveal ДО isPaused-гейта → VideoReady (коммит 83f7d1a) | **YES** | Web: reveal по timeupdate (fires на seek при паузе). Android: 50ms poll независимо от паузы | нет |
| 3 | SEEKING → PAUSE → RESUME → REVEAL | **sticky**: pausePlayback → SEEKING{paused:true} (payload жив) → resume → SEEKING{paused:false} → reveal по гейту | pausePlayback → `Paused` (payload сброшен) → resume → `ShowingStoryboard`; запасной путь: STATE_READY (`currentPlayerHasVideo && !Seeking` → Playing/VideoReady) | **NO** (наблюдаемо эквивалентно в достижимых случаях) | Web sticky — фикс P1. Android НЕ sticky в pausePlayback; seek локальный/мгновенный + 50ms poll раскрывают раньше человеческого тапа; при буферинге READY-reveal спасает | низкий (теоретический лок — только машинный тап/автопауза в окне seek на медленной сети, см. §3) |
| 4 | SEEKING → BUFFERING → RESUME → REVEAL | sticky на входе/выходе буфер-гейта: SEEKING{paused:true} → SEEKING{paused:false} → reveal по гейту (target+tolerance) | STATE_BUFFERING → `transition(Paused)` (гейт сброшен) + enterBuffering; STATE_READY → `!Seeking` → Playing/VideoReady + exitBuffering — reveal по **готовности кадра** на seek-таргете | **YES** | Android не хранит гейт в буфер-гейте, но READY-reveal для не-SEEKING — запасной путь, которого у web не было (поэтому web и потребовался sticky). Кадр на Android может раскрыться чуть раньше (на target, а не target+tolerance) — это начало юнита B, не хвост A | низкий (только точность первого кадра, P2) |
| 5 | SEEKING → overshoot unitEnd → следующий юнит → REVEAL | P2-4: каждый тик пере-оценивает AND-гейт; overshoot-тик не раскрывает, reveal при withinUnit=true | 50ms poll + `pos < unitEndMs` (belt-and-suspenders) в shouldRevealSeekVideo — никогда не имел одноразового guard-а, лоk невозможен | **YES** | Web фиксил то, чего у Android не было (poll без одноразового flip) | нет |
| 6 | Book A → Book B во время PLAYING | P2-3: preparePlayback prevBookId≠bId → stopAll() + one-shots; stale image/audio не переживают | MainActivity: fragment.stopAll() (→Idle, все поля чисты) + VM.preparePlayback; дополнительно observeState PLAYING→SCENE_READY → stopAll(); deferred seek из A dropped если не в очереди B | **YES** | Web: stopAll внутри preparePlayback. Android: stopAll в координаторе/коллекторе + preparePlayback | нет |
| 7 | Book A → Book B во время SEEKING | P2-3: stopAll → IDLE (гейт сброшен); stale seek не выполняется против B | fragment.stopAll() → Idle (гейт сброшен); VM.preparePlayback: pendingExternalSeek dropped если не в новой очереди | **YES** | тот же split координатор/коллектор | нет |
| 8a | Video OFF → ON во время PLAYING | OFF: updateLayers (скрыто, аудио+сториборды идут). ON: attached → re-show (re-align только при \|diff\|>0.5); не attached → ensureSceneVideo(key,null) audio-sync | OFF: updateLayers (поверх сториборда, surface жив). ON: источник уже с видео → только updateLayers (re-show); audio-only → targetScene(af, currentPosition, includeVideo=true) — rebuild на **актуальной позиции аудио** | **YES** | Web: display:none элемент + diff-реалигн. Android: единый merged источник физически не дрейфует — rebuild с той же позицией | нет |
| 8b | Video OFF → ON во время SEEKING | гейт живёт скрытым; ON: re-align → времяпдате до гейта → reveal (paused — после resume) | OFF: updateLayers скрывает, SEEKING не трогается. ON: источник с видео → re-show (reveal по гейту в poll); audio-only → targetScene(cur) → fresh Seeking{landed:true} → reveal по гейту | **YES** | та же пара re-show/rebuild | нет (теоретический угол re-align к не севшему аудио недостижим — аудио локальное) |
| 9 | После reveal: stale seek target не воскресает; attach не пере-армливает | P2-cleanup: `pendingVideoTargetSec = -1` при reveal; attachVideo → else-ветка (синк к аудио, без SEEKING) | отдельного target-поля нет: seek-таргет применяется сразу (seekTo / setMediaSources(startPosMs)), гейт живёт в PlayerState.Seeking и исчезает с reveal; rotation/return re-gate только через revealVideoAfterReturn (videoReadyToShow) — осознанный re-gate поверхности, не stale target | **YES** | Поле, которое чинил web-фикс, на Android не существует | нет |
| 10 | Старые callbacks/listeners после нового unit | P1-2: единый слот pendingMetaListener; timeupdate перечитывает текущий playerState; payload SEEKING заменяется целиком | единый ExoPlayer + один Listener на всю жизнь; stale-защита: `videoPlayerGeneration++` (targetScene/stopAll), `videoCurrentGen`, `pendingRevealGen`, onPlayerError гвард «stale (previous item)», onRenderedFirstFrame gen-guarded, onPositionDiscontinuity пишет в текущий playerState | **YES** | Android сильнее: generation-гварды вместо единого слота | нет |

Итог по сценариям: **9 YES / 1 NO-intentional** (сценарий 3 — см. §3).

---

## 2. Web-фиксы → Android-механизм

| WEB FIX | ANDROID CURRENT MECHANISM | PARITY STATUS |
|---|---|---|
| **P1-2** loadedmetadata listener lifecycle (единый слот) | единый `Player.Listener`, навешивается один раз в createVideoPlayer; stale отсекаются generation-гвардами (`videoCurrentGen != videoPlayerGeneration`) | **EQUIVALENT** (пере-регистрация на каждый src на Android не существует архитектурно) |
| **P2-1** enginePaused removal (write-only) | на Android поля `enginePaused` нет; источник истины — `PlaybackViewModel.uiState.phase` (+ `playerState` фрагмента) | **EQUIVALENT** (N/A — поля не было) |
| **P2-3** book-switch reset | MainActivity: `fragment.stopAll()` при смене книги + VM.preparePlayback (deferred seek dropped если не в очереди) + observeState PLAYING→SCENE_READY → stopAll() | **EQUIVALENT** (механизм: координатор + фрагмент-коллектор, вместо stopAll внутри preparePlayback) |
| **P2-4** overshoot recovery (guard → `!= SEEKING`) | 50ms poll без одноразового guard-а + `pos < unitEndMs` — лоk невозможен с самого начала | **EQUIVALENT** (уже было; web догонял) |
| **P1** sticky SEEKING (pause/buffer сохраняют payload) | pausePlayback → `Paused` (НЕ sticky); буфер-гейт → `Paused`; запасной путь — READY-reveal для не-SEEKING; keepSurface-stopAll сохраняет гейт {seekLanded:true} | **INTENTIONAL DIFFERENCE** (см. §3) |
| **P2** pendingVideoTargetSec cleanup | поля не существует: target применяется сразу в targetScene, гейт живёт в PlayerState.Seeking и умирает с reveal | **EQUIVALENT** (N/A — проблема невозможна) |

Итог по фиксам: **5 EQUIVALENT / 1 INTENTIONAL**.

---

## 3. Единственное реальное расхождение: pause во время незавершённого seek

| | Web | Android |
|---|---|---|
| pause во время SEEKING | `SEEKING{paused:true}` (sticky — гейт жив, reveal после resume по гейту) | `Paused` (гейт сброшен); resume → `ShowingStoryboard` |
| почему так | фикс P1: иначе resume уходил в SHOWING_STORYBOARD без пути reveal (timeupdate-guard + loadeddata уже сработал) | seek по локальному merged-файлу мгновенный, 50ms poll раскрывает в течение 50–100 мс — раньше человеческого тапа; при незавершённом seek на медленной сети STATE_BUFFERING→READY даёт READY-reveal |
| наблюдаемый контракт | reveal после resume всегда | reveal после resume в практически достижимых случаях; **теоретический лок**: seek уже READY + пауза в окне 50–100 мс после тапа (машинный тап/автопауза при переключении таба точно в окне) — poll без гейта не раскроет, STATE_READY не пере-сработает (уже READY) |

**Вывод:** расхождение **intentional** (Web — осознанный фикс, Android — другая
архитектура, где проблема практически недостижима). НЕ менять Android.
Зафиксировано как Known intentional difference в T4 manual plan.

---

## 4. Итоги

### Полностью parity (equivalent)
Сценарии 1, 2, 5, 6, 7, 8a, 8b, 9, 10 и фиксы P1-2, P2-1, P2-3, P2-4,
P2-target: наблюдаемое поведение совпадает, механизмы разные (архитектурно).

### Intentional differences
1. **Pause во время seek** (сценарий 3): Web sticky SEEKING{paused:true} vs
   Android Paused — осознанно, практически недостижимо на Android.
2. **Буфер-гейт во время seek** (сценарий 4): Web сохраняет гейт; Android
   сбрасывает, но READY-reveal раскрывает по готовности на seek-таргете.

### Реальные gaps
Нет критичных. Два низкоприоритетных риска (оба P2, оба на Android, оба
практически не проявляются):
- **R1 (P2):** reveal после буфер-гейта во время seek может показать кадр на
  seek-таргете (target), а не на гейте (target+tolerance) — начало юнита B,
  не хвост A. Наблюдаемо только при замедлении сети точно в окне seek.
- **R2 (P2):** теоретический stuck после pause-during-seek при уже-READY
  игроке (см. §3) — требует машинного тапа/автопаузы в окне 50–100 мс.

### Потенциальные bugs
Формально — 0. Оба пункта выше — риски, не воспроизведённые баги; на web
соответствующие классы уже закрыты фиксами P1/P2-4.

### Приоритет gap-ов
- R1: P2 (не менять — Android merge-архитектура делает это неважным).
- R2: P2 (не менять — недостижимо практически; если когда-нибудь понадобится
  полный паритет — sticky-переход в Android `pausePlayback()`).

### Что НЕ надо менять
- Android: НЕ вводить sticky SEEKING в `pausePlayback()` (R2 не стоит
  изменения ради теоретического случая); НЕ добавлять
  `pendingVideoTargetSec`-аналог; НЕ переделывать буфер-гейт.
- Web: НЕ переделывать reveal под Android-поллинг; текущая связка
  timeupdate + AND-гейт + sticky — контракт.
- Обе платформы: НЕ унифицировать механизмы reveal (poll vs timeupdate) —
  это архитектурное различие, не баг.
