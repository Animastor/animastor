# 09. Mobile Web → Desktop Migration

This section covers the desktop presentation of the existing Animastor mobile web app
(`frontends/mobile/`, Preact + TS + Vite). Desktop is **not** a
second product: it reuses the same routes, API client, stores, translations,
themes and domain components, adding a desktop shell and desktop variants of
workspace layouts.

> **Status:** plan approved (stage 1 audit complete). Desktop shell prototype
> implemented in 8 commits (built per plan §15 as "Immediate next step") —
> see [`02-PROGRESS.md`](02-PROGRESS.md). Next priority is desktop
> **Editor workspace** (Phase 5 of plan).

---

## Key decision (from plan, §1.4 and §14)

`frontends/main/` contains only a static `index.html` — this is **not** a desktop
application. Therefore desktop is implemented **inside `frontends/mobile/`** as
an adaptive view at a certain width breakpoint; mobile
composition remains the fallback below this breakpoint. Building a second
desktop application is forbidden (state duplication and behavior divergence).

## Core model

Contextual workspace:

```text
┌──────────── File rail ────────────┬────────────── Main workspace ──────────────┬──── Navigator ────┐
│ book actions / import / export    │  [Generator] [Player] [Editor]              │ chapters / scenes │
│ visible on first run, collapsible │  selected mode; state remains in stores     │ units / position  │
│                                   │  optional mode-specific panes               │ persistent/collap.│
└───────────────────────────────────┴─────────────────────────────────────────────┴───────────────────┘
                                                   ▲
                                  AI Assistant: contextual overlay / docked panel
```

Generator, Player and Editor are three **workspace modes**, not three adjacent
panels: segmented mode-bar in desktop header, state lives in
existing shared stores (`generateStore`, `playbackStore`, `positionStore`).

## Breakpoints (Phase 2 — validate with real content)

| Layout state | Viewport | Shell behaviour |
|---|---:|---|
| Wide desktop | `>= 1440px` | header + File panel 264–304px + center + Navigator 280–336px |
| Standard laptop | `1100–1439px` | File → rail 56–64px after book open; Navigator open, Editor compresses |
| Narrow desktop | `900–1099px` | center + one overlay/collapsible sidebar |
| Mobile | `< 900px` | current mobile shell (toolbar + tab bar), no desktop panels |

Current shell prototype works from breakpoint **`min-width: 1180px`**
(`DESKTOP_SHELL_QUERY` in `AppShell.tsx`) with laptop adaptation `<= 1359px` —
values to be verified against plan after visual prototypes.

## Section structure

| Document | Contents |
|---|---|
| [`01-MIGRATION-PLAN.md`](01-MIGRATION-PLAN.md) | Full migration plan: mobile UI audit, desktop principles, information architecture, desktop Editor/Generator/Player, AI Assistant, phases 1–10, definition of done |
| [`02-PROGRESS.md`](02-PROGRESS.md) | Phase progress tracker: what's implemented (shell prototype), what's in progress, what's next |

## Related documents

- [`docs/08-mobile-web-migration/README.md`](../08-mobile-web-migration/README.md) — preceding Android → Mobile Web migration (`frontends/mobile/`)
- [`docs/05-frontend/PLAYER_STATE.md`](../05-frontend/PLAYER_STATE.md) — player state (contract, reused without changes)
- [`docs/01-overview/PROJECT_STRUCTURE.md`](../01-overview/PROJECT_STRUCTURE.md) — `frontends/mobile/` position in project
- [`docs/DONT_DO.md`](../DONT_DO.md) — anti-patterns, do not reproduce in desktop shell
