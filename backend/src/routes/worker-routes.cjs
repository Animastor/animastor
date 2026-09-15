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
const userRepo = require('../storage/postgres/repositories/user-repo');
const shareEvents = require('../services/share-events');
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

/**
 * SH-2: drain a stopped users-policy lane into the public pool.
 * A users policy owns queue:{type}:policy:{id} — when sharing stops, only
 * that policy's worker could pop it, and it no longer does. Left in place
 * the queued jobs would strand until each dispatch lease expires (15-30
 * min); draining moves them to the system pool where they keep flowing to
 * public capacity — exactly where the scheduler's re-dispatch would have
 * sent them anyway. The stale policy_id marker is stripped so no consumer
 * (e.g. the hub's orphan requeue) can ever route the task back to the dead
 * lane. Each entry moves exactly once (RPOPLPUSH is atomic): an entry a
 * pool worker claims mid-drain simply runs with the inert marker; an entry
 * still queued is removed and re-pushed clean. Best-effort, non-fatal — the
 * dispatch-lease re-dispatch is the backstop.
 */
async function drainPolicyLane(redis, workerType, policyId) {
    const src = `animastor:queue:${workerType}:policy:${policyId}`;
    const dst = `animastor:queue:${workerType}`;
    try {
        for (let i = 0; i < 10000; i++) {
            const raw = await redis.rpoplpush(src, dst);
            if (!raw) break;
            try {
                const task = JSON.parse(raw);
                if (task && task.policy_id !== undefined) {
                    const removed = await redis.lrem(dst, 1, raw);
                    if (removed > 0) {
                        delete task.policy_id;
                        await redis.lpush(dst, JSON.stringify(task));
                    }
                }
            } catch (_) { /* unparseable entry — move it verbatim, it dead-letters as poison */ }
        }
    } catch (_) { /* non-fatal — the lease-expiry re-dispatch is the backstop */ }
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

    // ── SH-2: "Shared with me" (V2 discoverability, §14.2) ───────────────
    // A standing per-user list (state derived from grants/policies at read
    // time), NOT a transient notification feed and NOT the community pool:
    // only workers the caller may use through a PERSONAL grant. Each entry
    // carries its access reason ("Shared by <username>"). Registered before
    // the /:workerId detail route so the parametrized path cannot swallow it.
    app.get('/api/v1/workers/shared-with-me', async (req, res) => {
        if (!shareFeaturesEnabled()) return shareDisabledGuard(res);
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        try {
            const workers = await workerRepo.listSharedWithMe(req.user.userId);
            res.json({ workers });
        } catch (err) {
            console.error('[WORKERS] shared-with-me failed:', err.message);
            res.status(500).json({ error: 'Failed to load shared workers' });
        }
    });

    // ── GET one worker detail (caller's workspace only) ─────────────────
    // NOTE (route order): /api/v1/workers/shared-with-me is registered
    // BEFORE this handler — Express matches in registration order and this
    // parametrized path would otherwise swallow it.
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
            // SH-2: a revoked worker with an active USERS policy leaves a
            // policy lane only it could pop — capture the policy for the
            // drain BEFORE the revoke (the policy row survives the soft
            // delete, but the worker no longer pops anything).
            let activeUsersPolicy = null;
            if (shareFeaturesEnabled()) {
                try {
                    const p = await workerRepo.getActiveSharePolicyForWorker(req.params.workerId);
                    if (p && p.scope_kind === 'users') activeUsersPolicy = p;
                } catch (_) { /* non-fatal */ }
            }
            const { revoked, tokenHash } = await workerRepo.revokeWorker(req.params.workerId, workspaceId);
            if (!revoked) {
                return res.status(404).json({ error: 'Worker not found' });
            }
            if (activeUsersPolicy) {
                const row = await workerRepo.findById(req.params.workerId);
                if (row && row.worker_type) {
                    await drainPolicyLane(redis, row.worker_type, activeUsersPolicy.policy_id);
                }
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
    // V1: start PUBLIC sharing (body { expires_at? }) — unchanged shape.
    // V2 (SH-2): start USERS sharing by naming recipients: body { users:
    // [username,...], expires_at? }. The scope is derived server-side from
    // the presence of `users` (or an explicit `scope` field that must agree)
    // — it is never free-form. Recipients resolve server-side from
    // usernames; client-supplied user_ids are never a source of truth.
    app.post('/api/v1/workers/:workerId/share', async (req, res) => {
        if (!shareFeaturesEnabled()) return shareDisabledGuard(res);
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        const body = req.body || {};
        // Explicit scope, when present, must agree with the `users` field.
        if (body.scope !== undefined && body.scope !== null
            && !workerRepo.SHARE_POLICY_SCOPES.includes(body.scope)) {
            return res.status(400).json({
                error: `scope must be one of: ${workerRepo.SHARE_POLICY_SCOPES.join(', ')}`,
                code: 'invalid_scope',
            });
        }
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
        // SH-2: recipients by username. Absent → public sharing (V1 shape);
        // present → personal sharing (a users policy without recipients is
        // meaningless and is rejected rather than silently created).
        let scope = 'public';
        let usernames = null;
        const hasUsers = body.users !== undefined && body.users !== null;
        if (hasUsers) {
            if (!Array.isArray(body.users) || body.users.length === 0
                || body.users.some((u) => typeof u !== 'string' || !u.trim())
                || body.users.length > 50) {
                return res.status(400).json({
                    error: 'users must be a non-empty array of usernames (max 50 per request)',
                    code: 'invalid_users',
                });
            }
            usernames = [...new Set(body.users.map((u) => u.trim()))];
            scope = 'users';
        }
        if (body.scope === 'users' && !hasUsers) {
            return res.status(400).json({
                error: "scope 'users' requires a non-empty users array",
                code: 'invalid_users',
            });
        }
        if (body.scope === 'public' && hasUsers) {
            return res.status(400).json({
                error: "scope 'public' does not take a users array",
                code: 'invalid_scope',
            });
        }
        try {
            // Probe first: name for the event payloads + the indistinct
            // foreign/unknown 404 (same predicate as every worker route).
            const workerRow = await workerRepo.findById(req.params.workerId);
            if (!workerRow || workerRow.workspace_id !== workspaceId) {
                return res.status(404).json({ error: 'Worker not found' });
            }
            // V2: resolve recipients BEFORE creating the policy — unknown
            // usernames are rejected up-front (no policy is created).
            let resolvedUsers = null;
            if (scope === 'users') {
                resolvedUsers = await userRepo.findByUsernames(usernames);
                if (resolvedUsers.length !== usernames.length) {
                    const found = new Set(resolvedUsers.map((u) => u.username));
                    const unknown = usernames.filter((u) => !found.has(u));
                    return res.status(400).json({
                        error: `Unknown user(s): ${unknown.join(', ')}`,
                        code: 'unknown_user',
                        unknown_users: unknown,
                    });
                }
                // The owner cannot be their own recipient: a personal grant
                // to the owning workspace is a no-op by definition (the
                // owner's access rides the private lane, never a grant).
                if (resolvedUsers.some((u) => u.user_id === req.user.userId)) {
                    return res.status(400).json({
                        error: 'Cannot share with yourself',
                        code: 'self_grant_forbidden',
                    });
                }
            }
            const result = await workerRepo.startSharePolicy({
                workerId: req.params.workerId,
                workspaceId, // server-resolved — never from the body
                scope,
                expiresAt,
                createdBy: req.user.userId,
            });
            if (result.notFound) {
                // Revoked worker or non-private mode — the same indistinct
                // answer as a foreign id (the probe above already answered
                // for foreign/unknown).
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
            // SH-2: seed the audience of a users policy. addShareGrants is
            // guarded by the same workspace/active-policy predicates, so a
            // policy that died between the two statements simply grants
            // nothing (empty audience — the owner deletes the policy).
            let grants = [];
            if (scope === 'users') {
                const grantResult = await workerRepo.addShareGrants({
                    workerId: req.params.workerId,
                    workspaceId,
                    userIds: resolvedUsers.map((u) => u.user_id),
                    createdBy: req.user.userId,
                });
                grants = grantResult.grants || [];
                // Minimal notification/event seam (§15): one event per newly
                // granted recipient — enough for «<username> поделился с вами
                // Worker <worker name>». Non-fatal by contract.
                const actor = { user_id: req.user.userId, username: req.user.username };
                const added = new Set(grantResult.addedUserIds || []);
                for (const u of resolvedUsers) {
                    if (!added.has(u.user_id)) continue; // duplicate grant — no new access, no event
                    shareEvents.emitShareEvent(shareEvents.buildWorkerSharedWithUserEvent({
                        workerId: req.params.workerId,
                        workerName: workerRow.name,
                        recipient: u,
                        actor,
                    }));
                }
            }
            // Identity payload (mirror) gains the policy immediately (D4) —
            // the hub sees the change on the worker's next claim; the
            // periodic resync would heal it anyway.
            await workerAuth.mirrorPutWorkerById(redis, req.params.workerId);
            res.status(201).json({
                sharing: true,
                policy: result.policy,
                ...(scope === 'users' ? { grants } : {}),
            });
        } catch (err) {
            console.error('[WORKERS] share start failed:', err.message);
            res.status(500).json({ error: 'Failed to start sharing' });
        }
    });

    // ── DELETE stop sharing (idempotent end-state) ────────────────────────
    // PUBLIC policies need NO queue cleanup (D6): their consumer jobs sit in
    // the shared system pool and other pool workers serve them.
    // USERS policies own a per-policy lane (queue:{type}:policy:{id}) — when
    // sharing stops, that lane would strand its queued jobs (only this
    // worker could ever pop it, and it no longer pops). The lane is drained
    // back into the public pool so the jobs stay servable (best-effort).
    // Running jobs always finish normally (claim bound to the credential).
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
            if (result.policy && result.policy.scope_kind === 'users' && result.workerType) {
                await drainPolicyLane(redis, result.workerType, result.policy.policy_id);
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
            // SH-2: the audience rides along for users policies.
            const grants = policy && policy.scope_kind === 'users'
                ? (await workerRepo.listShareGrants(req.params.workerId, workspaceId)) || []
                : [];
            res.json({ sharing: !!policy, policy: policy || null, grants });
        } catch (err) {
            console.error('[WORKERS] share read failed:', err.message);
            res.status(500).json({ error: 'Failed to load sharing state' });
        }
    });

    // ── SH-2: personal grant management (recipients of a users policy) ────
    //   GET    /api/v1/workers/:workerId/share/users — list recipients
    //   POST   /api/v1/workers/:workerId/share/users — add recipient(s)
    //   DELETE /api/v1/workers/:workerId/share/users — revoke one recipient
    // The active policy is addressed THROUGH the worker (worker-addressed,
    // D7 — one active policy per worker). workspace_id / owner identity are
    // ALWAYS server-resolved from the session + worker row; the request body
    // never contributes identity. Foreign/unknown workers 404 indistinctly.

    app.get('/api/v1/workers/:workerId/share/users', async (req, res) => {
        if (!shareFeaturesEnabled()) return shareDisabledGuard(res);
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        try {
            const grants = await workerRepo.listShareGrants(req.params.workerId, workspaceId);
            if (grants === null) {
                return res.status(404).json({ error: 'Worker not found' });
            }
            res.json({ grants });
        } catch (err) {
            console.error('[WORKERS] share users list failed:', err.message);
            res.status(500).json({ error: 'Failed to list share recipients' });
        }
    });

    app.post('/api/v1/workers/:workerId/share/users', async (req, res) => {
        if (!shareFeaturesEnabled()) return shareDisabledGuard(res);
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        const body = req.body || {};
        if (!Array.isArray(body.users) || body.users.length === 0
            || body.users.some((u) => typeof u !== 'string' || !u.trim())
            || body.users.length > 50) {
            return res.status(400).json({
                error: 'users must be a non-empty array of usernames (max 50 per request)',
                code: 'invalid_users',
            });
        }
        const usernames = [...new Set(body.users.map((u) => u.trim()))];
        try {
            // Indistinct ownership probe FIRST (foreign/unknown → 404), then
            // the recipients resolve server-side from usernames (existing
            // users only — no arbitrary search, exact match).
            const workerRow = await workerRepo.findById(req.params.workerId);
            if (!workerRow || workerRow.workspace_id !== workspaceId) {
                return res.status(404).json({ error: 'Worker not found' });
            }
            const resolvedUsers = await userRepo.findByUsernames(usernames);
            if (resolvedUsers.length !== usernames.length) {
                const found = new Set(resolvedUsers.map((u) => u.username));
                const unknown = usernames.filter((u) => !found.has(u));
                return res.status(400).json({
                    error: `Unknown user(s): ${unknown.join(', ')}`,
                    code: 'unknown_user',
                    unknown_users: unknown,
                });
            }
            if (resolvedUsers.some((u) => u.user_id === req.user.userId)) {
                return res.status(400).json({
                    error: 'Cannot share with yourself',
                    code: 'self_grant_forbidden',
                });
            }
            // Owner check: the caller must own the worker (the guard inside
            // listShareGrants would answer null for a foreign row) AND a
            // users policy must be active (otherwise there is no audience to
            // extend — starting sharing is the separate POST /share call).
            const policy = await workerRepo.getActiveSharePolicy(req.params.workerId, workspaceId);
            if (!policy || policy.scope_kind !== 'users') {
                return res.status(409).json({
                    error: 'Worker has no active users sharing — start sharing with users first',
                    code: 'no_active_users_policy',
                });
            }
            const grantResult = await workerRepo.addShareGrants({
                workerId: req.params.workerId,
                workspaceId,
                userIds: resolvedUsers.map((u) => u.user_id),
                createdBy: req.user.userId,
            });
            if (grantResult.notFound) {
                return res.status(404).json({ error: 'Worker not found' });
            }
            // Events for NEWLY granted recipients only (duplicate grants add
            // no access and emit nothing).
            const actor = { user_id: req.user.userId, username: req.user.username };
            const added = new Set(grantResult.addedUserIds || []);
            for (const u of resolvedUsers) {
                if (!added.has(u.user_id)) continue;
                shareEvents.emitShareEvent(shareEvents.buildWorkerSharedWithUserEvent({
                    workerId: req.params.workerId,
                    workerName: workerRow.name,
                    recipient: u,
                    actor,
                }));
            }
            res.status(201).json({ grants: grantResult.grants });
        } catch (err) {
            console.error('[WORKERS] share users add failed:', err.message);
            res.status(500).json({ error: 'Failed to add share recipients' });
        }
    });

    app.delete('/api/v1/workers/:workerId/share/users', async (req, res) => {
        if (!shareFeaturesEnabled()) return shareDisabledGuard(res);
        const workspaceId = userWorkspaceGuard(req, res);
        if (!workspaceId) return;
        if (!UUID_RE.test(req.params.workerId)) {
            return res.status(404).json({ error: 'Worker not found' });
        }
        const body = req.body || {};
        if (typeof body.username !== 'string' || !body.username.trim()) {
            return res.status(400).json({
                error: 'username is required',
                code: 'invalid_username',
            });
        }
        try {
            // Indistinct ownership probe FIRST — a foreign worker gets the
            // same 404 as an unknown one (no existence oracle).
            const workerRow = await workerRepo.findById(req.params.workerId);
            if (!workerRow || workerRow.workspace_id !== workspaceId) {
                return res.status(404).json({ error: 'Worker not found' });
            }
            const target = await userRepo.findByUsername(body.username.trim());
            if (!target) {
                return res.status(404).json({ error: 'User not found', code: 'unknown_user' });
            }
            const result = await workerRepo.revokeShareGrant(req.params.workerId, workspaceId, target.user_id);
            if (result.notFound) {
                return res.status(404).json({ error: 'Worker not found' });
            }
            // The end state is "no grant" either way (idempotent revoke).
            res.json({ revoked: result.removed });
        } catch (err) {
            console.error('[WORKERS] share users revoke failed:', err.message);
            res.status(500).json({ error: 'Failed to revoke share recipient' });
        }
    });

    console.log('[ROUTES] Private worker routes loaded');
};
