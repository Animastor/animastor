// ======================================================
// GPU Worker - v1.0.0
// ======================================================
// CJS (CommonJS) — Node 20+ with global fetch is assumed.

const { execSync } = require("child_process");
const os = require("os");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

// ======================================================
// CONFIG
// ======================================================

const HUB_URL = process.env.HUB_URL || "https://animastor.in/gpu";
const COMFY_PORT = process.env.COMFY_PORT || 8188;
const WORKER_TYPE = process.env.WORKER_TYPE || "image";

const NOTEBOOK_PATH = process.env.NOTEBOOK_PATH || "";
const WORKER_ID = process.env.WORKER_ID || "gpu-" + os.hostname();

const RESULT_TIMEOUT_MS = Number(process.env.RESULT_TIMEOUT_MS || 600000);
const TASK_SLEEP_MS = Number(process.env.TASK_SLEEP_MS || 2000);
const BEACON_INTERVAL_MS = Number(process.env.BEACON_INTERVAL_MS || 10000);

const COMFY_INPUT_DIR = process.env.COMFY_INPUT_DIR || "/home/jovyan/ComfyUI/input";
const COMFY_OUTPUT_DIR = path.resolve(COMFY_INPUT_DIR, "../output");

// ======================================================
// UTILS
// ======================================================

function log(level, msg, data) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
  if (data !== undefined) console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function comfyUrl(p) {
  return `http://127.0.0.1:${COMFY_PORT}${NOTEBOOK_PATH}${p}`;
}

// ======================================================
// FIND OUTPUT NODES (Save*)
// ======================================================

function findOutputNodes(workflow) {
  const result = { image: [], audio: [], video: [] };

  for (const [id, node] of Object.entries(workflow || {})) {
    const type = node.class_type || "";

    if (type.startsWith("SaveImage")) result.image.push(id);
    if (type.startsWith("SaveAudio")) result.audio.push(id);
    if (type.startsWith("SaveVideo") || type.startsWith("CreateVideo")) result.video.push(id);
  }

  return result;
}

// ======================================================
// GPU INFO
// ======================================================

function getGPUInfo() {
  try {
    const gpu = execSync(
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader"
    ).toString().trim();

    const [name, vram] = gpu.split(",");
    return { name: name.trim(), vram: vram.trim() };
  } catch (err) {
    log("error", "nvidia-smi failed", err.message);
    return { name: "unknown", vram: "unknown" };
  }
}

// ======================================================
// WAIT COMFY with exponential backoff
// ======================================================

async function waitForComfyUI() {
  log("info", "Waiting for ComfyUI");
  let attempts = 0;

  while (true) {
    try {
      const res = await fetchTimeout(comfyUrl("/system_stats"));
      if (res.ok) {
        log("info", "ComfyUI ready");
        await sleep(3000);
        return;
      }
    } catch (err) {
      log("warn", `ComfyUI not ready (attempt ${attempts + 1}): ${err.message}`);
    }

    attempts++;
    const backoff = Math.min(1000 * (1 << Math.min(attempts, 5)), 30000);
    process.stdout.write(".");
    await sleep(backoff);
  }
}

// ======================================================
// BEACON
// ======================================================

async function sendBeacon() {
  try {
    const gpu = getGPUInfo();

    await fetchTimeout(`${HUB_URL}/beacon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: WORKER_ID,
        type: WORKER_TYPE,
        gpu: gpu.name,
        vram: gpu.vram
      })
    });
  } catch (err) {
    log("error", "Beacon failed", err.message);
  }
}

// ======================================================
// GET TASK with backoff
// ======================================================

async function getTask() {
  try {
    const res = await fetchTimeout(
      `${HUB_URL}/task/next?worker=${WORKER_ID}&type=${WORKER_TYPE}`
    );

    if (!res.ok) return null;

    const data = await res.json();
    return data?.task || null;

  } catch (err) {
    log("warn", "getTask failed", err.message);
    return null;
  }
}

// ======================================================
// SAVE IMAGE (async)
// ======================================================

async function saveBase64ImageSafe(base64, filename) {
  const clean = base64.includes(",") ? base64.split(",")[1] : base64;
  const buffer = Buffer.from(clean, "base64");

  await fsp.mkdir(COMFY_INPUT_DIR, { recursive: true }).catch(err => log("warn", "mkdir", err.message));

  const filePath = path.join(COMFY_INPUT_DIR, filename);
  await fsp.writeFile(filePath, buffer);

  return { path: filePath, expectedSize: buffer.length };
}

// ======================================================
// WAIT FILE READY
// ======================================================

async function waitForFileReady(filePath, expectedSize, timeout = 5000) {
  const start = Date.now();

  while (true) {
    if (Date.now() - start > timeout) {
      throw new Error(`File not ready: ${filePath}`);
    }

    try {
      try {
        await fsp.access(filePath);
        const stats = await fsp.stat(filePath);
        if (stats.size === expectedSize && stats.size > 0) {
          await sleep(50);
          return true;
        }
      }
    } catch (err) {
      log("warn", `waitForFileReady error`, err.message);
    }

    await sleep(100);
  }
}

// ======================================================
// RUN WORKFLOW
// ======================================================

async function runWorkflow(workflow) {
  const body = workflow?.prompt
    ? { ...workflow, client_id: WORKER_ID }
    : { prompt: workflow, client_id: WORKER_ID };

  const res = await fetchTimeout(
    comfyUrl("/prompt"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON from ComfyUI: " + text.slice(0, 500));
  }

  if (!data.prompt_id) {
    log("error", "ComfyUI error", data);
    throw new Error("No prompt_id");
  }

  return data.prompt_id;
}

// ======================================================
// WAIT RESULT (with backoff)
// ======================================================

async function waitResult(prompt_id, workflow) {
  const start = Date.now();
  const outputsMap = findOutputNodes(workflow);
  const isVideoJob = outputsMap.video.length > 0;

  let videoDir, beforeFiles, videoPrefix;
  if (isVideoJob) {
    videoDir = path.join(COMFY_OUTPUT_DIR, 'video');
    try {
      beforeFiles = new Set((await fsp.readdir(videoDir)).filter(f => f.endsWith('.mp4')));
    } catch (err) {
      log("warn", "waitResult readdir", err && err.message || err);
      beforeFiles = new Set();
    }
    for (const id of outputsMap.video) {
      const prefix = workflow?.[id]?.inputs?.filename_prefix;
      if (prefix) {
        videoPrefix = path.basename(prefix);
        break;
      }
    }
  }

  let pollDelay = 500;
  while (true) {
    if (Date.now() - start > RESULT_TIMEOUT_MS) {
      try {
        const res = await fetchTimeout(comfyUrl(`/history/${prompt_id}`));
        const d = await res.json();
        log("error", `Timeout: last history response`, JSON.stringify(d).slice(0, 2000));
      } catch (err) {
        log("error", "Timeout: failed to fetch history", err.message);
      }
      throw new Error("Timeout waiting result");
    }

    try {
      const res = await fetchTimeout(comfyUrl(`/history/${prompt_id}`));
      const data = await res.json();
      const outputs = data?.[prompt_id]?.outputs || {};

      for (const id of outputsMap.image) {
        const node = outputs[id];
        if (node?.images?.length > 0) return { type: "image", meta: node.images[0] };
      }

      for (const id of outputsMap.audio) {
        const node = outputs[id];
        if (node?.audio) {
          const a = Array.isArray(node.audio) ? node.audio[0] : node.audio;
          if (a?.filename) return { type: "audio", meta: a };
          if (a?.data || typeof a === "string") return { type: "audio_base64", data: a.data || a };
        }
      }

      if (isVideoJob) {
        for (const id of outputsMap.video) {
          const node = outputs[id];
          for (const key of ['videos', 'video', 'gifs', 'result', 'files', 'media']) {
            const arr = node?.[key];
            if (Array.isArray(arr) && arr[0]?.filename) {
              return { type: "video", meta: arr[0] };
            }
          }
        }

        for (const node of Object.values(outputs)) {
          for (const arr of Object.values(node || {})) {
            if (Array.isArray(arr) && arr[0]?.filename?.endsWith('.mp4')) {
              return { type: "video", meta: arr[0] };
            }
          }
        }

        if (data?.[prompt_id]?.status?.completed && videoDir) {
          const allFiles = await fsp.readdir(videoDir).catch(() => []);
          const mp4Files = allFiles.filter(f => f.endsWith('.mp4'));
          const newFiles = mp4Files.filter(f => !beforeFiles.has(f));
          const matched = videoPrefix
            ? newFiles.filter(f => f.startsWith(videoPrefix))
            : newFiles;
          if (matched.length > 0) {
            const newest = matched.sort().pop();
            log("info", `FS video: ${newest}`);
            return { type: "video", meta: { filename: newest, subfolder: 'video', type: 'output' } };
          }
        }
      }

      // Reset poll delay on successful response
      pollDelay = 500;
    } catch (err) {
      log("warn", "waitResult poll failed", err.message);
      // Exponential backoff on error: 1s → 2s → 4s → 8s cap
      pollDelay = Math.min(pollDelay * 2, 8000);
    }

    await sleep(pollDelay);
  }
}

// ======================================================
// DOWNLOAD RESULT (OOM-safe: читаем с диска, не через HTTP re-download)
// ======================================================
// ComfyUI уже сохранил результат на диск в COMFY_OUTPUT_DIR.
// Вместо повторного HTTP download (который держит 2x файл в памяти:
// arrayBuffer + base64), читаем локально.
// Для файлов > 50MB логируем предупреждение — они всё равно будут
// загружены в память как base64 (protocol limitation).

const MIME_MAP = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mp3', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.avi': 'video/avi', '.mov': 'video/quicktime',
};

async function downloadResult(result) {
  if (result.type === "audio_base64") {
    return `data:audio/mp3;base64,${result.data}`;
  }

  const f = result.meta;
  const filename = f.filename;
  const subfolder = f.subfolder || "";
  const ext = path.extname(filename).toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';

  // ── Try local filesystem first (OOM-safe, no HTTP overhead) ──
  const localPath = path.resolve(COMFY_OUTPUT_DIR, subfolder, filename);
  try {
    const stat = await fsp.stat(localPath).catch(() => null);
    if (stat && stat.isFile() && stat.size > 0) {
      if (stat.size > 50 * 1024 * 1024) {
        log("warn", `Large file (${(stat.size / 1024 / 1024).toFixed(1)}MB) — base64 will use significant memory: ${filename}`);
      }
      const buffer = await fsp.readFile(localPath);
      return `data:${mime};base64,${buffer.toString('base64')}`;
    }
  } catch (_) {}

  // ── Fallback: HTTP download from ComfyUI ──
  log("info", `Falling back to HTTP download for ${filename}`);
  let sf = subfolder;
  if (sf.includes("/")) sf = sf.split("/")[0];

  const url = comfyUrl(
    `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(sf)}&type=output`
  );

  const res = await fetchTimeout(url);
  if (!res.ok) throw new Error("Download failed: " + res.status);

  const buffer = await res.arrayBuffer();
  const raw = Buffer.from(buffer).toString("base64");

  return `data:${mime};base64,${raw}`;
}

// ======================================================
// SEND RESULT
// ======================================================

async function sendResult(task, data) {
  const { job_id, build_id } = task;
  await fetchTimeout(`${HUB_URL}/task/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id, build_id, result_base64: data })
  });
}

// ======================================================
// LOOP (with backoff on empty queue)
// ======================================================

let emptyQueueDelay = TASK_SLEEP_MS;

async function workerLoop() {
  setInterval(sendBeacon, BEACON_INTERVAL_MS);

  while (true) {
    const task = await getTask();

    if (!task) {
      await sleep(emptyQueueDelay);
      emptyQueueDelay = Math.min(emptyQueueDelay * 2, 15000);
      continue;
    }
    emptyQueueDelay = TASK_SLEEP_MS; // reset on task received

    log("info", `Task ${task.job_id}`);

    if (task.protocol_version && task.protocol_version !== 1) {
      log("warn", `Protocol version mismatch: got ${task.protocol_version}, worker expects 1`);
    }

    try {
      if (task.assets?.images) {
        const [jobBase] = task.job_id.split(/:(iu_image|image|audio|video)$/);
        const scenePrefix = jobBase.replace(/_g\d+$/, '');
        for (const [unitId, base64] of Object.entries(task.assets.images)) {
          const filename = `${scenePrefix}_${unitId}.png`;
          const { path: filePath, expectedSize } = await saveBase64ImageSafe(base64, filename);
          log("info", `Multi-image saved: ${filename}`);
          await waitForFileReady(filePath, expectedSize);
          log("info", `Multi-image ready: ${filename}`);
        }
      } else if (task.assets?.image) {
        const [baseId] = task.job_id.split(/:(iu_image|image|audio|video)$/);
        const filename = `${baseId}.png`;
        const { path: filePath, expectedSize } = await saveBase64ImageSafe(task.assets.image, filename);
        log("info", `Image saved: ${filename}`);
        await waitForFileReady(filePath, expectedSize);
        log("info", `Image ready: ${filename}`);
      }

      const prompt_id = await runWorkflow(task.params);
      const result = await waitResult(prompt_id, task.params);
      const base64 = await downloadResult(result);
      await sendResult(task, base64);
      log("info", `Done ${task.job_id}`);

    } catch (err) {
      log("error", `Failed ${task.job_id}`, err.message);

      try {
        await fetchTimeout(`${HUB_URL}/task/error`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id: task.job_id,
            build_id: task.build_id || null,
            reason: String(err && err.message || err || "worker_error").slice(0, 500)
          })
        });
      } catch (sendErr) {
        log("error", "Failed to send error to hub", sendErr.message);
      }
    }
  }
}

// ======================================================
// MAIN
// ======================================================

async function main() {
  log("info", `Worker ${WORKER_TYPE} started`);
  await waitForComfyUI();
  await workerLoop();
}

main().catch(err => {
  log("error", "Worker crashed", err.message);
  process.exit(1);
});
