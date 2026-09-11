# @animastor/generation

The **Generation domain** of the Animastor backend, physically extracted from the host
(`backend/src/generation/**` — S-7; recon: `docs/architecture/generation-module-extraction-reconnaissance.md` §29).

The package owns the prepared Generation Core (S-1…S-6 seam work):

```
src/
├── index.js               ← single public entry point (lazy surface, zero side effects)
├── core/                  — lifecycle/domain contracts
│   ├── media-registry.js          media capability registry (S-2; self-bootstrapping)
│   ├── default-registrations.js   audio/image/video capability registrations (S-2)
│   ├── generation-progress.js     pure task-registry domain (S-4; no persistence)
│   ├── scene-state.js             pure per-asset FSM contract (S-4; no persistence)
│   └── artifact-naming.js         canonical artifact filename grammar (S-4, single owner)
├── providers/
│   └── comfyui-provider.js        the SINGLE Generation → ComfyUI/GPU seam (S-3):
│                                  workflow/connector knowledge, merged-dialogue
│                                  assembly, Job Protocol v2 dispatch
├── prompt-profiles/       — shared prompt-assembly domain (S-4)
│   ├── assembly-profile.js        profile resolver (ProfileStore port)
│   ├── character-utils.js         character reference resolvers
│   └── prompt-text-utils.js       pure text normalizers
├── ports/                 — the frozen S-6 host ports (the ONLY way out to the host)
│   ├── dispatch-transport.js      Generation → GPU transport (host binds gpu-dispatcher)
│   ├── generation-config.js       capability config slices (host binds runtime-config)
│   ├── profile-store.js           assembly profile file loading (host binds ai-loader)
│   └── book-data.js               book scene/appearance data (host binds book facade)
└── utils/                 — package-internal pure primitives (parity-guarded copies)
```

## Dependency boundary

- The package **never** requires `backend/src/**`, Redis, PostgreSQL, the filesystem,
  Express, runtime-config, VBook, Player, Editor, GPU Hub or the ComfyUI connector
  implementation outside `providers/` (guarded: `backend/tests/architecture/generation-package-boundary.test.js`, G7-A…G7-M).
- Runtime dependencies: `@animastor/contracts` (frozen Job Protocol v2) and
  `animastor-comfyui-workflow-connector` (consumed by `providers/` only).
- Host-specific concerns are injected through the four `ports/` at the composition
  root (`backend/src/backend.cjs`, mirrored for tests by `backend/tests/generation-test-bindings.cjs`).

## Public API (frozen — G7-G)

```js
const generation = require('@animastor/generation');

generation.artifactNaming;   // canonical artifact filename grammar (writer side)
generation.mediaRegistry;    // media capability registry + resolvers
generation.bootstrap();      // eager default media-type registration (S-2 startup entry)
generation.generationProgress; // pure task-registry domain logic
generation.sceneState;       // per-asset FSM contract (states/transitions/validation)
generation.comfyuiProvider;  // the S-3 provider seam (loadWorkflow/applyValue/generate/…)
generation.promptProfiles;   // { assemblyProfile, characterUtils, promptTextUtils }
generation.ports;            // { dispatchTransport, generationConfig, profileStore, bookData }
```

The root module is lazy and side-effect-free: `require('@animastor/generation')`
loads nothing and throws nothing; unwired ports fail fast only when used.
Deep imports (`@animastor/generation/core/…` etc.) are NOT part of the public
surface — the exports map exposes only `'.'`.

## Host responsibilities (composition root)

1. Bind the four ports (`ports.dispatchTransport.setDispatchTransport`, …) —
   `backend/src/backend.cjs` does this FIRST, before any generation module loads.
2. Call `generation.bootstrap()` to register the default audio/image/video capabilities.
3. Implement persistence (Redis/PG) host-side: `services/generation-progress.js`
   and `state/asset-state-store.js` are the host adapters over the pure
   `generationProgress` / `sceneState` domain in this package.

## Tests

```bash
npm test            # package-own suite (standalone, no backend required)
```

Backend-side guards: `backend/tests/architecture/generation-package-boundary.test.js` (G7-A…G7-M)
plus the S-2/S-3/S-4/S-5/S-6 suites, re-pointed to the package.
