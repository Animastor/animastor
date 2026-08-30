'use strict';

/**
 * Management Tools tests — the CLI tools installed next to the worker
 * (tools/status.sh, tools/reboot-worker.sh, tools/reboot-comfyui.sh,
 * tools/comfyui-monitor.sh) and their shared runtime logic
 * (src/installer/management.js).
 *
 *  MT1  managed ComfyUI discovery (cwd + port) via the ENGINE primitives
 *  MT2  foreign ComfyUI / foreign worker are never matched or signaled
 *  MT3  status: healthy snapshot → exit 0, exact block rendering
 *  MT4  status: stopped/degraded → exit 1; API unreachable → Queue "—"
 *  MT5  reboot-worker: stopped → start (no kills, spawnDaemon used)
 *  MT6  reboot-worker: running → restart; ONLY the managed pid is killed
 *  MT7  reboot-worker: foreign-uid process is refused (shared host)
 *  MT8  reboot-comfyui: running → restart via restartManagedComfyUI (+API wait)
 *  MT9  reboot-comfyui: stopped → start via startComfyUI + waitForApi
 *  MT10 restartManagedComfyUI allowedUids filter (foreign uid not touched)
 *  MT11 monitor: empty queue → "Status: empty", exit 0
 *  MT12 monitor: running + pending queue, workflow type guesses
 *  MT13 monitor: API unavailable → renders, no crash, api.ok=false
 *  MT14 monitor: history errors → compact "Recent errors" block
 *  MT15 monitor: partial endpoint failures degrade gracefully (no crash)
 *  MT16 tools install: 4 executable wrappers, correct commands
 *  MT17 tools reinstall: idempotent overwrite, no duplicates
 *  MT18 tool wrapper quoting (paths with quotes)
 *  MT19 uninstall integration: installed tools are registered + removable
 *  MT20 ownership guard: sudo run against user-owned install is blocked
 *  MT21 decision logic: flags > prior decision > prompt/default
 *  MT22 engine persists the install_management_tools decision (resume)
 *  MT23 CLI subprocess: non-TTY output without ANSI, correct exit codes
 */

const assert = require('assert');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const management = require('../src/installer/management');
const comfyui = require('../src/installer/engine/comfyui');
const workerMod = require('../src/installer/engine/worker');
const engine = require('../src/installer/engine/engine');
const uninstaller = require('../src/installer/uninstaller');
const { parseArgs, resolveToolsDecision, resolveToolsDir } = require('../src/installer/cli');

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Mock io — memory fs + fake /proc + canned ComfyUI API
// ---------------------------------------------------------------------------

// The mock /proc uids must align with the REAL runner uid: the restart guards
// compare the process owner against the current account.
const MY_UID = typeof process.getuid === 'function' ? process.getuid() : 1000;
const FOREIGN_UID = MY_UID + 234;

const STATE = {
    state_version: 1,
    mode: 'managed',
    profiles: ['image/qwen-image'],
    root: '/home/u/ComfyUI',
    device: 'cpu',
    owner_uid: MY_UID,
    comfyui_runtime: { port: 8288, pid: 424242, started_at: 0 },
    components: { comfyui: null, venv: null, worker: { owned: true, dir: '/home/u/animastor/worker', files_installed: [], files_kept: [], env_created: true }, custom_nodes: [], models: [], workflows: [], services: [] },
    artifacts: {},
};

const DEFAULT_FILES = {
    '/home/u/ComfyUI': null, // directory marker
    '/home/u/ComfyUI/main.py': '# comfy',
    '/home/u/ComfyUI/venv/bin/python': '# py',
    '/home/u/animastor/worker': null, // directory marker
    '/home/u/animastor/worker/worker.cjs': '// worker',
};

function makeMockIo({
    files = {},
    procs = {},          // pid → { cwd, cmdline: string[], uid }
    http = {},           // path → { status, json } | 'throw'
} = {}) {
    const fsMap = new Map(Object.entries({ ...DEFAULT_FILES, ...files }));
    const killed = [];
    const spawned = [];

    const io = {
        fs: {
            existsSync: (p) => fsMap.has(String(p)),
            isDirectory: (p) => fsMap.has(String(p)),
            readFileSync: (p) => {
                const k = String(p);
                const m = /^\/proc\/(\d+)\/cmdline$/.exec(k);
                if (m && procs[m[1]]) return procs[m[1]].cmdline.join('\0');
                if (fsMap.has(k)) return fsMap.get(k);
                throw new Error(`ENOENT: ${p}`);
            },
            writeFileSync: (p, data) => { fsMap.set(String(p), data); },
            mkdirSync: () => {},
            renameSync: () => {},
            unlinkSync: (p) => { fsMap.delete(String(p)); },
            rmSync: (p) => { for (const k of [...fsMap.keys()]) if (k.startsWith(String(p))) fsMap.delete(k); },
            rmdirSync: () => {},
            copyFileSync: () => {},
            chmodSync: (p, mode) => { fsMap.set(`${String(p)}::mode`, mode); },
            statSync: (p) => {
                const k = String(p);
                const m = /^\/proc\/(\d+)$/.exec(k);
                if (m && procs[m[1]]) return { uid: procs[m[1]].uid, isFile: false, isDirectory: true };
                if (fsMap.has(k)) return { uid: MY_UID, isFile: true, isDirectory: false, size: 1 };
                throw new Error(`ENOENT: ${p}`);
            },
            readdirSync: (p) => {
                if (String(p) === '/proc') return [...Object.keys(procs), 'self'];
                throw new Error(`ENOENT: ${p}`);
            },
            readlinkSync: (p) => {
                const m = /^\/proc\/(\d+)\/cwd$/.exec(String(p));
                if (m && procs[m[1]]) return procs[m[1]].cwd;
                throw new Error(`ENOENT: ${p}`);
            },
        },
        exec: (cmd, args = []) => {
            const j = args.join(' ');
            if (cmd === 'pgrep') {
                const pids = Object.entries(procs).filter(([, pr]) => pr.cmdline.some((a) => /worker\.cjs$/.test(a))).map(([pid]) => pid);
                return { code: pids.length ? 0 : 1, stdout: pids.join('\n'), stderr: '' };
            }
            if (cmd === 'readlink') return { code: 0, stdout: (procs[j.replace('/proc/', '').replace('/cwd', '')] || {}).cwd || '', stderr: '' };
            if (cmd === 'ps') return { code: 0, stdout: 'node worker.cjs', stderr: '' };
            if (cmd === 'sleep') return { code: 0, stdout: '', stderr: '' };
            if (cmd === 'node') return { code: 0, stdout: '', stderr: '' }; // --check / require.resolve
            if (cmd === 'kill') return { code: 0, stdout: '', stderr: '' };
            return { code: 0, stdout: '', stderr: '' };
        },
        execAsync: async () => ({ code: 0, stdout: '', stderr: '' }),
        spawnDaemon: (command, args, opts) => {
            const pid = 999001 + spawned.length;
            spawned.push({ command, args, opts, pid });
            return pid;
        },
        kill: (pid, signal) => {
            killed.push({ pid, signal });
            delete procs[String(pid)]; // signal terminates the process
        },
        http: {
            async fetchJson(url) {
                const u = String(url);
                const key = u.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
                if (http[key] === 'throw') throw new Error('ECONNREFUSED');
                if (http[key]) return http[key];
                return { status: 404, json: null };
            },
        },
        now: () => Date.now(),
        _killed: killed,
        _spawned: spawned,
    };
    return io;
}

function baseTargets(overrides = {}) {
    return {
        state: STATE,
        comfyuiRoot: '/home/u/ComfyUI',
        workerDir: '/home/u/animastor/worker',
        port: 8288,
        device: 'cpu',
        statePath: '/home/u/ComfyUI/.animastor-installer/install-state.json',
        found: true,
        ...overrides,
    };
}

const COMFY_PROCS = {
    424242: { cwd: '/home/u/ComfyUI', cmdline: ['venv/bin/python', 'main.py', '--listen', '127.0.0.1', '--port', '8288', '--cpu'], uid: MY_UID },
    424000: { cwd: '/home/other/ComfyUI', cmdline: ['python3', 'main.py', '--port', '8288'], uid: FOREIGN_UID },
};
const WORKER_PROCS = {
    515151: { cwd: '/home/u/animastor/worker', cmdline: ['node', 'worker.cjs'], uid: MY_UID },
    515000: { cwd: '/home/other/animastor/worker', cmdline: ['node', 'worker.cjs'], uid: FOREIGN_UID },
};

// ---------------------------------------------------------------------------

describe('management tools (shared runtime logic)', () => {

    // ── MT1/MT2: managed discovery reuses the engine primitives ───────────
    it('MT1: managed ComfyUI is discovered by cwd+port (engine primitive)', () => {
        const io = makeMockIo({ procs: COMFY_PROCS });
        const pids = comfyui.findManagedComfyUIPids(io, { root: '/home/u/ComfyUI', port: 8288 });
        assert.deepStrictEqual(pids, [424242]);
    });

    it('MT2: foreign ComfyUI (other root) and foreign worker (other cwd) are never matched', () => {
        const io = makeMockIo({ procs: { ...COMFY_PROCS, ...WORKER_PROCS } });
        assert.deepStrictEqual(comfyui.findManagedComfyUIPids(io, { root: '/home/u/ComfyUI', port: 8288 }), [424242]);
        assert.strictEqual(workerMod.findRunningWorkerPid(io, '/home/u/animastor/worker'), 515151);
        assert.strictEqual(workerMod.findRunningWorkerPid(io, '/home/nobody/worker'), null);
    });

    // ── MT3/MT4: status ────────────────────────────────────────────────────
    it('MT3: status healthy → exit 0 and the expected block', async () => {
        const io = makeMockIo({
            procs: { ...COMFY_PROCS, ...WORKER_PROCS },
            http: {
                '/system_stats': { status: 200, json: { system: { comfyui_version: '0.11.1' } } },
                '/queue': { status: 200, json: { queue_running: [[1, 'p1']], queue_pending: [['2', 'p2'], ['3', 'p3'], ['4', 'p4']] } },
            },
        });
        const snap = await management.collectStatus(io, baseTargets());
        assert.strictEqual(snap.worker.running, true);
        assert.strictEqual(snap.comfyui.running, true);
        assert.strictEqual(snap.comfyui.port, 8288, 'port read from the managed process cmdline');
        assert.strictEqual(snap.api.ok, true);
        assert.deepStrictEqual(snap.queue, { running: 1, pending: 3 });
        const text = management.renderStatus(snap);
        assert.ok(text.includes('Animastor status'));
        assert.ok(text.includes('Worker:   ✓ RUNNING'));
        assert.ok(text.includes('ComfyUI:  ✓ RUNNING :8288'));
        assert.ok(text.includes('API:      ✓ OK'));
        assert.ok(text.includes('Queue:    1 running / 3 pending'));
        assert.strictEqual(management.statusExitCode(snap), 0);
    });

    it('MT4: status degraded → exit 1; API down renders Queue "—" and never throws', async () => {
        const io = makeMockIo({
            procs: WORKER_PROCS, // our ComfyUI not running; the foreign one on 8288 must not be reported
            http: { '/system_stats': 'throw', '/queue': 'throw' },
        });
        const snap = await management.collectStatus(io, baseTargets());
        assert.strictEqual(snap.worker.running, true);
        assert.strictEqual(snap.comfyui.running, false, 'foreign ComfyUI on the same port is not ours');
        assert.strictEqual(snap.api.ok, false);
        assert.strictEqual(snap.queue, null);
        const text = management.renderStatus(snap);
        assert.ok(text.includes('Worker:   ✓ RUNNING'));
        assert.ok(text.includes('ComfyUI:  ✗ STOPPED'));
        assert.ok(text.includes('API:      ✗ UNREACHABLE'));
        assert.ok(text.includes('Queue:    — (API unreachable)'));
        assert.strictEqual(management.statusExitCode(snap), 1);
    });

    // ── MT5–MT7: reboot-worker ─────────────────────────────────────────────
    it('MT5: reboot-worker stopped → started (no kills, engine startWorker used)', async () => {
        const io = makeMockIo({ procs: {} });
        const res = await management.restartWorker(io, baseTargets(), { term: null });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.healthy, true);
        assert.strictEqual(io._killed.length, 0);
        assert.strictEqual(io._spawned.length, 1);
        assert.deepStrictEqual(io._spawned[0].args, ['worker.cjs']);
        assert.strictEqual(io._spawned[0].opts.cwd, '/home/u/animastor/worker');
    });

    it('MT6: reboot-worker running → restart; ONLY the managed pid is killed', async () => {
        const io = makeMockIo({ procs: { ...WORKER_PROCS } });
        const res = await management.restartWorker(io, baseTargets(), { term: null });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.healthy, true);
        const killedPids = io._killed.map((k) => k.pid);
        assert.ok(killedPids.includes(515151), 'managed worker stopped');
        assert.ok(!killedPids.includes(515000), 'foreign worker never signaled');
        assert.strictEqual(io._spawned.length, 1, 'exactly one new worker process');
    });

    it('MT7: reboot-worker refuses a foreign-uid process (shared host)', async () => {
        const io = makeMockIo({ procs: { 515999: { cwd: '/home/u/animastor/worker', cmdline: ['node', 'worker.cjs'], uid: FOREIGN_UID } } });
        await assert.rejects(
            () => management.restartWorker(io, baseTargets(), { term: null }),
            /foreign process/,
        );
        assert.strictEqual(io._killed.length, 0);
        assert.strictEqual(io._spawned.length, 0);
    });

    // ── MT8–MT10: reboot-comfyui ───────────────────────────────────────────
    it('MT8: reboot-comfyui running → restart via restartManagedComfyUI; foreign instance untouched', async () => {
        const io = makeMockIo({
            procs: { ...COMFY_PROCS },
            http: { '/system_stats': { status: 200, json: { system: {} } } },
        });
        const res = await management.restartComfyUI(io, baseTargets(), { term: null });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.port, 8288);
        const killedPids = io._killed.map((k) => k.pid);
        assert.ok(killedPids.includes(424242));
        assert.ok(!killedPids.includes(424000), 'foreign ComfyUI (other root) never signaled');
        assert.strictEqual(io._spawned.length, 1);
        assert.ok(io._spawned[0].args.includes('--port'), 'restarted with the managed port');
    });

    it('MT9: reboot-comfyui stopped → started via startComfyUI + waitForApi', async () => {
        const io = makeMockIo({
            procs: { 424000: COMFY_PROCS[424000] }, // only the foreign one runs
            http: { '/system_stats': { status: 200, json: { system: {} } } },
        });
        const res = await management.restartComfyUI(io, baseTargets(), { term: null });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.port, 8288, 'state port used when no managed process runs');
        const killedPids = io._killed.map((k) => k.pid);
        assert.ok(!killedPids.includes(424000));
        assert.strictEqual(io._spawned.length, 1);
        const portIdx = io._spawned[0].args.indexOf('--port');
        assert.strictEqual(io._spawned[0].args[portIdx + 1], '8288');
    });

    it('MT10: restartManagedComfyUI allowedUids filter leaves foreign-uid processes running', async () => {
        const io = makeMockIo({
            procs: { 424111: { cwd: '/home/u/ComfyUI', cmdline: ['python', 'main.py', '--port', '8288'], uid: FOREIGN_UID } },
            http: { '/system_stats': { status: 200, json: { system: {} } } },
        });
        const res = await comfyui.restartManagedComfyUI(io, { root: '/home/u/ComfyUI', port: 8288, allowedUids: [MY_UID] });
        assert.strictEqual(res.restarted, false);
        assert.strictEqual(io._killed.length, 0);
        assert.strictEqual(io._spawned.length, 0);
        // without the filter (installer default) the process IS ours by cwd and is restarted
        const res2 = await comfyui.restartManagedComfyUI(io, { root: '/home/u/ComfyUI', port: 8288, verifyTimeoutMs: 500, pollIntervalMs: 20 });
        assert.strictEqual(res2.restarted, true);
        assert.strictEqual(res2.up, true);
    });

    // ── MT11–MT15: monitor ─────────────────────────────────────────────────
    it('MT11: monitor with an empty queue → "Status: empty"', async () => {
        const io = makeMockIo({
            http: {
                '/system_stats': { status: 200, json: { system: { comfyui_version: '0.11.1' } } },
                '/queue': { status: 200, json: { queue_running: [], queue_pending: [] } },
                '/history?max_items=24': { status: 200, json: {} },
            },
        });
        const data = await management.collectMonitor(io, baseTargets());
        const text = management.renderMonitor(data);
        assert.ok(text.includes('Animastor ComfyUI Monitor'));
        assert.ok(text.includes('ComfyUI:  ✓ RUNNING'));
        assert.ok(text.includes('Port:     8288'));
        assert.ok(text.includes('Version:  0.11.1'));
        assert.ok(text.includes('Running: 0'));
        assert.ok(text.includes('Pending: 0'));
        assert.ok(text.includes('Status: empty'));
        assert.ok(!text.includes('Recent errors'), 'no error block when history is clean');
    });

    it('MT12: monitor running + pending queue with workflow type guesses', async () => {
        const io = makeMockIo({
            http: {
                '/system_stats': { status: 200, json: { system: {} } },
                '/queue': {
                    status: 200,
                    json: {
                        queue_running: [[1, 'run-1', { '10': { class_type: 'KSampler' }, '20': { class_type: 'VAEDecode' } }]],
                        queue_pending: [
                            [2, 'pend-1', { '1': { class_type: 'Qwen3-TTS' } }],
                            [3, 'pend-2', { '1': { class_type: 'SVD_img2vid_Conditioning' } }],
                        ],
                    },
                },
                '/history?max_items=24': { status: 200, json: {} },
            },
        });
        const data = await management.collectMonitor(io, baseTargets());
        const text = management.renderMonitor(data);
        assert.ok(text.includes('Running: 1'));
        assert.ok(text.includes('Pending: 2'));
        assert.ok(text.includes('#run-1  image generation'), text);
        assert.ok(text.includes('#pend-1  audio generation'), text);
        assert.ok(text.includes('#pend-2  video generation'), text);
        assert.ok(text.includes('waiting'));
    });

    it('MT13: monitor with the API down renders NOT RESPONDING and does not crash', async () => {
        const io = makeMockIo({ http: { '/system_stats': 'throw', '/queue': 'throw', '/history?max_items=24': 'throw' } });
        const data = await management.collectMonitor(io, baseTargets());
        const text = management.renderMonitor(data);
        assert.ok(text.includes('ComfyUI:  ✗ NOT RESPONDING'));
        assert.ok(text.includes('API:      ✗ UNREACHABLE'));
        assert.ok(text.includes('Queue     — (unavailable)'));
        assert.strictEqual(data.api.ok, false);
    });

    it('MT14: monitor shows compact recent errors from /history', async () => {
        const ts = new Date('2026-08-30T12:41:08').getTime();
        const io = makeMockIo({
            http: {
                '/system_stats': { status: 200, json: { system: {} } },
                '/queue': { status: 200, json: { queue_running: [], queue_pending: [] } },
                '/history?max_items=24': {
                    status: 200,
                    json: {
                        'err-1': {
                            status: {
                                status_str: 'error',
                                completed: false,
                                messages: [
                                    ['execution_start', { prompt_id: 'err-1', timestamp: ts - 5000 }],
                                    ['execution_error', { prompt_id: 'err-1', node_type: 'Qwen3-TTS node', exception_message: 'CUDA out of memory\nmore lines', timestamp: ts }],
                                ],
                            },
                        },
                        'ok-1': { status: { status_str: 'success', completed: true, messages: [] } },
                    },
                },
            },
        });
        const data = await management.collectMonitor(io, baseTargets());
        assert.strictEqual(data.errors.length, 1);
        const text = management.renderMonitor(data);
        assert.ok(text.includes('Recent errors'));
        assert.ok(text.includes('Qwen3-TTS node: CUDA out of memory'), text);
        assert.ok(/\[\d\d:\d\d:\d\d\]/.test(text), 'timestamp rendered as HH:MM:SS');
        assert.ok(!text.includes('more lines'), 'error message truncated to the first line');
    });

    it('MT15: partial endpoint failures degrade gracefully (queue 404, /history fallback)', async () => {
        const io = makeMockIo({
            http: {
                '/system_stats': { status: 200, json: { system: {} } },
                '/queue': { status: 404, json: null },
                '/history?max_items=24': { status: 404, json: null },
                '/history': { status: 200, json: { 'e-1': { status: { status_str: 'error', messages: [['execution_error', { node_type: 'N', exception_message: 'boom', timestamp: 1 }]] } } } },
            },
        });
        const data = await management.collectMonitor(io, baseTargets());
        const text = management.renderMonitor(data);
        assert.strictEqual(data.api.ok, true, 'API (system_stats) still reported OK');
        assert.ok(text.includes('Queue     — (unavailable)'));
        assert.ok(text.includes('N: boom'), 'history fallback still yields errors');
    });

    it('MT15b: guessJobKind never throws on malformed queue entries', () => {
        assert.strictEqual(management.guessJobKind(null), 'workflow');
        assert.strictEqual(management.guessJobKind([1]), 'workflow');
        assert.strictEqual(management.guessJobKind([1, 'x', 'not-an-object']), 'workflow');
        assert.strictEqual(management.guessJobKind([1, 'x', { nodes: [{ type: 'SomethingNew' }] }]), 'SomethingNew');
    });

    // ── MT16–MT18: tools installation ──────────────────────────────────────
    it('MT16: tools install writes 4 executable wrappers with the right commands', () => {
        const io = makeMockIo({});
        const res = management.installManagementTools(io, {
            toolsDir: '/home/u/animastor/tools',
            nodePath: '/usr/bin/node',
            cliPath: '/opt/animastor/backend/src/installer/cli.js',
            statePath: '/home/u/ComfyUI/.animastor-installer/install-state.json',
            root: '/home/u/ComfyUI',
            workerDir: '/home/u/animastor/worker',
        });
        assert.strictEqual(res.files.length, 4);
        assert.deepStrictEqual(res.files.map((f) => path.basename(f)), ['status.sh', 'reboot-worker.sh', 'reboot-comfyui.sh', 'comfyui-monitor.sh']);
        for (const f of res.files) {
            const body = io.fs.readFileSync(f);
            assert.ok(body.startsWith('#!/bin/sh'), `${f} has a shebang`);
            assert.strictEqual(io.fs.readFileSync(`${f}::mode`), 0o755, `${f} is executable`);
            assert.ok(body.includes(`exec '/usr/bin/node' '/opt/animastor/backend/src/installer/cli.js'`), body);
            assert.ok(body.includes(`--state '/home/u/ComfyUI/.animastor-installer/install-state.json'`));
            assert.ok(body.includes(`--root '/home/u/ComfyUI'`));
            assert.ok(body.includes(`--worker-dir '/home/u/animastor/worker'`));
            assert.ok(body.includes('"$@"'), 'user flags are forwarded');
        }
        assert.ok(/cli\.js' status/.test(io.fs.readFileSync('/home/u/animastor/tools/status.sh')));
        assert.ok(/cli\.js' reboot-worker/.test(io.fs.readFileSync('/home/u/animastor/tools/reboot-worker.sh')));
        assert.ok(/cli\.js' reboot-comfyui/.test(io.fs.readFileSync('/home/u/animastor/tools/reboot-comfyui.sh')));
        assert.ok(/cli\.js' monitor/.test(io.fs.readFileSync('/home/u/animastor/tools/comfyui-monitor.sh')));
    });

    it('MT17: reinstalling tools overwrites the same files — no duplicates', () => {
        const io = makeMockIo({});
        const args = {
            toolsDir: '/home/u/animastor/tools',
            nodePath: '/usr/bin/node',
            cliPath: '/opt/animastor/backend/src/installer/cli.js',
            statePath: '/s.json',
            root: '/home/u/ComfyUI',
            workerDir: '/home/u/animastor/worker',
        };
        management.installManagementTools(io, args);
        management.installManagementTools(io, { ...args, cliPath: '/opt/animastor/backend/src/installer/cli.js' });
        assert.strictEqual(io._spawned.length, 0);
        const second = management.installManagementTools(io, args);
        assert.strictEqual(second.files.length, 4);
        assert.ok(/cli\.js' status/.test(io.fs.readFileSync('/home/u/animastor/tools/status.sh')));
    });

    it('MT18: tool wrapper quoting survives paths with single quotes', () => {
        const script = management.renderToolScript({
            command: 'status',
            nodePath: "/usr/bin/nod'e",
            cliPath: "/opt/it's/cli.js",
            statePath: '/s.json',
            root: '/r',
            workerDir: '/w',
        });
        assert.ok(script.includes(`'/usr/bin/nod'\\''e'`), script);
        assert.ok(script.includes(`'/opt/it'\\''s/cli.js'`), script);
    });

    // ── MT19: uninstall integration ────────────────────────────────────────
    it('MT19: installed tools are registered as owned components and removable by the uninstaller', () => {
        const io = makeMockIo({ files: {} });
        const res = management.installManagementTools(io, {
            toolsDir: '/home/u/animastor/tools',
            nodePath: '/usr/bin/node',
            cliPath: '/cli.js',
            statePath: '/home/u/ComfyUI/.animastor-installer/install-state.json',
            root: '/home/u/ComfyUI',
            workerDir: '/home/u/animastor/worker',
        });
        const st = JSON.parse(JSON.stringify(STATE));
        for (const f of res.files) {
            io.fs.writeFileSync(f, '#!/bin/sh\n'); // files must exist on disk for the plan
            require('../src/installer/engine/state').addOwnedComponent(st, 'services', { id: 'management-tools', path: f });
        }
        const plan = uninstaller.buildUninstallPlan(io, { state: st, statePath: st.root + '/.animastor-installer/install-state.json', home: '/home/u' });
        const services = plan.groups.find((g) => g.key === 'services');
        assert.ok(services, 'services group present');
        const toolItems = services.items.filter((i) => i.path.includes('/tools/'));
        assert.strictEqual(toolItems.length, 4);
        assert.ok(toolItems.every((i) => i.removable));
    });

    // ── MT20: ownership / permission behaviour ─────────────────────────────
    it('MT20: running as root (sudo) against a user-owned installation is blocked; same uid passes', () => {
        const io = makeMockIo({ files: { '/home/u/ComfyUI/.animastor-installer/install-state.json': JSON.stringify(STATE) } });
        const targets = baseTargets();
        // root running against a user install → violation (would create root-owned files)
        const asRoot = management.checkAccess(io, targets, { currentUid: 0, home: '/root' });
        assert.strictEqual(asRoot.ok, false);
        assert.ok(asRoot.violations.some((v) => v.kind === 'root-over-user-files' || v.kind === 'root-into-user-home'), JSON.stringify(asRoot.violations));
        // the installation owner passes
        const asOwner = management.checkAccess(io, targets, { currentUid: MY_UID, home: '/home/u' });
        assert.strictEqual(asOwner.ok, true, JSON.stringify(asOwner.violations));
        // another uid is blocked too (cross-tenant)
        const asOther = management.checkAccess(io, targets, { currentUid: FOREIGN_UID, home: '/home/other' });
        assert.strictEqual(asOther.ok, false);
    });

    // ── MT21/MT22: decision wiring ─────────────────────────────────────────
    it('MT21: tools decision — explicit flags win, prior decision kept, prompt asked only otherwise', async () => {
        assert.strictEqual(await resolveToolsDecision({ flags: { 'no-tools': true }, prompt: null, prior: true }), false);
        assert.strictEqual(await resolveToolsDecision({ flags: { 'install-tools': true }, prompt: null, prior: false }), true);
        assert.strictEqual(await resolveToolsDecision({ flags: {}, prompt: null, prior: true }), true);
        assert.strictEqual(await resolveToolsDecision({ flags: {}, prompt: null, prior: false }), false);
        assert.strictEqual(await resolveToolsDecision({ flags: {}, prompt: null, prior: null }), true, 'non-interactive default: install');
        let asked = 0;
        const answer = await resolveToolsDecision({
            flags: {}, prior: null,
            prompt: { confirm: async (q) => { asked += 1; assert.ok(/management tools/.test(q), q); return false; } },
        });
        assert.strictEqual(answer, false);
        assert.strictEqual(asked, 1, 'prompt used exactly once when no prior decision');
    });

    it('MT21b: --tools-dir defaults next to the worker dir; parseArgs picks up the new flags', () => {
        const flags = parseArgs(['node', 'cli.js', 'install', '--worker-dir', '/home/u/animastor/worker', '--install-tools']).flags;
        assert.strictEqual(resolveToolsDir(flags), '/home/u/animastor/tools');
        const flags2 = parseArgs(['node', 'cli.js', 'install', '--tools-dir', '/opt/tools']).flags;
        assert.strictEqual(resolveToolsDir(flags2), '/opt/tools');
    });

    it('MT22: the engine persists install_management_tools for resume', () => {
        const sanitized = engine.sanitizeDecisions({ install_management_tools: true, worker_setup: true, worker_key: 'secret' });
        assert.strictEqual(sanitized.install_management_tools, true);
        assert.ok(!('worker_key' in sanitized));
    });

    // ── MT23: real CLI subprocess — non-TTY output without ANSI ────────────
    it('MT23: `status` CLI — not-found → exit 2; stopped install → exit 1, no ANSI on non-TTY', async function () {
        this.timeout(30000);
        const cliPath = path.join(__dirname, '..', 'src', 'installer', 'cli.js');
        // no installation at all
        await assert.rejects(
            () => execFileAsync(process.execPath, [cliPath, 'status', '--state', '/tmp/opencode/mt-missing-state.json'], { env: { ...process.env, HOME: '/tmp/opencode' } }),
            (err) => err.code === 2,
        );
        // a recorded installation with nothing running (temp root, dead port → hermetic)
        const tmpRoot = '/tmp/opencode/mt-install';
        const fs = require('fs');
        fs.mkdirSync(path.join(tmpRoot, '.animastor-installer'), { recursive: true });
        const st = JSON.parse(JSON.stringify(STATE));
        st.root = tmpRoot;
        st.comfyui_runtime = { port: 59999 };
        fs.writeFileSync(path.join(tmpRoot, '.animastor-installer', 'install-state.json'), JSON.stringify(st));
        let err = null;
        try {
            await execFileAsync(process.execPath, [cliPath, 'status', '--state', path.join(tmpRoot, '.animastor-installer', 'install-state.json'), '--root', tmpRoot, '--worker-dir', '/tmp/opencode/mt-worker'], { timeout: 20000 });
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'degraded status must exit non-zero');
        assert.strictEqual(err.code, 1, `degraded status exit code: ${err.code}`);
        const out = String(err.stdout || '');
        assert.ok(!out.includes('\x1b'), `no ANSI escape sequences on non-TTY stdout: ${JSON.stringify(out)}`);
        assert.ok(out.includes('Animastor status'), out);
        assert.ok(out.includes('✗ STOPPED'), out);
    });
});
