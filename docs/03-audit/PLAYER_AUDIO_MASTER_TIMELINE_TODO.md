# Player Audio Master Timeline — TODO

> **Легенда:** 🟡 High | 🟢 Medium | ⚪ Low
> **Статус:** 📝 Plan | 🔧 In progress | ✅ Done | ❌ Skipped

Источник: `docs/03-audit/PLAYER_AUDIO_MASTER_TIMELINE.md`

---

## Этап 1: Reveal-гейт ограничить границами юнита (🟡 High)

**Проблема:** `pendingRevealPosMs = startPosMs + 150` (Android `PlayFragment.kt:1237,1245`;
Web `playbackStore.ts:1434,1494`) проверяет только нижнюю границу. Короткий юнит (< 150 ms)
раскрывает видео уже в следующем юните.

### [T1.1] Ввести верхнюю границу reveal-гейта
- [x] Android: в `startIuCycling` добавить `pos < unitEnd` (или `min(start + tol, unitEnd - safety)`)
  к условию reveal (`PlayFragment.kt:1076-1082`). Границу брать из `startMs` следующего юнита
  или `end_ms` (`StoryboardResponse.kt:21`).
- [x] Web: в `onVideoTimeUpdate` добавить верхнюю границу (`playbackStore.ts:1556-1564`).
- [x] Fallback: если у последнего юнита нет следующего `startMs` — использовать
  `startMs + durationMs`.

### [T1.2] Проверить границу на последнем юните сцены
- [x] Seek в последний юнит сцены: reveal не должен улетать за конец сцены / в `ended`
  (закрыто `unitEndMs`: последний юнит → `startMs + durationMs`; ручная проверка — в T4).

---

## Этап 2: Race first-frame vs position gate (🟡 High)

**Проблема:** на Web `onVideoTimeUpdate` раскрывает по одному `currentTime` без проверки
фактического декодированного кадра (`playbackStore.ts:1556-1564`, `videoHasFrame = true`
ставится по позиции). Android раскрывает по позиции без `onRenderedFirstFrame` в seek-пути.

### [T2.1] Привести оба платформы к AND
- [x] Web: в `onVideoTimeUpdate` перед reveal убеждаться, что кадр реально декодирован
  (например, `videoHasFrame || readyState >= HAVE_CURRENT_DATA`).
- [x] Android: зафиксировать решение — seek-reveal по позиции достаточен (README/комментарий),
  либо добавить проверку рендера.

### [T2.2] Тест-сценарии
- [ ] Seek → первый кадр есть, позиция < гейта → не показываем.
- [ ] Позиция >= гейта, первый кадр ещё не готов → не показываем.
- [ ] Оба условия выполнены → показываем.

---

## Этап 3: Инвариант currentIuIndex vs unitId (🟡 High)

**Проблема:** index остаётся операционным состоянием; возможен старый index после
pause/resume/rotation/restore.

### [T3.1] Проверить invariant
- [x] После каждого перехода (seek, pause, resume, rotation, scene transition, Navigator)
  проверять: `ius[currentIuIndex].unitId == targetUnit.unitId`.
- [x] Особо покрыть guard `idx == 0 && currentIuIndex != 0` (`PlayFragment.kt:1109`).

**Вывод:** invariant выполнен конструктивно — оба платформы в `handleChunk` выводят
`currentIuIndex` из `resolveUnitIndexForSequence` (unitId-first, fallback index),
то есть индекс пере-вычисляется на каждом заходе сцены, а не копируется из store.
Guard `idx == 0 && currentIuIndex != 0` — корректная защита от транзиентного `pos == 0`
сразу после seek в более поздний юнит (его `start_ms > 0`); при seek в юнит 0
`currentIuIndex == 0`, и guard не срабатывает. Ручной регресс — T4.

---

## Этап 4: Регрессионные сценарии (🟡 Test)

Прогнать после этапов 1-3 на обеих платформах:

- [ ] Cold start → Navigator → очень быстрый tap → Start → pause → другой unit.
- [ ] Pause → Navigator → unit → Play.
- [ ] Последний unit → первый unit той же сцены.
- [ ] Scene A → Scene B → быстро обратно Scene A.
- [ ] Positioned-pause на границе юнита (Android vs Web поведение).
- [ ] Короткий юнит (< 150 ms): reveal не в следующем юните.

---

## Этап 5: Разделить две смысловые `150` (🟢 Medium)

- [x] Android: переименовать/вынести `delay(150)` в `revealVideoAfterReturn`
  (`PlayFragment.kt:1482`) в отдельную именованную константу (например
  `SURFACE_RE_RENDER_FALLBACK_MS`), отдельно от `UNIT_REVEAL_TOLERANCE_MS`.
- [x] Web: убедиться, что `UNIT_REVEAL_TOLERANCE_MS` — единственная величина 150.

---

## Этап 6: Формализация state machine Player (🟢 Later)

**Проблема:** множество независимых флагов (`PlayFragment.kt:85-140`) вместо одного
источника истины для selectedUnit.

- [ ] Описать состояния: `IDLE / LOADING_SCENE / SHOWING_STORYBOARD / SEEKING /
  VIDEO_READY / PLAYING / PAUSED`.
- [ ] Свести флаги к одному источнику истины для selectedUnit.
- [ ] Не добавлять новые флаги до этого рефактора.

---

## Этап 7: Правило на будущее — video_start_ms (⚪ Doc)

- [x] Зафиксировать в DONT_DO.md: **Player никогда не зависит от `video_start_ms`**;
  LTX 8N+1 решается при подготовке/assembly видео.
- [x] Проверить чистоту моделей frontends (нигде не осталось `videoStartMs`).

---

## Прогресс

| Задача | Статус |
|---|---|
| T1.1 Reveal-гейт с верхней границей | ✅ Done |
| T1.2 Последний юнит сцены | ✅ Done (код; ручной тест — T4) |
| T2.1 AND first-frame + position | ✅ Done |
| T2.2 Тест-сценарии gate | 📝 Plan |
| T3.1 Инвариант index vs unitId | ✅ Done (verify) |
| T4 Регрессионные сценарии | 📝 Plan |
| T5 Разделить две 150 | ✅ Done |
| T6 State machine | 📝 Plan |
| T7 video_start_ms правило | ✅ Done |