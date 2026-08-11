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

        log(`Merging ${files.length} video groups for ${bookId}/${chapterId}/${sceneId}`);
        const result = await concatVideos(files, tempPath);
        if (!result) return null;

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
