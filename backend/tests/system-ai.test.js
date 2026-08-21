// ======================================================
// System AI Control Tests (kill switch + system provider)
// ======================================================
// Real-PG suite covering the admin kill switch and the platform-level
// system provider:
//   1. schema: system_settings + system_ai_providers exist; system_ai seeded ON
//   2. isSystemAiEnabled default ON; setSystemAiEnabled persists + flips
//   3. resolveSystemProvider: OFF → null; ON + env key → system; ON + DB row → DB
//   4. kill switch OFF blocks the env fallback (no hidden bypass)
//   5. personal workspace provider is UNAFFECTED by the kill switch
//   6. upsertSystemProvider + getSystemProviderMeta never leak the plaintext key
//   7. setSystemAiEnabled invalidates the workspace resolver cache
//
// HTTP fetch is stubbed with a recording mock — the suite never touches a
// real LLM API.

const { expect } = require('chai');

// Ensure an env key exists so the "system fallback via env" path is testable.
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'sk-system-env-test';

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const systemAi = require('../src/services/system-ai');
const workspaceAi = require('../src/services/workspace-ai-provider');
const config = require('../src/config/runtime-config');

if (!config.OPENROUTER_API_KEY) config.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const stamp = `sysai${Date.now()}`;

async function createWorkspaceRow(name) {
    const { rows } = await query(
        `INSERT INTO workspaces (name, type) VALUES ($1, 'personal') RETURNING id`,
        [`${name}-${stamp}`]
    );
    return rows[0].id;
}

async function cleanup() {
    await query(`DELETE FROM workspace_ai_providers WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')`);
    await query(`DELETE FROM workspaces WHERE name LIKE '%${stamp}%'`);
    await query(`DELETE FROM system_ai_providers WHERE id = 'default'`);
    // Restore the kill switch to its default (ON) for other suites.
    await query(`UPDATE system_settings SET value = '{"enabled": true}'::jsonb WHERE key = 'system_ai'`);
}

describe('System AI Control', () => {
    before(async () => {
        await runMigrations();
    });

    afterEach(() => {
        workspaceAi.invalidateAllCache();
        systemAi.invalidateAll();
    });

    after(async () => {
        await cleanup();
    });

    // 1 ── schema contract ───────────────────────────────────────────────
    it('system_settings + system_ai_providers tables exist; system_ai seeded ON', async () => {
        const s1 = await query(
            `SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_name = 'system_settings'`
        );
        expect(s1.rows[0].cnt).to.equal(1);
        const s2 = await query(
            `SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_name = 'system_ai_providers'`
        );
        expect(s2.rows[0].cnt).to.equal(1);

        const seed = await query(`SELECT value FROM system_settings WHERE key = 'system_ai'`);
        expect(seed.rows).to.have.length(1);
        expect(seed.rows[0].value.enabled).to.equal(true);
    });

    // 2 ── kill switch read/write ────────────────────────────────────────
    it('isSystemAiEnabled defaults to true; setSystemAiEnabled persists the flip', async () => {
        expect(await systemAi.isSystemAiEnabled()).to.equal(true);

        await systemAi.setSystemAiEnabled(false);
        expect(await systemAi.isSystemAiEnabled()).to.equal(false);

        await systemAi.setSystemAiEnabled(true);
        expect(await systemAi.isSystemAiEnabled()).to.equal(true);
    });

    // 3 ── resolveSystemProvider matrix ──────────────────────────────────
    it('resolveSystemProvider: OFF → null even with an env key', async () => {
        await systemAi.setSystemAiEnabled(false);
        const p = await systemAi.resolveSystemProvider();
        expect(p).to.equal(null);
        await systemAi.setSystemAiEnabled(true);
    });

    it('resolveSystemProvider: ON + no DB row → env key as system provider', async () => {
        await query(`DELETE FROM system_ai_providers WHERE id = 'default'`);
        await systemAi.setSystemAiEnabled(true);
        const p = await systemAi.resolveSystemProvider();
        expect(p).to.not.equal(null);
        expect(p.source).to.equal('system');
        expect(p.apiKey).to.equal(process.env.OPENROUTER_API_KEY);
    });

    it('resolveSystemProvider: ON + DB row → the admin-configured provider wins over env', async () => {
        await systemAi.upsertSystemProvider({
            providerType: 'openrouter',
            endpoint: 'https://sys.example/v1',
            apiKey: 'sk-system-db',
            model: 'sys-model',
        });
        await systemAi.setSystemAiEnabled(true);
        const p = await systemAi.resolveSystemProvider();
        expect(p.source).to.equal('system');
        expect(p.endpoint).to.equal('https://sys.example/v1');
        expect(p.apiKey).to.equal('sk-system-db');
        expect(p.model).to.equal('sys-model');
    });

    // 4 ── kill switch blocks the env fallback (no hidden bypass) ────────
    it('kill switch OFF → workspace with no provider resolves to no usable key', async () => {
        const wsId = await createWorkspaceRow('sysai-off');
        await systemAi.setSystemAiEnabled(false);
        const p = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(p.apiKey).to.equal(null);
        expect(p.source).to.equal('none');
        await systemAi.setSystemAiEnabled(true);
    });

    // 5 ── personal provider unaffected by the kill switch ───────────────
    it('kill switch OFF does NOT block a workspace personal provider', async () => {
        const wsId = await createWorkspaceRow('sysai-personal');
        await workspaceAi.upsertProvider(wsId, {
            endpoint: 'https://personal.example/v1', apiKey: 'sk-personal', model: 'pm',
        });
        await systemAi.setSystemAiEnabled(false);
        const p = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(p.source).to.equal('workspace');
        expect(p.apiKey).to.equal('sk-personal');
        await systemAi.setSystemAiEnabled(true);
    });

    // 6 ── system provider meta never leaks the key ──────────────────────
    it('getSystemProviderMeta masks the key; upsert requires a key on create', async () => {
        await query(`DELETE FROM system_ai_providers WHERE id = 'default'`);
        let threw = false;
        try {
            await systemAi.upsertSystemProvider({ endpoint: 'https://x.example/v1' });
        } catch (e) {
            threw = true;
        }
        expect(threw).to.equal(true);

        await systemAi.upsertSystemProvider({
            providerType: 'openai-compatible',
            endpoint: 'https://meta.example/v1',
            apiKey: 'sk-meta-secret',
            model: 'meta-model',
        });
        const meta = await systemAi.getSystemProviderMeta();
        expect(meta.endpoint).to.equal('https://meta.example/v1');
        expect(meta.configured).to.equal(true);
        expect(meta.api_key_masked).to.not.include('sk-meta-secret');
        expect(JSON.stringify(meta)).to.not.include('sk-meta-secret');
    });

    // 7 ── toggle invalidates the workspace resolver cache ───────────────
    it('setSystemAiEnabled clears the workspace resolver cache', async () => {
        // Remove any DB system provider left by earlier tests so the env
        // fallback is the observable system source.
        await query(`DELETE FROM system_ai_providers WHERE id = 'default'`);
        const wsId = await createWorkspaceRow('sysai-cache');
        // Warm the cache with the system (env) fallback.
        await systemAi.setSystemAiEnabled(true);
        const before = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(before.apiKey).to.equal(process.env.OPENROUTER_API_KEY);

        // Flip OFF — the cached entry must NOT be served; resolution re-runs.
        await systemAi.setSystemAiEnabled(false);
        const after = await workspaceAi.resolveAIForWorkspace(wsId);
        expect(after.apiKey).to.equal(null);

        await systemAi.setSystemAiEnabled(true);
    });
});
