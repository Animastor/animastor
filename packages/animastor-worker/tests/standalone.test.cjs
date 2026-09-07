// ======================================================
// animastor-worker — standalone boot smoke (package-owned)
// ======================================================
// Proves the bundle runs as a self-contained artifact: spawn worker.cjs
// from the package directory with a clean environment and no monorepo
// files — the fail-closed credential gate must terminate the process with
// exit code 1 (missing credential never silently becomes shared capacity,
// PW-4). Run: node tests/run-all.cjs (from worker/) — needs only node.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, expect } = require('./harness.cjs');

const BUNDLE_DIR = path.join(__dirname, '..', 'worker');

function cleanCopy() {
    // copy the bundle to a temp dir so the boot test proves file-level
    // self-containment (no accidental reliance on sibling checkout files)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-standalone-'));
    for (const f of fs.readdirSync(BUNDLE_DIR)) {
        if (f === 'tests' || f === 'node_modules') continue;
        fs.copyFileSync(path.join(BUNDLE_DIR, f), path.join(tmp, f));
    }
    return tmp;
}

describe('worker package — standalone boot smoke', () => {
    it('worker.cjs boots from a clean copy and fails closed without a credential', async () => {
        const tmp = cleanCopy();
        try {
            // env -i equivalent: no ANIMASTOR_WORKER_TOKEN, no .env file
            const res = spawnSync(process.execPath, ['worker.cjs'], {
                cwd: tmp,
                env: { PATH: process.env.PATH, HOME: process.env.HOME },
                timeout: 20000,
                encoding: 'utf8',
            });
            const output = String(res.stdout || '') + String(res.stderr || '');
            expect.equal(res.status, 1, `fail-closed exit code (output: ${output.slice(0, 400)})`);
            expect.include(output, 'Worker authentication failed');
            expect.include(output, 'ANIMASTOR_WORKER_TOKEN');
            expect.notInclude(output, 'Protocol version', 'must exit before any protocol activity');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('worker.cjs reports the canonical protocol version from the generated copy', async () => {
        const tmp = cleanCopy();
        try {
            const res = spawnSync(process.execPath, ['worker.cjs'], {
                cwd: tmp,
                env: {
                    PATH: process.env.PATH, HOME: process.env.HOME,
                    ANIMASTOR_WORKER_TOKEN: 'wrk.standalone.smoke',
                    WORKER_TYPE: 'image', WORKER_ID: 'smoke-worker',
                    // unreachable endpoints: the run stays local (no network egress)
                    HUB_URL: 'http://127.0.0.1:1', ANIMASTOR_API_URL: 'http://127.0.0.1:1/api/v1',
                    COMFY_PORT: '1',
                },
                timeout: 15000,
                encoding: 'utf8',
            });
            const output = String(res.stdout || '') + String(res.stderr || '');
            expect.include(output, 'Worker version: 2.1.1');
            expect.include(output, 'Protocol version: 2');
            // signal of the canonical copy in action: startup proceeded past
            // the config section (task rejects / waits use the same constant)
            expect.include(output, 'Waiting for ComfyUI');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
