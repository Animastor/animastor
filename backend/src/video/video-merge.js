const config = require('../config/runtime-config');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const videoTimeline = require('./video-timeline');

// Alignment constants — MUST mirror video-workflows.js (calculateFrames):
const ALIGN_FPS = parseInt(process.env.VIDEO_FPS || '24', 10);
const ALIGN_MIN_IU_DURATION = 1.0;
const MIN_VIDEO_BYTES = 10240;

function getOutputPath(...parts) {
    return path.join(config.OUTPUT_DIR, ...parts.filter(Boolean));
}

const logPrefix = '[VIDEO-MERGE]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

async function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.stdout.on('data', () => {});
        proc.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        });
        proc.on('error', reject);
    });
}

function createConcatFile(filePaths) {
    const content = filePaths.map(f => `file '${f}'`).join('\n');
    const concatPath = path.join('/tmp', `vconcat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(concatPath, content);
    return concatPath;
}

async function concatVideos(inputPaths, outputPath) {
    if (inputPaths.length === 0) return null;
    if (inputPaths.length === 1) {
        fs.copyFileSync(inputPaths[0], outputPath);
        return outputPath;
    }

    const concatFile = createConcatFile(inputPaths);
    try {
        await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', outputPath, '-y']);
        log(`Merged ${inputPaths.length} videos → ${path.basename(outputPath)}`);
        return outputPath;
    } finally {
        try { fs.unlinkSync(concatFile); } catch {}
    }
}

/** Load the scene's units (order + audio durations) from image_units so the
 *  merge can align the video timeline to the audio/start_ms timeline. */
async function loadSceneUnitDurations(buildId, bookId, chapterId, sceneId) {
    try {
        const iuRepo = require('../storage/postgres/repositories/iu-repo');
        const rows = await iuRepo.getImageUnitsForScene(buildId, bookId, chapterId, sceneId);
        if (!rows || rows.length === 0) return null;
        const sorted = [...rows].sort((a, b) => (a.scene_order || 0) - (b.scene_order || 0));
        return sorted.map(r => {
            const est = r.estimated_duration_sec && r.estimated_duration_sec > 0 ? r.estimated_duration_sec : null;
            const real = r.start_ms != null && r.end_ms != null ? (r.end_ms - r.start_ms) / 1000 : null;
            return est || real || ALIGN_MIN_IU_DURATION;
        });
    } catch (err) {
        warn(`loadSceneUnitDurations failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        return null;
    }
}

/** Trim a video to exactly `targetFrames` frames with `-c copy` (frame-exact,
 *  no re-encode). Returns the trimmed path, or the original when no trim is
 *  needed (target missing / target >= actual frames). */
async function trimVideoToFrames(filePath, targetFrames) {
    if (!targetFrames || targetFrames <= 0) return filePath;
    const actual = await countVideoFrames(filePath);
    if (actual == null || targetFrames >= actual) return filePath;
    const trimmed = filePath + '.trim.mp4';
    try {
        await runFFmpeg(['-y', '-i', filePath, '-c', 'copy', '-frames:v', String(targetFrames), trimmed, '-loglevel', 'error']);
        if (fs.existsSync(trimmed) && fs.statSync(trimmed).size >= MIN_VIDEO_BYTES) return trimmed;
        try { fs.unlinkSync(trimmed); } catch {}
        return filePath;
    } catch (err) {
        warn(`trimVideoToFrames failed for ${path.basename(filePath)}: ${err.message}`);
        try { fs.unlinkSync(trimmed); } catch {}
        return filePath;
    }
}function countVideoFrames(filePath) {
    return new Promise(resolve => {
        const proc = spawn('ffprobe', [
            '-v', 'error', '-count_frames', '-select_streams', 'v:0',
            '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', filePath,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('error', () => resolve(null));
        proc.on('close', () => {
            const v = parseInt(out.trim(), 10);
            resolve(Number.isFinite(v) && v > 0 ? v : null);
        });
    });

}

/** Probe every video frame's PTS (seconds, in display order). */
function probeFramePtsSec(filePath) {
    return new Promise(resolve => {
        const proc = spawn('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', filePath,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('error', () => resolve(null));
        proc.on('close', () => {
            const pts = out.split(/\r?\n/).map(s => parseFloat(s.trim())).filter(Number.isFinite);
            resolve(pts.length > 0 ? pts : null);
        });
    });
}

/** Re-encode a video, forcing an IDR keyframe at the LAST frame at-or-before
 *  each unit boundary (cumulative unit durations in seconds). Returns true on
 *  success. Rationale: Android MediaPlayer.seekTo is keyframe-aligned — it
 *  decodes from the nearest keyframe AT-OR-BEFORE the target. The merged video
 *  is VFR with cumulative PTS drift (concat of trimmed clips), so time-based
 *  -force_key_frames lands one frame after the boundary and the seek skips to
 *  the previous unit's keyframe (the "one-unit shift": N-th unit → N-1-th
 *  unit content). Forcing the keyframe on the last frame at-or-before the
 *  boundary makes the seek land within one frame of the unit start (the frame
 *  right at the transition — imperceptible). Frame count is preserved
 *  (passthrough fps mode); only the stream is re-encoded (crf 18, veryfast).
 *  Audio (if any) is copied. */
async function forceKeyframesAtUnitBoundaries(videoPath, buildId, bookId, chapterId, sceneId) {
    try {
        const durations = await loadSceneUnitDurations(buildId, bookId, chapterId, sceneId);
        if (!durations || durations.length <= 1) return true; // single unit — keyframe at 0 exists

        const framePts = await probeFramePtsSec(videoPath);
        if (!framePts || framePts.length === 0) return false;

        // Unit boundary times (seconds) = cumulative durations (audio timeline,
        // which the merged video is aligned to by alignGroupClips).
        const boundaries = [];
        let acc = 0;
        for (let i = 0; i < durations.length - 1; i++) {
            acc += durations[i];
            boundaries.push(acc);
        }
        if (boundaries.length === 0) return true;

        // For each boundary, find the index of the LAST frame with PTS <= it
        // (frame indices are stable under re-encode: -fps_mode passthrough
        // preserves the frame count exactly).
        const indices = [];
        for (const b of boundaries) {
            let idx = -1;
            for (let i = 0; i < framePts.length; i++) {
                if (framePts[i] <= b + 1e-6) idx = i;
                else break;
            }
            if (idx > 0 && !indices.includes(idx)) indices.push(idx);
        }
        if (indices.length === 0) return true;

        const expr = 'expr:' + indices.map(i => `eq(n,${i})`).join('+');
        const tmp = videoPath + '.kf.mp4';
        await runFFmpeg([
            '-y', '-i', videoPath,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
            '-force_key_frames', expr,
            '-fps_mode', 'passthrough',
            '-c:a', 'copy',
            tmp, '-loglevel', 'error',
        ]);
        if (fs.existsSync(tmp) && fs.statSync(tmp).size >= MIN_VIDEO_BYTES) {
            fs.renameSync(tmp, videoPath);
            log(`Forced keyframes at frames [${indices.join(', ')}] (unit boundaries ${boundaries.map(b => b.toFixed(3)).join(', ')}s)`);
            return true;
        }
        try { fs.unlinkSync(tmp); } catch {}
        return false;
    } catch (err) {
        warn(`forceKeyframesAtUnitBoundaries failed: ${err.message}`);
        try { fs.unlinkSync(videoPath + '.kf.mp4'); } catch {}
        return false;
    }
}

/** Trim every group clip to its exact audio-duration frame count so the merged
 *  scene video's timeline equals the audio/start_ms timeline (removes the
 *  8n+1 alignment tax per group). Returns the trimmed file list (original
 *  files untouched). Degrades gracefully — on any failure returns originals. */
async function alignGroupClips(files, buildId, bookId, chapterId, sceneId) {
    try {
        const durations = await loadSceneUnitDurations(buildId, bookId, chapterId, sceneId);
        if (!durations) return files;

        const rawFrames = durations.map(d => Math.max(
            Math.round(ALIGN_MIN_IU_DURATION * ALIGN_FPS), Math.round(d * ALIGN_FPS)
        ));

        const groupSec = [];
        for (const f of files) {
            const dur = await videoTimeline.probeVideoDurationSec(f);
            if (dur == null) return files;
            groupSec.push(dur);
        }
        const targets = videoTimeline.computeGroupTargetFrames(rawFrames, groupSec, ALIGN_FPS);
        if (targets.length !== files.length) return files;

        const trimmed = [];
        for (let i = 0; i < files.length; i++) {
            trimmed.push(await trimVideoToFrames(files[i], targets[i]));
        }
        log(`Aligned ${files.length} group clip(s) to the audio timeline for ${bookId}/${chapterId}/${sceneId}`);
        return trimmed;
    } catch (err) {
        warn(`alignGroupClips failed for ${bookId}/${chapterId}/${sceneId}: ${err.message} — merging untrimmed`);
        return files;
    }
}

// Собирает файлы видео-групп для указанной сцены в порядке генерации.
// Группы именуются `{prefix}_gN.mp4` (N>=1). Базовый `{prefix}.mp4` —
// результат склейки, в список групп не входит.
function findSceneVideoGroups(buildId, bookId, chapterId, sceneId, suffixes = null) {
    const dir = getOutputPath(buildId);
    if (!fs.existsSync(dir)) return [];
    const prefix = `${bookId}_${chapterId}_${sceneId}`;

    let files;
    if (Array.isArray(suffixes) && suffixes.length > 0) {
        // Явный порядок из video-orchestrator (источник истины — state machine,
        // не порядок readdir): группы, переданные в правильном порядке.
        files = suffixes.map(s => {
            const name = `${prefix}${s || ''}.mp4`;
            return fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null;
        }).filter(Boolean);
    } else {
        // Fallback: сканируем диск. Сортируем по номеру группы численно
        // (лексикографически _g10 < _g2), базовый файл исключаем.
        files = fs.readdirSync(dir)
            .filter(f => f.startsWith(prefix) && f.endsWith('.mp4') && f !== `${prefix}.mp4` && !f.endsWith('.mp4.mp4'))
            .sort((a, b) => {
                const na = parseInt((a.match(/_g(\d+)/) || [0, 0])[1], 10);
                const nb = parseInt((b.match(/_g(\d+)/) || [0, 0])[1], 10);
                return na - nb;
            })
            .map(f => path.join(dir, f));
    }

    return files;
}

// Склеивает видео-группы сцены в единый `{prefix}.mp4` для плеера.
// Групповые файлы `_gN.mp4` НЕ удаляются — они остаются отдельными
// чанками для точечной dirty-регенерации и экспорта.
// При одном файле — просто копирует его в финальный путь.
async function mergeSceneVideoGroups(redis, buildId, bookId, chapterId, sceneId, suffixes = null) {
    const lockKey = `animastor:video-merge-lock:${bookId}:${chapterId}:${sceneId}`;
    const lock = await redis.set(lockKey, buildId, 'NX', 'EX', 300);
    if (!lock) {
        log(`Merge already in progress: ${bookId}/${chapterId}/${sceneId}`);
        return null;
    }
    try {
        const files = findSceneVideoGroups(buildId, bookId, chapterId, sceneId, suffixes);
        log(`mergeSceneVideoGroups: scene=${bookId}/${chapterId}/${sceneId} suffixes=[${(suffixes || []).join(',')}] files=[${files.map(f => path.basename(f)).join(', ')}]`);
        if (files.length === 0) {
            log(`Nothing to merge for ${bookId}/${chapterId}/${sceneId} (no group files)`);
            return null;
        }

        const finalPath = path.join(getOutputPath(buildId), `${bookId}_${chapterId}_${sceneId}.mp4`);

        if (files.length === 1) {
            fs.copyFileSync(files[0], finalPath);
            log(`Single group copied: ${bookId}/${chapterId}/${sceneId} → ${path.basename(finalPath)}`);
            return finalPath;
        }

        const tempPath = finalPath + '.merge.mp4';

        // Align each group clip to the audio timeline before concat so the
        // merged video's unit boundaries match start_ms (see video-timeline.js).
        const alignedFiles = await alignGroupClips(files, buildId, bookId, chapterId, sceneId);
        log(`Merging ${alignedFiles.length} video groups for ${bookId}/${chapterId}/${sceneId}`);
        const result = await concatVideos(alignedFiles, tempPath);
        if (!result) return null;

        // ROOT-CAUSE FIX (unit seek landing in the previous unit): Android
        // MediaPlayer.seekTo is KEYFRAME-ALIGNED — it decodes from the nearest
        // keyframe at-or-before the target. If no keyframe sits exactly on a
        // unit boundary, a seek to that unit's start_ms lands on the previous
        // unit's last keyframe and the player shows the PREVIOUS unit's frames
        // until playback catches up (the "one-unit shift", N-th unit → N-1-th
        // unit content). Force a keyframe at every unit boundary so seekTo()
        // lands exactly on the selected unit's first frame.
        const forced = await forceKeyframesAtUnitBoundaries(tempPath, buildId, bookId, chapterId, sceneId);
        if (forced) {
            log(`Forced unit-boundary keyframes: ${bookId}/${chapterId}/${sceneId}`);
        } else {
            warn(`forceKeyframesAtUnitBoundaries failed for ${bookId}/${chapterId}/${sceneId} — seek may land one unit early`);
        }

        // Clean up trimmed intermediates (never touches the original _gN files).
        for (const f of alignedFiles) {
            if (f.endsWith('.trim.mp4')) {
                try { fs.unlinkSync(f); } catch {}
            }
        }

        fs.renameSync(tempPath, finalPath);

        // Групповые файлы сознательно сохраняются (чанки остаются отдельными).
        log(`Merge complete: ${bookId}/${chapterId}/${sceneId}`);
        return finalPath;
    } finally {
        await redis.del(lockKey);
    }
}

async function mergeBookVideos(redis, bookId, buildId, scenes) {
    const lockKey = `animastor:video-book-merge-lock:${bookId}`;
    const lock = await redis.set(lockKey, buildId, 'NX', 'EX', 600);
    if (!lock) {
        log(`Book merge already in progress: ${bookId}`);
        return null;
    }
    try {
        const inputPaths = [];
        for (const scene of scenes) {
            const scenePath = getOutputPath(buildId, `${bookId}_${scene.chapter_id}_${scene.scene_id}.mp4`);
            if (fs.existsSync(scenePath)) {
                inputPaths.push(scenePath);
            }
        }

        if (inputPaths.length <= 1) {
            log(`Nothing to merge for book ${bookId} (${inputPaths.length} scene(s))`);
            return null;
        }

        const finalPath = getOutputPath(buildId, `${bookId}.mp4`);
        const tempPath = finalPath + '.book.mp4';

        log(`Merging ${inputPaths.length} scene videos for book ${bookId}`);
        const result = await concatVideos(inputPaths, tempPath);
        if (!result) return null;

        fs.renameSync(tempPath, finalPath);
        log(`Book merge complete: ${bookId} → ${finalPath}`);
        return finalPath;
    } finally {
        await redis.del(lockKey);
    }
}

/**
 * Mux video and audio into a single MP4 file using ffmpeg.
 * If audio or video is missing, returns the existing track.
 */
async function muxVideoAudio(videoPath, audioPath, outputPath) {
    const hasVideo = videoPath && fs.existsSync(videoPath);
    const hasAudio = audioPath && fs.existsSync(audioPath);

    if (!hasVideo && !hasAudio) {
        error(`muxVideoAudio: neither video nor audio found`);
        return null;
    }

    if (!hasVideo) {
        log(`muxVideoAudio: no video, copying audio only`);
        fs.copyFileSync(audioPath, outputPath);
        return outputPath;
    }

    if (!hasAudio) {
        log(`muxVideoAudio: no audio, copying video only`);
        fs.copyFileSync(videoPath, outputPath);
        return outputPath;
    }

    await runFFmpeg([
        '-i', videoPath,
        '-i', audioPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest',
        outputPath, '-y'
    ]);
    log(`Muxed video+audio → ${path.basename(outputPath)}`);
    return outputPath;
}

module.exports = {
    mergeSceneVideoGroups,
    mergeBookVideos,
    concatVideos,
    muxVideoAudio,
};
