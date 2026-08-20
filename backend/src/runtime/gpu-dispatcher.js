const config = require('../config/runtime-config');
const jobSchema = require('./job-schema');
const { PROTOCOL_VERSION } = jobSchema;

const logPrefix = '[GPU]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }
function warn(msg) { console.warn(`${logPrefix} ⚠️ ${msg}`); }

const stats = {
    audio_jobs_started: 0,
    image_jobs_started: 0,
    video_jobs_started: 0,
    failed_jobs: 0
};

// ======================================================
// PW-2: WORKSPACE RESOLUTION & ROUTING (server-derived)
// ======================================================
// The backend is the ONLY author of job.workspace_id: book → books.workspace_id
// (never client-supplied). A job is routed to the workspace queue ONLY when
// the workspace has an active private worker of the job type; otherwise it
// stays in the system pool (backward compatibility — workspaces without a
// private worker keep flowing to the operator's GPU).
//
// Resolution failures degrade to the system pool (availability): the hub's
// token-scoped pop remains the authoritative isolation control either way.

const WORKSPACE_CACHE_TTL_MS = 60_000;      // book → workspace
const ROUTING_CACHE_TTL_MS = 30_000;        // (workspace,type) → has private worker
const workspaceCache = new Map();
const routingCache = new Map();

function cacheGet(cache, key, ttlMs) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.ts > ttlMs) { cache.delete(key); return undefined; }
    return hit.value;
}

/**
 * Resolve the owning workspace for a book (server-side, cached).
 * @returns {Promise<string|null>} workspace_id or null (absent/unattached/error)
 */
async function resolveWorkspaceForBook(bookId) {
    if (!bookId) return null;
    const cached = cacheGet(workspaceCache, bookId, WORKSPACE_CACHE_TTL_MS);
    if (cached !== undefined) return cached;
    let workspaceId = null;
    try {
        const bookRepo = require('../storage/postgres/repositories/book-repo');
        workspaceId = await bookRepo.getWorkspaceId(bookId);
    } catch (err) {
        warn(`workspace resolution failed for book=${bookId}: ${err.message} — using system pool`);
        workspaceId = null;
    }
    workspaceCache.set(bookId, { value: workspaceId, ts: Date.now() });
    return workspaceId;
}

/**
 * Does the workspace have an active private worker of this type? (cached).
 * @returns {Promise<boolean>}
 */
async function workspaceHasPrivateWorker(workspaceId, workerType) {
    if (!workspaceId) return false;
    const key = `${workspaceId}:${workerType}`;
    const cached = cacheGet(routingCache, key, ROUTING_CACHE_TTL_MS);
    if (cached !== undefined) return cached;
    let has = false;
    try {
        const workerRepo = require('../storage/postgres/repositories/worker-repo');
        has = await workerRepo.hasActivePrivateWorkerOfType(workspaceId, workerType);
    } catch (err) {
        warn(`private-worker routing check failed for ws=${workspaceId} type=${workerType}: ${err.message} — using system pool`);
        has = false;
    }
    routingCache.set(key, { value: has, ts: Date.now() });
    return has;
}

/** Test hook: drop resolution caches. */
function clearRoutingCaches() {
    workspaceCache.clear();
    routingCache.clear();
}

/**
 * Default timeouts per job type (ms). Used when layer-config
 * provides per-type timeout values.
 */
const DEFAULT_TYPE_TIMEOUT_MS = {
    audio: 30 * 60 * 1000,   // 30 min
    image: 30 * 60 * 1000,   // 30 min
    video: 60 * 60 * 1000,   // 60 min
};



// T4: Структурированный результат отправки
// { sent: true, jobId } или { sent: false, error }
async function sendUnified(taskSpec) {
    if (!taskSpec.job_id || !taskSpec.params || !taskSpec.job_type) {
        throw new Error("Invalid task specification");
    }
    const validTypes = ['audio', 'image', 'video'];
    if (!validTypes.includes(taskSpec.job_type)) {
        throw new Error("Invalid job type");
    }
    if (!taskSpec.dispatch_id || typeof taskSpec.dispatch_id !== 'string') {
        throw new Error("dispatch_id is required");
    }

    const parsed = jobSchema.parseJobId(taskSpec.job_id);
    if (!parsed) {
        throw new Error(`Invalid job_id: ${taskSpec.job_id}`);
    }

    // Per-type timeout: use taskSpec.timeout_ms if provided, else use DEFAULT_TYPE_TIMEOUT_MS,
    // else fall back to config.GPU_TIMEOUT_MS (global default).
    const timeoutMs = taskSpec.timeout_ms
        ?? DEFAULT_TYPE_TIMEOUT_MS[taskSpec.job_type]
        ?? config.GPU_TIMEOUT_MS
        ?? 600_000;

    // PW-2: server-derived workspace routing. workspace_id is ONLY ever set
    // here (book → workspace → active private worker of the type). Callers
    // cannot inject it: any client-supplied value is overwritten.
    let workspaceId = null;
    const bookWorkspace = await resolveWorkspaceForBook(parsed.bookId);
    if (bookWorkspace && await workspaceHasPrivateWorker(bookWorkspace, taskSpec.job_type)) {
        workspaceId = bookWorkspace;
    }

    const payload = {
        ...taskSpec,
        timeout_ms: timeoutMs,
        build_id: taskSpec.build_id || "default",
        protocol_version: PROTOCOL_VERSION,
        book_id: parsed.bookId,
        chapter_id: parsed.chapterId,
        scene_id: parsed.sceneId,
        stage: jobSchema.STAGE_BY_KIND[parsed.kind],
        workspace_id: workspaceId,
    };

    // T9: Include GPU_HUB_API_KEY header for authenticated requests
    const headers = { "Content-Type": "application/json" };
    if (config.GPU_HUB_API_KEY) {
        headers['x-api-key'] = config.GPU_HUB_API_KEY;
    }

    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            const res = await fetch(`${config.HUB_URL}/task`, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            log(`Task sent: ${payload.job_id} (${payload.job_type}), build: ${payload.build_id}, dispatch: ${payload.dispatch_id}, ws: ${workspaceId || '(system pool)'}`);
            switch (payload.job_type) {
                case 'audio': stats.audio_jobs_started++; break;
                case 'image': stats.image_jobs_started++; break;
                case 'video': stats.video_jobs_started++; break;
            }
            return { sent: true, jobId: payload.job_id, dispatchId: payload.dispatch_id };
        } catch (err) {
            lastError = err;
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
        }
    }
    stats.failed_jobs++;
    return { sent: false, error: lastError ? lastError.message : 'max_retries' };
}

async function send(job_id, workflow, type, build_id, dispatch_id) {
    return sendUnified({ job_id, params: workflow, job_type: type, build_id, dispatch_id });
}

module.exports = { send, sendUnified, resolveWorkspaceForBook, workspaceHasPrivateWorker, clearRoutingCaches };
