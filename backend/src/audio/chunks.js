// ======================================================
// Audio Chunk Helpers
// ======================================================

const fs = require('fs');
const helpers = require('./helpers');

function findExistingSceneChunks(bookId, chapterId, sceneId, buildId, expectedCount = null) {
    const dir = helpers.getOutputPath(buildId);

    try {
        if (!fs.existsSync(dir)) return [];

        // ── ENUMERATION-BASED (когда expectedCount известен) ──
        // Вместо readdir + regexp перечисляем ожидаемые индексы 1..expectedCount
        // и проверяем каждый файл. Это детерминированно: не зависит от порядка
        // readdir (EXT4 hash table) и не требует сортировки.
        // (docs/02-orchestration/AUDIO_ORCH_ARCHITECTURAL_FIXES.md §6)
        if (expectedCount !== null && expectedCount > 0) {
            const chunks = [];
            for (let i = 1; i <= expectedCount; i++) {
                const chunkPath = helpers.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}_${String(i).padStart(4, '0')}.mp3`);
                if (fs.existsSync(chunkPath)) {
                    chunks.push(i);
                }
            }
            helpers.log(`findExistingSceneChunks: enumerated ${chunks.length}/${expectedCount} chunks: [${chunks.join(',')}]`);
            return chunks;
        }

        // ── FALLBACK: readdir-based (когда expectedCount не известен) ──
        const escapedBookId = helpers.escapeRegExp(bookId);
        const escapedChapterId = helpers.escapeRegExp(chapterId);
        const escapedSceneId = helpers.escapeRegExp(sceneId);
        const chunkPrefix = `${escapedBookId}_${escapedChapterId}_${escapedSceneId}_`;
        const pattern = new RegExp(`^${chunkPrefix}\\d+\\.mp3$`);

        const chunks = fs.readdirSync(dir)
            .filter(f => pattern.test(f))
            .map(f => {
                const match = f.match(chunkPrefix + '(\\d+)\\.mp3$');
                return match ? parseInt(match[1], 10) : null;
            })
            .filter(Boolean);
        // Defense-in-depth: sort numeric — filesystem order is undefined
        chunks.sort((a, b) => a - b);
        helpers.log(`findExistingSceneChunks: readdir-sorted ${chunks.length} chunks: [${chunks.join(',')}]`);
        return chunks;
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
