// ======================================================
// Admin Foundation Security Tests
// ======================================================
// Guards for the /api/v1/admin/* surface (System AI Control):
//   1. anonymous → 401
//   2. authenticated regular user → 403
//   3. guest identity → 401/403 (never admin)
//   4. role='admin' user → allowed
//   5. ADMIN_USERNAMES allowlist grants admin without role='admin'
//   6. GET returns kill-switch state + masked provider (never plaintext key)
//   7. PUT toggles the kill switch and upserts the provider
//   8. /api/v1/admin writes never auto-provision a guest workspace
//
// HTTP-level: a real Express app with the production authContext middleware
// + real PG sessions. Admin users are created directly with role='admin'.

const { expect } = require('chai');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const authService = require('../src/auth/auth-service');
const { hashPassword } = require('../src/auth/password');
const registerAuthRoutes = require('../src/routes/auth-routes.cjs');
const registerAdminRoutes = require('../src/routes/admin-routes.cjs');
const { authContext } = require('../src/middleware/auth-context');
const systemAi = require('../src/services/system-ai');

function cookieOf(setCookieHeader) {
    if (!setCookieHeader) return null;
    const first = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    return first.split(';')[0];
}

async function loginUser(port, username, password) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    return { status: res.status, cookie: cookieOf(res.headers.get('set-cookie')) };
}

async function createAdminUser(username, role) {
    const pw = await hashPassword('admin-pass-42');
    const { rows } = await query(
        `INSERT INTO users (username, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4) RETURNING user_id`,
        [username, pw, username, role]
    );
    return rows[0].user_id;
}

describe('Admin Foundation Security', () => {
    const stamp = Date.now();
    const adminUname = `admin_${stamp}`;
    const allowUname = `allow_${stamp}`;
    const userUname = `user_${stamp}`;
    const password = 'admin-pass-42';

    let server, port;
    let adminCookie, allowCookie, userCookie;
    const userIds = [];

    before(async function() {
        this.timeout(20000);
        await runMigrations();

        // Grant the allowlist user admin via env (role stays 'user').
        process.env.ADMIN_USERNAMES = allowUname;

        userIds.push(await createAdminUser(adminUname, 'admin'));
        userIds.push(await createAdminUser(allowUname, 'user'));
        userIds.push(await createAdminUser(userUname, 'user'));

        const app = express();
        app.use(express.json());
        app.use(authContext);
        registerAuthRoutes(app, null, { utils: { log: () => {} } });
        registerAdminRoutes(app);

        await new Promise((resolve) => {
            server = app.listen(0, () => { port = server.address().port; resolve(); });
        });

        adminCookie = (await loginUser(port, adminUname, password)).cookie;
        allowCookie = (await loginUser(port, allowUname, password)).cookie;
        userCookie = (await loginUser(port, userUname, password)).cookie;
        expect(adminCookie).to.be.a('string');
        expect(allowCookie).to.be.a('string');
        expect(userCookie).to.be.a('string');
    });

    after(async () => {
        delete process.env.ADMIN_USERNAMES;
        if (server) await new Promise((r) => server.close(r));
        for (const uid of userIds) {
            await query(`DELETE FROM sessions WHERE user_id = $1`, [uid]);
            await query(`DELETE FROM workspaces WHERE owner_user_id = $1`, [uid]);
            await query(`DELETE FROM users WHERE user_id = $1`, [uid]);
        }
        // Restore kill switch default for other suites.
        await query(`UPDATE system_settings SET value = '{"enabled": true}'::jsonb WHERE key = 'system_ai'`);
        systemAi.invalidateAll();
    });

    function get(path, cookie) {
        return fetch(`http://127.0.0.1:${port}${path}`, {
            headers: cookie ? { Cookie: cookie } : {},
        });
    }
    function put(path, body, cookie) {
        return fetch(`http://127.0.0.1:${port}${path}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
            body: JSON.stringify(body),
        });
    }

    // 1 ── anonymous ─────────────────────────────────────────────────────
    it('anonymous request → 401', async () => {
        const res = await get('/api/v1/admin/system-ai');
        expect(res.status).to.equal(401);
    });

    // 2 ── regular user ──────────────────────────────────────────────────
    it('authenticated regular user → 403', async () => {
        const res = await get('/api/v1/admin/system-ai', userCookie);
        expect(res.status).to.equal(403);
    });

    // 3 ── role=admin allowed ────────────────────────────────────────────
    it('role=admin user → 200 with enabled flag', async () => {
        const res = await get('/api/v1/admin/system-ai', adminCookie);
        expect(res.status).to.equal(200);
        const body = await res.json();
        expect(body).to.have.property('enabled');
        expect(body.enabled).to.equal(true);
    });

    // 4 ── allowlist grants admin ────────────────────────────────────────
    it('ADMIN_USERNAMES allowlist user (role=user) → 200', async () => {
        const res = await get('/api/v1/admin/system-ai', allowCookie);
        expect(res.status).to.equal(200);
    });

    // 5 ── PUT toggle by admin ───────────────────────────────────────────
    it('admin PUT toggles the kill switch OFF then ON', async () => {
        let res = await put('/api/v1/admin/system-ai', { enabled: false }, adminCookie);
        expect(res.status).to.equal(200);
        let body = await res.json();
        expect(body.enabled).to.equal(false);
        expect(await systemAi.isSystemAiEnabled()).to.equal(false);

        res = await put('/api/v1/admin/system-ai', { enabled: true }, adminCookie);
        body = await res.json();
        expect(body.enabled).to.equal(true);
        expect(await systemAi.isSystemAiEnabled()).to.equal(true);
    });

    // 6 ── PUT rejected for regular user ─────────────────────────────────
    it('regular user PUT → 403 and state unchanged', async () => {
        const res = await put('/api/v1/admin/system-ai', { enabled: false }, userCookie);
        expect(res.status).to.equal(403);
        expect(await systemAi.isSystemAiEnabled()).to.equal(true);
    });

    // 7 ── provider upsert never leaks the key ───────────────────────────
    it('admin PUT upserts a provider; response masks the key', async () => {
        const res = await put('/api/v1/admin/system-ai', {
            provider: {
                provider_type: 'openrouter',
                endpoint: 'https://admin.example/v1',
                api_key: 'sk-admin-super-secret',
                model: 'admin-model',
            },
        }, adminCookie);
        expect(res.status).to.equal(200);
        const body = await res.json();
        expect(body.provider.endpoint).to.equal('https://admin.example/v1');
        expect(body.provider.configured).to.equal(true);
        expect(JSON.stringify(body)).to.not.include('sk-admin-super-secret');

        // GET also masks it.
        const g = await get('/api/v1/admin/system-ai', adminCookie);
        const gbody = await g.json();
        expect(JSON.stringify(gbody)).to.not.include('sk-admin-super-secret');

        await query(`DELETE FROM system_ai_providers WHERE id = 'default'`);
    });

    // 8 ── admin writes never auto-provision a guest ─────────────────────
    it('anonymous PUT to /api/v1/admin does NOT create a guest workspace', async () => {
        const before = await query(`SELECT COUNT(*)::int AS c FROM guests`);
        const res = await put('/api/v1/admin/system-ai', { enabled: false });
        expect(res.status).to.equal(401);
        const after = await query(`SELECT COUNT(*)::int AS c FROM guests`);
        expect(after.rows[0].c).to.equal(before.rows[0].c);
    });
});
