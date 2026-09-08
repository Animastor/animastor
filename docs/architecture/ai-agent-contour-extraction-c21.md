# C21 — AI Agent / AI Analysis: Shared Contour Extraction

**Status:** EXTRACTED. Physical module + seam; behavior-preserving; no prompt, rules, skills, JSON contract, degradation, or merge change.
**Date:** 2026-09-08
**Baseline:** HEAD `d27529d9` (`arch(editor): Phase 3 — resolve B1 extraction boundary`)
**Predecessors:** `ai-functional-decomposition-c18.md` (froze the F1–F7 contracts and the analysis/generation split), `structure-analyzer-extraction-c19.md` + `character-analyzer-extraction-c20.md` (module + ports pattern), C17 (`ai-analyzer-boundary-c17.md` — single `callAI` seam).
**Artifacts:** new physical module `backend/src/services/ai-agent/` (seam + shared port mechanism + 3 task files moved out of the `pipeline-steps.js` mega-file), thin host adapters in `pipeline-steps.js`, one behavior suite (`backend/tests/ai-agent-contour-c21.test.js`, 21 assertions), one architecture guard suite (`backend/tests/architecture/ai-agent-contour-extraction-c21.test.js`, 60 assertions), updated C17/C18/C19/C20 guard file lists + `pipeline-step-types` scan.

---

## 1. Why: the common mechanism already existed — it was just not owned

The C18 audit showed every AI analysis task follows one identical execution
shape:

```
task → prompt/rules/skills/examples → callAI → structured JSON → result
```

C19/C20 extracted two tasks behind module+ports seams. The remaining analysis
tasks (locations, scenes, units) still lived inline in `pipeline-steps.js`,
and there was no single place that *is* the AI analysis boundary: the host
adapters each wired their own analyzer module. C21 makes the shared mechanism
a physical, named contour **without** splitting it into per-function packages
and **without** guessing the final semantic decomposition (no
"character-analyzer npm package", no premature Behavior/Passport splits).

## 2. What physically moved

| Concern | Old location | New location |
|---|---|---|
| Location extraction (F3) | `pipeline-steps.stepExtractLocations` (inline AI logic) | `ai-agent/tasks/locations.js` → `extractLocations(input, ports)` |
| Scene analysis (F4) + `normalizeSceneEnvironment` + `SCENE_ENV_FIELDS` | `pipeline-steps.stepCreateScenes` (inline AI logic) | `ai-agent/tasks/scenes.js` → `createScenes(input, ports)` |
| Unit analysis (F5) | `pipeline-steps.stepCreateUnits` (inline AI logic) | `ai-agent/tasks/units.js` → `createUnits(input, ports)` |
| Shared prompt-context builder `buildLocationsContext` | `pipeline-steps.js` (used by scenes task AND polish steps) | `ai-agent/context.js` (pure; consumed by the contour and re-exported through the seam) |
| Shared fail-closed port validation | duplicated inline in C19/C20 modules | `ai-agent/ports.js` → `assertHostPorts` (new shared impl; C19/C20 modules keep their frozen inline checks — behavior unchanged) |
| Structure analysis (F1/F6, C19 module) | `services/structure-analyzer` | unchanged physically; re-exported through the seam |
| Character extraction (F2, C20 module) | `services/character-analyzer` | unchanged physically; re-exported through the seam |
| Voice authoring (F7, C20 `voices.js`) | `services/character-analyzer/voices.js` | unchanged physically; re-exported through the seam as **analysis/authoring** |

The three analysis steps in `pipeline-steps.js` are now thin host adapters
(≤20 LOC each) that build one shared host-port block (`analysisHostPorts`)
and route through the seam `require('../ai-agent')`. The adapters no longer
wire `structure-analyzer` / `character-analyzer` directly — the seam is the
single host-facing contour contract.

## 3. What the AI Agent module is

```
backend/src/services/ai-agent/
  index.js           — the seam: every analysis task reachable through ONE module
  ports.js           — shared fail-closed host-port validation (pure mechanism)
  context.js         — shared pure prompt-context builder (buildLocationsContext)
  tasks/
    locations.js     — extractLocations (F3)
    scenes.js        — createScenes (F4) + normalizeSceneEnvironment (pure output guard)
    units.js         — createUnits (F5)
```

Execution mechanism (owned by the contour, identical for every task):

```
task(input, ports)
  → assertHostPorts (fail-closed — no silent degradation on missing host wiring)
  → progress + updateSession (ports)
  → createStep(sessionId, '<frozen step type>', stepIndex) (port)
  → prompt assembly — task-LOCAL prompt/rules/skills (ports.prompt/fillLang/buildSkill)
  → ports.callAI(messages, opts)   ← the ONLY LLM seam
  → normalize structured JSON (task-specific, unchanged shapes)
  → logConversation + completeStep (ports)
  → result
fail → failStep (port) + task-specific degradation (unchanged):
  locations/scenes → throw (runner keeps existing set / retries with coverage hint)
  units            → single fallback unit (never throws)
```

**Deliberate mechanism boundaries:**
1. The contour owns the *mechanism*, not the semantics: no prompt text
   centralization, no generic "task framework", no JSON-schema engine.
2. Merge/dedup logic is **NOT** copied into the contour: character merge
   stays runner-owned via `@animastor/vbook-runtime/character-identity`
   (C18 H1 / C20 §6 decision re-affirmed); location merge + env sanitize
   stay runner-owned; scene coverage validation/retry and the deterministic
   fallback stay runner-owned.
3. The orchestrators (`parallel-analysis-orchestrator`, `pipeline-runner`)
   are host — they inject step adapters and are untouched.
4. Pure deterministic predicates may be consumed, never duplicated:
   `utils/snake-guard.sanitizeEnvironment` (scenes output guard), the
   vbook-runtime identity predicate (voices).

## 4. AI tasks in the contour (each keeps its own contract)

| Operation | Physical home | Frozen contract (unchanged) | Step type (PG CHECK) |
|---|---|---|---|
| `analyzeBookStructure` | `services/structure-analyzer` (C19) | `{ sourceText, candidates?, language, sessionId, stepIndex, progress } → structure`; fail → deterministic fallback | `analyze_structure` |
| `extractCharacters` | `services/character-analyzer` (C20) | `{ windowText, language, … } → { characters, mentions }`; fail → throw (runner keeps set) | `analyze_characters` |
| `generateVoices` | `services/character-analyzer/voices.js` (C20) | `{ windowText, characters, promptProfiles, … } → { voices }` + in-place `characters[i].voice` write-back; fail → `{ voices: {} }` | `generate_voices` |
| `extractLocations` | `ai-agent/tasks/locations.js` | `{ windowText, characters, language, … } → Location[]`; fail → throw (runner keeps set) | `analyze_locations` |
| `createScenes` | `ai-agent/tasks/scenes.js` | `{ sceneText, characters, locations, bookDefault?, repairHint?, chunkSize, language, … } → Scene[]` (env-normalized); fail → throw (runner retries/falls back) | `create_scenes` |
| `createUnits` | `ai-agent/tasks/units.js` | `{ scene, sceneIndex, characters, mentions?, … } → Unit[]`; fail → single fallback unit | `create_units` |

Ports (host-injected per call; fail-closed on missing):
`callAI`, `logConversation`, `updateSession`, `createStep`, `completeStep`,
`failStep`, per-task progress message (`PROGRESS_STAGES.*`), `prompt(name)`
(`SYSTEM_PROMPTS` → `ai/rules/*.md`, content unchanged), `fillLang`,
`buildSkill` (voices: audio skill injection via `prompt-profile-loader`).

## 5. What is consciously NOT in the AI Agent

1. **Generation/post-processing (F8–F14)** — `stepCreateVisuals`,
   `stepReconcilePassports`, `stepReconcileVideoActions`,
   `stepPolishStoryboard`, `stepPolishVideoActions`,
   `stepRepairFantasyIds`, `normalizeVisualText`, static-copy guards: stay
   host-side in `pipeline-steps.js` (C18 §4 boundary; visual-unit DTO is
   consumed GPU-side, H9).
2. **TTS / audio generation** — `generateVoices` produces voice
   *description* strings only; no TTS rendering, no audio files. "voice
   description → audio" belongs to a future Audio/TTS Generation module.
3. **Image / video generation** — no GPU workflows, no ComfyUI, no
   prompt-builder, no providers.
4. **Final generation-prompt assembly** — skills (`ai/skills/{image,video}`,
   image exemplars, passport injection) stay host-side.
5. **Orchestration** — windowing, coverage validation/retry loops, merge
   bookkeeping, parallel scheduling, cancellation, sessions (PG), progress
   (Redis/SSE), Book Writer persistence.
6. **Transport & provider selection** — `ai-caller` (retry/ALS), `ai-service`
   (HTTP/connector), `workspace-ai-provider`, system-ai kill switch: behind
   the injected `callAI` port.

## 6. Dependency boundary (pinned by guards)

```
HOST (composition)
  pipeline-steps.js  ── six thin adapters, one shared analysisHostPorts block
      │ inject ports { callAI, logConversation, session/steps, prompt,
      │               fillLang, PROGRESS message, buildSkill(voices) }
      ▼
  services/ai-agent (C21 seam)  ── index.js
      │            ├── ports.js   (shared fail-closed mechanism, pure)
      │            ├── context.js (shared pure prompt-context builder)
      │            ├── tasks/{locations,scenes,units}.js
      │            ├── ../structure-analyzer (C19)
      │            └── ../character-analyzer (C20, incl. F7 voices)
      ▼  pure deterministic utils only (never duplicated)
  utils/snake-guard (sanitizeEnvironment), @animastor/vbook-runtime
  /character-identity (hasRealAppearance)
```

**Correct directions (enforced):**
- Host adapters → `ai-agent` seam → tasks/analyzer modules ✓
- Tasks → shared `ports.js`/`context.js` + pure utils ✓
- Seam → C19/C20 analyzer modules (composition, not re-implementation) ✓

**Forbidden directions (guards prevent):**
- Contour → `ai-service` / `ai-caller` / OpenAI / Anthropic / fetch ✗ (the
  LLM arrives ONLY via the injected `callAI` port)
- Contour → PG / Redis / fs / `agent-session` / `agent-prompts` /
  `prompt-profile-loader` / provider resolution ✗ (all host-injected ports)
- Contour → Book Writer / Importer / `agent-service` ✗ (persistence +
  import orchestration are host-only)
- Task → sibling task ✗ (no `tasks/scenes → tasks/locations`; sharing goes
  through `ports.js`/`context.js` only)
- Contour → generation domain (image/video/audio orchestration, workflows,
  prompt-builder, placeholder-audio) ✗ (Analysis/Generation boundary, C18 §4)
- Contour → npm packages ✗ (no per-function packages created)
- Cycles within seam + tasks + analyzer modules ✗ (DFS guard)

## 7. How to evolve from here

**Improve one task** (prompt, rules, output normalization): edit its task
file (or the C19/C20 module) — sibling tasks, adapters, runner, and
generation are untouched.

**Move a function out into its own module** (when it starts evolving
independently — e.g. voices into an audio-domain module):
1. Its contract is already isolated: one file, own prompt, own ports
   subset, own JSON shape, own step type.
2. Move the file(s); keep exporting the same operation name through the
   seam (one-line re-export) so host adapters do not change.
3. Extend the C21 guard file lists; run `npm run test:arch`.
4. Only when a *second consumer* appears: promote to a package. No package
   extraction is justified by this refactor alone (C18 §11 verdict stands).

**Add a new analysis task**: add `tasks/<name>.js` (own contract +
degradation), re-export through the seam, add one thin adapter in
`pipeline-steps.js`, add the step type to the PG CHECK
(`pipeline-step-types` guard enforces schema sync), extend the guard file
lists. Do not widen the seam for generation concerns — that is a different
contour.

## 8. Behavior verification (all green)

| Suite | Result |
|---|---|
| `tests/ai-agent-contour-c21.test.js` (new: F3/F4/F5 contracts, degradation, fail-closed ports, shared builder, adapter routing) | 21 passing |
| `tests/architecture/ai-agent-contour-extraction-c21.test.js` (new, 60 assertions) | passing |
| `npm run test:arch` (incl. updated C17/C18/C19/C20 suites) | green |
| `tests/pipeline-step-types.test.js` (scan extended to contour tasks) | passing |
| `tests/character-analyzer-extraction-c20.test.js`, `tests/structure-detector.test.js`, `tests/unit-splitter.test.js`, `tests/coreference-agent.test.js` | passing |
| `tests/pipeline-runner-parallel/placeholder`, `parallel-analysis-{orchestrator,acceptance,concurrency}`, `tests/happy-path.test.js`, `tests/agent-status.test.js` | passing |
| `tests/scene-cache/scene-split`, `tests/snake-guard`, `tests/video-action-{polish,reconciliation}`, `tests/visuals-duration` | passing |
| `npm run test:syntax` | green |

Prompt text, prompt assembly, placeholder fills, `createStep` types, JSON
normalization, log lines (`[AGENT] Step 2/3/4 …`), failure semantics, and
merge behavior are byte-identical. Production changes: three steps became
thin adapters, two pure helpers moved to their shared physical homes;
everything else is additive (new module + tests).

## Verdict

**The shared AI analysis mechanism is now a named, guarded contour** —
"AI Agent / AI Analysis" — with one LLM seam (`callAI`), fail-closed host
ports, per-task contracts preserved verbatim, zero host/persistence/generation
coupling, and a documented, low-risk path for both per-task evolution and
future module/package extraction.
