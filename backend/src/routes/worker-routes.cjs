// ======================================================
// ANIMASTOR BACKEND — PRIVATE WORKER ROUTES (Experimental Beta — Phase 1)
// ======================================================
// Registration & lifecycle for private workers of the CALLER'S workspace:
//
//   POST   /api/v1/workers                 — create worker + issue credential
//   GET    /api/v1/workers                 — list (never returns secrets)
//   POST   /api/v1/workers/:workerId/rotate — new credential (old dies)
//   DELETE /api/v1/workers/:workerId       — revoke (immediate)
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
// Usage:
//   require('./routes/worker-routes.cjs')(app, redis);

const workerRepo = require('../storage/postgres/repositories/worker-repo');
const workerAuth = require('../services/worker-auth');

const MAX_NAME_LEN = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Public worker shape — never includes token_hash or the raw credential. */
function publicWorker(row) {
    return {
        worker_id: row.worker_id,
        workspace_id: row.workspace_id,
        name: row.name,
        worker_type: row.worker_type,
        capabilities: row.capabilities || null,
        mode: row.mode,
        status: row.status,
        token_prefix: row.token_prefix || null,
        last_seen: row.last_seen != null ? Number(row.last_seen) : null,
        revoked_at: row.revoked_at != null ? Number(row.revoked_at) : null,
        created_at: row.created_at != null ? Number(row.created_at) : null,
    };
}

module.exports = function(app, redis) {

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
        // workspace_id from the body is deliberately IGNORED — the worker is
        // always created in the caller's own workspace.

        try {
            const { worker, token } = await workerRepo.createWorker({
                workspaceId,
                name,
                workerType,
                createdBy: req.user.userId,
            });
            await workerAuth.mirrorPut(redis, { ...worker, token_hash: workerRepo.parseToken(token).secretHash });
            res.status(201).json({
                worker: publicWorker(worker),
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
            res.json({ workers: rows.map(publicWorker) });
        } catch (err) {
            console.error('[WORKERS] list failed:', err.message);
            res.status(500).json({ error: 'Failed to list workers' });
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
            await workerAuth.mirrorPut(redis, {
                ...result.worker,
                token_hash: workerRepo.parseToken(result.token).secretHash,
            });
            res.json({ worker: publicWorker(result.worker), token: result.token });
        } catch (err) {
            console.error('[WORKERS] rotate failed:', err.message);
            res.status(500).json({ error: 'Failed to rotate worker credential' });
        }
    });

    // ── DELETE revoke worker (immediate) ────────────────────────────────
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

    console.log('[ROUTES] Private worker routes loaded');
};
