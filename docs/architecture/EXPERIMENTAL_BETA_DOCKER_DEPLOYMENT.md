# Animastor — Experimental Beta Docker Deployment

**Date:** 2026-08-21  
**Status:** ACTIVE — deployment guide for fresh servers

---

## Overview

Animastor deploys via Docker Compose with six services:

| Service | Image / Build | Persistence | Restart |
|---------|--------------|-------------|---------|
| **postgres** | `postgres:16` | Named volume `pg-data` | `unless-stopped` |
| **redis** | `redis:7` | Named volume `redis-data` | `unless-stopped` |
| **backend** | `./backend` (build) | Bind mounts `./data/*` | `unless-stopped` |
| **gpu-hub** | `./gpu-hub` (build) | — | `unless-stopped` |
| **nginx** | `nginx:alpine` | Bind mounts for config + static content | `unless-stopped` |

---

## Prerequisites (Fresh Server)

**Minimum:** Ubuntu 22.04/24.04, Docker, Docker Compose v2.

No dependency on `/home/sureg/` or any personal filesystem paths.

### 1. Clone the repository

```bash
git clone <repo-url> /opt/animastor
cd /opt/animastor
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — fill in real values for:
#   POSTGRES_PASSWORD
#   WORKSPACE_SECRET_KEY (32+ random chars)
#   GPU_HUB_API_KEY
#   LETS_ENCRYPT_DIR (defaults to /etc/letsencrypt)
```

### 3. Obtain TLS certificates

Before starting the HTTPS nginx configuration, you must obtain certificates for your domains.

**Standard Let's Encrypt (production):**

```bash
# Install certbot
apt install certbot

# Obtain certificate (stop nginx on port 80 first if running)
certbot certonly --webroot -w /opt/animastor/frontends/website \
  -d animastor.in -d www.animastor.in -d app.animastor.in -d admin.animastor.in
```

**Alternative: place certificates manually**

If using a different CA or pre-provisioned certs, place them at:

```
/etc/letsencrypt/live/animastor.in/fullchain.pem
/etc/letsencrypt/live/animastor.in/privkey.pem
```

Or set `LETS_ENCRYPT_DIR` in `.env` to point to your certificate directory.

### 4. Start services

```bash
docker compose up -d
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `POSTGRES_PASSWORD` | PostgreSQL password (used by postgres + backend) |
| `WORKSPACE_SECRET_KEY` | AES-256-GCM key for encrypting per-workspace API keys (32+ random chars) |

### Optional (with defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `LETS_ENCRYPT_DIR` | `/etc/letsencrypt` | Host path to TLS certificates |
| `OPENROUTER_API_KEY` | _(empty)_ | Global AI provider key (fallback; workspaces can carry their own) |
| `GPU_HUB_API_KEY` | _(empty)_ | Shared secret for backend ↔ GPU Hub |
| `GPU_TIMEOUT` | `600000` | GPU task hard timeout in ms |

---

## Persistent Directories

These directories survive container restarts and must be backed up:

| Path | Content |
|------|---------|
| `pg-data` (named volume) | PostgreSQL database |
| `redis-data` (named volume) | Redis state |
| `./data/books` | Book source files |
| `./data/output` | Generated output |

**Do not** turn these into ephemeral container storage.

---

## TLS Configuration

- **Certificate directory:** configurable via `LETS_ENCRYPT_DIR` (default: `/etc/letsencrypt`)
- **Certificate paths inside nginx:** `/etc/letsencrypt/live/<domain>/fullchain.pem`
- **HTTPS behavior:** HTTP → HTTPS redirect is enforced. No self-signed certs, no disabled TLS.
- **ACME renewal:** webroot on `frontends/website` (ACME HTTP-01 challenge)

### Certificate Requirements

The following certificate files must exist before starting nginx:

```
$LETS_ENCRYPT_DIR/live/animastor.in/fullchain.pem
$LETS_ENCRYPT_DIR/live/animastor.in/privkey.pem
```

---

## Domain Routing

| Domain | Purpose | Auth |
|--------|---------|------|
| `animastor.in` / `www.animastor.in` | Public website, landing, docs, library | None |
| `app.animastor.in` | Web application (responsive SPA) | Basic Auth (except `/library`) |
| `admin.animastor.in` | Admin panel | Basic Auth |

### Basic Auth

Basic Auth is **preserved and enabled**. The Beta application at `app.animastor.in` is NOT publicly accessible.

Credentials are in `proxy/conf/.htpasswd`.

---

## Host Path Audit

After deployment, verify no personal paths remain in deployment config:

```
grep -r '/home/sureg/' docker-compose.yml proxy/ .env*
```

Expected result: no matches.

---

## What Changed (from pre-Beta)

| Before | After |
|--------|-------|
| `/home/sureg/net-disk:/net-disk:ro` | **Removed** — net-disk is no longer served |
| `/home/sureg/sureg-dev/site:/usr/share/nginx/sureg:ro` | **Removed** — sureg.dev is not part of the Animastor stack |
| `/etc/letsencrypt:/etc/letsencrypt:ro` | `${LETS_ENCRYPT_DIR:-/etc/letsencrypt}:/etc/letsencrypt:ro` |
| sureg.dev blocks in `default.conf` | **Removed** — nginx serves only animastor.in domains |

---

## Verification Checklist

- [ ] `docker compose config` succeeds
- [ ] `docker compose up -d` starts all services
- [ ] `curl -k https://app.animastor.in/health` returns 200
- [ ] Basic Auth prompts on `app.animastor.in`
- [ ] `/library` on `app.animastor.in` is accessible without auth
- [ ] `animastor.in` serves the public website
- [ ] No `/home/sureg/` references in deployment config
- [ ] Persistent data directories exist and are populated

---

## Non-Goals

This deployment guide does NOT cover:
- Kubernetes, Terraform, or infrastructure-as-code
- Redesigning nginx or Docker architecture
- Modifying AI provider, Admin, or Worker architecture
- Migrating existing production data
- Opening Beta to the public (Basic Auth remains enabled)
