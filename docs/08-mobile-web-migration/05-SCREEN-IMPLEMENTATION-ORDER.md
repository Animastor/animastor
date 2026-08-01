# 05. План переноса экранов (простые → сложные)

Порядок реализации выбран **от самых простых к самым сложным**, чтобы накопить
каркас, design tokens, i18n, HTTP-клиент и кэш-слой на тривиальных экранах до
самого рискованного — плеера. Каждая итерация заканчивается критериями приёмки
из [`02-DESIGN-PRESERVATION-PRINCIPLES.md`](02-DESIGN-PRESERVATION-PRINCIPLES.md) §3.

> Перед реализацией **любого** экрана должен быть готов каркас из этапа 0.

---

## Этап 0 — Каркас (до экранов)

- Shell: роутер + `TabBar` (5 вкладок) + `Toolbar` (Settings/AI) + сохранение
  состояния вкладок (storы на уровне shell).
- Design tokens: `theme-dark.css`/`theme-light.css` из `colors.xml`/`themes.xml`;
  `auto`-режим по часу (как в Android `applyTheme()`).
- i18n: словари ru/en из `strings.xml`; `auto` по `navigator.language`.
- `api/client.ts`: fetch-обёртка base `/api/v1/`, SSE-клиент, `retryWithBackoff`,
  streaming-Blob.
- `cache/mediaCache.ts`: Cache API/IndexedDB, `clearCache(buildId?)`.
- `state/*`: `positionStore` (SharedPositionManager), заглушки `generateStore` /
  `playbackStore`.
- SVG-иконки из `res/drawable/ic_*.xml`.
- `index.html`: meta viewport, тема, загрузчик.

Приёмка: открытие `m.animastor.in` показывает пустой shell с тёмной темой,
рабочий tab-bar (пустые страницы), переключение вкладок сохраняет их состояние,
`Settings`/`AI` кнопки открывают secondary-маршруты (заглушки).

---

## Этап 1 — Простейшие статичные/диалоговые экраны

| Шаг | Экран | Почему простой | Ключевые API/модели |
|---|---|---|---|
| 1.1 | **Settings** (`/settings`) | статичная форма, tiny API | тема + язык (localStorage, как `PREFS_*`), `getBook/updateBook/deleteBook/exportBook/downloadBook/clearBookCache/cancelGeneration` |
| 1.2 | **VBookSettings** (`/settings/vbook`) | форма 1-2 поля | `chunk size (scenes per pass)` из `GenerateViewModel` |
| 1.3 | **WorkerSettings** (`/settings/worker`) | форма по типам воркеров | `/worker/counts` |
| 1.4 | **Library** (`/library`) | WebView контента | iframe справки/релиз-ноутсов |

Приёмка: визуально и текстово совпадает с `fragment_*.xml`; тема/язык реально
переключают shell; сохранение настроек в localStorage (= `SharedPreferences`).

---

## Этап 2 — Сетевые списки/детали (без плеера и генерации)

| Шаг | Экран | Сложность | API/модели |
|---|---|---|---|
| 2.1 | **WorkflowManager** (`/workflows`) | список + сводка | `/workflows`, `/workflows/summary` (`WorkflowSummaryResponse`) |
| 2.2 | **WorkflowDetails** (`/workflows/:name`) | детали + hash + узлы | `/workflows/{name}`, `/workflows/{name}/hash` (`WorkflowDetail`, `WorkflowHashResponse`) |
| 2.3 | **WorkflowTypeList** (`/workflows/type/:type`) | узлы по типу | `WorkflowTypeListFragment` (sharedViewModel) |
| 2.4 | **DeveloperView** (`/dev`) | коннектор: параметры/биндинги/совместимость | `/connectors*` (`ConnectorDetail`, `CompatibilityStatus`, `putConnectorParameter/Binding/Status`, `validateConnector`, `reloadConnectors`, `getConnectorEntities`) |
| 2.5 | **AiAssistant** (`/ai`) | чат с сессиями/историей; режимы; typing | `/ai/chat`, `/ai/sessions*`, `/ai/sessions/{id}/messages` (`ChatAdapter`, `ChatHistoryManager`, `AssistantMode`) |

Приёмка: рекурсия навигации `WorkflowManager→Details→TypeList→DeveloperView`
работает; чат отправляет/принимает сообщения, показывает typing, переключает
режимы, список сессий создаётся/редактируется/удаляется.

---

## Этап 3 — File (импорт/экспорт)

| Шаг | Содержание | Почему сейчас |
|---|---|---|
| 3.1 | **File** (`/file`) | Импорт `.vbook`/txt через `<input type=file>` + drag-drop (`POST /book/import` multipart); список книг; экспорт/скачивание (`GET /book/{id}/export\|download`); глубокая ссылка `?book=`. Триггерит `generateStore.loadBook()` и переход на `Generate`/`Play`. | Нужен входной поток книги для всех остальных экранов. |

Приёмка: импорт книги → `Generate` видит книгу; экспорт/скчивание работают;
повторный выбор уже открытой книги не ломает состояние (как `pendingExportBookId`).

---

## Этап 4 — Generate (прогресс и координация)

| Шаг | Содержание | Риски |
|---|---|---|
| 4.1 | **Generate** (`/generate`) — запуск генерации, SSE-прогресс, статус по scope (`/progress-panel?scope=…&chapter_id=…&scene_id=…`), чипы режимов/тем/воркеров, индикатор статуса на tab-иконке (`running`/`error`/`success`, авто-сброс по таймеру как в `MainActivity.updateNavIconStatus`). Emits `playbackPrepared` → `playbackStore.preparePlayback()` (воспроизвести `setupPlaybackCoordination`). | SSE-монотонность/lost reconnect (см. `docs/05-frontend/PROGRESS_HANDOFF.md`). Скоординировать с плеером **до** этапа 5. |

Приёмка: запуск генерации, прогресс корректен при reconnect, после завершения
`Play` автоматически готов играть (через `playbackPrepared`), статус-иконка
корректно пульсирует и авто-сбрасывается.

---

## Этап 5 — Navigate (карта-закладки → seek)

| Шаг | Содержание |
|---|---|
| 5.1 | **Navigate** (`/navigate`) — дерево глав→сцен→юнитов (`getBook`, `sceneRefs()`, `getTextIndex`, `getChaptersSummary`); выбор узла → `positionStore.navigateTo(...)` + `router.push('/play')` + `playbackStore.seekToPosition(...)` (1:1 с `seekToPosition`: refresh book JSON при отсутствии сцены, `missingIuPosition` overlay). |

Приёмка: переход из Navigate в Play делает seek в нужный юнит; при отсутствии
сцены показывается overlay «не сгенерировано» (как `showMissingChunkOverlay`).

---

## Этап 6 — Edit (таймлайн + waveform)

| Шаг | Содержание | Риски |
|---|---|---|
| 6.1 | **Edit** (`/edit`) — список сцен/юнитов, waveform (`getSceneWaveform` → `WaveformView`-рендер на Canvas), предпросмотр IU-изображений, редактирование/сохранение таймингов (`GET/PUT /scene/.../timings`), `layer-config` (`GET/PUT /book/{id}/layer-config`). Переход в `Play` c seek по выбранному юниту. | waveform на canvas; сохранение таймингов с валидацией; синхронизация с `playbackStore` (те же `seekToPosition`/`positionStore`). Средне-высокий риск — см. 06. |

Приёмка: waveform рисуется идентично; правка таймингов сохраняется и влияет на
разбиение IU-cycling в Play; layer-config персистится.

---

## Этап 7 — Play (мультиплеер) — финальный, высший риск

| Шаг | Содержание | Зависимости |
|---|---|---|
| 7.1 | Подэкра: `playbackStore` (`PlaybackUiState`, `sceneQueue`, `currentIndex`, `currentUnitIndex`, preloadCache, `pendingSceneAudio/Video/IuSequence`, layer toggles, `needsContentRefresh`/`needsRotationResume` аналоги), `positionStore`. | Все предыдущие экраны. |
| 7.2 | UI каркас Play (`fragment_play.xml` 1:1): media viewport, layer bar (4 чипа), big-play-button, progress, status, fullscreen, curtains/cover/result/overlay/subtitle. | Design tokens готовы. |
| 7.3 | Движок воспроизведения: 2 аудио-источника (current+next, gapless-приближение), 1 video overlay, IU-cycling по `currentTime` (RAF), silent IU-режим (Cover), seek по `unitIndex` (сумма `durationMs`), `preloadAhead(3)` с retry/backoff, `fetchSceneData` (status→audio→video→IU), soft-refresh (`refreshContent`) + `needsContentRefresh`. | Реализация/выбор альтернатив — 06 §Player. |
| 7.4 | Seek/навигация: `seekToPosition` (refresh book JSON при отсутствии, `missingIuPosition`), `executePendingSeek` (через `positionStore.navigateTo`), восстановление позиции (`savedPlaybackPositionMs` аналог через `Page Visibility`). | `positionStore` готов. |
| 7.5 | Lifecycle/видимость: пауза при скрытии вкладки/минимизации (`Page Visibility`), восстановление при возврате, корректный release ресурсов. | Каркас shell. |

Приёмка: воспроизводится очередь сцен с gapless-переходом; IU-картинки и
субтитры синхронизированы с аудио; видеослой показывается по `status.video_ready`;
seek из Navigate/Edit работает; soft-refresh после регенерации работает; пауза/
возобновление/полный экран работают; `DONT_DO.md`-антипаттерны не воспроизведены.

---

## Резюме порядка

```
0 каркас →
1 Settings/Lib/VBook/Worker (тривиально) →
2 Workflows/Dev/Ai (списки/детали/чат) →
3 File (импорт) →
4 Generate (SSE + координация) →
5 Navigate (карта→seek) →
6 Edit (waveform + timings) →
7 Play (мультиплеер, высший риск)
```

Каждый этап сопровождается записью в этот же раздел: статус, фактческие
отклонения (ссылки на `06-RISKS-AND-ALTERNATIVES.md`), визуальные/UX-расхождения.
