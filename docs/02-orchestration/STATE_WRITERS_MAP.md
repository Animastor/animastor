# Карта писателей состояния (Д.0)

> Инвентаризация всех мест, которые пишут состояние сцены/ассетов. Опора для M5
> (свести к одному арбитру — Orchestrator) и M3 (диск как факт, не решение).
> Составлено по коду на 2026-06-26 (ветка `feat/orchestrator-facade`).
> Уточняет `docs-claude/03_Orchestrator.md §5` точными строками.

## Что считаем «состоянием»

1. **Per-asset** (КАНОН с v2.1.0): `setAssetState` / `setAssetStates` →
   Redis hash `animastor:asset-state:<scene>` (поля audio/image/video).
2. **Линейное** (проекция для плеера/debug): `transitionSceneState` /
   `setSceneState` / `setSceneStateWithBuildId` → `animastor:scene-state:<scene>`.
3. **Chunk-статусы** (disk-derived прогресс): `audio_status` / `image_status`
   в `animastor:chunk:*` — пишутся по наличию файла на диске (M3-поверхность).
4. **PG `scene_assets.status`** — пишется только через `markReady` (Н.5) из колбэков.

## 1. Per-asset writers (`setAssetState` / `setAssetStates`)

| # | Файл:строка | Что пишет | Триггер | Куда уедет (цель) |
|---|---|---|---|---|
| P1 | `scene-orchestrator.js:51,79,123` | → GENERATING (audio/image/video) | старт диспатча (§5.1) | `beginStage` (фасад) |
| P2 | `scene-callbacks.js:112,240,323,361,387` | → READY | колбэк GPU-завершения | `completeStage` (фасад) |
| P3 | `runtime-scheduler.js` `markVersionStaleDirty` | READY → DIRTY | тик: PG version-stale | ✅ Д.2: вынесено из `shouldScheduleAssets` в явный пред-проход |
| P4 | `reconciliation-engine.js:610-612,672-674` | → DIRTY | reconcile (auto-fix) | `reconcile` (фасад) |
| P5 | `startup-recovery.js:285` | → DIRTY/READY | старт сервера (version-stale) | `reconcile`/`markDirty` (Д.3) |
| P6 | `scene-restoration.js:66,71` | audio→READY, image→DIRTY | восстановление сцены | `reconcile` (Д.3) |
| P7 | `scene-window.js:626` | audio → PLACEHOLDER | оконная генерация (заглушка TTS) | оставить (особый кейс) |
| P8 | `book-diff.cjs:456` | → PENDING | /regenerate (через `markDirty` уже) | уже за фасадом ✅ |

**Итого 8 точек записи per-asset.** Уже за фасадом: P8 (через `orchestrator.markDirty`,
коммит a092f44). Цель Д.1 закрыта на уровне квот (release идемпотентен). Цель Д.2 — убрать
побочную запись P3 из `shouldScheduleAssets`.

## 2. Linear-state writers (проекция — пишется параллельно per-asset)

| # | Файл:строка | Триггер |
|---|---|---|
| L1 | `scene-orchestrator.js:30,48,76,120` | старт диспатча (PENDING/GENERATING) |
| L2 | `scene-callbacks.js:362,388` | колбэк (VIDEO_READY/IMAGE_READY + buildId) |
| L3 | `reconciliation-engine.js:607,669,702,721,750,793` | reconcile (множество переходов) |
| L4 | `scene-window.js:457,569,593,610` | оконное завершение video |
| L5 | `book-routes.cjs:101`, `window-generator.cjs:106`, `redis-helpers.cjs:154` | роуты/хелперы (VIDEO_READY) |
| L6 | `runtime-persistence.js:604` | восстановление снапшота |
| L7 | `debug-routes.cjs:381,443` | ручные debug-эндпоинты |

Линейное состояние — производное (L3 в аудите). На M5 оно должно вычисляться из per-asset
(`deriveLinearState`), а не писаться напрямую. Вывод проекции — отдельная задача после
перевода плеера (вне Д.0–Д.3).

## 3. Disk-derived chunk-status writers (M3-поверхность)

| # | Файл:строка | Что пишет | Решение по |
|---|---|---|---|
| D1 | `scene-window.js:274,278` (`restoreChunkStatusForScene`) | audio/image_status → ready/placeholder | **наличие файла на диске** |
| D2 | `scene-window.js:514,526` (`reconcileWindowStatuses`) | audio/image_status pending→ready | **наличие файла на диске** |
| D3 | `startup-recovery.js:131` (`recoverIuImagesFromDisk`) | image-готовность по PNG | **наличие файла на диске** |

**Это цель Д.3 (M3):** D1–D3 принимают решение о готовности по диску, переопределяя
намерение пользователя (старый файл «оживляет» сцену после force-regen). Должны вернуть
**факт** «файл существует для buildId X» в `reconcile`, а решение принимает Orchestrator
по версии.

## Сводка для M5/M3

- **Свести к фасаду (M5):** P2→`completeStage`, P3→`markDirty` (Д.2), P4/P5/P6→`reconcile`.
  P1 уже идёт через `beginStage`-путь, P8 уже за фасадом, P7 — особый кейс (placeholder).
- **Диск как факт (M3):** D1–D3 → факты в `reconcile` (Д.3).
- **Линейная проекция:** L1–L7 — вывести позже (вычислять из per-asset), вне текущих задач.

Порядок безопасного перевода (по одному за коммит): P3 (Д.2) → D1-D3 (Д.3) →
P5/P6 (recovery/restoration) → P4 (reconciliation) → P2 (callbacks).
