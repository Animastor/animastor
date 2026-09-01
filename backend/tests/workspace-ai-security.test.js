// ======================================================
// Workspace AI Security Regression Tests (Second Phase)
// ======================================================
// Regression coverage for the security findings of the independent
// verification audit (`docs/architecture/EXPERIMENTAL_BETA_IMPLEMENTATION_VERIFICATION.md`):
//
//   2.1 CRITICAL  guard/handler `book_id` mismatch → cross-tenant AI provider
//                 use, book data disclosure and book write;
//   2.2 HIGH      SSRF via user-controlled AI endpoint;
//   2.3 MEDIUM    "Test Connection" of a saved provider hits the wrong base URL;
//   2.4 MEDIUM    chat has no timeout.
//
// Security regression matrix:
//   Workspace A → own book → own provider           PASS (provider A used)
//   Workspace A → victim book                       403
//   Workspace A → victim provider                   denied (400 mismatch / no call)
//   query/body book mismatch                         400
//   private endpoint (169.254.169.254 / 127.0.0.1 / RFC1918 / ::1)  DENY
//   public OpenAI-compatible endpoint               ALLOW
//   saved custom endpoint test                      uses saved endpoint+key+model
//   chat hung endpoint                              times out (504)
//
// Real-PG HTTP suite: production authContext + auth routes + the exact
// guard wiring from backend.cjs. DNS is stubbed (the SSRF guard resolves the
// hostname at request time) and the LLM fetch is mocked — no real network
// beyond the localhost test server.

const { expect } = require('chai');
const express = require('express');
const dns = require('dns');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const urlSafety = require('../src/services/url-safety');
const workspaceAi = require('../src/services/workspace-ai-provider');
const config = require('../src/config/runtime-config');
const { authContext, requireBookAccess } = require('../src/middleware/auth-context');
const { aiBookGuard } = require('../src/middleware/ai-book-guard');

const stamp = `wsaisec${Date.now()}`;

// ── DNS stub (SSRF guard resolves hostnames at request time) ─────────────

const originalDnsLookup = dns.promises.lookup;
let dnsAnswer = ['93.184.216.34']; // public by default

function setDns(addresses) {
    dnsAnswer = addresses.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));
}

// ── fetch mock (LLM calls only; everything else passes through) ──────────

const nativeFetch = global.fetch;
let fetchCalls = [];

function okJsonResponse(payload, overrides = {}) {
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
        headers: { get: () => null },
        ...overrides,
    };
}

function installFetchMock(handler) {
    fetchCalls = [];
    global.fetch = async (url, opts) => {
        if (!String(url).includes('/chat/completions')) return nativeFetch(url, opts);
        const call = { url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null };
        fetchCalls.push(call);
        return handler(call);
    };
}

function restoreFetch() {
    if (global.fetch !== nativeFetch) global.fetch = nativeFetch;
}

function cookieOf(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const sid = set.find((c) => c.startsWith('animastor_sid='));
    return sid ? sid.split(';')[0] : null;
}

// ── HTTP app (mirrors backend.cjs wiring) ────────────────────────────────

const CREATE_BOOK_SUBPATHS = new Set(['import', 'import-txt', 'import-text', 'load-vbook', 'blank']);

function buildApp() {
    const chatEngine = require('../src/services/chat-engine.cjs')(config);
    const registerAuthRoutes = require('../src/routes/auth-routes.cjs');
    const registerAiRoutes = require('../src/routes/ai-routes.cjs');
    const registerSettingsRoutes = require('../src/routes/settings-ai-routes.cjs');

    const app = express();
    app.use(express.json());
    app.use(authContext);
    registerAuthRoutes(app, null, { utils: { log: () => {} } });

    // Book ownership guard — same shape as backend.cjs.
    app.use('/api/v1/book/:bookId', (req, res, next) => {
        if (CREATE_BOOK_SUBPATHS.has(req.params.bookId)) return next();
        return requireBookAccess('bookId')(req, res, next);
    });
    app.get('/api/v1/book/:bookId/meta', requireBookAccess('bookId'), (req, res) => {
        res.json({ ok: true, bookId: req.params.bookId });
    });

    // AI book guard — same shape as backend.cjs (sets req.scopedBookId).
    app.use('/api/v1/ai/sessions/:id', aiBookGuard);
    app.use('/api/v1/ai', (req, res, next) => {
        if (/^\/sessions\/[^/]+/.test(req.path)) return next();
        return aiBookGuard(req, res, next);
    });

    registerSettingsRoutes(app);
    registerAiRoutes(app, null, {
        config,
        state: {}, audio: {}, image: {}, video: {},
        book: { loadBook: () => null },
        orchestrator: {},
        storage: { postgres: { query } },
        layerConfig: {}, genScope: {}, activeScenes: {}, placeholderAudio: {},
        utils: { log: () => {} },
        saveChunk: async () => {}, getChunk: async () => null, getAllChunks: async () => [],
        getBookWindowStatus: () => null,
        detectAvailableMode: async () => 'chat',
        recoverChunksFromDisk: async () => {}, recoverAllBooksFromDisk: async () => {},
        cleanupService: {}, bookDiff: {}, taskHandler: {},
        chatEngine,
        iuRepo: {}, genSessionRepo: null,
        lazyBook: { loadDraftBook: () => null },
        txtImporter: {}, bookSourceRepo: {},
    });

    return app;
}

async function register(app, username) {
    const res = await fetch(`http://127.0.0.1:${app.__port}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct-horse-42', email: `${username}@test.local` }),
    });
    const body = await res.json();
    expect(res.status).to.equal(201);
    return { cookie: cookieOf(res), workspaceId: body.workspace.id };
}

async function cleanup() {
    await query(`DELETE FROM ai_chat_sessions WHERE book_id IN (
        SELECT book_id FROM books WHERE workspace_id IN (
            SELECT id FROM workspaces WHERE name LIKE '%${stamp}%' OR owner_user_id IN (
                SELECT user_id FROM users WHERE username LIKE 'wsaisec%')))`);
    await query(`DELETE FROM books WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%' OR owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'wsaisec%'))`);
    await query(`DELETE FROM workspace_members WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%' OR owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE 'wsaisec%'))`);
    await query(`DELETE FROM sessions WHERE user_id IN (
        SELECT user_id FROM users WHERE username LIKE 'wsaisec%')`);
    await query(`DELETE FROM workspaces WHERE name LIKE '%${stamp}%'`);
    await query(`DELETE FROM workspaces WHERE owner_user_id IN (
        SELECT user_id FROM users WHERE username LIKE 'wsaisec%')`);
    await query(`DELETE FROM users WHERE username LIKE 'wsaisec%'`);
}

describe('Workspace AI security regression', () => {
    let server;
    let base;
    let attacker;  // workspace A
    let victim;    // workspace B
    let bookA;
    let bookB;

    before(async function() {
        this.timeout(30000);
        await runMigrations();
        await cleanup();
        // The SSRF guard resolves the endpoint hostname at request time; install
        // the stub HERE (not at module load) so another suite's after-hook that
        // restores dns.promises.lookup cannot clobber it mid-run.
        dns.promises.lookup = async (hostname, options) => {
            if (options && options.all) return dnsAnswer;
            return dnsAnswer[0];
        };

        const app = buildApp();
        await new Promise((resolve) => {
            server = app.listen(0, () => {
                app.__port = server.address().port;
                base = `http://127.0.0.1:${app.__port}`;
                resolve();
            });
        });

        attacker = await register(app, `wsaisec_att_${Date.now()}`);
        victim = await register(app, `wsaisec_vic_${Date.now()}`);
        bookA = `wsaisec-${stamp}-bookA`;
        bookB = `wsaisec-${stamp}-bookB`;
        await query(`INSERT INTO books (book_id, title, workspace_id) VALUES ($1, $2, $3)`, [bookA, 'A', attacker.workspaceId]);
        await query(`INSERT INTO books (book_id, title, workspace_id) VALUES ($1, $2, $3)`, [bookB, 'B', victim.workspaceId]);

        // Both workspaces get their OWN provider — the isolation test proves
        // the attacker's requests can never reach the victim's provider.
        setDns(['93.184.216.34']);
        let res = await fetch(`${base}/api/v1/settings/ai/provider`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
            body: JSON.stringify({ endpoint: 'https://attacker.example/v1', api_key: 'sk-attacker', model: 'att-model' }),
        });
        expect(res.status).to.equal(200);
        res = await fetch(`${base}/api/v1/settings/ai/provider`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: victim.cookie },
            body: JSON.stringify({ endpoint: 'https://victim.example/v1', api_key: 'sk-victim', model: 'vic-model' }),
        });
        expect(res.status).to.equal(200);
    });

    after(async function() {
        this.timeout(30000);
        dns.promises.lookup = originalDnsLookup;
        restoreFetch();
        if (server) server.close(); // fire-and-forget: undici keep-alive may linger
        await cleanup();
    });

    afterEach(restoreFetch);

    // ══════════════════════════════════════════════════════════════════
    // 2.1 — book_id authorization mismatch (CRITICAL)
    // ══════════════════════════════════════════════════════════════════

    describe('book_id authorization mismatch', () => {
        it('Workspace A → own book → own provider: uses A provider', async () => {
            setDns(['93.184.216.34']);
            installFetchMock((call) => okJsonResponse({
                choices: [{ message: { content: 'reply-for-A' } }],
            }));

            const res = await fetch(`${base}/api/v1/ai/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ book_id: bookA, message: 'hi' }),
            });
            expect(res.status).to.equal(200);
            expect((await res.json()).reply).to.equal('reply-for-A');

            expect(fetchCalls).to.have.length(1);
            expect(fetchCalls[0].url).to.equal('https://attacker.example/v1/chat/completions');
            expect(fetchCalls[0].opts.headers.Authorization).to.equal('Bearer sk-attacker');
        });

        it('Workspace A → victim book in body: 403 (fail closed)', async () => {
            installFetchMock((call) => okJsonResponse({ choices: [{ message: { content: 'x' } }] }));
            const res = await fetch(`${base}/api/v1/ai/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ book_id: bookB, message: 'hi' }),
            });
            expect(res.status).to.equal(403);
            expect(fetchCalls).to.have.length(0); // victim provider never contacted
        });

        it('Workspace A → victim book via query: 403', async () => {
            installFetchMock((call) => okJsonResponse({ choices: [{ message: { content: 'x' } }] }));
            const res = await fetch(`${base}/api/v1/ai/chat?book_id=${encodeURIComponent(bookB)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ message: 'hi' }),
            });
            expect(res.status).to.equal(403);
            expect(fetchCalls).to.have.length(0);
        });

        it('query/body book mismatch (authorized A, body B): 400 — never operate on B', async () => {
            installFetchMock((call) => okJsonResponse({ choices: [{ message: { content: 'x' } }] }));
            const res = await fetch(`${base}/api/v1/ai/chat?book_id=${encodeURIComponent(bookA)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ book_id: bookB, message: 'hi' }),
            });
            expect(res.status).to.equal(400);
            const body = await res.json();
            expect(body.code).to.equal('book_id_mismatch');
            // The handler must not have run against B — no provider fetch at all.
            expect(fetchCalls).to.have.length(0);
        });

        it('session delete is scoped by the book guard: victim session → 400/403, never deleted', async () => {
            // DELETE /ai/sessions/:id resolves the book from the session row.
            // A session of another workspace must not be deletable.
            const victimSessionId = `wsaisec-${stamp}-victim-del`;
            await query(
                `INSERT INTO ai_chat_sessions (id, book_id, mode, topic_id, messages, created_at, updated_at, context, locked)
                 VALUES ($1, $2, 'chat', 'book', '[]', $3, $3, NULL, false)`,
                [victimSessionId, bookB, Date.now()]
            );
            try {
                const res = await fetch(`${base}/api/v1/ai/sessions/${encodeURIComponent(victimSessionId)}`, {
                    method: 'DELETE',
                    headers: { Cookie: attacker.cookie },
                });
                expect([403, 400]).to.include(res.status);
                const still = await query('SELECT id FROM ai_chat_sessions WHERE id = $1', [victimSessionId]);
                expect(still.rows).to.have.length(1);
            } finally {
                await query(`DELETE FROM ai_chat_sessions WHERE id = $1`, [victimSessionId]);
            }
        });

        it('DELETE own session removes the row (200)', async () => {
            const ownSessionId = `wsaisec-${stamp}-own-del`;
            await query(
                `INSERT INTO ai_chat_sessions (id, book_id, mode, topic_id, messages, created_at, updated_at, context, locked)
                 VALUES ($1, $2, 'chat', 'book', '[]', $3, $3, NULL, false)`,
                [ownSessionId, bookA, Date.now()]
            );
            const res = await fetch(`${base}/api/v1/ai/sessions/${encodeURIComponent(ownSessionId)}`, {
                method: 'DELETE',
                headers: { Cookie: attacker.cookie },
            });
            expect(res.status).to.equal(200);
            const gone = await query('SELECT id FROM ai_chat_sessions WHERE id = $1', [ownSessionId]);
            expect(gone.rows).to.have.length(0);
        });

        it('Workspace A cannot read victim book (book guard)', async () => {
            const res = await fetch(`${base}/api/v1/book/${bookB}/meta`, { headers: { Cookie: attacker.cookie } });
            expect(res.status).to.equal(403);
        });

        it('session/book mismatch: scoping own book A while writing victim session B → 400', async () => {
            const sessionId = `wsaisec-${stamp}-vic-session`;
            await query(
                `INSERT INTO ai_chat_sessions (id, book_id, mode, topic_id, messages, created_at, updated_at, context, locked)
                 VALUES ($1, $2, 'chat', 'book', '[]', $3, $3, NULL, false)`,
                [sessionId, bookB, Date.now()]
            );
            installFetchMock((call) => okJsonResponse({ choices: [{ message: { content: 'x' } }] }));
            const res = await fetch(`${base}/api/v1/ai/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ session_id: sessionId, book_id: bookA, message: 'hi' }),
            });
            expect(res.status).to.equal(400);
            expect((await res.json()).code).to.equal('session_book_mismatch');
            expect(fetchCalls).to.have.length(0);
            await query(`DELETE FROM ai_chat_sessions WHERE id = $1`, [sessionId]);
        });

        it('Workspace A own book with own provider still passes on /ai/chat', async () => {
            setDns(['93.184.216.34']);
            installFetchMock((call) => okJsonResponse({ choices: [{ message: { content: 'chat-ok' } }] }));
            const res = await fetch(`${base}/api/v1/ai/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ book_id: bookA, message: 'hi' }),
            });
            expect(res.status).to.equal(200);
            expect((await res.json()).reply).to.equal('chat-ok');
            expect(fetchCalls).to.have.length(1);
            expect(fetchCalls[0].url).to.equal('https://attacker.example/v1/chat/completions');
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // 2.2 — SSRF via user-controlled endpoint (HIGH)
    // ══════════════════════════════════════════════════════════════════

    describe('SSRF guard (url-safety)', () => {
        const BLOCKED = [
            'http://127.0.0.1',
            'http://169.254.169.254',   // cloud metadata
            'http://10.0.0.1',          // RFC1918
            'http://172.16.0.1',        // RFC1918
            'http://172.31.255.255',    // RFC1918
            'http://192.168.1.1',       // RFC1918
            'http://0.0.0.0',
            'http://100.64.0.1',        // CGNAT
            'http://2130706433',        // decimal 127.0.0.1
            'http://0177.0.0.1',        // octal
            'http://0x7f000001',        // hex
            'http://[::1]',             // IPv6 loopback
            'http://[::ffff:127.0.0.1]',// IPv4-mapped loopback
            'http://[fc00::1]',         // IPv6 unique local
            'http://[fe80::1]',         // IPv6 link-local
            'ftp://example.com',
            'not-a-url',
        ];

        BLOCKED.forEach((url) => {
            it(`blocks ${url}`, async () => {
                setDns(['127.0.0.1']); // DNS-rebinding shape for hostnames
                const verdict = await urlSafety.assertPublicEndpoint(url);
                expect(verdict.ok, verdict.reason).to.equal(false);
            });
        });

        it('DNS resolving to a private address is blocked (DNS rebinding shape)', async () => {
            setDns(['10.0.0.5']);
            const verdict = await urlSafety.assertPublicEndpoint('http://internal.evil.example');
            expect(verdict.ok, verdict.reason).to.equal(false);
            expect(verdict.reason).to.match(/private/);
        });

        it('multi-record DNS containing a private address is blocked', async () => {
            setDns(['93.184.216.34', '192.168.1.9']);
            const verdict = await urlSafety.assertPublicEndpoint('http://mixed.evil.example');
            expect(verdict.ok, verdict.reason).to.equal(false);
        });

        it('allows a normal public HTTPS endpoint', async () => {
            setDns(['93.184.216.34']);
            const verdict = await urlSafety.assertPublicEndpoint('https://api.openai.com/v1');
            expect(verdict.ok, verdict.reason).to.equal(true);
            const verdict2 = await urlSafety.assertPublicEndpoint('https://api.anthropic.com/v1');
            expect(verdict2.ok, verdict2.reason).to.equal(true);
        });

        it('safeFetch refuses a public endpoint redirecting to a private address', async () => {
            setDns(['93.184.216.34']);
            installFetchMock((call) => ({
                ok: false,
                status: 302,
                headers: { get: (h) => (String(h).toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data' : null) },
                text: async () => '', json: async () => ({}),
                body: null,
            }));
            let threw = null;
            try {
                await urlSafety.safeFetch('https://public.example/v1/chat/completions', { method: 'POST' });
            } catch (err) {
                threw = err;
            }
            expect(threw).to.exist;
            expect(threw.code).to.equal('ENDPOINT_NOT_PUBLIC');
        });

        it('settings PUT rejects a private endpoint', async () => {
            const res = await fetch(`${base}/api/v1/settings/ai/provider`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ endpoint: 'http://169.254.169.254', api_key: 'sk-x' }),
            });
            expect(res.status).to.equal(400);
            expect((await res.json()).error).to.match(/not allowed/);
        });

        it('settings POST test refuses a private endpoint', async () => {
            const res = await fetch(`${base}/api/v1/settings/ai/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ endpoint: 'http://127.0.0.1' }),
            });
            expect(res.status).to.equal(200);
            const body = await res.json();
            expect(body.ok).to.equal(false);
            expect(body.error).to.match(/Endpoint not allowed|connection failed/i);
        });

        it('settings POST test allows a normal public endpoint', async () => {
            setDns(['93.184.216.34']);
            installFetchMock((call) => okJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
            const res = await fetch(`${base}/api/v1/settings/ai/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ endpoint: 'https://api.openai.com/v1', api_key: 'sk-new' }),
            });
            expect(res.status).to.equal(200);
            const body = await res.json();
            expect(body.ok).to.equal(true);
            expect(fetchCalls).to.have.length(1);
            expect(fetchCalls[0].url).to.equal('https://api.openai.com/v1/chat/completions');
        });

        it('/ai/chat with a private saved endpoint is refused (502, no SSRF fetch)', async () => {
            // Force a private workspace provider, as if a DNS-rebinding domain
            // flipped to an internal address after being saved. Restored in
            // `finally` so later tests always see the real attacker provider.
            installFetchMock((call) => okJsonResponse({ choices: [{ message: { content: 'x' } }] }));
            await workspaceAi.upsertProvider(attacker.workspaceId, {
                endpoint: 'http://169.254.169.254/v1', apiKey: 'sk-private', model: 'm',
            });
            try {
                const res = await fetch(`${base}/api/v1/ai/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                    body: JSON.stringify({ book_id: bookA, message: 'hi' }),
                });
                expect(res.status).to.equal(502);
                expect((await res.json()).error).to.match(/not allowed/i);
                // Nothing reached the private address.
                expect(fetchCalls).to.have.length(0);
            } finally {
                workspaceAi.invalidateCache(attacker.workspaceId);
                setDns(['93.184.216.34']);
                await workspaceAi.upsertProvider(attacker.workspaceId, {
                    endpoint: 'https://attacker.example/v1', apiKey: 'sk-attacker', model: 'att-model',
                });
                workspaceAi.invalidateCache(attacker.workspaceId);
            }
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // 2.3 — Test Connection uses the saved provider snapshot (MEDIUM)
    // ══════════════════════════════════════════════════════════════════

    describe('settings /test uses the saved provider snapshot', () => {
        it('empty body re-tests the SAVED endpoint + key + model', async () => {
            setDns(['93.184.216.34']);
            // Attacker provider is already saved (https://attacker.example/v1,
            // sk-attacker, att-model) from suite setup.
            installFetchMock((call) => okJsonResponse({ choices: [{ message: { content: 'ok' } }] }));

            const res = await fetch(`${base}/api/v1/settings/ai/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({}),
            });
            expect(res.status).to.equal(200);
            const body = await res.json();
            expect(body.ok).to.equal(true);

            // Regression: the endpoint must be the SAVED workspace endpoint,
            // NOT the global AI_API_BASE_URL default.
            expect(fetchCalls).to.have.length(1);
            expect(fetchCalls[0].url).to.equal('https://attacker.example/v1/chat/completions');
            expect(fetchCalls[0].opts.headers.Authorization).to.equal('Bearer sk-attacker');
            expect(fetchCalls[0].body.model).to.equal('att-model');
        });

        it('explicit endpoint with no key uses the saved key against the new endpoint', async () => {
            setDns(['93.184.216.34']);
            installFetchMock((call) => okJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
            const res = await fetch(`${base}/api/v1/settings/ai/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ endpoint: 'https://override.example/v1' }),
            });
            expect(res.status).to.equal(200);
            expect((await res.json()).ok).to.equal(true);
            expect(fetchCalls).to.have.length(1);
            expect(fetchCalls[0].url).to.equal('https://override.example/v1/chat/completions');
            expect(fetchCalls[0].opts.headers.Authorization).to.equal('Bearer sk-attacker');
        });

        it('explicit endpoint + explicit key override the saved snapshot', async () => {
            setDns(['93.184.216.34']);
            installFetchMock((call) => okJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
            const res = await fetch(`${base}/api/v1/settings/ai/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ endpoint: 'https://override2.example/v1', api_key: 'sk-manual', model: 'manual-model' }),
            });
            expect(res.status).to.equal(200);
            expect((await res.json()).ok).to.equal(true);
            expect(fetchCalls).to.have.length(1);
            expect(fetchCalls[0].url).to.equal('https://override2.example/v1/chat/completions');
            expect(fetchCalls[0].opts.headers.Authorization).to.equal('Bearer sk-manual');
            expect(fetchCalls[0].body.model).to.equal('manual-model');
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // 2.4 — chat timeout (MEDIUM)
    // ══════════════════════════════════════════════════════════════════

    describe('chat timeout', () => {
        it('attaches a timeout signal and answers 504 when the provider hangs/aborts', async () => {
            setDns(['93.184.216.34']);
            installFetchMock((call) => {
                // The timeout contract: the request must carry an AbortSignal.
                expect(call.opts.signal).to.exist;
                expect(call.opts.signal.aborted).to.equal(false);
                // Simulate the provider hanging past the deadline: the
                // AbortController fires and fetch rejects with AbortError.
                const err = new DOMException('The operation was aborted', 'AbortError');
                throw err;
            });

            const res = await fetch(`${base}/api/v1/ai/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: attacker.cookie },
                body: JSON.stringify({ book_id: bookA, message: 'hi' }),
            });
            expect(res.status).to.equal(504);
            const body = await res.json();
            expect(body.code).to.equal('ai_timeout');
        });
    });
});