# Миграция Mobile Web → Desktop — трекер прогресса

Источник плана: [`01-MIGRATION-PLAN.md`](01-MIGRATION-PLAN.md)
Правило секции: [`README.md`](README.md)

Статусы: `[ ]` pending · `[~]` in_progress · `[x]` done

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

Осталось (Phase 5):

- [ ] Опционально: collapse Navigator в режиме Editor на laptop
- [ ] Двойной клик / явное «Open in Player» в Navigator на десктопе (план §4.3 — сейчас выбор юнита только меняет позицию)

## Phase 6 — Generator

- [ ] Раскладка воркер-карточек (grid, 2 колонки на wide)
- [ ] Глобальный job summary / status handoff в header
- [ ] Проверка poll lifecycle, scope dialog, cancel, ошибок при смене режимов

## Phase 7 — Player

- [ ] Большая сцена + desktop transport console
- [ ] Ревалидация fullscreen, subtitles, layer toggles, внешнего seek, soft refresh

## Phase 8 — Assistant и secondary-экраны

- [ ] Выделить контент Assistant из route-оболочки; монтировать в sheet/dock
- [ ] Settings/Library/workflows в шелле

## Phase 9 — Responsive integration и usability pass

- [ ] Прогон ширин 900/1024/1280/1366/1440/1920 + 200% zoom, ru/en, dark/light, no-book/loading/error/running
- [ ] Сценарии: open → generate → monitor → navigate → play → edit prompts → save → regenerate → play
- [ ] Mouse/keyboard/screen-reader семантика и восстановление фокуса

## Phase 10 — Final polish

- [ ] Отступы, выравнивание, анимации панелей, hover/focus, empty states, truncation, scrollbars
- [ ] Проверка контраста и длинных промптов/русских меток

---

## Прогресс

Обновлять статусы по мере выполнения; после каждого этапа — краткая заметка
здесь и в [`01-MIGRATION-PLAN.md`](01-MIGRATION-PLAN.md) (при необходимости),
затем коммит + push в `origin/master`.
