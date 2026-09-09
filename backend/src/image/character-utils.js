// ======================================================
// Image Character Utilities — transition shim (S-4)
// ======================================================
// The coreference resolvers moved to the Generation prompt-profiles layer:
// generation/prompt-profiles/character-utils.js. This shim keeps the legacy
// deep-require surface byte-compatible until the physical
// @animastor/generation package lands (S-7).
module.exports = require('../generation/prompt-profiles/character-utils');
