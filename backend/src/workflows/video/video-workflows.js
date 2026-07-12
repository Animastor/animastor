// ======================================================
// Video Workflows - v2.1.0 (Connector-aware)
// ======================================================
// Builds multi-image LTX workflows from scene/IU data.
// Uses the connector system to resolve nodeIds instead of
// hardcoded constants, enabling workflow changes without
// modifying backend code.

const book = require('../../book');
const wfLoader = require('../workflow-loader');

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

// ======================================================
// VIDEO PROMPT BUILDER
// ======================================================
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
    const loc = loadedBook.locations?.[locationId];

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
        // Video-specific action (temporal change) — prefer video.action, fallback to image prompt
        const action = unit.video?.action || prompt;

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
                descParts.push(`${unit.audio.speaker} speaking with lip movement`);
            }
        } else if (prompt) {
            descParts.push(prompt);
        }

        const line = `${startSec.toFixed(1)}–${endSec.toFixed(1)}s: ${descParts.join('. ')}`;
        storyboardParts.push(line);
    }

    const promptParts = [];
    if (charLines.length > 0) {
        promptParts.push(charLines.join(' '));
        promptParts.push('');
    }
    promptParts.push(storyboardParts.join('\n'));
    promptParts.push('');

    const renderMode = scene.visual?.render || loadedBook?.manifest?.render?.mode || '';
    promptParts.push(`${VIDEO_FPS}fps${renderMode ? `; ${renderMode.replace(/_/g, ' ')}` : ''}`);

    return promptParts.join('\n');
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
    const connector = getConnector(workflowName);
    const cl = require('../connector-loader');

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
    const prompt = buildVideoPrompt(sceneData, loadedBook, units, iuDurations);
    cl.setValue(wf, connector, 'positivePrompt', prompt);

    // 6. Set negative prompt via connector
    cl.setValue(wf, connector, 'negativePrompt', buildVideoNegativePrompt(sceneData, units));

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
// GROUP SPLITTER
// ======================================================
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
