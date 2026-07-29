// ======================================================
// Unit Splitter — splitLongUnits
// ======================================================
// Post-processing step that splits long Imagination Units
// (duration > MAX_UNIT_DURATION_SEC) into multiple shorter
// units, each representing exactly one act of imagination.
//
// Strategy (AI-first):
//   1. Measure duration of each unit via estimateSpeechDurationSec
//   2. If any unit exceeds threshold → AI reprompt to split semantically
//   3. Verify durations again
//   4. Emergency fallback (sentence → comma → char) if AI fails

const { estimateSpeechDurationSec } = require('../placeholder-audio');
const { SYSTEM_PROMPTS } = require('../agent-prompts');
const aiCaller = require('./ai-caller');
const { updateSession } = require('../agent-session');
const { PROGRESS_STAGES } = require('../agent-prompts');

// ── Constants ──

const MAX_UNIT_DURATION_SEC = 20;
const MAX_UNIT_SPLIT_RETRIES = 2;

// ── Duration check ──

/**
 * Estimate speech duration for a unit's text.
 * @param {string} text
 * @returns {number}
 */
function getUnitDurationSec(text) {
    return estimateSpeechDurationSec(text || '');
}

/**
 * Find all units that exceed the max duration threshold.
 * @param {Array<{text: string}>} units
 * @returns {Array<{index: number, unit: object, duration: number}>}
 */
function findLongUnits(units) {
    return units
        .map((unit, index) => ({
            index,
            unit,
            duration: getUnitDurationSec(unit.text || ''),
        }))
        .filter(({ duration }) => duration > MAX_UNIT_DURATION_SEC);
}

/**
 * Log a structured debug line with unit duration statistics.
 * Useful for collecting data on unit sizes in production.
 * Format is JSON-friendly for grep | jq analysis.
 * @param {Array} units - Units array
 * @param {string} label - Context label (e.g. "before_split", "after_split")
 * @param {number} sceneIndex - Scene index for context
 */
function logDurationStats(units, label, sceneIndex) {
    if (!units || units.length === 0) return;
    const durations = units.map((u, i) => ({
        index: i,
        type: u.type || '?',
        dur_sec: getUnitDurationSec(u.text || ''),
        words: (u.text || '').split(/\s+/).filter(Boolean).length,
        text_preview: (u.text || '').substring(0, 80),
    }));
    const totalDur = durations.reduce((s, d) => s + d.dur_sec, 0);
    const maxDur = Math.max(...durations.map(d => d.dur_sec));
    const avgDur = totalDur / durations.length;
    const overLimit = durations.filter(d => d.dur_sec > MAX_UNIT_DURATION_SEC).length;

    console.log(JSON.stringify({
        event: 'iu_duration_stats',
        scene_index: sceneIndex,
        label,
        unit_count: units.length,
        total_duration_sec: Math.round(totalDur * 10) / 10,
        avg_duration_sec: Math.round(avgDur * 10) / 10,
        max_duration_sec: Math.round(maxDur * 10) / 10,
        over_limit_count: overLimit,
        over_limit_max_sec: MAX_UNIT_DURATION_SEC,
        units: durations,
    }));
}

// ── Emergency fallbacks (AI-agnostic) ──

/**
 * Split text by sentences (. ! ?).
 * Each sentence becomes a separate unit.
 * @param {string} text
 * @returns {string[]}
 */
function splitBySentences(text) {
    const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    return parts.length > 1 ? parts : [text];
}

/**
 * Split text by commas, semicolons, em-dashes.
 * Each clause becomes a separate unit.
 * @param {string} text
 * @returns {string[]}
 */
function splitByCommas(text) {
    // Russian/German em-dash, comma, semicolon
    // Em-dash often has NO space after it (e.g. "part—another")
    // Using \s* to handle both with and without trailing whitespace
    const parts = text.split(/(?:,|;|—)\s*/).filter(Boolean);
    return parts.length > 1 ? parts : [text];
}

/**
 * Split text into equal halves by word count.
 * @param {string} text
 * @returns {string[]}
 */
function splitByWordCount(text) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= 1) return [text];
    const mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

/**
 * Emergency fallback chain to split a unit's text.
 * Tries progressively more aggressive strategies.
 * @param {{text: string, type: string}} unit
 * @returns {Array<{text: string, type: string}>}
 */
function emergencySplit(unit) {
    const text = unit.text || '';
    const baseType = unit.type || 'narration';

    // Strategy 1: sentence split
    const sentences = splitBySentences(text);
    if (sentences.length > 1) {
        return sentences.map(s => ({
            ...unit,
            text: s.trim(),
            type: baseType,
            // Preserve audio.speaker for dialogue — but only on first fragment
            audio: unit.audio ? { ...unit.audio, text: s.trim() } : undefined,
        }));
    }

    // Strategy 2: comma split
    const clauses = splitByCommas(text);
    if (clauses.length > 1) {
        return clauses.map(c => ({
            ...unit,
            text: c.trim(),
            type: baseType,
            audio: unit.audio ? { ...unit.audio, text: c.trim() } : undefined,
        }));
    }

    // Strategy 3: word-count split (last resort)
    const halves = splitByWordCount(text);
    return halves.map(h => ({
        ...unit,
        text: h.trim(),
        type: baseType,
        audio: unit.audio ? { ...unit.audio, text: h.trim() } : undefined,
    }));
}

// ── AI reprompt logic ──

/**
 * Call AI to split a single long unit into multiple units.
 * @param {string} sessionId
 * @param {object} unit - The long unit
 * @param {number} unitIndex - Index in the original units array
 * @returns {Promise<Array<{text: string, type: string}>|null>} Split units, or null on failure
 */
async function askAIToSplitUnit(sessionId, unit, unitIndex) {
    const prompt = SYSTEM_PROMPTS.unit_splitter
        .replace('%UNIT_TEXT%', unit.text || '')
        .replace('%UNIT_TYPE%', unit.type || 'perception');

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Split this unit into separate visual acts:\\n\\n\`\`\`\\n${unit.text}\\n\`\`\`` },
    ];

    try {
        const result = await aiCaller.callAI(messages, { maxTokens: 2048 });
        // logConversation is best-effort — don't let DB errors discard the AI result
        try {
            await aiCaller.logConversation(sessionId, `split-unit-${unitIndex}`, messages, JSON.stringify(result));
        } catch (_) {
            // Non-fatal: logConversation needs a real session UUID
        }
        const splitUnits = result.units || [];
        if (!Array.isArray(splitUnits) || splitUnits.length < 2) {
            console.warn(`[UNIT-SPLITTER] AI returned ${splitUnits.length} units for long unit ${unitIndex} — expected >= 2`);
            return null;
        }
        // Validate: all split units must have text
        const valid = splitUnits.filter(u => u.text && u.text.trim());
        if (valid.length < 2) {
            console.warn(`[UNIT-SPLITTER] AI returned only ${valid.length} valid units for unit ${unitIndex}`);
            return null;
        }
        // Preserve audio from original dialogue unit (first split fragment gets the full audio)
        if (unit.audio) {
            valid[0].audio = { ...unit.audio };
        }
        // Log the split for debugging
        const totalChars = valid.reduce((s, u) => s + (u.text || '').length, 0);
        const origChars = (unit.text || '').length;
        console.log(`[UNIT-SPLITTER] Split unit ${unitIndex}: "${(unit.text || '').substring(0, 50)}..." → ${valid.length} units (${totalChars}/${origChars} chars)`);
        return valid;
    } catch (err) {
        console.warn(`[UNIT-SPLITTER] AI call failed for unit ${unitIndex}: ${err.message}`);
        return null;
    }
}

/**
 * Replace a unit at index with multiple split units.
 * @param {Array} units - Original units array
 * @param {number} index - Index of unit to replace
 * @param {Array} splitUnits - Replacement units
 * @returns {Array} New units array
 */
function spliceUnits(units, index, splitUnits) {
    const result = [...units];
    result.splice(index, 1, ...splitUnits);
    return result;
}

/**
 * Split a single long unit using the full chain: AI first, then emergency fallback.
 * @param {string} sessionId
 * @param {Array} units - Current units array (may have been partially split already)
 * @param {number} longIndex - Index of the long unit to split
 * @param {object} longUnit - The unit object
 * @returns {Promise<Array>} Updated units array
 */
async function splitOneUnit(sessionId, units, longIndex, longUnit) {
    let result = null;
    let finalRetryCount = MAX_UNIT_SPLIT_RETRIES;
    let outcome = 'fallback';

    // Try AI reprompt (up to MAX_UNIT_SPLIT_RETRIES times)
    for (let retry = 0; retry < MAX_UNIT_SPLIT_RETRIES; retry++) {
        const attempt = retry + 1;
        result = await askAIToSplitUnit(sessionId, longUnit, longIndex);
        if (result) {
            // Verify: each split piece must be ≤ MAX_UNIT_DURATION_SEC
            const allOk = result.every(u => getUnitDurationSec(u.text) <= MAX_UNIT_DURATION_SEC);
            if (allOk) {
                finalRetryCount = attempt;
                outcome = 'ai_success';
                console.log(JSON.stringify({
                    event: 'iu_split_retry',
                    unit_index: longIndex,
                    retry_attempt: attempt,
                    total_attempts: attempt,
                    outcome: 'ai_success',
                    split_count: result.length,
                }));
                return spliceUnits(units, longIndex, result);
            }
            // Some pieces are still too long — log and retry
            const longPieces = result.filter(u => getUnitDurationSec(u.text) > MAX_UNIT_DURATION_SEC);
            console.warn(`[UNIT-SPLITTER] AI split retry ${attempt}: ${longPieces.length}/${result.length} pieces still > ${MAX_UNIT_DURATION_SEC}s`);
            console.log(JSON.stringify({
                event: 'iu_split_retry',
                unit_index: longIndex,
                retry_attempt: attempt,
                total_attempts: attempt,
                outcome: 'still_long',
                split_count: result.length,
                long_pieces: longPieces.length,
            }));
        } else {
            console.log(JSON.stringify({
                event: 'iu_split_retry',
                unit_index: longIndex,
                retry_attempt: attempt,
                total_attempts: attempt,
                outcome: 'ai_failed',
                split_count: 0,
            }));
        }
    }

    // If AI failed or returned still-long pieces, use emergency fallback
    const emergencyUnits = emergencySplit(longUnit);
    console.log(JSON.stringify({
        event: 'iu_split_retry',
        unit_index: longIndex,
        retry_attempt: finalRetryCount,
        total_attempts: MAX_UNIT_SPLIT_RETRIES,
        outcome: 'fallback',
        split_count: emergencyUnits.length,
        fallback_method: emergencyUnits.length > 1
            ? (emergencyUnits[0].text !== longUnit.text ? 'sentence_split' : 'comma_or_word_split')
            : 'none',
    }));
    return spliceUnits(units, longIndex, emergencyUnits);
}

// ── Main entry point ──

/**
 * Post-processing step: split long Imagination Units into multiple shorter units.
 *
 * Called after stepCreateUnits, before stepCreateVisuals.
 * Each unit's text is checked for estimated audio duration.
 * If any unit exceeds MAX_UNIT_DURATION_SEC (20s), it is split:
 *   1. Try AI reprompt (semantic split)
 *   2. Verify resulting durations
 *   3. Emergency fallback (sentence → comma → word-count)
 *
 * @param {string} sessionId - Agent session ID
 * @param {object} scene - The scene object
 * @param {Array<{text: string, type: string}>} units - Units created by stepCreateUnits
 * @param {number} sceneIndex - Global scene index
 * @param {number} stepIndex - Pipeline step index
 * @param {function} progress - Progress callback
 * @returns {Promise<Array>} Split units (or original if none were too long)
 */
async function splitLongUnits(sessionId, scene, units, sceneIndex, stepIndex, progress) {
    const _progress = progress || (() => {});

    if (!units || units.length === 0) {
        console.log(`[UNIT-SPLITTER] Scene ${sceneIndex}: no units to check`);
        return units || [];
    }

    // Debug: log pre-split duration stats
    logDurationStats(units, 'before_split', sceneIndex);

    // 1. Find long units
    const longUnits = findLongUnits(units);
    if (longUnits.length === 0) {
        console.log(`[UNIT-SPLITTER] Scene ${sceneIndex}: all ${units.length} units within ${MAX_UNIT_DURATION_SEC}s`);
        return units;
    }

    // Only update session progress when there's actual work to do
    const msg = PROGRESS_STAGES.splitting_long_units
        ? PROGRESS_STAGES.splitting_long_units(sceneIndex)
        : `⟳ Проверяю длительность юнитов сцены ${sceneIndex + 1}...`;
    _progress({ stage: 'splitting_long_units', message: msg });
    await updateSession(sessionId, { progress_msg: msg }).catch(err => {
        console.warn(`[UNIT-SPLITTER] Failed to update session progress: ${err.message}`);
    });

    console.log(`[UNIT-SPLITTER] Scene ${sceneIndex}: ${longUnits.length}/${units.length} units exceed ${MAX_UNIT_DURATION_SEC}s:`,
        longUnits.map(({ index, duration }) => `#${index}=${duration}s`).join(', '));

    // 2. Split each long unit (process right-to-left so indices stay valid)
    let result = [...units];
    for (const { index } of longUnits.sort((a, b) => b.index - a.index)) {
        result = await splitOneUnit(sessionId, result, index, result[index]);
    }

    // 3. Final verification: log results
    const finalLong = findLongUnits(result);
    if (finalLong.length > 0) {
        console.warn(`[UNIT-SPLITTER] Scene ${sceneIndex}: ${finalLong.length}/${result.length} units STILL exceed ${MAX_UNIT_DURATION_SEC}s after split`,
            finalLong.map(({ index, duration }) => `#${index}=${duration}s`).join(', '));
    } else {
        console.log(`[UNIT-SPLITTER] Scene ${sceneIndex}: all ${result.length} units OK (was ${units.length}) after split`);
    }

    // Debug: log post-split duration stats (always, even if unchanged)
    logDurationStats(result, 'after_split', sceneIndex);

    return result;
}

module.exports = {
    splitLongUnits,
    findLongUnits,
    getUnitDurationSec,
    logDurationStats,
    emergencySplit,
    splitBySentences,
    splitByCommas,
    splitByWordCount,
    // Exported for testing
    MAX_UNIT_DURATION_SEC,
    MAX_UNIT_SPLIT_RETRIES,
};
