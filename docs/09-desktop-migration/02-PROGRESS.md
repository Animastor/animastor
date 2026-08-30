# Mobile Web → Desktop Migration — Progress Tracker

Plan source: [`01-MIGRATION-PLAN.md`](01-MIGRATION-PLAN.md)
Section rule: [`README.md`](README.md)

Statuses: `[ ]` pending · `[~]` in_progress · `[x]` done

> **2026-08-12 — Domain migration:** app now lives on `app.animastor.in`
> (instead of `m.animastor.in`), directory `frontends/mobile` renamed to `frontends/app`.
> References to old paths below are historical (see `ARCHITECTURE.md` at root).

---

## Phase 1 — Audit ✅ (complete in plan)

- [x] Mobile screen map, routes, stores, tokens, themes, languages and adaptive mechanisms
- [x] Confirmed: target folder — `frontends/mobile/`; `frontends/main/` — only static `index.html`, not desktop app
- [x] Reuse / adaptation / new component boundaries described (plan §9)

## Phase 2 — Desktop information architecture

- [~] Concept confirmed by plan; exact breakpoints/widths — after visual prototypes
- [ ] Navigator selection behavior and File auto-collapse decision before code (draft — plan §3.2/§4.2/§4.3)

## Phase 3 — Design-system adaptation

- [ ] Desktop layout tokens (header/panels/gap) without changing palette and typography
- [ ] Primitives: panel, rail, mode-switcher, tooltip, focus

## Phase 4 — Navigation shell (prototype done, needs refinement)

Done by gpt-5.6-terra (commits `60d7240` → `7666de4`, pushed to `origin/master`):

- [x] `AppShell.tsx`: `DesktopWorkspace` branch beyond `min-width: 1180px` breakpoint
- [x] Desktop header: brand, book name (`GET /book/{id}`), position (chapter·scene·unit), generation status (idle/running/error/success + pulse), AI, settings
- [x] Mode switcher Generator/Player/Editor (segmented, icon+label, `aria-current`)
- [x] File panel left (embeds `FilePage`), Navigator panel right (embeds `NavigatePage`)
- [x] Both panels collapsible with selection persisted in `localStorage` (`animastor_desktop_panels`)
- [x] Laptop workspace prioritization (`@media (max-width: 1359px)`) in `base.css`
- [x] `tsc --noEmit` + `vite build` — OK

Remaining (Phase 4 → refinement):

- [ ] First-run/no-book state: File expanded + orienting empty-state in center (currently — `DesktopStartState` stub)
- [ ] Open book → compact rail (optional, opt-in, no auto-collapse during actions)
- [ ] Navigation mode: unit selection should not force mode switch (currently `NavigatePage` routes to `/play` — desktop semantics)
- [ ] Secondary screens (settings/workflows/library) in shell

## Phase 5 — Editor (highest priority) — first slice done

Done (stage 2, commit see git log):

- [x] Desktop two-column Editor layout inside `.desktop-main`: left — unit carousel + waveform (preview column, ~44%), right — tabs + fields + Save (inspector). Mobile composition below 1180px untouched (all rules under `.desktop-main`)
- [x] `image.prompt` / `video.action` — prompt editors: always textarea (rows 8), class `edit-field--prompt`, min-height 200px (160px on laptop), resize: vertical, word wrap, character limit preserved. Desktop shell only (`useDesktopShell`) — mobile field rendering unchanged
- [x] Ctrl/Cmd+S saves dirty draft (`e.code === 'KeyS'` — independent of RU/EN keyboard layout)
- [x] Editor posbar on desktop — informational breadcrumb (click doesn't route to `/navigate`, since Navigator is already on right)
- [x] `useDesktopShell` exported from `AppShell.tsx` for reuse
- [x] `tsc --noEmit` + `vite build` — OK; code review passed

Done (stage 2, slice 2):

- [x] **Desktop editor header** (plan §5.1/§5.2): breadcrumb (position), Unit N/M, prev/next buttons (disabled at boundaries), save state (Saving/Unsaved/Saved — text + color, not color separately), persistent Save. Mobile posbar hidden on desktop (`display: none`), mobile Save button also — one explicit Save per composition
- [x] **Draft protection** (plan §5.2, risk §14): `requestUnitNavigation` — when dirty draft on desktop, confirm shown (Save and navigate / Don't save and navigate / Cancel). "Save and navigate" continues navigation only on successful save (`saveToBackend` now returns `Promise<boolean>`, all paths return true/false)
- [x] Escape closes confirm-modal + scroll-lock; autofocus on safe action (Cancel)
- [x] Carousel (prev/next) also goes through `requestUnitNavigation`
- [x] New i18n keys in ru/en; `tsc --noEmit` + `vite build` — OK; code review passed

Done (stage 2, slice 3):

- [x] **Preview stage + thumbnail rail** (plan §5.3): on desktop instead of 3-card carousel — bounded canvas of current unit (`object-fit: contain`, click → existing full-size zoom, hover tooltip zoom) + horizontal scroll rail of current scene units (thumbnails with number, active — accent border, `aria-current`)
- [x] Thumb click → `jumpToUnit` (position + seek, same semantics as in-scene `navigateUnit` branch) via draft protection (`requestUnitJump`; jump to active unit — no-op without prompt)
- [x] Shared `previewUrl` helper reused in all three renders (stage / rail / mobile carousel)
- [x] Rail empty state (`edit_rail_empty`), lazy loading, a11y: buttons without false listbox pattern
- [x] `tsc --noEmit` + `vite build` — OK; code review passed

Done (stage 2, slice 4):

- [x] **Draft protection on external navigation** (plan §5.2, risk §14): position observer in EditPage on external position change (Navigator click, AI, deep link) with dirty draft on desktop takes snapshot (position/tab/fields/override blocks) and shows modal "Return to draft / Lose changes" — instead of silent long prompt loss. `restoringRef` protects restored fields from re-clearing by observer
- [x] **Navigator click on desktop doesn't route to `/play`** (plan §4.3): unit selection updates shared position, workspace mode stays; mobile preserves Android `switchToPlayTab()` below 1180px
- [x] **`useDesktopShell` + `DESKTOP_SHELL_QUERY` moved to `src/app/desktop.ts`** — eliminated circular import AppShell ↔ NavigatePage; imported by AppShell/EditPage/NavigatePage
- [x] Structured `lastPosRef` instead of position key string parsing
- [x] i18n recover-modal keys (ru/en); `tsc --noEmit` + `vite build` — OK; code review passed

Done (stage 2, slice 5):

- [x] **Arrow-key unit navigation** (plan §5.3/§11): Left/Right move active unit on desktop when focus is outside input/textarea/select/contenteditable; doesn't fire when zoom/confirm/recover modals open. Text hotkeys not intercepted
- [x] Auto-scroll active thumb in rail (`scrollIntoView inline:nearest`) on unit change — active unit stays in view without stealing focus
- [x] `tsc --noEmit` + `vite build` — OK; code review passed

Done (stage 2, slice 6):

- [x] **Explicit "Open in Player" in Navigator** (plan §4.3): single click on unit on desktop only selects position; double click or play button on active row (icon, `aria-label`+tooltip) — explicit switch to Player. Button — sibling element next to select button (not nested button); row wrapper `.nav-unit-row` handles margin; mobile click still routes to `/play`
- [x] i18n `navigate_open_in_player` (ru/en); `tsc --noEmit` + `vite build` — OK; code review passed

Remaining (Phase 5):

- [ ] Optional: collapse Navigator in Editor mode on laptop
- [ ] Known gap (Phase 9): mode/route change unmounts EditPage — unsaved draft lost on explicit "Open in Player" or mode switch (existing protection only covers position change while editor mounted). Plan §1.1/§14: mode-preserving mount or draft guard on mode exit

## Phase 6 — Generator — first slice done

Done (stage 2, slice 1):

- [x] **Control room** (plan §6): on desktop `.gen-page` — grid: header row (position · active tasks · Generate All/Stop All) + worker cards in 2 columns on wide (>=1360px), 1 readable column on laptop (max-width 1359px). Mobile composition below 1180px untouched (all under `.desktop-main`, JS gated by `isDesktop`)
- [x] **Active-jobs summary** in header (text + color, not color separately): "N tasks running" / "Generating…" / "No active tasks", pulse while working. `isGenerating` covers poll-gap (1.5s) and VBook COMPLETED row display window (10s, `isRegenerating`) — header never shows idle during real work
- [x] Posbar on desktop hidden (informational breadcrumb in header; click doesn't route to `/navigate`); mobile Global card hidden — its actions moved to header
- [x] Poll lifecycle, scope dialog, cancel — no semantics changes (layout only)
- [x] **ScopeDialog**: initial focus on Cancel, Escape cancels, scroll-lock; `onCancel` in ref + subscription once — focus not stolen by Cancel button on parent re-renders every 500ms (timer tick)
- [x] i18n keys (ru/en); `tsc --noEmit` + `vite build` — OK; code review passed

Remaining (Phase 6):

- [ ] Poll lifecycle, scope dialog, cancel, error validation on mode switches (Phase 9 runtime run)

## Phase 7 — Player — first slice done

Done (stage 2, slice 1):

- [x] **Desktop transport console** (plan §7): below stage — panel with primary play/pause (same `handlePlayButton`), status + progress and layer toggles with icon AND visible label (`aria-pressed` preserved). Scene already takes main space (`.page--play` overflow:hidden + `.play-media` flex:1)
- [x] Mobile layerbar/meta/big button hidden only on desktop (`.desktop-main`); below 1180px everything 1:1 unchanged
- [x] Fullscreen stays on scene (anchored `.play-fs`) — no duplicate control in console (plan §7 mentions fullscreen in console, but duplicate not needed)
- [x] Laptop density: `flex-wrap: wrap` + reduced pill buttons up to 1359px — console (~760px) doesn't fall out of workspace with both panels open at 1180px boundary
- [x] `tsc --noEmit` + `vite build` — OK; code review passed

Remaining (Phase 7):

- [ ] Re-validation of fullscreen, subtitles, layer toggles, external seek, soft refresh (Phase 9 runtime run)

## Phase 8 — Assistant and secondary screens — first slice done

Done (stage 2, slice 1):

- [x] **Assistant as desktop dock** (plan §8): click on AI chip in desktop header opens overlay panel on right (26rem, below header, z-60 — below modals), NOT a route — workspace below preserves state. `AiAssistantPage` received `embedded`/`onClose` props: back arrow replaced by close button (`IconClose`), route title not overwritten (`setSecondaryTitle` guarded `if (embedded)`)
- [x] Close: Escape / close button / re-click chip; single `closeAssistant` returns focus to chip (plan §11 — focus restoration); `aria-expanded` + active class on chip
- [x] Session list modal inside dock doesn't conflict with Escape (lib/ui Modal closes only on backdrop click)
- [x] **Secondary routes in shell** (plan §4.4/§8): settings/library/workflows/dev and deep-link `/ai` render inside DesktopWorkspace as central content with compact back bar (title from `secondaryTitle`/path); mobile `.secondary` wrapper untouched. `.desktop-main` became flex-column; `.settings-page` preserves pinned-footer scroll model
- [x] `tsc --noEmit` + `vite build` — OK; code review passed

## Phase 9 — Responsive integration and usability pass — static audit done

Done (stage 2, slice 1 — static audit + fixes; runtime run requires browser):

- [x] **Editor draft survives mode/route change** (plan §1.1/§14, gap closed from Phase 5/8): modular `storedDraft` in EditPage — on unmount with dirty draft on desktop, snapshot stored in store, on next mount restored (same position → fields returned directly, marked dirty; different position → existing recover-modal "Return to draft"). Mobile behavior untouched. `tabRef`/`overrideBlocksRef` prevent stale closures
- [x] **Pre-existing bug fix**: restored passport-override blocks no longer overwritten by canonical `ensurePassportBlocks` rebuild after reload — one-shot `preserveBlocksRef` (applied to both mount-restore and in-mount `restoreDraft`)
- [x] **First-run / no-book state** (plan §4.2): `DesktopStartState` became orienting — title + description + two buttons: "Open" (expands File panel and via `animastor:open-file` event opens picker of permanently mounted FilePage) and "Create with AI" (opens assistant dock in create mode). `/file` with open book now shows FilePage in center (like mobile tab)
- [x] `prefers-reduced-motion`: desktop animations (dock-in, generation status pulses and summary) disabled
- [x] Static audit: all new desktop controls have accessible names (aria-label/title/text); long RU labels ellipsed (header, posbar, panel title, nav); 1180px breakpoint — CSS pixels, so 200% zoom on 1920px switches to mobile composition (documented behavior)
- [x] i18n keys (ru/en); `tsc --noEmit` + `vite build` — OK; code review passed

Remaining (Phase 9):

- [ ] Runtime run of widths 900/1024/1280/1366/1440/1920 + 200% zoom, ru/en, dark/light, no-book/loading/error/running — needs browser/dev server
- [ ] Scenarios open → generate → monitor → navigate → play → edit → save → regenerate → play — runtime run
- [ ] Mouse/keyboard/screen-reader semantics — runtime run (static checked)

## Tool: Desktop Web Tester (`tools/desktop-web-tester`)

Built Android "desktop emulator" for design evaluation on tablet (clone
`tools/mobile-web-tester`, applicationId `com.animastor.desktop`):

- WebView full screen, landscape; desktop user-agent
- CSS viewport forced 1280/1366/1440/1920 px — main frame HTML
  intercepted in `shouldInterceptRequest`, content `<meta name="viewport">`
  entirely replaced with `width=N` (no `initial-scale`, so
  `loadWithOverviewMode` fits full layout on screen); desktop shell
  enabled (threshold >= 1180px)
- pinch-zoom available (inspect small layouts); Basic Auth automatic
  (Authorization header in intercept + `HttpAuthHandler` fallback); fullscreen
  API blocked; long-press ⟳ — clear cookies/cache
- APK: `build-apk.sh` → net-disk → `https://animastor.in/net-disk/desktop-web-tester.apk`
  (build with `-PTESTER_URL=...` / `-PTESTER_WIDTH=...`)

## Phase 10 — Final polish — static slice done

Done (plan §10/§11 — first static slice):

- [x] **Targets and hover/focus**: frequent primary actions brought to 40px (mode switcher, Save, Generate/Stop, Play, layer toggles, start-state buttons); editor navigation and "Open in Player" — 38px; unified `transition: background-color .15s` on all desktop controls (modal hover states, `.btn` in gen-desk-bar and start-state — `.btn--outlined:hover`)
- [x] **Tooltips for icon-only controls** (plan §11): settings gear, both panel collapse buttons, secondary bar back button and mobile Toolbar received `title` (aria-label preserved — SR uses aria-label, hover shows tooltip)
- [x] **Truncation of long RU labels**: `gen-desk-bar__summary` — max-width 16rem + `flex-shrink:1; min-width:0` + ellipsis (real shrink in narrow workspace); player pill labels — ellipsis via `> span`
- [x] **prefers-reduced-motion — blanket**: inside `.desktop-shell` all animations and transitions collapsed to 0.01ms (`animation-iteration-count:1`). Mobile tabbar (tab-pulse SUCCESS) outside shell — untouched; worker gen-pulse on desktop correctly disabled
- [x] Contrast: text-2 on surface (dark #B8AFA3/#1B1816, light #6B6258/#FAF7F0) — readable; long prompts stay in 12.5rem+ resize-able area (statically verified)
- [x] `tsc --noEmit` + `vite build` — OK; code review passed (duplicate transitions merged into base rules, summary got real shrink)

Remaining (runtime): run in browser/tester — widths, hover/focus tabs, tooltips, reduced-motion (needs Chrome/tablet).

---

## Progress

Update statuses as work proceeds; after each stage — brief note
here and in [`01-MIGRATION-PLAN.md`](01-MIGRATION-PLAN.md) (if needed),
then commit + push to `origin/master`.
