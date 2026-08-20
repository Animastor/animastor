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
const { assertPublicEndpoint } = require('../services/url-safety');

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

    // ── PUT upsert ──────────────────────────────────────────────────────
    app.put('/api/v1/settings/ai/provider', async (req, res) => {
        const workspaceId = identityGuard(req, res);
        if (!workspaceId) return;

        const body = req.body || {};
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
        if (body.model !== undefined && body.model !== null
            && (typeof body.model !== 'string' || body.model.length > 256)) {
            return res.status(400).json({ error: 'model must be a short string' });
        }

        try {
            // On UPDATE the key is optional (keep the stored one). On INSERT
            // a key is mandatory — never silently store an empty credential.
            const existing = await workspaceAi.getProviderMeta(workspaceId);
            if (!body.api_key && !existing) {
                return res.status(400).json({ error: 'api_key is required' });
            }
            if (body.api_key !== undefined && body.api_key !== null
                && (typeof body.api_key !== 'string' || !body.api_key.trim())) {
                return res.status(400).json({ error: 'api_key must be a non-empty string' });
            }

            const meta = await workspaceAi.upsertProvider(workspaceId, {
                provider: body.provider || 'custom',
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

    // ── POST connection test (does not persist anything) ────────────────
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

            const endpoint = normalizeEndpoint(body.endpoint)
                || (fromStored ? normalizeEndpoint(stored.endpoint) : null);
            const apiKey = (typeof body.api_key === 'string' && body.api_key.trim())
                ? body.api_key.trim()
                : (fromStored ? stored.apiKey : null);
            const model = (typeof body.model === 'string' && body.model.trim())
                ? body.model.trim()
                : (fromStored ? stored.model : null);

            const result = await workspaceAi.testConnection({
                endpoint: endpoint || undefined,
                apiKey: apiKey || undefined,
                model: model || undefined,
            });

            delete result.apiKey; // never echo credentials
            res.json(result);
        } catch (err) {
            console.error('[SETTINGS-AI] TEST failed:', err.message);
            res.status(500).json({ ok: false, error: 'Connection test failed' });
        }
    });

    console.log('[ROUTES] Workspace AI provider routes loaded');
};
