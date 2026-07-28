// ======================================================
// ANIMASTOR BACKEND — SHARED HELPERS
// ======================================================
// Pure utility functions extracted from backend.cjs.
// These have NO dependency on `redis`, `app`, or backend.cjs internal state.

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

// ── Scene collector ───────────────────────────────────

function collectScenes(book) {
    const runtime = [];
    const chapters = book.chapters || [];
    for (let chIndex = 0; chIndex < chapters.length; chIndex++) {
        const ch = chapters[chIndex];
        const canonicalChapterId = ch.chapter_id;
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

module.exports = {
    log,
    collectScenes,
};
