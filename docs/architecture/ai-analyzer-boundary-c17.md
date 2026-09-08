# C17 — AI Analyzer Boundary & Contract Freeze

**Status:** READ-ONLY architectural recon + contract freeze. No code moved, no npm package created, no AI algorithm/prompt/provider behavior changed. Artifacts: this document + one read-only architecture guard test.
**Date:** 2026-09-08
**Baseline:** HEAD `f24987ed` (`arch(editor): split edit routes into routes/editor contour`)
**Predecessor:** `docs/parser-ai-importer-boundary-audit.md` (C12 recon), C13 contract freeze, C15 physical extraction of `@animastor/parser`, C16 npm publication prep.
**Scope:** the semantic AI analysis of a book — structure, chapters, scenes, characters, locations, mentions, metadata, AI decision merge, provider transport, prompts, retries/fallback — and the boundary **Parser Core → AI Analyzer → Importer → Book Writer**.

---

## 1. Current implementation

The "AI Structure Analyzer" is **not a module** today — it is a layer woven through `backend/src/services/`:

| File | Role | Coupling |
|---|---|---|
| `backend/src/services/structure-detector.js` (1231 LOC, **zero requires**) | Candidates scan (deterministic) + deterministic chapter map + **LLM decision merge** (`mergeAiDecisions`, `analyzeStructure`, `sanitizeStructure` hallucination guard) | PURE — injectable as-is |
| `backend/src/services/agent/pipeline-steps.js` (1594 LOC) | The AI steps: `stepAnalyzeStructure` (202), `stepExtractCharacters` (311), `stepExtractLocations` (337), `stepCreateScenes` (368), `stepCreateUnits` (437), `stepCreateVisuals` (1080), voices (494), passport/video reconciliation + polish passes | PG sessions (agent-session), prompts, ai-caller |
| `backend/src/services/agent/pipeline-runner.js` (1370 LOC) | `runPipeline` orchestration per window: analysis merge, scene coverage validation/repair loop, unit/visual pipeline, reconciliation ordering; `getWindowText` (105) — chapter-map slicing + `injectChapterMarkers` | PG/Redis cancellation, SSE, lazyBook parser facade |
| `backend/src/services/agent/parallel-analysis-orchestrator.js` (441 LOC) | Parallel characters+locations extraction (fixed task graph, `p-limit`), voices ordered after characters | pure orchestrator over `pipelineSteps` |
| `backend/src/services/agent/ai-caller.js` (86 LOC) | **Provider seam**: `callAI(messages, {maxTokens, timeout})`, retry × `STEP_RETRIES` (3), AsyncLocalStorage provider context, `logConversation` → **PG** | PG logging, runtime-config, ai-service |
| `backend/src/services/ai-service.js` (656 LOC) | Transport: OpenAI-compatible HTTP `POST {baseUrl}/chat/completions` via `safeFetch` (OpenRouter-style, env `AI_API_BASE_URL`, default `https://api.aicredits.in/v1`) **or** LAC connector WS (`sharedPool.runSharedInference`); `parseJsonResponse` (fence/`<think>` strip, truncated-JSON repair) | config, url-safety, system-ai kill switch |
| `backend/src/services/agent-prompts.js` (179 LOC) | Prompt assembly: `SYSTEM_PROMPTS` loaded from `backend/ai/rules/*.md` via `ai-loader` (**filesystem**, env `AI_DIR`), `fillLang`, window/scene budgets, `STEP_RETRIES` | fs (ai-loader), env |
| `backend/src/services/agent/unit-splitter.js` (298 LOC) | AI split of long units (duration > 20 s) | ai-caller, agent-session |
| `backend/src/services/agent/bootstrap.js` (802 LOC) | **Orchestrator/host**: provider resolution (`workspace-ai-provider.resolveAIForBook`), `runWithProvider`, PG sessions, windows, metadata write, **Book Writer calls** | PG, Redis, fs, lazyBook |

Composition-root fact: `backend.cjs:40-41` binds the **whole** `structure-detector` (deterministic half + AI-merge half) into `@animastor/parser` via `setStructureDetector` — the parser package only calls the port's `buildDeterministicMap`.

**No `openai` / `anthropic` SDK is used anywhere** — transport is raw OpenAI-compatible HTTP + a connector WS branch (verified by grep; also asserted by the new architecture test).

## 2. Actual call graph (as-built, verified)

```
POST /book/:id/bootstrap (import-routes.cjs)
  → txt-importer.bootstrapImportedText → agent-service.bootstrapWithAgent
    → bootstrap.bootstrapWithAgent (services/agent/bootstrap.js:50)
        resolveAIForBook(bookId)                  ← host: provider resolution
        aiCaller.runWithProvider(provider, …)     ← AsyncLocalStorage context
        createSession (PG agent_sessions)
        structureDetector.extractCandidates(draft.sourceText)   ← DETERMINISTIC candidates (bootstrap.js:128)
        pipelineSteps.stepAnalyzeStructure(sourceText, {candidates})   (pipeline-steps.js:202)
            aiCaller.callAI(messages)             ← LLM: classify candidates (structure.md prompt)
            structureDetector.analyzeStructure(sourceText, aiResult)
                → mergeAiDecisions: deterministic backbone + sanitizeStructure-guarded LLM merge
            on AI failure → buildDeterministicMap fallback      (pipeline-steps.js:304-308)
        getWindowText(sourceText, …, {chapterMap: structure.segments})  (pipeline-runner.js:105)
            ← AI-refined segments drive window slicing; fallback lazyBook.splitIntoChapters (parser port)
        pipelineRunner.runPipeline(sessionId, windowText, …)    (pipeline-runner.js:286)
            characters (+mentions) — sequential or parallel orchestrator
            voices → locations → scenes (stepCreateScenes + source-coverage validation + repair + deterministic fallback textUtils.buildFallbackScenes)
            units (stepCreateUnits + unit-splitter) → visuals (stepCreateVisuals)
            passport/video reconciliation, storyboard/video polish, fantasy-id repair
        → { characters, locations, mentions, scenes, coverage, nextOffset, extraScenes }
    → lazyBook.createFromAnalysis / appendToBook               ← BOOK WRITER (bootstrap.js:227/514/713)
```

**Confirmations against the expected flow from the task:**
- `sourceText → deterministic candidates → AI analysis → semantic decisions → ChapterMap/segments → Book Writer` — **correct for the structure stage**.
- **Correction (matches prior recon):** the AI Analyzer receives **raw source text + `CandidateLine[]`**, not a `ParserResult`. `stepAnalyzeStructure(sessionId, sourceText, …, { candidates })` (pipeline-steps.js:202-213); candidates come from `structureDetector.extractCandidates` in bootstrap.js:128 (the step re-derives them when absent). The merge re-derives the deterministic map internally (`mergeAiDecisions` → `buildDeterministicMap`).
- The window stage (`runPipeline`) additionally embeds **generation-phase** passes (visuals, passport/video reconciliation, polish). These are AI calls, but they are visual-generation concerns, not book-structure analysis — see §4.

## 3. AI Analyzer responsibilities

1. **Structure classification** — LLM classifies candidate lines (title/author/chapter/prologue/part/epilogue/reject) with confidence + candidate anchors.
2. **AI decision merge** — `mergeAiDecisions`: anchored, confidence-gated (≥ 0.5), hallucination-guarded (`sanitizeStructure`: shape rules, surname-frequency author check, bare-number-title guard, poster/template logic) merge onto the deterministic backbone. Deterministic result is never erased without a validated AI decision.
3. **Deterministic fallback** — `buildDeterministicMap` on AI failure (never throws for malformed text; single `body` segment for unstructured input).
4. **Characters + mentions** — `stepExtractCharacters` (LLM) + `mergeCharacterLists` merge (placeholder filter, generic skip); `mentions` alias→character_id map.
5. **Locations** — `stepExtractLocations` (LLM) + environment sanitization (`sanitizeEnvironment`), description-merge.
6. **Scenes** — `stepCreateScenes` (LLM) + coverage validation (`source-coverage`) + repair retry + deterministic fallback scenes.
7. **Units** — `stepCreateUnits` (LLM visual frames) + `splitLongUnits` (AI duration split) + verbatim-text guards.
8. **Visual prompts** — `stepCreateVisuals` + passport/video reconciliation + storyboard/video polish + fantasy-snake-id repair (generation-phase, but currently inside the analyzer pipeline).
9. **Metadata** — book `title`, `author`, `country`, `epoch` (LLM, merged only if anchored/validated).
10. **Provider-agnostic LLM access** — retry, JSON parsing, timeout, conversation logging (PG).

## 4. Non-responsibilities

- **Deterministic parsing** — candidates scan and the fallback map *are* Parser Core seeded in the same file (`structure-detector.js`); the LLM never invents offsets (everything anchors to candidate ids / line_text found verbatim).
- **Book persistence** — the analyzer layer never calls `createFromAnalysis`/`appendToBook`/`writeFileSync` (verified: zero occurrences in pipeline-steps/pipeline-runner/structure-detector; the new architecture test freezes this).
- **Import orchestration** — draft lifecycle, dedup, two-phase HTTP flow, chunk/layer-config reads, provider *resolution* — Importer/host side (bootstrap.js, routes).
- **Session/progress ownership** — PG sessions, SSE, Redis are consumed by the analyzer layer today, but they are Importer/runtime capabilities that must become injected ports (§11).
- **HTTP routes / UI / frontends** — none.
- **Entity relationships** — do not exist anywhere in the current analyzer (only `mentions` alias→id; the word "relationship" appears solely as a camera-axis rule in `storyboard_polish.md`).
- **Lazy chapter materialization** (`lazy-book/parse.js`) — deterministic Book Writer, not analyzer.

## 5. Input contract (actual, frozen)

**Structure stage** — `stepAnalyzeStructure`:

```ts
interface StructureAnalysisInput {
    sourceText: string;              // RAW full source (exact string instance; offsets anchor into it)
    candidates: CandidateLine[];     // deterministic candidates (extractCandidates) — NOT a ParserResult
    language: string;                // book language, localized user-facing fields only ('ru'|'en'|…)
    // host-side today, must become ports: sessionId/stepIndex (PG step bookkeeping), progress callback
}
interface CandidateLine {            // output of Parser-side extractCandidates (frozen de-facto shape)
    id: string;                      // "c0", "c1", …  ← LLM anchors here
    lineIndex, startOffset, endOffset, text, length, wordCount: number|string;
    firstNonEmpty, inHeadBlock, standalone, allCaps, sentencePunctuation,
    followedByLongParagraph, numbered, romanNumeral, prefixDash: boolean;
    blankLinesBefore, blankLinesAfter, nextParagraphLines, nextParagraphLength: number;
    nextParagraphPreview, keyword, keywordWord, keywordRest: string|null;
    headingLikelihood: number;       // 0..1 suspicion score
}
```

**Window stage** — `runPipeline(sessionId, text, existingChars, existingLocs, stepIndex, progress, baseSceneCount, options)`:

```ts
interface WindowAnalysisInput {
    windowText: string;              // marker-injected window (injectChapterMarkers)
    rawWindowText: string;           // pre-marker window text (coverage checks)
    sourceOffsetBase: number;        // window start in source coordinates
    existingCharacters: Character[]; existingLocations: Location[]; existingMentions: Mentions;
    language: string;
    country, epoch: string|null;     // book defaults from structure stage
    chunkSize: number;               // 1..5 scenes per window
    analysisMode: 'sequential'|'parallel'; analysisParallelism: number;  // layer-config, host-read
    promptProfiles?: object;         // host prompt overrides
    // host-side today, must become ports: bookId, redis, publishProgress, sessionId (cancellation + sessions)
}
```

## 6. Output contract (actual, frozen)

**Structure result** (persisted into `window_data.structure` and book metadata):

```ts
interface StructureAnalysis {
    author: string|null; title: string|null;
    has_prologue: boolean; has_epilogue: boolean;
    parts: { name: string; order: number }[];
    chapters: LegacyChapterDTO[];    // mapToStructureChapters projection (compat)
    segments: ParserSegment[];       // canonical chapter map — C13 Parser contract shape
                                     // ({type,label,title,number,headerLine,startOffset,endOffset,source:'detect'|'ai'})
    country: string|null; epoch: string|null;   // semantic, LLM-only, not deterministically validated
}
```

**Window result** (feeds Book Writer):

```ts
interface WindowAnalysisResult {
    characters: Character[]; locations: Location[]; mentions: Mentions;
    scenes: Scene[];                 // ordered, coverage-validated, source_start/source_end + units[]
    allScenes: Scene[]; extraScenes: Scene[];   // over-budget cache for the next window
    sceneConsumedLength: number; nextOffset: number;
    coverage: { ok: boolean; reason?, gap_chars, covered_start_offset, covered_end_offset,
                last_scene_end_offset, next_offset, progress_method, scene_spans };
}
```

**Error contract (as-built):** analysis steps throw on AI-unavailable/cancelled (`SESSION_CANCELLED` code); the *structure* step degrades to the deterministic map (never fails the import); scene steps have a deterministic fallback after 2 coverage failures; both-tasks-parallel-failure is logged loudly and continues with the empty merge (no sequential re-run). Any package contract must preserve these degraded-but-valid semantics.

## 7. Provider boundary

```
pipeline steps / unit-splitter
      │  aiCaller.callAI(messages, {maxTokens, timeout})     ← the ONLY seam the analyzer sees
      ▼
ai-caller.js   retry ×3 (STEP_RETRIES, linear backoff), JSON parse, provider from
               AsyncLocalStorage (runWithProvider) or options; model default
               config.OPENROUTER_MODEL || 'qwen/qwen3.5-122b-a10b'
      ▼
ai-service.js  transport branch:
               • HTTP: POST {endpoint|AI_API_BASE_URL}/chat/completions (OpenAI-compatible,
                 OpenRouter-style; safeFetch + SSRF guard for workspace endpoints; timeout via
                 AbortSignal.timeout; 3 transport retries, no 4xx retry; system-ai kill switch)
               • Connector (LAC §9): sharedPool.runSharedInference over the connector WS
                 (apiKey=null by design; no retry at this level)
```

- **Swappable?** Yes — provider is a plain snapshot `{endpoint, apiKey, model, transport, source}` resolved host-side (`workspace-ai-provider.resolveAIForBook`) and threaded via context. Replacing OpenAI-compatible HTTP with another provider requires **zero analyzer-contract changes**: the port is "async callable: messages+options → parsed JSON object".
- **Not provider-specific:** no SDK imports, no provider names inside prompts/steps.
- **Ambient coupling to remove in C18:** the AsyncLocalStorage provider context (should become an explicit injected `callAI`).
- **Verdict: no separate provider npm package in C17/C18** — the seam already exists (`ai-caller`); a package would freeze a single-implementation abstraction prematurely.

## 8. Parser dependency decision

**Decision: the AI Analyzer must NOT depend on the Parser Core package.**

Facts:
- The analyzer consumes **raw text + `CandidateLine[]`** — not `ParserResult`. It *produces* `ParserSegment[]` (C13 contract shape), i.e. the dependency direction is "Analyzer output conforms to the Parser contract", not "Analyzer imports Parser".
- Today nothing in the analyzer imports `@animastor/parser` directly; the only parser touchpoints are host-side: `pipeline-runner.getWindowText` falls back to `lazyBook.splitIntoChapters` (parser facade) and uses `injectChapterMarkers` (parser facade) — both are **window-slicing (orchestrator) concerns**, not analysis.
- The reverse edge already exists and is healthy: the host binds `structure-detector` **into** the parser package (`setStructureDetector`, backend.cjs:41); the parser package knows nothing about AI.
- `structure-detector.js` currently fuses the two roles in one pure file: `extractCandidates`/`buildDeterministicMap` (deterministic = Parser Core) and `mergeAiDecisions`/`sanitizeStructure`/`analyzeStructure` (semantic = AI Analyzer).

**Minimal required data (instead of the whole Parser package):** `CandidateLine[]` + a `StructureDetectorPort` = `{ extractCandidates(text), buildDeterministicMap(text), mapToStructureChapters(map) }` — exactly the functions the analyzer calls. This port is already de-facto satisfied by the host module; freeze its shape, do not move code now.

## 9. Persistence dependencies

| Dependency | Where | Classification |
|---|---|---|
| PG `agent_sessions` (create/update, step records, cancellation checks ×3 levels) | agent-session via pipeline-steps + pipeline-runner | **PORT** (session/cancellation callbacks) |
| PG `agent_conversations` / `agent_messages` (LLM transcript logging) | `ai-caller.logConversation` | **PORT** (log callback) |
| PG `generation_cancel_repo`, cancelled-session cleanup | bootstrap | **HOST-ONLY** (orchestrator) |
| Redis `animastor:cancelled-workers:*` (cancel signal) | pipeline-runner checkCancelled | **PORT** (isCancelled callback) |
| Redis `animastor:vbook-scene-idx:*` (scene counter for /agent-status) | pipeline-runner publishVBook | **HOST-ONLY** (progress sink) |
| filesystem — book metadata write, draft/source reads, chapter files | bootstrap, lazyBook | **HOST-ONLY** (Book Writer / Importer) |
| filesystem — prompt assets `backend/ai/rules/*.md` via `ai-loader` (env `AI_DIR`) | agent-prompts | **KEEP with analyzer** (prompt assets are analyzer data; path via port) |

## 10. Importer dependencies

- The analyzer layer is **called by** the Importer (`txt-importer → agent-service → bootstrap`); it never calls back into the Importer. No `txt-importer` import exists inside the analyzer files (frozen by test).
- `bootstrap.js` is currently the boundary-crossing orchestrator: it is simultaneously Importer (sessions, cancellation cleanup, offset resolution, metadata writes, Book Writer calls) and analyzer host (provider context, candidate scan). In the future package, bootstrap stays host-side; the analyzer gets `StructureAnalysisInput`/`WindowAnalysisInput` DTOs.
- `layerConfig` (Redis chunk size, analysis mode/parallelism) is read by bootstrap and passed as plain options — the analyzer itself never touches layer-config. Correct shape; keep.

## 11. Hidden dependencies

Found by scanning actual `require()` edges (incl. inline requires), beyond the obvious:

| Dependency | Where | Verdict |
|---|---|---|
| PG database module | `ai-caller.js:12` (logConversation), `agent-session` (steps/sessions) | **PORT** |
| AsyncLocalStorage provider store | `ai-caller.js:11-17` | **PORT** (make explicit injectable `callAI`) |
| Redis client (threaded, not imported) | pipeline-runner options.redis (scene idx, cancellation) | **HOST-ONLY** (threading stays) |
| SSE `publishProgress` | threaded closure | **PORT** (progress callback) |
| `runtime-config` (OPENROUTER_MODEL) | ai-caller | **PORT** (model resolution moves to caller) |
| `image/image-service` (`normalizeCharacterRefs`) | pipeline-steps:20 | **PORT/KEEP** — deterministic id-normalization util; moves with analyzer or a shared utils pkg |
| `book/lazy-book/appearance` (`sanitizeVideoTokens`) | pipeline-steps:21 | **PORT** — VBook model utility used at merge time |
| `placeholder-audio` (`estimateSpeechDurationSec`) | pipeline-steps, unit-splitter, text-utils | **KEEP** — pure heuristic |
| `utils/snake-guard`, `utils/character-identity` → re-export `@animastor/vbook-runtime/*` | pipeline-steps/pipeline-runner | **KEEP** — deterministic validators, already package-side |
| `source-coverage.js` (pure, 0 requires) | pipeline-runner, pipeline-steps | **KEEP** — the analyzer's output validator |
| filesystem prompt loading (`ai-loader`, env `AI_DIR`) | agent-prompts | **PORT** (prompt provider) or ship rules as package assets |
| `prompt-profile-loader` / `profile-override` | bootstrap, pipeline-steps | **HOST-ONLY** (host prompt config, injected) |
| `layer-config` (Redis) | bootstrap only | **HOST-ONLY** |
| Express/routes | none in analyzer files | — (none found) |
| UI / frontends | none | — (none found) |
| OpenAI/Anthropic SDK | none anywhere | — (none found) |

## 12. Proposed package boundary

`@animastor/ai-analyzer` — semantic interpretation of a book text:

```ts
// Public API (frozen at C17; minimal typed contract)
export interface AIAnalyzer {
    analyzeStructure(input: StructureAnalysisInput): Promise<StructureAnalysis>;
    analyzeWindow(input: WindowAnalysisInput): Promise<WindowAnalysisResult>;
}

// Ports (host-injected; no ambient state, no PG/Redis/fs inside the package)
export interface AnalyzerPorts {
    callAI(messages: Msg[], opts: { maxTokens?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<object>; // parsed JSON
    structureDetector: { extractCandidates(text): CandidateLine[];          // minimal Parser data — §8
                         buildDeterministicMap(text): ChapterMap;
                         mapToStructureChapters(map): LegacyChapterDTO[] };
    getPrompt(name: 'structure'|'characters'|'locations'|'scenes'|'units'|'visuals'|…): string;  // prompt source
    onProgress?(event: { stage: string; message?: string; sceneIndex?: number }): void;
    isCancelled?(): Promise<boolean>;
    logStep?(step: { name: string; messages: Msg[]; response: string }): Promise<void>;
}

// Config
export interface AnalyzerConfig { language: string; maxScenes: number; country?: string|null; epoch?: string|null;
                                  analysisMode?: 'sequential'|'parallel'; analysisParallelism?: number; }

// Error contract: throws `AnalyzerError { code: 'AI_UNAVAILABLE'|'CANCELLED'|'COVERAGE_FAILED', cause }`
// only for hard failures; structure/scene stages degrade deterministically per §6 (frozen behavior).
```

**Must NOT contain:** provider transport (HTTP/WS), provider resolution, PG/Redis/SSE, draft/book writes, Importer logic, HTTP routes, runtime config reads.
**Dependencies:** none at runtime except `p-limit` (orchestrator) + pure utils that move with it (`source-coverage`, snake-guard/character-identity re-exports, placeholder-audio heuristic). Parser contract types may be duplicated or imported from `@animastor/parser` **types only** — no functional dependency.
**Relationship to the flow:** `Importer (host) → AIAnalyzer.analyzeStructure → host slices windows by returned segments → AIAnalyzer.analyzeWindow → BookWriter` — exactly today's data flow with ports replacing ambient access.

## 13. Extraction risks

1. **`runPipeline` infrastructure embedding (high).** PG logging + sessions + 3-level cancellation + Redis/SSE progress are interleaved with analysis. Any naive copy duplicates DB behavior; any omission breaks cancel/resume. Mitigation: port injection with default-to-current-implementation adapters.
2. **`structure-detector.js` dual role (medium).** Splitting the file must preserve the *whole-module* binding consumed by `setStructureDetector` (parser package calls `buildDeterministicMap` on the bound object). Split = keep a compatibility barrel or keep the file and split only in the package.
3. **Behavior-preserving fallback semantics (medium).** Degraded paths (deterministic structure fallback, scene fallback, empty-merge on double parallel failure, no-sequential-retry rule) are contractual; tests must pin them before extraction.
4. **Prompt assets on host filesystem (medium).** `ai/rules/*.md` + `AI_DIR` env — packages cannot read host env; the prompt port must be added first.
5. **Generation-phase passes inside `runPipeline` (medium).** Visuals/reconciliation/polish share the provider context and cancellation but are not "structure analysis". Extract the analyzer boundary *around the whole window pipeline* (as one `analyzeWindow`) first; a later milestone may split generation from analysis.
6. **Ambient provider context (low-medium).** AsyncLocalStorage works but hides the dependency; mechanical change, easy to revert.
7. **Offset discipline (low).** Offsets anchor into the exact `sourceText` string instance; any normalization across the boundary breaks anchors (multiple production bugs documented in comments). The contract must state "no trim/normalize/re-decode between Analyzer and its callers".
8. **`window_data` persistence shape (low).** `structure` round-trips through PG JSONB between windows; DTO must stay JSON-serializable with additive-only evolution (same rule as C13).

## 14. Recommended C18 extraction plan

| # | Step | Risk | Verification |
|---|---|---|---|
| 1 | Freeze the C17 contract (this doc) + architecture guard test | none | new test green |
| 2 | **Port-ify the seams inside the host** (no file moves): `ai-caller` accepts explicit `callAI` override; `pipeline-steps/pipeline-runner` take `logStep`, `isCancelled`, `onProgress` callbacks defaulting to today's PG/Redis implementations | medium | full agent test suite (`pipeline-runner-parallel`, `bootstrap-cancel-continue`, `scene-cache`, `scene-split`, `unit-splitter`) + import smoke |
| 3 | Split `structure-detector.js` into `parser-side` (candidates + deterministic map, stays the `setStructureDetector` impl) and `analyzer-side` (`mergeAiDecisions`, `sanitizeStructure`, `analyzeStructure`) with a compatibility barrel exporting both — zero behavior change | medium | `structure-detector.test.js` (~900 lines, golden) green |
| 4 | Move prompt loading behind `getPrompt` port (fs impl stays host-side; rules remain in `backend/ai/rules`) | low | agent-prompts tests, prompt smoke |
| 5 | Physically create `packages/animastor-ai-analyzer` hosting: pipeline analysis steps + orchestrator + merge/validation utils + `ai/rules` *copies* (or port), with the frozen DTOs; host keeps thin adapters (`agent/*` becomes a facade) | high | full suite + golden import fixtures; parser isolation + new boundary tests stay green |
| 6 | npm publication prep (mirror C15/C16 pattern: README, CHANGELOG, publishConfig, CI) | low | package suite in CI |

Do **not** extract a provider package in C18 (§7). Do **not** touch the Importer in C18 beyond the adapter facade it already uses.

---

## Verdict

**READY AFTER PREPARATION.** The boundary line already exists in production code (`structure-detector` merge half + `pipeline-steps` + `ai-caller` seam + `parseJsonResponse`), the parser edge is already clean (no Parser package dependency; candidates-in / segments-out), and the provider seam is swappable. What blocks a physical extraction today is only the embedded persistence (PG logging/sessions/cancellation), ambient provider context, and host-filesystem prompt loading — all resolvable by port injection (C18 steps 2–4) before any file moves.
