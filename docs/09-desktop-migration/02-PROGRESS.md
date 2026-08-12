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

## Phase 5 — Editor (наивысший приоритет) — в работе

- [~] Десктопный layout Editor: preview + inspector в 2 колонки (этап 2)
- [ ] Промпт-редакторы `image.prompt` / `video.action` (крупные textarea, лимит, resize)
- [ ] Save/dirty-состояние в header редактора + Ctrl/Cmd+S
- [ ] Безопасная навигация по юнитам (без потери черновика)
- [ ] Интеграция waveform и карусели/thumbnail rail

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
