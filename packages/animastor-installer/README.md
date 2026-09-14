# @animastor/installer

Self-contained CLI and library for Animastor Private GPU Worker setup,
verification, and management.

## Status

**Pre-extraction skeleton.** The production source still lives at
`backend/src/installer/`. This package will be populated during the
physical extraction step.

## Structure (after extraction)

```
packages/animastor-installer/
├── package.json
├── src/installer/          ← git mv from backend/src/installer
│   ├── cli.js              CLI entry (detect/plan/install/verify/resume/uninstall)
│   ├── index.js            Public API entry
│   ├── setup-contract.js   Host-facing projection (UI-safe DTOs)
│   ├── engine/             Core runtime (installers, fetchers, state, workflows)
│   ├── platform/           Platform adapters (linux/windows, docker/native)
│   └── ...
├── ai/
│   └── install-manifests/  ← git mv from backend/ai/install-manifests
└── tests/                  ← git mv from backend/tests/installer-*.test.js
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
| `downloads` | Download planner |
| `plan` | Interactive install plan |
| `safety` | Safety rules and secret redaction |
| `verification` | Post-install verification reporting |
| `engine` | Core installation engine |
| `uninstaller` | Uninstall orchestration |
| `setupContract` | Host-facing UI projection (for backend routes) |

## CLI

```bash
animastor-installer detect     # Detect environment
animastor-installer plan       # Generate install plan
animastor-installer install    # Perform installation
animastor-installer verify     # Verify installation
animastor-installer resume     # Resume interrupted install
animastor-installer uninstall  # Remove installation
```

## Runtime Contract

- **Node >= 20** required
- **Zero npm dependencies** — only Node builtins (fs, path, os, crypto, child_process, readline)
- **MANIFEST_ROOT**: baked-in `/app/artifacts/install-manifests` (container) or `__dirname/../../ai/install-manifests` (package-relative fallback)
- **Tarball layout**: `animastor-installer/src/installer/{cli.js, ...}` + `ai/install-manifests/` + `backend/ai/workflows/`

## License

Proprietary — Animastor
