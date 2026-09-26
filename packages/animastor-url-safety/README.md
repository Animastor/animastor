# @animastor/url-safety

Animastor **URL Safety** — the SSRF guard of the Animastor backend:
`assertPublicEndpoint` (a URL is an http(s) endpoint on a **public**
address) and `safeFetch` (fetch with **per-hop re-validation** and manual
redirect following).

**Status: EXTRACTED (0.1.0).** Physically extracted from the Animastor host
(`backend/src/services/url-safety.js`) with strict behavior parity — the
security contract is frozen, nothing weakened. See
[`docs/architecture/backend-decomposition-reconnaissance.md`](https://github.com/Animastor/animastor/blob/main/docs/architecture/backend-decomposition-reconnaissance.md)
§4.4 (physical extraction).

## Public API

The package exposes a single entrypoint — `require('@animastor/url-safety')`
returns exactly (frozen surface, pinned by guards):

| Export | Kind | Purpose |
|---|---|---|
| `assertPublicEndpoint(urlString)` | async fn | `→ { ok, reason? }` — http/https only; literal loopback/private/link-local/metadata IPv4+IPv6 (incl. decimal/octal/hex alternative IPv4 forms and IPv4-mapped IPv6 like `::ffff:127.0.0.1`); hostname DNS resolves ALL records against private/special ranges (defeats round-robin smuggling and the common DNS-rebinding shape); unresolvable → fail closed |
| `safeFetch(urlString, opts)` | async fn | fetch for user-controlled endpoints; re-validates EVERY hop (initial request AND each redirect — redirects are followed manually, never blindly); throws `ENDPOINT_NOT_PUBLIC` when a hop fails validation; `MAX_REDIRECTS = 3` |
| `isPrivateIPv4(ip)` / `isPrivateIPv6(ip)` / `isPrivateAddress(addr)` | fn | the address classifiers (RFC1918, CGNAT 100.64/10, loopback, link-local/metadata 169.254, TEST-NET, multicast+reserved; IPv4-mapped/compatible IPv6; unrecognized → unsafe) |
| `parseNumericHost(host)` | fn | decimal/octal/hex and dotted-radix literal forms → canonical IPv4/IPv6, or `null` |
| `MAX_REDIRECTS` | const | `3` — the redirect budget of `safeFetch` |
| `setUrlSafetyPorts(ports)` | fn | host injection seam (see below) |

Deep imports (`@animastor/url-safety/src/...`) are intentionally not exported.

## Requirements

- Node.js >= 18 (global `fetch` for the default transport)
- No runtime dependencies — the only requires are `net` + a call-time
  `dns` (both node builtins).

## Installation

```bash
npm install @animastor/url-safety
```

## Package boundary (dependency injection)

The package contains **no `process.env`, no backend config, no Express, no
request objects, no filesystem**. The two host mechanisms — DNS resolution
and HTTP fetch — arrive only through the injected ports:

| Port | Signature | Runtime default (call-time) |
|---|---|---|
| `dnsResolver` | `(host, options) → Promise<lookup result>` | `require('dns').promises.lookup` |
| `fetchImpl` | `(url, init) → Promise<Response>` (must honor `redirect: 'manual'`) | `global.fetch` |

```js
const { setUrlSafetyPorts } = require('@animastor/url-safety');

// composition root — wire once, or omit entirely for the node defaults
setUrlSafetyPorts({
    dnsResolver: customLookup,   // optional
    fetchImpl: customFetch,      // optional
});
setUrlSafetyPorts();             // reset → runtime defaults (call-time)
```

Defaults are resolved **lazily at call time**, so hosts and test harnesses
can keep stubbing `dns.promises.lookup` / `global.fetch` exactly as before
the extraction.

## The operator exemption is explicit

SSRF is about **user-controlled** endpoints. An operator-configured endpoint
(e.g. a global env-configured AI fallback in the host) is trusted
configuration, not an SSRF surface — but the package never reads env itself.
The host passes the exemption explicitly:

```js
await safeFetch(url, { validatePublic: false }); // operator-controlled, trusted config
await safeFetch(url);                            // default: validatePublic = true
```

## Usage

```js
const { assertPublicEndpoint, safeFetch } = require('@animastor/url-safety');

// save-time validation of a user-supplied endpoint
const verdict = await assertPublicEndpoint('https://api.example.com/v1');
if (!verdict.ok) throw new Error(`endpoint rejected: ${verdict.reason}`);

// per-fetch validation — every redirect hop re-validated
const res = await safeFetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
});
// err.code === 'ENDPOINT_NOT_PUBLIC' when any hop points at a private address
```

The HTTP adapter (which endpoints count as user-controlled, error
sanitization toward clients) is **host-owned** — see the Animastor
repository (`backend/src/routes/settings-ai-routes.cjs`,
`backend/src/services/provider-gateway.js`) for the reference wiring.

## Security invariants (frozen — do not weaken)

1. Only `http:` / `https:` schemes pass; everything else is rejected.
2. Literal IPv4: `0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`,
   `169.254/16` (link-local + cloud metadata), `172.16/12`, `192.168/16`,
   `192.0.0/24` + `192.0.2/24` (TEST-NET-1), `198.18/15` (benchmarking),
   `198.51.100/24` (TEST-NET-2), `203.0.113/24` (TEST-NET-3),
   `224/4`+ (multicast/reserved); malformed octets → unsafe.
3. Literal IPv6: `::` (unspecified), `::1` (loopback), `fc00::/7` (ULA),
   `fe80::/10` (link-local), `ff00::/8` (multicast); IPv4-mapped
   (`::ffff:a.b.c.d`) and IPv4-compatible are classified by the embedded
   IPv4; unparseable → unsafe.
4. Alternative literal forms (`2130706433`, `0177.0.0.1`, `0x7f000001`,
   mixed radix) are canonicalized BEFORE classification.
5. Hostname DNS: ALL records must be public (one private A/AAAA record
   fails the check — round-robin cannot smuggle an internal address);
   resolution failure or empty answer → fail closed.
6. Redirects are followed manually with per-hop re-validation, capped at
   `MAX_REDIRECTS = 3`; a public endpoint redirecting to a private address
   is refused with `ENDPOINT_NOT_PUBLIC`.
7. The `validatePublic: false` exemption is an explicit host decision —
   never an implicit env/config read inside this package.

## Development (repository checkout)

```bash
npm install   # dev: mocha + chai (no runtime dependencies)
npm test      # security contract tests — no real network (injected ports)
```

License: MIT — see [LICENSE](./LICENSE).
