// ======================================================
// Private Worker Setup Contract — API tests (Phase 3)
// ======================================================
// End-to-end coverage of the unified backend setup contract consumed by
// Web and Android (backend/src/routes/worker-setup-routes.cjs):
//
//   Auth & isolation
//     anonymous → 401 on every setup endpoint; worker Bearer ≠ session
//     setup/workers/:id — own visible, foreign → 404 (no existence oracle)
//
//   Profiles   — canonical installer metadata, no internal details
//   Platforms  — Linux available, Windows planned, unsupported → 404
//   Artifacts  — installer/uninstaller/worker-bundle metadata + checksum
//   Workflows  — baseline available, editable=true, no secret leakage
//   Worker     — extended status model, revoked handled, no token/token_hash
//   Security   — no token, no token_hash, no secrets in ANY response
//   Plan       — image/video/audio, existing/managed, shared verdicts
//
//   Legacy API — POST/GET/rotate/DELETE /api/v1/workers still work.

const { expect } = require('chai');
const express = require('express');
const path = require('path');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const { authContext } = require('../src/middleware/auth-context');
const config = require('../src/config/runtime-config');
const { createMockRedis } = require('./mocks/redis-mock');
const { buildHubApp } = require('../../gpu-hub/gpu-hub');

const REPO_ROOT = path.join(__dirname, '..', '..');

function cookieOf(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const sid = set.find((c) => c.startsWith('animastor_sid='));
    return sid ? sid.split(';')[0] : null;
}

async function cleanup() {
    await query(`DELETE FROM workers WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwsetup3%'))`);
    await query(`DELETE FROM workspace_members WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'pwsetup3%'))`);
    await query(`DELETE FROM sessions WHERE user_id IN (
        SELECT user_id FROM users WHERE username LIKE 'pwsetup3%')`);
    await query(`DELETE FROM workspaces WHERE owner_user_id IN (
        SELECT user_id FROM users WHERE username LIKE 'pwsetup3%')`);
    await query(`DELETE FROM users WHERE username LIKE 'pwsetup3%'`);
}

function writeHeartbeat(redis, workerType, workerId, ts = Date.now()) {
    const key = config.WORKER_HEARTBEAT_KEY(workerType, workerId);
    return redis.set(key, JSON.stringify({ type: workerType, worker_id: workerId, ts }), 'EX', config.WORKER_HEARTBEAT_TTL);
}

describe('Private worker setup contract API (Phase 3)', () => {
    let server;
    let hubServer;
    let base;
    let hubBase;
    let redis;
    let alice; // workspace A
    let bob;   // workspace B
    let aliceWorker;
    let aliceToken;

    before(async function() {
        this.timeout(60000);
        await runMigrations();
        await cleanup();
        redis = createMockRedis();

        // Real hub instance (real repo artifacts) — the setup contract
        // resolves artifact checksums against it, exactly like production.
        const hubApp = buildHubApp({
            redis: createMockRedis(),
            config: {
                BACKEND_URL: 'http://backend.test',
                GPU_HUB_API_KEY: null,
                WORKER_SOURCE_PATH: path.join(REPO_ROOT, 'worker', 'worker', 'worker.cjs'),
                WORKER_BUNDLE_DIR: path.join(REPO_ROOT, 'worker', 'worker'),
                WORKFLOW_DIR: path.join(REPO_ROOT, 'backend', 'ai', 'workflows'),
                INSTALLER_SRC_DIR: path.join(REPO_ROOT, 'backend', 'src', 'installer'),
                INSTALLER_MANIFESTS_DIR: path.join(REPO_ROOT, 'backend', 'ai', 'install-manifests'),
            },
            fetchImpl: async () => ({ ok: true, status: 200 }),
            intervals: false,
        });
        await new Promise((resolve) => {
            hubServer = hubApp.listen(0, () => {
                hubBase = `http://127.0.0.1:${hubServer.address().port}`;
                resolve();
            });
        });

        const registerAuthRoutes = require('../src/routes/auth-routes.cjs');
        const registerWorkerRoutes = require('../src/routes/worker-routes.cjs');
        const registerSetupRoutes = require('../src/routes/worker-setup-routes.cjs');

        const app = express();
        app.use(express.json());
        app.use(authContext);
        registerAuthRoutes(app, null, { utils: { log: () => {} } });
        registerWorkerRoutes(app, redis);
        registerSetupRoutes(app, redis, { hubUrlResolver: () => hubBase });

        await new Promise((resolve) => {
            server = app.listen(0, () => {
                app.__port = server.address().port;
                base = `http://127.0.0.1:${app.__port}`;
                resolve();
            });
        });

        const register = async (username) => {
            const res = await fetch(`${base}/api/v1/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password: 'correct-horse-42', email: `${username}@test.local` }),
            });
            const body = await res.json();
            expect(res.status).to.equal(201);
            return { cookie: cookieOf(res), workspaceId: body.workspace.id };
        };
        alice = await register(`pwsetup3_alice_${Date.now()}`);
        bob = await register(`pwsetup3_bob_${Date.now() + 1}`);

        const cw = await fetch(`${base}/api/v1/workers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
            body: JSON.stringify({ name: 'alice-image', worker_type: 'image' }),
        });
        expect(cw.status).to.equal(201);
        const cwBody = await cw.json();
        aliceWorker = cwBody.worker;
        aliceToken = cwBody.token;
    });

    after(async function() {
        this.timeout(30000);
        if (server) server.close();
        if (hubServer) hubServer.close();
        await cleanup();
    });

    const SETUP_ENDPOINTS = [
        ['GET', '/api/v1/private-worker/setup/profiles'],
        ['GET', '/api/v1/private-worker/setup/methods'],
        ['GET', '/api/v1/private-worker/setup/artifacts'],
        ['GET', '/api/v1/private-worker/setup/workflows'],
        ['GET', '/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image'],
        ['POST', '/api/v1/private-worker/setup/plan'],
    ];

    // ══════════════════════════════════════════════════════════════════
    // Auth & workspace isolation
    // ══════════════════════════════════════════════════════════════════

    describe('auth & isolation', () => {
        it('anonymous → 401 on every setup endpoint', async () => {
            for (const [method, url] of SETUP_ENDPOINTS) {
                const res = await fetch(`${base}${url}`, {
                    method,
                    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
                    body: method === 'POST' ? JSON.stringify({ profile_ids: ['image/qwen-image'], mode: 'managed' }) : undefined,
                });
                expect(res.status, `${method} ${url}`).to.equal(401);
            }
        });

        it('a worker Bearer token is NOT a user session for setup endpoints', async () => {
            const res = await fetch(`${base}/api/v1/private-worker/setup/profiles`, {
                headers: { Authorization: `Bearer ${aliceToken}` },
            });
            expect(res.status).to.equal(401);
        });

        it('setup/workers/:id — own worker visible, foreign worker → 404', async () => {
            const own = await fetch(`${base}/api/v1/private-worker/setup/workers/${aliceWorker.worker_id}`, {
                headers: { Cookie: alice.cookie },
            });
            expect(own.status).to.equal(200);
            const foreign = await fetch(`${base}/api/v1/private-worker/setup/workers/${aliceWorker.worker_id}`, {
                headers: { Cookie: bob.cookie },
            });
            expect(foreign.status).to.equal(404);
            const garbage = await fetch(`${base}/api/v1/private-worker/setup/workers/not-a-uuid`, {
                headers: { Cookie: alice.cookie },
            });
            expect(garbage.status).to.equal(404);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Profiles
    // ══════════════════════════════════════════════════════════════════

    describe('GET setup/profiles', () => {
        it('returns supported profiles from canonical installer metadata', async () => {
            const res = await fetch(`${base}/api/v1/private-worker/setup/profiles`, { headers: { Cookie: alice.cookie } });
            expect(res.status).to.equal(200);
            const { profiles } = await res.json();
            expect(profiles.map((p) => p.id).sort()).to.deep.equal([
                'audio/qwen-tts', 'image/qwen-image', 'video/ltx-2.3',
            ]);
            const image = profiles.find((p) => p.id === 'image/qwen-image');
            expect(image.name).to.equal('Qwen Image');
            expect(image.worker_type).to.equal('image');
            expect(image.supported_install_modes).to.include('managed').and.include('existing');
            expect(image.gpu).to.have.property('min_vram_gb'); // null is fine — unknown, not invented
            expect(image.workflows).to.deep.equal(['img-qwen-image']);
        });

        it('filters by type; invalid type → 400', async () => {
            const ok = await fetch(`${base}/api/v1/private-worker/setup/profiles?type=video`, { headers: { Cookie: alice.cookie } });
            const { profiles } = await ok.json();
            expect(profiles.map((p) => p.id)).to.deep.equal(['video/ltx-2.3']);
            const bad = await fetch(`${base}/api/v1/private-worker/setup/profiles?type=quantum`, { headers: { Cookie: alice.cookie } });
            expect(bad.status).to.equal(400);
        });

        it('never exposes internal manifest details or secrets', async () => {
            const text = await (await fetch(`${base}/api/v1/private-worker/setup/profiles`, { headers: { Cookie: alice.cookie } })).text();
            for (const needle of ['provenance', 'repository_path', 'token_hash', 'huggingface', 'environment_reference']) {
                expect(text, needle).to.not.contain(needle);
            }
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Platforms / methods / artifacts
    // ══════════════════════════════════════════════════════════════════

    describe('GET setup/methods & setup/artifacts', () => {
        it('Linux installer available (draft) with a real hub-resolved sha256', async () => {
            const res = await fetch(`${base}/api/v1/private-worker/setup/methods`, { headers: { Cookie: alice.cookie } });
            expect(res.status).to.equal(200);
            const { methods } = await res.json();
            const linux = methods.find((m) => m.platform === 'linux');
            expect(linux.installer.available).to.equal(true);
            expect(linux.installer.status).to.equal('draft');
            expect(linux.installer.download_url).to.equal('/gpu/installer');
            expect(linux.installer.sha256).to.match(/^[0-9a-f]{64}$/); // resolved from the hub
            expect(linux.worker_bundle.sha256).to.match(/^[0-9a-f]{64}$/);
            expect(linux.uninstaller.available).to.equal(false);
            expect(linux.uninstaller.status).to.equal('planned');
        });

        it('Windows is planned — schema-ready for future available=true', async () => {
            const { methods } = await (await fetch(`${base}/api/v1/private-worker/setup/methods`, { headers: { Cookie: alice.cookie } })).json();
            const windows = methods.find((m) => m.platform === 'windows');
            expect(windows.installer).to.deep.include({ available: false, status: 'planned' });
            expect(windows.uninstaller).to.deep.include({ available: false, status: 'planned' });
        });

        it('artifacts endpoint: linux ok, unsupported platform → 404', async () => {
            const ok = await fetch(`${base}/api/v1/private-worker/setup/artifacts?platform=linux`, { headers: { Cookie: alice.cookie } });
            expect(ok.status).to.equal(200);
            const body = await ok.json();
            expect(body.platform).to.equal('linux');
            expect(body.installer.version).to.be.a('string');
            expect(body.uninstaller.status).to.equal('planned');
            expect(body.worker_bundle.files).to.include('worker.cjs');

            const bad = await fetch(`${base}/api/v1/private-worker/setup/artifacts?platform=solaris`, { headers: { Cookie: alice.cookie } });
            expect(bad.status).to.equal(404);
            expect((await bad.json()).code).to.equal('unsupported_platform');
        });

        it('metadata carries no shell commands or file-format specifics', async () => {
            const text = await (await fetch(`${base}/api/v1/private-worker/setup/methods`, { headers: { Cookie: alice.cookie } })).text();
            for (const needle of ['.sh', '.bat', '.exe', 'PowerShell', 'curl']) {
                expect(text, needle).to.not.contain(needle);
            }
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Workflows
    // ══════════════════════════════════════════════════════════════════

    describe('GET setup/workflows', () => {
        it('baseline workflows available, editable, with sha256 + download_url', async () => {
            const res = await fetch(`${base}/api/v1/private-worker/setup/workflows`, { headers: { Cookie: alice.cookie } });
            expect(res.status).to.equal(200);
            const { workflows } = await res.json();
            expect(workflows.length).to.be.greaterThanOrEqual(7);
            const wf = workflows.find((w) => w.id === 'img-qwen-image');
            expect(wf.baseline_available).to.equal(true);
            expect(wf.editable).to.equal(true);
            expect(wf.profile_id).to.equal('image/qwen-image');
            expect(wf.sha256).to.match(/^[0-9a-f]{64}$/);
            expect(wf.download_url).to.equal('/gpu/workflow/img-qwen-image');
            // the advertised download actually works and matches the sha256
            const dl = await fetch(`${hubBase}/workflow/img-qwen-image`);
            expect(dl.status).to.equal(200);
            expect(dl.headers.get('x-animastor-sha256')).to.equal(wf.sha256);
        });

        it('filters by profile_id; unknown profile → 400 invalid_profile', async () => {
            const ok = await fetch(`${base}/api/v1/private-worker/setup/workflows?profile_id=audio/qwen-tts`, { headers: { Cookie: alice.cookie } });
            const { workflows } = await ok.json();
            expect(workflows.every((w) => w.profile_id === 'audio/qwen-tts')).to.equal(true);
            const bad = await fetch(`${base}/api/v1/private-worker/setup/workflows?profile_id=nope/x`, { headers: { Cookie: alice.cookie } });
            expect(bad.status).to.equal(400);
            expect((await bad.json()).code).to.equal('invalid_profile');
        });

        it('no secret leakage in workflow metadata', async () => {
            const text = await (await fetch(`${base}/api/v1/private-worker/setup/workflows`, { headers: { Cookie: alice.cookie } })).text();
            expect(text).to.not.contain('token');
            expect(text).to.not.contain('wrk.');
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Instructions
    // ══════════════════════════════════════════════════════════════════

    describe('GET setup/instructions', () => {
        it('dynamic instructions for linux/managed include the bootstrap flow', async () => {
            const res = await fetch(`${base}/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image&platform=linux&mode=managed`, {
                headers: { Cookie: alice.cookie },
            });
            expect(res.status).to.equal(200);
            const body = await res.json();
            expect(body.profile_ids).to.deep.equal(['image/qwen-image']);
            expect(body.steps.map((s) => s.id)).to.include('download-bootstrap').and.include('run-bootstrap');
            const download = body.steps.find((s) => s.id === 'download-bootstrap');
            // profile/mode embedded in the bootstrap download URL
            expect(download.code).to.contain('/gpu/installer?profile=image%2Fqwen-image&mode=managed');
            // the run command is just the script — no flags, no typing
            const run = body.steps.find((s) => s.id === 'run-bootstrap');
            expect(run.code).to.equal('bash animastor-installer.sh');
            // the old tarball+node instruction is gone from the contract
            expect(JSON.stringify(body)).to.not.contain('worker-source');
            expect(JSON.stringify(body)).to.not.contain('node worker.cjs');
            expect(JSON.stringify(body)).to.not.contain('cli.js install');
        });

        it('existing mode yields prerequisites; windows yields planned flow', async () => {
            const existing = await (await fetch(`${base}/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image&mode=existing`, { headers: { Cookie: alice.cookie } })).json();
            expect(existing.steps.map((s) => s.id)).to.contain('prerequisites');
            const windows = await (await fetch(`${base}/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image&platform=windows`, { headers: { Cookie: alice.cookie } })).json();
            expect(windows.steps.map((s) => s.id)).to.contain('platform-planned');
        });

        it('token appears only as a placeholder', async () => {
            const body = await (await fetch(`${base}/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image`, { headers: { Cookie: alice.cookie } })).json();
            expect(body.env.template_block).to.contain('ANIMASTOR_WORKER_TOKEN=<your-worker-key>');
            expect(JSON.stringify(body)).to.not.contain(aliceToken);
            expect(JSON.stringify(body)).to.not.match(/wrk\.[A-Za-z0-9_-]{8,}/);
        });

        it('invalid profile → 400, unsupported platform → 404', async () => {
            const badProfile = await fetch(`${base}/api/v1/private-worker/setup/instructions?profile_id=nope/x`, { headers: { Cookie: alice.cookie } });
            expect(badProfile.status).to.equal(400);
            expect((await badProfile.json()).code).to.equal('invalid_profile');
            const badPlatform = await fetch(`${base}/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image&platform=solaris`, { headers: { Cookie: alice.cookie } });
            expect(badPlatform.status).to.equal(404);
            const missing = await fetch(`${base}/api/v1/private-worker/setup/instructions`, { headers: { Cookie: alice.cookie } });
            expect(missing.status).to.equal(400);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Worker setup status
    // ══════════════════════════════════════════════════════════════════

    describe('GET setup/workers/:id', () => {
        it('created-but-never-seen worker → CONNECTING (extended model)', async () => {
            const res = await fetch(`${base}/api/v1/private-worker/setup/workers/${aliceWorker.worker_id}`, { headers: { Cookie: alice.cookie } });
            expect(res.status).to.equal(200);
            const { worker } = await res.json();
            expect(worker.status).to.equal('CONNECTING');
            expect(worker.base_status).to.equal('OFFLINE'); // legacy derivation unchanged
            expect(worker.status_model).to.include.members(['NOT_CONFIGURED', 'INSTALLING', 'CONNECTING', 'ONLINE', 'OFFLINE', 'ERROR', 'REVOKED']);
            expect(worker.capabilities).to.equal(null); // nothing reported yet — not invented
        });

        it('live heartbeat → ONLINE; revoked → REVOKED', async () => {
            const cw = await fetch(`${base}/api/v1/workers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
                body: JSON.stringify({ name: 'status-probe', worker_type: 'audio' }),
            });
            const { worker } = await cw.json();
            await writeHeartbeat(redis, 'audio', worker.worker_id);
            const online = await (await fetch(`${base}/api/v1/private-worker/setup/workers/${worker.worker_id}`, { headers: { Cookie: alice.cookie } })).json();
            expect(online.worker.status).to.equal('ONLINE');
            expect(online.worker.base_status).to.equal('ONLINE');

            await fetch(`${base}/api/v1/workers/${worker.worker_id}`, { method: 'DELETE', headers: { Cookie: alice.cookie } });
            const revoked = await (await fetch(`${base}/api/v1/private-worker/setup/workers/${worker.worker_id}`, { headers: { Cookie: alice.cookie } })).json();
            expect(revoked.worker.status).to.equal('REVOKED');
            expect(revoked.worker.base_status).to.equal('REVOKED');
        });

        it('seen-then-lost worker → OFFLINE', async () => {
            const cw = await fetch(`${base}/api/v1/workers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
                body: JSON.stringify({ name: 'seen-then-lost', worker_type: 'audio' }),
            });
            const { worker } = await cw.json();
            await writeHeartbeat(redis, 'audio', worker.worker_id);
            await redis.del(config.WORKER_HEARTBEAT_KEY('audio', worker.worker_id));
            await query('UPDATE workers SET last_seen = $1 WHERE worker_id = $2', [Date.now(), worker.worker_id]);
            const res = await (await fetch(`${base}/api/v1/private-worker/setup/workers/${worker.worker_id}`, { headers: { Cookie: alice.cookie } })).json();
            expect(res.worker.status).to.equal('OFFLINE');
            expect(res.worker.last_seen).to.be.a('number');
        });

        it('never exposes token/token_hash — at most token_prefix', async () => {
            const text = await (await fetch(`${base}/api/v1/private-worker/setup/workers/${aliceWorker.worker_id}`, { headers: { Cookie: alice.cookie } })).text();
            expect(text).to.not.contain('token_hash');
            expect(text).to.not.contain(aliceToken);
            expect(text).to.not.match(/wrk\.[A-Za-z0-9_-]{8,}/);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Installation plan
    // ══════════════════════════════════════════════════════════════════

    describe('POST setup/plan', () => {
        async function plan(cookie, body) {
            const res = await fetch(`${base}/api/v1/private-worker/setup/plan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify(body),
            });
            return { res, body: await res.json() };
        }

        it('image (managed): UI-safe summary with actions/warnings/blocks', async () => {
            const { res, body } = await plan(alice.cookie, { profile_ids: ['image/qwen-image'], mode: 'managed', platform: 'linux' });
            expect(res.status).to.equal(200);
            expect(body.result).to.be.oneOf(['READY', 'READY_WITH_WARNINGS', 'BLOCKED']);
            expect(body.profiles).to.deep.equal(['image/qwen-image']);
            expect(body.actions).to.be.an('array').with.length.greaterThan(0);
            for (const a of body.actions) {
                expect(a).to.have.property('type');
                expect(a).to.have.property('component');
                expect(a.type).to.be.oneOf(['KEEP', 'INSTALL', 'DOWNLOAD', 'CONFIGURE', 'VERIFY', 'REVIEW']);
            }
            expect(body.warnings).to.be.an('array');
            expect(body.blocks).to.be.an('array');
            // sources researched: ready with warnings for missing models on clean machine
            expect(body.result).to.be.oneOf(['READY', 'READY_WITH_WARNINGS']);
        });

        it('video and audio plans are computable', async () => {
            for (const id of ['video/ltx-2.3', 'audio/qwen-tts']) {
                const { res, body } = await plan(alice.cookie, { profile_ids: [id], mode: 'managed', platform: 'linux' });
                expect(res.status).to.equal(200);
                expect(body.profiles).to.deep.equal([id]);
                expect(body.actions.length).to.be.greaterThan(0);
            }
        });

        it('existing mode marks actions conditional', async () => {
            const { res, body } = await plan(alice.cookie, { profile_ids: ['image/qwen-image'], mode: 'existing', platform: 'linux' });
            expect(res.status).to.equal(200);
            const installs = body.actions.filter((a) => a.type === 'INSTALL' || a.type === 'DOWNLOAD');
            expect(installs.every((a) => a.conditional === true)).to.equal(true);
        });

        it('shared-compatible pair → SHARED_COMPATIBLE; conflicting pair → REQUIRES_ISOLATION', async () => {
            const ok = await plan(alice.cookie, { profile_ids: ['audio/qwen-tts', 'image/qwen-image'], mode: 'shared', platform: 'linux' });
            expect(ok.body.sharing.verdict).to.equal('SHARED_COMPATIBLE');
            const conflict = await plan(alice.cookie, { profile_ids: ['image/qwen-image', 'video/ltx-2.3'], mode: 'shared', platform: 'linux' });
            expect(conflict.body.sharing.verdict).to.equal('REQUIRES_ISOLATION');
        });

        it('windows → BLOCKED PLATFORM_NOT_SUPPORTED; invalid inputs → coded 4xx', async () => {
            const win = await plan(alice.cookie, { profile_ids: ['image/qwen-image'], mode: 'managed', platform: 'windows' });
            expect(win.body.result).to.equal('BLOCKED');
            expect(win.body.blocks[0].code).to.equal('PLATFORM_NOT_SUPPORTED');

            const unknown = await plan(alice.cookie, { profile_ids: ['nope/x'], mode: 'managed' });
            expect(unknown.res.status).to.equal(400);
            expect(unknown.body.code).to.equal('invalid_profile');
            const badMode = await plan(alice.cookie, { profile_ids: ['image/qwen-image'], mode: 'bogus' });
            expect(badMode.res.status).to.equal(400);
            expect(badMode.body.code).to.equal('invalid_mode');
            const empty = await plan(alice.cookie, { profile_ids: [], mode: 'managed' });
            expect(empty.res.status).to.equal(400);
            const noMode = await plan(alice.cookie, { profile_ids: ['image/qwen-image'] });
            expect(noMode.res.status).to.equal(400);
        });

        it('plan responses never carry secrets or internal URLs', async () => {
            const { body } = await plan(alice.cookie, { profile_ids: ['image/qwen-image', 'video/ltx-2.3'], mode: 'shared', platform: 'linux' });
            const json = JSON.stringify(body);
            expect(json).to.not.contain(aliceToken);
            expect(json).to.not.contain('token_hash');
            expect(json).to.not.match(/wrk\./);
            expect(json).to.not.contain('huggingface.co');
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Security sweep + legacy API intact
    // ══════════════════════════════════════════════════════════════════

    describe('security sweep', () => {
        it('no setup response contains token/token_hash/secrets', async () => {
            const urls = [
                '/api/v1/private-worker/setup/profiles',
                '/api/v1/private-worker/setup/methods',
                '/api/v1/private-worker/setup/artifacts',
                '/api/v1/private-worker/setup/workflows',
                '/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image',
                `/api/v1/private-worker/setup/workers/${aliceWorker.worker_id}`,
            ];
            for (const url of urls) {
                const text = await (await fetch(`${base}${url}`, { headers: { Cookie: alice.cookie } })).text();
                expect(text, url).to.not.contain('token_hash');
                expect(text, url).to.not.contain(aliceToken);
                expect(text, url).to.not.match(/wrk\.[A-Za-z0-9_-]{8,}/);
            }
        });

        it('the new Setup Contract never references the deprecated /worker-source', async () => {
            const urls = [
                '/api/v1/private-worker/setup/profiles',
                '/api/v1/private-worker/setup/methods',
                '/api/v1/private-worker/setup/artifacts',
                '/api/v1/private-worker/setup/workflows',
                '/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image',
                '/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image&mode=existing',
            ];
            for (const url of urls) {
                const text = await (await fetch(`${base}${url}`, { headers: { Cookie: alice.cookie } })).text();
                expect(text, url).to.not.contain('worker-source');
            }
            const planRes = await fetch(`${base}/api/v1/private-worker/setup/plan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
                body: JSON.stringify({ profile_ids: ['image/qwen-image'], mode: 'managed', platform: 'linux' }),
            });
            expect(await planRes.text()).to.not.contain('worker-source');
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Phase 3.1 — artifact integrity cross-check (API ↔ real download)
    // ══════════════════════════════════════════════════════════════════

    describe('artifact integrity (Phase 3.1)', () => {
        const crypto = require('crypto');
        const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

        it('API checksums equal the sha256 of the actually downloadable artifacts', async () => {
            const { methods } = await (await fetch(`${base}/api/v1/private-worker/setup/methods`, { headers: { Cookie: alice.cookie } })).json();
            const linux = methods.find((m) => m.platform === 'linux');

            // download artifact → calculate sha256 → compare with API checksum
            const installerBuf = Buffer.from(await (await fetch(`${hubBase}/installer/bundle`)).arrayBuffer());
            expect(linux.installer.sha256).to.equal(sha256(installerBuf));
            const bundleBuf = Buffer.from(await (await fetch(`${hubBase}/worker-bundle`)).arrayBuffer());
            expect(linux.worker_bundle.sha256).to.equal(sha256(bundleBuf));

            // same via the artifacts endpoint
            const artifacts = await (await fetch(`${base}/api/v1/private-worker/setup/artifacts?platform=linux`, { headers: { Cookie: alice.cookie } })).json();
            expect(artifacts.installer.sha256).to.equal(sha256(installerBuf));
            expect(artifacts.worker_bundle.sha256).to.equal(sha256(bundleBuf));

            // and via the instructions installer metadata
            const instructions = await (await fetch(`${base}/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image`, { headers: { Cookie: alice.cookie } })).json();
            expect(instructions.installer.sha256).to.equal(sha256(installerBuf));
        });

        it('advertised versions match the downloaded artifact headers', async () => {
            const { methods } = await (await fetch(`${base}/api/v1/private-worker/setup/methods`, { headers: { Cookie: alice.cookie } })).json();
            const linux = methods.find((m) => m.platform === 'linux');
            const installerRes = await fetch(`${hubBase}/installer/bundle`);
            expect(linux.installer.version).to.equal(installerRes.headers.get('x-animastor-artifact-version'));
            const bundleRes = await fetch(`${hubBase}/worker-bundle`);
            expect(linux.worker_bundle.version).to.equal(bundleRes.headers.get('x-animastor-artifact-version'));
        });

        it('available=true only for artifacts that really exist; uninstaller stays planned without fake URL', async () => {
            const { methods } = await (await fetch(`${base}/api/v1/private-worker/setup/methods`, { headers: { Cookie: alice.cookie } })).json();
            const linux = methods.find((m) => m.platform === 'linux');
            // the hub under test really serves these ⇒ available must be true
            expect(linux.installer.available).to.equal(true);
            expect((await fetch(`${hubBase}/installer/bundle`)).status).to.equal(200);
            expect((await fetch(`${hubBase}/installer`)).status).to.equal(200); // bootstrap script
            expect(linux.worker_bundle.available).to.equal(true);
            expect((await fetch(`${hubBase}/worker-bundle`)).status).to.equal(200);
            expect((await fetch(`${hubBase}/worker-bundle/sha256`)).status).to.equal(200);
            // uninstaller does not exist ⇒ no fake download URL
            expect(linux.uninstaller.available).to.equal(false);
            expect(linux.uninstaller.status).to.equal('planned');
            expect(linux.uninstaller.download_url).to.equal(null);
            expect(linux.uninstaller.version).to.equal(null);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Phase 3.1 — workspace isolation for contract metadata + plan
    // ══════════════════════════════════════════════════════════════════

    describe('workspace isolation (Phase 3.1)', () => {
        it('contract metadata is workspace-independent and identical for both users', async () => {
            for (const ep of ['profiles', 'methods', 'artifacts?platform=linux', 'workflows']) {
                const a = await (await fetch(`${base}/api/v1/private-worker/setup/${ep}`, { headers: { Cookie: alice.cookie } })).text();
                const b = await (await fetch(`${base}/api/v1/private-worker/setup/${ep}`, { headers: { Cookie: bob.cookie } })).text();
                expect(a, ep).to.equal(b); // canonical metadata — no per-workspace divergence
                // no workspace/worker identifiers leak into global metadata
                expect(a, ep).to.not.contain(alice.workspaceId);
                expect(a, ep).to.not.contain(bob.workspaceId);
                expect(a, ep).to.not.contain(aliceWorker.worker_id);
            }
        });

        it('installation plan is a pure preview: same input → same result, no workspace data', async () => {
            const body = { profile_ids: ['image/qwen-image', 'video/ltx-2.3'], mode: 'shared', platform: 'linux' };
            const a = await (await fetch(`${base}/api/v1/private-worker/setup/plan`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice.cookie }, body: JSON.stringify(body),
            })).text();
            const b = await (await fetch(`${base}/api/v1/private-worker/setup/plan`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob.cookie }, body: JSON.stringify(body),
            })).text();
            expect(a).to.equal(b);
            expect(a).to.not.contain(alice.workspaceId);
            expect(a).to.not.contain(bob.workspaceId);
        });

        it('user A cannot inspect user B worker via the setup status endpoint', async () => {
            // bob creates a worker; alice gets an indistinct 404
            const cw = await fetch(`${base}/api/v1/workers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: bob.cookie },
                body: JSON.stringify({ name: 'bob-private', worker_type: 'image' }),
            });
            const { worker: bobWorker } = await cw.json();
            const cross = await fetch(`${base}/api/v1/private-worker/setup/workers/${bobWorker.worker_id}`, { headers: { Cookie: alice.cookie } });
            expect(cross.status).to.equal(404);
            const own = await fetch(`${base}/api/v1/private-worker/setup/workers/${bobWorker.worker_id}`, { headers: { Cookie: bob.cookie } });
            expect(own.status).to.equal(200);
            await fetch(`${base}/api/v1/workers/${bobWorker.worker_id}`, { method: 'DELETE', headers: { Cookie: bob.cookie } });
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Phase 3.1 — installation plan is preview-only (no side effects)
    // ══════════════════════════════════════════════════════════════════

    describe('installation plan preview-only (Phase 3.1)', () => {
        it('planning never registers workers, mutates state, or creates heartbeats', async () => {
            const before = await query('SELECT COUNT(*)::int AS n FROM workers');
            const workersBefore = before.rows[0].n;

            for (const mode of ['managed', 'existing', 'isolated']) {
                for (const id of ['image/qwen-image', 'video/ltx-2.3', 'audio/qwen-tts']) {
                    const res = await fetch(`${base}/api/v1/private-worker/setup/plan`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
                        body: JSON.stringify({ profile_ids: [id], mode, platform: 'linux' }),
                    });
                    expect(res.status, `${mode}/${id}`).to.equal(200);
                }
            }
            // 'shared' is defined over profile PAIRS (one ComfyUI for several profiles)
            const shared = await fetch(`${base}/api/v1/private-worker/setup/plan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
                body: JSON.stringify({ profile_ids: ['audio/qwen-tts', 'image/qwen-image'], mode: 'shared', platform: 'linux' }),
            });
            expect(shared.status).to.equal(200);

            const after = await query('SELECT COUNT(*)::int AS n FROM workers');
            expect(after.rows[0].n).to.equal(workersBefore); // no worker registration
            // no heartbeat materialized by planning — the endpoint is a pure
            // function of canonical manifests (never touches worker state)
            for (const type of ['image', 'video', 'audio']) {
                const hb = await redis.get(config.WORKER_HEARTBEAT_KEY(type, aliceWorker.worker_id));
                expect(hb, `heartbeat ${type}`).to.equal(null);
            }
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Phase 3.1 — degraded hub: installer down, bundle up (the failure
    // mode that made Linux look fully unavailable in the Web wizard)
    // ══════════════════════════════════════════════════════════════════

    describe('degraded hub — installer unavailable, bundle available (Phase 3.1)', () => {
        let degServer;
        let degBase;

        before(async () => {
            const express2 = require('express');
            const app2 = express2();
            app2.use(express2.json());
            app2.use(authContext);
            require('../src/routes/worker-setup-routes.cjs')(app2, redis, {
                hubUrlResolver: () => 'http://hub.degraded.test',
                probeTtlMs: 0, // probe on every request — no stale cache in tests
                fetchImpl: async (url) => {
                    if (String(url).endsWith('/worker-bundle/sha256')) {
                        return { ok: true, json: async () => ({ sha256: 'b'.repeat(64), version: '2.0.0', bytes: 1 }) };
                    }
                    return { ok: false, status: 404, json: async () => ({}) }; // installer endpoint down
                },
            });
            await new Promise((resolve) => {
                degServer = app2.listen(0, () => {
                    degBase = `http://127.0.0.1:${degServer.address().port}`;
                    resolve();
                });
            });
        });

        after(() => { if (degServer) degServer.close(); });

        it('methods: linux stays available; installer unavailable without fake URL; bundle real', async () => {
            const res = await fetch(`${degBase}/api/v1/private-worker/setup/methods`, { headers: { Cookie: alice.cookie } });
            expect(res.status).to.equal(200);
            const { methods } = await res.json();
            const linux = methods.find((m) => m.platform === 'linux');
            expect(linux.status).to.equal('available'); // NOT blocked by the missing installer
            expect(linux.installer).to.deep.include({ available: false, status: 'unavailable', download_url: null, sha256: null });
            expect(linux.worker_bundle.available).to.equal(true);
            expect(linux.worker_bundle.download_url).to.equal('/gpu/worker-bundle');
            expect(linux.worker_bundle.sha256).to.equal('b'.repeat(64));
            expect(linux.worker_bundle.version).to.equal('2.0.0');
        });

        it('instructions: existing mode → real bundle flow; managed → honest installer-unavailable', async () => {
            const existing = await (await fetch(`${degBase}/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image&platform=linux&mode=existing`, { headers: { Cookie: alice.cookie } })).json();
            expect(existing.steps.map((s) => s.id)).to.include('download-bundle');
            const dl = existing.steps.find((s) => s.id === 'download-bundle');
            expect(dl.code).to.contain('/gpu/worker-bundle');
            expect(dl.checksum.value).to.equal('b'.repeat(64));
            expect(JSON.stringify(existing)).to.not.contain('/gpu/installer');

            const managed = await (await fetch(`${degBase}/api/v1/private-worker/setup/instructions?profile_id=image/qwen-image&platform=linux&mode=managed`, { headers: { Cookie: alice.cookie } })).json();
            expect(managed.steps.map((s) => s.id)).to.deep.equal(['installer-unavailable']);
            expect(managed.steps[0].body).to.contain('Existing ComfyUI');
        });
    });

    describe('legacy worker API (unchanged)', () => {
        it('create/list/detail/rotate/revoke still work alongside the contract', async () => {
            const cw = await fetch(`${base}/api/v1/workers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: bob.cookie },
                body: JSON.stringify({ name: 'legacy-check', worker_type: 'audio' }),
            });
            expect(cw.status).to.equal(201);
            const { worker, token } = await cw.json();
            expect(token).to.match(/^wrk\./);

            const list = await fetch(`${base}/api/v1/workers`, { headers: { Cookie: bob.cookie } });
            expect(list.status).to.equal(200);
            expect((await list.json()).workers.map((w) => w.worker_id)).to.contain(worker.worker_id);

            const detail = await fetch(`${base}/api/v1/workers/${worker.worker_id}`, { headers: { Cookie: bob.cookie } });
            expect(detail.status).to.equal(200);

            const rotate = await fetch(`${base}/api/v1/workers/${worker.worker_id}/rotate`, { method: 'POST', headers: { Cookie: bob.cookie } });
            expect(rotate.status).to.equal(200);
            const { token: newToken } = await rotate.json();
            expect(newToken).to.match(/^wrk\./);
            expect(newToken).to.not.equal(token);

            const del = await fetch(`${base}/api/v1/workers/${worker.worker_id}`, { method: 'DELETE', headers: { Cookie: bob.cookie } });
            expect(del.status).to.equal(200);
            expect((await del.json()).revoked).to.equal(true);
        });
    });
});
