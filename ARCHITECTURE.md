# Animastor — Architecture Map

One page: domain map and repository layout. For humans and AI coders.

## Domains (Production)

| Domain              | What it serves                                                                 | Auth |
|---------------------|----------------------------------------------------------------------------|------|
| `animastor.in`     | **Public site**: beta portal, `/docs/` (markdown tree), public Library, login/registration | none |
| `app.animastor.in` | **Web application** — responsive: `MobileShell` / `DesktopShell`             | Basic Auth, except `/library` |
| `admin.animastor.in` | **Admin** — same SPA dist, root → `/admin`                            | Basic Auth + backend `requireAdmin` |

The public site and application share **one backend and one authentication
system** (`/api/v1/auth/*`): session is an HttpOnly cookie
`animastor_sid` with `Domain=animastor.in` (env `COOKIE_DOMAIN`), so
logging in on `animastor.in` also works on `app.animastor.in`. Admin is not
mentioned in the public site navigation.

Rule: **hostname determines the application, viewport determines the presentation**.
One frontend, one API, shared stores. Layout depends solely on viewport width:

```
< 1180px  → MobileShell   (bottom tab bar: File/Generator/Player/Editor/Navigator)
>= 1180px → DesktopShell  (header Generator/Player/Editor + left/right panels)
```

## Repository Layout

```
frontends/
├── website/          ← animastor.in — public site (static + public /library)
├── app/              ← app.animastor.in — responsive web application (Preact)
│   └── src/
│       ├── layouts/  ←   MobileShell / DesktopShell
│       ├── pages/    ←   File, Generator, Player, Editor, Navigator, Settings…
│       ├── components/
│       ├── stores/   ←   shared stores for all views
│       ├── api/      ←   /api/v1 (relative base — hostname not hardcoded)
│       └── styles/
└── android/          ← Android application (Kotlin, Gradle)

backend/              ← API server + generation orchestration (Node.js, Docker)
worker/               ← GPU workers (ComfyUI + Node.js)
gpu-hub/              ← GPU queue dispatcher
proxy/                ← nginx: domains, Basic Auth, reverse proxy (proxy/conf/default.conf)
tools/                ← tablet/mobile/desktop testers (mobile-web-tester, desktop-web-tester)
docs/                 ← detailed documentation (by migration phases and subsystems)
```

## Key Facts

- `app.animastor.in` is the single application endpoint. `/library` on it is
  the only public route (nginx `location = /library`, auth off, content from
  the public site). SPA history routes (`/file`, `/generate`, `/play`, `/edit`,
  `/navigate`, `/settings`) are behind Basic Auth (same `proxy/conf/.htpasswd`).
- API: `/api/v1` → backend:3000, `/gpu` → gpu-hub:5000 — on both domains.
- Basic Auth at this stage is the existing Nginx authorization; there is no
  separate authorization system.
- SSL: Let's Encrypt — one certificate covering the entire family: `animastor.in,
  app.animastor.in, www.animastor.in` (SANs updated 2026-08-12;
  `m.animastor.in` has been retired). Renewal — webroot on
  `frontends/website` (ACME HTTP-01, `certbot.timer` daily), verified
  `--dry-run` — success.
- TLS certificates: configurable via `LETS_ENCRYPT_DIR` env var (default: `/etc/letsencrypt`).
  See `docs/architecture/EXPERIMENTAL_BETA_DOCKER_DEPLOYMENT.md`.
