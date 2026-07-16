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

const gpus = new Map()

// ======================================================
// CLEANUP (GPU TIMEOUT + REQUEUE)
// ======================================================

// ======================================================
// ERROR DELIVERY → BACKEND
// ======================================================
// T3 консолидации: любая ошибка задачи (сбой воркера, worker_timeout)
// доносится до backend → orchestrator.failStage. До этого backend узнавал
// о падении только по истечении dispatch-lease (15–30 мин).
// При недоставке — фолбэк-ключ animastor:error:{job_id} (симметрично
// animastor:result:* для результатов), его подберёт recovery.

async function notifyBackendError(job_id, build_id, reason) {
  for (let i = 0; i < 5; i++) {
    try {
      const backendRes = await fetch(
        `${BACKEND_URL}/gpu/task/error`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job_id, build_id: build_id || null, reason: reason || "unknown" })
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
      JSON.stringify({ job_id, build_id: build_id || null, reason: reason || "unknown", ts: Date.now() }),
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
            current_job_id: job_id
          })
          await redis.set(hbKey, hbPayload, 'EX', 30)
        }
      } catch (_) {}
    }
  } catch (_) {}

  // ── GPU timeout cleanup ──
  for (const [id, gpu] of gpus.entries()) {

    if (now - gpu.last_seen > GPU_TIMEOUT) {

      console.log("💀 GPU timeout:", id)

      const running = await redis.hgetall("animastor:running")

      for (const job_id in running) {

        try {

          const data = JSON.parse(running[job_id])

          if (data.worker === id) {

            console.log("💀 Worker timeout, reporting failure:", job_id)

            await redis.hdel("animastor:running", job_id)

            // Освобождаем dedup очереди, чтобы re-dispatch backend'а не
            // отбился как duplicate.
            await redis.del(`animastor:job:${job_id}`).catch(() => {})

            await notifyBackendError(job_id, data.build_id, "worker_timeout")
          }

        } catch (err) {
          console.error("Timeout report error:", err)
        }
      }

      gpus.delete(id)
    }
  }

}, 10000)

// ======================================================
// BEACON
// ======================================================

app.post("/beacon", async (req, res) => {

  const { id, type, gpu, vram } = req.body

  gpus.set(id, {
    id,
    type,
    gpu,
    vram,
    last_seen: Date.now()
  })

  // Also write to Redis for backend worker count panel
  try {
    const key = `animastor:worker:heartbeat:${type}:${id}`;
    const payload = JSON.stringify({ type, worker_id: id, ts: Date.now() });
    await redis.set(key, payload, 'EX', 30);
  } catch (_) {}

  res.json({ ok: true })
})

// ======================================================
// TASK CREATE
// ======================================================

app.post("/task", async (req, res) => {

  const { job_id, params, job_type, assets, build_id, protocol_version } = req.body

  const type = job_type || "image"

  console.log("📥 Task:", job_id, type, "build:", build_id)

  // SYNC: backend/src/runtime/job-schema.js (PROTOCOL_VERSION)
  if (protocol_version && protocol_version !== 1) {
    console.warn(`⚠️ Protocol version mismatch: got ${protocol_version}, hub expects 1 — check backend/gpu-hub versions`)
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
  `animastor:job:${job_id}`,
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
      protocol_version: protocol_version || 1
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

  const gpu = gpus.get(worker)
  if (!gpu) {
    return res.status(404).json({ error: "not registered" })
  }

  gpu.last_seen = Date.now()

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
      started_at: Date.now()
    })
  )

  console.log(`🚀 ${task.job_id} → ${worker} (${task.job_type}) build:${task.build_id || "none"}`)

  // Mark worker as busy in heartbeat
  try {
    const hbKey = `animastor:worker:heartbeat:${task.job_type}:${worker}`;
    const hbPayload = JSON.stringify({ type: task.job_type, worker_id: worker, ts: Date.now(), current_job_id: task.job_id });
    await redis.set(hbKey, hbPayload, 'EX', 30);
  } catch (_) {}

  res.json({ task })
})

// ======================================================
// RESULT (WITH RETRY)
// ======================================================

app.post("/task/result", async (req, res) => {

  const { job_id, build_id, result_base64 } = req.body

  if (!job_id || !result_base64) {
    return res.status(400).json({ error: "invalid" })
  }

  console.log("📤 Result:", job_id, "build:", build_id || "none")

  // Read running info to get worker/job_type before deleting
  let runningWorker = null;
  let runningType = null;
  try {
    const raw = await redis.hget("animastor:running", job_id);
    if (raw) {
      const info = JSON.parse(raw);
      runningWorker = info.worker;
      runningType = info.job_type;
    }
  } catch (_) {}

  // Store result as JSON so audio-recovery can parse it.
  // key format: animastor:result:<build_id>:<book_id>:<chapter_id>:<scene_id>:<type>
  // job_id format: "bookId_chapterId_sceneId_chunkIndex:type"
  // bookId can contain underscores, but chapterId/sceneId/chunkIndex cannot.
  // Split by ':' first to remove type suffix, then parse from the end.
  // SYNC: backend/src/runtime/job-schema.js — упрощённая копия parseJobId;
  // при изменении формата job_id обновить оба места.
  const resultKeyParts = job_id.split(':');
  const resultType = resultKeyParts.length > 1 ? resultKeyParts.pop() : 'audio';
  const resultBaseId = resultKeyParts.join(':');
  const resultIdParts = resultBaseId.split('_');
  let resultBookId = '';
  let resultChapterId = '';
  let resultSceneId = '';
  if (resultIdParts.length >= 3) {
    resultIdParts.pop();  // discard chunk index e.g. '0001'
    resultSceneId = resultIdParts.pop();           // e.g. 'sc-6c4ea9f6'
    resultChapterId = resultIdParts.pop();         // e.g. 'ch-ce87fec4'
    resultBookId = resultIdParts.join('_');        // e.g. 'master_margarita_demo'
  }
  const resultData = JSON.stringify({
    job_id,
    result_base64,
    build_id: build_id || null
  });
  const resultRedisKey = `animastor:result:${build_id || 'default'}:${resultBookId}:${resultChapterId}:${resultSceneId}:${resultType}`;
  await redis.set(
    resultRedisKey,
    resultData,
    "EX",
    3600 // 1 hour
  )

  await redis.hdel("animastor:running", job_id)

  // Clear busy flag from worker heartbeat
  if (runningWorker && runningType) {
    try {
      const hbKey = `animastor:worker:heartbeat:${runningType}:${runningWorker}`;
      const hbPayload = JSON.stringify({ type: runningType, worker_id: runningWorker, ts: Date.now(), current_job_id: null });
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
          body: JSON.stringify({ job_id, build_id, result_base64 })
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

  const { job_id, build_id, reason } = req.body

  console.log("❌ Error:", job_id, reason || "")

  // Read running info before deleting
  let runningWorker = null;
  let runningType = null;
  let runningBuildId = null;
  try {
    const raw = await redis.hget("animastor:running", job_id);
    if (raw) {
      const info = JSON.parse(raw);
      runningWorker = info.worker;
      runningType = info.job_type;
      runningBuildId = info.build_id;
    }
  } catch (_) {}

  await redis.hdel("animastor:running", job_id)

  // Освобождаем dedup очереди для будущего re-dispatch.
  await redis.del(`animastor:job:${job_id}`).catch(() => {})

  // Clear busy flag from worker heartbeat
  if (runningWorker && runningType) {
    try {
      const hbKey = `animastor:worker:heartbeat:${runningType}:${runningWorker}`;
      const hbPayload = JSON.stringify({ type: runningType, worker_id: runningWorker, ts: Date.now(), current_job_id: null });
      await redis.set(hbKey, hbPayload, 'EX', 30);
    } catch (_) {}
  }

  // T3: форвард ошибки в backend → orchestrator.failStage
  await notifyBackendError(job_id, build_id || runningBuildId, reason || "worker_error")

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

  res.json({
    gpus: gpus.size,
    queues,
    running
  })
})

app.delete("/queue/clear", async (req, res) => {
  try {
    const { book_id } = req.query
    const queueKeys = [
      "animastor:queue:image",
      "animastor:queue:audio",
      "animastor:queue:video"
    ]
    let removed = 0

    if (book_id) {
      // === FILTERED CLEAR: only tasks for this book ===

      // 1. Clear queue lists (filter by book_id prefix in job_id)
      for (const key of queueKeys) {
        const items = await redis.lrange(key, 0, -1)
        const remaining = []
        for (const item of items) {
          try {
            const parsed = JSON.parse(item)
            if (parsed.job_id && parsed.job_id.startsWith(book_id + '_')) {
              removed++
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

      // 2. Clear animastor:running entries for this book
      let cursor = '0'
      do {
        const scan = await redis.hscan('animastor:running', cursor, 'COUNT', 500)
        cursor = scan[0]
        const entries = scan[1]
        if (entries && entries.length > 0) {
          for (let i = 0; i < entries.length; i += 2) {
            const job_id = entries[i]
            if (job_id.startsWith(book_id + '_')) {
              await redis.hdel('animastor:running', job_id)
              removed++
            }
          }
        }
      } while (cursor !== '0')

      // 3. Clear result and dedup keys for this book
      for (const pattern of [`animastor:result:${book_id}_*`, `animastor:job:${book_id}_*`]) {
        let c = '0'
        do {
          const scan = await redis.scan(c, 'MATCH', pattern, 'COUNT', 500)
          c = scan[0]
          if (scan[1].length) {
            await redis.del(scan[1])
            removed += scan[1].length
          }
        } while (c !== '0')
      }

      console.log(`[QUEUE-CLEAR] Removed ${removed} entries for book ${book_id}`)
      res.json({ ok: true, message: `Cleared ${removed} tasks for book ${book_id}` })

    } else {
      // === FULL CLEAR: wipe all queues ===

      for (const key of queueKeys) {
        const len = await redis.llen(key) || 0
        await redis.del(key)
        removed += len
      }

      // Clear animastor:running
      const runningLen = await redis.hlen('animastor:running') || 0
      await redis.del('animastor:running')
      removed += runningLen

      // Clear all result and dedup keys
      for (const pattern of ['animastor:result:*', 'animastor:job:*']) {
        let c = '0'
        do {
          const scan = await redis.scan(c, 'MATCH', pattern, 'COUNT', 500)
          c = scan[0]
          if (scan[1].length) {
            await redis.del(scan[1])
            removed += scan[1].length
          }
        } while (c !== '0')
      }

      console.log(`[QUEUE-CLEAR] Removed ${removed} entries (full clear)`)
      res.json({ ok: true, message: "All gpu-hub queues cleared", removed })
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
