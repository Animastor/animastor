'use strict';

/**
 * Platform abstraction tests — cross-platform installer architecture.
 *
 * Contracts verified here:
 *   1. Platform is auto-detected (process.platform), never a CLI flag;
 *   2. Deployment is a SEPARATE dimension (docker ≠ OS platform);
 *   3. Adapter selection is lazy: the windows adapter is selected without
 *      loading Linux-only code (and vice versa) — checked in isolated
 *      child processes with empty require caches;
 *   4. An unsupported platform produces a clear, early error;
 *   5. Paths, venv layouts, tool script names and shell commands are
 *      platform-specific;
 *   6. The Windows worker flow works against mocks (pid marker + tasklist);
 *   7. The hub serves a PowerShell bootstrap for Windows without breaking
 *      the bash launcher for Linux.
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const platforms = require('../src/installer/platform');
const workerMod = require('../src/installer/engine/worker');
const { createMemoryFs } = require('../src/installer/engine/io');

const REPO_ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Mock io helper (memory fs + scripted exec)
// ---------------------------------------------------------------------------

function makeIo({ files = {}, exec: execImpl = null, spawnDaemon = null } = {}) {
    const ioFs = createMemoryFs(files);
    return {
        fs: ioFs,
        exec(cmd, args = []) {
            if (execImpl) return execImpl(cmd, args);
            return { code: 0, stdout: '', stderr: '' };
        },
        spawnDaemon: spawnDaemon || (() => 1),
        now: () => 1700000000000,
    };
}

// ---------------------------------------------------------------------------
// 1. Platform detection
// ---------------------------------------------------------------------------

describe('platform detection', () => {
    it('detects linux from process.platform', () => {
        assert.strictEqual(platforms.detectPlatform('linux'), 'linux');
    });

    it('detects windows from win32', () => {
        assert.strictEqual(platforms.detectPlatform('win32'), 'windows');
    });

    it('returns null for unsupported platforms (darwin, freebsd)', () => {
        assert.strictEqual(platforms.detectPlatform('darwin'), null);
        assert.strictEqual(platforms.detectPlatform('freebsd'), null);
    });

    it('auto-detects the real host platform', () => {
        const expected = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : null;
        assert.strictEqual(platforms.detectPlatform(), expected);
    });

    it('platform is NOT a CLI flag concept: deployment env vars cannot change it', () => {
        // ANIMASTOR_DEPLOYMENT only selects the deployment, never the platform
        const dep = platforms.detectDeployment({ platform: 'linux', env: { ANIMASTOR_DEPLOYMENT: 'docker' } });
        assert.strictEqual(dep, 'docker');
        assert.strictEqual(platforms.detectPlatform('linux'), 'linux');
    });
});

// ---------------------------------------------------------------------------
// 2. Adapter selection + interface completeness
// ---------------------------------------------------------------------------

describe('platform adapter selection', () => {
    it('selects the linux adapter with the full adapter interface', () => {
        const a = platforms.getPlatformAdapter('linux');
        assert.strictEqual(a.name, 'linux');
        assert.strictEqual(a.productionReady, true);
        for (const key of platforms.ADAPTER_INTERFACE) {
            assert.notStrictEqual(a[key], undefined, `linux adapter implements ${key}`);
        }
    });

    it('selects the windows adapter with the full adapter interface', () => {
        const a = platforms.getPlatformAdapter('windows');
        assert.strictEqual(a.name, 'windows');
        assert.strictEqual(a.productionReady, false, 'windows is an explicit preview');
        assert.ok(typeof a.previewNotice === 'string' && a.previewNotice.length > 0);
        for (const key of platforms.ADAPTER_INTERFACE) {
            assert.notStrictEqual(a[key], undefined, `windows adapter implements ${key}`);
        }
    });

    it('unsupported platform produces a clear error BEFORE any side effect', () => {
        assert.throws(
            () => platforms.getPlatformAdapter('darwin'),
            (err) => err.code === 'unsupported_platform'
                && /darwin/.test(err.message)
                && /linux/.test(err.message)
                && /windows/.test(err.message),
        );
        assert.throws(
            () => platforms.resolveRuntime({ platform: 'freebsd' }),
            (err) => err.code === 'unsupported_platform',
        );
    });

    it('windows adapter is selected WITHOUT loading Linux-only code (isolated process)', () => {
        const script = `
            const platforms = require('${path.join(REPO_ROOT, 'backend/src/installer/platform')}');
            const a = platforms.getPlatformAdapter('windows');
            const loaded = Object.keys(require.cache).filter((k) => /platform[\\\\/]linux\\.js$/.test(k));
            if (loaded.length > 0) { console.error('LINUX MODULE LOADED: ' + loaded.join(',')); process.exit(1); }
            if (a.name !== 'windows') { process.exit(2); }
            console.log('OK');
        `;
        const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
        assert.ok(out.includes('OK'));
    });

    it('linux adapter is selected WITHOUT loading Windows-only code (isolated process)', () => {
        const script = `
            const platforms = require('${path.join(REPO_ROOT, 'backend/src/installer/platform')}');
            const a = platforms.getPlatformAdapter('linux');
            const loaded = Object.keys(require.cache).filter((k) => /platform[\\\\/]windows\\.js$/.test(k));
            if (loaded.length > 0) { console.error('WINDOWS MODULE LOADED: ' + loaded.join(',')); process.exit(1); }
            if (a.name !== 'linux') { process.exit(2); }
            console.log('OK');
        `;
        const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
        assert.ok(out.includes('OK'));
    });
});

// ---------------------------------------------------------------------------
// 3. Deployment dimension (docker ≠ OS)
// ---------------------------------------------------------------------------

describe('deployment dimension', () => {
    it('docker is detected from container markers while the platform stays linux', () => {
        const dep = platforms.detectDeployment({ platform: 'linux', fsExists: (p) => p === '/.dockerenv' });
        assert.strictEqual(dep, 'docker');
        // docker is NOT a platform:
        assert.strictEqual(platforms.detectPlatform('linux'), 'linux');
        assert.strictEqual(platforms.PLATFORMS.includes('docker'), false);
    });

    it('ANIMASTOR_DEPLOYMENT env overrides detection (deployment is env-selectable, platform is not)', () => {
        assert.strictEqual(platforms.detectDeployment({ platform: 'linux', env: { ANIMASTOR_DEPLOYMENT: 'docker' } }), 'docker');
        assert.strictEqual(platforms.detectDeployment({ platform: 'linux', env: { ANIMASTOR_DEPLOYMENT: 'native' } }), 'native');
    });

    it('default deployment is native', () => {
        assert.strictEqual(platforms.detectDeployment({ platform: 'linux', fsExists: () => false, env: {} }), 'native');
        assert.strictEqual(platforms.detectDeployment({ platform: 'windows', fsExists: () => true, env: {} }), 'native',
            'dockerenv marker on a windows host is meaningless — windows containers are not a target');
    });

    it('docker deployment adapter is selected on linux and is explicitly NOT production-supported', () => {
        const d = platforms.getDeploymentAdapter('docker', { platform: 'linux' });
        assert.strictEqual(d.name, 'docker');
        assert.strictEqual(d.productionReady, false, 'docker must not be declared production-supported until VPS-validated');
        assert.ok(d.paths && d.volumeMap && d.gpuRuntime.flag, 'docker architecture touchpoints exist');
    });

    it('docker deployment on windows is rejected', () => {
        assert.throws(
            () => platforms.getDeploymentAdapter('docker', { platform: 'windows' }),
            /docker deployment requires the linux platform/,
        );
    });

    it('resolveRuntime composes platform + deployment and reports support honestly', () => {
        const linuxNative = platforms.resolveRuntime({ platform: 'linux', deployment: 'native' });
        assert.strictEqual(linuxNative.productionReady, true);
        assert.strictEqual(linuxNative.platform, 'linux');
        assert.strictEqual(linuxNative.deployment, 'native');

        const linuxDocker = platforms.resolveRuntime({ platform: 'linux', deployment: 'docker' });
        assert.strictEqual(linuxDocker.productionReady, false, 'docker deployment is not production-ready');

        const winNative = platforms.resolveRuntime({ platform: 'windows', deployment: 'native' });
        assert.strictEqual(winNative.productionReady, false, 'windows is a preview');
    });
});

// ---------------------------------------------------------------------------
// 4. Platform-specific paths, layouts, scripts
// ---------------------------------------------------------------------------

describe('platform-specific paths and scripts', () => {
    const linux = platforms.getPlatformAdapter('linux');
    const windows = platforms.getPlatformAdapter('windows');

    it('default roots are platform-specific', () => {
        assert.strictEqual(linux.defaultRoot('/home/u'), '/home/u/ComfyUI');
        assert.strictEqual(windows.defaultRoot('C:\\Users\\u'), 'C:\\Users\\u\\ComfyUI');
        assert.strictEqual(linux.defaultWorkerDir('/home/u'), '/home/u/animastor/worker');
        assert.strictEqual(windows.defaultWorkerDir('C:\\Users\\u'), 'C:\\Users\\u\\animastor\\worker');
    });

    it('home env variable differs', () => {
        assert.strictEqual(linux.HOME_ENV, 'HOME');
        assert.strictEqual(windows.HOME_ENV, 'USERPROFILE');
    });

    it('venv layouts are platform-specific', () => {
        assert.strictEqual(linux.venvPythonBin('/r/venv'), path.join('/r/venv', 'bin', 'python'));
        assert.strictEqual(windows.venvPythonBin('C:\\r\\venv'), 'C:\\r\\venv\\Scripts\\python.exe');
    });

    it('tool script names are platform-specific (.sh vs .cmd)', () => {
        assert.strictEqual(linux.toolScriptName('status.sh'), 'status.sh');
        assert.strictEqual(windows.toolScriptName('status.sh'), 'status.cmd');
    });

    it('tool script content is platform-specific (sh shim vs cmd shim)', () => {
        const args = {
            command: 'status', nodePath: '/usr/bin/node', cliPath: '/cli.js',
            statePath: '/s.json', root: '/r', workerDir: '/w',
        };
        const sh = linux.renderToolScript(args);
        assert.ok(sh.startsWith('#!/bin/sh'));
        assert.ok(sh.includes('"$@"'));
        const cmd = windows.renderToolScript({ ...args, nodePath: 'C:\\node.exe', cliPath: 'C:\\cli.js' });
        assert.ok(cmd.startsWith('@echo off'));
        assert.ok(cmd.includes('%*'));
    });

    it('shell/process commands are platform-specific', () => {
        assert.deepStrictEqual(linux.sleepCommand(2), { cmd: 'sleep', args: ['2'] });
        assert.strictEqual(windows.sleepCommand(2).cmd, 'ping', 'timeout.exe refuses redirected input — ping is the portable sleep');
        assert.deepStrictEqual(linux.killCommand(42), { cmd: 'kill', args: ['42'] });
        assert.strictEqual(windows.killCommand(42).cmd, 'taskkill');
        assert.deepStrictEqual(linux.psCheckCommand(42), { cmd: 'ps', args: ['-p', '42', '-o', 'args='] });
    });

    it('host package remediation is platform-specific', () => {
        assert.match(linux.hostPackageCommand('python3'), /^sudo apt install python3$/);
        assert.match(windows.hostPackageCommand('Python.Python.3'), /winget/);
    });
});

// ---------------------------------------------------------------------------
// 5. Windows worker flow (mocked: pid marker + tasklist)
// ---------------------------------------------------------------------------

describe('windows worker flow (mocked platform commands)', () => {
    function windowsIo({ files = {}, alivePids = [], commandLines = {}, daemonPid = 1 } = {}) {
        const wadapter = platforms.getPlatformAdapter('windows');
        return makeIo({
            files,
            spawnDaemon: () => daemonPid,
            exec: (cmd, args) => {
                if (cmd === 'tasklist') {
                    // tasklist /FO CSV /NH /FI "PID eq N" → filter is args[4]
                    const m = /PID eq (\d+)/.exec(args[4] || '');
                    const pid = m ? Number(m[1]) : 0;
                    const alive = alivePids.includes(pid);
                    return { code: 0, stdout: alive ? `"node.exe","${pid}"` : 'INFO: No tasks are running', stderr: '' };
                }
                if (cmd === 'powershell') {
                    const script = args[args.length - 1];
                    const m = /ProcessId=(\d+)/.exec(script);
                    const pid = m ? Number(m[1]) : null;
                    return { code: pid != null && commandLines[pid] ? 0 : 1, stdout: commandLines[pid] || '', stderr: '' };
                }
                return { code: 0, stdout: '', stderr: '' };
            },
        });
    }

    it('startWorker (windows adapter) writes the managed pid marker and reports alive', () => {
        const io = windowsIo({
            files: {
                'C:\\wdir\\worker.cjs': '// worker',
                'C:\\wdir\\package.json': '{}',
            },
            alivePids: [777],
            commandLines: { 777: '"C:\\node.exe" worker.cjs' },
            daemonPid: 777,
        });
        const wadapter = platforms.getPlatformAdapter('windows');
        // the syntax/deps checks run node via io.exec — make them pass
        const origExec = io.exec;
        io.exec = (cmd, args) => {
            if (cmd === 'node') return { code: 0, stdout: 'C:\\wdir', stderr: '' };
            return origExec(cmd, args);
        };
        const res = workerMod.startWorker(io, {
            workerDir: 'C:\\wdir',
            platformAdapter: wadapter,
            logFile: 'C:\\wdir\\worker-installer.log',
        });
        assert.strictEqual(res.started, true, `started: ${res.reason || ''}`);
        assert.strictEqual(res.alive, true);
        const marker = wadapter.readPidMarker(io, 'C:\\wdir');
        assert.ok(marker && marker.pid === res.pid, 'pid marker written at spawn');
    });

    it('findRunningWorkerPid (windows) finds only THIS dir\'s marked worker', () => {
        const wadapter = platforms.getPlatformAdapter('windows');
        const files = {
            'C:\\mine\\worker.cjs': '// worker',
        };
        const io = windowsIo({
            files,
            alivePids: [500, 600],
            commandLines: { 500: 'node worker.cjs', 600: 'node worker.cjs' },
        });
        // our marker says pid 500
        io.fs.writeFileSync('C:\\mine\\worker.pid', JSON.stringify({ pid: 500, started_at: 1 }));
        assert.strictEqual(workerMod.findRunningWorkerPid(io, 'C:\\mine', { platformAdapter: wadapter }), 500);
        // a foreign dir has NO marker → never discovered
        assert.strictEqual(workerMod.findRunningWorkerPid(io, 'C:\\foreign', { platformAdapter: wadapter }), null);
        // a marker pointing to a DEAD pid → not discovered
        io.fs.writeFileSync('C:\\mine\\worker.pid', JSON.stringify({ pid: 999, started_at: 1 }));
        assert.strictEqual(workerMod.findRunningWorkerPid(io, 'C:\\mine', { platformAdapter: wadapter }), null);
        // a marker whose process is alive but NOT a worker.cjs → not discovered
        io.fs.writeFileSync('C:\\mine\\worker.pid', JSON.stringify({ pid: 600, started_at: 1 }));
        io2line(io, 600, 'node other.cjs');
        assert.strictEqual(workerMod.findRunningWorkerPid(io, 'C:\\mine', { platformAdapter: wadapter }), null);
    });

    function io2line(io, pid, line) {
        const orig = io.exec;
        io.exec = (cmd, args) => {
            if (cmd === 'powershell') {
                const m = /ProcessId=(\d+)/.exec(args[args.length - 1]);
                if (m && Number(m[1]) === pid) return { code: 0, stdout: line, stderr: '' };
            }
            return orig(cmd, args);
        };
    }

    it('workerEnvIsNewer (windows) falls back to the pid marker when /proc is absent', () => {
        const wadapter = platforms.getPlatformAdapter('windows');
        const files = { 'C:\\w\\.env': 'A=1\\n' };
        const io = windowsIo({ files });
        // the memory fs has no mtimes — provide the .env mtime explicitly
        // (path.join on POSIX produces mixed separators — normalize first)
        const baseStat = io.fs.statSync.bind(io.fs);
        io.fs.statSync = (p) => (String(p).replace(/\\/g, '/') === 'C:/w/.env'
            ? { mtimeMs: 1700000000000, isFile: true }
            : baseStat(p));
        // marker started BEFORE .env was modified → stale worker
        io.fs.writeFileSync('C:\\w\\worker.pid', JSON.stringify({ pid: 5, started_at: 1700000000000 - 60000 }));
        assert.strictEqual(workerMod.workerEnvIsNewer(io, { workerDir: 'C:\\w', pid: 5, platformAdapter: wadapter }), true,
            '.env modified after the marker time → stale worker');
        io.fs.writeFileSync('C:\\w\\worker.pid', JSON.stringify({ pid: 5, started_at: 1700000000000 + 60000 }));
        assert.strictEqual(workerMod.workerEnvIsNewer(io, { workerDir: 'C:\\w', pid: 5, platformAdapter: wadapter }), false);
    });
});

// ---------------------------------------------------------------------------
// 6. Bootstrap platform selection (bash vs PowerShell launcher)
// ---------------------------------------------------------------------------

describe('bootstrap platform selection', () => {
    const { buildBootstrapScript, buildWindowsBootstrapScript } = require('../../gpu-hub/bootstrap');

    it('the bash launcher keeps its credential rejection and checksum gates', () => {
        const s = buildBootstrapScript({ hubUrl: 'https://hub.example/gpu', profile: 'image/qwen-image', mode: 'managed' });
        assert.ok(s.startsWith('#!/usr/bin/env bash'));
        assert.ok(s.includes('ANIMASTOR_WORKER_TOKEN'), 'fail-closed credential env rejection');
        assert.ok(s.includes('/installer/sha256'), 'bundle checksum gate');
        assert.ok(s.includes('SHASUMS256.txt'), 'pinned node runtime verified against nodejs.org checksums');
        // credential material itself never appears (the 'wrk.' pattern in the
        // rejection loop is the guard, not a credential)
        assert.ok(!s.includes('Bearer wrk'), 'no credential material');
        assert.ok(!/--worker-key=/.test(s), 'no credential flag with a value');
    });

    it('a PowerShell launcher exists for windows with the SAME security gates', () => {
        const s = buildWindowsBootstrapScript({ hubUrl: 'https://hub.example/gpu', profile: 'image/qwen-image', mode: 'managed' });
        assert.ok(s.includes('$ErrorActionPreference'), 'is PowerShell');
        assert.ok(s.includes('ANIMASTOR_WORKER_TOKEN'), 'fail-closed credential env rejection');
        assert.ok(s.includes('Get-FileHash'), 'SHA-256 verification (bundle + node runtime)');
        assert.ok(s.includes('SHASUMS256.txt'), 'pinned node runtime verified against nodejs.org checksums');
        assert.ok(s.includes('/installer/sha256'), 'bundle checksum gate');
        assert.ok(!s.includes('wrk.'), 'no credential material');
    });

    it('node auto-provision is a fallback, not a replacement: a healthy system node is used as-is', () => {
        const s = buildBootstrapScript({ hubUrl: 'https://hub.example/gpu', profile: 'image/qwen-image', mode: 'managed' });
        const sysIdx = s.indexOf('for candidate in node node20 node22');
        const provIdx = s.indexOf('provisioning the pinned runtime');
        assert.ok(sysIdx !== -1 && provIdx !== -1 && sysIdx < provIdx, 'system node checked before provisioning');
    });

    it('both launchers are deterministic for identical inputs', () => {
        const a1 = buildBootstrapScript({ hubUrl: 'https://h/gpu', profile: 'p', mode: 'managed' });
        const a2 = buildBootstrapScript({ hubUrl: 'https://h/gpu', profile: 'p', mode: 'managed' });
        assert.strictEqual(a1, a2);
        const w1 = buildWindowsBootstrapScript({ hubUrl: 'https://h/gpu', profile: 'p', mode: 'managed' });
        const w2 = buildWindowsBootstrapScript({ hubUrl: 'https://h/gpu', profile: 'p', mode: 'managed' });
        assert.strictEqual(w1, w2);
    });
});

// ---------------------------------------------------------------------------
// 7. Hub serves the platform-appropriate launcher
// ---------------------------------------------------------------------------

describe('hub GET /installer platform selection', () => {
    const { createMockRedis } = require('./mocks/redis-mock');
    const { buildHubApp } = require('../../gpu-hub/gpu-hub');

    async function startHub() {
        const stubSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-hub-'));
        fs.writeFileSync(path.join(stubSrc, 'cli.js'), 'process.exit(0);\n');
        fs.writeFileSync(path.join(stubSrc, 'package.json'), JSON.stringify({ name: 'animastor-installer', version: '9.9.9' }));
        const app = buildHubApp({
            redis: createMockRedis(),
            config: {
                INSTALLER_SRC_DIR: stubSrc,
                WORKER_BUNDLE_DIR: path.join(REPO_ROOT, 'worker', 'worker'),
                WORKFLOW_DIR: path.join(REPO_ROOT, 'backend', 'ai', 'workflows'),
                INSTALLER_MANIFESTS_DIR: path.join(REPO_ROOT, 'backend', 'ai', 'install-manifests'),
            },
            fetchImpl: async () => ({ ok: true, status: 200 }),
            intervals: false,
        });
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        return { server, base: `http://127.0.0.1:${server.address().port}`, stubSrc };
    }

    it('?platform=windows serves the PowerShell launcher', async () => {
        const hub = await startHub();
        try {
            const res = await fetch(`${hub.base}/installer?platform=windows`);
            const body = await res.text();
            assert.strictEqual(res.status, 200);
            assert.ok(res.headers.get('content-disposition').includes('animastor-installer.ps1'));
            assert.ok(body.includes('$ErrorActionPreference'));
        } finally {
            await new Promise((r) => hub.server.close(r));
            fs.rmSync(hub.stubSrc, { recursive: true, force: true });
        }
    });

    it('a windows User-Agent gets the PowerShell launcher automatically; linux default unchanged', async () => {
        const hub = await startHub();
        try {
            const win = await fetch(`${hub.base}/installer`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
            const winBody = await win.text();
            assert.ok(win.headers.get('content-disposition').includes('.ps1'));
            assert.ok(winBody.includes('$ErrorActionPreference'));

            const lnx = await fetch(`${hub.base}/installer`, { headers: { 'User-Agent': 'curl/8.5.0' } });
            const lnxBody = await lnx.text();
            assert.ok(lnx.headers.get('content-disposition').includes('.sh'));
            assert.ok(lnxBody.startsWith('#!/usr/bin/env bash'));
        } finally {
            await new Promise((r) => hub.server.close(r));
            fs.rmSync(hub.stubSrc, { recursive: true, force: true });
        }
    });

    it('unknown platform param → 400 (fail closed)', async () => {
        const hub = await startHub();
        try {
            const res = await fetch(`${hub.base}/installer?platform=macos`);
            assert.strictEqual(res.status, 400);
            const j = await res.json();
            assert.strictEqual(j.error, 'invalid_platform');
        } finally {
            await new Promise((r) => hub.server.close(r));
            fs.rmSync(hub.stubSrc, { recursive: true, force: true });
        }
    });
});
