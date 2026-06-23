// ======================================================
// ANIMASTOR BACKEND — SHARED HELPERS
// ======================================================
// Pure utility functions extracted from backend.cjs.
// These have NO dependency on `redis`, `app`, or backend.cjs internal state.
//
// Usage:
//   const { log, pad, parseChunkId } = require('./helpers/utils.cjs');

const path = require('path');

// ── Logging ───────────────────────────────────────────

function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

function pad(n) {
    return String(n).padStart(4, '0');
}

// ── Chunk ID parsing ──────────────────────────────────

function parseChunkId(chunkId) {
    const parts = chunkId.split('_');
    if (parts.length < 4) {
        console.error('❌ Invalid chunk ID (too few parts):', chunkId);
        return null;
    }
    const chunkIndex = parts.pop();
    const sceneId = parts.pop();
    const chapterId = parts.pop();
    const bookId = parts.join('_');
    return { bookId, chapterId, sceneId, chunkIndex };
}

// ── Safe build path ───────────────────────────────────

function safeBuildPath(buildId) {
    if (!buildId || buildId === '.' || buildId === '..') {
        console.error('⚠️ Invalid buildId (empty, ., ..):', buildId);
        return null;
    }
    if (buildId.includes('/') || buildId.includes('\\\\')) {
        console.error('⚠️ buildId contains path separators:', buildId);
        return null;
    }
    const regex = /^[a-zA-Z0-9._-]+$/;
    if (!regex.test(buildId)) {
        console.error('⚠️ buildId fails regex validation:', buildId);
        return null;
    }
    const safeId = path.basename(buildId);
    return safeId;
}

function safeBuildPathAbsolute(buildId, outputDir) {
    if (!buildId || buildId === '.' || buildId === '..') return null;
    if (buildId.includes('/') || buildId.includes('\\\\')) return null;
    const regex = /^[a-zA-Z0-9._-]+$/;
    if (!regex.test(buildId)) return null;
    const safeId = path.basename(buildId);
    const fullPath = path.resolve(outputDir, safeId);
    const outputDirResolved = path.resolve(outputDir);
    const relative = path.relative(outputDirResolved, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    if (fullPath === outputDirResolved) return null;
    return fullPath;
}

// ── Scene collector ───────────────────────────────────

function collectScenes(book) {
    const runtime = [];
    const chapters = book.chapters || [];
    for (let chIndex = 0; chIndex < chapters.length; chIndex++) {
        const ch = chapters[chIndex];
        const canonicalChapterId = ch.chapter;
        for (let scIndex = 0; scIndex < (ch.scenes || []).length; scIndex++) {
            const scene = ch.scenes[scIndex];
            runtime.push({
                runtime_type: 'scene',
                chapter_id: canonicalChapterId,
                scene_id: scene.scene_id,
                scene_type: scene.type || 'narration',
                location: scene.location || null,
                participants: scene.participants || [],
                chapter: ch,
                scene,
                sceneIndex: scIndex,
                scene_order: runtime.length + 1,
                payload: scene,
            });
        }
    }
    return runtime;
}

// ── Text chunking ─────────────────────────────────────

function splitTextIntoChunks(text, maxChars = 500) {
    if (!text?.trim()) return [];
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
        const test = current ? current + ' ' + sentence : sentence;
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
    text = text.replace(/\r/g, '').trim();
    const lines = text.match(/[a-z0-9_]+:\s.*?(?=\n[a-z0-9_]+:|$)/gis) || [text];
    const chunks = [];
    let current = '';
    for (const rawLine of lines) {
        const line = rawLine.trim();
        const test = current ? current + '\n' + line : line;
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

// ── Segments builder ──────────────────────────────────

function buildSegments(runtimeEntry) {
    if (runtimeEntry.runtime_type === 'scene' && runtimeEntry.scene_type === 'narration') {
        const fullText = runtimeEntry.payload?.audio?.full_text || '';
        const chunks = splitTextIntoChunks(fullText);
        return chunks.map((text, i) => ({
            segment_id: String(i + 1).padStart(4, '0'),
            segment_type: 'narration',
            text,
        }));
    }
    if (runtimeEntry.runtime_type === 'scene' && runtimeEntry.scene_type === 'dialogue') {
        const fullText = runtimeEntry.payload?.audio?.full_text || '';
        const chunks = splitDialogueIntoChunks(fullText);
        return chunks.map((text, i) => ({
            segment_id: String(i + 1).padStart(4, '0'),
            segment_type: 'dialogue',
            text,
        }));
    }
    return [];
}

// ── Asset path resolution ────────────────────────────

function resolveAssetPath(job_id, buildId, outputDir) {
    if (!job_id || !buildId) return null;
    const dir = outputDir || '/data/output';
    const outputPath = path.join(dir, buildId);

    if (job_id.endsWith(':audio')) {
        const assetId = job_id.replace(/:audio$/, '');
        return { type: 'audio_chunk', extension: 'mp3', fullPath: path.join(outputPath, `${assetId}.mp3`) };
    }
    if (job_id.endsWith(':video')) {
        let assetId = job_id.replace(/:video$/, '');
        const groupMatch = assetId.match(/^(.+?)(_g\d+)$/);
        const groupSuffix = groupMatch ? groupMatch[2] : '';
        if (groupMatch) assetId = groupMatch[1];
        return { type: 'scene_video', extension: 'mp4', fullPath: path.join(outputPath, `${assetId}${groupSuffix}.mp4`) };
    }
    if (job_id.endsWith(':image')) {
        const assetId = job_id.replace(/:image$/, '');
        if (assetId.includes('_iu')) {
            return { type: 'iu_image', extension: 'png', fullPath: path.join(outputPath, `${assetId}.png`) };
        }
        return { type: 'scene_image', extension: 'png', fullPath: path.join(outputPath, `${assetId}.png`) };
    }
    return null;
}

// ── Scene lookup ──────────────────────────────────────

function findSceneRuntimeData(loadedBook, chapterId, sceneId) {
    const chapters = loadedBook.chapters || [];
    for (const ch of chapters) {
        if (ch.chapter === chapterId) {
            const scenes = ch.scenes || [];
            for (const sc of scenes) {
                if (sc.scene_id === sceneId) {
                    return {
                        runtime_type: 'scene',
                        chapter_id: ch.chapter,
                        scene_id: sc.scene_id,
                        scene_type: sc.type || 'narration',
                        location: sc.location || null,
                        participants: sc.participants || [],
                        chapter: ch,
                        scene: sc,
                        payload: sc,
                    };
                }
            }
        }
    }
    return null;
}

module.exports = {
    log,
    pad,
    parseChunkId,
    safeBuildPath,
    collectScenes,
    splitTextIntoChunks,
    splitDialogueIntoChunks,
    buildSegments,
    findSceneRuntimeData,
};
