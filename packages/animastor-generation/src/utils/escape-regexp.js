// ======================================================
// escapeRegExp — @animastor/generation internal copy
// ======================================================
// PACKAGE-INTERNAL COPY (S-7 — physical package extraction): the pure
// RegExp-escape primitive the prompt-profiles text normalizers need. The
// host's backend/src/utils/string-utils.js also carries getOutputPath (a
// host runtime-config read) — that part is NOT package territory; only the
// pure function is mirrored here.
//
// Byte-parity (behavior + source) with the host escapeRegExp is guarded by
// backend/tests/architecture/generation-package-boundary.test.js (G7-M);
// edit the host source first, then mirror the change in the same commit.

/**
 * Escape a string for use in a RegExp pattern.
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { escapeRegExp };
