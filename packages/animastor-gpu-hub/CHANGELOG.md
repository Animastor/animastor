# Changelog

## 0.1.2 (2026-10-10)

Canonical domain migration `animastor.in → animastor.org` (commit 60f8b9ee).
No API or protocol change — defaults only.

### Changed

- `gpu-hub.js` — the canonical fallback hub origin is now
  `https://animastor.org/gpu` (was `https://animastor.in/gpu`).

## 0.1.1 (2026-09-26)

Installer version resolution fix after the installer physical move
(`refactor(extraction): move installer to packages/animastor-installer`
97df4b7d). No API change.

### Fixed

- `gpu-hub.js` — the canonical installer version is now also resolved from
  `packages/animastor-installer/package.json` in a repository checkout: the
  container path (`installer-src/package.json`, baked by the Dockerfile)
  stays canonical first, the repo checkout is the dev fallback. Dev hub runs
  and container runs now report the same version source.
- `Dockerfile` — the artifact bake-in matches the new canonical layout.

## 0.1.0 (2026-09-14)

First release — standalone HTTP orchestration boundary between the Animastor
backend and GPU workers: job queue (Redis), task dispatch/result callbacks,
worker onboarding artifacts. Job Protocol v2 consumed from the canonical
`@animastor/contracts` package.
