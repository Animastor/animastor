# Experimental Beta Docker Deployment Audit

**Date:** 2026-08-21  
**Head:** `d8194e2f1ed4fc8b498f8b96fe0b357c570ad8c3`  
**Status:** AUDIT ONLY — no code modified  
**Auditor:** Buffy (Codebuff)

---

## Current Deployment Model

The production deployment is defined in `docker-compose.yml` with six services:

| Service | Image / Build | Persistence | Restart |
|---------|--------------|-------------|---------|
| **postgres** | `postgres:16` | Named volume `pg-data` | `unless-stopped` |
| **redis** | `redis:7` | Named volume `redis-data` | `unless-stopped` |
| **backend** | `./backend` (build) | Bind mounts `./data/*` | `unless-stopped` |
| **gpu-hub** | `./gpu-hub` (build) | — | `unless-stopped` |
| **nginx** | `nginx:alpine` | Bind mounts for config + static content | `unless-stopped` |

---

## Host-Specific Dependencies

### Path 1: `/home/sureg/net-disk` → `/net-disk:ro` (nginx)

| Attribute | Value |
|-----------|-------|
| **Service** | nginx |
| **Required at runtime?** | No — nginx will start with an empty directory |
| **Persistent app data?** | No |
| **Static frontend content?** | Partially — serves APK downloads and misc files |
| **Development artifact?** | Yes — developer convenience for APK distribution |
| **Runtime consumers** | None. Nginx `location /net-disk/` serves a directory listing (autoindex). The backend never reads from `/net-disk`. |
| **Used by** | `proxy/conf/default.conf` lines 121-132 (public site) and 245-256 (app site) — both `alias /net-disk/; autoindex on;` |
| **Code references** | Only in `default.conf`, `build-apk.sh` scripts (which `if [ -d /home/sureg/net-disk ]` before copying), and documentation |
| **Can be replaced by** | Named volume, relative project path (`./net-disk/`), or configurable env var (`NET_DISK_DIR`). Also: simply removed — the feature is non-essential for Beta. |
| **Fresh server impact** | **BLOCKER** — Docker will refuse to start nginx if this path doesn't exist |

### Path 2: `/home/sureg/sureg-dev/site` → `/usr/share/nginx/sureg:ro` (nginx)

| Attribute | Value |
|-----------|-------|
| **Service** | nginx |
| **Required at runtime?** | No — nginx will start with an empty directory |
| **Persistent app data?** | No |
| **Static frontend content?** | Yes — serves `sureg.dev` static site |
| **Development artifact?** | Yes — developer's personal domain site, entirely separate from Animastor |
| **Runtime consumers** | None. Nginx `server_name sureg.dev` serves the site. The backend never reads from this path. |
| **Used by** | `proxy/conf/default.conf` lines 388-428 — `sureg.dev` and `www.sureg.dev` server blocks |
| **Code references** | Only in `default.conf` |
| **Can be replaced by** | Named volume, relative project path (`./site/`), env var (`SUREG_SITE_DIR`), or removed entirely |
| **Fresh server impact** | **BLOCKER** — Docker will refuse to start nginx if this path doesn't exist |

### Path 3: `/etc/letsencrypt` → `/etc/letsencrypt:ro` (nginx)

| Attribute | Value |
|-----------|-------|
| **Service** | nginx |
| **Required at runtime?** | Yes — nginx needs SSL certificates for HTTPS |
| **Persistent app data?** | No — certificates are managed externally (Certbot/Let's Encrypt) |
| **Development artifact?** | No — production requirement |
| **Fresh server impact** | **BLOCKER** — Docker will refuse to start nginx if this path doesn't exist. On a fresh server, Certbot hasn't been run yet. |

---

## Persistent Data

### Must Survive (CRITICAL)

| Data | Current Mount | Survives `down`/`up`? | Survives `rm`? | Survives host reboot? |
|------|--------------|----------------------|-----------------|----------------------|
| PostgreSQL data | Named volume `pg-data` | ✅ Yes | ✅ Yes (named vol) | ✅ Yes |
| Redis data | Named volume `redis-data` | ✅ Yes | ✅ Yes (named vol) | ✅ Yes |
| Book snapshots | `./data/books` bind | ✅ Yes (host dir) | ✅ Yes (host dir) | ✅ Yes |
| Build output | `./data/output` bind | ✅ Yes (host dir) | ✅ Yes (host dir) | ✅ Yes |

### Safe (not critical)

| Data | Current Mount | Survives `down`/`up`? | Notes |
|------|--------------|----------------------|-------|
| Frontend source | `./frontends/app` | ✅ Yes (host dir) | Mounted read-only |
| Website source | `./frontends/website` | ✅ Yes (host dir) | Mounted read-only |
| Nginx config | `./proxy/conf/default.conf` | ✅ Yes (host dir) | Mounted read-only |
| Backend source | `./backend/src`, `./backend/ai`, `./backend/tests` | ✅ Yes (host dir) | Dev mounts — live code sync |
| Workflow config | `./workflow.json` | ✅ Yes (host dir) | Mounted read-only |

### Not persistent (safe to lose)

| Data | Mount | Notes |
|------|-------|-------|
| Net-disk files | `/home/sureg/net-disk` | APK distribution — can be rebuilt |
| Sureg site files | `/home/sureg/sureg-dev/site` | Separate domain — not part of Animastor |
| Cache | In-container (Redis only) | Redis is persistent; ephemeral keys are fine |

---

## Fresh Server Simulation

**Assumptions:** Ubuntu 22.04/24.04, Docker, Docker Compose plugin, repository cloned to `/opt/animastor`.

### Step 1: `docker compose config`

**Result: PASS** — `docker compose config` succeeds because:
- Relative paths (`./backend`, `./data/*`, etc.) resolve against the project directory ✅
- `${POSTGRES_PASSWORD:?...}` etc. resolve if `.env` exists ✅
- **No path validation** — Docker Compose does not check that bind mount source paths exist at `config` time

### Step 2: `docker compose up`

**Result: FAIL**

```
Error response from daemon: Bind mount failed: '/home/sureg/net-disk' does not exist
Error response from daemon: Bind mount failed: '/home/sureg/sureg-dev/site' does not exist
Error response from daemon: Bind mount failed: '/etc/letsencrypt' does not exist
```

Docker validates bind mount source paths at container creation time (not `config` time). All three absolute host paths must exist before any container can start.

### First Failure

**First failure:** `nginx` service fails to start because `/home/sureg/net-disk` does not exist.

Because nginx `depends_on: backend`, and backend `depends_on: postgres` + `redis`, the dependency graph means nginx is the **last** container to attempt creation. However, Docker Compose starts services in dependency order — postgres and redis would start first, then backend, then nginx. The nginx failure occurs at the very end of the startup sequence.

**Critical nuance:** The three missing absolute paths (`/home/sureg/net-disk`, `/home/sureg/sureg-dev/site`, `/etc/letsencrypt`) are all in the nginx volume list. Docker validates **all** bind mount sources before starting any container. If even one is missing, the nginx container fails to start. In practice, all three will be missing on a fresh server, so the **first visible error** is whichever path Docker checks first — typically the one at the bottom of the volume list.

---

## Path-by-Path Analysis

### All docker-compose.yml Volumes

| # | Mount | Service | Classification | Notes |
|---|-------|---------|---------------|-------|
| 1 | `pg-data:/var/lib/postgresql/data` | postgres | PORTABLE, PRODUCTION-REQUIRED | Named volume — fully portable |
| 2 | `redis-data:/data` | redis | PORTABLE, PRODUCTION-REQUIRED | Named volume — fully portable |
| 3 | `./workflow.json:/workflow.json:ro` | backend | PORTABLE, REQUIRED | Relative path — resolves from project root |
| 4 | `./data/output:/data/output` | backend | PORTABLE, PRODUCTION-REQUIRED | Relative path — bind mount to host dir |
| 5 | `./data/books:/data/books` | backend | PORTABLE, PRODUCTION-REQUIRED | Relative path — bind mount to host dir |
| 6 | `./backend/ai:/app/ai` | backend | PORTABLE, DEV-ONLY | Live code mount for development |
| 7 | `./backend/src:/app/src` | backend | PORTABLE, DEV-ONLY | Live code mount for development |
| 8 | `./backend/tests:/app/tests` | backend | PORTABLE, DEV-ONLY | Live code mount for development |
| 9 | `./worker/worker/worker.cjs:/app/worker-source/worker.cjs:ro` | gpu-hub | PORTABLE, OPTIONAL | Worker self-contained file |
| 10 | `./proxy/conf/default.conf:/etc/nginx/conf.d/default.conf:ro` | nginx | PORTABLE, REQUIRED | Relative path — resolves from project root |
| 11 | `/etc/letsencrypt:/etc/letsencrypt:ro` | nginx | **HOST-SPECIFIC**, PRODUCTION-REQUIRED | Absolute host path — must exist |
| 12 | `/home/sureg/net-disk:/net-disk:ro` | nginx | **HOST-SPECIFIC**, OPTIONAL | Developer convenience — non-essential |
| 13 | `/home/sureg/sureg-dev/site:/usr/share/nginx/sureg:ro` | nginx | **HOST-SPECIFIC**, OPTIONAL | Developer's personal domain site |
| 14 | `./frontends/website:/usr/share/nginx/frontends/website:ro` | nginx | PORTABLE, REQUIRED | Relative path — resolves from project root |
| 15 | `./frontends/app:/usr/share/nginx/frontends/app:ro` | nginx | PORTABLE, REQUIRED | Relative path — resolves from project root |
| 16 | `./proxy/conf/.htpasswd:/etc/nginx/.htpasswd:ro` | nginx | PORTABLE, REQUIRED | Relative path — resolves from project root |

### Summary by Classification

| Classification | Count | Items |
|---------------|-------|-------|
| **PORTABLE + REQUIRED** | 8 | Volumes 1-2, 3-5, 10, 14-16 |
| **HOST-SPECIFIC + PRODUCTION-REQUIRED** | 1 | Volume 11 (`/etc/letsencrypt`) |
| **HOST-SPECIFIC + OPTIONAL** | 2 | Volumes 12-13 (`net-disk`, `sureg-dev/site`) |
| **DEV-ONLY** | 3 | Volumes 6-8 (`backend/src`, `backend/ai`, `backend/tests`) |
| **PORTABLE + OPTIONAL** | 1 | Volume 9 (`worker.cjs`) |

---

## Path Details

### `/home/sureg/net-disk` — Net Disk (APK Distribution)

**Purpose:** Serves APK files and miscellaneous downloads via nginx autoindex at `/net-disk/`.

**Why it exists:** The developer distributes test APK builds (mobile-web-tester, desktop-web-tester) to tablets via `https://animastor.in/net-disk/mobile-web-tester.apk`. The `build-apk.sh` scripts copy APKs here after building.

**Runtime dependency chain:**
```
nginx → /net-disk/ (alias) → autoindex → serves directory listing
```

The backend never reads from `/net-disk`. No backend code references this path. The GPU hub doesn't use it. Only nginx serves it.

**Can this become a named volume?**
**Yes, trivially.** The data is static APK files that can be recreated from the build scripts. There is no persistent state here that must survive across containers. Options:
- Named volume: `net-disk-data:/net-disk:ro`
- Relative path: `./net-disk:/net-disk:ro`
- Env var: `${NET_DISK_DIR:-./net-disk}:/net-disk:ro`

**Can it be removed?**
Yes. The `/net-disk/` nginx location blocks can be removed entirely without affecting core functionality. The Beta doesn't need APK distribution. This is the simplest option.

### `/home/sureg/sureg-dev/site` — Sureg.dev Static Site

**Purpose:** Serves the `sureg.dev` domain via nginx.

**Why it exists:** The developer hosts a personal/development website at `sureg.dev` and `www.sureg.dev`. The nginx config has dedicated server blocks (lines 383-428) for this domain.

**Runtime dependency chain:**
```
nginx → server_name sureg.dev → root /usr/share/nginx/sureg → serves static files
```

**Relationship to Animastor:** None. This is a completely separate domain served from the same nginx container. The backend, GPU hub, and all Animastor application code do not reference this domain or its content.

**Can this become a named volume?**
Yes. But more importantly: **it should not be required for Animastor deployment.** A new operator deploying Animastor has no reason to host `sureg.dev`.

**Can it be removed?**
Yes. The `sureg.dev` server blocks in `default.conf` can be removed (or made conditional via env var). This is non-core infrastructure.

### `/etc/letsencrypt` — SSL Certificates

**Purpose:** Provides SSL certificates for `animastor.in`, `sureg.dev`, and other domains.

**Why it exists:** Production TLS termination. The nginx config references:
- `/etc/letsencrypt/live/animastor.in/fullchain.pem`
- `/etc/letsencrypt/live/animastor.in/privkey.pem`
- `/etc/letsencrypt/live/sureg.dev/fullchain.pem`
- `/etc/letsencrypt/live/sureg.dev/privkey.pem`

**Fresh server problem:** On a fresh server, Certbot hasn't been run, so no certificates exist. The directory itself may not exist.

**Can this become a named volume?**
No — Let's Encrypt certificates are issued to specific domains and must be managed by Certbot or another ACME client. A named volume would be empty on first run.

**Minimal fix:** The operator must create the directory before first `docker compose up`:
```bash
mkdir -p /etc/letsencrypt/live/animastor.in
```
Or the compose file can use `:delegated` / check for existence. The most practical approach is to document this as an operator prerequisite.

---

## Minimal Fix Options

### Option A: Named Docker Volumes

For each host-specific path, use a named volume:

| Path | Proposed | Migration |
|------|----------|-----------|
| `/home/sureg/net-disk` | `net-disk-data:/net-disk:ro` | None — volume starts empty |
| `/home/sureg/sureg-dev/site` | Remove entirely or `sureg-site:/usr/share/nginx/sureg:ro` | Remove sureg.dev server blocks from `default.conf` |
| `/etc/letsencrypt` | `letsencrypt-certs:/etc/letsencrypt:ro` | Operator must populate volume after Certbot |

**Pros:** Fully portable — `docker compose up` works with zero host path knowledge.  
**Cons:** Named volumes are opaque — harder to manage SSL certs. Volume must be populated externally.

### Option B: Relative Project Paths

For non-critical paths, use relative project directories:

| Path | Proposed | Migration |
|------|----------|-----------|
| `/home/sureg/net-disk` | `./net-disk:/net-disk:ro` | Create `./net-disk/` in project root |
| `/home/sureg/sureg-dev/site` | Remove or `./site:/usr/share/nginx/sureg:ro` | Remove sureg.dev server blocks |
| `/etc/letsencrypt` | Keep as env var `${LETS_ENCRYPT_DIR:-/etc/letsencrypt}:/etc/letsencrypt:ro` | Operator creates dir or sets env var |

**Pros:** Simple, visible, Docker-friendly.  
**Cons:** Relative path for SSL certs is fragile.

### Option C: Configurable Host Paths (Env Vars)

Make all host-specific paths configurable via `.env`:

```yaml
- ${NET_DISK_DIR:-./net-disk}:/net-disk:ro
- ${SUREG_SITE_DIR:-./sureg-site}:/usr/share/nginx/sureg:ro
- ${LETS_ENCRYPT_DIR:-/etc/letsencrypt}:/etc/letsencrypt:ro
```

**Pros:** Operator controls paths. Default values work on fresh server.  
**Cons:** Still requires `.env` configuration. More moving parts.

### Option D: Hybrid (Recommended)

| Path | Proposed | Rationale |
|------|----------|-----------|
| `/home/sureg/net-disk` | Remove mount entirely + remove `/net-disk/` nginx blocks | Non-essential for Beta. APK distribution is developer tooling. |
| `/home/sureg/sureg-dev/site` | Remove mount entirely + remove `sureg.dev` nginx blocks | Not part of Animastor. Separate domain. |
| `/etc/letsencrypt` | `${LETS_ENCRYPT_DIR:?Set LETS_ENCRYPT_DIR}:/etc/letsencrypt:ro` | Required but operator must provide path. Env var with `:?` gives clear error. |

**Migration concern:** LOW. Removing net-disk and sureg.dev blocks doesn't affect any Animastor functionality. The `/etc/letsencrypt` env var is a one-line `.env` addition.

---

## Recommended Minimal Fix

**Hybrid approach (Option D)** with these changes:

1. **Remove** `/home/sureg/net-disk:/net-disk:ro` from nginx volumes
2. **Remove** `/home/sureg/sureg-dev/site:/usr/share/nginx/sureg:ro` from nginx volumes  
3. **Replace** `/etc/letsencrypt:/etc/letsencrypt:ro` with `${LETS_ENCRYPT_DIR:-/etc/letsencrypt}:/etc/letsencrypt:ro`
4. **Remove** `/net-disk/` location blocks from `proxy/conf/default.conf` (both public and app server blocks)
5. **Remove** `sureg.dev` server blocks from `proxy/conf/default.conf`
6. **Create** `./net-disk/` directory (or `.gitkeep`) for APK distribution if the feature is desired later
7. **Document** in README: operator must set `LETS_ENCRYPT_DIR` in `.env` or run Certbot before first start

**Alternative (simpler):** If the sureg.dev and net-disk features are not needed for Beta, just remove the mounts and the nginx blocks. Keep `/etc/letsencrypt` as-is with a README note that operators must `mkdir -p /etc/letsencrypt` on fresh servers.

---

## Migration / Data Risks

| Risk | Severity | Details |
|------|----------|---------|
| Remove net-disk mount | **NONE** | No persistent data. APK files are build artifacts. |
| Remove sureg.dev site | **NONE** | Not part of Animastor. Separate domain entirely. |
| Change /etc/encrypt to env var | **NONE** | Same mount, just configurable path. Existing deployments set `LETS_ENCRYPT_DIR=/etc/letsencrypt` and behavior is identical. |
| Named volume for pg-data | **N/A** | Already a named volume. No change needed. |
| Named volume for redis-data | **N/A** | Already a named volume. No change needed. |
| data/books, data/output | **N/A** | Already relative paths. No change needed. |

**Overall migration risk: LOW** — All changes are to nginx infrastructure mounts that are either non-essential (net-disk, sureg.dev) or need only a trivial `.env` addition (`LETS_ENCRYPT_DIR`).

---

## Beta Deployment Contract

After the fix, a new operator needs:

```
1. Repository
   git clone https://github.com/... /opt/animastor

2. .env file
   cp .env.example .env
   # Fill in: POSTGRES_PASSWORD, WORKSPACE_SECRET_KEY, OPENROUTER_API_KEY
   # Optional: GPU_HUB_API_KEY, GPU_TIMEOUT, LETS_ENCRYPT_DIR

3. SSL certificates (production)
   # Run Certbot to generate certificates for animastor.in
   # Set LETS_ENCRYPT_DIR=/etc/letsencrypt in .env

4. Docker + Docker Compose
   docker compose up -d

5. Application starts
   postgres, redis, backend, gpu-hub, nginx — all healthy

6. Persistent data works
   Books in ./data/books survive restart
   Build output in ./data/output survives restart
   PostgreSQL data in pg-data volume survives restart
   Redis data in redis-data volume survives restart

7. App survives restart
   docker compose down && docker compose up -d → everything recovers
```

**What operators should NOT need:**
- Knowledge of `/home/sureg/...`
- Developer filesystem layout
- Internal development paths
- The `sureg.dev` domain
- The `net-disk` directory

---

## Security (Host Mount-Related)

| Mount | Exposure | Severity |
|-------|----------|----------|
| `/home/sureg/net-disk` | Nginx can read the developer's net-disk directory. If sensitive files were placed there, they'd be exposed inside the container. | LOW (mount is `:ro`) |
| `/home/sureg/sureg-dev/site` | Nginx can read the developer's site directory. Same concern. | LOW (mount is `:ro`) |
| `/etc/letsencrypt` | Contains **private SSL keys**. Mounted read-only, but any container with access can read them. Currently only nginx has this mount. | MEDIUM — private keys should be as restricted as possible |
| `./backend/src` | Live code mount — backend container sees host source directory. | LOW (development mount, not production concern) |

**No Docker socket exposure.** No credential file exposure through mounts. No root filesystem exposure (mounts are specific paths, not `/`).

---

## Out of Scope

- Android-specific `docker-compose.yml` at `frontends/android/docker-compose.yml` (separate Compose file, not part of main deployment)
- ComfyUI configuration (runs on separate GPU machine, not part of main deployment)
- Kubernetes / Helm / Terraform deployment
- CI/CD pipeline deployment
- Cloud infrastructure provisioning
- Nginx security hardening beyond portability concerns

---

## Final Verdict

### **PORTABLE WITH OPERATOR SETUP**

**First blocker:** Three absolute host paths (`/home/sureg/net-disk`, `/home/sureg/sureg-dev/site`, `/etc/letsencrypt`) in the nginx volume list prevent `docker compose up` on any server that isn't the original developer's machine.

**Minimal fix:** Remove the two non-essential absolute paths (net-disk, sureg-dev/site) and their nginx blocks; make `/etc/letsencrypt` configurable via env var or document the prerequisite.

**Migration risk:** LOW — no persistent application data is affected; only nginx infrastructure mounts change.

---

*Audit completed. No files modified. This is reconnaissance only.*
