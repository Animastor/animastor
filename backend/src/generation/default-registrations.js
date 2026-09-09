// ======================================================
// Default Media Registrations — S-2
// ======================================================
// Registers the three existing media types (audio, image, video)
// into the media registry with their production configurations.
//
// This module is imported ONCE at startup (by backend.cjs or
// generation/index.js) to populate the registry.
//
// S-2 COMPLETION: Values are READ from runtime-config (the
// canonical source of truth) — NOT hardcoded here. This
// eliminates duplicate configuration between registry and
// runtime-config.
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
const runtimeConfig = require('../config/runtime-config');

// ======================================================
// AUDIO
// ======================================================
// Config values are READ from runtime-config (the canonical source) — the
// registry does not duplicate them. jobMs defaults are the registry's own
// canonical home: they were previously hardcoded in gpu-dispatcher's
// DEFAULT_TYPE_TIMEOUT_MS and existed nowhere in runtime-config.
// retry.perSceneLimit likewise (previously retry-budget-manager's
// PER_SCENE_LIMITS) — also not present in runtime-config.
registerMediaType({
    mediaType: 'audio',
    taskTypes: ['audio'],
    timeout: {
        jobMs: 30 * 60 * 1000,    // 30 min (was gpu-dispatcher DEFAULT_TYPE_TIMEOUT_MS.audio)
        leaseTtlS: runtimeConfig.LEASE_TTL_S.AUDIO,
    },
    quota: {
        maxActive: runtimeConfig.QUOTAS.MAX_ACTIVE_AUDIO,
    },
    retry: {
        perSceneLimit: 10,
    },
    circuit: {
        serviceName: 'audio',
    },
    stuck: {
        generatingMinutes: runtimeConfig.STUCK_THRESHOLDS.AUDIO_GENERATING,
        pendingMinutes: runtimeConfig.STUCK_THRESHOLDS.AUDIO_PENDING,
    },
    progress: {
        strategy: 'chunk',
    },
    cancel: {
        clearsStages: ['audio'],
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
        jobMs: 30 * 60 * 1000,    // 30 min (was gpu-dispatcher DEFAULT_TYPE_TIMEOUT_MS.image)
        leaseTtlS: runtimeConfig.LEASE_TTL_S.IMAGE,
    },
    quota: {
        maxActive: runtimeConfig.QUOTAS.MAX_ACTIVE_IMAGE,
    },
    retry: {
        perSceneLimit: 10,
    },
    circuit: {
        serviceName: 'image',
    },
    stuck: {
        generatingMinutes: runtimeConfig.STUCK_THRESHOLDS.IMAGE_GENERATING,
        pendingMinutes: runtimeConfig.STUCK_THRESHOLDS.IMAGE_PENDING,
    },
    progress: {
        strategy: 'iu',
    },
    cancel: {
        clearsStages: ['image'],
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
        jobMs: 60 * 60 * 1000,    // 60 min (was gpu-dispatcher DEFAULT_TYPE_TIMEOUT_MS.video)
        leaseTtlS: runtimeConfig.LEASE_TTL_S.VIDEO,
    },
    quota: {
        maxActive: runtimeConfig.QUOTAS.MAX_ACTIVE_VIDEO,
    },
    retry: {
        perSceneLimit: 5,
    },
    circuit: {
        serviceName: 'video',
    },
    stuck: {
        generatingMinutes: runtimeConfig.STUCK_THRESHOLDS.VIDEO_GENERATING,
        pendingMinutes: runtimeConfig.STUCK_THRESHOLDS.VIDEO_PENDING,
    },
    progress: {
        strategy: 'scene',
    },
    cancel: {
        clearsStages: ['video'],
    },
    artifact: {
        suffix: '.mp4',
    },
});
