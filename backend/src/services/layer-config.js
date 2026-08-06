// ======================================================
// Layer Config Service
// ======================================================
// Persists per-book defaults for initial/bulk generation:
//   - audio_enabled:  base layer, always true (audio is the story narration)
//   - image_enabled:  storyboard / IU images
//   - video_enabled:  full video composition (requires image_enabled to be true)
//
// Storage:
//   Redis key: animastor:layer-config:<bookId>
//   Value:     JSON { audio_enabled, image_enabled, video_enabled, updated_at }
//
// Used by:
//   - POST /api/v1/generate                  (multipart, on book import)
//   - POST /api/v1/book/:bookId/regenerate   (in-place regeneration)
//   - GET  /api/v1/book/:bookId/layer-config (read)
//   - PUT  /api/v1/book/:bookId/layer-config (write)
//   - GET  /api/v1/book/:bookId/assets-state (derived: which layers have content)

const SCOPES = Object.freeze({
    CURRENT_SCENE:      'current_scene',
    CURRENT_CHAPTER:    'current_chapter',
    FROM_CURRENT_SCENE: 'from_current_scene',
    WHOLE_BOOK:         'whole_book',
});

const KEY_PREFIX = 'animastor:layer-config:';
const key = (bookId) => `${KEY_PREFIX}${bookId}`;

const DEFAULTS = Object.freeze({
    audio_enabled: true,
    image_enabled: true,
    video_enabled: true,

    // VBook AI agent: how many scenes to generate per pass (1-5, default 3)
    chunk_size: 3,

    // Per-worker generation timeouts (minutes). Controls GPU_TIMEOUT_MS.
    // Used by dispatch-engine to set per-type timeout for gpu-hub tasks.
    audio_timeout_minutes: 30,
    image_timeout_minutes: 30,
    video_timeout_minutes: 60,
});

function normalize(raw) {
    if (!raw) return { ...DEFAULTS };
    let obj = raw;
    if (typeof raw === 'string') {
        try { obj = JSON.parse(raw); } catch { obj = {}; }
    }
    return {
        audio_enabled: obj.audio_enabled !== false,
        image_enabled: obj.image_enabled !== false,
        video_enabled: obj.video_enabled !== false,

        chunk_size: _clampInt(obj.chunk_size, 1, 5, DEFAULTS.chunk_size),

        audio_timeout_minutes: _clampInt(obj.audio_timeout_minutes, 5, 120, DEFAULTS.audio_timeout_minutes),
        image_timeout_minutes: _clampInt(obj.image_timeout_minutes, 5, 120, DEFAULTS.image_timeout_minutes),
        video_timeout_minutes: _clampInt(obj.video_timeout_minutes, 10, 180, DEFAULTS.video_timeout_minutes),
    };
}

function _clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

async function get(redis, bookId) {
    if (!redis || !bookId) return { ...DEFAULTS };
    const raw = await redis.get(key(bookId));
    return normalize(raw);
}

async function set(redis, bookId, partial) {
    if (!redis || !bookId) return { ...DEFAULTS };
    const current = await get(redis, bookId);
    const next = {
        audio_enabled: partial.audio_enabled !== undefined ? !!partial.audio_enabled : current.audio_enabled,
        image_enabled: partial.image_enabled !== undefined ? !!partial.image_enabled : current.image_enabled,
        video_enabled: partial.video_enabled !== undefined ? !!partial.video_enabled : current.video_enabled,

        chunk_size: partial.chunk_size !== undefined
            ? _clampInt(partial.chunk_size, 1, 5, current.chunk_size)
            : current.chunk_size,

        audio_timeout_minutes: partial.audio_timeout_minutes !== undefined
            ? _clampInt(partial.audio_timeout_minutes, 5, 120, current.audio_timeout_minutes)
            : current.audio_timeout_minutes,

        image_timeout_minutes: partial.image_timeout_minutes !== undefined
            ? _clampInt(partial.image_timeout_minutes, 5, 120, current.image_timeout_minutes)
            : current.image_timeout_minutes,

        video_timeout_minutes: partial.video_timeout_minutes !== undefined
            ? _clampInt(partial.video_timeout_minutes, 10, 180, current.video_timeout_minutes)
            : current.video_timeout_minutes,
    };
    await redis.set(key(bookId), JSON.stringify(next));
    return next;
}

function isValidScope(value) {
    return Object.values(SCOPES).includes(value);
}

/**
 * Per-book VBook window size (scenes per pass) — the effective chunk size the
 * AI pipeline actually uses. Reads layer-config chunk_size (1..5) and falls
 * back to MAX_SCENES_PER_CHUNK when unset/unavailable. Single source of truth
 * shared by bootstrap._readChunkSize (what the pipeline processes) and the
 * /agent-status route (what the frontend progress counter displays) so the two
 * can never drift apart.
 */
async function getChunkSize(redis, bookId) {
    const { MAX_SCENES_PER_CHUNK } = require('../agent-prompts');
    try {
        if (redis && bookId) {
            const cfg = await get(redis, bookId);
            if (cfg && cfg.chunk_size >= 1 && cfg.chunk_size <= 5) {
                return cfg.chunk_size;
            }
        }
    } catch (_) { /* best-effort */ }
    return MAX_SCENES_PER_CHUNK;
}

module.exports = {
    SCOPES,
    DEFAULTS,
    key,
    get,
    set,
    normalize,
    isValidScope,
    getChunkSize,
};
