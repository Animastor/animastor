// ======================================================
// Scene State — v2.2.0 — PURE core (S-4 correction)
// ======================================================
// The per-asset state model is the ONLY source of truth for Generation
// asset lifecycle (per-scene hash fields audio/image/video).
//
// This module is the pure FSM/domain core: asset enum, state transitions and
// transition validation, and the registry-backed ASSETS view. It knows
// NOTHING about Redis — no client calls, no key namespaces. The Redis
// persistence (animastor:asset-state:* hashes) lives in the host adapter:
// state/asset-state-store.js (formalized as a port in S-6).

// ======================================================
// ASSETS — lazy view over the media registry (the single
// source of registered media types). The media-registry self-bootstraps its
// default registrations on first access, so module load order no longer
// requires a static fallback here.
// Consumers keep the same shape and semantics: array equality with
// ['audio', 'image', 'video'], ASSETS.includes(asset) validation, join().
// ======================================================

const mediaRegistry = require('./media-registry');
const ASSETS = new Proxy([], {
    get(_, key) {
        const assets = mediaRegistry.listMediaTypes();
        if (key === 'includes') return (a) => assets.includes(a);
        if (key === 'join') return (sep) => assets.join(sep);
        if (key === Symbol.iterator) return function* () { yield* assets; };
        if (typeof key === 'string' && /^\d+$/.test(key)) return assets[Number(key)];
        if (key === 'length') return assets.length;
        const arrProps = ['indexOf', 'filter', 'map', 'forEach', 'slice', 'concat', 'some', 'every'];
        if (arrProps.includes(key)) return assets[key].bind(assets);
        return undefined;
    },
    ownKeys() { return mediaRegistry.listMediaTypes().map((_, i) => String(i)).concat('length'); },
    getOwnPropertyDescriptor(_, key) {
        const assets = mediaRegistry.listMediaTypes();
        if (key === 'length') return { value: assets.length, enumerable: false, configurable: true };
        if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) < assets.length) {
            return { value: assets[Number(key)], enumerable: true, configurable: true, writable: true };
        }
        return undefined;
    },
});

/** @type {{ [name: string]: string }} */
const AssetState = {
    NEW: 'new',
    DIRTY: 'dirty',
    PENDING: 'pending',
    GENERATING: 'generating',
    READY: 'ready',
    FAILED: 'failed',
    PLACEHOLDER: 'placeholder'
};
const ASSET_STATES = new Set(Object.values(AssetState));

// ======================================================
// ASSET STATE OPERATIONS
// ======================================================

/**
 * Per-asset transition validation map.
 */
const AssetTransitions = {
    [AssetState.NEW]: [AssetState.DIRTY, AssetState.PENDING, AssetState.PLACEHOLDER],
    [AssetState.DIRTY]: [AssetState.PENDING, AssetState.PLACEHOLDER],
    [AssetState.PENDING]: [AssetState.GENERATING, AssetState.FAILED],
    [AssetState.GENERATING]: [AssetState.READY, AssetState.FAILED, AssetState.DIRTY],
    [AssetState.READY]: [AssetState.DIRTY],
    [AssetState.FAILED]: [AssetState.PENDING, AssetState.DIRTY],
    [AssetState.PLACEHOLDER]: [AssetState.DIRTY, AssetState.GENERATING]
};

/**
 * Validate per-asset state transition.
 * @param {string} fromState
 * @param {string} toState
 * @returns {{ valid: boolean, reason: string }}
 */
function validateAssetTransition(fromState, toState) {
    if (fromState === toState) {
        return { valid: true, reason: 'same_state' };
    }
    const allowed = AssetTransitions[fromState] || [];
    if (allowed.includes(toState)) {
        return { valid: true, reason: 'valid' };
    }
    return { valid: false, reason: 'invalid_asset_transition', allowed };
}

/**
 * Normalize a raw per-asset hash into the canonical state shape
 * ({ audio, image, video } with NEW defaults for missing fields).
 * Pure mapping used by the host store after HGETALL.
 *
 * @param {object} raw — hash fields (or empty/absent)
 * @returns {{audio: string, image: string, video: string}}
 */
function normalizeAssetStates(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length > 0) {
        return {
            audio: raw.audio || AssetState.NEW,
            image: raw.image || AssetState.NEW,
            video: raw.video || AssetState.NEW
        };
    }
    // No fallback — legacy scene-state has been removed
    return { audio: AssetState.NEW, image: AssetState.NEW, video: AssetState.NEW };
}

/**
 * Validate one (asset, status) pair against the FSM.
 * @returns {string | null} error message, or null when valid
 */
function validateAssetUpdate(asset, status) {
    if (!ASSETS.includes(asset)) {
        return `Invalid asset type: ${asset}. Must be one of: ${ASSETS.join(', ')}`;
    }
    if (!ASSET_STATES.has(status)) {
        return `Invalid asset status: ${status}. Must be one of: ${[...ASSET_STATES].join(', ')}`;
    }
    return null;
}

/**
 * Validate a bulk (asset, status) updates object against the FSM.
 * @returns {string | null} error message, or null when valid
 */
function validateAssetUpdates(updates) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return 'Invalid asset state updates: expected an object';
    }
    for (const [asset, status] of Object.entries(updates)) {
        const err = validateAssetUpdate(asset, status);
        if (err) return err;
    }
    return null;
}

module.exports = {
    // Asset state (canonical)
    AssetState,
    ASSETS,
    validateAssetTransition,
    normalizeAssetStates,
    validateAssetUpdate,
    validateAssetUpdates,
};
