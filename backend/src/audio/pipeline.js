// ======================================================
// Audio Build Pipeline
// ======================================================

const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');
const ffmpeg = require('./ffmpeg');
const validation = require('./validation');
const chunks = require('./chunks');

// TEMPORARY (research): when set, source audio chunks are NOT deleted after merge
// so their real durations can be measured while they are still on disk.
const KEEP_AUDIO_CHUNKS = !!process.env.KEEP_AUDIO_CHUNKS;

// TEMPORARY (research): when set, final cleanup trims ONLY the trailing silence
// (tail-only) instead of removing silence from the middle of the file.
// This keeps Σ(chunk durations) ≈ merged duration, which is what video sync needs.
const CLEANUP_TAIL_ONLY = !!process.env.AUDIO_CLEANUP_TAIL_ONLY;

// TEMPORARY (research): when set, real durations of every source chunk (raw and
// after tail-only trim) are measured before merge and written next to the merged
// file as <scene>.chunk-durations.json — for comparing against video chunk timings.
const TRACK_CHUNK_DURATIONS = !!process.env.TRACK_CHUNK_DURATIONS;

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
            await ffmpeg.runFFmpegTrim(singleChunk, tempPath, 0, null, CLEANUP_TAIL_ONLY);

            fs.renameSync(tempPath, finalPath);
            helpers.log(`✅ Single chunk processed: ${path.basename(finalPath)}`);

            if (fs.existsSync(singleChunk)) {
                if (KEEP_AUDIO_CHUNKS) {
                    helpers.log(`🔒 KEEP_AUDIO_CHUNKS: keeping single chunk: ${path.basename(singleChunk)}`);
                } else {
                    fs.unlinkSync(singleChunk);
                    helpers.log(`🗑 Deleted temp chunk: ${path.basename(singleChunk)}`);
                }
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
    const concatPath = createConcatFile(chunkPaths, buildId);

    try {
        const args = ['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', finalPath, '-y'];
        await ffmpeg.runFFmpegMerge(args);

        helpers.log(`✅ Audio merge completed: ${path.basename(finalPath)}`);

        helpers.log(`🎬 Applying final audio cleanup filter to canonical output...`);
        const tempCleanupPath = finalPath.replace('.mp3', '.cleanup.mp3');
        try {
            await ffmpeg.runFFmpegTrim(finalPath, tempCleanupPath, 0, null, CLEANUP_TAIL_ONLY);
            helpers.log(`✅ Final audio cleanup applied${CLEANUP_TAIL_ONLY ? ' (TAIL-ONLY mode)' : ''}`);
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
                if (KEEP_AUDIO_CHUNKS) {
                    helpers.log(`🔒 KEEP_AUDIO_CHUNKS: keeping chunk: ${path.basename(chunk)}`);
                } else {
                    try { fs.unlinkSync(chunk); } catch (e) {}
                }
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

// TEMPORARY (research): measure real durations of every source chunk before merge.
// raw = duration as-is on disk; tail = duration after the same tail-only trim that
// the final cleanup applies. Chunks are bound to their source unit via Redis
// (animastor:chunk:* → unit_id, set during generation).
// Written as <scene>.chunk-durations.json next to the merged file.
async function trackChunkDurations(redis, bookId, chapterId, sceneId, chunkPaths, finalPath) {
    if (!TRACK_CHUNK_DURATIONS || !chunkPaths.length) return;
    try {
        const records = [];
        for (let i = 0; i < chunkPaths.length; i++) {
            const chunkPath = chunkPaths[i];
            if (!fs.existsSync(chunkPath)) continue;
            const chunkIndex = i + 1;
            const raw = await ffmpeg.probeDuration(chunkPath);
            let tail = raw;
            if (CLEANUP_TAIL_ONLY) {
                const tmp = chunkPath.replace(/\.mp3$/, '.tailonly.mp3');
                try {
                    await ffmpeg.runFFmpegTrim(chunkPath, tmp, 0, null, true);
                    tail = await ffmpeg.probeDuration(tmp);
                } catch (_) { tail = raw; }
                finally {
                    if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch (_) {} }
                }
            }
            let unitId = null;
            try {
                const id = chunks.makeChunkId(chapterId, sceneId, chunkIndex, bookId);
                const chunkKey = `animastor:chunk:${id}`;
                const rawChunk = await redis.get(chunkKey);
                if (rawChunk) unitId = JSON.parse(rawChunk).unit_id || null;
            } catch (_) {}
            records.push({ chunk_index: chunkIndex, unit_id: unitId, raw_duration_sec: raw, tail_duration_sec: tail });
        }
        const sumRaw = records.reduce((s, r) => s + r.raw_duration_sec, 0);
        const sumTail = records.reduce((s, r) => s + r.tail_duration_sec, 0);
        const metaPath = finalPath.replace(/\.mp3$/, '.chunk-durations.json');
        fs.writeFileSync(metaPath, JSON.stringify({ records, sum_raw_sec: sumRaw, sum_tail_sec: sumTail, tail_only: CLEANUP_TAIL_ONLY }, null, 2));
        helpers.log(`📏 trackChunkDurations: ${records.length} chunks → sum_raw=${sumRaw.toFixed(3)}s sum_tail=${sumTail.toFixed(3)}s → ${path.basename(metaPath)}`);
    } catch (err) {
        helpers.warn(`trackChunkDurations failed: ${err.message}`);
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
        const existingChunks = chunks.findExistingSceneChunks(bookId, chapterId, sceneId, buildId, expectedChunkCount);

        if (existingChunks.length === 0) {
            helpers.warn(`No audio chunks found for scene: ${bookId}/${chapterId}/${sceneId}`);
            return null;
        }

        if (expectedChunkCount && existingChunks.length !== expectedChunkCount) {
            helpers.warn(`Not all chunks ready: found=${existingChunks.length}, expected=${expectedChunkCount}`);
            return null;
        }

        const chunkPaths = existingChunks.map(ch => helpers.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}_${String(ch).padStart(4, '0')}.mp3`));

        // Warn about empty chunks that would produce incomplete output
        const MIN_CHUNK_BYTES = 100;
        const emptyChunks = [];
        for (let i = 0; i < chunkPaths.length; i++) {
            let size = 0;
            try { if (fs.existsSync(chunkPaths[i])) size = fs.statSync(chunkPaths[i]).size; } catch (_) {}
            if (size < MIN_CHUNK_BYTES) emptyChunks.push(i + 1);
        }
        if (emptyChunks.length > 0) {
            helpers.warn(`${emptyChunks.length} chunk(s) are empty — will produce incomplete output: [${emptyChunks.join(',')}]`);
        }

        await trackChunkDurations(redis, bookId, chapterId, sceneId, chunkPaths, finalPath);

        const result = await buildSceneAudio(chunkPaths, finalPath, buildId, true);
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

    const existingChunks = chunks.findExistingSceneChunks(bookId, chapterId, sceneId, buildId, expectedChunkCount);

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
