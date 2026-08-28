'use strict';

/**
 * Installer Phase 2.1 — CLI smoke tests.
 *
 * Spawns the real `cli.js` as a child process against throw-away temp dirs.
 * Covers the five user-facing commands and PROVES the dry-run guarantee with a
 * recursive filesystem snapshot (path + size + sha256) taken before/after:
 *
 *   C1  detect            → exit 0, prints a detection summary
 *   C2  plan              → exit 0, prints a plan for the profile
 *   C3  plan (no profile) → exit 1, clear error
 *   C3b REGRESSION: boolean consent flags (--accept-reference-runtime,
 *                           --accept-runtime-change) must not swallow the
 *                           following flag (e.g. --comfy-port)
 *   C4  install --dry-run → exit 0, ZERO filesystem mutations (snapshot equal),
 *                           zero downloads, zero process starts, marker printed
 *   C5  verify            → exit 0, prints a verification report
 *   C6  resume (no state) → exact "No resumable installation state found."
 *                           message, non-zero exit, does NOT start an install
 *   C7  unknown command   → exit 1, usage printed
 *   C8  REGRESSION: interactive CPU install (audio/qwen-tts, managed) — the
 *                           real VPS scenario: prompts answered, Worker Key
 *                           typed; the post-prompt plan rebuild keeps its
 *                           resolution report and execution is reached
 *
 * Dry-run proof: the snapshot captures every file/dir under the scratch root.
 * If the dry-run path performed ANY mkdir/write/download/clone it would change
 * the snapshot (or trip the mutation guard and exit non-zero). Equality of the
 * two snapshots + exit 0 is the proof of "zero mutations / zero downloads /
 * zero process starts".
 */

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.resolve(__dirname, '..', 'src', 'installer', 'cli.js');

function runCli(args, opts = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, ...(opts.env || {}) },
        input: opts.input,
    });
}

/** Recursively snapshot a directory tree → stable comparable string. */
function snapshotTree(root) {
    const entries = [];
    if (!fs.existsSync(root)) return '<absent>';
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir).sort()) {
            const abs = path.join(dir, name);
            const rel = path.relative(root, abs);
            const st = fs.statSync(abs);
            if (st.isDirectory()) {
                entries.push(`d ${rel}`);
                walk(abs);
            } else {
                const data = fs.readFileSync(abs);
                const sha = crypto.createHash('sha256').update(data).digest('hex');
                entries.push(`f ${rel} ${st.size} ${sha}`);
            }
        }
    };
    walk(root);
    return entries.join('\n');
}

function mkTempDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `installer-cli-${label}-`));
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

t('C1: detect exits 0 and prints a detection summary', () => {
    const root = mkTempDir('detect');
    const r = runCli(['detect', '--root', path.join(root, 'ComfyUI'), '--worker-dir', path.join(root, 'worker')]);
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(/GPU:/.test(r.stdout), 'prints GPU line');
    assert.ok(/ComfyUI:/.test(r.stdout), 'prints ComfyUI line');
    fs.rmSync(root, { recursive: true, force: true });
});

t('C2: plan --profile image/qwen-image exits 0 and renders a plan', () => {
    const root = mkTempDir('plan');
    const r = runCli(['plan', '--profile', 'image/qwen-image',
        '--root', path.join(root, 'ComfyUI'), '--worker-dir', path.join(root, 'worker')]);
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(/Profile: image\/qwen-image/.test(r.stdout), 'plan names the profile');
    assert.ok(/Mode:/.test(r.stdout), 'plan shows mode');
    fs.rmSync(root, { recursive: true, force: true });
});

t('C3: plan without --profile exits 1 with a clear error', () => {
    const r = runCli(['plan']);
    assert.strictEqual(r.status, 1);
    assert.ok(/--profile is required/.test(r.stderr), 'error names the missing flag');
});

t('C3b: REGRESSION parseArgs — boolean consent flags never swallow the next flag', () => {
    const { parseArgs } = require('../src/installer/cli');
    const parsed = parseArgs(['node', 'cli.js', 'install', '--profile', 'audio/qwen-tts',
        '--accept-reference-runtime', '--comfy-port', '8199', '--accept-runtime-change', '--mode', 'managed']);
    assert.strictEqual(parsed.flags['accept-reference-runtime'], true, 'consent flag is boolean true');
    assert.strictEqual(parsed.flags['accept-runtime-change'], true, 'runtime-change flag is boolean true');
    assert.strictEqual(parsed.flags['comfy-port'], '8199', '--comfy-port keeps its value (not swallowed)');
    assert.strictEqual(parsed.flags.mode, 'managed', '--mode keeps its value');
    assert.deepStrictEqual(parsed.profiles, ['audio/qwen-tts']);
});

t('C4: install --dry-run performs ZERO filesystem mutations / downloads / process starts', () => {
    const root = mkTempDir('dryrun');
    const comfyRoot = path.join(root, 'ComfyUI');
    const workerDir = path.join(root, 'worker');
    // Pre-create the scratch root so the snapshot has a stable baseline.
    fs.mkdirSync(comfyRoot, { recursive: true });
    fs.mkdirSync(workerDir, { recursive: true });

    const before = snapshotTree(root);
    const r = runCli(['install', '--profile', 'image/qwen-image', '--dry-run',
        '--root', comfyRoot, '--worker-dir', workerDir,
        '--state', path.join(root, 'state', 'install-state.json')]);
    const after = snapshotTree(root);

    assert.strictEqual(r.status, 0, `dry-run must exit 0; stderr: ${r.stderr}`);
    assert.ok(/\[dry-run\] zero mutations performed/.test(r.stdout), 'dry-run marker printed');
    assert.strictEqual(after, before,
        'filesystem snapshot identical → no mkdir/write/download/clone/.part/.env/state file');
    // No install-state.json may have been created by a dry-run.
    assert.ok(!fs.existsSync(path.join(root, 'state', 'install-state.json')),
        'dry-run never writes install state');
    fs.rmSync(root, { recursive: true, force: true });
});

t('C5: verify exits 0 and prints a verification report', () => {
    const root = mkTempDir('verify');
    const r = runCli(['verify', '--profile', 'image/qwen-image',
        '--root', path.join(root, 'ComfyUI'), '--worker-dir', path.join(root, 'worker')]);
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(/INSTALLATION INCOMPLETE|READY|GPU/.test(r.stdout), 'prints a verification verdict');
    fs.rmSync(root, { recursive: true, force: true });
});

t('C6: resume with no state prints the exact message and does NOT start an install', () => {
    const root = mkTempDir('resume');
    const comfyRoot = path.join(root, 'ComfyUI');
    fs.mkdirSync(comfyRoot, { recursive: true });
    const before = snapshotTree(root);

    const r = runCli(['resume',
        '--root', comfyRoot, '--worker-dir', path.join(root, 'worker'),
        '--state', path.join(root, 'state', 'install-state.json')]);

    const after = snapshotTree(root);
    assert.notStrictEqual(r.status, 0, 'resume without state must exit non-zero');
    assert.ok(/No resumable installation state found\./.test(r.stdout),
        `exact message printed; got: ${r.stdout}`);
    assert.strictEqual(after, before, 'resume without state mutates nothing');
    fs.rmSync(root, { recursive: true, force: true });
});

t('C7: unknown command exits 1 and prints usage', () => {
    const r = runCli(['frobnicate']);
    assert.strictEqual(r.status, 1);
    assert.ok(/Usage: animastor-installer/.test(r.stderr), 'usage printed');
});

/**
 * C8 — REGRESSION for the real CPU-only VPS incident:
 *   node cli.js install --profile audio/qwen-tts --mode managed
 * answered interactively (CPU confirm, nodes yes, models yes, workflows no,
 * worker yes, Worker Key typed at the hidden prompt) crashed AFTER the
 * prompts with:
 *   fatal: buildInstallPlan requires a resolution report
 * because the post-prompt plan rebuild passed the freshly resolved report
 * under the wrong property name (`report2` shorthand instead of `report`),
 * so buildInstallPlan saw `report === undefined`.
 *
 * The test drives the REAL CLI with the exact prompt sequence and proves:
 *   - the crash is gone (no "requires a resolution report");
 *   - every interactive decision is consumed (no "Still awaiting decisions");
 *   - the engine reaches its execution phase (install-state.json is written
 *     BEFORE any component install);
 *   - the CPU device and ALL user selections survive the plan rebuild;
 *   - the typed Worker Key value never appears in output or state.
 * The child is killed as soon as the state file exists, so the test performs
 * no real component installation (no network beyond an aborted git clone).
 */
t('C8: REGRESSION interactive CPU install (audio/qwen-tts, managed) rebuilds the plan with a report and reaches execution', async () => {
    const root = mkTempDir('cpu-install');
    const comfyRoot = path.join(root, 'ComfyUI');
    const workerDir = path.join(root, 'worker');
    const statePath = path.join(comfyRoot, '.animastor-installer', 'install-state.json');

    // Force CPU detection even on a GPU dev host: a failing nvidia-smi shim
    // first in PATH. (An AMD sysfs detection also maps to device=cpu, so no
    // shim is needed for that branch.)
    const shimDir = path.join(root, 'shimbin');
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, 'nvidia-smi'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(shimDir, 'nvidia-smi'), 0o755);

    const TOKEN = 'pw.regression.dummy-token';
    const child = spawn(process.execPath, [
        CLI, 'install', '--profile', 'audio/qwen-tts', '--mode', 'managed',
        '--root', comfyRoot, '--worker-dir', workerDir,
        '--hub-url', 'http://127.0.0.1:9', // unreachable on purpose
    ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}` },
    });

    let out = '';
    let tail = '';
    let idx = 0;
    // Real readline prompts carry the "[Yes/No] " suffix (the plan text
    // renders questions with "[Yes] [No]" — never matched here). The hidden
    // secret prompt ends with ": ". Answers are consumed strictly in order.
    const answers = [
        [/Continue with the CPU-only installation\? \[Yes\/No\]/, 'yes'],
        [/component\(s\) missing\. Install\?[\s\S]*?\[Yes\/No\]/, 'yes'], // custom nodes
        [/component\(s\) missing\. Install\?[\s\S]*?\[Yes\/No\]/, 'yes'], // models
        [/Which baseline workflows to download\?[\s\S]*?\[Yes\/No\]/, 'no'],
        [/Worker setup:[\s\S]*?\[Yes\/No\]/, 'yes'],
        [/Enter ANIMASTOR_WORKER_TOKEN \(hidden input\): /, TOKEN],
    ];
    child.stdout.on('data', (d) => {
        const s = d.toString();
        out += s;
        tail += s;
        while (idx < answers.length) {
            const [re, ans] = answers[idx];
            if (re.test(tail.slice(-4000))) {
                child.stdin.write(`${ans}\n`);
                tail = '';
                idx += 1;
            } else break;
        }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });

    // install-state.json is written at the very start of the engine execution
    // phase — BEFORE any component install. Its existence proves the plan was
    // rebuilt with a valid resolution report and execution began.
    const deadline = Date.now() + 40000;
    while (!fs.existsSync(statePath) && Date.now() < deadline) {
        if (child.exitCode !== null) break; // crashed — assertions below report it
        await new Promise((r) => setTimeout(r, 100));
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {
        try { child.kill('SIGKILL'); } catch (__) { /* already gone */ }
    }
    await new Promise((r) => { child.on('close', r); });

    assert.ok(!/buildInstallPlan requires a resolution report/.test(out),
        `plan rebuild must never lose the resolution report; output tail: ${out.slice(-1200)}`);
    assert.ok(!/Still awaiting decisions after prompts/.test(out),
        `all interactive decisions must be consumed; output tail: ${out.slice(-1200)}`);
    assert.ok(fs.existsSync(statePath),
        `engine execution must be reached (state file written); output tail: ${out.slice(-1500)}`);

    const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(st.device, 'cpu', 'CPU device recorded in install state');
    assert.deepStrictEqual(st.profiles, ['audio/qwen-tts']);
    assert.strictEqual(st.mode, 'managed');
    // User selections survive the post-prompt plan rebuild
    assert.strictEqual(st.decisions.install_custom_nodes, true, 'custom nodes selection kept');
    assert.strictEqual(st.decisions.install_models, true, 'models selection kept');
    assert.strictEqual(st.decisions.workflows, 'none', 'workflows decline kept');
    assert.strictEqual(st.decisions.worker_setup, true, 'worker selection kept');
    assert.strictEqual(st.decisions.worker_key_provided, true, 'typed token counts as provided');
    // Secret hygiene: the typed value never appears in output or state
    assert.ok(!out.includes(TOKEN), 'token value must never be printed');
    assert.ok(!fs.readFileSync(statePath, 'utf8').includes(TOKEN), 'token value must never be persisted in state');

    fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

(async () => {
    await Promise.all(pending);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Installer Phase 2.1 CLI smoke: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));
    if (failed > 0) process.exit(1);
})();
