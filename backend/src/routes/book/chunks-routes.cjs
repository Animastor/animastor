// ======================================================
// Book Chunks Routes — registrar stub (Player route split)
// ======================================================
// The playback endpoints that lived here — GET /api/v1/book/:bookId/chunks
// (playback queue) and GET /api/v1/book/:bookId/assets-state (readiness) —
// moved to routes/player/playback-queue.cjs (Player contour, see
// docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md). This module is kept
// as a registrar for any future book-contour chunk concerns; it registers
// nothing today. The pure IU-progress math stays in ./iu-progress-utils.cjs
// (shared with routes/book/progress-panel.cjs and injected into the player
// routes by the composition root).

module.exports = function(app, redis, deps) {
    // Intentionally empty after the Player route split. Kept so existing
    // requires (routes/book-routes.cjs) keep working and future book-side
    // chunk routes have a home.
};
