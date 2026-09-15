'use strict';

/**
 * Windows platform adapter — Private Worker Installer (cross-platform prep).
 *
 * STATUS: architectural preview. The adapter defines every platform
 * touchpoint needed to run the universal installer on Windows and the parts
 * that can be implemented safely without a Windows test machine are
 * implemented (paths, venv layout, tool wrappers, remediation commands,
 * home/env resolution, daemon pid marker). The process-management commands
 * are implemented against standard Windows tooling (PowerShell CIM,
 * tasklist) but are NOT yet production-validated — the adapter is marked
 * productionReady:false and the CLI prints an explicit preview notice.
 *
 * Design notes (why this differs from the Linux adapter):
 *   - Windows has no /proc: process discovery cannot cwd-verify. The managed
 *     worker is instead identified by a pid marker file written next to the
 *     bundle (worker.pid) at start time — a foreign worker in another
 *     directory never has our marker, which preserves the "never touch
 *     foreign processes" invariant.
 *   - A managed ComfyUI process runs on the venv python whose ExecutablePath
 *     lives under the installation root — that is the ownership marker.
 *   - venv layout is Scripts\python.exe (not bin/python).
 *   - Management tools are .cmd batch wrappers (cmd.exe), not shell scripts.
 *   - Grace sleeps use ping (timeout.exe refuses redirected input).
 *   - The uid/ownership guard is a POSIX concept; Windows returns null uids
 *     and the guard passes (path ACLs are a later concern).
 */

const path = require('path');

const NAME = 'windows';
const PID_MARKER_FILE = 'worker.pid';

// ---------------------------------------------------------------------------
// Paths (true Windows paths, independent of the host the adapter runs on —
 // the adapter must produce backslash paths even when unit-tested on Linux)
// ---------------------------------------------------------------------------

/** Join path segments with Windows separators (backslash), never POSIX. */
function winJoin(...parts) {
    return parts
        .filter((p) => p != null && String(p) !== '')
        .map((p, i) => (i === 0 ? String(p) : String(p).replace(/^[\\/]+/, '')))
        .join('\\')
        .replace(/[\\/]+/g, '\\');
}

/** Default ComfyUI root: %USERPROFILE%\ComfyUI. */
function defaultRoot(home) {
    return winJoin(home || 'C:\\Users\\Public', 'ComfyUI');
}

/** Default worker bundle dir: %USERPROFILE%\animastor\worker. */
function defaultWorkerDir(home) {
    return winJoin(home || 'C:\\Users\\Public', 'animastor', 'worker');
}

/** Home directory env var on Windows. */
const HOME_ENV = 'USERPROFILE';

/** Python interpreter inside a venv (Windows layout). */
function venvPythonBin(venvDir) {
    return winJoin(venvDir, 'Scripts', 'python.exe');
}

// ---------------------------------------------------------------------------
// Process management (PowerShell CIM / pid marker)
// ---------------------------------------------------------------------------

/** Normalize a Windows path for case/slash-insensitive comparison. */
function normWinPath(p) {
    return String(p || '').replace(/\//g, '\\').toLowerCase();
}

function ps(script) {
    return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
}

/** Read the pid marker file written by onWorkerSpawned, or null. */
function readPidMarker(io, workerDir) {
    try {
        const p = winJoin(workerDir, PID_MARKER_FILE);
        if (!io.fs.existsSync(p)) return null;
        const parsed = JSON.parse(io.fs.readFileSync(p, 'utf8'));
        return parsed && Number.isFinite(parsed.pid) ? parsed : null;
    } catch (_) {
        return null;
    }
}

/** Is the pid alive? (tasklist filter — present on every Windows install) */
function pidAlive(io, pid) {
    const r = io.exec('tasklist', ['/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`]);
    if (!r || r.code !== 0) return false;
    return new RegExp(`["]${pid}["]`).test(String(r.stdout));
}

/**
 * Post-spawn bookkeeping: Windows has no /proc, so the managed worker is
 * identified by a pid marker written next to the bundle at start time.
 * Best effort — discovery simply finds nothing when the write failed.
 */
function onWorkerSpawned(io, { workerDir, pid }) {
    try {
        io.fs.writeFileSync(
            winJoin(workerDir, PID_MARKER_FILE),
            JSON.stringify({ pid, started_at: io.now ? io.now() : Date.now() }),
        );
    } catch (_) { /* best effort */ }
}

/**
 * PIDs of worker processes for THIS workerDir. Windows has no cwd to verify,
 * so the managed marker is the pid file written when the installer started
 * the worker; the pid must still be alive AND running node on worker.cjs.
 * @returns {number[]}
 */
function findPidsByCmdlineAndCwd(io, { cwd, cmdPattern = 'worker\\.cjs' }) {
    const marker = readPidMarker(io, cwd);
    if (!marker) return [];
    if (!pidAlive(io, marker.pid)) return [];
    const q = ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${marker.pid}").CommandLine`);
    const r = io.exec(q.cmd, q.args);
    const cmdline = r && r.code === 0 ? String(r.stdout).trim() : '';
    if (!cmdline || !new RegExp(cmdPattern).test(cmdline)) return [];
    return [marker.pid];
}

/** cwd of a pid — not resolvable on Windows (no /proc). Always null. */
function readProcessCwd(_io, _pid) {
    return null;
}

/** Command line of a pid via PowerShell CIM, or null. */
function readProcessCmdline(io, pid) {
    const q = ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`);
    const r = io.exec(q.cmd, q.args);
    if (!r || r.code !== 0 || !String(r.stdout).trim()) return null;
    return String(r.stdout).trim().split(/\s+/);
}

/**
 * Process start time. Windows has no /proc mtime; the pid marker written at
 * spawn time is the source of truth (same role as .env-newer detection).
 */
function processStartMs(io, pid) {
    return null; // caller falls back to the marker via workerStartMarker
}

/**
 * Marker of when the managed worker started (replaces /proc mtime check).
 * Returns ms or null when no marker exists.
 */
function workerStartMarkerMs(io, workerDir) {
    const marker = readPidMarker(io, workerDir);
    return marker && Number.isFinite(marker.started_at) ? marker.started_at : null;
}

/** Uid owning a process — POSIX concept, null on Windows. */
function pidUid(_io, _pid) {
    return null;
}

/**
 * PIDs of ComfyUI processes managed by THIS installation root: python
 * processes running main.py whose ExecutablePath is the venv python under
 * `root` (the venv lives inside the root — a strong managed marker), and by
 * default on `port`.
 */
function findComfyUIPids(io, { root, port = null }) {
    const script = 'Get-CimInstance Win32_Process -Filter "Name=\'python.exe\'" '
        + '| Select-Object ProcessId,ExecutablePath,CommandLine '
        + '| ConvertTo-Json -Compress';
    const q = ps(script);
    const r = io.exec(q.cmd, q.args);
    if (!r || r.code !== 0 || !String(r.stdout).trim()) return [];
    let items = [];
    try {
        const parsed = JSON.parse(String(r.stdout).trim());
        items = Array.isArray(parsed) ? parsed : [parsed];
    } catch (_) { return []; }
    const rootNorm = normWinPath(root);
    const out = [];
    for (const it of items) {
        if (!it || !it.ProcessId) continue;
        const exe = normWinPath(it.ExecutablePath);
        if (!exe || !exe.startsWith(rootNorm)) continue; // foreign python
        const cmdline = String(it.CommandLine || '');
        if (!/(^|[\\\/])main\.py(["']|\s|$)/.test(cmdline)) continue;
        if (port != null) {
            const m = /--port\s+(\d+)/.exec(cmdline);
            if ((m ? Number(m[1]) : 8188) !== Number(port)) continue;
        }
        out.push(Number(it.ProcessId));
    }
    return out;
}

/**
 * Process discovery by cwd prefix — not supported on Windows (no /proc).
 * The uninstaller reports this explicitly instead of pretending to scan.
 */
function findPidsByCwdPrefix(_io, _paths) {
    return [];
}

// ---------------------------------------------------------------------------
// Shell command fragments
// ---------------------------------------------------------------------------

/**
 * Grace sleep. `timeout /t` refuses redirected input, so the standard trick
 * is pinging loopback N+1 times (≈ N seconds).
 */
function sleepCommand(seconds) {
    const n = Math.max(1, Math.ceil(seconds));
    return { cmd: 'ping', args: ['-n', String(n + 1), '127.0.0.1'] };
}

/** Kill a pid: taskkill /PID (graceful-then-force is handled by the engine). */
function killCommand(pid) {
    return { cmd: 'taskkill', args: ['/PID', String(pid)] };
}

/**
 * Daemon liveness check. Linux greps `ps -o args=` for the marker; on
 * Windows the pid marker + tasklist is the check (see checkDaemonAlive).
 */
function psCheckCommand(_pid) {
    return { cmd: 'tasklist', args: ['/FO', 'CSV', '/NH', '/FI', 'PID eq 0'] }; // unused
}

/** Alive check used by the engine after spawning the daemon. */
function checkDaemonAlive(io, { pid, workerDir }) {
    if (!pidAlive(io, pid)) return false;
    const marker = readPidMarker(io, workerDir);
    return !!marker && marker.pid === pid;
}

// ---------------------------------------------------------------------------
// Host prerequisites / remediation
// ---------------------------------------------------------------------------

/** Windows package remediation hint (winget preferred, choco fallback). */
function hostPackageCommand(pkg) {
    return `winget install --id ${pkg} (or: choco install ${pkg})`;
}

function hostPackagesCommand(pkgs) {
    return `winget install ${pkgs} (or: choco install ${pkgs})`;
}

/**
 * C build-tool prerequisites — on Windows the supported path is the Visual
 * Studio Build Tools. Not yet validated; reported as an explicit limitation
 * instead of probing the Linux package set.
 */
function checkBuildPrerequisites(_io, _opts = {}) {
    return {
        ok: false,
        missing: [],
        remediation: { package: 'Microsoft Visual Studio Build Tools', command: 'winget install Microsoft.VisualStudio.2022.BuildTools' },
        message: 'Windows build-tool detection is not implemented yet (preview platform). '
            + 'Python packages with native extensions require the Visual Studio Build Tools.',
    };
}

// ---------------------------------------------------------------------------
// Management tools (cmd.exe batch wrappers)
// ---------------------------------------------------------------------------

/** Tool script filename: cmd.exe batch extension (.sh → .cmd). */
function toolScriptName(fileName) {
    return String(fileName).replace(/\.sh$/i, '.cmd');
}

function cmdQuote(s) {
    return `"${String(s).replace(/"/g, '')}"`;
}

/** Render one management-tool wrapper (cmd.exe shim around the CLI). */
function renderToolScript({ command, nodePath, cliPath, statePath, root, workerDir }) {
    return [
        '@echo off',
        'rem Animastor management tool — generated by animastor-installer.',
        'rem Do not edit: re-run the installer to refresh (paths are recorded at install time).',
        `${cmdQuote(nodePath)} ${cmdQuote(cliPath)} ${command} --state ${cmdQuote(statePath)} --root ${cmdQuote(root || '')} --worker-dir ${cmdQuote(workerDir || '')} %*`,
    ].join('\r\n') + '\r\n';
}

/** Mode bits for generated tools (ignored on Windows, kept for parity). */
const TOOL_SCRIPT_MODE = 0o755;

// ---------------------------------------------------------------------------
// GPU probing (platform-specific parts)
// ---------------------------------------------------------------------------

/**
 * AMD GPU detection on Windows — sysfs/rocm-smi do not exist. Detection via
 * wmic path win32_VideoController. Preview-grade; never guessed.
 */
function probeAmdGpu(io) {
    const r = io.exec('wmic', ['path', 'win32_VideoController', 'get', 'name', '/format:list']);
    if (!r || r.code !== 0) return null;
    const m = /Name=(.*(Radeon|AMD).*)/i.exec(String(r.stdout));
    if (m && m[1].trim()) {
        return { vendor: 'amd', name: m[1].trim(), vram_mib: null, driver_version: null, detection: 'wmic' };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Ownership guard
// ---------------------------------------------------------------------------

/** POSIX uid guard is not applicable on Windows. */
const UID_GUARD = false;

module.exports = {
    name: NAME,
    displayName: 'Windows (native)',
    productionReady: false, // architectural preview — not production-validated
    previewNotice: 'Windows support is an architectural preview: paths, venv layout and tool wrappers are implemented, process management is not yet production-validated.',

    HOME_ENV,
    UID_GUARD,
    TOOL_SCRIPT_MODE,
    PID_MARKER_FILE,

    defaultRoot,
    defaultWorkerDir,
    venvPythonBin,

    findPidsByCmdlineAndCwd,
    readProcessCwd,
    readProcessCmdline,
    processStartMs,
    workerStartMarkerMs,
    pidUid,
    findComfyUIPids,
    findPidsByCwdPrefix,
    readPidMarker,
    pidAlive,
    checkDaemonAlive,
    onWorkerSpawned,

    sleepCommand,
    killCommand,
    psCheckCommand,

    hostPackageCommand,
    hostPackagesCommand,
    checkBuildPrerequisites,

    toolScriptName,
    renderToolScript,

    probeAmdGpu,
};
