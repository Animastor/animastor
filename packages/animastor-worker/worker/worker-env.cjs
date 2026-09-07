// ======================================================
// Animastor Private Worker — minimal .env loader (no deps)
// ======================================================
// Makes the worker runtime bundle self-contained: `cp .env.example .env`,
// edit, `node worker.cjs`. Loads `./.env` next to the worker entry file;
// REAL environment variables always win (the file never overrides them).
// Never logs values — the Worker Key stays out of logs.

const fs = require("fs");
const path = require("path");

/** Parse one KEY=VALUE line; returns [key, value] or null. */
function parseEnvLine(line) {
  const m = String(line).match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m) return null;
  let value = m[2];
  if (value.length >= 2 && (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )) {
    value = value.slice(1, -1);
  }
  return [m[1], value];
}

/**
 * Load `./.env` from `dir` (default: this directory) into process.env.
 * Existing process.env entries are NEVER overridden. Comments/blank lines
 * are ignored. Returns true when a .env file was read.
 */
function loadDotEnv(dir) {
  const file = path.join(dir || __dirname, ".env");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (_) {
    return false; // no .env — environment variables only
  }
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    process.env[key] = value;
  }
  return true;
}

module.exports = { loadDotEnv, parseEnvLine };
