# 02. Принципы сохранения дизайна и UX

Основное правило проекта: мобильная веб-версия **максимально повторяет**
Android-приложение по дизайну, логике и пользовательскому опыту. Любое
отклонение предварительно документируется и обосновывается в
[`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md).

---

## 1. Четыре принципа сохранения

### 1.1. Максимально сохранить внешний вид

- Перенести **дизайн-токены** из `res/values/colors.xml` и `themes.xml` в CSS
  custom properties (`--cinema-background`, `--cinema-primary`, …). Тёмная
  тема «кинозал» — точка входа по умолчанию (как в Android `Theme.Animastor` =
  `Theme.Animastor.CinemaDark`).
- Сохранить палитру `cinema_*`: `cinema_background`, `cinema_surface`,
  `cinema_surface_variant`, `cinema_primary`, `cinema_accent`, `cinema_error`,
  `cinema_text_primary/secondary`, `cinema_outline[_variant]`, `cinema_scrim`,
  `subtitle_background`, `cinema_missing_bg`. Полный список — таблица в
  [`04-MAPPING-TABLES.md`](04-MAPPING-TABLES.md) §3.
- Сохранить **скругления** Material 3: small=12, medium=18, large=28 dp (→ rem
  по плотности).
- Сохранить **shape-исключения** плеера: `ChevronLeft`/`ChevronRight` (12dp с
  одной стороны, 0 с другой) для чипов-слоёв.
- Перекодировать векторные drawable `ic_*.xml` в SVG и подключить как
  `mask-icon`/inline SVG (_color-tint по `currentColor`), чтобы `app:tint` →
  CSS `color`.
- Сохранить типографику: `sans-serif-medium`, размеры `15sp`/`16sp`/`11sp`,
  `textAllCaps`, `letterSpacing` (например `0.08` для overlay «не сгенерировано»).

### 1.2. Максимально сохранить расположение экранов

- **Нижняя панель из 5 вкладок** (`bottom_nav.xml`): `File · Generate · Play ·
  Edit · Navigate` — тот же порядок. Стартовый экран — `File`.
- Структура каждого `fragment_*.xml` переносится один-в-один в разметку
  страницы (ConstraintLayout-`constraints` → CSS Grid/Flexbox, `layout_*
  constraints` сохраняются как DOM-порядок и anchor-связи).
- Сохранить вертикальный ритм плеера: media viewport сверху, layer bar, big play
  button, progress bar, status text (см. `fragment_play.xml`).
- Вторичные экраны открываются «поверх» вкладок (full-screen route), как в
  Android `addToBackStack`.

### 1.3. Максимально сохранить расположение элементов управления

- Чипы-слои плеера (`layerAudio/Image/Video/Subtitles`) — горизонтальный ряд
  48dp с icon-only и icon-toggle по `checked`.
- Big play button — `56dp`, `cornerRadius 18dp`, full-width с `margin 16dp`,
  `marginBottom 20dp`.
- Fullscreen-кнопка — `44dp`, `bottom|end`, `margin 14dp`, tint `#FFFFFF`,
  показывается поверх media viewport, позиционируется с учётом letterbox и
  субтитров (логика `anchorFullscreenToImage()`).
- Toolbar со settings-кнопкой и AI-кнопкой сверху; статус-генерации пульсация
  иконки `Generate` (running/error/success) — перенести как CSS-анимация `alpha`.
- Чипы режимов `mode_chip_*`, тем `topic_chip_*`, слоёв `layer_chip_*`,
  тогглов `toggle_chip_*` — те же цвета/обводки/иконки. (`worker_chip_*` —
  удалённые тулбар-чипы старой архитектуры, вместо них тогглы секций
  воркеров `toggle_chip_*` на экране Generator.)

### 1.4. Максимально сохранить пользовательские сценарии

Сохраняются **сквозные потоки** из `docs/01-overview/DATA_FLOW.md`:

1. **Импорт книги** (`File`): файл `.vbook`/текст → `POST /api/v1/book/import`
   (multipart) → открытие книги → авто-переход на `Generate`/`Play`.
2. **Генерация** (`Generate`): запуск генерации, прогресс по SSE/plain,
   индикация статуса на иконке вкладки (running/error/success), сигнал
   `playbackPrepared` → `Play`.
3. **Play**: очередь сцен, preloading **на 3 сцены вперёд**, IU-cycling с
   субтитрами, gapless-переход между сценами, слои audio/image/video/subtitles,
   fullscreen, seek по unitIndex, внешний seek из `Navigate`/`Edit`.
4. **Edit**: таймлайн сцен/юнитов, waveform-представление аудио, изменяемые
   тайминги (`PUT /scene/.../timings`), слой-config.
5. **Navigate**: карта глав/сцен/юнитов с переходом → `Play.seekToPosition`.
6. **Settings**: тема (dark/light/auto), язык (ru/en/auto), данные о книге,
   экспорт/скачивание, Workflow Manager→Details→TypeList→DeveloperView,
   VBook/Worker settings, AiAssistant (чат с историей сессий), Library (WebView
   help/release-notes).

## 2. Кросс-платформенные ограничения, требующие фиксации

Браузер ≠ Android по нескольким аспектам; каждое отклонение фиксируется в
[`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md):

| Аспект | Android | Web план |
|---|---|---|
| Медиа-плеер | `MediaPlayer` ×3 (current/next audio + video) | Web Audio API + `<audio>` + `<video>` (детали — риск Player) |
| Surface для видео | `SurfaceView` | `<video>`/`<canvas>` |
| Фоновая/карточная навигация | `onHiddenChanged`, lifecycle | visibility route + Page Visibility API |
| Кэш | `SimpleDiskCache` | Cache API + IndexedDB |
| Файловые ассоциации | `ACTION_VIEW` для `.vbook` | `<input type=file>` + drag-drop; deep link `?book=` |
| Шрифты/ плотность | `dp/sp` | `rem`/`vh` + `prefers-reduced-motion` |

## 3. Проверка сохранения дизайна (критерии приёмки)

Для каждого экрана:

- ✅ Совпадает состав и порядок контролов из `fragment_*.xml`.
- ✅ Совпадают цвета/скругления/иконки по таблице токенов.
- ✅ Совпадает поведение вкладок/кнопок/жестов.
- ✅ Совпадает текст из `strings.xml` (ru + en) для всех видимых строк.
- ✅ Воспроизводятся ключевые сценарии из §1.4 на реальном backend.
- ✅ Зафиксированы (если есть) обоснованные отклонения в
  [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md).
