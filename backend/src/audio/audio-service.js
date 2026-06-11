// ======================================================
// Audio Service - v1.0.0
// ======================================================
// Handles all audio-related operations: generation, processing, validation.
// Does NOT know orchestration, states, or transitions.

const config = require('../config/runtime-config');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const gpu = require('../runtime/gpu-dispatcher');
const wfLoader = require('../workflows/workflow-loader');

// Helper to build output paths
function getOutputPath(...parts) {
    return path.join(config.OUTPUT_DIR, ...parts.filter(Boolean));
}

const logPrefix = '[AUDIO]';

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
// FFMPEG OPERATIONS
// ======================================================

/**
 * Run ffmpeg merge with stream copy mode (no re-encoding).
 */
async function runFFmpegMerge(args) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', args, {
            stdio: ['ignore', 'pipe', 'pipe'] // Use pipes to prevent blocking
        });

        let stderr = '';

        ffmpeg.stderr.on('data', data => {
            stderr += data.toString();
        });

        ffmpeg.stdout.on('data', () => {
            // Discard stdout data
        });

        ffmpeg.on('close', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
            }
        });

        ffmpeg.on('error', reject);
    });
}

/**
 * Run ffmpeg to trim/cleanup audio (remove trailing silence).
 */
async function runFFmpegTrim(inputPath, outputPath, startTimeSec = 0, durationSec = null) {
    return new Promise((resolve, reject) => {
        const args = ['-i', inputPath];

        if (startTimeSec > 0) {
            args.push('-ss', String(startTimeSec));
        }

        // Remove trailing silence
        const filterArgs = ['-af', 'silenceremove=stop_periods=-1:stop_duration=0.2:stop_threshold=-50dB'];
        args.push(...filterArgs);

        if (durationSec !== null) {
            args.push('-t', String(durationSec));
        }

        args.push('-y', outputPath);

        const ffmpeg = spawn('ffmpeg', args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';

        ffmpeg.stderr.on('data', data => {
            stderr += data.toString();
        });

        ffmpeg.stdout.on('data', () => {});

        ffmpeg.on('close', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg trim exited with code ${code}: ${stderr}`));
            }
        });

        ffmpeg.on('error', reject);
    });
}

// ======================================================
// AUDIO BUILD PIPELINE
// ======================================================

/**
 * Unified audio pipeline for final scene audio.
 * Handles both single and multi-chunk cases.
 */
async function buildSceneAudio(chunks, finalPath, buildId = null) {
    // Validate input
    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
        throw new Error("buildSceneAudio: chunks must be a non-empty array");
    }

    if (!finalPath || typeof finalPath !== 'string') {
        throw new Error("buildSceneAudio: finalPath must be a non-empty string");
    }

    // Extract buildId from finalPath if not provided
    if (!buildId) {
        const parts = finalPath.split(path.sep);
        const buildIdFromPath = parts[parts.length - 2];
        if (buildIdFromPath && !buildIdFromPath.includes(path.sep)) {
            buildId = buildIdFromPath;
        } else {
            error(`Could not extract valid buildId from finalPath: ${finalPath}`);
            return null;
        }
    }

    // Ensure output directory exists
    const outputDir = path.dirname(finalPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Validate canonical audio exists and is valid
    if (fs.existsSync(finalPath)) {
        try {
            const isValid = await validateCanonicalAudio(finalPath);
            if (isValid) {
                log(`Canonical audio already exists and is valid: ${path.basename(finalPath)}`);
                return finalPath;
            } else {
                log(`Canonical audio exists but is invalid - will regenerate: ${path.basename(finalPath)}`);
                try { fs.unlinkSync(finalPath); } catch (e) {}
            }
        } catch (err) {
            warn(`Validation error, regenerating: ${err.message}`);
            try { fs.unlinkSync(finalPath); } catch (e) {}
        }
    }

    // CASE A: Single chunk - use atomic pipeline with temp file
    if (chunks.length === 1) {
        const singleChunk = chunks[0];
        log(`Processing single chunk through unified audio pipeline...`);

        const tempPath = finalPath.replace(/\.mp3$/, '.cleanup.mp3');

        try {
            log(`ffmpeg cleanup: trim tail and save to temp path...`);
            await runFFmpegTrim(singleChunk, tempPath);

            // Atomically move temp file to final path
            fs.renameSync(tempPath, finalPath);
            log(`✅ Single chunk processed: ${path.basename(finalPath)}`);

            if (fs.existsSync(singleChunk)) {
                fs.unlinkSync(singleChunk);
                log(`🗑 Deleted temp chunk: ${path.basename(singleChunk)}`);
            }

            return finalPath;
        } catch (err) {
            error(`Audio processing failed: ${err.message}`);
            if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch (e) {}
            }
            if (fs.existsSync(finalPath)) {
                try { fs.unlinkSync(finalPath); } catch (e) {}
            }
            return null;
        }
    }

    // CASE B: Multiple chunks - use ffmpeg concat + cleanup
    log(`🎬 Merging ${chunks.length} audio chunks with ffmpeg`);
    const concatPath = createConcatFile(chunks, buildId);

    try {
        const args = ['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', finalPath, '-y'];
        await runFFmpegMerge(args);

        log(`✅ Audio merge completed: ${path.basename(finalPath)}`);

        // Post-merge silence cleanup (remove trailing silence from merge seams)
        log(`🎬 Applying final audio cleanup filter to canonical output...`);
        const tempCleanupPath = finalPath.replace('.mp3', '.cleanup.mp3');
        try {
            await runFFmpegTrim(finalPath, tempCleanupPath);
            log(`✅ Final audio cleanup applied`);
            fs.unlinkSync(finalPath);
            fs.renameSync(tempCleanupPath, finalPath);
        } catch (cleanupErr) {
            warn(`⚠️ Cleanup on final output skipped/failed: ${cleanupErr.message}`);
            if (fs.existsSync(tempCleanupPath)) {
                try { fs.unlinkSync(tempCleanupPath); } catch (e) {}
            }
        }

        // Cleanup temp chunks
        for (const chunk of chunks) {
            if (fs.existsSync(chunk)) {
                try { fs.unlinkSync(chunk); } catch (e) {}
            }
        }
        if (fs.existsSync(concatPath)) {
            fs.unlinkSync(concatPath);
        }

        return finalPath;
    } catch (err) {
        error(`Audio merge failed: ${err.message}`);
        if (fs.existsSync(finalPath)) {
            try { fs.unlinkSync(finalPath); } catch (e) {}
        }
        if (fs.existsSync(concatPath)) {
            try { fs.unlinkSync(concatPath); } catch (e) {}
        }
        return null;
    }
}

/**
 * Create temporary concat file for ffmpeg.
 */
function createConcatFile(chunks, buildId) {
    const concatContent = chunks
        .map(chunk => `file '${chunk}'`)
        .join('\n');
    const concatPath = path.join('/tmp', `concat_${buildId}_${Date.now()}.txt`);
    fs.writeFileSync(concatPath, concatContent);
    return concatPath;
}

// ======================================================
// AUDIO VALIDATION
// ======================================================

/**
 * Validate canonical scene audio file.
 * Returns true only if file exists, is readable, and has valid duration.
 */
async function validateCanonicalAudio(path) {
    if (!path || typeof path !== 'string') {
        warn(`validateCanonicalAudio: invalid path`);
        return false;
    }

    if (!fs.existsSync(path)) {
        warn(`validateCanonicalAudio: file does not exist: ${path}`);
        return false;
    }

    const stats = fs.statSync(path);
    if (stats.size < 1024) {
        warn(`validateCanonicalAudio: file too small: ${path} (${stats.size} bytes)`);
        return false;
    }

    try {
        const mm = require('music-metadata');
        const metadata = await mm.parseFile(path);
        const duration = metadata.format.duration || 0;

        if (duration <= 0) {
            warn(`validateCanonicalAudio: invalid duration: ${path} (${duration}s)`);
            return false;
        }

        if (duration > 7200) {
            warn(`validateCanonicalAudio: suspiciously long duration: ${path} (${duration}s)`);
            return false;
        }

        // Success - no log to avoid spam
        return true;
    } catch (err) {
        warn(`validateCanonicalAudio: parse error: ${path} ${err.message}`);
        return false;
    }
}

/**
 * Check if canonical scene audio is ready (exists and valid).
 */
async function isSceneAudioReady(buildId, bookId, chapterId, sceneId, mm) {
    const audioPath = getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);

    if (!fs.existsSync(audioPath)) {
        return false;
    }

    const isValid = await validateCanonicalAudio(audioPath);
    return isValid;
}

/**
 * Get audio duration using music-metadata.
 */
async function getAudioDuration(filePath, mm) {
    try {
        const metadata = await mm.parseFile(filePath);
        return metadata.format.duration || 0;
    } catch (err) {
        return 0;
    }
}

// ======================================================
// CHUNK HELPERS
// ======================================================

/**
 * Find existing scene chunks from disk.
 */
function findExistingSceneChunks(bookId, chapterId, sceneId, buildId) {
    const dir = getOutputPath(buildId);
    const escapedBookId = escapeRegExp(bookId);
    const escapedChapterId = escapeRegExp(chapterId);
    const escapedSceneId = escapeRegExp(sceneId);
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
        error(`findExistingSceneChunks error: ${err.message}`);
        return [];
    }
}

/**
 * Check if all expected chunks exist on disk.
 */
function allSceneChunksExist(bookId, chapterId, sceneId, buildId, expectedChunkCount) {
    const chunks = findExistingSceneChunks(bookId, chapterId, sceneId, buildId);
    return {
        exists: expectedChunkCount ? chunks.length === expectedChunkCount : chunks.length > 0,
        chunkCount: chunks.length
    };
}

/**
 * Check if audio chunks are ready for merge.
 */
function areSceneAudioChunksReady(bookId, chapterId, sceneId, buildId, expectedChunkCount) {
    const result = allSceneChunksExist(bookId, chapterId, sceneId, buildId, expectedChunkCount);
    return {
        ready: result.exists,
        chunkCount: result.chunkCount,
        expectedCount: expectedChunkCount || 'any'
    };
}

// ======================================================
// AUDIO MERGE / RECOVERY
// ======================================================

/**
 * Merge audio chunks to build canonical scene audio.
 */
async function mergeSceneAudioChunks(redis, bookId, chapterId, sceneId, buildId, expectedChunkCount = null) {
    // Acquire merge lock to prevent concurrent merges
    const mergeLockKey = `animastor:audio-merge-lock:${bookId}:${chapterId}:${sceneId}`;
    const lockAcquired = await redis.set(mergeLockKey, buildId, 'NX', 'EX', 300);
    if (!lockAcquired) {
        log(`Audio merge already in progress: ${bookId}/${chapterId}/${sceneId}`);
        return null;
    }

    try {
        const finalPath = getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
        const chunks = findExistingSceneChunks(bookId, chapterId, sceneId, buildId);

        if (chunks.length === 0) {
            warn(`No audio chunks found for scene: ${bookId}/${chapterId}/${sceneId}`);
            return null;
        }

        if (expectedChunkCount && chunks.length !== expectedChunkCount) {
            warn(`Not all chunks ready for merge: found=${chunks.length}, expected=${expectedChunkCount}`);
            return null;
        }

        const chunkPaths = chunks.map(ch => getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}_${String(ch).padStart(4, '0')}.mp3`));

        const result = await buildSceneAudio(chunkPaths, finalPath, buildId);
        return result;
    } catch (err) {
        error(`Audio merge error: ${err.message}`);
        return null;
    } finally {
        await redis.del(mergeLockKey);
    }
}

async function trimPaddedSceneAudio(filePath) {
    const { spawn } = require('child_process');
    const fs = require('fs');
    return new Promise((resolve, reject) => {
        // Detect silence between repetitions: use lower threshold and shorter min duration
        const ffmpeg = spawn('ffmpeg', [
            '-i', filePath,
            '-af', 'silencedetect=noise=-25dB:d=0.25',
            '-f', 'null',
            '-y', '/dev/null'
        ]);

        let stderr = '';
        ffmpeg.stderr.on('data', data => { stderr += data.toString(); });
        ffmpeg.on('close', code => {
            if (code !== 0) { resolve(); return; }
            const matches = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)];
            let cutTime = null;
            if (matches.length > 0) {
                const t = parseFloat(matches[0][1]);
                if (t && t > 0.3) cutTime = t;
            }
            if (!cutTime) {
                // Fallback: probe duration and cut at half
                const { spawn: sp } = require('child_process');
                const probe = sp('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', filePath]);
                let out = '';
                probe.stdout.on('data', d => { out += d.toString(); });
                probe.on('close', pCode => {
                    if (pCode !== 0) { resolve(); return; }
                    const dur = parseFloat(out.trim());
                    if (!dur || dur < 0.6) { resolve(); return; }
                    cutTime = dur / 2;
                    doCut(cutTime);
                });
                probe.on('error', () => resolve());
            } else {
                doCut(cutTime);
            }

            function doCut(ct) {
                const tempPath = filePath + '.trim.mp3';
                const cut = spawn('ffmpeg', [
                    '-i', filePath, '-t', String(ct),
                    '-c', 'copy', '-y', tempPath
                ]);
                cut.on('close', cutCode => {
                    if (cutCode === 0 && fs.existsSync(tempPath)) {
                        try {
                            fs.renameSync(tempPath, filePath);
                            log(`Padded audio trimmed at ${ct.toFixed(1)}s: ${path.basename(filePath)}`);
                        } catch (e) {}
                    }
                    resolve();
                });
                cut.on('error', () => resolve());
            }
        });
        ffmpeg.on('error', () => resolve());
    });
}

/**
 * Recover canonical scene audio from chunks if canonical is missing.
 */
async function recoverSceneAudioFromChunks(bookId, chapterId, sceneId, buildId, expectedChunkCount = null) {
    const finalPath = getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);

    // Check if canonical audio already exists
    if (fs.existsSync(finalPath)) {
        const isValid = await validateCanonicalAudio(finalPath);
        if (isValid) {
            log(`Canonical audio already valid, nothing to recover: ${path.basename(finalPath)}`);
            return { recovered: true, path: finalPath, reason: 'already_valid' };
        }
        log(`Canonical audio exists but is invalid, will attempt recovery: ${path.basename(finalPath)}`);
        try { fs.unlinkSync(finalPath); } catch (e) {}
    }

    // Find existing chunks
    const existingChunks = findExistingSceneChunks(bookId, chapterId, sceneId, buildId);

    if (existingChunks.length === 0) {
        warn(`No audio chunks found for recovery: ${bookId}/${chapterId}/${sceneId}`);
        return { recovered: false, reason: 'no_chunks' };
    }

    // Validate all chunks exist
    const chunkCheck = allSceneChunksExist(bookId, chapterId, sceneId, buildId, expectedChunkCount);
    if (!chunkCheck.ready) {
        warn(`Not all chunks ready for recovery: ${bookId}/${chapterId}/${sceneId}`);
        return { recovered: false, reason: 'incomplete_chunks' };
    }

    const chunkPaths = existingChunks.map(c => getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}_${String(c).padStart(4, '0')}.mp3`));

    try {
        const result = await buildSceneAudio(chunkPaths, finalPath, buildId);
        if (result) {
            log(`Audio recovery successful: ${path.basename(finalPath)}`);
            return { recovered: true, path: finalPath, reason: 'success' };
        }
        return { recovered: false, reason: 'merge_failed' };
    } catch (err) {
        error(`Audio recovery error: ${err.message}`);
        return { recovered: false, reason: 'error', error: err.message };
    }
}

// ======================================================
// CONVENIENCE FUNCTIONS (DEPRECATED WRAPPERS)
// ======================================================

// ======================================================
// ESCAPE REGEXP
// ======================================================

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ======================================================
// TEXT CHUNKING (restored from legacy)
// ======================================================

function splitTextIntoChunks(text, maxChars = 500) {
    if (!text?.trim()) return [];
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
        const test = current ? current + " " + sentence : sentence;
        if (test.length > maxChars) {
            if (current.trim()) chunks.push(current.trim());
            current = sentence;
        } else {
            current = test;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

function splitDialogueIntoChunks(text, maxChars = 500) {
    if (!text?.trim()) return [];
    text = text.replace(/\r/g, "").trim();
    const lines = text.match(/[a-z0-9_]+:\s.*?(?=\n[a-z0-9_]+:|$)/gis) || [text];
    const chunks = [];
    let current = "";
    for (const rawLine of lines) {
        const line = rawLine.trim();
        const test = current ? current + "\n" + line : line;
        if (test.length > maxChars) {
            if (current.trim()) chunks.push(current.trim());
            current = line;
        } else {
            current = test;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

function narratorVoice(scene, book) {
    const voiceId = scene?.audio?.voice || book?.book?.defaults?.narration_voice || "narrator";
    if (voiceId === "narrator") {
        return book?.bible?.narrator?.voice?.instruction || "";
    }
    const c = book?.characters?.find(x => x.id === voiceId);
    return c?.voice?.instruction || "";
}

function padShortText(text) {
    if (text.length >= 40) return text;
    return text + " " + text;
}

function buildSegments(runtimeEntry) {
    if (runtimeEntry.runtime_type === "scene" && (runtimeEntry.scene_type === "narration" || runtimeEntry.scene_type === "chapter_intro" || runtimeEntry.scene_type === "cover")) {
        const rawText = runtimeEntry.payload?.audio?.full_text || "";
        const isPadded = rawText.length < 40;
        const fullText = isPadded ? padShortText(rawText) : rawText;
        const chunks = splitTextIntoChunks(fullText);
        return chunks.map((text, i) => ({
            segment_id: String(i + 1).padStart(4, "0"),
            segment_type: "narration",
            text,
            padded: isPadded
        }));
    }
    if (runtimeEntry.runtime_type === "scene" && runtimeEntry.scene_type === "dialogue") {
        const fullText = runtimeEntry.payload?.audio?.full_text || "";
        const chunks = splitDialogueIntoChunks(fullText);
        return chunks.map((text, i) => ({
            segment_id: String(i + 1).padStart(4, "0"),
            segment_type: "dialogue",
            text
        }));
    }
    return [];
}

function makeChunkId(chapterId, sceneId, chunkIndex, bookId) {
    return `${bookId}_${chapterId}_${sceneId}_${String(chunkIndex).padStart(4, '0')}`;
}

function getChunkAudioPath(buildId, bookId, chapterId, sceneId, chunkIndex) {
    return getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}_${String(chunkIndex).padStart(4, '0')}.mp3`);
}

// ======================================================
// AUDIO GENERATION (restored from legacy generateScene)
// ======================================================

async function generateSceneAudio(redis, sceneData, loadedBook, buildId, bookId) {
    const chapterId = sceneData.chapter_id;
    const sceneId = sceneData.scene_id;

    // Acquire audio orchestration lock to prevent duplicate TTS submissions
    const sceneLockKey = `animastor:audio-scene-lock:${bookId}:${chapterId}:${sceneId}`;
    const lockAcquired = await redis.set(sceneLockKey, buildId, 'NX', 'EX', 600);
    if (!lockAcquired) {
        log(`Audio orchestration already in progress: ${bookId}/${chapterId}/${sceneId}`);
        return { generated: false, reason: 'locked' };
    }

    // Build segments
    const segments = buildSegments(sceneData);
    const expectedChunkCount = segments.length;

    // Check if audio already ready AND is real (not placeholder)
    let isReady = await isSceneAudioReady(buildId, bookId, chapterId, sceneId);
    if (isReady) {
        // Double-check: if the audio is placeholder, proceed with real generation
        try {
            const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
            const asset = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'audio', buildId);
            if (asset && asset.status === 'placeholder') {
                log(`Audio is placeholder — will regenerate real audio: ${bookId}/${chapterId}/${sceneId}`);
                isReady = false;
            }
        } catch (err) {
            warn(`Failed to check audio status: ${err.message}`);
            isReady = false;
        }
    }
    if (isReady) {
        log(`Audio already ready, no generation needed: ${bookId}/${chapterId}/${sceneId}`);
        // Still save chunk metadata for existing audio so /api/v1/chunk/:id/audio works
        for (let i = 0; i < segments.length; i++) {
            const chunkIndex = i + 1;
            const id = makeChunkId(chapterId, sceneId, chunkIndex, bookId);
            const chunkKey = `animastor:chunk:${id}`;
            const existingChunk = await redis.get(chunkKey);
            if (!existingChunk) {
                const segment = segments[i];
                const chunkData = {
                    build_id: buildId,
                    book_id: bookId,
                    chapter_id: chapterId,
                    scene_id: sceneId,
                    chunk_index: String(chunkIndex).padStart(4, '0'),
                    expected_chunk_count: expectedChunkCount,
                    scene_type: sceneData.scene_type,
                    audio: true,
                    audio_status: 'ready',
                    padded_text: segment.padded || false
                };
                await redis.set(chunkKey, JSON.stringify(chunkData));
                await redis.sadd(`animastor:chunks:${bookId}`, id);
            }
        }
        await redis.del(sceneLockKey);
        return { generated: false, reason: 'already_ready' };
    }

    // Submit TTS job for each segment
    for (let i = 0; i < segments.length; i++) {
        const chunkIndex = i + 1;
        const id = makeChunkId(chapterId, sceneId, chunkIndex, bookId);

        // Check if chunk file already exists on disk (per-chunk cache)
        const chunkFilePath = getChunkAudioPath(buildId, bookId, chapterId, sceneId, chunkIndex);
        const chunkFileExists = fs.existsSync(chunkFilePath);

        // Save chunk metadata FIRST so webhook can find it
        const chunkKey = `animastor:chunk:${id}`;
        const existingChunk = await redis.get(chunkKey);
        if (!existingChunk) {
            const segment = segments[i];
            const chunkData = {
                build_id: buildId,
                book_id: bookId,
                chapter_id: chapterId,
                scene_id: sceneId,
                chunk_index: String(chunkIndex).padStart(4, '0'),
                expected_chunk_count: expectedChunkCount,
                scene_type: sceneData.scene_type,
                audio: chunkFileExists,
                audio_status: chunkFileExists ? 'ready' : 'pending',
                padded_text: segment.padded || false
            };
            await redis.set(chunkKey, JSON.stringify(chunkData));
            // Add to chunks set for book
            await redis.sadd(`animastor:chunks:${bookId}`, id);
        }

        // Skip TTS if chunk file already exists on disk
        if (chunkFileExists) {
            log(`AUDIO CHUNK CACHE HIT (disk): ${id}`);
            continue;
        }

        const segment = segments[i];
        let wfAudio = wfLoader.getWorkflow(segment.segment_type === 'dialogue' ? 'tts-qwen-dialogue' : 'tts-qwen-narrator');

        if (segment.segment_type === 'dialogue') {
            const participants = sceneData.payload?.participants || [];
            const chars = participants.map(id => loadedBook?.characters?.find(c => c.id === id)).filter(Boolean);
            const c1 = chars[0] || {};
            const c2 = chars[1] || {};
            wfAudio["108"].inputs = { script: segment.text, default_instruct: "" };
            wfAudio["71"].inputs.voice_instruction = c1?.voice?.instruction || "";
            wfAudio["80"].inputs.voice_instruction = c2?.voice?.instruction || "";
            wfAudio["74"].inputs.role_name_1 = c1?.id || "role1";
            wfAudio["74"].inputs.role_name_2 = c2?.id || "role2";
        } else {
            wfAudio["108"].inputs.text = segment.text;
            wfAudio["108"].inputs.voice_instruction = narratorVoice(sceneData.payload, loadedBook);
        }

        await gpu.send(`${id}:audio`, wfAudio, "audio", buildId);
        log(`Audio TTS submitted: ${id} (${segment.segment_type})`);
    }

    // Release audio orchestration lock
    await redis.del(sceneLockKey);
    log(`Audio orchestration lock released: ${bookId}/${chapterId}/${sceneId}`);

    return { generated: true, expectedChunkCount };
}

// ======================================================
// BOOK-LEVEL AUDIO MERGE
// ======================================================

/**
 * Merge all scene audio files into a single book-level audio file.
 * Scenes array: [{ chapter_id, scene_id }, ...]
 * Output: {buildDir}/{bookId}.mp3
 * Uses ffmpeg concat demuxer with stream copy (no re-encode).
 */
async function mergeBookAudio(buildId, bookId, scenes) {
    if (!scenes || scenes.length === 0) {
        warn(`mergeBookAudio: no scenes for book ${bookId}`);
        return null;
    }

    const finalPath = getOutputPath(buildId, `${bookId}.mp3`);
    log(`mergeBookAudio: ${bookId} (${scenes.length} scenes) -> ${finalPath}`);

    // Validate existing canonical audio
    if (fs.existsSync(finalPath)) {
        try {
            const isValid = await validateCanonicalAudio(finalPath);
            if (isValid) {
                log(`Book audio already exists and is valid: ${path.basename(finalPath)}`);
                return finalPath;
            }
            log(`Book audio exists but invalid, regenerating`);
            try { fs.unlinkSync(finalPath); } catch (e) {}
        } catch (err) {
            warn(`Book audio validation error, regenerating: ${err.message}`);
            try { fs.unlinkSync(finalPath); } catch (e) {}
        }
    }

    const audioPaths = [];
    for (const scene of scenes) {
        const scenePath = getOutputPath(buildId, `${bookId}_${scene.chapter_id}_${scene.scene_id}.mp3`);
        if (fs.existsSync(scenePath)) {
            audioPaths.push(scenePath);
        } else {
            warn(`Scene audio not found: ${scenePath}`);
        }
    }

    if (audioPaths.length === 0) {
        warn(`mergeBookAudio: no scene audio files found for book ${bookId}`);
        return null;
    }

    if (audioPaths.length === 1) {
        fs.copyFileSync(audioPaths[0], finalPath);
        log(`Book audio: single scene, copied.`);
        return finalPath;
    }

    const concatPath = path.join('/tmp', `aconcat_${bookId}_${Date.now()}.txt`);
    const concatContent = audioPaths.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatPath, concatContent);

    try {
        const args = ['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', finalPath, '-y'];
        await runFFmpegMerge(args);
        log(`Book audio merged: ${path.basename(finalPath)}`);
        return finalPath;
    } catch (err) {
        error(`Book audio merge failed: ${err.message}`);
        if (fs.existsSync(finalPath)) {
            try { fs.unlinkSync(finalPath); } catch (e) {}
        }
        return null;
    } finally {
        if (fs.existsSync(concatPath)) {
            try { fs.unlinkSync(concatPath); } catch (e) {}
        }
    }
}

// ======================================================
// SILENT AUDIO GENERATION (Placeholder)
// ======================================================

/**
 * Generate a silent audio file with the given duration.
 * Uses ffmpeg's anullsrc filter to create silence.
 * Output: MP3, 24000 Hz, mono, 64kbps.
 */
async function generateSilentAudio(outputPath, durationSec) {
    return new Promise((resolve, reject) => {
        const args = [
            '-f', 'lavfi',
            '-i', 'anullsrc=r=24000:cl=mono',
            '-t', String(durationSec),
            '-c:a', 'libmp3lame',
            '-b:a', '64k',
            '-y', outputPath
        ];

        const ffmpeg = spawn('ffmpeg', args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        ffmpeg.stderr.on('data', data => { stderr += data.toString(); });
        ffmpeg.stdout.on('data', () => {});

        ffmpeg.on('close', code => {
            if (code === 0) {
                log(`Silent audio generated: ${path.basename(outputPath)} (${durationSec.toFixed(1)}s)`);
                resolve(outputPath);
            } else {
                error(`Silent audio generation failed: ffmpeg exited with code ${code}`);
                reject(new Error(`ffmpeg silence exited with code ${code}: ${stderr}`));
            }
        });

        ffmpeg.on('error', reject);
    });
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Path helpers
    getOutputPath,
    makeChunkId,

    // FFMPEG
    runFFmpegMerge,
    runFFmpegTrim,

    // Audio pipeline
    buildSceneAudio,
    mergeSceneAudioChunks,
    recoverSceneAudioFromChunks,
    validateCanonicalAudio,
    isSceneAudioReady,
    getAudioDuration,

    // Chunk helpers
    findExistingSceneChunks,
    allSceneChunksExist,
    areSceneAudioChunksReady,
    mergeBookAudio,

    // Audio generation
    generateSceneAudio,
    buildSegments,
    narratorVoice,

    // Short-text trim
    trimPaddedSceneAudio,

    // Utility
    escapeRegExp,

    // Silent audio (placeholder)
    generateSilentAudio,
};
