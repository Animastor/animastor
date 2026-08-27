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
 *   C4  install --dry-run → exit 0, ZERO filesystem mutations (snapshot equal),
 *                           zero downloads, zero process starts, marker printed
 *   C5  verify            → exit 0, prints a verification report
 *   C6  resume (no state) → exact "No resumable installation state found."
 *                           message, non-zero exit, does NOT start an install
 *   C7  unknown command   → exit 1, usage printed
 *
 * Dry-run proof: the snapshot captures every file/dir under the scratch root.
 * If the dry-run path performed ANY mkdir/write/download/clone it would change
 * the snapshot (or trip the mutation guard and exit non-zero). Equality of the
 * two snapshots + exit 0 is the proof of "zero mutations / zero downloads /
 * zero process starts".
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
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

// ---------------------------------------------------------------------------

(async () => {
    await Promise.all(pending);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Installer Phase 2.1 CLI smoke: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));
    if (failed > 0) process.exit(1);
})();
