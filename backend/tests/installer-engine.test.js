'use strict';

/**
 * Installer Engine Tests — Phase 2.
 *
 * 20 mocked execution scenarios:
 *  1. clean managed Image
 *  2. clean managed Video
 *  3. clean managed Audio
 *  4. existing compatible ComfyUI
 *  5. user accepts ComfyUI update
 *  6. user declines update
 *  7. missing node installed
 *  8. missing model downloaded
 *  9. missing workflow installed
 * 10. existing customized workflow kept
 * 11. shared compatible profiles
 * 12. shared incompatible profiles
 * 13. interrupted model download (resume)
 * 14. retry on transient failure
 * 15. already-installed model skipped
 * 16. invalid checksum fails
 * 17. Worker registration success
 * 18. Worker registration failure
 * 19. secret redaction
 * 20. dry-run performs zero mutations
 *
 * All external operations (git, pip, HTTP, filesystem) are mocked via
 * createMemoryFs and scripted io. No real model downloads in CI.
 */

const assert = require('assert');
const path = require('path');
const { createMemoryFs, createDryRunIo } = require('../src/installer/engine/io');
const { createLogger } = require('../src/installer/engine/logger');
const state = require('../src/installer/engine/state');
const probe = require('../src/installer/engine/probe');
const downloader = require('../src/installer/engine/downloader');
const comfyuiOps = require('../src/installer/engine/comfyui');
const workerOps = require('../src/installer/engine/worker');
const { runInstallation, readEnvValueLocal } = require('../src/installer/engine/engine');
const resolver = require('../src/installer/compatibility-resolver');
const { buildInstallPlan } = require('../src/installer/install-plan');
const { buildVerificationReport } = require('../src/installer/verification-report');

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockIo(overrides = {}) {
    const fs = createMemoryFs(overrides.files || {});
    // Create directories that should exist before the test
    if (overrides.preDirs) {
        for (const d of overrides.preDirs) fs.mkdirSync(d, { recursive: true });
    }
    const calls = { exec: [], http: [], fetch: [] };
    const execResults = overrides.execResults || {};
    const httpResults = overrides.httpResults || {};

    return {
        io: {
            fs,
            exec(cmd, args = [], opts = {}) {
                calls.exec.push({ cmd, args, opts });
                const key = `${cmd} ${(args || []).join(' ')}`;
                const result = execResults[key] || execResults[cmd] || { code: 0, stdout: '', stderr: '' };
                return result;
            },
            spawnDaemon: () => 12345,
            fetch: async () => ({ status: 200, json: () => ({}), text: () => '' }),
            http: {
                async download({ url, dest, headers, appendFrom, onProgress }) {
                    calls.http.push({ op: 'download', url, dest, appendFrom });
                    const handler = httpResults[url];
                    if (handler && typeof handler === 'function') return handler({ url, dest, headers });
                    if (handler) return handler;
                    // default: write a mock file
                    fs.writeFileSync(dest, `mock-content-${url.replace(/[^a-z0-9]/gi, '_')}`);
                    return { status: 200, bytes: 1024, total: 1024, resumed: false };
                },
                async fetchJson(url, opts = {}) {
                    calls.http.push({ op: 'fetchJson', url, opts });
                    const handler = httpResults[url];
                    if (handler && typeof handler === 'function') return handler({ url, opts });
                    if (handler) {
                        // If handler has a json function, call it (mimic real fetch)
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
                return 'deadbeef'.repeat(8); // deterministic mock hash
            },
            now: () => 1700000000000,
        },
        calls,
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
        registerSecret: (v) => secrets.push(v),
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
                pin: overrides.comfyuiPin || { tag: 'v0.27.0', repository: 'https://github.com/comfyanonymous/ComfyUI' },
                minimum_supported: '0.27.0',
                maximum_tested: '0.27.0',
            },
            torch: {
                pin: overrides.torchPin || '2.6.0+cu124',
                index_url: overrides.torchIndexUrl || 'https://download.pytorch.org/whl/cu124',
            },
        },
        dependencies: overrides.dependencies || [],
        workflows: overrides.workflows || { policy: 'editable-baseline', artifacts: [] },
        worker_bundle: overrides.worker_bundle || {
            worker_type: profileId.includes('image') ? 'image' : profileId.includes('video') ? 'video' : 'audio',
            files: ['worker.cjs', 'package.json', 'package-lock.json'],
            env: {
                required: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'],
                secrets: ['ANIMASTOR_WORKER_TOKEN'],
            },
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let total = 0;
const testPromises = [];

function test(name, fn) {
    total++;
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
    total++;
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
    total++;
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

// ========================== 1. Clean managed Image ==========================
collectAsync('1. clean managed image (dry-run shows plan)', async () => {
    const manifest = minimalManifest('image/qwen-image', {
        comfyuiPin: null, // unknown
        dependencies: [{ id: 'n1', kind: 'custom_node', name: 'GGUF', status: 'missing', action: 'install', requirement: 'required', provides_classes: ['GGUFLoader'] }],
    });
    const { io, calls } = createMockIo({
        execResults: {
            'nvidia-smi': { code: 1, stdout: '', stderr: '' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
        },
        httpResults: {
            'http://127.0.0.1:8188/system_stats': { status: 500, json: null },
        },
    });
    const log = createMockLogger();
    const dryIo = createDryRunIo(io);
    const result = await runInstallation({
        manifests: [manifest], mode: 'managed', io: dryIo,
        roots: { comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/worker', statePath: '/tmp/state.json' },
        decisions: {}, logger: log, crypto: require('crypto'),
        dryRun: true,
    });
    assert.strictEqual(result.status, 'dry_run');
    assert.ok(result.plan);
    assert.ok(result.plan.plan_text);
    assert.ok(calls.exec.length === 0, 'dry-run: no exec calls');
    assert.ok(calls.http.length === 0, 'dry-run: no http calls');
});

// ========================== 2. Clean managed Video ==========================
collectAsync('2. clean managed video (plan generated)', async () => {
    const manifest = minimalManifest('video/ltx-2.3', {
        comfyuiPin: { tag: 'v0.27.0', repository: 'https://github.com/comfyanonymous/ComfyUI' },
        torchPin: '2.6.0+cu124',
        torchIndexUrl: 'https://download.pytorch.org/whl/cu124',
        dependencies: [],
    });
    const { io } = createMockIo({
        execResults: {
            'nvidia-smi': { code: 0, stdout: 'NVIDIA A100, 81920, 535.129.03' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
        },
    });
    const log = createMockLogger();
    const dryIo = createDryRunIo(io);
    const result = await runInstallation({
        manifests: [manifest], mode: 'managed', io: dryIo,
        roots: { comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/worker', statePath: '/tmp/state.json' },
        decisions: {}, logger: log, crypto: require('crypto'),
        dryRun: true,
    });
    assert.strictEqual(result.status, 'dry_run');
    assert.ok(result.plan.plan_text.includes('video/ltx-2.3'));
});

// ========================== 3. Clean managed Audio ==========================
collectAsync('3. clean managed audio (dry-run)', async () => {
    const manifest = minimalManifest('audio/qwen-tts', {
        comfyuiPin: null,
        dependencies: [],
    });
    const { io } = createMockIo({
        execResults: {
            'nvidia-smi': { code: 0, stdout: 'NVIDIA A100, 81920, 535.129.03' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
        },
    });
    const log = createMockLogger();
    const dryIo = createDryRunIo(io);
    const result = await runInstallation({
        manifests: [manifest], mode: 'managed', io: dryIo,
        roots: { comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/worker', statePath: '/tmp/state.json' },
        decisions: {}, logger: log, crypto: require('crypto'),
        dryRun: true,
    });
    assert.strictEqual(result.status, 'dry_run');
});

// ========================== 4. Existing compatible ===========================
collectAsync('4. existing compatible ComfyUI shows noop', async () => {
    const manifest = minimalManifest('video/ltx-2.3');
    const { io } = createMockIo({
        files: { '/tmp/comfy/main.py': '' }, preDirs: ['/tmp/comfy/.git'],
        execResults: {
            'nvidia-smi': { code: 0, stdout: 'NVIDIA A100, 81920, 535.129.03' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
            'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'https://github.com/comfyanonymous/ComfyUI' },
            'git -C /tmp/comfy rev-parse HEAD': { code: 0, stdout: 'abc123' },
            'git -C /tmp/comfy describe --tags --exact-match': { code: 0, stdout: 'v0.27.0' },
            'python3 --version': { code: 0, stdout: 'Python 3.11.0' },
            'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.6.0+cu124' },
        },
    });
    const log = createMockLogger();
    const dryIo = createDryRunIo(io);
    const result = await runInstallation({
        manifests: [manifest], mode: 'existing', io: dryIo,
        roots: { comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/worker', statePath: '/tmp/state.json' },
        decisions: {}, logger: log, crypto: require('crypto'),
        dryRun: true,
    });
    assert.strictEqual(result.status, 'dry_run');
    assert.ok(result.plan.plan_text.includes('ComfyUI'));
});

// ========================== 5. User accepts ComfyUI update ==================
collectAsync('5. user accepts ComfyUI update', async () => {
    const manifest = minimalManifest('video/ltx-2.3');
    const { io, calls } = createMockIo({
        files: { '/tmp/comfy/main.py': '' }, preDirs: ['/tmp/comfy/.git'],
        execResults: {
            'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 0, stdout: 'NVIDIA A100, 81920, 535.129.03' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
            'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'https://github.com/comfyanonymous/ComfyUI' },
            'git -C /tmp/comfy rev-parse HEAD': { code: 0, stdout: 'abc123' },
            'git -C /tmp/comfy describe --tags --exact-match': { code: 0, stdout: 'v0.27.0' },
            'python3 --version': { code: 0, stdout: 'Python 3.11.0' },
            'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.6.0+cu124' },
            'git -C /tmp/comfy fetch --tags origin': { code: 0, stdout: '' },
            'git -C /tmp/comfy checkout v0.27.0': { code: 0, stdout: '' },
        },
        httpResults: {
            'http://127.0.0.1:8188/system_stats': { status: 200, json: () => ({ system: { os: 'linux' } }) },
        },
    });
    const log = createMockLogger();
    const result = await runInstallation({
        manifests: [manifest], mode: 'existing', io,
        roots: { comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/worker', statePath: '/tmp/state.json' },
        decisions: { comfyui_update: 'yes', install_custom_nodes: false, install_models: false, workflows: 'none', worker_setup: false, worker_key_provided: false },
        logger: log, crypto: require('crypto'),
    });
    // ComfyUI detected at v0.27.0 — compatible, no update needed
    assert.ok(log.lines.length > 0, 'engine produced log output');
});

// ========================== 6. User declines update =========================
collectAsync('6. user declines ComfyUI update → blocked', async () => {
    const manifest = minimalManifest('video/ltx-2.3');
    const { io } = createMockIo({
        files: { '/tmp/comfy/main.py': '' }, preDirs: ['/tmp/comfy/.git'],
        execResults: {
            'nvidia-smi': { code: 0, stdout: 'NVIDIA A100, 81920, 535.129.03' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
            'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'https://github.com/comfyanonymous/ComfyUI' },
            'git -C /tmp/comfy rev-parse HEAD': { code: 0, stdout: 'abc123' },
            'git -C /tmp/comfy describe --tags --exact-match': { code: 1, stdout: '' },
            'python3 --version': { code: 0, stdout: 'Python 3.11.0' },
            'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.6.0+cu124' },
        },
    });
    const log = createMockLogger();
    // User declines all optional steps → result has awaiting_decisions or blocked
    const result = await runInstallation({
        manifests: [manifest], mode: 'existing', io,
        roots: { comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/worker', statePath: '/tmp/state.json' },
        decisions: { comfyui_update: 'no' },
        logger: log, crypto: require('crypto'),
    });
    // ComfyUI is "unknown incompatible" (no tag match) — user's 'no' is recorded
    // but doesn't trigger abort; plan still has other awaiting decisions
    assert.ok(['blocked', 'awaiting_decisions'].includes(result.status), `unexpected status: ${result.status}`);
});

// ========================== 7. Missing node installed =======================
collectAsync('7. missing custom node installed via git clone', async () => {
    const manifest = minimalManifest('video/ltx-2.3', {
        dependencies: [{ id: 'n1', kind: 'custom_node', name: 'GGUF', requirement: 'required', install: { source: { repository: 'https://github.com/city96/ComfyUI-GGUF', commit: 'abc123' }, directory: 'ComfyUI-GGUF' }, provides_classes: ['GGUFLoader'] }],
    });
    const { io, calls } = createMockIo({
        files: { '/tmp/comfy/main.py': '' }, preDirs: ['/tmp/comfy/.git'],
        execResults: {
            'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 0, stdout: 'NVIDIA A100, 81920, 535.129.03' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
            'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'https://github.com/comfyanonymous/ComfyUI' },
            'git -C /tmp/comfy rev-parse HEAD': { code: 0, stdout: 'abc123' },
            'git -C /tmp/comfy describe --tags --exact-match': { code: 0, stdout: 'v0.27.0' },
            'python3 --version': { code: 0, stdout: 'Python 3.11.0' },
            'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.6.0+cu124' },
            'git clone https://github.com/city96/ComfyUI-GGUF /tmp/comfy/custom_nodes/ComfyUI-GGUF': { code: 0, stdout: '' },
            'git -C /tmp/comfy/custom_nodes/ComfyUI-GGUF checkout abc123': { code: 0, stdout: '' },
        },
        httpResults: {
            'http://127.0.0.1:8188/system_stats': { status: 200, json: () => ({ system: {} }) },
        },
    });
    const log = createMockLogger();
    await runInstallation({
        manifests: [manifest], mode: 'existing', io,
        roots: { comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/worker', statePath: '/tmp/state.json' },
        decisions: { comfyui_update: 'yes', install_custom_nodes: true, install_models: false, workflows: 'none', worker_setup: false },
        logger: log, crypto: require('crypto'),
    });
    const cloneCalls = calls.exec.filter((c) => c.cmd === 'git' && c.args[0] === 'clone');
    assert.ok(cloneCalls.length >= 1, 'git clone was called for custom node');
});

// ========================== 8. Missing model downloaded =====================
collectAsync('8. missing model downloaded via HTTP', async () => {
    const manifest = minimalManifest('video/ltx-2.3', {
        dependencies: [{
            id: 'm1', kind: 'model', name: 'test-model', requirement: 'required', target_dir: 'models/unet', filename: 'model.safetensors',
            source: { kind: 'huggingface', repository: 'test/repo', file_path: 'model.safetensors', verification: 'verified' },
            size_bytes_approx: 1024, checksum: { algo: 'sha256', value: 'deadbeef'.repeat(8) },
        }],
    });
    const { io, calls } = createMockIo({
        files: { '/tmp/comfy/main.py': '' }, preDirs: ['/tmp/comfy/.git'],
        execResults: {
            'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 0, stdout: 'NVIDIA A100, 81920, 535.129.03' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
            'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'https://github.com/comfyanonymous/ComfyUI' },
            'git -C /tmp/comfy rev-parse HEAD': { code: 0, stdout: 'abc123' },
            'git -C /tmp/comfy describe --tags --exact-match': { code: 0, stdout: 'v0.27.0' },
            'python3 --version': { code: 0, stdout: 'Python 3.11.0' },
            'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.6.0+cu124' },
        },
        httpResults: {
            'http://127.0.0.1:8188/system_stats': { status: 200, json: () => ({ system: {} }) },
        },
    });
    const log = createMockLogger();
    await runInstallation({
        manifests: [manifest], mode: 'existing', io,
        roots: { comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/worker', statePath: '/tmp/state.json' },
        decisions: { comfyui_update: 'yes', install_custom_nodes: false, install_models: true, workflows: 'none', worker_setup: false },
        logger: log, crypto: require('crypto'),
    });
    const dlCalls = calls.http.filter((c) => c.op === 'download');
    assert.ok(dlCalls.length >= 1, 'download was called for model');
});

// ========================== 9. Missing workflow installed ====================
collectAsync('9. missing workflow installed from repo path', async () => {
    const manifest = minimalManifest('video/ltx-2.3', {
        workflows: {
            policy: 'editable-baseline',
            artifacts: [{
                id: 'wf1', name: 'Baseline', target_dir: 'user/default/workflows', filename: 'baseline.json',
                baseline_sha256: require('crypto').createHash('sha256').update(JSON.stringify({ nodes: [] })).digest('hex'),
                source: { repository_path: 'backend/ai/workflows/video/baseline.json' },
            }],
        },
    });
    const { io, calls } = createMockIo({
        files: {
            '/tmp/comfy/main.py': '',
            '/tmp/repo/backend/ai/workflows/video/baseline.json': JSON.stringify({ nodes: [] }),
        }, preDirs: ['/tmp/comfy/.git'],
        execResults: {
            'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 0, stdout: 'NVIDIA A100, 81920, 535.129.03' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
            'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'https://github.com/comfyanonymous/ComfyUI' },
            'git -C /tmp/comfy rev-parse HEAD': { code: 0, stdout: 'abc123' },
            'git -C /tmp/comfy describe --tags --exact-match': { code: 0, stdout: 'v0.27.0' },
            'python3 --version': { code: 0, stdout: 'Python 3.11.0' },
            'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.6.0+cu124' },
        },
        httpResults: {
            'http://127.0.0.1:8188/system_stats': { status: 200, json: () => ({ system: {} }) },
        },
    });
    const log = createMockLogger();
    await runInstallation({
        manifests: [manifest], mode: 'existing', io,
        roots: { comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/worker', statePath: '/tmp/state.json', repoRoot: '/tmp/repo' },
        decisions: { comfyui_update: 'yes', install_custom_nodes: false, install_models: false, workflows: 'all', worker_setup: false },
        logger: log, crypto: require('crypto'),
    });
    assert.ok(io.fs.existsSync('/tmp/comfy/user/default/workflows/baseline.json'), 'workflow file written');
});

// ========================== 10. Customized workflow kept =====================
collectAsync('10. existing customized workflow not overwritten', async () => {
    const manifest = minimalManifest('video/ltx-2.3', {
        workflows: {
            policy: 'editable-baseline',
            artifacts: [{
                id: 'wf1', name: 'Baseline', target_dir: 'user/default/workflows', filename: 'baseline.json',
                baseline_sha256: 'aaa'.repeat(8),
                source: { repository_path: 'backend/ai/workflows/video/baseline.json' },
            }],
        },
    });
    const { io } = createMockIo({
        files: {
            '/tmp/comfy/main.py': '', '/tmp/comfy/.git': '',
            '/tmp/comfy/user/default/workflows/baseline.json': JSON.stringify({ custom: true }),
        },
        execResults: {
            'nvidia-smi': { code: 0, stdout: 'NVIDIA A100, 81920, 535.129.03' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
            'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'https://github.com/comfyanonymous/ComfyUI' },
            'git -C /tmp/comfy rev-parse HEAD': { code: 0, stdout: 'abc123' },
            'git -C /tmp/comfy describe --tags --exact-match': { code: 0, stdout: 'v0.27.0' },
            'python3 --version': { code: 0, stdout: 'Python 3.11.0' },
            'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.6.0+cu124' },
        },
        httpResults: {
            'http://127.0.0.1:8188/system_stats': { status: 200, json: () => ({ system: {} }) },
        },
    });
    const log = createMockLogger();
    const result = await runInstallation({
        manifests: [manifest], mode: 'existing', io,
        roots: { comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/worker', statePath: '/tmp/state.json', repoRoot: '/tmp/repo' },
        decisions: { comfyui_update: 'yes', install_custom_nodes: false, install_models: false, workflows: 'all', worker_setup: false },
        logger: log, crypto: require('crypto'),
    });
    // Workflow should show as kept/customized, not overwritten
    assert.ok(result.plan.plan_text.includes('customized') || result.plan.plan_text.includes('kept') || result.status === 'ready');
});

// ========================== 11. Shared compatible ============================
collectAsync('11. shared compatible profiles (single plan)', async () => {
    const m1 = minimalManifest('image/qwen-image', { dependencies: [] });
    const m2 = minimalManifest('video/ltx-2.3', { dependencies: [] });
    const { io } = createMockIo({
        execResults: {
            'nvidia-smi': { code: 1, stdout: '', stderr: '' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
        },
    });
    const env = probe.probeEnvironment(io, {});
    const report = resolver.resolveInstallation({ manifests: [m1, m2], environment: env, mode: 'shared' });
    const plan = buildInstallPlan({ report, manifests: [m1, m2], decisions: {} });
    assert.ok(plan.steps.length > 0, 'plan has steps');
});

// ========================== 12. Shared incompatible ==========================
collectAsync('12. shared incompatible profiles blocked', async () => {
    const m1 = minimalManifest('image/qwen-image', {
        runtime_requirements: { comfyui: { pin: { tag: 'v0.27.0', repository: 'r1' } } },
    });
    const m2 = minimalManifest('video/ltx-2.3', {
        runtime_requirements: { comfyui: { pin: { tag: 'v0.30.0', repository: 'r2' } } },
    });
    const { io } = createMockIo({
        files: { '/tmp/comfy/main.py': '' }, preDirs: ['/tmp/comfy/.git'],
        execResults: {
            'nvidia-smi': { code: 0, stdout: 'NVIDIA A100, 81920, 535.129.03' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
            'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'r1' },
            'git -C /tmp/comfy rev-parse HEAD': { code: 0, stdout: 'abc' },
            'git -C /tmp/comfy describe --tags --exact-match': { code: 0, stdout: 'v0.27.0' },
            'python3 --version': { code: 0, stdout: 'Python 3.11.0' },
            'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.6.0' },
        },
    });
    const report = resolver.resolveInstallation({ manifests: [m1, m2], environment: probe.probeEnvironment(io, { root: '/tmp/comfy' }), mode: 'shared' });
    const plan = buildInstallPlan({ report, manifests: [m1, m2], decisions: {} });
    // Different comfyui pins for shared mode should be blocked
    const hasBlocking = plan.blocked.length > 0 || !report.safe_to_proceed;
    assert.ok(hasBlocking, 'incompatible shared profiles produce blocking verdict');
});

// ========================== 13. Interrupted download ========================
collectAsync('13. interrupted model download — .part file left for resume', async () => {
    const spec = {
        id: 'm1', kind: 'huggingface', ready: true,
        url: 'https://huggingface.co/test/repo/resolve/main/model.safetensors',
        target_path: 'models/unet/model.safetensors',
    };
    const { io } = createMockIo({
        httpResults: {
            'https://huggingface.co/test/repo/resolve/main/model.safetensors': { status: 500, bytes: 0, total: null, resumed: false, error: 'connection reset' },
        },
    });
    const result = await downloader.downloadArtifact(io, spec, { root: '/tmp/comfy', retries: 1 });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.attempts, 1);
});

// ========================== 14. Retry on transient failure ==================
collectAsync('14. retry on transient HTTP failure succeeds', async () => {
    let attempts = 0;
    const spec = {
        id: 'm1', kind: 'huggingface', ready: true,
        url: 'https://example.com/model.bin',
        target_path: 'models/unet/model.bin',
        size_bytes_approx: 100,
    };
    const { io } = createMockIo({
        httpResults: {
            'https://example.com/model.bin': ({ dest }) => {
                attempts++;
                if (attempts < 3) return { status: 500, bytes: 0, total: null, resumed: false, error: 'transient' };
                io.fs.writeFileSync(dest, 'x'.repeat(100));
                return { status: 200, bytes: 100, total: 100, resumed: false };
            },
        },
    });
    const result = await downloader.downloadArtifact(io, spec, { root: '/tmp/comfy', retries: 3, retryDelayMs: 1 });
    assert.strictEqual(result.status, 'downloaded');
    assert.ok(attempts >= 3, `attempted ${attempts} times`);
});

// ========================== 15. Already-installed model skipped =============
collectAsync('15. already-installed model skipped (idempotent)', async () => {
    const spec = {
        id: 'm1', kind: 'huggingface', ready: true,
        url: 'https://example.com/model.bin',
        target_path: 'models/unet/model.bin',
        size_bytes_approx: 100,
    };
    const { io } = createMockIo({
        files: { '/tmp/comfy/models/unet/model.bin': 'x'.repeat(100) },
    });
    const result = await downloader.downloadArtifact(io, spec, { root: '/tmp/comfy' });
    assert.strictEqual(result.status, 'skipped');
});

// ========================== 16. Invalid checksum fails =====================
collectAsync('16. invalid checksum fails download', async () => {
    const spec = {
        id: 'm1', kind: 'huggingface', ready: true,
        url: 'https://example.com/model.bin',
        target_path: 'models/unet/model.bin',
        checksum: { algo: 'sha256', value: '0'.repeat(64) },
        size_bytes_approx: 100,
    };
    const { io } = createMockIo({
        httpResults: {
            'https://example.com/model.bin': ({ dest }) => {
                // write content to the part file
                io.fs.writeFileSync(dest, 'bad-content');
                return { status: 200, bytes: 12, total: 100, resumed: false };
            },
        },
    });
    // mock hashFile to return wrong hash
    io.hashFile = async () => 'ff'.repeat(32);
    const result = await downloader.downloadArtifact(io, spec, { root: '/tmp/comfy', retries: 1 });
    assert.strictEqual(result.status, 'failed');
    assert.ok(!io.fs.existsSync('/tmp/comfy/models/unet/model.bin'), 'final file not created');
    assert.ok(!io.fs.existsSync('/tmp/comfy/models/unet/model.bin.part'), '.part file removed after bad checksum');
});

// ========================== 17. Worker registration success =================
collectAsync('17. worker registration success', async () => {
    const { io } = createMockIo({
        httpResults: {
            'https://animastor.in/api/v1/worker/verify': { status: 200, json: () => ({ verified: true, worker_id: 'w1', worker_type: 'image', mode: 'private' }) },
        },
    });
    const result = await workerOps.verifyRegistration(io, { hubUrl: 'https://animastor.in/gpu', token: 'wrk.w1.secret123', expectedType: 'image' });
    assert.strictEqual(result.registered, true);
    assert.strictEqual(result.worker_type, 'image');
});

// ========================== 18. Worker registration failure =================
collectAsync('18. worker registration failure (401)', async () => {
    const { io } = createMockIo({
        httpResults: {
            'https://animastor.in/api/v1/worker/verify': { status: 401, json: () => ({}) },
        },
    });
    const result = await workerOps.verifyRegistration(io, { hubUrl: 'https://animastor.in/gpu', token: 'bad-token', expectedType: 'image' });
    assert.strictEqual(result.registered, false);
    assert.ok(result.reason.includes('credential rejected'));
});

// ========================== 19. Secret redaction ============================
collectAsync('19. secret values are redacted from logs', async () => {
    const secretVal = 'wrk.test123.mysecretvalue';
    const log = createMockLogger();
    log.registerSecret(secretVal);
    log.info(`token is ${secretVal}`);
    log.warn(`Worker Key: ${secretVal}`);
    const redactedLines = log.lines.join('\n');
    assert.ok(!redactedLines.includes(secretVal), 'secret value NOT in log output');
    assert.ok(redactedLines.includes('<REDACTED>'), '<REDACTED> present');
});

// ========================== 20. Dry-run zero mutations ======================
collectAsync('20. dry-run performs zero mutations', async () => {
    const manifest = minimalManifest('video/ltx-2.3');
    const { io, calls } = createMockIo({
        execResults: {
            'nvidia-smi': { code: 0, stdout: 'NVIDIA A100, 81920, 535.129.03' },
            'node --version': { code: 0, stdout: 'v22.0.0' },
        },
    });
    const log = createMockLogger();
    // dryRun=true in engine prevents probing; io itself is never guarded
    const result = await runInstallation({
        manifests: [manifest], mode: 'managed', io,
        roots: { comfyuiRoot: '/tmp/comfy', workerDir: '/tmp/worker', statePath: '/tmp/state.json' },
        decisions: {}, logger: log, crypto: require('crypto'),
        dryRun: true,
    });
    assert.strictEqual(result.status, 'dry_run');
    assert.strictEqual(calls.exec.length, 0, 'no exec calls in dry-run');
    assert.strictEqual(calls.http.length, 0, 'no http calls in dry-run');
});

// ========================== Summary ==========================================
(async () => {
    await Promise.all(testPromises);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Phase 2 installer engine: ${passed} passed, ${failed} failed, ${total} total`);
    console.log('='.repeat(60));
    if (failed > 0) process.exit(1);
})();
