'use strict';

/**
 * Linux platform adapter — Private Worker Installer (cross-platform prep).
 *
 * Extracts every OS-specific behaviour of the installer that is genuinely
 * Linux-specific so the universal engine code can stay platform-neutral:
 *
 *   - process discovery via /proc (cwd-verified, never global pkill);
 *   - process start time / uid from /proc/<pid>;
 *   - venv layout (bin/python);
 *   - Debian/Ubuntu apt remediation commands;
 *   - POSIX shell management-tool wrappers (#!/bin/sh);
 *   - AMD GPU detection via sysfs/rocm-smi/lspci.
 *
 * IMPORTANT CONTRACT: every method takes the `io` abstraction as its first
 * argument (or reads it from the options object) and uses ONLY io.exec /
 * io.fs primitives. This keeps the adapter fully testable with the memory
 * fs + scripted exec mocks, exactly like the engine code it was extracted
 * from — the existing Linux test suite keeps passing unchanged.
 */

const path = require('path');

const NAME = 'linux';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Default ComfyUI root: $HOME/ComfyUI (POSIX home layout). */
function defaultRoot(home) {
    return path.join(home || '/root', 'ComfyUI');
}

/** Default worker bundle dir: $HOME/animastor/worker. */
function defaultWorkerDir(home) {
    return path.join(home || '/root', 'animastor', 'worker');
}

/** Home directory env var name on this platform. */
const HOME_ENV = 'HOME';

/** Python interpreter inside a venv (POSIX layout). */
function venvPythonBin(venvDir) {
    return path.join(venvDir, 'bin', 'python');
}

// ---------------------------------------------------------------------------
// Process management (procfs-backed)
// ---------------------------------------------------------------------------

/**
 * PIDs of processes whose command line matches `cmdPattern` AND whose cwd
 * equals `cwd`. `pgrep -f` matches host-wide, so every candidate is confirmed
 * via /proc/<pid>/cwd — a foreign installation is never touched.
 * @returns {number[]} matching pids
 */
function findPidsByCmdlineAndCwd(io, { cmdPattern, cwd }) {
    const out = [];
    const r = io.exec('pgrep', ['-f', cmdPattern]);
    if (!r || r.code !== 0 || !r.stdout) return out;
    for (const line of String(r.stdout).split('\n')) {
        const pid = Number(line.trim());
        if (!Number.isFinite(pid) || pid <= 0) continue;
        const cwdRes = io.exec('readlink', [`/proc/${pid}/cwd`]);
        if (cwdRes && cwdRes.code === 0
            && path.resolve(String(cwdRes.stdout).trim()) === path.resolve(cwd)) {
            out.push(pid);
        }
    }
    return out;
}

/** cwd of a pid (readlink /proc/<pid>/cwd) or null. */
function readProcessCwd(io, pid) {
    const r = io.exec('readlink', [`/proc/${pid}/cwd`]);
    return r && r.code === 0 ? String(r.stdout).trim() : null;
}

/** Command line argv of a pid (/proc/<pid>/cmdline, NUL-separated) or null. */
function readProcessCmdline(io, pid) {
    try {
        return io.fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch (_) {
        return null;
    }
}

/** Process start time in ms (/proc/<pid> mtime is the Linux start time). */
function processStartMs(io, pid) {
    try {
        return io.fs.statSync(`/proc/${pid}`).mtimeMs;
    } catch (_) {
        return null;
    }
}

/** Uid owning a process (/proc/<pid> stat) or null when unavailable. */
function pidUid(io, pid) {
    try {
        const st = io.fs.statSync(`/proc/${pid}`);
        return typeof st.uid === 'number' ? st.uid : null;
    } catch (_) {
        return null;
    }
}

/**
 * PIDs of ComfyUI processes running from `root` (cwd check via /proc), by
 * default on `port`. The cwd check means the installer only ever touches an
 * instance it manages — a foreign ComfyUI (different root) is never signaled.
 */
function findComfyUIPids(io, { root, port = null }) {
    const out = [];
    let dirs = [];
    try { dirs = io.fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch (_) { return out; }
    for (const dir of dirs) {
        const pid = Number(dir);
        if (!Number.isFinite(pid) || pid === process.pid) continue;
        const parts = readProcessCmdline(io, pid);
        if (!parts || !parts.some((a) => a === 'main.py' || a.endsWith('/main.py'))) continue;
        if (port != null) {
            const portIdx = parts.indexOf('--port');
            const procPort = portIdx !== -1 ? Number(parts[portIdx + 1]) : 8188;
            if (procPort !== Number(port)) continue;
        }
        try {
            if (io.fs.readlinkSync(`/proc/${pid}/cwd`) !== root) continue;
        } catch (_) { continue; } // foreign process or already gone
        out.push(pid);
    }
    return out;
}

/**
 * Scan /proc for processes whose cwd is inside any of `paths` (prefix match).
 * Used by the uninstaller to find components of THIS installation.
 * Implemented as a single sh -c loop (the historical implementation) so the
 * mocked-exec tests keep working.
 */
function findPidsByCwdPrefix(io, paths) {
    const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const script = 'for p in /proc/[0-9]*; do '
        + 'cwd=$(readlink "$p/cwd" 2>/dev/null) || continue; '
        + `case "$cwd" in ${paths.map((p) => `${shQuote(p)}*`).join('| ')}) echo "\${p#/proc/}";; esac; done`;
    const r = io.exec('sh', ['-c', script]);
    if (!r || r.code !== 0 || !r.stdout) return [];
    return String(r.stdout).split('\n').map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

// ---------------------------------------------------------------------------
// Shell command fragments (start/grace/alive/kill)
// ---------------------------------------------------------------------------

/** Grace sleep: POSIX sleep(1). Returns { cmd, args } for io.exec. */
function sleepCommand(seconds) {
    return { cmd: 'sleep', args: [String(Math.max(1, Math.ceil(seconds)))] };
}

/** Kill a pid: POSIX kill(1). */
function killCommand(pid) {
    return { cmd: 'kill', args: [String(pid)] };
}

/** Liveness check returning the process args (worker.cjs marker match). */
function psCheckCommand(pid) {
    return { cmd: 'ps', args: ['-p', String(pid), '-o', 'args='] };
}

// ---------------------------------------------------------------------------
// Host prerequisites / remediation
// ---------------------------------------------------------------------------

/** Debian/Ubuntu apt remediation for a host package. */
function hostPackageCommand(pkg) {
    return `sudo apt install ${pkg}`;
}

/** Debian/Ubuntu apt remediation for several host packages. */
function hostPackagesCommand(pkgs) {
    return `sudo apt-get install -y ${pkgs}`;
}

/**
 * C build-tool prerequisites (native Python extensions). Debian/Ubuntu
 * package names — a Linux-specific concern, so it lives in this adapter.
 */
function checkBuildPrerequisites(io, { python = 'python3', log = null } = {}) {
    const missing = [];
    const versionRes = io.exec(python, ['--version']);
    const vMatch = /Python\s+([0-9][0-9.]*)/.exec(String(versionRes.stdout) + String(versionRes.stderr));
    const pyVer = vMatch ? vMatch[1] : null;
    const pyMajor = pyVer ? pyVer.split('.').slice(0, 2).join('.') : null;

    const gcc = io.exec('gcc', ['--version']);
    if (gcc.code !== 0) missing.push({ pkg: 'build-essential', check: 'gcc --version' });

    const devPkg = pyMajor ? `python${pyMajor}-dev` : 'python3-dev';
    const devCheck = io.exec(python, ['-c', 'import sysconfig; print(sysconfig.get_path("include"))']);
    if (devCheck.code !== 0 || !String(devCheck.stdout).trim()) {
        missing.push({ pkg: devPkg, check: `${python} -c "import sysconfig; print(sysconfig.get_path('include'))"` });
    }

    const sndfile = io.exec('pkg-config', ['--exists', 'sndfile']);
    if (sndfile.code !== 0) missing.push({ pkg: 'libsndfile1-dev', check: 'pkg-config --exists sndfile' });

    if (missing.length === 0) return { ok: true, missing: [] };

    const pkgList = missing.map((m) => m.pkg).join(' ');
    const cmd = hostPackagesCommand(pkgList);
    const msg = `Missing C build tools required by Python packages with native extensions: ${missing.map((m) => m.pkg).join(', ')}. `
        + `Run: ${cmd}`;
    if (log) log.warn(msg);
    return { ok: false, missing, remediation: { package: pkgList, command: cmd }, message: msg };
}

// ---------------------------------------------------------------------------
// Management tools (POSIX shell wrappers)
// ---------------------------------------------------------------------------

/**
 * Tool script filename: identity on Linux — the canonical names are the
 * historical POSIX shell names (status.sh, reboot-worker.sh, …).
 */
function toolScriptName(fileName) {
    return fileName;
}

function shQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Render one management-tool wrapper (#!/bin/sh shim around the CLI). */
function renderToolScript({ command, nodePath, cliPath, statePath, root, workerDir }) {
    return [
        '#!/bin/sh',
        '# Animastor management tool — generated by animastor-installer.',
        '# Do not edit: re-run the installer to refresh (paths are recorded at install time).',
        `exec ${shQuote(nodePath)} ${shQuote(cliPath)} ${command} \\`,
        `  --state ${shQuote(statePath)} \\`,
        `  --root ${shQuote(root || '')} \\`,
        `  --worker-dir ${shQuote(workerDir || '')} "$@"`,
        '',
    ].join('\n');
}

/** Mode bits applied to generated tool scripts. */
const TOOL_SCRIPT_MODE = 0o755;

// ---------------------------------------------------------------------------
// GPU probing (platform-specific parts)
// ---------------------------------------------------------------------------

/**
 * AMD GPU detection with positive evidence only (Linux paths):
 *   1. rocm-smi runtime (Card series: …), or
 *   2. kernel drm sysfs vendor 0x1002 (amdgpu), name via lspci when available.
 * Empty/unknown output is treated as "not detected" — never guessed.
 */
function probeAmdGpu(io) {
    const rocm = io.exec('rocm-smi', ['--showproductname']);
    if (rocm.code === 0) {
        const m = /Card series:\s*(.+)/.exec(rocm.stdout);
        if (m && m[1].trim()) {
            return { vendor: 'amd', name: m[1].trim(), vram_mib: null, driver_version: null, detection: 'rocm-smi' };
        }
    }
    try {
        const drm = '/sys/class/drm';
        if (io.fs.isDirectory(drm)) {
            for (const entry of io.fs.readdirSync(drm)) {
                if (!/^card\d+$/.test(entry)) continue;
                const vendorPath = `${drm}/${entry}/device/vendor`;
                if (!io.fs.existsSync(vendorPath)) continue;
                const vendor = String(io.fs.readFileSync(vendorPath, 'utf8')).trim().toLowerCase();
                if (vendor !== '0x1002') continue;
                let name = null;
                const productPath = `${drm}/${entry}/device/product_name`;
                if (io.fs.existsSync(productPath)) {
                    name = String(io.fs.readFileSync(productPath, 'utf8')).trim() || null;
                }
                if (!name) {
                    const lspci = io.exec('lspci', []);
                    if (lspci.code === 0) {
                        const m = /VGA compatible controller[^\n]*\[AMD\/ATI\][^\n]*/.exec(lspci.stdout)
                            || /Display controller[^\n]*\[AMD\/ATI\][^\n]*/.exec(lspci.stdout);
                        if (m) {
                            const chip = m[0].split(':').slice(2).join(':').trim();
                            if (chip) name = chip;
                        }
                    }
                }
                return { vendor: 'amd', name: name || 'AMD GPU', vram_mib: null, driver_version: null, detection: 'sysfs-vendor' };
            }
        }
    } catch (_) { /* sysfs unavailable — not detected */ }
    return null;
}

// ---------------------------------------------------------------------------
// Ownership guard
// ---------------------------------------------------------------------------

/** Uid guard is meaningful on Linux (shared hosts, sudo mixing). */
const UID_GUARD = true;

module.exports = {
    name: NAME,
    displayName: 'Linux (native)',
    productionReady: true,

    HOME_ENV,
    UID_GUARD,
    TOOL_SCRIPT_MODE,

    defaultRoot,
    defaultWorkerDir,
    venvPythonBin,

    findPidsByCmdlineAndCwd,
    readProcessCwd,
    readProcessCmdline,
    processStartMs,
    pidUid,
    findComfyUIPids,
    findPidsByCwdPrefix,

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
