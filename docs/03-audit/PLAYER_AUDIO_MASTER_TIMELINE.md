# Аудит плеера: единая аудио-шкала и reveal-гейт (n−1)

Дата: 17 августа 2026
Базовые коммиты: `413a841` (единая аудио-шкала), `7b58152` (unitId вместо индекса)
Платформы: Android (`PlayFragment.kt` / `PlaybackViewModel.kt`), Web (`frontends/app/src/state/playbackStore.ts`)

---

## Резюме

Последний рефактор — правильное архитектурное направление. Player живёт на audio master
timeline (`start_ms`), storyboard принадлежит выбранному юниту, видео — подчинённая
визуализация (`follower`), которая раскрывается только после того, как позиция реально
оказалась внутри выбранного юнита (reveal-гейт по позиции). LTX-specific выравнивание
(`video_start_ms`) корректно вынесено в backend/video profile/assembly.

Аудит подтвердил контракт:

```
AUDIO → MASTER TIMELINE → STORYBOARD (selected IU) + VIDEO (follower) → PLAYER

LTX chunks → 8N+1 correction → normalized video → Player / Final Export
```

При этом найдено несколько мест, которые стоит проверить / закрепить.

---

## 🟢 Что выглядит хорошо (подтверждено кодом)

1. **Audio master timeline.** `unitStartMs()` на обеих платформах читает только `start_ms`
   (Android: `PlayFragment.kt:810-818`; Web: `playbackStore.ts:1154-1160`). `video_start_ms`
   полностью убран из Player.
2. **unitId вместо индексов Navigator.** Разрешение цели по ID против storyboard-последовательности:
   `resolveUnitIndexForSequence` (Android: `PlaybackViewModel.kt:753-760`; Web:
   `playbackStore.ts:1166-1173`). Index остаётся только fallback'ом.
3. **Storyboard selected unit как transition overlay.** `showIuImage(iuSequence[seekToUnit])`
   до `targetScene` (Android: `PlayFragment.kt:756`; Web: `playbackStore.ts:1096-1103`).
4. **Видео раскрывается после seek, а не сразу после назначения source.** Гейт по позиции
   `startPosMs + tolerance`: Android `PlayFragment.kt:1076-1082`, Web `onVideoTimeUpdate`
   `playbackStore.ts:1556-1564`.
5. **`video_start_ms` вынесен из Player.** Frontends его больше не потребляют (модели чистые);
   backend продолжает считать best-effort (`backend/src/video/video-timeline.js:229,294`;
   `generation-routes.cjs:885-894`) для Final Assembly. Разделение верное.
6. **Cold-start закрыт.** `pendingExternalSeek` откладывается до готовности очереди
   (Android: `PlaybackViewModel.kt:300-311, 685-745`; Web: `playbackStore.ts:589-625`).

---

## 🟡 Что стоит исследовать

### 1. Магические +150 ms и границы юнита — ПРИОРИТЕТ №1

Сейчас:

```
unit N  стартует на audio T
   ↓
seek video → T
   ↓
storyboard unit N закрывает поверхность
   ↓
ждём video position >= T + 150 ms
   ↓
показываем video
```

Обе платформы проверяют только `pos >= target + 150`, **верхняя граница юнита не проверяется**:

- Android: `pendingRevealPosMs = startPosMs + UNIT_REVEAL_TOLERANCE_MS`
  (`PlayFragment.kt:1237, 1245`), reveal при `pos >= pendingRevealPosMs` (`PlayFragment.kt:1076-1082`).
- Web: `pendingVideoRevealSec = explicitSeekMs/1000 + UNIT_REVEAL_TOLERANCE_MS/1000`
  (`playbackStore.ts:1434, 1494`), reveal в `onVideoTimeUpdate` при `currentTime >= pendingVideoRevealSec`
  (`playbackStore.ts:1556-1564`).

Если юнит короче 150 ms, позиция `T + 150` уже находится в следующем юните. Reveal должен
быть ограничен границами текущего юнита:

```text
revealPosition = min(unitStart + tolerance, unitEnd - safetyMargin)
```

Или reveal по условиям: `seek завершён AND video имеет кадр AND pos >= unitStart + tolerance
AND pos < unitEnd`. Границу юнита можно получить из `end_ms` (`StoryboardResponse.kt:21`)
или из `startMs` следующего юнита.

**Не превращать 150 ms в универсальную истину.** Для другого профиля / модели drift может
быть 250 ms; для короткого юнита — перескакиваем через конец. Только `REVEAL_SAFETY_TOLERANCE`
и проверка, что мы всё ещё внутри выбранного юнита.

### 2. 150 ms одновременно в визуальной логике и timing-логике

`UNIT_REVEAL_TOLERANCE_MS = 150` (Android: `PlayFragment.kt:56`; Web: `playbackStore.ts:176`) —
это reveal-гейт. Но на Android есть **второй, отдельный** `delay(150)` в
`revealVideoAfterReturn()` (`PlayFragment.kt:1482`) — визуальный fallback на пересозданной
поверхности. Это разные смыслы одной величины, зашитой в двух местах. Стоит разделить
константы/комментарии, чтобы `150` не превратилось в «всё подряд».

### 3. Android vs Web — разные механизмы синхронизации

- Android: один ExoPlayer + `MergingMediaSource` — аудио и видео под одним media clock
  (`PlayFragment.kt:68-77, 1255-1266`).
- Web: отдельные `<audio>` и `<video>` (`currentPlayer` + `videoEl`).

Это сознательная платформенная архитектура, и это не баг. Но требовать от Web побайтового
поведения Android нельзя: на web всегда останется небольшой независимый drift между двумя
HTML media elements. Контракт: **Audio = semantic master timeline, Video = visual follower**.

### 4. Player знает слишком много состояний видео

Накопилось много независимых флагов:

```
videoReadyToShow, videoSeekInFlight, pendingRevealPosMs, pendingRevealGen,
videoPlayerGeneration, videoCurrentGen, videoSurfaceAlive,
currentPlayerVideoVersion, currentPlayerHasVideo, currentPlayerSceneKey,
currentIuSequence, currentIuIndex, advancePending, pendingLoad, ...
```

`PlayFragment.kt:85-140`. Именно такой код породил N−1 (цепочка `currentIuSequence →
stopAll → null → SCENE_READY → другая картинка`). Сейчас новое не сломано, но не стоит
добавлять новые флаги даже для edge case. Следующий этап — формализовать состояния:

```
IDLE / LOADING_SCENE / SHOWING_STORYBOARD / SEEKING / VIDEO_READY / PLAYING / PAUSED
```

и один источник истины для selectedUnit.

### 5. `currentIuIndex` против `unitId` — инвариант

Разрешение цели по ID — правильный основной путь. Но index остаётся операционным состоянием
(циклическое проигрывание). Проверить инвариант:

> В любой момент `currentIuIndex` должен быть индексом того же объекта, который
> идентифицирован `currentUnitId` (в Android — target unit из `resolveUnitIndexForSequence`).

Иначе через `pause → resume → scene transition → Navigator → rotation → restore` можно снова
получить старый index. Особенно стоит покрыть тестами `idx == 0 && currentIuIndex != 0`
(`PlayFragment.kt:1109`) — guard, который принудительно держит индекс от отката к unit 0.

### 6. `video_start_ms` — правило на будущее

Backend продолжает считать `video_start_ms` (best-effort) для Final Assembly. Это хорошо.
Архитектурное правило: **Player никогда больше не должен зависеть от `video_start_ms`**,
иначе эпопея с N−1 вернётся через «ну вот для одного edge case».

### 7. Race: first frame + position gate

Два условия: «видео отрисовало первый кадр» и «позиция дошла до reveal-гейта». Должно быть
именно AND, а не две независимые возможности раскрыть видео.

- Android: reveal по позиции — первый кадр не обязателен (`PlayFragment.kt:1076-1082`);
  `onRenderedFirstFrame` обслуживает только путь возврата (`PlayFragment.kt:1371-1381`).
- Web: `onVideoFirstFrame` не раскрывает, пока `videoSeekInFlight` (`playbackStore.ts:1543-1547`),
  а `onVideoTimeUpdate` раскрывает по позиции и **без проверки фактического кадра**
  (`playbackStore.ts:1556-1564` — `videoHasFrame = true` ставится чисто по currentTime).

На web есть тонкий случай: currentTime может пересечь гейт до декода кадра. Низкая частота,
но это место стоит протестировать отдельно.

### 8. Сценарии, которые прогнать после изменений

1. Cold start → Navigator → очень быстрый tap → Start → pause → другой unit.
2. Pause → Navigator → unit → Play.
3. Последний unit → первый unit той же сцены.
4. Scene A → Scene B → быстро обратно Scene A.
5. Positioned-pause на границе юнита (Android раскрывает по позиции до `isPaused`-гейта
   `PlayFragment.kt:1076` vs `1084`; Web — только по `timeupdate`, т.е. на паузе не
   раскрывает). Потенциальное расхождение платформ.

---

## 🔴 Чего НЕ делать

- Не трогать идею единой аудио-шкалы — это хороший фундамент.
- Не возвращать `video_start_ms` в Player, даже если в конкретном LTX-тесте снова появится
  пара кадров N−1. Смотреть только через контракт «storyboard = выбранный юнит; audio =
  master; video = follower», а LTX 8N+1 решать при подготовке/assembly видео.

---

## Файлы, затронутые рефактором (413a841, 7b58152)

| Файл | Роль |
|---|---|
| `frontends/android/.../ui/PlayFragment.kt` | Reveal-гейт по позиции, `UNIT_REVEAL_TOLERANCE_MS`, unitId-seek, watchdog READY |
| `frontends/android/.../ui/PlaybackViewModel.kt` | `resolveUnitIndexForSequence`, `pendingExternalUnitId`, deferred seek |
| `frontends/android/.../repository/StoryboardResponse.kt` | `end_ms` (полезен для границ юнита) |
| `frontends/app/src/state/playbackStore.ts` | Web-паритет reveal-гейта, `resolveUnitIndexForSequence` |
| `backend/src/video/video-timeline.js` | `video_start_ms` для Final Assembly (не для Player) |
| `backend/src/routes/generation-routes.cjs` | Отдаёт `video_start_ms` best-effort |

---

## Рейтинг приоритетов

| # | Находка | Приоритет |
|---|---|---|
| 1 | +150 ms может перескочить конец короткого юнита — нужна верхняя граница | 🟡 High |
| 2 | Race first-frame vs position gate (web раскрывает по одному currentTime) | 🟡 High |
| 3 | Инвариант `currentIuIndex` vs unitId (особенно guard `idx==0`) | 🟡 High |
| 4 | Cold-start / Navigator / Play race после последних изменений | 🟡 Test |
| 5 | Pause → Navigator → unit → Play | 🟡 Test |
| 6 | Последний unit → первый unit той же сцены | 🟡 Test |
| 7 | Scene A → Scene B → быстро обратно Scene A | 🟡 Test |
| 8 | Формализация state machine Player (7 состояний) | 🟢 Later |
| 9 | Разделить две смысловые `150` (reveal-гейт vs `revealVideoAfterReturn`) | 🟢 Later |