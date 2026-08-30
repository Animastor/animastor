// ======================================================
// Bootstrap installer — END-TO-END execution tests (Phase 3.2)
// ======================================================
// The bash script produced by buildBootstrapScript() is executed for real
// against a hub under test whose installer CLI is a stub that records how
// it was invoked. The HTTP serving of the script is covered by
// gpu-hub-artifacts.test.js; here we test the RUNTIME behavior of the
// script itself — download, verify, execute, cleanup, credential rejection,
// exit code propagation, and error handling.
//
// NOTE: We use child_process.exec (not spawnSync) because spawnSync's
// synchronous pipe reads cause a deadlock when the child (bash → curl)
// writes enough data to fill the OS pipe buffer (64KB). exec reads
// stdout/stderr asynchronously, preventing the deadlock.

const { expect } = require('chai');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMockRedis } = require('./mocks/redis-mock');
const { buildHubApp } = require('../../gpu-hub/gpu-hub');
const { buildBootstrapScript } = require('../../gpu-hub/bootstrap');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REAL_MANIFESTS = path.join(REPO_ROOT, 'backend', 'ai', 'install-manifests');

const STUB_CLI = `
const fs = require('fs');
const record = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdinIsTTY: process.stdin.isTTY === true,
};
const out = process.env.BOOTSTRAP_TEST_RECORDER;
if (out) fs.appendFileSync(out, JSON.stringify(record) + '\\n');
process.stdout.write('animastor-installer v9.9.9 (stub)\\n');
process.exit(Number(process.env.BOOTSTRAP_TEST_EXIT || '0'));
`;

async function startHub(config) {
    const app = buildHubApp({
        redis: createMockRedis(),
        config,
        fetchImpl: async () => ({ ok: true, status: 200 }),
        intervals: false,
    });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function execBash(scriptFile, { env = {}, timeout = 30000, args = '' } = {}) {
    return new Promise((resolve) => {
        exec(`bash "${scriptFile}" ${args}`, {
            env: { ...process.env, ...env },
            timeout,
            maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => {
            resolve({
                status: error ? error.code || 1 : 0,
                stdout: stdout || '',
                stderr: stderr || '',
                error,
            });
        });
    });
}

describe('Bootstrap installer (end-to-end)', function () {
    this.timeout(60000);

    let tmpRoot;
    let hub;
    let recorder;
    let stubSrc;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-e2e-'));
        recorder = path.join(tmpRoot, 'installer-calls.jsonl');
        stubSrc = path.join(tmpRoot, 'installer-src');
        fs.mkdirSync(stubSrc, { recursive: true });
        fs.writeFileSync(path.join(stubSrc, 'cli.js'), STUB_CLI);
        fs.writeFileSync(path.join(stubSrc, 'package.json'),
            JSON.stringify({ name: 'animastor-installer', version: '9.9.9' }));
    });

    afterEach(async () => {
        if (hub) { await new Promise((r) => hub.server.close(r)); hub = null; }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function writeScript(profile, mode, hubUrl) {
        const file = path.join(tmpRoot, 'animastor-installer.sh');
        fs.writeFileSync(file, buildBootstrapScript({ hubUrl: hubUrl || hub.base, profile, mode }));
        return file;
    }

    function runBootstrap(scriptFile, { env = {} } = {}) {
        return execBash(scriptFile, {
            env: { ANIMASTOR_HUB_URL: hub ? hub.base : undefined, BOOTSTRAP_TEST_RECORDER: recorder, ...env },
        });
    }

    function readRecorder() {
        if (!fs.existsSync(recorder)) return [];
        return fs.readFileSync(recorder, 'utf8').trim().split('\n').filter(Boolean)
            .map((line) => JSON.parse(line));
    }

    it('full happy path: download → verify → run installer with embedded profile/mode → temp dir wiped', async () => {
        hub = await startHub({
            INSTALLER_SRC_DIR: stubSrc,
            WORKER_BUNDLE_DIR: path.join(REPO_ROOT, 'worker', 'worker'),
            WORKFLOW_DIR: path.join(REPO_ROOT, 'backend', 'ai', 'workflows'),
            INSTALLER_MANIFESTS_DIR: REAL_MANIFESTS,
        });
        const script = writeScript('image/qwen-image', 'managed');
        const run = await runBootstrap(script);
        expect(run.status, `${run.stderr}\n${run.stdout}`).to.equal(0);

        const calls = readRecorder();
        expect(calls).to.have.lengthOf(1);
        expect(calls[0].argv).to.deep.equal(['install', '--profile', 'image/qwen-image', '--mode', 'managed']);
        expect(calls[0].cwd).to.match(/animastor-installer\./);
        expect(fs.existsSync(calls[0].cwd), 'temp workspace must be removed after the run').to.equal(false);
        expect(run.stdout).to.contain('Verifying integrity');
        expect(run.stdout).to.contain('checksum OK');
        expect(run.stdout).to.contain('Online');
    });

    it('tampered bundle is NEVER executed (integrity gate)', async () => {
        const crypto = require('crypto');
        const server = require('http').createServer((req, res) => {
            if (req.url === '/installer/sha256') {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({
                    artifact: 'installer', version: '9.9.9',
                    sha256: crypto.createHash('sha256').update('anything-else').digest('hex'),
                }));
            } else if (req.url === '/installer/bundle') {
                res.setHeader('content-type', 'application/gzip');
                res.end(Buffer.from('this is NOT a tarball — a MITM/corruption payload'));
            } else {
                res.statusCode = 404; res.end('{}');
            }
        });
        await new Promise((r) => server.listen(0, r));
        try {
            const tamperedBase = `http://127.0.0.1:${server.address().port}`;
            const script = writeScript('image/qwen-image', 'managed', tamperedBase);
            const run = await execBash(script, { env: { ANIMASTOR_HUB_URL: tamperedBase, BOOTSTRAP_TEST_RECORDER: recorder } });
            expect(run.status).to.not.equal(0);
            expect(run.stderr).to.contain('integrity check FAILED');
            expect(readRecorder()).to.have.lengthOf(0);
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it('a Worker Key in the environment is REFUSED (fail closed, nothing downloaded)', async () => {
        hub = await startHub({ INSTALLER_MANIFESTS_DIR: REAL_MANIFESTS });
        const script = writeScript('image/qwen-image', 'managed');
        const run = await runBootstrap(script, {
            env: { ANIMASTOR_WORKER_TOKEN: 'wrk.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb' },
        });
        expect(run.status).to.equal(3);
        expect(run.stderr).to.contain('never accepts the Worker Key');
        expect(readRecorder()).to.have.lengthOf(0);
    });

    it('a credential-like CLI argument is REFUSED (the key belongs to the hidden prompt)', async () => {
        hub = await startHub({ INSTALLER_MANIFESTS_DIR: REAL_MANIFESTS });
        const script = writeScript('image/qwen-image', 'managed');
        const run = await execBash(script, {
            env: { ANIMASTOR_HUB_URL: hub.base, BOOTSTRAP_TEST_RECORDER: recorder },
            args: '--worker-key wrk.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb',
        });
        expect(run.status).to.equal(3);
        expect(run.stderr).to.contain('credential-like argument detected');
        expect(readRecorder()).to.have.lengthOf(0);
    });

    it('bootstrap without an embedded profile refuses to guess (re-download from the page)', async () => {
        hub = await startHub({ INSTALLER_MANIFESTS_DIR: REAL_MANIFESTS });
        const script = writeScript(null, null);
        const run = await runBootstrap(script);
        expect(run.status).to.equal(3);
        expect(run.stderr).to.contain('no install profile configured');
        expect(readRecorder()).to.have.lengthOf(0);
    });

    it('re-running the bootstrap is safe (fresh temp dir, installer invoked again)', async () => {
        hub = await startHub({
            INSTALLER_SRC_DIR: stubSrc,
            WORKER_BUNDLE_DIR: path.join(REPO_ROOT, 'worker', 'worker'),
            WORKFLOW_DIR: path.join(REPO_ROOT, 'backend', 'ai', 'workflows'),
            INSTALLER_MANIFESTS_DIR: REAL_MANIFESTS,
        });
        const script = writeScript('image/qwen-image', 'managed');
        const first = await runBootstrap(script);
        expect(first.status).to.equal(0);
        const second = await runBootstrap(script);
        expect(second.status).to.equal(0);
        const calls = readRecorder();
        expect(calls).to.have.lengthOf(2);
        expect(calls[0].argv).to.deep.equal(calls[1].argv);
        expect(calls[0].cwd).to.not.equal(calls[1].cwd);
    });

    it('installer failures propagate (exit code + visible remediation pointer)', async () => {
        hub = await startHub({
            INSTALLER_SRC_DIR: stubSrc,
            WORKER_BUNDLE_DIR: path.join(REPO_ROOT, 'worker', 'worker'),
            WORKFLOW_DIR: path.join(REPO_ROOT, 'backend', 'ai', 'workflows'),
            INSTALLER_MANIFESTS_DIR: REAL_MANIFESTS,
        });
        const script = writeScript('image/qwen-image', 'managed');
        const run = await runBootstrap(script, { env: { BOOTSTRAP_TEST_EXIT: '7' } });
        expect(run.status).to.equal(7);
        expect(run.stderr).to.contain('exited with an error');
        expect(readRecorder()).to.have.lengthOf(1);
    });

    it('profile/mode are NOT secrets — but no credential is ever embedded', async () => {
        const file = path.join(tmpRoot, 'check.sh');
        fs.writeFileSync(file, buildBootstrapScript({ hubUrl: 'http://example.com', profile: 'image/qwen-image', mode: 'managed' }));
        const content = fs.readFileSync(file, 'utf8');
        expect(content).to.contain('image/qwen-image');
        expect(content).to.not.match(/wrk\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
        expect(content).to.not.contain('ANIMASTOR_WORKER_TOKEN=');
    });

    it('deterministic output: same hub + profile → identical script bytes', async () => {
        const a = path.join(tmpRoot, 'a.sh');
        const b = path.join(tmpRoot, 'b.sh');
        fs.writeFileSync(a, buildBootstrapScript({ hubUrl: 'http://example.com', profile: 'image/qwen-image', mode: 'managed' }));
        fs.writeFileSync(b, buildBootstrapScript({ hubUrl: 'http://example.com', profile: 'image/qwen-image', mode: 'managed' }));
        expect(fs.readFileSync(a, 'utf8')).to.equal(fs.readFileSync(b, 'utf8'));
    });
});
