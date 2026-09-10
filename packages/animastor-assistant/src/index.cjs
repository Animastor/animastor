// ======================================================
// @animastor/assistant — PACKAGE ENTRYPOINT (public API)
// ======================================================
// The AI Assistant contour of the Animastor backend, physically extracted
// from the host (backend/src/services/chat-engine.cjs +
// backend/src/routes/ai-routes.cjs — deleted by the extraction commit;
// docs/architecture/ai-assistant-extraction.md).
//
// The package owns:
//   - the chat ENGINE: persona/system prompt assembly, book context
//     builders (full + compact), mode/topic prompts, the edit_book tool
//     definition, AI response parsing and the JSON patch pipeline with
//     bundle-contract validation (applyPatchesValidated) and the
//     deterministic scene-participants normalizer;
//   - the /api/v1/ai/* HTTP CONTOUR: session CRUD (list/get/create/rename/
//     delete/messages), the non-streaming chat route and the SSE stream
//     route (meta/delta/done/error contract unchanged), tool-call
//     orchestration (structured + content-embedded), the connector
//     shared-inference path and the cloud-provider path;
//   - the CONTRACTS: the AssistantPorts interface (the host seam —
//     loadBook/persistBook/validate/resolveChatAI/sessionRepo/purgeForBook/
//     chatTransport/log) and the chat-session repository interface.
//
// The package imports NOTHING from the backend host: no config, no
// services, no middleware, no PG/Redis internals, no backend storage, no
// Book/lazyBook/bundle-validator requires, no host transport-service
// requires. Every host leg — book read/write, bundle
// validation, provider resolution, session persistence, the SSRF-guarded
// fetch, connector shared inference, the AI-source token mapping and the
// persona profile path — arrives as an injected port at registration
// time, wired at the composition root (backend.cjs).
//
// Public API:
//   const { createChatEngine, createAssistantRoutes,
//           assertAssistantPorts, assertSessionRepo } =
//       require('@animastor/assistant');
//   const chatEngine = createChatEngine(config, {
//       validateBundleObject,            // host bundle-validator binding
//       aiProfilePath,                  // host persona file path
//   });
//   createAssistantRoutes(app, redis, { chatEngine, assistantPorts, utils });
//
// This entrypoint is the ONLY public surface: the package.json export map
// exposes exactly this root ("." → "./src/index.cjs") and every other
// subpath is blocked. Host code must not deep-import internals
// (@animastor/assistant/...) — guarded by
// backend/tests/architecture/assistant-package-boundary.test.js.
//
// Guards: backend/tests/architecture/assistant-contour.test.js (A1–A7),
//         backend/tests/architecture/assistant-package-boundary.test.js
//         (PB1–PB4 — package closure, no reverse imports, manifest freeze),
//         backend/tests/architecture/chat-transport.test.js (SSE/tools/
//         abort contract on the moved contour).

const createChatEngine = require('./chat-engine.cjs');
const createAssistantRoutes = require('./assistant-routes.cjs');
const { assertAssistantPorts } = require('./assistant-ports-contract.cjs');
const { assertSessionRepo } = require('./session-repo-contract.cjs');

module.exports = {
    createChatEngine,
    createAssistantRoutes,
    assertAssistantPorts,
    assertSessionRepo,
};
