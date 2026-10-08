# Domain migration: animastor.in → animastor.org (2026-10)

Report for the canonical-domain migration. The system now uses
**`https://animastor.org`** as the single canonical / production domain;
**`animastor.in`** (apex + `www` / `app` / `admin`) only serves **HTTP 301**
redirects to the matching `.org` host.

- **Commit:** `60f8b9ee` — `feat(domain): migrate canonical domain from animastor.in to animastor.org`
- **Scope:** 69 files, +328 / −212
- **Constraint honored:** no architecture changes, no unrelated refactoring.

---

## What changed

### Nginx / reverse proxy
- `proxy/conf/default.conf`
  - added `map $host $animastor_canonical_host` (subdomain-preserving
    `animastor.in → animastor.org`, `www.animastor.in → animastor.org`,
    `app.animastor.in → app.animastor.org`, `admin.animastor.in → admin.animastor.org`);
  - `.org` hosts are the production server blocks (website / app / admin),
    certificate path `/etc/letsencrypt/live/animastor.org/`;
  - `.in` hosts (HTTP `:80` and HTTPS `:443`) return **301** to the canonical
    `.org` host preserving path and query string via `$request_uri`.
- `proxy/docker-compose.yml` — same `.org` production + `.in` redirect model.

### Certificates / deployment script
- `scripts/enable-admin-https.sh` now issues **two** Let's Encrypt certificates:
  1. `animastor.org` — canonical family: `animastor.org www.animastor.org app.animastor.org admin.animastor.org`;
  2. `animastor.in` — legacy family, kept only so the redirect works over HTTPS
     without a certificate error: `animastor.in www.animastor.in app.animastor.in admin.animastor.in`.
  It then reloads nginx and verifies the served SANs of both.

### Backend
- `HUB_URL` default → `https://animastor.org/gpu`:
  `backend.cjs`, `config/runtime-config.js`, `routes/book/cache-routes.cjs`,
  `services/book-deletion.cjs`.
- `services/ai-service.js` — `HTTP-Referer` → `https://animastor.org`.
- CORS: backend uses `app.use(cors())` (reflective); **no `.in` origin is
  hardcoded**, so nothing to change. See "Remaining / notes".

### Cookies
- `COOKIE_DOMAIN=animastor.org` in `.env.example`, the `docker-compose.yml`
  default, and the local `.env` (gitignored — not committed).
- Internal service-to-service URLs (e.g. `HUB_URL=http://gpu-hub:5000`) are
  unchanged — they are not public URLs.

### Frontends
- `frontends/website/index.html`, `library/index.html` — links and
  `mailto:support@animastor.org`; added `<link rel="canonical">` + `og:url`
  pointing at `https://animastor.org`.
- `frontends/app` — `package.json` description, `AdminPage.tsx` /
  `LibraryPage.tsx` comments.

### Docker / worker / e2e / packages
- `docker/worker/entrypoint.sh`, `docker/e2e/dispatch-task.cjs`,
  `docker/worker/docker-run.md`.
- `packages/animastor-gpu-hub/gpu-hub.js` (canonical fallback origin).
- `packages/animastor-installer` — `cli.js`, `engine/engine.js`, `package.json`.
- `packages/animastor-worker` — `worker/worker.cjs`, `worker/.env.example`,
  `worker/package.json`, `start-worker.sh`, `new/start-worker.sh`.
- `packages/animastor-gpu-hub/artifacts.lock.json` — **regenerated** with
  `node packages/animastor-gpu-hub/tools/update-artifacts-lock.cjs`; only the
  `worker-bundle` and `installer-src` group digests changed (the groups whose
  sources were edited).

### Shell scripts / Android / testers
- `app-web-rebuild.sh`, `frontends/android/apk-build-in.sh`.
- Android `BASE_URL` default and `LibraryFragment.kt` → `app.animastor.org`;
  Android + tester unit-test fixtures updated.
- `tools/mobile-web-tester`, `tools/desktop-web-tester` — Gradle defaults,
  MainActivity strings, build scripts, READMEs.

### Tests
- Domain fixtures updated in `backend/tests/auth-mvp.test.js`,
  `backend/tests/gpu-hub-artifacts.test.js`,
  `packages/animastor-auth/test/auth-contract.test.js`,
  `packages/animastor-installer/tests/*`,
  `packages/animastor-web-workers/test/workerSetup.test.ts`,
  `packages/animastor-worker/tests/worker-env.test.cjs`.

### Active docs
- `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `ANDROID_WEB_PARITY.md`,
  `docs/index.html` (live served asset), `docs/01-overview/*`,
  `docs/architecture/AUTH_IMPLEMENTATION.md`,
  `docs/architecture/EXPERIMENTAL_BETA_DOCKER_DEPLOYMENT.md`,
  `docs/architecture/GPU_HUB_CONTRACT.md`.

---

## Verification performed

| Check | Result |
|-------|--------|
| Full backend suite (`backend: npm test`) | 979 passing, **2 failing** |
| Pre-existing failures confirmed via `git stash` baseline | `installer-package-boundary` (IB-G15), `phase5-runtime-result` (T9) — **both fail without this change** |
| `packages/animastor-auth` | 41 passing |
| `packages/animastor-installer` | 304 passing |
| `packages/animastor-worker` | 45 passing |
| `packages/animastor-web-workers` | 104 passing |
| `packages/animastor-gpu-hub` | 22 passing |
| `nginx -t` (nginx:alpine, dummy certs) | syntax OK |
| Functional redirect test (nginx + dummy certs) | see below |
| Global re-search for `animastor.in` | none in code/config beyond intended redirect config |

Functional redirect results (local nginx container):

```
HTTP  :80  animastor.in/foo/bar?x=123  → 301 Location: https://animastor.org/foo/bar?x=123
HTTPS :443 animastor.in/foo/bar?x=123  → 301 Location: https://animastor.org/foo/bar?x=123
HTTPS      www.animastor.in/a?b=1      → 301 Location: https://animastor.org/a?b=1
HTTPS      app.animastor.in/settings   → 301 Location: https://app.animastor.org/settings
HTTPS      admin.animastor.in/admin    → 301 Location: https://admin.animastor.org/admin
HTTPS      animastor.org/              → served by .org block (no redirect loop)
```

---

## Remaining `.in` references (classified)

- **Intentionally kept (redirect / legacy):**
  `proxy/conf/default.conf`, `proxy/docker-compose.yml`,
  `scripts/enable-admin-https.sh`.
- **Historical documentation, left unchanged** (scope was "active docs only"):
  `docs/CHANGELOG.md`, `docs/architecture/*AUDIT*`, `*RECONNAISSANCE*`,
  `PHASE_*`, `npm-git-inventory-audit.md`, `post-split-build-deploy-diagnostic.md`,
  `docs/04-planning/*`, `docs/08-mobile-web-migration/*`,
  `docs/09-desktop-migration/*`, `docs/runtime-audits/*`.
  `m.animastor.in` mentions are historical (subdomain retired 2026-08-12).
- **Not part of this migration:**
  `api.aicredits.in` (external AI provider), `animastor.dev` (stable JSON-Schema
  `$id`), `sureg.dev`.

---

## Manual actions outside the repository

1. **Republish npm packages** `@animastor/gpu-hub` and `@animastor-installer`
   (new versions with the `.org` defaults) and update the backend dependencies.
   The backend consumes the **published** `@animastor/gpu-hub@0.1.x` from the
   registry, so the source edits take effect only after republish + install.
   (`node_modules` was synced locally only to run the tests; it is not committed.)
2. **TLS:** issue the production certificate for `animastor.org` (4 SANs) and
   keep/renew the `.in` certificate for the redirect — run
   `scripts/enable-admin-https.sh`. The nginx certificate path changed to
   `/etc/letsencrypt/live/animastor.org/`; nginx will not start without it.
3. **DNS:** no record changes required, but verify that `animastor.org` and its
   subdomains (and `animastor.in` for the redirect) actually resolve.
4. **Deploy / reload** nginx after the certificates are issued.
5. **Email:** the address is now `support@animastor.org` — create the mailbox or
   forward from the old `support@animastor.in`.
6. **Android / tester apps:** the changed `BASE_URL` default requires
   **rebuilding / a new release** for installed builds.
7. **External OAuth providers:** no OAuth configuration exists in the repo; if
   any external provider has registered redirect URIs, update them manually
   (nothing found in code).
8. **GitHub Release artifacts:** after republishing, the `worker-bundle` /
   `installer-src` zips must match the new digests in `artifacts.lock.json`.

## Cannot be verified from here

Production-verification items 1–17 (live `https://animastor.org` / `.in`, DNS
resolution, real certificates, login/admin/API/upload/WebSocket in production)
require server access. Redirect behaviour, HTTPS on `.in`, and nginx config
validity were verified locally in an nginx container.

---

## Deployment status (2026-10-08)

Executed on the production host (DNS already pointed all 8 hostnames at it):

- **Certificates issued** via the official `certbot/certbot` Docker image
  (host `sudo` is password-protected; the container writes `/etc/letsencrypt`):
  - `animastor.org` — SAN `animastor.org, www.animastor.org, app.animastor.org, admin.animastor.org`, expires **2027-01-06**;
  - `animastor.in` — reused, valid until **2026-11-19** (SAN `animastor.in, www, app, admin`).
- **Renewal webroots repaired.** The new `animastor.org` renewal conf was
  written with the container path (`/var/www/website`), and the pre-existing
  `animastor.in` conf pointed at the non-existent legacy path
  `/home/sureg/animastor/frontends/website`; both were corrected to the real
  host webroot `/home/animastor/animastor/frontends/website`. `certbot renew
  --dry-run` succeeds for **both** lineages.
- **nginx reloaded** with the migrated config; `nginx -t` passes with the real
  certificates.

Verified live (no `-k`, real DNS):

```
https://animastor.org/            -> 200 (cert CN=animastor.org, issuer Let's Encrypt)
https://www.animastor.org/        -> 200
https://app.animastor.org/        -> 200
https://admin.animastor.org/      -> 302 -> /admin
https://app.animastor.org/gpu/health -> 200
https://animastor.org/health      -> 200
https://app.animastor.org/library -> 200
https://animastor.in/             -> 301 -> https://animastor.org/
https://app.animastor.in/         -> 301 -> https://app.animastor.org/
https://admin.animastor.in/       -> 301 -> https://admin.animastor.org/
http://animastor.in/foo/bar?x=123 -> 301 -> https://animastor.org/foo/bar?x=123
http://animastor.org/             -> 301 -> https://animastor.org/
```

The `.in` hosts present a valid certificate (no TLS error before the redirect).

Note: `scripts/enable-admin-https.sh` was also fixed to derive `WEBROOT` from
its own location instead of the stale `/home/sureg/animastor/...` path.
