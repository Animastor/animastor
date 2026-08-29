'use strict';

/**
 * Installer prerequisite / failure-propagation regression tests.
 *
 * Covers the real CPU-only Debian/Ubuntu failure scenario:
 *
 *  P1-P10  host prerequisite checks (python3, venv, ensurepip, pip) BEFORE
 *          any mutation, with the exact apt remediation command
 *  D1-D4   dependency propagation: failed "prepare Python runtime" must
 *          STOP custom nodes, model downloads and ComfyUI start
 *  V1-V3   broken/incomplete existing venv: classified, quarantined,
 *          recreated — never treated as a working runtime
 *  O1-O3   ownership: sudo re-run over a user-owned install is BLOCKED;
 *          resume after a UID change is BLOCKED (state semantics)
 *  G1-G6   download progress: formatting, throttling, TTY line, aggregate,
 *          ModelScope wiring
 *  I1-I3   Ctrl+C: interrupted state, partial artifact, resume of .part
 *  U1-U3   uninstall after a partial install: dry-run, real removal of
 *          only owned components, idempotent second uninstall
 *
 * All external operations are mocked (memory fs + scripted io).
 */

const assert = require('assert');
const path = require('path');
const { createMemoryFs } = require('../src/installer/engine/io');
const prereq = require('../src/installer/engine/prereq');
const progress = require('../src/installer/engine/progress');
const downloader = require('../src/installer/engine/downloader');
const comfyui = require('../src/installer/engine/comfyui');
const { runInstallation, createInterruptGuard } = require('../src/installer/engine/engine');
const uninstaller = require('../src/installer/uninstaller');

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockIo(overrides = {}) {
    const fs = createMemoryFs(overrides.files || {});
    if (overrides.preDirs) {
        for (const d of overrides.preDirs) fs.mkdirSync(d, { recursive: true });
    }
    // uid map for ownership tests: path → uid (undefined entries behave like
    // a filesystem without uid information)
    const uidMap = overrides.uidMap || {};
    if (Object.keys(uidMap).length > 0) {
        const baseStat = fs.statSync;
        fs.statSync = (p) => {
            const st = baseStat(p);
            if (uidMap[p] !== undefined) return { ...st, uid: uidMap[p] };
            return st;
        };
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
    const redact = (text) => redactSecrets(text, secrets);
    const log = {
        info: (msg) => lines.push(`INFO: ${redact(msg)}`),
        warn: (msg) => lines.push(`WARN: ${redact(msg)}`),
        error: (msg) => lines.push(`ERROR: ${redact(msg)}`),
        output: (msg) => lines.push(`OUT: ${redact(msg)}`),
        step: async (name, fn) => {
            lines.push(`STEP: ${redact(name)}`);
            try {
                const value = await fn();
                lines.push(`STEP-OK: ${redact(name)}`);
                return { ok: true, value, ms: 10 };
            } catch (err) {
                lines.push(`STEP-FAIL: ${redact(name)} — ${redact(String(err && err.message))}`);
                return { ok: false, error: err, ms: 10 };
            }
        },
        registerSecret: (v) => secrets.push(v),
        lines,
    };
    return log;
}

function minimalManifest(profileId, overrides = {}) {
    return {
        profile: { id: profileId, name: profileId },
        runtime_requirements: {
            comfyui: {
                pin: { tag: 'v0.27.0', repository: 'https://github.com/comfyanonymous/ComfyUI' },
            },
            torch: overrides.torch !== undefined ? overrides.torch : {
                pin: null,
                index_url: null,
                cpu: { pin: '2.10.0', index_url: 'https://download.pytorch.org/whl/cpu' },
            },
            python: { minimum: '3.10' },
            nodejs: { minimum: '20' },
        },
        dependencies: overrides.dependencies || [],
        workflows: overrides.workflows || { policy: 'editable-baseline', artifacts: [] },
        worker_bundle: overrides.worker_bundle || {
            worker_type: 'audio',
            files: ['worker.cjs', 'package.json', '.env.example'],
            env: { required: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN'], secrets: ['ANIMASTOR_WORKER_TOKEN'] },
        },
    };
}

function venvCreateOk(dir) {
    return ({ fs: mfs }) => {
        mfs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
        mfs.writeFileSync(path.join(dir, 'bin', 'python'), '#!/bin/sh');
        return { code: 0, stdout: '', stderr: '' };
    };
}

function cloneComfyUi(root) {
    return ({ fs: mfs }) => {
        mfs.mkdirSync(root, { recursive: true });
        mfs.writeFileSync(path.join(root, 'main.py'), '# comfy');
        mfs.writeFileSync(path.join(root, 'requirements.txt'), 'torchsde\n');
        mfs.mkdirSync(path.join(root, '.git'), { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
    };
}

const PROBE_TMP = '/tmp/prereq-probe';
const ENSUREPIP_ERR = 'The virtual environment was not created successfully because ensurepip is not\navailable. On Debian/Ubuntu systems, you need to install the python3-venv package.';

function baseMockOpts(overrides = {}) {
    const base = {
        'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': { code: 1, stdout: '', stderr: '' },
        'nvidia-smi': { code: 1, stdout: '', stderr: '' },
        'rocm-smi --showproductname': { code: 127, stdout: '' },
        'node --version': { code: 0, stdout: 'v22.0.0' },
        'python3 --version': { code: 0, stdout: 'Python 3.10.12' },
        'python3 -m venv /tmp/comfy/venv': venvCreateOk('/tmp/comfy/venv'),
        '/tmp/comfy/venv/bin/python -m pip --version': { code: 0, stdout: 'pip 22.0.2' },
        '/tmp/comfy/venv/bin/python --version': { code: 0, stdout: 'Python 3.10.12' },
        '/tmp/comfy/venv/bin/python -c import torch; print(torch.__version__)': { code: 0, stdout: '2.10.0+cpu' },
        'git clone https://github.com/comfyanonymous/ComfyUI /tmp/comfy': cloneComfyUi('/tmp/comfy'),
        'git -C /tmp/comfy checkout v0.27.0': { code: 0, stdout: '', stderr: '' },
        'git -C /tmp/comfy remote get-url origin': { code: 0, stdout: 'https://github.com/comfyanonymous/ComfyUI' },
        'git -C /tmp/comfy rev-parse HEAD': { code: 0, stdout: 'abc123' },
        'git -C /tmp/comfy describe --tags --exact-match': { code: 0, stdout: 'v0.27.0' },
    };
    const { execResults, files, ...rest } = overrides;
    return {
        execResults: { ...base, ...(execResults || {}) },
        files: {
            '/tmp/repo/worker/worker/worker.cjs': '// worker',
            '/tmp/repo/worker/worker/package.json': '{"name":"animastor-worker"}',
            '/tmp/repo/worker/worker/.env.example': 'HUB_URL=\nANIMASTOR_WORKER_TOKEN=\nWORKER_TYPE=\nWORKER_ID=\n',
            ...(files || {}),
        },
        ...rest,
    };
}

function runEngine(io, log, { decisions = null, options = {}, manifests = null } = {}) {
    return runInstallation({
        manifests: manifests || [minimalManifest('audio/qwen-tts')],
        mode: 'managed',
        io,
        roots: {
            comfyuiRoot: '/tmp/comfy',
            workerDir: '/tmp/animastor/worker',
            statePath: '/tmp/comfy/.animastor-installer/install-state.json',
            repoRoot: '/tmp/repo',
            hubUrl: null,
        },
        decisions: decisions || {
            comfyui_update: 'yes', install_custom_nodes: true, install_models: true,
            workflows: 'none', worker_setup: true, worker_key_provided: true,
        },
        secretProvider: async (name) => (name === 'ANIMASTOR_WORKER_TOKEN' ? 'wrk.test-token' : null),
        logger: log,
        crypto: require('crypto'),
        options: { interruptGuard: false, ...options },
    });
}

// ---------------------------------------------------------------------------
// P: prerequisite checks
// ---------------------------------------------------------------------------

describe('prereq: package naming & classification', () => {
    it('P1: debianVenvPackage maps the detected python version to the apt package', () => {
        assert.strictEqual(prereq.debianVenvPackage('3.10.12'), 'python3.10-venv');
        assert.strictEqual(prereq.debianVenvPackage('3.11.8'), 'python3.11-venv');
        assert.strictEqual(prereq.debianVenvPackage(null), 'python3-venv');
        assert.strictEqual(prereq.debianVenvPackage('garbage'), 'python3-venv');
    });

    it('P2: classifyVenvCreateFailure recognizes the Debian ensurepip message', () => {
        const f = prereq.classifyVenvCreateFailure(ENSUREPIP_ERR, '3.10.12');
        assert.strictEqual(f.code, 'MISSING_VENV_PACKAGE');
        assert.strictEqual(f.hostPackage, 'python3.10-venv');
        assert.strictEqual(f.remediationCommand, 'sudo apt install python3.10-venv');
    });

    it('P3: classifyVenvDir distinguishes missing / incomplete / working venvs', () => {
        const { io } = createMockIo({ preDirs: ['/v'] });
        assert.strictEqual(prereq.classifyVenvDir(io, '/v/none').state, 'missing');
        assert.strictEqual(prereq.classifyVenvDir(io, '/v').state, 'incomplete', 'dir without bin/python is incomplete');
        fsWritePython(io, '/v/venv');
        assert.strictEqual(prereq.classifyVenvDir(io, '/v/venv').state, 'has-python');
    });
});

function fsWritePython(io, venvDir) {
    io.fs.mkdirSync(path.join(venvDir, 'bin'), { recursive: true });
    io.fs.writeFileSync(path.join(venvDir, 'bin', 'python'), '#!/bin/sh');
}

describe('prereq: checkPythonPrerequisites', () => {
    it('P4: python3 missing → NO_PYTHON with remediation', () => {
        const { io } = createMockIo({ execResults: { 'python3 --version': { code: 127, stdout: '', stderr: 'not found' } } });
        const r = prereq.checkPythonPrerequisites(io, { deep: false });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.failure.code, 'NO_PYTHON');
        assert.strictEqual(r.failure.remediation.command, 'sudo apt install python3');
    });

    it('P5: venv creation fails with ensurepip message → MISSING_VENV_PACKAGE + exact command', () => {
        const { io } = createMockIo({
            execResults: {
                'python3 --version': { code: 0, stdout: 'Python 3.10.12' },
                [`python3 -m venv ${PROBE_TMP}/venv`]: { code: 1, stdout: '', stderr: ENSUREPIP_ERR },
            },
        });
        const r = prereq.checkPythonPrerequisites(io, { tmpRoot: PROBE_TMP, deep: true });
        assert.strictEqual(r.ok, false, JSON.stringify(r));
        assert.strictEqual(r.failure.code, 'MISSING_VENV_PACKAGE');
        assert.strictEqual(r.failure.remediation.package, 'python3.10-venv');
        assert.strictEqual(r.failure.remediation.command, 'sudo apt install python3.10-venv');
        assert.ok(!io.fs.existsSync(PROBE_TMP), 'probe venv is cleaned up');
    });

    it('P6: successful probe venv with working pip → ok (deep_checked)', () => {
        const { io } = createMockIo({
            execResults: {
                'python3 --version': { code: 0, stdout: 'Python 3.10.12' },
                [`python3 -m venv ${PROBE_TMP}/venv`]: venvCreateOk(`${PROBE_TMP}/venv`),
                [`${PROBE_TMP}/venv/bin/python -m pip --version`]: { code: 0, stdout: 'pip 22.0.2' },
            },
        });
        const r = prereq.checkPythonPrerequisites(io, { tmpRoot: PROBE_TMP, deep: true });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.strictEqual(r.deep_checked, true);
        assert.strictEqual(r.python_version, '3.10.12');
        assert.ok(!io.fs.existsSync(PROBE_TMP), 'probe venv is cleaned up');
    });

    it('P7: probe venv created but python missing → VENV_INCOMPLETE', () => {
        const { io } = createMockIo({
            execResults: {
                'python3 --version': { code: 0, stdout: 'Python 3.10.12' },
                [`python3 -m venv ${PROBE_TMP}/venv`]: ({ fs: mfs }) => {
                    mfs.mkdirSync(`${PROBE_TMP}/venv`, { recursive: true });
                    return { code: 0, stdout: '', stderr: '' };
                },
            },
        });
        const r = prereq.checkPythonPrerequisites(io, { tmpRoot: PROBE_TMP, deep: true });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.failure.code, 'VENV_INCOMPLETE');
        assert.ok(!io.fs.existsSync(PROBE_TMP));
    });

    it('P8: probe venv without pip and failing ensurepip → MISSING_ENSUREPIP', () => {
        const { io } = createMockIo({
            execResults: {
                'python3 --version': { code: 0, stdout: 'Python 3.10.12' },
                [`python3 -m venv ${PROBE_TMP}/venv`]: venvCreateOk(`${PROBE_TMP}/venv`),
                [`${PROBE_TMP}/venv/bin/python -m pip --version`]: { code: 1, stdout: '', stderr: 'No module named pip' },
                [`${PROBE_TMP}/venv/bin/python -m ensurepip --upgrade`]: { code: 1, stdout: '', stderr: 'No module named ensurepip' },
            },
        });
        const r = prereq.checkPythonPrerequisites(io, { tmpRoot: PROBE_TMP, deep: true });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.failure.code, 'MISSING_ENSUREPIP');
        assert.strictEqual(r.failure.remediation.command, 'sudo apt install python3.10-venv');
    });

    it('P9: mocked success without a materialized dir → inconclusive pass (no false failure)', () => {
        const { io } = createMockIo({
            execResults: {
                'python3 --version': { code: 0, stdout: 'Python 3.10.12' },
                [`python3 -m venv ${PROBE_TMP}/venv`]: { code: 0, stdout: '', stderr: '' },
            },
        });
        const r = prereq.checkPythonPrerequisites(io, { tmpRoot: PROBE_TMP, deep: true });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.deep_checked, false);
    });

    it('P10: renderRemediation prints the required 4-line block', () => {
        const lines = prereq.renderRemediation({
            summary: 'the Python venv prerequisite is missing',
            remediation: { package: 'python3.10-venv', command: 'sudo apt install python3.10-venv' },
        });
        assert.deepStrictEqual(lines, [
            'Installation stopped because the Python venv prerequisite is missing.',
            'Required host package: python3.10-venv',
            'Install it with: sudo apt install python3.10-venv',
            'Then re-run the installer.',
        ]);
    });

    it('P11: a working existing venv at the target satisfies the gate WITHOUT probing venv creation', () => {
        const { io } = createMockIo({
            execResults: {
                'python3 --version': { code: 0, stdout: 'Python 3.10.12' },
                // NOTE: no venv-creation capability needed — host may lack python3-venv
                [`python3 -m venv ${PROBE_TMP}/venv`]: { code: 1, stdout: '', stderr: ENSUREPIP_ERR },
                '/target/venv/bin/python -m pip --version': { code: 0, stdout: 'pip 22.0.2' },
            },
            files: { '/target/venv/bin/python': '#!/bin/sh' },
        });
        const r = prereq.checkPythonPrerequisites(io, { tmpRoot: PROBE_TMP, deep: true, existingVenvDir: '/target/venv' });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.strictEqual(r.existing_venv_usable, true);
        assert.strictEqual(r.deep_checked, false);
    });

    it('P12: a broken existing venv does NOT satisfy the gate — deep probe still runs', () => {
        const { io } = createMockIo({
            execResults: {
                'python3 --version': { code: 0, stdout: 'Python 3.10.12' },
                [`python3 -m venv ${PROBE_TMP}/venv`]: { code: 1, stdout: '', stderr: ENSUREPIP_ERR },
                '/target/venv/bin/python -m pip --version': { code: 1, stdout: '', stderr: 'No module named pip' },
            },
            files: { '/target/venv/bin/python': '#!/bin/sh' },
        });
        const r = prereq.checkPythonPrerequisites(io, { tmpRoot: PROBE_TMP, deep: true, existingVenvDir: '/target/venv' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.failure.code, 'MISSING_VENV_PACKAGE');
    });
});

// ---------------------------------------------------------------------------
// D: dependency propagation after a failed runtime
// ---------------------------------------------------------------------------

describe('engine: failure propagation from the runtime step', () => {
    it('D1: missing python3-venv → installer stops BEFORE the clone, nodes and models', async () => {
        const { io, calls } = createMockIo(baseMockOpts({
            execResults: {
                [`python3 -m venv ${PROBE_TMP}/venv`]: { code: 1, stdout: '', stderr: ENSUREPIP_ERR },
            },
        }));
        const log = createMockLogger();
        const result = await runEngine(io, log, { options: { prereqTmpRoot: PROBE_TMP } });

        assert.strictEqual(result.status, 'failed', `status: ${result.status}`);
        assert.ok(result.remediation, 'remediation payload present');
        assert.strictEqual(result.remediation.command, 'sudo apt install python3.10-venv');
        assert.ok(result.blocked.some((b) => b.step === 'runtime'));
        // nothing was mutated: no clone, no node installs, no downloads
        assert.ok(!calls.exec.some((c) => c.cmd === 'git' && c.args[0] === 'clone'), 'no git clone after failed prereq');
        assert.ok(!calls.http.some((c) => c.op === 'download'), 'no model downloads after failed prereq');
        assert.ok(!calls.exec.some((c) => c.args && c.args.join(' ').includes('/tmp/comfy/custom_nodes')), 'no custom node operations');
        // remediation block visible in the log
        assert.ok(log.lines.some((l) => l.includes('Install it with: sudo apt install python3.10-venv')), log.lines.join('\n'));
        assert.ok(log.lines.some((l) => l.includes('Then re-run the installer.')));
    });

    it('D2: venv created but pip+ensurepip broken → runtime FAILED, dependent steps SKIPPED, no heavy downloads', async () => {
        const m = minimalManifest('audio/qwen-tts', {
            dependencies: [
                {
                    id: 'custom-node:x', kind: 'custom_node', name: 'X', requirement: 'required',
                    install: { directory: 'x', source: { repository: 'https://github.com/x/node', commit: 'aaa' } },
                    provides_classes: ['XNode'],
                },
                {
                    id: 'model:m', kind: 'model', name: 'm', requirement: 'required',
                    target_dir: 'models/TTS', filename: 'm.safetensors',
                    source: { kind: 'huggingface', repository: 'o/r', file_path: 'm.safetensors', verification: 'confirmed' },
                },
            ],
        });
        const { io, calls } = createMockIo(baseMockOpts({
            execResults: {
                [`python3 -m venv ${PROBE_TMP}/venv`]: venvCreateOk(`${PROBE_TMP}/venv`),
                [`${PROBE_TMP}/venv/bin/python -m pip --version`]: { code: 0, stdout: 'pip 22.0.2' },
                '/tmp/comfy/venv/bin/python -m pip --version': { code: 1, stdout: '', stderr: 'No module named pip' },
                '/tmp/comfy/venv/bin/python -m ensurepip --upgrade': { code: 1, stdout: '', stderr: 'No module named ensurepip' },
            },
        }));
        const log = createMockLogger();
        const result = await runEngine(io, log, { manifests: [m], options: { prereqTmpRoot: PROBE_TMP } });

        assert.strictEqual(result.status, 'failed', `status: ${result.status}`);
        assert.ok(result.results.runtime && result.results.runtime.failed, 'runtime failed recorded');
        assert.ok(result.remediation && result.remediation.command === 'sudo apt install python3.10-venv');
        // dependency propagation
        assert.ok(result.blocked.some((b) => b.step === 'custom-nodes'), 'custom nodes skipped');
        assert.ok(result.blocked.some((b) => b.step === 'models'), 'models skipped');
        assert.ok(log.lines.some((l) => l.includes('skipping "install custom nodes"')), log.lines.join('\n'));
        assert.ok(log.lines.some((l) => l.includes('skipping model downloads')));
        assert.ok(!calls.exec.some((c) => c.cmd === 'git' && String(c.args.join(' ')).includes('custom_nodes')), 'no node cloned');
        assert.ok(!calls.http.some((c) => c.op === 'download'), 'no model downloaded');
        // the clone itself DID happen (runtime gate is per-venv, after clone) but nothing else mutates
        assert.ok(calls.exec.some((c) => c.cmd === 'git' && c.args[0] === 'clone'));
        assert.ok(!calls.spawn.length, 'ComfyUI start is skipped for a broken runtime');
    });

    it('D3: torch spec missing → blocked runtime stops dependents too', async () => {
        const m = minimalManifest('audio/qwen-tts', { torch: { pin: null, index_url: null } });
        const { io, calls } = createMockIo(baseMockOpts({}));
        const log = createMockLogger();
        const result = await runEngine(io, log, { manifests: [m] });
        assert.strictEqual(result.status, 'blocked', `status: ${result.status}\n${log.lines.join('\n')}`);
        assert.ok(result.blocked.some((b) => b.step === 'runtime' && b.reason.includes('torch')));
        assert.ok(!calls.http.some((c) => c.op === 'download'));
    });
});

// ---------------------------------------------------------------------------
// V: broken existing venv
// ---------------------------------------------------------------------------

describe('engine: broken/incomplete existing venv', () => {
    it('V1: venv dir without bin/python is quarantined and recreated, install completes', async () => {
        // a re-run over an existing managed root whose venv got broken
        const { io, calls, fs } = createMockIo(baseMockOpts({
            files: {
                '/tmp/comfy/main.py': '# comfy',
                '/tmp/comfy/requirements.txt': 'torchsde\n',
                '/tmp/comfy/venv/leftover.txt': 'junk from a broken run',
            },
            preDirs: ['/tmp/comfy/venv', '/tmp/comfy/.git'],
        }));
        const log = createMockLogger();
        const result = await runEngine(io, log, { options: { prereqTmpRoot: PROBE_TMP } });

        assert.ok(!['failed', 'blocked'].includes(result.status), `unexpected status: ${result.status}\n${log.lines.join('\n')}`);
        const entries = fs.readdirSync('/tmp/comfy').filter((n) => n.startsWith('venv.broken-'));
        assert.strictEqual(entries.length, 1, `broken venv quarantined: ${entries.join(', ')}`);
        assert.ok(fs.existsSync('/tmp/comfy/venv/bin/python'), 'fresh venv created');
        assert.ok(result.warnings.some((w) => w.includes('broken venv')), 'quarantine is warned about');
        // exactly one venv creation for the fresh runtime
        assert.strictEqual(calls.exec.filter((c) => c.cmd === 'python3' && c.args.join(' ') === '-m venv /tmp/comfy/venv').length, 1);
    });

    it('V2: venv with python but broken pip that ensurepip cannot fix → structured PrerequisiteError', () => {
        const { io } = createMockIo({
            execResults: {
                '/tmp/comfy/venv/bin/python -m pip --version': { code: 1, stdout: '', stderr: 'No module named pip' },
                '/tmp/comfy/venv/bin/python -m ensurepip --upgrade': { code: 1, stdout: '', stderr: 'ensurepip is not available' },
                '/tmp/comfy/venv/bin/python --version': { code: 0, stdout: 'Python 3.10.12' },
            },
            preDirs: ['/tmp/comfy/venv/bin'],
            files: { '/tmp/comfy/venv/bin/python': '#!/bin/sh' },
        });
        assert.throws(
            () => comfyui.preparePythonRuntime(io, { root: '/tmp/comfy', torchSpec: null, log: null }),
            (err) => err.name === 'PrerequisiteError'
                && err.code === 'MISSING_ENSUREPIP'
                && err.remediationCommand === 'sudo apt install python3.10-venv',
        );
    });

    it('V3: PrerequisiteError from the runtime step carries the remediation into the result', async () => {
        const { io } = createMockIo(baseMockOpts({
            execResults: {
                [`python3 -m venv ${PROBE_TMP}/venv`]: venvCreateOk(`${PROBE_TMP}/venv`),
                [`${PROBE_TMP}/venv/bin/python -m pip --version`]: { code: 0, stdout: 'pip 22.0.2' },
                // target venv creation fails with the Debian ensurepip message
                'python3 -m venv /tmp/comfy/venv': { code: 1, stdout: '', stderr: ENSUREPIP_ERR },
            },
        }));
        const log = createMockLogger();
        const result = await runEngine(io, log, { options: { prereqTmpRoot: PROBE_TMP } });
        assert.strictEqual(result.status, 'failed');
        assert.ok(result.remediation && result.remediation.package === 'python3.10-venv');
        assert.ok(log.lines.some((l) => l.includes('Required host package: python3.10-venv')), log.lines.join('\n'));
    });
});

// ---------------------------------------------------------------------------
// O: ownership / sudo mixing
// ---------------------------------------------------------------------------

describe('engine: ownership guard (sudo vs normal user)', () => {
    it('O1: sudo (uid 0) over a user-owned install root is BLOCKED before any mutation', async () => {
        const { io, calls, fs } = createMockIo(baseMockOpts({
            preDirs: ['/home/sureg/ComfyUI'],
            uidMap: { '/home/sureg/ComfyUI': 1000, '/home/sureg': 1000 },
        }));
        const log = createMockLogger();
        const result = await runInstallation({
            manifests: [minimalManifest('audio/qwen-tts')],
            mode: 'managed',
            io,
            roots: {
                comfyuiRoot: '/home/sureg/ComfyUI',
                workerDir: '/home/sureg/animastor/worker',
                statePath: '/home/sureg/ComfyUI/.animastor-installer/install-state.json',
                repoRoot: '/tmp/repo', hubUrl: null,
            },
            decisions: { comfyui_update: 'yes', install_custom_nodes: true, install_models: true, workflows: 'none', worker_setup: false, worker_key_provided: false },
            logger: log,
            crypto: require('crypto'),
            options: { interruptGuard: false, currentUid: 0, home: '/home/sureg' },
        });
        assert.strictEqual(result.status, 'blocked', `status: ${result.status}`);
        assert.ok(result.blocked.some((b) => b.step === 'ownership'));
        assert.ok(result.blocked.some((b) => b.reason.includes('root-owned files')), JSON.stringify(result.blocked));
        assert.ok(!calls.exec.some((c) => c.cmd === 'git'), 'no git operations under the blocked ownership run');
        assert.ok(!calls.spawn.length, 'nothing spawned');
        assert.ok(!fs.existsSync('/home/sureg/ComfyUI/.animastor-installer/install-state.json'), 'state file not even created');
        assert.ok(!calls.http.some((c) => c.op === 'download'), 'nothing downloaded');
    });

    it('O2: the owning user (matching uid) proceeds normally', async () => {
        const { io } = createMockIo(baseMockOpts({
            uidMap: { '/tmp/comfy': 1000 },
        }));
        const log = createMockLogger();
        const result = await runEngine(io, log, { options: { prereqTmpRoot: PROBE_TMP, currentUid: 1000, home: '/tmp' } });
        assert.ok(!['failed', 'blocked'].includes(result.status), log.lines.join('\n'));
    });

    it('O3: resume/install after a UID change (state owner_uid mismatch) is BLOCKED', async () => {
        // first run by uid 1000 records owner_uid
        const first = createMockIo(baseMockOpts({}));
        const log1 = createMockLogger();
        await runEngine(first.io, log1, { options: { prereqTmpRoot: PROBE_TMP, currentUid: 1000 } });
        const stateText = first.fs.readFileSync('/tmp/comfy/.animastor-installer/install-state.json', 'utf8');
        assert.ok(JSON.parse(stateText).owner_uid === 1000, 'owner_uid recorded');

        // second run as root → blocked, no further mutations
        const second = createMockIo(baseMockOpts({
            files: { '/tmp/comfy/.animastor-installer/install-state.json': stateText },
        }));
        const log2 = createMockLogger();
        const result = await runEngine(second.io, log2, { options: { prereqTmpRoot: PROBE_TMP, currentUid: 0, home: '/root' } });
        assert.strictEqual(result.status, 'blocked');
        assert.ok(result.blocked.some((b) => b.reason.includes('created by uid 1000')), JSON.stringify(result.blocked));
        assert.ok(!second.calls.exec.some((c) => c.cmd === 'git'), 'no mutations on the blocked resume');
    });
});

// ---------------------------------------------------------------------------
// G: download progress
// ---------------------------------------------------------------------------

describe('progress: formatting', () => {
    it('G1: formatBytes / formatEta', () => {
        assert.strictEqual(progress.formatBytes(0), '0 B');
        assert.strictEqual(progress.formatBytes(512), '512 B');
        assert.strictEqual(progress.formatBytes(800 * 1024), '800 KB');
        assert.strictEqual(progress.formatBytes(1.2 * 1024 ** 3), '1.2 GB');
        assert.strictEqual(progress.formatBytes(4.8 * 1024 ** 3), '4.8 GB');
        assert.strictEqual(progress.formatEta(0), '00:00');
        assert.strictEqual(progress.formatEta(75), '01:15');
        assert.strictEqual(progress.formatEta(3725), '1:02:05');
        assert.strictEqual(progress.formatEta(NaN), '--:--');
    });

    it('G2: renderProgressLine shows file, bytes, percent, speed and ETA', () => {
        const line = progress.renderProgressLine({
            label: 'Qwen/Qwen3-TTS/model.safetensors',
            received: 1.2 * 1024 ** 3,
            total: 4.8 * 1024 ** 3,
            rateBps: 12.3 * 1024 ** 2,
            etaSeconds: 312,
        });
        assert.strictEqual(line, 'Downloading Qwen/Qwen3-TTS/model.safetensors  1.2 GB / 4.8 GB (25%)  12.3 MB/s  ETA 05:12');
    });

    it('G3: non-TTY throttles log lines (time AND byte delta) and always emits the final line', () => {
        const lines = [];
        const t0 = 1_000_000;
        let t = t0;
        const rep = progress.createProgressReporter({
            isTTY: false,
            log: { info: (m) => lines.push(m) },
            now: () => t,
            minIntervalMs: 2000,
            minDeltaBytes: 100 * 1024 * 1024,
        });
        rep.beginFile('big.safetensors', 4.8 * 1024 ** 3);
        for (let i = 1; i <= 50; i++) {
            t += 100; // 100 ms per chunk
            rep.onChunk({ received: i * 10 * 1024 * 1024, total: 4.8 * 1024 ** 3 });
        }
        rep.endFile({ status: 'downloaded', bytes: 500 * 1024 * 1024 });
        // 5 seconds total, 500 MB — far below the throttle thresholds after the first line
        assert.ok(lines.length >= 1 && lines.length <= 3, `throttled to few lines, got ${lines.length}: ${JSON.stringify(lines)}`);
        assert.ok(lines[0].includes('Downloading big.safetensors'), lines[0]);
        assert.ok(lines[lines.length - 1].startsWith('Downloaded big.safetensors'), 'final line always emitted');
    });

    it('G4: TTY renders one in-place line (\\r) and a newline only at completion', () => {
        const writes = [];
        const rep = progress.createProgressReporter({
            isTTY: true,
            write: (s) => writes.push(s),
            now: () => 1000,
        });
        rep.beginFile('f.bin', 1000);
        rep.onChunk({ received: 250, total: 1000 });
        rep.onChunk({ received: 500, total: 1000 });
        rep.endFile({ status: 'downloaded', bytes: 1000 });
        const joined = writes.join('');
        assert.ok(joined.includes('\r'), 'in-place line updates');
        assert.ok(joined.includes('(50%)'), `percent shown: ${joined}`);
        assert.strictEqual(writes[writes.length - 1], '\n', 'exactly one trailing newline at completion');
        assert.ok(!writes.slice(0, -1).some((w) => w.includes('\n')), 'no intermediate newlines');
    });

    it('G5: repo aggregate counts files and bytes (skips included)', () => {
        const lines = [];
        const rep = progress.createProgressReporter({
            isTTY: false,
            log: { info: (m) => lines.push(m) },
            now: () => 1000,
        });
        rep.beginRepo({ repository: 'Qwen/Qwen3-TTS', filesTotal: 3, bytesTotal: 3072 });
        rep.fileSkipped('config.json', 1024);
        rep.beginFile('model.safetensors', 2048);
        rep.onChunk({ received: 1500, total: 2048 });
        rep.endFile({ status: 'downloaded', bytes: 2048 });
        rep.endRepo({ status: 'downloaded' });
        const repoLine = lines.find((l) => l.includes('Repo complete'));
        assert.ok(repoLine, lines.join('\n'));
        assert.ok(repoLine.includes('(2/3 files)'), `files counted: ${repoLine}`);
        assert.ok(repoLine.includes('3.0 KB / 3.0 KB'), `aggregate bytes: ${repoLine}`);
    });

    it('G6: downloadModelScopeRepo drives the progress reporter (per-file + aggregate)', async () => {
        const events = [];
        const spy = {
            beginRepo: (e) => events.push(['beginRepo', e]),
            fileSkipped: (p, s) => events.push(['fileSkipped', p, s]),
            beginFile: (l, t) => events.push(['beginFile', l, t]),
            onChunk: (e) => events.push(['onChunk', e]),
            endFile: (e) => events.push(['endFile', e]),
            endRepo: (e) => events.push(['endRepo', e]),
        };
        const { io } = createMockIo({
            httpResults: {
                'https://modelscope.cn/api/v1/models/Qwen/p/repo/files?Revision=master': () => ({
                    status: 200,
                    json: { Data: { Files: [{ Path: 'a.bin', Type: 'blob', Size: 300 }] } },
                }),
            },
        });
        io.http.download = async ({ url, dest, onProgress }) => {
            io.fs.writeFileSync(dest, Buffer.alloc(300, 1));
            if (onProgress) onProgress({ received: 300, total: 300 });
            return { status: 200, bytes: 300, total: 300, resumed: false };
        };
        const res = await downloader.downloadModelScopeRepo(io, {
            id: 'model-repo:p', kind: 'modelscope', repository: 'Qwen/p', revision: 'master',
            target_path: 'models/TTS/p', ready: true,
        }, { root: '/comfyui', getHeader: downloader.makeHeaderProvider({}), progress: spy });
        assert.strictEqual(res.status, 'downloaded', JSON.stringify(res));
        assert.deepStrictEqual(events[0][0], 'beginRepo');
        assert.strictEqual(events[0][1].filesTotal, 1);
        assert.ok(events.some((e) => e[0] === 'beginFile' && e[1] === 'Qwen/p/a.bin'));
        assert.ok(events.some((e) => e[0] === 'onChunk'));
        assert.ok(events.some((e) => e[0] === 'endFile' && e[1].status === 'downloaded'));
        assert.deepStrictEqual(events[events.length - 1][0], 'endRepo');
    });
});

// ---------------------------------------------------------------------------
// I: Ctrl+C / interrupted downloads
// ---------------------------------------------------------------------------

describe('interrupt handling (Ctrl+C)', () => {
    it('I1: guard marks the in-flight artifact PARTIAL, flags the state, saves, exits 130', () => {
        const { io } = createMockIo({});
        const state = require('../src/installer/engine/state');
        const st = state.emptyState({ mode: 'managed', profiles: ['audio/qwen-tts'] });
        state.setArtifact(st, 'model-repo:qwen3-tts', 'missing', {});
        const statePath = '/tmp/comfy/.animastor-installer/install-state.json';
        const saves = [];
        const exitCodes = [];
        let handlerRef = null;
        const remove = createInterruptGuard({
            state: st,
            save: () => { state.saveState(io, statePath, st, io.now); saves.push(1); },
            log: createMockLogger(),
            getArtifactId: () => 'model-repo:qwen3-tts',
            exit: (code) => exitCodes.push(code),
            register: (h) => { handlerRef = h; },
            unregister: () => { handlerRef = null; },
        });
        handlerRef(); // simulate SIGINT
        assert.deepStrictEqual(exitCodes, [130]);
        assert.strictEqual(saves.length, 1);
        assert.strictEqual(st.interrupted, true);
        assert.strictEqual(st.artifacts['model-repo:qwen3-tts'].status, 'partial');
        assert.ok(st.artifacts['model-repo:qwen3-tts'].detail.reason.includes('Ctrl+C'));
        const saved = JSON.parse(io.fs.readFileSync(statePath, 'utf8'));
        assert.strictEqual(saved.artifacts['model-repo:qwen3-tts'].status, 'partial');
        remove(); // unregisters
        assert.strictEqual(handlerRef, null);
    });

    it('I2: a partial artifact is never treated as an installed model (no ownership registration)', () => {
        const { io } = createMockIo({});
        const state = require('../src/installer/engine/state');
        const st = state.emptyState({ mode: 'managed', profiles: ['x'] });
        state.setArtifact(st, 'model-repo:q', 'partial', { reason: 'interrupted' });
        assert.strictEqual(state.artifactStatus(st, 'model-repo:q'), 'partial');
        assert.strictEqual(st.components.models.length, 0, 'partial model is NOT a owned/installed component');
        assert.ok(!io.fs.existsSync('/tmp/comfy/models'), 'no published file for the partial download');
    });

    it('I4: SIGINT mid-download marks the model PARTIAL in the saved state and exits 130', async () => {
        const { io, calls, fs } = createMockIo(baseMockOpts({}));
        // a download that stays in flight until the test releases it
        let releaseDownload;
        const gate = new Promise((res) => { releaseDownload = res; });
        io.http.download = async (opts) => {
            calls.http.push({ op: 'download', url: opts.url, dest: opts.dest, appendFrom: opts.appendFrom });
            io.fs.writeFileSync(opts.dest, 'PARTIAL');
            await gate;
            return { status: 200, bytes: 7, total: 7, resumed: false };
        };
        const manifest = minimalManifest('audio/qwen-tts', {
            dependencies: [{
                id: 'model:m', kind: 'model', name: 'm', requirement: 'required',
                target_dir: 'models/TTS', filename: 'm.safetensors',
                source: { kind: 'huggingface', repository: 'o/r', file_path: 'm.safetensors', verification: 'confirmed' },
                checksum: { algo: 'sha256', value: 'deadbeef'.repeat(8) },
            }],
        });

        const log = createMockLogger();
        const statePath = '/tmp/comfy/.animastor-installer/install-state.json';
        const realExit = process.exit;
        const exitCodes = [];
        process.exit = (code) => { exitCodes.push(code); throw new Error('__exit__'); };
        const sigintBefore = process.listenerCount('SIGINT');
        let enginePromise;
        try {
            enginePromise = runEngine(io, log, {
                manifests: [manifest],
                options: { prereqTmpRoot: PROBE_TMP, interruptGuard: true }, // SIGINT guard ENABLED
            });
            const t0 = Date.now();
            while (calls.http.length === 0 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
            assert.ok(calls.http.length > 0, 'download started');
            assert.ok(process.listenerCount('SIGINT') > sigintBefore, 'SIGINT guard registered');
            assert.throws(() => process.emit('SIGINT'), /__exit__/);
        } finally {
            process.exit = realExit;
        }
        assert.deepStrictEqual(exitCodes, [130], 'exit code 130 (SIGINT)');
        const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        assert.strictEqual(saved.interrupted, true, 'state flagged interrupted');
        assert.strictEqual(saved.artifacts['model:m'].status, 'partial', 'in-flight artifact marked PARTIAL');
        assert.ok(!fs.existsSync('/tmp/comfy/models/TTS/m/model.safetensors'), 'partial file never published as the model');

        // let the engine unwind; the guard must be removed again
        releaseDownload();
        await enginePromise;
        assert.strictEqual(process.listenerCount('SIGINT'), sigintBefore, 'SIGINT guard unregistered after the run');
    });

    it('I3: after Ctrl+C the .part file is resumed on the next run (Range from part size)', async () => {
        const { io } = createMockIo({
            files: { '/comfyui/models/TTS/m/model.safetensors.part': 'PARTIALDATA' },
            httpResults: {
                'https://example.com/m.safetensors': ({ dest, fs: mfs, headers }) => {
                    return { status: 206, bytes: 4, total: 15, resumed: true };
                },
            },
        });
        const downloads = [];
        const orig = io.http.download;
        io.http.download = async (opts) => {
            downloads.push(opts.appendFrom);
            const r = await orig(opts);
            io.fs.writeFileSync(opts.dest, 'PARTIALDATA-REST');
            return { ...r, bytes: 15 };
        };
        const res = await downloader.downloadArtifact(io, {
            id: 'model:m', kind: 'huggingface', url: 'https://example.com/m.safetensors',
            target_path: 'models/TTS/m/model.safetensors', ready: true,
            checksum: { algo: 'sha256', value: 'deadbeef'.repeat(8) },
        }, { root: '/comfyui', retries: 1, retryDelayMs: 0 });
        assert.strictEqual(res.status, 'resumed', JSON.stringify(res));
        assert.strictEqual(downloads[0], 11, 'Range request resumes from the .part size');
        assert.ok(!io.fs.existsSync('/comfyui/models/TTS/m/model.safetensors.part'), '.part consumed after publish');
    });
});

// ---------------------------------------------------------------------------
// U: uninstall after partial installation
// ---------------------------------------------------------------------------

function uninstallPlanFor(io, statePath, home = null) {
    const record = uninstaller.loadInstallRecord(io, statePath);
    assert.ok(record, 'state record present');
    return { record, plan: uninstaller.buildUninstallPlan(io, { state: record, statePath, home }) };
}

describe('uninstall after a partial installation', () => {
    it('U1: managed install → broken venv + dead ensurepip → installer stops → dry-run then real uninstall removes ONLY owned components', async () => {
        // venv creation works exactly ONCE (the initial install); afterwards
        // the host behaves like a system without python3-venv/ensurepip
        let venvCreates = 0;
        const install = createMockIo(baseMockOpts({
            execResults: {
                'python3 -m venv /tmp/comfy/venv': ({ fs: mfs }) => {
                    venvCreates += 1;
                    if (venvCreates > 1) return { code: 1, stdout: '', stderr: ENSUREPIP_ERR };
                    mfs.mkdirSync('/tmp/comfy/venv/bin', { recursive: true });
                    mfs.writeFileSync('/tmp/comfy/venv/bin/python', '#!/bin/sh');
                    return { code: 0, stdout: '', stderr: '' };
                },
            },
            dependencies: [{
                id: 'model:m', kind: 'model', name: 'm', requirement: 'required',
                target_dir: 'models/TTS', filename: 'm.safetensors',
                source: { kind: 'huggingface', repository: 'o/r', file_path: 'm.safetensors', verification: 'confirmed' },
            }],
        }));
        const manifest = minimalManifest('audio/qwen-tts', {
            dependencies: [{
                id: 'model:m', kind: 'model', name: 'm', requirement: 'required',
                target_dir: 'models/TTS', filename: 'm.safetensors',
                source: { kind: 'huggingface', repository: 'o/r', file_path: 'm.safetensors', verification: 'confirmed' },
            }],
        });
        const logInstall = createMockLogger();
        const r1 = await runEngine(install.io, logInstall, { manifests: [manifest], options: { prereqTmpRoot: PROBE_TMP } });
        assert.ok(!['failed', 'blocked'].includes(r1.status), logInstall.lines.join('\n'));
        assert.strictEqual(venvCreates, 1);

        // 2. break the venv → rerun must STOP (repair impossible without ensurepip)
        install.fs.unlinkSync('/tmp/comfy/venv/bin/python');
        install.calls.exec.length = 0;
        install.calls.http.length = 0;
        install.calls.spawn.length = 0;
        const logRerun = createMockLogger();
        const r2 = await runEngine(install.io, logRerun, { manifests: [manifest], options: { prereqTmpRoot: PROBE_TMP } });
        assert.strictEqual(r2.status, 'failed', `rerun status: ${r2.status}\n${logRerun.lines.join('\n')}`);
        assert.ok(r2.remediation && r2.remediation.package === 'python3.10-venv');
        assert.ok(!install.calls.http.some((c) => c.op === 'download'), 'no downloads after broken runtime');
        assert.ok(!install.calls.spawn.length, 'ComfyUI not started on a broken runtime');

        // 3. dry-run uninstall: plan shows the owned ComfyUI dir, removes nothing
        const statePath = '/tmp/comfy/.animastor-installer/install-state.json';
        const { record, plan } = uninstallPlanFor(install.io, statePath);
        assert.ok(record.components.comfyui && record.components.comfyui.owned === true);
        const comfyItem = plan.groups.find((g) => g.key === 'comfyui').items.find((i) => i.path === '/tmp/comfy');
        assert.ok(comfyItem && comfyItem.removable, 'owned ComfyUI dir removable');
        const dry = uninstaller.runUninstallation(install.io, { plan, answers: { comfyui: true, models: true, custom_nodes: true, worker: true, services: true, config: true }, statePath, dryRun: true });
        assert.strictEqual(dry.failed, 0);
        assert.ok(install.fs.existsSync('/tmp/comfy/main.py'), 'dry-run removes nothing');
        assert.ok(install.fs.existsSync(statePath), 'dry-run keeps the state');

        // 4. real uninstall: owned dir removed, state LAST
        const real = uninstaller.runUninstallation(install.io, {
            plan,
            answers: { comfyui: true, models: true, custom_nodes: true, worker: true, services: true, config: true },
            statePath, dryRun: false,
            log: createMockLogger(),
        });
        assert.strictEqual(real.failed, 0, JSON.stringify(real.results));
        assert.ok(!install.fs.existsSync('/tmp/comfy'), 'owned ComfyUI dir (incl. broken venv) removed');
        assert.ok(!install.fs.existsSync(statePath), 'state removed last');
    });

    it('U2: pre-existing ComfyUI is NEVER removed; second uninstall is idempotent', async () => {
        const { io, fs } = createMockIo({
            preDirs: ['/tmp/preexisting/.animastor-installer'],
            files: {
                '/tmp/preexisting/main.py': '# user comfy',
                '/tmp/preexisting/.animastor-installer/install-state.json': JSON.stringify({
                    state_version: 1,
                    mode: 'existing',
                    profiles: ['audio/qwen-tts'],
                    owner_uid: null,
                    artifacts: {},
                    components: {
                        comfyui: { owned: false, path: '/tmp/preexisting' },
                        venv: { owned: true, path: '/tmp/preexisting/venv', created: false },
                        worker: null, custom_nodes: [], models: [], workflows: [], services: [],
                    },
                    checkpoints: [],
                }),
            },
        });
        const statePath = '/tmp/preexisting/.animastor-installer/install-state.json';
        const { plan } = uninstallPlanFor(io, statePath);
        const comfyItems = plan.groups.find((g) => g.key === 'comfyui');
        assert.ok(comfyItems.skipped.some((s) => s.label.includes('/tmp/preexisting')), 'pre-existing ComfyUI kept');
        assert.ok(comfyItems.items.some((i) => i.path === '/tmp/preexisting/venv' && i.removable), 'installer venv removable precisely');

        const outcome = uninstaller.runUninstallation(io, {
            plan,
            answers: { comfyui: true, models: true, custom_nodes: true, worker: true, services: true, config: true },
            statePath, dryRun: false, log: createMockLogger(),
        });
        assert.strictEqual(outcome.failed, 0);
        assert.ok(fs.existsSync('/tmp/preexisting/main.py'), 'pre-existing ComfyUI untouched');
        assert.ok(!fs.existsSync('/tmp/preexisting/venv'), 'owned venv removed');
        assert.ok(!fs.existsSync(statePath), 'state removed');

        // second run: no state → nothing found, nothing deleted (idempotent)
        assert.strictEqual(uninstaller.loadInstallRecord(io, statePath), null);
        const outcome2 = uninstaller.runUninstallation(io, {
            plan: { groups: [], removable_count: 0, skipped_count: 0, has_any: false },
            answers: { comfyui: true, models: true, custom_nodes: true, worker: true, services: true, config: true },
            statePath, dryRun: false, log: createMockLogger(),
        });
        assert.strictEqual(outcome2.failed, 0);
        assert.strictEqual(outcome2.removed, 0);
        assert.ok(fs.existsSync('/tmp/preexisting/main.py'), 'still untouched');
    });
});
