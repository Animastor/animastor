// ======================================================
// AUTH CONFIG (Auth Extraction Phase 1) — injected configuration contract
// ======================================================
// The package-grade config contract for the auth domain (audit §7): the
// HOST resolves env/platform values once and injects the ready object; the
// domain never reads process.env itself. normalizeAuthConfig is pure — it
// is the validation/normalization half that a future @animastor/auth owns,
// while the host wiring (auth/index.cjs) performs the process.env reads.
//
// Defaults are the FROZEN historical values — normalization is identity for
// every deployment that never touched the env vars (audit §9 invariant:
// config behaviour must not change under preparation).
// ======================================================

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_AUTH_CONFIG = Object.freeze({
    sessionCookieName: 'animastor_sid',
    guestCookieName: 'animastor_gid',
    sessionTtlMs: 30 * DAY_MS, // hardcoded 30 days today (audit §7: stays non-env-tunable)
    guestWorkspaceTtlMs: 7 * DAY_MS,
    guestWorkspaceGraceMs: 23 * DAY_MS,
    guestSessionTtlMs: 30 * DAY_MS,
    cookieDomain: '', // '' → host-only cookies (historical single-host behaviour)
});

/**
 * Normalize + validate a partial auth config into the full frozen shape.
 * Pure: same input → same output, no env, no clock.
 * @param {object} [partial] - raw values (host-resolved env or test literals)
 * @returns {object} frozen full config
 */
function normalizeAuthConfig(partial = {}) {
    const p = partial || {};
    return Object.freeze({
        sessionCookieName: typeof p.sessionCookieName === 'string' && p.sessionCookieName
            ? p.sessionCookieName
            : DEFAULT_AUTH_CONFIG.sessionCookieName,
        guestCookieName: typeof p.guestCookieName === 'string' && p.guestCookieName
            ? p.guestCookieName
            : DEFAULT_AUTH_CONFIG.guestCookieName,
        sessionTtlMs: posInt(p.sessionTtlMs, DEFAULT_AUTH_CONFIG.sessionTtlMs),
        guestWorkspaceTtlMs: posInt(p.guestWorkspaceTtlMs, DEFAULT_AUTH_CONFIG.guestWorkspaceTtlMs),
        // Grace may legitimately be 0 — only rejects negative values.
        guestWorkspaceGraceMs: nonNegInt(p.guestWorkspaceGraceMs, DEFAULT_AUTH_CONFIG.guestWorkspaceGraceMs),
        guestSessionTtlMs: posInt(p.guestSessionTtlMs, DEFAULT_AUTH_CONFIG.guestSessionTtlMs),
        cookieDomain: normalizeCookieDomain(p.cookieDomain),
    });
}

function posInt(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt;
}

function nonNegInt(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/**
 * Cookie-domain normalization (moved verbatim-semantics from auth-service):
 * strict charset, trim/lowercase, leading-dot stripped. '' (or invalid) →
 * host-only cookies. The validation is security-relevant — it makes cookie
 * attribute injection impossible (auth-mvp §Cookie domain tests pin it).
 */
const COOKIE_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
function normalizeCookieDomain(v) {
    const d = (v == null ? '' : String(v)).trim().toLowerCase().replace(/^\./, '');
    if (!d || !COOKIE_DOMAIN_RE.test(d)) return '';
    return d;
}

module.exports = { DEFAULT_AUTH_CONFIG, normalizeAuthConfig, normalizeCookieDomain, DAY_MS };
