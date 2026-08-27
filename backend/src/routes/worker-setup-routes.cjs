// ======================================================
// ANIMASTOR BACKEND — PRIVATE WORKER SETUP CONTRACT ROUTES (Phase 3)
// ======================================================
// The unified, UI-safe setup contract consumed by BOTH frontends (Web and
// Android). It complements — never replaces — the existing worker API:
//
//   existing (unchanged):                 setup contract (this file):
//     POST   /api/v1/workers                GET  /api/v1/private-worker/setup/profiles
//     GET    /api/v1/workers                GET  /api/v1/private-worker/setup/methods
//     GET    /api/v1/workers/:id            GET  /api/v1/private-worker/setup/artifacts
//     POST   /api/v1/workers/:id/rotate     GET  /api/v1/private-worker/setup/workflows
//     DELETE /api/v1/workers/:id            GET  /api/v1/private-worker/setup/instructions
//     POST   /api/v1/worker/verify          GET  /api/v1/private-worker/setup/workers/:id
//                                           POST /api/v1/private-worker/setup/plan
//
// Division of labour: the setup contract answers "what to download, how to
// install, which profile to pick, how to verify" — worker CREATION and the
// one-time Worker Key disclosure stay with POST /api/v1/workers. The setup
// contract NEVER returns the token, the token_hash, or any secret.
//
// Security model (identical to worker-routes.cjs):
//   - registered users only (guests 403, anonymous 401);
//   - workspace_id always resolved server-side from the session;
//   - setup/workers/:id answers one indistinct 404 for foreign/unknown ids
//     (no existence oracle);
//   - all metadata is projected from canonical installer manifests by
//     installer/setup-contract.js — raw manifests, internal source URLs,
//     resolver internals and credentials never leave the backend;
//   - download URLs are origin-relative constants authored by the backend;
//     the client cannot supply or alter them.
//
// Usage:
//   require('./routes/worker-setup-routes.cjs')(app, redis, opts?);

const workerRepo = require('../storage/postgres/repositories/worker-repo');
const config = require('../config/runtime-config');
const setupContract = require('../installer/setup-contract');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Users-only guard; returns the caller's workspace id or answers 401/403. */
function setupGuard(req, res) {
    if (!req.user) {
        res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
        return null;
    }
    if (req.guest) {
        res.status(403).json({ error: 'Guests cannot manage workers', code: 'guest_forbidden' });
        return null;
    }
    if (!req.workspace || !req.workspace.id) {
        res.status(401).json({ error: 'Workspace not resolved', code: 'workspace_unresolved' });
        return null;
    }
    return req.workspace.id;
}

/** Derived liveness (same rules as worker-routes.cjs — fail closed). */
async function liveInfo(redis, row) {
    if (row.revoked_at != null) {
        return { status: 'REVOKED', last_seen: null };
    }
    try {
        const key = config.WORKER_HEARTBEAT_KEY(row.worker_type, row.worker_id);
        const raw = await redis.get(key);
        if (raw) {
            let ts = null;
            try { ts = JSON.parse(raw).ts; } catch (_) { /* keep null */ }
            return { status: 'ONLINE', last_seen: (typeof ts === 'number' ? ts : Date.now()) };
        }
    } catch (_) { /* non-fatal — treat as offline */ }
    return { status: 'OFFLINE', last_seen: row.last_seen != null ? Number(row.last_seen) : null };
}

/** Contract error → HTTP status mapping (thrown by setup-contract.js). */
function statusForContractError(err) {
    switch (err.code) {
        case 'invalid_profile': return 400;
        case 'invalid_mode': return 400;
        case 'unsupported_platform': return 404;
        default: return 400;
    }
}

module.exports = function(app, redis, opts = {}) {
    // Injectable for tests; in production the hub is reached via HUB_URL
    // (backend → hub, no /gpu prefix — nginx adds it for browsers).
    const hubUrlResolver = opts.hubUrlResolver || (() => config.HUB_URL);
    const fetchImpl = opts.fetchImpl || null;
    const registry = opts.registry || setupContract.getManifestRegistry();

    // Artifact availability is REAL: the hub is probed for each artifact's
    // sha256 endpoint (available=true only what the hub actually serves).
    // Probed at most once per PROBE_TTL_MS to keep the metadata endpoints
    // light; a hub outage degrades to available=false (honest, not fake).
    const PROBE_TTL_MS = typeof opts.probeTtlMs === 'number' ? opts.probeTtlMs : 30_000;
    let probeCache = { ts: 0, promise: null };
    function probe() {
        const now = Date.now();
        if (!probeCache.promise || now - probeCache.ts > PROBE_TTL_MS) {
            probeCache = {
                ts: now,
                promise: setupContract.probeHubArtifacts({ hubUrl: hubUrlResolver(), fetchImpl }),
            };
        }
        return probeCache.promise;
    }

    // ── GET setup profiles (canonical installer metadata, UI-safe) ──────
    app.get('/api/v1/private-worker/setup/profiles', async (req, res) => {
        if (!setupGuard(req, res)) return;
        const type = typeof req.query.type === 'string' ? req.query.type : null;
        if (type && !['audio', 'image', 'video'].includes(type)) {
            return res.status(400).json({ error: 'type must be one of: audio, image, video', code: 'invalid_type' });
        }
        try {
            const profiles = setupContract.listSetupProfiles({ type, registry });
            res.json({ profiles });
        } catch (err) {
            console.error('[WORKER-SETUP] profiles failed:', err.message);
            res.status(500).json({ error: 'Failed to load setup profiles' });
        }
    });

    // ── GET installation methods (platforms × lifecycle artifacts) ──────
    app.get('/api/v1/private-worker/setup/methods', async (req, res) => {
        if (!setupGuard(req, res)) return;
        try {
            const sums = await probe();
            res.json(setupContract.getInstallationMethods({ registry, probe: sums }));
        } catch (err) {
            console.error('[WORKER-SETUP] methods failed:', err.message);
            res.status(500).json({ error: 'Failed to load installation methods' });
        }
    });

    // ── GET artifacts for one platform (installer/uninstaller/bundle) ───
    app.get('/api/v1/private-worker/setup/artifacts', async (req, res) => {
        if (!setupGuard(req, res)) return;
        const platform = typeof req.query.platform === 'string' ? req.query.platform : 'linux';
        try {
            const sums = await probe();
            const artifacts = setupContract.getPlatformArtifacts({ platform, registry, probe: sums });
            if (!artifacts) {
                return res.status(404).json({
                    error: `unsupported platform "${platform}"`,
                    code: 'unsupported_platform',
                    supported: setupContract.PLATFORMS.slice(),
                });
            }
            res.json(artifacts);
        } catch (err) {
            console.error('[WORKER-SETUP] artifacts failed:', err.message);
            res.status(500).json({ error: 'Failed to load artifacts' });
        }
    });

    // ── GET workflow metadata (editable baselines) ───────────────────────
    app.get('/api/v1/private-worker/setup/workflows', async (req, res) => {
        if (!setupGuard(req, res)) return;
        const profileId = typeof req.query.profile_id === 'string' ? req.query.profile_id : null;
        try {
            if (profileId) {
                const manifest = registry.get(profileId);
                if (!manifest || setupContract.isHiddenManifest(manifest)) {
                    return res.status(400).json({ error: `unknown profile "${profileId}"`, code: 'invalid_profile' });
                }
            }
            const workflows = setupContract.listWorkflowArtifacts({ profileId, registry });
            res.json({ workflows });
        } catch (err) {
            console.error('[WORKER-SETUP] workflows failed:', err.message);
            res.status(500).json({ error: 'Failed to load workflows' });
        }
    });

    // ── GET dynamic setup instructions (server-assembled) ────────────────
    app.get('/api/v1/private-worker/setup/instructions', async (req, res) => {
        if (!setupGuard(req, res)) return;
        const q = req.query;
        const profileIds = typeof q.profile_id === 'string' && q.profile_id
            ? q.profile_id.split(',').map((s) => s.trim()).filter(Boolean)
            : [];
        const platform = typeof q.platform === 'string' ? q.platform : 'linux';
        const mode = typeof q.mode === 'string' ? q.mode : 'managed';
        try {
            const sums = await probe();
            const origin = `${req.protocol}://${req.get('host')}`;
            const instructions = setupContract.buildInstructions({
                profileIds, platform, mode, origin, registry, probe: sums,
            });
            res.json(instructions);
        } catch (err) {
            if (err.code) {
                return res.status(statusForContractError(err)).json({ error: err.message, code: err.code });
            }
            console.error('[WORKER-SETUP] instructions failed:', err.message);
            res.status(500).json({ error: 'Failed to build instructions' });
        }
    });

    // ── GET worker setup status (extended UI-safe model) ─────────────────
    // Same authorization as GET /api/v1/workers/:id — caller's workspace
    // only, one indistinct 404 for foreign/unknown ids. Never returns
    // token/token_hash; at most token_prefix (already public in the list).
    app.get('/api/v1/private-worker/setup/workers/:workerId', async (req, res) => {
        const workspaceId = setupGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        try {
            const row = await workerRepo.findById(req.params.workerId);
            if (!row || row.workspace_id !== workspaceId) {
                return res.status(404).json({ error: 'Worker not found' });
            }
            const live = await liveInfo(redis, row);
            res.json({
                worker: {
                    worker_id: row.worker_id,
                    workspace_id: row.workspace_id,
                    name: row.name,
                    worker_type: row.worker_type,
                    mode: row.mode,
                    // Extended contract status (adapter over the derived
                    // ONLINE/OFFLINE/REVOKED — legacy values unchanged).
                    status: setupContract.adaptSetupStatus({ status: live.status, last_seen: live.last_seen }),
                    base_status: live.status,
                    status_model: setupContract.SETUP_WORKER_STATUSES.slice(),
                    token_prefix: row.token_prefix || null,
                    last_seen: live.last_seen,
                    revoked_at: row.revoked_at != null ? Number(row.revoked_at) : null,
                    created_at: row.created_at != null ? Number(row.created_at) : null,
                    capabilities: setupContract.normalizeCapabilities(row.capabilities),
                    // Online details (GPU/VRAM/worker version) require a hub
                    // heartbeat-payload extension — not invented meanwhile.
                    details: null,
                },
            });
        } catch (err) {
            console.error('[WORKER-SETUP] worker status failed:', err.message);
            res.status(500).json({ error: 'Failed to load worker' });
        }
    });

    // ── POST installation plan (UI-safe preview — NEVER executes) ────────
    app.post('/api/v1/private-worker/setup/plan', async (req, res) => {
        if (!setupGuard(req, res)) return;
        const body = req.body || {};
        const profileIds = Array.isArray(body.profile_ids)
            ? body.profile_ids.filter((p) => typeof p === 'string' && p.length > 0)
            : [];
        const mode = typeof body.mode === 'string' ? body.mode : null;
        const platform = body.platform === undefined ? 'linux' : body.platform;
        if (profileIds.length === 0) {
            return res.status(400).json({ error: 'profile_ids is required (non-empty array)', code: 'invalid_profile' });
        }
        if (typeof mode !== 'string') {
            return res.status(400).json({ error: 'mode is required', code: 'invalid_mode' });
        }
        if (typeof platform !== 'string') {
            return res.status(400).json({ error: 'platform must be a string', code: 'unsupported_platform' });
        }
        try {
            const plan = setupContract.buildSetupPlan({ profileIds, mode, platform, registry });
            res.json(plan);
        } catch (err) {
            if (err.code) {
                return res.status(statusForContractError(err)).json({ error: err.message, code: err.code });
            }
            console.error('[WORKER-SETUP] plan failed:', err.message);
            res.status(500).json({ error: 'Failed to build installation plan' });
        }
    });

    console.log('[ROUTES] Private worker setup contract routes loaded');
};
