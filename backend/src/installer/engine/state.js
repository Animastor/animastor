'use strict';

/**
 * Install state — Private Worker Installer Phase 2.
 *
 * A small JSON file (default: <stateDir>/install-state.json) recording what
 * the engine has done, so an interrupted installation can be resumed:
 *
 *   installer resume
 *
 * Artifact statuses: missing | partial | installed | verified | failed.
 *
 * Rules:
 *   - the state file is an OPTIMIZATION — truth is the disk (the engine
 *     always re-checks before doing);
 *   - NO secrets are ever written here (worker key, tokens);
 *   - writes are atomic (tmp file + rename).
 */

const STATE_VERSION = 1;

const ARTIFACT_STATUSES = Object.freeze(['missing', 'partial', 'installed', 'verified', 'failed']);

function emptyState({ mode = null, profiles = [], root = null } = {}) {
    return {
        state_version: STATE_VERSION,
        created: null,
        updated: null,
        mode,
        profiles,
        root,
        artifacts: {},
        checkpoints: [],
    };
}

function loadState(io, statePath) {
    if (!io.fs.existsSync(statePath)) return null;
    try {
        const parsed = JSON.parse(io.fs.readFileSync(statePath, 'utf8'));
        if (!parsed || parsed.state_version !== STATE_VERSION) return null;
        return parsed;
    } catch (_) {
        return null; // corrupt state — start fresh, truth is the disk
    }
}

function saveState(io, statePath, state, now) {
    state.updated = new Date(now()).toISOString();
    if (!state.created) state.created = state.updated;
    const dir = statePath.replace(/\/[^/]+$/, '');
    if (dir && !io.fs.existsSync(dir)) io.fs.mkdirSync(dir, { recursive: true });
    const tmp = `${statePath}.tmp`;
    io.fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    io.fs.renameSync(tmp, statePath);
}

function setArtifact(state, id, status, detail = {}) {
    if (!ARTIFACT_STATUSES.includes(status)) {
        throw new Error(`internal error: unknown artifact status "${status}"`);
    }
    const prev = state.artifacts[id] || {};
    state.artifacts[id] = {
        status,
        at: new Date(Date.now()).toISOString(),
        attempts: (prev.attempts || 0) + (status === 'failed' ? 1 : 0),
        detail: { ...prev.detail, ...detail },
    };
}

function artifactStatus(state, id) {
    return state.artifacts[id] ? state.artifacts[id].status : 'missing';
}

/** Record a rollback checkpoint (e.g. previous ComfyUI commit). */
function addCheckpoint(state, checkpoint) {
    state.checkpoints.push({ at: new Date(Date.now()).toISOString(), ...checkpoint });
}

module.exports = {
    STATE_VERSION,
    ARTIFACT_STATUSES,
    emptyState,
    loadState,
    saveState,
    setArtifact,
    artifactStatus,
    addCheckpoint,
};
