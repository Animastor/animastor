# 02. Design and UX Preservation Principles

Core project rule: the mobile web version **closely replicates** the
Android app in design, logic, and user experience. Any deviation is
pre-documented and justified in
[`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md).

---

## 1. Four preservation principles

### 1.1. Maximize visual preservation

- Migrate **design tokens** from `res/values/colors.xml` and `themes.xml` to CSS
  custom properties (`--cinema-background`, `--cinema-primary`, …). Dark
  "cinema" theme — default entry point (like Android `Theme.Animastor` =
  `Theme.Animastor.CinemaDark`).
- Preserve `cinema_*` palette: `cinema_background`, `cinema_surface`,
  `cinema_surface_variant`, `cinema_primary`, `cinema_accent`, `cinema_error`,
  `cinema_text_primary/secondary`, `cinema_outline[_variant]`, `cinema_scrim`,
  `subtitle_background`, `cinema_missing_bg`. Full list — table in
  [`04-MAPPING-TABLES.md`](04-MAPPING-TABLES.md) §3.
- Preserve Material 3 **rounded corners**: small=12, medium=18, large=28 dp (→ rem
  by density).
- Preserve player **shape exceptions**: `ChevronLeft`/`ChevronRight` (12dp on
  one side, 0 on other) for layer chips.
- Re-encode vector drawable `ic_*.xml` to SVG and connect as
  `mask-icon`/inline SVG (`currentColor` color-tint), so `app:tint` →
  CSS `color`.
- Preserve typography: `sans-serif-medium`, sizes `15sp`/`16sp`/`11sp`,
  `textAllCaps`, `letterSpacing` (e.g., `0.08` for "not generated" overlay).

### 1.2. Maximize screen layout preservation

- **Bottom bar with 5 tabs** (`bottom_nav.xml`): `File · Generate · Play ·
  Edit · Navigate` — same order. Home screen is `File`.
- Each `fragment_*.xml` structure migrated one-to-one to page
  layout ( ConstraintLayout `constraints` → CSS Grid/Flexbox, `layout_*`
  constraints preserved as DOM order and anchor links).
- Preserve player vertical rhythm: media viewport top, layer bar, big play
  button, progress bar, status text (see `fragment_play.xml`).
- Secondary screens open "above" tabs (full-screen route), like
  Android `addToBackStack`.

### 1.3. Maximize control placement preservation

- Player layer chips (`layerAudio/Image/Video/Subtitles`) — horizontal row
  48dp with icon-only and icon-toggle by `checked`.
- Big play button — `56dp`, `cornerRadius 18dp`, full-width with `margin 16dp`,
  `marginBottom 20dp`.
- Fullscreen button — `44dp`, `bottom|end`, `margin 14dp`, tint `#FFFFFF`,
  shown over media viewport, positioned accounting for letterbox and
  subtitles (`anchorFullscreenToImage()` logic).
- Toolbar with settings and AI button at top; generation status icon
  pulsation `Generate` (running/error/success) — migrate as CSS `alpha` animation.
- Mode chips `mode_chip_*`, topic chips `topic_chip_*`, layer chips `layer_chip_*`,
  toggle chips `toggle_chip_*` — same colors/borders/icons. (`worker_chip_*` —
  removed old architecture toolbar chips, replaced by worker section
  toggles `toggle_chip_*` on Generator screen.)

### 1.4. Maximize user scenario preservation

**Cross-cutting flows** from `docs/01-overview/DATA_FLOW.md` are preserved:

1. **Book import** (`File`): `.vbook` file/text → `POST /api/v1/book/import`
   (multipart) → open book → auto-navigate to `Generate`/`Play`.
2. **Generation** (`Generate`): start generation, SSE/plain progress,
   status indicator on tab icon (running/error/success), signal
   `playbackPrepared` → `Play`.
3. **Play**: scene queue, preloading **3 scenes ahead**, IU-cycling with
   subtitles, gapless scene transitions, audio/image/video/subtitle layers,
   fullscreen, seek by unitIndex, external seek from `Navigate`/`Edit`.
4. **Edit**: scene/unit timeline, audio waveform representation, editable
   timings (`PUT /scene/.../timings`), layer config.
5. **Navigate**: chapter/scene/unit map with navigation → `Play.seekToPosition`.
6. **Settings**: theme (dark/light/auto), language (ru/en/auto), book data,
   export/download, Workflow Manager→Details→TypeList→DeveloperView,
   VBook/Worker settings, AiAssistant (chat with session history), Library (WebView
   help/release-notes).

## 2. Cross-platform limitations requiring documentation

Browser ≠ Android in several aspects; each deviation documented in
[`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md):

| Aspect | Android | Web plan |
|---|---|---|
| Media player | `MediaPlayer` ×3 (current/next audio + video) | Web Audio API + `<audio>` + `<video>` (details — Player risk) |
| Video surface | `SurfaceView` | `<video>`/`<canvas>` |
| Background/card navigation | `onHiddenChanged`, lifecycle | visibility route + Page Visibility API |
| Cache | `SimpleDiskCache` | Cache API + IndexedDB |
| File associations | `ACTION_VIEW` for `.vbook` | `<input type=file>` + drag-drop; deep link `?book=` |
| Fonts/density | `dp/sp` | `rem`/`vh` + `prefers-reduced-motion` |

## 3. Design preservation verification (acceptance criteria)

For each screen:

- ✅ Controls composition and order from `fragment_*.xml` matches.
- ✅ Colors/rounded corners/icons match token table.
- ✅ Tab/button/gesture behavior matches.
- ✅ Text from `strings.xml` (ru + en) matches for all visible strings.
- ✅ Key scenarios from §1.4 reproduce on real backend.
- ✅ Justified deviations (if any) documented in
  [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md).
