// ======================================================
// ANIMASTOR BACKEND — WORKSPACE AI PROVIDER ROUTES
// ======================================================
// Experimental Beta — Milestone 1. Settings layer for the ONE active AI
// provider of the CALLER'S workspace:
//
//   GET    /api/v1/settings/ai/provider    — meta (never the plaintext key)
//   PUT    /api/v1/settings/ai/provider    — upsert (endpoint+key+model)
//   DELETE /api/v1/settings/ai/provider    — remove → global env fallback
//   POST   /api/v1/settings/ai/test        — connection test (does not save)
//
// Identity: any recognized identity (user OR guest) may manage its workspace
// provider; anonymous → 401, expired guest workspace → 410. The workspace id
// ALWAYS comes from req.workspace (resolved by authContext) — never from the
// request body, so cross-workspace writes are impossible.

const workspaceAi = require('../services/workspace-ai-provider');
const aiConnectorRepo = require('../storage/postgres/repositories/ai-connector-repo');
const { assertPublicEndpoint } = require('../services/url-safety');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identityGuard(req, res) {
    if (req.guest && req.workspace && req.workspace.status === 'expired') {
        res.status(410).json({ error: 'Guest workspace expired', code: 'workspace_expired' });
        return null;
    }
    if (!req.user && !req.guest) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }
    if (!req.workspace || !req.workspace.id) {
        res.status(401).json({ error: 'Workspace not resolved' });
        return null;
    }
    return req.workspace.id;
}

function normalizeEndpoint(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!/^https?:\/\//i.test(trimmed)) return null;
    return trimmed.replace(/\/+$/, '');
}

// One workspace → ONE active provider (spec §10). selector endpoints change
// the active provider; list stays a single row by PK invariant. The "list"
// endpoint is exposed for API parity (spec §7) but returns a singleton.
module.exports = function(app) {

    // ── GET provider meta ───────────────────────────────────────────────
    app.get('/api/v1/settings/ai/provider', async (req, res) => {
        const workspaceId = identityGuard(req, res);
        if (!workspaceId) return;
        try {
            const meta = await workspaceAi.getProviderMeta(workspaceId);
            res.json({ provider: meta, has_workspace_provider: !!meta });
        } catch (err) {
            console.error('[SETTINGS-AI] GET failed:', err.message);
            res.status(500).json({ error: 'Failed to read AI provider' });
        }
    });

    // ── GET list (singleton, spec §7) ───────────────────────────────────
    // Identical shape to GET above but always returns an array, so future
    // multi-provider Consumers can switch off the same endpoint without a
    // breaking change. NEVER returns the plaintext key.
    app.get('/api/v1/settings/ai/providers', async (req, res) => {
        const workspaceId = identityGuard(req, res);
        if (!workspaceId) return;
        try {
            const meta = await workspaceAi.getProviderMeta(workspaceId);
            res.json({ providers: meta ? [meta] : [] });
        } catch (err) {
            console.error('[SETTINGS-AI] LIST failed:', err.message);
            res.status(500).json({ error: 'Failed to list AI providers' });
        }
    });

    // ── PUT upsert ──────────────────────────────────────────────────────
    app.put('/api/v1/settings/ai/provider', async (req, res) => {
        const workspaceId = identityGuard(req, res);
        if (!workspaceId) return;

        const body = req.body || {};

        // Validate provider_type (spec §3): openrouter | openai-compatible |
        // custom — plus `local-ai` (LAC §9: a connector binding, not an HTTP
        // endpoint). The local-ai branch replaces the endpoint/key contract
        // with a connector_id contract.
        let providerType = null;
        if (body.provider_type !== undefined && body.provider_type !== null) {
            providerType = workspaceAi.normalizeProviderType(body.provider_type);
            if (!providerType) {
                return res.status(400).json({ error: `provider_type must be one of: ${workspaceAi.PROVIDER_TYPES.join(', ')}` });
            }
        } else if (body.provider !== undefined && body.provider !== null) {
            // Legacy callers still pass `provider` for the same purpose.
            providerType = workspaceAi.normalizeProviderType(body.provider);
            if (!providerType) {
                return res.status(400).json({ error: `provider must be one of: ${workspaceAi.PROVIDER_TYPES.join(', ')}` });
            }
        }
        if (body.model !== undefined && body.model !== null
            && (typeof body.model !== 'string' || body.model.length > 256)) {
            return res.status(400).json({ error: 'model must be a short string' });
        }

        // ── local-ai: bind the workspace provider to a Local AI Connector ──
        // No endpoint (never a server-side runtime URL — AD-5), no api_key
        // (marker per AD-11). The connector must exist in the CALLER's
        // workspace and not be revoked; anything else is one indistinct 404
        // (no cross-workspace oracle).
        if (providerType === 'local-ai') {
            const connectorId = typeof body.connector_id === 'string' ? body.connector_id.trim() : '';
            if (!UUID_RE.test(connectorId)) {
                return res.status(400).json({ error: 'connector_id is required to bind a Local AI provider' });
            }
            try {
                const row = await aiConnectorRepo.getConnector(connectorId);
                if (!row || row.workspace_id !== workspaceId || row.revoked_at != null) {
                    return res.status(404).json({ error: 'Connector not found' });
                }
                const meta = await workspaceAi.upsertProvider(workspaceId, {
                    providerType: 'local-ai',
                    connectorId,
                    model: body.model ?? null,
                    enabled: body.enabled !== false,
                });
                return res.json({ provider: meta });
            } catch (err) {
                console.error('[SETTINGS-AI] PUT local-ai failed:', err.message);
                return res.status(500).json({ error: 'Failed to save AI provider' });
            }
        }

        const endpoint = normalizeEndpoint(body.endpoint);
        if (!endpoint) {
            return res.status(400).json({ error: 'endpoint must be a valid http(s) URL' });
        }
        // SSRF guard: a workspace provider endpoint is USER-controlled, so it
        // must never point at loopback/private/link-local/metadata addresses
        // (checked at save time AND again at every fetch — see safeFetch).
        const verdict = await assertPublicEndpoint(endpoint);
        if (!verdict.ok) {
            return res.status(400).json({ error: `endpoint not allowed: ${verdict.reason}` });
        }

        try {
            // On UPDATE the key is optional (keep the stored one). On INSERT
            // a key is mandatory — never silently store an empty credential.
            // A local-ai binding stores only the AD-11 marker — switching
            // back to a cloud provider type must supply a REAL key again
            // (the marker is never a usable credential).
            const existing = await workspaceAi.getProviderMeta(workspaceId);
            const existingIsLocalAi = !!(existing && existing.provider_type === 'local-ai');
            if (!body.api_key && (!existing || existingIsLocalAi)) {
                return res.status(400).json({ error: 'api_key is required' });
            }
            if (body.api_key !== undefined && body.api_key !== null
                && (typeof body.api_key !== 'string' || !body.api_key.trim())) {
                return res.status(400).json({ error: 'api_key must be a non-empty string' });
            }

            // Changing endpoint/provider_type/model after a successful test
            // invalidates the stored status — the row goes back to 'untested'
            // until the next Test Connection (spec §7, §8). saveRow is the
            // single owner of this transition.
            const meta = await workspaceAi.upsertProvider(workspaceId, {
                providerType: providerType || undefined,
                provider: providerType || body.provider || undefined,
                endpoint,
                apiKey: body.api_key ? String(body.api_key).trim() : undefined,
                model: body.model ?? null,
                enabled: body.enabled !== false,
            });
            res.json({ provider: meta });
        } catch (err) {
            console.error('[SETTINGS-AI] PUT failed:', err.message);
            res.status(500).json({ error: 'Failed to save AI provider' });
        }
    });

    // ── DELETE provider ─────────────────────────────────────────────────
    app.delete('/api/v1/settings/ai/provider', async (req, res) => {
        const workspaceId = identityGuard(req, res);
        if (!workspaceId) return;
        try {
            const deleted = await workspaceAi.deleteProvider(workspaceId);
            res.json({ deleted, has_workspace_provider: false });
        } catch (err) {
            console.error('[SETTINGS-AI] DELETE failed:', err.message);
            res.status(500).json({ error: 'Failed to delete AI provider' });
        }
    });

    // ── POST connection test (does not persist anything except last_test) ─
    app.post('/api/v1/settings/ai/test', async (req, res) => {
        const workspaceId = identityGuard(req, res);
        if (!workspaceId) return;

        const body = req.body || {};
        try {
            // Build ONE consistent snapshot of the provider under test:
            // explicit body values win, otherwise the STORED workspace
            // provider fills in every missing field — endpoint, key AND
            // model come from the same source so a saved custom provider is
            // re-tested against its own endpoint, never the global default.
            const stored = await workspaceAi.resolveAIForWorkspace(workspaceId);
            const fromStored = stored && stored.source === 'workspace';
            const storedIsConnector = fromStored && stored.transport === 'connector';

            // ── local-ai branch (LAC §9): the user-initiated AD-7 probe ──
            // ONE max_tokens:1 completion over the connector's live WS
            // session (may cold-load the model — the UI warns). The
            // connector comes from body.connector_id or the stored binding;
            // anything not in the CALLER's workspace → one indistinct 404.
            // This branch must run BEFORE the HTTP path: a connector binding
            // has no endpoint/key, and the HTTP test would otherwise fall
            // through to the server global env key (false positive).
            const connectorId = (typeof body.connector_id === 'string' && body.connector_id.trim())
                ? body.connector_id.trim()
                : (storedIsConnector ? stored.connectorId : null);
            if (connectorId || body.provider_type === 'local-ai') {
                if (!connectorId || !UUID_RE.test(connectorId)) {
                    return res.status(400).json({ ok: false, error: 'connector_id is required to test a Local AI connector' });
                }
                const row = await aiConnectorRepo.getConnector(connectorId);
                if (!row || row.workspace_id !== workspaceId) {
                    return res.status(404).json({ ok: false, error: 'Connector not found' });
                }
                const testModel = (typeof body.model === 'string' && body.model.trim())
                    ? body.model.trim()
                    : (storedIsConnector ? stored.model : null);
                const result = await workspaceAi.testConnectorConnection({ connectorId, model: testModel });
                if (storedIsConnector) await workspaceAi.setLastTest(workspaceId, !!result.ok);
                res.json(result);
                return;
            }

            const endpoint = normalizeEndpoint(body.endpoint)
                || (fromStored ? normalizeEndpoint(stored.endpoint) : null);
            const apiKey = (typeof body.api_key === 'string' && body.api_key.trim())
                ? body.api_key.trim()
                : (fromStored ? stored.apiKey : null);
            const model = (typeof body.model === 'string' && body.model.trim())
                ? body.model.trim()
                : (fromStored ? stored.model : null);

            // Ghost-provider guard: when there is NO stored workspace provider
            // AND the request body is empty (no explicit endpoint/key/model),
            // reject immediately instead of silently falling back to the server
            // global env key — that would produce a false-positive "connection
            // OK" for a provider the user already deleted.
            if (!fromStored && !endpoint && !apiKey) {
                return res.status(400).json({
                    ok: false,
                    error: 'No provider configured — add a provider first',
                });
            }

            const result = await workspaceAi.testConnection({
                endpoint: endpoint || undefined,
                apiKey: apiKey || undefined,
                model: model || undefined,
            });

            // Persist last_tested_at + status so the UI can show a state.
            // Safe-best: never clobber the test verdict on DB error.
            if (fromStored) await workspaceAi.setLastTest(workspaceId, !!result.ok);

            delete result.apiKey; // never echo credentials
            res.json(result);
        } catch (err) {
            console.error('[SETTINGS-AI] TEST failed:', err.message);
            res.status(500).json({ ok: false, error: 'Connection test failed' });
        }
    });

    console.log('[ROUTES] Workspace AI provider routes loaded');
};
