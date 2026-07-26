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
    };
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
    };
    await redis.set(key(bookId), JSON.stringify(next));
    return next;
}

function isValidScope(value) {
    return Object.values(SCOPES).includes(value);
}

module.exports = {
    SCOPES,
    DEFAULTS,
    key,
    get,
    set,
    normalize,
    isValidScope,
};
