'use strict';

/**
 * Private Worker Setup Contract — UI-safe projection (Phase 3).
 *
 * Projects the canonical installer metadata (install manifests, resolver,
 * download planner) into a stable DTO surface consumed by BOTH frontends
 * (Web and Android) through backend/src/routes/worker-setup-routes.cjs:
 *
 *   profiles, installation methods, installer/uninstaller artifacts,
 *   worker bundle, workflow metadata, setup instructions, worker status,
 *   normalized capabilities, UI-safe installation plan.
 *
 * Hard rules:
 *   - the raw installer manifest NEVER leaves the backend; only the
 *     projections defined here are exposed;
 *   - no secrets: the Worker Key / token_hash / credentials never appear in
 *     any projection; instructions carry a placeholder only;
 *   - nothing is invented: unknown VRAM stays null, unresearched model
 *     sources become explicit blocks, unavailable artifacts stay
 *     available=false with status 'planned';
 *   - download URLs are ORIGIN-RELATIVE paths (e.g. "/gpu/worker-bundle");
 *     the frontend resolves them against its own origin. The frontend can
 *     never supply or alter a download URL.
 */

const fs = require('fs');
const path = require('path');

const { loadManifest, loadAllManifests, MANIFEST_ROOT } = require('./install-manifest');
const resolver = require('./compatibility-resolver');
const { planModelDownload } = require('./download-planner');

// ---------------------------------------------------------------------------
// Versions & registries (single source of truth for the contract)
// ---------------------------------------------------------------------------
// Versions are READ from canonical sources — never duplicated here:
//   installer     → backend/src/installer/package.json   (getInstallerVersion)
//   worker bundle → worker/worker/package.json           (hub probe first,
//                   repo fallback via getWorkerBundleVersion)
//   workflows     → manifest revision + baseline_sha256  (content-addressed)
//   uninstaller   → does not exist yet → version stays null, status 'planned'

/** Read the canonical installer version from the installer's package.json. */
function getInstallerVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
    } catch (_) {
        return null;
    }
}

/**
 * Read the canonical worker bundle version from the bundle's own
 * package.json (repo checkout). In container deployments the worker tree
 * may not be mounted into the backend — then the hub probe is the only
 * source (probeHubArtifacts carries the version the hub actually serves).
 */
function getWorkerBundleVersion() {
    try {
        const file = path.join(__dirname, '..', '..', '..', 'worker', 'worker', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
        return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
    } catch (_) {
        return null;
    }
}

const PLATFORMS = Object.freeze(['linux', 'windows', 'docker']);

/** Install modes exposed to the UI (resolver RUNTIME_MODES minus none). */
const INSTALL_MODES = Object.freeze(['managed', 'existing', 'shared', 'isolated']);

/**
 * Extended UI-safe worker status model. Superset of the existing
 * ONLINE/OFFLINE/REVOKED — the legacy values keep their meaning; the extra
 * states are derived (CONNECTING) or reserved for future signals
 * (NOT_CONFIGURED is a frontend-level state, INSTALLING/ERROR await an
 * installer check-in / worker error channel).
 */
const SETUP_WORKER_STATUSES = Object.freeze([
    'NOT_CONFIGURED',
    'INSTALLING',
    'CONNECTING',
    'ONLINE',
    'OFFLINE',
    'ERROR',
    'REVOKED',
]);

/** Machine-readable sharing verdicts (task §15 naming). */
const SHARING_VERDICT_MAP = Object.freeze({
    'shared-compatible': 'SHARED_COMPATIBLE',
    'shared-conflict': 'SHARED_CONFLICT',
    'requires-isolation': 'REQUIRES_ISOLATION',
    unknown: 'UNKNOWN',
});

const ACRONYMS = Object.freeze({ tts: 'TTS', ltx: 'LTX', gpu: 'GPU' });

function displayNameFromSlug(slug) {
    return String(slug)
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((w) => (ACRONYMS[w.toLowerCase()] ? ACRONYMS[w.toLowerCase()] : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ');
}

// ---------------------------------------------------------------------------
// Manifest cache (manifests are mounted live — reload when the tree changes)
// ---------------------------------------------------------------------------

function manifestsFingerprint(root) {
    if (!fs.existsSync(root)) return null;
    const parts = [];
    for (const type of fs.readdirSync(root).sort()) {
        const typeDir = path.join(root, type);
        if (!fs.statSync(typeDir).isDirectory()) continue;
        for (const file of fs.readdirSync(typeDir).sort()) {
            if (!file.endsWith('.json')) continue;
            const st = fs.statSync(path.join(typeDir, file));
            parts.push(`${type}/${file}:${st.size}:${st.mtimeMs}`);
        }
    }
    return parts.join('|') || null;
}

function createManifestRegistry({ loadAll = loadAllManifests, root = MANIFEST_ROOT } = {}) {
    const cache = { fingerprint: undefined, manifests: null };
    return {
        /** @returns {Object<string, object>} manifests keyed by profile id */
        all() {
            const fp = manifestsFingerprint(root);
            if (fp === cache.fingerprint && cache.manifests) return cache.manifests;
            cache.manifests = loadAll({ skipValidation: false });
            cache.fingerprint = fp;
            return cache.manifests;
        },
        /** @returns {object|null} one manifest or null when unknown */
        get(profileId) {
            if (typeof profileId !== 'string' || !profileId) return null;
            const all = this.all();
            return Object.prototype.hasOwnProperty.call(all, profileId) ? all[profileId] : null;
        },
        invalidate() { cache.fingerprint = undefined; cache.manifests = null; },
    };
}

const defaultRegistry = createManifestRegistry();

/** The canonical (repo manifests) registry — used unless one is injected. */
function getManifestRegistry() {
    return defaultRegistry;
}

/** Manifests that must never be exposed through the setup contract. */
function isHiddenManifest(manifest) {
    const status = manifest && manifest.status;
    return status === 'internal' || status === 'hidden';
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

function dependenciesSummary(manifest) {
    const deps = manifest.dependencies || [];
    const models = deps.filter((d) => d.kind === 'model' || d.kind === 'model_repo');
    const customNodes = deps.filter((d) => d.kind === 'custom_node');
    const requiredModels = models.filter((d) => d.requirement === 'required');
    const approxBytes = requiredModels.reduce(
        (sum, d) => sum + (typeof d.size_bytes_approx === 'number' ? d.size_bytes_approx : 0), 0
    );
    return {
        custom_nodes: customNodes.filter((d) => d.requirement === 'required').length,
        models: requiredModels.length,
        approx_bytes: approxBytes > 0 ? approxBytes : null,
    };
}

/**
 * UI-safe profile projection. Deliberately NOT the raw manifest: internal
 * source URLs, repository paths, checksums of models, provenance evidence
 * and resolver details stay inside the backend.
 */
function projectProfile(manifest) {
    const profile = manifest.profile;
    const hardware = manifest.hardware || {};
    const wfArtifacts = (manifest.workflows && manifest.workflows.artifacts) || [];
    return {
        id: profile.id,
        name: displayNameFromSlug(profile.name),
        description: `${displayNameFromSlug(profile.name)} — private ${profile.type} generation via ComfyUI on your own GPU worker.`,
        worker_type: profile.type,
        status: manifest.status || 'draft',
        supported_install_modes: INSTALL_MODES.slice(),
        gpu: {
            min_vram_gb: typeof hardware.gpu_min_vram_gb === 'number' ? hardware.gpu_min_vram_gb : null,
            reference_gpu: hardware.reference_gpu || null,
        },
        disk_budget_bytes_approx: (manifest.disk_budget && manifest.disk_budget.models_bytes_approx) || null,
        workflows: wfArtifacts.map((w) => String(w.id).replace(/^workflow:/, '')),
        dependencies_summary: dependenciesSummary(manifest),
    };
}

/**
 * List UI-safe install profiles from canonical installer metadata.
 * @param {{type?: string, registry?: object}} opts
 */
function listSetupProfiles({ type = null, registry = defaultRegistry } = {}) {
    const manifests = registry.all();
    const profiles = [];
    for (const id of Object.keys(manifests).sort()) {
        const manifest = manifests[id];
        if (isHiddenManifest(manifest)) continue;
        if (type && manifest.profile.type !== type) continue;
        profiles.push(projectProfile(manifest));
    }
    return profiles;
}

// ---------------------------------------------------------------------------
// Installation methods & artifacts
// ---------------------------------------------------------------------------

function strictestMinimum(manifests, component) {
    let max = null;
    for (const m of manifests) {
        const spec = (m.runtime_requirements || {})[component] || {};
        if (spec.minimum && (max === null || resolver.compareVersions(spec.minimum, max) === 1)) {
            max = spec.minimum;
        }
    }
    return max;
}

/**
 * Probe the hub for the artifacts it actually serves (task Phase 3.1:
 * available=true ONLY when the artifact genuinely exists). Each artifact's
 * sha256 endpoint is the authority: reachable + 200 ⇒ available with the
 * real version/sha256; anything else ⇒ unavailable (no fake download URLs).
 *
 * @returns {Promise<{worker_bundle: object, installer: object}>}
 *   each: { available, status, version, sha256, bytes, files? }
 */
async function probeHubArtifacts({ hubUrl = null, fetchImpl = null, timeoutMs = 2500 } = {}) {
    const unavailable = { available: false, status: 'unavailable', version: null, sha256: null, bytes: null };
    const result = { worker_bundle: { ...unavailable }, installer: { ...unavailable } };
    if (!hubUrl) return result;
    const doFetch = fetchImpl || ((url, opts) => fetch(url, opts));
    const targets = [
        ['worker_bundle', `${String(hubUrl).replace(/\/$/, '')}/worker-bundle/sha256`],
        ['installer', `${String(hubUrl).replace(/\/$/, '')}/installer/sha256`],
    ];
    await Promise.all(targets.map(async ([key, url]) => {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            const res = await doFetch(url, { signal: controller.signal });
            clearTimeout(timer);
            if (!res || !res.ok) return;
            const body = await res.json();
            if (body && typeof body.sha256 === 'string') {
                result[key] = {
                    available: true,
                    status: 'available',
                    sha256: body.sha256,
                    version: typeof body.version === 'string' ? body.version : null,
                    bytes: typeof body.bytes === 'number' ? body.bytes : null,
                    files: Array.isArray(body.files) ? body.files : undefined,
                };
            }
        } catch (_) { /* hub unreachable — artifact stays unavailable */ }
    }));
    return result;
}

/**
 * Installation methods metadata (task §4): which platform has which
 * lifecycle artifacts. No file extensions, shells or commands here — pure
 * availability metadata the UI renders.
 *
 * Availability is REAL (Phase 3.1): `probe` carries the hub probe result —
 * an artifact is available=true only if the hub actually serves it. The
 * version is taken from the probe (what the hub publishes); the canonical
 * repo package.json is the fallback when the probe is unavailable.
 * download_url is present ONLY for available artifacts — no fake URLs.
 *
 * `status` values: available | draft (implemented, E2E acceptance pending)
 * | planned (not implemented) | unavailable (not served by this deployment).
 */
function getInstallationMethods({ registry = defaultRegistry, probe = null } = {}) {
    const manifests = Object.values(registry.all()).filter((m) => !isHiddenManifest(m));
    const profileIds = manifests.map((m) => m.profile.id).sort();
    const workerBundleFiles = manifests.length > 0 ? (manifests[0].worker_bundle.files || []).slice() : [];
    const p = probe || {
        worker_bundle: { available: false, status: 'unavailable', version: null, sha256: null },
        installer: { available: false, status: 'unavailable', version: null, sha256: null },
    };

    const installerAvailable = !!(p.installer && p.installer.available);
    const bundleAvailable = !!(p.worker_bundle && p.worker_bundle.available);

    const linux = {
        platform: 'linux',
        architectures: ['x86_64'],
        // Capability model: the platform is available when AT LEAST ONE
        // lifecycle artifact is served. A missing installer must not block
        // the Existing ComfyUI flow (worker bundle only) — the UI derives
        // per-mode availability from the artifact flags below.
        status: (installerAvailable || bundleAvailable) ? 'available' : 'unavailable',
        installer: {
            available: installerAvailable,
            // Installer code exists and its tests pass, but E2E acceptance on
            // real GPU hardware is still pending — honest draft marker.
            status: installerAvailable ? 'draft' : 'unavailable',
            version: (p.installer && p.installer.version) || getInstallerVersion(),
            download_url: installerAvailable ? '/gpu/installer' : null,
            sha256: (p.installer && p.installer.sha256) || null,
            signature: null,
            signature_algorithm: null,
        },
        uninstaller: {
            // The Linux uninstaller does not exist yet (a separate lifecycle
            // artifact with its own ownership model — never assumed to be
            // "install --remove"). Schema-ready for available=true later.
            available: false,
            status: 'planned',
            version: null,
            download_url: null,
            sha256: null,
            signature: null,
            signature_algorithm: null,
        },
        worker_bundle: {
            available: bundleAvailable,
            status: bundleAvailable ? 'available' : 'unavailable',
            version: (p.worker_bundle && p.worker_bundle.version) || getWorkerBundleVersion(),
            download_url: bundleAvailable ? '/gpu/worker-bundle' : null,
            sha256: (p.worker_bundle && p.worker_bundle.sha256) || null,
            files: workerBundleFiles,
        },
        supported_profiles: profileIds,
        minimum_requirements: {
            node: strictestMinimum(manifests, 'nodejs'),
            python: strictestMinimum(manifests, 'python'),
            gpu: 'NVIDIA GPU with a CUDA-capable driver (detected by the installer; never installed/upgraded by it)',
        },
    };

    const planned = (platform) => ({
        platform,
        architectures: platform === 'windows' ? ['x86_64'] : [],
        status: 'planned',
        installer: {
            available: false, status: 'planned', version: null,
            download_url: null, sha256: null, signature: null, signature_algorithm: null,
        },
        uninstaller: {
            available: false, status: 'planned', version: null,
            download_url: null, sha256: null, signature: null, signature_algorithm: null,
        },
        worker_bundle: {
            // The bundle itself is platform-neutral (Node.js); it becomes
            // "available" for a platform together with its installer.
            available: false, status: 'planned', version: null,
            download_url: null, sha256: null, files: [],
        },
        supported_profiles: profileIds,
        minimum_requirements: null,
    });

    return { methods: [linux, planned('windows'), planned('docker')] };
}

/**
 * Artifact summary for one platform (task §5/§6). Unknown platform → null
 * (the route answers 404 unsupported_platform).
 */
function getPlatformArtifacts({ platform = 'linux', registry = defaultRegistry, probe = null } = {}) {
    if (!PLATFORMS.includes(platform)) return null;
    const { methods } = getInstallationMethods({ registry, probe });
    const method = methods.find((m) => m.platform === platform);
    return {
        platform: method.platform,
        architecture: method.architectures[0] || null,
        status: method.status,
        installer: method.installer,
        uninstaller: method.uninstaller,
        worker_bundle: method.worker_bundle,
        supported_profiles: method.supported_profiles,
    };
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/**
 * UI-safe workflow metadata (task §8). Baseline workflows are EDITABLE
 * starting points — never immutable. No resolver internals, no repository
 * paths; download_url is the public hub endpoint.
 *
 * Phase 3.1 honesty: `baseline_available` is true ONLY when the canonical
 * workflow file actually exists in the repo tree the hub serves; otherwise
 * download_url/sha256 are null (no fake downloads). `revision` is the
 * manifest revision — the canonical workflow artifact version.
 */
function listWorkflowArtifacts({ profileId = null, registry = defaultRegistry, workflowsRoot = null } = {}) {
    const root = workflowsRoot || path.join(MANIFEST_ROOT, '..', 'workflows');
    const manifests = registry.all();
    const out = [];
    for (const id of Object.keys(manifests).sort()) {
        const manifest = manifests[id];
        if (isHiddenManifest(manifest)) continue;
        if (profileId && manifest.profile.id !== profileId) continue;
        const artifacts = (manifest.workflows && manifest.workflows.artifacts) || [];
        for (const wf of artifacts) {
            const wfId = String(wf.id).replace(/^workflow:/, '');
            let available = false;
            try {
                available = fs.existsSync(path.join(root, wf.filename));
            } catch (_) { available = false; }
            out.push({
                id: wfId,
                name: wf.name,
                profile_id: manifest.profile.id,
                revision: manifest.revision || null,
                baseline_available: available,
                download_url: available ? `/gpu/workflow/${wfId}` : null,
                sha256: available ? (wf.baseline_sha256 || null) : null,
                editable: wf.editable !== false,
            });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Instructions (server-assembled; the frontend only renders)
// ---------------------------------------------------------------------------

function envTemplateBlock(manifests, { hubUrl = null } = {}) {
    const wb = manifests[0] && manifests[0].worker_bundle;
    const required = (wb && wb.env && wb.env.required) || ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'];
    const secrets = (wb && wb.env && wb.env.secrets) || ['ANIMASTOR_WORKER_TOKEN'];
    const types = new Set(manifests.map((m) => m.profile && m.profile.type).filter(Boolean));
    const workerType = types.size === 1 ? [...types][0] : null;
    const lines = required.map((key) => {
        if (secrets.includes(key)) return `${key}=<your-worker-key>`;
        if (key === 'HUB_URL') return hubUrl ? `HUB_URL=${hubUrl}` : `${key}=<hub-url>`;
        if (key === 'WORKER_TYPE') return workerType ? `WORKER_TYPE=${workerType}` : `${key}=<worker-type>`;
        if (key === 'WORKER_ID') return `${key}=<worker-id>`;
        return `${key}=<value>`;
    });
    return lines.join('\n');
}

/**
 * Dynamic setup instructions (task §9, Phase 3.2 bootstrap flow). Nothing is
 * hardcoded in the frontends: commands, versions and checksums come from
 * canonical metadata. The Worker Key is referenced by placeholder ONLY — its
 * value never enters this response (it is disclosed once by
 * POST /api/v1/workers and entered on the GPU machine through the
 * installer's hidden prompt).
 *
 * Logical model (the worker is ALREADY created when these instructions are
 * rendered — no "create the worker" step exists here):
 *
 *   1. download the bootstrap script (profile/mode embedded in the URL —
 *      the user never types them);
 *   2. run it — it downloads + checksum-verifies the installer bundle,
 *      unpacks it and runs the real installer, which asks for the Worker
 *      Key interactively (hidden input);
 *   3. return to this page — the worker goes ONLINE after its first
 *      heartbeat (~30s). A terminal diagnostics command is provided as
 *      optional secondary info (verify_command), not as a required step.
 *
 * @param {{profileIds: string[], platform?: string, mode?: string,
 *          origin?: string, registry?: object, probe?: object}} args
 */
function buildInstructions({
    profileIds,
    platform = 'linux',
    mode = 'managed',
    origin = '',
    registry = defaultRegistry,
    probe = null,
}) {
    if (!Array.isArray(profileIds) || profileIds.length === 0) {
        const err = new Error('profile_ids is required (non-empty array)');
        err.code = 'invalid_profile';
        throw err;
    }
    if (!PLATFORMS.includes(platform)) {
        const err = new Error(`unsupported platform "${platform}" (expected one of ${PLATFORMS.join(', ')})`);
        err.code = 'unsupported_platform';
        throw err;
    }
    if (!INSTALL_MODES.includes(mode)) {
        const err = new Error(`unsupported mode "${mode}" (expected one of ${INSTALL_MODES.join(', ')})`);
        err.code = 'invalid_mode';
        throw err;
    }
    const manifests = profileIds.map((id) => {
        const m = registry.get(id);
        if (!m || isHiddenManifest(m)) {
            const err = new Error(`unknown profile "${id}"`);
            err.code = 'invalid_profile';
            throw err;
        }
        return m;
    });

    const artifacts = getPlatformArtifacts({ platform, registry, probe });
    const base = String(origin || '').replace(/\/$/, '');
    const hubUrl = base ? `${base}/gpu` : null;
    const steps = [];

    const response = {
        platform,
        mode,
        profile_ids: profileIds,
        worker_key_policy: {
            disclosed_once: true,
            disclosed_by: 'POST /api/v1/workers (create) or POST /api/v1/workers/:id/rotate',
            entered_on: 'GPU machine — the installer asks interactively (hidden input)',
            never: ['setup contract responses', 'logs', 'argv', 'URLs', 'installer state files'],
        },
        env: {
            required: (manifests[0].worker_bundle.env && manifests[0].worker_bundle.env.required) || [],
            secrets: (manifests[0].worker_bundle.env && manifests[0].worker_bundle.env.secrets) || ['ANIMASTOR_WORKER_TOKEN'],
            template_block: envTemplateBlock(manifests, { hubUrl }),
        },
        // Installer artifact metadata for the UI: version is the primary UX
        // line; the sha256 belongs in a collapsed/secondary block (shown ONCE).
        installer: null,
        steps,
        // Optional terminal diagnostics — never a required step: the page
        // itself shows the worker status (ONLINE after the first heartbeat).
        verify_command: null,
    };

    const installerAvailable = !!(artifacts && artifacts.installer.available);
    const bundle = artifacts && artifacts.worker_bundle;
    const bundleAvailable = !!(bundle && bundle.available);

    if (!installerAvailable) {
        if (mode === 'existing' && bundleAvailable) {
            // Existing ComfyUI without the installer: the worker runtime
            // bundle alone is enough to connect an already installed ComfyUI.
            // One bundle download — never manual per-file instructions.
            steps.push({
                id: 'prerequisites',
                title: 'Existing ComfyUI — what you need',
                body: 'Your ComfyUI stays untouched — the worker bundle only connects it to Animastor. Nothing is replaced, downgraded or removed.',
                requirements: {
                    comfyui: 'installed and running (the worker finds it at http://127.0.0.1:8188; override with COMFY_PORT)',
                    node: `>= ${(artifacts.minimum_requirements && artifacts.minimum_requirements.node) || '20'} (for the worker runtime)`,
                    gpu: 'NVIDIA GPU with a CUDA-capable driver',
                },
            });
            const bundleFile = `animastor-worker-${bundle.version || 'latest'}.tar.gz`;
            steps.push({
                id: 'download-bundle',
                title: 'Download the worker runtime bundle',
                body: `Download the worker runtime bundle (version ${bundle.version}). It contains the complete worker runtime — no manual per-file downloads.`,
                code: `curl -fsSL -o ${bundleFile} ${base}${bundle.download_url}`,
                checksum: bundle.sha256
                    ? { algorithm: 'sha256', value: bundle.sha256, verify_code: `echo "${bundle.sha256}  ${bundleFile}" | sha256sum -c -` }
                    : null,
            });
            steps.push({
                id: 'unpack-bundle',
                title: 'Unpack the bundle',
                body: 'Unpack the bundle on the GPU machine (e.g. next to your ComfyUI installation).',
                code: `tar -xzf ${bundleFile} && cd animastor-worker`,
            });
            steps.push({
                id: 'configure-worker',
                title: 'Configure the worker',
                body: 'Copy the environment template and fill in your Worker Key (shown once above) — the key value never passes through this contract. HUB_URL is this site address + /gpu.',
                code: `cp .env.example .env\n# then edit .env:\n${envTemplateBlock(manifests, { hubUrl })}`,
            });
            steps.push({
                id: 'start-worker',
                title: 'Start the worker',
                body: 'Start the worker and keep it running (e.g. in tmux/screen or as a systemd service). It verifies the credential, finds your ComfyUI and connects to the hub.',
                code: 'node worker.cjs',
            });
            steps.push({
                id: 'verify',
                title: 'Verify',
                body: 'Return to Settings → Private Workers: the worker status changes CONNECTING → ONLINE within ~30 seconds after the worker starts.',
            });
            return response;
        }
        if (bundleAvailable) {
            // Installer missing but the bundle is served — do not block the
            // whole platform: point at the Existing ComfyUI flow instead.
            steps.push({
                id: 'installer-unavailable',
                title: 'Installer temporarily unavailable',
                body: `The ${platform} installer is temporarily unavailable. Existing ComfyUI setup may still be available — choose the "Existing ComfyUI" mode: the worker runtime bundle is served by this deployment.`,
            });
            return response;
        }
        steps.push({
            id: 'platform-planned',
            title: 'Installation is not available on this platform yet',
            body: `The ${platform} installer is planned but not published. The setup contract will expose it automatically (available=true) once it exists — no frontend change is needed.`,
        });
        return response;
    }

    // ── Bootstrap flow (installer artifact is served by the hub) ────────

    const profileParam = encodeURIComponent(profileIds.join(','));
    const bootstrapUrl = `${base}/gpu/installer?profile=${profileParam}&mode=${mode}`;
    response.installer = {
        version: artifacts.installer.version,
        sha256: artifacts.installer.sha256 || null,
        status: artifacts.installer.status || 'available',
        download_url: bootstrapUrl,
    };
    response.verify_command = '$HOME/animastor/tools/status.sh';

    if (mode === 'existing') {
        steps.push({
            id: 'prerequisites',
            title: 'Existing ComfyUI — what the installer expects',
            body: 'The installer detects your ComfyUI, Python, Torch, CUDA, GPU, custom nodes, models and workflows itself, then proposes only what is missing. It never replaces, downgrades or removes your components automatically.',
            requirements: {
                comfyui: 'installed (any version — detected and compared, never auto-replaced)',
                python: `>= ${artifacts.minimum_requirements && artifacts.minimum_requirements.python || '3.10'}`,
                torch: 'installed with CUDA support (detected; never auto-replaced)',
                gpu: 'NVIDIA GPU with a CUDA-capable driver',
                node: `>= ${artifacts.minimum_requirements && artifacts.minimum_requirements.node || '20'} (for the installer runtime)`,
            },
        });
    }

    if (mode === 'isolated') {
        // Isolated mode = several independent ComfyUI environments — one
        // installer run per profile into its own root. That is beyond what a
        // single embedded-profile bootstrap run can express, so this
        // power-user path keeps the explicit bundle flow (bootstrap is the
        // canonical path for the wizard modes managed/existing).
        const bundleUrl = `${base}/gpu/installer/bundle`;
        const installerFile = `animastor-installer-${artifacts.installer.version}.tar.gz`;
        response.installer = {
            version: artifacts.installer.version,
            sha256: artifacts.installer.sha256 || null,
            status: artifacts.installer.status || 'available',
            download_url: bundleUrl,
        };
        steps.push({
            id: 'download-bootstrap',
            title: 'Download the installer',
            body: `Download the installer package (version ${artifacts.installer.version}).`,
            code: `curl -fsSL -o ${installerFile} ${bundleUrl}`,
            checksum: artifacts.installer.sha256
                ? { algorithm: 'sha256', value: artifacts.installer.sha256, verify_code: `echo "${artifacts.installer.sha256}  ${installerFile}" | sha256sum -c -` }
                : null,
        });
        steps.push({
            id: 'run-bootstrap',
            title: 'Run the installer (once per profile)',
            body: 'Isolated mode: run the installer once per profile, each into its own root directory. The Worker Key is asked interactively (hidden input) on each run.',
            code: profileIds
                .map((p) => `tar -xzf ${installerFile} && node animastor-installer/src/installer/cli.js install --profile ${p} --mode managed --root "$HOME/animastor/isolated/${p.split('/').pop()}"`)
                .join('\n'),
        });
        steps.push({
            id: 'verify',
            title: 'Verify',
            body: 'After the installer finishes the workers connect to Animastor automatically. Return to Settings → Private Workers: the status changes to ONLINE after the first heartbeat, usually within ~30 seconds.',
        });
        return response;
    }

    steps.push({
        id: 'download-bootstrap',
        title: 'Download the installer',
        body: `Download the bootstrap installer (installer version ${artifacts.installer.version}). The profile and connection mode you selected here are already embedded — nothing needs to be typed.`,
        code: `curl -fsSL -o animastor-installer.sh ${bootstrapUrl}`,
    });

    steps.push({
        id: 'run-bootstrap',
        title: 'Run the installer',
        body: 'The installer itself downloads and verifies all components (ComfyUI, models, worker), then asks for the Worker Key (hidden input) — paste the key saved above.',
        code: 'bash animastor-installer.sh',
    });

    steps.push({
        id: 'verify',
        title: 'Verify',
        body: 'After the installer finishes the worker connects to Animastor automatically. Return to Settings → Private Workers: the status changes to ONLINE after the first heartbeat, usually within ~30 seconds.',
    });

    return response;
}

// ---------------------------------------------------------------------------
// Worker status adapter & capabilities normalization
// ---------------------------------------------------------------------------

/**
 * Adapt the existing derived status (ONLINE/OFFLINE/REVOKED) to the
 * extended UI-safe model. A worker that was created but never seen has no
 * heartbeat yet — it is CONNECTING (installed-and-starting or still being
 * set up). NOT_CONFIGURED is frontend-level (no worker record); INSTALLING
 * and ERROR await future installer check-in / worker error signals.
 */
function adaptSetupStatus({ status, last_seen = null }) {
    if (status === 'REVOKED') return 'REVOKED';
    if (status === 'ONLINE') return 'ONLINE';
    if (last_seen == null) return 'CONNECTING';
    return 'OFFLINE';
}

/**
 * Normalize the free-form `capabilities` jsonb into the contract shape.
 * Passes through REAL data only — never invents fields.
 * @returns {{profiles?: string[], workflows?: string[], gpu?: {name: string|null, vram_gb: number|null}}|null}
 */
function normalizeCapabilities(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    if (Array.isArray(raw.profiles)) {
        out.profiles = raw.profiles.filter((p) => typeof p === 'string');
    }
    if (Array.isArray(raw.workflows)) {
        out.workflows = raw.workflows.filter((w) => typeof w === 'string');
    }
    if (raw.gpu && typeof raw.gpu === 'object' && !Array.isArray(raw.gpu)) {
        let vramGb = null;
        if (typeof raw.gpu.vram_gb === 'number') vramGb = raw.gpu.vram_gb;
        else if (typeof raw.gpu.vram_mib === 'number') vramGb = Math.round((raw.gpu.vram_mib / 1024) * 10) / 10;
        out.gpu = {
            name: typeof raw.gpu.name === 'string' ? raw.gpu.name : null,
            vram_gb: vramGb,
        };
    }
    return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Installation plan (UI-safe; NO execution — task §16)
// ---------------------------------------------------------------------------

const RUNTIME_LABELS = Object.freeze({
    comfyui: 'ComfyUI',
    torch: 'Torch',
    python: 'Python',
    nodejs: 'Node.js',
    nvidia_driver: 'NVIDIA driver',
});

function mapEntryToAction(entry, { mode, downloadSpecs }) {
    const conditional = mode === 'existing' || mode === 'isolated';
    const base = {
        component: null,
        name: null,
        profiles: entry.profiles || [],
        conditional,
    };
    switch (entry.kind) {
        case 'runtime': {
            if (entry.component === 'nvidia_driver') return null; // detected only, never installed
            if (entry.status === 'installed') return { ...base, type: 'KEEP', component: 'runtime', name: RUNTIME_LABELS[entry.component] || entry.component };
            if (entry.status === 'missing' || entry.action === 'install') {
                return { ...base, type: 'INSTALL', component: 'runtime', name: RUNTIME_LABELS[entry.component] || entry.component };
            }
            return { ...base, type: 'REVIEW', component: 'runtime', name: RUNTIME_LABELS[entry.component] || entry.component };
        }
        case 'custom_node': {
            if (entry.status === 'installed') return { ...base, type: 'KEEP', component: 'custom-node', name: entry.name || entry.id };
            if (entry.requirement !== 'required') return null; // optional/unknown extras are never auto-installed
            return { ...base, type: 'INSTALL', component: 'custom-node', name: entry.name || entry.id };
        }
        case 'model':
        case 'model_repo': {
            if (entry.status === 'installed') return { ...base, type: 'KEEP', component: 'model', name: entry.name || entry.id };
            if (entry.requirement !== 'required') return null;
            const spec = downloadSpecs.get(entry.id);
            return {
                ...base,
                type: 'DOWNLOAD',
                component: 'model',
                name: entry.name || entry.id,
                blocked: spec ? !spec.ready : true,
                size_bytes_approx: spec ? spec.size_bytes_approx : null,
            };
        }
        case 'workflow': {
            if (entry.status === 'installed') return { ...base, type: 'KEEP', component: 'workflow', name: entry.name || entry.id, editable: true };
            return { ...base, type: 'DOWNLOAD', component: 'workflow', name: entry.name || entry.id, editable: true };
        }
        case 'worker': {
            if (entry.status === 'installed' && entry.action === 'skip') return { ...base, type: 'KEEP', component: 'worker-bundle', name: `Animastor worker (${entry.worker_type})` };
            if (entry.action === 'configure') {
                return { ...base, type: 'CONFIGURE', component: 'worker-env', name: 'Worker configuration (Worker Key entered on the GPU machine — never via this API)' };
            }
            return { ...base, type: 'INSTALL', component: 'worker-bundle', name: `Animastor worker (${entry.worker_type})` };
        }
        default:
            return null;
    }
}

/**
 * Build a UI-safe installation plan preview (task §16). This is a PROPOSAL
 * computed from canonical manifests + resolver against a clean environment —
 * it never starts an installation and never touches any machine. On
 * mode=existing the real detection happens on the GPU machine; actions are
 * marked conditional.
 */
function buildSetupPlan({ profileIds, mode, platform = 'linux', registry = defaultRegistry }) {
    if (!Array.isArray(profileIds) || profileIds.length === 0) {
        const err = new Error('profile_ids is required (non-empty array)');
        err.code = 'invalid_profile';
        throw err;
    }
    if (!INSTALL_MODES.includes(mode)) {
        const err = new Error(`unsupported mode "${mode}" (expected one of ${INSTALL_MODES.join(', ')})`);
        err.code = 'invalid_mode';
        throw err;
    }
    if (platform != null && !PLATFORMS.includes(platform)) {
        const err = new Error(`unsupported platform "${platform}" (expected one of ${PLATFORMS.join(', ')})`);
        err.code = 'unsupported_platform';
        throw err;
    }
    const manifests = profileIds.map((id) => {
        const m = registry.get(id);
        if (!m || isHiddenManifest(m)) {
            const err = new Error(`unknown profile "${id}"`);
            err.code = 'invalid_profile';
            throw err;
        }
        return m;
    });
    if (mode === 'shared' && manifests.length < 2) {
        const err = new Error("mode 'shared' requires at least two profiles");
        err.code = 'invalid_mode';
        throw err;
    }

    const warnings = [];
    const blocks = [];

    // Platform gate: no non-linux installer exists yet — honest BLOCKED.
    if (platform && platform !== 'linux') {
        return {
            result: 'BLOCKED',
            platform,
            mode,
            profiles: profileIds,
            actions: [],
            warnings,
            blocks: [{
                code: 'PLATFORM_NOT_SUPPORTED',
                message: `Installation on "${platform}" is planned but not available yet (no installer artifact published).`,
            }],
            sharing: null,
            disk_budget_bytes_approx: null,
        };
    }

    // Sharing verdict (multi-profile) — machine-readable (task §15).
    let sharing = null;
    if (manifests.length > 1) {
        const shared = resolver.resolveSharedRuntime(manifests);
        sharing = {
            verdict: SHARING_VERDICT_MAP[shared.verdict] || 'UNKNOWN',
            can_share: shared.can_share,
            message: shared.message,
        };
        if (!shared.can_share) warnings.push(shared.message);
    }

    // Isolated mode: each profile is planned in its own environment
    // (data model only — no multi-ComfyUI orchestration in Phase 3).
    const reports = [];
    if (mode === 'isolated') {
        for (const m of manifests) {
            reports.push(resolver.resolveInstallation({
                manifests: m,
                environment: resolver.createEmptyEnvironment(`isolated/${m.profile.id}`),
                mode: 'isolated',
            }));
        }
        if (manifests.length > 1 && !sharing) {
            sharing = {
                verdict: 'REQUIRES_ISOLATION',
                can_share: false,
                message: 'isolated mode: each profile gets its own ComfyUI environment by definition',
            };
        }
    } else {
        reports.push(resolver.resolveInstallation({
            manifests,
            environment: resolver.createEmptyEnvironment(),
            mode: mode === 'shared' ? 'shared' : mode,
        }));
    }

    // Download specs for missing models — NEVER invent URLs: unresearched
    // sources become explicit blocks (installer would report BLOCKED too).
    const downloadSpecs = new Map();
    for (const report of reports) {
        for (const entry of report.entries) {
            if ((entry.kind === 'model' || entry.kind === 'model_repo')
                && entry.status === 'missing' && entry.requirement === 'required'
                && !downloadSpecs.has(entry.id)) {
                const dep = manifests.flatMap((m) => m.dependencies || []).find((d) => d.id === entry.id);
                if (dep) {
                    const spec = planModelDownload(dep);
                    downloadSpecs.set(entry.id, spec);
                    if (!spec.ready) {
                        blocks.push({
                            code: 'MODEL_SOURCE_NOT_PUBLISHED',
                            message: `${dep.name || dep.id}: download source is not researched yet — the installer refuses to guess URLs (manifest status: ${manifests.find((m) => (m.dependencies || []).some((d) => d.id === dep.id)).status || 'draft'})`,
                        });
                    }
                }
            }
        }
    }

    const actions = [];
    const seen = new Set();
    for (const report of reports) {
        for (const entry of report.entries) {
            if (entry.id.startsWith('extra:')) continue; // extras are never part of a plan
            const action = mapEntryToAction(entry, { mode, downloadSpecs });
            if (!action) continue;
            const key = `${action.type}|${action.component}|${action.name}|${action.profiles.join(',')}`;
            if (seen.has(key)) continue;
            seen.add(key);
            actions.push(action);
        }
        for (const w of report.warnings) {
            if (!warnings.includes(w)) warnings.push(w);
        }
    }

    // Worker Key configuration is always an interactive on-machine step.
    actions.push({
        type: 'CONFIGURE',
        component: 'worker-env',
        name: 'Worker configuration (Worker Key entered on the GPU machine — never via this API)',
        profiles: profileIds.slice(),
        conditional: false,
    });
    actions.push({
        type: 'VERIFY',
        component: 'verification',
        name: 'Post-install verification (resolver diff + registration check)',
        profiles: profileIds.slice(),
        conditional: false,
    });

    for (const m of manifests) {
        if ((m.status || 'draft') !== 'stable') {
            warnings.push(`profile ${m.profile.id} is "${m.status || 'draft'}" — E2E acceptance on real GPU hardware is pending`);
        }
        if ((m.hardware || {}).gpu_min_vram_gb == null) {
            warnings.push(`profile ${m.profile.id}: minimum VRAM is unknown — preflight must measure, no automatic judgement`);
        }
    }
    if (mode === 'existing') {
        warnings.push('plan computed against a clean environment — on your machine the installer detects ComfyUI/Python/Torch/CUDA/nodes/models itself and installs only what is missing; user components are never replaced or removed automatically');
    }

    const diskBudget = manifests.reduce(
        (sum, m) => sum + ((m.disk_budget && m.disk_budget.models_bytes_approx) || 0), 0
    );

    let result = 'READY';
    if (blocks.length > 0) result = 'BLOCKED';
    else if (warnings.length > 0) result = 'READY_WITH_WARNINGS';

    return {
        result,
        platform: platform || 'linux',
        mode,
        profiles: profileIds,
        actions,
        warnings,
        blocks,
        sharing,
        disk_budget_bytes_approx: diskBudget > 0 ? diskBudget : null,
    };
}

module.exports = {
    PLATFORMS,
    INSTALL_MODES,
    SETUP_WORKER_STATUSES,
    SHARING_VERDICT_MAP,
    getInstallerVersion,
    getWorkerBundleVersion,
    createManifestRegistry,
    getManifestRegistry,
    isHiddenManifest,
    listSetupProfiles,
    getInstallationMethods,
    getPlatformArtifacts,
    probeHubArtifacts,
    listWorkflowArtifacts,
    buildInstructions,
    adaptSetupStatus,
    normalizeCapabilities,
    buildSetupPlan,
    // exposed for tests
    projectProfile,
    displayNameFromSlug,
    loadManifest,
};
