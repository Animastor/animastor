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
returns `{ createEditorModel, createEditorRoutes, createEntityCrudRoutes }`.
Deep imports (`@animastor/editor/src/...`) are intentionally not exported.

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
const { createEditorModel, createEditorRoutes, createEntityCrudRoutes } =
    require('@animastor/editor');

const editorModel = createEditorModel({ bookModel, persistBook: book.saveBookBundle });
const editorPorts = require('@animastor/editor/editor-ports.cjs')({
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
(T2–T7).

## License

MIT
