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
//   const { createEditorModel, createEditorRoutes, createEntityCrudRoutes,
//           createEditorPorts } = require('@animastor/editor');
//   const editorModel = createEditorModel({ bookModel, persistBook });
//   const editorPorts = createEditorPorts({ deps: { ...7 frozen ports... } });
//   createEditorRoutes(app, redis, { ...routeDeps, editorModel, editorPorts });
//   createEntityCrudRoutes(app, redis, { ...routeDeps, editorModel, editorPorts });
//
// This entrypoint is the ONLY public surface (Phase 4.1): the package.json
// export map exposes exactly this root ("." → "./src/index.cjs") and every
// other subpath is blocked ("./package.json" included). Host code must not
// deep-import internals (@animastor/editor/...) — the deep-import guard
// (backend/tests/architecture/editor-package-boundary.test.js, PB1–PB5)
// fails the suite if a deep import appears.
//
// Guards: backend/tests/architecture/editor-route-split.test.js (E1–E3),
//         backend/tests/architecture/editor-extraction-readiness.test.js
//         (E4–E8 + B1),
//         backend/tests/architecture/phase6-editor-player.test.js (T2–T7),
//         backend/tests/architecture/editor-package-boundary.test.js
//         (Phase 4.1 — deep-import guard + package closure).

const { createEditorModel } = require('./editor-model.cjs');
const createEditorRoutes = require('./editor-routes.cjs');
const createEntityCrudRoutes = require('./entity-crud-routes.cjs');
// The ports seam (composition-root shape): host legs are wired INTO the
// frozen 7-port object by the host and injected into the registrars. The
// module itself holds zero host requires — exporting it through the root
// keeps the seam documented and typed without opening any internal path.
const createEditorPorts = require('./editor-ports.cjs');

module.exports = { createEditorModel, createEditorRoutes, createEntityCrudRoutes, createEditorPorts };
