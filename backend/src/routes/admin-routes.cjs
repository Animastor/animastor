// ======================================================
// ANIMASTOR BACKEND — ADMIN ROUTES (Admin Foundation)
// ======================================================
// Platform-level admin surface, guarded by requireAdmin (role='admin' OR
// ADMIN_USERNAMES allowlist). Served on admin.animastor.in behind nginx
// Basic Auth as a second layer.
//
//   GET  /api/v1/admin/system-ai        — kill switch state + provider meta
//   PUT  /api/v1/admin/system-ai        — toggle enabled and/or upsert provider
//   POST /api/v1/admin/system-ai/test   — connection test (does not save)
//
//   POST   /api/v1/admin/workers/system              — create SYSTEM worker (token ONCE)
//   GET    /api/v1/admin/workers/system              — list SYSTEM workers
//   POST   /api/v1/admin/workers/system/:id/rotate   — rotate credential (token ONCE)
//   DELETE /api/v1/admin/workers/system/:id          — revoke (immediate)
//
// SYSTEM workers are the Animastor-operated pool (promo/trials/commercial
// lanes). They are workspace-less and can ONLY be created here — the tenant
// routes reject mode='system'. The plaintext credential is returned exactly
// once (create/rotate), never afterwards.
//
// The plaintext API key is accepted on write and NEVER returned: responses
// carry only a masked value. Toggling the kill switch clears every resolver
// cache so the change applies immediately.

const systemAi = require('../services/system-ai');
const workspaceAi = require('../services/workspace-ai-provider');
const workerRepo = require('../storage/postgres/repositories/worker-repo');
const workerAuth = require('../services/worker-auth');
const config = require('../config/runtime-config');
const { requireAdmin } = require('../middleware/auth-context');
const { assertPublicEndpoint } = require('../services/url-safety');

const MAX_NAME_LEN = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeEndpoint(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!/^https?:\/\//i.test(trimmed)) return null;
    return trimmed.replace(/\/+$/, '');
}

/** Derived liveness for an admin worker row (ONLINE/OFFLINE/REVOKED). */
async function adminLiveInfo(redis, row) {
    if (row.revoked_at != null) return { status: 'REVOKED', last_seen: null };
    try {
        const raw = await redis.get(config.WORKER_HEARTBEAT_KEY(row.worker_type, row.worker_id));
        if (raw) {
            let ts = null;
            try { ts = JSON.parse(raw).ts; } catch (_) { /* keep null */ }
            return { status: 'ONLINE', last_seen: (typeof ts === 'number' ? ts : Date.now()) };
        }
    } catch (_) { /* non-fatal — offline */ }
    return { status: 'OFFLINE', last_seen: row.last_seen != null ? Number(row.last_seen) : null };
}

/** Public admin worker shape — never includes token_hash or the credential. */
async function adminPublicWorker(redis, row) {
    const live = await adminLiveInfo(redis, row);
    return {
        worker_id: row.worker_id,
        workspace_id: row.workspace_id || null,
        name: row.name,
        worker_type: row.worker_type,
        mode: row.mode,
        status: live.status,
        token_prefix: row.token_prefix || null,
        last_seen: live.last_seen,
        revoked_at: row.revoked_at != null ? Number(row.revoked_at) : null,
        created_at: row.created_at != null ? Number(row.created_at) : null,
    };
}

module.exports = function(app, redis) {

    // ── GET system AI state ─────────────────────────────────────────────
    app.get('/api/v1/admin/system-ai', requireAdmin, async (req, res) => {
        try {
            const enabled = await systemAi.isSystemAiEnabled();
            const provider = await systemAi.getSystemProviderMeta();
            res.json({ enabled, provider });
        } catch (err) {
            console.error('[ADMIN] GET system-ai failed:', err.message);
            res.status(500).json({ error: 'Failed to read system AI state' });
        }
    });

    // ── PUT toggle and/or provider upsert ───────────────────────────────
    app.put('/api/v1/admin/system-ai', requireAdmin, async (req, res) => {
        const body = req.body || {};
        try {
            let enabled;
            if (body.enabled !== undefined) {
                enabled = await systemAi.setSystemAiEnabled(!!body.enabled);
            } else {
                enabled = await systemAi.isSystemAiEnabled();
            }

            let provider = await systemAi.getSystemProviderMeta();
            if (body.provider && typeof body.provider === 'object') {
                const p = body.provider;
                const endpoint = normalizeEndpoint(p.endpoint);
                if (p.endpoint !== undefined && !endpoint) {
                    return res.status(400).json({ error: 'provider.endpoint must be a valid http(s) URL' });
                }
                if (endpoint) {
                    // SSRF guard: the admin endpoint is still user-controlled input.
                    const verdict = await assertPublicEndpoint(endpoint);
                    if (!verdict.ok) {
                        return res.status(400).json({ error: `endpoint not allowed: ${verdict.reason}` });
                    }
                }
                if (p.provider_type !== undefined && p.provider_type !== null
                    && !workspaceAi.normalizeProviderType(p.provider_type)) {
                    return res.status(400).json({ error: `provider_type must be one of: ${workspaceAi.PROVIDER_TYPES.join(', ')}` });
                }
                if (p.api_key !== undefined && p.api_key !== null
                    && (typeof p.api_key !== 'string' || !p.api_key.trim())) {
                    return res.status(400).json({ error: 'provider.api_key must be a non-empty string' });
                }

                const existing = await systemAi.getSystemProviderMeta();
                if (!p.api_key && !existing) {
                    return res.status(400).json({ error: 'provider.api_key is required' });
                }

                provider = await systemAi.upsertSystemProvider({
                    providerType: p.provider_type || undefined,
                    endpoint: endpoint || (existing ? existing.endpoint : ''),
                    apiKey: p.api_key ? String(p.api_key).trim() : undefined,
                    model: p.model !== undefined ? (p.model || null) : undefined,
                });
            }

            res.json({ enabled, provider });
        } catch (err) {
            console.error('[ADMIN] PUT system-ai failed:', err.message);
            res.status(500).json({ error: 'Failed to update system AI state' });
        }
    });

    // ── POST connection test (does not persist the key) ─────────────────
    app.post('/api/v1/admin/system-ai/test', requireAdmin, async (req, res) => {
        const body = req.body || {};
        try {
            // Explicit body values win; missing fields fall back to the STORED
            // system provider so a saved provider is re-tested against itself.
            const stored = await systemAi.resolveSystemProvider();
            const fromStored = stored && stored.source === 'system' && !!stored.endpoint;

            const endpoint = normalizeEndpoint(body.endpoint)
                || (fromStored ? normalizeEndpoint(stored.endpoint) : null);
            const apiKey = (typeof body.api_key === 'string' && body.api_key.trim())
                ? body.api_key.trim()
                : (fromStored ? stored.apiKey : null);
            const model = (typeof body.model === 'string' && body.model.trim())
                ? body.model.trim()
                : (fromStored ? stored.model : null);

            const result = await workspaceAi.testConnection({
                endpoint: endpoint || undefined,
                apiKey: apiKey || undefined,
                model: model || undefined,
            });

            // Stamp status when the stored provider was the source and the
            // resolved endpoint matches the stored one (body overrides for
            // ad-hoc testing are fine — the stored provider is still the
            // one being validated).
            const storedEndpoint = fromStored ? normalizeEndpoint(stored.endpoint) : null;
            if (fromStored && endpoint === storedEndpoint) {
                await systemAi.setSystemLastTest(!!result.ok);
            }

            delete result.apiKey; // never echo credentials
            res.json(result);
        } catch (err) {
            console.error('[ADMIN] TEST system-ai failed:', err.message);
            res.status(500).json({ ok: false, error: 'Connection test failed' });
        }
    });

    // ── POST create SYSTEM worker (Animastor-operated pool; token ONCE) ──
    app.post('/api/v1/admin/workers/system', requireAdmin, async (req, res) => {
        const body = req.body || {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > MAX_NAME_LEN) {
            return res.status(400).json({ error: `name is required (max ${MAX_NAME_LEN} chars)` });
        }
        const workerType = typeof body.worker_type === 'string' ? body.worker_type : '';
        if (!workerRepo.WORKER_TYPES.includes(workerType)) {
            return res.status(400).json({
                error: `worker_type must be one of: ${workerRepo.WORKER_TYPES.join(', ')}`,
            });
        }
        try {
            const { worker, token } = await workerRepo.createSystemWorker({
                name,
                workerType,
                createdBy: req.user ? req.user.userId : null,
            });
            await workerAuth.mirrorPut(redis, { ...worker, token_hash: workerRepo.parseToken(token).secretHash });
            res.status(201).json({
                worker: await adminPublicWorker(redis, worker),
                token, // one-time disclosure — never returned again
            });
        } catch (err) {
            console.error('[ADMIN] create system worker failed:', err.message);
            res.status(500).json({ error: 'Failed to create system worker' });
        }
    });

    // ── GET list SYSTEM workers ───────────────────────────────────────────
    app.get('/api/v1/admin/workers/system', requireAdmin, async (req, res) => {
        try {
            const rows = await workerRepo.listSystemWorkers();
            const workers = await Promise.all(rows.map((r) => adminPublicWorker(redis, r)));
            res.json({ workers });
        } catch (err) {
            console.error('[ADMIN] list system workers failed:', err.message);
            res.status(500).json({ error: 'Failed to list system workers' });
        }
    });

    // ── POST rotate SYSTEM worker credential (token ONCE, old dies) ───────
    app.post('/api/v1/admin/workers/system/:workerId/rotate', requireAdmin, async (req, res) => {
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        try {
            const result = await workerRepo.rotateSystemCredential(req.params.workerId);
            if (!result) return res.status(404).json({ error: 'Worker not found' });
            await workerAuth.mirrorDrop(redis, [result.previousTokenHash]);
            await workerAuth.mirrorPut(redis, {
                ...result.worker,
                token_hash: workerRepo.parseToken(result.token).secretHash,
            });
            res.json({ worker: await adminPublicWorker(redis, result.worker), token: result.token });
        } catch (err) {
            console.error('[ADMIN] rotate system worker failed:', err.message);
            res.status(500).json({ error: 'Failed to rotate system worker credential' });
        }
    });

    // ── DELETE revoke SYSTEM worker (immediate; soft delete) ──────────────
    app.delete('/api/v1/admin/workers/system/:workerId', requireAdmin, async (req, res) => {
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        try {
            const { revoked, tokenHash } = await workerRepo.revokeSystemWorker(req.params.workerId);
            if (!revoked) return res.status(404).json({ error: 'Worker not found' });
            await workerAuth.mirrorDrop(redis, [tokenHash]);
            res.json({ revoked: true });
        } catch (err) {
            console.error('[ADMIN] revoke system worker failed:', err.message);
            res.status(500).json({ error: 'Failed to revoke system worker' });
        }
    });

    console.log('[ROUTES] Admin routes loaded');
};
