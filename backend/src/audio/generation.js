// ======================================================
// Audio Generation
// ======================================================

const fs = require('fs');
const path = require('path');
const gpu = require('../runtime/gpu-dispatcher');
const jobSchema = require('../runtime/job-schema');
const wfLoader = require('../workflows/workflow-loader');
const helpers = require('./helpers');
const validation = require('./validation');
const chunks = require('./chunks');
const segments = require('./segments');
const ffmpeg = require('./ffmpeg');

const WORKFLOW_NARRATION = 'tts-qwen-narrator';
const WORKFLOW_DIALOGUE = 'tts-qwen-dialogue';

// ══════════════════════════════════════════════════════
//  MERGED DIALOGUE WORKFLOW
// ══════════════════════════════════════════════════════
// Собирает ВСЕ диалоговые сегменты чистой сцены в один
// workflow с динамическим RoleBank на N ролей.
// Это даёт Qwen3TTSAdvancedDialogue возможность
// сгенерировать непрерывную естественную беседу.
//
// Для каждого уникального speaker-а создаётся пара нод:
//   VoiceDesign (голосовая инструкция → аудио-образец)
//   VoiceClonePrompt (аудио-образец → voice prompt)
//
// RoleBank расширяется role_name_N + prompt_N для всех
// speaker-ов, а не только для первых двух.
// ══════════════════════════════════════════════════════

function buildMergedDialogueWorkflow(segments, loadedBook) {
    const wfAudio = wfLoader.getWorkflow(WORKFLOW_DIALOGUE);
    if (!wfAudio) {
        helpers.error('buildMergedDialogueWorkflow: base workflow not found');
        return null;
    }

    // ── 1. Collect all speakers and voice instructions ──
    const speakers = new Map(); // speakerId → voiceInstruction
    const scriptLines = [];
    const speakerRegex = /^([a-z0-9_]+):\s/;

    for (const seg of segments) {
        if (seg.segment_type !== 'dialogue') continue;
        const match = seg.text.match(speakerRegex);
        const speakerId = match ? match[1] : null;
        if (speakerId && !speakers.has(speakerId)) {
            const vi = loadedBook?.voices?.[speakerId]?.instruction
                || loadedBook?.characters?.find(x => x.id === speakerId)?.voice?.instruction
                || "";
            speakers.set(speakerId, vi);
        }
        scriptLines.push(seg.text);
    }

    const script = scriptLines.join('\n');
    const speakerIds = [...speakers.keys()];
    const speakerCount = speakerIds.length;

    if (speakerCount === 0) {
        helpers.warn('buildMergedDialogueWorkflow: no speakers found in segments');
        return null;
    }

    if (speakerCount > 3) {
        helpers.warn(`buildMergedDialogueWorkflow: ${speakerCount} speakers exceeds max 3 — falling back to per-segment`);
        return null;
    }

    helpers.log(`🎭 Merged dialogue: ${speakerCount} speaker(s), ${segments.length} segment(s)`);

    // ── 2. Build script node (node 108) ──
    wfAudio["108"].inputs = {
        script,
        default_instruct: ""
    };

    // ── 3. Map speaker → static node IDs ──
    // speaker 0 → 71(VoiceDesign) + 73(ClonePrompt)
    // speaker 1 → 80(VoiceDesign) + 81(ClonePrompt)
    // speaker 2 → 82(VoiceDesign) + 83(ClonePrompt)
    const voiceDesignIds = [71, 80, 82];
    const clonePromptIds = [73, 81, 83];

    // Update VoiceDesign nodes with actual voice instructions.
    // Если voice пустой — используем narrator voice как fallback.
    // ComfyUI выдаёт ошибку "Voice instruction cannot be empty."
    const narratorVi = segments.narratorVoice({}, loadedBook);
    const vi0 = speakers.get(speakerIds[0]) || narratorVi;
    if (vi0) wfAudio["71"].inputs.voice_instruction = vi0;
    if (speakerCount > 1) {
        const vi1 = speakers.get(speakerIds[1]) || narratorVi;
        if (vi1) wfAudio["80"].inputs.voice_instruction = vi1;
    }
    if (speakerCount > 2) {
        const vi2 = speakers.get(speakerIds[2]) || narratorVi;
        if (vi2) wfAudio["82"].inputs.voice_instruction = vi2;
    }

    // ── 4. Configure RoleBank (node 74) with correct role names ──
    for (let i = 0; i < speakerCount; i++) {
        const idx = i + 1;
        wfAudio["74"].inputs[`role_name_${idx}`] = speakerIds[i];
        wfAudio["74"].inputs[`prompt_${idx}`] = [String(clonePromptIds[i]), 0];
    }

    helpers.log(`🎭 Merged dialogue: roles=${speakerIds.join(', ')}`);
    return wfAudio;
}

async function trimPaddedSceneAudio(filePath, originalTextLength) {
    const basename = path.basename(filePath);

    const duration = await ffmpeg.probeDuration(filePath);
    if (!duration || duration < 0.5) {
        helpers.log(`✂️ trimPaddedSceneAudio: ${basename} duration=${duration}s too short, skipping`);
        return;
    }

    let cutTime;
    if (originalTextLength && originalTextLength > 0) {
        // Ratio-based cut: padShortText produces `text + " " + text`
        // Keep only the first copy. Ratio = original_len / (original_len * 2 + 1).
        const paddedLength = originalTextLength * 2 + 1;
        const ratio = originalTextLength / paddedLength;
        cutTime = duration * ratio;
        helpers.log(`✂️ trimPaddedSceneAudio: ${basename} ratio-based cut: ${originalTextLength}/${paddedLength} = ${ratio.toFixed(3)} of ${duration.toFixed(2)}s → cut at ${cutTime.toFixed(2)}s`);
    } else {
        // Fallback: silence detection for legacy padded chunks without original_text_length
        const quietest = await ffmpeg.findQuietestPoint(filePath, 0.40, 0.60);
        cutTime = (quietest > 0.3) ? quietest : (duration / 2);
        helpers.log(`✂️ trimPaddedSceneAudio: ${basename} silence-based fallback: quietest=${quietest.toFixed(3)}s → cut at ${cutTime.toFixed(2)}s`);
    }

    const safetyMargin = 0.10;
    cutTime = Math.min(cutTime + safetyMargin, duration * 0.55);

    const tempPath = filePath + '.trim.mp3';
    const ok = await ffmpeg.cutFirstHalf(filePath, tempPath, cutTime);
    if (ok) {
        try {
            fs.renameSync(tempPath, filePath);
            helpers.log(`✂️ trimPaddedSceneAudio: trimmed ${basename} → kept first ${cutTime.toFixed(1)}s (original ${duration.toFixed(1)}s)`);
        } catch (e) {
            helpers.log(`⚠️ trimPaddedSceneAudio: rename failed for ${basename}: ${e.message}`);
        }
    } else {
        helpers.log(`⚠️ trimPaddedSceneAudio: ffmpeg cut failed for ${basename}, file unchanged`);
    }
}

// ══════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════

/**
 * Create or update a single chunk in Redis for a merged dialogue scene.
 */
async function ensureMergedChunk(redis, buildId, bookId, chapterId, sceneId, sceneType, audioStatus) {
    const chunkIndex = 1;
    const id = chunks.makeChunkId(chapterId, sceneId, chunkIndex, bookId);
    const chunkKey = `animastor:chunk:${id}`;

    const chunkData = {
        build_id: buildId,
        book_id: bookId,
        chapter_id: chapterId,
        scene_id: sceneId,
        chunk_index: String(chunkIndex).padStart(4, '0'),
        expected_chunk_count: 1,
        scene_type: sceneType,
        audio: audioStatus === 'ready',
        audio_status: audioStatus,
        padded_text: false
    };

    await redis.set(chunkKey, JSON.stringify(chunkData));
    await redis.sadd(`animastor:chunks:${bookId}`, id);
    return { id };
}

/**
 * Determine voice instruction for a character.
 */
function voiceForCharacter(charId, loadedBook) {
    return loadedBook?.voices?.[charId]?.instruction
        || loadedBook?.characters?.find(x => x.id === charId)?.voice?.instruction
        || "";
}

// ══════════════════════════════════════════════════════
//  GENERATE SCENE AUDIO
// ══════════════════════════════════════════════════════

async function generateSceneAudio(redis, sceneData, loadedBook, buildId, bookId, dispatchId) {
    const chapterId = sceneData.chapter_id;
    const sceneId = sceneData.scene_id;

    const sceneLockKey = `animastor:audio-scene-lock:${bookId}:${chapterId}:${sceneId}`;
    const lockAcquired = await redis.set(sceneLockKey, buildId, 'NX', 'EX', 600);
    if (!lockAcquired) {
        helpers.log(`Audio orchestration already in progress: ${bookId}/${chapterId}/${sceneId}`);
        return { generated: false, reason: 'locked' };
    }

    const segList = segments.buildSegments(sceneData);

    // ── Detect pure dialogue scene ──
    // Если ВСЕ сегменты — dialogue, собираем их в один merged workflow.
    // Это даёт Qwen3TTSAdvancedDialogue непрерывную беседу.
    const isPureDialogue = segList.length > 0 && segList.every(s => s.segment_type === 'dialogue');
    const expectedChunkCount = isPureDialogue ? 1 : segList.length;
    helpers.log(`generateSceneAudio: ${bookId}/${chapterId}/${sceneId} segments=${segList.length} isPureDialogue=${isPureDialogue} expectedChunks=${expectedChunkCount}`);

    // 🧹 Log partial completion — don't delete, sendPerSegmentAudio handles cache-hit per chunk
    const existingChunks = chunks.findExistingSceneChunks(bookId, chapterId, sceneId, buildId);
    if (existingChunks.length > 0 && existingChunks.length !== expectedChunkCount) {
        helpers.log(`🧹 Partial audio cache: ${existingChunks.length}/${expectedChunkCount} chunks on disk — preserving, sendPerSegmentAudio will reuse existing and dispatch missing`);
    }

    // ── Check if audio is already ready ──
    let isReady = await validation.isSceneAudioReady(buildId, bookId, chapterId, sceneId);
    if (isReady) {
        try {
            const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
            const asset = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'audio', buildId);
            if (asset && asset.status === 'placeholder') {
                helpers.log(`Audio is placeholder — will regenerate real audio: ${bookId}/${chapterId}/${sceneId}`);
                isReady = false;
                const mergedPath = helpers.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
                if (fs.existsSync(mergedPath)) {
                    try {
                        fs.unlinkSync(mergedPath);
                        helpers.log(`  🗑 Deleted stale placeholder merged audio: ${mergedPath}`);
                    } catch (e) {
                        helpers.warn(`  ⚠️ Failed to delete stale placeholder merged audio: ${e.message}`);
                    }
                }
            }
        } catch (err) {
            helpers.warn(`Failed to check audio status: ${err.message}`);
            isReady = false;
        }

        if (isReady) {
            try {
                const state = require('../state');
                const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
                if (assetStates && assetStates.audio === 'pending') {
                    helpers.log(`Audio state is PENDING in Redis — will regenerate: ${bookId}/${chapterId}/${sceneId}`);
                    isReady = false;
                }
            } catch (err) {
                helpers.warn(`Failed to check Redis asset state: ${err.message}`);
            }
        }
    }

    if (isReady) {
        helpers.log(`Audio already ready, no generation needed: ${bookId}/${chapterId}/${sceneId}`);
        if (isPureDialogue) {
            // Pure dialogue: ensure single merged chunk
            await ensureMergedChunk(redis, buildId, bookId, chapterId, sceneId, sceneData.scene_type, 'ready');
        } else {
            for (let i = 0; i < segList.length; i++) {
                const chunkIndex = i + 1;
                const id = chunks.makeChunkId(chapterId, sceneId, chunkIndex, bookId);
                const chunkKey = `animastor:chunk:${id}`;
                const existingChunk = await redis.get(chunkKey);
                if (existingChunk) {
                    const segment = segList[i];
                    const existing = JSON.parse(existingChunk);
                    existing.padded_text = segment.padded || false;
                    existing.expected_chunk_count = expectedChunkCount;
                    if (existing.audio_status !== 'ready') {
                        existing.audio = true;
                        existing.audio_status = 'ready';
                    }
                    await redis.set(chunkKey, JSON.stringify(existing));
                } else {
                    const segment = segList[i];
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
        }
        await redis.del(sceneLockKey);
        return { generated: false, reason: 'already_ready' };
    }

    // ── Generate audio ──
    let sentCount = 0;

    if (isPureDialogue) {
        // ════════════════════════════════════════
        // PURE DIALOGUE: один merged workflow
        // ════════════════════════════════════════
        const mergedWf = buildMergedDialogueWorkflow(segList, loadedBook);
        if (!mergedWf) {
            helpers.warn(`Pure dialogue: buildMergedDialogueWorkflow returned null for ${bookId}/${chapterId}/${sceneId} — falling back to per-segment`);
            // Fallback to per-segment approach
            sentCount = await sendPerSegmentAudio(redis, segList, sceneData, loadedBook, buildId, bookId, dispatchId, chapterId, sceneId);
        } else {
            // Create single chunk and send one workflow
            const { id } = await ensureMergedChunk(
                redis, buildId, bookId, chapterId, sceneId, sceneData.scene_type, 'pending'
            );

            const sendResult = await gpu.send(
                jobSchema.buildJobId(id, 'audio'),
                mergedWf,
                "audio",
                buildId,
                dispatchId
            );

            if (sendResult.sent) {
                sentCount = 1;
                helpers.log(`🎭 Merged dialogue dispatched: ${bookId}/${chapterId}/${sceneId} (${segList.length} segments in 1 workflow)`);
            } else {
                helpers.warn(`Audio enqueue failed for merged dialogue ${id}: ${sendResult.error || 'unknown'}`);
                // Cleanup the pending chunk
                const chunkKey = `animastor:chunk:${id}`;
                await redis.del(chunkKey);
                await redis.srem(`animastor:chunks:${bookId}`, id);
            }
        }
    } else {
        // ════════════════════════════════════════
        // MIXED SCENE: по-сегментно (narration + dialogue)
        // ════════════════════════════════════════
        sentCount = await sendPerSegmentAudio(redis, segList, sceneData, loadedBook, buildId, bookId, dispatchId, chapterId, sceneId);
    }

    await redis.del(sceneLockKey);
    helpers.log(`Audio orchestration lock released: ${bookId}/${chapterId}/${sceneId}`);

    return {
        generated: sentCount > 0,
        chunks: sentCount,
        expectedChunkCount: isPureDialogue ? 1 : segList.length,
        reason: sentCount > 0 ? null : 'no_jobs_accepted'
    };
}

/**
 * Send audio per-segment (for mixed scenes or fallback).
 * Each segment gets its own workflow with speaker-based voice.
 */
async function sendPerSegmentAudio(redis, segList, sceneData, loadedBook, buildId, bookId, dispatchId, chapterId, sceneId) {
    let sentCount = 0;

    // ═══ BATCH DISPATCH ═══
    // Отправляем все narration чанки скопом, затем все dialogue.
    // Narration workflow загружает 1 модель (VoiceDesign),
    // dialogue workflow — 2 модели (VoiceDesign + Base).
    // Чередование вызывает постоянную перезагрузку Base-модели на ComfyUI,
    // что приводит к 0-секундному аудио при переходе narration→dialogue→narration...
    // Batching сохраняет оригинальные chunkIndex — мердж не путает порядок.
    const indexedSegs = segList.map((seg, i) => ({ idx: i + 1, segment: seg }));
    const narrationSegs = indexedSegs.filter(s => s.segment.segment_type !== 'dialogue');
    const dialogueSegs = indexedSegs.filter(s => s.segment.segment_type === 'dialogue');
    const reordered = [...narrationSegs, ...dialogueSegs];
    helpers.log(`📦 BATCH dispatch: ${narrationSegs.length} narration first, then ${dialogueSegs.length} dialogue`);

    for (const { idx: chunkIndex, segment } of reordered) {
        const id = chunks.makeChunkId(chapterId, sceneId, chunkIndex, bookId);

        const chunkFilePath = chunks.getChunkAudioPath(buildId, bookId, chapterId, sceneId, chunkIndex);
        const chunkFileExists = fs.existsSync(chunkFilePath);

        const chunkKey = `animastor:chunk:${id}`;
        const existingChunk = await redis.get(chunkKey);
        if (existingChunk) {
            const existing = JSON.parse(existingChunk);
            const expectPadded = segment.padded || false;
            if (existing.padded_text !== expectPadded) {
                helpers.log(`🧹 Stale padded_text flag for ${id}: was ${existing.padded_text}, expected ${expectPadded} — deleting stale cache`);
                if (fs.existsSync(chunkFilePath)) {
                    try { fs.unlinkSync(chunkFilePath); } catch (e) {}
                }
                await redis.del(chunkKey);
                await redis.srem(`animastor:chunks:${bookId}`, id);
                const fresh = {
                    build_id: buildId,
                    book_id: bookId,
                    chapter_id: chapterId,
                    scene_id: sceneId,
                    chunk_index: String(chunkIndex).padStart(4, '0'),
                    expected_chunk_count: segList.length,
                    scene_type: sceneData.scene_type,
                    audio: false,
                    audio_status: 'pending',
                    padded_text: expectPadded,
                    original_text_length: segment.original_text_length
                };
                await redis.set(chunkKey, JSON.stringify(fresh));
                await redis.sadd(`animastor:chunks:${bookId}`, id);
            } else {
                existing.padded_text = expectPadded;
                existing.expected_chunk_count = segList.length;
                existing.audio = chunkFileExists;
                existing.audio_status = chunkFileExists ? 'ready' : 'pending';
                await redis.set(chunkKey, JSON.stringify(existing));

                if (chunkFileExists) {
                    helpers.log(`AUDIO CHUNK CACHE HIT (disk): ${id}`);
                    continue;
                }
            }
        } else {
            const chunkData = {
                build_id: buildId,
                book_id: bookId,
                chapter_id: chapterId,
                scene_id: sceneId,
                chunk_index: String(chunkIndex).padStart(4, '0'),
                expected_chunk_count: segList.length,
                scene_type: sceneData.scene_type,
                audio: chunkFileExists,
                audio_status: chunkFileExists ? 'ready' : 'pending',
                padded_text: segment.padded || false,
                original_text_length: segment.original_text_length
            };
            await redis.set(chunkKey, JSON.stringify(chunkData));
            await redis.sadd(`animastor:chunks:${bookId}`, id);

            if (chunkFileExists) {
                helpers.log(`AUDIO CHUNK CACHE HIT (disk): ${id}`);
                continue;
            }
        }

        const isDialogue = segment.segment_type === 'dialogue';
        const workflowName = isDialogue ? WORKFLOW_DIALOGUE : WORKFLOW_NARRATION;
        const wfAudio = wfLoader.getWorkflow(workflowName);

        if (isDialogue) {
            // Dialogue → Qwen3TTSAdvancedDialogue
            const connector = wfLoader.getConnector(workflowName);
            if (connector) {
                const cl = require('../workflows/connector-loader');
                cl.setValue(wfAudio, connector, 'dialogueScript', segment.text);
                cl.setValue(wfAudio, connector, 'defaultInstruct', "");
            } else {
                wfAudio["108"].inputs = { script: segment.text, default_instruct: "" };
            }

            // ⚡ Определяем speaker из segment.text (формат: "speaker_id: текст")
            const speakerMatch = segment.text.match(/^([a-z0-9_]+):\s/);
            const speakerId = speakerMatch ? speakerMatch[1] : null;

            const speakerVoice = speakerId ? voiceForCharacter(speakerId, loadedBook) : "";
            const narratorVi = segments.narratorVoice(sceneData.payload, loadedBook);

            // ⚡ FALLBACK: если у speaker нет голоса — используем narrator голос.
            // ComfyUI выдаёт ошибку "Voice instruction cannot be empty."
            const c1Voice = speakerVoice || narratorVi || "";
            const c2Voice = narratorVi || c1Voice || "";

            if (!c1Voice) {
                helpers.warn(`⚠️ EMPTY VOICE for ${speakerId || 'unknown'} in ${bookId}/${chapterId}/${sceneId} — using template default`);
            }

            if (connector) {
                const cl = require('../workflows/connector-loader');
                if (c1Voice) cl.setValue(wfAudio, connector, 'character1Voice', c1Voice);
                if (c2Voice) cl.setValue(wfAudio, connector, 'character2Voice', c2Voice);
                cl.setValue(wfAudio, connector, 'roleName1', speakerId || "speaker");
                cl.setValue(wfAudio, connector, 'roleName2', "narrator");
            } else {
                if (c1Voice) wfAudio["71"].inputs.voice_instruction = c1Voice;
                if (c2Voice) wfAudio["80"].inputs.voice_instruction = c2Voice;
                wfAudio["74"].inputs.role_name_1 = speakerId || "speaker";
                wfAudio["74"].inputs.role_name_2 = "narrator";
            }

            // [DEBUG] Log actual workflow values for this dialogue chunk
            helpers.log(`[DEBUG] Dialogue chunk prompt: id=${id} speaker=${speakerId || 'unknown'} text="${segment.text.substring(0, 80)}" c1Voice=${c1Voice ? '(set)' : '(empty)'} c2Voice=${c2Voice ? '(set)' : '(empty)'} workflow=${workflowName}`);
        } else {
            // Narration segment
            const connector = wfLoader.getConnector(workflowName);
            const vi = segments.narratorVoice(sceneData.payload, loadedBook);

            if (!vi) {
                helpers.warn(`⚠️ EMPTY narrator voice for ${bookId}/${chapterId}/${sceneId} — using template default`);
            }

            if (connector) {
                const cl = require('../workflows/connector-loader');
                cl.setValue(wfAudio, connector, 'narrationText', segment.text);
                if (vi) {
                    cl.setValue(wfAudio, connector, 'voiceInstruction', vi);
                }
            } else {
                wfAudio["108"].inputs.text = segment.text;
                if (vi) {
                    wfAudio["108"].inputs.voice_instruction = vi;
                }
            }
        }

        const sendResult = await gpu.send(
            jobSchema.buildJobId(id, 'audio'),
            wfAudio,
            "audio",
            buildId,
            dispatchId
        );
        if (sendResult.sent) {
            sentCount++;
            helpers.log(`📤 Dispatched chunk ${chunkIndex}/${segList.length}: ${id} (${segment.segment_type}, padded=${!!segment.padded})`);
        } else {
            helpers.warn(`Audio enqueue failed for ${id}: ${sendResult.error || 'unknown'}`);
        }
    }

    return sentCount;
}

async function mergeBookAudio(buildId, bookId, scenes) {
    if (!scenes || scenes.length === 0) {
        helpers.warn(`mergeBookAudio: no scenes for book ${bookId}`);
        return null;
    }

    const finalPath = helpers.getOutputPath(buildId, `${bookId}.mp3`);
    helpers.log(`mergeBookAudio: ${bookId} (${scenes.length} scenes) -> ${finalPath}`);

    if (fs.existsSync(finalPath)) {
        try {
            const isValid = await validation.validateCanonicalAudio(finalPath);
            if (isValid) {
                helpers.log(`Book audio already exists and is valid: ${path.basename(finalPath)}`);
                return finalPath;
            }
            helpers.log(`Book audio exists but invalid, regenerating`);
            try { fs.unlinkSync(finalPath); } catch (e) {}
        } catch (err) {
            helpers.warn(`Book audio validation error, regenerating: ${err.message}`);
            try { fs.unlinkSync(finalPath); } catch (e) {}
        }
    }

    const audioPaths = [];
    for (const scene of scenes) {
        const scenePath = helpers.getOutputPath(buildId, `${bookId}_${scene.chapter_id}_${scene.scene_id}.mp3`);
        if (fs.existsSync(scenePath)) {
            audioPaths.push(scenePath);
        } else {
            helpers.warn(`Scene audio not found: ${scenePath}`);
        }
    }

    if (audioPaths.length === 0) {
        helpers.warn(`mergeBookAudio: no scene audio files found for book ${bookId}`);
        return null;
    }

    if (audioPaths.length === 1) {
        fs.copyFileSync(audioPaths[0], finalPath);
        helpers.log(`Book audio: single scene, copied.`);
        return finalPath;
    }

    const concatPath = path.join('/tmp', `aconcat_${bookId}_${Date.now()}.txt`);
    const concatContent = audioPaths.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatPath, concatContent);

    try {
        const args = ['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', finalPath, '-y'];
        await ffmpeg.runFFmpegMerge(args);
        helpers.log(`Book audio merged: ${path.basename(finalPath)}`);
        return finalPath;
    } catch (err) {
        helpers.error(`Book audio merge failed: ${err.message}`);
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

module.exports = {
    generateSceneAudio,
    mergeBookAudio,
    trimPaddedSceneAudio,
    buildMergedDialogueWorkflow,
    WORKFLOW_NARRATION,
    WORKFLOW_DIALOGUE,
};
