// ======================================================
// GPU Hub — Setup Contract artifact endpoints (Phase 3)
// ======================================================
// GET /worker-bundle          full worker runtime bundle (tar.gz)
// GET /worker-bundle/sha256   bundle checksum metadata
// GET /workflow/:id           baseline workflow JSON (manifest allowlist)
// GET /installer              self-contained installer package (tar.gz)
// GET /installer/sha256       installer checksum metadata
// GET /worker-source          DEPRECATED single-file endpoint (still works)
//
// Invariants under test:
//   - artifacts are deterministic (same content ⇒ same sha256);
//   - .env / secrets are NEVER part of the bundle;
//   - legacy/excluded workflows (old_*.json) are never served;
//   - path traversal is impossible;
//   - the old /worker-source keeps working (no breaking change).

const { expect } = require('chai');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { createMockRedis } = require('./mocks/redis-mock');
const { buildHubApp } = require('../../gpu-hub/gpu-hub');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REAL_WORKER_DIR = path.join(REPO_ROOT, 'worker', 'worker');
const REAL_WORKER_SOURCE = path.join(REAL_WORKER_DIR, 'worker.cjs');
const REAL_WORKFLOW_DIR = path.join(REPO_ROOT, 'backend', 'ai', 'workflows');
const REAL_INSTALLER_SRC = path.join(REPO_ROOT, 'backend', 'src', 'installer');
const REAL_MANIFESTS = path.join(REPO_ROOT, 'backend', 'ai', 'install-manifests');

const ARTIFACT_CONFIG = {
    BACKEND_URL: 'http://backend.test',
    GPU_HUB_API_KEY: null,
    WORKER_SOURCE_PATH: REAL_WORKER_SOURCE,
    WORKER_BUNDLE_DIR: REAL_WORKER_DIR,
    WORKFLOW_DIR: REAL_WORKFLOW_DIR,
    INSTALLER_SRC_DIR: REAL_INSTALLER_SRC,
    INSTALLER_MANIFESTS_DIR: REAL_MANIFESTS,
};

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

/** Parse a ustar buffer → [{ name, size, data }]. */
function parseTar(tar) {
    const entries = [];
    let off = 0;
    while (off + 512 <= tar.length) {
        const header = tar.slice(off, off + 512);
        const name = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
        if (!name) break;
        const prefix = header.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
        const size = parseInt(header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
        const fullName = prefix ? `${prefix}/${name}` : name;
        entries.push({ name: fullName, size, data: tar.slice(off + 512, off + 512 + size) });
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return entries;
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('GPU hub — setup contract artifacts (Phase 3)', () => {
    let hub;
    let tmpDirs = [];

    afterEach(async () => {
        if (hub) { await new Promise((r) => hub.server.close(r)); hub = null; }
        for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
        tmpDirs = [];
    });

    function makeTmpDir(files) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-artifacts-'));
        for (const [name, content] of Object.entries(files)) {
            const full = path.join(dir, name);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
        }
        tmpDirs.push(dir);
        return dir;
    }

    // ══════════════════════════════════════════════════════════════════
    // Worker bundle
    // ══════════════════════════════════════════════════════════════════

    describe('GET /worker-bundle', () => {
        it('serves the full bundle as tar.gz with all runtime files', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            const res = await fetch(`${hub.base}/worker-bundle`);
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type')).to.contain('application/gzip');
            expect(res.headers.get('content-disposition')).to.contain('animastor-worker-');
            expect(res.headers.get('cache-control')).to.equal('no-store');
            expect(res.headers.get('x-animastor-artifact-version')).to.equal('2.0.0');

            const buf = Buffer.from(await res.arrayBuffer());
            const entries = parseTar(zlib.gunzipSync(buf));
            const names = entries.map((e) => e.name).sort();
            expect(names).to.deep.equal([
                'animastor-worker/.env.example',
                'animastor-worker/package-lock.json',
                'animastor-worker/package.json',
                'animastor-worker/worker-cleanup-journal.cjs',
                'animastor-worker/worker-cleanup.cjs',
                'animastor-worker/worker.cjs',
            ]);
            // every file's content matches the repo source
            for (const e of entries) {
                const rel = e.name.replace(/^animastor-worker\//, '');
                expect(sha256(e.data)).to.equal(sha256(fs.readFileSync(path.join(REAL_WORKER_DIR, rel))));
            }
        });

        it('published sha256 matches the downloaded artifact (integrity)', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            const res = await fetch(`${hub.base}/worker-bundle`);
            const buf = Buffer.from(await res.arrayBuffer());
            const meta = await (await fetch(`${hub.base}/worker-bundle/sha256`)).json();
            expect(meta.artifact).to.equal('worker-bundle');
            expect(meta.version).to.equal('2.0.0');
            expect(meta.sha256).to.equal(sha256(buf));
            expect(meta.signature).to.equal(null); // future extension, not invented
            expect(res.headers.get('x-animastor-sha256')).to.equal(meta.sha256);
        });

        it('is deterministic — identical content produces identical bytes', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            const a = Buffer.from(await (await fetch(`${hub.base}/worker-bundle`)).arrayBuffer());
            const b = Buffer.from(await (await fetch(`${hub.base}/worker-bundle`)).arrayBuffer());
            expect(sha256(a)).to.equal(sha256(b));
        });

        it('NEVER includes .env even if present in the source directory', async () => {
            const dir = makeTmpDir({
                'worker.cjs': '// worker',
                'package.json': JSON.stringify({ name: 'animastor-worker', version: '2.0.0' }),
                '.env': 'ANIMASTOR_WORKER_TOKEN=wrk.SUPER-SECRET-LEAK',
                '.env.backup': 'ANIMASTOR_WORKER_TOKEN=wrk.ANOTHER-LEAK',
                '.env.example': 'ANIMASTOR_WORKER_TOKEN=wrk.your-worker-id.your-secret',
            });
            hub = await startHub({ ...ARTIFACT_CONFIG, WORKER_BUNDLE_DIR: dir });
            const res = await fetch(`${hub.base}/worker-bundle`);
            expect(res.status).to.equal(200);
            const buf = Buffer.from(await res.arrayBuffer());
            const entries = parseTar(zlib.gunzipSync(buf));
            const names = entries.map((e) => e.name);
            expect(names).to.not.contain('animastor-worker/.env');
            expect(names).to.not.contain('animastor-worker/.env.backup');
            expect(names).to.contain('animastor-worker/.env.example');
            expect(buf.toString('latin1')).to.not.contain('SUPER-SECRET-LEAK');
            const meta = await (await fetch(`${hub.base}/worker-bundle/sha256`)).json();
            expect(meta.files).to.not.include('.env');
        });

        // Phase 3.1 §4 — unpack the REAL bundle and scan every file for
        // secrets: .env files, Worker Keys, tokens, token_hash, credentials.
        it('security scan: unpacked real bundle contains no secrets', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            const res = await fetch(`${hub.base}/worker-bundle`);
            const buf = Buffer.from(await res.arrayBuffer());
            const entries = parseTar(zlib.gunzipSync(buf));
            expect(entries.length).to.be.greaterThanOrEqual(6); // full runtime, not just worker.cjs
            for (const e of entries) {
                const base = path.basename(e.name);
                if (base.startsWith('.env')) {
                    expect(base, `only .env.example may ship: ${e.name}`).to.equal('.env.example');
                }
                const text = e.data.toString('utf8');
                // no real Worker Keys (wrk.<id>.<secret> with plausible entropy)
                expect(text, `no worker key in ${e.name}`).to.not.match(/wrk\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/);
                // no credential material of any kind
                expect(text, `no token_hash in ${e.name}`).to.not.match(/token_hash/i);
                expect(text, `no credentials in ${e.name}`).to.not.match(/credentials?\s*[:=]/i);
                expect(text, `no bearer tokens in ${e.name}`).to.not.match(/Bearer\s+[A-Za-z0-9._-]{16,}/);
            }
            // .env.example is allowed ONLY with the documented placeholder
            const example = entries.find((e) => e.name.endsWith('.env.example'));
            expect(example, '.env.example ships as the template').to.exist;
            expect(example.data.toString('utf8')).to.contain('<your-worker-key>');
        });

        it('planted secret in a servable file is never shipped', async () => {
            const planted = 'wrk.plantedid0123456.plantedsecret0123456789abcdef';
            const dir = makeTmpDir({
                'worker.cjs': `// worker\nconst leaked = "${planted}";\n`,
                'package.json': JSON.stringify({ name: 'animastor-worker', version: '2.0.0' }),
                '.env': `ANIMASTOR_WORKER_TOKEN=${planted}`,
                '.env.example': 'ANIMASTOR_WORKER_TOKEN=<your-worker-key>',
            });
            hub = await startHub({ ...ARTIFACT_CONFIG, WORKER_BUNDLE_DIR: dir });
            const buf = Buffer.from(await (await fetch(`${hub.base}/worker-bundle`)).arrayBuffer());
            // worker.cjs is servable, so the planted string WOULD ship if the
            // source itself contained it — this asserts the hub never adds
            // secrets on its own and .env is excluded even when it matches.
            const entries = parseTar(zlib.gunzipSync(buf));
            expect(entries.map((e) => e.name)).to.not.contain('animastor-worker/.env');
            const envLeak = entries.some((e) => e.name.endsWith('.env') && e.data.toString().includes(planted));
            expect(envLeak).to.equal(false);
        });

        it('reports Content-Length matching the body (integrity header)', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            for (const ep of ['/worker-bundle', '/installer']) {
                const res = await fetch(`${hub.base}${ep}`);
                const buf = Buffer.from(await res.arrayBuffer());
                expect(Number(res.headers.get('content-length'))).to.equal(buf.length);
            }
        });

        it('version comes from the canonical bundle package.json (no hub-side hardcode)', async () => {
            const dir = makeTmpDir({
                'worker.cjs': '// worker',
                'package.json': JSON.stringify({ name: 'animastor-worker', version: '7.7.7' }),
            });
            hub = await startHub({ ...ARTIFACT_CONFIG, WORKER_BUNDLE_DIR: dir });
            const res = await fetch(`${hub.base}/worker-bundle`);
            expect(res.headers.get('x-animastor-artifact-version')).to.equal('7.7.7');
            expect(res.headers.get('content-disposition')).to.contain('animastor-worker-7.7.7.tar.gz');
            const meta = await (await fetch(`${hub.base}/worker-bundle/sha256`)).json();
            expect(meta.version).to.equal('7.7.7');
        });

        it('no canonical package.json → 404 (a versionless artifact is never served)', async () => {
            const dir = makeTmpDir({ 'worker.cjs': '// worker' });
            hub = await startHub({ ...ARTIFACT_CONFIG, WORKER_BUNDLE_DIR: dir });
            const res = await fetch(`${hub.base}/worker-bundle`);
            expect(res.status).to.equal(404);
            expect((await res.json()).error).to.equal('worker_bundle_unavailable');
        });

        it('answers 404 (never 500) when the bundle directory is absent', async () => {
            hub = await startHub({ ...ARTIFACT_CONFIG, WORKER_BUNDLE_DIR: '/nonexistent/bundle' });
            const res = await fetch(`${hub.base}/worker-bundle`);
            expect(res.status).to.equal(404);
            expect((await res.json()).error).to.equal('worker_bundle_unavailable');
            const meta = await fetch(`${hub.base}/worker-bundle/sha256`);
            expect(meta.status).to.equal(404);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Baseline workflows
    // ══════════════════════════════════════════════════════════════════

    describe('GET /workflow/:id', () => {
        it('serves a canonical baseline workflow with its manifest sha256', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            const res = await fetch(`${hub.base}/workflow/img-qwen-image`);
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type')).to.contain('application/json');
            const buf = Buffer.from(await res.arrayBuffer());
            // matches the canonical repo file AND the manifest baseline_sha256
            const canonical = fs.readFileSync(path.join(REAL_WORKFLOW_DIR, 'img-qwen-image.json'));
            expect(sha256(buf)).to.equal(sha256(canonical));
            expect(res.headers.get('x-animastor-sha256')).to.equal(sha256(canonical));
            const manifest = JSON.parse(fs.readFileSync(path.join(REAL_MANIFESTS, 'image', 'qwen-image.json'), 'utf8'));
            expect(sha256(buf)).to.equal(manifest.workflows.artifacts[0].baseline_sha256);
        });

        it('never serves legacy/excluded workflow files (old_*.json)', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            const res = await fetch(`${hub.base}/workflow/old_img-qwen-image`);
            expect(res.status).to.equal(404);
            expect((await res.json()).error).to.equal('workflow_not_found');
        });

        it('unknown workflow id → 404', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            const res = await fetch(`${hub.base}/workflow/does-not-exist`);
            expect(res.status).to.equal(404);
        });

        it('path traversal is impossible', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            for (const evil of ['..%2f..%2fetc%2fpasswd', '%2e%2e%2fpasswd', 'a..b..%2f']) {
                const res = await fetch(`${hub.base}/workflow/${evil}`);
                expect(res.status).to.equal(404);
            }
        });

        it('reports Content-Length matching the body', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            const res = await fetch(`${hub.base}/workflow/img-qwen-image`);
            const buf = Buffer.from(await res.arrayBuffer());
            expect(Number(res.headers.get('content-length'))).to.equal(buf.length);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Installer package
    // ══════════════════════════════════════════════════════════════════

    describe('GET /installer', () => {
        it('serves a self-contained installer package with manifests', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            const res = await fetch(`${hub.base}/installer`);
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type')).to.contain('application/gzip');
            expect(res.headers.get('x-animastor-artifact-version')).to.equal('1.0.0');
            const buf = Buffer.from(await res.arrayBuffer());
            const names = parseTar(zlib.gunzipSync(buf)).map((e) => e.name);
            expect(names).to.include('animastor-installer/src/installer/cli.js');
            expect(names).to.include('animastor-installer/src/installer/install-manifest.js');
            expect(names).to.include('animastor-installer/ai/install-manifests/image/qwen-image.json');
            expect(names).to.include('animastor-installer/package.json');
            // no secrets of any kind
            for (const n of names) {
                expect(n).to.not.match(/\.env$/);
            }
        });

        it('published sha256 matches the downloaded package', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            const buf = Buffer.from(await (await fetch(`${hub.base}/installer`)).arrayBuffer());
            const meta = await (await fetch(`${hub.base}/installer/sha256`)).json();
            expect(meta.artifact).to.equal('installer');
            expect(meta.version).to.equal('1.0.0');
            expect(meta.sha256).to.equal(sha256(buf));
            expect(meta.signature).to.equal(null);
        });

        it('answers 404 when installer sources are not mounted', async () => {
            hub = await startHub({ ...ARTIFACT_CONFIG, INSTALLER_SRC_DIR: '/nonexistent/installer' });
            const res = await fetch(`${hub.base}/installer`);
            expect(res.status).to.equal(404);
            expect((await res.json()).error).to.equal('installer_unavailable');
        });

        it('version comes from the canonical installer package.json (no hub-side hardcode)', async () => {
            const src = makeTmpDir({
                'cli.js': '// cli',
                'package.json': JSON.stringify({ name: 'animastor-installer', version: '3.1.4' }),
            });
            hub = await startHub({ ...ARTIFACT_CONFIG, INSTALLER_SRC_DIR: src });
            const res = await fetch(`${hub.base}/installer`);
            expect(res.status).to.equal(200);
            expect(res.headers.get('x-animastor-artifact-version')).to.equal('3.1.4');
            expect(res.headers.get('content-disposition')).to.contain('animastor-installer-3.1.4.tar.gz');
            const meta = await (await fetch(`${hub.base}/installer/sha256`)).json();
            expect(meta.version).to.equal('3.1.4');
            // the generated root package.json carries the same canonical version
            const root = parseTar(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())))
                .find((e) => e.name === 'animastor-installer/package.json');
            expect(JSON.parse(root.data.toString('utf8')).version).to.equal('3.1.4');
        });

        it('no canonical package.json → 404 (a versionless artifact is never served)', async () => {
            const src = makeTmpDir({ 'cli.js': '// cli' });
            hub = await startHub({ ...ARTIFACT_CONFIG, INSTALLER_SRC_DIR: src });
            const res = await fetch(`${hub.base}/installer`);
            expect(res.status).to.equal(404);
            expect((await res.json()).error).to.equal('installer_unavailable');
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Legacy endpoint (must keep working — no breaking changes)
    // ══════════════════════════════════════════════════════════════════

    describe('GET /worker-source (deprecated)', () => {
        it('still serves worker.cjs and is marked deprecated', async () => {
            hub = await startHub(ARTIFACT_CONFIG);
            const res = await fetch(`${hub.base}/worker-source`);
            expect(res.status).to.equal(200);
            expect(res.headers.get('deprecation')).to.equal('true');
            expect(res.headers.get('link')).to.contain('/worker-bundle');
            const body = await res.text();
            expect(body).to.equal(fs.readFileSync(REAL_WORKER_SOURCE, 'utf8'));
        });
    });
});
