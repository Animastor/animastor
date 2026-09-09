// ======================================================
// Audio Generation
// ======================================================

const fs = require('fs');
const path = require('path');
// S-3: the generation provider seam is the ONLY Generation → ComfyUI/GPU
// boundary. No gpu-dispatcher / workflow-connector imports in executors.
const provider = require('../generation/comfyui-provider');
const { resolveAssembly } = require('../generation/prompt-profiles/assembly-profile');
const profileOverride = require('../services/profile-override');
const helpers = require('./helpers');
// S-4: filename grammar composed from the canonical owner (bytes unchanged)
const artifactNaming = require('../generation/artifact-naming');
const validation = require('./validation');
const chunks = require('./chunks');
const segments = require('./segments');
const ffmpeg = require('./ffmpeg');

const WORKFLOW_NARRATION = 'tts-qwen-narrator';
const WORKFLOW_DIALOGUE = 'tts-qwen-dialogue';

/**
 * Resolve the active audio assembly profile (ai/profiles/audio/{profile}.json).
 * A user override (global settings choice) wins; otherwise the TTS connector's
 * profile.audioProfile ('qwen-tts'); falls back to the built-in audio
 * assembly when unset (there is no 'default' profile). Its defaults
 * drive programmatic values like the dialogue workflow's defaultInstruct.
 * @returns {object} — normalized assembly { profileName, type, sections, suppress, defaults }
 */
function resolveAudioAssembly() {
    const connector = provider.getConnector(WORKFLOW_DIALOGUE) || provider.getConnector(WORKFLOW_NARRATION);
    return resolveAssembly('audio', profileOverride.getOverride('audio') || provider.profileNameFromConnector(connector, 'audio'));
}

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

function buildMergedDialogueWorkflow(segList, loadedBook) {
    // NOTE: the parameter is named segList (NOT segments) — 'segments' is the
    // module-level require('./segments') used below for narratorVoice().

    // ── 1. Collect all speakers and voice instructions ──
    // The speaker label is any text before the first ": " — a character_id
    // (mikhail_berlioz) OR a natural designation of an episodic speaker
    // ("женщина в будочке"). Episodic speakers keep their natural label as the
    // role name and get the narrator voice as fallback — they are NOT
    // characters and must never be forced into a snake_case id.
    const speakers = new Map(); // speakerId → voiceInstruction
    const scriptLines = [];
    const speakerRegex = /^([^:\n]+?):\s/;

    for (const seg of segList) {
        if (seg.segment_type !== 'dialogue') continue;
        const match = seg.text.match(speakerRegex);
        const speakerId = match ? match[1].trim() : null;
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

    helpers.log(`🎭 Merged dialogue: ${speakerCount} speaker(s), ${segList.length} segment(s)`);

    // ── 2. Resolve voices + hand off to the provider seam ──
    // S-3: ComfyUI node knowledge (script/VoiceDesign/RoleBank/ClonePrompt
    // nodes) lives ONLY in the provider. The executor passes semantic
    // speaker data: name + voice instruction.
    // Empty voice → narrator voice fallback (ComfyUI rejects empty voice
    // instructions: "Voice instruction cannot be empty.").
    const narratorVi = segments.narratorVoice({}, loadedBook);
    const speakerSpecs = speakerIds.map(id => ({ name: id, voice: speakers.get(id) || narratorVi }));
    const wfAudio = provider.assembleMergedDialogueWorkflow({
        script,
        defaultInstruct: resolveAudioAssembly().defaults.defaultInstruct || "",
        speakers: speakerSpecs,
    });
    if (!wfAudio) {
        helpers.error('buildMergedDialogueWorkflow: base workflow not found');
        return null;
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
    const existingChunks = chunks.findExistingSceneChunks(bookId, chapterId, sceneId, buildId, expectedChunkCount);
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
                const mergedPath = helpers.getOutputPath(buildId, artifactNaming.sceneAudioName(bookId, chapterId, sceneId));
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
                    existing.unit_id = segment.unit_id || existing.unit_id || null;
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
                        padded_text: segment.padded || false,
                        unit_id: segment.unit_id || null
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

            const sendResult = await provider.generate({
                jobId: provider.buildJobId(id, 'audio'),
                workflow: mergedWf,
                jobType: 'audio',
                buildId,
                dispatchId
            });

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
                    original_text_length: segment.original_text_length,
                    unit_id: segment.unit_id || null
                };
                await redis.set(chunkKey, JSON.stringify(fresh));
                await redis.sadd(`animastor:chunks:${bookId}`, id);
            } else {
                existing.padded_text = expectPadded;
                existing.expected_chunk_count = segList.length;
                existing.unit_id = segment.unit_id || existing.unit_id || null;
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
                original_text_length: segment.original_text_length,
                unit_id: segment.unit_id || null
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
        const wfAudio = provider.loadWorkflow(workflowName);

        if (isDialogue) {
            // Dialogue → Qwen3TTSAdvancedDialogue — all node patching via the
            // provider's connector bindings (entity keys, no node ids here).
            const defaultInstruct = resolveAudioAssembly().defaults.defaultInstruct || "";
            provider.applyValue(wfAudio, workflowName, 'dialogueScript', segment.text);
            provider.applyValue(wfAudio, workflowName, 'defaultInstruct', defaultInstruct);

            // ⚡ Определяем speaker из segment.text (формат: "speaker: текст")
            // speaker = character_id ИЛИ естественное обозначение эпизодического
            // участника ("женщина в будочке") — он остаётся как есть, без
            // принудительного snake_case id; голос по умолчанию = narrator.
            const speakerMatch = segment.text.match(/^([^:\n]+?):\s/);
            const speakerId = speakerMatch ? speakerMatch[1].trim() : null;

            const speakerVoice = speakerId ? voiceForCharacter(speakerId, loadedBook) : "";
            const narratorVi = segments.narratorVoice(sceneData.payload, loadedBook);

            // ⚡ FALLBACK: если у speaker нет голоса — используем narrator голос.
            // ComfyUI выдаёт ошибку "Voice instruction cannot be empty."
            const c1Voice = speakerVoice || narratorVi || "";
            const c2Voice = narratorVi || c1Voice || "";

            if (!c1Voice) {
                helpers.warn(`⚠️ EMPTY VOICE for ${speakerId || 'unknown'} in ${bookId}/${chapterId}/${sceneId} — using template default`);
            }

            if (c1Voice) provider.applyValue(wfAudio, workflowName, 'character1Voice', c1Voice);
            if (c2Voice) provider.applyValue(wfAudio, workflowName, 'character2Voice', c2Voice);
            provider.applyValue(wfAudio, workflowName, 'roleName1', speakerId || "speaker");
            provider.applyValue(wfAudio, workflowName, 'roleName2', "narrator");

        } else {
            // Narration segment
            const vi = segments.narratorVoice(sceneData.payload, loadedBook);

            if (!vi) {
                helpers.warn(`⚠️ EMPTY narrator voice for ${bookId}/${chapterId}/${sceneId} — using template default`);
            }

            provider.applyValue(wfAudio, workflowName, 'narrationText', segment.text);
            if (vi) {
                provider.applyValue(wfAudio, workflowName, 'voiceInstruction', vi);
            }
        }

        const sendResult = await provider.generate({
            jobId: provider.buildJobId(id, 'audio'),
            workflow: wfAudio,
            jobType: 'audio',
            buildId,
            dispatchId
        });
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

    const finalPath = helpers.getOutputPath(buildId, artifactNaming.bookAudioName(bookId));
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
        const scenePath = helpers.getOutputPath(buildId, artifactNaming.sceneAudioName(bookId, scene.chapter_id, scene.scene_id));
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
    resolveAudioAssembly,
    WORKFLOW_NARRATION,
    WORKFLOW_DIALOGUE,
};
