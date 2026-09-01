// @ts-check
// ======================================================
// Runtime Configuration - v1.0.0
// ======================================================
// Centralized config to avoid hardcoded values in runtime modules.

/**
 * @typedef {{ 
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
// VIDEO — PLAYBACK PROFILE
// ======================================================
// Bitrate cap (kbps) for the Player's merged scene video (the re-encode in
// video-merge.js that also forces unit-boundary keyframes). The pipeline
// SOURCES (_gN.mp4) stay untouched at master quality — this only affects the
// lightweight derivative served to the Player. 0 disables the cap → falls back
// to the previous near-lossless CRF 18. Default 2000 kbps was confirmed by the
// on-device experiment (docs/05-frontend/VIDEO_LOADING_RESEARCH.md §playback
// profile): a 2 Mbps 768×1024 stream played continuously on a mobile connection
// where the 5.47 Mbps current file buffered constantly (SSIM 0.968 vs source).
const PLAYBACK_VIDEO_BITRATE_KBPS = Number(process.env.PLAYBACK_VIDEO_BITRATE_KBPS ?? 2000);

// Source/master profile (kbps): the pipeline's ComfyUI SaveVideo node has NO
// bitrate controls, so raw group clips arrive at 4-6+ Mbps for 768p animation.
// video-orchestrator caps each incoming _gN.mp4 ONCE at ingest to this rate so
// stored sources (and the merge's playback re-encode) start from a sane
// bitrate. 3500 kbps is near-transparent for this content (PSNR ~39.8 dB,
// SSIM ~0.977 per the playback experiment) and still export-worthy; 0 disables
// the cap (sources stored as the pipeline produced them).
const SOURCE_VIDEO_BITRATE_KBPS = Number(process.env.SOURCE_VIDEO_BITRATE_KBPS ?? 3500);

// ======================================================
// TXT IMPORT
// ======================================================
const TXT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const LAZY_WINDOW_SIZE = 3; // default scenes per window

// ======================================================
// REDIS KEYS
// ======================================================
const REDIS = {
    // Scene transition lock
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
// Tune these values to match your GPU capacity.
// Each slot = one concurrent worker task.
// Start with 8/4/2 if you have 2+ GPUs; lower if 1 GPU.
const QUOTAS = {
    MAX_ACTIVE_AUDIO: 8,
    MAX_ACTIVE_IMAGE: 4,
    MAX_ACTIVE_VIDEO: 2,
};

// ======================================================
// GPU TIMEOUT — ЕДИНСТВЕННАЯ ВХОДНАЯ КОНСТАНТА
// ======================================================
// Single source of truth для всех аудио-таймаутов оркестрации.
// gpu-hub, watchdog, dispatch lease — все вычисляются от неё.
// (см. docs/02-orchestration/AUDIO_ORCH_ARCHITECTURAL_FIXES.md §1)
//
// Инвариант (проверяется в tests/runtime-timeouts.test.js):
//   GPU_TIMEOUT_MS < STALL_FAILSAFE_MS < LEASE_TTL_S.AUDIO * 1000
// Backward compat: GPU_TIMEOUT (without _MS) — устаревшее имя, удалить после миграции.
const GPU_TIMEOUT_MS = Number(process.env.GPU_TIMEOUT_MS ?? process.env.GPU_TIMEOUT ?? 600_000);

// ======================================================
// TIMEOUTS — все аудио-таймауты вычисляются от GPU_TIMEOUT_MS
// ======================================================
// Формулы:
//   STALL_FAILSAFE_MS  = GPU_TIMEOUT_MS * 3
//     — watchdog срабатывает только после того, как hub объявил timeout
//     — живые чанки НЕ отвергаются как stale_dispatch
//   LEASE_TTL_S.AUDIO  = ceil(STALL_FAILSAFE_MS / 1000) + 60
//     — lease переживает watchdog, не блокирует re-dispatch при реальном застое
//
// Dispatch lease TTL (секунды). Покрывает реальную генерацию + ожидание в очереди:
//   audio, image: до 15 мин генерации; video: до 20 мин.
// Lease снимается сразу по completion callback — TTL важен только при сбоях.
const STALL_FAILSAFE_MS = GPU_TIMEOUT_MS * 3;

const LEASE_TTL_S = {
    AUDIO: Math.ceil(STALL_FAILSAFE_MS / 1000) + 60,
    IMAGE: 20 * 60,
    VIDEO: 30 * 60,
};

const TIMEOUTS = {
    // Порог застоя аудио-чанков (reconcileCycle, checkStalledAudioScenes).
    // Вычисляется от GPU_TIMEOUT_MS: watchdog срабатывает ПОСЛЕ того, как
    // gpu-hub затаймил воркера, но ДО истечения dispatch lease.
    // Если ты меняешь GPU_TIMEOUT_MS — STALL_FAILSAFE_MS и LEASE_TTL_S.AUDIO
    // пересчитываются автоматически.
    AUDIO_CHUNK_STALL_MS: STALL_FAILSAFE_MS,

    // Порог застоя видео-групп (reconcileCycle, checkStalledVideoScenes).
    // Аналогичен AUDIO_CHUNK_STALL_MS: видео-группы генерируются дольше
    // (LTX до ~20 мин на группу), поэтому порог удвоен от STALL_FAILSAFE_MS.
    VIDEO_CHUNK_STALL_MS: STALL_FAILSAFE_MS * 2,

    // Периодическая чистка протухших failsafe-локов (cleanup-service.cjs)
    CLEANUP_INTERVAL_MS: 60000,

    // Флаг форсированного диспатча при регенерации (generation-routes)
    FORCE_DISPATCH_TTL_S: 120,

    // TTL маркера animastor:iu-in-flight:* (iu-processor ставит ДО gpu.send)
    // и per-dispatch индекса animastor:iu-in-flight-index:* (dispatch-engine).
    // Маркер переживает backend restart; очистка привязана к dispatch ownership
    // (forensic audit 6929ba5: no_jobs_sent ghost).
    IU_IN_FLIGHT_TTL_S: 1200,
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
// WORKER SHARING V1 — KILL-SWITCH (SH-1)
// ======================================================
// SHARE_FEATURES_ENABLED gates the share-policy routes (§7.3) and — on the
// gpu-hub side (its own env copy, SYNC comment in gpu-hub/gpu-hub.js) — the
// lane-priority step-2 pop (§7.2). DEFAULT OFF (§8.7): disabling returns the
// system bit-for-bit to pre-sharing behavior (routes answer 404 as if the
// endpoints do not exist; the hub never pops the system pool for private
// workers; heartbeats never carry the share_policy marker).
//
// Read LAZILY on every call (not cached at module load) so the kill-switch
// can be flipped by changing the env of a running process (and so tests can
// exercise both states in one run).
function shareFeaturesEnabled() {
    const v = process.env.SHARE_FEATURES_ENABLED;
    return v === '1' || v === 'true' || v === 'on';
}

// ======================================================
// GPU HUB
// ======================================================
// T9: Единое имя env для API-ключа GPU Hub.
// Пробрасывается в backend и gpu-hub через docker-compose.
const GPU_HUB_API_KEY = process.env.GPU_HUB_API_KEY || null;

// Startup warning: если GPU_TIMEOUT_MS был явно изменён — логируем
// пересчитанные значения, чтобы в логах было видно, что изменилось.
if ((process.env.GPU_TIMEOUT_MS || process.env.GPU_TIMEOUT) && process.env.NODE_ENV !== 'test') {
    console.log(`[CONFIG] GPU_TIMEOUT_MS=${GPU_TIMEOUT_MS} → ` +
        `STALL_FAILSAFE_MS=${STALL_FAILSAFE_MS} (${(STALL_FAILSAFE_MS/60000).toFixed(0)}min), ` +
        `AUDIO_LEASE_TTL_S=${LEASE_TTL_S.AUDIO} (${(LEASE_TTL_S.AUDIO/60).toFixed(0)}min)`);
}

// ======================================================
// AI (NVIDIA)
// ======================================================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY && process.env.NODE_ENV !== 'test') {
    console.debug('[CONFIG] OPENROUTER_API_KEY is not set — AI assistant will be unavailable');
}
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3-32b';

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
// GUEST / TEMPORARY WORKSPACES (Guest Workspace MVP)
// ======================================================
// Development defaults, deliberately configurable — exact retention numbers
// are an operational decision, not architecture. TTL counts from creation/
// last user activity; after TTL the workspace is EXPIRED but recoverable
// through the grace period; hard deletion happens only past TTL+grace.
const GUEST_WORKSPACE_TTL_DAYS = Number(process.env.GUEST_WORKSPACE_TTL_DAYS ?? 7);
const GUEST_WORKSPACE_GRACE_PERIOD_DAYS = Number(process.env.GUEST_WORKSPACE_GRACE_PERIOD_DAYS ?? 23);
const GUEST_SESSION_TTL_DAYS = Number(process.env.GUEST_SESSION_TTL_DAYS ?? 30);

// ======================================================
// EXPORTS
// ======================================================
module.exports = {
    OUTPUT_DIR,
    BOOKS_DIR,
    HUB_URL,
    REDIS,
    QUOTAS,
    GPU_TIMEOUT_MS,
    STALL_FAILSAFE_MS,
    LEASE_TTL_S,
    TIMEOUTS,
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

    // Worker sharing V1 (kill-switch, default OFF)
    shareFeaturesEnabled,

    // GPU Hub
    GPU_HUB_API_KEY,

    // AI
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL,

    // Video playback profile
    PLAYBACK_VIDEO_BITRATE_KBPS,
    SOURCE_VIDEO_BITRATE_KBPS,

    // Guest / temporary workspaces
    GUEST_WORKSPACE_TTL_DAYS,
    GUEST_WORKSPACE_GRACE_PERIOD_DAYS,
    GUEST_SESSION_TTL_DAYS,

};

// Backwards compatibility aliases
module.exports.SCENE_TRANSITION_LOCK_PREFIX = REDIS.SCENE_TRANSITION_LOCK_PREFIX;
module.exports.SCENE_TRANSITION_LOCK_TTL = 15; // 15 seconds
