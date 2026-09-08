// ======================================================
// EDITOR CONTOUR — host ports (composition-root seam)
// ======================================================
// Editor route split (Phase 1 of the Editor extraction,
// docs/architecture/editor-module-extraction-audit.md §6/§13).
//
// The Editor HTTP contour (routes/editor/**) must not import host
// implementation modules directly (PG repos, Redis helpers, services,
// middleware) — the same rule the Player contour follows via playerPorts
// (docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md). Instead the host
// wires its implementations into ONE port object at the composition root:
//
//   createEditorPorts({ deps }) → editorPorts
//
// The port object is injected into the contour registrars via routeDeps
// (deps.editorPorts) and carries exactly the host legs the contour needs:
//
//   sceneAssetsRepo   — PG scene-assets port: bumpSceneVersions /
//                       setDirtyUnitIds (storage/postgres repositories stay
//                       host-side)
//   auditCoverage     — source-coverage audit (services/source-coverage-audit)
//   promptLimit       — IMAGE_PROMPT_MAX_CHARS (services/agent-prompts —
//                       the agent-domain constant flows through the seam)
//   purge             — entity-cleanup purgeScene/purgeUnit (PG+Redis+FS+
//                       in-flight cancellation stays host-side)
//   resolveOwnership  — workspace-ownership.resolveWorkspaceForBook
//                       (POST /book/blank ownership attach)
//   recoverChunks     — read-time Redis chunk repair (read-recovery ctx)
//   placeholderAudio — recoverMissingPlaceholders (read-repair leg)
//
// IMPORTANT (behavior-neutral split): the port functions are the SAME host
// function references the contour previously required directly — no
// implementation moves in this step; only the wiring does. The frozen
// T6 baseline (phase6-editor-player.test.js) is re-pinned in the same
// change; the E-guards (editor-route-split.test.js E1–E3) freeze the
// HTTP surface and the contour's require isolation.
//
// This module itself is part of the Editor contour and must stay
// dependency-free (it only re-shapes what the composition root passes in)
// so the future physical move to packages/animastor-editor can carry it
// as-is (the implementations stay host-side forever).

module.exports = function createEditorPorts({ deps }) {
    const {
        redis, config, storage, runtime, bookDiff, book,
        sceneAssetsRepo, placeholderAudio, activeScenes, state,
        getAllChunks, saveChunk, utils,
    } = deps;

    const log = (utils && utils.log) || ((...a) => console.log(new Date().toISOString(), ...a));

    // ── PG scene-assets port ────────────────────────────
    // The contour's post-commit fan-out (version bumps + dirty-unit
    // marking) previously required the repo module directly. The port
    // passes the SAME functions through.
    if (!sceneAssetsRepo) {
        throw new Error('createEditorPorts: sceneAssetsRepo is required (PG scene-assets port)');
    }

    // ── Read-time repair ports (GET /book/:id) ─────────
    // Same references the old core-routes.cjs destructured from routeDeps
    // or required directly; the contour invokes them via the port object.
    if (!placeholderAudio) {
        throw new Error('createEditorPorts: placeholderAudio is required (read-repair port)');
    }

    // ── entity-cleanup port (structure deletes) ────────
    // The factory stays host-side (services/entity-cleanup.cjs); the contour
    // calls purge.purgeScene / purge.purgeUnit.
    const entityCleanup = require('../../services/entity-cleanup.cjs')(redis, config, {
        utils: { log }, storage, runtime, bookDiff, book,
    });

    return {
        // PG scene-assets (post-commit derived state)
        sceneAssetsRepo,

        // Read-time placeholder recovery (GET /book/:bookId)
        placeholderAudio,

        // POST /book/:bookId/source-coverage — host audit service
        auditCoverage: require('../../services/source-coverage-audit'),

        // Editor-save prompt guard ceiling (agent-domain constant)
        promptLimit: require('../../services/agent-prompts').IMAGE_PROMPT_MAX_CHARS,

        // Structure-delete deep cleanup (scene/unit purge)
        purge: entityCleanup,

        // POST /book/blank ownership attach (workspace-ownership)
        resolveOwnership: async (bookId, meta) => {
            const workspaceOwnership = require('../../middleware/workspace-ownership');
            return workspaceOwnership.resolveWorkspaceForBook(bookId, meta);
        },

        // Read-time Redis chunk repair — the ctx the recovery helper needs.
        // The helper itself (read-recovery.cjs) is contour-owned; its
        // dependencies (redis, book, state, activeScenes, config,
        // getAllChunks, saveChunk, log) are host legs and arrive via this
        // ctx object, exactly the pre-split shape.
        recoveryCtx: {
            redis, book, state, activeScenes, config, getAllChunks, saveChunk, log,
        },
    };
};
