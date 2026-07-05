// ======================================================
// Audio Generation
// ======================================================

const fs = require('fs');
const path = require('path');
const gpu = require('../runtime/gpu-dispatcher');
const wfLoader = require('../workflows/workflow-loader');
const helpers = require('./helpers');
const validation = require('./validation');
const chunks = require('./chunks');
const segments = require('./segments');
const ffmpeg = require('./ffmpeg');

const WORKFLOW_NARRATION = 'tts-qwen-narrator';
const WORKFLOW_DIALOGUE = 'tts-qwen-dialogue';

async function trimPaddedSceneAudio(filePath) {
    const basename = path.basename(filePath);
    helpers.log(`✂️ trimPaddedSceneAudio: trimming ${basename}`);

    const duration = await ffmpeg.probeDuration(filePath);
    if (!duration || duration < 0.5) {
        helpers.log(`⚠️ trimPaddedSceneAudio: duration=${duration}s too short for ${basename}, skipping`);
        return;
    }

    const quietest = await ffmpeg.findQuietestPoint(filePath, 0.40, 0.60);
    let cutTime = (quietest > 0.3) ? quietest : (duration / 2);
    const safetyMargin = 0.10;
    cutTime = Math.min(cutTime + safetyMargin, duration * 0.55);
    const method = (quietest > 0.3) ? `quietest@${quietest.toFixed(2)}s+${(safetyMargin*1000).toFixed(0)}ms` : 'half-duration';
    helpers.log(`✂️ trimPaddedSceneAudio: total=${duration.toFixed(2)}s, ${method} cut at ${cutTime.toFixed(2)}s for ${basename}`);

    const tempPath = filePath + '.trim.mp3';
    const ok = await ffmpeg.cutFirstHalf(filePath, tempPath, cutTime);
    if (ok) {
        try {
            fs.renameSync(tempPath, filePath);
            helpers.log(`✅ trimPaddedSceneAudio: trimmed ${basename} → kept first ${cutTime.toFixed(1)}s`);
        } catch (e) {
            helpers.log(`⚠️ trimPaddedSceneAudio: rename failed for ${basename}: ${e.message}`);
        }
    } else {
        helpers.log(`⚠️ trimPaddedSceneAudio: ffmpeg cut failed for ${basename}, file unchanged`);
    }
}

async function generateSceneAudio(redis, sceneData, loadedBook, buildId, bookId) {
    const chapterId = sceneData.chapter_id;
    const sceneId = sceneData.scene_id;

    const sceneLockKey = `animastor:audio-scene-lock:${bookId}:${chapterId}:${sceneId}`;
    const lockAcquired = await redis.set(sceneLockKey, buildId, 'NX', 'EX', 600);
    if (!lockAcquired) {
        helpers.log(`Audio orchestration already in progress: ${bookId}/${chapterId}/${sceneId}`);
        return { generated: false, reason: 'locked' };
    }

    const segList = segments.buildSegments(sceneData);
    const expectedChunkCount = segList.length;

    let isReady = await validation.isSceneAudioReady(buildId, bookId, chapterId, sceneId);
    if (isReady) {
        try {
            const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
            const asset = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'audio', buildId);
            if (asset && asset.status === 'placeholder') {
                helpers.log(`Audio is placeholder — will regenerate real audio: ${bookId}/${chapterId}/${sceneId}`);
                isReady = false;
            }
        } catch (err) {
            helpers.warn(`Failed to check audio status: ${err.message}`);
            isReady = false;
        }
    }
    if (isReady) {
        helpers.log(`Audio already ready, no generation needed: ${bookId}/${chapterId}/${sceneId}`);
        for (let i = 0; i < segList.length; i++) {
            const chunkIndex = i + 1;
            const id = chunks.makeChunkId(chapterId, sceneId, chunkIndex, bookId);
            const chunkKey = `animastor:chunk:${id}`;
            const existingChunk = await redis.get(chunkKey);
            if (existingChunk) {
                const segment = segList[i];
                const existing = JSON.parse(existingChunk);
                existing.padded_text = segment.padded || false;
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
        await redis.del(sceneLockKey);
        return { generated: false, reason: 'already_ready' };
    }

    for (let i = 0; i < segList.length; i++) {
        const chunkIndex = i + 1;
        const id = chunks.makeChunkId(chapterId, sceneId, chunkIndex, bookId);

        const chunkFilePath = chunks.getChunkAudioPath(buildId, bookId, chapterId, sceneId, chunkIndex);
        const chunkFileExists = fs.existsSync(chunkFilePath);

        const chunkKey = `animastor:chunk:${id}`;
        const existingChunk = await redis.get(chunkKey);
        if (existingChunk) {
            const segment = segList[i];
            const existing = JSON.parse(existingChunk);
            existing.padded_text = segment.padded || false;
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
                audio: chunkFileExists,
                audio_status: chunkFileExists ? 'ready' : 'pending',
                padded_text: segment.padded || false
            };
            await redis.set(chunkKey, JSON.stringify(chunkData));
            await redis.sadd(`animastor:chunks:${bookId}`, id);
        }

        if (chunkFileExists) {
            helpers.log(`AUDIO CHUNK CACHE HIT (disk): ${id}`);
            continue;
        }

        const segment = segList[i];
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

            const voiceFor = (id) => loadedBook?.voices?.[id]?.instruction
                || loadedBook?.characters?.find(x => x.id === id)?.voice?.instruction
                || "";

            if (connector) {
                const cl = require('../workflows/connector-loader');
                const v1 = voiceFor(c1?.id);
                if (v1) cl.setValue(wfAudio, connector, 'character1Voice', v1);
                const v2 = voiceFor(c2?.id);
                if (v2) cl.setValue(wfAudio, connector, 'character2Voice', v2);
                cl.setValue(wfAudio, connector, 'roleName1', c1?.id || "role1");
                cl.setValue(wfAudio, connector, 'roleName2', c2?.id || "role2");
            } else {
                const v1 = voiceFor(c1?.id);
                if (v1) wfAudio["71"].inputs.voice_instruction = v1;
                const v2 = voiceFor(c2?.id);
                if (v2) wfAudio["80"].inputs.voice_instruction = v2;
                wfAudio["74"].inputs.role_name_1 = c1?.id || "role1";
                wfAudio["74"].inputs.role_name_2 = c2?.id || "role2";
            }
        } else {
            const connector = wfLoader.getConnector(workflowName);
            if (connector) {
                const cl = require('../workflows/connector-loader');
                cl.setValue(wfAudio, connector, 'narrationText', segment.text);
                const vi = segments.narratorVoice(sceneData.payload, loadedBook);
                if (vi) {
                    cl.setValue(wfAudio, connector, 'voiceInstruction', vi);
                }
            } else {
                wfAudio["108"].inputs.text = segment.text;
                const vi = segments.narratorVoice(sceneData.payload, loadedBook);
                if (vi) {
                    wfAudio["108"].inputs.voice_instruction = vi;
                }
            }
        }

        await gpu.send(`${id}:audio`, wfAudio, "audio", buildId);
        helpers.log(`Audio TTS submitted: ${id} (${segment.segment_type})`);
    }

    await redis.del(sceneLockKey);
    helpers.log(`Audio orchestration lock released: ${bookId}/${chapterId}/${sceneId}`);

    return { generated: true, expectedChunkCount };
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
    WORKFLOW_NARRATION,
    WORKFLOW_DIALOGUE,
};
