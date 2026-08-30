// ======================================================
// GPU HUB - v0.2.0 (Fail-closed worker authorization — PW-4)
// ======================================================
// Workspace-aware job ownership, FAIL CLOSED:
//   - worker identity comes ONLY from a Bearer credential resolved via the
//     backend-maintained Redis mirror `animastor:worker-auth` (hub has no pg);
//     NO CREDENTIAL → 401 on every worker-facing endpoint. There is no
//     uncredentialed lane: a missing/invalid credential never becomes
//     SYSTEM or SHARE — it is UNAUTHORIZED and gets nothing.
//   - three registry modes: private (serves only its workspace queue),
//     share (community pool) and system (Animastor-operated pool); share and
//     system pop the workspace-less system pool, private pops its own queue;
//   - the backend resolves `book → workspace` at dispatch and passes
//     workspace_id in /task (key-gated) → hub enqueues to
//     `queue:{type}:ws:{workspace}`; the system pool (`queue:{type}`) serves
//     share/system workers and workspaces without a private worker;
//   - the claim binds the running record to the authenticated worker +
//     workspace; /task/result and /task/error are claimer-only;
//   - poison-write cross-check on pop; `processing` orphan sweep requeues
//     crashed claims back to the correct queue (capped, then backend error).
// The hub stays a dumb transport: ownership is DATA (workspace_id authored by
// the backend), never hub policy and never client-supplied.

const express = require("express")
const cors = require("cors")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const { buildTarGz, walkDir } = require("./tarball")
const { buildBootstrapScript, buildWindowsBootstrapScript, BOOTSTRAP_VERSION } = require("./bootstrap")

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
 * missing ownership all yield null — never an identity.
 *
 * Ownership model (PW-4): private/share identities MUST carry a workspace;
 * only mode='system' (Animastor-operated pool) is workspace-less. A missing
 * credential is NEVER system/share — it is UNAUTHORIZED (caller answers 401).
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
    if (!identity.worker_type) return null;
    if (identity.mode !== 'system' && !identity.workspace_id) return null;
    return identity;
  } catch (_) {
    return null;
  }
}

/**
 * FAIL-CLOSED worker gate for the worker-facing endpoints. No Bearer
 * credential → 401 (there is no uncredentialed lane); an invalid/revoked
 * one → 401 as well. Returns the registry identity or null after answering.
 * @returns {Promise<object|null>}
 */
async function requireWorkerCredential(redis, req, res) {
  const token = extractBearerToken(req);
  if (!token) {
    return (res.status(401).json({
      error: 'worker_authentication_failed',
      message: 'Worker authentication failed — check ANIMASTOR_WORKER_TOKEN',
    }), null);
  }
  const auth = await authenticateWorkerMirror(redis, token);
  if (!auth) {
    return (res.status(401).json({ error: 'invalid_worker_credential' }), null);
  }
  return auth;
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
    // FAIL CLOSED (PW-4): an unset API key DENIES the backend-facing endpoints.
    // Explicit dev-only opt-out for local setups without a key.
    GPU_HUB_ALLOW_OPEN = null,
  } = config;

  const doFetch = fetchImpl || ((url, options) => fetch(url, options));

  const app = express()
  app.use(cors())
  app.use(express.json({ limit: "500mb" }))

  // ======================================================
  // API KEY AUTH
  // ======================================================

  function requireApiKey(req, res, next) {
    // PW-4 FAIL CLOSED: no key configured → deny (the old "unset = open"
    // behavior left /task and /queue/clear exposed). GPU_HUB_ALLOW_OPEN=1
    // is the explicit dev-only opt-out.
    if (!GPU_HUB_API_KEY) {
      if (String(GPU_HUB_ALLOW_OPEN) === '1') return next();
      return res.status(503).json({ error: 'hub_api_key_not_configured' });
    }
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
  // PW-4 FAIL CLOSED: identity comes ONLY from a valid Bearer credential —
  // there is no uncredentialed lane. A missing/invalid credential never
  // becomes SYSTEM or SHARE; it is simply rejected (401).

  app.post("/beacon", async (req, res) => {

    const auth = await requireWorkerCredential(redis, req, res);
    if (!auth) return;

    const { gpu, vram, version, image_tag, protocol_version } = req.body
    // Registry identity is server-derived; body id/type are labels only.
    const workerId = auth.worker_id;
    const workerType = auth.worker_type;

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
      workspace_id: auth.workspace_id || null,
      last_seen: Date.now()
    };

    // Primary registry: Redis (survives restart, cluster-aware)
    await setGpuInRedis(workerId, data);

    // Also write heartbeat for backend worker count panel.
    // VISIBILITY: the payload carries the registry-derived scope
    // (workspace_id + mode ∈ private|share|system) so the backend separates
    // SYSTEM/SHARE capacity from a workspace's PRIVATE workers.
    try {
      const key = `animastor:worker:heartbeat:${workerType}:${workerId}`;
      const payload = JSON.stringify({
        type: workerType,
        worker_id: workerId,
        ts: Date.now(),
        workspace_id: auth.workspace_id || null,
        mode: auth.mode || null,
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
  // PW-4 FAIL CLOSED: identity comes ONLY from the Bearer credential.
  //   private → pops ONLY its own workspace+type queue;
  //   share   → pops the community/system pool (workspace-less jobs);
  //   system  → pops the Animastor-operated pool (workspace-less jobs).
  // No credential → 401. The `worker`/`type` query params are never
  // identity — they are validated against the registry record.

  app.get("/task/next", async (req, res) => {

    const auth = await requireWorkerCredential(redis, req, res);
    if (!auth) return;

    const { type } = req.query

    // Identity is token-derived.
    const workerId = auth.worker_id;
    const workerType = auth.worker_type;

    if (!workerId) {
      return res.status(400).json({ error: "worker required" })
    }
    if (type && auth.worker_type !== type) {
      // A worker may only ever pop its registered type.
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

    // PW-4: mode-scoped pop. Private worker → its workspace queue ONLY;
    // share/system → the system pool ONLY. Cross-workspace and private-pool
    // access are structurally impossible (the key is never derivable from
    // the client).
    const popWorkspaceId = auth.mode === 'private' ? auth.workspace_id : null;
    const queueKey = queueKeyFor(workerType, popWorkspaceId)

    const taskRaw = await redis.rpoplpush(
      queueKey,
      "animastor:processing"
    )

    if (!taskRaw) return res.json({ task: null })

    const task = JSON.parse(taskRaw)

    // PW-2 poison-write cross-check: the popped item's workspace must match
    // the lane this worker may serve (private → its workspace; share/system
    // → workspace-less jobs only). A mismatch means a poison write —
    // dead-letter it, never hand it out.
    const expectedWs = auth.mode === 'private' ? auth.workspace_id : null;
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
        workspace_id: task.workspace_id || null,
        // VISIBILITY: kept so heartbeat refreshes (sweep/result/error) can
        // re-stamp the scope without re-authenticating.
        worker_mode: auth.mode || null,
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

    console.log(`🚀 ${task.job_id} → ${workerId} (${task.job_type}) build:${task.build_id || "none"} timeout_ms:${task.timeout_ms || "(default)"} mode:${auth.mode} ws:${task.workspace_id || "(system pool)"}`)

    // Mark worker as busy in heartbeat (scope fields per VISIBILITY note).
    try {
      const hbKey = `animastor:worker:heartbeat:${task.job_type}:${workerId}`;
      const hbPayload = JSON.stringify({
        type: task.job_type,
        worker_id: workerId,
        ts: Date.now(),
        current_job_id: task.job_id,
        current_dispatch_id: task.dispatch_id,
        workspace_id: auth.workspace_id || null,
        mode: auth.mode || null,
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
  // PW-4 FAIL CLOSED: claimer-only, credential required. The submitter must
  // be the worker that claimed the job (worker + workspace match the running
  // record). A worker can never complete another worker's job or another
  // workspace's job; share/system workers complete workspace-less jobs only.

  app.post("/task/result", async (req, res) => {

    const auth = await requireWorkerCredential(redis, req, res);
    if (!auth) return;

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

    // PW-4 claimer check: the submitter must BE the claimer and the job's
    // workspace must match the claimer's lane (private → its workspace;
    // share/system → workspace-less jobs only).
    if (runningInfo.worker !== auth.worker_id ||
        (runningInfo.workspace_id || null) !== (auth.workspace_id || null)) {
      console.error(`🚫 Result rejected (not claimer): job=${job_id} submitter=${auth.worker_id} claimer=${runningInfo.worker} ws=${auth.workspace_id || 'null'} vs ${runningInfo.workspace_id || 'null'}`);
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
  // PW-4 FAIL CLOSED: claimer-only, credential required, symmetric with
  // /task/result.

  app.post("/task/error", async (req, res) => {

    const auth = await requireWorkerCredential(redis, req, res);
    if (!auth) return;

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

    // PW-4 claimer check (symmetric with /task/result).
    if (runningInfo.worker !== auth.worker_id ||
        (runningInfo.workspace_id || null) !== (auth.workspace_id || null)) {
      console.error(`🚫 Error rejected (not claimer): job=${job_id} submitter=${auth.worker_id} claimer=${runningInfo.worker}`);
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
  // WORKER SOURCE (Experimental Beta — onboarding) — DEPRECATED
  // ======================================================
  // DEPRECATED (Private Worker Setup Contract Phase 3): serves worker.cjs
  // ONLY. The worker requires additional runtime files (worker-cleanup.cjs,
  // worker-cleanup-journal.cjs, package*.json, .env.example), so a
  // single-file install is broken. Canonical replacement: GET /worker-bundle
  // (full versioned bundle, sha256 published at /worker-bundle/sha256).
  // Kept for backward compatibility with the old instruction; no secrets
  // here — same file as worker/worker/worker.cjs, mounted read-only.

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
      res.setHeader("Deprecation", "true");
      res.setHeader("Link", '</worker-bundle>; rel="successor-version"');
      res.send(buf);
    });
  });

  // ======================================================
  // SETUP CONTRACT ARTIFACTS (Private Worker — Phase 3)
  // ======================================================
  // Public download endpoints behind the UI-safe setup contract metadata
  // served by the backend (GET /api/v1/private-worker/setup/*). Artifacts
  // carry NO secrets: the Worker Key is never part of any bundle — it is
  // entered interactively on the GPU machine. Integrity: every artifact
  // publishes a sha256 (signature infrastructure is a future extension).
  //
  //   GET /worker-bundle          full worker runtime bundle (tar.gz)
  //   GET /worker-bundle/sha256   bundle checksum + version metadata
  //   GET /workflow/:id           baseline workflow JSON (editable-baseline)
  //   GET /installer              installer package (tar.gz, self-contained)
  //   GET /installer/sha256       installer checksum + version metadata

  const WORKER_BUNDLE_DIR = config.WORKER_BUNDLE_DIR || "/app/worker-bundle";
  const WORKFLOW_DIR = config.WORKFLOW_DIR || "/app/workflows";
  const INSTALLER_SRC_DIR = config.INSTALLER_SRC_DIR || "/app/installer-src";
  const INSTALLER_MANIFESTS_DIR =
    config.INSTALLER_MANIFESTS_DIR || "/app/install-manifests";
  const INSTALLER_WORKFLOWS_DIR =
    config.INSTALLER_WORKFLOWS_DIR || "/app/workflows";

  // Versions have ONE canonical source each (no manual duplication):
  //   worker bundle → worker/worker/package.json (mounted as WORKER_BUNDLE_DIR)
  //   installer     → backend/src/installer/package.json (INSTALLER_SRC_DIR)
  // The hub reads them at request time; config overrides exist for tests.
  function readCanonicalVersion(dir, fallbackName) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg && typeof pkg.version === "string" && pkg.version) {
        return { version: pkg.version, name: pkg.name || fallbackName, description: pkg.description || null };
      }
    } catch (_) { /* canonical package.json missing/unreadable */ }
    return null;
  }

  function workerBundleMeta() {
    const canonical = readCanonicalVersion(WORKER_BUNDLE_DIR, "animastor-worker");
    return {
      version: config.WORKER_BUNDLE_VERSION || (canonical && canonical.version) || null,
      name: (canonical && canonical.name) || "animastor-worker",
    };
  }

  function installerMeta() {
    const canonical = readCanonicalVersion(INSTALLER_SRC_DIR, "animastor-installer");
    return {
      version: config.INSTALLER_VERSION || (canonical && canonical.version) || null,
      name: (canonical && canonical.name) || "animastor-installer",
      description: canonical && canonical.description,
    };
  }

  // A file is servable only if it cannot be a secret: `.env` and any
  // `.env.*` variant are NEVER included (defense in depth — the mounted
  // directory must not contain them, but we never trust the mount alone).
  function isServableBundleFile(relPath) {
    const base = relPath.split("/").pop();
    if (base === ".env" || /^\.env\..+$/.test(base)) return base === ".env.example";
    return true;
  }

  // Deterministic artifact cache: rebuilt only when the source tree changes
  // (fingerprint = sorted relpath + size + mtime of every included file).
  function cachedArtifact(cache, fingerprintFn, buildFn) {
    let fingerprint = null;
    try { fingerprint = fingerprintFn(); } catch (_) { return null; }
    if (!fingerprint) return null;
    if (cache.fingerprint === fingerprint) return cache.artifact;
    const artifact = buildFn();
    cache.fingerprint = fingerprint;
    cache.artifact = artifact;
    return artifact;
  }

  function dirFingerprint(dir, filter) {
    if (!fs.existsSync(dir)) return null;
    const files = walkDir(fs, dir).filter((f) => !filter || filter(f)).sort();
    if (files.length === 0) return null;
    const parts = [];
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f));
      parts.push(`${f}:${st.size}:${st.mtimeMs}`);
    }
    return parts.join("|");
  }

  function buildBundleArtifact() {
    const files = walkDir(fs, WORKER_BUNDLE_DIR)
      .filter(isServableBundleFile)
      .sort();
    const entries = files.map((f) => ({
      name: `animastor-worker/${f}`,
      data: fs.readFileSync(path.join(WORKER_BUNDLE_DIR, f)),
    }));
    const buffer = buildTarGz(entries);
    return {
      buffer,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      files,
      bytes: buffer.length,
    };
  }

  const workerBundleCache = { fingerprint: null, artifact: null };

  app.get("/worker-bundle", (req, res) => {
    const meta = workerBundleMeta();
    const artifact = meta.version && cachedArtifact(
      workerBundleCache,
      () => dirFingerprint(WORKER_BUNDLE_DIR, isServableBundleFile),
      buildBundleArtifact
    );
    if (!artifact) {
      // No canonical version (package.json missing) or no files — never
      // serve a versionless artifact.
      return res.status(404).json({ error: "worker_bundle_unavailable" });
    }
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${meta.name}-${meta.version}.tar.gz"`
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Animastor-Artifact-Version", meta.version);
    res.setHeader("X-Animastor-Sha256", artifact.sha256);
    res.send(artifact.buffer);
  });

  app.get("/worker-bundle/sha256", (req, res) => {
    const meta = workerBundleMeta();
    const artifact = meta.version && cachedArtifact(
      workerBundleCache,
      () => dirFingerprint(WORKER_BUNDLE_DIR, isServableBundleFile),
      buildBundleArtifact
    );
    if (!artifact) {
      return res.status(404).json({ error: "worker_bundle_unavailable" });
    }
    res.json({
      artifact: "worker-bundle",
      version: meta.version,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      files: artifact.files,
      signature: null, // future: signature + signature_algorithm
    });
  });

  // Baseline workflows (editable-baseline policy). The allowlist is derived
  // from the canonical install manifests — legacy/excluded workflow files
  // (old_*.json) are never served. The id is the manifest workflow id
  // without the "workflow:" prefix (e.g. img-qwen-image).
  const WORKFLOW_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

  function loadWorkflowAllowlist() {
    const allow = new Map();
    if (!fs.existsSync(INSTALLER_MANIFESTS_DIR)) return allow;
    for (const type of fs.readdirSync(INSTALLER_MANIFESTS_DIR).sort()) {
      const typeDir = path.join(INSTALLER_MANIFESTS_DIR, type);
      if (!fs.statSync(typeDir).isDirectory()) continue;
      for (const file of fs.readdirSync(typeDir).sort()) {
        if (!file.endsWith(".json")) continue;
        let manifest = null;
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(typeDir, file), "utf8"));
        } catch (_) { continue; }
        const profileId = manifest.profile && manifest.profile.id;
        const artifacts =
          manifest.workflows && Array.isArray(manifest.workflows.artifacts)
            ? manifest.workflows.artifacts
            : [];
        for (const wf of artifacts) {
          if (!wf || !wf.id || !wf.filename) continue;
          allow.set(String(wf.id).replace(/^workflow:/, ""), {
            filename: wf.filename,
            name: wf.name || null,
            profile_id: profileId || null,
            baseline_sha256: wf.baseline_sha256 || null,
          });
        }
      }
    }
    return allow;
  }

  app.get("/workflow/:id", (req, res) => {
    const id = req.params.id;
    if (!WORKFLOW_ID_RE.test(id)) {
      return res.status(404).json({ error: "workflow_not_found" });
    }
    const meta = loadWorkflowAllowlist().get(id);
    if (!meta) {
      return res.status(404).json({ error: "workflow_not_found" });
    }
    const filePath = path.resolve(WORKFLOW_DIR, meta.filename);
    // Path traversal defense: resolved path must stay inside WORKFLOW_DIR.
    if (!filePath.startsWith(path.resolve(WORKFLOW_DIR) + path.sep)) {
      return res.status(404).json({ error: "workflow_not_found" });
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        return res.status(404).json({ error: "workflow_unavailable" });
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${meta.filename}"`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "X-Animastor-Sha256",
        crypto.createHash("sha256").update(buf).digest("hex")
      );
      res.send(buf);
    });
  });

  // ======================================================
  // BOOTSTRAP INSTALLER (Private Worker onboarding — Phase 3.2)
  // ======================================================
  // GET /installer serves a small, auditable bootstrap LAUNCHER SCRIPT (not
  // a tarball): the user downloads and runs it on the GPU machine and it does
  // the whole flow — download the installer bundle (GET /installer/bundle),
  // verify its sha256 against the hub-published checksum (GET
  // /installer/sha256), unpack into a temp dir and run the real installer
  // CLI. The profile/mode selected in the web onboarding are embedded into
  // the script at download time (query params, validated against the
  // canonical manifest allowlist — they are NOT secrets). The Worker Key is
  // NEVER part of this exchange: the installer asks for it interactively.
  //
  // The launcher script ITSELF is the platform choice (the platform is
  // auto-detected by which script the user runs — never a CLI flag):
  //   ?platform=linux   → bash launcher (animastor-installer.sh, default)
  //   ?platform=windows → PowerShell launcher (animastor-installer.ps1)
  // Without ?platform the hub sniffs the User-Agent: a Windows browser
  // download gets the PowerShell launcher automatically.
  //
  //   GET /installer            bootstrap launcher script
  //                             ?profile=<id>&mode=<mode>&platform=<p>
  //   GET /installer/bundle     self-contained installer package (tar.gz)
  //   GET /installer/sha256     installer checksum + version metadata

  // Modes the bootstrap may embed — mirrors the setup contract INSTALL_MODES.
  const BOOTSTRAP_MODES = new Set(["managed", "existing", "shared", "isolated"]);

  // Canonical profile allowlist from the install manifests (hidden/internal
  // profiles are never embeddable). Rebuilt with the same freshness rules as
  // the workflow allowlist.
  function loadProfileAllowlist() {
    const allow = new Set();
    if (!fs.existsSync(INSTALLER_MANIFESTS_DIR)) return allow;
    for (const type of fs.readdirSync(INSTALLER_MANIFESTS_DIR).sort()) {
      const typeDir = path.join(INSTALLER_MANIFESTS_DIR, type);
      if (!fs.statSync(typeDir).isDirectory()) continue;
      for (const file of fs.readdirSync(typeDir).sort()) {
        if (!file.endsWith(".json")) continue;
        let manifest = null;
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(typeDir, file), "utf8"));
        } catch (_) { continue; }
        const id = manifest.profile && manifest.profile.id;
        const status = manifest.status;
        if (!id || status === "internal" || status === "hidden") continue;
        allow.add(id);
      }
    }
    return allow;
  }

  // The hub does not know its own public origin (it lives behind nginx), so
  // the bootstrap embeds it from the forwarded Host. Only a clean DNS-name
  // Host is accepted — anything else falls back to the canonical origin.
  const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

  function publicHubUrl(req) {
    if (config.PUBLIC_HUB_URL) return String(config.PUBLIC_HUB_URL).replace(/\/$/, "");
    const host = req && req.headers && typeof req.headers.host === "string" ? req.headers.host : "";
    if (HOSTNAME_RE.test(host)) return `https://${host}/gpu`;
    return "https://animastor.in/gpu";
  }

  app.get("/installer", (req, res) => {
    const meta = installerMeta();
    if (!meta.version) {
      return res.status(404).json({ error: "installer_unavailable" });
    }
    // Optional onboarding context: profile/mode baked into the script so the
    // user never types them. Fail closed on invalid values (never silently
    // degrade — a wrong profile would produce a confusing install later).
    let profile = null;
    if (req.query.profile !== undefined) {
      const raw = String(req.query.profile);
      const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const allow = loadProfileAllowlist();
      if (ids.length === 0 || !ids.every((id) => allow.has(id))) {
        return res.status(400).json({ error: "invalid_profile" });
      }
      profile = ids.join(",");
    }
    let mode = null;
    if (req.query.mode !== undefined) {
      mode = String(req.query.mode);
      if (!BOOTSTRAP_MODES.has(mode)) {
        return res.status(400).json({ error: "invalid_mode" });
      }
    }
    // Platform choice (bash vs PowerShell launcher). Explicit query param
    // wins; otherwise a Windows User-Agent gets the PowerShell launcher.
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
    const platformParam = req.query.platform !== undefined ? String(req.query.platform) : null;
    let targetPlatform = "linux";
    if (platformParam === "windows") targetPlatform = "windows";
    else if (platformParam === "linux") targetPlatform = "linux";
    else if (platformParam !== null) return res.status(400).json({ error: "invalid_platform" });
    else if (/Windows/i.test(ua)) targetPlatform = "windows";
    const common = {
      hubUrl: publicHubUrl(req),
      profile,
      mode,
      installerVersion: meta.version,
    };
    const headers = {
      "Cache-Control": "no-store",
      "X-Animastor-Bootstrap-Version": BOOTSTRAP_VERSION,
      "X-Animastor-Artifact-Version": meta.version,
    };
    if (targetPlatform === "windows") {
      const script = buildWindowsBootstrapScript(common);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="animastor-installer.ps1"');
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.send(script);
    }
    const script = buildBootstrapScript(common);
    res.setHeader("Content-Type", "text/x-shellscript; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="animastor-installer.sh"');
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    res.send(script);
  });

  // Installer package — self-contained: installer sources + canonical
  // install manifests + the full worker bundle + generated root
  // package.json/README. Layout mirrors the repo (src/installer/*,
  // ai/install-manifests/*, worker/worker/*) so install-manifest.js and the
  // engine resolve their inputs without modification. The version comes
  // from the canonical backend/src/installer/package.json — never hardcoded
  // here. No Worker Key, no .env, no credentials.
  function buildInstallerArtifact() {
    const meta = installerMeta();
    if (!meta.version) return null; // no canonical version → not publishable
    const entries = [];
    const srcFiles = walkDir(fs, INSTALLER_SRC_DIR).sort();
    for (const f of srcFiles) {
      entries.push({
        name: `animastor-installer/src/installer/${f}`,
        data: fs.readFileSync(path.join(INSTALLER_SRC_DIR, f)),
      });
    }
    const manifestFiles = walkDir(fs, INSTALLER_MANIFESTS_DIR).sort();
    for (const f of manifestFiles) {
      entries.push({
        name: `animastor-installer/ai/install-manifests/${f}`,
        data: fs.readFileSync(path.join(INSTALLER_MANIFESTS_DIR, f)),
      });
    }
    // Baseline workflows — the installer reads them from <repo>/backend/ai/workflows/.
    // Including them in the tarball lets the repo_path source work even when the
    // installer runs on a machine without a full Animastor checkout.
    let workflowFiles = [];
    try { workflowFiles = walkDir(fs, INSTALLER_WORKFLOWS_DIR).sort(); } catch (_) { /* dir may not exist in test */ }
    for (const f of workflowFiles) {
      entries.push({
        name: `animastor-installer/backend/ai/workflows/${f}`,
        data: fs.readFileSync(path.join(INSTALLER_WORKFLOWS_DIR, f)),
      });
    }
    // The engine deploys the worker bundle from <installer>/worker/worker/
    // (manifest worker_bundle.files). Without these files a distributed
    // installer could never install the worker offline — the install on the
    // GPU machine would always fail with "could not obtain bundle files".
    const workerFiles = walkDir(fs, WORKER_BUNDLE_DIR)
      .filter(isServableBundleFile)
      .sort();
    for (const f of workerFiles) {
      entries.push({
        name: `animastor-installer/worker/worker/${f}`,
        data: fs.readFileSync(path.join(WORKER_BUNDLE_DIR, f)),
      });
    }
    entries.push({
      name: "animastor-installer/package.json",
      data: JSON.stringify(
        {
          name: meta.name,
          version: meta.version,
          private: true,
          description: meta.description
            || "Animastor Private GPU Worker installer (setup contract distribution)",
          bin: { [meta.name]: "src/installer/cli.js" },
          engines: { node: ">=20" },
        },
        null,
        2
      ) + "\n",
    });
    entries.push({
      name: "animastor-installer/README.txt",
      data: [
        "Animastor Private GPU Worker installer",
        "",
        "Usage:",
        "  node src/installer/cli.js detect",
        "  node src/installer/cli.js plan --profile audio/qwen-tts",
        "  node src/installer/cli.js install --profile audio/qwen-tts --yes",
        "",
        "  Managed mode (default) starts ComfyUI and the worker automatically",
        "  and picks a free port when 8188 is already taken. Remembered across",
        "  re-runs — a bare re-run keeps the same wiring. Opt out with",
        "  --no-start-comfy / --no-start-worker, pin a port with --comfy-port N.",
        "",
        "  --accept-reference-runtime  install the manifest's known-working reference",
        "                              ComfyUI while the canonical pin is open (D1)",
        "",
        "The Worker Key is asked interactively on this machine (hidden input).",
        "It is never logged, never stored in installer state, never passed via argv.",
        "",
      ].join("\n"),
    });
    const buffer = buildTarGz(entries);
    return {
      buffer,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.length,
      files: entries.map((e) => e.name),
    };
  }

  const installerCache = { fingerprint: null, artifact: null };

  function installerFingerprint() {
    const a = dirFingerprint(INSTALLER_SRC_DIR);
    const b = dirFingerprint(INSTALLER_MANIFESTS_DIR);
    const c = dirFingerprint(WORKER_BUNDLE_DIR, isServableBundleFile);
    const d = dirFingerprint(INSTALLER_WORKFLOWS_DIR);
    const meta = installerMeta();
    return a && b && meta.version ? `${meta.version}|${a}|${b}|${c || "no-worker-bundle"}|${d || "no-workflows"}` : null;
  }

  app.get("/installer/bundle", (req, res) => {
    const meta = installerMeta();
    const artifact = cachedArtifact(installerCache, installerFingerprint, buildInstallerArtifact);
    if (!artifact) {
      return res.status(404).json({ error: "installer_unavailable" });
    }
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${meta.name}-${meta.version}.tar.gz"`
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Animastor-Artifact-Version", meta.version);
    res.setHeader("X-Animastor-Sha256", artifact.sha256);
    res.send(artifact.buffer);
  });

  app.get("/installer/sha256", (req, res) => {
    const meta = installerMeta();
    const artifact = cachedArtifact(installerCache, installerFingerprint, buildInstallerArtifact);
    if (!artifact) {
      return res.status(404).json({ error: "installer_unavailable" });
    }
    res.json({
      artifact: "installer",
      version: meta.version,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      signature: null, // future: signature + signature_algorithm
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
      GPU_HUB_ALLOW_OPEN: process.env.GPU_HUB_ALLOW_OPEN || null,
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
  requireWorkerCredential,
  buildHubApp,
};
