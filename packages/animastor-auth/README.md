# @animastor/auth

The identity / session / authorization domain of the Animastor backend, physically extracted from the host as a standalone npm package.

The package owns:

- **`createAuthService({ ports, config, logger? })`** — the auth lifecycle over injected ports: `register` (with guest→account **in-place workspace conversion**), `login`, `logout`, `resolveSession`, `resolveGuest`, `createGuest`, `touchGuestWorkspace`, `resolveDefaultWorkspace` (legacy-name self-heal), and the guest TTL policy;
- **the canonical book-access decision layer** — `decideBookAccess(identity, bookId, ports)` → `{ ok, status?, mode, workspace? }` and `authorizedWorkspace` (workspace|null, `WorkspaceExpiredError` on 410). Pre-auth / user / guest / expired / denied semantics are frozen; failures fail closed;
- **the cookie grammar** — `animastor_sid` / `animastor_gid` Set-Cookie builders (`Path=/; HttpOnly; SameSite=Lax`, TTLs, optional validated `Domain`, caller-supplied `Secure`) and `parseCookieHeader`;
- **the config contract** — `normalizeAuthConfig` / `normalizeCookieDomain` with frozen historical defaults (strict charset validation makes cookie-attribute injection impossible);
- **the error contract** — `AuthError(status, message, reason)` and `WorkspaceExpiredError` (410 `workspace_expired`);
- **password primitives** — scrypt `hashPassword` / `verifyPassword` / `validatePasswordPolicy` with a constant-cost path when the stored hash is missing (timing-enumeration guard);
- **port contracts** — `assertAuthPorts` runtime validators (the `@animastor/assistant` `assertSessionRepo` pattern).

## Package boundary

The package has **zero runtime dependencies** (`node:crypto` only) and contains **no Express, no PostgreSQL, no `process.env`, no filesystem, no worker-auth**. It installs and runs in any host that supplies:

| Port | Methods | Typical adapter |
|---|---|---|
| `ports.users` | `findByUsernameCanonical`, `findByEmail` | user repository |
| `ports.sessions` | `createSession`, `findByToken`, `revokeByToken` | session repository |
| `ports.guests` | `createGuest`, `findByToken`, `touchWorkspaceActivity`, `revokeByToken` | guest repository |
| `ports.workspaces` | `findById`, `checkBookAccess`, `getMembership`, `getWorkspaceIdForBook`, `findPersonalWorkspace`, `createWorkspace`, `renameWorkspace` | workspace repository |
| `ports.bookOwnership` | `resolveAccessWorkspace`, `getWorkspaceId` | book ownership resolver |
| `ports.registrationTx` | `registerUserWithWorkspace` | **unit-of-work** (one transaction: user + workspace + owner membership + guest conversion) |

The concrete PostgreSQL implementations stay host-side (in Animastor: `backend/src/storage/postgres/repositories/` + `registration-tx.js`); the token grammar contract is hash-only storage — raw tokens exist only in cookies and function arguments.

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

The HTTP adapter (cookie transport, status mapping, guest auto-provisioning policy) is **host-owned** — see `backend/src/middleware/auth-context.js` and `backend/src/routes/auth-routes.cjs` for the reference implementation.

## Security invariants (frozen)

1. scrypt `N=16384, r=8, p=1`, per-hash salt, `timingSafeEqual`, dummy derivation on missing hash;
2. unknown-user and wrong-password logins are indistinguishable (401, `login_invalid_credentials`);
3. token-hash-only storage; tokens never appear in API responses;
4. cookie attributes `Path=/; HttpOnly; SameSite=Lax; Max-Age=<TTL>` always, `Domain=` only from a strictly validated value;
5. the guest is never a fake user; expired workspaces keep resolving but every access answers 410;
6. guest→account conversion keeps the same `workspace_id` (zero book copying) and revokes the guest token;
7. ownership chain is always `identity → workspace → book`; cross-workspace access requires explicit membership; DB failure fails closed.

## Development

```bash
npm install
npm test
```

License: MIT — see [LICENSE](./LICENSE).
