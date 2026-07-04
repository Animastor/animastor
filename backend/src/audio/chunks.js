// ======================================================
// Audio Chunk Helpers
// ======================================================

const fs = require('fs');
const helpers = require('./helpers');

function findExistingSceneChunks(bookId, chapterId, sceneId, buildId) {
    const dir = helpers.getOutputPath(buildId);
    const escapedBookId = helpers.escapeRegExp(bookId);
    const escapedChapterId = helpers.escapeRegExp(chapterId);
    const escapedSceneId = helpers.escapeRegExp(sceneId);
    const chunkPrefix = `${escapedBookId}_${escapedChapterId}_${escapedSceneId}_`;
    const pattern = new RegExp(`^${chunkPrefix}\\d+\\.mp3$`);

    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => pattern.test(f))
            .map(f => {
                const match = f.match(chunkPrefix + '(\\d+)\\.mp3$');
                return match ? parseInt(match[1], 10) : null;
            })
            .filter(Boolean);
    } catch (err) {
        helpers.error(`findExistingSceneChunks error: ${err.message}`);
        return [];
    }
}

function allSceneChunksExist(bookId, chapterId, sceneId, buildId, expectedChunkCount) {
    const chunks = findExistingSceneChunks(bookId, chapterId, sceneId, buildId);
    return {
        exists: expectedChunkCount ? chunks.length === expectedChunkCount : chunks.length > 0,
        chunkCount: chunks.length
    };
}

function areSceneAudioChunksReady(bookId, chapterId, sceneId, buildId, expectedChunkCount) {
    const result = allSceneChunksExist(bookId, chapterId, sceneId, buildId, expectedChunkCount);
    return {
        ready: result.exists,
        chunkCount: result.chunkCount,
        expectedCount: expectedChunkCount || 'any'
    };
}

function makeChunkId(chapterId, sceneId, chunkIndex, bookId) {
    return `${bookId}_${chapterId}_${sceneId}_${String(chunkIndex).padStart(4, '0')}`;
}

function getChunkAudioPath(buildId, bookId, chapterId, sceneId, chunkIndex) {
    return helpers.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}_${String(chunkIndex).padStart(4, '0')}.mp3`);
}

module.exports = {
    findExistingSceneChunks,
    allSceneChunksExist,
    areSceneAudioChunksReady,
    makeChunkId,
    getChunkAudioPath,
};
