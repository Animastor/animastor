# Миграция Android → Mobile Web — список задач

Источник плана: [`08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md`](08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md)
Правило проекта: [`08-mobile-web-migration/README.md`](08-mobile-web-migration/README.md)

Статусы: `[ ]` pending · `[~]` in_progress · `[x]` done

## Этап 0 — Каркас (до экранов)

- [x] **Каркас `frontends/mobile`**: Preact + Vite + TS (стек зафиксирован). Роутер (`preact-router`), `TabBar` (5 вкладок), `Toolbar` (Settings/AI), сохранение состояния вкладок; design tokens `tokens.css`/`theme-dark.css`/`theme-light.css` из `colors.xml`/`themes.xml` + `auto` по часу (pre-paint скрипт в `index.html`); i18n ru/en/auto из `strings.xml`; `api/client.ts` (fetch base `/api/v1/`, SSE, `retryWithBackoff`, streaming-Blob); `cache/mediaCache.ts` (Cache API + `clearCache(buildId?)`); `state/*` (`positionStore`, `generateStore`, `playbackStore`); SVG-иконки из `res/drawable/ic_*.xml`. ✅ `tsc --noEmit` + `vite build` + dev-server smoke — OK.

## Этап 1 — Простейшие статичные/диалоговые экраны

- [x] **Settings** (`/settings`) — тема dark/light/auto + язык ru/en/auto (segmented control, `localStorage` = `SharedPreferences`), через `applyTheme`/`applyLanguage`. VBook/Worker секции — заглушки в том же файле.
- [x] **VBookSettings** (`/settings/vbook`) — chunk size (scenes per pass), layer-config `GET/PUT`
- [x] **WorkerSettings** (`/settings/worker`) — `/worker/counts`, профили (`/connectors/profiles`), таймауты (layer-config), workflow (`/connectors/grouped`)
- [x] **Library** (`/library`) — iframe справки/релиз-ноутсов (`animastor.in`)

## Этап 2 — Сетевые списки/детали (без плеера и генерации)

- [x] **WorkflowManager** (`/workflows`) — карточки audio/image/video + активные счётчики из `/connectors/grouped` (F12), Reload → `/connectors/reload`
- [x] **WorkflowDetails** (`/workflows/:name`) — header-карточка + 4 таба (Inputs/Outputs/Parameters/Compatibility), edit-режим (`?edit` → `routeState.detailsEditMode`), правка параметров (`PUT /connectors/{name}/parameters`) и биндингов/гайд-нод (`PUT .../bindings`), dev-чип `</>`
- [x] **WorkflowTypeList** (`/workflows/type/:type`) — список коннекторов типа, enable-переключатель (`PUT .../status`), кнопка Details, Add Workflow (JSON-файл → `POST /connectors`)
- [x] **DeveloperView** (`/dev`) — табы Raw JSON (`/connectors/{name}/raw`) / Bindings (из ConnectorDetail), переход по dev-чипу с `routeState.devConnector`
- [x] **AiAssistant** (`/ai`) — чат: сессии (`/ai/sessions*`), 6 режимов (AssistantMode), typing-индикатор, position-bar, markdown-бабблы, копирование, голосовой ввод (Web Speech API)

### Завершение этапа 2 (2026-08-02) ✅

- Все 5 экранов реализованы; `tsc --noEmit` + `vite build` — OK; code-review пройден.
- Отклонения и решения — [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) §11.

---

## Этап 3 — File (импорт/экспорт)

- [ ] **File** (`/file`) — импорт `.vbook`/txt (`POST /book/import` multipart), список книг, экспорт/скачивание, deep link `?book=`

## Этап 4 — Generate (прогресс и координация)

- [ ] **Generate** (`/generate`) — SSE-прогресс, статус по scope (`/progress-panel`), чипы режимов/тем/воркеров, индикатор статуса на tab-иконке (running/error/success + авто-сброс), emits `playbackPrepared` → `playbackStore.preparePlayback()`

## Этап 5 — Navigate (карта-закладки → seek)

- [ ] **Navigate** (`/navigate`) — дерево глав→сцен→юнитов → `positionStore.navigateTo()` + `router.push('/play')` + `playbackStore.seekToPosition()` (refresh book JSON если нет → `missingIuPosition` overlay)

## Этап 6 — Edit (таймлайн + waveform)

- [ ] **Edit** (`/edit`) — таймлайн сцен/юнитов, waveform (`getSceneWaveform` → Canvas), IU-предпросмотр, `GET/PUT /scene/.../timings`, `GET/PUT /book/{id}/layer-config`, переход в Play по seek

## Этап 7 — Play (мультиплеер) — высший риск

- [ ] **Play** (`/play`) — UI-каркас (`fragment_play.xml` 1:1); `playbackStore` (`PlaybackUiState`, `sceneQueue`, preloadCache, layer toggles, `needsContentRefresh`); движок: 2×`<audio>` (gapless −200ms) + `<video>` overlay + IU-cycling (RAF по `currentTime`) + silent IU-режим + seek по `unitIndex` (sum `durationMs`) + `preloadAhead(3)` retry/backoff + `fetchSceneData` (status→audio→video→IU) + soft-refresh; seek/навигация (`seekToPosition`/`executePendingSeek`/`missingIuPosition`); lifecycle (Page Visibility, sessionStorage savedPosition). Антипаттерны `DONT_DO.md` не воспроизводить.

## Финал

- [ ] Снять Basic Auth с `m.animastor.in` (`proxy/conf/default.conf`) перед публичным запуском

---

## Прогресс

Обновлять статусы скобками по мере выполнения; при завершении этапа — краткая заметка в
[`08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md`](08-mobile-web-migration/05-SCREEN-IMPLEMENTATION-ORDER.md)
и фиксация отклонений в
[`08-mobile-web-migration/06-RISKS-AND-ALTERNATIVES.md`](08-mobile-web-migration/06-RISKS-AND-ALTERNATIVES.md).
