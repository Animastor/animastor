// ======================================================
// URL Safety — SSRF guard for user-controlled endpoints
// ======================================================
// Users may point a workspace AI provider at their own OpenAI-compatible
// endpoint, but the backend must never become an SSRF proxy. This module
// rejects non-public endpoints:
//
//   - non-http(s) schemes;
//   - literal loopback/private/link-local/metadata IPv4 and IPv6
//     (incl. decimal/octal/hex "alternative" IPv4 forms and IPv4-mapped
//     IPv6 such as ::ffff:127.0.0.1);
//   - hostnames whose DNS (ALL records, so round-robin cannot sneak a
//     private address in) resolves to any private/special address — this
//     also defeats the common DNS-rebinding shape where the domain points
//     at an internal address by the time the request is made;
//   - unresolvable hostnames (fail closed).
//
// `safeFetch` re-validates EVERY hop: the initial request AND each redirect
// (redirects are not followed blindly — a public endpoint redirecting to a
// private address is refused). Only http/https is accepted. Operator-controlled
// env endpoints (global AI_API_BASE_URL fallback) are deliberately exempt
// (validatePublic=false) — SSRF is about USER-controlled endpoints; a
// self-hosted operator may still target an internal LLM via env config.

const dns = require('dns');
const net = require('net');

const MAX_REDIRECTS = 3;

// ── IPv4 classification ──────────────────────────────────────────────────

/** True when `ip` is a private / loopback / link-local / metadata / special IPv4. */
function isPrivateIPv4(ip) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!m) return false;
    const a = +m[1], b = +m[2], c = +m[3], d = +m[4];
    if (a > 255 || b > 255 || c > 255 || d > 255) return true; // malformed octet → unsafe
    if (a === 0) return true;                          // "this" network
    if (a === 10) return true;                         // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared space
    if (a === 127) return true;                        // loopback
    if (a === 169 && b === 254) return true;           // link-local / EC2 metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
    if (a === 192 && b === 168) return true;           // RFC1918
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol / TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true;          // benchmarking
    if (a === 198 && b === 51 && c === 100) return true;           // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true;            // TEST-NET-3
    if (a >= 224) return true;                         // multicast + reserved
    return false;
}

// ── IPv6 helpers (no external deps) ──────────────────────────────────────

/** 16-byte Buffer for an IPv6 string, or null when unparseable. */
function ipv6ToBuffer(ip) {
    let s = ip.trim();
    let v4Suffix = null;
    // Trailing dotted IPv4 (::ffff:1.2.3.4 style)
    if (s.includes('.')) {
        const lastColon = s.lastIndexOf(':');
        const v4part = s.slice(lastColon + 1);
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4part);
        if (!m) return null;
        const oct = m.slice(1).map(Number);
        if (oct.some((x) => x > 255)) return null;
        v4Suffix = oct;
        const hi = (oct[0] << 8) | oct[1];
        const lo = (oct[2] << 8) | oct[3];
        s = s.slice(0, lastColon + 1) + hi.toString(16) + ':' + lo.toString(16);
    }

    let words;
    if (s.includes('::')) {
        const [left, right] = s.split('::');
        const l = left ? left.split(':').filter(Boolean) : [];
        const r = right ? right.split(':').filter(Boolean) : [];
        const missing = 8 - l.length - r.length;
        if (missing < 1) return null;
        words = [...l, ...Array(missing).fill('0'), ...r];
    } else {
        words = s.split(':');
    }
    if (words.length !== 8) return null;

    const buf = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) {
        const w = parseInt(words[i], 16);
        if (Number.isNaN(w) || w < 0 || w > 0xffff) return null;
        buf.writeUInt16BE(w, i * 2);
    }
    return buf;
}

/** True when `ipBuf` is inside `prefix`/`prefixLen`. */
function ipv6InPrefix(ipBuf, prefix, prefixLen) {
    const pBuf = ipv6ToBuffer(prefix);
    if (!pBuf) return false;
    const bytes = prefixLen >> 3;
    const rem = prefixLen & 7;
    for (let i = 0; i < bytes; i++) {
        if (ipBuf[i] !== pBuf[i]) return false;
    }
    if (rem) {
        const mask = 0xff << (8 - rem);
        return (ipBuf[bytes] & mask) === (pBuf[bytes] & mask);
    }
    return true;
}

/** True when `ip` is a private / loopback / link-local / special IPv6. */
function isPrivateIPv6(ip) {
    const buf = ipv6ToBuffer(ip);
    if (!buf) return true; // unparseable → unsafe

    // IPv4-mapped ::ffff:a.b.c.d — classify the embedded IPv4.
    if (buf.subarray(0, 10).equals(Buffer.alloc(10)) && buf[10] === 0xff && buf[11] === 0xff) {
        return isPrivateIPv4(`${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`);
    }
    // IPv4-compatible ::a.b.c.d (deprecated but present in some tooling).
    if (buf.subarray(0, 12).equals(Buffer.alloc(12)) && !buf.subarray(12).equals(Buffer.alloc(4))) {
        return isPrivateIPv4(`${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`);
    }

    const BLOCKS = [
        ['::', 128],    // unspecified
        ['::1', 128],   // loopback
        ['fc00::', 7],  // unique local
        ['fe80::', 10], // link-local
        ['ff00::', 8],  // multicast
    ];
    return BLOCKS.some(([prefix, len]) => ipv6InPrefix(buf, prefix, len));
}

/** True when an arbitrary IP string is private/special (or unrecognized). */
function isPrivateAddress(address) {
    if (net.isIPv4(address)) return isPrivateIPv4(address);
    if (net.isIPv6(address)) return isPrivateIPv6(address);
    return true; // unrecognized form → unsafe
}

// ── literal hostname forms ───────────────────────────────────────────────

/**
 * Parse numeric / alternative hostname forms (decimal, octal, hex, dotted
 * with radix parts) into a canonical IPv4 or IPv6 string, or null when the
 * host is not a literal address.
 */
function parseNumericHost(host) {
    if (!host) return null;
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (net.isIPv4(host)) return { ipv4: host };
    if (net.isIPv6(host)) return { ipv6: host };

    // Single integer: decimal, 0x-hex or 0-octal.
    const intMatch = host.match(/^(0[xX][0-9a-fA-F]+|[0-7]+|\d+)$/);
    if (intMatch) {
        const s = intMatch[0];
        let v;
        if (/^0[xX]/.test(s)) v = parseInt(s, 16);
        else if (/^0[0-7]+$/.test(s)) v = parseInt(s, 8);
        else v = parseInt(s, 10);
        if (Number.isFinite(v) && v >= 0 && v <= 0xffffffff) {
            return { ipv4: [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.') };
        }
        return null; // out-of-range integer → not a valid endpoint
    }

    // Dotted with octal/hex parts (e.g. 0177.0.0.1, 0x7f.0.0.1).
    const dotted = host.split('.');
    if (dotted.length === 4
        && dotted.every((p) => /^0[xX][0-9a-fA-F]+$/.test(p) || /^0[0-7]+$/.test(p) || /^\d{1,3}$/.test(p))) {
        const oct = dotted.map((p) => {
            if (/^0[xX]/.test(p)) return parseInt(p, 16);
            if (/^0[0-7]+$/.test(p) && p.length > 1) return parseInt(p, 8);
            return parseInt(p, 10);
        });
        if (oct.every((x) => Number.isFinite(x) && x >= 0 && x <= 255)) {
            return { ipv4: oct.join('.') };
        }
    }
    return null;
}

// ── public endpoint assertion ────────────────────────────────────────────

/**
 * Verify that a URL is an http(s) endpoint pointing at a public address.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function assertPublicEndpoint(urlString) {
    let url;
    try {
        url = new URL(urlString);
    } catch (_) {
        return { ok: false, reason: 'invalid URL' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, reason: 'endpoint must use http or https' };
    }

    const host = url.hostname; // WHATWG URL: lowercased, brackets stripped
    const numeric = parseNumericHost(host);
    if (numeric) {
        if (numeric.ipv4) {
            return isPrivateIPv4(numeric.ipv4)
                ? { ok: false, reason: 'private/loopback IPv4 endpoint' }
                : { ok: true };
        }
        if (numeric.ipv6) {
            return isPrivateIPv6(numeric.ipv6)
                ? { ok: false, reason: 'private/loopback IPv6 endpoint' }
                : { ok: true };
        }
    }

    try {
        // Resolve ALL addresses — round-robin / multi-A records must not be
        // able to smuggle a private address past the check. `verbatim` keeps
        // the native A/AAAA order so IPv6-capable clients are not broken.
        const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
        if (!addrs || addrs.length === 0) {
            return { ok: false, reason: 'endpoint hostname did not resolve' };
        }
        for (const { address } of addrs) {
            if (isPrivateAddress(address)) {
                return { ok: false, reason: `endpoint resolves to a private address (${address})` };
            }
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: `endpoint hostname could not be resolved (${err.code || err.message})` };
    }
}

// ── fetch wrapper with per-hop re-validation ─────────────────────────────

/**
 * fetch() for user-controlled endpoints. Re-validates the endpoint before
 * EVERY hop and follows redirects manually (never blindly) so a public
 * endpoint redirecting to a private address is refused. Throws
 * `ENDPOINT_NOT_PUBLIC` when a hop fails validation.
 *
 * @param {string} urlString
 * @param {object} opts fetch options plus:
 *   validatePublic (default true) — set false for operator-controlled
 *   (env) endpoints which are trusted configuration, not an SSRF surface.
 */
async function safeFetch(urlString, opts = {}) {
    const { validatePublic = true, ...fetchOpts } = opts;
    let currentUrl = String(urlString);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (validatePublic) {
            const verdict = await assertPublicEndpoint(currentUrl);
            if (!verdict.ok) {
                const err = new Error(`Endpoint not allowed: ${verdict.reason}`);
                err.code = 'ENDPOINT_NOT_PUBLIC';
                throw err;
            }
        }
        const response = await global.fetch(currentUrl, { ...fetchOpts, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) return response;
            currentUrl = new URL(location, currentUrl).href;
            continue;
        }
        return response;
    }
    throw new Error(`Endpoint redirected too many times (>${MAX_REDIRECTS})`);
}

module.exports = {
    assertPublicEndpoint,
    safeFetch,
    isPrivateIPv4,
    isPrivateIPv6,
    isPrivateAddress,
    parseNumericHost,
    MAX_REDIRECTS,
};