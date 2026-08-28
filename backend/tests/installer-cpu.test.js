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
 * 14. state registry idempotency
 * 15. resolveAndPlan with the REAL audio/qwen-tts manifest: pre- and
 *     post-prompt plans both carry a resolution report (regression for
 *     "fatal: buildInstallPlan requires a resolution report"); CPU torch
 *     resolution survives the rebuild
 * 16a. D1: real manifest install source is reference-grade, needs consent
 * 16b. engine without accept_reference_runtime → BLOCKED, nothing cloned
 * 16. engine: full managed CPU install from the REAL audio/qwen-tts
 *     manifest — D1 consent honored, CPU torch pin/index, ensurepip
 *     bootstrap, ModelScope repo downloads, token hygiene
 * 16c/16d. installComfyUI stashes pre-written install-state metadata so
 *     git clone gets an empty destination (and restores it on failure)
 *
 * All external operations are mocked (memory fs + scripted io). No GPU,
 * network, or real downloads.
 */

const assert = require('assert');
const path = require('path');
const realFs = require('fs');
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

// ========================== 15. resolveAndPlan real manifest ==========
// Regression for the production crash: the interactive CLI rebuilt the plan
// after the prompts with the report under the WRONG key, so buildInstallPlan
// threw "buildInstallPlan requires a resolution report". resolveAndPlan is
// now the only call shape — exercised here with the REAL manifest.
collectAsync('15. resolveAndPlan: real audio/qwen-tts manifest — pre/post-prompt plans both carry a report', async () => {
    const cli = require('../src/installer/cli');
    const manifestMod = require('../src/installer/install-manifest');
    const manifests = [manifestMod.loadManifest('audio/qwen-tts')];
    const env = resolver.createEmptyEnvironment('/tmp/comfy');
    env.device = 'cpu';
    env.python = { version: '3.10.12' };
    env.nodejs = { version: '22.0.0' };

    // pre-prompt: no decisions yet → must list interactive decisions, not crash
    const pre = cli.resolveAndPlan({ manifests, env, mode: 'managed', decisions: {} });
    assert.ok(pre.report && Array.isArray(pre.report.entries), 'resolution report present');
    assert.ok(pre.plan && Array.isArray(pre.plan.steps), 'plan present');
    assert.ok(pre.plan.awaiting_decisions.length > 0, `interactive decisions listed: ${pre.plan.awaiting_decisions.join(', ')}`);
    assert.ok(pre.plan.plan_text.includes('CPU-ONLY MODE'), 'CPU banner in plan text');
    const keyStep = pre.plan.steps.find((s) => s.id === 'worker-key');
    assert.ok(keyStep, 'worker-key step present');
    assert.strictEqual(keyStep.kind, 'secret-prompt', 'worker-key is a secret prompt (never a Yes/No confirm)');
    assert.ok(keyStep.secret_keys.includes('ANIMASTOR_WORKER_TOKEN'), 'secret key named');

    // the exact decision set the interactive CLI records after the prompts
    const decisions = {
        install_custom_nodes: true,
        install_models: true,
        workflows: 'all',
        worker_setup: true,
        worker_key_provided: true,
        accept_reference_runtime: true,
    };
    const post = cli.resolveAndPlan({ manifests, env, mode: 'managed', decisions });
    assert.ok(post.report && Array.isArray(post.report.entries), 'post-prompt report present');
    assert.strictEqual(post.plan.awaiting_decisions.length, 0, `post-prompt plan fully resolved, still awaiting: ${post.plan.awaiting_decisions.join(', ')}`);
    assert.strictEqual(post.plan.blocked.length, 0, `not blocked: ${JSON.stringify(post.plan.blocked)}`);

    // user selections survived the rebuild
    const nodesStep = post.plan.steps.find((s) => s.id === 'custom-nodes');
    const modelsStep = post.plan.steps.find((s) => s.id === 'models');
    const wfStep = post.plan.steps.find((s) => s.id === 'workflows');
    assert.strictEqual(nodesStep.decision, 'yes', 'custom nodes approved');
    assert.strictEqual(modelsStep.decision, 'yes', 'models approved');
    assert.strictEqual(wfStep.decision, 'all', 'workflows approved');
    assert.strictEqual(nodesStep.missing.length, 1, 'only the required node is installed (optional manager excluded)');

    // CPU torch resolution survives the rebuild (engine's source of truth)
    const picked = pickTorchSpec(manifests, decisions, [], 'cpu');
    assert.ok(picked, 'torch spec picked for cpu device');
    assert.strictEqual(picked.grade, 'cpu-canonical');
    assert.strictEqual(picked.spec.pin, '2.10.0');
    assert.strictEqual(picked.spec.index_url, 'https://download.pytorch.org/whl/cpu');
});

// ========================== 16a. D1 install source =====================
test('16a. D1: real manifest ComfyUI source is reference-grade and requires consent', () => {
    const comfy = require('../src/installer/engine/comfyui');
    const m = require('../src/installer/install-manifest').loadManifest('audio/qwen-tts');
    const src = comfy.pickInstallSource(m);
    assert.ok(src, 'install source exists (known-working reference)');
    assert.strictEqual(src.grade, 'reference');
    assert.strictEqual(src.needs_consent, true, 'reference grade always needs explicit consent');
    assert.strictEqual(src.source.repository, 'https://github.com/rajsingh1-dev/ComfyUI.git');
    assert.strictEqual(src.source.commit, 'c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11');
});

// Shared mock-io factory for the real-manifest engine runs (16b / 16).
function createRealManifestEngineIo() {
    const repoRootReal = path.resolve(__dirname, '..', '..');
    return createMockIo({
        execResults: {
            'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 1, stdout: '', stderr: 'no devices' },
            'nvidia-smi': { code: 1, stdout: '', stderr: 'no devices' },
            'rocm-smi --showproductname': { code: 127, stdout: '', stderr: 'not found' },
            lspci: { code: 1, stdout: '', stderr: 'not found' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
            'python3 --version': { code: 0, stdout: 'Python 3.10.12' },
            'python3 -m venv /tmp/comfy/venv': ({ fs: mfs }) => {
                mfs.mkdirSync('/tmp/comfy/venv/bin', { recursive: true });
                mfs.writeFileSync('/tmp/comfy/venv/bin/python', '#!/bin/sh');
                return { code: 0, stdout: '', stderr: '' };
            },
            // venv WITHOUT pip (Ubuntu VPS without python3-venv) → ensurepip path
            '/tmp/comfy/venv/bin/python -m pip --version': { code: 1, stdout: '', stderr: 'No module named pip' },
            '/tmp/comfy/venv/bin/python -m ensurepip --upgrade': { code: 0, stdout: '', stderr: '' },
            '/tmp/comfy/venv/bin/python --version': { code: 0, stdout: 'Python 3.10.12' },
            '/tmp/comfy/venv/bin/python -c import torch; print(torch.__version__)': { code: 0, stdout: '2.10.0+cpu' },
            'git clone https://github.com/rajsingh1-dev/ComfyUI.git /tmp/comfy': ({ fs: mfs }) => {
                mfs.mkdirSync('/tmp/comfy', { recursive: true });
                mfs.writeFileSync('/tmp/comfy/main.py', '# comfy fork');
                mfs.writeFileSync('/tmp/comfy/requirements.txt', 'torchsde\n');
                mfs.mkdirSync('/tmp/comfy/.git', { recursive: true });
                return { code: 0, stdout: '', stderr: '' };
            },
            'git -C /tmp/comfy checkout c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11': { code: 0, stdout: '', stderr: '' },
            'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'https://github.com/rajsingh1-dev/ComfyUI.git' },
            'git -C /tmp/comfy rev-parse HEAD': { code: 0, stdout: 'c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11' },
            'git -C /tmp/comfy describe --tags --exact-match': { code: 1, stdout: '', stderr: 'no tag' },
            'git clone https://github.com/wanaigc/ComfyUI-Qwen3-TTS /tmp/comfy/custom_nodes/qwen3-tts': ({ fs: mfs }) => {
                mfs.mkdirSync('/tmp/comfy/custom_nodes/qwen3-tts', { recursive: true });
                mfs.writeFileSync('/tmp/comfy/custom_nodes/qwen3-tts/requirements.txt', 'transformers\n');
                return { code: 0, stdout: '', stderr: '' };
            },
            'git -C /tmp/comfy/custom_nodes/qwen3-tts checkout 2ee1131': { code: 0, stdout: '', stderr: '' },
            'npm install --omit=dev --no-audit --no-fund': { code: 0, stdout: '', stderr: '' },
        },
        files: {
            '/tmp/repo/worker/worker/worker.cjs': '// worker v2.0.0',
            '/tmp/repo/worker/worker/worker-env.cjs': '// env',
            '/tmp/repo/worker/worker/worker-cleanup.cjs': '// cleanup',
            '/tmp/repo/worker/worker/worker-cleanup-journal.cjs': '// journal',
            '/tmp/repo/worker/worker/package.json': '{"name":"animastor-worker"}',
            '/tmp/repo/worker/worker/package-lock.json': '{}',
            '/tmp/repo/worker/worker/.env.example': 'HUB_URL=\nANIMASTOR_WORKER_TOKEN=\nWORKER_TYPE=\nWORKER_ID=\n',
            // canonical production workflows — real content so baseline_sha256 matches
            '/tmp/repo/backend/ai/workflows/tts-qwen-narrator.json': realFs.readFileSync(path.join(repoRootReal, 'backend/ai/workflows/tts-qwen-narrator.json'), 'utf8'),
            '/tmp/repo/backend/ai/workflows/tts-qwen-dialogue.json': realFs.readFileSync(path.join(repoRootReal, 'backend/ai/workflows/tts-qwen-dialogue.json'), 'utf8'),
        },
        httpResults: {
            // ModelScope listing — real API shape: Data.Files, tree recursion via Root=
            'https://modelscope.cn/api/v1/models/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/repo/files?Revision=master': {
                status: 200,
                json: () => ({ Code: 200, Data: { Files: [
                    { Name: 'model.safetensors', Path: 'model.safetensors', Type: 'blob', Size: 0, Sha256: '' },
                    { Name: 'speech_tokenizer', Path: 'speech_tokenizer', Type: 'tree', Size: 0 },
                ] } }),
            },
            'https://modelscope.cn/api/v1/models/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/repo/files?Revision=master&Root=speech_tokenizer': {
                status: 200,
                json: () => ({ Code: 200, Data: { Files: [
                    { Name: 'model.safetensors', Path: 'speech_tokenizer/model.safetensors', Type: 'blob', Size: 0, Sha256: '' },
                ] } }),
            },
            'https://modelscope.cn/api/v1/models/Qwen/Qwen3-TTS-12Hz-1.7B-Base/repo/files?Revision=master': {
                status: 200,
                json: () => ({ Code: 200, Data: { Files: [
                    { Name: 'model.safetensors', Path: 'model.safetensors', Type: 'blob', Size: 0, Sha256: '' },
                    { Name: 'speech_tokenizer', Path: 'speech_tokenizer', Type: 'tree', Size: 0 },
                ] } }),
            },
            'https://modelscope.cn/api/v1/models/Qwen/Qwen3-TTS-12Hz-1.7B-Base/repo/files?Revision=master&Root=speech_tokenizer': {
                status: 200,
                json: () => ({ Code: 200, Data: { Files: [
                    { Name: 'model.safetensors', Path: 'speech_tokenizer/model.safetensors', Type: 'blob', Size: 0, Sha256: '' },
                ] } }),
            },
            'https://animastor.in/api/v1/worker/verify': { status: 200, json: () => ({ verified: true, worker_id: 'w-cpu-test', worker_type: 'audio' }) },
            'http://127.0.0.1:8188/system_stats': { status: 200, json: () => ({ system: {} }) },
            'http://127.0.0.1:8188/object_info': {
                status: 200,
                json: () => ({
                    Qwen3TTSVoiceDesign: {}, Qwen3TTSLoader: {}, Qwen3TTSVoiceClonePrompt: {},
                    Qwen3TTSRoleBank: {}, Qwen3TTSAdvancedDialogue: {}, Qwen3TTSScriptProcessor: {},
                    SaveAudioMP3: {},
                }),
            },
        },
    });
}

// ========================== 16b. D1 consent gate =======================
collectAsync('16b. engine: real manifest WITHOUT accept_reference_runtime → blocked, nothing cloned', async () => {
    const manifestMod = require('../src/installer/install-manifest');
    const manifests = [manifestMod.loadManifest('audio/qwen-tts')];
    const { io, calls } = createRealManifestEngineIo();
    const log = createMockLogger();
    const result = await runInstallation({
        manifests, mode: 'managed', io,
        roots: {
            comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/animastor/worker',
            statePath: '/tmp/comfy/.animastor-installer/install-state.json',
            repoRoot: '/tmp/repo', hubUrl: 'https://animastor.in/gpu',
        },
        decisions: {
            install_custom_nodes: false, install_models: false, workflows: 'none',
            worker_setup: false, worker_key_provided: false,
        },
        logger: log, crypto: require('crypto'),
        options: {},
    });
    assert.strictEqual(result.status, 'blocked', `expected blocked, got ${result.status}`);
    const d1 = result.blocked.find((b) => b.step === 'comfyui-update');
    assert.ok(d1, 'comfyui step blocked');
    assert.ok(d1.reason.includes('accept_reference_runtime'), `D1 reason names the consent decision: ${d1.reason}`);
    assert.ok(d1.reason.includes('rajsingh1-dev'), 'D1 reason names the reference source');
    assert.ok(!calls.exec.some((c) => c.cmd === 'git' && c.args[0] === 'clone' && String(c.args[1]).includes('rajsingh1-dev')), 'reference ComfyUI was NOT cloned without consent');
});

// ========================== 16. Engine real-manifest CPU install =======
collectAsync('16. engine: managed CPU install from REAL audio/qwen-tts manifest (D1 consent, CPU torch, ModelScope, token hygiene)', async () => {
    const manifestMod = require('../src/installer/install-manifest');
    const manifests = [manifestMod.loadManifest('audio/qwen-tts')];
    const DUMMY_TOKEN = 'wrk.cpu-dummy-token';
    const { io, calls, fs } = createRealManifestEngineIo();
    const log = createMockLogger();
    const result = await runInstallation({
        manifests, mode: 'managed', io,
        roots: {
            comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/animastor/worker',
            statePath: '/tmp/comfy/.animastor-installer/install-state.json',
            repoRoot: '/tmp/repo', hubUrl: 'https://animastor.in/gpu',
        },
        decisions: {
            comfyui_update: 'yes', install_custom_nodes: true, install_models: true,
            workflows: 'all', worker_setup: true, worker_key_provided: true,
            accept_reference_runtime: true,
        },
        secretProvider: async (name) => (name === 'ANIMASTOR_WORKER_TOKEN' ? DUMMY_TOKEN : null),
        logger: log, crypto: require('crypto'),
        options: { startComfyui: true },
    });

    // D1 consent honored — reference fork cloned at the audited commit
    assert.strictEqual(result.blocked.length, 0, `not blocked: ${JSON.stringify(result.blocked)}`);
    assert.ok(calls.exec.some((c) => c.cmd === 'git' && c.args.join(' ') === 'clone https://github.com/rajsingh1-dev/ComfyUI.git /tmp/comfy'), 'reference ComfyUI cloned');
    assert.ok(calls.exec.some((c) => c.cmd === 'git' && c.args.join(' ') === '-C /tmp/comfy checkout c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11'), 'reference commit checked out');

    // CPU torch: ensurepip bootstrap + pinned CPU wheel, no CUDA builds
    assert.ok(calls.exec.some((c) => c.args && c.args.join(' ') === '-m ensurepip --upgrade'), 'pip bootstrapped via ensurepip (pip-less venv)');
    const pipCalls = calls.exec.filter((c) => c.cmd === '/tmp/comfy/venv/bin/python');
    const torchCall = pipCalls.find((c) => c.args.includes('torch==2.10.0'));
    assert.ok(torchCall, 'torch==2.10.0 installed via venv python');
    assert.strictEqual(torchCall.args[torchCall.args.indexOf('--index-url') + 1], 'https://download.pytorch.org/whl/cpu', 'CPU wheel index');
    assert.ok(!calls.exec.some((c) => JSON.stringify(c.args).includes('cu128') || JSON.stringify(c.args).includes('cu124')), 'no CUDA-specific installs');
    // requirements.txt must be installed UNDER a torch constraint: unpinned
    // torch/torchvision/torchaudio in requirements would otherwise replace the
    // pinned CPU torch with the latest (CUDA) build from PyPI
    const reqCall = pipCalls.find((c) => c.args.includes('-r'));
    assert.ok(reqCall, 'requirements.txt installed');
    const cIdx = reqCall.args.indexOf('-c');
    assert.ok(cIdx !== -1, 'requirements installed under a constraints file');
    const constraintPath = reqCall.args[cIdx + 1];
    assert.strictEqual(fs.readFileSync(constraintPath, 'utf8').trim(), 'torch==2.10.0', 'constraint pins torch');
    assert.strictEqual(reqCall.args[reqCall.args.indexOf('--index-url') + 1], 'https://download.pytorch.org/whl/cpu', 'requirements prefer the pinned index');

    // Models: both ModelScope repos preloaded incl. nested speech_tokenizer file
    const modelResults = result.results.models;
    assert.strictEqual(modelResults.length, 2, `two model repos: ${JSON.stringify(modelResults)}`);
    for (const mr of modelResults) {
        assert.strictEqual(mr.status, 'downloaded', `${mr.id}: ${mr.status} ${mr.reason || ''}`);
        const paths = (mr.files || []).map((f) => f.path);
        assert.ok(paths.includes('model.safetensors'), `${mr.id} top-level file`);
        assert.ok(paths.includes('speech_tokenizer/model.safetensors'), `${mr.id} nested file via tree recursion`);
    }
    const downloadUrls = calls.http.filter((c) => c.op === 'download').map((c) => c.url);
    assert.ok(downloadUrls.some((u) => u.includes('/repo?Revision=master&FilePath=model.safetensors')), 'ModelScope download URL shape');
    assert.ok(downloadUrls.some((u) => u.includes('FilePath=speech_tokenizer%2Fmodel.safetensors')), 'nested file downloaded via FilePath');

    // Workflows: canonical repo content, sha256-verified against the manifest
    assert.strictEqual(result.results.workflows.length, 2, 'two workflows');
    for (const wf of result.results.workflows) {
        assert.strictEqual(wf.status, 'installed', `${wf.id}: ${wf.status} ${wf.reason || ''}`);
        assert.strictEqual(wf.grade, 'sha256-verified');
    }

    // CPU-only recorded in state; components registry complete
    assert.ok(!['blocked', 'failed'].includes(result.status), `unexpected status: ${result.status}\n${result.verification ? result.verification.text : ''}\n${JSON.stringify(result.warnings, null, 1)}`);
    assert.strictEqual(deviceOf(result), 'cpu');
    const st = JSON.parse(fs.readFileSync('/tmp/comfy/.animastor-installer/install-state.json', 'utf8'));
    assert.strictEqual(st.device, 'cpu');
    assert.deepStrictEqual(st.torch, { device: 'cpu', grade: 'cpu-canonical', pin: '2.10.0' });
    assert.strictEqual(st.components.comfyui.owned, true);
    assert.strictEqual(st.components.comfyui.ref, 'c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11');
    assert.strictEqual(st.components.venv.owned, true);
    assert.strictEqual(st.components.custom_nodes.length, 1, 'required node only (optional manager not auto-installed)');
    assert.strictEqual(st.components.models.length, 2, 'both model repos registered');
    assert.strictEqual(st.components.workflows.length, 2, 'both workflows registered');
    assert.strictEqual(st.components.worker.env_created, true, '.env created by installer');

    // Worker registration verified against the hub
    assert.ok(result.results.registration && result.results.registration.registered === true, `registration: ${JSON.stringify(result.results.registration)}`);

    // Token hygiene: value in .env only — never in logs or state
    const envText = fs.readFileSync('/tmp/animastor/worker/.env', 'utf8');
    assert.ok(envText.includes(`ANIMASTOR_WORKER_TOKEN=${DUMMY_TOKEN}`), 'token written to .env');
    assert.ok(!log.lines.some((l) => l.includes(DUMMY_TOKEN)), 'token never appears in logs');
    assert.ok(!fs.readFileSync('/tmp/comfy/.animastor-installer/install-state.json', 'utf8').includes(DUMMY_TOKEN), 'token never persisted to state');

    // CPU-only machine must not hard-fail verification on GPU absence
    assert.notStrictEqual(result.verification.status, 'FAIL', `verification:\n${result.verification.text}`);
});

// ========================== 16c/16d. clone vs install-state ============
// The engine persists install state into <root>/.animastor-installer/ BEFORE
// cloning ComfyUI (resume support), but real git refuses a non-empty
// destination. installComfyUI must stash the metadata aside and restore it.
test('16c. installComfyUI stashes installer metadata so git gets an empty destination, then restores it', () => {
    const comfy = require('../src/installer/engine/comfyui');
    const { io, fs } = createMockIo({
        files: { '/tmp/comfy/.animastor-installer/install-state.json': '{"state_version":1}' },
        execResults: {
            'git clone https://github.com/x/ComfyUI.git /tmp/comfy': ({ fs: mfs }) => {
                // emulate real git: a non-empty destination is refused
                if (mfs.existsSync('/tmp/comfy') && mfs.readdirSync('/tmp/comfy').length > 0) {
                    return { code: 128, stdout: '', stderr: "fatal: destination path '/tmp/comfy' already exists and is not an empty directory." };
                }
                mfs.mkdirSync('/tmp/comfy', { recursive: true });
                mfs.writeFileSync('/tmp/comfy/main.py', '# comfy');
                mfs.mkdirSync('/tmp/comfy/.git', { recursive: true });
                return { code: 0, stdout: '', stderr: '' };
            },
            'git -C /tmp/comfy checkout abc123': { code: 0, stdout: '', stderr: '' },
        },
    });
    const res = comfy.installComfyUI(io, { root: '/tmp/comfy', source: { repository: 'https://github.com/x/ComfyUI.git', commit: 'abc123' } });
    assert.strictEqual(res.ref, 'abc123');
    assert.ok(fs.existsSync('/tmp/comfy/main.py'), 'ComfyUI cloned');
    assert.ok(fs.existsSync('/tmp/comfy/.animastor-installer/install-state.json'), 'install state restored after the clone');
    assert.strictEqual(fs.readFileSync('/tmp/comfy/.animastor-installer/install-state.json', 'utf8'), '{"state_version":1}');
});

test('16d. installComfyUI restores metadata to the original root when the clone fails', () => {
    const comfy = require('../src/installer/engine/comfyui');
    const { io, fs } = createMockIo({
        files: { '/tmp/comfy/.animastor-installer/install-state.json': '{"state_version":1}' },
        execResults: {
            'git clone https://github.com/x/ComfyUI.git /tmp/comfy': { code: 128, stdout: '', stderr: 'fatal: network unreachable' },
        },
    });
    assert.throws(
        () => comfy.installComfyUI(io, { root: '/tmp/comfy', source: { repository: 'https://github.com/x/ComfyUI.git', commit: 'abc123' } }),
        /git clone failed/,
    );
    assert.ok(fs.existsSync('/tmp/comfy/.animastor-installer/install-state.json'), 'install state restored after the failed clone (resume still possible)');
});

// ---------------------------------------------------------------------------

Promise.all(testPromises).then(() => {
    console.log(`\nCPU installer tests: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
});
