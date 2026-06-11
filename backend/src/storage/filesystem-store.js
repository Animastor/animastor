// ======================================================
// Filesystem Store - v1.0.0
// ======================================================
// Storage layer - file system operations for media assets.

const path = require('path');
const fs = require('fs');
const config = require('../config/runtime-config');

// ======================================================
// LOGGING
// ======================================================
const logPrefix = '[STORAGE]';
const fsLogPrefix = '[FS]';

function log(msg) {
    console.log(`${logPrefix} ${fsLogPrefix} ${msg}`);
}

// ======================================================
// CANONICAL PATH HELPERS
// ======================================================

// Form canonical scene audio filename: bookId_chapterId_sceneId.mp3
function makeSceneAudioFilename(bookId, chapterId, sceneId) {
    return `${bookId}_${chapterId}_${sceneId}.mp3`;
}

// Form chunk audio filename: bookId_chapterId_sceneId_chunk.mp3
function makeChunkAudioFilename(bookId, chapterId, sceneId, chunkIndex) {
    return `${bookId}_${chapterId}_${sceneId}_${chunkIndex}.mp3`;
}

// Form chunk image filename: bookId_chapterId_sceneId_chunk.png
function makeChunkImageFilename(bookId, chapterId, sceneId, chunkIndex) {
    return `${bookId}_${chapterId}_${sceneId}_${chunkIndex}.png`;
}

// Form IU image filename: bookId_chapterId_sceneId_iu*.png
function makeIUImageFilename(bookId, chapterId, sceneId, iuId) {
    return `${bookId}_${chapterId}_${sceneId}_iu${iuId}.png`;
}

// Form preview thumbnail filename: bookId_chapterId_sceneId_pr*.png
function makePreviewFilename(bookId, chapterId, sceneId, iuId) {
    return `${bookId}_${chapterId}_${sceneId}_pr${iuId}.png`;
}

// ======================================================
// PATH BUILDERS
// ======================================================

/**
 * Get full path to canonical scene audio file.
 */
function getSceneAudioPath(OUTPUT_DIR, buildId, bookId, chapterId, sceneId) {
    const filename = makeSceneAudioFilename(bookId, chapterId, sceneId);
    return path.join(OUTPUT_DIR, buildId, filename);
}

/**
 * Get full path to temporary chunk audio file.
 */
function getChunkAudioPath(OUTPUT_DIR, buildId, bookId, chapterId, sceneId, chunkIndex) {
    const filename = makeChunkAudioFilename(bookId, chapterId, sceneId, chunkIndex);
    return path.join(OUTPUT_DIR, buildId, filename);
}

/**
 * Get full path to canonical scene video file.
 */
function getSceneVideoPath(OUTPUT_DIR, buildId, bookId, chapterId, sceneId) {
    const filename = `${bookId}_${chapterId}_${sceneId}.mp4`;
    return path.join(OUTPUT_DIR, buildId, filename);
}

/**
 * Get full path to canonical scene image (IU image).
 */
function getSceneImage(OUTPUT_DIR, buildId, bookId, chapterId, sceneId) {
    // Scans for IU images using resolveCanonicalSceneImage
    return null; // Handled by resolveCanonicalSceneImage
}

// ======================================================
// FILE OPERATIONS
// ======================================================

/**
 * Save base64 data to file.
 */
// Save file atomically (write to temp file then rename)
function saveFile(base64Data, filePath) {
    const clean = base64Data.includes(",") ? base64Data.split(",")[1] : base64Data
    const buffer = Buffer.from(clean, "base64")
    const tmpPath = filePath + '.tmp';

    // Remove temp file if it exists (from a previous failed write)
    if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
    }

    try {
        // Write to temp file
        fs.writeFileSync(tmpPath, buffer);
        // Atomically rename (replace destination file)
        fs.renameSync(tmpPath, filePath);
        log(`saved: ${filePath}`);
        return true;
    } catch (err) {
        console.error(`${logPrefix} ${fsLogPrefix} saveFile error:`, err.message);
        // Clean up temp file if write failed
        if (fs.existsSync(tmpPath)) {
            try {
                fs.unlinkSync(tmpPath);
            } catch (unlinkErr) {
                console.error(`${logPrefix} ${fsLogPrefix} Error cleaning up temp file after write failure:`, tmpPath, unlinkErr.message);
            }
        }
        return false;
    }
}

/**
 * Read file as base64 with size validation and retry capability.
 * Returns null if file doesn't exist, is empty,Too large, or read fails.
 */
function safeReadBase64(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
            console.warn(`${logPrefix} ${fsLogPrefix} File is empty: ${filePath}`);
            return null;
        }
        // File size checks (protect against OOM)
        const maxSizeBytes = 100 * 1024 * 1024; // 100 MB
        const criticalSizeBytes = 500 * 1024 * 1024; // 500 MB
        const hardStopSizeBytes = 1 * 1024 * 1024 * 1024; // 1 GB

        if (stats.size > hardStopSizeBytes) {
            console.error(`${logPrefix} ${fsLogPrefix} CRITICAL FILE SIZE HARD STOP: ${filePath} Size: ${Math.round(stats.size / (1024 * 1024 * 1024))}GB`);
            return null; // DO NOT read files this large
        } else if (stats.size > criticalSizeBytes) {
            console.error(`${logPrefix} ${fsLogPrefix} CRITICAL FILE SIZE WARNING: ${filePath} Size: ${Math.round(stats.size / (1024 * 1024))}MB`);
        } else if (stats.size > maxSizeBytes) {
            console.warn(`${logPrefix} ${fsLogPrefix} File is very large, potential memory risk: ${filePath} Size: ${Math.round(stats.size / (1024 * 1024))}MB`);
        }

        // Read file completely
        const buffer = fs.readFileSync(filePath);
        // Verify buffer size matches file size (file didn't change during read)
        if (buffer.length !== stats.size) {
            console.warn(`${logPrefix} ${fsLogPrefix} File read incomplete or size mismatch: ${filePath}`);
            return null;
        }
        return buffer.toString("base64");
    } catch (err) {
        console.error(`${logPrefix} ${fsLogPrefix} safeReadBase64 error:`, err.message);
        return null;
    }
}

/**
 * Read file safely, returns null on error.
 */
function safeReadFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        return fs.readFileSync(filePath);
    } catch (err) {
        console.error(`${logPrefix} ${fsLogPrefix} safeReadFile error:`, err.message);
        return null;
    }
}

// ======================================================
// FILE EXISTENCE CHECKERS
// ======================================================

/**
 * Check if IU image exists for given ID.
 */
function probeIUImage(iuId, buildId, OUTPUT_DIR) {
    const dir = path.join(OUTPUT_DIR, buildId);
    try {
        if (!fs.existsSync(dir)) {
            return null;
        }
        const imgPath = path.join(dir, `${iuId}.png`);
        if (fs.existsSync(imgPath)) {
            return { image: true, path: imgPath };
        }
        return { image: false, path: null };
    } catch (err) {
        return { image: false, path: null, error: err.message };
    }
}

/**
 * Check if scene image exists for video.
 */
function probeSceneImage(buildId, bookId, chapterId, sceneId, OUTPUT_DIR) {
    const filename = `${bookId}_${chapterId}_${sceneId}.png`;
    const fullPath = path.join(OUTPUT_DIR, buildId, filename);
    return { exists: fs.existsSync(fullPath), path: fullPath };
}

// ======================================================
// CHUNK HELPERS
// ======================================================

/**
 * Find existing scene chunks from disk.
 */
function findExistingSceneChunks(bookId, chapterId, sceneId, buildId) {
    const dir = path.join(config.OUTPUT_DIR, buildId);
    const escapedBookId = escapeRegExp(bookId);
    const escapedChapterId = escapeRegExp(chapterId);
    const escapedSceneId = escapeRegExp(sceneId);
    const chunkPrefix = `${escapedBookId}_${escapedChapterId}_${escapedSceneId}_`;
    const pattern = new RegExp(`^${chunkPrefix}\\d+\\.mp3$`);

    try {
        return fs.readdirSync(dir)
            .filter(f => pattern.test(f))
            .map(f => {
                const match = f.match(chunkPrefix + '(\\d+)\\.mp3$');
                return match ? parseInt(match[1], 10) : null;
            })
            .filter(Boolean);
    } catch (err) {
        console.error(`${logPrefix} ${fsLogPrefix} findExistingSceneChunks error:`, err.message);
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

/**
 * Find all existing chunk files and return their full paths.
 * Returns array of absolute file paths.
 */
function getSceneChunkPaths(bookId, chapterId, sceneId, buildId) {
    const dir = path.join(config.OUTPUT_DIR, buildId);
    const escapedBookId = escapeRegExp(bookId);
    const escapedChapterId = escapeRegExp(chapterId);
    const escapedSceneId = escapeRegExp(sceneId);
    const chunkPrefix = `${escapedBookId}_${escapedChapterId}_${escapedSceneId}_`;
    const pattern = new RegExp(`^${chunkPrefix}\\d+\\.mp3$`);

    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => pattern.test(f))
            .map(f => path.join(dir, f))
            .sort();
    } catch (err) {
        console.error(`${logPrefix} ${fsLogPrefix} getSceneChunkPaths error:`, err.message);
        return [];
    }
}

/**
 * Ensure audio directory exists for canonical audio output.
 */
function ensureAudioDirectory(buildId) {
    const audioDir = path.join(config.OUTPUT_DIR, buildId);
    if (!fs.existsSync(audioDir)) {
        fs.mkdirSync(audioDir, { recursive: true });
    }
    return audioDir;
}

// ======================================================
// ESCAPE REGEXP HELPER
// ======================================================

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    makeSceneAudioFilename,
    makeChunkAudioFilename,
    makeChunkImageFilename,
    makeIUImageFilename,
    makePreviewFilename,
    getSceneAudioPath,
    getChunkAudioPath,
    getSceneVideoPath,
    saveFile,
    safeReadBase64,
    safeReadFile,
    probeIUImage,
    probeSceneImage,
    findExistingSceneChunks,
    getSceneChunkPaths,
    allSceneChunksExist,
    areSceneAudioChunksReady,
    ensureAudioDirectory,
    escapeRegExp
};
