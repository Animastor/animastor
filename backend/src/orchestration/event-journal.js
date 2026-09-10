// ======================================================
// Event Journal — relocation shim (S-5)
// ======================================================
// S-5 moved the journal to the host state adapter (state/event-journal.js):
// it is an append-only Redis sink with zero requires and no orchestration
// policy. This shim keeps the legacy `../orchestration/event-journal`
// deep-require surface (orchestrator.js, scene-utils.js and test harnesses)
// byte-compatible until S-6. Redis key bytes (`animastor:event-journal:*`)
// unchanged.
module.exports = require('../state/event-journal');
