// ======================================================
// AUTH COOKIE GRAMMAR (Auth Extraction Phase 1)
// ======================================================
// String-level cookie builders + parser for the auth domain. This is the
// file a future @animastor/auth exports as-is: it never sees `req`/`res` —
// the HTTP adapter passes a `secure` boolean and a raw Cookie header string.
//
// Semantics FROZEN (audit §9 invariant 4):
//   every Set-Cookie carries Path=/; HttpOnly; SameSite=Lax; Max-Age=<TTL>;
//   Secure appended when the caller passes { secure: true };
//   Domain= appended only for a validated normalized config.cookieDomain
//   (strict charset — attribute injection impossible);
//   clear-headers use Max-Age=0 with otherwise identical attributes.
// ======================================================

'use strict';

const { DAY_MS } = require('./auth-config');

// ── token/cookie identity constants (the wire contract) ─────────────────
const SESSION_COOKIE_NAME = 'animastor_sid';
const GUEST_COOKIE_NAME = 'animastor_gid';
const SESSION_TTL_MS = 30 * DAY_MS;
const GUEST_WORKSPACE_TTL_MS = 7 * DAY_MS;
const GUEST_WORKSPACE_GRACE_MS = 23 * DAY_MS;
const GUEST_SESSION_TTL_MS = 30 * DAY_MS;

function domainSuffix(cookieDomain) {
    return cookieDomain ? `; Domain=${cookieDomain}` : '';
}

/** Set-Cookie for a fresh session token. */
function sessionCookieHeader(token, { secure }, cfg = {}) {
    const ttl = cfg.sessionTtlMs != null ? cfg.sessionTtlMs : SESSION_TTL_MS;
    const maxAgeSec = Math.floor(ttl / 1000);
    let v = `${cfg.sessionCookieName || SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${domainSuffix(cfg.cookieDomain)}`;
    if (secure) v += '; Secure';
    return v;
}

/** Set-Cookie that clears the session cookie. */
function clearSessionCookieHeader({ secure } = {}, cfg = {}) {
    let v = `${cfg.sessionCookieName || SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${domainSuffix(cfg.cookieDomain)}`;
    if (secure) v += '; Secure';
    return v;
}

/** Set-Cookie for a fresh guest identity. */
function guestCookieHeader(token, { secure } = {}, cfg = {}) {
    const ttl = cfg.guestSessionTtlMs != null ? cfg.guestSessionTtlMs : GUEST_SESSION_TTL_MS;
    const maxAgeSec = Math.floor(ttl / 1000);
    let v = `${cfg.guestCookieName || GUEST_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${domainSuffix(cfg.cookieDomain)}`;
    if (secure) v += '; Secure';
    return v;
}

/** Set-Cookie that clears the guest cookie (after conversion / logout). */
function clearGuestCookieHeader({ secure } = {}, cfg = {}) {
    let v = `${cfg.guestCookieName || GUEST_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${domainSuffix(cfg.cookieDomain)}`;
    if (secure) v += '; Secure';
    return v;
}

/**
 * Minimal cookie header parsing (no cookie-parser dependency).
 * String-level by design: the HTTP adapter passes `req.headers.cookie`.
 * @param {string} header - raw Cookie header value (may be null/undefined)
 * @param {string} name - cookie name to extract
 * @returns {string|null} decoded value or null
 */
function parseCookieHeader(header, name) {
    if (!header) return null;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) {
            try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch (_) { return part.slice(eq + 1).trim(); }
        }
    }
    return null;
}

module.exports = {
    SESSION_COOKIE_NAME,
    GUEST_COOKIE_NAME,
    SESSION_TTL_MS,
    GUEST_WORKSPACE_TTL_MS,
    GUEST_WORKSPACE_GRACE_MS,
    GUEST_SESSION_TTL_MS,
    sessionCookieHeader,
    clearSessionCookieHeader,
    guestCookieHeader,
    clearGuestCookieHeader,
    parseCookieHeader,
};
