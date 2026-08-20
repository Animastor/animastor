// ======================================================
// Worker Auth Service (Experimental Beta — Private Worker Phase 1)
// ======================================================
// The single worker authentication boundary.
//
//   Bearer wrk.<worker_id>.<secret>  →  authenticatedWorker {
//       id, workspace_id, worker_type, capabilities, mode, name
//   }
//
// FAIL CLOSED by construction:
//   - missing / malformed / unknown / revoked credential → null (caller 401);
//   - there is NO "auth not configured → allow" path — a worker identity can
//     only ever come from a registered, non-revoked credential row;
//   - worker_id / workspace_id from query/body are NEVER consulted here or
//     downstream — identity is derived exclusively from the credential.
//
// Resolution: PostgreSQL `workers` table — durable source of truth. The
// Redis mirror `animastor:worker-auth` (hash: token_hash → identity JSON) is
// maintained here for the hub's hot path (Phase 2); it is rebuilt from PG
// and never authoritative — the backend boundary always resolves against PG.
//
// The mirror is maintained here: startup + periodic full rebuild from PG
// (Redis-loss recovery per redis-failure-model doctrine) plus point updates
// on create/rotate/revoke.
// ======================================================

const workerRepo = require('../storage/postgres/repositories/worker-repo');

const WORKER_AUTH_MIRROR_KEY = 'animastor:worker-auth';
const MIRROR_RESYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Identity shape exposed to downstream handlers (nothing more). */
function toAuthenticatedWorker(row) {
    return {
        id: row.worker_id,
        workspace_id: row.workspace_id,
        worker_type: row.worker_type,
        capabilities: row.capabilities || null,
        mode: row.mode,
        name: row.name,
    };
}

function mirrorValue(row) {
    return JSON.stringify({
        worker_id: row.worker_id,
        workspace_id: row.workspace_id,
        worker_type: row.worker_type,
        mode: row.mode,
        name: row.name,
    });
}

/**
 * Extract the raw Bearer token from a request (Authorization header only —
 * tokens are never accepted in query strings or bodies).
 * @returns {string|null}
 */
function extractBearerToken(req) {
    const header = req && req.headers && req.headers.authorization;
    if (!header || typeof header !== 'string') return null;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

/**
 * Authenticate a worker credential. FAIL CLOSED: any error, unknown hash,
 * revoked row or PG outage yields null — never an identity.
 * @param {object} redis - reserved for the mirror fast-path (Phase 2 hub
 *   resolves via the mirror); the backend boundary resolves against PG.
 * @param {string} token - raw `wrk.*` token
 * @returns {Promise<object|null>} authenticatedWorker or null
 */
async function authenticateWorker(redis, token) {
    const parsed = workerRepo.parseToken(token);
    if (!parsed) return null;
    try {
        const row = await workerRepo.findByToken(token);
        if (!row) return null;
        return toAuthenticatedWorker(row);
    } catch (err) {
        // PG outage: fail closed — an unresolvable credential authenticates
        // nothing. Never degrade to "allow".
        console.error('[WORKER-AUTH] resolution failed (denied):', err.message);
        return null;
    }
}

// ── mirror maintenance ────────────────────────────────────────────────────

/**
 * Full mirror rebuild from PG: the mirror becomes exactly the set of active
 * (non-revoked) credentials. Heals Redis loss, revoke-during-blip races and
 * any drift. Safe to call at any time (idempotent).
 * @returns {Promise<{synced:number}>}
 */
async function syncWorkerAuthMirror(redis) {
    if (!redis) return { synced: 0 };
    const rows = await workerRepo.listActive();
    const pipeline = redis.pipeline ? redis.pipeline() : null;
    const fresh = new Map();
    for (const row of rows) {
        fresh.set(row.token_hash, mirrorValue(row));
    }
    try {
        // Replace atomically-ish: delete the key, then write the fresh set.
        if (pipeline) {
            pipeline.del(WORKER_AUTH_MIRROR_KEY);
            for (const [hash, value] of fresh) pipeline.hset(WORKER_AUTH_MIRROR_KEY, hash, value);
            await pipeline.exec();
        } else {
            await redis.del(WORKER_AUTH_MIRROR_KEY);
            for (const [hash, value] of fresh) await redis.hset(WORKER_AUTH_MIRROR_KEY, hash, value);
        }
    } catch (err) {
        console.warn('[WORKER-AUTH] mirror rebuild failed (non-fatal):', err.message);
    }
    return { synced: fresh.size };
}

/** Point update: add/replace one credential in the mirror. */
async function mirrorPut(redis, row) {
    if (!redis) return;
    try {
        await redis.hset(WORKER_AUTH_MIRROR_KEY, row.token_hash, mirrorValue(row));
    } catch (err) {
        console.warn('[WORKER-AUTH] mirror put failed (healed by next resync):', err.message);
    }
}

/** Point update: drop dead credential hashes from the mirror. */
async function mirrorDrop(redis, tokenHashes) {
    if (!redis || !tokenHashes || tokenHashes.length === 0) return;
    try {
        await redis.hdel(WORKER_AUTH_MIRROR_KEY, ...tokenHashes);
    } catch (err) {
        console.warn('[WORKER-AUTH] mirror drop failed (healed by next resync):', err.message);
    }
}

/**
 * Start the periodic mirror resync (startup rebuild + interval). Returns a
 * stop function. Non-fatal: failures only log.
 */
function startWorkerAuthMirrorSync(redis, { intervalMs = MIRROR_RESYNC_INTERVAL_MS } = {}) {
    let stopped = false;
    const runOnce = async () => {
        if (stopped) return;
        try {
            const { synced } = await syncWorkerAuthMirror(redis);
            console.log(`[WORKER-AUTH] mirror resync complete (${synced} active credentials)`);
        } catch (err) {
            console.warn('[WORKER-AUTH] periodic mirror resync failed (non-fatal):', err.message);
        }
    };
    runOnce();
    const timer = setInterval(runOnce, intervalMs);
    if (timer.unref) timer.unref();
    return () => { stopped = true; clearInterval(timer); };
}

module.exports = {
    WORKER_AUTH_MIRROR_KEY,
    MIRROR_RESYNC_INTERVAL_MS,
    authenticateWorker,
    extractBearerToken,
    syncWorkerAuthMirror,
    mirrorPut,
    mirrorDrop,
    startWorkerAuthMirrorSync,
    toAuthenticatedWorker,
};
