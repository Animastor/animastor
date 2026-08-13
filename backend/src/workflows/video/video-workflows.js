// ======================================================
// Video Workflows - v2.1.0 (Connector-aware)
// ======================================================
// Builds multi-image LTX workflows from scene/IU data.
// Uses the connector system to resolve nodeIds instead of
// hardcoded constants, enabling workflow changes without
// modifying backend code.

const book = require('../../book');
const wfLoader = require('../workflow-loader');
const profileOverride = require('../../services/profile-override');
const { tokensToString } = require('../../book/lazy-book/appearance');
const { resolveAssembly, DEFAULT_VIDEO_DEFAULTS } = require('../../image/assembly-profile');
const { normalizeCharacterRefs } = require('../../image/character-utils');
const { escapeRegExp } = require('../../image/helpers');

const logPrefix = '[WF-VIDEO]';

// Connector constants are no longer needed — connectors are required at startup

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// CONNECTOR HELPERS
// ======================================================

/**
 * Get connector for a workflow name.
 */
function getConnector(workflowName) {
    return wfLoader.getConnector(workflowName);
}

// ======================================================
// IU DURATION READER
// ======================================================
async function readIUMetadata(buildId, bookId, chapterId, sceneId, unitId) {
    try {
        const { query } = require('../../storage/postgres/database');
        const result = await query(`
            SELECT * FROM image_units
            WHERE build_id = $1 AND book_id = $2 AND chapter_id = $3 AND scene_id = $4 AND unit_id = $5
        `, [buildId, bookId, chapterId, sceneId, String(unitId)]);
        const row = result.rows[0];
        if (row) {
            return {
                unit_id: row.unit_id,
                scene_id: row.scene_id,
                chapter_id: row.chapter_id,
                book_id: row.book_id,
                scene_audio_file: row.scene_audio_file,
                scene_duration_sec: row.scene_duration_sec,
                text: row.text,
                text_length: row.text_length,
                text_proportion: row.text_proportion,
                estimated_duration_sec: row.estimated_duration_sec,
            };
        }
    } catch (err) {
        log(`Failed to read IU metadata from SQLite: ${err.message}`);
    }
    return null;
}

// ── Video token resolution ──────────────────────────────────────────
// video_tokens are 1-4 SHORT visual features per character, chosen by the AI
// agent (characters.md → global passport) and refined per scene by passport
// reconciliation (scene.passport[charId].video_tokens — a FULL override).
// This module only renders them (array | legacy string) and guards against
// exact duplicates within a scene.

/**
 * Comparison key for the duplicate guard: feature ORDER must not matter, so an
 * array token is sorted before joining. Legacy string tokens are used as-is.
 */
function tokenKey(tokens) {
    if (Array.isArray(tokens)) {
        return tokens.map(t => (typeof t === 'string' ? t.trim() : '')).filter(Boolean).sort().join(', ');
    }
    return tokensToString(tokens);
}

/**
 * Build "character_id: tokens." lines for the video prompt. A scene override
 * fully replaces the global token. Duplicate guard: if two participants in the
 * SAME scene resolve to the same feature SET (an agent collision —
 * order-insensitive), the second one falls back to its global passport token;
 * if that also collides, the line is dropped rather than emitting an
 * ambiguous reference.
 */
function buildCharLines(participants, loadedBook, scene) {
    const used = new Set();
    const lines = [];
    for (const id of participants) {
        const c = loadedBook.characters?.find(ch => ch.id === id);
        if (!c) continue;
        const sceneTokens = scene?.passport?.[c.id]?.video_tokens;
        const globalTokens = c.passport?.video_tokens;
        const sceneStr = tokensToString(sceneTokens);
        const globalStr = tokensToString(globalTokens);
        let chosen = sceneStr ? sceneTokens : globalTokens;
        let final = sceneStr || globalStr;
        if (final && used.has(tokenKey(chosen))) {
            // Scene token collides — try the global one instead.
            chosen = globalTokens;
            final = globalStr;
        }
        if (!final || used.has(tokenKey(chosen))) continue;
        used.add(tokenKey(chosen));
        // Trailing period guard: legacy string tokens may already end with '.'
        lines.push(`${c.id}: ${final.replace(/[.\s]+$/, '')}.`);
    }
    return lines;
}

// ── Generic group-reference anchoring ────────────────────────────────
// The video model maps storyboard lines to identity anchors by character_id.
// When an agent writes a generic plural noun ("the two men", "both
// characters") instead of the ids, the mapping breaks — the model sees an
// unknown new person. Deterministic repair at build time: if the action
// contains NO character_id but the unit's OWN image.prompt names the in-frame
// participants, substitute those ids for the group nouns. Character-less
// units (landscape/object/title) have no ids in the prompt → never touched.

function containsCharacterId(text, ids) {
    if (!text || !ids?.length) return false;
    return ids.some(id => {
        const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(id)}(?![\\p{L}\\p{N}_])`, 'iu');
        return re.test(text);
    });
}

/**
 * Deterministic identity anchor for a storyboard line. Replaces generic
 * plural group nouns with the character_ids the unit's image.prompt puts in
 * frame. Pronouns ("they"/"them") are rewritten ONLY when every scene
 * participant is in frame — otherwise they stay (ambiguous subset reference).
 * @param {string} action - normalized storyboard action text
 * @param {string[]} inFrameIds - character_ids present in the unit image.prompt
 * @param {string[]} allParticipants - scene.participants
 * @returns {string}
 */
function anchorGroupRefs(action, inFrameIds, allParticipants) {
    if (!action) return action;
    if (inFrameIds.length < 2) return action;
    // Already anchored to ANY scene participant (even one not in this unit's
    // frame) — don't touch it.
    if (containsCharacterId(action, allParticipants)) return action;

    const joined = inFrameIds.join(' and ');
    let out = action
        .replace(/\bthe two of them\b/gi, joined)
        .replace(/\bthe two men\b/gi, joined)
        .replace(/\bboth characters\b/gi, joined)
        .replace(/\bthe characters\b/gi, joined)
        .replace(/\bthe men\b/gi, joined)
        .replace(/\bthe two\b/gi, joined)
        .replace(/\bboth of them\b/gi, joined);

    // "they"/"them" are rewritten ONLY when (a) the whole scene group is in
    // frame (unambiguous) AND (b) the action STILL has no character_id after
    // the group-noun replacements above — otherwise the nouns already anchored
    // it and pronouns resolve naturally ("…between mikhail_berlioz and
    // ivan_ponyrev as they arrive").
    const allInFrame = allParticipants.length > 0 && inFrameIds.length === allParticipants.length;
    if (allInFrame && !containsCharacterId(out, allParticipants)) {
        out = out.replace(/\bthey\b/gi, joined).replace(/\bthem\b/gi, joined);
    }
    return out;
}

// ======================================================
// VIDEO PROMPT BUILDER (assembly-profile driven)
// ======================================================
// The final video prompt is assembled from SECTIONS in the order defined by the
// active assembly profile (ai/profiles/video/{profile}.json):
//   characters → storyboard → renderInfo  (ltx-2.3)
// Sections suppressed by the profile are skipped; defaults (negativeBase) also
// come from the profile. Default output is byte-identical to the pre-profile
// builder.

/**
 * Pure helper (testable): extract the video assembly-profile name from a
 * connector object. Returns null when no connector/profile exists — callers
 * fall back to the built-in assembly then (there is no 'default' profile).
 * @param {object|null} connector
 * @returns {string|null}
 */
function videoProfileNameFromConnector(connector) {
    return connector?.profile?.videoProfile || null;
}

/**
 * Build the final video prompt for a workflow group.
 * @param {object} sceneData — { book_id, chapter_id, scene_id, scene, chapter }
 * @param {object} loadedBook — book with characters + locations
 * @param {Array} units — image units of this workflow group
 * @param {Array<number>} iuDurations — per-unit durations (seconds)
 * @param {string} [profileName] — assembly profile name ('ltx-2.3', ...)
 * @returns {string}
 */
function buildVideoPrompt(sceneData, loadedBook, units, iuDurations, profileName) {
    const scene = sceneData.scene || sceneData.payload || {};
    const assembly = resolveAssembly('video', profileName);

    // 1. Characters with video tokens — one identity anchor per line (each
    //    "character_id: tokens." block on its own line for readability; newline
    //    is just a separator for the video model, like the storyboard lines).
    const participants = scene.participants || [];
    const charLines = buildCharLines(participants, loadedBook, scene);
    const charactersSection = charLines.length > 0 ? charLines.join('\n') : '';

    // 2. Location / environment context
    const locationId = scene.location?.id || '';
    const loc = loadedBook.locations?.[locationId];
    // Location environment is a global template — the scene environment
    // overrides it per-field (same pattern as image prompt-builder).
    const env = {
        ...(loc?.environment || {}),
        ...(scene.location?.environment || {}),
    };

    // 3. Storyboard per IU
    const storyboardParts = [];
    let cumulativeSec = 0;

    for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        const dur = Math.max(iuDurations[i] || MIN_IU_DURATION, MIN_IU_DURATION);
        const startSec = cumulativeSec;
        const endSec = cumulativeSec + dur;
        cumulativeSec = endSec;

        const descParts = [];

        // Image section (canonical) — shot, prompt from image section
        const shot = unit.image?.shot;
        const prompt = unit.image?.prompt;
        // Video-specific action (temporal change) — prefer video.action, fallback
        // to image prompt. Character references are normalized to character_ids
        // (same as the image directPrompt path) so the video model can map the
        // motion to the identity anchors in the characters section. Then generic
        // group nouns ("the two men", "both characters") are deterministically
        // anchored to the in-frame ids named by the unit's own image.prompt.
        const actionText = normalizeCharacterRefs(unit.video?.action || prompt, loadedBook.characters);
        const promptNorm = normalizeCharacterRefs(prompt || '', loadedBook.characters);
        const inFrameIds = participants.filter(id =>
            new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(id)}(?![\\p{L}\\p{N}_])`, 'i').test(promptNorm)
        );
        const action = anchorGroupRefs(actionText, inFrameIds, participants);

        if (shot) {
            descParts.push(`${shot.replace(/_/g, ' ')} shot`);
        }

        if (i === 0) {
            if (loc?.description) descParts.push(loc.description);
            if (env.time) descParts.push(env.time);
            if (env.weather) descParts.push(env.weather);
            if (env.atmosphere) descParts.push(env.atmosphere);
            if (env.mood) descParts.push(env.mood);
        }

        if (action) {
            descParts.push(action);
            // Derived active speaker: if dialogue unit has audio.speaker, add speaking behaviour
            if (unit.type === 'dialogue' && unit.audio?.speaker) {
                descParts.push(`${normalizeCharacterRefs(unit.audio.speaker, loadedBook.characters)} speaking with lip movement`);
            }
        } else if (prompt) {
            descParts.push(prompt);
        }

        const line = `${startSec.toFixed(1)}–${endSec.toFixed(1)}s: ${descParts.join('. ')}`;
        storyboardParts.push(line);
    }

    // 4. Render info footer
    const renderMode = scene.visual?.render || loadedBook?.manifest?.render?.mode || '';
    const renderInfo = `${VIDEO_FPS}fps${renderMode ? `; ${renderMode.replace(/_/g, ' ')}` : ''}`;

    // 5. Assemble sections in profile order (skip suppressed). Emitters return
    //    '' for empty/unknown sections, so the join stays clean (equivalent to
    //    the pre-profile blank-line structure).
    const sectionEmitters = {
        characters: () => charactersSection,
        storyboard: () => storyboardParts.join('\n'),
        renderInfo: () => renderInfo,
    };

    const parts = [];
    for (const section of assembly.sections) {
        if (assembly.suppress.has(section)) continue;
        const rendered = sectionEmitters[section]?.() || '';
        if (rendered) parts.push(rendered);
    }
    return parts.join('\n\n');
}

function resolveNegativePrompt(unit, scene) {
    return unit?.image?.negative
        || unit?.negative
        || unit?.negative_prompt
        || scene?.negative
        || scene?.visual?.negative
        || scene?.negative_prompt
        || scene?.visual?.negative_prompt
        || '';
}

/**
 * Build the workflow's negative prompt: per-unit custom negatives + the base
 * negative from the active assembly profile (default: still-frame/jitter guard).
 * @param {object} sceneData
 * @param {Array} units
 * @param {string} [negativeBase] — profile defaults.negativeBase (optional)
 * @returns {string}
 */
function buildVideoNegativePrompt(sceneData, units, negativeBase) {
    const scene = sceneData.scene || sceneData.payload || {};
    const baseNegative = negativeBase || DEFAULT_VIDEO_DEFAULTS.negativeBase;
    const customNegatives = units
        .map(unit => resolveNegativePrompt(unit, scene))
        .filter(Boolean);

    return customNegatives.length > 0
        ? `${[...new Set(customNegatives)].join(', ')}, ${baseNegative}`
        : baseNegative;
}

// ======================================================
// WORKFLOW BUILDER (single group)
// ======================================================
function buildWorkflowForGroup(groupInfo, units, iuDurations, sceneData, loadedBook, buildId, workflows) {
    const workflowName = groupInfo.name;
    const baseWorkflow = workflows[workflowName];
    if (!baseWorkflow) {
        log(`Workflow not found: ${workflowName}`);
        return { success: false, reason: `workflow_not_found: ${workflowName}` };
    }

    const wf = JSON.parse(JSON.stringify(baseWorkflow));
    const connector = getConnector(workflowName);
    const cl = require('../connector-loader');
    // Assembly profile drives final prompt structure + negative base.
    // A user override (global settings choice) wins; otherwise the connector's
    // profile.videoProfile ('ltx-2.3'); when neither is set the built-in
    // video assembly applies.
    const assembly = resolveAssembly('video', profileOverride.getOverride('video') || videoProfileNameFromConnector(connector));

    // Resolve guide nodes from the workflow (sorted by node ID for consistent ordering)
    const guideNodeIds = Object.entries(wf)
        .filter(([, v]) => v.class_type === 'LTXVAddGuide')
        .sort(([a], [b]) => parseInt(a) - parseInt(b))
        .map(([id]) => id);

    // Resolve node IDs from connector (required at startup)
    const loadImageNodeIds = cl.getNodeId(connector, 'sourceImages');
    const totalFramesNodeId = cl.getNodeId(connector, 'totalFrames');
    const positiveNodeId = cl.getNodeId(connector, 'positivePrompt');
    const negativeNodeId = cl.getNodeId(connector, 'negativePrompt');

    // 1. Calculate frames
    const { frameIndices, totalFrames } = calculateFrames(iuDurations);

    // 2. Set total frames via connector
    cl.setValue(wf, connector, 'totalFrames', totalFrames);

    // 3. Set image filenames, guide frame indices, and per-guide strengths
    for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        const imageNodeId = Array.isArray(loadImageNodeIds) ? loadImageNodeIds[i] : loadImageNodeIds;
        const guideNodeId = guideNodeIds[i];
        const imageName = `${sceneData.book_id}_${sceneData.chapter_id}_${sceneData.scene_id}_${unit.id}.png`;

        if (wf[imageNodeId]) {
            wf[imageNodeId].inputs.image = imageName;
        }

        if (guideNodeId && wf[guideNodeId]) {
            wf[guideNodeId].inputs.frame_idx = frameIndices[i];
            // Apply per-guide strength from connector (guideStrength_0, guideStrength_1, ...)
            const gs = cl.getBinding(connector, `guideStrength_${i}`);
            if (gs && gs.default !== undefined) {
                wf[guideNodeId].inputs.strength = gs.default;
            }
        }
    }

    // Fill unused LoadImage nodes with last available image
    const maxSlots = loadImageNodeIds?.length || 0;
    const lastImageName = `${sceneData.book_id}_${sceneData.chapter_id}_${sceneData.scene_id}_${units[units.length - 1].id}.png`;
    for (let i = units.length; i < maxSlots; i++) {
        const imageNodeId = Array.isArray(loadImageNodeIds) ? loadImageNodeIds[i] : null;
        if (imageNodeId && wf[imageNodeId]) {
            wf[imageNodeId].inputs.image = lastImageName;
        }
    }

    // 4. Set video filename prefix via connector
    const prefixValue = `video/${sceneData.book_id}_${sceneData.chapter_id}_${sceneData.scene_id}`;
    cl.setValue(wf, connector, 'outputFilenamePrefix', prefixValue);

    // 5. Set positive prompt via connector
    const prompt = buildVideoPrompt(sceneData, loadedBook, units, iuDurations, assembly.profileName);
    cl.setValue(wf, connector, 'positivePrompt', prompt);

    // 6. Set negative prompt via connector (base negative from the profile)
    cl.setValue(wf, connector, 'negativePrompt', buildVideoNegativePrompt(sceneData, units, assembly.defaults.negativeBase));

    log(`Built ${workflowName} workflow: ${units.length} IU(s), ${totalFrames} total frames`);

    return { success: true, workflow: wf };
}

// ======================================================
// MAIN ENTRY
// ======================================================
async function buildVideoWorkflows(sceneData, loadedBook, buildId, workflows) {
    const scene = sceneData.scene || sceneData.payload || {};
    const units = book.collectSceneUnits(scene) || [];

    if (units.length === 0) {
        log('No units found in scene');
        return { success: false, reason: 'no_units' };
    }

    const iuDurations = await Promise.all(units.map(async unit => {
        const meta = await readIUMetadata(
            buildId,
            sceneData.book_id,
            sceneData.chapter_id,
            sceneData.scene_id,
            unit.id
        );
        return meta ? (meta.estimated_duration_sec || MIN_IU_DURATION) : MIN_IU_DURATION;
    }));

    const groups = selectWorkflowGroups(units, iuDurations);
    log(`Scene has ${units.length} IU(s), split into ${groups.length} workflow group(s)`);

    const results = [];
    for (const group of groups) {
        const groupUnits = units.slice(group.offset, group.offset + group.count);
        const groupDurations = iuDurations.slice(group.offset, group.offset + group.count);

        const result = buildWorkflowForGroup(
            group,
            groupUnits,
            groupDurations,
            sceneData,
            loadedBook,
            buildId,
            workflows
        );

        if (!result.success) {
            return result;
        }

        results.push({
            workflowName: group.name,
            workflow: result.workflow,
            units: groupUnits,
            unitCount: group.count
        });
    }

    return { success: true, workflows: results };
}

// ======================================================
// LEGACY COMPAT - single image workflow builder
// ======================================================
function buildVideoWorkflow(scene, chapter, bookData) {
    const workflow = {
        "202": {
            inputs: {
                text: "blurry, low quality, still frame, jitter, flicker, artifacts"
            }
        },
        "203": {
            inputs: {
                text: buildVideoPromptLegacy(scene, chapter, bookData)
            }
        }
    };
    return workflow;
}

function buildVideoPromptLegacy(scene, chapter, book) {
    const bookTitle = book?.manifest?.title || book?.manifest?.name || '';
    const chapterTitle = chapter?.title || chapter?.name || '';
    const sceneType = scene?.type || 'narration';
    const location = scene?.location || '';

    let prompt = `Scene: ${sceneType}`;
    if (location) prompt += `, Location: ${location}`;
    if (chapterTitle) prompt += `, Chapter: ${chapterTitle}`;
    if (bookTitle) prompt += `, Book: ${bookTitle}`;

    return prompt;
}

function motionFromState(state) {
    if (!state) return '';
    if (state.includes('calm')) return 'minimal movement, subtle breathing';
    if (state.includes('agitated') || state.includes('heated')) return 'more active gestures, expressive movement';
    return '';
}

function buildCamera(scene) {
    const cam = scene?.visual?.camera;
    if (!cam) return '';
    return `${cam.shot} shot, ${cam.angle} angle`;
}

// ======================================================
// FRAME CALCULATORS
// ======================================================
const VIDEO_FPS = parseInt(process.env.VIDEO_FPS || '24', 10);
const LTX_FRAME_ALIGN = parseInt(process.env.LTX_FRAME_ALIGN || '8', 10);
const MIN_IU_DURATION = 1.0;

function calculateFrames(iuDurations) {
    const minFrames = Math.round(MIN_IU_DURATION * VIDEO_FPS);
    const frameCounts = [];
    for (const dur of iuDurations) {
        const frames = Math.max(minFrames, Math.round(dur * VIDEO_FPS));
        frameCounts.push(frames);
    }
    const frameIndices = [];
    let cumulative = 0;
    for (let i = 0; i < frameCounts.length; i++) {
        if (i === frameCounts.length - 1) {
            frameIndices.push(-1);
        } else {
            frameIndices.push(cumulative);
            cumulative += frameCounts[i];
        }
    }
    const totalFrames = toValidLTXFrames(frameCounts.reduce((a, b) => a + b, 0));
    return { frameIndices, frameCounts, totalFrames };
}

function toValidLTXFrames(rawTotal) {
    return Math.ceil((rawTotal - 1) / 8) * 8 + 1;
}

// ======================================================
// GROUP SPLITTER (LTX-drift aware)
// ======================================================
// Groups consecutive image units into video chunks. LTX 2.3 requires each
// generated clip to have a frame count of 8n+1 (official: 9, 17, 25, 33, ...).
// Every chunk pays this alignment "tax" (rounding its raw frame sum UP to a
// valid 8n+1), and the tax is paid PER CHUNK — so fewer, larger chunks keep
// the total video length closest to the audio track.
//
// DP chooses the grouping that minimises the sum of per-chunk alignment
// overhead (totalFrames − raw frames), so the concatenated scene video lands
// as close to the real audio duration as the 8n+1 constraint allows.
//
// Constraints:
//   - max 4 units per group (model limitation of current LTX workflows)
//   - group duration ≤ VIDEO_CHUNK_MAX_SEC (default 30s; LTX target is ~20s,
//     slightly longer groups are allowed when they cut alignment drift)
//   - soft penalty for groups exceeding VIDEO_CHUNK_TARGET_SEC (quality guard)

const VIDEO_CHUNK_TARGET_SEC = 20;
const VIDEO_CHUNK_MAX_SEC = parseInt(process.env.VIDEO_CHUNK_MAX_SEC || '30', 10);
const MAX_UNITS_PER_GROUP = 4;
const OVER_TARGET_PENALTY_PER_SEC = 0.25; // frames of virtual cost per second over 20s

// Alignment overhead (in frames) a group pays when its raw frame sum is
// rounded up to a valid LTX 8n+1 count. Zero means the group sum is already
// a valid frame count.
function groupAlignmentOverhead(iuDurations, start, end) {
    let rawFrames = 0;
    for (let i = start; i < end; i++) {
        const dur = Math.max(iuDurations[i] || MIN_IU_DURATION, MIN_IU_DURATION);
        rawFrames += Math.round(dur * VIDEO_FPS);
    }
    return toValidLTXFrames(rawFrames) - rawFrames;
}

function groupDuration(iuDurations, start, end) {
    let sec = 0;
    for (let i = start; i < end; i++) {
        sec += Math.max(iuDurations[i] || MIN_IU_DURATION, MIN_IU_DURATION);
    }
    return sec;
}

function selectWorkflowGroups(units, iuDurations) {
    const n = units.length;
    if (n === 0) return [];

    // dp[k] = { cost, from, groupSize } — minimal total cost to cover units[0..k)
    // cost = alignment overhead + over-target duration penalty.
    const dp = Array.from({ length: n + 1 }, () => ({ cost: Infinity, from: -1, groupSize: 0 }));
    dp[0] = { cost: 0, from: -1, groupSize: 0 };

    for (let k = 0; k < n; k++) {
        if (dp[k].cost === Infinity) continue;
        // Try group sizes from largest to smallest so that, on equal cost,
        // the leftmost groups end up largest (stable, predictable grouping).
        for (let g = MAX_UNITS_PER_GROUP; g >= 1; g--) {
            const end = k + g;
            if (end > n) continue;
            if (g > 1) {
                const sec = groupDuration(iuDurations, k, end);
                if (sec > VIDEO_CHUNK_MAX_SEC) continue;
            }
            const overhead = groupAlignmentOverhead(iuDurations, k, end);
            const sec = groupDuration(iuDurations, k, end);
            const overTarget = Math.max(0, sec - VIDEO_CHUNK_TARGET_SEC) * OVER_TARGET_PENALTY_PER_SEC;
            const cost = dp[k].cost + overhead + overTarget;
            // `<=` keeps the last best candidate — combined with descending g
            // this prefers larger leftmost groups on ties.
            if (cost <= dp[end].cost) {
                dp[end] = { cost, from: k, groupSize: g };
            }
        }
    }

    const groups = [];
    let k = n;
    while (k > 0) {
        const { from, groupSize } = dp[k];
        if (from === -1) break; // safety — should not happen for k > 0
        groups.push({ offset: from, count: groupSize, name: `video-ltx-${groupSize}p` });
        k = from;
    }
    return groups.reverse();
}

// ======================================================
// EXPORTS
// ======================================================
module.exports = {
    buildVideoWorkflows,
    buildVideoWorkflow,
    buildVideoPrompt,
    buildVideoNegativePrompt,
    buildVideoPromptLegacy,
    videoProfileNameFromConnector,
    buildCharLines,
    anchorGroupRefs,
    containsCharacterId,
    motionFromState,
    buildCamera,
    selectWorkflowGroups,
    calculateFrames,
    toValidLTXFrames
};
