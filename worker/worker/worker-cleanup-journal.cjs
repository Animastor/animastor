// ======================================================
// Worker Cleanup Journal — crash-safe recovery временных файлов ComfyUI
// ======================================================
// Worker-local persistent journal lifecycle одной job:
//   CREATED → GENERATED → DELIVERED → (CLEANED удаляет запись)
//
// Хранит ТОЛЬКО конкретные absolute paths (никаких glob/prefix). Записи
// пишутся атомарно (tmp → fsync → rename), поэтому crash не повреждает JSON.
// Живёт на persistent-диске worker'а (рядом с runtime data), переживает и
// worker-restart, и Redis-restart (не зависит от Redis/PG).
//
// ВАЖНЫЙ ПРИНЦИП recovery: если нет доказательства DELIVERED — output не
// удаляется (защита единственной копии результата). input_files можно
// удалять всегда — они пересоздаются из task.assets при re-dispatch.
//
// Повреждённый journal НЕ расшифровывается и НЕ приводит к удалению файлов:
// записывается warning, файл остаётся для диагностики.
// Orphan-файлы без journal не трогаются (нет доказательства принадлежности).

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { cleanupJobArtifacts } = require("./worker-cleanup.cjs");

const PHASES = ["created", "generated", "delivered"];

function defaultLog(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

function resolveJournalDir(journalDir) {
  return journalDir || process.env.WORKER_JOURNAL_DIR || path.join(__dirname, "cleanup-journal");
}

function sanitizeFilePart(str) {
  return String(str).replace(/[^A-Za-z0-9._-]/g, "_");
}

function journalFilePath(journalDir, jobId, dispatchId) {
  return path.join(journalDir, `${sanitizeFilePart(jobId)}__${sanitizeFilePart(dispatchId)}.json`);
}

// ── Atomic JSON write: tmp file → fsync → rename ──
async function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  const fh = await fsp.open(tmpPath, "w");
  try {
    await fh.writeFile(JSON.stringify(data, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmpPath, filePath);
}

// ── Read + validate a journal record. Returns null on any corruption. ──
function readRecord(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const record = JSON.parse(raw);
    if (!record || typeof record !== "object") return null;
    if (!record.job_id || !record.dispatch_id) return null;
    if (!PHASES.includes(record.phase)) return null;
    if (!Array.isArray(record.input_files)) record.input_files = [];
    return record;
  } catch (_) {
    return null;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Создать journal-запись job (phase=created). ДОЛЖЕН вызываться ДО создания
 * первого временного input-файла. Best-effort: возвращает record или null.
 */
async function createJob({ journalDir, jobId, dispatchId, log } = {}) {
  const logFn = log || defaultLog;
  if (!jobId || !dispatchId) return null;
  try {
    const dir = resolveJournalDir(journalDir);
    await ensureDir(dir);
    const record = {
      job_id: jobId,
      dispatch_id: dispatchId,
      phase: "created",
      input_files: [],
      output_file: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await atomicWriteJson(journalFilePath(dir, jobId, dispatchId), record);
    return record;
  } catch (err) {
    logFn("warn", `Journal create failed for ${jobId}: ${err.message}`);
    return null;
  }
}

async function mutate({ journalDir, jobId, dispatchId, log } = {}, mutateFn) {
  const logFn = log || defaultLog;
  if (!jobId || !dispatchId) return null;
  try {
    const dir = resolveJournalDir(journalDir);
    const filePath = journalFilePath(dir, jobId, dispatchId);
    const record = readRecord(filePath);
    if (!record) {
      logFn("warn", `Journal record missing for ${jobId} (${filePath})`);
      return null;
    }
    const changed = await mutateFn(record);
    if (changed === false) return record;
    record.updated_at = new Date().toISOString();
    await atomicWriteJson(filePath, record);
    return record;
  } catch (err) {
    logFn("warn", `Journal update failed for ${jobId}: ${err.message}`);
    return null;
  }
}

/** Добавить фактически созданный input path в journal. */
async function addInputFile(opts, filePath) {
  return mutate(opts, (record) => {
    if (!filePath) return false;
    if (!record.input_files.includes(filePath)) record.input_files.push(filePath);
  });
}

/** После waitResult: зафиксировать конкретный output-файл → phase=generated. */
async function setOutputAndGenerated(opts, outputFile) {
  return mutate(opts, (record) => {
    if (!outputFile) return false;
    record.output_file = outputFile;
    record.phase = "generated";
  });
}

/** После успешного sendResult (HTTP 200) → phase=delivered. */
async function setDelivered(opts) {
  return mutate(opts, (record) => {
    record.phase = "delivered";
  });
}

/** Удалить journal-запись (после полного CLEANED). Идемпотентно. */
async function removeJob({ journalDir, jobId, dispatchId, log } = {}) {
  try {
    const dir = resolveJournalDir(journalDir);
    await fsp.unlink(journalFilePath(dir, jobId, dispatchId)).catch(() => {});
    return true;
  } catch (_) {
    return false;
  }
}

function listJournalFiles(journalDir) {
  let files = [];
  try {
    files = fs.readdirSync(resolveJournalDir(journalDir));
  } catch (_) {}
  return files.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp.json"));
}

/**
 * Crash-safe startup recovery. Для каждой записи:
 *   delivered  → удалить input_files + output_file;
 *   created/generated → удалить ТОЛЬКО input_files (output сохраняется).
 * Запись удаляется только когда ВСЕ удаления успешны; при частичном cleanup
 * запись остаётся — следующий прогон дочистит. Повреждённые записи
 * пропускаются (warning) и не ломают startup.
 *
 * @returns {Promise<{found:number, cleaned:number, kept:number, corrupt:number}>}
 */
async function recoverCleanupJournal({ journalDir, log } = {}) {
  const logFn = log || defaultLog;
  const dir = resolveJournalDir(journalDir);
  const files = listJournalFiles(journalDir);
  const result = { found: files.length, cleaned: 0, kept: 0, corrupt: 0 };

  if (files.length > 0) logFn("info", `Cleanup recovery: found ${files.length} journal(s)`);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const record = readRecord(filePath);
    if (!record) {
      result.corrupt++;
      logFn("warn", `Cleanup recovery: corrupt journal skipped ${file} (kept for diagnostics)`);
      continue;
    }
    const { job_id, dispatch_id } = record;
    logFn("info", `Cleanup recovery: job_id=${job_id} phase=${record.phase}`);

    // Без proof DELIVERED output не трогаем (единственная копия результата).
    const outputFile = record.phase === "delivered" ? record.output_file : null;
    let cleanupResult;
    try {
      cleanupResult = await cleanupJobArtifacts({
        inputFiles: record.input_files,
        outputFile,
      });
    } catch (err) {
      result.kept++;
      logFn("warn", `Cleanup recovery: job_id=${job_id} failed path=(${err.message})`);
      continue;
    }

    result.cleaned += cleanupResult.cleaned;
    for (const fail of cleanupResult.failed) {
      logFn("warn", `Cleanup recovery: failed path=${fail.path} reason=${fail.reason}`);
    }

    if (cleanupResult.failed.length === 0) {
      await removeJob({ journalDir: dir, jobId: job_id, dispatchId: dispatch_id });
      logFn("info", `Cleanup recovery: job_id=${job_id} cleaned ${cleanupResult.cleaned} artifact(s)`);
    } else {
      result.kept++;
      logFn("info", `Cleanup recovery: job_id=${job_id} partial cleanup, journal kept`);
    }
  }

  return result;
}

module.exports = {
  createJob,
  addInputFile,
  setOutputAndGenerated,
  setDelivered,
  removeJob,
  recoverCleanupJournal,
  readRecord,
  atomicWriteJson,
  journalFilePath,
  resolveJournalDir,
  sanitizeFilePart,
};
