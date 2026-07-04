// ======================================================
// IU Image Registry
// ======================================================
// IU image registration, probing, and scene unit collection.

const path = require('path');
const fs = require('fs');
const config = require('../config/runtime-config');
const helpers = require('./helpers');

async function saveIURegistry(redis, iuId, buildId) {
    const key = `${config.REDIS.IU_REGISTRY_PREFIX}:${iuId}`;
    await redis.set(key, JSON.stringify({ build_id: buildId, iu_id: iuId, ts: Date.now() }), 'EX', 86400);
}

async function getIURegistry(redis, iuId) {
    const key = `${config.REDIS.IU_REGISTRY_PREFIX}:${iuId}`;
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
}

function probeIUImage(iuId, buildId, OUTPUT_DIR) {
    const dir = path.join(OUTPUT_DIR, buildId);
    try {
        if (!fs.existsSync(dir)) {
            return { image: false, path: null };
        }
        const imgPath = path.join(dir, `${iuId}.png`);
        if (fs.existsSync(imgPath)) {
            return { image: true, path: imgPath };
        }
        return { image: false, path: null };
    } catch (err) {
        helpers.error(`probeIUImage error: ${err.message}`);
        return { image: false, path: null };
    }
}

function resolveCanonicalSceneImage(OUTPUT_DIR, buildId, bookId, chapterId, sceneId) {
    const dir = path.join(OUTPUT_DIR, buildId);
    const scenePrefix = `${bookId}_${chapterId}_${sceneId}_iu`;

    try {
        if (!fs.existsSync(dir)) {
            return null;
        }
        const files = fs.readdirSync(dir);
        const iuImages = files.filter(f => f.startsWith(scenePrefix) && f.endsWith('.png'));
        if (iuImages.length > 0) {
            iuImages.sort();
            helpers.log(`CANONICAL IU IMAGE: ${iuImages[0]}`);
            return iuImages[0];
        }
    } catch (err) {
        helpers.error(`Error scanning IU images for scene: ${bookId}/${chapterId}/${sceneId}`, err.message);
    }
    return null;
}

function collectSceneUnits(scenePayload) {
    const result = [];
    if (scenePayload?.units?.length) {
        result.push(...scenePayload.units);
    }
    if (scenePayload?.dialogue_blocks?.length) {
        for (const block of scenePayload.dialogue_blocks) {
            if (block?.units?.length) {
                result.push(...block.units);
            }
        }
    }
    return result;
}

module.exports = {
    saveIURegistry,
    getIURegistry,
    probeIUImage,
    resolveCanonicalSceneImage,
    collectSceneUnits,
};
