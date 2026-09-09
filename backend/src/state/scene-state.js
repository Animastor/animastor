// ======================================================
// Scene State — transition shim (S-4, corrected in the S-4 correction pass)
// ======================================================
// The pure per-asset FSM contract lives in the Generation core
// (generation/scene-state.js); the Redis-backed persistence lives in the
// host adapter (state/asset-state-store.js). This shim keeps the legacy
// deep-require surface byte-compatible until the physical
// @animastor/generation package lands (S-7). Redis key bytes and FSM
// semantics unchanged.
module.exports = require('./asset-state-store');
