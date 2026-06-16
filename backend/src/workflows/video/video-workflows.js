// ======================================================
// Video Workflows - v2.0.0 (Multi-Image LTX)
// ======================================================
// Builds multi-image LTX workflows from scene/IU data.
// Selects 1p/2p/3p/4p workflow based on IU count,
// assigns frame indices, images, prompts, and total frames.

const book = require('../../book');

const logPrefix = '[WF-VIDEO]';

// Node IDs shared across all video-ltx-* workflows.
// GUIDE nodes are resolved dynamically per workflow.
const NODE = {
    TOTAL_FRAMES: '112',
    POSITIVE: '121',
    NEGATIVE: '110',
    LOAD_IMAGE: ['149', '179', '187', '216'],
};
function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// IU DURATION READER
// ======================================================
// Reads IU metadata from PostgreSQL (preferred) or JSON file (fallback)
async function readIUMetadata(buildId, bookId, chapterId, sceneId, unitId) {
    // Try PG first
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

// ======================================================
// VIDEO PROMPT BUILDER
// ======================================================
// Format:
//   character1: video_tokens. character2: video_tokens.
//
//   0.0–3.0s: Shot description. Environment. Visual.
//   3.0–7.0s: Shot. Character description. Visual.
//
//   24fps; cinematic realism.
function buildVideoPrompt(sceneData, loadedBook, units, iuDurations) {
    const scene = sceneData.scene || sceneData.payload || {};
    const chapterData = sceneData.chapter || {};

    // 1. Characters with video tokens
    const participants = scene.participants || [];
    const charLines = participants
        .map(id => loadedBook.characters?.find(c => c.id === id))
        .filter(Boolean)
        .map(c => {
            const tokens = c.passport?.video_tokens || '';
            return tokens ? `${c.name}: ${tokens}` : null;
        })
        .filter(Boolean);

    // 2. Location / environment context
    const env = scene.location?.environment || {};
    const locationId = scene.location?.id || '';
    const loc = loadedBook.bible?.locations?.[locationId];

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

        // Shot type
        if (unit.visual?.shot) {
            descParts.push(`${unit.visual.shot.replace(/_/g, ' ')} shot`);
        }

        // Environment for establishing shot (first IU)
        if (i === 0) {
            if (loc?.description) descParts.push(loc.description);
            if (env.time) descParts.push(env.time);
            if (env.weather) descParts.push(env.weather);
            if (env.atmosphere) descParts.push(env.atmosphere);
            if (env.mood) descParts.push(env.mood);
        }

        // Participating character visuals
        if (unit.participants?.length) {
            const chars = unit.participants
                .filter(id => id !== 'author')
                .map(id => loadedBook.characters?.find(c => c.id === id))
                .filter(Boolean);
            for (const c of chars) {
                if (c.passport?.video_tokens) {
                    descParts.push(`${c.name} (${c.passport.video_tokens})`);
                }
            }
        }

        // Visual prompt
        if (unit.visual?.prompt) {
            descParts.push(unit.visual.prompt);
        }

        const line = `${startSec.toFixed(1)}–${endSec.toFixed(1)}s: ${descParts.join('. ')}`;
        storyboardParts.push(line);
    }

    // 4. Assemble final prompt
    const promptParts = [];

    if (charLines.length > 0) {
        promptParts.push(charLines.join(' '));
        promptParts.push('');
    }

    promptParts.push(storyboardParts.join('\n'));
    promptParts.push('');

    // Footer: FPS + render mode
    const renderMode = scene.visual?.render || loadedBook?.manifest?.render?.mode || '';
    promptParts.push(`${VIDEO_FPS}fps${renderMode ? `; ${renderMode.replace(/_/g, ' ')}` : ''}`);

    return promptParts.join('\n');
}

function resolveNegativePrompt(unit, scene) {
    return unit?.visual?.negative
        || unit?.negative
        || unit?.negative_prompt
        || unit?.visual?.negative_prompt
        || scene?.negative
        || scene?.visual?.negative
        || scene?.negative_prompt
        || scene?.visual?.negative_prompt
        || '';
}

function buildVideoNegativePrompt(sceneData, units) {
    const scene = sceneData.scene || sceneData.payload || {};
    const baseNegative = 'blurry, low quality, still frame, jitter, flicker, artifacts';
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

    // Resolve LTXVAddGuide nodes from the workflow (sorted by node ID for consistent ordering)
    const guideNodeIds = Object.entries(wf)
        .filter(([, v]) => v.class_type === 'LTXVAddGuide')
        .sort(([a], [b]) => parseInt(a) - parseInt(b))
        .map(([id]) => id);

    // 1. Calculate frames
    const { frameIndices, totalFrames } = calculateFrames(iuDurations);

    // 2. Set total frames
    wf[NODE.TOTAL_FRAMES].inputs.value = totalFrames;

    // 3. Set image filenames and guide frame indices
    for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        const imageNodeId = NODE.LOAD_IMAGE[i];
        const guideNodeId = guideNodeIds[i];
        const imageName = `${sceneData.book_id}_${sceneData.chapter_id}_${sceneData.scene_id}_${unit.id}.png`;

        // Set LoadImage filename
        if (wf[imageNodeId]) {
            wf[imageNodeId].inputs.image = imageName;
        }

        // Set frame_idx on LTXVAddGuide
        if (guideNodeId && wf[guideNodeId]) {
            wf[guideNodeId].inputs.frame_idx = frameIndices[i];
        }
    }

    // Fill unused LoadImage nodes with last available image so ComfyUI validation passes
    const lastImageName = `${sceneData.book_id}_${sceneData.chapter_id}_${sceneData.scene_id}_${units[units.length - 1].id}.png`;
    for (let i = units.length; i < NODE.LOAD_IMAGE.length; i++) {
        const imageNodeId = NODE.LOAD_IMAGE[i];
        if (wf[imageNodeId]) {
            wf[imageNodeId].inputs.image = lastImageName;
        }
    }

    // 4. Set video filename prefix to scene ID for precise FS detection
    if (wf['75']) {
        wf['75'].inputs.filename_prefix = `video/${sceneData.book_id}_${sceneData.chapter_id}_${sceneData.scene_id}`;
    }

    // 5. Set positive prompt
    const prompt = buildVideoPrompt(sceneData, loadedBook, units, iuDurations);
    if (wf[NODE.POSITIVE]) {
        wf[NODE.POSITIVE].inputs.text = prompt;
    }

    // 5. Set negative prompt for this IU group
    if (wf[NODE.NEGATIVE]) {
        wf[NODE.NEGATIVE].inputs.text = buildVideoNegativePrompt(sceneData, units);
    }

    log(`Built ${workflowName} workflow: ${units.length} IU(s), ${totalFrames} total frames`);

    return { success: true, workflow: wf };
}

// ======================================================
// MAIN ENTRY
// ======================================================
// Builds all video workflows for a scene.
// Returns { success, workflows: [{ workflowName, workflow, units, unitCount }] }
async function buildVideoWorkflows(sceneData, loadedBook, buildId, workflows) {
    const scene = sceneData.scene || sceneData.payload || {};
    const units = book.collectSceneUnits(scene) || [];

    if (units.length === 0) {
        log('No units found in scene');
        return { success: false, reason: 'no_units' };
    }

    // Read IU durations from PG metadata
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

    const groups = selectWorkflowGroups(units.length);
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

// Old prompt builder (kept for backward compat)
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
const LTX_FRAME_ALIGN = parseInt(process.env.LTX_FRAME_ALIGN || '8', 10); // LTX requires % 8
const MIN_IU_DURATION = 1.0; // minimum IU duration in seconds

/**
 * Calculate frame indices per IU, per-IU frame counts, and total frames.
 * Frame indices mark where each IU starts. Last IU gets -1 (end-of-video marker).
 * Total frames = sum of all IU frames + 1 (LTX tail padding).
 */
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
            frameIndices.push(-1); // last IU uses remaining frames
        } else {
            frameIndices.push(cumulative);
            cumulative += frameCounts[i];
        }
    }
    const totalFrames = toValidLTXFrames(frameCounts.reduce((a, b) => a + b, 0));
    return { frameIndices, frameCounts, totalFrames };
}

function toValidLTXFrames(rawTotal) {
    // LTX requires 8n+1 frames: round up to nearest 8n+1
    return Math.ceil((rawTotal - 1) / 8) * 8 + 1;
}

// ======================================================
// GROUP SPLITTER
// ======================================================
// Splits N IUs into workflow groups (max 4 per group, LTX limit).
// Returns [{ offset, count, name }] where name = "${count}p"
function selectWorkflowGroups(unitCount) {
    const groups = [];
    let offset = 0;
    while (offset < unitCount) {
        const remaining = unitCount - offset;
        const count = Math.min(remaining, 4);
        groups.push({ offset, count, name: `video-ltx-${count}p` });
        offset += count;
    }
    return groups;
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
    motionFromState,
    buildCamera,
    selectWorkflowGroups,
    calculateFrames,
    toValidLTXFrames
};
