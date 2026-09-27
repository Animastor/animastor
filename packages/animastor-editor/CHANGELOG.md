# Changelog

## 0.1.1 (2026-09-26)

Documentation-only release: the repository `CHANGELOG.md` mistakenly held a
copy of the `@animastor/player` changelog (carried over with the Player
extraction commit and never replaced). The published 0.1.0 npm tarball was
not affected — it contained no CHANGELOG at all (not in `files`). The
runtime code in 0.1.1 is identical to the published 0.1.0 tarball.

### Fixed

- `CHANGELOG.md` — replaced the wrong (Player) changelog with the Editor
  history (see 0.1.0 below).
- `files` — `CHANGELOG.md` added to the published tarball metadata, so the
  correct changelog ships with 0.1.1.

## 0.1.0 (2026-09-08)

First release — the book-editing HTTP contour physically extracted from the
Animastor backend host (editor extraction audit, Phase 4 — physical move
COMPLETE).

### API

- Root entrypoint exports `createEditorModel`, `createEditorRoutes`,
  `createEntityCrudRoutes`, `createEditorPorts` (root-only export map;
  deep imports blocked by the package `exports` map and the deep-import
  guard, PB1–PB4).
- `createEditorModel` — facade over the Canonical Book Model
  (`@animastor/vbook-runtime/book-model.cjs`).
- `createEditorPorts` — frozen host-port seam (Phase 2, guard E5):
  `sceneAssetsRepo`, `placeholderAudio`, `auditCoverage`, `promptLimit`,
  `purge`, `resolveOwnership`, `recoveryCtx`; mandatory ports fail-closed.

### Surface

- Core book GET/PUT/PATCH/DELETE with read-time enrichment and the
  post-commit derived-state fan-out.
- Targeted PATCH endpoints: scenes / metadata / locations / characters /
  voices / behaviors.
- Entity CRUD (characters / locations / voices / behaviors) with the
  entity-id grammar (transliteration → snake_case over the pure cyr-latin
  map), duplicate-id 409, missing-name 400, full-passport delete plus the
  dangling same-id voice cleanup.
- Structure CRUD (chapters / scenes / units) and blank-book scaffolding
  (`POST /book/blank`).
- Scene-patch utils (pure) and read-recovery (chunk repair ctx).

### Boundary

- No backend-host imports: book content is reached only through the
  injected `editorModel`; every host dependency arrives as an injected
  port at registration time.
- Runtime dependency: `@animastor/vbook-runtime ^0.1.0` (Book Model facade
  + `lazy-book/paths` id grammar).
