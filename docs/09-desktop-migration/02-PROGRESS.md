# Миграция Mobile Web → Desktop — трекер прогресса

Источник плана: [`01-MIGRATION-PLAN.md`](01-MIGRATION-PLAN.md)
Правило секции: [`README.md`](README.md)

Статусы: `[ ]` pending · `[~]` in_progress · `[x]` done

> **2026-08-12 — Доменная миграция:** приложение теперь живёт на `app.animastor.in`
> (вместо `m.animastor.in`), каталог `frontends/mobile` переименован в `frontends/app`.
> Упоминания старых путей ниже — исторические (см. `ARCHITECTURE.md` в корне).

---

## Phase 1 — Audit ✅ (завершена в плане)

- [x] Карта мобильных экранов, маршрутов, сторов, токенов, тем, языков и адаптивных механизмов
- [x] Подтверждено: целевая папка — `frontends/mobile/`; `frontends/main/` — только статичный `index.html`, не десктопное приложение
- [x] Границы reuse / adaptation / new components описаны (план §9)

## Phase 2 — Desktop information architecture

- [~] Концепция подтверждена планом; точные брейкпоинты/ширины — после визуальных прототипов
- [ ] Решение по Navigator selection behaviour и File auto-collapse до кода (черновик — план §3.2/§4.2/§4.3)

## Phase 3 — Design-system adaptation

- [ ] Десктопные layout-токены (header/панели/gap) без смены палитры и типографики
- [ ] Примитивы: панель, rail, mode-switcher, tooltip, focus

## Phase 4 — Navigation shell (прототип сделан, нужна доводка)

Сделано gpt-5.6-terra (коммиты `60d7240` → `7666de4`, запушены в `origin/master`):

- [x] `AppShell.tsx`: `DesktopWorkspace`-ветка за брейкпоинтом `min-width: 1180px`
- [x] Desktop header: бренд, название книги (`GET /book/{id}`), позиция (глава·сцена·юнит), статус генерации (idle/running/error/success + пульс), AI, settings
- [x] Mode switcher Generator/Player/Editor (segmented, иконка+подпись, `aria-current`)
- [x] File-панель слева (встраивает `FilePage`), Navigator-панель справа (встраивает `NavigatePage`)
- [x] Коллапс обеих панелей с сохранением выбора в `localStorage` (`animastor_desktop_panels`)
- [x] Laptop-приоритизация workspace (`@media (max-width: 1359px)`) в `base.css`
- [x] `tsc --noEmit` + `vite build` — OK

Осталось (Phase 4 → доводка):

- [ ] First-run/no-book состояние: File expanded + ориентирующий empty-state в центре (сейчас — заглушка `DesktopStartState`)
- [ ] Open book → компакт rail (опционально, opt-in, без авто-сворачивания в процессе действий)
- [ ] Режим навигации: выбор юнита не должен принудительно переключать режим (сейчас `NavigatePage` роутит в `/play` — десктопная семантика)
- [ ] Secondary-экраны (settings/workflows/library) в шелле

## Phase 5 — Editor (наивысший приоритет) — первый срез сделан

Сделано (этап 2, коммит см. git log):

- [x] Десктопный двухколоночный layout Editor внутри `.desktop-main`: слева — карусель юнитов + waveform (preview-колонка, ~44%), справа — tabs + fields + Save (инспектор). Мобильная композиция ниже 1180px не тронута (все правила под `.desktop-main`)
- [x] `image.prompt` / `video.action` — промпт-редакторы: всегда textarea (rows 8), класс `edit-field--prompt`, min-height 200px (160px на laptop), resize: vertical, перенос строк, лимит символов сохраняется. Только в десктопном шелле (`useDesktopShell`) — мобильный рендер полей не меняется
- [x] Ctrl/Cmd+S сохраняет dirty-черновик (`e.code === 'KeyS'` — независимо от раскладки RU/EN)
- [x] Posbar редактора на десктопе — информационный breadcrumb (клик не роутит в `/navigate`, т.к. Navigator уже справа)
- [x] `useDesktopShell` экспортирован из `AppShell.tsx` для переиспользования
- [x] `tsc --noEmit` + `vite build` — OK; code-review пройден

Сделано (этап 2, срез 2):

- [x] **Десктопный header редактора** (план §5.1/§5.2): breadcrumb (позиция), Unit N/M, кнопки prev/next (disabled на границах), save-состояние (Saving/Unsaved/Saved — текст + цвет, не цвет отдельно), persistent Save. Мобильный posbar скрыт на десктопе (`display: none`), нижняя мобильная кнопка Save тоже — один явный Save на композицию
- [x] **Защита черновика** (план §5.2, риск §14): `requestUnitNavigation` — при dirty-черновике на десктопе показывается confirm (Сохранить и перейти / Не сохранять и перейти / Отмена). «Сохранить и перейти» продолжает навигацию только при успешном save (`saveToBackend` теперь `Promise<boolean>`, все пути возвращают true/false)
- [x] Escape закрывает confirm-modal + scroll-lock; autofocus на безопасном действии (Отмена)
- [x] Карусель (prev/next) тоже идёт через `requestUnitNavigation`
- [x] Новые i18n-ключи в ru/en; `tsc --noEmit` + `vite build` — OK; code-review пройден

Сделано (этап 2, срез 3):

- [x] **Preview stage + thumbnail rail** (план §5.3): на десктопе вместо карусели 3 карточек — bounded canvas текущего юнита (`object-fit: contain`, клик → существующий full-size zoom, hover-подсказка zoom) + горизонтальный скролл-rail юнитов текущей сцены (миниатюры с номером, активная — accent-рамка, `aria-current`)
- [x] Клик по thumb → `jumpToUnit` (позиция + seek, те же семантики, что in-scene ветка `navigateUnit`) через защиту черновика (`requestUnitJump`; прыжок на активный юнит — no-op без prompt)
- [x] Общий хелпер `previewUrl` переиспользован во всех трёх рендерах (stage / rail / мобильная карусель)
- [x] Пустое состояние rail (`edit_rail_empty`), lazy-загрузка, a11y: кнопки без ложного listbox-паттерна
- [x] `tsc --noEmit` + `vite build` — OK; code-review пройден

Сделано (этап 2, срез 4):

- [x] **Защита черновика при внешней навигации** (план §5.2, риск §14): observer позиции в EditPage при внешней смене позиции (Navigator-клик, AI, deep link) с dirty-черновиком на десктопе делает snapshot (позиция/tab/поля/override-блоки) и показывает modal «Вернуться к черновику / Потерять правки» — вместо молчаливой потери длинного промпта. `restoringRef` защищает восстановленные поля от повторной очистки observer'ом
- [x] **Navigator-клик на десктопе не роутит в `/play`** (план §4.3): выбор юнита обновляет shared position, режим workspace остаётся; мобильный сохраняет Android `switchToPlayTab()` ниже 1180px
- [x] **`useDesktopShell` + `DESKTOP_SHELL_QUERY` вынесены в `src/app/desktop.ts`** — устранён циклический импорт AppShell ↔ NavigatePage; импортируются из AppShell/EditPage/NavigatePage
- [x] Структурированный `lastPosRef` вместо парсинга строки ключа позиции
- [x] i18n-ключи recover-modal (ru/en); `tsc --noEmit` + `vite build` — OK; code-review пройден

Сделано (этап 2, срез 5):

- [x] **Arrow-key навигация по юнитам** (план §5.3/§11): Left/Right двигают активный модуль на десктопе, когда фокус вне полей ввода/textarea/select/contenteditable; не срабатывает при открытых zoom/confirm/recover модалках. Текстовые хоткеи не перехватываются
- [x] Авто-скролл активного thumb в rail (`scrollIntoView inline:nearest`) при смене модуля — активный модуль остаётся в поле зрения без кражи фокуса
- [x] `tsc --noEmit` + `vite build` — OK; code-review пройден

Сделано (этап 2, срез 6):

- [x] **Явное «Open in Player» в Navigator** (план §4.3): единичный клик по юниту на десктопе только выбирает позицию; двойной клик или кнопка play на активной строке (иконка, `aria-label`+tooltip) — явное переключение в Player. Кнопка — sibling-элемент рядом с кнопкой выбора (не вложенный button); row-обёртка `.nav-unit-row` переносит margin; mobile-клик по-прежнему роутит в `/play`
- [x] i18n `navigate_open_in_player` (ru/en); `tsc --noEmit` + `vite build` — OK; code-review пройден

Осталось (Phase 5):

- [ ] Опционально: collapse Navigator в режиме Editor на laptop
- [ ] Известный gap (Phase 9): смена режима/роут размонтирует EditPage — несохранённый черновик теряется при явном «Open in Player» или переключении мода (существующая защита покрывает только смену позиции при смонтированном редакторе). План §1.1/§14: mode-preserving mount или guard черновика при выходе из мода

## Phase 6 — Generator — первый срез сделан

Сделано (этап 2, срез 1):

- [x] **Control room** (план §6): на десктопе `.gen-page` — grid: header-строка (позиция · активные задачи · Generate All/Stop All) + воркер-карточки в 2 колонки на wide (>=1360px), 1 читаемая колонка на laptop (max-width 1359px). Мобильная композиция ниже 1180px не тронута (всё под `.desktop-main`, JS гейтится `isDesktop`)
- [x] **Active-jobs summary** в header (текст + цвет, не цвет отдельно): «N задач выполняется» / «Идёт генерация…» / «Нет активных задач», пульс при работе. `isGenerating` покрывает poll-gap (1.5s) и окно показа COMPLETED-строки VBook (10s, `isRegenerating`) — header никогда не показывает idle во время реальной работы
- [x] Posbar на десктопе скрыт (информационный breadcrumb в header; клик не роутит в `/navigate`); мобильная Global-карточка скрыта — её действия перенесены в header
- [x] Poll lifecycle, scope dialog, cancel — без изменений семантики (только layout)
- [x] **ScopeDialog**: initial focus на Cancel, Escape отменяет, scroll-lock; `onCancel` в ref + подписка один раз — фокус не крадётся кнопкой Cancel при ре-рендерах родителя каждые 500ms (тик таймера)
- [x] i18n-ключи (ru/en); `tsc --noEmit` + `vite build` — OK; code-review пройден

Осталось (Phase 6):

- [ ] Проверка poll lifecycle, scope dialog, cancel, ошибок при смене режимов (Phase 9 runtime-прогон)

## Phase 7 — Player — первый срез сделан

Сделано (этап 2, срез 1):

- [x] **Десктопный transport console** (план §7): под stage — панель с primary play/pause (та же `handlePlayButton`), статусом + прогрессом и layer-переключателями с иконкой И видимой подписью (`aria-pressed` сохранён). Сцена и так занимает основное пространство (`.page--play` overflow:hidden + `.play-media` flex:1)
- [x] Мобильная layerbar/meta/большая кнопка скрыты только на десктопе (`.desktop-main`); ниже 1180px всё 1:1 без изменений
- [x] Fullscreen остаётся на сцене (якорный `.play-fs`) — без дублирующего контрола в консоли (план §7 упоминает fullscreen в консоли, но дубликат не нужен)
- [x] Laptop-плотность: `flex-wrap: wrap` + уменьшенные pill-кнопки до 1359px — консоль (~760px) не выпадает из workspace при открытых обеих панелях на границе 1180px
- [x] `tsc --noEmit` + `vite build` — OK; code-review пройден

Осталось (Phase 7):

- [ ] Ревалидация fullscreen, subtitles, layer toggles, внешнего seek, soft refresh (Phase 9 runtime-прогон)

## Phase 8 — Assistant и secondary-экраны — первый срез сделан

Сделано (этап 2, срез 1):

- [x] **Assistant как десктопный dock** (план §8): клик по AI-чипу в десктопном header открывает оверлей-панель справа (26rem, ниже header, z-60 — ниже модалок), НЕ роут — workspace под ней сохраняет состояние. `AiAssistantPage` получила props `embedded`/`onClose`: стрелка «назад» заменяется на кнопку закрытия (`IconClose`), роут-заголовок не затирается (`setSecondaryTitle` загарден `if (embedded)`)
- [x] Закрытие: Escape / кнопка закрытия / повторный клик по чипу; единый `closeAssistant` возвращает фокус на чип (план §11 — focus restoration); `aria-expanded` + active-класс на чипе
- [x] Modal списка сессий внутри dock не конфликтует с Escape (lib/ui Modal закрывается только по backdrop-клику)
- [x] **Secondary-маршруты в шелле** (план §4.4/§8): settings/library/workflows/dev и deep-link `/ai` рендерятся внутри DesktopWorkspace как центральный контент с компактной back-бар (заголовок из `secondaryTitle`/пути); на мобильном `.secondary`-обёртка не тронута. `.desktop-main` стал flex-column; `.settings-page` сохраняет pinned-footer scroll-модель
- [x] `tsc --noEmit` + `vite build` — OK; code-review пройден

## Phase 9 — Responsive integration и usability pass — статический аудит сделан

Сделано (этап 2, срез 1 — статический аудит + фиксы; runtime-прогон требует браузера):

- [x] **Черновик редактора переживает смену режима/роут** (план §1.1/§14, закрыт gap из Phase 5/8): модульный `storedDraft` в EditPage — при unmount с dirty-черновиком на десктопе snapshot кладётся в store, при следующем mount восстанавливается (та же позиция → поля возвращаются напрямую, помечаются dirty; другая позиция → существующий recover-modal «Вернуться к черновику»). Мобильный поведение не тронуто. `tabRef`/`overrideBlocksRef` исключают stale closures
- [x] **Фикс pre-existing бага**: восстановленные passport-override блоки больше не перезаписываются каноническим ребуилдом `ensurePassportBlocks` после reload — одноразовый `preserveBlocksRef` (применён и к mount-restore, и к in-mount `restoreDraft`)
- [x] **First-run / no-book состояние** (план §4.2): `DesktopStartState` стал ориентирующим — заголовок + описание + две кнопки: «Открыть» (разворачивает File-панель и через событие `animastor:open-file` открывает пикер постоянно смонтированной FilePage) и «Создать с ИИ» (открывает assistant dock в create-режиме). `/file` с открытой книгой теперь показывает FilePage в центре (как мобильная вкладка)
- [x] `prefers-reduced-motion`: десктопные анимации (dock-in, пульсы статуса генерации и summary) отключаются
- [x] Статический аудит: все новые десктопные контролы имеют доступные имена (aria-label/title/текст); длинные RU-метки эллипсируются (header, posbar, panel title, nav); брейкпоинт 1180px — CSS-пиксели, поэтому 200% zoom на 1920px переводит в мобильную композицию (задокументированное поведение)
- [x] i18n-ключи (ru/en); `tsc --noEmit` + `vite build` — OK; code-review пройден

Осталось (Phase 9):

- [ ] Runtime-прогон ширин 900/1024/1280/1366/1440/1920 + 200% zoom, ru/en, dark/light, no-book/loading/error/running — нужен браузер/дев-сервер
- [ ] Сценарии open → generate → monitor → navigate → play → edit → save → regenerate → play — runtime-прогон
- [ ] Mouse/keyboard/screen-reader семантика — runtime-прогон (статика проверена)

## Инструмент: Desktop Web Tester (`tools/desktop-web-tester`)

Сделан Android-«эмулятор десктопа» для оценки дизайна на планшете (клон
`tools/mobile-web-tester`, applicationId `com.animastor.desktop`):

- WebView на весь экран, landscape; десктопный user-agent
- CSS viewport принудительно 1280/1366/1440/1920 px — HTML главного фрейма
  перехватывается в `shouldInterceptRequest`, content `<meta name="viewport">`
  целиком заменяется на `width=N` (без `initial-scale`, чтобы
  `loadWithOverviewMode` уместил весь макет на экран); включается десктопный
  шелл (порог >= 1180px)
- pinch-zoom доступен (разглядывать мелкий макет); Basic Auth автоматически
  (Authorization header в перехвате + `HttpAuthHandler` fallback); fullscreen
  API заблокирован; долгое нажатие ⟳ — сброс cookies/кэша
- APK: `build-apk.sh` → net-disk → `https://animastor.in/net-disk/desktop-web-tester.apk`
  (сборка с `-PTESTER_URL=...` / `-PTESTER_WIDTH=...`)

## Phase 10 — Final polish — статический слайс сделан

Сделано (план §10/§11 — первый статический слайс):

- [x] **Таргеты и hover/focus**: частые primary-действия доведены до 40px (mode-переключатель, Save, Generate/Stop, Play, layer-тогглы, start-state кнопки); навигация редактора и «Открыть в плеере» — 38px; единые `transition: background-color .15s` на всех десктопных контролах (модальные hover-состояния, `.btn` в gen-desk-bar и start-state — `.btn--outlined:hover`)
- [x] **Tooltips для icon-only контролов** (план §11): settings-шестерёнка, обе кнопки collapse панелей, back-кнопка secondary-бара и мобильного Toolbar получили `title` (aria-label сохранён — SR использует aria-label, hover показывает tooltip)
- [x] **Truncation длинных RU-меток**: `gen-desk-bar__summary` — max-width 16rem + `flex-shrink:1; min-width:0` + ellipsis (настоящий shrink при узком workspace); подпись layer-пиллов плеера — ellipsis через `> span`
- [x] **prefers-reduced-motion — blanket**: внутри `.desktop-shell` все анимации и транзишены схлопываются до 0.01ms (`animation-iteration-count:1`). Мобильный tabbar (tab-pulse SUCCESS) вне шелла — не затронут; gen-pulse воркеров на десктопе корректно отключается
- [x] Контраст: текст-2 на surface (тёмный #B8AFA3/#1B1816, светлый #6B6258/#FAF7F0) — читаемо; длинные промпты остаются в 12.5rem+ resize-able area (проверено статически)
- [x] `tsc --noEmit` + `vite build` — OK; code-review пройден (дубли transition объединены в основные правила, summary получил настоящий shrink)

Осталось (runtime): прогон в браузере/тестере — ширин, hover/focus табов, tooltips, reduced-motion (нужен Chrome/планшет).

---

## Прогресс

Обновлять статусы по мере выполнения; после каждого этапа — краткая заметка
здесь и в [`01-MIGRATION-PLAN.md`](01-MIGRATION-PLAN.md) (при необходимости),
затем коммит + push в `origin/master`.
