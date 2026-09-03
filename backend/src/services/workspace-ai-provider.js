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

// ── provider types (spec §3, §14, §15) ───────────────────────────────────
// `openrouter` — first documented example. `openai-compatible` — any other
// OpenAI-compatible endpoint (custom local server, other aggregator). The
// legacy `custom` value is kept as a back-compat alias of `openai-compatible`.
// The architecture is NOT tied to OpenRouter — the `model` field is a free
// string the user can type in (spec §15).
// `local-ai` — Local AI Connector V1 (LAC): the workspace provider is bound
// to an ai_connectors row (connector_id) instead of an HTTP endpoint/key.
// The runtime URL never exists server-side (AD-5); inference rides the
// connector's authenticated WS session via the transport seam (§9).
const PROVIDER_TYPES = ['openrouter', 'openai-compatible', 'custom', 'local-ai'];

const DEFAULT_PROVIDER_TYPE = 'openai-compatible';

const LOCAL_AI_TYPE = 'local-ai';

// Marker value for api_key_enc on local-ai rows (AD-11): satisfies the NOT
// NULL constraint without storing any credential material. It is never a
// usable cloud key — decryptSecret() returns null for it (not a ciphertext
// envelope), and publicMeta() handles local-ai rows separately.
const LOCAL_AI_KEY_MARKER = 'local-ai-connector-binding';

function normalizeProviderType(value) {
    if (!value || typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    if (v === 'openai' || v === 'openai-api') return 'openai-compatible';
    if (v === 'local' || v === 'localai') return LOCAL_AI_TYPE;
    if (PROVIDER_TYPES.includes(v)) return v;
    return null;
}

// Connection status — derived from the most recent Test Connection (spec §7,§8).
//   untested — created but never tested
//   ok       — last test succeeded
//   failed   — last test failed
const STATUS_VALUES = ['untested', 'ok', 'failed'];
const DEFAULT_STATUS = 'untested';

// ── secret key management ───────────────────────────────────────────────

/**
 * Validate that a raw env-string is a usable secret key.
 * Rejects: undefined, empty string, whitespace-only.
 * @param {string|undefined} value
 * @returns {string} trimmed non-empty value
 * @throws if invalid
 */
function _validateSecretKeyRaw(value) {
    if (value == null || typeof value !== 'string') {
        throw new Error('WORKSPACE_SECRET_KEY is required in production');
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new Error('WORKSPACE_SECRET_KEY is required in production');
    }
    return trimmed;
}

/**
 * Encryption key derivation: WORKSPACE_SECRET_KEY (any length) → 32 bytes.
 *
 * Production (NODE_ENV=production): the key is mandatory; a missing, empty,
 * or whitespace-only value throws immediately — no fallback.
 *
 * Development / test: a deterministic dev-only fallback is used when the
 * env var is absent.  The fallback is clearly marked and MUST NOT be
 * deployed to a real environment.
 */
function getSecretKey() {
    const raw = process.env.WORKSPACE_SECRET_KEY;
    const isProduction = process.env.NODE_ENV === 'production';

    // Production: fail closed — no fallback, no silent generation.
    if (isProduction) {
        _validateSecretKeyRaw(raw);
        return crypto.createHash('sha256').update(raw.trim()).digest();
    }

    // Development / test: allow the legacy dev fallback.
    if (!raw || raw.trim().length === 0) {
        if (!_logEmitted) {
            _logEmitted = true;
            console.warn(
                '[WORKSPACE-AI] WORKSPACE_SECRET_KEY not set — using INSECURE development-only key. ' +
                'This key is publicly visible and MUST NOT be used in production.'
            );
        }
        return crypto.createHash('sha256').update('animastor-dev-workspace-secret-key-do-not-use-in-prod').digest();
    }
    return crypto.createHash('sha256').update(raw.trim()).digest();
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

/**
 * No-provider snapshot — returned when neither a workspace provider nor a
 * usable system provider exists (kill switch OFF, or nothing configured).
 * Callers must treat `apiKey === null` as "AI unavailable" and fail with a
 * clear message instead of silently attempting a call.
 */
function noProvider() {
    return {
        source: 'none',
        provider: null,
        endpoint: null,
        apiKey: null,
        model: FALLBACK_MODEL,
        workspaceId: null,
    };
}

/**
 * Gated system/provider fallback (System AI Control).
 * Delegates to the system-ai service which enforces the admin kill switch:
 *   - kill switch OFF  → null → noProvider()
 *   - kill switch ON   → admin-configured system provider, else env key, else null
 * Never throws — degrades to noProvider() on any resolution error.
 * @returns {Promise<{source:string, provider:string|null, endpoint:string|null, apiKey:string|null, model:string|null, workspaceId:null}>}
 */
async function resolveSystemFallback() {
    try {
        const systemAi = require('./system-ai');
        const p = await systemAi.resolveSystemProvider();
        if (p) return p; // source: 'system'
    } catch (err) {
        console.error('[WORKSPACE-AI] system fallback resolution failed:', err.message);
    }
    return noProvider();
}

/**
 * Legacy sync global fallback. Kept for backward compatibility with callers
 * that still reference it, but the resolver no longer uses it — all fallback
 * now goes through the gated resolveSystemFallback(). New code should not
 * call this directly.
 */
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

/**
 * Local AI Connector provider snapshot (LAC §9): transport='connector' means
 * the consumer branch talks to the connector's live WS session through
 * ai-connector/transport — there is NO server-side endpoint/key at all
 * (apiKey stays null by design; the empty-key fail-closed hint must not
 * apply — resolveAIProvider skips the re-tag for connector snapshots).
 * Liveness is NOT checked here: the transport step fails closed with
 * 'connector_offline' (AD-12 — never a silent fallback to the system AI).
 */
function buildConnectorProvider(row) {
    return {
        source: 'workspace',
        transport: 'connector',
        provider: LOCAL_AI_TYPE,
        connectorId: row.connector_id || null,
        endpoint: null,
        apiKey: null,
        model: row.model || FALLBACK_MODEL,
        workspaceId: row.workspace_id,
    };
}

function buildWorkspaceProvider(row) {
    if ((row.provider_type || row.provider) === LOCAL_AI_TYPE) {
        return buildConnectorProvider(row);
    }
    const apiKey = decryptSecret(row.api_key_enc);
    if (!apiKey) {
        // Rotated key or corrupted ciphertext — the workspace row is unusable.
        // Return null so the resolver falls through to the gated system
        // fallback instead of silently using a global env key.
        console.warn(`[WORKSPACE-AI] Failed to decrypt provider key for workspace ${row.workspace_id}`);
        return null;
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

/** Clear the ENTIRE workspace resolver cache (admin kill-switch toggle). */
function invalidateAllCache() {
    _cache.clear();
}

// ── repository ──────────────────────────────────────────────────────────

async function getRow(workspaceId) {
    const { query } = require('../storage/postgres/database');
    const result = await query(
        `SELECT workspace_id, provider, provider_type, endpoint, api_key_enc, model, enabled,
                connector_id, status, last_tested_at, created_at, updated_at
         FROM workspace_ai_providers WHERE workspace_id = $1 LIMIT 1`,
        [workspaceId]
    );
    return result.rows[0] || null;
}

async function insertRow(workspaceId, input) {
    const { query } = require('../storage/postgres/database');
    const providerType = normalizeProviderType(input.providerType) || input.provider || DEFAULT_PROVIDER_TYPE;
    const isLocalAi = providerType === LOCAL_AI_TYPE;
    const result = await query(
        `INSERT INTO workspace_ai_providers
             (workspace_id, provider, provider_type, endpoint, api_key_enc, model, enabled, connector_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [workspaceId, providerType, providerType,
         // local-ai rows carry no endpoint/credential — marker values only
         // (AD-11; NOT NULL satisfied, no usable material stored).
         isLocalAi ? '' : input.endpoint,
         isLocalAi ? LOCAL_AI_KEY_MARKER : encryptSecret(input.apiKey),
         input.model || null, input.enabled !== false,
         isLocalAi ? (input.connectorId || null) : null,
         DEFAULT_STATUS]
    );
    return result.rows[0];
}

async function updateRow(workspaceId, input, existing) {
    const { query } = require('../storage/postgres/database');
    // `provider` is the legacy column (free text), `provider_type` is the
    // normalized enum from spec §3. They are kept in lock-step so any caller
    // (frontend, audit, tests) reading either field sees the same value.
    let providerType = existing.provider_type || existing.provider || DEFAULT_PROVIDER_TYPE;
    if (input.providerType !== undefined) {
        const norm = normalizeProviderType(input.providerType);
        if (norm) providerType = norm;
        else if (input.providerType === null) providerType = existing.provider_type || existing.provider || DEFAULT_PROVIDER_TYPE;
    } else if (input.provider !== undefined) {
        const norm = normalizeProviderType(input.provider);
        if (norm) providerType = norm;
    }

    const next = {
        provider_type: providerType,
        endpoint: normalizeEndpoint(input.endpoint ?? existing.endpoint) || '',
        model: input.model !== undefined ? (input.model || null) : (existing.model || null),
        enabled: input.enabled !== undefined ? input.enabled !== false : (existing.enabled !== false),
        connector_id: providerType === LOCAL_AI_TYPE ? (input.connectorId || null) : null,
    };
    if (input.apiKey) next.api_key_enc = encryptSecret(input.apiKey);
    // Switching TO a local-ai binding: overwrite any stored cloud credential
    // with the AD-11 marker — the old key must not linger in the row.
    if (providerType === LOCAL_AI_TYPE) {
        next.api_key_enc = LOCAL_AI_KEY_MARKER;
        next.endpoint = '';
    }

    const result = await query(
        `UPDATE workspace_ai_providers
         SET provider = $2, provider_type = $3, endpoint = $4, api_key_enc = COALESCE($5, api_key_enc),
             model = $6, enabled = $7, connector_id = $8,
             updated_at = (EXTRACT(EPOCH FROM NOW())::bigint)
         WHERE workspace_id = $1 RETURNING *`,
        [workspaceId, next.provider_type, next.provider_type, next.endpoint, next.api_key_enc || null,
         next.model, next.enabled, next.connector_id]
    );
    return result.rows[0];
}

// ── public API (settings layer) ─────────────────────────────────────────

/** Meta row for GET/PUT responses — NEVER returns the plaintext key. */
function publicMeta(row) {
    if (!row) return null;
    const isLocalAi = (row.provider_type || row.provider) === LOCAL_AI_TYPE;
    if (isLocalAi) {
        // Local AI binding (LAC §9): no endpoint, no key material — the
        // binding is the connector_id reference. has_api_key stays false and
        // api_key_masked null so the UI never pretends a credential exists.
        return {
            workspace_id: row.workspace_id,
            provider: LOCAL_AI_TYPE,
            provider_type: LOCAL_AI_TYPE,
            endpoint: null,
            model: row.model || null,
            enabled: row.enabled !== false,
            configured: true,
            has_api_key: false,
            api_key_masked: null,
            connector_id: row.connector_id || null,
            status: row.status || DEFAULT_STATUS,
            last_tested_at: row.last_tested_at != null ? Number(row.last_tested_at) : null,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }
    return {
        workspace_id: row.workspace_id,
        provider: row.provider || row.provider_type || DEFAULT_PROVIDER_TYPE,
        provider_type: row.provider_type || row.provider || DEFAULT_PROVIDER_TYPE,
        endpoint: row.endpoint,
        model: row.model || null,
        enabled: row.enabled !== false,
        // "configured: true" (spec §5) — has an encrypted key that decrypts
        // back. api_key_masked stays for the show/hide UX; the plaintext is
        // never returned.
        configured: !!row.api_key_enc,
        has_api_key: true,
        api_key_masked: maskKey(decryptSecret(row.api_key_enc)),
        status: row.status || DEFAULT_STATUS,
        last_tested_at: row.last_tested_at != null ? Number(row.last_tested_at) : null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

/** Read the provider for a workspace (meta only). Never leaks the key. */
async function getProviderMeta(workspaceId) {
    const row = await getRow(workspaceId);
    return publicMeta(row);
}

/** Persist the last Test Connection outcome (spec §8). Resets the row to
 *  'ok' or 'failed' and stamps last_tested_at to server time. Safe-best: a
 *  DB failure here must NOT clobber the test response. */
async function setLastTest(workspaceId, ok) {
    try {
        const { query } = require('../storage/postgres/database');
        await query(
            `UPDATE workspace_ai_providers
             SET status = $2, last_tested_at = (EXTRACT(EPOCH FROM NOW())::bigint)
             WHERE workspace_id = $1`,
            [workspaceId, ok ? 'ok' : 'failed']
        );
        invalidateCache(workspaceId);
    } catch (err) {
        console.warn(`[WORKSPACE-AI] setLastTest(${workspaceId}) failed:`, err.message);
    }
}

/**
 * Upsert the active provider. One row per workspace enforced by PK.
 * @param {string} workspaceId
 * @param {{providerType?:string, provider?:string, endpoint?:string, apiKey?:string, model?:string|null, connectorId?:string|null, enabled?:boolean}} input
 * @throws When `provider`/`providerType` is supplied but not one of PROVIDER_TYPES.
 */
async function upsertProvider(workspaceId, input) {
    if (input && (input.providerType !== undefined && input.providerType !== null)) {
        const norm = normalizeProviderType(input.providerType);
        if (!norm) throw new Error(`Unsupported provider_type: ${input.providerType}. Allowed: ${PROVIDER_TYPES.join(', ')}`);
    }
    if (input && (input.provider !== undefined && input.provider !== null) && !normalizeProviderType(input.provider)) {
        // Legacy callers pass `provider` as a free text — only reject blatant mistakes.
        // Allow anything matching an allowed type after normalization; otherwise keep existing.
    }
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
 * Shared-pool stage (Phase 2 consumer inference — SH-AI-3, sharing doc
 * §6.2 resolver stage 2): consulted when the workspace has NO usable
 * provider row (no row / disabled row / undecryptable credential). The
 * OWNER's row — cloud or local-ai connector — always wins first and its
 * behavior is byte-identical to pre-sharing days (an explicitly bound
 * local-ai connector that is offline keeps failing closed at the transport
 * step per AD-12; the pool is never a silent substitution for an explicit
 * binding).
 *
 * The returned snapshot is a SLOTLESS selection (selectSharedAI — the full
 * eligibility ladder incl. "concurrency slot available" runs at selection
 * time; the slot itself is reserved per inference at the transport branch
 * by shared-pool.runSharedInference). It is NEVER cached: pool capacity
 * must not ride the 30s resolver cache, and every request re-runs the
 * eligibility ladder (a revoked policy depools consumers within one
 * request, not one TTL).
 *
 * Pool failure degrades to null (→ system fallback) — never throws.
 * @returns {Promise<object|null>} shared connector snapshot or null
 */
async function resolveSharedPoolStage(workspaceId, { purpose, model } = {}) {
    try {
        const sharedPool = require('./ai-connector/shared-pool');
        return await sharedPool.selectSharedAI({ workspaceId, purpose, model });
    } catch (err) {
        console.warn(`[WORKSPACE-AI] shared pool stage failed for ${workspaceId}: ${err.message}`);
        return null;
    }
}

/**
 * Resolve the AI provider for a workspace: workspace row first, then the
 * SHARED POOL (Phase 2, stage 2 — slotless, never cached), then the GATED
 * system fallback (admin kill switch enforced). Never throws on config
 * errors (degrades to the next stage / noProvider).
 *
 * Resolution chain (sharing doc §6.2):
 *   1. workspace_ai_providers row (cloud or local-ai binding — untouched)
 *   2. shared pool                (NEW — only when stage 1 yields nothing)
 *   3. system provider / env      (kill-switch gated, untouched)
 *   4. fail closed                ('none' / 'unconfigured', untouched)
 *
 * @param {string} workspaceId
 * @param {{purpose?:string, model?:string}} [opts] - purpose/model ride the
 *        shared-pool selection (private rows have no per-purpose routing).
 * @returns {Promise<{source:string, provider:string|null, endpoint:string|null, apiKey:string|null, model:string|null, workspaceId:string|null}>}
 */
async function resolveAIForWorkspace(workspaceId, opts = {}) {
    if (!workspaceId) return resolveSystemFallback();

    const cached = _cache.get(workspaceId);
    if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
        return cached.provider;
    }

    let provider = null;
    try {
        const row = await getRow(workspaceId);
        if (row && row.enabled !== false) {
            provider = buildWorkspaceProvider(row); // null on decrypt failure
        }
    } catch (err) {
        console.error(`[WORKSPACE-AI] resolve for ${workspaceId} failed, falling through:`, err.message);
        provider = null;
    }

    if (provider) {
        // Stage 1 hit — the owner's own resource. Cached exactly as before
        // (30s TTL, invalidated on writes). Behavior byte-identical.
        provider.workspaceId = workspaceId;
        cacheSet(workspaceId, provider);
        return provider;
    }

    // Stage 2 — shared pool (Phase 2): slotless selection, NEVER cached
    // (the pool is capacity, not configuration; every request re-checks
    // the eligibility ladder).
    const shared = await resolveSharedPoolStage(workspaceId, opts);
    if (shared) {
        shared.workspaceId = workspaceId;
        return shared;
    }

    // Stage 3 — gated system fallback (unchanged; cached as before).
    provider = await resolveSystemFallback();
    provider.workspaceId = workspaceId;
    cacheSet(workspaceId, provider);
    return provider;
}

/**
 * Resolve the provider for a book: book → its workspace → provider.
 * Pre-auth / unresolvable book → gated system fallback.
 * allowCreate=false: resolution must never seed registry rows for ghost
 * book ids (old sessions pointing at deleted books) — when the book is
 * unregistered, the system fallback applies.
 * opts ride through to resolveAIForWorkspace (Phase 2: purpose/model for
 * the shared-pool stage).
 */
async function resolveAIForBook(bookId, opts = {}) {
    if (!bookId) return resolveSystemFallback();
    try {
        const ownership = require('../middleware/workspace-ownership');
        const workspaceId = await ownership.resolveWorkspaceForBook(bookId, { allowCreate: false });
        if (!workspaceId) return resolveSystemFallback();
        return await resolveAIForWorkspace(workspaceId, opts);
    } catch (err) {
        console.error(`[WORKSPACE-AI] resolveForBook(${bookId}) failed, using system fallback:`, err.message);
        return resolveSystemFallback();
    }
}

/** True when any API key is available (workspace or global). */
function hasUsableApiKey(provider) {
    return !!(provider && provider.apiKey);
}

// ── purpose-based resolver (spec §9, §13) ────────────────────────────────
//
// resolveAIProvider(workspaceId, purpose)
//   one addressable entry point consumers (chat, parser, future agents) call
//   instead of touching the resolver internals. Today per-workspace selection
//   is identical for all purposes (one active provider per workspace, spec §9),
//   so the function is a thin alias over resolveAIForWorkspace. The `purpose`
//   argument is logged at debug level so that future per-purpose routing,
//   fallback chains, or per-agent provider trees can be added HERE without
//   touching every call site (spec §13: avoid premature complexity).
//
//   purpose ∈ {'chat','parser','agent','future-agent'}
//   Unknown purposes are accepted (future-proof) but logged once.
//
//   Fail closed in Personal-only mode (spec §10): when no workspace provider
//   exists AND the operator has NOT configured a global fallback key, returns
//   a provider snapshot with apiKey=null and source='unconfigured' so the
//   caller can fail with a clear message instead of silently pretending an
//   AI call will work. resolveAIForWorkspace / resolveAIForBook keep their
//   existing global-fallback behaviour to preserve Phase 1-3 compatibility.

const KNOWN_PURPOSES = new Set(['chat', 'parser', 'agent']);

async function resolveAIProvider(workspaceId, purpose /* = 'agent' */) {
    const p = (typeof purpose === 'string' && purpose) || 'agent';
    if (!KNOWN_PURPOSES.has(p)) {
        // Unknown — accept for forward compatibility, but log once.
        console.warn(`[WORKSPACE-AI] resolveAIProvider unknown purpose "${p}" — using default path`);
    }
    const provider = await resolveAIForWorkspace(workspaceId);

    // IMPORTANT: never mutate the cached snapshot — buildWorkspaceProvider()
    // returns the one & only entry held by _cache for this workspace; mutating
    // it would leak `purpose` across callers (parser would see 'chat', etc.).
    // A shallow copy with the purpose/derived-source tags is safe: the
    // AsyncLocalStorage context owns this transient instance, not the cache.
    const tagged = { ...provider, purpose: p };
    if (!tagged.apiKey && tagged.transport !== 'connector') {
        // Personal-only fail-closed hint (spec §10). Callers choose whether to
        // surface this as an error or fall back to legacy behaviour.
        // Connector snapshots are exempt: apiKey is null BY DESIGN (LAC §9 —
        // there is no server-side credential; the empty-key hint would turn
        // every local-ai binding into a false 'workspace-unconfigured').
        tagged.source = tagged.source === 'workspace' ? 'workspace-unconfigured' : 'unconfigured';
    }
    return tagged;
}

// ── connection test ─────────────────────────────────────────────────────

/**
 * Map raw provider exception → sanitized message (spec §8, §18).
 * Never echo authorization headers, raw response bodies, or stack traces
 * containing the key. The downstream caller strips `apiKey` afterwards too.
 */
function sanitizeTestError(err, httpStatus) {
    if (httpStatus === 401 || httpStatus === 403) return 'Authentication failed';
    if (httpStatus === 404) return 'Endpoint or model not found';
    if (httpStatus === 429) return 'Rate limited by provider';
    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
        return `Provider rejected the request (${httpStatus})`;
    }
    if (err?.code === 'ENDPOINT_NOT_PUBLIC') return `Endpoint not allowed: ${err.message || 'blocked by SSRF policy'}`;
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'Provider timed out';
    // Network / DNS / TLS — keep the generic shape; don't leak internal host detail.
    const msg = String(err?.message || 'Connection failed').substring(0, 120);
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'Endpoint hostname could not be resolved';
    if (/ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(msg)) return 'Provider connection refused or reset';
    if (/certificate|ssl|tls/i.test(msg)) return 'Provider TLS validation failed';
    return `Provider connection failed: ${msg}`;
}

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
            // Sanitized — never echo request headers/key back.
            const text = (await response.text().catch(() => '')).substring(0, 200);
            // The body excerpt stays very small and is for the user/operator only;
            // the sanitized error message returned to the client strips it.
            console.warn(`[WORKSPACE-AI] testConnection non-ok status=${response.status} body=${text}`);
            return { ok: false, status: response.status, error: sanitizeTestError(null, response.status) };
        }
        return { ok: true, model: usedModel, status: response.status };
    } catch (err) {
        return { ok: false, error: sanitizeTestError(err) };
    }
}

/**
 * Local AI Connector connection test (LAC §9 / AD-7): ONE user-initiated
 * chat.request with max_tokens:1 through the connector's live WS session.
 * May cold-load the model (30-60 s spikes — the UI warns). Never scheduled,
 * never heartbeat-driven. Sanitized codes only — never raw runtime errors,
 * URLs or credential material.
 * @param {{connectorId:string, model?:string|null}} input
 * @returns {Promise<{ok:boolean, model?:string, error?:string, code?:string}>}
 */
async function testConnectorConnection({ connectorId, model }) {
    const { connectorChat, describeConnectorError } = require('./ai-connector/transport');
    if (!connectorId) return { ok: false, error: 'Local AI connector is not bound', code: 'connector_not_bound' };

    let usedModel = (typeof model === 'string' && model.trim()) ? model.trim() : null;
    if (!usedModel) {
        // Fall back to the first discovered model of the connector. A model
        // is required by the chat.request contract; discovery ≠ loading —
        // picking a discovered id proves nothing about warm state (§7).
        try {
            const { getConnector } = require('../storage/postgres/repositories/ai-connector-repo');
            const row = await getConnector(connectorId);
            const models = Array.isArray(row && row.models) ? row.models : [];
            if (models.length > 0) usedModel = String(models[0]);
        } catch (_) { /* fall through to the explicit no-models answer */ }
    }
    if (!usedModel) {
        return { ok: false, error: 'No models discovered — run Refresh Models first', code: 'no_models' };
    }

    try {
        const result = await connectorChat(connectorId, {
            model: usedModel,
            messages: [{ role: 'user', content: 'ok' }],
            params: { max_tokens: 1, temperature: 0 },
        }, { timeoutMs: 180_000 });
        if (result.ok) return { ok: true, model: usedModel };
        return { ok: false, error: describeConnectorError(result.code), code: result.code };
    } catch (err) {
        return { ok: false, error: 'Local AI connection test failed' };
    }
}

module.exports = {
    getSecretKey,
    validateSecretKeyRaw: _validateSecretKeyRaw,
    encryptSecret,
    decryptSecret,
    globalFallbackProvider,
    noProvider,
    resolveSystemFallback,
    upsertProvider,
    deleteProvider,
    getProviderMeta,
    setLastTest,
    resolveAIForWorkspace,
    resolveAIForBook,
    resolveAIProvider,
    hasUsableApiKey,
    testConnection,
    testConnectorConnection,
    invalidateCache,
    invalidateAllCache,
    maskKey,
    normalizeProviderType,
    sanitizeTestError,
    PROVIDER_TYPES,
    STATUS_VALUES,
};
