# @animastor/installer

Self-contained CLI and library for Animastor Private GPU Worker setup,
verification, and management.

## Status

**Published.** The production source physically lives here
(`packages/animastor-installer/src/installer/`); the backend consumes it as
the `@animastor/installer` package (`file:` dependency), and the package is
published to npm as `@animastor/installer`.

## Structure

```
packages/animastor-installer/
├── package.json            @animastor/installer 0.1.0, Node >=20, zero runtime deps
├── src/installer/
│   ├── cli.js              CLI entry (detect/plan/install/verify/resume/uninstall)
│   ├── index.js            Public API entry (10 exports, incl. setupContract)
│   ├── setup-contract.js   Host-facing projection (UI-safe DTOs)
│   ├── engine/             Core runtime (installers, fetchers, state, workflows)
│   ├── platform/           Platform adapters (linux/windows, docker/native)
│   └── ...
├── ai/install-manifests/   Manifest profiles (MANIFEST_ROOT fallback, relative to __dirname)
└── tests/                  mocha/chai package tests (npm test)
```

`backend/ai/workflows` is a **shared host asset** (the backend runtime and the
generation package consume it) — it stays host-side and is NOT part of this
package. The installer reads workflows via manifest `repository_path`
candidates (repo root + tarball prefix), never package-locally.

## Public API

| Export | Purpose |
|---|---|
| `manifest` | Install manifest loading and validation |
| `resolver` | Compatibility resolver |
| `workflows` | Workflow artifact management |
| `downloads` | Download planning |
| `plan` | Install planning |
| `safety` | Safety rules |
| `verification` | Verification reports |
| `engine` | Install engine |
| `uninstaller` | Uninstall flows |
| `setupContract` | Host-facing setup contract (backend worker-setup routes) |

## CLI

`animastor-installer` (package `bin` → `src/installer/cli.js`).

## Manifest resolution (MANIFEST_ROOT contract)

1. `/app/artifacts/install-manifests` (baked container layout)
2. `packages/animastor-installer/ai/install-manifests` (repo-dev, resolved
   relative to `__dirname` — package-relative fallback, no env var)

## GPU Hub tarball contract (unchanged prefixes)

```
animastor-installer/src/installer/...
animastor-installer/ai/install-manifests/...
animastor-installer/backend/ai/workflows/...
animastor-installer/packages/animastor-worker/worker/...
```
