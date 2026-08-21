// ======================================================
// System AI Control Service
// ======================================================
// Platform-level AI kill switch + admin-configured system provider.
//
// Kill switch: system_settings key 'system_ai' → { enabled: boolean }.
//   - Default ON (preserves existing beta behaviour).
//   - Admin flips OFF → ALL system/provider AI calls are blocked.
//   - Personal (workspace) AI providers are NOT affected.
//
// System provider: system_ai_providers row id='default'.
//   - Admin-configured endpoint/key/model for the platform.
//   - Key stored AES-256-GCM encrypted (same envelope as workspace providers).
//   - Env vars (OPENROUTER_API_KEY etc.) act as secondary fallback ONLY
//     when the kill switch is ON.
//
// Cache: enabled flag cached ~5s to avoid a DB hit per AI call.
//   invalidateAll() clears both this cache and the workspace resolver cache.
// ======================================================

const SETTING_KEY = 'system_ai';
const CACHE_TTL_MS = 5_000;

let _enabledCache = null; // { value: boolean, at: number }

// ── kill switch ─────────────────────────────────────────────────────────

/**
 * Read the system AI enabled flag.
 * Returns true when no row exists (default ON — preserves beta behaviour).
 * Fail-closed on DB error with no cache: returns false (block AI).
 */
async function isSystemAiEnabled() {
    if (_enabledCache && Date.now() - _enabledCache.at < CACHE_TTL_MS) {
        return _enabledCache.value;
    }
    try {
        const { query } = require('../storage/postgres/database');
        const { rows } = await query(
            `SELECT value FROM system_settings WHERE key = $1 LIMIT 1`,
            [SETTING_KEY]
        );
        const enabled = rows.length > 0 ? rows[0].value?.enabled !== false : true;
        _enabledCache = { value: enabled, at: Date.now() };
        return enabled;
    } catch (err) {
        console.error('[SYSTEM-AI] Failed to read kill switch, fail-closed:', err.message);
        if (_enabledCache) return _enabledCache.value;
        return false;
    }
}

/**
 * Set the system AI enabled flag. Clears all caches so the change
 * takes effect immediately for subsequent requests.
 */
async function setSystemAiEnabled(enabled) {
    const { query } = require('../storage/postgres/database');
    const value = JSON.stringify({ enabled: !!enabled });
    await query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, (EXTRACT(EPOCH FROM NOW())::bigint))
         ON CONFLICT (key)
         DO UPDATE SET value = $2::jsonb, updated_at = (EXTRACT(EPOCH FROM NOW())::bigint)`,
        [SETTING_KEY, value]
    );
    invalidateAll();
    return !!enabled;
}

// ── system provider ─────────────────────────────────────────────────────

/**
 * Resolve the system (platform) AI provider.
 * Priority: DB row → env vars. Returns null when kill switch is OFF
 * or no provider is configured at all.
 *
 * @returns {Promise<{source:string, provider:string, endpoint:string|null, apiKey:string|null, model:string|null, workspaceId:null}|null>}
 */
async function resolveSystemProvider() {
    const enabled = await isSystemAiEnabled();
    if (!enabled) return null;

    const { decryptSecret } = require('./workspace-ai-provider');

    try {
        const { query } = require('../storage/postgres/database');
        const { rows } = await query(
            `SELECT provider_type, endpoint, api_key_enc, model, status
             FROM system_ai_providers WHERE id = 'default' LIMIT 1`
        );
        if (rows.length > 0) {
            const row = rows[0];
            const apiKey = decryptSecret(row.api_key_enc);
            if (apiKey) {
                return {
                    source: 'system',
                    provider: row.provider_type || 'openai-compatible',
                    endpoint: row.endpoint || null,
                    apiKey,
                    model: row.model || null,
                    workspaceId: null,
                };
            }
        }
    } catch (err) {
        console.error('[SYSTEM-AI] Failed to read system provider:', err.message);
    }

    const envKey = process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY || null;
    if (envKey) {
        return {
            source: 'system',
            provider: 'global',
            endpoint: null,
            apiKey: envKey,
            model: null,
            workspaceId: null,
        };
    }

    return null;
}

/**
 * Meta view of the system provider for the admin UI.
 * Never returns the plaintext key.
 */
async function getSystemProviderMeta() {
    const { decryptSecret, maskKey } = require('./workspace-ai-provider');
    try {
        const { query } = require('../storage/postgres/database');
        const { rows } = await query(
            `SELECT provider_type, endpoint, api_key_enc, model, status, last_tested_at, created_at, updated_at
             FROM system_ai_providers WHERE id = 'default' LIMIT 1`
        );
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            provider_type: row.provider_type || 'openai-compatible',
            endpoint: row.endpoint,
            model: row.model || null,
            configured: !!row.api_key_enc,
            api_key_masked: maskKey(decryptSecret(row.api_key_enc)),
            status: row.status || 'untested',
            last_tested_at: row.last_tested_at != null ? Number(row.last_tested_at) : null,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    } catch (err) {
        console.error('[SYSTEM-AI] getSystemProviderMeta failed:', err.message);
        return null;
    }
}

/**
 * Upsert the system provider (admin action).
 * @param {{providerType?:string, endpoint:string, apiKey?:string, model?:string|null}} input
 */
async function upsertSystemProvider(input) {
    const { encryptSecret, normalizeProviderType } = require('./workspace-ai-provider');
    const { query } = require('../storage/postgres/database');

    const providerType = normalizeProviderType(input.providerType) || 'openai-compatible';
    const endpoint = (input.endpoint || '').trim().replace(/\/+$/, '');

    const { rows: existing } = await query(
        `SELECT api_key_enc FROM system_ai_providers WHERE id = 'default' LIMIT 1`
    );

    let apiKeyEnc;
    if (input.apiKey) {
        apiKeyEnc = encryptSecret(input.apiKey);
    } else if (existing.length > 0) {
        apiKeyEnc = existing[0].api_key_enc;
    } else {
        throw new Error('apiKey is required when creating the system provider');
    }

    const result = await query(
        `INSERT INTO system_ai_providers (id, provider_type, endpoint, api_key_enc, model, status)
         VALUES ('default', $1, $2, $3, $4, 'untested')
         ON CONFLICT (id)
         DO UPDATE SET provider_type = $1, endpoint = $2,
                       api_key_enc = $3, model = $4,
                       updated_at = (EXTRACT(EPOCH FROM NOW())::bigint)
         RETURNING *`,
        [providerType, endpoint, apiKeyEnc, input.model || null]
    );
    invalidateAll();
    return getSystemProviderMeta();
}

/** Persist the last Test Connection outcome for the system provider. */
async function setSystemLastTest(ok) {
    try {
        const { query } = require('../storage/postgres/database');
        await query(
            `UPDATE system_ai_providers
             SET status = $1, last_tested_at = (EXTRACT(EPOCH FROM NOW())::bigint)
             WHERE id = 'default'`,
            [ok ? 'ok' : 'failed']
        );
    } catch (err) {
        console.warn('[SYSTEM-AI] setSystemLastTest failed:', err.message);
    }
}

// ── cache ───────────────────────────────────────────────────────────────

/** Clear the enabled-flag cache AND the workspace resolver cache. */
function invalidateAll() {
    _enabledCache = null;
    try {
        const workspaceAi = require('./workspace-ai-provider');
        if (typeof workspaceAi.invalidateAllCache === 'function') {
            workspaceAi.invalidateAllCache();
        }
    } catch (_) { /* circular guard */ }
}

module.exports = {
    isSystemAiEnabled,
    setSystemAiEnabled,
    resolveSystemProvider,
    getSystemProviderMeta,
    upsertSystemProvider,
    setSystemLastTest,
    invalidateAll,
};
