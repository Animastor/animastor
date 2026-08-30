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
const { currentUid } = require('./prereq');

function findWorkerManifest(manifests, workerEntryId) {
    return manifests.find((m) => `worker:${m.profile.id}` === workerEntryId) || null;
}

/**
 * Deploy the worker bundle into workerDir.
 * Source order (never invented): repo checkout `worker/worker/` first, then
 * an explicit `bundleDir` (a verified hub worker-bundle tarball the engine
 * extracted beforehand), then the hub's GET /worker-source (worker.cjs only;
 * deprecated single-file channel).
 * Ownership details are returned for the uninstall manifest: dir_created,
 * files the installer actually copied (files_installed) vs files that were
 * already on disk and were kept (files_kept).
 * @returns {{ status, files, files_installed, files_kept, dir_created, reason? }}
 */
function installWorkerBundle(io, { workerDir, manifest, repoRoot = null, bundleDir = null, hubUrl = null, httpFetchText = null, log = null }) {
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
        if (bundleDir && io.fs.existsSync(path.join(bundleDir, f))) {
            io.fs.copyFileSync(path.join(bundleDir, f), dest);
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
        return { status: 'failed', files: installed, files_installed: installed, files_kept: kept, dir_created: dirCreated, reason: `could not obtain bundle files: ${failed.join(', ')} (no repo checkout, no hub bundle)` };
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

/**
 * Download + verify + extract the hub's full worker bundle (GET
 * /worker-bundle, sha256 published at /worker-bundle/sha256). Returns the
 * extraction dir (`animastor-worker/`) as a copy source for
 * installWorkerBundle — used when the installer runs without a repo
 * checkout (the distributed installer package may not carry bundle files).
 * The caller owns the returned tmpDir and must clean it up.
 * @returns {{ bundleDir, tmpDir } | { bundleDir: null, reason }}
 */
async function fetchHubWorkerBundle(io, { hubUrl, tmpRoot = null }) {
    if (!hubUrl) return { bundleDir: null, reason: 'no hub URL' };
    if (!io.http || !io.http.download || !io.http.fetchJson || !io.hashFile) {
        return { bundleDir: null, reason: 'io layer cannot download the hub bundle' };
    }
    const base = hubUrl.replace(/\/$/, '');
    const os = require('os');
    const tmpDir = path.join(tmpRoot || os.tmpdir(), `animastor-worker-bundle-${Date.now()}`);
    const tarPath = path.join(tmpDir, 'worker-bundle.tar.gz');
    try {
        const shaRes = await io.http.fetchJson(`${base}/worker-bundle/sha256`);
        io.fs.mkdirSync(tmpDir, { recursive: true });
        const dl = await io.http.download({ url: `${base}/worker-bundle`, dest: tarPath });
        if (dl.status !== 200) {
            return { bundleDir: null, reason: `worker-bundle download failed (HTTP ${dl.status})` };
        }
        if (shaRes.status === 200 && shaRes.json && shaRes.json.sha256) {
            const actual = await io.hashFile(tarPath);
            if (actual !== shaRes.json.sha256) {
                return { bundleDir: null, reason: 'worker-bundle sha256 mismatch — download refused (integrity)' };
            }
        }
        const r = io.exec('tar', ['-xzf', tarPath, '-C', tmpDir]);
        if (r.code !== 0) {
            return { bundleDir: null, reason: `tar extraction failed: ${String(r.stderr || r.error).slice(-200)}` };
        }
        const srcDir = path.join(tmpDir, 'animastor-worker');
        if (!io.fs.isDirectory(srcDir)) {
            return { bundleDir: null, reason: 'worker-bundle layout unexpected (animastor-worker/ missing)' };
        }
        return { bundleDir: srcDir, tmpDir };
    } catch (err) {
        return { bundleDir: null, reason: `worker-bundle fetch failed: ${err && err.message ? err.message : err}` };
    } finally {
        try { if (io.fs.existsSync(tarPath)) io.fs.unlinkSync(tarPath); } catch (_) { /* best effort */ }
    }
}

/**
 * Find a RUNNING worker process for this exact workerDir. `pgrep -f worker.cjs`
 * matches every worker on the host (several users may run one), so each
 * candidate pid is confirmed via /proc/<pid>/cwd — the worker always runs with
 * cwd=workerDir (both the installer spawn and a manual `node worker.cjs`).
 * @returns {number|null} pid of the running worker in this dir
 */
function findRunningWorkerPid(io, workerDir) {
    const out = io.exec('pgrep', ['-f', 'worker\\.cjs']);
    if (!out || out.code !== 0 || !out.stdout) return null;
    for (const line of String(out.stdout).split('\n')) {
        const pid = Number(line.trim());
        if (!Number.isFinite(pid) || pid <= 0) continue;
        const cwd = io.exec('readlink', [`/proc/${pid}/cwd`]);
        if (cwd && cwd.code === 0 && path.resolve(String(cwd.stdout).trim()) === path.resolve(workerDir)) {
            return pid;
        }
    }
    return null;
}

/**
 * True when .env was modified AFTER the worker process started: the running
 * worker loaded the OLD configuration (its process.env is fixed at startup)
 * and would keep the stale wiring (e.g. the pre-COMFY_PORT default port)
 * forever. /proc/<pid> mtime is the process start time on Linux.
 */
function workerEnvIsNewer(io, { workerDir, pid }) {
    try {
        const envM = io.fs.statSync(path.join(workerDir, '.env')).mtimeMs;
        const procM = io.fs.statSync(`/proc/${pid}`).mtimeMs;
        return envM > procM + 1000; // 1s tolerance for same-second writes
    } catch (_) {
        return false;
    }
}

/**
 * Start the installed worker as a detached daemon (node worker.cjs). The
 * worker loads its own .env (worker-env.cjs), so no secrets pass through
 * the environment or argv here. Returns whether the process is still alive
 * after a short grace period. Idempotent: a worker already running for this
 * directory is left alone (re-runs must never spawn a second instance).
 */
function startWorker(io, { workerDir, logFile = null, graceMs = 3000, sleep = null }) {
    const can = checkWorkerCanStart(io, { workerDir });
    if (!can.ok) return { started: false, alive: false, reason: can.reason };
    const existing = findRunningWorkerPid(io, workerDir);
    if (existing && !workerEnvIsNewer(io, { workerDir, pid: existing })) {
        return { started: true, already_running: true, pid: existing, alive: true, reason: null };
    }
    if (existing) {
        // .env changed after this worker started — it is running on the OLD
        // configuration (its env is fixed at process start). Restart it so
        // re-runs with a new --comfy-port etc. actually take effect.
        io.exec('kill', [String(existing)]);
        io.exec(sleep || 'sleep', ['1']);
    }
    const pid = io.spawnDaemon('node', ['worker.cjs'], {
        cwd: workerDir,
        logFile: logFile || path.join(workerDir, 'worker-installer.log'),
    });
    // sync grace pause (installer is already a synchronous-step CLI)
    io.exec(sleep || 'sleep', [String(Math.max(1, Math.ceil(graceMs / 1000)))]);
    const chk = io.exec('ps', ['-p', String(pid), '-o', 'args=']);
    const alive = chk.code === 0 && /worker\.cjs/.test(chk.stdout);
    return { started: true, pid, alive, reason: alive ? null : 'worker exited immediately — see the log file' };
}

/**
 * Uid of a process (from /proc/<pid> stat) or null when unavailable.
 */
function pidUid(io, pid) {
    try {
        const st = io.fs.statSync(`/proc/${pid}`);
        return typeof st.uid === 'number' ? st.uid : null;
    } catch (_) {
        return null;
    }
}

/**
 * Stop a RUNNING worker of THIS installation (pid from findRunningWorkerPid,
 * i.e. cwd-verified) and wait for it to exit. Never uses pkill/killall: the
 * pid is addressed directly, and a pid owned by a DIFFERENT account is
 * refused (shared host with several Animastor installations).
 * @returns {{ stopped: boolean, pid: number|null, reason: string|null }}
 */
async function stopManagedWorker(io, { workerDir, stopTimeoutMs = 15000, pollMs = 300, log = null }) {
    const pid = findRunningWorkerPid(io, workerDir);
    if (!pid) return { stopped: false, pid: null, reason: 'no running worker process found for this installation' };
    const me = currentUid();
    const owner = pidUid(io, pid);
    if (me != null && owner != null && me !== 0 && owner !== me) {
        return { stopped: false, pid, reason: `worker process ${pid} is owned by uid ${owner} — refusing to signal a foreign process` };
    }
    if (log) log.info(`stopping worker (pid ${pid})`);
    try {
        if (typeof io.kill === 'function') io.kill(pid, 'SIGTERM');
        else process.kill(pid, 'SIGTERM');
    } catch (_) {
        return { stopped: true, pid, reason: null }; // already gone
    }
    const alive = () => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
    const deadline = (io.now ? io.now() : Date.now()) + stopTimeoutMs;
    while (alive() && (io.now ? io.now() : Date.now()) < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
    }
    if (alive()) {
        try { if (typeof io.kill === 'function') io.kill(pid, 'SIGKILL'); else process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ }
    }
    return { stopped: true, pid, reason: null };
}

/**
 * Restart the managed worker of THIS installation: stop the running process
 * (cwd-verified, uid-guarded — a foreign worker is never signaled), then
 * start a fresh one via startWorker (which is idempotent, refuses a broken
 * bundle, and reports liveness after a grace period). Also used when the
 * worker is already stopped: the stop step is skipped and it is just started.
 * @returns {{ restarted: boolean, previously_running: boolean, pid: number|null,
 *             alive: boolean, reason: string|null }}
 */
async function restartManagedWorker(io, { workerDir, log = null, stopTimeoutMs = 15000, pollMs = 300, graceMs = 3000 }) {
    const previouslyRunning = !!findRunningWorkerPid(io, workerDir);
    if (previouslyRunning) {
        const stop = await stopManagedWorker(io, { workerDir, stopTimeoutMs, pollMs, log });
        if (!stop.stopped) {
            return { restarted: false, previously_running: true, pid: stop.pid, alive: false, reason: stop.reason };
        }
    }
    const start = startWorker(io, { workerDir, graceMs, log });
    if (!start.started) {
        return { restarted: true, previously_running: previouslyRunning, pid: null, alive: false, reason: start.reason };
    }
    if (start.already_running) {
        return { restarted: false, previously_running: true, pid: start.pid, alive: true, reason: null };
    }
    return { restarted: true, previously_running: previouslyRunning, pid: start.pid, alive: start.alive, reason: start.reason };
}

module.exports = {
    installWorkerBundle,
    fetchHubWorkerBundle,
    startWorker,
    stopManagedWorker,
    restartManagedWorker,
    findRunningWorkerPid,
    workerEnvIsNewer,
    configureEnv,
    apiBaseFromHubUrl,
    verifyRegistration,
    checkWorkerCanStart,
    renderEnvLines,
};
