// ======================================================
// Video Service - v2.0.0 (Multi-Image LTX)
// ======================================================
// Handles video generation with multi-image LTX workflows,
// lock management, and GPU hub dispatch.

const config = require('../config/runtime-config');
const path = require('path');
const fs = require('fs');
const wfBuilder = require('../workflows/video/video-workflows');
const gpu = require('../runtime/gpu-dispatcher');
const jobSchema = require('../runtime/job-schema');

const OUTPUT_DIR = config.OUTPUT_DIR;
const FPS = 24;

const logPrefix = '[VIDEO]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

// ======================================================
// PATH HELPERS
// ======================================================
function getOutputPath(...parts) {
    return path.join(OUTPUT_DIR, ...parts.filter(Boolean));
}

// ======================================================
// VIDEO LOCK METRICS
// ======================================================
let activeVideoLocks = 0;

function incrementVideoLocks() {
    activeVideoLocks++;
}

function decrementVideoLocks() {
    if (activeVideoLocks > 0) activeVideoLocks--;
}

function getActiveVideoLocks() {
    return activeVideoLocks;
}

// ======================================================
// IMAGE READING FOR GPU ASSETS
// ======================================================
function readImageAsBase64(buildId, imageName) {
    const imgPath = getOutputPath(buildId, imageName);
    if (!fs.existsSync(imgPath)) {
        error(`IMAGE MISSING: ${imgPath}`);
        return null;
    }
    const stats = fs.statSync(imgPath);
    if (stats.size < 1024) {
        error(`IMAGE TOO SMALL: ${imgPath} (${stats.size} bytes)`);
        return null;
    }
    try {
        const data = fs.readFileSync(imgPath);
        return data.toString('base64');
    } catch (err) {
        error(`Failed to read image: ${imgPath} - ${err.message}`);
        return null;
    }
}

// ======================================================
// MULTI-IMAGE VIDEO GENERATION
// ======================================================
// Generates video using the appropriate multi-image LTX workflow.
// Returns array of job specs, one per workflow group.
// Each job spec includes params (workflow JSON) and assets (multiple images).
async function generateVideoAnimation(sceneData, loadedBook, buildId, workflows, dispatchId) {
    // Build multi-image workflows
    const buildResult = await wfBuilder.buildVideoWorkflows(sceneData, loadedBook, buildId, workflows);
    if (!buildResult.success) {
        error(`Workflow build failed: ${buildResult.reason}`);
        return { success: false, reason: buildResult.reason };
    }

    const baseJobId = `${sceneData.book_id}_${sceneData.chapter_id}_${sceneData.scene_id}`;
    const jobSpecs = [];

    for (let g = 0; g < buildResult.workflows.length; g++) {
        const wfGroup = buildResult.workflows[g];
        const suffix = g > 0 ? `_g${g + 1}` : '';
        const jobId = `${baseJobId}${suffix}`;

        // Read images for this workflow group
        const images = {};
        let allImagesFound = true;
        for (const unit of wfGroup.units) {
            const imageName = `${sceneData.book_id}_${sceneData.chapter_id}_${sceneData.scene_id}_${unit.id}.png`;
            const base64 = readImageAsBase64(buildId, imageName);
            if (!base64) {
                allImagesFound = false;
                break;
            }
            images[unit.id] = base64;
        }
        if (!allImagesFound) {
            error(`Images missing for workflow group ${g + 1}: ${jobId}`);
            return { success: false, reason: 'images_missing' };
        }

        jobSpecs.push({
            job_id: jobSchema.buildJobId(jobId, 'video'),
            params: wfGroup.workflow,
            job_type: 'video',
            assets: { images },
            build_id: buildId,
            dispatch_id: dispatchId,
            workflow_name: wfGroup.workflowName,
            unit_ids: wfGroup.units.map(u => u.id)
        });
    }

    log(`Generated ${jobSpecs.length} video job(s) for ${baseJobId}`);
    return { success: true, jobSpecs };
}

// ======================================================
// VIDEO VALIDATION HELPERS
// ======================================================
async function isSceneVideoReady(buildId, bookId, chapterId, sceneId, getSceneVideoRegistry) {
    const videoPath = getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp4`);
    const fileExists = fs.existsSync(videoPath);
    if (!fileExists) return false;
    const registry = await getSceneVideoRegistry(bookId, chapterId, sceneId);
    return registry?.status === 'ready';
}

function validateVideoFile(videoPath) {
    try {
        if (!fs.existsSync(videoPath)) return { valid: false, reason: 'not_found' };
        const stats = fs.statSync(videoPath);
        if (stats.size < 10240) return { valid: false, reason: 'too_small' };
        return { valid: true, size: stats.size };
    } catch (err) {
        return { valid: false, reason: 'error', message: err.message };
    }
}

// ======================================================
// SCENE VIDEO REGISTRY
// ======================================================
async function updateSceneVideoStatus(redis, bookId, chapterId, sceneId, status) {
    const data = await getSceneVideoRegistry(redis, bookId, chapterId, sceneId) || {
        book_id: bookId,
        chapter_id: chapterId,
        scene_id: sceneId,
        status: 'pending',
        created_at: Date.now()
    };
    data.status = status;
    data.updated_at = Date.now();
    const key = `animastor:scene-video:${bookId}:${chapterId}:${sceneId}`;
    await redis.set(key, JSON.stringify(data), 'EX', 86400);
    return data;
}

async function getSceneVideoRegistry(redis, bookId, chapterId, sceneId) {
    const key = `animastor:scene-video:${bookId}:${chapterId}:${sceneId}`;
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
}

// ======================================================
// WORKER AVAILABILITY
// ======================================================
function isVideoAvailable(workflows) {
    return !!(workflows && (
        workflows['video-ltx'] ||
        workflows['video-ltx-1p'] ||
        workflows['video-ltx-2p'] ||
        workflows['video-ltx-3p'] ||
        workflows['video-ltx-4p']
    ));
}

// ======================================================
// EXPORTS
// ======================================================
module.exports = {
    getOutputPath,
    incrementVideoLocks,
    decrementVideoLocks,
    getActiveVideoLocks,

    isSceneVideoReady,
    validateVideoFile,
    isVideoAvailable,

    updateSceneVideoStatus,
    getSceneVideoRegistry,

    generateVideoAnimation

};
