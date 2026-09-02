// ======================================================
// LLM Connector Credential Lifecycle Tests (LAC-1 — Local AI Connector V1 Phase 1)
// ======================================================
// Coverage (docs/04-planning/local-ai-connector-v1.md §8, §8.1, §10):
//   create connector → pending, workspace-bound                            ok
//   registration token TTL ≤ 15 min                                        ok
//   tokens stored hash-only (no plaintext / no raw secret in DB)           ok
//   first activation → persistent llmc.* disclosed once, status online     ok
//   replay of the same registration token → registration_already_used      ok
//   expired registration token → registration_expired                      ok
//   TWO CONCURRENT activations with one token → exactly one winner,
//   one clean loser, exactly one persistent credential (AD-3 race test)    ok
//   revoked connector fails authentication (fail-closed)                   ok
//   rotated credential invalidates the old one                             ok
//   workspace isolation (list / revoke / rotate are workspace-scoped)      ok
//   plaintext token/secret never reaches application logs                  ok
//   malformed / unknown / wrong-secret credentials → null (fail-closed)    ok
//   heartbeat/state update is server-identity-scoped                       ok
//
// Real-PG suite (migrations run against the test database).

const { expect } = require('chai');
const crypto = require('crypto');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const repo = require('../src/storage/postgres/repositories/ai-connector-repo');

const stamp = `lac1${Date.now()}`;

async function createWorkspace(name) {
    const { rows } = await query(
        `INSERT INTO workspaces (name, type) VALUES ($1, 'personal') RETURNING id`,
        [`${name}-${stamp}`]
    );
    return rows[0].id;
}

async function cleanup() {
    await query(`DELETE FROM ai_connectors WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE name LIKE '%${stamp}%')`);
    await query(`DELETE FROM workspaces WHERE name LIKE '%${stamp}%'`);
}

/** Read the RAW DB row (hash columns included) for storage-shape assertions. */
async function rawRow(connectorId) {
    const { rows } = await query(
        `SELECT * FROM ai_connectors WHERE connector_id = $1`,
        [connectorId]
    );
    return rows[0] || null;
}

/** Capture console output while fn runs (plaintext-leak assertions). */
async function captureConsole(fn) {
    const entries = [];
    const originals = {};
    for (const method of ['log', 'error', 'warn', 'info']) {
        originals[method] = console[method];
        console[method] = (...args) => entries.push({ method, text: args.map(String).join(' ') });
    }
    try {
        return { result: await fn(), entries };
    } finally {
        for (const method of Object.keys(originals)) console[method] = originals[method];
    }
}

describe('LLM Connector credential lifecycle (LAC-1)', () => {
    let wsA, wsB;

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        await cleanup();
        wsA = await createWorkspace('lacA');
        wsB = await createWorkspace('lacB');
    });

    after(async () => {
        await cleanup();
    });

    // ── 1. creation ────────────────────────────────────────────────────────

    it('createConnector → pending, workspace-bound, runtime validated', async () => {
        const { connector, regToken, regExpiresAt } = await repo.createConnector({
            workspaceId: wsA,
            name: 'Home Ollama',
            runtimeType: 'ollama',
        });
        expect(connector.workspace_id).to.equal(wsA);
        expect(connector.status).to.equal('pending');
        expect(connector.runtime_type).to.equal('ollama');
        expect(connector.token_hash === undefined).to.equal(true); // public shape — no hash columns
        expect(regToken).to.match(/^llmcreg\./);
        expect(typeof regExpiresAt).to.equal('number');

        // runtime_type is validated fail-closed.
        let rejected = false;
        try {
            await repo.createConnector({ workspaceId: wsA, name: 'x', runtimeType: 'gpu-hub' });
        } catch (_) { rejected = true; }
        expect(rejected).to.equal(true);

        // cleanup for the created connector
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('createConnector without workspaceId is refused', async () => {
        let rejected = false;
        try { await repo.createConnector({ name: 'x' }); } catch (_) { rejected = true; }
        expect(rejected).to.equal(true);
    });

    // ── 2/3. TTL + hash-only storage ───────────────────────────────────────

    it('registration token has a TTL ≤ 15 minutes', async () => {
        const before = Date.now();
        const { connector, regExpiresAt } = await repo.createConnector({
            workspaceId: wsA, name: 'ttl-check',
        });
        expect(regExpiresAt).to.be.at.most(before + repo.REG_TOKEN_TTL_MS + 50);
        expect(repo.REG_TOKEN_TTL_MS).to.be.at.most(15 * 60 * 1000);
        const raw = await rawRow(connector.connector_id);
        expect(Number(raw.reg_expires_at)).to.equal(regExpiresAt);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('registration token + persistent credential are stored HASH-ONLY', async () => {
        const { connector, regToken } = await repo.createConnector({
            workspaceId: wsA, name: 'hash-only',
        });
        const parsed = repo.parseRegToken(regToken);
        const raw = await rawRow(connector.connector_id);
        // The stored value is the SHA-256 of the secret — not the secret, not
        // the token, and not any recoverable plaintext form.
        expect(raw.reg_token_hash).to.equal(parsed.secretHash);
        expect(raw.reg_token_hash).to.match(/^[0-9a-f]{64}$/);
        const secretB64 = regToken.split('.')[2];
        expect(raw.reg_token_hash).to.not.include(secretB64);
        expect(raw.reg_token_hash).to.not.include(regToken);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    // ── 4. first activation ────────────────────────────────────────────────

    it('first activation mints the persistent llmc.* credential (disclosed once)', async () => {
        const { connector, regToken } = await repo.createConnector({
            workspaceId: wsA, name: 'activate-me', runtimeType: 'vllm',
        });
        const res = await repo.activateConnector(regToken);
        expect(res.ok).to.equal(true);
        expect(res.token).to.match(/^llmc\./);
        expect(res.connector.connector_id).to.equal(connector.connector_id);
        expect(res.connector.status).to.equal('online');
        expect(res.connector.workspace_id).to.equal(wsA);

        // The persistent credential authenticates and carries the workspace.
        const auth = await repo.authenticateConnector(res.token);
        expect(auth).to.not.equal(null);
        expect(auth.connector_id).to.equal(connector.connector_id);
        expect(auth.workspace_id).to.equal(wsA);
        expect(auth.token_hash === undefined).to.equal(true);

        // DB now: persistent hash present, registration hash + expiry nulled.
        const raw = await rawRow(connector.connector_id);
        expect(raw.token_hash).to.match(/^[0-9a-f]{64}$/);
        expect(raw.token_prefix).to.match(/^llmc_/);
        expect(raw.token_prefix).to.not.include(res.token);
        expect(raw.reg_token_hash).to.equal(null);
        expect(raw.reg_expires_at).to.equal(null);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    // ── 5. replay ──────────────────────────────────────────────────────────

    it('re-activation with the SAME token → registration_already_used', async () => {
        const { regToken } = await repo.createConnector({
            workspaceId: wsA, name: 'replay-me',
        });
        const first = await repo.activateConnector(regToken);
        expect(first.ok).to.equal(true);
        const second = await repo.activateConnector(regToken);
        expect(second.ok).to.equal(false);
        expect(second.reason).to.equal('registration_already_used');
        // Exactly one persistent credential row-side.
        const raw = await rawRow(first.connector.connector_id);
        expect(raw.token_hash).to.match(/^[0-9a-f]{64}$/);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [first.connector.connector_id]);
    });

    it('expired registration token → registration_expired', async () => {
        const { regToken } = await repo.createConnector({
            workspaceId: wsA, name: 'expired-token',
        });
        const res = await repo.activateConnector(regToken, Date.now() + repo.REG_TOKEN_TTL_MS + 1);
        expect(res.ok).to.equal(false);
        expect(res.reason).to.equal('registration_expired');
        // Still pending, token still armed (not consumed by the failed attempt).
        const rows = await query(
            `SELECT status, reg_token_hash FROM ai_connectors WHERE workspace_id = $1 AND name = 'expired-token'`,
            [wsA]
        );
        expect(rows.rows[0].status).to.equal('pending');
        expect(rows.rows[0].reg_token_hash).to.not.equal(null);
        await query(`DELETE FROM ai_connectors WHERE workspace_id = $1 AND name = 'expired-token'`, [wsA]);
    });

    it('malformed / wrong-prefix / unknown-id registration tokens are rejected', async () => {
        for (const bad of [null, '', 'garbage', 'llmc.abc.def', 'llmcreg.only.two']) {
            const res = await repo.activateConnector(bad);
            expect(res.ok).to.equal(false);
            expect(res.reason).to.equal('invalid_registration_token');
        }
        const fake = `llmcreg.${Buffer.from('00000000-0000-4000-8000-000000000000').toString('base64url')}.${crypto.randomBytes(32).toString('base64url')}`;
        const res = await repo.activateConnector(fake);
        expect(res.ok).to.equal(false);
        expect(res.reason).to.equal('registration_already_used');
    });

    // ── 6. THE RACE (AD-3 — mandatory concurrency test) ────────────────────

    it('two CONCURRENT activations with one token → exactly one winner', async function () {
        this.timeout(30000);
        const { connector, regToken } = await repo.createConnector({
            workspaceId: wsA, name: 'race-me',
        });
        // Both processes present the same plaintext simultaneously. The PG
        // row lock (SELECT … FOR UPDATE inside the exchange transaction)
        // serializes them: one winner, one clean
        // registration_already_used loser — exactly one persistent credential.
        const [r1, r2] = await Promise.all([
            repo.activateConnector(regToken),
            repo.activateConnector(regToken),
        ]);
        const outcomes = [r1, r2].map((r) => (r.ok ? 'winner' : r.reason)).sort();
        expect(outcomes).to.deep.equal(['registration_already_used', 'winner']);

        const winner = r1.ok ? r1 : r2;
        const loser = r1.ok ? r2 : r1;
        expect(loser.token).to.equal(undefined);

        // Exactly one persistent credential exists, and it belongs to the winner.
        const raw = await rawRow(connector.connector_id);
        expect(raw.token_hash).to.equal(repo.parseToken(winner.token).secretHash);
        expect(raw.reg_token_hash).to.equal(null);

        // The winner's credential authenticates; no second identity exists.
        const auth = await repo.authenticateConnector(winner.token);
        expect(auth.connector_id).to.equal(connector.connector_id);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('three-way race (token + token + token) still yields exactly one credential', async function () {
        this.timeout(30000);
        const { connector, regToken } = await repo.createConnector({
            workspaceId: wsA, name: 'race-me-3',
        });
        const results = await Promise.all([
            repo.activateConnector(regToken),
            repo.activateConnector(regToken),
            repo.activateConnector(regToken),
        ]);
        const winners = results.filter((r) => r.ok);
        expect(winners).to.have.lengthOf(1);
        expect(results.filter((r) => !r.ok && r.reason === 'registration_already_used')).to.have.lengthOf(2);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    // ── 7. revocation ──────────────────────────────────────────────────────

    it('revoked connector does NOT authenticate (fail-closed)', async () => {
        const { connector, regToken } = await repo.createConnector({
            workspaceId: wsA, name: 'revoke-me',
        });
        const act = await repo.activateConnector(regToken);
        expect(act.ok).to.equal(true);
        expect(await repo.authenticateConnector(act.token)).to.not.equal(null);

        const rev = await repo.revokeConnector(connector.connector_id, wsA);
        expect(rev.revoked).to.equal(true);
        expect(rev.tokenHash).to.match(/^[0-9a-f]{64}$/);

        expect(await repo.authenticateConnector(act.token)).to.equal(null);

        // A revoked pending connector's registration token is dead too.
        const { regToken: reg2 } = await repo.createConnector({ workspaceId: wsA, name: 'revoke-pending' });
        const connectorId = repo.parseRegToken(reg2).connectorId;
        await repo.revokeConnector(connectorId, wsA);
        const act2 = await repo.activateConnector(reg2);
        expect(act2.ok).to.equal(false);
        expect(act2.reason).to.equal('connector_revoked');
        await query(`DELETE FROM ai_connectors WHERE connector_id IN ($1, $2)`, [connector.connector_id, connectorId]);
    });

    // ── 8. rotation ────────────────────────────────────────────────────────

    it('rotated credential invalidates the OLD credential immediately', async () => {
        const { connector, regToken } = await repo.createConnector({
            workspaceId: wsA, name: 'rotate-me',
        });
        const act = await repo.activateConnector(regToken);
        const rot = await repo.rotateConnectorCredential(connector.connector_id, wsA);
        expect(rot).to.not.equal(null);
        expect(rot.token).to.match(/^llmc\./);
        expect(rot.token).to.not.equal(act.token);
        // Hashes are internal state — the public rotation result never
        // carries the previous (or any) credential hash.
        expect(rot.previousTokenHash).to.equal(undefined);
        expect(JSON.stringify(rot)).to.not.include(repo.parseToken(act.token).secretHash);

        // Old credential is dead the moment rotation commits.
        expect(await repo.authenticateConnector(act.token)).to.equal(null);
        // New credential authenticates to the same identity.
        const auth = await repo.authenticateConnector(rot.token);
        expect(auth.connector_id).to.equal(connector.connector_id);
        expect(auth.workspace_id).to.equal(wsA);
        // Exactly one current persistent credential hash row-side.
        const raw = await rawRow(connector.connector_id);
        expect(raw.token_hash).to.equal(repo.parseToken(rot.token).secretHash);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('two CONCURRENT rotations → last committed wins, exactly one live credential', async function () {
        this.timeout(30000);
        const { connector, regToken } = await repo.createConnector({
            workspaceId: wsA, name: 'rotate-race',
        });
        const act = await repo.activateConnector(regToken);
        // Serialized by the row lock: each rotation commits from a fresh
        // locked read; no stale state, no torn result.
        const [r1, r2] = await Promise.all([
            repo.rotateConnectorCredential(connector.connector_id, wsA),
            repo.rotateConnectorCredential(connector.connector_id, wsA),
        ]);
        expect(r1).to.not.equal(null);
        expect(r2).to.not.equal(null);
        expect(r1.token).to.match(/^llmc\./);
        expect(r2.token).to.match(/^llmc\./);
        expect(r1.token).to.not.equal(r2.token);
        expect(r1.token).to.not.equal(act.token);
        expect(r2.token).to.not.equal(act.token);
        // Neither result leaks the previous credential hash.
        expect(r1.previousTokenHash).to.equal(undefined);
        expect(r2.previousTokenHash).to.equal(undefined);

        // DB state: exactly ONE current token_hash — matching the LAST
        // committed rotation.
        const raw = await rawRow(connector.connector_id);
        const candidates = [r1, r2].map((r) => repo.parseToken(r.token).secretHash);
        expect(candidates).to.include(raw.token_hash);
        expect(candidates.filter((h) => h === raw.token_hash)).to.have.lengthOf(1);

        // Exactly one of the two fresh tokens authenticates: the one whose
        // hash is the committed state (the last rotation); the other is
        // already stale. The pre-race credential is dead either way.
        const auth1 = await repo.authenticateConnector(r1.token);
        const auth2 = await repo.authenticateConnector(r2.token);
        expect([auth1, auth2].filter((a) => a !== null)).to.have.lengthOf(1);
        if (auth1) { expect(auth1.connector_id).to.equal(connector.connector_id); }
        else { expect(auth2.connector_id).to.equal(connector.connector_id); }
        expect(await repo.authenticateConnector(act.token)).to.equal(null);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('a PENDING (never-activated) connector cannot rotate', async () => {
        const { connector } = await repo.createConnector({ workspaceId: wsA, name: 'rotate-pending' });
        expect(await repo.rotateConnectorCredential(connector.connector_id, wsA)).to.equal(null);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    // ── 9. workspace isolation ─────────────────────────────────────────────

    it('workspace isolation: list / revoke / rotate are strictly workspace-scoped', async () => {
        const a = await repo.createConnector({ workspaceId: wsA, name: 'iso-A' });
        const b = await repo.createConnector({ workspaceId: wsB, name: 'iso-B' });

        const listA = await repo.listWorkspaceConnectors(wsA);
        const listB = await repo.listWorkspaceConnectors(wsB);
        expect(listA.map((c) => c.connector_id)).to.include(a.connector.connector_id);
        expect(listA.map((c) => c.connector_id)).to.not.include(b.connector.connector_id);
        expect(listB.map((c) => c.connector_id)).to.not.include(a.connector.connector_id);

        // wsB cannot revoke wsA's connector…
        expect((await repo.revokeConnector(a.connector.connector_id, wsB)).revoked).to.equal(false);
        // …nor rotate its credential.
        expect(await repo.rotateConnectorCredential(a.connector.connector_id, wsB)).to.equal(null);
        // The connector is untouched by the foreign calls.
        expect((await rawRow(a.connector.connector_id)).revoked_at).to.equal(null);

        // Identity NEVER comes from the token body: a token minted for wsA's
        // connector resolves to wsA's workspace — always the DB binding.
        const actA = await repo.activateConnector(a.regToken);
        expect(actA.ok).to.equal(true);
        const auth = await repo.authenticateConnector(actA.token);
        expect(auth.workspace_id).to.equal(wsA);
        await query(`DELETE FROM ai_connectors WHERE connector_id IN ($1, $2)`,
            [a.connector.connector_id, b.connector.connector_id]);
    });

    // ── 10. credential auth fail-closed matrix ─────────────────────────────

    it('credential authentication fail-closed: malformed / unknown / wrong secret → null', async () => {
        const { connector, regToken } = await repo.createConnector({ workspaceId: wsA, name: 'fc-auth' });
        // Pending: no persistent credential exists yet — any llmc.* is dead.
        const ghost = `llmc.${Buffer.from(connector.connector_id).toString('base64url')}.${crypto.randomBytes(32).toString('base64url')}`;
        expect(await repo.authenticateConnector(ghost)).to.equal(null);

        const act = await repo.activateConnector(regToken);
        // Wrong secret for a real connector id → null (timing-safe compare).
        const wrongSecret = `llmc.${Buffer.from(connector.connector_id).toString('base64url')}.${crypto.randomBytes(32).toString('base64url')}`;
        expect(await repo.authenticateConnector(wrongSecret)).to.equal(null);
        // Garbage of every shape → null (never throws).
        for (const bad of [null, undefined, '', 'llmc', 'llmc.x', 'llmc.a.b.c', 'wrk.a.b', 'llmcreg.a.b']) {
            expect(await repo.authenticateConnector(bad)).to.equal(null);
        }
        // The real credential still resolves.
        expect((await repo.authenticateConnector(act.token)).connector_id).to.equal(connector.connector_id);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    // ── 11. heartbeat / state ──────────────────────────────────────────────

    it('heartbeat updates last_seen/status/models — server-resolved identity only', async () => {
        const { connector, regToken } = await repo.createConnector({ workspaceId: wsA, name: 'hb-me' });
        const act = await repo.activateConnector(regToken);
        const before = Number(act.connector.last_seen);
        await new Promise((r) => setTimeout(r, 5));
        const hb = await repo.updateConnectorHeartbeat(connector.connector_id, {
            models: ['qwen3:32b', 'llama3:8b'],
            capabilities: { tools: false, vision: false, context: 32768 },
            runtimeMeta: { version: '0.3.10', adapter: 'ollama' },
        });
        expect(hb).to.not.equal(null);
        expect(hb.status).to.equal('online');
        expect(Number(hb.last_seen)).to.be.at.least(before);
        expect(hb.models).to.deep.equal(['qwen3:32b', 'llama3:8b']);
        expect(hb.capabilities.tools).to.equal(false);
        expect(hb.runtime_meta.version).to.equal('0.3.10');

        // Revoked connectors never accept heartbeats.
        await repo.revokeConnector(connector.connector_id, wsA);
        expect(await repo.updateConnectorHeartbeat(connector.connector_id, {})).to.equal(null);
        // Invalid status refused fail-closed.
        let rejected = false;
        try { await repo.updateConnectorHeartbeat(connector.connector_id, { status: 'busy' }); } catch (_) { rejected = true; }
        expect(rejected).to.equal(true);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('re-arming a pending connector replaces the previous registration token', async () => {
        const { connector, regToken } = await repo.createConnector({ workspaceId: wsA, name: 're-arm' });
        const again = await repo.issueRegistrationToken(connector.connector_id, wsA);
        expect(again).to.not.equal(null);
        expect(again.regToken).to.not.equal(regToken);
        // The FIRST token is dead (hash replaced), the new one activates.
        expect((await repo.activateConnector(regToken)).ok).to.equal(false);
        const act = await repo.activateConnector(again.regToken);
        expect(act.ok).to.equal(true);
        // Activated connectors cannot be re-armed.
        expect(await repo.issueRegistrationToken(connector.connector_id, wsA)).to.equal(null);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    it('two CONCURRENT re-arms → exactly one live registration token (last committed)', async function () {
        this.timeout(30000);
        const { connector, regToken } = await repo.createConnector({ workspaceId: wsA, name: 're-arm-race' });
        // Serialized by the row lock: each re-arm commits from a fresh locked
        // read and replaces the previous hash — after both, exactly ONE token
        // (the last committed) can activate.
        const [r1, r2] = await Promise.all([
            repo.issueRegistrationToken(connector.connector_id, wsA),
            repo.issueRegistrationToken(connector.connector_id, wsA),
        ]);
        expect(r1).to.not.equal(null);
        expect(r2).to.not.equal(null);
        expect(r1.regToken).to.not.equal(r2.regToken);
        expect(r1.regToken).to.not.equal(regToken);
        expect(r2.regToken).to.not.equal(regToken);

        // DB state: exactly one live reg-token hash — the last committed.
        const raw = await rawRow(connector.connector_id);
        const candidates = [r1, r2].map((r) => repo.parseRegToken(r.regToken).secretHash);
        expect(candidates).to.include(raw.reg_token_hash);
        expect(candidates.filter((h) => h === raw.reg_token_hash)).to.have.lengthOf(1);
        expect(raw.reg_token_hash).to.not.equal(repo.parseRegToken(regToken).secretHash);

        // Exactly one of the three tokens activates; the rest are dead.
        const attempts = await Promise.all([
            repo.activateConnector(regToken),
            repo.activateConnector(r1.regToken),
            repo.activateConnector(r2.regToken),
        ]);
        expect(attempts.filter((a) => a.ok)).to.have.lengthOf(1);
        expect(attempts.filter((a) => !a.ok && a.reason === 'registration_already_used')).to.have.lengthOf(2);
        const winner = attempts.find((a) => a.ok);
        expect(winner.connector.connector_id).to.equal(connector.connector_id);
        expect(winner.connector.status).to.equal('online');
        // After activation no registration token remains usable.
        for (const a of attempts) {
            if (!a.ok) {
                expect((await repo.activateConnector(
                    [regToken, r1.regToken, r2.regToken][attempts.indexOf(a)]
                )).ok).to.equal(false);
            }
        }
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [connector.connector_id]);
    });

    // ── 12. log hygiene ────────────────────────────────────────────────────

    it('plaintext tokens/secrets NEVER reach application logs', async () => {
        const captured = await captureConsole(async () => {
            const { regToken } = await repo.createConnector({ workspaceId: wsA, name: 'log-hygiene' });
            const act = await repo.activateConnector(regToken);
            await repo.authenticateConnector(act.token);
            await repo.authenticateConnector('llmc.garbage.garbage');
            await repo.authenticateConnector(null);
            await repo.rotateConnectorCredential(act.connector.connector_id, wsA);
            await repo.revokeConnector(act.connector.connector_id, wsA);
            return act;
        });
        const logged = captured.entries.map((e) => e.text).join('\n');
        expect(logged).to.not.include(captured.result.token);
        const secret = captured.result.token.split('.')[2];
        expect(logged).to.not.include(secret);
        expect(logged).to.not.match(/llmc\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        expect(logged).to.not.match(/llmcreg\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        await query(`DELETE FROM ai_connectors WHERE connector_id = $1`, [captured.result.connector.connector_id]);
    });
});
