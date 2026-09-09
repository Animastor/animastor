// ======================================================
// Speech Duration Estimation (pure) — S-4
// ======================================================
// The 0.3s/word narration duration heuristic shared by the audio pipeline
// (placeholder audio synthesis) and the Book/authoring contour (VBook agent
// pipeline scene sizing, scene splitting) — previously defined inline in
// services/placeholder-audio.js and imported from there by modules that have
// nothing to do with placeholder audio.
//
// S-4: canonical home is utils/ (shared pure host utils); placeholder-audio
// re-exports it for compatibility.
//
// IMPORTANT: the constants are part of a documented contract with
// agent-prompts.js scene splitting ("~N words" guideline) — the tokenizer
// and rates must stay identical wherever a word-count estimate is compared
// against it. Do not tune one copy without the other (single canonical copy
// now; guarded by tests/architecture/s4-shared-infra-moves.test.js S4-F).
//
// Pure function — no disk/DB access — so it can be called on raw scene
// text during book splitting, not only on persisted scenes.

const SPEECH_SEC_PER_WORD = 0.3;
const SPEECH_MIN_SEC = 2;

/**
 * Estimate narration duration (seconds) for an arbitrary text string.
 *
 * @param {string} text
 * @returns {number} estimated seconds (>= SPEECH_MIN_SEC), rounded to 0.1s
 */
function estimateSpeechDurationSec(text) {
    const wordCount = String(text || '').split(/\s+/).filter(Boolean).length;
    const estimated = Math.max(wordCount * SPEECH_SEC_PER_WORD, SPEECH_MIN_SEC);
    const rounded = Math.round(estimated * 10) / 10;
    return rounded;
}

module.exports = {
    SPEECH_SEC_PER_WORD,
    SPEECH_MIN_SEC,
    estimateSpeechDurationSec,
};
