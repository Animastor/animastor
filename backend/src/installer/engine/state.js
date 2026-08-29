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

/**
 * Ownership registry kinds (uninstaller input). Each entry records a path the
 * installer actually created — the uninstaller must never guess and never
 * delete anything that is not registered here.
 */
const COMPONENT_KINDS = Object.freeze(['custom_nodes', 'models', 'workflows', 'services']);

const { isSecretName } = require('../safety-rules');

/** Defensive scrub: never persist values under secret-looking names. */
function scrubSecrets(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    for (const key of Object.keys(obj)) {
        if (isSecretName(key)) {
            delete obj[key];
        } else if (typeof obj[key] === 'object') {
            scrubSecrets(obj[key]);
        }
    }
    return obj;
}

function emptyState({ mode = null, profiles = [], root = null } = {}) {
    return {
        state_version: STATE_VERSION,
        created: null,
        updated: null,
        mode,
        profiles,
        root,
        // hardware branch chosen by the installer: 'cuda' | 'cpu'
        device: null,
        // uid of the account that created the installation — the ownership
        // guard blocks resume/install under a different uid (sudo mixing).
        owner_uid: null,
        // non-secret user decisions (comfyui_update, install_models, …).
        // Recorded so `resume` continues without re-prompting.
        decisions: {},
        artifacts: {},
        // Installation manifest for the uninstaller: what THIS installer run
        // created (and therefore owns). `null` = not touched/unknown.
        //   comfyui: { owned, path, ref? }        — owned=true only when the
        //                                            installer created the dir
        //   venv:    { owned, path, created }
        //   worker:  { owned, dir, files_installed[], files_kept[], env_created }
        //   custom_nodes/models/workflows/services: [{ id, path, created?, files? }]
        components: {
            comfyui: null,
            venv: null,
            worker: null,
            custom_nodes: [],
            models: [],
            workflows: [],
            services: [],
        },
        checkpoints: [],
    };
}

/**
 * Normalize a state loaded from disk (older states lack the components
 * registry and the device field — additively restored, version stays 1).
 */
function normalizeState(state) {
    if (!state || typeof state !== 'object') return state;
    if (state.device === undefined) state.device = null;
    if (state.owner_uid === undefined) state.owner_uid = null;
    const empty = emptyState();
    state.components = { ...empty.components, ...(state.components || {}) };
    return state;
}

/**
 * Register an installer-created component (idempotent per path).
 * @param {string} kind one of COMPONENT_KINDS
 * @param {object} entry { id, path, created?, files? }
 */
function addOwnedComponent(state, kind, entry) {
    if (!COMPONENT_KINDS.includes(kind)) {
        throw new Error(`internal error: unknown component kind "${kind}"`);
    }
    if (!entry || !entry.path) return;
    const list = state.components[kind];
    if (list.some((e) => e.path === entry.path)) return;
    list.push({ id: entry.id || null, path: entry.path, ...(entry.created !== undefined ? { created: entry.created } : {}), ...(entry.files ? { files: entry.files } : {}) });
}

function loadState(io, statePath) {
    if (!io.fs.existsSync(statePath)) return null;
    try {
        const parsed = JSON.parse(io.fs.readFileSync(statePath, 'utf8'));
        if (!parsed || parsed.state_version !== STATE_VERSION) return null;
        return normalizeState(parsed);
    } catch (_) {
        return null; // corrupt state — start fresh, truth is the disk
    }
}

function saveState(io, statePath, state, now) {
    state.updated = new Date(now()).toISOString();
    if (!state.created) state.created = state.updated;
    scrubSecrets(state);
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
    COMPONENT_KINDS,
    emptyState,
    normalizeState,
    loadState,
    saveState,
    setArtifact,
    artifactStatus,
    addCheckpoint,
    addOwnedComponent,
};
