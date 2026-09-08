# C19 — Structure Analyzer: Physical Extraction

**Status:** EXTRACTED. Physical file split + module boundary; behavior-preserving; no prompt, algorithm, provider, or fallback change.
**Date:** 2026-09-08
**Baseline:** HEAD `e1311d0e` (`arch(ai): C18 functional decomposition of AI pipeline`)
**Predecessors:** `docs/architecture/ai-analyzer-boundary-c17.md` (C17 froze the analyzer boundary + `StructureDetectorPort` shape), `docs/architecture/ai-functional-decomposition-c18.md` (C18 froze F1 contracts, H7 dual-role finding, extraction stage 4).
**Artifacts:** physical code move + port-based entry point + one new guard suite (`backend/tests/architecture/structure-analyzer-extraction-c19.test.js`, 23 assertions) + updated C17/C18 guards + repointed golden tests.

---

## 1. Old boundary (as found, C17/C18)

`backend/src/services/structure-detector.js` (1231 LOC, zero requires) was a **dual-role file** (C18 H7):

| Half | Functions | Actual owner |
|---|---|---|
| Deterministic (Parser-side) | `extractCandidates`, `buildDeterministicMap`, `matchKeyword`, keyword/number/roman helpers, title/author head-zone heuristics, `mapToStructureChapters` | **Parser Core** — host-injected into `@animastor/parser` via `setStructureDetector` (`backend.cjs:41`); the parser calls only `buildDeterministicMap` |
| AI merge (Analyzer-side) | `sanitizeStructure` (+ `sanitizeTitleLike`/`sanitizeAuthorName`/`sanitizeChapterNumber`/`isBareNumberTitle`), `mergeAiDecisions`, `analyzeStructure` | **AI Structure Analyzer (F1/F6)** — called by `pipeline-steps.stepAnalyzeStructure` |

The AI *step wrapper* (prompt assembly, `ai-caller.callAI`, PG session/step bookkeeping, fallback projection) lived inline in `pipeline-steps.js` (202–309) mixed with the sibling analyzers. `agent/bootstrap.js:127-131` also required the detector directly for the candidate pre-scan.

C18 §10 stage 4 scheduled exactly this split: *"split `structure-detector.js` AI-merge half from the deterministic half behind the frozen `StructureDetectorPort` (compatibility barrel keeps `setStructureDetector` working)"*.

## 2. New boundary (as built)

```
HOST (composition)
  backend.cjs ──── setStructureDetector(require('./services/structure-detector'))   ← unchanged binding
                         │
                         ▼ (whole-object port binding; parser calls buildDeterministicMap only)
  @animastor/parser (Parser Core) ── knows NOTHING about AI              (C19 guard 6)

  agent/bootstrap.js ──── candidates pre-scan ── structure-analyzer.extractCandidates
  agent/pipeline-steps.stepAnalyzeStructure ── thin host adapter:
        injects ports { callAI, logConversation, updateSession, createStep,
                        completeStep, failStep, analyzingStructureMessage,
                        prompt, fillLang } → analyzeBookStructure(input, ports)

STRUCTURE ANALYZER (backend/src/services/structure-analyzer/)
  index.js    analyzeBookStructure(input, ports)  ← the C19 contract entry point
              + re-exports of the frozen AI-merge seam + detector surface
  ai-merge.js sanitizeStructure / mergeAiDecisions / analyzeStructure
              (pure logic; requires ONLY the deterministic adapter module)

HOST-SIDE PARSER ADAPTER (backend/src/services/structure-detector-deterministic.js)
  extractCandidates / buildDeterministicMap / mapToStructureChapters + heuristics
  (pure, zero requires; the injected detector implementation)

COMPATIBILITY BARREL (backend/src/services/structure-detector.js)
  re-export-only; zero local function definitions                       (C19 guard 8)
```

**Deliberate decision (per the C19 brief §5):** the deterministic half stays **host-side as the Parser adapter**. It is Parser Core deterministic functionality, not AI. The analyzer consumes it through the same `StructureDetectorPort` shape frozen in C17 §8 — so Parser Core gains **no** reverse dependency on the AI module, and no parser copy is created inside the AI module.

## 3. Input contract (frozen, minimal — C18 §6 F1 unchanged)

```js
analyzeBookStructure({
  sourceText,      // the exact source string instance — segment offsets anchor
                   // into it; no trim/normalize/re-decode across the boundary
  candidates?,     // CandidateLine[] (optional; re-derived via the detector port)
  language,        // prompt localization
  sessionId, stepIndex, progress,   // session/progress context (ports below)
}, ports)           // ports missing → fail-closed throw (C19 guard 7)
```

`ports` (host-injected, no ambient access inside the module):

| Port | Default source | Role |
|---|---|---|
| `callAI(messages, opts)` | `ai-caller.callAI` | **the single LLM seam** — provider from ALS context threaded by host; no provider/transport/SDK knowledge in the module |
| `logConversation(sessionId, stepId, messages, response)` | `ai-caller.logConversation` | conversation log (PG) |
| `updateSession` / `createStep` / `completeStep` / `failStep` | `agent-session` | session & step persistence (PG) |
| `analyzingStructureMessage` | `PROGRESS_STAGES.analyzing_structure` | user-facing progress text |
| `prompt(name)` | `SYSTEM_PROMPTS.structure` | prompt source (`ai/rules/structure.md` via `ai-loader`, unchanged content) |
| `fillLang(t, lang)` | `agent-prompts.fillLang` | `%LANGUAGE%` fill |
| `detector?` | host parser adapter | optional deterministic-backbone override (`extractCandidates` / `buildDeterministicMap` / `mapToStructureChapters`) — the replacement point for the deterministic half |

## 4. Output contract (frozen — downstream shape unchanged)

```js
{ author, title,                       // strings or null
  has_prologue, has_epilogue,          // booleans
  parts[],                             // [{ name, order }]
  chapters[],                          // LegacyChapterDTO (mapToStructureChapters projection)
  segments[],                          // ParserSegment[] — canonical chapter map
  country, epoch }                     // book defaults (null on fallback)
```

**Fail behavior (unchanged):** any AI failure (transport, retries, malformed JSON) → `failStep` + deterministic `fallbackStructure` (`buildDeterministicMap` + projection). The import is never failed by the analyzer. Malformed/empty AI output is neutralized by `sanitizeStructure` inside `mergeAiDecisions` exactly as before.

Downstream consumers of this shape (verified unchanged): window slicing `getWindowText(..., {chapterMap: structure.segments})` (bootstrap + `bootstrapNextWindow`), book metadata write (bootstrap 136–152), `window_data.structure` PG round-trip, `lazyBook.createFromAnalysis/appendToBook` chapter materialization, `chapterUtils.buildSegmentIntro`.

## 5. What was physically moved vs. kept host-side

| Code | Old home | New home |
|---|---|---|
| `sanitizeStructure` + sanitizer helpers | structure-detector.js 394–538 | `structure-analyzer/ai-merge.js` (verbatim) |
| `mergeAiDecisions` | structure-detector.js 921–1201 | `structure-analyzer/ai-merge.js` (verbatim) |
| `analyzeStructure` (one-shot) | structure-detector.js 1203+ | `structure-analyzer/ai-merge.js` (verbatim) |
| `extractCandidates`, `buildDeterministicMap`, all detection heuristics, `mapToStructureChapters` | structure-detector.js | `structure-detector-deterministic.js` (verbatim, stays **host-side**) |
| AI step wrapper (prompt assembly, callAI, PG steps, fallback) | `pipeline-steps.js` inline | `structure-analyzer/index.js` as port-based logic; `pipeline-steps.stepAnalyzeStructure` remains as a **thin composition adapter** (≤30 LOC, only port wiring) |
| candidates pre-scan in bootstrap | `require('../structure-detector')` | `require('../structure-analyzer')` (same function objects) |
| `require('../services/structure-detector')` consumers | direct module | unchanged — barrel re-exports both halves (incl. `setStructureDetector` binding in `backend.cjs`, test bindings) |

Shared heuristics needed by both halves (`looksLikeAuthorName`, `isAuthorSurnameACharacter`, `TYPE_LABELS`, `_extractSurname`, `_countSurnameInText`) stayed in the deterministic module and are explicitly exported on the frozen port surface.

## 6. Dependency graph (after extraction)

```
                 HOST
  bootstrap.js ────────────── pipeline-steps.js (composition adapters)
      │ candidates pre-scan            │ inject ports
      ▼                                ▼
  structure-analyzer/index.js  ◄──── ports {callAI, log, session/steps, prompt, fillLang}
      │ require (only)
      ▼
  structure-analyzer/ai-merge.js ── sanitizeStructure → mergeAiDecisions → analyzeStructure
      │ require (only)
      ▼
  structure-detector-deterministic.js (pure Parser adapter, host-side)
      ▲ setStructureDetector (whole-object port, composition root)
      │
  @animastor/parser (Parser Core — no AI knowledge)
```

- **No import cycles** (C18 DAG guard re-run over the new file set: green).
- The analyzer module's only `require` is the deterministic adapter (plus nothing else — C19 guards 1–5, 7).
- `pipeline-steps.js` retains the `stepAnalyzeStructure` name (runner/bootstrap/orchestrator injection surface unchanged); the big refactor of `pipeline-steps.js` remains explicitly out of scope (C19 brief §9).

## 7. Why Structure Analyzer is now replaceable

To replace the Structure Analysis algorithm a developer touches **only** `backend/src/services/structure-analyzer/` (merge logic in `ai-merge.js`, step flow in `index.js`) and the prompt `ai/rules/structure.md` — or injects `ports.detector`/`ports.callAI` from the host for an alternative implementation. There is **no need to enter** Character, Location, Scene analysis, Generation passes, the Importer, the Book Writer, the parser package, or provider/transport code. The C19 guard suite pins each of these edges statically.

Residual coupling, documented on purpose:
1. **The deterministic backbone stays host-side** (Parser adapter). Replacing the *deterministic* fallback algorithm means replacing the adapter + rebinding `setStructureDetector` — a Parser-domain decision, deliberately not owned by the AI module (C19 brief §5: "не создать новую связанную копию Parser внутри AI-модуля").
2. **`stepAnalyzeStructure` remains the orchestration slot** in `pipeline-steps.js`/`pipeline-runner` (analysis-phase ordering, F24). Moving the *slot* is pipeline-orchestration work (C18 stage 2), not analyzer-internal work.
3. **Legacy `refineDraft` path** (`ai-service.js:263+`, old import flow) still contains its own parallel analysis prompt — unchanged, out of scope (C18 open question 7).

## 8. Guards

New: `backend/tests/architecture/structure-analyzer-extraction-c19.test.js` —
1. no Book Writer calls; 2. no Importer imports; 3. no direct `ai-service`; 4. no direct `fetch`; 5. no sibling-analyzer dependency (imports + output-field scan); 6. parser package has no reverse dependency (adapter stays pure; composition-root binding pinned); 7. host capabilities enter only via the port object (fail-closed on missing ports; adapter wiring pinned); 8. barrel is re-export-only, no duplicated implementation, module exports the frozen contract.

Updated: `ai-analyzer-boundary.test.js` (C17 Guard 1 now targets the split files + barrel purity), `ai-functional-decomposition-c18.test.js` (contour file set + Guard 7 dual-role resolution + Book Writer file list), `parser-core-isolation.test.js` pattern (still matches the new adapter filename).

## 9. Behavior verification (all green)

| Suite | Result |
|---|---|
| `tests/structure-detector.test.js` (golden, ~900 lines; AI-half tests repointed to `structure-analyzer`) | 64 passing |
| `tests/parser-contract.test.js` (Parser contract + port binding) | passing |
| `npm run test:arch` (all 33 architecture suites incl. C17/C18/C19) | 517 passing |
| `tests/pipeline-runner-parallel.test.js`, `unit-splitter`, `source-coverage`, `scene-cache`, `scene-split`, `happy-path`, `txt-import-ownership`, `agent-status` | 275 passing |
| `packages/animastor-parser` + `packages/animastor-vbook-runtime` package suites | 32 + 24 passing |
| fallback on AI failure / malformed response | pinned (deterministic map returned, `failStep` called, log/complete not called) |
| `npm run test:syntax` | green |

Prompt text, merge algorithm, sanitize rules, numbering, offsets, fallback shape, `[AGENT] Step 0 (structure)` log line — all byte-identical. Test-only changes: import paths in `structure-detector.test.js` (explicitly allowed by C19 brief §8).

## 10. Further extraction order (per C18 §10 + C19 result)

1. **Port-ify session/log/progress/cancellation** for the remaining analysis steps (C18 stage 3; the Structure Analyzer already demonstrates the port shape).
2. **File split of `pipeline-steps.js`** into analysis vs generation halves (C18 stage 2) — the `stepAnalyzeStructure` adapter moves wholesale; no analyzer change needed.
3. **Character Analyzer (F2/F7)** — same pattern: module + ports, merge contract made explicit (C18 H1 decision #3), prompt `characters.md`/`voice_generation.md` via `prompt` port.
4. **Location Analyzer (F3)** — env sanitize + merge contract (runner 513–556) must move into the module contract first.
5. **Scene Analysis (F4/F5)** — needs `source-coverage` + duration heuristic ownership decision; biggest port surface (repairHint, coverage loop).
6. **Package extraction (`@animastor/ai-analyzer`)** — only after all F1–F5 modules share the port idiom; the C19 `structure-analyzer/` directory is the first package-boundary seed, promoted when (and only when) the sibling modules reach the same shape.
