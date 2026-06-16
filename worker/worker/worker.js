// ======================================================
// GPU Worker - v1.0.0
// ======================================================

import { execSync } from "child_process"
import os from "os"
import fs from "fs"
import path from "path"

const fetch = global.fetch || (await import("node-fetch")).default

// ======================================================
// CONFIG
// ======================================================

const HUB_URL = process.env.HUB_URL || "https://animastor.in/gpu"
const COMFY_PORT = process.env.COMFY_PORT || 8188
const WORKER_TYPE = process.env.WORKER_TYPE || "image"

const NOTEBOOK_PATH = process.env.NOTEBOOK_PATH || ""
const WORKER_ID = process.env.WORKER_ID || "gpu-" + os.hostname()

const RESULT_TIMEOUT_MS = Number(process.env.RESULT_TIMEOUT_MS || 600000)
const TASK_SLEEP_MS = Number(process.env.TASK_SLEEP_MS || 2000)
const BEACON_INTERVAL_MS = Number(process.env.BEACON_INTERVAL_MS || 10000)

const COMFY_INPUT_DIR = process.env.COMFY_INPUT_DIR || "/home/jovyan/ComfyUI/input"
const COMFY_OUTPUT_DIR = path.resolve(COMFY_INPUT_DIR, "../output")

// ======================================================
// UTILS
// ======================================================

function log(level, msg, data = null) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`)
  if (data) console.log(data)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function fetchTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeout)

  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

function comfyUrl(path) {
  return `http://127.0.0.1:${COMFY_PORT}${NOTEBOOK_PATH}${path}`
}

// ======================================================
// FIND OUTPUT NODES (Save*)
// ======================================================

function findOutputNodes(workflow) {
  const result = {
    image: [],
    audio: [],
    video: []
  }

  for (const [id, node] of Object.entries(workflow || {})) {
    const type = node.class_type || ""

    if (type.startsWith("SaveImage")) {
      result.image.push(id)
    }

    if (type.startsWith("SaveAudio")) {
      result.audio.push(id)
    }

    if (type.startsWith("SaveVideo") || type.startsWith("CreateVideo")) {
      result.video.push(id)
    }
  }

  return result
}

// ======================================================
// GPU INFO
// ======================================================

function getGPUInfo() {
  try {
    const gpu = execSync(
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader"
    ).toString().trim()

    const [name, vram] = gpu.split(",")
    return { name: name.trim(), vram: vram.trim() }
  } catch {
    return { name: "unknown", vram: "unknown" }
  }
}

// ======================================================
// WAIT COMFY
// ======================================================

async function waitForComfyUI() {
  log("info", "Waiting for ComfyUI")

  while (true) {
    try {
      const res = await fetchTimeout(comfyUrl("/system_stats"))
      if (res.ok) {
        log("info", "ComfyUI ready")
        await sleep(3000)
        return
      }
    } catch {}

    process.stdout.write(".")
    await sleep(3000)
  }
}

// ======================================================
// BEACON
// ======================================================

async function sendBeacon() {
  try {
    const gpu = getGPUInfo()

    await fetchTimeout(`${HUB_URL}/beacon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: WORKER_ID,
        type: WORKER_TYPE,
        gpu: gpu.name,
        vram: gpu.vram
      })
    })
  } catch {
    log("error", "Beacon failed")
  }
}

// ======================================================
// GET TASK
// ======================================================

async function getTask() {
  try {
    const res = await fetchTimeout(
      `${HUB_URL}/task/next?worker=${WORKER_ID}&type=${WORKER_TYPE}`
    )

    if (!res.ok) return null

    const data = await res.json()
    return data?.task || null

  } catch {
    return null
  }
}

// ======================================================
// SAVE IMAGE SAFE
// ======================================================

function saveBase64ImageSafe(base64, filename) {
  const clean = base64.includes(",") ? base64.split(",")[1] : base64
  const buffer = Buffer.from(clean, "base64")

  if (!fs.existsSync(COMFY_INPUT_DIR)) {
    fs.mkdirSync(COMFY_INPUT_DIR, { recursive: true })
  }

  const filePath = path.join(COMFY_INPUT_DIR, filename)
  fs.writeFileSync(filePath, buffer)

  return {
    path: filePath,
    expectedSize: buffer.length
  }
}

// ======================================================
// WAIT FILE READY
// ======================================================

async function waitForFileReady(filePath, expectedSize, timeout = 5000) {
  const start = Date.now()

  while (true) {
    if (Date.now() - start > timeout) {
      throw new Error(`File not ready: ${filePath}`)
    }

    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath)

        if (stats.size === expectedSize && stats.size > 0) {
          await sleep(50)
          return true
        }
      }
    } catch {}

    await sleep(100)
  }
}

// ======================================================
// RUN WORKFLOW
// ======================================================

async function runWorkflow(workflow) {

  const body = workflow?.prompt
    ? { ...workflow, client_id: WORKER_ID }
    : { prompt: workflow, client_id: WORKER_ID }

  const res = await fetchTimeout(
    comfyUrl("/prompt"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  )

  const text = await res.text()

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("Invalid JSON from ComfyUI: " + text)
  }

  if (!data.prompt_id) {
    log("error", "ComfyUI error", data)
    throw new Error("No prompt_id")
  }

  return data.prompt_id
}

// ======================================================
// WAIT RESULT (dynamic)
// ======================================================

async function waitResult(prompt_id, workflow) {

  const start = Date.now()
  const outputsMap = findOutputNodes(workflow)
  const isVideoJob = outputsMap.video.length > 0

  // For video jobs: snapshot existing files and extract filename_prefix
  let videoDir, beforeFiles, videoPrefix
  if (isVideoJob) {
    videoDir = path.join(COMFY_OUTPUT_DIR, 'video')
    try {
      beforeFiles = new Set(fs.readdirSync(videoDir).filter(f => f.endsWith('.mp4')))
    } catch { beforeFiles = new Set() }
    // Extract filename_prefix from SaveVideo node to filter correctly
    for (const id of outputsMap.video) {
      const prefix = workflow?.[id]?.inputs?.filename_prefix
      if (prefix) {
        videoPrefix = path.basename(prefix)  // "video/LTX-2" → "LTX-2"
        break
      }
    }
  }

  while (true) {

    if (Date.now() - start > RESULT_TIMEOUT_MS) {
      try {
        const res = await fetchTimeout(comfyUrl(`/history/${prompt_id}`))
        const data = await res.json()
        log("error", `Timeout: last history response`, JSON.stringify(data).slice(0, 2000))
      } catch {}
      throw new Error("Timeout waiting result")
    }

    try {
      const res = await fetchTimeout(comfyUrl(`/history/${prompt_id}`))
      const data = await res.json()
      const outputs = data?.[prompt_id]?.outputs || {}

      // IMAGE
      for (const id of outputsMap.image) {
        const node = outputs[id]
        if (node?.images?.length > 0) return { type: "image", meta: node.images[0] }
      }

      // AUDIO
      for (const id of outputsMap.audio) {
        const node = outputs[id]
        if (node?.audio) {
          const a = Array.isArray(node.audio) ? node.audio[0] : node.audio
          if (a?.filename) return { type: "audio", meta: a }
          if (a?.data || typeof a === "string") return { type: "audio_base64", data: a.data || a }
        }
      }

      // VIDEO
      if (isVideoJob) {

        // 1. Check designated SaveVideo/CreateVideo nodes
        for (const id of outputsMap.video) {
          const node = outputs[id]
          for (const key of ['videos', 'video', 'gifs', 'result', 'files', 'media']) {
            const arr = node?.[key]
            if (Array.isArray(arr) && arr[0]?.filename) {
              return { type: "video", meta: arr[0] }
            }
          }
        }

        // 2. Scan ALL outputs
        for (const node of Object.values(outputs)) {
          for (const arr of Object.values(node || {})) {
            if (Array.isArray(arr) && arr[0]?.filename?.endsWith('.mp4')) {
              return { type: "video", meta: arr[0] }
            }
          }
        }

        // 3. Prompt completed in history → check filesystem
        if (data?.[prompt_id]?.status?.completed && videoDir) {
          const currentFiles = fs.readdirSync(videoDir).filter(f => f.endsWith('.mp4'))
          const newFiles = currentFiles.filter(f => !beforeFiles.has(f))
          // Filter by filename_prefix to avoid picking up unrelated files
          const matched = videoPrefix
            ? newFiles.filter(f => f.startsWith(videoPrefix))
            : newFiles
          if (matched.length > 0) {
            const newest = matched.sort().pop()
            log("info", `FS video: ${newest}`)
            return { type: "video", meta: { filename: newest, subfolder: 'video', type: 'output' } }
          }
        }
      }

    } catch {}

    await sleep(1500)
  }
}

// ======================================================
// DOWNLOAD RESULT
// ======================================================

async function downloadResult(result) {

  if (result.type === "audio_base64") {
    return `data:audio/mp3;base64,${result.data}`
  }

  let f = result.meta
  let subfolder = f.subfolder || ""

  if (subfolder.includes("/")) {
    subfolder = subfolder.split("/")[0]
  }

  const url = comfyUrl(
    `/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(subfolder)}&type=output`
  )

  const res = await fetchTimeout(url)
  if (!res.ok) throw new Error("Download failed")

  const buffer = await res.arrayBuffer()
  const raw = Buffer.from(buffer).toString("base64")

  if (result.type === "image") return `data:image/png;base64,${raw}`
  if (result.type === "audio") return `data:audio/mp3;base64,${raw}`
  if (result.type === "video") return `data:video/mp4;base64,${raw}`

  throw new Error("Unknown result type")
}

// ======================================================
// SEND RESULT
// ======================================================

async function sendResult(task, data) {
  const { job_id, build_id } = task
  await fetchTimeout(`${HUB_URL}/task/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id,
      build_id,
      result_base64: data
    })
  })
}

// ======================================================
// LOOP
// ======================================================

async function workerLoop() {

  setInterval(sendBeacon, BEACON_INTERVAL_MS)

  while (true) {

    const task = await getTask()

    if (!task) {
      await sleep(TASK_SLEEP_MS)
      continue
    }

    log("info", `Task ${task.job_id}`)

    try {

      if (task.assets?.images) {
        // Multi-image: { unitId: base64, ... }
        // filename = scenePrefix_unitId.png where scenePrefix = job_id stripped of suffix
        const [jobBase] = task.job_id.split(/:(image|audio|video)$/)
        const scenePrefix = jobBase.replace(/_g\d+$/, '')
        for (const [unitId, base64] of Object.entries(task.assets.images)) {
          const filename = `${scenePrefix}_${unitId}.png`
          const { path: filePath, expectedSize } =
            saveBase64ImageSafe(base64, filename)
          log("info", `Multi-image saved: ${filename}`)
          await waitForFileReady(filePath, expectedSize)
          log("info", `Multi-image ready: ${filename}`)
        }
      } else if (task.assets?.image) {

        const [baseId] = task.job_id.split(/:(image|audio|video)$/) 
        const filename = `${baseId}.png`

        const { path: filePath, expectedSize } =
          saveBase64ImageSafe(task.assets.image, filename)

        log("info", `Image saved: ${filename}`)

        await waitForFileReady(filePath, expectedSize)

        log("info", `Image ready: ${filename}`)
      }

      const prompt_id = await runWorkflow(task.params)

      const result = await waitResult(prompt_id, task.params)

      const base64 = await downloadResult(result)

      await sendResult(task, base64)

      log("info", `Done ${task.job_id}`)

    } catch (err) {

      log("error", `Failed ${task.job_id}`, err)

      await fetchTimeout(`${HUB_URL}/task/error`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: task.job_id })
      })
    }
  }
}

// ======================================================
// MAIN
// ======================================================

async function main() {
  log("info", `Worker ${WORKER_TYPE} started`)
  await waitForComfyUI()
  await workerLoop()
}

main()