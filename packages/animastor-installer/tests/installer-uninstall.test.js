'use strict';

/**
 * Uninstaller tests — manifest-driven safe removal.
 *
 * Scenarios:
 *  1. assertDeletablePath guards (root, system dirs, home, relative)
 *  2. loadInstallRecord: missing / corrupt / valid
 *  3. plan: owned comfyui + venv are removable; pre-existing comfyui is kept
 *  4. plan: model dir created by installer removable; pre-existing model dir
 *     removes only registered files
 *  5. plan: pre-existing worker dir → only deployed files removable, .env kept
 *  6. execution: selective answers remove only the chosen groups
 *  7. execution: full uninstall removes everything owned, never pre-existing
 *  8. dry-run removes nothing
 *  9. execution stops processes found under the target paths
 * 10. config step removes the state file + empty state dir, last
 * 11. renderUninstallPlan renders removable and kept components
 */

const assert = require('assert');
const path = require('path');
const { createMemoryFs } = require('../src/installer/engine/io');
const state = require('../src/installer/engine/state');
const uninstaller = require('../src/installer/uninstaller');

// ---------------------------------------------------------------------------
// Mock io (memory fs + exec recorder)
// ---------------------------------------------------------------------------

function createMockIo(overrides = {}) {
    const fs = createMemoryFs(overrides.files || {});
    if (overrides.preDirs) {
        for (const d of overrides.preDirs) fs.mkdirSync(d, { recursive: true });
    }
    const calls = { exec: [] };
    const execResults = overrides.execResults || {};
    return {
        io: {
            fs,
            exec(cmd, args = []) {
                calls.exec.push({ cmd, args });
                const key = `${cmd} ${(args || []).join(' ')}`;
                const r = execResults[key] || execResults[cmd] || { code: 0, stdout: '', stderr: '' };
                return typeof r === 'function' ? r({ cmd, args, fs }) : r;
            },
            spawnDaemon: () => 1,
            fetch: async () => ({}),
            http: {},
            hashFile: async () => '0'.repeat(64),
            now: () => 1700000000000,
        },
        calls,
        fs,
    };
}

const HOME = '/home/tester';
const STATE_PATH = '/home/tester/ComfyUI/.animastor-installer/install-state.json';

function baseState() {
    const st = state.emptyState({ mode: 'managed', profiles: ['audio/qwen-tts'], root: '/home/tester/ComfyUI' });
    st.device = 'cpu';
    return st;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ========================== 1. Path guards ===========================
test('1. assertDeletablePath refuses root, system dirs, home, parents of home, relative', () => {
    const g = (p, opts = {}) => {
        try {
            uninstaller.assertDeletablePath(p, { home: HOME, ...opts });
            return null;
        } catch (err) {
            return err.message;
        }
    };
    assert.match(g('/') || '', /filesystem root/);
    assert.match(g('/usr') || '', /protected/);
    assert.match(g('/etc') || '', /protected/);
    assert.match(g('/var/lib') || '', /system directory/);
    assert.match(g('/usr/share/x') || '', /system directory/);
    assert.match(g('/home') || '', /protected/);
    assert.match(g(HOME) || '', /home directory/);
    assert.match(g('relative/path') || '', /relative|non-normalized/);
    assert.match(g('') || '', /invalid/);
    // allowed: deep user-owned paths
    assert.strictEqual(g('/home/tester/ComfyUI'), null);
    assert.strictEqual(g('/opt/animastor-test'), null);
    assert.strictEqual(g('/data/comfy'), null);
    assert.strictEqual(g('/home/tester/ComfyUI/venv', {}), null);
});

// ========================== 2. loadInstallRecord =====================
test('2. loadInstallRecord: missing → null, corrupt → flagged, valid → normalized', () => {
    const { io, fs } = createMockIo({});
    assert.strictEqual(uninstaller.loadInstallRecord(io, '/nonexistent/state.json'), null);
    fs.mkdirSync('/s', { recursive: true });
    fs.writeFileSync('/s/state.json', '{not json');
    let rec = uninstaller.loadInstallRecord(io, '/s/state.json');
    assert.ok(rec && rec.corrupt === true, 'corrupt state flagged');
    fs.writeFileSync('/s/state.json', JSON.stringify({ state_version: 1, profiles: ['audio/qwen-tts'] }));
    rec = uninstaller.loadInstallRecord(io, '/s/state.json');
    assert.ok(rec && rec.components && Array.isArray(rec.components.models), 'valid state normalized');
});

// ========================== 3. ComfyUI ownership =====================
test('3. plan: owned comfyui + venv removable; pre-existing comfyui kept', () => {
    const st = baseState();
    st.components.comfyui = { owned: true, path: '/home/tester/ComfyUI' };
    st.components.venv = { owned: true, path: '/home/tester/ComfyUI/venv', created: true };
    const { io, fs } = createMockIo({ preDirs: ['/home/tester/ComfyUI', '/home/tester/ComfyUI/venv'] });
    const plan = uninstaller.buildUninstallPlan(io, { state: st, statePath: STATE_PATH, home: HOME });
    const g = plan.groups.find((x) => x.key === 'comfyui');
    assert.strictEqual(g.items.length, 2);
    assert.ok(g.items.every((i) => i.removable));
    // state file lives inside the root → note about manifest removal
    assert.ok(g.items[0].note && g.items[0].note.includes('state'), 'containment note shown');

    const st2 = baseState();
    st2.components.comfyui = { owned: false, path: '/home/tester/ComfyUI' };
    st2.components.venv = { owned: true, path: '/home/tester/ComfyUI/venv', created: true };
    const plan2 = uninstaller.buildUninstallPlan(io, { state: st2, statePath: STATE_PATH, home: HOME });
    const g2 = plan2.groups.find((x) => x.key === 'comfyui');
    assert.strictEqual(g2.items.length, 1, 'only the venv is removable');
    assert.strictEqual(g2.items[0].path, '/home/tester/ComfyUI/venv');
    assert.strictEqual(g2.skipped.length, 1, 'pre-existing root reported as kept');
});

// ========================== 4. Models ownership ======================
test('4. plan: created model dirs removable; pre-existing dirs → files only', () => {
    const st = baseState();
    st.components.models = [
        { id: 'm-created', path: '/home/tester/ComfyUI/models/TTS/Qwen/model-a', created: true },
        { id: 'm-pre', path: '/home/tester/ComfyUI/models/TTS/shared', created: false, files: ['model.safetensors', 'speech_tokenizer/model.safetensors'] },
    ];
    const { io, fs } = createMockIo({
        preDirs: [
            '/home/tester/ComfyUI/models/TTS/shared',
            '/home/tester/ComfyUI/models/TTS/Qwen/model-a',
        ],
        files: {
            '/home/tester/ComfyUI/models/TTS/shared/model.safetensors': 'x',
            '/home/tester/ComfyUI/models/TTS/shared/speech_tokenizer/model.safetensors': 'x',
            '/home/tester/ComfyUI/models/TTS/shared/user-file.txt': 'do not touch',
        },
    });
    const plan = uninstaller.buildUninstallPlan(io, { state: st, statePath: STATE_PATH, home: HOME });
    const g = plan.groups.find((x) => x.key === 'models');
    const paths = g.items.map((i) => i.path);
    assert.ok(paths.includes('/home/tester/ComfyUI/models/TTS/Qwen/model-a'), 'created dir removable whole');
    assert.ok(paths.includes('/home/tester/ComfyUI/models/TTS/shared/model.safetensors'), 'registered file removable');
    assert.ok(!paths.includes('/home/tester/ComfyUI/models/TTS/shared'), 'pre-existing dir NOT removable');
    assert.ok(!paths.includes('/home/tester/ComfyUI/models/TTS/shared/user-file.txt'), 'unregistered file untouched');
});

// ========================== 5. Worker ownership ======================
test('5. plan: pre-existing worker dir → only deployed files; .env created vs merged', () => {
    const st = baseState();
    st.components.worker = {
        owned: false, dir: '/home/tester/animastor/worker',
        files_installed: ['worker.cjs', 'package.json'], files_kept: ['.env'],
        env_created: false,
    };
    const { io, fs } = createMockIo({
        preDirs: [
            '/home/tester/animastor/worker',
            '/home/tester/animastor/worker/node_modules',
        ],
        files: {
            '/home/tester/animastor/worker/worker.cjs': '//',
            '/home/tester/animastor/worker/package.json': '{}',
            '/home/tester/animastor/worker/.env': 'ANIMASTOR_WORKER_TOKEN=x\n',
        },
    });
    const plan = uninstaller.buildUninstallPlan(io, { state: st, statePath: STATE_PATH, home: HOME });
    const g = plan.groups.find((x) => x.key === 'worker');
    const paths = g.items.map((i) => i.path);
    assert.ok(paths.includes('/home/tester/animastor/worker/worker.cjs'));
    assert.ok(paths.includes('/home/tester/animastor/worker/package.json'));
    assert.ok(paths.includes('/home/tester/animastor/worker/node_modules'), 'node_modules removable (package.json was ours)');
    assert.ok(!paths.includes('/home/tester/animastor/worker'), 'dir itself NOT removable');
    assert.ok(!paths.includes('/home/tester/animastor/worker/.env'), 'merged .env NOT removable');
    assert.ok(g.skipped.some((s) => s.label.includes('.env')), 'merged .env reported');

    const st2 = baseState();
    st2.components.worker = { owned: true, dir: '/home/tester/animastor/worker', files_installed: ['worker.cjs'], files_kept: [], env_created: true };
    const plan2 = uninstaller.buildUninstallPlan(io, { state: st2, statePath: STATE_PATH, home: HOME });
    const g2 = plan2.groups.find((x) => x.key === 'worker');
    assert.ok(g2.items.some((i) => i.path === '/home/tester/animastor/worker' && i.type === 'dir'), 'owned dir removable whole');
    assert.ok(g2.items.some((i) => i.path.endsWith('/.env')), 'created .env removable');
});

// ========================== 6. Selective execution ===================
test('6. selective answers remove only chosen groups', () => {
    const st = baseState();
    st.components.comfyui = { owned: true, path: '/home/tester/ComfyUI' };
    st.components.venv = { owned: true, path: '/home/tester/ComfyUI/venv', created: true };
    st.components.models = [{ id: 'm1', path: '/home/tester/ComfyUI/models/TTS/model-a', created: true }];
    st.components.custom_nodes = [{ id: 'n1', path: '/home/tester/ComfyUI/custom_nodes/qwen3-tts' }];
    const { io, fs } = createMockIo({
        preDirs: ['/home/tester/ComfyUI', '/home/tester/ComfyUI/venv', '/home/tester/ComfyUI/models/TTS/model-a', '/home/tester/ComfyUI/custom_nodes/qwen3-tts'],
    });
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(st));

    const plan = uninstaller.buildUninstallPlan(io, { state: st, statePath: STATE_PATH, home: HOME });
    const outcome = uninstaller.runUninstallation(io, {
        plan,
        answers: { comfyui: false, models: true, custom_nodes: true, worker: false, services: false, config: false },
        statePath: STATE_PATH,
    });
    assert.strictEqual(fs.existsSync('/home/tester/ComfyUI/models/TTS/model-a'), false, 'model removed');
    assert.strictEqual(fs.existsSync('/home/tester/ComfyUI/custom_nodes/qwen3-tts'), false, 'node removed');
    assert.strictEqual(fs.existsSync('/home/tester/ComfyUI'), true, 'comfyui kept by user');
    assert.strictEqual(fs.existsSync(STATE_PATH), true, 'state kept by user');
    assert.strictEqual(outcome.removed, 2);
    assert.ok(outcome.failed === 0);
});

// ========================== 7. Full execution ========================
test('7. full uninstall removes everything owned, never pre-existing', () => {
    const st = baseState();
    st.components.comfyui = { owned: false, path: '/home/tester/ComfyUI' }; // pre-existing root
    st.components.venv = { owned: true, path: '/home/tester/ComfyUI/venv', created: true };
    st.components.worker = { owned: true, dir: '/home/tester/animastor/worker', files_installed: ['worker.cjs'], files_kept: [], env_created: true };
    const { io, fs } = createMockIo({
        preDirs: ['/home/tester/ComfyUI', '/home/tester/ComfyUI/venv', '/home/tester/animastor/worker'],
        files: {
            '/home/tester/ComfyUI/main.py': '# comfy (user data!)',
            '/home/tester/animastor/worker/worker.cjs': '//',
            '/home/tester/animastor/worker/.env': 'ANIMASTOR_WORKER_TOKEN=x\n',
        },
    });
    const plan = uninstaller.buildUninstallPlan(io, { state: st, statePath: STATE_PATH, home: HOME });
    const outcome = uninstaller.runUninstallation(io, {
        plan,
        answers: { comfyui: true, models: true, custom_nodes: true, worker: true, services: true, config: false },
        statePath: STATE_PATH,
    });
    assert.strictEqual(fs.existsSync('/home/tester/ComfyUI/venv'), false, 'owned venv removed');
    assert.strictEqual(fs.existsSync('/home/tester/ComfyUI/main.py'), true, 'PRE-EXISTING ComfyUI root survived');
    assert.strictEqual(fs.existsSync('/home/tester/animastor/worker'), false, 'owned worker dir removed');
    assert.strictEqual(outcome.failed, 0);
});

// ========================== 8. Dry run ===============================
test('8. dry-run: nothing is removed', () => {
    const st = baseState();
    st.components.comfyui = { owned: true, path: '/home/tester/ComfyUI' };
    st.components.models = [{ id: 'm1', path: '/home/tester/ComfyUI/models/TTS/model-a', created: true }];
    const { io, fs } = createMockIo({
        preDirs: ['/home/tester/ComfyUI', '/home/tester/ComfyUI/models/TTS/model-a'],
        files: { '/home/tester/ComfyUI/main.py': 'x' },
    });
    const plan = uninstaller.buildUninstallPlan(io, { state: st, statePath: STATE_PATH, home: HOME });
    const outcome = uninstaller.runUninstallation(io, {
        plan,
        answers: { comfyui: true, models: true, custom_nodes: true, worker: true, services: true, config: true },
        statePath: STATE_PATH,
        dryRun: true,
    });
    assert.strictEqual(fs.existsSync('/home/tester/ComfyUI/main.py'), true, 'comfyui intact');
    assert.ok(outcome.results.every((r) => r.status.startsWith('would-') || r.status === 'kept-by-user' || r.status === 'missing'), 'dry-run statuses only');
    assert.strictEqual(outcome.removed, outcome.results.filter((r) => r.status.startsWith('would-')).length);
});

// ========================== 9. Process stop ==========================
test('9. processes under target paths are stopped before deletion', () => {
    const st = baseState();
    st.components.models = [{ id: 'm1', path: '/home/tester/ComfyUI/models/TTS/model-a', created: true }];
    const { io, fs, calls } = createMockIo({
        preDirs: ['/home/tester/ComfyUI/models/TTS/model-a'],
        execResults: {
            sh: (ctx) => {
                // the /proc scan: report two pids
                const isScan = ctx.args[0] === '-c' && String(ctx.args[1]).includes('/proc/');
                if (isScan) return { code: 0, stdout: '111\n222\n', stderr: '' };
                return { code: 0, stdout: '', stderr: '' };
            },
        },
    });
    const plan = uninstaller.buildUninstallPlan(io, { state: st, statePath: STATE_PATH, home: HOME });
    const outcome = uninstaller.runUninstallation(io, {
        plan,
        answers: { models: true, comfyui: false, custom_nodes: false, worker: false, services: false, config: false },
        statePath: STATE_PATH,
    });
    const kills = calls.exec.filter((c) => c.cmd === 'kill');
    assert.strictEqual(kills.length, 2, 'SIGTERM sent to both pids');
    assert.deepStrictEqual(kills.map((k) => k.args[1]).sort(), ['111', '222']);
    assert.ok(outcome.results.some((r) => r.status === 'stopped-process'));
    assert.strictEqual(fs.existsSync('/home/tester/ComfyUI/models/TTS/model-a'), false, 'model still removed');
});

// ========================== 10. Config step ==========================
test('10. config step removes the state file and empty state dir, last', () => {
    const st = baseState();
    st.components.custom_nodes = [{ id: 'n1', path: '/home/tester/ComfyUI/custom_nodes/qwen3-tts' }];
    const { io, fs } = createMockIo({
        preDirs: ['/home/tester/ComfyUI', '/home/tester/ComfyUI/custom_nodes/qwen3-tts'],
    });
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(st));

    const plan = uninstaller.buildUninstallPlan(io, { state: st, statePath: STATE_PATH, home: HOME });
    const outcome = uninstaller.runUninstallation(io, {
        plan,
        answers: { comfyui: false, models: false, custom_nodes: false, worker: false, services: false, config: true },
        statePath: STATE_PATH,
    });
    assert.strictEqual(fs.existsSync(STATE_PATH), false, 'state file removed');
    assert.strictEqual(fs.existsSync(path.dirname(STATE_PATH)), false, 'empty state dir removed');
    assert.strictEqual(fs.existsSync('/home/tester/ComfyUI/custom_nodes/qwen3-tts'), true, 'node kept (user said no)');
    assert.strictEqual(outcome.failed, 0);
});

// ========================== 11. Rendering ============================
test('11. renderUninstallPlan lists removable and kept components', () => {
    const st = baseState();
    st.components.comfyui = { owned: false, path: '/home/tester/ComfyUI' };
    st.components.venv = { owned: true, path: '/home/tester/ComfyUI/venv', created: true };
    st.components.worker = { owned: false, dir: '/home/tester/animastor/worker', files_installed: ['worker.cjs'], files_kept: [], env_created: false };
    const { io, fs } = createMockIo({
        preDirs: ['/home/tester/ComfyUI', '/home/tester/ComfyUI/venv', '/home/tester/animastor/worker'],
        files: { '/home/tester/animastor/worker/worker.cjs': '//' },
    });
    const plan = uninstaller.buildUninstallPlan(io, { state: st, statePath: STATE_PATH, home: HOME });
    const text = uninstaller.renderUninstallPlan(plan, { state: st });
    assert.ok(text.includes('Animastor Worker Uninstaller'));
    assert.ok(text.includes('KEPT'), 'pre-existing components marked as kept');
    assert.ok(text.includes('venv'), 'venv listed');
    assert.ok(text.includes('device cpu'), 'recorded device shown');
    assert.ok(text.includes('Removable components:'), 'summary line');
});

// ---------------------------------------------------------------------------

console.log(`\nUninstaller tests: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
