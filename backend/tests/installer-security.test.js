'use strict';

/**
 * Installer Phase 2.1 — Secret safety, shared-profile isolation, idempotency.
 *
 * Secret-safety invariant under test: the Worker Key, Hugging Face token and
 * ModelScope token VALUES must never appear in stdout, stderr, logs, install
 * state, plan, verification report, or error messages — including errors like
 * HTTP 401/403, registration failed, download failed.
 *
 *   SEC1  Worker Key value absent from logs/state/plan/result/verification
 *   SEC2  HF token absent from a 401 download error message
 *   SEC3  Worker Key absent from a registration-failure reason (401/403)
 *   SEC4  logger redacts registered secrets + bare wrk.<id>.<secret> tokens
 *   SEC5  install-state scrub drops secret-named keys before persisting
 *   SEC6  shared profiles with conflicting ComfyUI pins → REQUIRES_ISOLATION
 *         (blocked, never silently merged)
 *   SEC7  shared-compatible profiles → one shared environment, can_share
 *   SEC8  idempotent re-run: a verified model is NOT re-downloaded
 */

const assert = require('assert');
const crypto = require('crypto');
const { createMemoryFs } = require('../src/installer/engine/io');
const { createLogger } = require('../src/installer/engine/logger');
const state = require('../src/installer/engine/state');
const downloader = require('../src/installer/engine/downloader');
const workerOps = require('../src/installer/engine/worker');
const { runInstallation } = require('../src/installer/engine/engine');
const resolver = require('../src/installer/compatibility-resolver');
const { buildInstallPlan } = require('../src/installer/install-plan');
const { redactSecrets, isSecretName } = require('../src/installer/safety-rules');

const WORKER_KEY = 'wrk.live.SUPER-SECRET-VALUE-9f3a';
const HF_TOKEN = 'hf_SUPERSECRETHF TOKEN-xyz123';

// ---------------------------------------------------------------------------
// Mock io (same shape as installer-resume.test.js)
// ---------------------------------------------------------------------------

function createIo({ files = {}, preDirs = [], exec = {}, http = {} } = {}) {
    const fs = createMemoryFs(files);
    for (const d of preDirs) fs.mkdirSync(d, { recursive: true });
    const calls = { exec: [], http: [] };
    const self = {
        fs,
        calls,
        exec(cmd, args = []) {
            calls.exec.push({ cmd, args });
            const key = `${cmd} ${(args || []).join(' ')}`;
            if (cmd === 'git' && args[0] === 'clone' && args[2]) {
                self.fs.mkdirSync(args[2], { recursive: true });
                self.fs.writeFileSync(`${args[2]}/index.js`, '// stub');
            }
            return exec[key] || exec[cmd] || { code: 0, stdout: '', stderr: '' };
        },
        spawnDaemon() { return 1; },
        fetch: async () => ({ status: 200, json: () => ({}), text: () => '' }),
        http: {
            async download({ url, dest }) {
                calls.http.push({ op: 'download', url, dest });
                const h = http[url];
                if (!h) throw new Error(`unexpected download ${url}`);
                return h({ dest, fs: self.fs });
            },
            async fetchJson(url) {
                calls.http.push({ op: 'fetchJson', url });
                const h = http[url];
                if (h && typeof h === 'function') return h();
                if (h) return h;
                return { status: 500, json: null };
            },
            async fetchText(url) {
                calls.http.push({ op: 'fetchText', url });
                const h = http[url];
                if (h && typeof h === 'function') return h();
                if (h) return h;
                return { status: 404, text: '' };
            },
        },
        async hashFile() { return 'deadbeef'.repeat(8); },
        now: (() => { let t = 1700000000000; return () => (t += 10); })(),
    };
    return self;
}

function baseExec() {
    return {
        'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 0, stdout: 'NVIDIA RTX 4090, 24564, 550' },
        'nvidia-smi': { code: 0, stdout: 'x\nCUDA Version: 12.4' },
        'node --version': { code: 0, stdout: 'v22.0.0' },
        'git -C /comfy remote get-url origin': { code: 0, stdout: 'https://github.com/comfyanonymous/ComfyUI' },
        'git -C /comfy rev-parse HEAD': { code: 0, stdout: 'abc123' },
        'git -C /comfy describe --tags --exact-match': { code: 0, stdout: 'v0.27.0' },
        'python3 --version': { code: 0, stdout: 'Python 3.11.0' },
        'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.6.0+cu124' },
        npm: { code: 0, stdout: '', stderr: '' },
    };
}

function manifestWithModel() {
    return {
        profile: { id: 'video/ltx-2.3', name: 'LTX' },
        runtime_requirements: {
            comfyui: { pin: { tag: 'v0.27.0', repository: 'https://github.com/comfyanonymous/ComfyUI' }, min_version: '0.27.0', max_tested_version: '0.27.0' },
            torch: { pin: '2.6.0+cu124' },
        },
        dependencies: [{
            id: 'm-one', kind: 'model', name: 'one', requirement: 'required',
            target_dir: 'models/unet', filename: 'one.safetensors',
            source: { kind: 'huggingface', repository: 'test/repo', file_path: 'one.safetensors', verification: 'verified' },
            size_bytes_approx: 1024,
            checksum: { algo: 'sha256', value: 'deadbeef'.repeat(8) },
        }],
        workflows: { policy: 'editable-baseline', artifacts: [] },
        worker_bundle: {
            worker_type: 'video',
            files: ['worker.cjs', 'package.json'],
            env: { required: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'], secrets: ['ANIMASTOR_WORKER_TOKEN'] },
        },
    };
}

const MODEL_URL = 'https://huggingface.co/test/repo/resolve/main/one.safetensors';
const ALL_YES = {
    comfyui_update: 'yes', install_custom_nodes: true, install_models: true,
    workflows: 'none', worker_setup: true, worker_key_provided: true,
};

function existingComfyIo(extraHttp = {}) {
    return createIo({
        files: {
            '/comfy/main.py': '',
            '/repo/worker/worker/worker.cjs': '// stub',
            '/repo/worker/worker/package.json': '{}',
        },
        preDirs: ['/comfy/.git', '/repo/worker/worker'],
        exec: baseExec(),
        http: {
            'http://127.0.0.1:8188/system_stats': { status: 200, json: () => ({ system: {} }) },
            [MODEL_URL]: ({ dest, fs }) => {
                fs.writeFileSync(dest, 'x'.repeat(1024));
                return { status: 200, bytes: 1024, total: 1024, resumed: false };
            },
            ...extraHttp,
        },
    });
}

let passed = 0; let failed = 0;
const pending = [];
function t(name, fn) {
    pending.push(Promise.resolve()
        .then(fn)
        .then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch((err) => { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }));
}

// ---------------------------------------------------------------------------
// SEC1 — Worker Key never appears anywhere
// ---------------------------------------------------------------------------

t('SEC1: Worker Key value absent from logs, state, plan, result, verification', async () => {
    const io = existingComfyIo();
    const log = createLogger({ io, quiet: true });
    const result = await runInstallation({
        manifests: [manifestWithModel()], mode: 'existing', io,
        roots: { comfyuiRoot: '/comfy', workerDir: '/worker', statePath: '/state/install-state.json', repoRoot: '/repo', hubUrl: null },
        decisions: ALL_YES, logger: log, crypto,
        secretProvider: async (n) => (n === 'ANIMASTOR_WORKER_TOKEN' ? WORKER_KEY : null),
        options: { startComfyui: false },
    });

    const surfaces = {
        logs: log.lines.join('\n'),
        state: io.fs.readFileSync('/state/install-state.json', 'utf8'),
        plan: result.plan.plan_text,
        result: JSON.stringify(result),
        verification: result.verification ? result.verification.text : '',
    };
    for (const [name, text] of Object.entries(surfaces)) {
        assert.ok(!text.includes(WORKER_KEY), `Worker Key leaked into ${name}`);
    }
    // The .env legitimately contains the key — that is its purpose — but it must
    // be chmod 600 and never echoed. Confirm the file itself holds it (sanity).
    assert.ok(io.fs.readFileSync('/worker/.env', 'utf8').includes(WORKER_KEY), '.env holds the key (expected)');
});

// ---------------------------------------------------------------------------
// SEC2 — HF token not leaked in a 401 download error
// ---------------------------------------------------------------------------

t('SEC2: HF token absent from 401 download error message', async () => {
    const io = createIo({});
    const spec = {
        id: 'm-gated', kind: 'huggingface', ready: true,
        url: 'https://huggingface.co/gated/repo/resolve/main/model.safetensors',
        target_path: 'models/unet/model.safetensors',
    };
    io.http.download = async () => ({ status: 401, bytes: 0, total: null, resumed: false, error: 'Repository requires authentication' });
    const getHeader = () => ({ Authorization: `Bearer ${HF_TOKEN}` });
    const log = createLogger({ io, quiet: true });
    const res = await downloader.downloadArtifact(io, spec, { root: '/comfy', getHeader, retries: 1, retryDelayMs: 1, log });
    assert.strictEqual(res.status, 'failed');
    const combined = `${res.reason}\n${log.lines.join('\n')}`;
    assert.ok(!combined.includes(HF_TOKEN), 'HF token leaked into download error/log');
    assert.ok(/authentication|401/i.test(combined), 'error still explains the auth problem');
});

// ---------------------------------------------------------------------------
// SEC3 — Worker Key not leaked in registration failure
// ---------------------------------------------------------------------------

t('SEC3: Worker Key absent from registration-failure reason (401/403)', async () => {
    for (const status of [401, 403]) {
        const io = createIo({});
        io.http.fetchJson = async () => ({ status, json: () => ({}) });
        const res = await workerOps.verifyRegistration(io, { hubUrl: 'https://animastor.in/gpu', token: WORKER_KEY, expectedType: 'image' });
        assert.strictEqual(res.registered, false);
        assert.ok(!JSON.stringify(res).includes(WORKER_KEY), `token leaked into ${status} registration result`);
        assert.ok(/credential rejected/i.test(res.reason), `${status} reason explains rejection without the secret`);
    }
});

// ---------------------------------------------------------------------------
// SEC4 — logger redaction (registered secrets + bare wrk tokens)
// ---------------------------------------------------------------------------

t('SEC4: logger redacts registered secrets and bare wrk.<id>.<secret> tokens', async () => {
    const io = createIo({});
    const log = createLogger({ io, quiet: true });
    log.registerSecret(WORKER_KEY);
    log.info(`using token ${WORKER_KEY} now`);
    log.warn(`leaked bare token wrk.abc123.some-secret-value here`);
    const text = log.lines.join('\n');
    assert.ok(!text.includes(WORKER_KEY), 'registered secret redacted');
    assert.ok(text.includes('<REDACTED>'), '<REDACTED> marker present');
    assert.ok(!text.includes('some-secret-value'), 'bare wrk token scrubbed');
});

// ---------------------------------------------------------------------------
// SEC5 — state scrub drops secret-named keys
// ---------------------------------------------------------------------------

t('SEC5: install-state scrub removes secret-named keys before persisting', async () => {
    const io = createIo({});
    const st = state.emptyState({ mode: 'existing', profiles: ['video/ltx-2.3'], root: '/comfy' });
    state.setArtifact(st, 'm-one', 'installed', { HF_TOKEN: HF_TOKEN, note: 'ok' });
    st.decisions = { worker_key_provided: true };
    state.saveState(io, '/state/install-state.json', st, io.now);
    const saved = io.fs.readFileSync('/state/install-state.json', 'utf8');
    assert.ok(!saved.includes(HF_TOKEN), 'HF token value not persisted');
    assert.ok(!saved.includes('HF_TOKEN'), 'secret-named key dropped entirely');
    assert.ok(saved.includes('"note"'), 'non-secret detail preserved');
    assert.ok(isSecretName('ANIMASTOR_WORKER_TOKEN') && isSecretName('HF_TOKEN') && isSecretName('MODELSCOPE_API_TOKEN'),
        'secret-name classifier recognises worker/HF/ModelScope keys');
});

// ---------------------------------------------------------------------------
// SEC6 — shared profiles with conflicting ComfyUI pins → REQUIRES_ISOLATION
// ---------------------------------------------------------------------------

function sharedManifest(profileId, comfyTag, torchPin) {
    return {
        profile: { id: profileId, name: profileId },
        runtime_requirements: {
            comfyui: { pin: { tag: comfyTag, repository: 'https://github.com/comfyanonymous/ComfyUI' }, min_version: comfyTag.replace(/^v/, ''), max_tested_version: comfyTag.replace(/^v/, '') },
            torch: { pin: torchPin },
        },
        dependencies: [],
        workflows: { policy: 'editable-baseline', artifacts: [] },
        worker_bundle: { worker_type: 'image', files: ['worker.cjs'], env: { required: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN'], secrets: ['ANIMASTOR_WORKER_TOKEN'] } },
    };
}

t('SEC6: conflicting ComfyUI pins → REQUIRES_ISOLATION, never silently merged', async () => {
    const m1 = sharedManifest('image/a', 'v0.27.0', '2.6.0+cu124');
    const m2 = sharedManifest('video/b', 'v0.30.0', '2.6.0+cu124');
    const sharing = resolver.resolveSharedRuntime([m1, m2]);
    assert.strictEqual(sharing.verdict, 'requires-isolation');
    assert.strictEqual(sharing.can_share, false);

    const io = createIo({ files: { '/comfy/main.py': '' }, preDirs: ['/comfy/.git'], exec: baseExec() });
    const env = { root: '/comfy', comfyui: undefined, python: undefined, torch: undefined, nodejs: undefined, gpu: null, custom_nodes: [], models: [], python_packages: [], workflows: [], worker: null };
    const report = resolver.resolveInstallation({ manifests: [m1, m2], environment: env, mode: 'shared' });
    const plan = buildInstallPlan({ report, manifests: [m1, m2], decisions: {} });
    assert.ok(plan.blocked.length > 0, 'plan is blocked');
    assert.ok(plan.blocked.some((b) => b.code === 'REQUIRES_ISOLATION'),
        'blocked entry carries machine-readable REQUIRES_ISOLATION code');
    assert.ok(/REQUIRES_ISOLATION/.test(plan.plan_text), 'plan text surfaces the REQUIRES_ISOLATION verdict');
    assert.ok(/isolation/i.test(plan.blocked.map((b) => `${b.reason} ${b.detail || ''}`).join('\n')),
        'blocked reason recommends isolation');
    assert.strictEqual(plan.safe_to_proceed, false, 'never silently merged');
});

// ---------------------------------------------------------------------------
// SEC7 — shared-compatible profiles share ONE environment
// ---------------------------------------------------------------------------

t('SEC7: shared-compatible profiles → single shared environment (can_share)', async () => {
    const m1 = sharedManifest('image/a', 'v0.27.0', '2.6.0+cu124');
    const m2 = sharedManifest('image/b', 'v0.27.0', '2.6.0+cu124');
    const sharing = resolver.resolveSharedRuntime([m1, m2]);
    assert.strictEqual(sharing.verdict, 'shared-compatible');
    assert.strictEqual(sharing.can_share, true);

    const io = createIo({ files: { '/comfy/main.py': '' }, preDirs: ['/comfy/.git'], exec: baseExec() });
    const env = { root: '/comfy', comfyui: undefined, python: undefined, torch: undefined, nodejs: undefined, gpu: null, custom_nodes: [], models: [], python_packages: [], workflows: [], worker: null };
    const report = resolver.resolveInstallation({ manifests: [m1, m2], environment: env, mode: 'shared' });
    const plan = buildInstallPlan({ report, manifests: [m1, m2], decisions: {} });
    const isolationBlocked = plan.blocked.filter((b) => b.code === 'REQUIRES_ISOLATION' || b.code === 'SHARED_CONFLICT');
    assert.strictEqual(isolationBlocked.length, 0, 'compatible profiles are NOT isolation-blocked');
});

// ---------------------------------------------------------------------------
// SEC8 — idempotent re-run: verified model not re-downloaded
// ---------------------------------------------------------------------------

t('SEC8: idempotent re-run does NOT re-download a verified model', async () => {
    const io = existingComfyIo();
    const log = createLogger({ io, quiet: true });
    const run = () => runInstallation({
        manifests: [manifestWithModel()], mode: 'existing', io,
        roots: { comfyuiRoot: '/comfy', workerDir: '/worker', statePath: '/state/install-state.json', repoRoot: '/repo', hubUrl: null },
        decisions: ALL_YES, logger: log, crypto,
        secretProvider: async (n) => (n === 'ANIMASTOR_WORKER_TOKEN' ? WORKER_KEY : null),
        options: { startComfyui: false },
    });

    const r1 = await run();
    const downloadsAfter1 = io.calls.http.filter((c) => c.op === 'download').length;
    assert.strictEqual(downloadsAfter1, 1, 'first run downloads the model once');
    assert.ok(r1.results.models.some((m) => m.id === 'm-one' && m.status === 'downloaded'));

    const r2 = await run();
    const downloadsAfter2 = io.calls.http.filter((c) => c.op === 'download').length;
    assert.strictEqual(downloadsAfter2, downloadsAfter1, 'second run performs ZERO new downloads');
    assert.ok(r2.results.models.every((m) => m.status !== 'downloaded'), 'no model re-downloaded on re-run');
});

// ---------------------------------------------------------------------------

(async () => {
    await Promise.all(pending);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Installer Phase 2.1 security/shared/idempotency: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));
    if (failed > 0) process.exit(1);
})();
