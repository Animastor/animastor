// ======================================================
// GPU HUB - v1.0.0
// ======================================================

const express = require("express")
const cors = require("cors")

const REDIS_URL = process.env.REDIS_URL || "redis://animastor-redis:6379";
const redis = new (require("ioredis"))(REDIS_URL)

const {
  PORT = 5000,
  BACKEND_URL = "http://animastor-backend:3000",
  // 10 min — image ~1-2min, audio ~30s, video (LTX) ~5-10min.
  // ИНВАРИАНТ: GPU_TIMEOUT должен быть МЕНЬШЕ минимального dispatch-lease TTL
  // backend'а (backend/src/config/runtime-config.js → LEASE_TTL_S, минимум 15 мин),
  // иначе backend узнает о мёртвом воркере позже, чем hub перевыдаст job.
  GPU_TIMEOUT = 600000
} = process.env

const app = express()
app.use(cors())
app.use(express.json({ limit: "500mb" }))
const PROTOCOL_VERSION = 2;

// ======================================================
// API KEY AUTH
// ======================================================

const GPU_HUB_API_KEY = process.env.GPU_HUB_API_KEY || null;

function requireApiKey(req, res, next) {
  if (!GPU_HUB_API_KEY) return next(); // no key configured = open access
  // T9: Header-only — не принимаем ключ в query string
  const provided = req.headers['x-api-key'];
  if (provided !== GPU_HUB_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
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

async function notifyBackendError(job_id, build_id, dispatch_id, reason) {
  for (let i = 0; i < 5; i++) {
    try {
      const backendRes = await fetch(
        `${BACKEND_URL}/gpu/task/error`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id,
            build_id: build_id || null,
            dispatch_id,
            protocol_version: PROTOCOL_VERSION,
            reason: reason || "unknown"
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
// HEARTBEAT REFRESH (every 15s) + GPU TIMEOUT
// ======================================================
// Two responsibilities in one interval:
// 1. Refresh heartbeat for running tasks so busyImage stays valid
// 2. Clean up timed-out GPUs and report their tasks as failed to backend
//    (T3: hub — тупой транспорт; retry-решение принимает backend-планировщик,
//    а не повторный enqueue здесь. Прежний авто-requeue терял build_id и
//    конфликтовал с dispatch-lease backend'а.)

setInterval(async () => {

  const now = Date.now()

  // ── Refresh heartbeat for all running tasks ──
  // This keeps animastor:worker:heartbeat:type:id with current_job_id
  // alive for the ENTIRE duration of generation (15+ min).
  // Without this refresh, the heartbeat expires after 30s and
  // backend worker toggle falsely shows idle.
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
  for (const [id, gpu] of allGpus) {

    if (now - gpu.last_seen > GPU_TIMEOUT) {

      console.log("💀 GPU timeout:", id)

      const running = await redis.hgetall("animastor:running")

      for (const job_id in running) {

        try {

          const data = JSON.parse(running[job_id])

          if (data.worker === id) {

            console.log("💀 Worker timeout, reporting failure:", job_id)

            await redis.hdel("animastor:running", job_id)
            if (data.task_raw) {
              await redis.lrem("animastor:processing", 1, data.task_raw).catch(() => {})
            }

            // Освобождаем dedup очереди, чтобы re-dispatch backend'а не
            // отбился как duplicate.
            if (data.dispatch_id) {
              await redis.del(jobDedupKey(job_id, data.dispatch_id)).catch(() => {})
            }

            await notifyBackendError(job_id, data.build_id, data.dispatch_id, "worker_timeout")
          }

        } catch (err) {
          console.error("Timeout report error:", err)
        }
      }

      await deleteGpuFromRedis(id);
    }
  }

}, 10000)

// ======================================================
// BEACON
// ======================================================

app.post("/beacon", async (req, res) => {

  const { id, type, gpu, vram, version, image_tag, protocol_version } = req.body
  if (!id || !type) {
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
    id,
    type,
    gpu,
    vram,
    version: version || null,
    image_tag: image_tag || null,
    protocol_version: protocol_version || null,
    last_seen: Date.now()
  };

  // Primary registry: Redis (survives restart, cluster-aware)
  await setGpuInRedis(id, data);

  // Also write heartbeat for backend worker count panel
  try {
    const key = `animastor:worker:heartbeat:${type}:${id}`;
    const payload = JSON.stringify({
      type,
      worker_id: id,
      ts: Date.now(),
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
    stage
  } = req.body

  const type = job_type || "image"

  console.log("📥 Task:", job_id, type, "build:", build_id)

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
    `animastor:queue:${type}`,
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
      dispatch_id
    })
  )

  res.json({ ok: true })
})

// ======================================================
// TASK NEXT
// ======================================================

app.get("/task/next", async (req, res) => {

  const { worker, type } = req.query

  if (!worker) {
    return res.status(400).json({ error: "worker required" })
  }

  const gpu = await getGpuFromRedis(worker);
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
  if (type && gpu.type !== type) {
    return res.status(409).json({
      error: "worker_type_mismatch",
      registered: gpu.type,
      requested: type
    })
  }

  gpu.last_seen = Date.now();
  await setGpuInRedis(worker, gpu);

  const queueKey = `animastor:queue:${type || "image"}`

  const taskRaw = await redis.rpoplpush(
  queueKey,
  "animastor:processing"
)

  if (!taskRaw) return res.json({ task: null })

  const task = JSON.parse(taskRaw)

  await redis.hset(
    "animastor:running",
    task.job_id,
    JSON.stringify({
      worker,
      job_type: task.job_type,
      params: task.params,
      assets: task.assets || null,
      build_id: task.build_id || null,
      book_id: task.book_id,
      chapter_id: task.chapter_id,
      scene_id: task.scene_id,
      stage: task.stage,
      dispatch_id: task.dispatch_id,
      protocol_version: task.protocol_version,
      worker_version: gpu.version || null,
      worker_image_tag: gpu.image_tag || null,
      worker_protocol_version: gpu.protocol_version || null,
      task_raw: taskRaw,
      started_at: Date.now()
    })
  )

  console.log(`🚀 ${task.job_id} → ${worker} (${task.job_type}) build:${task.build_id || "none"}`)

  // Mark worker as busy in heartbeat
  try {
    const hbKey = `animastor:worker:heartbeat:${task.job_type}:${worker}`;
    const hbPayload = JSON.stringify({
      type: task.job_type,
      worker_id: worker,
      ts: Date.now(),
      current_job_id: task.job_id,
      current_dispatch_id: task.dispatch_id,
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

app.post("/task/result", async (req, res) => {

  const { job_id, build_id, result_base64, dispatch_id, protocol_version } = req.body

  if (!job_id || !build_id || !result_base64 || !dispatch_id || protocol_version !== PROTOCOL_VERSION) {
    return res.status(400).json({ error: "invalid" })
  }

  console.log("📤 Result:", job_id, "build:", build_id || "none")

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
  if (runningInfo.task_raw) {
    await redis.lrem("animastor:processing", 1, runningInfo.task_raw).catch(() => {})
  }

  // Clear busy flag from worker heartbeat
  if (runningInfo.worker && runningInfo.job_type) {
    try {
      const hbKey = `animastor:worker:heartbeat:${runningInfo.job_type}:${runningInfo.worker}`;
      const hbPayload = JSON.stringify({
        type: runningInfo.job_type,
        worker_id: runningInfo.worker,
        ts: Date.now(),
        current_job_id: null,
        current_dispatch_id: null,
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
      const backendRes = await fetch(
        `${BACKEND_URL}/gpu/task/result`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id,
            build_id,
            dispatch_id,
            protocol_version,
            result_base64
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

app.post("/task/error", async (req, res) => {

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

  await redis.hdel("animastor:running", job_id)
  if (runningInfo.task_raw) {
    await redis.lrem("animastor:processing", 1, runningInfo.task_raw).catch(() => {})
  }

  // Освобождаем dedup очереди для будущего re-dispatch.
  await redis.del(jobDedupKey(job_id, dispatch_id)).catch(() => {})

  // Clear busy flag from worker heartbeat
  if (runningInfo.worker && runningInfo.job_type) {
    try {
      const hbKey = `animastor:worker:heartbeat:${runningInfo.job_type}:${runningInfo.worker}`;
      const hbPayload = JSON.stringify({
        type: runningInfo.job_type,
        worker_id: runningInfo.worker,
        ts: Date.now(),
        current_job_id: null,
        current_dispatch_id: null,
        version: runningInfo.worker_version || null,
        image_tag: runningInfo.worker_image_tag || null,
        protocol_version: runningInfo.worker_protocol_version || null
      });
      await redis.set(hbKey, hbPayload, 'EX', 30);
    } catch (_) {}
  }

  // T3: форвард ошибки в backend → orchestrator.failStage
  await notifyBackendError(job_id, build_id, dispatch_id, reason || "worker_error")

  res.json({ ok: true })
})

// ======================================================
// HEALTH
// ======================================================

app.get("/health", async (req, res) => {

  const queues = {
    image: await redis.llen("animastor:queue:image"),
    audio: await redis.llen("animastor:queue:audio"),
    video: await redis.llen("animastor:queue:video")
  }

  const running = await redis.hlen("animastor:running")
  const gpuCount = (await getAllGpusFromRedis()).size;

  res.json({
    gpus: gpuCount,
    queues,
    running
  })
})

app.delete("/queue/clear", requireApiKey, async (req, res) => {
  try {
    const { book_id, dispatch_id } = req.query
    const queueKeys = [
      "animastor:queue:image",
      "animastor:queue:audio",
      "animastor:queue:video"
    ]
    const summary = { queued: 0, processing: 0, running: 0, results: 0, dedup: 0 }

    if (book_id || dispatch_id) {
      const matches = (record) => {
        if (dispatch_id) return record.dispatch_id === dispatch_id
        return record.book_id === book_id
      }
      const removedJobs = []

      // 1. Clear queue lists by structured ownership.
      for (const key of queueKeys) {
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
            } else if (parts.length >= 4 && parts[3] === book_id) {
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

      console.log(`[QUEUE-CLEAR] Filtered cleanup`, { book_id, dispatch_id, summary })
      res.json({ ok: true, scope: { book_id: book_id || null, dispatch_id: dispatch_id || null }, removed: summary })

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

// ======================================================
// START
// ======================================================

const server = app.listen(PORT, () => {
  console.log("🚀 GPU HUB running on", PORT)
})

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log("[SHUTDOWN] SIGTERM received, shutting down...");
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
