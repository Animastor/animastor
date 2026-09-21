# @animastor/auth

Animastor **Auth** — the identity / session / authorization domain of the
Animastor backend: registration (with guest→account **in-place workspace
conversion**), login/logout, server-side session and guest-identity
lifecycle, the canonical book-access decision layer, the frozen cookie
grammar (`animastor_sid` / `animastor_gid`) and the scrypt password
primitives.

**Status: EXTRACTED (0.1.0).** The domain physically lives in this package
(`src/`); the host backend consumes it only through the package entrypoint
(`backend/src/auth/index.cjs` — composition root over host ports). See
[`docs/architecture/auth-extraction-readiness-audit.md`](https://github.com/Animastor/animastor/blob/main/docs/architecture/auth-extraction-readiness-audit.md)
(physical extraction COMPLETE).

## Public API

The package exposes a single entrypoint — `require('@animastor/auth')`
returns exactly (frozen surface, pinned by guards):

| Export | Kind | Purpose |
|---|---|---|
| `createAuthService({ ports, config, logger? })` | factory | the auth lifecycle: `register`, `login`, `logout`, `resolveSession`, `resolveGuest`, `createGuest`, `touchGuestWorkspace`, `resolveDefaultWorkspace`, `bookAccessDecision`, config-bound cookie helpers |
| `decideBookAccess(identity, bookId, ports)` | async fn | the canonical authorization decision → `{ ok, status?, mode, workspace? }` |
| `authorizedWorkspace(identity, bookId, ports)` | async fn | workspace or `null`; throws `WorkspaceExpiredError` on 410 |
| `ANONYMOUS_WORKSPACE` | const | the pre-auth identity placeholder |
| `AuthError(status, message, reason)` | class | domain error carrying its own HTTP status + loggable reason |
| `WorkspaceExpiredError` | class | 410 `workspace_expired` sentinel |
| `DEFAULT_AUTH_CONFIG` | const | frozen historical defaults (TTLs, cookie names) |
| `normalizeAuthConfig(input)` | fn | config validation/normalization (strict charset — cookie-attribute injection impossible) |
| `normalizeCookieDomain(value)` | fn | domain validation for the optional `Domain=` attribute |
| `cookies` | namespace | `sessionCookieHeader`, `clearSessionCookieHeader`, `guestCookieHeader`, `clearGuestCookieHeader`, `parseCookieHeader`, `SESSION_COOKIE_NAME`, `GUEST_COOKIE_NAME`, `SESSION_TTL_MS` |
| `password` | namespace | scrypt `hashPassword`, `verifyPassword`, `validatePasswordPolicy` (constant-cost path when the stored hash is missing) |
| `assertAuthPorts(ports)` | fn | fail-fast runtime validation of the six repository ports |

Deep imports (`@animastor/auth/src/...`) are intentionally not exported.

## Requirements

- Node.js >= 20
- No runtime dependencies — the only external require is `node:crypto`.

## Installation

```bash
npm install @animastor/auth
```

## Package boundary

The package contains **no Express, no PostgreSQL, no `process.env`, no
filesystem, no worker-auth**. It installs and runs in any host that supplies
the ports below (validated by `assertAuthPorts`) and a config object:

| Port | Methods | Typical adapter |
|---|---|---|
| `ports.users` | `findByUsernameCanonical`, `findByEmail` | user repository |
| `ports.sessions` | `createSession`, `findByToken`, `revokeByToken` | session repository |
| `ports.guests` | `createGuest`, `findByToken`, `touchWorkspaceActivity`, `revokeByToken` | guest repository |
| `ports.workspaces` | `findById`, `checkBookAccess`, `getMembership`, `getWorkspaceIdForBook`, `findPersonalWorkspace`, `createWorkspace`, `renameWorkspace` | workspace repository |
| `ports.bookOwnership` | `resolveAccessWorkspace`, `getWorkspaceId` | book ownership resolver |
| `ports.registrationTx` | `registerUserWithWorkspace` | **unit-of-work** (one transaction: user + workspace + owner membership + guest conversion) |

The concrete PostgreSQL implementations stay host-side (in Animastor:
`backend/src/storage/postgres/repositories/` + `registration-tx.js`); the
token grammar contract is hash-only storage — raw tokens exist only in
cookies and function arguments.

## Usage

```js
const { createAuthService, assertAuthPorts, normalizeAuthConfig } = require('@animastor/auth');

const auth = createAuthService({
    ports: assertAuthPorts({
        users, sessions, guests, workspaces, bookOwnership, registrationTx,
    }),
    config: normalizeAuthConfig({
        cookieDomain: 'animastor.in',   // '' → host-only cookies
        sessionTtlMs: 30 * 24 * 3600e3, // all TTLs optional — frozen defaults
    }),
});

const { user, workspace, session } = await auth.login({ username, password });
const decision = await auth.bookAccessDecision(identity, bookId);
// → { ok, status?, mode: 'pre-auth'|'user'|'guest'|'expired'|'denied', workspace? }
```

The HTTP adapter (cookie transport, status mapping, guest auto-provisioning
policy) is **host-owned** — see the composition root in the Animastor
repository (`backend/src/middleware/auth-context.js` and
`backend/src/routes/auth-routes.cjs`) for the reference implementation.

## Security invariants (frozen)

1. scrypt `N=16384, r=8, p=1`, per-hash salt, `timingSafeEqual`, dummy
   derivation on missing hash;
2. unknown-user and wrong-password logins are indistinguishable (401,
   `login_invalid_credentials`);
3. token-hash-only storage; tokens never appear in API responses;
4. cookie attributes `Path=/; HttpOnly; SameSite=Lax; Max-Age=<TTL>` always,
   `Domain=` only from a strictly validated value;
5. the guest is never a fake user; expired workspaces keep resolving but
   every access answers 410;
6. guest→account conversion keeps the same `workspace_id` (zero book
   copying) and revokes the guest token;
7. ownership chain is always `identity → workspace → book`; cross-workspace
   access requires explicit membership; DB failure fails closed.

## Development (repository checkout)

```bash
npm install   # dev: mocha + chai (no runtime dependencies)
npm test      # 41 contract tests over in-memory ports — no PG, no Express
```

License: MIT — see [LICENSE](./LICENSE).
