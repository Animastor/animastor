// ======================================================
// Prompt Profile Override
// ======================================================
// User-selected prompt profile per type (audio/image/video). The selection is
// GLOBAL (deployment-level, not per-book): the frontend Settings → Worker
// settings dropdown saves it here, and the pipeline + assembly builders honor it.
//
// Storage: in-memory cache + Redis (key 'animastor:prompt-profiles'). The cache
// is primed from Redis when the backend registers the connector routes
// (setRedis → loadFromRedis), so assembly-time reads are synchronous.
//
// Resolution:
//   override (user choice)  →  connector's profile.{type}Profile  →  null
// 'default' is a valid override: it selects ai/profiles/{type}/default.json
// and injects skills/{type}/default.md instead of the model-specific ones.

const wfLoader = require('../workflows/workflow-loader');

const REDIS_KEY = 'animastor:prompt-profiles';

// type → connector profile field + a canonical workflow to read it from.
const TYPE_FIELDS = { audio: 'audioProfile', image: 'imageProfile', video: 'videoProfile' };
const TYPE_WORKFLOWS = { image: 'img-qwen-image', video: 'video-ltx-1p', audio: 'tts-qwen-dialogue' };
const TYPES = Object.keys(TYPE_FIELDS);

let redisRef = null;
let cache = { audio: null, image: null, video: null };

/**
 * Attach the Redis client and prime the cache from Redis (best-effort async).
 * Called once when the connector routes register (backend startup).
 */
function setRedis(redis) {
    redisRef = redis || null;
    if (redisRef) {
        loadFromRedis().catch(err => {
            console.warn(`[PROFILE-OVERRIDE] Failed to prime from Redis: ${err.message}`);
        });
    }
}

/**
 * Reload the override cache from Redis.
 */
async function loadFromRedis() {
    if (!redisRef) return;
    try {
        const raw = await redisRef.get(REDIS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            cache = { audio: null, image: null, video: null, ...parsed };
        }
    } catch (err) {
        console.warn(`[PROFILE-OVERRIDE] Failed to load from Redis: ${err.message}`);
    }
}

/**
 * Current overrides (copy). Values are profile names or null (connector default).
 */
function getOverrides() {
    return { ...cache };
}

/**
 * Get the override for one type (null when not set → connector default wins).
 */
function getOverride(type) {
    return cache[type] || null;
}

/**
 * Set (or clear, with null/'') the override for one type. Persists to Redis.
 * @returns {Promise<object>} updated overrides
 */
async function setOverride(type, name) {
    const normalized = (name && String(name).trim()) || null;
    cache[type] = normalized;
    if (redisRef) {
        try {
            await redisRef.set(REDIS_KEY, JSON.stringify(cache));
        } catch (err) {
            console.warn(`[PROFILE-OVERRIDE] Failed to persist to Redis: ${err.message}`);
        }
    }
    return { ...cache };
}

/**
 * Connector-derived profile name for a type (no override applied).
 * @param {string} type — 'audio' | 'image' | 'video'
 * @returns {string|null}
 */
function connectorProfileName(type) {
    const conn = wfLoader.getConnector(TYPE_WORKFLOWS[type]);
    return conn?.profile?.[TYPE_FIELDS[type]] || null;
}

/**
 * Resolve the ACTIVE prompt profiles for the agent pipeline (skill injection).
 * User override wins; otherwise the connector's profile; finally 'default'.
 * @returns {{ audioProfile: string, imageProfile: string, videoProfile: string }}
 */
function resolvePromptProfiles() {
    const result = {};
    for (const type of TYPES) {
        result[`${type}Profile`] = getOverride(type) || connectorProfileName(type) || 'default';
    }
    return result;
}

module.exports = {
    setRedis,
    loadFromRedis,
    getOverrides,
    getOverride,
    setOverride,
    connectorProfileName,
    resolvePromptProfiles,
    REDIS_KEY,
};
