# @animastor/editor

Animastor **Editor** — the book-editing HTTP contour of the Animastor
backend: core book GET/PUT/PATCH/DELETE (with read-time enrichment and the
post-commit derived-state fan-out), targeted PATCH endpoints for
scenes/metadata/locations/characters/voices/behaviors, entity CRUD
(characters/locations/voices/behaviors), structure CRUD
(chapters/scenes/units) and blank-book scaffolding (`POST /book/blank`).
Includes the `createEditorModel` facade over the Canonical Book Model, the
pure scene-patch helpers and the entity-id grammar (transliteration →
snake_case over the pure cyr-latin map).

**Status: EXTRACTED (0.1.0).** The editing contour physically lives in this
package (`src/`); the host backend consumes it only through the package
entrypoint. See
[`docs/architecture/editor-module-extraction-audit.md`](https://github.com/Animastor/animastor/blob/main/docs/architecture/editor-module-extraction-audit.md)
(Phase 4 — physical move COMPLETE).

## Requirements

- Node.js >= 18
- [`@animastor/vbook-runtime`](https://www.npmjs.com/package/@animastor/vbook-runtime)
  (installed automatically as the only runtime dependency — the Editor Model
  facade over its Canonical Book Model plus the `lazy-book/paths` id grammar)

## Installation

```bash
npm install @animastor/editor
```

## Public API

The package exposes a single entrypoint — `require('@animastor/editor')`
returns `{ createEditorModel, createEditorRoutes, createEntityCrudRoutes,
createEditorPorts }`. Since Phase 4.1 the export map is root-only:
deep imports (`@animastor/editor/...`, `@animastor/editor/src/...`) are
blocked by the package `exports` map and rejected by the deep-import guard
(`backend/tests/architecture/editor-package-boundary.test.js`, PB1–PB4).
The `editorPorts` seam is exported through the same root because it is the
composition-root shape the host must build before registration — it is
part of the public contract, not an internal file.

## Boundary

The package imports **nothing** from the backend host: no config, no
services, no middleware, no PG/Redis internals, no backend storage, no
generation/AI/agent domain. Book content is reached only through the
injected `editorModel` (VBook boundary — the facade over
`@animastor/vbook-runtime`'s Book Model). Every host dependency arrives as
an injected port (`editorPorts`) at registration time, wired at the
composition root. The `editorPorts` shape is frozen (Phase 2, guard E5):
`sceneAssetsRepo`, `placeholderAudio`, `auditCoverage`, `promptLimit`,
`purge`, `resolveOwnership`, `recoveryCtx` — identity pass-through,
mandatory ports fail-closed.

## Standalone use (repository checkout)

```bash
npm install        # dep: @animastor/vbook-runtime (dev: mocha + chai)
npm test           # behavioral tests, no host needed
```

## Host integration (composition root)

```js
const { createEditorModel, createEditorRoutes, createEntityCrudRoutes,
        createEditorPorts } = require('@animastor/editor');

const editorModel = createEditorModel({ bookModel, persistBook: book.saveBookBundle });
const editorPorts = createEditorPorts({
    deps: {
        sceneAssetsRepo,          // PG scene-assets (bumpSceneVersions/setDirtyUnitIds)
        placeholderAudio,         // read-time placeholder recovery
        auditCoverage,            // source-coverage audit service
        promptLimit,              // IMAGE_PROMPT_MAX_CHARS
        purge,                    // entity-cleanup purgeScene/purgeUnit
        resolveOwnership,         // workspace-ownership attach (POST /book/blank)
        recoveryCtx,              // read-recovery ctx (redis chunk repair)
    },
});
createEditorRoutes(app, redis, { ...routeDeps, editorModel, editorPorts });
createEntityCrudRoutes(app, redis, { ...routeDeps, editorModel, editorPorts });
```

## Frozen HTTP surface (26 endpoints)

```
GET    /api/v1/book/:bookId                                  PUT    /api/v1/book/:bookId
PATCH  /api/v1/book/:bookId/scene/:chapterId/:sceneId        PATCH  /api/v1/book/:bookId/metadata
PATCH  /api/v1/book/:bookId/locations/:locationId            PATCH  /api/v1/book/:bookId/characters/:characterId
PATCH  /api/v1/book/:bookId/voices/:voiceId                  PATCH  /api/v1/book/:bookId/behaviors/:characterId
GET    /api/v1/book/:bookId/source-coverage                  GET    /api/v1/book/:bookId/cover
DELETE /api/v1/book/:bookId                                  POST   /api/v1/book/blank
POST   /api/v1/book/:bookId/characters                       DELETE /api/v1/book/:bookId/characters/:characterId
POST   /api/v1/book/:bookId/locations                        DELETE /api/v1/book/:bookId/locations/:locationId
POST   /api/v1/book/:bookId/voices                           DELETE /api/v1/book/:bookId/voices/:voiceId
POST   /api/v1/book/:bookId/behaviors                        DELETE /api/v1/book/:bookId/behaviors/:characterId
POST   /api/v1/book/:bookId/chapters                         DELETE /api/v1/book/:bookId/chapters/:chapterId
POST   /api/v1/book/:bookId/chapters/:chapterId/scenes       DELETE /api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId
POST   /api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units
DELETE /api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units/:unitId
```

Guards: [`backend/tests/architecture/editor-route-split.test.js`](https://github.com/Animastor/animastor/blob/main/backend/tests/architecture/editor-route-split.test.js)
(E1–E3), [`backend/tests/architecture/editor-extraction-readiness.test.js`](https://github.com/Animastor/animastor/blob/main/backend/tests/architecture/editor-extraction-readiness.test.js)
(E4–E8 + B1), [`backend/tests/architecture/phase6-editor-player.test.js`](https://github.com/Animastor/animastor/blob/main/backend/tests/architecture/phase6-editor-player.test.js)
(T2–T7), [`backend/tests/architecture/editor-package-boundary.test.js`](https://github.com/Animastor/animastor/blob/main/backend/tests/architecture/editor-package-boundary.test.js)
(PB1–PB5 — deep-import guard, manifest freeze, package closure, cyr-latin-map twin parity).

## Package boundary (NPM readiness — Phase 4.1)

- The `exports` map is **root-only**: `{ ".": "./src/index.cjs" }`. Deep imports
  (`@animastor/editor/...`) throw `ERR_PACKAGE_PATH_NOT_EXPORTED` at runtime and are
  rejected by the PB1 architecture guard.
- `createEditorPorts` is public through the root: it is the composition-root seam
  the host fills before route registration (the frozen 7-port contract above).
- The pure `cyr-latin-map` transliteration module is **internal**. Hosts that need
  Cyrillic→Latin normalization outside the Editor should keep their own copy (the
  Animastor backend carries a byte-parity twin guarded by the PB5 test) — the
  Editor is not a general-purpose utilities library.

## Versioning / release

- Current version: `0.1.0` (first publishable release; `npm publish --dry-run` verified).
- SemVer: the frozen HTTP surface (26 endpoints), the four public factories and the
  7-port `editorPorts` shape are the contract — breaking any of them requires a major
  bump. New optional ports or endpoints are minor; fixes are patch.
- The package is published from `packages/animastor-editor` (`files` = `src/`,
  `README.md`, `LICENSE`; `publishConfig.access = public`). Publication is a manual,
  explicit step — it is never automated in CI or agent runs.
- Release history is tracked in
  [`docs/architecture/editor-module-extraction-audit.md`](https://github.com/Animastor/animastor/blob/main/docs/architecture/editor-module-extraction-audit.md)
  (§Phase 4 physical move, §Phase 4.1 NPM readiness).

## License

MIT
