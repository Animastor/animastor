'use strict';

/**
 * CPU-only installer tests.
 *
 * Scenarios:
 *  1. probe: NVIDIA GPU verified via nvidia-smi query → device 'cuda'
 *  2. probe: no GPU at all → device 'cpu'
 *  3. probe: AMD GPU via sysfs vendor → reported, device falls back to 'cpu'
 *  4. pickTorchSpec: CPU branch uses the manifest's dedicated CPU build
 *  5. pickTorchSpec: CPU branch derives from the CUDA reference (warns)
 *  6. pickTorchSpec: GPU branch unchanged (reference gate still applies)
 *  7. resolver: torch 2.10.0+cpu matches the CPU pin on a CPU device
 *  8. resolver: full resolution on CPU env → runtime:torch installed
 *  9. summarizeHardware: CPU-only note
 * 10. plan text: CPU-only banner
 * 11. engine: managed CPU install — CPU torch index, --cpu start flag,
 *     CPU warning, ownership recorded in state
 * 12. verification report: CPU device → GPU line WARN (not FAIL)
 * 13. detection rendering shows the CPU-only warning
 *
 * All external operations are mocked (memory fs + scripted io). No GPU,
 * network, or real downloads.
 */

const assert = require('assert');
const { createMemoryFs } = require('../src/installer/engine/io');
const { createLogger } = require('../src/installer/engine/logger');
const probe = require('../src/installer/engine/probe');
const engineMod = require('../src/installer/engine/engine');
const { runInstallation } = engineMod;
const { pickTorchSpec } = engineMod;
const resolver = require('../src/installer/compatibility-resolver');
const { buildInstallPlan } = require('../src/installer/install-plan');
const { buildVerificationReport } = require('../src/installer/verification-report');
const state = require('../src/installer/engine/state');

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockIo(overrides = {}) {
    const fs = createMemoryFs(overrides.files || {});
    if (overrides.preDirs) {
        for (const d of overrides.preDirs) fs.mkdirSync(d, { recursive: true });
    }
    const calls = { exec: [], http: [], spawn: [] };
    const execResults = overrides.execResults || {};
    const httpResults = overrides.httpResults || {};

    return {
        io: {
            fs,
            exec(cmd, args = [], opts = {}) {
                calls.exec.push({ cmd, args, opts });
                const key = `${cmd} ${(args || []).join(' ')}`;
                const result = execResults[key] || execResults[cmd] || { code: 0, stdout: '', stderr: '' };
                // functional handlers may materialize files (e.g. git clone)
                if (typeof result === 'function') return result({ cmd, args, fs, calls });
                return result;
            },
            spawnDaemon(command, args = [], opts = {}) {
                calls.spawn.push({ command, args, opts });
                return 4242;
            },
            fetch: async () => ({ status: 200, json: () => ({}), text: () => '' }),
            http: {
                async download({ url, dest, headers, appendFrom, onProgress }) {
                    calls.http.push({ op: 'download', url, dest, appendFrom });
                    const handler = httpResults[url];
                    if (handler && typeof handler === 'function') return handler({ url, dest, headers, fs });
                    if (handler) return handler;
                    fs.writeFileSync(dest, `mock-content-${url.replace(/[^a-z0-9]/gi, '_')}`);
                    return { status: 200, bytes: 1024, total: 1024, resumed: false };
                },
                async fetchJson(url, opts = {}) {
                    calls.http.push({ op: 'fetchJson', url, opts });
                    const handler = httpResults[url];
                    if (handler && typeof handler === 'function') return handler({ url, opts });
                    if (handler) {
                        const json = typeof handler.json === 'function' ? handler.json() : (handler.json || null);
                        return { status: handler.status, json };
                    }
                    return { status: 200, json: {} };
                },
                async fetchText(url, opts = {}) {
                    calls.http.push({ op: 'fetchText', url, opts });
                    const handler = httpResults[url];
                    if (handler && typeof handler === 'function') return handler({ url, opts });
                    if (handler) return handler;
                    return { status: 200, text: '' };
                },
            },
            async hashFile(filePath, algo = 'sha256') {
                calls.http.push({ op: 'hashFile', filePath });
                return 'deadbeef'.repeat(8);
            },
            now: () => 1700000000000,
        },
        calls,
        fs,
    };
}

function createMockLogger(secrets = []) {
    const lines = [];
    const { redactSecrets } = require('../src/installer/safety-rules');
    function redact(text) {
        return redactSecrets(text, secrets);
    }
    const log = {
        info: (msg) => lines.push(`INFO: ${redact(msg)}`),
        warn: (msg) => lines.push(`WARN: ${redact(msg)}`),
        error: (msg) => lines.push(`ERROR: ${redact(msg)}`),
        output: (msg) => lines.push(`OUT: ${redact(msg)}`),
        step: async (name, fn) => {
            lines.push(`STEP: ${redact(name)}`);
            try {
                const value = await fn();
                return { ok: true, value, ms: 10 };
            } catch (err) {
                return { ok: false, error: err, ms: 10 };
            }
        },
        registerSecret: () => {},
        lines,
        secrets,
    };
    return log;
}

function minimalManifest(profileId, overrides = {}) {
    return {
        profile: { id: profileId, name: profileId },
        runtime_requirements: {
            comfyui: {
                pin: overrides.comfyuiPin !== undefined ? overrides.comfyuiPin : { tag: 'v0.27.0', repository: 'https://github.com/comfyanonymous/ComfyUI' },
            },
            torch: overrides.torch !== undefined ? overrides.torch : {
                pin: null,
                index_url: null,
                cpu: { pin: '2.10.0', index_url: 'https://download.pytorch.org/whl/cpu' },
                known_working_reference: { version: '2.10.0+cu128' },
            },
            python: { minimum: '3.10' },
            nodejs: { minimum: '20' },
        },
        dependencies: overrides.dependencies || [],
        workflows: overrides.workflows || { policy: 'editable-baseline', artifacts: [] },
        worker_bundle: overrides.worker_bundle || {
            worker_type: 'audio',
            files: ['worker.cjs', 'package.json', '.env.example'],
            env: {
                required: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'],
                secrets: ['ANIMASTOR_WORKER_TOKEN'],
            },
        },
    };
}

let passed = 0;
let failed = 0;
const testPromises = [];

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

async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${err.message}`);
    }
}

function collectAsync(name, fn) {
    testPromises.push(
        fn().then(() => {
            passed++;
            console.log(`  ✓ ${name}`);
        }).catch((err) => {
            failed++;
            console.log(`  ✗ ${name}`);
            console.log(`    ${err.message}`);
        })
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ========================== 1. NVIDIA probe ==========================
test('1. probe: nvidia-smi query success → device cuda', () => {
    const { io } = createMockIo({
        execResults: {
            'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 0, stdout: 'NVIDIA L40S, 46068, 550.127.08' },
            'nvidia-smi': { code: 0, stdout: 'NVIDIA L40S, 46068, 550.127.08\nCUDA Version: 12.4' },
        },
    });
    const env = probe.probeEnvironment(io, { root: null, workerDir: null });
    assert.ok(env.gpu, 'gpu detected');
    assert.strictEqual(env.gpu.vendor, 'nvidia');
    assert.strictEqual(env.gpu.name, 'NVIDIA L40S');
    assert.strictEqual(env.device, 'cuda');
    assert.strictEqual(env.cuda, '12.4');
});

// ========================== 2. No GPU probe ==========================
test('2. probe: nvidia-smi fails, no AMD → device cpu', () => {
    const { io } = createMockIo({
        execResults: {
            'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 1, stdout: '', stderr: 'no devices' },
            'nvidia-smi': { code: 1, stdout: '', stderr: 'no devices' },
            'rocm-smi --showproductname': { code: 127, stdout: '', stderr: 'not found' },
            lspci: { code: 1, stdout: '', stderr: 'not found' },
        },
    });
    const env = probe.probeEnvironment(io, { root: null, workerDir: null });
    assert.strictEqual(env.gpu, null);
    assert.strictEqual(env.device, 'cpu');
});

// ========================== 3. AMD probe =============================
test('3. probe: AMD GPU via sysfs vendor 0x1002 → reported, device cpu (fallback)', () => {
    const { io } = createMockIo({
        files: { '/sys/class/drm/card0/device/vendor': '0x1002\n' },
        execResults: {
            'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 1, stdout: '' },
            'nvidia-smi': { code: 1, stdout: '' },
            'rocm-smi --showproductname': { code: 127, stdout: '', stderr: 'not found' },
        },
    });
    const env = probe.probeEnvironment(io, { root: null, workerDir: null });
    assert.ok(env.gpu, 'amd gpu detected');
    assert.strictEqual(env.gpu.vendor, 'amd');
    assert.strictEqual(env.device, 'cpu');
});

test('3b. probe: empty nvidia-smi output (code 0) is NOT a GPU', () => {
    const { io } = createMockIo({});
    const env = probe.probeEnvironment(io, { root: null, workerDir: null });
    assert.strictEqual(env.gpu, null, 'empty stdout must not count as a GPU');
    assert.strictEqual(env.device, 'cpu');
});

// ========================== 4. pickTorchSpec CPU =====================
test('4. pickTorchSpec: device cpu → manifest CPU build (cpu-canonical)', () => {
    const m = minimalManifest('audio/qwen-tts');
    const warnings = [];
    const picked = pickTorchSpec([m], {}, warnings, 'cpu');
    assert.ok(picked, 'spec picked');
    assert.strictEqual(picked.grade, 'cpu-canonical');
    assert.strictEqual(picked.spec.pin, '2.10.0');
    assert.strictEqual(picked.spec.index_url, 'https://download.pytorch.org/whl/cpu');
    assert.strictEqual(warnings.length, 0);
});

test('5. pickTorchSpec: device cpu without spec.cpu → derived from reference with warning', () => {
    const m = minimalManifest('audio/qwen-tts', {
        torch: { pin: null, index_url: null, known_working_reference: { version: '2.10.0+cu128' } },
    });
    const warnings = [];
    const picked = pickTorchSpec([m], {}, warnings, 'cpu');
    assert.ok(picked, 'spec picked');
    assert.strictEqual(picked.grade, 'cpu-derived');
    assert.strictEqual(picked.spec.pin, '2.10.0', 'CUDA local tag stripped');
    assert.strictEqual(picked.spec.index_url, 'https://download.pytorch.org/whl/cpu');
    assert.ok(warnings.some((w) => w.includes('CPU')), 'derivation is explicitly warned');
});

test('6. pickTorchSpec: GPU branch unchanged — reference requires consent', () => {
    const m = minimalManifest('audio/qwen-tts', {
        torch: { pin: null, index_url: null, known_working_reference: { version: '2.10.0+cu128' } },
    });
    const warnings = [];
    const denied = pickTorchSpec([m], {}, warnings, 'cuda');
    assert.strictEqual(denied, null, 'no consent → no spec');
    const accepted = pickTorchSpec([m], { accept_reference_runtime: true }, warnings, 'cuda');
    assert.ok(accepted);
    assert.strictEqual(accepted.grade, 'reference');
    assert.strictEqual(accepted.spec.pin, '2.10.0+cu128', 'GPU branch keeps the CUDA build');
});

// ========================== 7/8. Resolver CPU ========================
test('7. resolver: torch 2.10.0+cpu matches CPU pin on cpu device', () => {
    const spec = { cpu: { pin: '2.10.0' }, pin: '2.10.0+cu128' };
    const v = resolver.checkTorchAgainst(spec, { version: '2.10.0+cpu' }, 'cpu');
    assert.strictEqual(v.status, 'installed');
    assert.strictEqual(v.grade, 'cpu-canonical');
    const mismatch = resolver.checkTorchAgainst(spec, { version: '2.9.0+cpu' }, 'cpu');
    assert.strictEqual(mismatch.status, 'incompatible');
    // GPU branch still compares against the CUDA pin
    const gpu = resolver.checkTorchAgainst(spec, { version: '2.10.0+cu128' }, 'cuda');
    assert.strictEqual(gpu.status, 'installed');
    const gpuWrong = resolver.checkTorchAgainst(spec, { version: '2.10.0+cpu' }, 'cuda');
    assert.strictEqual(gpuWrong.status, 'incompatible');
});

test('8. resolver: full CPU env resolution → runtime:torch installed', () => {
    const m = minimalManifest('audio/qwen-tts', {
        comfyuiPin: { tag: 'v0.27.0', repository: 'https://github.com/comfyanonymous/ComfyUI' },
    });
    const env = resolver.createEmptyEnvironment('/tmp/comfy');
    env.device = 'cpu';
    env.comfyui = { present: true, tag: 'v0.27.0', version: '0.27.0' };
    env.python = { version: '3.11.0' };
    env.torch = { version: '2.10.0+cpu' };
    env.nodejs = { version: '22.0.0' };
    const report = resolver.resolveInstallation({ manifests: [m], environment: env, mode: 'existing' });
    const torch = report.entries.find((e) => e.id === 'runtime:torch');
    assert.strictEqual(torch.status, 'installed', `torch status: ${torch.status} ${JSON.stringify(torch.notes)}`);
    assert.strictEqual(report.hardware.device, 'cpu');
});

// ========================== 9. Hardware notes ========================
test('9. summarizeHardware: CPU-only note present', () => {
    const hw = resolver.summarizeHardware({ gpu: null, device: 'cpu' }, []);
    assert.strictEqual(hw.device, 'cpu');
    assert.ok(hw.notes.some((n) => n.includes('CPU-only mode')));
    assert.strictEqual(hw.sufficient_vram, null);
});

// ========================== 10. Plan text banner =====================
test('10. plan text: CPU-only banner shown', () => {
    const m = minimalManifest('audio/qwen-tts');
    const env = resolver.createEmptyEnvironment('/tmp/comfy');
    env.device = 'cpu';
    const report = resolver.resolveInstallation({ manifests: [m], environment: env, mode: 'managed' });
    const plan = buildInstallPlan({ report, manifests: [m], decisions: { install_models: true, install_custom_nodes: true, workflows: 'all', worker_setup: true, worker_key_provided: true } });
    assert.ok(plan.plan_text.includes('CPU-ONLY MODE'), 'banner in plan text');
    assert.ok(plan.plan_text.includes('SIGNIFICANTLY'), 'performance warning in plan text');
    const detectStep = plan.steps.find((s) => s.id === 'detect-gpu');
    assert.strictEqual(detectStep.result.device, 'cpu');
});

// ========================== 11. Engine CPU install ===================
collectAsync('11. engine: managed CPU install → CPU torch index, --cpu flag, ownership recorded', async () => {
    const manifest1 = minimalManifest('audio/qwen-tts', {
        dependencies: [
            {
                id: 'custom-node:qwen3-tts', kind: 'custom_node', name: 'Qwen3TTS', requirement: 'required',
                install: { directory: 'qwen3-tts', source: { repository: 'https://github.com/wanaigc/ComfyUI-Qwen3-TTS', commit: '2ee1131' } },
                provides_classes: ['Qwen3TTSLoader'],
            },
            {
                id: 'model:tts', kind: 'model', name: 'tts-model', requirement: 'required',
                target_dir: 'models/TTS', filename: 'model.safetensors',
                source: { kind: 'huggingface', repository: 'Qwen/Qwen3-TTS', file_path: 'model.safetensors', verification: 'confirmed' },
                checksum: { algo: 'sha256', value: 'deadbeef'.repeat(8) },
            },
        ],
        workflows: {
            policy: 'editable-baseline',
            artifacts: [{
                id: 'workflow:tts', name: 'TTS baseline', target_dir: 'user/default/workflows/animastor/audio',
                filename: 'tts-qwen-narrator.json',
                baseline_sha256: require('crypto').createHash('sha256').update(JSON.stringify({ nodes: [] })).digest('hex'),
                source: { repository_path: 'backend/ai/workflows/tts-qwen-narrator.json' },
            }],
        },
    });
    const { io, calls, fs } = createMockIo({
        execResults: {
            'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 1, stdout: '', stderr: '' },
            'nvidia-smi': { code: 1, stdout: '', stderr: '' },
            'rocm-smi --showproductname': { code: 127, stdout: '' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
            'python3 --version': { code: 0, stdout: 'Python 3.11.0' },
            'python3 -m venv /tmp/comfy/venv': ({ fs: mfs }) => {
                mfs.mkdirSync('/tmp/comfy/venv/bin', { recursive: true });
                mfs.writeFileSync('/tmp/comfy/venv/bin/python', '#!/bin/sh');
                return { code: 0, stdout: '', stderr: '' };
            },
            '/tmp/comfy/venv/bin/python -c import torch; print(torch.__version__)': { code: 0, stdout: '2.10.0+cpu' },
            '/tmp/comfy/venv/bin/python --version': { code: 0, stdout: 'Python 3.11.0' },
            // git clone materializes ComfyUI in the memory fs
            'git clone https://github.com/comfyanonymous/ComfyUI /tmp/comfy': function ctx({ fs: mfs }) {
                mfs.mkdirSync('/tmp/comfy', { recursive: true });
                mfs.writeFileSync('/tmp/comfy/main.py', '# comfy');
                mfs.writeFileSync('/tmp/comfy/requirements.txt', 'torchsde\n');
                mfs.mkdirSync('/tmp/comfy/.git', { recursive: true });
                return { code: 0, stdout: '', stderr: '' };
            },
            'git -C /tmp/comfy checkout v0.27.0': { code: 0, stdout: '', stderr: '' },
            'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'https://github.com/comfyanonymous/ComfyUI' },
            'git -C /tmp/comfy rev-parse HEAD': { code: 0, stdout: 'abc123' },
            'git -C /tmp/comfy describe --tags --exact-match': { code: 0, stdout: 'v0.27.0' },
            'git clone https://github.com/wanaigc/ComfyUI-Qwen3-TTS /tmp/comfy/custom_nodes/qwen3-tts': ({ fs: mfs }) => {
                mfs.mkdirSync('/tmp/comfy/custom_nodes/qwen3-tts', { recursive: true });
                mfs.writeFileSync('/tmp/comfy/custom_nodes/qwen3-tts/requirements.txt', 'transformers\n');
                return { code: 0, stdout: '', stderr: '' };
            },
            'git -C /tmp/comfy/custom_nodes/qwen3-tts checkout 2ee1131': { code: 0, stdout: '', stderr: '' },
            'npm install --omit=dev --no-audit --no-fund': { code: 0, stdout: '', stderr: '' },
        },
        files: {
            '/tmp/repo/worker/worker/worker.cjs': '// worker',
            '/tmp/repo/worker/worker/package.json': '{}',
            '/tmp/repo/worker/worker/.env.example': 'HUB_URL=\n',
            '/tmp/repo/backend/ai/workflows/tts-qwen-narrator.json': JSON.stringify({ nodes: [] }),
        },
        httpResults: {
            'http://127.0.0.1:8188/system_stats': { status: 200, json: () => ({ system: {} }) },
            'http://127.0.0.1:8188/object_info': { status: 200, json: () => ({ Qwen3TTSLoader: {} }) },
            'https://animastor.in/api/v1/worker/verify': { status: 200, json: () => ({ verified: true, worker_id: 'w1', worker_type: 'audio' }) },
        },
    });
    const log = createMockLogger();
    const result = await runInstallation({
        manifests: [manifest1], mode: 'managed', io,
        roots: {
            comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/animastor/worker',
            statePath: '/tmp/comfy/.animastor-installer/install-state.json',
            repoRoot: '/tmp/repo', hubUrl: 'https://animastor.in/gpu',
        },
        decisions: { comfyui_update: 'yes', install_custom_nodes: true, install_models: true, workflows: 'all', worker_setup: true, worker_key_provided: true },
        secretProvider: async (name) => (name === 'ANIMASTOR_WORKER_TOKEN' ? 'wrk.test-token' : null),
        logger: log, crypto: require('crypto'),
        options: { startComfyui: true },
    });

    // CPU torch: pip install torch==2.10.0 from the CPU wheel index, and
    // torch BEFORE requirements.txt
    const pipCalls = calls.exec.filter((c) => c.cmd === '/tmp/comfy/venv/bin/python');
    const torchCall = pipCalls.find((c) => c.args.includes('torch==2.10.0'));
    assert.ok(torchCall, 'torch==2.10.0 installed via venv python');
    assert.ok(torchCall.args.includes('--index-url'), 'explicit index');
    assert.strictEqual(torchCall.args[torchCall.args.indexOf('--index-url') + 1], 'https://download.pytorch.org/whl/cpu', 'CPU wheel index');
    const reqCall = pipCalls.find((c) => c.args.includes('-r'));
    assert.ok(reqCall, 'requirements.txt installed');
    assert.ok(calls.exec.indexOf(torchCall) < calls.exec.indexOf(reqCall), 'torch before requirements.txt');
    assert.ok(!calls.exec.some((c) => JSON.stringify(c.args).includes('cu128') || JSON.stringify(c.args).includes('cu124')), 'no CUDA-specific installs');

    // CPU-only mode recorded everywhere
    assert.strictEqual(deviceOf(result), 'cpu');
    assert.ok(result.warnings.some((w) => w.includes('CPU-only mode')), 'CPU-only warning present');

    // Ownership manifest
    assert.ok(fs.existsSync('/tmp/comfy/.animastor-installer/install-state.json'), 'state written');
    const st = JSON.parse(fs.readFileSync('/tmp/comfy/.animastor-installer/install-state.json', 'utf8'));
    assert.strictEqual(st.device, 'cpu');
    assert.ok(st.components, 'components registry present');
    assert.ok(st.components.comfyui && st.components.comfyui.owned === true, 'comfyui owned');
    assert.ok(st.components.venv && st.components.venv.owned === true, 'venv owned');
    assert.strictEqual(st.components.custom_nodes.length, 1, 'custom node registered');
    assert.strictEqual(st.components.models.length, 1, 'model registered');
    assert.strictEqual(st.components.workflows.length, 1, 'workflow registered');
    assert.ok(st.components.worker && st.components.worker.owned === true, 'worker dir owned');
    assert.strictEqual(st.components.worker.env_created, true, '.env created by installer');

    assert.ok(!['blocked', 'failed'].includes(result.status), `unexpected status: ${result.status}\n${result.verification ? result.verification.text : ''}\n${JSON.stringify(result.warnings, null, 1)}\n${JSON.stringify(result.results, null, 1)}`);
});

function deviceOf(result) {
    return result.report && result.report.hardware ? result.report.hardware.device : null;
}

// ========================== 11b. startComfyUI device flag ============
test('11b. startComfyUI passes --cpu on CPU devices, plain args on CUDA', () => {
    const comfy = require('../src/installer/engine/comfyui');
    const spawned = [];
    const io = { fs: createMemoryFs({ '/c/main.py': '' }), spawnDaemon: (cmd, args) => { spawned.push(args); return 1; } };
    comfy.startComfyUI(io, { root: '/c', port: 8188, device: 'cpu' });
    assert.ok(spawned[0].includes('--cpu'), `cpu args: ${spawned[0].join(' ')}`);
    comfy.startComfyUI(io, { root: '/c', port: 8188, device: 'cuda' });
    assert.ok(!spawned[1].includes('--cpu'), `cuda args: ${spawned[1].join(' ')}`);
    comfy.startComfyUI(io, { root: '/c', port: 8188 });
    assert.ok(!spawned[2].includes('--cpu'), 'default (no device) keeps GPU behavior');
});

// ========================== 12. Verification report ==================
test('12. verification: CPU device → GPU line WARN, not FAIL', () => {
    const m = minimalManifest('audio/qwen-tts');
    const env = resolver.createEmptyEnvironment('/tmp/comfy');
    env.device = 'cpu';
    env.comfyui = { present: true, tag: 'v0.27.0', version: '0.27.0' };
    env.python = { version: '3.11.0' };
    env.torch = { version: '2.10.0+cpu' };
    env.nodejs = { version: '22.0.0' };
    env.worker = {
        worker_type: 'audio',
        bundle: { present: true, dir: '/tmp/worker', files: ['worker.cjs', 'package.json', '.env.example'] },
        env: { present: true, set_keys: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'] },
    };
    const report = resolver.resolveInstallation({ manifests: [m], environment: env, mode: 'existing' });
    const ver = buildVerificationReport({ report, live: {} });
    assert.notStrictEqual(ver.status, 'FAIL', `CPU-only machine must not hard-fail on GPU absence:\n${ver.text}`);
    const gpuLine = ver.lines.find((l) => l.includes('GPU') && !l.includes('VRAM') && !l.includes('Hub'));
    assert.ok(gpuLine.startsWith('!'), `GPU line is a warning: ${gpuLine}`);
    assert.ok(gpuLine.includes('CPU-only mode'));
});

// ========================== 13. Detection rendering ==================
test('13. renderDetection announces CPU-only mode', () => {
    const lines = probe.renderDetection({ gpu: null, device: 'cpu', cuda: null, comfyui: null, python: null, torch: null, nodejs: null }).split('\n');
    assert.ok(lines.some((l) => l.includes('CPU-only mode')), 'CPU-only line');
    assert.ok(lines.some((l) => l.toLowerCase().includes('warning')), 'low-performance warning');
});

// ========================== 14. State registry =======================
test('14. state: addOwnedComponent is idempotent per path; normalizeState restores registry', () => {
    const st = state.emptyState({ mode: 'managed', profiles: ['audio/qwen-tts'] });
    state.addOwnedComponent(st, 'models', { id: 'm1', path: '/x/model.safetensors' });
    state.addOwnedComponent(st, 'models', { id: 'm1', path: '/x/model.safetensors' });
    assert.strictEqual(st.components.models.length, 1, 'dedup by path');
    assert.throws(() => state.addOwnedComponent(st, 'bogus', { path: '/x' }), 'unknown kind rejected');
    const restored = state.normalizeState({ state_version: 1, artifacts: {} });
    assert.ok(restored.components && Array.isArray(restored.components.models), 'normalizeState restores missing registry');
});

// ---------------------------------------------------------------------------

Promise.all(testPromises).then(() => {
    console.log(`\nCPU installer tests: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
});
