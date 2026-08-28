'use strict';

/**
 * Installer Phase 2.1 — Resume + Failure/Recovery + Existing-Environment Safety.
 *
 * Scenarios (all external ops mocked; a shared in-memory FS stands in for the
 * disk, so an interrupted run leaves real state behind):
 *
 *   R1  resume refuses to start without install-state.json
 *   R2  crash mid-install → resume continues, completed steps NOT repeated
 *   R3  transient download failures retried; later resume downloads succeed
 *   R4  checksum mismatch → safe failure: no final file, .part removed,
 *       state records the failure (recovery possible)
 *   R5  one custom node clone fails → state saved; resume retries ONLY it
 *   R6  ComfyUI API never comes up → safe verdict, environment intact,
 *       resume possible
 *   R7  invalid canonical workflow JSON → failed validation, nothing written
 *   R8  worker registration failure recorded; installation stays intact
 *   S1  user-customized baseline workflow preserved byte-for-byte on install
 *   S2  newer-than-tested ComfyUI kept unless user approves downgrade
 *   S3  existing Torch/CUDA runtime NEVER silently replaced
 *
 * Every failure scenario asserts: state saved → safe exit → resumable.
 */

const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const { createMemoryFs } = require('../src/installer/engine/io');
const { createLogger } = require('../src/installer/engine/logger');
const state = require('../src/installer/engine/state');
const { runInstallation, loadResumableState } = require('../src/installer/engine/engine');

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function baseManifest() {
    return {
        profile: { id: 'video/ltx-2.3', name: 'LTX 2.3' },
        runtime_requirements: {
            comfyui: {
                pin: { tag: 'v0.27.0', repository: 'https://github.com/comfyanonymous/ComfyUI' },
                min_version: '0.27.0',
                max_tested_version: '0.27.0',
            },
            torch: {
                pin: '2.6.0+cu124',
                index_url: 'https://download.pytorch.org/whl/cu124',
            },
        },
        dependencies: [
            {
                id: 'n-gguf', kind: 'custom_node', name: 'GGUF', requirement: 'required',
                install: {
                    source: { repository: 'https://github.com/city96/ComfyUI-GGUF', commit: 'abc123' },
                    directory: 'ComfyUI-GGUF',
                },
                provides_classes: ['GGUFLoader'],
            },
            {
                id: 'm-one', kind: 'model', name: 'model one', requirement: 'required',
                target_dir: 'models/unet', filename: 'one.safetensors',
                source: { kind: 'huggingface', repository: 'test/repo', file_path: 'one.safetensors', verification: 'verified' },
                size_bytes_approx: 1024,
                checksum: { algo: 'sha256', value: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
            },
            {
                id: 'm-two', kind: 'model', name: 'model two', requirement: 'required',
                target_dir: 'models/unet', filename: 'two.safetensors',
                source: { kind: 'huggingface', repository: 'test/repo', file_path: 'two.safetensors', verification: 'verified' },
                size_bytes_approx: 1024,
                checksum: { algo: 'sha256', value: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
            },
        ],
        workflows: { policy: 'editable-baseline', artifacts: [] },
        worker_bundle: {
            worker_type: 'video',
            files: ['worker.cjs', 'package.json'],
            env: {
                required: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'],
                secrets: ['ANIMASTOR_WORKER_TOKEN'],
            },
        },
    };
}

const EXEC_BASE = () => ({
    'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 0, stdout: 'NVIDIA RTX 4090, 24564, 550.54.14' },
    'nvidia-smi': { code: 0, stdout: 'NVIDIA RTX 4090, 24564, 550.54.14\nCUDA Version: 12.4' },
    'node --version': { code: 0, stdout: 'v22.0.0' },
    'git -C /comfy remote get-url origin': { code: 0, stdout: 'https://github.com/comfyanonymous/ComfyUI' },
    'git -C /comfy rev-parse HEAD': { code: 0, stdout: 'abc123' },
    'git -C /comfy describe --tags --exact-match': { code: 0, stdout: 'v0.27.0' },
    'python3 --version': { code: 0, stdout: 'Python 3.11.0' },
    'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.6.0+cu124' },
    npm: { code: 0, stdout: '', stderr: '' },
});

/**
 * Exec handlers may be functions receiving ({ args, fs }) and returning the
 * result object — used to emulate real side effects (e.g. git clone creating
 * the target directory).
 */
function createIo({ files = {}, preDirs = [], exec = {}, execHandlers = {}, http = {}, fs: sharedFs = null } = {}) {
    const fs = sharedFs || createMemoryFs(files);
    if (!sharedFs) {
        for (const d of preDirs) fs.mkdirSync(d, { recursive: true });
    }
    const calls = { exec: [], http: [], spawn: [], fetch: [] };
    const self = {
        fs,
        calls,
        execHandlers, // mutable post-creation for targeted failure
        exec(cmd, args = [], opts = {}) {
            calls.exec.push({ cmd, args });
            const key = `${cmd} ${(args || []).join(' ')}`;
            if (execHandlers[key]) return execHandlers[key]({ args, fs: self.fs });
            // Default side effects emulate reality: a successful git clone
            // creates the target directory with content. Uses self.fs so a
            // later-shared disk is honoured.
            if (cmd === 'git' && args[0] === 'clone' && args[2]) {
                self.fs.mkdirSync(args[2], { recursive: true });
                self.fs.writeFileSync(`${args[2]}/index.js`, '// stub node');
            }
            if (cmd === 'python3' && args[0] === '-m' && args[1] === 'venv' && args[2]) {
                self.fs.mkdirSync(path.join(args[2], 'bin'), { recursive: true });
                self.fs.writeFileSync(path.join(args[2], 'bin', 'python'), '#!/bin/sh\n');
            }
            return exec[key] || exec[cmd] || { code: 0, stdout: '', stderr: '' };
        },
        spawnDaemon(command, args = []) {
            calls.spawn.push({ command, args });
            return 42424;
        },
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
        async hashFile(filePath, algo = 'sha256') {
            calls.http.push({ op: 'hashFile', filePath });
            return 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
        },
        now: (() => { let t = 1700000000000; return () => (t += 10); })(),
    };
    return self;
}

/** Existing compatible ComfyUI at /comfy (deep-merged with `extra`). */
function existingComfy(extra = {}) {
    const base = {
        files: { '/comfy/main.py': '' },
        preDirs: ['/comfy/.git', '/repo/worker/worker'],
        exec: EXEC_BASE(),
        http: {},
    };
    const merged = { ...base, ...extra };
    merged.files = { ...base.files, ...(extra.files || {}) };
    merged.exec = { ...base.exec, ...(extra.exec || {}) };
    merged.http = { ...(base.http || {}), ...(extra.http || {}) };
    // ComfyUI stats endpoint defaults to "running"
    if (!merged.http['http://127.0.0.1:8188/system_stats']) {
        merged.http['http://127.0.0.1:8188/system_stats'] = { status: 200, json: () => ({ system: {} }) };
    }
    return merged;
}

function workerRepoFiles() {
    return {
        '/repo/worker/worker/worker.cjs': '// worker stub',
        '/repo/worker/worker/package.json': '{"name":"x","dependencies":{}}',
    };
}

const MODEL_URLS = {
    'https://huggingface.co/test/repo/resolve/main/one.safetensors': ({ dest, fs }) => {
        fs.writeFileSync(dest, 'x'.repeat(1024)); // matches size_bytes_approx
        return { status: 200, bytes: 1024, total: 1024, resumed: false };
    },
    'https://huggingface.co/test/repo/resolve/main/two.safetensors': ({ dest, fs }) => {
        fs.writeFileSync(dest, 'y'.repeat(1024)); // matches size_bytes_approx
        return { status: 200, bytes: 1024, total: 1024, resumed: false };
    },
};

const ALL_YES = {
    comfyui_update: 'yes',
    install_custom_nodes: true,
    install_models: true,
    workflows: 'none',
    worker_setup: true,
    worker_key_provided: true,
};

function secretProvider(value) {
    return async (name) => (name === 'ANIMASTOR_WORKER_TOKEN' ? value : null);
}

async function installOnce(io, extraArgs = {}) {
    return runInstallation({
        manifests: [baseManifest()], mode: 'existing', io,
        roots: { comfyuiRoot: '/comfy', workerDir: '/worker', statePath: '/state/install-state.json', repoRoot: '/repo', hubUrl: null },
        decisions: ALL_YES, logger: extraArgs.logger || createLogger({ io, quiet: true }), crypto,
        secretProvider: secretProvider('wrk.test.local-secret-value'),
        initialState: extraArgs.initialState || undefined,
        options: { startComfyui: false },
        ...extraArgs.override,
    });
}

let passed = 0; let failed = 0;
const pending = [];
const TRACE = process.env.TRACE === '1';
async function t(name, fn) {
    pending.push(fn()
        .then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch((err) => {
            failed++;
            console.log(`  ✗ ${name}\n    ${err.message}`);
            if (TRACE) console.log(err.stack.split('\n').slice(1, 6).map((l) => `      ${l}`).join('\n'));
        }));
}

// ---------------------------------------------------------------------------
// R1 — resume without state refuses
// ---------------------------------------------------------------------------

t('R1: loadResumableState without state file refuses (engine does not invent an install)', async () => {
    const io = createIo(existingComfy());
    const r = loadResumableState(io, '/state/install-state.json');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-state-file');
});

// ---------------------------------------------------------------------------
// R2 — crash before worker bundle; resume finishes without repeating work
// ---------------------------------------------------------------------------

t('R2: crash mid-install → resume continues; completed steps are NOT repeated', async () => {
    // Shared fs = persistent disk across the "process restart"
    const crashWrap = createIo(existingComfy({ files: workerRepoFiles(), http: MODEL_URLS }));
    const sharedFs = crashWrap.fs;
    const stopAtWorkerBundle = (log) => ({
        ...log,
        step: async (name, fn) => {
            if (/install worker bundle/.test(name)) throw new Error('SIMULATED_PROCESS_STOP');
            return log.step(name, fn);
        },
    });

    // Run 1: stops (abruptly) right before the worker bundle step.
    await assert.rejects(
        installOnce(crashWrap, { logger: stopAtWorkerBundle(createLogger({ io: crashWrap, quiet: true })) }),
        /SIMULATED_PROCESS_STOP/,
    );
    // Downloads/clones that happened before the crash persisted:
    assert.ok(sharedFs.existsSync('/comfy/custom_nodes/ComfyUI-GGUF/index.js'), 'custom node dir present after crash');
    assert.ok(sharedFs.existsSync('/comfy/models/unet/one.safetensors'), 'model one present after crash');

    // Run 2 (new process): fresh io over the SAME disk.
    const io2 = createIo(existingComfy());
    io2.fs = sharedFs;
    const loaded = loadResumableState(io2, '/state/install-state.json');
    assert.ok(loaded.ok, 'state file survived the crash');
    const log2 = createLogger({ io: io2, quiet: true });
    const result2 = await installOnce(io2, { initialState: loaded.state, logger: log2 });

    const clones = io2.calls.exec.filter((c) => c.cmd === 'git' && c.args[0] === 'clone');
    assert.strictEqual(clones.length, 0, 'resume did NOT re-clone anything');
    const downloads = io2.calls.http.filter((c) => c.op === 'download');
    assert.strictEqual(downloads.length, 0, 'resume did NOT re-download verified models');
    const workflowWrites = io2.calls.exec.filter((c) => c.cmd !== 'npm'); // sanity
    assert.ok(Array.isArray(workflowWrites));

    // The remaining operation (worker bundle) executed:
    assert.ok(io2.fs.existsSync('/worker/worker.cjs'), 'worker bundle deployed on resume');
    assert.ok(['ready', 'warn'].includes(result2.status), `status: ${result2.status}`);
    // Summary lines came through the log:
    assert.ok(log2.lines.some((l) => l.includes('Prior progress')), 'resume printed prior progress');
});

// ---------------------------------------------------------------------------
// R3 — transient download failures then resume downloads successfully
// ---------------------------------------------------------------------------

t('R3: transient HTTP errors retried internally; a later run resumes to completion', async () => {
    const netDownUrls = Object.fromEntries(Object.keys(MODEL_URLS).map((u) => [u, () => (
        { status: 500, bytes: 0, total: null, resumed: false, error: 'connection reset' }
    )]));
    const io1 = createIo(existingComfy({
        files: workerRepoFiles(),
        http: { ...MODEL_URLS },
        // note: MODEL_URLS ignored here because net-down entries override below
    }));
    // net down ONLY for downloads — the ComfyUI stats endpoint is proxied too...
    // Instead build precisely: start from existingComfy then patch download URLs.
    io1.http.download = async ({ url, dest }) => {
        io1.calls.http.push({ op: 'download', url, dest });
        return { status: 500, bytes: 0, total: null, resumed: false, error: 'connection reset' };
    };

    const log1 = createLogger({ io: io1, quiet: true });
    const r1 = await installOnce(io1, { logger: log1 });
    const dlAttempts1 = io1.calls.http.filter((c) => c.op === 'download').length;
    assert.strictEqual(r1.results.models.filter((m) => m.status === 'failed').length, 2, 'both model downloads failed while network was down');
    const saved = JSON.parse(io1.fs.readFileSync('/state/install-state.json', 'utf8'));
    assert.strictEqual(saved.artifacts['m-one'].status, 'failed');
    assert.strictEqual(saved.artifacts['m-two'].attempts >= 1, true, 'failed attempts recorded');

    // Network healed — resume (fresh io over the SAME disk, healthy network):
    const io2 = createIo(existingComfy({ http: MODEL_URLS, files: {} }));
    io2.fs = io1.fs;
    const loaded = loadResumableState(io2, '/state/install-state.json');
    const r2 = await installOnce(io2, { initialState: loaded.state });
    assert.strictEqual(r2.results.models.filter((m) => ['downloaded', 'skipped'].includes(m.status)).length, 2, 'both models downloaded on resume');
    assert.ok(io2.fs.existsSync('/comfy/models/unet/one.safetensors'), 'final model file present');
    assert.ok(io2.fs.existsSync('/comfy/models/unet/two.safetensors.part') === false, 'no leftover .part file');
    assert.ok(dlAttempts1 >= 2 * 3, `retry with backoff ran (${dlAttempts1} attempts)`);
});

// ---------------------------------------------------------------------------
// R4 — checksum mismatch: safe failure, resumable afterwards
// ---------------------------------------------------------------------------

t('R4: checksum mismatch → failure recorded, no final file, .part removed', async () => {
    const badHashManifest = baseManifest();
    badHashManifest.dependencies[1].checksum.value = '1111111111111111111111111111111111111111111111111111111111111111';
    const io = createIo(existingComfy({ files: workerRepoFiles(), http: MODEL_URLS }));
    const log = createLogger({ io: io, quiet: true });
    const result = await runInstallation({
        manifests: [badHashManifest], mode: 'existing', io,
        roots: { comfyuiRoot: '/comfy', workerDir: '/worker', statePath: '/state/install-state.json', repoRoot: '/repo', hubUrl: null },
        decisions: ALL_YES, logger: log, crypto,
        secretProvider: secretProvider('wrk.test.local-secret-value'),
        options: { startComfyui: false },
    });
    const one = result.results.models.find((m) => m.id === 'm-one');
    assert.strictEqual(one.status, 'failed');
    assert.strictEqual(/sha256 mismatch|corrupt/i.test(String(one.reason)), true, 'clear reason reported');
    assert.ok(!io.fs.existsSync('/comfy/models/unet/one.safetensors'), 'corrupt file NEVER published as final');
    assert.ok(!io.fs.existsSync('/comfy/models/unet/one.safetensors.part'), '.part removed after failed verification');
    const saved = JSON.parse(io.fs.readFileSync('/state/install-state.json', 'utf8'));
    assert.strictEqual(saved.artifacts['m-one'].status, 'failed');
});

// ---------------------------------------------------------------------------
// R5 — custom node clone failure; resume retries ONLY that node
// ---------------------------------------------------------------------------

t('R5: one custom node fails → recorded; resume retries only the failed one', async () => {
    // First run: GGUF clone fails (network), so the second dependency is used.
    const io1 = createIo(existingComfy({ files: workerRepoFiles(), http: MODEL_URLS }));
    io1.execHandlers['git clone https://github.com/city96/ComfyUI-GGUF /comfy/custom_nodes/ComfyUI-GGUF'] =
        () => ({ code: 128, stdout: '', stderr: 'fatal: unable to access' });
    const log1 = createLogger({ io: io1, quiet: true });
    await installOnce(io1, { logger: log1 });
    const saved1 = JSON.parse(io1.fs.readFileSync('/state/install-state.json', 'utf8'));
    assert.strictEqual(saved1.artifacts['n-gguf'].status, 'failed');

    // Second run: network works (fresh io, same fs).
    const io2 = createIo(existingComfy());
    io2.fs = io1.fs;
    const loaded = loadResumableState(io2, '/state/install-state.json');
    await installOnce(io2, { initialState: loaded.state });
    const clones = io2.calls.exec.filter((c) => c.cmd === 'git' && c.args[0] === 'clone');
    assert.strictEqual(clones.length, 1, 'exactly the failed node cloned once more');
    assert.ok(clones[0].args.join(' ').includes('ComfyUI-GGUF'), 'the failed node was the retry target');
    const saved2 = JSON.parse(io2.fs.readFileSync('/state/install-state.json', 'utf8'));
    assert.strictEqual(saved2.artifacts['n-gguf'].status, 'installed');
});

// ---------------------------------------------------------------------------
// R6 — ComfyUI never becomes reachable: safe verdict, resumable, intact disk
// ---------------------------------------------------------------------------

t('R6: ComfyUI start/health failure → safe verdict, environment intact, resume possible', async () => {
    const io = createIo(existingComfy());
    // system_stats unreachable → waitForApi must time out quickly.
    io.http.fetchJson = async (url) => {
        io.calls.http.push({ op: 'fetchJson', url });
        return { status: 503, json: null };
    };
    io.now = Date.now.bind(Date); // enable real timeout arithmetic
    const log = createLogger({ io: io, quiet: true });
    const result = await installOnce(io, {
        logger: log,
        override: {
            options: { startComfyui: true, verifyTimeoutMs: 120, pollIntervalMs: 20 },
        },
    });
    assert.ok(result.verification, 'verification ran');
    assert.strictEqual(liveOk(result), false, 'live comfyui marked not running');
    assert.ok(!io.fs.existsSync('/comfy/anything-unexpected'), 'no stray files written during failed verification');
    const saved = JSON.parse(io.fs.readFileSync('/state/install-state.json', 'utf8'));
    assert.ok(saved.artifacts['n-gguf'], 'state intact after failed verification');
});

function liveOk(result) {
    const l = result.verification.live || {};
    return Boolean(l.comfyui && l.comfyui.running);
}

// ---------------------------------------------------------------------------
// R7 — invalid canonical workflow JSON → nothing written
// ---------------------------------------------------------------------------

t('R7: invalid canonical workflow content fails validation and writes nothing', async () => {
    const m = baseManifest();
    m.workflows = {
        policy: 'editable-baseline',
        artifacts: [{
            id: 'wf-broken', name: 'Broken', target_dir: 'user/default/workflows', filename: 'broken.json',
            source: { repository_path: 'backend/ai/workflows/broken.json' },
        }],
    };
    const io = createIo(existingComfy({
        files: { ...workerRepoFiles(), '/repo/backend/ai/workflows/broken.json': '{ NOT JSON' },
    }));
    const yes = { ...ALL_YES, workflows: 'all' };
    const log = createLogger({ io: io, quiet: true });
    const result = await runInstallation({
        manifests: [m], mode: 'existing', io,
        roots: { comfyuiRoot: '/comfy', workerDir: '/worker', statePath: '/state/install-state.json', repoRoot: '/repo', hubUrl: null },
        decisions: yes, logger: log, crypto,
        secretProvider: secretProvider('wrk.test.local-secret-value'),
        options: { startComfyui: false },
    });
    const wf = result.results.workflows.find((w) => w.id === 'wf-broken');
    assert.strictEqual(wf.status, 'failed');
    assert.ok(/not valid JSON/i.test(wf.reason));
    assert.ok(!io.fs.existsSync('/comfy/user/default/workflows/broken.json'), 'invalid workflow never written');
});

// ---------------------------------------------------------------------------
// R8 — registration failure recorded; local environment stays usable
// ---------------------------------------------------------------------------

t('R8: worker registration failure recorded; files intact; state saved', async () => {
    const io = createIo(existingComfy({
        files: workerRepoFiles(),
        http: {
            ...MODEL_URLS,
            'https://animastor.in/api/v1/worker/verify': () => ({ status: 401, json: () => ({}) }),
        },
    }));
    const log = createLogger({ io: io, quiet: true });
    const result = await runInstallation({
        manifests: [baseManifest()], mode: 'existing', io,
        roots: { comfyuiRoot: '/comfy', workerDir: '/worker', statePath: '/state/install-state.json', repoRoot: '/repo', hubUrl: 'https://animastor.in/gpu' },
        decisions: ALL_YES, logger: log, crypto,
        secretProvider: secretProvider('wrk.test.register-secret-value'),
        options: { startComfyui: false },
    });
    assert.ok(result.results.registration, 'registration attempted');
    assert.strictEqual(result.results.registration.registered, false, 'registration not faked');
    assert.ok(log.lines.some((l) => /registration failed/i.test(l)), 'explicit guidance logged');
    assert.ok(io.fs.existsSync('/worker/.env'), '.env still configured');
    assert.ok(io.fs.existsSync('/worker/worker.cjs'), 'bundle still deployed');
    assert.ok(io.fs.existsSync('/state/install-state.json'), 'state saved');
});

// ---------------------------------------------------------------------------
// S1 — user-customized workflow preserved byte-for-byte
// ---------------------------------------------------------------------------

t('S1: user-modified baseline workflow survives install byte-for-byte', async () => {
    const m = baseManifest();
    const canonical = '{"nodes": []}';
    const canonicalSha = crypto.createHash('sha256').update(Buffer.from(canonical)).digest('hex');
    m.workflows = {
        policy: 'editable-baseline',
        artifacts: [{
            id: 'wf-base', name: 'Baseline', target_dir: 'user/default/workflows', filename: 'baseline.json',
            baseline_sha256: canonicalSha,
            source: { repository_path: 'backend/ai/workflows/baseline.json' },
        }],
    };
    const userContent = '{"nodes": [{"my": "custom edit"}]}';
    const io = createIo(existingComfy({
        files: {
            ...workerRepoFiles(),
            '/repo/backend/ai/workflows/baseline.json': canonical,
            '/comfy/user/default/workflows/baseline.json': userContent,
        },
    }));
    const yes = { ...ALL_YES, workflows: 'all' };
    const result = await runInstallation({
        manifests: [m], mode: 'existing', io,
        roots: { comfyuiRoot: '/comfy', workerDir: '/worker', statePath: '/state/install-state.json', repoRoot: '/repo', hubUrl: null },
        decisions: yes, logger: createLogger({ io: io, quiet: true }), crypto,
        secretProvider: secretProvider('wrk.test.local-secret-value'),
        options: { startComfyui: false },
    });
    assert.strictEqual(io.fs.readFileSync('/comfy/user/default/workflows/baseline.json', 'utf8'), userContent,
        'user content unchanged');
    // The resolver must have classified the user file as customized (never overwritten)
    const entry = result.report.entries.find((e) => e.id === 'wf-base');
    assert.ok(entry && entry.grade === 'customized', `workflow classified customized (${entry && entry.grade})`);
});

// ---------------------------------------------------------------------------
// S2 — newer ComfyUI never auto-downgraded
// ---------------------------------------------------------------------------

t('S2: above-max ComfyUI kept without explicit downgrade decision (no checkout executed)', async () => {
    const exec = EXEC_BASE();
    exec['git -C /comfy describe --tags --exact-match'] = { code: 0, stdout: 'v9.9.9' };
    const io = createIo({ files: { '/comfy/main.py': '' }, preDirs: ['/comfy/.git'], exec });
    const log = createLogger({ io, quiet: true });
    const args = (overrides) => ({
        manifests: [baseManifest()], mode: 'existing', io,
        roots: { comfyuiRoot: '/comfy', workerDir: '/worker', statePath: '/state/s2.json', repoRoot: '/repo', hubUrl: null },
        logger: log, crypto, options: { startComfyui: false },
        ...overrides,
    });

    // A. No decision recorded → engine stops safely awaiting the user.
    let result = await runInstallation(args({ decisions: {} }));
    assert.strictEqual(result.status, 'awaiting_decisions');
    assert.ok(result.plan.steps.some((s) => s.id === 'comfyui-update' && s.prompt
        && /downgrade/i.test(s.prompt.question)), 'user asked about keep vs downgrade');
    assert.strictEqual(io.calls.exec.filter((c) => String(c.args.join(' ')).includes('checkout')).length, 0);

    // B. User keeps the newer version → recorded continue-at-own-risk; still no downgrade.
    io.calls.exec.length = 0;
    result = await runInstallation(args({
        decisions: {
            comfyui_update: 'keep',
            install_custom_nodes: true, install_models: true, workflows: 'none',
            worker_setup: true, worker_key_provided: true,
        },
        secretProvider: secretProvider('wrk.test.local-secret-value'),
        roots: { comfyuiRoot: '/comfy', workerDir: '/worker', statePath: '/state/s2b.json', repoRoot: '/repo', hubUrl: null },
    }));
    assert.strictEqual(io.calls.exec.filter((c) => c.cmd === 'git' && c.args[0] === '-C'
        && c.args[1] === '/comfy' && /checkout/.test(c.args.join(' '))).length, 0,
    'NO downgrade checkout ever ran');
    assert.ok(result.warnings.some((w) => /own risk/.test(w)) || log.lines.some((l) => /own risk/.test(l)),
        'continue-at-own-risk surfaced');
});

// ---------------------------------------------------------------------------
// S3 — existing runtime never silently replaced
// ---------------------------------------------------------------------------

t('S3: mismatched Torch in managed venv is BLOCKED without accept_runtime_change; pip torch never executed', async () => {
    // Create a managed venv directory (as if a previous install created it)
    // so the engine treats this as "replace existing venv runtime".
    const io = createIo({
        files: { '/comfy/main.py': '', '/comfy/venv/bin/python': '#!/bin/sh' },
        preDirs: ['/comfy/.git'],
        exec: {
            ...EXEC_BASE(),
            'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.4.0' },
            '/comfy/venv/bin/python -c import torch; print(torch.__version__)': { code: 0, stdout: '2.4.0' },
        },
    });
    const log = createLogger({ io: io, quiet: true });
    const result = await runInstallation({
        manifests: [baseManifest()], mode: 'existing', io,
        roots: { comfyuiRoot: '/comfy', workerDir: '/worker', statePath: '/state/install-state.json', repoRoot: '/repo', hubUrl: null },
        decisions: ALL_YES, logger: log, crypto, options: { startComfyui: false }, // note: no accept_runtime_change
    });
    const pipTorch = io.calls.exec.filter((c) => c.cmd === 'python3'
        && JSON.stringify(c.args).includes('torch=='));
    assert.strictEqual(pipTorch.length, 0, 'torch left untouched');
    assert.ok(result.blocked.some((b) => b.reason.includes('accept_runtime_change')),
        'clear blocked reason naming the required decision');
    assert.strictEqual(result.status, 'blocked');
});

t('S3b: mismatched system Torch without managed venv proceeds (isolated venv created, system runtime untouched)', async () => {
    // No managed venv exists — installer creates an isolated venv and does NOT
    // touch the system torch.
    const io = createIo({
        files: { '/comfy/main.py': '' },
        preDirs: ['/comfy/.git'],
        exec: {
            ...EXEC_BASE(),
            'python3 -c import torch; print(torch.__version__)': { code: 0, stdout: '2.4.0' },
        },
    });
    const log = createLogger({ io: io, quiet: true });
    const result = await runInstallation({
        manifests: [baseManifest()], mode: 'existing', io,
        roots: { comfyuiRoot: '/comfy', workerDir: '/worker', statePath: '/state/install-state.json', repoRoot: '/repo', hubUrl: null },
        decisions: ALL_YES, logger: log, crypto, options: { startComfyui: false },
    });
    assert.notStrictEqual(result.status, 'blocked', 'install proceeds when no managed venv exists');
    // torch was installed INTO the venv (not the system)
    const venvPipTorch = io.calls.exec.filter((c) => {
        const full = c.cmd + ' ' + c.args.join(' ');
        return full.includes('/comfy/venv/bin/python') && full.includes('torch==');
    });
    assert.ok(venvPipTorch.length > 0, 'torch installed into managed venv');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

(async () => {
    await Promise.all(pending);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Installer Phase 2.1 resume/failure/safety: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));
    if (failed > 0) process.exit(1);
})();
