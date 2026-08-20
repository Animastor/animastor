// ======================================================
// Worker Auth Middleware (Experimental Beta — Private Worker Phase 1)
// ======================================================
// The single worker authentication boundary for worker-facing endpoints.
//
//   Authorization: Bearer wrk.<worker_id>.<secret>
//       → req.authenticatedWorker = { id, workspace_id, worker_type,
//                                     capabilities, mode, name }
//
// FAIL CLOSED: missing, malformed, unknown or revoked credential → 401.
// There is no configuration under which this middleware allows a request
// through without a valid credential (no "key unset → open" degradation).
//
// Downstream contract: handlers MUST use req.authenticatedWorker.id /
// req.authenticatedWorker.workspace_id. Values from req.body.worker_id,
// req.query.worker_id or req.body.workspace_id are NEVER identity — they are
// ignored (and must never be trusted again downstream).
//
// A worker token is NOT a user session: this middleware never sets req.user,
// and user endpoints guarded by requireAuth stay unreachable with a worker
// token (disjoint identity namespaces).

const workerAuth = require('../services/worker-auth');

/**
 * Express middleware factory.
 * @param {object} redis - redis client (mirror fast-path, Phase 2)
 */
function requireWorkerAuth(redis) {
    return async function workerAuthMiddleware(req, res, next) {
        req.authenticatedWorker = null;
        let worker = null;
        try {
            const token = workerAuth.extractBearerToken(req);
            if (!token) {
                return res.status(401).json({ error: 'Worker credential required', code: 'worker_credential_missing' });
            }
            worker = await workerAuth.authenticateWorker(redis, token);
        } catch (err) {
            // authenticateWorker already fails closed; anything escaping here
            // must never open the gate.
            console.error('[WORKER-AUTH] middleware error (denied):', err.message);
            return res.status(401).json({ error: 'Worker authentication failed', code: 'worker_auth_failed' });
        }
        if (!worker) {
            return res.status(401).json({ error: 'Invalid or revoked worker credential', code: 'worker_credential_invalid' });
        }
        req.authenticatedWorker = worker;
        next();
    };
}

module.exports = { requireWorkerAuth };
