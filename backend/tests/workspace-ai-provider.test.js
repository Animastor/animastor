// ======================================================
// Workspace AI Provider Tests (Experimental Beta — Milestone 1)
// ======================================================
// Real-PG suite:
//   1.  table exists with workspace_id PK + CASCADE FK (schema contract);
//   2.  secret storage: AES-256-GCM roundtrip, no plaintext in PG row,
//       meta responses never contain the key;
//   3.  upsert one-row-per-workspace invariant; delete;
//   4.  resolveAIForWorkspace: workspace row wins, global fallback second,
//       disabled/deleted rows degrade to global;
//   5.  resolver TTL cache + write invalidation;
//   6.  ai-caller AsyncLocalStorage: provider flows into ai-service.callAI
//       (endpoint/key/model override), global behaviour intact outside;
//   7.  ai-service.checkAIHealth: per-provider cache isolation;
//   8.  guest workspace purge cascades the provider row away;
//   9.  /api/v1/ai/chat + /ai/prompt use the workspace provider endpoint;
//   10. /ai/prompt parsed.reply regression (workspace/locked absences).
//
// HTTP fetch is stubbed with a recording mock — the suite never touches a
// real LLM API.

const { expect } = require('chai');
const express = require('express');
const dns = require('dns');

// Global fallback key for the suite so the backward-compat path
// (no workspace provider → global env) is exercised, not skipped.
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'sk-global-fallback-test';

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const workspaceAi = require('../src/services/workspace-ai-provider');
const aiService = require('../src/services/ai-service');
const aiCaller = require('../src/services/agent/ai-caller');
const config = require('../src/config/runtime-config');

// In the full suite runtime-config may already be cached from an earlier
// module evaluated BEFORE this file set the env var — sync the snapshot so
// the shared config object (read by ai-service at call time) has the key.
if (!config.OPENROUTER_API_KEY) config.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const stamp = `wspai${Date.now()}`;
let bookWorkspaceId = null;

async function createWorkspaceRow(name, type) {
    const { rows } = await query(
        `INSERT INTO workspaces (name, type) VALUES ($1, $2) RETURNING id`,
        [`${name}-${stamp}`, type]
    );
    return rows[0].id;
}

async function cleanup() {
    await query(`DELETE FROM workspace_ai_providers WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')`);
    await query(`DELETE FROM books WHERE book_id LIKE 'wspai-${stamp}%'`);
    await query(`DELETE FROM workspaces WHERE name LIKE '%${stamp}%'`);
}

// ── fetch mock ──────────────────────────────────────────────────────────

// Node 22 native fetch (saved once — the mock re-dispatches non-LLM URLs
// there, so local HTTP tests can still talk to the express server).
const nativeFetch = global.fetch;

let fetchCalls = [];
let fetchImpl = null;

function installFetchMock(handler) {
    fetchCalls = [];
    fetchImpl = async (url, opts) => {
        // LLM calls only (`/chat/completions`); everything else (test server
        // localhost, health) passes through to the real fetch.
        if (!String(url).includes('/chat/completions')) return nativeFetch(url, opts);
        const call = { url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null };
        fetchCalls.push(call);
        return handler(call);
    };
    global.fetch = fetchImpl;
}

function okJsonResponse(payload, overrides = {}) {
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
        ...overrides,
    };
}

describe('Workspace AI Provider', () => {
    const originalDnsLookup = dns.promises.lookup;

    before(async () => {
        await runMigrations();
        bookWorkspaceId = await createWorkspaceRow('wspai-book', 'personal');
        // The SSRF guard (url-safety) resolves the endpoint hostname before
        // every fetch. This suite uses reserved *.example hostnames (RFC 2606,
        // intentionally unresolvable), so DNS is stubbed to a public address —
        // deterministic, no real network.
        dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    });

    afterEach(async () => {
        // restore the native fetch for local HTTP tests (delete breaks it)
        if (fetchImpl) { global.fetch = nativeFetch; fetchImpl = null; }
        workspaceAi.invalidateCache(bookWorkspaceId);
    });

    after(async () => {
        dns.promises.lookup = originalDnsLookup;
        await cleanup();
    });

    // 1 ── schema contract ───────────────────────────────────────────────
    it('workspace_ai_providers table exists with workspace_id PK and cascade FK', async () => {
        const tbl = await query(
            `SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_name = 'workspace_ai_providers'`
        );
        expect(tbl.rows[0].cnt).to.equal(1);

        const pk = await query(
            `SELECT kcu.column_name FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
             WHERE tc.table_name = 'workspace_ai_providers' AND tc.constraint_type = 'PRIMARY KEY'`
        );
        expect(pk.rows.map(r => r.column_name)).to.deep.equal(['workspace_id']);

        const fk = await query(
            `SELECT rc.delete_rule FROM information_schema.referential_constraints rc
             WHERE rc.constraint_name = (SELECT conname FROM pg_constraint
                 WHERE conrelid = 'workspace_ai_providers'::regclass AND contype = 'f')`
        );
        expect(fk.rows[0].delete_rule).to.equal('CASCADE');
    });

    // 2 ── encryption roundtrip + no plaintext at rest ──────────────────
    it('stores the api key encrypted (never plaintext) and decrypts it back', async () => {
        const wsId = await createWorkspaceRow('wspai-enc', 'personal');
        const secret = `sk-test-${stamp}-verysecretkey`;
        await workspaceAi.upsertProvider(wsId, { provider: 'custom', endpoint: 'https://enc.example/v1', apiKey: secret, model: 'm1' });

        const row = (await query(`SELECT * FROM workspace_ai_providers WHERE workspace_id = $1`, [wsId])).rows[0];
        expect(row).to.exist;
        expect(row.api_key_enc).to.not.include(secret);   // ciphertext, not plaintext
        expect(row.api_key_enc.indexOf(':')).to.be.greaterThan(0); // iv:tag:data shape

        const meta = await workspaceAi.getProviderMeta(wsId);
        expect(meta.api_key_masked).to.not.include(secret);
        expect(meta).to.not.have.property('apiKey');
        expect(meta.api_key_masked.endsWith(secret.slice(-4))).to.equal(true);

        const resolved = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(resolved.apiKey).to.equal(secret);
        expect(resolved.source).to.equal('workspace');

        await query(`DELETE FROM workspace_ai_providers WHERE workspace_id = $1`, [wsId]);
    });

    // 3 ── one row per workspace + delete ───────────────────────────────
    it('upsert keeps exactly one row per workspace; delete removes it', async () => {
        const wsId = await createWorkspaceRow('wspai-one', 'personal');
        await workspaceAi.upsertProvider(wsId, { endpoint: 'https://a.example/v1', apiKey: 'k1' });
        await workspaceAi.upsertProvider(wsId, { endpoint: 'https://b.example/v1', apiKey: 'k2', model: 'm2' });

        const rows = (await query(`SELECT * FROM workspace_ai_providers WHERE workspace_id = $1`, [wsId])).rows;
        expect(rows).to.have.length(1);
        expect(rows[0].endpoint).to.equal('https://b.example/v1');
        expect(rows[0].model).to.equal('m2');

        // Update WITHOUT apiKey keeps the stored credential
        const meta = await workspaceAi.upsertProvider(wsId, { endpoint: 'https://c.example/v1' });
        expect(meta.api_key_masked).to.equal('••••'); // short keys are fully masked

        expect(await workspaceAi.deleteProvider(wsId)).to.equal(true);
        expect(await workspaceAi.getProviderMeta(wsId)).to.equal(null);
        expect(await workspaceAi.deleteProvider(wsId)).to.equal(false);
    });

    // 4 ── resolver precedence ──────────────────────────────────────────
    it('workspace row wins; missing/disabled row degrades to system fallback', async () => {
        const wsId = await createWorkspaceRow('wspai-resolve', 'personal');

        let p = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(p.source).to.equal('system');
        expect(p.apiKey).to.equal(process.env.OPENROUTER_API_KEY || null);

        await workspaceAi.upsertProvider(wsId, { endpoint: 'https://ws.example/v1', apiKey: 'sk-ws', model: 'ws-model' });
        p = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(p.source).to.equal('workspace');
        expect(p.endpoint).to.equal('https://ws.example/v1');
        expect(p.apiKey).to.equal('sk-ws');
        expect(p.model).to.equal('ws-model');

        // disable → system fallback
        await workspaceAi.upsertProvider(wsId, { enabled: false });
        p = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(p.source).to.equal('system');

        // corrupted ciphertext → system fallback (never crash)
        await query(`UPDATE workspace_ai_providers SET api_key_enc = 'garbage' WHERE workspace_id = $1`, [wsId]);
        workspaceAi.invalidateCache(wsId);
        p = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(p.source).to.equal('system');

        await query(`DELETE FROM workspace_ai_providers WHERE workspace_id = $1`, [wsId]);
    });

    // 4b ── book resolution follows the owning workspace ────────────────
    it('resolveAIForBook resolves the book workspace provider; unknown book → system fallback', async () => {
        const bookId = `wspai-${stamp}-book`;
        await query(`INSERT INTO books (book_id, workspace_id) VALUES ($1, $2)`, [bookId, bookWorkspaceId]);
        await workspaceAi.upsertProvider(bookWorkspaceId, { endpoint: 'https://bookws.example/v1', apiKey: 'sk-bookws' });

        const p = await workspaceAi.resolveAIForBook(bookId);
        expect(p.source).to.equal('workspace');
        expect(p.apiKey).to.equal('sk-bookws');

        const unknown = await workspaceAi.resolveAIForBook('wspai-nonexistent-book-id');
        expect(unknown.source).to.equal('system');

        await query(`DELETE FROM books WHERE book_id = $1`, [bookId]);
    });

    // 5 ── cache + invalidation ─────────────────────────────────────────
    it('resolver result is cached ~30s and invalidated on writes', async () => {
        const wsId = await createWorkspaceRow('wspai-cache', 'personal');
        await workspaceAi.upsertProvider(wsId, { endpoint: 'https://v1.example/v1', apiKey: 'sk-v1' });

        // warm cache, then mutate the row behind its back: cached value wins
        const first = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(first.apiKey).to.equal('sk-v1');
        await query(`UPDATE workspace_ai_providers SET api_key_enc = $2 WHERE workspace_id = $1`,
            [wsId, workspaceAi.encryptSecret('sk-v2')]);
        const cached = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(cached.apiKey).to.equal('sk-v1'); // still cached

        // write API invalidates immediately
        await workspaceAi.upsertProvider(wsId, { endpoint: 'https://v3.example/v1', apiKey: 'sk-v3' });
        const fresh = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(fresh.apiKey).to.equal('sk-v3');

        await query(`DELETE FROM workspace_ai_providers WHERE workspace_id = $1`, [wsId]);
    });

    // 6 ── ai-caller: provider context flows into ai-service.callAI ─────
    it('ai-caller passes the AsyncLocalStorage provider to ai-service.callAI', async () => {
        installFetchMock((call) => okJsonResponse({
            choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }],
            usage: { total_tokens: 1 },
        }));

        const provider = { source: 'workspace', endpoint: 'https://ctx.example/v1', apiKey: 'sk-ctx', model: 'ctx-model', workspaceId: bookWorkspaceId };
        const parsed = await aiCaller.runWithProvider(provider, async () => {
            return await aiCaller.callAI([{ role: 'user', content: 'hi' }], { retries: 1 });
        });

        expect(parsed.ok).to.equal(1);
        expect(fetchCalls).to.have.length(1);
        expect(fetchCalls[0].url).to.equal('https://ctx.example/v1/chat/completions');
        expect(fetchCalls[0].opts.headers.Authorization).to.equal('Bearer sk-ctx');
        expect(fetchCalls[0].body.model).to.equal('ctx-model');
    });

    it('ai-caller without context keeps global endpoint + key (backward compat)', async () => {
        installFetchMock((call) => okJsonResponse({
            choices: [{ message: { content: '{"ok":2}' }, finish_reason: 'stop' }],
            usage: { total_tokens: 1 },
        }));

        const parsed = await aiCaller.callAI([{ role: 'user', content: 'hi' }], { retries: 1 });
        expect(parsed.ok).to.equal(2);
        expect(fetchCalls).to.have.length(1);
        expect(fetchCalls[0].url).to.include('/chat/completions');
        const auth = fetchCalls[0].opts.headers.Authorization || '';
        expect(auth).to.equal(`Bearer ${process.env.OPENROUTER_API_KEY || ''}`.replace(/Bearer \s*$/, 'Bearer '));
    });

    // 7 ── health cache isolation per provider ──────────────────────────
    it('checkAIHealth caches per provider (workspace vs global do not shadow each other)', async () => {
        let healthCalls = 0;
        installFetchMock((call) => {
            healthCalls += 1;
            return okJsonResponse({ choices: [{ message: { content: 'ok' } }] });
        });

        const wsProvider = { source: 'workspace', endpoint: 'https://h.example/v1', apiKey: 'sk-h1', model: 'm1', workspaceId: bookWorkspaceId };
        const wsProvider2 = { source: 'workspace', endpoint: 'https://h.example/v2', apiKey: 'sk-h22', model: 'm1', workspaceId: `${bookWorkspaceId}-x` };

        expect(await aiService.checkAIHealth({}, wsProvider)).to.equal(1);
        expect(await aiService.checkAIHealth({}, wsProvider)).to.equal(1);   // cached
        expect(healthCalls).to.equal(1);

        expect(await aiService.checkAIHealth({}, wsProvider2)).to.equal(1);  // different provider → fresh check
        expect(healthCalls).to.equal(2);
    });

    // 8 ── guest purge cascade ──────────────────────────────────────────
    it('deleting a (temporary) workspace cascades the provider row', async () => {
        const wsId = await createWorkspaceRow('wspai-guest', 'temporary');
        await workspaceAi.upsertProvider(wsId, { endpoint: 'https://g.example/v1', apiKey: 'sk-guest' });
        let row = await query(`SELECT 1 FROM workspace_ai_providers WHERE workspace_id = $1`, [wsId]);
        expect(row.rows).to.have.length(1);

        await query(`DELETE FROM workspaces WHERE id = $1`, [wsId]); // simulates guest purge
        row = await query(`SELECT 1 FROM workspace_ai_providers WHERE workspace_id = $1`, [wsId]);
        expect(row.rows).to.have.length(0);
    });

    // 9 + 10 ── HTTP routes ──────────────────────────────────────────────
    describe('routes: /api/v1/ai/chat + /ai/prompt', () => {
        const config = require('../src/config/runtime-config');
        const chatEngine = require('../src/services/chat-engine.cjs')(config);
        const registerAiRoutes = require('../src/routes/ai-routes.cjs');
        const registerSettingsRoutes = require('../src/routes/settings-ai-routes.cjs');
        const { authContext } = require('../src/middleware/auth-context');

        let server, port;

        before(async function() {
            const app = express();
            app.use(express.json());
            app.use(authContext);
            registerSettingsRoutes(app);
            // Minimal deps for the chat/prompt endpoints under test.
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

            await new Promise((resolve) => {
                server = app.listen(0, () => { port = server.address().port; resolve(); });
            });
        });

        after(() => server && server.close());

        it('/ai/prompt uses the workspace provider endpoint/key and returns parsed.reply without a book', async function() {
            this.timeout(10000);
            const bookId = `wspai-${stamp}-promptbook`;
            await query(`INSERT INTO books (book_id, workspace_id) VALUES ($1, $2)`, [bookId, bookWorkspaceId]);
            await workspaceAi.upsertProvider(bookWorkspaceId, { endpoint: 'https://route.example/v1', apiKey: 'sk-route', model: 'route-model' });

            installFetchMock((call) => okJsonResponse({
                choices: [{ message: { content: 'just-a-reply' } }],
            }));

            const res = await fetch(`http://localhost:${port}/api/v1/ai/prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ book_id: bookId, prompt: 'hello' }),
            });
            expect(res.status).to.equal(200);
            const body = await res.json();

            // parsed.reply regression: reply present even though the book has
            // no loadable bookData (previously threw ReferenceError).
            expect(body.reply).to.equal('just-a-reply');
            expect(body.patches_applied).to.equal(0);

            // Workspace provider was actually used.
            expect(fetchCalls).to.have.length(1);
            expect(fetchCalls[0].url).to.equal('https://route.example/v1/chat/completions');
            expect(fetchCalls[0].opts.headers.Authorization).to.equal('Bearer sk-route');
            expect(fetchCalls[0].body.model).to.equal('route-model');

            await query(`DELETE FROM books WHERE book_id = $1`, [bookId]);
        });

        it('settings routes enforce identity and never leak the key', async function() {
            this.timeout(10000);
            // Anonymous GET → 401 (identity required)
            let res = await fetch(`http://localhost:${port}/api/v1/settings/ai/provider`);
            expect(res.status).to.equal(401);

            // Anonymous WRITE is auto-provisioned as guest (authContext), so
            // PUT creates a provider in the guest workspace and returns meta.
            res = await fetch(`http://localhost:${port}/api/v1/settings/ai/provider`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                // No workspace id accepted from the body — server takes req.workspace.
                body: JSON.stringify({ endpoint: 'https://s.example/v1', api_key: 'sk-settings-secret', model: 'sm' }),
            });
            expect(res.status).to.equal(200);
            const putBody = await res.json();
            expect(putBody.provider).to.exist;
            expect(JSON.stringify(putBody)).to.not.include('sk-settings-secret');
            expect(putBody.provider.endpoint).to.equal('https://s.example/v1');

            // Invalid endpoint → 400
            const badRes = await fetch(`http://localhost:${port}/api/v1/settings/ai/provider`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: 'not-a-url', api_key: 'sk-x' }),
            });
            expect(badRes.status).to.equal(400);

            // Clean up the auto-provisioned guest workspace (cascades provider + guest rows).
            await query(`DELETE FROM workspaces WHERE id = $1`, [putBody.provider.workspace_id]);
        });
    });
});
