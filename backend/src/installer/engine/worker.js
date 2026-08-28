'use strict';

/**
 * Worker installation — Private Worker Installer Phase 2.
 *
 * Deploys the existing Animastor Worker bundle (the runtime contract is NOT
 * changed), creates/updates `.env` with merge semantics, and verifies
 * registration against GPU Hub.
 *
 * Worker Key safety:
 *   - the value is accepted only via an interactive secret provider;
 *   - it is never logged, never written to the plan/state/reports, never
 *     passed through argv;
 *   - an existing valid token in `.env` is never overwritten.
 */

const path = require('path');
const { parseEnvKeys } = require('./probe');

function findWorkerManifest(manifests, workerEntryId) {
    return manifests.find((m) => `worker:${m.profile.id}` === workerEntryId) || null;
}

/**
 * Deploy the worker bundle into workerDir.
 * Source order (never invented): repo checkout `worker/worker/` first, then
 * the hub's GET /worker-source (serves worker.cjs only).
 * Ownership details are returned for the uninstall manifest: dir_created,
 * files the installer actually copied (files_installed) vs files that were
 * already on disk and were kept (files_kept).
 * @returns {{ status, files, files_installed, files_kept, dir_created, reason? }}
 */
function installWorkerBundle(io, { workerDir, manifest, repoRoot = null, hubUrl = null, httpFetchText = null, log = null }) {
    const wb = manifest.worker_bundle || {};
    const files = wb.files || [];
    const dirCreated = !io.fs.existsSync(workerDir);
    if (dirCreated) io.fs.mkdirSync(workerDir, { recursive: true });

    const repoBundleDir = repoRoot ? path.join(repoRoot, 'worker', 'worker') : null;
    const fromRepo = repoBundleDir && io.fs.isDirectory(repoBundleDir);
    const installed = [];
    const kept = [];
    const failed = [];

    for (const f of files) {
        const dest = path.join(workerDir, f);
        if (io.fs.existsSync(dest)) { kept.push(f); continue; }
        if (fromRepo && io.fs.existsSync(path.join(repoBundleDir, f))) {
            io.fs.copyFileSync(path.join(repoBundleDir, f), dest);
            installed.push(f);
            continue;
        }
        if (f === 'worker.cjs' && hubUrl && httpFetchText) {
            const url = `${hubUrl.replace(/\/$/, '')}/worker-source`;
            const res = httpFetchText(url);
            if (res && res.status === 200 && res.text) {
                io.fs.writeFileSync(dest, res.text);
                installed.push(f);
                continue;
            }
        }
        failed.push(f);
    }

    if (failed.length > 0) {
        return { status: 'failed', files: installed, files_installed: installed, files_kept: kept, dir_created: dirCreated, reason: `could not obtain bundle files: ${failed.join(', ')} (no repo checkout and hub unreachable)` };
    }

    // npm dependencies (node-fetch etc.) — best effort, offline-tolerant
    if (installed.includes('package.json')) {
        const r = io.exec('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: workerDir, timeout: 10 * 60 * 1000 });
        if (r.code !== 0 && log) {
            log.warn(`npm install in ${workerDir} failed (worker may still run if deps are cached): ${String(r.stderr).slice(-300)}`);
        }
    }

    if (log) log.info(`worker bundle deployed at ${workerDir} (${installed.length} files)`);
    return { status: 'installed', files: installed, files_installed: installed, files_kept: kept, dir_created: dirCreated };
}

/** Serialize KEY=value lines. Values are written as given — never logged. */
function renderEnvLines(values) {
    return Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n');
}

/**
 * Create or update `.env` with merge semantics:
 *   - existing keys are preserved (a valid token is never overwritten);
 *   - missing required keys are appended;
 *   - chmod 600.
 * @param {object} opts { workerDir, manifest, values: {KEY: value} candidate
 *   values for MISSING keys only, log }
 * @returns {{ status, missing_after: string[], preserved: string[] }}
 */
function configureEnv(io, { workerDir, manifest, values = {}, log = null }) {
    const wb = manifest.worker_bundle || {};
    const required = (wb.env && wb.env.required) || [];
    const envPath = path.join(workerDir, '.env');

    let existingText = '';
    let existingKeys = [];
    if (io.fs.existsSync(envPath)) {
        existingText = io.fs.readFileSync(envPath, 'utf8');
        existingKeys = parseEnvKeys(existingText);
    }

    const preserved = [];
    const additions = [];
    for (const key of required) {
        if (existingKeys.includes(key)) {
            preserved.push(key); // merge semantics: never overwrite
        } else if (values[key] !== undefined) {
            additions.push(`${key}=${values[key]}`);
        }
    }
    for (const [key, val] of Object.entries(values)) {
        if (!required.includes(key) && !existingKeys.includes(key)) {
            additions.push(`${key}=${val}`);
        }
    }

    const missingAfter = required.filter((k) => !existingKeys.includes(k) && values[k] === undefined);

    const envCreated = !io.fs.existsSync(envPath);
    let text = existingText;
    if (additions.length > 0) {
        if (text && !text.endsWith('\n')) text += '\n';
        text += additions.join('\n') + '\n';
    }
    io.fs.writeFileSync(envPath, text);
    io.fs.chmodSync(envPath, 0o600);

    if (log) log.info(`.env configured: ${preserved.length} key(s) preserved, ${additions.length} added, ${missingAfter.length} still missing`);
    return { status: missingAfter.length === 0 ? 'configured' : 'incomplete', missing_after: missingAfter, preserved, created: envCreated };
}

/** Derive the backend API base from HUB_URL (…/gpu → …/api/v1). */
function apiBaseFromHubUrl(hubUrl) {
    return String(hubUrl || '').replace(/\/gpu\/?$/, '') + '/api/v1';
}

/**
 * Verify worker registration against GPU Hub:
 *   POST {api}/worker/verify with Authorization: Bearer <token>
 * The token value is used in the request header ONLY.
 * @returns {{ registered, worker_id?, worker_type?, mode?, status_code?, reason? }}
 */
async function verifyRegistration(io, { hubUrl, token, expectedType = null }) {
    if (!token) {
        return { registered: false, reason: 'no Worker Key provided' };
    }
    const url = `${apiBaseFromHubUrl(hubUrl)}/worker/verify`;
    let res;
    try {
        res = await io.http.fetchJson(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
        });
    } catch (err) {
        return { registered: false, reason: `hub unreachable: ${err.message}` };
    }
    if (res.status === 200 && res.json && res.json.verified === true) {
        const typeOk = expectedType ? res.json.worker_type === expectedType : true;
        return {
            registered: true,
            worker_id: res.json.worker_id,
            worker_type: res.json.worker_type,
            mode: res.json.mode,
            type_matches: typeOk,
        };
    }
    if (res.status === 401 || res.status === 403) {
        return { registered: false, status_code: res.status, reason: 'credential rejected (fail-closed) — check the Worker Key; it is shown once at creation/rotation' };
    }
    return { registered: false, status_code: res.status, reason: `unexpected hub response (${res.status})` };
}

/**
 * Local sanity check that the worker CAN start: syntax check + dependency
 * resolution. (Actually starting the infinite worker loop is not part of
 * installation; registration is verified via the hub endpoint.)
 */
function checkWorkerCanStart(io, { workerDir }) {
    const workerCjs = path.join(workerDir, 'worker.cjs');
    if (!io.fs.existsSync(workerCjs)) return { ok: false, reason: 'worker.cjs missing' };
    const syntax = io.exec('node', ['--check', workerCjs]);
    if (syntax.code !== 0) return { ok: false, reason: `worker.cjs failed syntax check: ${String(syntax.stderr).slice(-200)}` };
    const deps = io.exec('node', ['-e', "require.resolve('node-fetch', { paths: [process.argv[1]] })", workerDir]);
    if (deps.code !== 0) {
        return { ok: false, reason: 'worker npm dependencies missing (run npm install in the worker dir)' };
    }
    return { ok: true };
}

module.exports = {
    installWorkerBundle,
    configureEnv,
    apiBaseFromHubUrl,
    verifyRegistration,
    checkWorkerCanStart,
    renderEnvLines,
};
