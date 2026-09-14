# @animastor/orchestration

Generation orchestration and runtime contour of the Animastor backend,
physically extracted from the host (`backend/src/orchestration/**` +
`backend/src/runtime/**` — §32.30; recon:
`docs/architecture/generation-module-extraction-reconnaissance.md` §32.29).

The package owns:

- the orchestration facade (stage executor + FSM-safe scene writers)
- the dispatch engine and its lease/quota/retry managers
- the reconciliation engine and counter reconciliation
- scene window/scheduler/worker-health
- the runtime-result emitter/consumer
- the eight O-2…O-10 port contracts (Persistence, SceneData,
  PlaceholderAudio, ProgressEvents, AudioFsm, VideoFsm, HubCancel,
  LayerConfig)

## Dependency direction

```
backend host → @animastor/orchestration → ports / host-bindings / contracts
```

The package reaches the host (runtime config, Redis-domain state, media
facades, S-5 seam registry, artifact root, PW-2 workspace resolver)
**only** through the composition-root host-bindings seam — no
`backend/src` require, no storage/book/routes/services, no Redis, no PG,
no Express inside.

Runtime dependencies: `@animastor/contracts`, `@animastor/generation`,
`music-metadata`.

## Public API

```js
const orchestration = require('@animastor/orchestration');
```

| Export | Kind | Description |
|---|---|---|
| orchestration facade | lazy | stage executor + FSM scene writers (begin/plan/dispatch/complete/fail/rollback) |
| `createRuntimeResultConsumer` | eager | Phase-5 result-reporting consumer |
| `ports` | eager | `{ persistence, sceneData, placeholderAudio, progressEvents, audioFsm, videoFsm, hubCancel, layerConfig }` |
| `bindHostModules` | eager | composition-root binding surface |
| `hostBinding` | eager | host-binding accessor |
| `runtime` | lazy namespace | `{ scheduler, activeScenes, reconciliation, dispatch, leaseManager, counterReconciliation, metrics, workerHealth, sceneWindow, failureTaxonomy, runtimeResultEmitter }` |

Facade exports are **lazy getters** — the FSM-writer re-exports resolve
the `stateOps` host binding on access. `Object.defineProperties` on the
root prevents eager evaluation at `require()` time.

Deep imports (`@animastor/orchestration/runtime/…` etc.) are NOT part of
the public surface — the exports map exposes only `'.'`.

## Host responsibilities (composition root)

1. Call `bindHostModules(…)` to wire config/state/media/seams/artifact
   root/PW-2 resolver before accessing any lazy export.
2. Register `createRuntimeResultConsumer` via
   `runtimeResultEmitter.setConsumer(…)`.

Without host binding, lazy getters throw on first access. This is
intentional — the package is a pure domain contour until the composition
root wires it.

## Tests

```bash
npm test            # package-own suite (standalone, no backend required)
```

Backend-side guards: `backend/tests/architecture/physical-move-gate.test.js`
(PM-G suite) ensures the moved files are gone from `backend/src/runtime`
and the barrel is not consumed.
