# C21.4 — Physical Extraction of Analysis from Backend

**Status:** IMPLEMENTED. The transitional seam is removed. All semantic analyzers physically live in `@animastor/ai-analysis`.
**Date:** 2026-09-09
**Baseline:** C21.3 (`8118f766`)
**Predecessors:** C18 (functional decomposition), C19 (structure-analyzer), C20 (character-analyzer), C21 (contour extraction), C21.1 (package separation), C21.2 (generic execute()), C21.3 (hardened lifecycle)

---

## 1. What changed (C21.2 → C21.3)

C21.2 introduced the generic `execute()` but its error lifecycle had gaps found by the C21.3 audit:

| Gap in C21.2 | Fix in C21.3 |
|---|---|
| `buildMessages` ran OUTSIDE the try/catch — a prompt-assembly throw left the PG step dangling (created, neither completed nor failed) | `buildMessages` moved inside the guarded region: `createStep → try { buildMessages → callAI → normalize → log → complete } catch { failStep → onError/rethrow }` |
| `failStep` was called unshielded — a failing failStep (PG down) masked the original task error | failStep is wrapped in its own try/catch: the original error is always preserved; the failStep failure is logged, never re-thrown over it |
| `onError(err, step, ports)` had no access to `input` — tasks re-wrapped the task object with closures to close over input (units, structure) | Contract extended: `onError(err, step, ports, input)`. The closure re-wrapping (`taskWithInput`) is deleted; guards forbid it |
| Tasks re-declared the default as `onError(err) { throw err; }` (redundant, misleading) | Redundant declarations removed; a guard forbids re-declaring the built-in default |
| Header docs promised "structured JSON → validation" as if the core owned a generic validation hook — no such hook existed | False promise removed: **validation is task-owned** (lives in `normalize`; a throw there is treated exactly like an AI failure). The core defines no semantic schema and never will |

## 2. The execute() lifecycle (final contract)

```
PRE-STEP (no PG step exists — an error propagates as-is, failStep NOT called):
  1. assertHostPorts        (fail-closed)
  2. progressMessage        (resolve from ports)
  3. progress + updateSession
  4. createStep

POST-STEP (one shared guarded region; failStep runs AT MOST ONCE):
  5. buildMessages          (task-specific)
  6. callAI                 (injected seam)
  7. normalize              (task-owned validation + post-processing)
  8. logConversation
  9. completeStep
 10. return result

On ANY error in 5–9:
  a. failStep(step_id, failMessage(err) || err.message) — shielded
  b. onError(err, step, ports, input) if defined → its return value becomes the result
     otherwise → rethrow err
```

### Why the pre-step/post-step split?

Before `createStep` succeeds there is no step row to fail. Port validation, progress, and session updates therefore propagate their errors as-is — a misconfigured host fails loudly and immediately. After `createStep`, every failure (task bug, transport, validation, logging, completion) goes through the single shared path, so a step is never left in a non-terminal state and degradation rules always see the same error surface.

### Task definition contract

| Field | Required | Description |
|---|---|---|
| `requiredPorts` | yes | Port names this task needs |
| `taskName` | yes | e.g. `'ai-agent/locations'` (used in error messages) |
| `stage` | yes | Progress stage key |
| `progressMessage` | yes | `(ports) => string` — resolve progress text from ports |
| `stepType` | yes | PG step type, e.g. `'analyze_locations'` |
| `buildMessages` | yes | `(input, ports) => { messages, options? }` — build AI request |
| `normalize` | no | `(result, input, ports) => any` — **task-owned validation + post-processing**; throwing here is treated exactly like an AI failure |
| `failMessage` | no | `(err) => string` — custom failStep message (default: `err.message`) |
| `onError` | no | `(err, step, ports, input) => any` — custom degradation (default: rethrow) |

### Validation boundary (explicit)

The core provides NO `validate` hook. Validation is a semantic concern:
- shape checks ("must return scenes") live in the task's `normalize` (throw = failure);
- task schemas never enter the core — a core that knows "scenes" is a broken core.

## 3. What's in Core vs. Semantic

### @animastor/ai-agent (Core) — MECHANISM
- `execute()` — the generic lifecycle (progress, step, LLM call ordering, error/degradation dispatch)
- `assertHostPorts()` — fail-closed port validation
- Zero dependencies, zero domain knowledge, zero I/O

The core NEVER imports/knows: ai-analysis, backend host, concrete analyzers, prompts/rules/skills, providers, PG/Redis/fs, TTS/audio/image/video, pipeline orchestration. (Enforced by Guard 8, C21.3.)

### @animastor/ai-analysis (Semantic Layer) — SEMANTICS
- Task definitions: buildMessages (prompt assembly), normalize (validation), onError/failMessage (degradation)
- C19/C20 analyzer modules (physically in backend/src/services, wired through the analysis seam)
- Context builders

Degradation stays task-specific: locations/scenes/characters throw (runner owns recovery), units returns a fallback unit, structure returns the deterministic map, voices keeps existing voices. The core only provides the hook.

## 4. Task adoption status

| Task | Uses execute() | Degradation |
|---|---|---|
| locations | ✅ | default rethrow |
| scenes | ✅ | normalize throws on empty → default rethrow |
| units | ✅ | onError fallback unit + failMessage prefix |
| structure-analyzer | ✅ | onError deterministic fallback |
| character-analyzer | ✅ | default rethrow |
| voices | ❌ manual lifecycle | pre-check skip (no viable chars → return before step creation); failStep + keep existing voices |

**voices** stays manual intentionally: it can decide to skip BEFORE creating a step. This is the documented pre-check pattern for tasks whose step creation is conditional.

## 5. The ai-analysis → backend seam (C21.4: COMPLETED)

The transitional seam has been **physically removed** in C21.4:

- `backend/src/services/structure-analyzer/` → `packages/animastor-ai-analysis/src/tasks/structure-analyzer/`
- `backend/src/services/character-analyzer/` → `packages/animastor-ai-analysis/src/tasks/character-analyzer/`
- `backend/src/services/structure-detector-deterministic.js` → `packages/animastor-ai-analysis/src/tasks/structure-detector-deterministic.js`

The two `../../../backend` cross-requires in `packages/animastor-ai-analysis/src/index.js` are deleted. The analysis package now imports only from its own task directories and from `@animastor/ai-agent`.

The backend compatibility barrel (`backend/src/services/structure-detector.js`) now requires from `@animastor/ai-analysis/tasks/structure-analyzer` instead of the local path.

**Final dependency direction (enforced by guards):**
```
@animastor/ai-agent
        ↑
@animastor/ai-analysis
        ↑
backend (host)
```

No reverse dependency: `@animastor/ai-analysis` does NOT import `backend/src`. `@animastor/ai-agent` does NOT import either.

## 6. Architecture guards (C21.3/C21.4)

### C21.3 guards (lifecycle hardening):
- `buildMessages` is inside the guarded try region (static order check)
- `_ports.failStep(` is called exactly once in execute.js, and is shielded (own try/catch, "original error kept" log path)
- `onError` is invoked with the 4-arg contract `(err, step, _ports, input)`
- No semantic validate hook in the core; core code (comment-stripped) never mentions locations/scenes/units/characters/structure/voices
- Core files require NOTHING external (zero-dep mechanism)
- Core never touches PG/Redis/fs/fetch/ai-service/ai-caller/providers/TTS/audio/image/video (comment-stripped scan)
- Tasks must not re-declare the default rethrow `onError(err){throw err}`
- Tasks with input-dependent degradation use the onError contract arg — no `taskWithInput` closure re-wrapping

### C21.4 guards (physical extraction):
- `@animastor/ai-analysis` has ZERO cross-requires into `backend/src` (transitional seam removed)
- `@animastor/ai-agent` does not depend on analysis or backend (core purity)
- `@animastor/ai-analysis` does not depend on backend (direction enforced)
- All analysis task files resolve within the closed dependency surface (no backend escapes)
- The backend barrel (`structure-detector.js`) imports from `@animastor/ai-analysis/tasks/structure-analyzer` — not from a local path

## 7. Unit tests (C21.3 edge cases)

`backend/tests/execute-lifecycle.test.js` — 30 tests covering:
- buildMessages throws → failStep once + rethrow / onError available / lifecycle ORDER (createStep → buildMessages → failStep)
- callAI / normalize / logConversation / completeStep throws → failStep + original error
- normalize throw == AI failure (validation is task-owned)
- failStep itself throws → original error preserved (also with onError defined)
- pre-step failures (port validation, createStep) → propagate WITHOUT failStep
- port-validation failure → zero side effects
- onError receives `(err, step, ports, input)`

## 8. Evolution path

**Add a new analysis task:** task object + `execute()`. Custom degradation via `onError`; custom failure text via `failMessage`.

**Conditional step creation (skip pattern):** keep a manual lifecycle like voices — the core always creates a step.

**The physical extraction (C21.4) is complete.** The analysis package is self-contained: all semantic analyzers live in `packages/animastor-ai-analysis/src/tasks/`. The backend is a thin host/composition layer.
