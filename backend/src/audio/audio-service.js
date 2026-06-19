// ======================================================
// Audio Service - v1.1.0 (Connector-aware)
// ======================================================
// Handles all audio-related operations: generation, processing, validation.
// Uses the connector system to resolve workflow nodeIds.

const config = require('../config/runtime-config');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const gpu = require('../runtime/gpu-dispatcher');
const wfLoader = require('../workflows/workflow-loader');

const WORKFLOW_NARRATION = 'tts-qwen-narrator';
const WORKFLOW_DIALOGUE = 'tts-qwen-dialogue';

/**
 * Check if ffmpeg is available on the system.
 */
let _ffmpegChecked = false;
let _ffmpegAvailable = false;

function isFFmpegAvailable() {
  if (!_ffmpegChecked) {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore', timeout: 3000 });
      _ffmpegAvailable = true;
    } catch {
      _ffmpegAvailable = false;
    }
    _ffmpegChecked = true;
  }
  return _ffmpegAvailable;
}

/**
 * Apply a value to a workflow JSON via connector binding.
 */
function applyAudioValue(wf, workflowName, entityKey, value) {
  const connector = wfLoader.getConnector(workflowName);
  if (connector) {
    const cl = require('../workflows/connector-loader');
    return cl.setValue(wf, connector, entityKey, value);
  }
  return false;
}

/**
 * Get node ID from connector for an entity key.
 */
function getAudioNodeId(workflowName, entityKey) {
  const connector = wfLoader.getConnector(workflowName);
  if (connector) {
    const cl = require('../workflows/connector-loader');
    return cl.getNodeId(connector, entityKey);
  }
  return null;
}

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

async function runFFmpegMerge(args) {
    return new Promise((resolve, reject) => {
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
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
            }
        });

        ffmpeg.on('error', reject);
    });
}

async function runFFmpegTrim(inputPath, outputPath, startTimeSec = 0, durationSec = null) {
    return new Promise((resolve, reject) => {
        const args = ['-i', inputPath];

        if (startTimeSec > 0) {
            args.push('-ss', String(startTimeSec));
        }

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

async function buildSceneAudio(chunks, finalPath, buildId = null, force = false) {
    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
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
            error(`Could not extract valid buildId from finalPath: ${finalPath}`);
            return null;
        }
    }

    const outputDir = path.dirname(finalPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    if (!force && fs.existsSync(finalPath)) {
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

    if (chunks.length === 1) {
        const singleChunk = chunks[0];
        log(`Processing single chunk through unified audio pipeline...`);

        const tempPath = finalPath.replace(/\.mp3$/, '.cleanup.mp3');

        try {
            log(`ffmpeg cleanup: trim tail and save to temp path...`);
            await runFFmpegTrim(singleChunk, tempPath);

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

    log(`🎬 Merging ${chunks.length} audio chunks with ffmpeg`);
    const concatPath = createConcatFile(chunks, buildId);

    try {
        const args = ['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', finalPath, '-y'];
        await runFFmpegMerge(args);

        log(`✅ Audio merge completed: ${path.basename(finalPath)}`);

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

async function validateCanonicalAudio(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        warn(`validateCanonicalAudio: invalid path`);
        return false;
    }

    if (!fs.existsSync(filePath)) {
        warn(`validateCanonicalAudio: file does not exist: ${filePath}`);
        return false;
    }

    const stats = fs.statSync(filePath);
    if (stats.size < 1024) {
        warn(`validateCanonicalAudio: file too small: ${filePath} (${stats.size} bytes)`);
        return false;
    }

    try {
        const mm = require('music-metadata');
        const metadata = await mm.parseFile(filePath);
        const duration = metadata.format.duration || 0;

        if (duration <= 0) {
            warn(`validateCanonicalAudio: invalid duration: ${filePath} (${duration}s)`);
            return false;
        }

        if (duration > 7200) {
            warn(`validateCanonicalAudio: suspiciously long duration: ${filePath} (${duration}s)`);
            return false;
        }

        return true;
    } catch (err) {
        warn(`validateCanonicalAudio: parse error: ${filePath} ${err.message}`);
        return false;
    }
}

async function isSceneAudioReady(buildId, bookId, chapterId, sceneId, mm) {
    const audioPath = getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);

    if (!fs.existsSync(audioPath)) {
        return false;
    }

    const isValid = await validateCanonicalAudio(audioPath);
    return isValid;
}

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

// ======================================================
// AUDIO MERGE / RECOVERY
// ======================================================

async function mergeSceneAudioChunks(redis, bookId, chapterId, sceneId, buildId, expectedChunkCount = null) {
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

        const result = await buildSceneAudio(chunkPaths, finalPath, buildId, true);
        return result;
    } catch (err) {
        error(`Audio merge error: ${err.message}`);
        return null;
    } finally {
        await redis.del(mergeLockKey);
    }
}

function probeDuration(filePath) {
    return new Promise((resolve) => {
        const { spawn } = require('child_process');
        const probe = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'stream=duration',
            '-of', 'csv=p=0',
            filePath
        ]);
        let out = '';
        probe.stdout.on('data', d => { out += d.toString(); });
        probe.on('close', code => {
            if (code !== 0) { resolve(0); return; }
            const lines = out.trim().split('\n').filter(Boolean);
            for (const line of lines) {
                const dur = parseFloat(line);
                if (Number.isFinite(dur) && dur > 0) { resolve(dur); return; }
            }
            resolve(0);
        });
        probe.on('error', () => resolve(0));
    });
}

function cutFirstHalf(filePath, outputPath, duration) {
    return new Promise((resolve) => {
        const { spawn } = require('child_process');
        const cut = spawn('ffmpeg', [
            '-i', filePath,
            '-t', String(duration),
            '-c', 'copy',
            '-y', outputPath
        ]);
        cut.on('close', code => resolve(code === 0));
        cut.on('error', () => resolve(false));
    });
}

function findQuietestPoint(filePath, startPct = 0.25, endPct = 0.75) {
    return new Promise((resolve) => {
        const { spawn } = require('child_process');
        const windowMs = 50;
        const sampleRate = 24000;
        const windowSamples = Math.floor(sampleRate * windowMs / 1000);

        const ff = spawn('ffmpeg', [
            '-i', filePath,
            '-ac', '1',
            '-ar', String(sampleRate),
            '-f', 's16le',
            '-y',
            'pipe:1'
        ]);

        const chunks = [];
        ff.stdout.on('data', d => { chunks.push(d); });
        let stderrBuf = '';
        ff.stderr.on('data', d => { stderrBuf += d.toString(); });

        ff.on('close', code => {
            if (code !== 0) { resolve(0); return; }
            const buf = Buffer.concat(chunks);
            const totalSamples = Math.floor(buf.length / 2);
            if (totalSamples < windowSamples * 3) { resolve(0); return; }

            const totalWindows = Math.floor(totalSamples / windowSamples);
            const lo = Math.floor(totalWindows * Math.max(0, Math.min(1, startPct)));
            const hi = Math.floor(totalWindows * Math.max(0, Math.min(1, endPct)));
            let minRms = Infinity, minWin = lo;

            for (let w = lo; w < hi && w < totalWindows; w++) {
                let sumSq = 0;
                const offset = w * windowSamples * 2;
                const len = Math.min(windowSamples * 2, buf.length - offset);
                for (let i = 0; i < len; i += 2) {
                    const s = buf.readInt16LE(offset + i);
                    sumSq += s * s;
                }
                const rms = Math.sqrt(sumSq / (len / 2));
                if (rms < minRms) {
                    minRms = rms;
                    minWin = w;
                }
            }

            const cutTime = (minWin * windowMs + windowMs / 2) / 1000;
            resolve(cutTime);
        });
        ff.on('error', () => resolve(0));
    });
}

async function trimPaddedSceneAudio(filePath) {
    const basename = path.basename(filePath);
    log(`✂️ trimPaddedSceneAudio: trimming ${basename}`);

    const duration = await probeDuration(filePath);
    if (!duration || duration < 0.5) {
        log(`⚠️ trimPaddedSceneAudio: duration=${duration}s too short for ${basename}, skipping`);
        return;
    }

    const quietest = await findQuietestPoint(filePath, 0.40, 0.60);
    let cutTime = (quietest > 0.3) ? quietest : (duration / 2);
    const safetyMargin = 0.10;
    cutTime = Math.min(cutTime + safetyMargin, duration * 0.55);
    const method = (quietest > 0.3) ? `quietest@${quietest.toFixed(2)}s+${(safetyMargin*1000).toFixed(0)}ms` : 'half-duration';
    log(`✂️ trimPaddedSceneAudio: total=${duration.toFixed(2)}s, ${method} cut at ${cutTime.toFixed(2)}s for ${basename}`);

    const tempPath = filePath + '.trim.mp3';
    const ok = await cutFirstHalf(filePath, tempPath, cutTime);
    if (ok) {
        try {
            const fs = require('fs');
            fs.renameSync(tempPath, filePath);
            log(`✅ trimPaddedSceneAudio: trimmed ${basename} → kept first ${cutTime.toFixed(1)}s`);
        } catch (e) {
            log(`⚠️ trimPaddedSceneAudio: rename failed for ${basename}: ${e.message}`);
        }
    } else {
        log(`⚠️ trimPaddedSceneAudio: ffmpeg cut failed for ${basename}, file unchanged`);
    }
}

async function recoverSceneAudioFromChunks(bookId, chapterId, sceneId, buildId, expectedChunkCount = null) {
    const finalPath = getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);

    if (fs.existsSync(finalPath)) {
        const isValid = await validateCanonicalAudio(finalPath);
        if (isValid) {
            log(`Canonical audio already valid, nothing to recover: ${path.basename(finalPath)}`);
            return { recovered: true, path: finalPath, reason: 'already_valid' };
        }
        log(`Canonical audio exists but is invalid, will attempt recovery: ${path.basename(finalPath)}`);
        try { fs.unlinkSync(finalPath); } catch (e) {}
    }

    const existingChunks = findExistingSceneChunks(bookId, chapterId, sceneId, buildId);

    if (existingChunks.length === 0) {
        warn(`No audio chunks found for recovery: ${bookId}/${chapterId}/${sceneId}`);
        return { recovered: false, reason: 'no_chunks' };
    }

    const chunkCheck = allSceneChunksExist(bookId, chapterId, sceneId, buildId, expectedChunkCount);
    if (!chunkCheck.ready) {
        warn(`Not all chunks ready for recovery: ${bookId}/${chapterId}/${sceneId}`);
        return { recovered: false, reason: 'incomplete_chunks' };
    }

    const chunkPaths = existingChunks.map(c => getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}_${String(c).padStart(4, '0')}.mp3`));

    try {
        const result = await buildSceneAudio(chunkPaths, finalPath, buildId, true);
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
// HELPERS
// ======================================================

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    log(`📐 Short text detected (${text.length} chars) — duplicating: "${text}" → "${text} ${text}"`);
    return text + " " + text;
}

function buildSegments(runtimeEntry) {
    if (runtimeEntry.runtime_type === "scene" && (runtimeEntry.scene_type === "narration" || runtimeEntry.scene_type === "chapter_intro" || runtimeEntry.scene_type === "cover")) {
        const rawText = runtimeEntry.payload?.audio?.full_text || "";
        const isPadded = rawText.length < 40;
        const fullText = isPadded ? padShortText(rawText) : rawText;
        if (isPadded) {
            log(`📐 buildSegments: short text (${rawText.length} chars) → padded mode ON for "${rawText}"`);
        }
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
// AUDIO GENERATION
// ======================================================

async function generateSceneAudio(redis, sceneData, loadedBook, buildId, bookId) {
    const chapterId = sceneData.chapter_id;
    const sceneId = sceneData.scene_id;

    const sceneLockKey = `animastor:audio-scene-lock:${bookId}:${chapterId}:${sceneId}`;
    const lockAcquired = await redis.set(sceneLockKey, buildId, 'NX', 'EX', 600);
    if (!lockAcquired) {
        log(`Audio orchestration already in progress: ${bookId}/${chapterId}/${sceneId}`);
        return { generated: false, reason: 'locked' };
    }

    const segments = buildSegments(sceneData);
    const expectedChunkCount = segments.length;

    let isReady = await isSceneAudioReady(buildId, bookId, chapterId, sceneId);
    if (isReady) {
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
        for (let i = 0; i < segments.length; i++) {
            const chunkIndex = i + 1;
            const id = makeChunkId(chapterId, sceneId, chunkIndex, bookId);
            const chunkKey = `animastor:chunk:${id}`;
            const existingChunk = await redis.get(chunkKey);
                if (existingChunk) {
                    const segment = segments[i];
                    const existing = JSON.parse(existingChunk);
                    existing.padded_text = segment.padded || false;
                    if (existing.audio_status !== 'ready') {
                        existing.audio = true;
                        existing.audio_status = 'ready';
                    }
                    await redis.set(chunkKey, JSON.stringify(existing));
                } else {
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

    for (let i = 0; i < segments.length; i++) {
        const chunkIndex = i + 1;
        const id = makeChunkId(chapterId, sceneId, chunkIndex, bookId);

        const chunkFilePath = getChunkAudioPath(buildId, bookId, chapterId, sceneId, chunkIndex);
        const chunkFileExists = fs.existsSync(chunkFilePath);

        const chunkKey = `animastor:chunk:${id}`;
        const existingChunk = await redis.get(chunkKey);
        if (existingChunk) {
            const segment = segments[i];
            const existing = JSON.parse(existingChunk);
            existing.padded_text = segment.padded || false;
            await redis.set(chunkKey, JSON.stringify(existing));
        } else {
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
            await redis.sadd(`animastor:chunks:${bookId}`, id);
        }

        if (chunkFileExists) {
            log(`AUDIO CHUNK CACHE HIT (disk): ${id}`);
            continue;
        }

        const segment = segments[i];
        const isDialogue = segment.segment_type === 'dialogue';
        const workflowName = isDialogue ? WORKFLOW_DIALOGUE : WORKFLOW_NARRATION;
        const wfAudio = wfLoader.getWorkflow(workflowName);

        if (isDialogue) {
            const connector = wfLoader.getConnector(workflowName);
            if (connector) {
                const cl = require('../workflows/connector-loader');
                cl.setValue(wfAudio, connector, 'dialogueScript', segment.text);
                cl.setValue(wfAudio, connector, 'defaultInstruct', "");
            } else {
                wfAudio["108"].inputs = { script: segment.text, default_instruct: "" };
            }

            const participants = sceneData.payload?.participants || [];
            const chars = participants.map(id => loadedBook?.characters?.find(c => c.id === id)).filter(Boolean);
            const c1 = chars[0] || {};
            const c2 = chars[1] || {};

            if (connector) {
                const cl = require('../workflows/connector-loader');
                if (c1?.voice?.instruction) {
                    cl.setValue(wfAudio, connector, 'character1Voice', c1.voice.instruction);
                }
                if (c2?.voice?.instruction) {
                    cl.setValue(wfAudio, connector, 'character2Voice', c2.voice.instruction);
                }
                cl.setValue(wfAudio, connector, 'roleName1', c1?.id || "role1");
                cl.setValue(wfAudio, connector, 'roleName2', c2?.id || "role2");
            } else {
                if (c1?.voice?.instruction) {
                    wfAudio["71"].inputs.voice_instruction = c1.voice.instruction;
                }
                if (c2?.voice?.instruction) {
                    wfAudio["80"].inputs.voice_instruction = c2.voice.instruction;
                }
                wfAudio["74"].inputs.role_name_1 = c1?.id || "role1";
                wfAudio["74"].inputs.role_name_2 = c2?.id || "role2";
            }
        } else {
            const connector = wfLoader.getConnector(workflowName);
            if (connector) {
                const cl = require('../workflows/connector-loader');
                cl.setValue(wfAudio, connector, 'narrationText', segment.text);
                const vi = narratorVoice(sceneData.payload, loadedBook);
                if (vi) {
                    cl.setValue(wfAudio, connector, 'voiceInstruction', vi);
                }
            } else {
                wfAudio["108"].inputs.text = segment.text;
                const vi = narratorVoice(sceneData.payload, loadedBook);
                if (vi) {
                    wfAudio["108"].inputs.voice_instruction = vi;
                }
            }
        }

        await gpu.send(`${id}:audio`, wfAudio, "audio", buildId);
        log(`Audio TTS submitted: ${id} (${segment.segment_type})`);
    }

    await redis.del(sceneLockKey);
    log(`Audio orchestration lock released: ${bookId}/${chapterId}/${sceneId}`);

    return { generated: true, expectedChunkCount };
}

// ======================================================
// BOOK-LEVEL AUDIO MERGE
// ======================================================

async function mergeBookAudio(buildId, bookId, scenes) {
    if (!scenes || scenes.length === 0) {
        warn(`mergeBookAudio: no scenes for book ${bookId}`);
        return null;
    }

    const finalPath = getOutputPath(buildId, `${bookId}.mp3`);
    log(`mergeBookAudio: ${bookId} (${scenes.length} scenes) -> ${finalPath}`);

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
 * Write a minimal valid MP3 silence file using pure Node.js.
 * This is a fallback when ffmpeg is not available.
 * Generates MPEG1 Layer 3 silent frames.
 */
function writeSilentMP3Node(outputPath, durationSec) {
    // MPEG1 Layer 3, 64kbps, 24000Hz, mono, no CRC
    const sampleRate = 24000;
    const bitrateKbps = 64;
    const frameSamples = 1152; // MPEG1 Layer 3 samples per frame
    const frameSize = Math.floor(144 * bitrateKbps * 1000 / sampleRate); // bytes per frame (384)

    // Build MPEG frame header (4 bytes)
    const header = Buffer.alloc(4);
    // Byte 0: sync word (0xFF)
    header[0] = 0xFF;
    // Byte 1: 0xFB = sync(3) + MPEG1(2) + Layer3(2) + noCRC(1)
    // bits: 1111 1011
    header[1] = 0xFB;
    // Byte 2: bitrate_idx(4) + sample_rate_idx(2) + padding(1) + private(1)
    // bitrate_idx=5 (64kbps), sample_rate_idx=2 (24kHz), padding=0, private=0
    // 0101 1000 = 0x58
    header[2] = 0x58;
    // Byte 3: channel_mode(2) + mode_ext(2) + copyright(1) + original(1) + emphasis(2)
    // channel_mode=3 (mono), original=1
    // 1100 0100 = 0xC4
    header[3] = 0xC4;

    // One frame = header + side info + main data (zeros = silence)
    const frame = Buffer.concat([header, Buffer.alloc(frameSize - 4, 0)]);

    // Calculate number of frames needed for requested duration
    const framesNeeded = Math.max(1, Math.ceil((durationSec * sampleRate) / frameSamples));

    // Concatenate frames
    const totalSize = framesNeeded * frameSize;
    const result = Buffer.alloc(totalSize);
    for (let i = 0; i < framesNeeded; i++) {
        frame.copy(result, i * frameSize);
    }

    fs.writeFileSync(outputPath, result);
}

/**
 * Generate a silent MP3 audio file.
 * Prefers ffmpeg for proper encoding, falls back to pure Node.js MP3 frame generation
 * when ffmpeg is not available.
 */
async function generateSilentAudio(outputPath, durationSec) {
    if (isFFmpegAvailable()) {
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

    // Pure Node.js fallback when ffmpeg is not available
    log(`ffmpeg not found, generating silent MP3 with Node.js fallback: ${path.basename(outputPath)} (${durationSec.toFixed(1)}s)`);
    writeSilentMP3Node(outputPath, durationSec);
    return outputPath;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    getOutputPath,
    makeChunkId,
    runFFmpegMerge,
    runFFmpegTrim,
    buildSceneAudio,
    mergeSceneAudioChunks,
    recoverSceneAudioFromChunks,
    validateCanonicalAudio,
    isSceneAudioReady,
    getAudioDuration,
    findExistingSceneChunks,
    allSceneChunksExist,
    areSceneAudioChunksReady,
    mergeBookAudio,
    generateSceneAudio,
    buildSegments,
    narratorVoice,
    trimPaddedSceneAudio,
    escapeRegExp,
    generateSilentAudio,
    // Connector-aware utilities
    applyAudioValue,
    getAudioNodeId,
    WORKFLOW_NARRATION,
    WORKFLOW_DIALOGUE,
};
