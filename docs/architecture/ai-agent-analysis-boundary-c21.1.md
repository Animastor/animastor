# C21.1 — AI Agent Core / AI Analysis: Package Separation

**Status:** EXTRACTED. Two physical packages with enforced dependency direction; behavior-preserving; no prompt, rules, skills, JSON contract, degradation, or merge change.
**Date:** 2026-09-08
**Baseline:** C21 (`ai-agent-contour-extraction-c21.md` — shared contour extraction)
**Predecessors:** C18 (functional decomposition), C19 (structure-analyzer), C20 (character-analyzer), C21 (contour extraction)

---

## 1. Why: mechanism ≠ semantics

C21 extracted a shared contour that unified all AI analysis tasks behind one seam. But the contour mixed two concerns:

1. **Mechanism**: fail-closed port validation, `callAI` seam pattern, task lifecycle
2. **Semantics**: concrete analysis tasks (structure, characters, locations, scenes, units, voices)

C21.1 separates these into two physical packages with a strict dependency direction, so each concern can evolve independently without accidental coupling.

## 2. What was separated

| Concern | Before (C21) | After (C21.1) |
|---|---|---|
| Host port validation (`assertHostPorts`) | `ai-agent/ports.js` (backend) | `packages/animastor-ai-agent/src/ports.js` (Core) |
| Task files (locations, scenes, units) | `ai-agent/tasks/*.js` (backend) | `packages/animastor-ai-analysis/src/tasks/*.js` (Semantic) |
| Prompt-context builder | `ai-agent/context.js` (backend) | `packages/animastor-ai-analysis/src/context.js` (Semantic) |
| C19/C20 module re-exports | `ai-agent/index.js` (backend) | `packages/animastor-ai-analysis/src/index.js` (Semantic) |
| Backend barrel | `ai-agent/index.js` (full seam) | `ai-agent/index.js` → delegates to `@animastor/ai-analysis` |

## 3. Package responsibilities

### @animastor/ai-agent (Core)

**Owns:** The shared execution mechanism — the pattern every AI analysis task follows.

```
task → callAI → structured JSON → validation/error/degradation lifecycle
```

**Public API:**
- `assertHostPorts(ports, required, taskName)` — fail-closed host port validation

**Does NOT know:**
- characters, locations, scenes, units, structure, voice
- concrete analyzers, Book Writer, Importer
- specific AI provider, callAI implementation
- PG, Redis, fs, generation

**Dependencies:** zero (pure mechanism)

### @animastor/ai-analysis (Semantic Layer)

**Owns:** All AI analysis tasks and authoring operations.

| Operation | Physical home | Function |
|---|---|---|
| Structure / Chapter analysis | `services/structure-analyzer` (C19) | `analyzeBookStructure` |
| Character extraction | `services/character-analyzer` (C20) | `extractCharacters` |
| Voice authoring | `services/character-analyzer/voices` (C20) | `generateVoices` |
| Location extraction | `tasks/locations.js` | `extractLocations` |
| Scene analysis | `tasks/scenes.js` | `createScenes` |
| Unit analysis | `tasks/units.js` | `createUnits` |
| Shared context builder | `context.js` | `buildLocationsContext` |

**Public API:** All analysis functions re-exported through `src/index.js`.

**Dependencies:** `@animastor/ai-agent` (Core), `@animastor/vbook-runtime` (pure utils)

## 4. Dependency direction (enforced by guards)

```
host/backend
    ↓
@animastor/ai-analysis    (semantic analysis tasks)
    ↓
@animastor/ai-agent       (execution mechanism)
```

**Forbidden directions (guards prevent):**
- `ai-agent → ai-analysis` ✗
- `ai-agent → pipeline` ✗
- `ai-agent → ai-service/provider` ✗
- `ai-agent → PG/Redis/fs` ✗
- `ai-analysis → generation` ✗

## 5. What is intentionally NOT in Core

The following are analysis/semantic concerns that live in `@animastor/ai-analysis`:

- All analysis task implementations (F1–F7)
- Prompt assembly (task-local, not centralized)
- Output normalization (`normalizeSceneEnvironment`)
- Context builders (`buildLocationsContext`)
- C19/C20 analyzer modules (composition, not re-implementation)

## 6. Backward compatibility

The backend barrel at `backend/src/services/ai-agent/index.js` delegates to `@animastor/ai-analysis`:

```javascript
const analysis = require('@animastor/ai-analysis');
module.exports = analysis;
```

Existing host adapters (`pipeline-steps.js`) continue to import from `../ai-agent` unchanged. New code should import directly from the appropriate package.

## 7. Architecture guards (65 assertions)

The guard test (`tests/architecture/ai-agent-contour-extraction-c21.test.js`) enforces:

1. **Shared execution boundary** — barrel delegates to analysis package; analysis exports all tasks
2. **Single LLM seam** — no task imports ai-service/SDK/fetch
3. **Dependency boundary** — no PG/Redis/fs/Book Writer/Importer in analysis tasks
4. **Separate task contracts** — each task owns its own prompt and step type
5. **Task independence** — no task→task imports; acyclic graph
6. **Generation boundary** — no image/video/audio generation in analysis tasks
7. **Package architecture** — exactly two packages; core has zero deps; no per-function packages

## 8. Evolution path

**Improve one task:** Edit its task file in `packages/animastor-ai-analysis/src/tasks/` — siblings, core, and generation untouched.

**Add a new analysis task:** Add `tasks/<name>.js`, export through the analysis package, add one host adapter in `pipeline-steps.js`.

**Extract a per-function package** (when justified by a second consumer): Move its files from the analysis package; update the guard file lists.

**Replace the Core mechanism:** Replace `packages/animastor-ai-agent/src/ports.js` — analysis tasks, adapters, and generation are untouched.
