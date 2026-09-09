// ======================================================
// Generation Task Registry — transition shim (S-4)
// ======================================================
// The generation task registry (animastor:generation-progress:*) moved to
// the Generation core area: generation/generation-progress.js. This shim
// keeps the legacy deep-require surface byte-compatible until the physical
// @animastor/generation package lands (S-7). Redis key bytes unchanged.
module.exports = require('../generation/generation-progress');
