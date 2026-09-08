// ======================================================
// @animastor/editor — PACKAGE ENTRYPOINT (public API)
// ======================================================
// The book-editing HTTP contour of the Animastor backend, physically
// extracted from the host (backend/src/routes/editor/ + backend/src/editor/
// — deleted by the extraction commit;
// docs/architecture/editor-module-extraction-audit.md — Phase 4,
// PHYSICAL MOVE COMPLETE).
//
// The package owns: the core book GET/PUT/PATCH/DELETE endpoints (with the
// read-time enrichment + post-commit derived-state fan-out), entity CRUD
// (characters/locations/voices/behaviors), structure CRUD
// (chapters/scenes/units), blank-book scaffolding (POST /book/blank), the
// read-time chunk repair (read-recovery), the pure scene-patch helpers and
// the entity-id grammar (transliteration → snake_case, over the pure
// cyr-latin map).
//
// The package imports NOTHING from the backend host: no config, no services,
// no middleware, no PG/Redis internals, no backend storage, no generation/AI
// domain. Book content is reached ONLY through the injected editorModel
// (the VBook boundary — the facade over @animastor/vbook-runtime's Book
// Model); every host dependency arrives as an injected port (editorPorts)
// at registration time, wired at the composition root.
//
// Public API:
//   const { createEditorModel, createEditorRoutes, createEntityCrudRoutes } =
//       require('@animastor/editor');
//   const editorModel = createEditorModel({ bookModel, persistBook });
//   createEditorRoutes(app, redis, routeDeps);
//   createEntityCrudRoutes(app, redis, routeDeps);
//
// Guards: backend/tests/architecture/editor-route-split.test.js (E1–E3),
//         backend/tests/architecture/editor-extraction-readiness.test.js
//         (E4–E8 + B1),
//         backend/tests/architecture/phase6-editor-player.test.js (T2–T7).

const { createEditorModel } = require('./editor-model.cjs');
const createEditorRoutes = require('./editor-routes.cjs');
const createEntityCrudRoutes = require('./entity-crud-routes.cjs');

module.exports = { createEditorModel, createEditorRoutes, createEntityCrudRoutes };
