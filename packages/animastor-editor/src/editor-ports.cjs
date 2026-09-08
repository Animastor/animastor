// ======================================================
// EDITOR CONTOUR — host ports (composition-root seam)
// ======================================================
// Editor route split (Phase 1 of the Editor extraction,
// docs/architecture/editor-module-extraction-audit.md §6/§13) — carried
// into @animastor/editor by the Phase 4 physical move.
//
// The Editor HTTP contour (this package) must not import host
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
// This module itself is part of the Editor contour and MUST NOT contain
// any host require() calls (services, middleware, PG repos, Redis) — it
// only re-shapes what the composition root passes in. The physical move
// to packages/animastor-editor carried it as-is (the implementations
// stay host-side forever).  Phase 1.1 removed the last
// four host requires (entity-cleanup, source-coverage-audit, agent-prompts,
// workspace-ownership); these are now constructed in backend.cjs and passed
// as ready-made references.

module.exports = function createEditorPorts({ deps }) {
    const {
        // ── host legs carried from the composition root ──────────
        // All host implementations arrive as already-resolved references;
        // editor-ports.cjs itself holds ZERO host require() calls so that
        // the @animastor/editor package carries only this file
        // and the contour registrars — the host services stay host-side.
        sceneAssetsRepo, placeholderAudio,
        auditCoverage, promptLimit,
        purge, resolveOwnership, recoveryCtx,
    } = deps;

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

    return {
        sceneAssetsRepo,
        placeholderAudio,
        auditCoverage,
        promptLimit,
        purge,
        resolveOwnership,
        recoveryCtx,
    };
};
