// ======================================================
// Audio Build Pipeline
// ======================================================

const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');
const ffmpeg = require('./ffmpeg');
const validation = require('./validation');
const chunks = require('./chunks');

function createConcatFile(chunks, buildId) {
    const concatContent = chunks
        .map(chunk => `file '${chunk}'`)
        .join('\n');
    const concatPath = path.join('/tmp', `concat_${buildId}_${Date.now()}.txt`);
    fs.writeFileSync(concatPath, concatContent);
    return concatPath;
}

async function buildSceneAudio(chunkPaths, finalPath, buildId = null, force = false) {
    if (!chunkPaths || !Array.isArray(chunkPaths) || chunkPaths.length === 0) {
        throw new Error("buildSceneAudio: chunks must be a non-empty array");
    }

    if (!finalPath || typeof finalPath !== 'string') {
        throw new Error("buildSceneAudio: finalPath must be a non-empty string");
    }

    if (!buildId) {
        const parts = finalPath.split(path.sep);
        const buildIdFromPath = parts[parts.length - 2];
        if (buildIdFromPath && !buildIdFromPath.includes(path.sep)) {
            buildId = buildIdFromPath;
        } else {
            helpers.error(`Could not extract valid buildId from finalPath: ${finalPath}`);
            return null;
        }
    }

    const outputDir = path.dirname(finalPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    if (!force && fs.existsSync(finalPath)) {
        try {
            const isValid = await validation.validateCanonicalAudio(finalPath);
            if (isValid) {
                helpers.log(`Canonical audio already exists and is valid: ${path.basename(finalPath)}`);
                return finalPath;
            } else {
                helpers.log(`Canonical audio exists but is invalid - will regenerate: ${path.basename(finalPath)}`);
                try { fs.unlinkSync(finalPath); } catch (e) {}
            }
        } catch (err) {
            helpers.warn(`Validation error, regenerating: ${err.message}`);
            try { fs.unlinkSync(finalPath); } catch (e) {}
        }
    }

    if (chunkPaths.length === 1) {
        const singleChunk = chunkPaths[0];
        helpers.log(`Processing single chunk through unified audio pipeline...`);

        const tempPath = finalPath.replace(/\.mp3$/, '.cleanup.mp3');

        try {
            helpers.log(`ffmpeg cleanup: trim tail and save to temp path...`);
            await ffmpeg.runFFmpegTrim(singleChunk, tempPath);

            fs.renameSync(tempPath, finalPath);
            helpers.log(`✅ Single chunk processed: ${path.basename(finalPath)}`);

            if (fs.existsSync(singleChunk)) {
                fs.unlinkSync(singleChunk);
                helpers.log(`🗑 Deleted temp chunk: ${path.basename(singleChunk)}`);
            }

            return finalPath;
        } catch (err) {
            helpers.error(`Audio processing failed: ${err.message}`);
            if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch (e) {}
            }
            if (fs.existsSync(finalPath)) {
                try { fs.unlinkSync(finalPath); } catch (e) {}
            }
            return null;
        }
    }

    helpers.log(`🎬 Merging ${chunkPaths.length} audio chunks with ffmpeg`);
    const concatContent = chunkPaths.map(ch => `file '${ch}'`).join('\n');
    helpers.log(`[DEBUG] MERGE concat order:\n${concatContent}`);
    const concatPath = createConcatFile(chunkPaths, buildId);

    try {
        const args = ['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', finalPath, '-y'];
        await ffmpeg.runFFmpegMerge(args);

        helpers.log(`✅ Audio merge completed: ${path.basename(finalPath)}`);

        helpers.log(`🎬 Applying final audio cleanup filter to canonical output...`);
        const tempCleanupPath = finalPath.replace('.mp3', '.cleanup.mp3');
        try {
            await ffmpeg.runFFmpegTrim(finalPath, tempCleanupPath);
            helpers.log(`✅ Final audio cleanup applied`);
            fs.unlinkSync(finalPath);
            fs.renameSync(tempCleanupPath, finalPath);
        } catch (cleanupErr) {
            helpers.warn(`⚠️ Cleanup on final output skipped/failed: ${cleanupErr.message}`);
            if (fs.existsSync(tempCleanupPath)) {
                try { fs.unlinkSync(tempCleanupPath); } catch (e) {}
            }
        }

        for (const chunk of chunkPaths) {
            if (fs.existsSync(chunk)) {
                try { fs.unlinkSync(chunk); } catch (e) {}
            }
        }
        if (fs.existsSync(concatPath)) {
            fs.unlinkSync(concatPath);
        }

        return finalPath;
    } catch (err) {
        helpers.error(`Audio merge failed: ${err.message}`);
        if (fs.existsSync(finalPath)) {
            try { fs.unlinkSync(finalPath); } catch (e) {}
        }
        if (fs.existsSync(concatPath)) {
            try { fs.unlinkSync(concatPath); } catch (e) {}
        }
        return null;
    }
}

async function mergeSceneAudioChunks(redis, bookId, chapterId, sceneId, buildId, expectedChunkCount = null) {
    const mergeLockKey = `animastor:audio-merge-lock:${bookId}:${chapterId}:${sceneId}`;
    const lockAcquired = await redis.set(mergeLockKey, buildId, 'NX', 'EX', 300);
    if (!lockAcquired) {
        helpers.log(`Audio merge already in progress: ${bookId}/${chapterId}/${sceneId}`);
        return null;
    }

    try {
        const finalPath = helpers.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
        const existingChunks = chunks.findExistingSceneChunks(bookId, chapterId, sceneId, buildId);

        helpers.log(`[DEBUG] MERGE: mergeSceneAudioChunks ${bookId}/${chapterId}/${sceneId}: found=${existingChunks.length} expected=${expectedChunkCount}`);

        if (existingChunks.length === 0) {
            helpers.warn(`[DEBUG] MERGE: No audio chunks found for scene: ${bookId}/${chapterId}/${sceneId}`);
            return null;
        }

        if (expectedChunkCount && existingChunks.length !== expectedChunkCount) {
            helpers.warn(`[DEBUG] MERGE: Not all chunks ready: found=${existingChunks.length}, expected=${expectedChunkCount}`);
            return null;
        }

        const chunkPaths = existingChunks.map(ch => helpers.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}_${String(ch).padStart(4, '0')}.mp3`));

        // Validate all chunk files have content > 0
        const MIN_CHUNK_BYTES = 100;
        const emptyChunks = [];
        for (let i = 0; i < chunkPaths.length; i++) {
            let size = 0;
            try { if (fs.existsSync(chunkPaths[i])) size = fs.statSync(chunkPaths[i]).size; } catch (_) {}
            helpers.log(`[DEBUG] MERGE: chunk ${i + 1}/${chunkPaths.length}: ${path.basename(chunkPaths[i])} = ${size} bytes`);
            if (size < MIN_CHUNK_BYTES) emptyChunks.push(i + 1);
        }
        if (emptyChunks.length > 0) {
            helpers.warn(`[DEBUG] MERGE: ${emptyChunks.length} chunk(s) are empty — will produce incomplete output: [${emptyChunks.join(',')}]`);
        }

        const result = await buildSceneAudio(chunkPaths, finalPath, buildId, true);
        helpers.log(`[DEBUG] MERGE: buildSceneAudio result=${result ? 'ok' : 'null'}`);
        return result;
    } catch (err) {
        helpers.error(`Audio merge error: ${err.message}`);
        return null;
    } finally {
        await redis.del(mergeLockKey);
    }
}

async function recoverSceneAudioFromChunks(bookId, chapterId, sceneId, buildId, expectedChunkCount = null) {
    const finalPath = helpers.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);

    if (fs.existsSync(finalPath)) {
        const isValid = await validation.validateCanonicalAudio(finalPath);
        if (isValid) {
            helpers.log(`Canonical audio already valid, nothing to recover: ${path.basename(finalPath)}`);
            return { recovered: true, path: finalPath, reason: 'already_valid' };
        }
        helpers.log(`Canonical audio exists but is invalid, will attempt recovery: ${path.basename(finalPath)}`);
        try { fs.unlinkSync(finalPath); } catch (e) {}
    }

    const existingChunks = chunks.findExistingSceneChunks(bookId, chapterId, sceneId, buildId);

    if (existingChunks.length === 0) {
        helpers.warn(`No audio chunks found for recovery: ${bookId}/${chapterId}/${sceneId}`);
        return { recovered: false, reason: 'no_chunks' };
    }

    const chunkCheck = chunks.allSceneChunksExist(bookId, chapterId, sceneId, buildId, expectedChunkCount);
    if (!chunkCheck.ready) {
        helpers.warn(`Not all chunks ready for recovery: ${bookId}/${chapterId}/${sceneId}`);
        return { recovered: false, reason: 'incomplete_chunks' };
    }

    const chunkPaths = existingChunks.map(c => helpers.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}_${String(c).padStart(4, '0')}.mp3`));

    try {
        const result = await buildSceneAudio(chunkPaths, finalPath, buildId, true);
        if (result) {
            helpers.log(`Audio recovery successful: ${path.basename(finalPath)}`);
            return { recovered: true, path: finalPath, reason: 'success' };
        }
        return { recovered: false, reason: 'merge_failed' };
    } catch (err) {
        helpers.error(`Audio recovery error: ${err.message}`);
        return { recovered: false, reason: 'error', error: err.message };
    }
}

module.exports = {
    createConcatFile,
    buildSceneAudio,
    mergeSceneAudioChunks,
    recoverSceneAudioFromChunks,
};
