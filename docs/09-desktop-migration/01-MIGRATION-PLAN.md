# Animastor: migration from mobile UI to desktop UI

## Purpose and decision

This document is the implementation plan for a desktop presentation of the existing Animastor web application. Its purpose is **not** to create a second product or replace the mobile UI. Desktop reuses the current Preact application, routes, API client, stores, translations, theme tokens and domain components; it adds a desktop application shell and desktop variants of the workspace layouts.

The guiding principle is:

> Preserve the mobile visual language and functional logic; reorganise information and interaction for a mouse, keyboard and a larger working surface.

The proposed model is a contextual workspace:

```text
┌──────────── File rail ────────────┬────────────── Main workspace ──────────────┬──── Navigator ────┐
│ book actions / import / export    │  [Generator] [Player] [Editor]              │ chapters / scenes │
│ visible on first run, collapsible │  selected mode; state remains in stores     │ units / position  │
│                                   │  optional mode-specific panes               │ persistent/collap.│
└───────────────────────────────────┴─────────────────────────────────────────────┴───────────────────┘
                                                   ▲
                                  AI Assistant: contextual overlay / docked panel
```

This develops the supplied hypothesis, with two important refinements:

1. **File is a task drawer, not permanent global navigation.** It is expanded while no book is open and on a user’s first desktop visit; after a book is opened it becomes a compact rail by default. It must never auto-collapse in the middle of an import, export, error or keyboard interaction, and automatic collapse is a one-time, dismissible onboarding convenience—not a recurring surprise.
2. **Navigator is the persistent contextual outline.** It remains open by default on wide desktop because it controls the current book position, which Player, Generator and Editor share. On laptop it becomes collapsible; on narrow desktop it is an overlay drawer. It is not an unrelated floating window.

Generator, Player and Editor are therefore three **workspace modes**, rather than three permanently adjacent panes or three unrelated mobile pages. A segmented, icon-and-label mode bar in the desktop header makes the mode visible and fast to change, while their state remains in the existing shared stores.

## 1. Audit of the current mobile web UI

### 1.1 Technical baseline

The implemented mobile frontend lives in `frontends/mobile/`. It is a Preact + TypeScript + Vite SPA. `main.tsx` mounts one `AppShell` around a `preact-router` route tree. The current routes are:

| Area | Route | Current mobile purpose |
|---|---|---|
| File | `/file` (also `/`) | import by file picker or drag/drop, create with AI, Library, export book/storyboard/audio/video, status/progress |
| Generator | `/generate` | generation scope, VBook/audio/image/video worker controls, progress rows, cancellation and worker settings |
| Player | `/play` | media viewport, audio/image/video/subtitle layer controls, playback status and fullscreen |
| Editor | `/edit` | current position, unit carousel, waveform/timing edit, property tabs and saving |
| Navigator | `/navigate` | chapter → scene → unit outline and selection/seek |
| AI Assistant | `/ai` | chat sessions, modes, contextual book/position information and optional voice input |
| Secondary | `/settings`, `/library`, `/workflows`, `/dev` | settings, external library, workflow and developer configuration |

The existing navigation is a mobile bottom tab bar: File → Generator → Player → Editor → Navigator. The compact global toolbar contains the Animastor wordmark, AI button and Settings button. Secondary screens use a back toolbar.

The app already has a good non-visual separation that desktop must retain:

| Existing layer | Responsibility | Desktop consequence |
|---|---|---|
| `generateStore.ts` | open book/build, generation phase, worker toggles, progress, completion handoff | do not create desktop-only generation state |
| `playbackStore.ts` | playback state, media/layers, seek, video attachment, lifecycle | Player layout changes; playback engine does not |
| `positionStore.ts` | active chapter, scene and unit | Navigator and Editor must use this single source of truth |
| `api/*` | requests/models | no endpoint redesign is required for the layout phase |
| `app/theme.ts`, `app/i18n.ts` | day/night/auto and ru/en/auto | desktop reads the same tokens and strings |

The mobile route components are currently mounted by the router and their durable state is already held in module-level stores. Desktop mode changes must therefore avoid destructive remounting where it would detach the Player’s video or discard an editor draft. The new shell should preserve mounted mode panels where practical, or explicitly preserve ephemeral UI state in a workspace store.

### 1.2 Existing visual system

The design system is already defined in `src/styles/tokens.css`, `theme-dark.css`, `theme-light.css` and `base.css`:

- Cinema palette: burgundy primary (`--primary`), gold accent (`--accent`), warm dark/light surfaces and semantic success/error/warning colours.
- System UI / Segoe / Roboto typography, compact 11–15sp body scale and a 24sp title token.
- Rounded 12/18/28dp shape scale, restrained elevation, outlined cards and Material-like buttons/chips/tabs.
- Theme resolution (`auto`, `dark`, `light`) and language resolution (`auto`, `ru`, `en`) are local preferences applied on the document root.
- Focus-visible already uses the accent outline. Existing active/pressed states, progress animation, generation pulses, scrollbars, dialogs and fullscreen are reusable foundations.

The desktop version must introduce no competing colour palette, typeface or icon set. It may add desktop spacing, sizing and layout tokens, for example `--desktop-header-h`, `--file-panel-w`, `--navigator-panel-w`, `--workspace-gap` and `--editor-preview-min-w`, all derived from the existing token system.

### 1.3 Screen and component map

#### File

`FilePage` supplies a hidden file input, card actions for Open/Create/Library, native desktop drag-and-drop feedback, export availability rules, determinate and indeterminate progress, and error reporting. This is already a strong basis for a File sidebar. Its current single-column full-page card stack is mobile-specific.

#### Generator

`GeneratePage` has a position bar, Generate All / Stop All actions, four worker sections (VBook, audio, image, video), per-worker enable switches and settings, task progress rows, timers, worker availability counts, cancellation menu and a scope dialog. It polls server progress and worker counts; these semantics must remain unchanged. Its tall sequential card stack is mobile-specific.

#### Player

`PlayPage` provides the central cinema viewport: cover/curtains/current image/video, missing-IU state, subtitles, letterboxing/scrim, fullscreen, layer chips, status/progress and a play/pause action. `playbackStore` coordinates media, lifecycle, seeking and soft refresh after generation. This is reusable; the mobile vertical order of viewport → chips → status → large button needs a desktop console layout.

#### Navigator

`NavigatePage` loads and renders a nested book structure. Chapters and scenes expand/collapse, active unit is highlighted and scrolled into view, and unit selection updates the shared position, seeks playback and currently routes to Player. The tree, thumbnails, labels and position semantics are reusable. The standalone page and automatic switch to Player need a desktop-aware adaptation: selecting a unit should update the active workspace and only switch mode when the selection originated from an explicit “open in Player” action or a configured preference.

#### Editor

`EditPage` is the highest-value desktop workspace. It currently supplies:

- a position bar and unit count;
- previous/current/next image carousel with full-size image dialog;
- waveform and editable unit timing range;
- tabs for Scene, Audio, Unit, Characters, Voices, Locations and Global;
- editable values, local dirty state, character limits and backend save routing;
- `image.prompt` and `video.action` fields, currently generic vertical textareas;
- character, voice and location editors; scene passport overrides;
- explicit save, errors and server dirty-summary feedback.

The data model, save endpoints, field components, waveform and preview loading are reusable. The serial mobile flow—carousel, timeline, tab strip, vertically scrolling fields and fixed save button—requires a purpose-built desktop composition.

#### AI Assistant, settings and secondary screens

`AiAssistantPage` includes session list/new chat, assistant modes (conversation, import, editor, director, extraction, validation), contextual position information, text entry, send-on-Enter and Web Speech input. Settings, Library, Workflows and Developer tools exist as secondary routes. They need desktop containment and sizing, but do not need their product logic redesigned in this migration.

### 1.4 Existing responsive behaviour and gaps

The codebase is intentionally mobile-first. It uses full-height flex pages, a fixed-height toolbar and bottom tab bar, compact cards, scrollable tab strips, mobile-safe areas and a coarse-pointer scrollbar adaptation. There is currently no width breakpoint that creates desktop columns or a desktop navigation shell. `frontends/main/` contains only a static `index.html`, not a separate desktop application to extend.

Therefore desktop should be implemented inside `frontends/mobile/` as a responsive presentation at a defined width breakpoint. The current mobile composition must remain the fallback below that breakpoint.

## 2. Desktop UX principles

1. **One book, one shared position, one workspace.** The selected chapter/scene/unit is continuously visible in breadcrumb/status form and has the same meaning in Navigator, Player, Generator and Editor.
2. **Use persistent space only for frequent context.** Navigator earns persistent space on wide screens. File is initially discoverable but should not permanently consume space once book work begins. Settings, workflows and Assistant are on-demand.
3. **Keep the editing loop in view.** In Editor the user must be able to assess the unit, change prompts, save and move to the next unit without repeatedly opening drawers or scrolling through unrelated properties.
4. **Progress must be glanceable, not modal.** Generation status remains visible in the Generator mode and is also represented by a small status indicator in the workspace header. Running work must never disappear when the user changes to Player or Editor.
5. **Keyboard augments, never conflicts with text editing.** Arrow keys move units only outside an editable control; Escape closes the top-most dismissible surface; standard browser text editing shortcuts remain untouched.
6. **Progressive disclosure over a wall of panels.** Tabs, collapsible detail areas and optional inspector panes are preferred to simultaneous small cards. Panels have clear ownership and a meaningful empty state.
7. **Predictable persistence.** Mode, sidebar state and user-selected inspector subtab may persist locally. A current book, active position, draft status and generation state come from the existing stores/server, not duplicated layout state.

## 3. Desktop information architecture

### 3.1 Shell

At desktop widths the current `AppShell` becomes a `DesktopShell` variant. It contains:

- **Top workspace header:** Animastor brand; current book title/status; Generator/Player/Editor segmented mode navigation; compact generation indicator; Assistant; Settings/profile actions.
- **File panel (left):** import, create, library and exports; expanded when there is no book or the user asks for it; compact rail otherwise.
- **Main workspace (centre):** active Generator, Player or Editor mode.
- **Navigator panel (right):** book location, chapter/scene/unit tree, active unit and optional quick search/filter.
- **Transient layers:** dialogs, confirmation prompts, image zoom, menus and Assistant.

The header is the desktop primary navigation. The mobile bottom tab bar must remain active only in the mobile shell. File and Navigator are panel controls in desktop—not duplicate items competing with central mode tabs.

### 3.2 Critical evaluation of the proposed structure

The suggested “File | Generator/Player/Editor | Navigator, Assistant overlay” structure corresponds well to common creative desktop tools: assets/project on the left, main canvas in the centre, document outline/inspector on the right. It is the recommended direction, with these boundaries:

| Hypothesis | Decision | Rationale |
|---|---|---|
| File as visible left panel on first opening | Accept, conditional | It teaches new users how to open a book; once a book is open, a full panel is low-frequency and should compact |
| File auto-collapse | Limited opt-in behaviour | Collapse once after a successful open only if user has not manually pinned it; never make controls disappear while being used |
| Navigator as right panel | Accept | It is a high-frequency shared position controller and works as a document outline |
| Navigator permanently open | Wide desktop default; collapsible elsewhere | A 13–14 inch laptop cannot comfortably sustain three wide columns, especially in Editor |
| Generator/Player/Editor as central modes | Accept | They represent distinct tasks with the same book/position context; keeping all three visible would dilute the workspace |
| Assistant as separate full route | Replace on desktop with overlay/dock | Assistant must retain context and not take users away from their task |

The desktop UI must not show both a large File panel and a wide Navigator alongside an Editor inspector on ordinary laptop. The editor uses a mode-specific right inspector; in that mode Navigator collapses to a compact rail or slides over the workspace. This is an intentional exception to the otherwise persistent navigator.

### 3.3 Layout states and breakpoints

Breakpoints are behaviour thresholds, not device labels. Use container constraints and test at intermediate widths; the initial values below should be validated with real content and the Russian labels.

| Layout state | Suggested viewport | Shell behaviour |
|---|---:|---|
| Wide desktop | `>= 1440px` | header + optional 264–304px File panel + flexible centre + 280–336px Navigator; Editor may open its inspector in the centre/right workspace split |
| Standard laptop | `1100–1439px` | File defaults to 56–64px icon rail after book open; Navigator 272–304px open in Player/Generator, collapses in Editor when needed; no three equal columns |
| Narrow desktop/tablet landscape | `900–1099px` | centre workspace plus one overlay/collapsible side panel; mode bar remains labelled; Editor stacks preview and prompts within centre |
| Mobile | `< 900px` | retain the current toolbar, routed pages and bottom tab bar without desktop panels |

Initial dimensions:

- File expanded: 264–304px; compact rail: 56–64px.
- Navigator: 280–336px, with 240px minimum only when text has no truncation risk.
- Main workspace: minimum 640px in Player/Generator and 720px preferred in Editor.
- Desktop page padding: 20–32px; internal panel gap: 12–20px; retain existing 12/18/28px radii.
- Panels may be resized by a pointer drag only in wide desktop; constrain widths, offer a reset action and do not make resizing required for normal use.

## 4. Navigation and orientation

### 4.1 Header and mode switcher

The central mode switcher is a single segmented control or tab row with icon + localised label:

`Generator | Player | Editor`.

Player may be visually first or marked as the default content mode after a book opens, but Generator should remain prominent while no generated content exists. The selection is a mode, not a destructive route transition. Implementation may continue to update a route (`/generate`, `/play`, `/edit`) for deep links and browser history, while `DesktopShell` renders the corresponding desktop layout and preserves workspace state.

The header also shows:

- current book title, with an accessible compact breadcrumb/position (`Chapter / Scene / Unit`);
- a small Generator status button: idle, running, error or success using the existing pulse/status colours; clicking opens Generator;
- Assistant button and settings menu;
- controls to reveal/collapse File and Navigator panels.

### 4.2 File panel

The File panel groups actions rather than mirroring a stack of mobile cards:

1. **Open book** — large primary button and drop zone when no book is loaded.
2. **Create with AI** — opens Assistant in import/create context.
3. **Library** — secondary link.
4. **Current book** — title, build/phase summary and Close action only if that existing capability is safe to expose.
5. **Export** — grouped secondary actions, retaining existing availability rules and progress.

On first desktop load with no book, File is expanded and the main workspace shows an oriented empty state pointing to Open/Create. After a book is opened, retain the panel’s last explicit user state. If the user never explicitly changed it, it may compact once after completion. Compact rail buttons must have labels via tooltips and accessible names.

### 4.3 Navigator panel

Navigator uses the existing tree and shared `positionStore`, enhanced for desktop:

- compact current-position breadcrumb at the top;
- optional filter/search field above the tree (Phase 4 only after performance and matching rules are specified);
- chapter/scene expansion controls with 32–40px pointer targets;
- units with preview thumbnail, type and truncated text; active state uses existing accent-container/gold language;
- single-click selects active unit; double-click or an explicit Player action switches to Player; keyboard Enter selects, Right/Left expand and collapse the focused tree item;
- keep the active item in view without unexpectedly stealing focus.

Do not make every unit click forcibly route to Player on desktop: that would interrupt editing. A Navigator selection updates the shared position; the current mode stays unless the selected mode cannot show the selection or the user requested playback.

### 4.4 Secondary areas

Settings, workflows, developer tools and Library remain secondary routes. On desktop they open as full central content with the File/Navigator shell still available where useful, or as appropriately-sized modal/drawer surfaces for quick settings. They must not inherit the dense Editor workspace by accident.

## 5. Desktop Editor

### 5.1 Recommended editor composition

Editor has its own layout because it is a production workspace, not a form page. At wide desktop it uses a two-column centre workspace:

```text
┌─ Editor header: breadcrumb · Unit 12/28 · previous/next · Save state · Save ─────────────────────┐
│                                                                                                   │
│  Preview / unit rail (min 44%)                      Editing inspector (min 420px)                 │
│  ┌─────────────────────────────────┐               ┌ [Unit][Scene][Audio][Cast][Global] ┐        │
│  │ large current IU image/video     │               │                                      │        │
│  │ click to zoom; status overlay    │               │ selected property fields            │        │
│  │ ‹ previous · thumbnails · next › │               │                                      │        │
│  └─────────────────────────────────┘               │ Image prompt (large textarea)        │        │
│  waveform/timing, collapsible                        │ Video action (large textarea)         │        │
│                                                       └──────────────────────────────────────┘        │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The right-side Navigator remains visible on wide screens only if the remaining editor workspace is at least its minimum width. On laptop, use the editor inspector as the persistent right area and collapse Navigator to a rail/drawer. This keeps prompt fields usable instead of producing three cramped columns.

At standard laptop width, use a horizontal split where preview and inspector are resizable within safe minimums. At narrow desktop, stack preview above inspector; show a horizontal unit thumbnail strip and make Navigator an overlay. Below mobile breakpoint, preserve the current mobile order.

### 5.2 Editor header and actions

The desktop Editor header contains:

- breadcrumb/current scene and active unit ordinal;
- previous/next unit buttons with disabled endpoint states;
- unit jump/thumbnails control;
- unsaved state (`Saved`, `Unsaved changes`, `Saving`, error) using text plus colour, never colour alone;
- a persistent Save action in the header. `Ctrl/Cmd+S` triggers the same save path when a draft is dirty.

Saving must remain explicit. Before navigation that changes the active unit/scene, show a discard/save confirmation only after the desktop draft model has been proven reliable; do not silently lose a desktop user’s long prompt. This improves the current mobile behaviour, where a position move discards local fields.

### 5.3 Unit navigation and carousel replacement

The current previous/current/next carousel remains useful as a content model, but not as the desktop primary control. Desktop uses:

- a large central current-unit preview for visual evaluation;
- previous/next arrow buttons, keyboard navigation and current-unit label;
- a horizontally scrollable thumbnail rail of nearby units (initially current scene; cross-scene progression follows the existing navigation rules);
- selected thumbnail state and accessible text labels;
- optional side previews only on wide screens, subordinate to the main preview;
- click/double-click behaviour that is clear: click selects a thumbnail; main preview opens the existing full-size zoom.

The large preview uses `object-fit: contain`, a stable bounded canvas and loading/missing states. It must not collapse or change surrounding layout dramatically for portrait versus landscape images. The existing image endpoint, full-size zoom dialog and error overlay are reused.

Arrow-key navigation only operates when focus is not in an input, textarea, select, dialog or Assistant. Suggested bindings are Left/Right for previous/next unit; `Alt+Left/Alt+Right` may be retained as an alternative only after browser-history conflicts are tested. Buttons remain the discoverable control.

### 5.4 Prompt editing: `image.prompt` and `video.action`

These two fields are dedicated working editors, not ordinary mobile field cards. In the Unit tab they should appear early and receive durable room:

- width: the full inspector column, never a narrow sidebar below 420px;
- height: 180–260px initial, with vertical resize and a reasonable maximum; preserve line breaks;
- monospaced text is optional and should be validated with the visual system; default is the existing body font for consistency;
- clear labels: **Image prompt** and **Video action**, their existing character counter/limit, and visible focus state;
- normal text selection, copy/paste, undo/redo, Home/End and browser keyboard shortcuts must work without interception;
- save status is visible near the fields and in the header; no automatic save that overwrites work silently;
- long content wraps naturally, preserves whitespace and scrolls inside the field rather than making the entire inspector jump.

`image.shot`, negative prompt, unit text and audio fields stay in the same Unit tab but use shorter or collapsible field groups. The prompt editors should not be hidden behind a general “more” accordion in normal desktop editing.

### 5.5 Property organisation

Keep the current domain categories but adapt their presentation:

| Current mobile tab | Desktop presentation |
|---|---|
| Unit | default inspector tab; unit text, audio, image and video groups, with prompt editors prominent |
| Scene | scene metadata, location and participant/prompt override information |
| Audio | waveform/timing and audio settings; waveform remains directly below preview when editing a unit |
| Characters | list selector plus selected character form, not a long sequence of all cards |
| Voices | list selector plus selected voice instruction form |
| Locations | list selector plus selected location form/environment |
| Global | book/world/defaults grouped in a normal scrollable inspector |

The mobile tabs themselves, fields, validation, character limits and endpoint routing should be extracted into reusable presentation components before a desktop layout consumes them. This avoids two sets of save logic.

### 5.6 Mouse, timing and focus

The existing waveform range controls support pointer dragging and should remain available. Desktop adds visible hover affordances for handles, a precise cursor and a keyboard-accessible alternative for timing adjustments if the waveform component can support it. Do not ship a pointer-only editor.

When switching inspector tabs, preserve the selected unit, preview, thumbnail scroll position and draft. When opening full-size image zoom, trap focus, close with Escape and restore focus to the preview trigger—building on the current Escape close support.

## 6. Generator desktop layout

Generator is a control room rather than a tall stack of mobile cards.

### Wide desktop

- Header row: current position, global Generate / Stop actions and summary of active workers/tasks.
- Main area: a responsive grid of VBook, Audio, Image and Video worker cards (two columns where each card remains readable; one column if there are long task rows).
- Each worker card retains existing header/toggle/settings, task rows, progress bar, duration and cancel action.
- A compact active-jobs summary stays near the header or in a sticky lower status strip, so a long list does not hide the fact that work is running.
- The scope choice opens the existing modal, with initial focus and Escape/Enter handling.

### Standard/narrow desktop

- Use one column of cards at a readable width rather than squeezing four cards.
- Navigator may remain open because it helps define scope. File compacts first.
- Preserve server polling cadence and existing running/error/success indicator semantics.

Changing mode must not cancel polling, reset timer presentation or lose the active row popup state. Generation activity appears in the global header even outside Generator.

## 7. Player desktop layout

Player gives media the majority of the screen:

- central media stage with stable cinema framing, fullscreen and existing cover/curtains/missing/subtitle states;
- below or beside it, a desktop transport console: play/pause as the primary action, status/progress, layer toggles with icon **and visible label** at desktop widths, fullscreen and current position;
- Navigator remains the principal way to jump through the book; selected Navigator unit seeks through the existing playback API;
- an optional compact metadata rail can show current scene/unit and generation availability, but must not duplicate the entire Navigator;
- layer controls retain their current enabled/disabled semantics and must expose pressed state to screen readers.

At wide desktop the stage and console can be a vertical centre column. On laptop, keep controls immediately below the stage. The Player must keep `playbackStore` ownership of media and its existing fullscreen/soft-refresh rules; desktop changes only the DOM layout and interaction ergonomics.

## 8. AI Assistant

On desktop Assistant is a contextual, non-destructive surface:

- opened from the global header with the existing Assistant button;
- default: docked right overlay panel, 380–480px wide, over the main workspace but below global modal priority;
- wide desktop option: user can pin it as a third-party-style dock replacing/temporarily overlaying Navigator, not creating a fourth always-visible column;
- on laptop/narrow desktop: modal side sheet or full-height overlay; it never forces a route away from the current workspace;
- contains current book and position context supplied by the existing stores, session list, mode selection, chat history, text input and voice controls;
- close with Escape, close button or header toggle; return focus to its invoker; retain draft/session and the underlying workspace context.

Assistant actions that alter book data must surface a review/confirmation and clearly refresh the relevant Editor/Navigator/Player data. Assistant should not silently mutate an unsaved Editor draft.

The existing `/ai` route remains available for mobile and direct links. Desktop can render the same chat component inside a panel; separate route and panel wrappers from the Assistant content before implementation.

## 9. Reuse, adaptation and new components

### Reuse without changing domain behaviour

- API client and TypeScript models.
- `generateStore`, `playbackStore`, `positionStore`, cache and playback lifecycle coordination.
- Theme/language preference resolution and all existing colour/font tokens.
- SVG icons, buttons/chips/cards, progress styles, status colours, dialogs, toast system and accessibility focus outline.
- File import/export behaviour and enable rules.
- Generator worker data, polling, scope selection, task cancellation and status calculation.
- Player media state, layer controls, fullscreen calculation and soft refresh.
- Navigator tree-building, thumbnail endpoint and shared-position/seek behaviour.
- Editor field routing, backend configuration/character limits, waveform data/range persistence, image URLs and full-size zoom.

### Components requiring desktop adaptation

| Component | Adaptation |
|---|---|
| `AppShell` / tab bar | responsive shell; desktop header/mode bar/panels while preserving mobile toolbar/tab bar |
| `FilePage` | sidebar grouping, compact rail and onboarding empty state |
| `GeneratePage` | responsive card grid and persistent header summary |
| `PlayPage` | stage/transport composition and labelled desktop layer controls |
| `NavigatePage` | embedded panel, desktop selection semantics, keyboard tree interaction |
| `EditPage` | split workspace, unit rail, prompt editors, non-destructive drafts and header save |
| `AiAssistantPage` | content component usable in a sheet/dock, not only a route |
| mobile cards/tabs | desktop density, hover states and minimum pointer/keyboard targets |

### New desktop-specific components

- `DesktopShell` / `WorkspaceHeader`.
- `WorkspaceModeSwitcher`.
- `CollapsiblePanel` with persistent user choice and optional bounded resizing.
- `FileSidebar` and compact `FileRail`.
- `NavigatorPanel` wrapper around reusable navigation tree.
- `EditorWorkspace`, `UnitPreviewStage`, `UnitThumbnailRail`, `EditorInspector` and `PromptEditor`.
- `GenerationStatusButton` / global job summary.
- `AssistantPanel` / `AssistantSheet` and focus management utility.
- `useDesktopBreakpoint` or CSS-first responsive shell logic; a small workspace layout preference store only for presentation state.

## 10. Responsive integration strategy

1. Keep existing mobile markup and styles as the base. Desktop styles are gated by a shared breakpoint and preferably use CSS grid/flex rather than JavaScript width branching for ordinary reflow.
2. Add a desktop shell only at the chosen desktop threshold. Do not merely hide the bottom tab bar and enlarge mobile pages.
3. Extract shared content from route wrappers where a page must render in both mobile and desktop containers, e.g. `NavigationTree`, `AssistantContent`, `EditorFields`, `WorkerSection`.
4. Use `ResizeObserver` for only components that truly need measured media layout, such as preview anchoring. Avoid parallel desktop data loading.
5. Store only panel open/closed/pinned/preferred-width and last desktop mode in local storage. Clamp invalid old values.
6. Test changes at 900, 1024, 1280, 1366, 1440, 1920px and at 200% browser zoom. Test Russian and English labels, dark/light themes and no-book/long-book states.

When the width crosses into mobile, render the existing mobile navigation and do not lose shared book, position, generation or playback state. A transient desktop-only panel can close; it should not reset a running task or selected unit.

## 11. Keyboard, mouse and accessibility requirements

| Context | Interaction |
|---|---|
| Global | `Escape` closes the top-most menu, dialog, Assistant or drawer; focus returns to the invoker |
| Header | Tab moves through visible controls; mode switcher announces active mode |
| Editor | `Ctrl/Cmd+S` saves a dirty draft; Left/Right changes unit only when no text control is active; Enter/Space activates focused buttons/thumbnails |
| Navigator | Up/Down moves tree focus; Right expands; Left collapses; Enter selects; focus does not auto-jump during polling |
| Dialogs | focus trap, initial meaningful focus, Escape cancellation where safe, Enter only confirms when it cannot submit an unintended text edit |
| Prompts | browser-standard text editing keys and selection must be unmodified |

All icon-only desktop controls need accessible names and hover/focus tooltips. Hover states must supplement, not replace, visible labels/state. Pointer targets should normally be at least 32px for desktop utility controls and 40px+ for frequent primary actions; controls must work with keyboard alone. Respect `prefers-reduced-motion` for nonessential panel and status animations.

## 12. Implementation phases and order

### Phase 1 — Audit (complete for this plan)

- Map mobile screens, routes, stores, design tokens, themes, language and responsive mechanisms.
- Confirm that `frontends/mobile/` is the implementation target and `frontends/main/` is not a desktop application.
- Identify reuse/adaptation/new component boundaries described above.

### Phase 2 — Desktop information architecture

- Confirm the proposed shell with product/design review using representative long books and a 13-inch laptop.
- Decide exact threshold and initial panel widths after visual prototypes.
- Document Navigator selection behaviour and File auto-collapse opt-out before coding.

### Phase 3 — Design-system adaptation

- Add desktop layout/density tokens without changing theme colours or typography family.
- Build reusable panel, rail, mode-switcher, tooltip and focus primitives.
- Validate day/night and ru/en at every new primitive.

### Phase 4 — Navigation shell

- Implement responsive `DesktopShell`, header, mode switching, File panel/rail and Navigator wrapper.
- Preserve deep routes and mobile bottom tabs below the breakpoint.
- Persist only presentation preferences; test first run/no book, open book, reload and browser back/forward.

### Phase 5 — Editor (highest priority)

- Extract reusable editor data/field components if needed.
- Build preview stage, thumbnail rail and inspector split.
- Promote `image.prompt` and `video.action` to desktop prompt editors.
- Add header save/dirty state, safe unit navigation and keyboard/focus behaviour.
- Integrate waveform and cast/location/global selector patterns.

### Phase 6 — Generator

- Convert worker stack to responsive cards/grid.
- Add global job summary/status handoff in header.
- Verify poll lifecycle, scope dialog, cancellation and errors across mode switches.

### Phase 7 — Player

- Implement large stage and desktop transport console.
- Revalidate fullscreen, subtitles, layer toggles, external seek and soft refresh after generation.

### Phase 8 — Assistant and secondary screens

- Separate Assistant content from route chrome; mount it in a contextual desktop sheet/dock.
- Adapt Settings, Library and workflow pages to the shell without unnecessary functional changes.

### Phase 9 — Responsive integration and usability pass

- Exercise all target widths, zoom levels, themes, languages, no-book/loading/error/running states.
- Run task walkthroughs: open → generate → monitor → navigate → play → edit prompts → save → regenerate → return to playback.
- Test mouse, keyboard, screen-reader semantics and focus restoration.

### Phase 10 — Final polish

- Tune spacing, alignment, panel animation, hover/focus, empty states, text truncation and scrollbar behaviour.
- Remove layout shifts, inspect contrast and ensure long prompts/long Russian labels remain usable.

## 13. Definition of done

Desktop migration is ready when:

- The existing mobile UI is visually and functionally unchanged below the mobile breakpoint.
- A new desktop user can immediately find Open/Create without a hamburger menu.
- A book-open user has a clear current book, workspace mode and current chapter/scene/unit.
- Wide screens offer File, central workspace and Navigator without crowding; laptop and narrow desktop collapse panels predictably.
- Generator, Player and Editor switch without losing the shared position, a running generation or media state.
- Editor shows a substantial current IU preview and supports fast unit switching via mouse and keyboard.
- `image.prompt` and `video.action` are comfortably multi-line editable, copyable, selectable, limit-aware and saveable with keyboard.
- Navigator selection changes shared position without unwanted mode switches; explicit playback navigation remains available.
- Player remains correct through fullscreen, layers, external seek and generation soft refresh.
- Assistant overlays/docks contextually and closing it restores the exact working context.
- Day/night and ru/en/auto use the existing visual system; keyboard focus, tooltips and screen-reader names work for all new controls.
- Automated typecheck/build pass; relevant unit/integration/UI tests cover shell state, editor save/navigation and responsive visibility.

## 14. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Building a second desktop app | duplicated state and divergent behaviour | implement as responsive presentation within `frontends/mobile/` |
| Three panels crowd laptop Editor | prompts become unusable | mode-specific collapse: editor inspector has priority; Navigator becomes drawer/rail |
| Route remount detaches Player/video | playback interruption | preserve mode mounts where possible; keep media ownership in `playbackStore`; test route transitions |
| Position selection discards prompt draft | data loss | desktop dirty guard/confirmation before position change; do not duplicate draft logic carelessly |
| Auto-collapse File surprises users | loss of orientation | only one-time, non-forced suggestion after successful open; explicit pin always wins |
| Polling tied to visible Generator | stale background status | retain store/network lifecycle independently of layout; show global summary |
| CSS-only desktop restyle of mobile Editor | oversized but still inefficient mobile flow | introduce `EditorWorkspace` with preview/inspector architecture |
| Long content/localisation causes overflow | clipped Russian labels and prompts | test ru/en, long titles, narrow widths and 200% zoom before merging |
| Accessibility regressions in drawers/overlays | keyboard traps/focus loss | reusable focus management, semantic buttons/tree roles, automated keyboard checks |
| Resizable panels add complexity | unstable layout/preferences | ship fixed responsive widths first; add constrained resizing only after core usability passes |

## 15. Immediate next step

Create a small desktop-shell prototype in the existing frontend, behind the desktop breakpoint, before rewriting individual pages. It should include the header, File onboarding drawer, central mode switcher and Navigator panel with dummy/reused content. Validate it at laptop and wide desktop widths with real book data; then implement the Editor workspace first.
