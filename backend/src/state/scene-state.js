// ======================================================
// Scene State — transition shim (S-4)
// ======================================================
// The per-asset FSM (animastor:asset-state:*) moved to the Generation core
// area: generation/scene-state.js. This shim keeps the legacy deep-require
// surface byte-compatible until the physical @animastor/generation package
// lands (S-7). Redis key bytes and FSM semantics unchanged.
module.exports = require('../generation/scene-state');
