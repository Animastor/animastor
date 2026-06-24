const fs = require('fs');
const path = require('path');
const state = require('../state');
const runtimeScheduler = require('../runtime/runtime-scheduler');
const { log, warn } = require('./scene-utils');

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output';

async function restoreSceneChunkStatus(redis, buildId, bookId, chapterId, sceneId, hasDirtyUnits, unitIds) {
    const sceneWindow = require('../runtime/scene-window');
    const buildDir = path.join(OUTPUT_DIR, buildId);
    const fileStatus = await sceneWindow.getSceneFilesStatus(buildDir, bookId, chapterId, sceneId);

    if (!hasDirtyUnits) {
        // Нет информации о конкретных dirty-юнитах (например, rebuild_all=true).
        // Проверяем, есть ли какой-либо контент на диске.
        const hasAnyContent = fileStatus.audio.exists || fileStatus.image.exists || fileStatus.video.exists;
        if (!hasAnyContent) {
            log(`[RESTORE-SKIP] ${bookId}/${chapterId}/${sceneId}: no content on disk — leaving as-is for regeneration`);
            return { restored: false, reason: 'no_content' };
        }

        // Контент существует на диске (от предыдущей генерации).
        // Восстанавливаем чанки, чтобы /assets-state показывал корректный прогресс
        // (файлы, которые уже есть на диске).
        await sceneWindow.restoreChunkStatusForScene(redis, buildId, bookId, chapterId, sceneId);

        // НЕ выставляем VIDEO_READY — сцена остаётся в active-scenes,
        // и шедулер запустит перегенерацию всех слоёв.
        // Per-asset state остаётся PENDING (как установлено Lua-скриптом markDirtyScenes).
        // syncLinearState сам выведет корректное составное состояние.
        await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);

        log(`[RESTORE-PARTIAL] ${bookId}/${chapterId}/${sceneId}: chunks restored from disk (audio=${fileStatus.audio.exists}, image=${fileStatus.image.exists}), keeping pending for regeneration`);
        return { restored: true, reason: 'partial_restore' };
    }

    // Есть конкретные dirty-юниты (изменён visual prompt и т.п.).
    // Удаляем stale PNG для этих юнитов, чтобы GPU обязательно перегенерировал их.
    if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
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

    // Аудио не было затронуто изменением visual prompt — восстанавливаем.
    await sceneWindow.restoreChunkStatusForScene(redis, buildId, bookId, chapterId, sceneId);

    // Audio: не затронуто, оставляем READY (если файл существует).
    if (fileStatus.audio.exists) {
        await state.setAssetState(redis, bookId, chapterId, sceneId, 'audio', state.AssetState.READY);
    }
    // Image: всегда DIRTY — при наличии dirty-юнитов визуальный контент
    // нужно перегенерировать. Если сюда попали с hasDirtyUnits=true,
    // значит есть изменения, влияющие на image.
    await state.setAssetState(redis, bookId, chapterId, sceneId, 'image', state.AssetState.DIRTY);
    await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);

    log(`[RESTORE-PER-UNIT] ${bookId}/${chapterId}/${sceneId}: ${unitIds?.length || 0} dirty unit(s) — audio=${fileStatus.audio.exists}, image=${unitIds?.length > 0 ? 'dirty' : fileStatus.image.exists}, PNG pre-deleted`);
    return { restored: true, reason: 'per_unit_restore' };
}

module.exports = { restoreSceneChunkStatus };
