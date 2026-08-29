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
collectAsync('16b. engine: real manifest WITHOUT accept_reference_runtime → awaiting decisions (consent not given)', async () => {
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
            // accept_reference_runtime deliberately omitted
        },
        logger: log, crypto: require('crypto'),
        options: {},
    });
    // Without consent the plan has an unresolved comfyui-update prompt;
    // the engine returns 'awaiting_decisions' (not 'blocked' — the user is
    // asked, not told no).
    assert.strictEqual(result.status, 'awaiting_decisions', `expected awaiting_decisions, got ${result.status}`);
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

// ========================== 17. installComfyUI adopt partial root ===========
// When the installer root already contains venv/models/custom_nodes from an
// earlier run but ComfyUI was never cloned (main.py missing), installComfyUI
// must ADOPT the root in place (git init + fetch + checkout) instead of
// refusing to touch a non-empty directory.
test('17a. installComfyUI adopts a partial installer root (no main.py, state file present)', () => {
    const comfy = require('../src/installer/engine/comfyui');
    const { io, fs } = createMockIo({
        files: {
            '/tmp/comfy/.animastor-installer/install-state.json': '{"state_version":1}',
            '/tmp/comfy/venv/bin/python': '#!/bin/sh',
        },
        execResults: {
            'git -C /tmp/comfy init': { code: 0, stdout: 'Initialized empty Git repository', stderr: '' },
            'git -C /tmp/comfy remote add origin https://github.com/x/ComfyUI.git': { code: 0, stdout: '', stderr: '' },
            'git -C /tmp/comfy fetch --tags origin': { code: 0, stdout: ' * [new branch]', stderr: '' },
            'git -C /tmp/comfy checkout abc123': ({ fs: mfs }) => {
                mfs.writeFileSync('/tmp/comfy/main.py', '# comfy fork');
                mfs.mkdirSync('/tmp/comfy/.git/info', { recursive: true });
                return { code: 0, stdout: '', stderr: '' };
            },
        },
    });
    const res = comfy.installComfyUI(io, { root: '/tmp/comfy', source: { repository: 'https://github.com/x/ComfyUI.git', commit: 'abc123' } });
    assert.strictEqual(res.ref, 'abc123');
    assert.strictEqual(res.adopted, true, 'adopted flag set');
    assert.ok(fs.existsSync('/tmp/comfy/main.py'), 'main.py created by checkout');
    // existing venv preserved
    assert.ok(fs.existsSync('/tmp/comfy/venv/bin/python'), 'pre-existing venv untouched');
    // .git/info/exclude should contain installer metadata
    const exclude = fs.readFileSync('/tmp/comfy/.git/info/exclude', 'utf8');
    assert.ok(exclude.includes('.animastor-installer/'), 'installer metadata excluded from git');
});

test('17b. installComfyUI adopt fails when git checkout conflicts with existing content', () => {
    const comfy = require('../src/installer/engine/comfyui');
    const { io, fs } = createMockIo({
        files: {
            '/tmp/comfy/.animastor-installer/install-state.json': '{"state_version":1}',
        },
        execResults: {
            'git -C /tmp/comfy init': { code: 0, stdout: '', stderr: '' },
            'git -C /tmp/comfy remote add origin https://github.com/x/ComfyUI.git': { code: 0, stdout: '', stderr: '' },
            'git -C /tmp/comfy fetch --tags origin': { code: 0, stdout: '', stderr: '' },
            // checkout fails because repo tracks a file at the same path as an existing file
            'git -C /tmp/comfy checkout abc123': { code: 128, stdout: '', stderr: 'error: The following untracked working tree files would be overwritten by merge: main.py' },
        },
    });
    assert.throws(
        () => comfy.installComfyUI(io, { root: '/tmp/comfy', source: { repository: 'https://github.com/x/ComfyUI.git', commit: 'abc123' } }),
        /git checkout abc123 failed/,
    );
});

test('17c. installComfyUI still refuses a non-empty root WITHOUT installer state (not an installer partial)', () => {
    const comfy = require('../src/installer/engine/comfyui');
    const { io } = createMockIo({
        files: { '/tmp/comfy/venv/bin/python': '#!/bin/sh' },
    });
    assert.throws(
        () => comfy.installComfyUI(io, { root: '/tmp/comfy', source: { repository: 'https://github.com/x/ComfyUI.git', commit: 'abc123' } }),
        /not empty/,
    );
});

// ========================== 18. fetchHubWorkerBundle =====================
collectAsync('18a. fetchHubWorkerBundle downloads, verifies sha256, and extracts the hub bundle', async () => {
    const workerMod = require('../src/installer/engine/worker');
    const tarGzContent = Buffer.from('mock-tarball');
    const fakeSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const { io, fs } = createMockIo({
        files: { '/tmp/wdir/.env': 'HUB_URL=https://x\n' },
        httpResults: {
            'https://animastor.in/gpu/worker-bundle/sha256': { status: 200, json: () => ({ sha256: fakeSha }) },
            'https://animastor.in/gpu/worker-bundle': async ({ dest }) => {
                fs.writeFileSync(dest, tarGzContent);
                return { status: 200, bytes: 1024, total: 1024, resumed: false };
            },
        },
    });
    // Override http.download and hashFile to use the real-mock fs
    io.http.download = async ({ url, dest }) => {
        fs.writeFileSync(dest, tarGzContent);
        return { status: 200, bytes: 1024, total: 1024, resumed: false };
    };
    io.hashFile = async () => fakeSha;
    io.exec = (cmd, args) => {
        if (cmd === 'tar' && args[0] === '-xzf' && args[2] === '-C') {
            const extractDir = args[3] || '/tmp/bundle-test';
            const workerDir = `${extractDir}/animastor-worker`;
            fs.mkdirSync(workerDir, { recursive: true });
            for (const f of ['worker.cjs', 'worker-env.cjs', 'worker-cleanup.cjs', 'worker-cleanup-journal.cjs', 'package.json', 'package-lock.json', '.env.example']) {
                fs.writeFileSync(`${workerDir}/${f}`, `// ${f}`);
            }
            return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
    };
    const result = await workerMod.fetchHubWorkerBundle(io, { hubUrl: 'https://animastor.in/gpu', tmpRoot: '/tmp/bundle-test' });
    assert.ok(result.bundleDir, `bundleDir set: ${result.reason || 'ok'}`);
    assert.ok(result.bundleDir.includes('animastor-worker'), `bundleDir contains animastor-worker: ${result.bundleDir}`);
    assert.ok(fs.existsSync(`${result.bundleDir}/worker.cjs`), 'extracted files present');
});

collectAsync('18b. fetchHubWorkerBundle returns failure reason when hub sha256 mismatches', async () => {
    const workerMod = require('../src/installer/engine/worker');
    const { io, fs } = createMockIo({ files: {} });
    io.http = {
        async download({ dest }) { fs.writeFileSync(dest, 'data'); return { status: 200, bytes: 4, total: 4, resumed: false }; },
        async fetchJson(url) { if (url.includes('sha256')) return { status: 200, json: { sha256: 'wronghash' } }; return { status: 200, json: {} }; },
    };
    io.hashFile = async () => 'correcthash';
    const result = await workerMod.fetchHubWorkerBundle(io, { hubUrl: 'https://x', tmpRoot: '/tmp/bundle-test2' });
    assert.ok(!result.bundleDir, 'no bundleDir on sha256 mismatch');
    assert.ok(result.reason.includes('sha256 mismatch'), `reason: ${result.reason}`);
});

// ========================== 19. installWorkerBundle with bundleDir =========
test('19. installWorkerBundle uses bundleDir when repo bundle dir is empty', () => {
    const workerMod = require('../src/installer/engine/worker');
    const manifest = {
        worker_bundle: { files: ['worker.cjs', 'package.json', '.env.example'] },
    };
    const bundleDir = '/tmp/extracted-bundle/animastor-worker';
    const { io, fs } = createMockIo({
        files: {
            [`${bundleDir}/worker.cjs`]: '// worker v2.0.0',
            [`${bundleDir}/package.json`]: '{"name":"animastor-worker"}',
            [`${bundleDir}/.env.example`]: 'HUB_URL=\n',
        },
    });
    const result = workerMod.installWorkerBundle(io, {
        workerDir: '/tmp/wdir', manifest, repoRoot: '/tmp/nonexistent-repo',
        bundleDir, hubUrl: 'https://x', httpFetchText: null,
    });
    assert.strictEqual(result.status, 'installed', `status: ${result.status} ${result.reason || ''}`);
    assert.ok(result.files_installed.includes('worker.cjs'), 'worker.cjs installed from bundleDir');
    assert.ok(fs.existsSync('/tmp/wdir/worker.cjs'), 'worker.cjs on disk');
});

// ========================== 20. startWorker ==============================
test('20a. startWorker returns alive=true when process is running', () => {
    const workerMod = require('../src/installer/engine/worker');
    const { io, fs } = createMockIo({
        files: {
            '/tmp/wdir/worker.cjs': '// worker',
            '/tmp/wdir/package.json': '{}',
        },
    });
    // Make syntax check succeed
    io.exec = (cmd, args, opts) => {
        if (cmd === 'node' && args[0] === '--check') return { code: 0, stdout: '', stderr: '' };
        if (cmd === 'node' && args[0] === '-e') return { code: 0, stdout: '/tmp/wdir', stderr: '' };
        if (cmd === 'sleep') return { code: 0, stdout: '', stderr: '' };
        if (cmd === 'ps') return { code: 0, stdout: 'node worker.cjs', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
    };
    const result = workerMod.startWorker(io, { workerDir: '/tmp/wdir' });
    assert.strictEqual(result.started, true, 'started');
    assert.strictEqual(result.alive, true, 'alive after grace period');
});

test('20b. startWorker returns alive=false when process dies immediately', () => {
    const workerMod = require('../src/installer/engine/worker');
    const { io, fs } = createMockIo({
        files: {
            '/tmp/wdir/worker.cjs': '// worker',
            '/tmp/wdir/package.json': '{}',
        },
    });
    io.exec = (cmd, args) => {
        if (cmd === 'node' && args[0] === '--check') return { code: 0, stdout: '', stderr: '' };
        if (cmd === 'node' && args[0] === '-e') return { code: 0, stdout: '/tmp/wdir', stderr: '' };
        if (cmd === 'sleep') return { code: 0, stdout: '', stderr: '' };
        if (cmd === 'ps') return { code: 1, stdout: '', stderr: 'no such process' };
        return { code: 0, stdout: '', stderr: '' };
    };
    const result = workerMod.startWorker(io, { workerDir: '/tmp/wdir' });
    assert.strictEqual(result.started, true, 'started');
    assert.strictEqual(result.alive, false, 'not alive');
    assert.ok(result.reason.includes('exited immediately'), `reason: ${result.reason}`);
});

test('20c. startWorker detects an already-running worker for this dir — no double spawn', () => {
    const workerMod = require('../src/installer/engine/worker');
    const spawned = [];
    const { io } = createMockIo({
        files: {
            '/tmp/wdir/worker.cjs': '// worker',
            '/tmp/wdir/package.json': '{}',
        },
    });
    io.spawnDaemon = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return 424242; };
    io.exec = (cmd, args) => {
        if (cmd === 'pgrep') return { code: 0, stdout: '111\n222\n', stderr: '' };
        if (cmd === 'readlink' && args[0] === '/proc/111/cwd') return { code: 0, stdout: '/other/worker/dir\n', stderr: '' };
        if (cmd === 'readlink' && args[0] === '/proc/222/cwd') return { code: 0, stdout: '/tmp/wdir\n', stderr: '' };
        if (cmd === 'node') return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
    };
    const result = workerMod.startWorker(io, { workerDir: '/tmp/wdir' });
    assert.strictEqual(result.started, true, 'started');
    assert.strictEqual(result.already_running, true, 'detected as already running');
    assert.strictEqual(result.pid, 222, 'pid of the worker whose cwd is this workerDir');
    assert.strictEqual(result.alive, true, 'alive');
    assert.strictEqual(spawned.length, 0, 'no second worker spawned');
});

test('20d. startWorker restarts a running worker whose .env changed after its start', () => {
    const workerMod = require('../src/installer/engine/worker');
    const spawned = [];
    const killed = [];
    const { io, fs } = createMockIo({
        files: {
            '/tmp/wdir/worker.cjs': '// worker',
            '/tmp/wdir/package.json': '{}',
            '/tmp/wdir/.env': 'HUB_URL=https://animastor.in/gpu\nCOMFY_PORT=8288\n',
            '/proc/222': 'proc-entry',
        },
        preDirs: ['/tmp/wdir'],
    });
    // the running worker started BEFORE .env was last modified → stale
    const baseStat = fs.statSync;
    fs.statSync = (p) => {
        const st = baseStat(p);
        if (p === '/proc/222') return { ...st, mtimeMs: 1000 };
        if (p === '/tmp/wdir/.env') return { ...st, mtimeMs: 5000 };
        return st;
    };
    io.spawnDaemon = (cmd, args, opts) => { spawned.push(args); return 777; };
    io.exec = (cmd, args) => {
        if (cmd === 'kill') { killed.push(args[0]); return { code: 0, stdout: '', stderr: '' }; }
        if (cmd === 'pgrep') return { code: 0, stdout: '222\n', stderr: '' };
        if (cmd === 'readlink') return { code: 0, stdout: '/tmp/wdir\n', stderr: '' };
        if (cmd === 'node' && args[0] === '--check') return { code: 0, stdout: '', stderr: '' };
        if (cmd === 'node' && args[0] === '-e') return { code: 0, stdout: '/tmp/wdir', stderr: '' };
        if (cmd === 'sleep') return { code: 0, stdout: '', stderr: '' };
        if (cmd === 'ps') return { code: 0, stdout: 'node worker.cjs', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
    };
    const result = workerMod.startWorker(io, { workerDir: '/tmp/wdir' });
    assert.deepStrictEqual(killed, ['222'], 'stale worker killed');
    assert.strictEqual(spawned.length, 1, 'fresh worker spawned with the new env');
    assert.strictEqual(result.alive, true, 'fresh worker alive');
    assert.strictEqual(result.already_running, undefined, 'not reported as already_running');
});

// ========================== 21. COMFY_PORT in .env =======================
test('21. engine passes COMFY_PORT to .env when --comfy-port is given', async () => {
    const manifestMod = require('../src/installer/install-manifest');
    const manifests = [manifestMod.loadManifest('audio/qwen-tts')];
    const { io, fs } = createRealManifestEngineIo();
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
        secretProvider: async () => 'wrk.test-token',
        logger: log, crypto: require('crypto'),
        options: { comfyPort: 8288 },
    });
    const envText = fs.readFileSync('/tmp/animastor/worker/.env', 'utf8');
    assert.ok(envText.includes('COMFY_PORT=8288'), `.env contains COMFY_PORT=8288\n${envText}`);
    assert.ok(!envText.includes('COMFY_PORT=8188'), 'COMFY_PORT not defaulted to 8188');
});

test('21b. a bare re-run inherits remembered --comfy-port/--start flags from state', async () => {
    const manifestMod = require('../src/installer/install-manifest');
    const manifests = [manifestMod.loadManifest('audio/qwen-tts')];
    const roots = {
        comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/animastor/worker',
        statePath: '/tmp/comfy/.animastor-installer/install-state.json',
        repoRoot: '/tmp/repo', hubUrl: 'https://animastor.in/gpu',
    };
    const decisions = {
        comfyui_update: 'yes', install_custom_nodes: true, install_models: true,
        workflows: 'all', worker_setup: true, worker_key_provided: true,
        accept_reference_runtime: true,
    };
    const base = { manifests, mode: 'managed', roots, decisions, secretProvider: async () => 'wrk.test-token', crypto: require('crypto') };

    // Run 1: explicit flags → settings remembered in state
    const io1 = createRealManifestEngineIo();
    const log1 = createMockLogger();
    await runInstallation({ ...base, io: io1.io, logger: log1, options: { comfyPort: 8288, startComfyui: true, startWorker: true } });
    const st = JSON.parse(io1.fs.readFileSync(roots.statePath, 'utf8'));
    assert.deepStrictEqual(st.installer_options, { comfyPort: 8288, startComfyui: true, startWorker: true }, `options persisted: ${JSON.stringify(st.installer_options)}`);

    // Run 2: bare (no options) → remembered values apply; .env keeps the port
    const io2 = createRealManifestEngineIo();
    // pre-seed the state from run 1 into the fresh io
    io2.fs.mkdirSync('/tmp/comfy/.animastor-installer', { recursive: true });
    io2.fs.writeFileSync(roots.statePath, JSON.stringify(st));
    const log2 = createMockLogger();
    await runInstallation({ ...base, io: io2.io, logger: log2, options: {} });
    assert.ok(log2.lines.some((l) => l.includes('reusing remembered setting: comfyPort=8288')), `log: ${log2.lines.join('\n')}`);
    const envText = io2.fs.readFileSync('/tmp/animastor/worker/.env', 'utf8');
    assert.ok(envText.includes('COMFY_PORT=8288'), `.env still wired to 8288\n${envText}`);
});

// ================= 21c. managed mode: services auto-start, port auto-pick ==
test('21c. bare managed run: foreign 8188 avoided, services start by default', async () => {
    const engine = require('../src/installer/engine/engine');
    const manifestMod = require('../src/installer/install-manifest');
    const manifests = [manifestMod.loadManifest('audio/qwen-tts')];
    const spawnCalls = [];
    const { io, fs, calls } = createRealManifestEngineIo({
        // foreign ComfyUI occupies 8188; managed range is free
        'http://127.0.0.1:8188/system_stats': { status: 200, json: () => ({ system: {} }) },
        'http://127.0.0.1:8288/system_stats': () => { throw new Error('ECONNREFUSED'); },
        'http://127.0.0.1:8289/system_stats': () => { throw new Error('ECONNREFUSED'); },
    });
    io.spawnDaemon = (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return 555; };
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
        secretProvider: async () => 'wrk.test-token',
        logger: log, crypto: require('crypto'),
        options: { verifyTimeoutMs: 300 },
    });
    const envText = fs.readFileSync('/tmp/animastor/worker/.env', 'utf8');
    assert.ok(envText.includes('COMFY_PORT=8288'), `port auto-picked to 8288\n${envText}`);
    assert.ok(!envText.includes('COMFY_PORT=8188'), 'foreign 8188 never used');
    const st = JSON.parse(fs.readFileSync('/tmp/comfy/.animastor-installer/install-state.json', 'utf8'));
    assert.deepStrictEqual(st.installer_options, { comfyPort: 8288, startComfyui: true, startWorker: true }, `persisted: ${JSON.stringify(st.installer_options)}`);
    const comfySpawn = spawnCalls.find((s) => s.args && s.args[0] === 'main.py');
    assert.ok(comfySpawn, 'ComfyUI spawned');
    assert.ok(comfySpawn.args.includes('8288'), 'ComfyUI spawned on the auto-picked port');
    assert.ok(st.comfyui_runtime && st.comfyui_runtime.port === 8288, 'runtime recorded for future re-runs');
});

test('21d. autoPickComfyPort: runtime-alive > free default > managed range; existing mode trusts 8188', async () => {
    const engine = require('../src/installer/engine/engine');
    const mk = (handlers) => createMockIo({ httpResults: handlers }).io;
    const refused = () => { throw new Error('ECONNREFUSED'); };
    const foreign = { status: 200, json: () => ({}) };                 // answers, not ComfyUI
    const comfy = { status: 200, json: () => ({ system: {} }) };       // ComfyUI API

    // foreign service on 8188 → managed range
    let io = mk({ 'http://127.0.0.1:8188/system_stats': foreign, 'http://127.0.0.1:8288/system_stats': refused });
    assert.strictEqual(await engine.autoPickComfyPort(io, { st: {}, mode: 'managed', log: null }), 8288);

    // everything free → default 8188
    io = mk({ 'http://127.0.0.1:8188/system_stats': refused });
    assert.strictEqual(await engine.autoPickComfyPort(io, { st: {}, mode: 'managed', log: null }), 8188);

    // previous runtime still alive → keep it (even with foreign 8188)
    io = mk({ 'http://127.0.0.1:8188/system_stats': foreign, 'http://127.0.0.1:8288/system_stats': comfy });
    assert.strictEqual(await engine.autoPickComfyPort(io, { st: { comfyui_runtime: { port: 8288 } }, mode: 'managed', log: null }), 8288);

    // existing mode: the user's own ComfyUI on 8188 IS the target
    io = mk({ 'http://127.0.0.1:8188/system_stats': comfy });
    assert.strictEqual(await engine.autoPickComfyPort(io, { st: {}, mode: 'existing', log: null }), 8188);

    // portState classification
    io = mk({ 'http://127.0.0.1:9000/system_stats': foreign });
    assert.strictEqual(await engine.comfyPortState(io, 9000), 'foreign');
    io = mk({ 'http://127.0.0.1:9000/system_stats': comfy });
    assert.strictEqual(await engine.comfyPortState(io, 9000), 'comfyui');
    io = mk({ 'http://127.0.0.1:9000/system_stats': refused });
    assert.strictEqual(await engine.comfyPortState(io, 9000), 'free');
});

// ========================== 22. nodes retryDeps ==========================
test('22. installCustomNode retries pip install for existing nodes with incomplete deps', () => {
    const nodesMod = require('../src/installer/engine/nodes');
    const { io, fs } = createMockIo({
        files: {
            '/tmp/comfy/venv/bin/python': '#!/bin/sh',
            '/tmp/comfy/custom_nodes/qwen3-tts/requirements.txt': 'transformers\n',
        },
        execResults: {
            // pip install succeeds
            '/tmp/comfy/venv/bin/python -m pip install -r /tmp/comfy/custom_nodes/qwen3-tts/requirements.txt -c /tmp/comfy/venv/.animastor-torch-constraints.txt': { code: 0, stdout: '', stderr: '' },
        },
    });
    const dep = { id: 'custom-node:comfyui-qwen3-tts', install: { directory: 'qwen3-tts', source: { repository: 'https://github.com/x/ComfyUI-Qwen3-TTS', commit: '2ee1131' } } };
    const result = nodesMod.installCustomNode(io, {
        root: '/tmp/comfy', dep,
        python: '/tmp/comfy/venv/bin/python',
        torchSpec: { pin: '2.10.0', index_url: 'https://download.pytorch.org/whl/cpu' },
        retryDeps: true,
    });
    assert.strictEqual(result.status, 'installed');
    assert.strictEqual(result.origin, 'pre-existing');
    assert.ok(!result.reason, `reason cleared: ${result.reason}`);
});

test('22b. installCustomNode returns incomplete reason when pip retry fails', () => {
    const nodesMod = require('../src/installer/engine/nodes');
    const { io } = createMockIo({
        files: {
            '/tmp/comfy/venv/bin/python': '#!/bin/sh',
            '/tmp/comfy/custom_nodes/qwen3-tts/requirements.txt': 'transformers\n',
        },
        execResults: {
            '/tmp/comfy/venv/bin/python -m pip install -r /tmp/comfy/custom_nodes/qwen3-tts/requirements.txt -c /tmp/comfy/venv/.animastor-torch-constraints.txt': { code: 1, stdout: '', stderr: 'conflict' },
        },
    });
    const dep = { id: 'custom-node:comfyui-qwen3-tts', install: { directory: 'qwen3-tts', source: { repository: 'https://github.com/x', commit: '2ee1131' } } };
    const result = nodesMod.installCustomNode(io, {
        root: '/tmp/comfy', dep,
        python: '/tmp/comfy/venv/bin/python',
        torchSpec: { pin: '2.10.0' },
        retryDeps: true,
    });
    assert.strictEqual(result.status, 'installed');
    assert.strictEqual(result.origin, 'pre-existing');
    assert.ok(/dependencies incomplete/.test(result.reason), `reason: ${result.reason}`);
});

// ========================== 23. buildInstallPlan consent =================
test('23a. plan: missing ComfyUI with reference source → awaiting_decision (consent prompt)', () => {
    const manifestMod = require('../src/installer/install-manifest');
    const manifests = [manifestMod.loadManifest('audio/qwen-tts')];
    const env = resolver.createEmptyEnvironment();
    const report = resolver.resolveInstallation({ manifests, environment: env, mode: 'managed' });
    const plan = buildInstallPlan({ report, manifests, decisions: {} });
    const comfyStep = plan.steps.find((s) => s.id === 'comfyui-update');
    assert.ok(comfyStep, 'comfyui-update step exists');
    assert.strictEqual(comfyStep.awaiting_decision, true, 'awaiting consent');
    assert.strictEqual(comfyStep.consent, 'accept_reference_runtime');
    assert.ok(comfyStep.prompt.question.includes('rajsingh1-dev'), 'prompt names the reference source');
});

test('23b. plan: accept_reference_runtime=true → install_comfyui action (no block)', () => {
    const manifestMod = require('../src/installer/install-manifest');
    const manifests = [manifestMod.loadManifest('audio/qwen-tts')];
    const env = resolver.createEmptyEnvironment();
    const report = resolver.resolveInstallation({ manifests, environment: env, mode: 'managed' });
    const plan = buildInstallPlan({ report, manifests, decisions: { accept_reference_runtime: true } });
    const comfyStep = plan.steps.find((s) => s.id === 'comfyui-update');
    assert.strictEqual(comfyStep.awaiting_decision, undefined, 'not awaiting');
    assert.ok(comfyStep.action, 'action present');
    assert.strictEqual(comfyStep.action.op, 'install_comfyui');
    assert.ok(!comfyStep.abort, 'not aborted');
});

test('23c. plan: accept_reference_runtime=false → abort (fail-closed)', () => {
    const manifestMod = require('../src/installer/install-manifest');
    const manifests = [manifestMod.loadManifest('audio/qwen-tts')];
    const env = resolver.createEmptyEnvironment();
    const report = resolver.resolveInstallation({ manifests, environment: env, mode: 'managed' });
    const plan = buildInstallPlan({ report, manifests, decisions: { accept_reference_runtime: false } });
    const comfyStep = plan.steps.find((s) => s.id === 'comfyui-update');
    assert.strictEqual(comfyStep.abort, true, 'aborted');
    assert.ok(comfyStep.abort_reason.includes('declined'), `reason: ${comfyStep.abort_reason}`);
});

// ========================== 24. engine: adopt + full flow ================
collectAsync('24. engine: adopt partial root + COMFY_PORT + worker start (end-to-end)', async () => {
    const manifestMod = require('../src/installer/install-manifest');
    const manifests = [manifestMod.loadManifest('audio/qwen-tts')];
    const DUMMY_TOKEN = 'wrk.adopt-test-token';
    const repoRootReal = path.resolve(__dirname, '..', '..');
    // Partial root: venv + models + custom_nodes present, ComfyUI missing
    const { io, calls, fs } = createMockIo({
        files: {
            '/tmp/comfy/venv/bin/python': '#!/bin/sh',
            '/tmp/comfy/venv/bin/pip': '#!/bin/sh',
            '/tmp/comfy/custom_nodes/qwen3-tts/requirements.txt': 'transformers\n',
            '/tmp/comfy/models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-Base/model.safetensors': 'existing',
            '/tmp/comfy/models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-Base/speech_tokenizer/model.safetensors': 'existing',
            '/tmp/comfy/models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/model.safetensors': 'existing',
            '/tmp/comfy/models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/speech_tokenizer/model.safetensors': 'existing',
            '/tmp/comfy/.animastor-installer/install-state.json': JSON.stringify({
                state_version: 1, mode: 'managed', profiles: ['audio/qwen-tts'],
                artifacts: {
                    runtime: { status: 'installed' },
                    'custom-node:comfyui-qwen3-tts': { status: 'installed', detail: { reason: 'cloned; python dependencies incomplete — see warnings' } },
                    'model-repo:qwen3-tts-12hz-1.7b-voicedesign': { status: 'installed' },
                    'model-repo:qwen3-tts-12hz-1.7b-base': { status: 'installed' },
                    'worker:audio/qwen-tts': { status: 'failed' },
                    env: { status: 'installed' },
                },
            }),
            '/tmp/repo/worker/worker/worker.cjs': '// worker v2.0.0',
            '/tmp/repo/worker/worker/worker-env.cjs': '// env',
            '/tmp/repo/worker/worker/worker-cleanup.cjs': '// cleanup',
            '/tmp/repo/worker/worker/worker-cleanup-journal.cjs': '// journal',
            '/tmp/repo/worker/worker/package.json': '{"name":"animastor-worker"}',
            '/tmp/repo/worker/worker/package-lock.json': '{}',
            '/tmp/repo/worker/worker/.env.example': 'HUB_URL=\nANIMASTOR_WORKER_TOKEN=\nWORKER_TYPE=\nWORKER_ID=\n',
            '/tmp/repo/backend/ai/workflows/tts-qwen-narrator.json': realFs.readFileSync(path.join(repoRootReal, 'backend/ai/workflows/tts-qwen-narrator.json'), 'utf8'),
            '/tmp/repo/backend/ai/workflows/tts-qwen-dialogue.json': realFs.readFileSync(path.join(repoRootReal, 'backend/ai/workflows/tts-qwen-dialogue.json'), 'utf8'),
        },
        execResults: {
            'git -C /tmp/comfy init': { code: 0, stdout: '', stderr: '' },
            'git -C /tmp/comfy remote add origin https://github.com/rajsingh1-dev/ComfyUI.git': { code: 0, stdout: '', stderr: '' },
            'git -C /tmp/comfy fetch --tags origin': { code: 0, stdout: '', stderr: '' },
            'git -C /tmp/comfy checkout c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11': ({ fs: mfs }) => {
                mfs.writeFileSync('/tmp/comfy/main.py', '# comfy fork');
                mfs.mkdirSync('/tmp/comfy/.git/info', { recursive: true });
                return { code: 0, stdout: '', stderr: '' };
            },
            'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'https://github.com/rajsingh1-dev/ComfyUI.git', stderr: '' },
            '/tmp/comfy/venv/bin/python -m pip --version': { code: 0, stdout: 'pip 23.0', stderr: '' },
            '/tmp/comfy/venv/bin/python -m ensurepip --upgrade': { code: 0, stdout: '', stderr: '' },
            '/tmp/comfy/venv/bin/python --version': { code: 0, stdout: 'Python 3.10.12' },
            '/tmp/comfy/venv/bin/python -c import torch; print(torch.__version__)': { code: 0, stdout: '2.10.0+cpu' },
            '/tmp/comfy/venv/bin/python -m pip install -r /tmp/comfy/custom_nodes/qwen3-tts/requirements.txt -c /tmp/comfy/venv/.animastor-torch-constraints.txt': { code: 0, stdout: '', stderr: '' },
            'npm install --omit=dev --no-audit --no-fund': { code: 0, stdout: '', stderr: '' },
            'ps -p 4242 -o args=': { code: 0, stdout: 'node worker.cjs', stderr: '' },
            // Node.js check for worker
            'node --check /tmp/animastor/worker/worker.cjs': { code: 0, stdout: '', stderr: '' },
            'node --version': { code: 0, stdout: 'v22.0.0', stderr: '' },
        },
        httpResults: {
            'https://animastor.in/api/v1/worker/verify': { status: 200, json: () => ({ verified: true, worker_id: 'w-adopt-test', worker_type: 'audio' }) },
            'http://127.0.0.1:8288/system_stats': { status: 200, json: () => ({ system: {} }) },
            'http://127.0.0.1:8288/object_info': {
                status: 200,
                json: () => ({
                    Qwen3TTSVoiceDesign: {}, Qwen3TTSLoader: {}, Qwen3TTSVoiceClonePrompt: {},
                    Qwen3TTSRoleBank: {}, Qwen3TTSAdvancedDialogue: {}, Qwen3TTSScriptProcessor: {},
                    SaveAudioMP3: {},
                }),
            },
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
        },
    });
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
        secretProvider: async () => DUMMY_TOKEN,
        logger: log, crypto: require('crypto'),
        options: { comfyPort: 8288, startWorker: true },
    });

    // 1) ComfyUI adopted in place (not cloned from scratch)
    assert.ok(calls.exec.some((c) => c.cmd === 'git' && c.args.join(' ') === '-C /tmp/comfy init'), 'git init for adopt');
    assert.ok(calls.exec.some((c) => c.cmd === 'git' && (c.args.join(' ').includes('remote add origin') || c.args.join(' ').includes('remote set-url origin'))), 'remote added/set');
    assert.ok(calls.exec.some((c) => c.cmd === 'git' && c.args.join(' ') === '-C /tmp/comfy fetch --tags origin'), 'fetched');
    assert.ok(calls.exec.some((c) => c.cmd === 'git' && c.args.join(' ') === '-C /tmp/comfy checkout c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11'), 'checkout ref');
    assert.ok(fs.existsSync('/tmp/comfy/main.py'), 'main.py present after adopt');

    // 2) COMFY_PORT in .env
    const envText = fs.readFileSync('/tmp/animastor/worker/.env', 'utf8');
    assert.ok(envText.includes('COMFY_PORT=8288'), '.env has COMFY_PORT=8288');
    assert.ok(envText.includes('ANIMASTOR_WORKER_TOKEN='), '.env has token');

    // 3) Worker started
    assert.ok(result.results.worker.some((w) => w.id === 'worker-process' && w.started), 'worker-process result present');
    const wp = result.results.worker.find((w) => w.id === 'worker-process');
    assert.strictEqual(wp.alive, true, 'worker alive after start');

    // 4) Node deps retried and healed
    const nodeArtifact = JSON.parse(fs.readFileSync('/tmp/comfy/.animastor-installer/install-state.json', 'utf8')).artifacts['custom-node:comfyui-qwen3-tts'];
    assert.ok(!nodeArtifact.detail.reason, `node deps healed (reason cleared): ${JSON.stringify(nodeArtifact.detail)}`);

    // 5) Models skipped (already present)
    for (const mr of result.results.models) {
        assert.ok(mr.status === 'downloaded' || mr.status === 'skipped' || mr.status === 'verified', `${mr.id}: ${mr.status}`);
    }

    // 6) Status not blocked/failed
    assert.ok(!['blocked', 'failed'].includes(result.status), `status: ${result.status}`);
});

// ==========================================================================

Promise.all(testPromises).then(() => {
    console.log(`\nCPU installer tests: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
});
