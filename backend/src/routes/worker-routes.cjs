// ======================================================
// ANIMASTOR BACKEND — PRIVATE WORKER ROUTES (Experimental Beta)
// ======================================================
// Registration & lifecycle for workers of the CALLER'S workspace:
//
//   POST   /api/v1/worker/verify             — credential check (worker CLI first-run)
//   POST   /api/v1/workers                   — create worker + issue credential (one-time)
//   GET    /api/v1/workers                   — list (never returns secrets)
//   GET    /api/v1/workers/:workerId         — one worker detail (never returns secrets)
//   POST   /api/v1/workers/:workerId/rotate  — new credential (old dies; one-time)
//   DELETE /api/v1/workers/:workerId         — revoke (immediate; soft delete)
//   DELETE /api/v1/workers/:workerId/purge   — permanent delete (revoked only; hard delete)
//
// Modes (PW-4 fail-closed model): tenants may create 'private' (default) or
// 'share' (explicit confirm_share=true — the worker is volunteered to the
// community pool). 'system' is Animastor-operated and admin-only.
//
// Identity rules (Phase 1 invariants):
//   - requireAuth: REGISTERED USERS ONLY. Guests may NOT create workers — a
//     deliberate deviation from the Milestone-1 identityGuard (which admits
//     guests): a temporary workspace must never own long-lived GPU
//     credentials that outlive the guest purge.
//   - workspace_id ALWAYS comes from req.workspace (resolved by authContext)
//     — never from the request body/query, so cross-workspace registration
//     is impossible.
//   - The plaintext credential is returned ONLY by the create/rotate
//     responses; every other response carries at most token_prefix.
//
// Operational status (Phase 3):
//   REVOKED — revoked_at is set (authorization dead; liveness irrelevant);
//   ONLINE  — the live Redis heartbeat key exists (the GPU hub refreshes it
//             every 10s with a 30s TTL while the worker beacons);
//   OFFLINE — no live heartbeat seen (fail closed: Redis outage → OFFLINE,
//             never an unsolicited ONLINE).
//   The status is a DERIVED liveness hint ONLY — authorization is ALWAYS
//   decided by the credential / revocation, never by this status.
//
// Usage:
//   require('./routes/worker-routes.cjs')(app, redis);

const workerRepo = require('../storage/postgres/repositories/worker-repo');
const workerAuth = require('../services/worker-auth');
const workspaceRepo = require('../storage/postgres/repositories/workspace-repo');
const { requireWorkerAuth } = require('../middleware/worker-auth-middleware');
const config = require('../config/runtime-config');

const MAX_NAME_LEN = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kill-switch (SH-1): share-policy routes exist only when the flag is on. */
function shareFeaturesEnabled() {
    return config.shareFeaturesEnabled() === true;
}

/**
 * Kill-switch OFF → the endpoints answer 404 exactly as if they did not
 * exist (bit-for-bit pre-sharing behavior, §8.7 of the design doc). The
 * check runs BEFORE authentication: with the flag off there is no surface
 * at all — anonymous and authenticated callers see the same dead endpoint.
 */
function shareDisabledGuard(res) {
    res.status(404).json({ error: 'Not found' });
    return null;
}

/** Users-only guard; returns the caller's workspace id or answers 401/403. */
function userWorkspaceGuard(req, res) {
    if (!req.user) {
        res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
        return null;
    }
    if (req.guest) {
        // A request cannot be both user and guest — defensive only.
        res.status(403).json({ error: 'Guests cannot manage workers', code: 'guest_forbidden' });
        return null;
    }
    if (!req.workspace || !req.workspace.id) {
        res.status(401).json({ error: 'Workspace not resolved', code: 'workspace_unresolved' });
        return null;
    }
    return req.workspace.id;
}

/**
 * Derived operational liveness for a worker row.
 * Returns { status: 'ONLINE'|'OFFLINE'|'REVOKED', last_seen: number|null }.
 * A revoked worker has status REVOKED regardless of any heartbeat. Otherwise
 * the live Redis heartbeat key drives ONLINE/OFFLINE (the GPU hub writes
 * `animastor:worker:heartbeat:<type>:<worker_id>` on every beacon, TTL 30s).
 * Any Redis error → OFFLINE (never an unsolicited ONLINE).
 */
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

/**
 * Public worker shape — never includes token_hash or the raw credential.
 * The Operational `status` is DERIVED (ONLINE/OFFLINE/REVOKED); the raw DB
 * `status` column (online/offline/busy/error) is intentionally NOT exposed.
 */
async function publicWorker(redis, row) {
    const live = await liveInfo(redis, row);
    return {
        worker_id: row.worker_id,
        workspace_id: row.workspace_id,
        name: row.name,
        worker_type: row.worker_type,
        capabilities: row.capabilities || null,
        mode: row.mode,
        status: live.status,
        token_prefix: row.token_prefix || null,
        last_seen: live.last_seen,
        revoked_at: row.revoked_at != null ? Number(row.revoked_at) : null,
        created_at: row.created_at != null ? Number(row.created_at) : null,
    };
}

module.exports = function(app, redis) {

    // ── POST verify credential (worker CLI first-run confirmation) ────────
    // FAIL CLOSED (requireWorkerAuth): missing/invalid/revoked credential →
    // 401. The registry is the source of truth: the CLI does not choose its
    // mode — it learns identity + mode from this response. Resolved against
    // PG (authoritative), never the mirror.
    app.post('/api/v1/worker/verify', requireWorkerAuth(redis), async (req, res) => {
        const w = req.authenticatedWorker;
        let workspaceName = null;
        if (w.workspace_id) {
            try {
                const ws = await workspaceRepo.findById(w.workspace_id);
                workspaceName = ws ? ws.name : null;
            } catch (_) { /* non-fatal — name is cosmetic */ }
        }
        try { await workerRepo.touchLastSeen(w.id); } catch (_) { /* non-fatal */ }
        res.json({
            verified: true,
            worker_id: w.id,
            name: w.name,
            worker_type: w.worker_type,
            mode: w.mode,
            workspace_id: w.workspace_id || null,
            workspace_name: workspaceName,
        });
    });

    // ── POST create worker (credential shown ONCE) ──────────────────────
    app.post('/api/v1/workers', async (req, res) => {
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;

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
        // Mode: 'private' (default) or 'share' with explicit confirmation.
        // 'system' is Animastor-operated — never creatable through this route.
        let mode = 'private';
        if (body.mode !== undefined && body.mode !== 'private') {
            if (body.mode === 'share') {
                if (body.confirm_share !== true) {
                    return res.status(400).json({
                        error: 'share mode requires confirm_share=true — a share worker may be used by other Animastor users',
                        code: 'share_confirmation_required',
                    });
                }
                mode = 'share';
            } else {
                return res.status(400).json({ error: "mode must be 'private' or 'share'" });
            }
        }
        // workspace_id from the body is deliberately IGNORED — the worker is
        // always created in the caller's own workspace.

        try {
            const { worker, token } = await workerRepo.createWorker({
                workspaceId,
                name,
                workerType,
                mode,
                createdBy: req.user.userId,
            });
            await workerAuth.mirrorPut(redis, { ...worker, token_hash: workerRepo.parseToken(token).secretHash });
            res.status(201).json({
                worker: await publicWorker(redis, worker),
                token, // one-time disclosure — never returned again
            });
        } catch (err) {
            console.error('[WORKERS] create failed:', err.message);
            res.status(500).json({ error: 'Failed to create worker' });
        }
    });

    // ── GET list workers of the caller's workspace ──────────────────────
    app.get('/api/v1/workers', async (req, res) => {
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        try {
            const rows = await workerRepo.listByWorkspace(workspaceId);
            const workers = await Promise.all(rows.map((r) => publicWorker(redis, r)));
            res.json({ workers });
        } catch (err) {
            console.error('[WORKERS] list failed:', err.message);
            res.status(500).json({ error: 'Failed to list workers' });
        }
    });

    // ── GET one worker detail (caller's workspace only) ─────────────────
    app.get('/api/v1/workers/:workerId', async (req, res) => {
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        try {
            const row = await workerRepo.findById(req.params.workerId);
            if (!row || row.workspace_id !== workspaceId) {
                // Foreign/unknown — one indistinct answer (no existence oracle).
                return res.status(404).json({ error: 'Worker not found' });
            }
            res.json({ worker: await publicWorker(redis, row) });
        } catch (err) {
            console.error('[WORKERS] detail failed:', err.message);
            res.status(500).json({ error: 'Failed to load worker' });
        }
    });

    // ── POST rotate credential (new token shown ONCE, old dies) ─────────
    app.post('/api/v1/workers/:workerId/rotate', async (req, res) => {
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        try {
            const result = await workerRepo.rotateCredential(req.params.workerId, workspaceId);
            if (!result) {
                // Unknown id, foreign workspace or already revoked — one
                // indistinct answer (no existence oracle for other workspaces).
                return res.status(404).json({ error: 'Worker not found' });
            }
            await workerAuth.mirrorDrop(redis, [result.previousTokenHash]);
            // SH-1: rebuild the mirror entry from PG (identity + active share
            // policy) — a plain mirrorPut with the rotation row would drop the
            // policy until the next resync.
            const mirrored = await workerAuth.mirrorPutWorkerById(redis, req.params.workerId);
            if (!mirrored) {
                // Defense in depth (non-fatal — the periodic resync heals):
                // fall back to the direct point update with the new hash.
                await workerAuth.mirrorPut(redis, {
                    ...result.worker,
                    token_hash: workerRepo.parseToken(result.token).secretHash,
                });
            }
            res.json({ worker: await publicWorker(redis, result.worker), token: result.token });
        } catch (err) {
            console.error('[WORKERS] rotate failed:', err.message);
            res.status(500).json({ error: 'Failed to rotate worker credential' });
        }
    });

    // ── DELETE revoke worker (immediate; soft delete — kept for audit) ───
    app.delete('/api/v1/workers/:workerId', async (req, res) => {
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        try {
            const { revoked, tokenHash } = await workerRepo.revokeWorker(req.params.workerId, workspaceId);
            if (!revoked) {
                return res.status(404).json({ error: 'Worker not found' });
            }
            await workerAuth.mirrorDrop(redis, [tokenHash]);
            res.json({ revoked: true });
        } catch (err) {
            console.error('[WORKERS] revoke failed:', err.message);
            res.status(500).json({ error: 'Failed to revoke worker' });
        }
    });

    // ── DELETE purge worker (permanent; revoked workers only) ─────────────
    // Hard-deletes the registry row of an ALREADY REVOKED worker and clears
    // every derived state that could surface or resurrect it:
    //   - PG row removed → gone from list/detail, survives reload/re-login;
    //   - auth-mirror entry dropped (also healed by the periodic resync,
    //     which rebuilds the mirror from PG — the row no longer exists);
    //   - heartbeat key deleted → never counted in liveness/availability;
    //   - GPU hub registry entry dropped (SYNC: gpu-hub/gpu-hub.js
    //     GPU_REGISTRY_KEY — TTL'd anyway, best-effort).
    // Active workers are NEVER purgeable — revoke first (409). The token was
    // already killed at revoke time, so no credential outlives the row.
    app.delete('/api/v1/workers/:workerId/purge', async (req, res) => {
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        try {
            const row = await workerRepo.findById(req.params.workerId);
            if (!row || row.workspace_id !== workspaceId) {
                // Foreign/unknown — one indistinct answer (no existence oracle).
                return res.status(404).json({ error: 'Worker not found' });
            }
            if (row.revoked_at == null) {
                return res.status(409).json({
                    error: 'Worker is not revoked — revoke it before deleting',
                    code: 'worker_not_revoked',
                });
            }
            const { deleted, tokenHash, workerType } = await workerRepo.purgeWorker(req.params.workerId, workspaceId);
            if (!deleted) {
                return res.status(404).json({ error: 'Worker not found' });
            }
            await workerAuth.mirrorDrop(redis, tokenHash ? [tokenHash] : []);
            try {
                await redis.del(config.WORKER_HEARTBEAT_KEY(workerType, req.params.workerId));
            } catch (_) { /* non-fatal — the key is TTL'd (30s) anyway */ }
            try {
                await redis.hdel('animastor:gpu-hub:workers', req.params.workerId);
            } catch (_) { /* non-fatal — the registry hash is TTL'd anyway */ }
            res.json({ deleted: true });
        } catch (err) {
            console.error('[WORKERS] purge failed:', err.message);
            res.status(500).json({ error: 'Failed to delete worker' });
        }
    });

    // ── SH-1: share policy management (worker sharing V1) ────────────────
    // Kill-switch-gated (SHARE_FEATURES_ENABLED, default OFF) thin wrappers
    // over the share_policies table (§7.3 of worker-sharing-model-design.md):
    //
    //   POST   /api/v1/workers/:workerId/share — start public sharing
    //   DELETE /api/v1/workers/:workerId/share — stop sharing
    //   GET    /api/v1/workers/:workerId/share — current policy (owner view)
    //
    // Authorization: workspace-scoped via userWorkspaceGuard + WHERE
    // workspace_id = $2 SQL predicates — a foreign/unknown worker id 404s
    // indistinctly (no existence oracle), and workspace-less SYSTEM workers
    // can never match (the same structural property that protects every
    // other workspace-scoped route). Only mode='private' workers can carry a
    // policy (a 'share' worker's lane IS the community pool already; a
    // policy would be meaningless). Sharing never changes the worker's mode
    // or ownership (§3): the private lane keeps strict priority.
    //
    // Stop sharing requires NO queue cleanup (D6): consumer jobs sit in the
    // shared system pool, served by other pool workers; running jobs finish
    // normally (the claim is bound to the credential, not the policy).

    // ── POST start sharing (single active policy; worker-addressed, D7) ──
    app.post('/api/v1/workers/:workerId/share', async (req, res) => {
        if (!shareFeaturesEnabled()) return shareDisabledGuard(res);
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        // Body: { expires_at?: <epoch ms>|null }. Scope is NOT client-
        // supplied — V1 is public-only server-side (no spoofing surface).
        const body = req.body || {};
        let expiresAt = null;
        if (body.expires_at !== undefined && body.expires_at !== null) {
            if (typeof body.expires_at !== 'number' || !Number.isInteger(body.expires_at)) {
                return res.status(400).json({
                    error: 'expires_at must be an epoch-milliseconds integer or null',
                    code: 'invalid_expires_at',
                });
            }
            if (body.expires_at <= Date.now()) {
                return res.status(400).json({
                    error: 'expires_at must be in the future',
                    code: 'expires_at_in_past',
                });
            }
            expiresAt = body.expires_at;
        }
        try {
            const result = await workerRepo.startSharePolicy({
                workerId: req.params.workerId,
                workspaceId, // server-resolved — never from the body
                expiresAt,
                createdBy: req.user.userId,
            });
            if (result.notFound) {
                // Unknown id, foreign workspace, revoked worker or a
                // non-private mode — one indistinct answer (no existence
                // oracle for other workspaces' workers).
                return res.status(404).json({ error: 'Worker not found' });
            }
            if (result.conflict) {
                // D1: one active policy per worker — stop first (or wait for
                // the running one to expire).
                return res.status(409).json({
                    error: 'Worker is already shared — stop sharing first',
                    code: 'share_already_active',
                });
            }
            // Identity payload (mirror) gains the policy immediately (D4) —
            // the hub sees the change on the worker's next claim; the
            // periodic resync would heal it anyway.
            await workerAuth.mirrorPutWorkerById(redis, req.params.workerId);
            res.status(201).json({ sharing: true, policy: result.policy });
        } catch (err) {
            console.error('[WORKERS] share start failed:', err.message);
            res.status(500).json({ error: 'Failed to start sharing' });
        }
    });

    // ── DELETE stop sharing (idempotent end-state; no queue cleanup) ─────
    app.delete('/api/v1/workers/:workerId/share', async (req, res) => {
        if (!shareFeaturesEnabled()) return shareDisabledGuard(res);
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        try {
            const result = await workerRepo.stopSharePolicy(req.params.workerId, workspaceId);
            if (result.notFound) {
                return res.status(404).json({ error: 'Worker not found' });
            }
            // Nothing was active → the end state is already achieved.
            await workerAuth.mirrorPutWorkerById(redis, req.params.workerId);
            res.json({ sharing: false, stopped: !!result.policy });
        } catch (err) {
            console.error('[WORKERS] share stop failed:', err.message);
            res.status(500).json({ error: 'Failed to stop sharing' });
        }
    });

    // ── GET current policy (owner view) ──────────────────────────────────
    app.get('/api/v1/workers/:workerId/share', async (req, res) => {
        if (!shareFeaturesEnabled()) return shareDisabledGuard(res);
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        try {
            const row = await workerRepo.findById(req.params.workerId);
            if (!row || row.workspace_id !== workspaceId) {
                // Foreign/unknown — one indistinct answer (no existence oracle).
                return res.status(404).json({ error: 'Worker not found' });
            }
            // Expiry re-checked on read: an expired policy is not active.
            const policy = await workerRepo.getActiveSharePolicy(req.params.workerId, workspaceId);
            res.json({ sharing: !!policy, policy: policy || null });
        } catch (err) {
            console.error('[WORKERS] share read failed:', err.message);
            res.status(500).json({ error: 'Failed to load sharing state' });
        }
    });

    console.log('[ROUTES] Private worker routes loaded');
};
