// ======================================================
// Default Media Registrations — S-2
// ======================================================
// Registers the three existing media types (audio, image, video)
// into the media registry with their production configurations.
//
// This module is imported ONCE at startup (by backend.cjs or
// generation/index.js) to populate the registry.
//
// COVER CLASSIFICATION:
//   'cover' is NOT a separate media type — it is a chapter-type
//   label in the book model. When cover generation runs, it
//   executes through the image and audio media types. The
//   cancel-worker route's 'cover' branch clears both audio and
//   image stages. No separate registry entry is needed.
//
// IMAGE_UNITS CLASSIFICATION:
//   image_units is a cross-media timing/artifact contract stored
//   in PG. It is WRITTEN by the image stage (durations) and
//   READ by video (group planning) and player (timeline). It is
//   a shared domain contract, not an image-specific implementation.
//   The registry does not own it — it stays as a neutral contract.

const { registerMediaType } = require('./media-registry');

// ======================================================
// AUDIO
// ======================================================
registerMediaType({
    mediaType: 'audio',
    taskTypes: ['audio'],
    timeout: {
        jobMs: 30 * 60 * 1000,    // 30 min (from runtime-config GPU_TIMEOUT_MS for audio)
        leaseTtlS: undefined,       // computed from GPU_TIMEOUT_MS: ceil(STALL_FAILSAFE/1000)+60
    },
    quota: {
        maxActive: 8,               // runtime-config QUOTAS.MAX_ACTIVE_AUDIO
    },
    retry: {
        perSceneLimit: 10,          // retry-budget-manager PER_SCENE_LIMITS.audio
    },
    circuit: {
        serviceName: 'audio',       // circuit-breaker SERVICE_TARGETS.AUDIO
    },
    stuck: {
        generatingMinutes: 15,      // runtime-config STUCK_THRESHOLDS.AUDIO_GENERATING
        pendingMinutes: 15,         // runtime-config STUCK_THRESHOLDS.AUDIO_PENDING
    },
    progress: {
        strategy: 'chunk',          // progress-panel countAudio: chunk-based counting
    },
    cancel: {
        clearsStages: ['audio'],    // cancel-worker clears audio stage only
    },
    artifact: {
        suffix: '.mp3',
    },
});

// ======================================================
// IMAGE
// ======================================================
registerMediaType({
    mediaType: 'image',
    taskTypes: ['image'],
    timeout: {
        jobMs: 30 * 60 * 1000,    // 30 min (runtime-config default)
        leaseTtlS: 20 * 60,        // runtime-config LEASE_TTL_S.IMAGE
    },
    quota: {
        maxActive: 4,               // runtime-config QUOTAS.MAX_ACTIVE_IMAGE
    },
    retry: {
        perSceneLimit: 10,          // retry-budget-manager PER_SCENE_LIMITS.image
    },
    circuit: {
        serviceName: 'image',       // circuit-breaker SERVICE_TARGETS.IMAGE
    },
    stuck: {
        generatingMinutes: 30,      // runtime-config STUCK_THRESHOLDS.IMAGE_GENERATING
        pendingMinutes: 30,         // runtime-config STUCK_THRESHOLDS.IMAGE_PENDING
    },
    progress: {
        strategy: 'iu',             // progress-panel countImage: IU-based counting
    },
    cancel: {
        clearsStages: ['image'],    // cancel-worker clears image stage only
    },
    artifact: {
        suffix: '.png',
    },
});

// ======================================================
// VIDEO
// ======================================================
registerMediaType({
    mediaType: 'video',
    taskTypes: ['video'],
    timeout: {
        jobMs: 60 * 60 * 1000,    // 60 min (runtime-config DEFAULT_TYPE_TIMEOUT_MS.video)
        leaseTtlS: 30 * 60,        // runtime-config LEASE_TTL_S.VIDEO
    },
    quota: {
        maxActive: 2,               // runtime-config QUOTAS.MAX_ACTIVE_VIDEO
    },
    retry: {
        perSceneLimit: 5,           // retry-budget-manager PER_SCENE_LIMITS.video
    },
    circuit: {
        serviceName: 'video',       // circuit-breaker SERVICE_TARGETS.VIDEO
    },
    stuck: {
        generatingMinutes: 60,      // runtime-config STUCK_THRESHOLDS.VIDEO_GENERATING
        pendingMinutes: 60,         // runtime-config STUCK_THRESHOLDS.VIDEO_PENDING
    },
    progress: {
        strategy: 'scene',          // progress-panel countSceneStage: per-scene ready check
    },
    cancel: {
        clearsStages: ['video'],    // cancel-worker clears video stage only
    },
    artifact: {
        suffix: '.mp4',
    },
});
