// ======================================================
// Scene Hash - canonical creative-content fingerprint
// ======================================================
// Computes a stable hash from a scene's creative content
// (text, visuals, structure) so that any change to the
// creative content automatically invalidates derived assets.
//
// Excludes runtime / derived fields:
//   - generated asset paths
//   - build_id
//   - created_at / updated_at
//   - status, scene_hash itself

const crypto = require('crypto');

const EXCLUDED_TOP_KEYS = new Set([
    'id', 'created_at', 'updated_at', 'build_id',
    'status', 'scene_hash', 'metadata', 'state',
]);

const EXCLUDED_UNIT_KEYS = new Set([
    'id', 'created_at', 'updated_at', 'status',
]);

function canonicalize(value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    const out = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) {
        if (EXCLUDED_TOP_KEYS.has(k)) continue;
        out[k] = canonicalize(value[k]);
    }
    return out;
}

function canonicalizeUnit(unit) {
    if (!unit || typeof unit !== 'object') return null;
    const out = {};
    const keys = Object.keys(unit).sort();
    for (const k of keys) {
        if (EXCLUDED_UNIT_KEYS.has(k)) continue;
        out[k] = unit[k];
    }
    return out;
}

function extractSceneFingerprint(scene) {
    if (!scene || typeof scene !== 'object') return null;

    const fingerprint = {};
    for (const key of Object.keys(scene).sort()) {
        if (EXCLUDED_TOP_KEYS.has(key)) continue;
        if (key === 'units' && Array.isArray(scene.units)) {
            fingerprint.units = scene.units
                .map(canonicalizeUnit)
                .filter(u => u !== null);
        } else {
            fingerprint[key] = scene[key];
        }
    }
    return fingerprint;
}

function hashString(s) {
    return crypto.createHash('sha256').update(s).digest('hex');
}

function computeSceneHash(scene) {
    const fp = extractSceneFingerprint(scene);
    if (!fp) return null;
    const canonical = JSON.stringify(fp);
    return hashString(canonical);
}

function computeBookHash(book) {
    if (!book) return null;
    const canonical = JSON.stringify(canonicalize(book));
    return hashString(canonical);
}

function shortHash(hash) {
    if (!hash) return null;
    return hash.slice(0, 12);
}

function generateBuildId(prefix = 'bld') {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(4).toString('hex');
    return `${prefix}-${ts}-${rand}`;
}

module.exports = {
    computeSceneHash,
    computeBookHash,
    shortHash,
    generateBuildId,
    _internal: { canonicalize, extractSceneFingerprint },
};
