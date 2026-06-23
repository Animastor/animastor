const fs = require('fs');
const path = require('path');
const state = require('../state');
const runtimeScheduler = require('../runtime/runtime-scheduler');
const { log, warn } = require('./scene-utils');

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output';

async function restoreSceneChunkStatus(redis, buildId, bookId, chapterId, sceneId, hasDirtyUnits, unitIds) {
    const sceneWindow = require('../runtime/scene-window');

    const cacheInfo = await sceneWindow.checkSceneContentCache(redis, buildId, bookId, chapterId, sceneId);

    if (!cacheInfo.valid) {
        return { restored: false, reason: 'no_valid_content' };
    }

    if (!hasDirtyUnits) {
        await sceneWindow.restoreChunkStatusForScene(redis, buildId, bookId, chapterId, sceneId);
        await state.setSceneStateWithBuildId(redis, bookId, chapterId, sceneId, state.SceneState.VIDEO_READY, buildId);
        await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
        log(`[RESTORE] ${bookId}/${chapterId}/${sceneId}: fully restored, VIDEO_READY, removed from active index`);
        return { restored: true, reason: 'full_restore' };
    }

    if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
        const buildDir = path.join(OUTPUT_DIR, buildId);
        for (const unitId of unitIds) {
            const imageIUId = `${bookId}_${chapterId}_${sceneId}_${unitId}`;
            const pngPath = path.join(buildDir, `${imageIUId}.png`);
            try {
                if (fs.existsSync(pngPath)) {
                    fs.unlinkSync(pngPath);
                    log(`[RESTORE-PRE-DELETE] Deleted stale PNG: ${imageIUId}.png`);
                }
            } catch (delErr) {
                console.warn(`[RESTORE-PRE-DELETE] Failed to delete ${imageIUId}.png: ${delErr.message}`);
            }
            try {
                await redis.del(`animastor:job:${imageIUId}:image`);
                log(`[RESTORE-PRE-DELETE] Cleared GPU dedup for ${imageIUId}`);
            } catch (dedupErr) {
                console.warn(`[RESTORE-PRE-DELETE] Failed to clear dedup for ${imageIUId}: ${dedupErr.message}`);
            }
        }
    }

    await sceneWindow.restoreChunkStatusForScene(redis, buildId, bookId, chapterId, sceneId);
    log(`[RESTORE-PER-UNIT] ${bookId}/${chapterId}/${sceneId}: ${unitIds?.length || 0} dirty unit(s) — keeping in active index for per-unit dispatch, PNG pre-deleted`);
    return { restored: true, reason: 'per_unit_restore' };
}

module.exports = { restoreSceneChunkStatus };
