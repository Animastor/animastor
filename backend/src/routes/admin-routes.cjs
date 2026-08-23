// ======================================================
// ANIMASTOR BACKEND — ADMIN ROUTES (Admin Foundation)
// ======================================================
// Platform-level admin surface, guarded by requireAdmin (role='admin' OR
// ADMIN_USERNAMES allowlist). Served on admin.animastor.in behind nginx
// Basic Auth as a second layer.
//
//   GET  /api/v1/admin/system-ai        — kill switch state + provider meta
//   PUT  /api/v1/admin/system-ai        — toggle enabled and/or upsert provider
//   POST /api/v1/admin/system-ai/test   — connection test (does not save)
//
// The plaintext API key is accepted on write and NEVER returned: responses
// carry only a masked value. Toggling the kill switch clears every resolver
// cache so the change applies immediately.

const systemAi = require('../services/system-ai');
const workspaceAi = require('../services/workspace-ai-provider');
const { requireAdmin } = require('../middleware/auth-context');
const { assertPublicEndpoint } = require('../services/url-safety');

function normalizeEndpoint(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!/^https?:\/\//i.test(trimmed)) return null;
    return trimmed.replace(/\/+$/, '');
}

module.exports = function(app) {

    // ── GET system AI state ─────────────────────────────────────────────
    app.get('/api/v1/admin/system-ai', requireAdmin, async (req, res) => {
        try {
            const enabled = await systemAi.isSystemAiEnabled();
            const provider = await systemAi.getSystemProviderMeta();
            res.json({ enabled, provider });
        } catch (err) {
            console.error('[ADMIN] GET system-ai failed:', err.message);
            res.status(500).json({ error: 'Failed to read system AI state' });
        }
    });

    // ── PUT toggle and/or provider upsert ───────────────────────────────
    app.put('/api/v1/admin/system-ai', requireAdmin, async (req, res) => {
        const body = req.body || {};
        try {
            let enabled;
            if (body.enabled !== undefined) {
                enabled = await systemAi.setSystemAiEnabled(!!body.enabled);
            } else {
                enabled = await systemAi.isSystemAiEnabled();
            }

            let provider = await systemAi.getSystemProviderMeta();
            if (body.provider && typeof body.provider === 'object') {
                const p = body.provider;
                const endpoint = normalizeEndpoint(p.endpoint);
                if (p.endpoint !== undefined && !endpoint) {
                    return res.status(400).json({ error: 'provider.endpoint must be a valid http(s) URL' });
                }
                if (endpoint) {
                    // SSRF guard: the admin endpoint is still user-controlled input.
                    const verdict = await assertPublicEndpoint(endpoint);
                    if (!verdict.ok) {
                        return res.status(400).json({ error: `endpoint not allowed: ${verdict.reason}` });
                    }
                }
                if (p.provider_type !== undefined && p.provider_type !== null
                    && !workspaceAi.normalizeProviderType(p.provider_type)) {
                    return res.status(400).json({ error: `provider_type must be one of: ${workspaceAi.PROVIDER_TYPES.join(', ')}` });
                }
                if (p.api_key !== undefined && p.api_key !== null
                    && (typeof p.api_key !== 'string' || !p.api_key.trim())) {
                    return res.status(400).json({ error: 'provider.api_key must be a non-empty string' });
                }

                const existing = await systemAi.getSystemProviderMeta();
                if (!p.api_key && !existing) {
                    return res.status(400).json({ error: 'provider.api_key is required' });
                }

                provider = await systemAi.upsertSystemProvider({
                    providerType: p.provider_type || undefined,
                    endpoint: endpoint || (existing ? existing.endpoint : ''),
                    apiKey: p.api_key ? String(p.api_key).trim() : undefined,
                    model: p.model !== undefined ? (p.model || null) : undefined,
                });
            }

            res.json({ enabled, provider });
        } catch (err) {
            console.error('[ADMIN] PUT system-ai failed:', err.message);
            res.status(500).json({ error: 'Failed to update system AI state' });
        }
    });

    // ── POST connection test (does not persist the key) ─────────────────
    app.post('/api/v1/admin/system-ai/test', requireAdmin, async (req, res) => {
        const body = req.body || {};
        try {
            // Explicit body values win; missing fields fall back to the STORED
            // system provider so a saved provider is re-tested against itself.
            const stored = await systemAi.resolveSystemProvider();
            const fromStored = stored && stored.source === 'system' && !!stored.endpoint;

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

            // Stamp status when the stored provider was the source and the
            // resolved endpoint matches the stored one (body overrides for
            // ad-hoc testing are fine — the stored provider is still the
            // one being validated).
            const storedEndpoint = fromStored ? normalizeEndpoint(stored.endpoint) : null;
            if (fromStored && endpoint === storedEndpoint) {
                await systemAi.setSystemLastTest(!!result.ok);
            }

            delete result.apiKey; // never echo credentials
            res.json(result);
        } catch (err) {
            console.error('[ADMIN] TEST system-ai failed:', err.message);
            res.status(500).json({ ok: false, error: 'Connection test failed' });
        }
    });

    console.log('[ROUTES] Admin routes loaded');
};
