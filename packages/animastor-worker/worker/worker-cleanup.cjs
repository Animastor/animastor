// ======================================================
// Worker Cleanup — точечная уборка временных файлов ComfyUI
// ======================================================
// Удаляет ТОЛЬКО файлы конкретной job (input-файлы, созданные worker'ом, и
// output-файл, реально прочитанный как результат). Никогда не бросает:
// - отсутствующий файл (ENOENT) считается успехом;
// - ошибка удаления одного файла не останавливает уборку остальных.
// Это НЕ глобальная чистка input/output — только явно переданные пути.

const fsp = require("fs").promises;

/**
 * Safe unlink — никогда не бросает.
 * @param {string} filePath абсолютный путь
 * @returns {Promise<{ok:boolean, path:string, missing?:boolean, error?:string}>}
 */
async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, path: filePath, missing: true };
    }
    return { ok: false, path: filePath, error: (err && err.message) || String(err) };
  }
}

/**
 * Cleanup артефактов одной job: input-файлы (всегда) + output-файл
 * (только когда он передан — т.е. результат уже доставлен).
 * @param {{inputFiles?: string[], outputFile?: string|null}} opts
 * @returns {Promise<{cleaned:number, failed:Array<{path:string, reason:string}>, outputFile:string|null}>}
 */
async function cleanupJobArtifacts({ inputFiles = [], outputFile = null } = {}) {
  const failed = [];
  let cleaned = 0;

  for (const filePath of inputFiles) {
    const res = await safeUnlink(filePath);
    if (res.ok) {
      cleaned++;
    } else {
      failed.push({ path: filePath, reason: res.error });
    }
  }

  if (outputFile) {
    const res = await safeUnlink(outputFile);
    if (res.ok) {
      cleaned++;
    } else {
      failed.push({ path: outputFile, reason: res.error });
    }
  }

  return { cleaned, failed, outputFile: outputFile || null };
}

module.exports = { safeUnlink, cleanupJobArtifacts };
