// ======================================================
// Workspace AI Provider Service
// ======================================================
// Experimental Beta — Milestone 1.
//
// One ACTIVE provider per workspace. Secret lives in PG ENCRYPTED at rest
// (AES-256-GCM, key from WORKSPACE_SECRET_KEY), never in plaintext in
// responses, logs or errors.
//
// Transport separation: this service knows NOTHING about fetch/HTTP — it
// resolves { endpoint, apiKey, model, source }. Consumers (ai-service.js,
// ai-routes.cjs, the agent via ai-caller.js) take the provider as a
// dependency argument. AI calls keep working with global env config when a
// workspace has no provider configured (backward compatibility).
// ======================================================

const crypto = require('crypto');
const { safeFetch } = require('./url-safety');

let _logEmitted = false;

// ── secret key management ───────────────────────────────────────────────

/**
 * Encryption key derivation: WORKSPACE_SECRET_KEY (any length) → 32 bytes.
 * Dev-only deterministic fallback when the env var is absent: a warning is
 * logged once — production MUST set a real key (docker-compose passes it).
 */
function getSecretKey() {
    const raw = process.env.WORKSPACE_SECRET_KEY;
    if (!raw) {
        if (!_logEmitted) {
            _logEmitted = true;
            console.warn('[WORKSPACE-AI] WORKSPACE_SECRET_KEY not set — using insecure development key');
        }
        return crypto.createHash('sha256').update('animastor-dev-workspace-secret-key-do-not-use-in-prod').digest();
    }
    return crypto.createHash('sha256').update(raw).digest();
}

/** @returns {string} `iv64:tag64:cipher64` for `plain` */
function encryptSecret(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getSecretKey(), iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** @returns {string|null} plaintext, or null on malformed/tampered input */
function decryptSecret(serialized) {
    try {
        const [iv64, tag64, data64] = String(serialized || '').split(':');
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            getSecretKey(),
            Buffer.from(iv64, 'base64')
        );
        decipher.setAuthTag(Buffer.from(tag64, 'base64'));
        const dec = Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]);
        return dec.toString('utf8');
    } catch (_) {
        return null;
    }
}

// ── shape helpers ───────────────────────────────────────────────────────

const FALLBACK_MODEL = null; // per-consumer default (resolved downstream)

function normalizeEndpoint(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let ep = raw.trim().replace(/\/+$/, '');
    return ep || null;
}

function maskKey(plain) {
    if (!plain) return '';
    const s = String(plain);
    if (s.length <= 4) return '••••';
    return '••••' + s.slice(-4);
}

function globalFallbackProvider() {
    return {
        source: 'global',
        provider: 'global',
        endpoint: null,          // consumer default (ai-service / chat-engine)
        apiKey: process.env.OPENROUTER_API_KEY || null,
        model: FALLBACK_MODEL,   // consumer default (AI_MODEL / OPENROUTER_MODEL)
        workspaceId: null,
    };
}

function buildWorkspaceProvider(row) {
    const apiKey = decryptSecret(row.api_key_enc);
    if (!apiKey) {
        // Rotated key or corrupted ciphertext — degrade to global, never crash.
        console.warn(`[WORKSPACE-AI] Failed to decrypt provider key for workspace ${row.workspace_id}`);
        return globalFallbackProvider();
    }
    return {
        source: 'workspace',
        provider: row.provider || 'custom',
        endpoint: normalizeEndpoint(row.endpoint),
        apiKey,
        model: row.model || FALLBACK_MODEL,
        workspaceId: row.workspace_id,
    };
}

// ── cache (30s TTL, invalidated on write) ───────────────────────────────

const CACHE_TTL_MS = 30_000;
const _cache = new Map(); // workspaceId → { resolvedAt, provider }

function cacheSet(workspaceId, provider) {
    _cache.set(workspaceId, { resolvedAt: Date.now(), provider });
}

function invalidateCache(workspaceId) {
    _cache.delete(workspaceId);
}

// ── repository ──────────────────────────────────────────────────────────

async function getRow(workspaceId) {
    const { query } = require('../storage/postgres/database');
    const result = await query(
        `SELECT workspace_id, provider, endpoint, api_key_enc, model, enabled, created_at, updated_at
         FROM workspace_ai_providers WHERE workspace_id = $1 LIMIT 1`,
        [workspaceId]
    );
    return result.rows[0] || null;
}

async function insertRow(workspaceId, input) {
    const { query } = require('../storage/postgres/database');
    const result = await query(
        `INSERT INTO workspace_ai_providers (workspace_id, provider, endpoint, api_key_enc, model, enabled)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [workspaceId, input.provider || 'custom', input.endpoint, encryptSecret(input.apiKey),
         input.model || null, input.enabled !== false]
    );
    return result.rows[0];
}

async function updateRow(workspaceId, input, existing) {
    const { query } = require('../storage/postgres/database');
    const next = {
        provider: input.provider ?? existing.provider ?? 'custom',
        endpoint: normalizeEndpoint(input.endpoint ?? existing.endpoint) || '',
        model: input.model !== undefined ? (input.model || null) : (existing.model || null),
        enabled: input.enabled !== undefined ? input.enabled !== false : (existing.enabled !== false),
    };
    if (input.apiKey) next.api_key_enc = encryptSecret(input.apiKey);

    const result = await query(
        `UPDATE workspace_ai_providers
         SET provider = $2, endpoint = $3, api_key_enc = COALESCE($4, api_key_enc),
             model = $5, enabled = $6,
             updated_at = (EXTRACT(EPOCH FROM NOW())::bigint)
         WHERE workspace_id = $1 RETURNING *`,
        [workspaceId, next.provider, next.endpoint, next.api_key_enc || null,
         next.model, next.enabled]
    );
    return result.rows[0];
}

// ── public API (settings layer) ─────────────────────────────────────────

/** Meta row for GET/PUT responses — NEVER returns the plaintext key. */
function publicMeta(row) {
    if (!row) return null;
    return {
        workspace_id: row.workspace_id,
        provider: row.provider,
        endpoint: row.endpoint,
        model: row.model || null,
        enabled: row.enabled !== false,
        has_api_key: true,
        api_key_masked: maskKey(decryptSecret(row.api_key_enc)),
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

/** Read the provider for a workspace (meta only). Never leaks the key. */
async function getProviderMeta(workspaceId) {
    const row = await getRow(workspaceId);
    return publicMeta(row);
}

/**
 * Upsert the active provider. One row per workspace enforced by PK.
 * @param {string} workspaceId
 * @param {{provider?:string, endpoint:string, apiKey?:string, model?:string|null, enabled?:boolean}} input
 */
async function upsertProvider(workspaceId, input) {
    const existing = await getRow(workspaceId);
    const row = existing
        ? await updateRow(workspaceId, input, existing)
        : await insertRow(workspaceId, input);
    invalidateCache(workspaceId);
    return publicMeta(row);
}

/** Delete the provider row. Returns true when a row existed. */
async function deleteProvider(workspaceId) {
    const { query } = require('../storage/postgres/database');
    const result = await query(
        `DELETE FROM workspace_ai_providers WHERE workspace_id = $1`,
        [workspaceId]
    );
    invalidateCache(workspaceId);
    return (result.rowCount || 0) > 0;
}

// ── resolver (transport layer / callers) ────────────────────────────────

/**
 * Resolve the AI provider for a workspace: workspace row first, global env
 * fallback second. Never throws on config errors (degrades to global).
 * @returns {Promise<{source:string, provider:string, endpoint:string|null, apiKey:string|null, model:string|null, workspaceId:string|null}>}
 */
async function resolveAIForWorkspace(workspaceId) {
    if (!workspaceId) return globalFallbackProvider();

    const cached = _cache.get(workspaceId);
    if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
        return cached.provider;
    }

    let provider;
    try {
        const row = await getRow(workspaceId);
        if (row && row.enabled !== false) {
            provider = buildWorkspaceProvider(row);
        } else {
            provider = globalFallbackProvider();
        }
        provider.workspaceId = workspaceId;
    } catch (err) {
        console.error(`[WORKSPACE-AI] resolve for ${workspaceId} failed, using global:`, err.message);
        provider = globalFallbackProvider();
    }

    cacheSet(workspaceId, provider);
    return provider;
}

/**
 * Resolve the provider for a book: book → its workspace → provider.
 * Pre-auth / unresolvable book → global fallback (legacy behaviour).
 * allowCreate=false: resolution must never seed registry rows for ghost
 * book ids (old sessions pointing at deleted books) — when the book is
 * unregistered, the global fallback applies (same as before Beta).
 */
async function resolveAIForBook(bookId) {
    if (!bookId) return globalFallbackProvider();
    try {
        const ownership = require('../middleware/workspace-ownership');
        const workspaceId = await ownership.resolveWorkspaceForBook(bookId, { allowCreate: false });
        if (!workspaceId) return globalFallbackProvider();
        return await resolveAIForWorkspace(workspaceId);
    } catch (err) {
        console.error(`[WORKSPACE-AI] resolveForBook(${bookId}) failed, using global:`, err.message);
        return globalFallbackProvider();
    }
}

/** True when any API key is available (workspace or global). */
function hasUsableApiKey(provider) {
    return !!(provider && provider.apiKey);
}

// ── connection test ─────────────────────────────────────────────────────

/**
 * POST a tiny chat completion to prove the provider works.
 * @returns {Promise<{ok:boolean, model?:string, status?:number, error?:string}>}
 */
async function testConnection({ endpoint, apiKey, model }) {
    const base = normalizeEndpoint(endpoint) || process.env.AI_API_BASE_URL || 'https://api.aicredits.in/v1';
    const key = apiKey || process.env.OPENROUTER_API_KEY;
    if (!key) return { ok: false, error: 'No API key configured for this provider' };

    const usedModel = model || process.env.AI_MODEL || process.env.OPENROUTER_MODEL || 'qwen/qwen3-32b';
    try {
        // safeFetch validates the endpoint is public (SSRF guard) when an
        // explicit endpoint is being tested; the env fallback is
        // operator-controlled and exempt. Redirects are re-validated per hop.
        const response = await safeFetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify({
                model: usedModel,
                messages: [{ role: 'user', content: 'ok' }],
                max_tokens: 1,
                temperature: 0,
            }),
            signal: AbortSignal.timeout(20_000),
            validatePublic: !!endpoint,
        });
        if (!response.ok) {
            // Truncated, sanitized — never echo request headers/key back.
            const text = (await response.text().catch(() => '')).substring(0, 200);
            return { ok: false, status: response.status, error: `Provider API error (${response.status}): ${text}` };
        }
        return { ok: true, model: usedModel, status: response.status };
    } catch (err) {
        return { ok: false, error: `Provider connection failed: ${err.message}` };
    }
}

module.exports = {
    encryptSecret,
    decryptSecret,
    globalFallbackProvider,
    upsertProvider,
    deleteProvider,
    getProviderMeta,
    resolveAIForWorkspace,
    resolveAIForBook,
    hasUsableApiKey,
    testConnection,
    invalidateCache,
    maskKey,
};
