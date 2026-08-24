// ======================================================
// GPU HUB - v0.1.0 (Experimental Beta — Private Worker Phase 2)
// ======================================================
// Workspace-aware job ownership:
//   - worker identity comes ONLY from a Bearer credential resolved via the
//     backend-maintained Redis mirror `animastor:worker-auth` (hub has no pg);
//   - the backend resolves `book → workspace` at dispatch and passes
//     workspace_id in /task (key-gated) → hub enqueues to
//     `queue:{type}:ws:{workspace}`; the system pool (`queue:{type}`) is kept
//     for workspaces without a private worker of the type;
//   - /task/next pops ONLY the token-derived workspace+type key — a private
//     worker can never see another workspace's queue or the system pool;
//   - the claim binds the running record to the authenticated worker +
//     workspace; /task/result and /task/error are claimer-only;
//   - poison-write cross-check on pop; `processing` orphan sweep requeues
//     crashed claims back to the correct queue (capped, then backend error).
// The hub stays a dumb transport: ownership is DATA (workspace_id authored by
// the backend), never hub policy and never client-supplied. Requests without
// a credential stay in the legacy system-pool lane (backward compatibility).

const express = require("express")
const cors = require("cors")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

// SYNC: backend/src/runtime/job-schema.js (PROTOCOL_VERSION)
const PROTOCOL_VERSION = 2;

// ======================================================
// CONSTANTS
// ======================================================

// SYNC: backend/src/services/worker-auth.js — mirror key + value shape
// ({ worker_id, workspace_id, worker_type, mode, name }).
const WORKER_AUTH_MIRROR_KEY = 'animastor:worker-auth';
// Claim bookkeeping for the processing orphan sweep (job_id → claim JSON).
const PROCESSING_CLAIMED_KEY = 'animastor:processing-claimed';
// Poison / requeue-limit entries land here (kept for audit, never requeued).
const DEAD_LETTER_KEY = 'animastor:dead-letter';
// A processing entry without a running record is requeued only after this
// grace — covers the rpoplpush→hset crash window and sweep/read races.
const ORPHAN_GRACE_MS = Number(process.env.ORPHAN_GRACE_MS || 60000);
// Cap requeues of the same orphaned task; afterwards it is dead-lettered and
// reported to the backend (the scheduler re-dispatches via lease expiry).
const MAX_ORPHAN_REQUEUES = Number(process.env.MAX_ORPHAN_REQUEUES || 3);

const SYSTEM_JOB_TYPES = ['audio', 'image', 'video'];

// ======================================================
// WORKER TOKEN (mirror fast-path)
// ======================================================
// SYNC: backend/src/storage/postgres/repositories/worker-repo.js — token
// format `wrk.<worker_id_b64url>.<secret_b64url>`; the mirror field is the
// SHA-256 of the secret. The hub NEVER resolves identity from query/body.

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Parse a raw worker token → { workerId, secretHash } or null. */
function parseWorkerToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'wrk') return null;
  try {
    const workerId = b64urlDecode(parts[1]).toString('utf8');
    const secret = b64urlDecode(parts[2]);
    if (!workerId || secret.length === 0) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workerId)) return null;
    return { workerId, secretHash: sha256(secret) };
  } catch (_) {
    return null;
  }
}

/** Authorization header only — tokens are never accepted in query/body. */
function extractBearerToken(req) {
  const header = req && req.headers && req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Resolve a worker credential via the Redis auth mirror. FAIL CLOSED:
 * malformed token, missing mirror entry, corrupt JSON, worker_id mismatch or
 * missing workspace all yield null — never an identity.
 * @returns {Promise<{worker_id,workspace_id,worker_type,mode,name}|null>}
 */
async function authenticateWorkerMirror(redis, token) {
  const parsed = parseWorkerToken(token);
  if (!parsed) return null;
  try {
    const raw = await redis.hget(WORKER_AUTH_MIRROR_KEY, parsed.secretHash);
    if (!raw) return null;
    const identity = JSON.parse(raw);
    if (!identity || typeof identity !== 'object') return null;
    // Cross-check the mirror value against the token's self-locator.
    if (identity.worker_id !== parsed.workerId) return null;
    if (!identity.workspace_id || !identity.worker_type) return null;
    return identity;
  } catch (_) {
    return null;
  }
}

const WORKSPACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ======================================================
// HUB APP FACTORY (testable; server.js starts it)
// ======================================================

function buildHubApp({ redis, config = {}, fetchImpl, intervals = true } = {}) {
  if (!redis) throw new Error('buildHubApp: redis is required');

  const {
    BACKEND_URL = "http://animastor-backend:3000",
    // 10 min — image ~1-2min, audio ~30s, video (LTX) ~5-10min.
    // ИНВАРИАНТ: GPU_TIMEOUT_MS должен быть МЕНЬШЕ STALL_FAILSAFE_MS backend'а
    // (backend/src/config/runtime-config.js, формула GPU_TIMEOUT_MS * 3).
    GPU_TIMEOUT_MS = 600000,
    GPU_HUB_API_KEY = null,
  } = config;

  const doFetch = fetchImpl || ((url, options) => fetch(url, options));

  const app = express()
  app.use(cors())
  app.use(express.json({ limit: "500mb" }))

  // ======================================================
  // API KEY AUTH
  // ======================================================

  function requireApiKey(req, res, next) {
    if (!GPU_HUB_API_KEY) return next(); // no key configured = open access
    // T9: Header-only — не принимаем ключ в query string
    const provided = req.headers['x-api-key'];
    if (provided !== GPU_HUB_API_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  }

  /** Headers for the hub→backend hop (key-authenticated when configured). */
  function backendHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (GPU_HUB_API_KEY) headers['x-api-key'] = GPU_HUB_API_KEY;
    return headers;
  }

  // ======================================================
  // GPU REGISTRY (Redis-backed, survives restart)
  // ======================================================

  const GPU_REGISTRY_KEY = 'animastor:gpu-hub:workers';

  async function getGpuFromRedis(id) {
    try {
      const raw = await redis.hget(GPU_REGISTRY_KEY, id);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  async function getAllGpusFromRedis() {
    try {
      const raw = await redis.hgetall(GPU_REGISTRY_KEY);
      if (!raw) return new Map();
      const result = new Map();
      for (const [id, json] of Object.entries(raw)) {
        result.set(id, JSON.parse(json));
      }
      return result;
    } catch { return new Map(); }
  }

  async function setGpuInRedis(id, data) {
    try {
      await redis.hset(GPU_REGISTRY_KEY, id, JSON.stringify(data));
      // TTL: prune stale registrations automatically
      await redis.expire(GPU_REGISTRY_KEY, 900); // 15 min
    } catch {}
  }

  async function deleteGpuFromRedis(id) {
    try { await redis.hdel(GPU_REGISTRY_KEY, id); } catch {}
  }

  // ======================================================
  // QUEUES
  // ======================================================
  // PW-2: workspace-scoped queue keys are derived from SERVER data only:
  //   enqueue — workspace_id authored by the backend in /task (key-gated);
  //   pop     — workspace_id from the authenticated token (never query/body).
  // The system pool keeps the legacy per-type keys.

  function queueKeyFor(type, workspaceId) {
    return workspaceId
      ? `animastor:queue:${type}:ws:${workspaceId}`
      : `animastor:queue:${type}`;
  }

  /** Discover all queue keys (system + workspace) via SCAN — never hardcode. */
  async function discoverQueueKeys() {
    const keys = new Set();
    for (const type of SYSTEM_JOB_TYPES) keys.add(`animastor:queue:${type}`);
    try {
      let cursor = '0';
      do {
        const scan = await redis.scan(cursor, 'MATCH', 'animastor:queue:*', 'COUNT', 500);
        cursor = scan[0];
        for (const key of scan[1] || []) keys.add(key);
      } while (cursor !== '0');
    } catch (_) {}
    return [...keys];
  }

  /** Dead-letter a poison/orphan-limit entry: kept for audit, never requeued. */
  async function deadLetter(rawEntry, reason) {
    try {
      await redis.lpush(DEAD_LETTER_KEY, JSON.stringify({
        reason: reason || 'unknown',
        ts: Date.now(),
        entry: rawEntry,
      }));
      await redis.expire(DEAD_LETTER_KEY, 7 * 24 * 3600).catch(() => {});
    } catch (_) {}
  }

  // ======================================================
  // ERROR DELIVERY → BACKEND
  // ======================================================
  // T3 консолидации: любая ошибка задачи (сбой воркера, worker_timeout)
  // доносится до backend → orchestrator.failStage. До этого backend узнавал
  // о падении только по истечении dispatch-lease (15–30 мин).
  // При недоставке — фолбэк-ключ animastor:error:{job_id} (симметрично
  // animastor:result:* для результатов), его подберёт recovery.

  function jobDedupKey(job_id, dispatch_id) {
    return `animastor:job:${dispatch_id}:${job_id}`;
  }

  async function notifyBackendError(job_id, build_id, dispatch_id, reason, ownership = {}) {
    for (let i = 0; i < 5; i++) {
      try {
        const backendRes = await doFetch(
          `${BACKEND_URL}/gpu/task/error`,
          {
            method: "POST",
            headers: backendHeaders(),
            body: JSON.stringify({
              job_id,
              build_id: build_id || null,
              dispatch_id,
              protocol_version: PROTOCOL_VERSION,
              reason: reason || "unknown",
              // PW-2: audit-only forwarding — the backend re-verifies
              // job→book→workspace itself and never trusts these fields.
              worker_id: ownership.worker_id || null,
              workspace_id: ownership.workspace_id || null
            })
          }
        )
        if (!backendRes.ok) throw new Error(`HTTP ${backendRes.status}`)
        return true
      } catch (err) {
        console.error(`⚠️ backend error-delivery retry ${i + 1} failed`, job_id, err.message)
        await new Promise(r => setTimeout(r, 500))
      }
    }
    console.error("❌ backend error-delivery failed:", job_id)
    try {
      await redis.set(
        `animastor:error:${job_id}`,
        JSON.stringify({
          job_id,
          build_id: build_id || null,
          dispatch_id,
          protocol_version: PROTOCOL_VERSION,
          reason: reason || "unknown",
          ts: Date.now()
        }),
        "EX",
        3600
      )
    } catch (_) {}
    return false
  }

  // ======================================================
  // HEARTBEAT REFRESH + GPU TIMEOUT + ORPHAN SWEEP (10s)
  // ======================================================
  // Responsibilities of the interval:
  // 1. Refresh heartbeat for running tasks so busyImage stays valid
  // 2. Clean up timed-out GPUs and report their tasks as failed to backend
  //    (T3: hub — тупой транспорт; retry-решение принимает backend-планировщик)
  // 3. PW-2: sweep `animastor:processing` for orphaned claims (crash between
  //    rpoplpush and the running-record write) and requeue them.

  async function heartbeatAndTimeoutSweep() {
    const now = Date.now()

    // ── Refresh heartbeat for all running tasks ──
    try {
      const running = await redis.hgetall("animastor:running")
      for (const job_id in running) {
        try {
          const data = JSON.parse(running[job_id])
          if (data.worker && data.job_type) {
            const hbKey = `animastor:worker:heartbeat:${data.job_type}:${data.worker}`
            const hbPayload = JSON.stringify({
              type: data.job_type,
              worker_id: data.worker,
              ts: Date.now(),
              current_job_id: job_id,
              current_dispatch_id: data.dispatch_id || null,
              // VISIBILITY: scope fields — the backend counts a heartbeat as
              // globally available ONLY when it carries no workspace (system
              // pool). A private worker's heartbeat stays workspace-scoped.
              workspace_id: data.workspace_id || null,
              mode: data.worker_mode || null,
              version: data.worker_version || null,
              image_tag: data.worker_image_tag || null,
              protocol_version: data.worker_protocol_version || null
            })
            await redis.set(hbKey, hbPayload, 'EX', 30)
          }
        } catch (_) {}
      }
    } catch (_) {}

    // ── GPU timeout cleanup (Redis-backed) ──
    const allGpus = await getAllGpusFromRedis();
    const running = await redis.hgetall("animastor:running")
    const runningMap = new Map(Object.entries(running || {}).map(([k, v]) => [k, JSON.parse(v)]));

    // ── Level 1: Per-job timeout ──
    for (const [job_id, data] of runningMap) {
      const jobTimeoutMs = data.timeout_ms || GPU_TIMEOUT_MS;
      const jobStarted = data.started_at || 0;
      if (now - jobStarted > jobTimeoutMs) {
        console.log(`💀 Job timeout: ${job_id} (type=${data.job_type}, timeout=${Math.round(jobTimeoutMs / 1000)}s, started=${Math.round((now - jobStarted) / 1000)}s ago)`)
        try {
          await redis.hdel("animastor:running", job_id)
          if (data.task_raw) {
            await redis.lrem("animastor:processing", 1, data.task_raw).catch(() => {})
          }
          await redis.hdel(PROCESSING_CLAIMED_KEY, job_id).catch(() => {})
          if (data.dispatch_id) {
            await redis.del(jobDedupKey(job_id, data.dispatch_id)).catch(() => {})
          }
          await notifyBackendError(job_id, data.build_id, data.dispatch_id, "worker_timeout", {
            worker_id: data.worker || null,
            workspace_id: data.workspace_id || null
          })
        } catch (err) {
          console.error("Job timeout error:", err)
        }
      }
    }

    // ── Level 2: Per-GPU timeout (for jobs still running on stale GPUs) ──
    for (const [id, gpu] of allGpus) {

      if (now - gpu.last_seen > GPU_TIMEOUT_MS) {

        console.log("💀 GPU timeout:", id)

        for (const [job_id, data] of runningMap) {
          if (data.worker === id) {
            // Skip if already handled by per-job timeout
            const jobTimeoutMs = data.timeout_ms || GPU_TIMEOUT_MS;
            const jobStarted = data.started_at || 0;
            if (now - jobStarted > jobTimeoutMs) continue;

            console.log("💀 Worker timeout, reporting failure:", job_id)

            await redis.hdel("animastor:running", job_id)
            if (data.task_raw) {
              await redis.lrem("animastor:processing", 1, data.task_raw).catch(() => {})
            }
            await redis.hdel(PROCESSING_CLAIMED_KEY, job_id).catch(() => {})

            // Освобождаем dedup очереди, чтобы re-dispatch backend'а не
            // отбился как duplicate.
            if (data.dispatch_id) {
              await redis.del(jobDedupKey(job_id, data.dispatch_id)).catch(() => {})
            }

            await notifyBackendError(job_id, data.build_id, data.dispatch_id, "worker_timeout", {
              worker_id: data.worker || null,
              workspace_id: data.workspace_id || null
            })
          }
        }

        await deleteGpuFromRedis(id);
      }
    }
  }

  /**
   * PW-2 processing orphan sweep. An entry in `animastor:processing` with no
   * `animastor:running` record is a crashed claim (hub died between rpoplpush
   * and the running write — no recovery reader existed before). After a grace
   * period the task is requeued to ITS OWN queue (workspace-scoped or system);
   * after MAX_ORPHAN_REQUEUES it is dead-lettered and reported to the backend.
   * Poison entries (unparseable / no job_id) are dead-lettered, never requeued.
   */
  async function sweepProcessingOrphans(now = Date.now()) {
    let items = [];
    try {
      items = await redis.lrange("animastor:processing", 0, -1) || [];
    } catch (_) { return; }

    for (const raw of items) {
      let task = null;
      try { task = JSON.parse(raw); } catch (_) { task = null; }
      if (!task || !task.job_id) {
        await redis.lrem("animastor:processing", 1, raw).catch(() => {});
        await deadLetter(raw, 'poison_processing_entry');
        continue;
      }
      const jobId = task.job_id;

      let runningRaw = null;
      try { runningRaw = await redis.hget("animastor:running", jobId); } catch (_) {}
      if (runningRaw) {
        // Actively claimed — drop any stale orphan bookkeeping.
        await redis.hdel(PROCESSING_CLAIMED_KEY, jobId).catch(() => {});
        continue;
      }

      let seen = null;
      try {
        const seenRaw = await redis.hget(PROCESSING_CLAIMED_KEY, jobId);
        seen = seenRaw ? JSON.parse(seenRaw) : null;
      } catch (_) { seen = null; }

      if (!seen) {
        // First sighting — start the grace window, do not act yet.
        await redis.hset(PROCESSING_CLAIMED_KEY, jobId, JSON.stringify({ first_seen: now })).catch(() => {});
        continue;
      }
      if (now - (seen.first_seen || now) < ORPHAN_GRACE_MS) continue;

      // Confirmed orphan — pull it out of processing first.
      await redis.lrem("animastor:processing", 1, raw).catch(() => {});
      await redis.hdel(PROCESSING_CLAIMED_KEY, jobId).catch(() => {});

      const requeues = Number(task.orphan_requeues || 0);
      if (requeues >= MAX_ORPHAN_REQUEUES) {
        console.error(`☠️ Orphan requeue limit reached: ${jobId} (${requeues} requeues) — dead-lettered`);
        await deadLetter(raw, 'orphan_requeue_limit');
        await notifyBackendError(jobId, task.build_id, task.dispatch_id, "orphaned_task", {
          workspace_id: task.workspace_id || null
        });
        continue;
      }

      // Requeue to the task's OWN queue — workspace-scoped or system pool.
      const queueKey = queueKeyFor(task.job_type || 'image', task.workspace_id || null);
      task.orphan_requeues = requeues + 1;
      try {
        await redis.lpush(queueKey, JSON.stringify(task));
        console.log(`♻️ Orphan requeued: ${jobId} → ${queueKey} (attempt ${task.orphan_requeues})`);
      } catch (err) {
        console.error(`Orphan requeue failed: ${jobId}`, err.message);
        await deadLetter(raw, 'orphan_requeue_failed');
      }
    }
  }

  let intervalTimer = null;
  if (intervals) {
    intervalTimer = setInterval(() => {
      heartbeatAndTimeoutSweep().catch(err => console.error('Hub sweep error:', err.message));
      sweepProcessingOrphans().catch(err => console.error('Orphan sweep error:', err.message));
    }, 10000);
    if (intervalTimer.unref) intervalTimer.unref();
  }

  // ======================================================
  // BEACON
  // ======================================================
  // PW-2: with a Bearer credential the registry identity is server-derived
  // (worker_id/worker_type from the token; body fields are labels only).
  // Without a credential the legacy system-pool beacon is kept as-is.

  app.post("/beacon", async (req, res) => {

    const auth = await authenticateWorkerMirror(redis, extractBearerToken(req));
    if (extractBearerToken(req) && !auth) {
      return res.status(401).json({ error: 'invalid_worker_credential' });
    }

    const { id, type, gpu, vram, version, image_tag, protocol_version } = req.body
    const workerId = auth ? auth.worker_id : id;
    const workerType = auth ? auth.worker_type : type;

    if (!workerId || !workerType) {
      return res.status(400).json({ error: "worker_identity_required" })
    }
    if (protocol_version !== PROTOCOL_VERSION) {
      return res.status(409).json({
        error: "protocol_version_mismatch",
        expected: PROTOCOL_VERSION,
        received: protocol_version || null
      })
    }

    const data = {
      id: workerId,
      type: workerType,
      gpu,
      vram,
      version: version || null,
      image_tag: image_tag || null,
      protocol_version: protocol_version || null,
      workspace_id: auth ? auth.workspace_id : null,
      last_seen: Date.now()
    };

    // Primary registry: Redis (survives restart, cluster-aware)
    await setGpuInRedis(workerId, data);

    // Also write heartbeat for backend worker count panel.
    // VISIBILITY: the payload carries the token-derived scope (workspace_id +
    // mode) so the backend can separate SYSTEM capacity from a workspace's
    // PRIVATE workers. Legacy (uncredentialed) beacons carry no scope → they
    // count as the system/operator pool, exactly as before.
    try {
      const key = `animastor:worker:heartbeat:${workerType}:${workerId}`;
      const payload = JSON.stringify({
        type: workerType,
        worker_id: workerId,
        ts: Date.now(),
        workspace_id: auth ? auth.workspace_id : null,
        mode: auth ? (auth.mode || null) : null,
        version: version || null,
        image_tag: image_tag || null,
        protocol_version: protocol_version || null
      });
      await redis.set(key, payload, 'EX', 30);
    } catch (_) {}

    res.json({ ok: true })
  })

  // ======================================================
  // TASK CREATE
  // ======================================================

  app.post("/task", requireApiKey, async (req, res) => {

    const {
      job_id,
      params,
      job_type,
      assets,
      build_id,
      protocol_version,
      dispatch_id,
      book_id,
      chapter_id,
      scene_id,
      stage,
      workspace_id,
      timeout_ms
    } = req.body

    const type = job_type || "image"

    console.log("📥 Task:", job_id, type, "build:", build_id, "timeout_ms:", timeout_ms || "(default)", "workspace:", workspace_id || "(system pool)")

    // SYNC: backend/src/runtime/job-schema.js (PROTOCOL_VERSION)
    if (protocol_version !== PROTOCOL_VERSION) {
      return res.status(409).json({
        error: "protocol_version_mismatch",
        expected: PROTOCOL_VERSION,
        received: protocol_version || null
      })
    }
    if (!dispatch_id || !build_id || !book_id || !chapter_id || !scene_id || !stage) {
      return res.status(400).json({ error: "incomplete_dispatch_identity" })
    }
    // PW-2: workspace_id is backend-authored (book → workspace). The hub
    // validates shape only — a malformed value is rejected, never trusted.
    if (workspace_id !== undefined && workspace_id !== null) {
      if (typeof workspace_id !== 'string' || !WORKSPACE_ID_RE.test(workspace_id)) {
        return res.status(400).json({ error: "invalid_workspace_id" })
      }
    }

    if (assets?.image) {
      console.log(
        "🖼 asset image size:",
        Math.round(assets.image.length / 1024),
        "KB"
      )
    }
    // BEST-EFFORT dedup: защищает только очередь hub'а от двойного enqueue.
    // Авторитетный dedup результатов — на backend
    // (animastor:result-processed:{job_id}:{build_id}, generation-routes).
    // Этот ключ НЕ гарантия и не должен блокировать легитимный retry —
    // backend чистит его перед принудительным re-dispatch.
    const isNew = await redis.set(
      jobDedupKey(job_id, dispatch_id),
      1,
      "NX",
      "EX",
      3600
    )

    if (!isNew) {
      console.log("⚠️ Duplicate job ignored:", job_id)
      return res.json({ ok: true, duplicate: true })
    }

    await redis.lpush(
      queueKeyFor(type, workspace_id || null),
      JSON.stringify({
        job_id,
        params,
        job_type: type,
        assets: assets || null,
        build_id: build_id || null,
        protocol_version,
        // T9: Structured ownership для точной фильтрации без prefix-коллизий
        book_id,
        chapter_id,
        scene_id,
        stage,
        dispatch_id,
        // PW-2: server-derived ownership anchor (backend-authored; null =
        // system pool job — never set from any worker-facing input).
        workspace_id: workspace_id || null,
        // Per-job timeout, переданный backend'ом (layer-config per-type timeout).
        // Без проброса per-job timeout падал бы на GPU_TIMEOUT_MS (10 мин по
        // умолчанию) — нормальная долгая видео-генерация (20-60+ мин) убивалась
        // как worker_timeout. ИНВАРИАНТ: per-job timeout >= GPU_TIMEOUT_MS —
        // ниже базового порога не опускаемся никогда.
        timeout_ms: timeout_ms && Number(timeout_ms) > 0
          ? Math.max(Number(timeout_ms), GPU_TIMEOUT_MS)
          : null
      })
    )

    res.json({ ok: true })
  })

  // ======================================================
  // TASK NEXT
  // ======================================================
  // PW-2: identity comes ONLY from the Bearer credential. A credentialed
  // worker pops ONLY its own workspace+type queue; an uncredentialed request
  // (legacy system worker) pops ONLY the system pool. The `worker`/`type`
  // query params are never identity — they are validated against the token.

  app.get("/task/next", async (req, res) => {

    const auth = await authenticateWorkerMirror(redis, extractBearerToken(req));
    if (extractBearerToken(req) && !auth) {
      return res.status(401).json({ error: 'invalid_worker_credential' });
    }

    const { worker, type } = req.query

    // Credentialed lane: identity is token-derived; query params must agree.
    const workerId = auth ? auth.worker_id : worker;
    const workerType = auth ? auth.worker_type : (type || "image");

    if (!workerId) {
      return res.status(400).json({ error: "worker required" })
    }
    if (auth && type && auth.worker_type !== type) {
      // A private worker may only ever pop its registered type.
      return res.status(409).json({
        error: "worker_type_mismatch",
        registered: auth.worker_type,
        requested: type
      })
    }

    const gpu = await getGpuFromRedis(workerId);
    if (!gpu) {
      return res.status(404).json({ error: "not registered" })
    }
    if (gpu.protocol_version !== PROTOCOL_VERSION) {
      return res.status(409).json({
        error: "worker_protocol_mismatch",
        expected: PROTOCOL_VERSION,
        received: gpu.protocol_version || null
      })
    }
    if (workerType && gpu.type !== workerType) {
      return res.status(409).json({
        error: "worker_type_mismatch",
        registered: gpu.type,
        requested: workerType
      })
    }

    gpu.last_seen = Date.now();
    await setGpuInRedis(workerId, gpu);

    // PW-2: token-scoped pop. Private worker → its workspace queue ONLY;
    // system lane → system pool ONLY. Cross-workspace and system-pool access
    // are structurally impossible (the key is never derivable from the client).
    const queueKey = queueKeyFor(workerType, auth ? auth.workspace_id : null)

    const taskRaw = await redis.rpoplpush(
      queueKey,
      "animastor:processing"
    )

    if (!taskRaw) return res.json({ task: null })

    const task = JSON.parse(taskRaw)

    // PW-2 poison-write cross-check: the popped item's workspace must match
    // the token's workspace (system lane: item must have no workspace). A
    // mismatch means a poison write — dead-letter it, never hand it out.
    const expectedWs = auth ? auth.workspace_id : null;
    if ((task.workspace_id || null) !== expectedWs) {
      console.error(`🧪 Poison write detected on ${queueKey}: job=${task.job_id} task_ws=${task.workspace_id || 'null'} expected=${expectedWs || 'null'}`);
      await redis.lrem("animastor:processing", 1, taskRaw).catch(() => {});
      await deadLetter(taskRaw, 'poison_workspace_mismatch');
      return res.json({ task: null })
    }

    await redis.hset(
      "animastor:running",
      task.job_id,
      JSON.stringify({
        worker: workerId,
        // PW-2: claim binds the job to the authenticated worker + workspace.
        workspace_id: auth ? auth.workspace_id : null,
        // VISIBILITY: kept so heartbeat refreshes (sweep/result/error) can
        // re-stamp the scope without re-authenticating.
        worker_mode: auth ? (auth.mode || null) : null,
        job_type: task.job_type,
        params: task.params,
        assets: task.assets || null,
        build_id: task.build_id || null,
        book_id: task.book_id,
        chapter_id: task.chapter_id,
        scene_id: task.scene_id,
        stage: task.stage,
        dispatch_id: task.dispatch_id,
        timeout_ms: task.timeout_ms || null,
        protocol_version: task.protocol_version,
        worker_version: gpu.version || null,
        worker_image_tag: gpu.image_tag || null,
        worker_protocol_version: gpu.protocol_version || null,
        task_raw: taskRaw,
        started_at: Date.now()
      })
    )

    console.log(`🚀 ${task.job_id} → ${workerId} (${task.job_type}) build:${task.build_id || "none"} timeout_ms:${task.timeout_ms || "(default)"} ws:${auth ? auth.workspace_id : "(system)"}`)

    // Mark worker as busy in heartbeat (scope fields per VISIBILITY note).
    try {
      const hbKey = `animastor:worker:heartbeat:${task.job_type}:${workerId}`;
      const hbPayload = JSON.stringify({
        type: task.job_type,
        worker_id: workerId,
        ts: Date.now(),
        current_job_id: task.job_id,
        current_dispatch_id: task.dispatch_id,
        workspace_id: auth ? auth.workspace_id : null,
        mode: auth ? (auth.mode || null) : null,
        version: gpu.version || null,
        image_tag: gpu.image_tag || null,
        protocol_version: gpu.protocol_version || null
      });
      await redis.set(hbKey, hbPayload, 'EX', 30);
    } catch (_) {}

    res.json({ task })
  })

  // ======================================================
  // RESULT (WITH RETRY)
  // ======================================================
  // PW-2: claimer-only. The submitter must be the worker that claimed the job
  // (worker + dispatch + workspace all match the running record). A worker can
  // never complete another worker's job or another workspace's job.

  app.post("/task/result", async (req, res) => {

    const auth = await authenticateWorkerMirror(redis, extractBearerToken(req));
    if (extractBearerToken(req) && !auth) {
      return res.status(401).json({ error: 'invalid_worker_credential' });
    }

    const { job_id, build_id, result_base64, dispatch_id, protocol_version } = req.body

    if (!job_id || !build_id || !result_base64 || !dispatch_id || protocol_version !== PROTOCOL_VERSION) {
      return res.status(400).json({ error: "invalid" })
    }

    console.log("📤 Result:", job_id, "build:", build_id || "none", "size:", Math.round((result_base64 || "").length / 1024), "KB")

    // Read running info to get worker/job_type before deleting
    let runningInfo = null;
    try {
      const raw = await redis.hget("animastor:running", job_id);
      if (raw) {
        runningInfo = JSON.parse(raw);
      }
    } catch (_) {}
    if (!runningInfo || runningInfo.dispatch_id !== dispatch_id) {
      return res.status(409).json({ error: "stale_or_unknown_dispatch" })
    }

    // PW-2 claimer check: credentialed submitter must BE the claimer and own
    // the workspace; uncredentialed (system lane) may only complete jobs with
    // no workspace. Symmetric fail-closed in both directions.
    if (auth) {
      if (runningInfo.worker !== auth.worker_id ||
          (runningInfo.workspace_id || null) !== auth.workspace_id) {
        console.error(`🚫 Result rejected (not claimer): job=${job_id} submitter=${auth.worker_id} claimer=${runningInfo.worker} ws=${auth.workspace_id} vs ${runningInfo.workspace_id || 'null'}`);
        return res.status(403).json({ error: "not_task_claimer" })
      }
    } else if (runningInfo.workspace_id) {
      console.error(`🚫 Result rejected (workspace job via system lane): job=${job_id} ws=${runningInfo.workspace_id}`);
      return res.status(403).json({ error: "not_task_claimer" })
    }

    // Store result as JSON so audio-recovery can parse it.
    // key format: animastor:result:<build_id>:<book_id>:<chapter_id>:<scene_id>:<type>
    // job_id format: "bookId_chapterId_sceneId_chunkIndex:type"
    // bookId can contain underscores, but chapterId/sceneId/chunkIndex cannot.
    // Split by ':' first to remove type suffix, then parse from the end.
    // SYNC: backend/src/runtime/job-schema.js — упрощённая копия parseJobId;
    // при изменении формата job_id обновить оба места.
    const resultType = runningInfo.stage;
    const resultBookId = runningInfo.book_id;
    const resultChapterId = runningInfo.chapter_id;
    const resultSceneId = runningInfo.scene_id;
    const resultData = JSON.stringify({
      job_id,
      result_base64,
      build_id,
      dispatch_id,
      protocol_version
    });
    const resultRedisKey = `animastor:result:${build_id}:${resultBookId}:${resultChapterId}:${resultSceneId}:${resultType}`;
    await redis.set(
      resultRedisKey,
      resultData,
      "EX",
      3600 // 1 hour
    )

    await redis.hdel("animastor:running", job_id)
    await redis.hdel(PROCESSING_CLAIMED_KEY, job_id).catch(() => {})
    if (runningInfo.task_raw) {
      await redis.lrem("animastor:processing", 1, runningInfo.task_raw).catch(() => {})
    }

    // Clear busy flag from worker heartbeat (scope fields per VISIBILITY note).
    if (runningInfo.worker && runningInfo.job_type) {
      try {
        const hbKey = `animastor:worker:heartbeat:${runningInfo.job_type}:${runningInfo.worker}`;
        const hbPayload = JSON.stringify({
          type: runningInfo.job_type,
          worker_id: runningInfo.worker,
          ts: Date.now(),
          current_job_id: null,
          current_dispatch_id: null,
          workspace_id: runningInfo.workspace_id || null,
          mode: runningInfo.worker_mode || null,
          version: runningInfo.worker_version || null,
          image_tag: runningInfo.worker_image_tag || null,
          protocol_version: runningInfo.worker_protocol_version || null
        });
        await redis.set(hbKey, hbPayload, 'EX', 30);
      } catch (_) {}
    }

    let success = false

    for (let i = 0; i < 5; i++) {
      try {
        const backendRes = await doFetch(
          `${BACKEND_URL}/gpu/task/result`,
          {
            method: "POST",
            headers: backendHeaders(),
            body: JSON.stringify({
              job_id,
              build_id,
              dispatch_id,
              protocol_version,
              result_base64,
              // PW-2: audit-only forwarding — backend re-verifies
              // job→book→workspace itself and never trusts these fields.
              worker_id: runningInfo.worker || null,
              workspace_id: runningInfo.workspace_id || null
            })
          }
        )

        if (!backendRes.ok) {
          throw new Error(`HTTP ${backendRes.status}`)
        }

        success = true
        break
      } catch (err) {
        console.error(`⚠️ backend retry ${i + 1} failed`, job_id, err.message)
        await new Promise(r => setTimeout(r, 500))
      }
    }

    if (!success) {
      console.error("❌ backend delivery failed:", job_id)
    }

    res.json({ ok: true })
  })

  // ======================================================
  // ERROR
  // ======================================================
  // PW-2: claimer-only, symmetric with /task/result.

  app.post("/task/error", async (req, res) => {

    const auth = await authenticateWorkerMirror(redis, extractBearerToken(req));
    if (extractBearerToken(req) && !auth) {
      return res.status(401).json({ error: 'invalid_worker_credential' });
    }

    const { job_id, build_id, dispatch_id, protocol_version, reason } = req.body
    if (!job_id || !build_id || !dispatch_id || protocol_version !== PROTOCOL_VERSION) {
      return res.status(400).json({ error: "invalid" })
    }

    console.log("❌ Error:", job_id, reason || "")

    // Read running info before deleting
    let runningInfo = null;
    try {
      const raw = await redis.hget("animastor:running", job_id);
      if (raw) {
        runningInfo = JSON.parse(raw);
      }
    } catch (_) {}
    if (!runningInfo || runningInfo.dispatch_id !== dispatch_id) {
      return res.status(409).json({ error: "stale_or_unknown_dispatch" })
    }

    // PW-2 claimer check (symmetric with /task/result).
    if (auth) {
      if (runningInfo.worker !== auth.worker_id ||
          (runningInfo.workspace_id || null) !== auth.workspace_id) {
        console.error(`🚫 Error rejected (not claimer): job=${job_id} submitter=${auth.worker_id} claimer=${runningInfo.worker}`);
        return res.status(403).json({ error: "not_task_claimer" })
      }
    } else if (runningInfo.workspace_id) {
      console.error(`🚫 Error rejected (workspace job via system lane): job=${job_id} ws=${runningInfo.workspace_id}`);
      return res.status(403).json({ error: "not_task_claimer" })
    }

    await redis.hdel("animastor:running", job_id)
    await redis.hdel(PROCESSING_CLAIMED_KEY, job_id).catch(() => {})
    if (runningInfo.task_raw) {
      await redis.lrem("animastor:processing", 1, runningInfo.task_raw).catch(() => {})
    }

    // Освобождаем dedup очереди для будущего re-dispatch.
    await redis.del(jobDedupKey(job_id, dispatch_id)).catch(() => {})

    // Clear busy flag from worker heartbeat (scope fields per VISIBILITY note).
    if (runningInfo.worker && runningInfo.job_type) {
      try {
        const hbKey = `animastor:worker:heartbeat:${runningInfo.job_type}:${runningInfo.worker}`;
        const hbPayload = JSON.stringify({
          type: runningInfo.job_type,
          worker_id: runningInfo.worker,
          ts: Date.now(),
          current_job_id: null,
          current_dispatch_id: null,
          workspace_id: runningInfo.workspace_id || null,
          mode: runningInfo.worker_mode || null,
          version: runningInfo.worker_version || null,
          image_tag: runningInfo.worker_image_tag || null,
          protocol_version: runningInfo.worker_protocol_version || null
        });
        await redis.set(hbKey, hbPayload, 'EX', 30);
      } catch (_) {}
    }

    // T3: форвард ошибки в backend → orchestrator.failStage
    await notifyBackendError(job_id, build_id, dispatch_id, reason || "worker_error", {
      worker_id: runningInfo.worker || null,
      workspace_id: runningInfo.workspace_id || null
    })

    res.json({ ok: true })
  })

  // ======================================================
  // WORKER SOURCE (Experimental Beta — onboarding)
  // ======================================================
  // Serves the self-contained worker.cjs so a Private Worker operator can
  // obtain it from the hub itself (the repo mirror is private). No secrets
  // here — this is the same file that ships in the repo at
  // worker/worker/worker.cjs. Mounted read-only into the container.

  const WORKER_SOURCE_PATH =
    config.WORKER_SOURCE_PATH || "/app/worker-source/worker.cjs";

  app.get("/worker-source", (req, res) => {
    fs.readFile(WORKER_SOURCE_PATH, (err, buf) => {
      if (err) {
        return res.status(404).json({ error: "worker_source_unavailable" });
      }
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="worker.cjs"');
      res.setHeader("Cache-Control", "no-store");
      res.send(buf);
    });
  });

  // ======================================================
  // HEALTH
  // ======================================================

  app.get("/health", async (req, res) => {

    const queues = {
      image: await redis.llen("animastor:queue:image"),
      audio: await redis.llen("animastor:queue:audio"),
      video: await redis.llen("animastor:queue:video")
    }

    // PW-2: workspace queue depths (discovered, never hardcoded).
    const workspaceQueues = {};
    for (const key of await discoverQueueKeys()) {
      const m = key.match(/^animastor:queue:(audio|image|video):ws:(.+)$/);
      if (!m) continue;
      workspaceQueues[key] = await redis.llen(key);
    }

    const running = await redis.hlen("animastor:running")
    const gpuCount = (await getAllGpusFromRedis()).size;

    res.json({
      gpus: gpuCount,
      queues,
      workspace_queues: workspaceQueues,
      running
    })
  })

  app.delete("/queue/clear", requireApiKey, async (req, res) => {
    try {
      const { book_id, dispatch_id, workspace_id } = req.query
      // PW-2: workspace-scoped clear — when workspace_id is given, only that
      // workspace's queues/running entries are touched (guest purge seam).
      const queueKeys = await discoverQueueKeys();
      const scopedKeys = workspace_id
        ? queueKeys.filter(k => k.endsWith(`:ws:${workspace_id}`))
        : queueKeys;
      const summary = { queued: 0, processing: 0, running: 0, results: 0, dedup: 0 }

      if (book_id || dispatch_id || workspace_id) {
        const matches = (record) => {
          if (dispatch_id) return record.dispatch_id === dispatch_id
          if (workspace_id) return (record.workspace_id || null) === workspace_id
          return record.book_id === book_id
        }
        const removedJobs = []

        // 1. Clear queue lists by structured ownership.
        for (const key of scopedKeys) {
          const items = await redis.lrange(key, 0, -1)
          const remaining = []
          for (const item of items) {
            try {
              const parsed = JSON.parse(item)
              if (matches(parsed)) {
                removedJobs.push(parsed)
                summary.queued++
              } else {
                remaining.push(item)
              }
            } catch (_) { remaining.push(item) }
          }
          await redis.del(key)
          if (remaining.length > 0) {
            await redis.rpush(key, ...remaining)
          }
        }

        // 2. Clear running entries by the same ownership fields.
        let cursor = '0'
        do {
          const scan = await redis.hscan('animastor:running', cursor, 'COUNT', 500)
          cursor = scan[0]
          const entries = scan[1]
          if (entries && entries.length > 0) {
            for (let i = 0; i < entries.length; i += 2) {
              const job_id = entries[i]
              const record = JSON.parse(entries[i + 1])
              if (matches(record)) {
                removedJobs.push({ ...record, job_id })
                await redis.hdel('animastor:running', job_id)
                await redis.hdel(PROCESSING_CLAIMED_KEY, job_id).catch(() => {})
                if (record.task_raw) {
                  await redis.lrem('animastor:processing', 1, record.task_raw).catch(() => {})
                }
                summary.running++
              }
            }
          }
        } while (cursor !== '0')

        // 3. Clear result keys. Dispatch-scoped cleanup reads stored identity;
        // book-scoped cleanup can use the structured key segment.
        // Key format: animastor:result:<build_id>:<bookId>:<chapterId>:<sceneId>:<type>
        // Используем SCAN с HSCAN-подобным подходом: итерируем все result ключи и фильтруем по book_id.
        // Аналог animastor:result:*:${book_id}:* — но SCAN с двумя * в начале медленный,
        // поэтому итерируем все animastor:result:* и фильтруем на стороне клиента.
        {
          let c = '0'
          do {
            const scan = await redis.scan(c, 'MATCH', 'animastor:result:*', 'COUNT', 1000)
            c = scan[0]
            const toDelete = []
            for (const key of scan[1]) {
              const parts = key.split(':')
              // Format: animastor:result:<build_id>:<bookId>:...
              // book_id at index 3 (0=animastor,1=result,2=build_id,3=bookId)
              if (dispatch_id) {
                const raw = await redis.get(key)
                try {
                  if (JSON.parse(raw || '{}').dispatch_id === dispatch_id) toDelete.push(key)
                } catch (_) {}
              } else if (book_id && parts.length >= 4 && parts[3] === book_id) {
                toDelete.push(key)
              }
            }
            if (toDelete.length > 0) {
              await redis.del(...toDelete)
              summary.results += toDelete.length
            }
          } while (c !== '0')
        }

        // 4. Clear exact dedup records for removed queue/running jobs.
        for (const job of removedJobs) {
          if (job.job_id && job.dispatch_id) {
            summary.dedup += await redis.del(jobDedupKey(job.job_id, job.dispatch_id))
          }
        }

        console.log(`[QUEUE-CLEAR] Filtered cleanup`, { book_id, dispatch_id, workspace_id, summary })
        res.json({ ok: true, scope: { book_id: book_id || null, dispatch_id: dispatch_id || null, workspace_id: workspace_id || null }, removed: summary })

      } else {
        // === FULL CLEAR: wipe all queues ===

        for (const key of queueKeys) {
          const len = await redis.llen(key) || 0
          await redis.del(key)
          summary.queued += len
        }

        // Clear animastor:running
        const runningLen = await redis.hlen('animastor:running') || 0
        await redis.del('animastor:running')
        summary.running += runningLen

        const processingLen = await redis.llen('animastor:processing') || 0
        await redis.del('animastor:processing')
        summary.processing += processingLen

        await redis.del(PROCESSING_CLAIMED_KEY).catch(() => {})

        // Clear all result and dedup keys
        for (const pattern of ['animastor:result:*', 'animastor:job:*']) {
          let c = '0'
          do {
            const scan = await redis.scan(c, 'MATCH', pattern, 'COUNT', 500)
            c = scan[0]
            if (scan[1].length) {
              await redis.del(...scan[1])
              if (pattern.includes(':result:')) summary.results += scan[1].length
              else summary.dedup += scan[1].length
            }
          } while (c !== '0')
        }

        console.log(`[QUEUE-CLEAR] Full cleanup`, summary)
        res.json({ ok: true, message: "All gpu-hub queues cleared", removed: summary })
      }
    } catch (err) {
      console.error("Failed to clear queues:", err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // Expose internals for tests / server.js lifecycle.
  app.__hub = {
    redis,
    sweepProcessingOrphans,
    heartbeatAndTimeoutSweep,
    stopIntervals: () => { if (intervalTimer) clearInterval(intervalTimer); },
  };

  return app
}

// ======================================================
// STANDALONE START (server.js requires this module)
// ======================================================

if (require.main === module) {
  const REDIS_URL = process.env.REDIS_URL || "redis://animastor-redis:6379";
  const redis = new (require("ioredis"))(REDIS_URL);
  const { PORT = 5000 } = process.env;

  const app = buildHubApp({
    redis,
    config: {
      BACKEND_URL: process.env.BACKEND_URL || "http://animastor-backend:3000",
      GPU_TIMEOUT_MS: Number(process.env.GPU_TIMEOUT_MS ?? process.env.GPU_TIMEOUT ?? 600000),
      GPU_HUB_API_KEY: process.env.GPU_HUB_API_KEY || null,
    },
  });

  const server = app.listen(PORT, () => {
    console.log("🚀 GPU HUB running on", PORT)
  })

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log("[SHUTDOWN] SIGTERM received, shutting down...");
    app.__hub.stopIntervals();
    server.close(() => {
      console.log("[SHUTDOWN] HTTP server closed");
    });
    try {
      await redis.quit();
      console.log("[SHUTDOWN] Redis connection closed");
    } catch (_) {}
    console.log("[SHUTDOWN] Goodbye");
    process.exit(0);
  });
}

module.exports = {
  PROTOCOL_VERSION,
  WORKER_AUTH_MIRROR_KEY,
  PROCESSING_CLAIMED_KEY,
  DEAD_LETTER_KEY,
  ORPHAN_GRACE_MS,
  MAX_ORPHAN_REQUEUES,
  parseWorkerToken,
  extractBearerToken,
  authenticateWorkerMirror,
  buildHubApp,
};
