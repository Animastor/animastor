'use strict';

/**
 * Management Tools runtime — shared logic for the installer and the
 * command-line management tools installed next to the worker
 * (tools/status.sh, tools/reboot-worker.sh, tools/reboot-comfyui.sh,
 * tools/comfyui-monitor.sh).
 *
 * The tools are thin CLI entry points; ALL runtime behaviour lives here and
 * reuses the installer engine primitives — there is exactly ONE
 * implementation of managed ComfyUI discovery (engine/comfyui.js
 * findManagedComfyUIPids / restartManagedComfyUI), managed worker discovery
 * (engine/worker.js findRunningWorkerPid / restartManagedWorker), port
 * handling (installer_options / comfyui_runtime state) and terminal UX
 * (engine/term.js createTermRenderer + busy spinner).
 *
 * Safety invariants (mirrors the installer):
 *   - no global pkill/killall: only cwd-verified managed processes are
 *     signaled, and only ones owned by the current account (uid guard);
 *   - cross-tenant safety: paths and the install state's owner_uid go through
 *     the same ownership guard as the installer (prereq.checkOwnership);
 *   - tools never create root-owned files: the ownership guard blocks a sudo
 *     run against a user-owned installation;
 *   - read-only tools (status/monitor) never write state; reboot tools write
 *     only the runtime log files the engine's spawnDaemon already manages.
 *
 * ComfyUI API usage (v0.11.x, graceful fallback everywhere):
 *   GET /system_stats  — API reachability (comfyui.systemStats)
 *   GET /queue         — queue_running / queue_pending
 *   GET /history?max_items=N (fallback: /history) — recent errors
 * The monitor NEVER invents data it could not retrieve: unknown values are
 * rendered as "—" and unavailable blocks are omitted.
 */

const path = require('path');
const comfyui = require('./engine/comfyui');
const workerMod = require('./engine/worker');
const stateMod = require('./engine/state');
const prereq = require('./engine/prereq');

/** The installed command-line tools (wrapper script → CLI subcommand). */
const TOOL_SCRIPTS = Object.freeze([
    { file: 'status.sh', command: 'status' },
    { file: 'reboot-worker.sh', command: 'reboot-worker' },
    { file: 'reboot-comfyui.sh', command: 'reboot-comfyui' },
    { file: 'comfyui-monitor.sh', command: 'monitor' },
]);

// ---------------------------------------------------------------------------
// Runtime target resolution (one installation = one state file + roots)
// ---------------------------------------------------------------------------

/**
 * Resolve the runtime targets of THIS installation.
 * Precedence: explicit CLI flags > install state > defaults.
 * @returns {{ state, comfyuiRoot, workerDir, port, device, statePath, found: boolean }}
 */
function resolveTargets(io, { statePath, root = null, workerDir = null, port = null } = {}) {
    const st = statePath ? stateMod.loadState(io, statePath) : null;
    const comfyuiRoot = root || (st && st.root) || null;
    const resolvedWorker = workerDir
        || (st && st.components && st.components.worker && st.components.worker.dir)
        || null;
    const resolvedPort = port
        || (st && st.comfyui_runtime && st.comfyui_runtime.port)
        || null;
    const found = !!(comfyuiRoot || resolvedWorker || st);
    return {
        state: st,
        comfyuiRoot,
        workerDir: resolvedWorker,
        port: resolvedPort,
        device: st ? st.device : null,
        statePath,
        found,
    };
}

/**
 * Ownership guard for every tool invocation: blocks running as root against
 * a user-owned installation (sudo mixing) and operating on another uid's
 * installation. Same rules, same messages as the installer gates.
 * `currentUid`/`home` overrides exist for deterministic tests; production
 * passes nothing and the real uid/home are used.
 * @returns {{ ok: boolean, violations: object[] }}
 */
function checkAccess(io, targets, { currentUid = null, home = null } = {}) {
    return prereq.checkOwnership(io, {
        paths: [targets.comfyuiRoot, targets.workerDir, targets.statePath].filter(Boolean),
        home: home !== null ? home : prereq.currentHome(),
        currentUid: currentUid !== null ? currentUid : prereq.currentUid(),
        stateUid: targets.state && targets.state.owner_uid != null ? targets.state.owner_uid : null,
    });
}

/** Extract the --port value from a process cmdline (/proc/<pid>/cmdline). */
function readPidPort(io, pid) {
    try {
        const parts = io.fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        const i = parts.indexOf('--port');
        if (i !== -1 && parts[i + 1]) return Number(parts[i + 1]);
    } catch (_) { /* gone or unreadable */ }
    return null;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Snapshot of the managed runtime. Reuses the managed discovery primitives:
 *   - Worker: engine/worker.findRunningWorkerPid (cwd-verified)
 *   - ComfyUI: engine/comfyui.findManagedComfyUIPids (cwd-verified — a
 *     foreign ComfyUI on the same port is NEVER reported as ours)
 *   - API: engine/comfyui.systemStats (GET /system_stats)
 *   - Queue: GET /queue
 * Never throws on unreachable components — unreachable IS the status.
 */
async function collectStatus(io, targets) {
    const workerPid = targets.workerDir
        ? workerMod.findRunningWorkerPid(io, targets.workerDir)
        : null;
    const comfyRootPresent = !!(targets.comfyuiRoot && io.fs.existsSync(targets.comfyuiRoot));
    const comfyPids = comfyRootPresent
        ? comfyui.findManagedComfyUIPids(io, { root: targets.comfyuiRoot })
        : [];
    let port = targets.port || null;
    if (comfyPids.length > 0) {
        port = readPidPort(io, comfyPids[0]) || port;
    }
    const baseUrl = port ? `http://127.0.0.1:${port}` : null;
    const stats = baseUrl ? await comfyui.systemStats(io, baseUrl) : null;
    let queue = null;
    if (stats && baseUrl) {
        try {
            const r = await io.http.fetchJson(`${baseUrl}/queue`);
            if (r.status === 200 && r.json && Array.isArray(r.json.queue_running)) {
                queue = {
                    running: r.json.queue_running.length,
                    pending: (r.json.queue_pending || []).length,
                };
            }
        } catch (_) { /* queue is optional */ }
    }
    return {
        worker: { running: !!workerPid, pid: workerPid || null },
        comfyui: { running: comfyPids.length > 0, root_present: comfyRootPresent, port, pids: comfyPids },
        api: { ok: !!stats },
        queue,
    };
}

/** Render the `Animastor status` block. */
function renderStatus(snapshot) {
    const ok = '✓';
    const bad = '✗';
    const lines = [];
    lines.push('Animastor status');
    lines.push('');
    lines.push(`Worker:   ${snapshot.worker.running ? `${ok} RUNNING` : `${bad} STOPPED`}`);
    lines.push(`ComfyUI:  ${snapshot.comfyui.running
        ? `${ok} RUNNING${snapshot.comfyui.port ? ` :${snapshot.comfyui.port}` : ''}`
        : `${bad} STOPPED`}`);
    lines.push(`API:      ${snapshot.api.ok ? `${ok} OK` : `${bad} UNREACHABLE`}`);
    if (snapshot.queue) {
        lines.push(`Queue:    ${snapshot.queue.running} running / ${snapshot.queue.pending} pending`);
    } else {
        lines.push('Queue:    — (API unreachable)');
    }
    return lines.join('\n');
}

/** Exit code for a status snapshot: 0 healthy, 1 degraded. */
function statusExitCode(snapshot) {
    return snapshot.worker.running && snapshot.comfyui.running && snapshot.api.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// reboot-worker / reboot-comfyui
// ---------------------------------------------------------------------------

/**
 * Restart THIS installation's worker. Managed-only and uid-guarded via
 * engine/worker.restartManagedWorker (no global pkill/killall). Correctly
 * handles the already-stopped case (skips the stop step and just starts).
 * @returns {{ ok: boolean, healthy: boolean, detail: string|null }}
 */
async function restartWorker(io, targets, { term = null, log = null, stopTimeoutMs = 15000 } = {}) {
    const withBusy = (label, fn) => (term ? term.withBusy(label, fn) : fn());
    const withBusySync = (label, fn) => (term ? term.withBusySync(label, fn) : fn());
    const wasRunning = !!workerMod.findRunningWorkerPid(io, targets.workerDir);

    if (wasRunning) {
        await withBusy('Stopping Worker', async () => {
            const stop = await workerMod.stopManagedWorker(io, { workerDir: targets.workerDir, stopTimeoutMs, log });
            if (!stop.stopped) throw new Error(stop.reason || 'worker could not be stopped');
            return stop;
        });
    }
    const start = withBusySync(wasRunning ? 'Starting Worker' : 'Starting Worker (was stopped)', () =>
        workerMod.startWorker(io, { workerDir: targets.workerDir, log }));
    if (!start.started) {
        return { ok: false, healthy: false, detail: start.reason || 'worker could not be started' };
    }
    // startWorker already waited the grace period and verified the process is
    // alive (ps args check) — that IS the runtime's worker health check.
    if (!start.alive) {
        return { ok: false, healthy: false, detail: start.reason || 'worker exited immediately — see the worker log' };
    }
    return { ok: true, healthy: true, detail: start.already_running ? 'already running' : null };
}

/**
 * Restart THIS installation's managed ComfyUI. REUSES the installer engine:
 *   - running  → engine/comfyui.restartManagedComfyUI (managed discovery,
 *                uid-guarded via allowedUids, API wait built in);
 *   - stopped  → engine/comfyui.startComfyUI + waitForApi (the same
 *                primitives the installer's verification step uses).
 * @returns {{ ok: boolean, port: number|null, detail: string|null }}
 */
async function restartComfyUI(io, targets, { term = null, log = null, verifyTimeoutMs = 120000, pollIntervalMs = 2000 } = {}) {
    const withBusy = (label, fn) => (term ? term.withBusy(label, fn, { minShowMs: 200 }) : fn());
    if (!targets.comfyuiRoot || !io.fs.existsSync(targets.comfyuiRoot)) {
        return { ok: false, port: null, detail: `ComfyUI root not found${targets.comfyuiRoot ? ` (${targets.comfyuiRoot})` : ''}` };
    }
    const me = prereq.currentUid();
    const allowedUids = me != null ? [me] : null;
    const pids = comfyui.findManagedComfyUIPids(io, { root: targets.comfyuiRoot });
    let port = targets.port || null;
    if (pids.length > 0) port = readPidPort(io, pids[0]) || port;

    if (pids.length > 0) {
        const res = await withBusy('Restarting ComfyUI', () => comfyui.restartManagedComfyUI(io, {
            root: targets.comfyuiRoot,
            port: port || 8188,
            device: targets.device || null,
            log,
            verifyTimeoutMs,
            pollIntervalMs,
            allowedUids,
        }));
        if (!res.restarted) {
            return { ok: false, port, detail: res.reason || 'managed ComfyUI was not restarted' };
        }
        if (!res.up) {
            return { ok: true, port, detail: res.reason || 'ComfyUI restarted but the API did not come up — see the ComfyUI log', up: false };
        }
        return { ok: true, port, detail: null };
    }
    // stopped → start (same primitives as the installer's start step)
    const res = await withBusy('Starting ComfyUI (was stopped)', async () => {
        const started = comfyui.startComfyUI(io, {
            root: targets.comfyuiRoot,
            port: port || 8188,
            device: targets.device || null,
        });
        const up = await comfyui.waitForApi(io, `http://127.0.0.1:${started.port}`, { timeoutMs: verifyTimeoutMs, intervalMs: pollIntervalMs });
        return { started, up };
    });
    if (!res.up.ok) {
        return { ok: true, port: res.started.port, detail: res.up.reason, up: false };
    }
    return { ok: true, port: res.started.port, detail: null };
}

// ---------------------------------------------------------------------------
// comfyui-monitor
// ---------------------------------------------------------------------------

/** Best-effort job kind from a queue entry's prompt graph (never throws). */
function guessJobKind(queueEntry) {
    try {
        const prompt = queueEntry && queueEntry[2];
        const classes = [];
        if (prompt && typeof prompt === 'object') {
            if (Array.isArray(prompt.nodes)) {
                for (const n of prompt.nodes) if (n && (n.class_type || n.type)) classes.push(String(n.class_type || n.type));
            } else {
                for (const n of Object.values(prompt)) {
                    if (n && typeof n === 'object' && n.class_type) classes.push(String(n.class_type));
                }
            }
        }
        const joined = classes.join(' ');
        if (/tts|audio|voice|speech/i.test(joined)) return 'audio generation';
        if (/video|svd|vhs|animate|framepack/i.test(joined)) return 'video generation';
        if (/upscale/i.test(joined)) return 'upscale';
        if (/ksampler|checkpoint|clip|vae|latent|diffusion/i.test(joined)) return 'image generation';
        if (classes.length > 0) return classes[0];
    } catch (_) { /* never */ }
    return 'workflow';
}

function fmtClock(tsMs) {
    try {
        const d = new Date(Number(tsMs));
        if (Number.isNaN(d.getTime())) return null;
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    } catch (_) {
        return null;
    }
}

/**
 * Collect monitor data from the ComfyUI API with graceful fallback:
 *   - /system_stats down → api.ok=false (monitor still renders, exit 1);
 *   - /queue unavailable → queue section omitted;
 *   - /history?max_items unavailable → retries plain /history;
 *   - running-job duration/progress are not exposed by the supported
 *     ComfyUI REST API → rendered as "—", never invented.
 */
async function collectMonitor(io, targets, { historyMax = 24 } = {}) {
    const port = targets.port || 8188;
    const base = `http://127.0.0.1:${port}`;
    const stats = await comfyui.systemStats(io, base);

    let queue = null;
    try {
        const r = await io.http.fetchJson(`${base}/queue`);
        if (r.status === 200 && r.json && Array.isArray(r.json.queue_running)) {
            queue = { running: r.json.queue_running || [], pending: r.json.queue_pending || [] };
        }
    } catch (_) { /* optional */ }

    let history = null;
    try {
        let r = await io.http.fetchJson(`${base}/history?max_items=${historyMax}`);
        if (!(r.status === 200 && r.json)) r = await io.http.fetchJson(`${base}/history`);
        if (r.status === 200 && r.json) history = r.json;
    } catch (_) { /* optional */ }

    const errors = [];
    if (history && typeof history === 'object') {
        for (const [promptId, entry] of Object.entries(history)) {
            const status = entry && entry.status;
            if (!status || status.status_str !== 'error') continue;
            for (const msg of status.messages || []) {
                const [event, data] = Array.isArray(msg) ? msg : [null, null];
                if (event !== 'execution_error' || !data || typeof data !== 'object') continue;
                errors.push({
                    prompt_id: promptId,
                    node_type: data.node_type || null,
                    message: String(data.exception_message || data.exception_type || 'execution error'),
                    timestamp: data.timestamp || null,
                });
            }
        }
    }
    errors.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return {
        port,
        api: { ok: !!stats },
        stats,
        queue,
        errors: errors.slice(0, 5),
    };
}

/** Render the `Animastor ComfyUI Monitor` block. */
function renderMonitor(data) {
    const ok = '✓';
    const bad = '✗';
    const lines = [];
    lines.push('Animastor ComfyUI Monitor');
    lines.push('────────────────────────────────────');
    lines.push('');
    lines.push(`ComfyUI:  ${data.api.ok ? `${ok} RUNNING` : `${bad} NOT RESPONDING`}`);
    lines.push(`API:      ${data.api.ok ? `${ok} OK` : `${bad} UNREACHABLE`}`);
    lines.push(`Port:     ${data.port}`);
    if (data.stats && data.stats.system && data.stats.system.comfyui_version) {
        lines.push(`Version:  ${data.stats.system.comfyui_version}`);
    }

    if (!data.queue) {
        lines.push('');
        lines.push('Queue     — (unavailable)');
    } else {
        const running = data.queue.running || [];
        const pending = data.queue.pending || [];
        lines.push('');
        lines.push('Queue');
        lines.push(`  Running: ${running.length}`);
        lines.push(`  Pending: ${pending.length}`);
        if (running.length === 0 && pending.length === 0) {
            lines.push('  Status: empty');
        }

        if (running.length > 0) {
            lines.push('');
            lines.push('Running');
            for (const entry of running.slice(0, 5)) {
                const id = entry && entry[1] ? String(entry[1]) : '?';
                // duration/progress are not exposed by the REST API — shown as "—"
                lines.push(`  #${id}  ${guessJobKind(entry)}  —`);
            }
        }
        if (pending.length > 0) {
            lines.push('');
            lines.push('Pending');
            for (const entry of pending.slice(0, 8)) {
                const id = entry && entry[1] ? String(entry[1]) : '?';
                lines.push(`  #${id}  ${guessJobKind(entry)}  waiting`);
            }
            if (pending.length > 8) lines.push(`  … ${pending.length - 8} more`);
        }
    }

    if (data.errors.length > 0) {
        lines.push('');
        lines.push('Recent errors');
        for (const e of data.errors) {
            const when = e.timestamp ? fmtClock(e.timestamp) : null;
            const head = String(e.message).split('\n')[0].slice(0, 120);
            lines.push(`  [${when || '—'}] ${e.node_type || 'node'}: ${head}`);
        }
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tools installation (installer component)
// ---------------------------------------------------------------------------

/** Escape a single-quoted shell word. */
function shQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Render one tool wrapper. The wrapper is a THIN shim: all runtime behaviour
 * lives in the installer CLI (`management.js`), so there is exactly one
 * implementation of discovery/restart logic for installer and tools.
 */
function renderToolScript({ command, nodePath, cliPath, statePath, root, workerDir }) {
    const parts = [
        '#!/bin/sh',
        '# Animastor management tool — generated by animastor-installer.',
        '# Do not edit: re-run the installer to refresh (paths are recorded at install time).',
        `exec ${shQuote(nodePath)} ${shQuote(cliPath)} ${command} \\`,
        `  --state ${shQuote(statePath)} \\`,
        `  --root ${shQuote(root || '')} \\`,
        `  --worker-dir ${shQuote(workerDir || '')} "$@"`,
        '',
    ];
    return parts.join('\n');
}

/**
 * Install (or idempotently refresh) the command-line management tools next
 * to the worker. Re-running the installer overwrites the same four files —
 * no duplicates, no broken state.
 * @returns {{ toolsDir, files: string[] }}
 */
function installManagementTools(io, { toolsDir, nodePath, cliPath, statePath, root, workerDir, log = null }) {
    io.fs.mkdirSync(toolsDir, { recursive: true });
    const files = [];
    for (const t of TOOL_SCRIPTS) {
        const p = path.join(toolsDir, t.file);
        io.fs.writeFileSync(p, renderToolScript({
            command: t.command, nodePath, cliPath, statePath, root, workerDir,
        }));
        io.fs.chmodSync(p, 0o755);
        files.push(p);
    }
    if (log && log.info) log.info(`management tools installed at ${toolsDir} (${files.length} commands)`);
    return { toolsDir, files };
}

module.exports = {
    TOOL_SCRIPTS,
    resolveTargets,
    checkAccess,
    readPidPort,
    collectStatus,
    renderStatus,
    statusExitCode,
    restartWorker,
    restartComfyUI,
    collectMonitor,
    renderMonitor,
    guessJobKind,
    renderToolScript,
    installManagementTools,
};
