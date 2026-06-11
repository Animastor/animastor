// @ts-check
// ======================================================
// Runtime Configuration - v1.0.0
// ======================================================
// Centralized config to avoid hardcoded values in runtime modules.

/**
 * @typedef {import('../state/scene-state').SceneStateValue} SceneStateValue
 */

/**
 * @typedef {{ 
 *   SCENE_STATE_KEY_PREFIX: string, 
 *   SCENE_TRANSITION_LOCK_PREFIX: string, 
 *   DISPATCH_LEASE_PREFIX: string, 
 *   DISPATCH_META_PREFIX: string, 
 *   ACTIVE_COUNTER_PREFIX: string, 
 *   SCHEDULER_LOCK: string, 
 *   CLEANUP_LOCK: string, 
 *   AUDIO_SCENE_LOCK_PREFIX: string, 
 *   VIDEO_SCENE_LOCK_PREFIX: string, 
 *   IU_REGISTRY_PREFIX: string, 
 *   SCENE_VIDEO_PREFIX: string, 
 *   METRICS_CURRENT: string, 
 *   METRICS_HISTORY: string 
 * }} RedisKeys
 */

/**
 * @typedef {{ 
 *   TTL: { AUDIO: number, IMAGE: number, VIDEO: number }, 
 *   RENEWAL: { INTERVAL_MS: number, START_DELAY_MS: number, EXTENSION_SECONDS: number }, 
 *   STALE_THRESHOLD: number 
 * }} LeaseConfig
 */

/**
 * @typedef {{ 
 *   MAX_ACTIVE_AUDIO: number, 
 *   MAX_ACTIVE_IMAGE: number, 
 *   MAX_ACTIVE_VIDEO: number 
 * }} QuotasConfig
 */

/**
 * @typedef {{ 
 *   MAX_ATTEMPTS: { AUDIO: number, IMAGE: number, VIDEO: number }, 
 *   INITIAL_BACKOFF_MS: number, 
 *   MAX_BACKOFF_MS: number, 
 *   BACKOFF_MULTIPLIER: number 
 * }} RetryConfig
 */

/**
 * @typedef {{ TICK_MS: number }} SchedulerConfig
 */

/**
 * @typedef {{ [state: string]: number }} StuckThresholds
 */

// ======================================================
// PATHS
// ======================================================
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output';
const BOOKS_DIR = process.env.BOOKS_DIR || '/data/books';
const HUB_URL = process.env.HUB_URL || 'https://animastor.in/gpu';

// ======================================================
// TXT IMPORT
// ======================================================
const TXT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const LAZY_WINDOW_SIZE = 3; // default scenes per window

// ======================================================
// REDIS KEYS
// ======================================================
const REDIS = {
    // Scene state
    SCENE_STATE_KEY_PREFIX: 'animastor:scene-state',
    SCENE_TRANSITION_LOCK_PREFIX: 'animastor:scene-transition-lock',
    
    // Dispatch leases
    DISPATCH_LEASE_PREFIX: 'animastor:dispatch-lease',
    DISPATCH_META_PREFIX: 'animastor:dispatch-meta',
    
    // Active counters (derived, not source of truth)
    ACTIVE_COUNTER_PREFIX: 'animastor:runtime:active',
    
    // Runtime locks
    SCHEDULER_LOCK: 'animastor:runtime:scheduler-lock',
    CLEANUP_LOCK: 'animastor:cleanup-lock',
    AUDIO_SCENE_LOCK_PREFIX: 'animastor:audio-scene-lock',
    VIDEO_SCENE_LOCK_PREFIX: 'animastor:video-lock',
    
    // IU Registry
    IU_REGISTRY_PREFIX: 'animastor:iu-registry',
    
    // Scene video registry
    SCENE_VIDEO_PREFIX: 'animastor:scene-video',
    
    // Runtime metrics
    METRICS_CURRENT: 'animastor:runtime:metrics:current',
    METRICS_HISTORY: 'animastor:runtime:metrics:history',
};

// ======================================================
// QUOTAS
// ======================================================
const QUOTAS = {
    MAX_ACTIVE_AUDIO: 3,
    MAX_ACTIVE_IMAGE: 2,
    MAX_ACTIVE_VIDEO: 1,
};

// ======================================================
// SCENE WINDOW (triplet generation)
// ======================================================
const WINDOW_SIZE = 3;

const BOOK_SCENE_KEY_PREFIX = 'animastor:book-scenes';
const BOOK_SCENE_TOTAL = (bookId) => `${BOOK_SCENE_KEY_PREFIX}:${bookId}:total`;
const BOOK_SCENE_NEXT = (bookId) => `${BOOK_SCENE_KEY_PREFIX}:${bookId}:next-index`;

// ======================================================
// WORKER HEARTBEAT
// ======================================================
const WORKER_HEARTBEAT_PREFIX = 'animastor:worker:heartbeat';
const WORKER_HEARTBEAT_TTL = 30; // seconds — worker must heartbeat at least this often
const WORKER_HEARTBEAT_TYPES = ['audio', 'image', 'video'];

const WORKER_HEARTBEAT_KEY = (type, workerId) => `${WORKER_HEARTBEAT_PREFIX}:${type}:${workerId}`;
const WORKER_HEARTBEAT_TYPE_PATTERN = (type) => `${WORKER_HEARTBEAT_PREFIX}:${type}:*`;

// ======================================================
// AI (NVIDIA)
// ======================================================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY && process.env.NODE_ENV !== 'test') {
    console.warn('[CONFIG] WARNING: OPENROUTER_API_KEY is not set — AI assistant will be unavailable');
}
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3.5-122b-a10b';

// ======================================================
// STUCK DETECTION (minutes)
// ======================================================
const STUCK_THRESHOLDS = {
    AUDIO_GENERATING: 15,
    AUDIO_PENDING: 15,
    IMAGE_GENERATING: 30,
    IMAGE_PENDING: 30,
    VIDEO_GENERATING: 60,
    VIDEO_PENDING: 60,
};

// ======================================================
// EXPORTS
// ======================================================
module.exports = {
    OUTPUT_DIR,
    BOOKS_DIR,
    HUB_URL,
    REDIS,
    QUOTAS,
    STUCK_THRESHOLDS,

    // Scene window
    WINDOW_SIZE,
    BOOK_SCENE_TOTAL,
    BOOK_SCENE_NEXT,

    // TXT import
    TXT_MAX_SIZE,
    LAZY_WINDOW_SIZE,

    // Worker heartbeat
    WORKER_HEARTBEAT_PREFIX,
    WORKER_HEARTBEAT_TTL,
    WORKER_HEARTBEAT_TYPES,
    WORKER_HEARTBEAT_KEY,
    WORKER_HEARTBEAT_TYPE_PATTERN,

    // AI
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL,
};

// Backwards compatibility aliases
module.exports.SCENE_STATE_KEY_PREFIX = REDIS.SCENE_STATE_KEY_PREFIX;
module.exports.SCENE_TRANSITION_LOCK_PREFIX = REDIS.SCENE_TRANSITION_LOCK_PREFIX;
module.exports.SCENE_TRANSITION_LOCK_TTL = 15; // 15 seconds
