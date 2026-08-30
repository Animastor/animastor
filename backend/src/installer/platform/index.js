'use strict';

/**
 * Platform abstraction — Private Worker Installer (cross-platform prep).
 *
 * Two ORTHOGONAL dimensions (never mix them):
 *
 *   Platform  — the operating system the installer runs on:
 *                 'linux' | 'windows'
 *               (auto-detected from process.platform; never a CLI flag)
 *
 *   Deployment — HOW the installer's products run:
 *                 'native' | 'docker'
 *               (docker is a deployment of a platform — usually linux —
 *               NOT a platform of its own)
 *
 * The universal engine code calls the adapter methods listed in
 * `ADAPTER_INTERFACE`; each platform module (linux.js / windows.js) provides
 * its own implementation. Adapters are loaded LAZILY: selecting the windows
 * adapter never loads linux-only code paths (and vice versa) — guaranteed by
 * the architecture test suite.
 *
 * Adapters are chosen automatically. Production support today:
 *   linux + native      — fully supported (unchanged behavior)
 *   windows + native    — architectural preview (platform adapter present)
 *   * + docker          — deployment adapter prepared, NOT production-supported
 */

const path = require('path');

/** OS platforms the installer knows about (adapter modules exist). */
const PLATFORMS = Object.freeze(['linux', 'windows']);

/** Deployment targets (docker is a DEPLOYMENT, not an OS). */
const DEPLOYMENTS = Object.freeze(['native', 'docker']);

/** Canonical platform for a Node.js platform id, or null when unsupported. */
function detectPlatform(processPlatform = process.platform) {
    if (processPlatform === 'linux') return 'linux';
    if (processPlatform === 'win32') return 'windows';
    return null;
}

/**
 * Deployment detection: docker when the container markers are present.
 * Pure when `fsExists`/`env` are injected (tests); on a real host it probes
 * the canonical /.dockerenv marker plus the common env fingerprints.
 * Docker markers are only meaningful on the linux platform — windows
 * containers are explicitly not a target.
 */
function detectDeployment({ platform = detectPlatform(), fsExists = null, env = process.env } = {}) {
    if (platform === 'windows') return 'native';
    const exists = fsExists || ((p) => { try { return require('fs').existsSync(p); } catch (_) { return false; } });
    if (exists('/.dockerenv')) return 'docker';
    if (env.ANIMASTOR_DEPLOYMENT) {
        const v = String(env.ANIMASTOR_DEPLOYMENT).toLowerCase();
        if (v === 'docker' || v === 'native') return v;
    }
    if (/docker|containerd|kubepods/.test(String(env.container || ''))) return 'docker';
    return 'native';
}

/** Raised when the host platform has no adapter (e.g. darwin, freebsd). */
class UnsupportedPlatformError extends Error {
    constructor(platform) {
        super(`unsupported platform "${platform ?? 'unknown'}": the Animastor installer supports linux and windows (docker is a separate deployment target).`);
        this.name = 'UnsupportedPlatformError';
        this.code = 'unsupported_platform';
        this.platform = platform ?? null;
    }
}

/** Adapter modules are LAZY so a selected platform never loads the others. */
const ADAPTER_MODULES = {
    linux: () => require('./linux'),
    windows: () => require('./windows'),
};

/** Resolved-adapter cache (one module instance per platform). */
const adapterCache = new Map();

/**
 * The full adapter surface the engine is allowed to call. Documented here so
 * every platform module implements the same contract (checked by tests).
 */
const ADAPTER_INTERFACE = Object.freeze([
    'name', 'displayName', 'productionReady',
    'HOME_ENV', 'UID_GUARD', 'TOOL_SCRIPT_MODE',
    'defaultRoot', 'defaultWorkerDir', 'venvPythonBin',
    'findPidsByCmdlineAndCwd', 'readProcessCwd', 'readProcessCmdline',
    'processStartMs', 'pidUid', 'findComfyUIPids', 'findPidsByCwdPrefix',
    'sleepCommand', 'killCommand', 'psCheckCommand',
    'hostPackageCommand', 'hostPackagesCommand', 'checkBuildPrerequisites',
    'toolScriptName', 'renderToolScript',
    'probeAmdGpu',
]);

/**
 * Resolve the platform adapter. Lazily requires ONLY the selected module —
 * on linux the windows module is never imported, and vice versa.
 * @param {string|null|undefined} platform explicit platform id; default = auto-detect
 * @returns {object} platform adapter (see ADAPTER_INTERFACE)
 * @throws UnsupportedPlatformError for darwin/freebsd/… (clear, early, loud)
 */
function getPlatformAdapter(platform) {
    const id = platform == null ? detectPlatform() : platform;
    if (!id || !PLATFORMS.includes(id)) {
        throw new UnsupportedPlatformError(id);
    }
    let mod = adapterCache.get(id);
    if (mod) return mod;
    mod = ADAPTER_MODULES[id]();
    for (const key of ADAPTER_INTERFACE) {
        if (mod[key] === undefined) {
            throw new Error(`platform adapter "${id}" is incomplete: missing "${key}"`);
        }
    }
    adapterCache.set(id, mod);
    return mod;
}

/**
 * Resolve the deployment adapter. Lazily requires ONLY the selected module.
 * Docker deployment on a windows platform is rejected: docker is a linux
 * deployment target (windows containers are explicitly out of scope).
 */
function getDeploymentAdapter(deployment = 'native', { platform = detectPlatform() } = {}) {
    if (!DEPLOYMENTS.includes(deployment)) {
        throw new Error(`unknown deployment "${deployment}" (expected one of ${DEPLOYMENTS.join(', ')})`);
    }
    if (deployment === 'docker' && platform && platform !== 'linux') {
        throw new Error(`docker deployment requires the linux platform (got "${platform}"); windows containers are not a supported target.`);
    }
    return require(`./deployment/${deployment}`);
}

/**
 * Resolve the runtime context for a whole installer run: one platform
 * adapter + one deployment adapter + the effective production-support
 * verdict. This is the single entry point the CLI/engine should use.
 */
function resolveRuntime({ platform = detectPlatform(), deployment = null, env = process.env } = {}) {
    const adapter = getPlatformAdapter(platform);
    const dep = deployment || detectDeployment({ platform, env });
    const deploymentAdapter = getDeploymentAdapter(dep, { platform });
    return {
        platform,
        deployment: dep,
        adapter,
        deploymentAdapter,
        productionReady: adapter.productionReady && deploymentAdapter.productionReady,
    };
}

module.exports = {
    PLATFORMS,
    DEPLOYMENTS,
    ADAPTER_INTERFACE,
    UnsupportedPlatformError,
    detectPlatform,
    detectDeployment,
    getPlatformAdapter,
    getDeploymentAdapter,
    resolveRuntime,
};
