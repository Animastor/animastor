// ======================================================
// Audio Validation
// ======================================================

const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

async function validateCanonicalAudio(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        helpers.warn(`validateCanonicalAudio: invalid path`);
        return false;
    }

    if (!fs.existsSync(filePath)) {
        helpers.warn(`validateCanonicalAudio: file does not exist: ${filePath}`);
        return false;
    }

    const stats = fs.statSync(filePath);
    if (stats.size < 1024) {
        helpers.warn(`validateCanonicalAudio: file too small: ${filePath} (${stats.size} bytes)`);
        return false;
    }

    try {
        const mm = require('music-metadata');
        const metadata = await mm.parseFile(filePath);
        const duration = metadata.format.duration || 0;

        if (duration <= 0) {
            helpers.warn(`validateCanonicalAudio: invalid duration: ${filePath} (${duration}s)`);
            return false;
        }

        if (duration > 7200) {
            helpers.warn(`validateCanonicalAudio: suspiciously long duration: ${filePath} (${duration}s)`);
            return false;
        }

        return true;
    } catch (err) {
        helpers.warn(`validateCanonicalAudio: parse error: ${filePath} ${err.message}`);
        return false;
    }
}

async function isSceneAudioReady(buildId, bookId, chapterId, sceneId) {
    const audioPath = helpers.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);

    if (!fs.existsSync(audioPath)) {
        return false;
    }

    return await validateCanonicalAudio(audioPath);
}

async function getAudioDuration(filePath) {
    try {
        const mm = require('music-metadata');
        const metadata = await mm.parseFile(filePath);
        return metadata.format.duration || 0;
    } catch (err) {
        return 0;
    }
}

module.exports = {
    validateCanonicalAudio,
    isSceneAudioReady,
    getAudioDuration,
};
