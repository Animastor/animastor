// ======================================================
// Assembly Profile Resolver — transition shim (S-4)
// ======================================================
// The shared prompt-assembly profile resolver moved to the Generation
// prompt-profiles layer:
// generation/prompt-profiles/assembly-profile.js. This shim keeps the
// legacy deep-require surface byte-compatible until the physical
// @animastor/generation package lands (S-7).
module.exports = require('../generation/prompt-profiles/assembly-profile');
