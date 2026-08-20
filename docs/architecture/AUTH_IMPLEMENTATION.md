# Authentication MVP — Implementation Note

**Status:** Implemented (commit follows Account & Workspace foundation + hardening)
**Date:** 2026-08-20
**Scope:** REGISTER + LOGIN + SESSION + LOGOUT + CURRENT USER + BASIC AUTHORIZATION INTEGRATION.
Explicitly NOT included: OAuth, passkeys, email verification, password reset,
recovery keys, workspace switcher, anonymous/guest workspaces, billing, RBAC.

---

## 1. What was built

### Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /api/v1/auth/register` | public | username + password (+ optional email) → user + personal workspace + owner membership + session |
| `POST /api/v1/auth/login` | public | username + password → session |
| `POST /api/v1/auth/logout` | public (cookie) | revoke session (idempotent), clear cookie |
| `GET /api/v1/auth/me` | public → `{authenticated:false}` when anonymous | current user + workspace |

### Password storage (`backend/src/auth/password.js`)

- `crypto.scrypt` (Node built-in; memory-hard, no native dependency).
- Format: `scrypt$N=16384,r=8,p=1$<salt.b64>$<hash.b64>` — self-describing,
  rehashable for a future Argon2id switch.
- Policy: length 8–512, no composition rules (deliberately minimal).
- `verifyPassword` uses `timingSafeEqual` and a dummy derivation for
  missing hashes (equalizes timing for unknown users).

### Sessions (`sessions` table, `backend/src/storage/postgres/repositories/session-repo.js`)

- Server-side in PostgreSQL (never Redis — PG is the identity source of truth).
- Cookie: `animastor_sid = sid.<session_id_b64url>.<secret_b64url>`,
  HttpOnly, SameSite=Lax, Secure over HTTPS (`X-Forwarded-Proto`,
  `NODE_ENV=production`). TTL 30 days.
- **Raw tokens never stored** — only SHA-256 of the secret
  (`token_hash`, indexed). Session id + hash are generated together (never
  drift); a leaked DB yields no usable tokens.
- Logout = revoke (idempotent). Expired/revoked rows purged every 6 h.
- Session cookie value never appears in logs, responses, or `/auth/me`.

### Username / email policy

- Username: trimmed; 2–32 chars; no whitespace; compared case-insensitively
  via DB-side unique index `lower(username)` (application pre-check only
  races — the index is authoritative). No hash-suffix generation.
- Email: optional, trim + lowercase; unique (NULL = unlimited accounts
  without email).

### Registration atomicity

Registration runs in **one** PG transaction: `users` INSERT →
`workspaces` INSERT → `workspace_members` INSERT (`owner`). Any failure
rolls everything back — a user can never exist without a workspace, nor a
workspace without its owner. The session is created only after COMMIT.

---

## 2. Auth context (`backend/src/middleware/auth-context.js`)

```text
request → cookie → sessions lookup (PG) → users → workspaces
                 → req.user = { userId, username, displayName }
                 → req.workspace = { id, name, type }  (personal/default ws)
```

- `authContext` is async now; no valid cookie ⇒ `req.user = null` and the
  request proceeds exactly as pre-auth (no global `requireAuth` anywhere).
- Transient PG failures during session lookup degrade to anonymous.
- `checkBookAccess`: pre-auth allows all (compat); authenticated requires
  workspace membership (`books.workspace_id` → `workspace_members`), with
  self-heal for rows created before ownership existed (never overwriting a
  concurrent/foreign workspace).

## 3. Authorization wiring (`backend/src/backend.cjs`)

Mounted before the route handlers:

- `/api/v1/book/:bookId/*` — ownership guard (exempt: `import`,
  `import-txt`, `import-text`, `load-vbook`, `blank` — creation paths).
- `/api/v1/scene/*`, `/api/v1/iu-image/*`, `/api/v1/preview/*` — guard.
- `/api/v1/chunk/:id/*` (status/storyboard/audio/image/video) — the target
  book comes from Redis, so it is checked in-handler after chunk load.
- `/api/v1/ai/*` — book resolved from query/body/session lookup, guarded
  pre-route (fail closed).
- `GET /api/v1/books` — workspace-filtered for authenticated callers
  (implemented in the foundation phase; now driven by a real `req.workspace`).
- **Import cross-tenant guards** (dedup + bundle re-import): a re-import may
  only return/touch a book the caller owns (`dedupOwnedByCaller`,
  `importBookAllowed`); raw disk-scan dedup is pre-auth only; a bundle whose
  id collides with a foreign book → 403; disk copy with unverifiable
  ownership (PG down) → 403 for authed callers.
- Rate limits: `/auth/login` 10/min, `/auth/register` 5/min (brute force).

**Pre-auth behaviour is fully preserved** — every guard is a no-op for
requests without a valid session; dev books belong to the seeded developer
workspace and keep working.

## 4. Frontend

- `state/authStore.ts` — signals over `/auth/me`; localStorage is never
  auth truth (cookie only).
- `features/auth/UserMenu.tsx` — user-circle button in header/toolbar
  (concept §19, left of Settings): `Anonymous` → Login/Create account;
  logged in → username + Personal workspace + Sign out. Minimal dialog,
  existing `.modal` design tokens (en+ru i18n).

## 5. Known follow-ups (next stages, by design)

1. Anonymous/temporary workspaces + "Keep my workspace" conversion
   (registration currently always creates a fresh workspace).
2. Workspace switcher (today: `req.workspace` = personal/default).
3. `/api/v1/debug/*`, `/api/v1/worker/*`, connectors/workflows/config are
   INTERNAL/dev endpoints left unguarded for dev compatibility.
4. Android still uses nginx Basic Auth — needs this flow later.
5. Recovery keys / password reset via optional email (schema already has
   `recovery_key_hash` column).
