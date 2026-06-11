const config = require('../config/runtime-config');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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

function findSceneVideoGroups(buildId, bookId, chapterId, sceneId) {
    const dir = getOutputPath(buildId);
    if (!fs.existsSync(dir)) return [];
    const prefix = `${bookId}_${chapterId}_${sceneId}`;
    const mainPath = path.join(dir, `${prefix}.mp4`);
    if (!fs.existsSync(mainPath)) return [];

    const files = fs.readdirSync(dir).filter(f =>
        f.startsWith(prefix) && f.endsWith('.mp4') && !f.endsWith('.mp4.mp4')
    );
    files.sort();

    return files.map(f => path.join(dir, f));
}

async function mergeSceneVideoGroups(redis, buildId, bookId, chapterId, sceneId) {
    const lockKey = `animastor:video-merge-lock:${bookId}:${chapterId}:${sceneId}`;
    const lock = await redis.set(lockKey, buildId, 'NX', 'EX', 300);
    if (!lock) {
        log(`Merge already in progress: ${bookId}/${chapterId}/${sceneId}`);
        return null;
    }
    try {
        const files = findSceneVideoGroups(buildId, bookId, chapterId, sceneId);
        if (files.length <= 1) {
            log(`Nothing to merge for ${bookId}/${chapterId}/${sceneId} (${files.length} file(s))`);
            return null;
        }

        const finalPath = path.join(getOutputPath(buildId), `${bookId}_${chapterId}_${sceneId}.mp4`);
        const tempPath = finalPath + '.merge.mp4';

        log(`Merging ${files.length} video groups for ${bookId}/${chapterId}/${sceneId}`);
        const result = await concatVideos(files, tempPath);
        if (!result) return null;

        fs.renameSync(tempPath, finalPath);

        for (const f of files) {
            if (f !== finalPath) {
                try { fs.unlinkSync(f); } catch {}
            }
        }

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
