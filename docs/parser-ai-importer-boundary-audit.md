# Parser / AI Analyzer / Importer Boundary & Contracts Audit

**Status:** READ-ONLY reconnaissance. Production code not changed, no packages created, no files moved, no imports altered. Only this document was added.
**Date:** 2026-09-08
**Baseline:** HEAD `99d8f270` (`docs(arch): move Editor module extraction audit…`)
**Supersedes context:** refines `docs/parser-module-extraction-audit.md` (2026-09-08) — that audit mapped *files*; this audit defines *boundaries and contracts* between Parser Core / AI Analyzer / Importer / Encoding / Book Writer, per task.
**Related:** `docs/parser-module-extraction-audit.md`, `docs/architecture/VBOOK_EXTRACTION_READINESS_AUDIT.md` (§2.6 detector-port decision), `docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md`, `docs/architecture/MODULAR_PRODUCT_ARCHITECTURE.md` §8/§24 (C13 parser contract missing), `docs/architecture/PLUGIN_EXTENSION_ARCHITECTURE.md`.

---

## 1. Executive Summary

The import/parse contour is **not one parser** — it is four distinct responsibilities currently woven across three locations:

| # | Responsibility | Where it physically lives today | Clean? |
|---|---|---|---|
| 1 | **Encoding / decoding** (`Buffer → Text`) | `backend/src/services/encoding-detect.js` (303 LOC, only dep: `iconv-lite`) | ✅ almost fully clean; leaks size-limit + `console.log` |
| 2 | **Deterministic parsing** (`Text → structure`) | `packages/animastor-vbook-runtime/src/lazy-book/parser.js` (227 LOC) + `language-detector.js` (148 LOC, `tinyld`) | ⚠️ already extracted into VBook runtime, but **fused to VBook**: writes book files, reads draft state, relies on a runtime-global `structureDetector` port |
| 3 | **Structure detection (candidates + LLM merge + sanitation)** | `backend/src/services/structure-detector.js` (1231 LOC, **zero requires**) | ✅ pure; *deterministic half* is generic, *merge half* is the seed of the AI Analyzer boundary |
| 4 | **Import orchestration** (pipeline: AI analysis → book creation → windows → progress/Redis/PG) | `services/txt-importer.js` (298) → `services/agent/bootstrap.js` (802) → `agent/pipeline-steps.js` (1594) + `agent/pipeline-runner.js` (1370) → writes via `lazyBook.createFromAnalysis/appendToBook` | ❌ heavily coupled: AI provider, PG sessions, Redis, SSE, lazy-book writes, dedup, cancellation — all interleaved |

**Central finding:** the boundary line between "Parser Core" and "AI Analyzer" **already exists inside `structure-detector.js`** — `buildDeterministicMap()` is a pure deterministic parser output, and `mergeAiDecisions()`/`analyzeStructure()` are the AI-merge seam with a hallucination guard (`sanitizeStructure`). The port `setStructureDetector()` (bound in `backend.cjs:41` and tests `vbook-test-bindings.cjs`) is the de-facto seed of the future C13 Parser contract. What is missing is: (a) naming/typing this contract as `ParserResult`, (b) decoupling `lazy-book/parse.js` (lazy window materialization = **Book Writer**, not Parser), and (c) making the AI path an explicit `AIAnalyzer` port instead of 4 pipeline-step functions reaching into PG/Redis/SSE directly.

**Verdicts (details §16):**

| Component | Verdict |
|---|---|
| Parser Core | **READY AFTER PREPARATION** (contract extraction; no code moves needed) |
| AI Analyzer | **READY AFTER PREPARATION** (port extraction; pipeline steps stay host-side initially) |
| Text Importer | **NOT READY** (deep PG/Redis/SSE/lazy-book coupling; biggest payoff, most work) |
| Encoding Detector | **READY** (extractable almost as-is) |
| Book Writer / Port | **READY AFTER PREPARATION** (operations exist and are concentrated in `lazy-book`; needs an interface) |

---

## 2. Current Architecture

### 2.1 Physical layout

```
backend/src/
  services/
    encoding-detect.js        Buffer→Text (iconv-lite, BOM, heuristic scoring)   [PURE except console.log]
    structure-detector.js     candidates + deterministic map + LLM merge + guard  [PURE, 0 requires]
    language-detector.js      shim → @animastor/vbook-runtime/language-detector   [host shim]
    txt-importer.js           decode+validate+draft+bootstrap orchestration       [HOST-BOUND]
    agent/
      bootstrap.js            first/next window AI orchestration, sessions, PG    [HOST-BOUND]
      pipeline-steps.js       AI steps: structure/chars/locs/scenes/units/visuals [HOST-BOUND]
      pipeline-runner.js      getWindowText (chapter map slicing), runPipeline    [HOST-BOUND]
      parallel-analysis-orchestrator.js   parallel chars/locs extraction           [HOST-BOUND]
      ai-caller.js            AsyncLocalStorage provider context + retries + PG log [HOST-BOUND]
      unit-splitter.js        long-unit AI splitting                              [HOST-BOUND]
  routes/book/
    import-routes.cjs         /import (unified txt|vbook), /import-txt, /load-vbook,
                              /:id/bootstrap, /:id/bootstrap-next-window, /:id/resume-bootstrap, /:id/trigger-next-window
    parse-routes.cjs          /:id/lazy-parse, /:id/lazy-parse-to, /import-text, /:id/source, /:id/snapshot
    status-routes.cjs         /:id/status, /:id/source-chapters, /:id/chapters-summary, /:id/generation-state
    generation-routes.cjs     /generate-next, /cancel-worker, /regenerate, layer-config
  backend.cjs                 composition root: setStructureDetector(services/structure-detector) (line 41)

packages/animastor-vbook-runtime/            (@animastor/vbook-runtime@0.1.0)
  src/lazy-book/parser.js     splitIntoChapters/Scenes/Units, injectChapterMarkers, detectLanguage,
                              setStructureDetector PORT  ← deterministic parser facade
  src/lazy-book/parse.js      lazyParseNextWindow/Chapter  ← NOT parsing: window materialization + file writes (Book Writer)
  src/lazy-book/create.js     createFromAnalysis/appendToBook ← Book Writer (AI path)
  src/lazy-book/draft.js      createDraftBook/loadDraftBook/updateBookState ← Book Model lifecycle
  src/lazy-book/chapter-utils.js  typography intro/cover scenes ← VBook-specific presentation
  src/lazy-book/paths.js      filesystem layout (booksRoot port)
  src/books-root.js           booksRoot port (configureBooksRoot)
  src/language-detector.js    tinyld-based source-language detection
  src/index.js                bundle CRUD (extractBookBundle/saveBookBundle/loadBook/resetBook)
```

### 2.2 Composition-root pattern (already in place)

- `backend.cjs:40-41`: `const { setStructureDetector } = require('@animastor/vbook-runtime/lazy-book/parser'); setStructureDetector(require('./services/structure-detector'));` — the **detector port**, fail-closed until bound.
- `packages/.../books-root.js`: `configureBooksRoot(provider)` — the **booksRoot port** (host owns filesystem root).
- `backend/tests/vbook-test-bindings.cjs`: mirrors both bindings for the test suite.
- These two ports are the working precedent the new contracts must follow: **host binds implementation, package declares interface, fail-closed before binding.**

### 2.3 What is actually deterministic vs AI today

| Concern | Deterministic implementation | AI involvement |
|---|---|---|
| Chapter detection | `structure-detector.buildDeterministicMap` (keywords, caps, numbering, blank runs, title/author heuristics, template learning, poster filtering) | `mergeAiDecisions` refines boundaries/titles; anchors everything to candidate ids |
| Scene detection (window path) | `parser.splitIntoScenes` (blank-run/`---`/`***` regexes) | AI path: `stepCreateScenes` (semantic episodes) + coverage validation |
| Unit/paragraph detection | `parser.splitIntoUnits` (1 scene = 1 narration unit — placeholder) | AI path: `stepCreateUnits` (visual units) + `unit-splitter.splitLongUnits` |
| Language detection | `language-detector.js` (tinyld, confidence, boilerplate strip) | none |
| Title/author | deterministic head-zone heuristics + surname-frequency guard (`isAuthorSurnameACharacter`) | LLM proposal merged only if anchored + confidence ≥ 0.5 |
| Characters | — | `stepExtractCharacters` (+ mentions map) |
| Locations | — | `stepExtractLocations` |
| Semantic structure (country/epoch) | — | `stepAnalyzeStructure` returns `country`/`epoch` (never validated deterministically) |
| Metadata extraction | `buildDeterministicMap` title/author guess | merged in `mergeAiDecisions` |
| Sanitation/validation | `sanitizeStructure` (anchors, confidence gates, shape rules), `source-coverage` (scene coverage), snake-guard | — |
| Book creation/update | — | `lazyBook.createFromAnalysis/appendToBook` (host+package) |

---

## 3. Current Data Flow (as-built)

### 3.1 Import (TXT, AI path — the main path)

```
HTTP POST /book/import | /import-txt (multer buffer)
  │  routes/book/import-routes.cjs:582,321
  ├─ dedup: sha256(decoded text) → book_source_repo (PG), workspace ownership attach
  ├─ txtImporter.decodeTxtBuffer(buffer)
  │    ├─ size guard: config.TXT_MAX_SIZE (10 MB)        ← config leak into decoder wrapper
  │    └─ encodingDetect.decodeBuffer(buffer)            ← iconv-lite, BOM, scoring
  ├─ lazyBook.createDraftBook(text, TXT, title)          ← Book Writer (draft)
  ├─ manifest patch: import_meta.original_filename       ← raw fs read/write in route
  ▼
HTTP POST /book/:id/bootstrap  (separate call!)
  └─ txtImporter.bootstrapImportedText(bookId, progress, publishProgress, redis)
       ├─ loadDraftBook; idempotence check (BOOTSTRAPPED + chapters>0 → skip)
       ├─ cleanup partial artifacts (chapters/, characters.json, bible.json)
       └─ agentService.bootstrapWithAgent(bookId, …)      services/agent/bootstrap.js:50
            ├─ resolveBookLanguage(draft)                 (book.language → detectLanguage → 'en')
            ├─ workspace-ai-provider.resolveAIForBook     ← provider resolution
            ├─ aiCaller.runWithProvider(provider, …)      ← AsyncLocalStorage context
            ├─ createSession(bookId,'txt_import')         ← PG agent_sessions
            ├─ PG: clear stale cancelled sessions + generation-cancel tombstone
            ├─ structureDetector.extractCandidates(sourceText)
            ├─ pipelineSteps.stepAnalyzeStructure         ← LLM structure (fallback: deterministic map)
            │    └─ structureDetector.analyzeStructure(text, aiResult) → mergeAiDecisions
            ├─ pipelineRunner.getWindowText(text,…, {chapterMap: structure.segments})  ← chapter-map slicing
            │    └─ lazyBook.injectChapterMarkers(windowText)  ← marker injection for LLM
            ├─ pipelineRunner.runPipeline(...)            ← the AI analyzer core
            │    ├─ checkCancelled: PG session + PG book + Redis cancelled-workers (3 levels)
            │    ├─ parallel-analysis-orchestrator | sequential: chars → voices → locs
            │    ├─ stepCreateScenes → source-coverage validation → repair loop
            │    ├─ stepCreateUnits per scene → snake-guard canonicalization
            │    ├─ stepCreateVisuals → passport/video reconciliation → polish steps
            │    ├─ publishVBook → SSE + Redis scene index (progress path)
            │    └─ returns { scenes, characters, locations, mentions, coverage, nextOffset, extraScenes }
            ├─ lazyBook.createFromAnalysis(bookId, {characters, locations, mentions, scenes, structure})
            │                                             ← Book Writer (AI materialization)
            ├─ updateSession window_data (PG), status paused/completed
            └─ publishProgress 'import_complete' (SSE)
```

**Continuation:** `/bootstrap-next-window` → `bootstrapNextWindow` (offset resolution disk-vs-PG, cached-scene replay without AI, dedup by windowStartOffset, `appendToBook`) → `lazyParseNext` (`/lazy-parse`) → **deterministic path** `lazy-book/parse.js` materializes remaining chapters from the chapter map *with direct fs writes*.

### 3.2 Deterministic path (no AI)

```
sourceText
  → structure-detector.buildDeterministicMap(text)      (bound as port into the runtime)
  → parser.splitIntoChapters(text) → chapters[{title,type,label,number,start/endLine/Offset,length}]
  → parser.splitIntoScenes(chapterText)                 (regex boundaries)
  → parser.splitIntoUnits(sceneText)                    (1:1 narration)
  → parse.js lazyParseNextWindow/Chapter                ← ⚠️ same module also WRITES chapter files
     + chapterUtils.buildSegmentIntro → typography intro scenes
     + fs.writeFileSync(chapters/<id>.json), chapters_order update, updateBookState
```

**Correction to the reference flow from the task:** the proposed linear chain `Input → Source Importer → Text Decoder → Parser Core → AI Analyzer → Book Writer` is *almost* right but two real aspects force amendments:

1. **Draft creation happens BEFORE parsing** — the source text is persisted (`createDraftBook`) and book identity/ownership/dedup are established first; bootstrap is a *separate HTTP phase* operating on a persisted draft (two-phase import by design, needed for resume).
2. **AI Analyzer does not consume `ParserResult`** — it consumes raw source text + `candidates` (a derived artifact of the same detector), and its structure output (`segments`) is then fed *back* as the chapter map for window slicing. The parser result and the AI result both derive from the same candidate scan; the merge is inside `structure-detector.js`, not in the orchestrator.

Corrected target flow: **Draft/Import phase** (`Input → Decode → createDraft`) and **Bootstrap phase** (`draft.sourceText → Parser Core (deterministic map + candidates) → AI Analyzer (classify candidates) → merged ChapterMap → Book Writer (windows) → Book`), with progress/events and persistence as side-channels the orchestrator owns.

---

## 4. Parser Core Analysis

### 4.1 What qualifies as deterministic parsing

- `structure-detector.js`: `extractCandidates`, `matchKeyword`, `buildDeterministicMap`, template learning, poster filter, `extractNumber/romanToInt`, title/author heuristics, surname-frequency guard. Pure, language-agnostic-ish (multilingual keyword lists), zero requires.
- `vbook-runtime/lazy-book/parser.js`: `splitIntoChapters` (map → legacy chapter DTO), `splitIntoScenes`, `splitIntoUnits`, `injectChapterMarkers`, `firstMeaningfulChapter`.
- `vbook-runtime/language-detector.js`: source-language detection (tinyld, confidence gates, boilerplate strip).

### 4.2 What does NOT belong to Parser Core (misplaced today)

- `lazy-book/parse.js` (`lazyParseNextWindow/lazyParseChapter`) — despite the filename, this is **window materialization + persistence**: reads draft state, generates ids, builds typography intro scenes (VBook presentation concern), writes chapter JSON files, rewrites `chapters_order`, flips book state. This is **Book Writer**, executed against the VBook disk model. Keeping it under the "parser" name inside the runtime is the main source of the "Parser vs VBook" confusion.
- `chapter-utils.js` typography/cover prompts — VBook presentation (generation-facing image prompts), not parsing.
- `injectChapterMarkers` is used only by the AI path (`pipeline-runner.getWindowText:233`) — it is an **AI prompt preparation** utility, arguably Analyzer-side; it stays deterministic, so it can remain in Parser Core as an optional helper, but its only consumer today is the LLM window.

### 4.3 VBook runtime coupling of the parser facade

`parser.js` inside the runtime is generic *except*:
1. It consumes the injected `structureDetector` port (good — no reverse dependency).
2. `detectLanguage` requires `../language-detector` (runtime-internal, fine).
3. Its output DTO (`{title,type,label,number,startLine,endLine,startOffset,endOffset,length}`) is a **legacy array contract** preserved for host callers — this is the implicit Parser contract today.

**Can the deterministic parser be extracted without reverse VBook dependency?** Yes — `splitIntoChapters/Scenes/Units/detectLanguage/injectChapterMarkers` plus the port have no VBook-specific types, no fs, no draft access. The only blocker is that `parse.js` (Book Writer) sits in the same `lazy-book` barrel and host code calls `lazyBook.splitIntoChapters(...)` through it (e.g. `pipeline-runner.js:114`, `txt-importer.js:267`, `status-routes.cjs:63`).

---

## 5. AI Analyzer Analysis

### 5.1 What Animastor actually needs semantically

From the pipeline outputs that reach the Book Writer:
- **structure**: `{author, title, has_prologue, has_epilogue, parts[], chapters[], segments[], country, epoch}` (segment = chapter map unit with offsets)
- **characters**: `[{id, name, role, …passport fields}]`
- **mentions**: `{alias → character_id}` (role/title → character mapping)
- **locations**: `[{id, name, …, environment{time,season,lighting,weather,mood,atmosphere,country,epoch}}]`
- **scenes**: narrative episodes with `title`, `location.id`, optional `environment` override, ordered, source-coverage-validated against the window text
- **units**: visual decomposition `{type, text, audio, image, video, participants}`
- derived: voices, visual reconciliation — these are **generation-phase** concerns, not import-analysis, but currently run inside `runPipeline`.

### 5.2 Provider-specific vs generic

- Provider handling (`ai-caller.js` AsyncLocalStorage + `workspace-ai-provider` + `ai-service.js` OpenRouter-compatible transport) is entirely host-side and reusable across features — the Analyzer should only see a `callAI(messages, {maxTokens})` seam.
- Prompts (`agent-prompts.js` SYSTEM_PROMPTS, language filling) and step orchestration/retry/logging (`logConversation` → PG `agent_conversations`) are Analyzer-internal but persistence-aware.
- Validation around AI output is deliberately **deterministic**: `sanitizeStructure` (hallucination guard), `source-coverage` (scene coverage/repair loop), snake-guard, `normalizeSceneEnvironment`. These belong to the Analyzer's *output contract enforcement*, not to the LLM adapter.

### 5.3 Where the Analyzer boundary should be

`stepAnalyzeStructure` + `mergeAiDecisions`/`sanitizeStructure` already form the minimal AI-analysis unit: `Text + candidates → ChapterMap (ai-refined)`. Characters/locations/scenes/units are the wider `AIAnalysisResult`. The provider adapter seam is `aiCaller.callAI`; session/progress/Redis must move OUT of the analyzer's contract into the orchestrator (callback-based), otherwise the analyzer can never be replaced or tested without PG/Redis.

---

## 6. Importer Analysis

`txt-importer.js` is a thin facade over three mixed concerns:

| Export | Actual concern | Coupling |
|---|---|---|
| `decodeTxtBuffer` | Encoding wrapper | config.TXT_MAX_SIZE |
| `validateAiText` | Input validation | config |
| `importTxtFile`/`importAiText` | **dead in routes** (verified: no caller outside the module; routes do their own decode+dedup+draft inline) — duplicated logic risk | draft write |
| `bootstrapImportedText` | idempotence + artifact cleanup + delegate to agent | lazyBook, agent-service (lazy require) |
| `bootstrapNextWindow` | delegate | agent-service |
| `lazyParseNext/lazyParseToPosition` | deterministic window delegation | lazyBook |
| `getParsedChaptersSummary` | read model | lazyBook |

Routes additionally own: multipart, dedup (`resolveOwnedTxtDedup`), source hash registration (PG `book_source_repo`), workspace ownership, manifest patching, chunk/Redis/placeholder-audio side effects, SSE wiring (`publishProgress(redis,…)`), and `trigger-next-window` server-side trigger logic (cooldown/dedup in Redis, tail detection).

**Conclusion:** a source-specific `TxtImporter` already exists conceptually but is split between the service, routes, and agent bootstrap. A generic Importer must be an orchestrator port-holder: it coordinates Decode → Parser → Analyzer → Writer and owns progress/events/retry — it must NOT itself implement parsing or AI calls. Epub/Fb2 adapters are future source adapters implementing the same `ImportInput` front half; do not build them now.

---

## 7. Encoding Layer Analysis

`encoding-detect.js` is the cleanest extraction candidate:

- Input: `Buffer`; Output: `{text, encoding, label, error, warnings, score}`.
- Deps: `iconv-lite` only. Own BOM strip, UTF-8 validation via U+FFFD counting, byte-level win1251/koi8-r heuristic, bigram scoring, control/replacement char thresholds.
- Handles: binary detection (NUL in first 1 KB), empty buffer, undecodable input — all as **result objects** (no throws), which is a good error-transport precedent.
- Leaks to fix at extraction: `console.log` (2 call sites), and the size limit which today lives in `txt-importer.decodeTxtBuffer` via `config.TXT_MAX_SIZE` (limit is an Importer concern, not a decoder concern).

---

## 8. Book Writer / Persistence Analysis

Book persistence today = VBook runtime disk model + host side-effects:

| Operation | Where |
|---|---|
| Draft creation (`createDraftBook`, source.txt + manifest + book.json) | `vbook-runtime/lazy-book/draft.js` |
| AI-window materialization (characters/locations/mentions/scenes/units files, chapters_order, state) | `vbook-runtime/lazy-book/create.js` (`createFromAnalysis/appendToBook`) |
| Deterministic window materialization (chapter JSON writes) | `vbook-runtime/lazy-book/parse.js` |
| Metadata/state updates | `metadata.js`, `draft.js` |
| Bundle save/load/reset | `vbook-runtime/src/index.js` |
| Host side-effects around it (chunks in Redis, placeholder audio, PG session bookkeeping, source hash registry) | routes + bootstrap |

What Parser/AI/Importer actually need from the model (the future **BookWriter port**):
1. `createDraft(input) → {bookId}`
2. `saveStructure(bookId, ChapterMap)` (title/author/parts/segments → book.json)
3. `saveWindow(bookId, WindowAnalysis) → WriteResult` (characters/locations/mentions/scenes for a window; idempotent per window index)
4. `appendWindow` (equivalent for continuation)
5. `materializeChapters(bookId, chapterMap, {from,to})` (deterministic lazy parse)
6. `getState(bookId)`, `updateState(bookId, state)`
7. `getLastSourceEnd(bookId)` (resume offset — currently bootstrap reads disk directly, `bootstrap.js:293`)

The pipeline *conveyor* (pipeline-runner → materialized scenes) and `createFromAnalysis` already communicate through a plain JSON DTO (`analysis`), which is 80 % of the port's shape. The main blockers: `parse.js` writing files directly, and host-side id generation/`chapters_order` semantics being implicit.

---

## 9. VBook Boundary

**Should remain in VBook runtime:** bundle/manifest/book-model CRUD, draft lifecycle, booksRoot port, id grammar, snake-guard/character-identity/scene-title-utils, typography/cover presentation, state machine (`RAW_IMPORTED → BOOTSTRAPPED → ACTIVE`), lazy-window materialization against its own disk layout.

**Generic (candidate for Parser Core):** the *pure* functions of `lazy-book/parser.js` + `language-detector.js` + (host-side, pure) the deterministic half of `structure-detector.js`.

**Currently in "lazy-book" but conceptually not VBook:** the parsing facade itself (`parser.js`), the language detector, and `parse.js`'s *parsing* logic (its *writing* logic is VBook).

**Dependencies replaceable by ports:** structureDetector (already), booksRoot (already), fs-root provider (already); remaining: `console.log` side effects, `detectLanguage` hard require (fine — pure), and the fact that `parse.js`/`create.js` mix computation with persistence — the BookWriter port is the fix.

**Do NOT move code merely because it is named "parser":** `parse.js` is a Writer; `structure-detector.js`'s AI-merge half is Analyzer-side; `unit-splitter.js` is generation-phase tooling.

---

## 10. Dependency Graph

```
                     ┌──────────────────────────────────────────────┐
 routes ─────────────► Importer (txt-importer + agent/bootstrap)     │
  redis, PG, SSE      │  deps: lazyBook, config, ai-provider,        │
                      │        PG(agent_sessions), Redis, SSE        │
                      └───┬───────────────┬──────────────┬───────────┘
                          ▼               ▼              ▼
                 Encoding Detector   Parser Core     AI Analyzer
                 (iconv-lite only)   (pure; port:    (deps: aiCaller→ai-service→
                                      structure-       provider; PG logging; prompts;
                                      Detector)        validation: source-coverage,
                                          │            snake-guard)
                                          ▼                │
                                     Book Writer ◄─────────┘
                                     (lazy-book create/parse/draft;
                                      ports: booksRoot, structureDetector)
```

**Cycles / hidden couplings found:**
1. **Host → package → host port loop (intentional, healthy):** `backend.cjs` binds `services/structure-detector` into the runtime's parser. No require cycle (port indirection), but the *contract* is untyped (`buildDeterministicMap` duck-typing, documented in a comment as "seed of C13").
2. **`parse.js` (Writer) is exported through the same barrel as parsing** — `lazyBook.splitIntoChapters` used by `pipeline-runner`, `txt-importer`, `status-routes` makes Parser↔Writer appear fused.
3. **Lazy requires hide runtime deps:** `txt-importer.js:204` requires `agent-service` inside a function; `bootstrap.js:67/97/109/341` require provider/PG modules inline; `pipeline-steps.js:210` requires structure-detector inline. Grep-level dependency maps will miss these.
4. **Global singletons/config:** `runtime-config` (TXT_MAX_SIZE, LAZY_WINDOW_SIZE), AsyncLocalStorage provider store (`ai-caller`), `booksRoot` global, Redis client threaded as argument (good) but also reached via route closures.
5. **PG inside the Analyzer:** `ai-caller.logConversation` (agent_conversations), `agent-session` (agent_sessions), cancellation queries — these make `runPipeline` impossible to run without a DB.
6. **SSE/Redis progress inside the pipeline:** `publishVBook` closure in `runPipeline` writes Redis scene index — progress is mixed with analysis.

**Real blockers per component:**
- *Parser Core:* none technical — only the untyped port and the barrel-fusion with `parse.js` (naming/contract issue, not coupling).
- *AI Analyzer:* PG logging + session/cancellation + Redis inside `runPipeline`; provider resolution via AsyncLocalStorage (needs to become an explicit injected dependency).
- *Importer:* everything above + route-owned dedup/ownership/hash + two-phase HTTP split.
- *Encoding:* none.
- *Book Writer:* `parse.js`/`create.js` mixing computation with direct fs; `chapters_order` and id-generation semantics implicit.

---

## 11. Proposed Contracts

All contracts are plain JSON-serializable DTOs; versioning via additive optional fields + a `contractVersion` on envelope objects; errors as result objects (`{ok:false, error:{code, message}}`) for sync boundaries and typed rejections for async ones.

### 11.1 Parser Core

```ts
// Parser: Text → ParserResult  (pure, sync, no IO)
interface Parser {                       // port currently: setStructureDetector()
  buildChapterMap(text: string): ChapterMap;          // exists as buildDeterministicMap
  splitScenes(chapterText: string): string[];         // exists as splitIntoScenes
  detectLanguage(text: string): LanguageResult;       // exists (tinyld)
  injectChapterMarkers?(text: string): string;        // optional AI-prompt helper
}

interface ChapterMap {                    // ≈ ParserResult (today's buildDeterministicMap output)
  contractVersion: 1;
  title:   { text: string; candidateId?: string; source: 'detect' } | null;
  author:  { text: string; candidateId?: string; source: 'detect' } | null;
  hasPrologue: boolean; hasEpilogue: boolean;
  parts: { name: string; order: number }[];
  segments: ParserSegment[];              // never empty; ≥1 'body' segment guaranteed
  source: 'detect';
}
interface ParserSegment {
  type: 'chapter'|'prologue'|'epilogue'|'part'|'introduction'|'afterword'|'appendix'|'body'|'poem';
  label: string | null;                   // verbatim keyword ("Глава")
  title: string | null; number: number | null; headerLine: string | null;
  startOffset: number; endOffset: number; // char offsets into the SAME text instance
  source: 'detect'|'ai';
}
interface LegacyChapterDTO { title; type; label; number; startLine; endLine; startOffset; endOffset; length }
//                          ↑ projection of ParserSegment, kept for status-routes/pipeline-runner compat
```
Ownership: Parser owns offsets and their validity against the exact input string; consumers must not mutate segments. Errors: throw only on contract misuse (unbound detector); malformed text is never an error — it degrades to a single `body` segment (current behavior, must be preserved). Sync, pure.

### 11.2 AI Analyzer

```ts
// AIAnalyzer: Text + AnalysisRequest → AIAnalysisResult  (async)
interface AIAnalyzer {
  analyzeStructure(text: string, candidates: Candidate[], opts): Promise<ChapterMap>;   // exists as analyzeStructure/mergeAiDecisions
  analyzeWindow(req: WindowAnalysisRequest): Promise<WindowAnalysisResult>;
}
interface WindowAnalysisRequest {
  contractVersion: 1;
  windowText: string;                    // marker-injected window text
  rawWindowText: string;                 // pre-marker text (coverage checks)
  sourceOffsetBase: number;
  existingCharacters: Character[]; existingLocations: Location[]; existingMentions: Mentions;
  language: string;                      // ISO 639-1, localized user-facing text only
  bookDefault: { country: string|null; epoch: string|null };
  maxScenes: number;
  promptProfiles?: object;               // host-injected prompt configuration
}
interface WindowAnalysisResult {
  scenes: Scene[];                       // coverage-validated, ordered, source-anchored
  characters: Character[]; locations: Location[]; mentions: Mentions;
  coverage: { ok: boolean; gap_chars: number; next_offset: number; … };
  extraScenes: Scene[];                  // over-budget scenes for the next window (cache)
  nextOffset: number;
}
// Error surface: throws on AI-unavailable/cancelled (orchestrator decides fallback);
// returns degraded-but-valid results on partial AI failure (deterministic structure
// fallback already exists; scene fallback exists in stepCreateUnits).
```
Provider seam: `callAI(messages, {maxTokens, timeout, provider})` — stays host-side initially; the port is "an async JSON-returning callable with retry", exactly what `ai-caller.callAI` already is. Logging (PG conversations) and progress become injected callbacks (`onStep`, `log`) rather than direct PG/Redis use. Sync of sanitation: `sanitizeStructure` and `source-coverage` validators are part of the Analyzer's public behavior (deterministic validation around AI output) and must move with it.

### 11.3 Importer

```ts
interface SourceImporter {                                  // per-format adapter
  format: 'txt'|'ai-text'|'vbook'|… ;
  decode(input: ImportInput): Promise<DecodedText>;         // txt: encoding layer
  createDraft(decoded: DecodedText, opts): Promise<{bookId}>;
}
interface ImportOrchestrator {                              // format-agnostic
  bootstrap(bookId: string, ctx: ImportContext): Promise<BootstrapResult>;
  bootstrapNextWindow(bookId: string, ctx: ImportContext): Promise<BootstrapResult>;
  lazyParseNext(bookId: string, windowSize?: number): Promise<LazyParseResult>;
}
interface ImportContext {                   // host-injected capabilities — the whole point of the port
  progress: (stage: string, message: string) => void;
  publish?: (event: object) => void;        // SSE
  analyzer: AIAnalyzer; parser: Parser; writer: BookWriter; decoder: TextDecoder;
  limits: { maxSizeBytes: number; windowSize: number };
  cancellation?: { isCancelled(bookId): Promise<boolean> };
}
interface BootstrapResult { bookId; state; title; author; language;
  characters?: number; locations?: number; scenes?: number; sessionId?: string; hasMore?: boolean }
```
`ImportInput` (v1): `{ kind:'buffer', buffer, filename } | { kind:'text', text, title? } | { kind:'vbook-bundle', buffer }`. `ImportResult` mirrors today's route responses (`book_id, build_id, title, state, dedup?`). Dedup/ownership/hash-registration remain host-side route middleware initially (identity-scoped, cross-cutting); the orchestrator receives an already-allowed, already-deduplicated input.

### 11.4 Encoding / TextDecoder

```ts
interface TextDecoder { decode(buffer: Buffer): DecodeResult }   // sync, result-object errors
interface DecodeResult { ok: boolean; text: string|null; encoding: string|null;
  label: string|null; warnings: string[]; error: {code:'binary'|'empty'|'undecodable', message}|null }
```
No size limit inside (Importer validates). No `console.log`. Drop-in: current `encodingDetect.decodeBuffer` maps 1:1 (`error` → `error.code/message`).

### 11.5 BookWriter

```ts
interface BookWriter {                                      // async (fs), one impl = VBook disk model
  createDraft(input: { text; sourceType; title }): Promise<{bookId}>;
  saveStructure(bookId, map: ChapterMap): Promise<void>;
  saveWindow(bookId, result: WindowAnalysisResult, meta: {chapterTitle; chapterIndex; windowIndex; isFirstWindow}): Promise<WriteResult>;
  materializeChapters(bookId, { fromIndex, toIndex }): Promise<LazyParseResult>;   // absorbs parse.js writes
  getState(bookId): Promise<{state; chapters: ChapterRef[]; lastSourceEnd: number|null}>;
  updateState(bookId, state: 'RAW_IMPORTED'|'BOOTSTRAPPED'|'ACTIVE'): Promise<void>;
}
```
First implementation = thin wrapper over existing `draft.js/create.js/parse.js/metadata.js` — no rewrite, just an interface over the current public functions (they already take plain DTOs).

---

## 12. Proposed Package Boundaries

| Package | Responsibility | Public API | Dependencies | Must NOT contain |
|---|---|---|---|---|
| `@animastor/encoding-detector` (or merged into parser pkg initially) | `Buffer → Text` | `decode(buffer)`, `detectBom`, labels | iconv-lite | size limits, fs, progress |
| `@animastor/parser` (Parser Core) | `Text → ChapterMap/Language` | `Parser` port impl + DTO types | tinyld; **port:** structure-detector impl injected | LLM, fs, Book model writes, Redis/PG, window materialization |
| `@animastor/ai-analyzer` (later) | `Text+candidates → ChapterMap`; `Window → WindowAnalysisResult` | `AIAnalyzer` + DTOs | port: `callAI`; validation utils | provider transport (host), PG sessions, Redis/SSE, book writes |
| `@animastor/text-importer` (later) | orchestration | `ImportOrchestrator`, `SourceImporter` adapters | depends on the three ports above | parsing logic, AI prompts, persistence implementation, HTTP |
| `@animastor/vbook-runtime` (exists) | Book model + disk layout + Writer impl | current exports + future `BookWriter` impl | adm-zip, tinyld | AI, HTTP, Redis/PG |

**Do not physically extract yet:** Parser Core (already inside vbook-runtime — moving it again before the C13 contract is typed would be churn), AI Analyzer (port first, package later), Importer (only after context injection lands). Encoding could be extracted safely now but gains little alone; cheapest path is exporting it from the parser package together with Parser Core.

---

## 13. Migration Plan

| # | Step | Prerequisites | Risk | Affected files | Tests | Rollback |
|---|---|---|---|---|---|---|
| 1 | **Type the C13 Parser contract** — freeze `ChapterMap`/`ParserSegment` as documented DTO + validation helper; keep `setStructureDetector` as the binding seam | none | very low | docs, optional `packages/animastor-vbook-runtime/src/contracts.js` (pure, additive) | assert runtime + detector satisfy the contract (existing `structure-detector.test.js` + package suite) | revert doc/type file |
| 2 | **Extract Parser Core facade** — move/re-export pure parser functions under a dedicated export path (`@animastor/vbook-runtime/parser-core` or new tiny pkg); keep legacy barrel re-exports | step 1 | low | `packages/…/lazy-book/parser.js`, `language-detector.js`, host shims | package suite + `structure-detector.test.js` `splitIntoChapters (lazy-book integration)` block | re-point shims back |
| 3 | **AI Analyzer boundary** — `runPipeline`/`stepAnalyzeStructure` stop touching PG/Redis directly: inject `logStep`, `onProgress`, `isCancelled` callbacks from bootstrap; `ai-caller` provider context stays | none (host-internal) | medium — touches hot path of all imports; behavior must be byte-identical | `pipeline-runner.js`, `pipeline-steps.js`, `bootstrap.js`, `ai-caller.js` | `pipeline-runner-parallel.test.js`, `bootstrap-cancel-continue.test.js`, `scene-cache.test.js`, mocks-based step tests | revert wiring; callbacks default to current implementations |
| 4 | **Encoding layer port** — `TextDecoder` interface + remove size limit from decoder wrapper into caller | none | very low | `txt-importer.js`, import-routes | new encoding golden tests (§14) | keep old wrapper as alias |
| 5 | **BookWriter port** — interface over `draft/create/parse/metadata`; `parse.js` writes routed through it internally first | steps 1–2 | medium | `lazy-book/parse.js`, `create.js`, new `writer.js` in runtime | package suite `draft lifecycle → bundle round-trip`, `createFromAnalysis integration` | interface defaults to direct calls |
| 6 | **Importer orchestration** — `ImportContext` injection; move route-inline dedup/hash/ownership behind narrow host hooks; retire dead `importTxtFile/importAiText` | steps 3–5 | high (largest surface) | `txt-importer.js`, `bootstrap.js`, import-routes, parse-routes | `txt-import-ownership.test.js`, `happy-path.test.js`, new import e2e fixtures | keep legacy facade exports delegating to new orchestrator |
| 7 | **Physical package extraction** of `@animastor/parser` (+ encoding) and later `@animastor/ai-analyzer` | steps 1–6 + golden fixtures green | medium (versioning/CI) | packages/*, backend package.json | full suite + fixture diff harness | npm aliases / shims (proven pattern) |

Order rationale: contract-first (steps 1–2 are near-zero-risk and unblock everything), then decouple the Analyzer from infrastructure (highest-value decoupling at medium risk), then Writer, then Importer, then physical moves. This matches the repo's proven pattern (VBook runtime relocation: shims → ports → move).

---

## 14. Test Strategy / Golden Fixtures

Existing coverage to preserve:
- `backend/tests/structure-detector.test.js` (~900+ lines): deterministic map, universality (no forced structure), merge decisions, hallucination guard, lazy-book integration, createFromAnalysis integration, surname-frequency, template learning (Master i Margarita), inverted title page, typography intros. **This is the Parser/AI-merge golden suite.**
- `packages/animastor-vbook-runtime/test/package-suite.test.js` (21 its): booksRoot port, id grammar, draft lifecycle round-trip, detector stub injection, Book Model facade, bundle validator.
- `language-detector.test.js` (incl. pipeline wiring TXT→book.json), `scene-split.test.js`, `unit-splitter.test.js`, `txt-import-ownership.test.js`, `bootstrap-cancel-continue.test.js`, `pipeline-runner-parallel.test.js`, `scene-cache.test.js`, `source-coverage.test.js`.

Gaps to close before/with extraction:
1. **Encoding golden fixtures** (currently none): binary-in-first-1KB, empty, UTF-8 with BOM, UTF-16LE/BE, cp1251, koi8-r, iso-8859-5, ibm866, mixed-language scoring, file with >15 % control chars, undecodable → assert `DecodeResult` exactly.
2. **Parser fixtures** (`/tests/fixtures/` corpus of small books): classic `Глава N. Title`; ALL-CAPS headings; poster lines inside chapters (М&М case); poem/fragment (single `body` segment); inverted title page; epigraph top; decorative-period title; empty file; 1-char file; 10 MB boundary. Each fixture = input text + expected `ChapterMap` JSON → regression harness executable in-package and in-host (guards the port).
3. **AI Analyzer contract tests:** malformed LLM output (unanchored candidates, confidence <0.5, bare-number titles, duplicate chapter classification) → deterministic result unchanged; structure fallback on AI failure; coverage repair loop paths (already partially in `scene-split.test.js`).
4. **Importer tests:** decode-failure propagation, empty text, oversized text, partial window failure → session `failed` + no partial chapters left (cleanup path exists — untested), resume/retry (`resume-bootstrap`), cached-scene replay, `all_done` semantics, progress stage sequence snapshot.

---

## 15. Risks / Blockers

1. **Untyped port contract (C13)** — the detector port is duck-typed with the contract living in comments (`parser.js:80-92`). Highest-leverage, lowest-risk fix; without it any extraction is behavior-preserving by luck.
2. **`parse.js` misnomer** — Writer logic under a parsing name in the runtime barrel; any "move the parser" effort guided by names would cut the wrong line (§9).
3. **Infrastructure embedded in `runPipeline`** — PG logging, session cancellation, Redis progress: blocks Analyzer testing/replacement; fix = injected callbacks (step 3).
4. **Dead duplicated import API** — `importTxtFile/importAiText` uncalled; routes re-implement decode+dedup+draft inline → drift risk when changing import behavior.
5. **Two-phase HTTP import** (import → bootstrap) is a product behavior (resume/dedup across workspaces, identity-scoped dedup) — Importer contract must keep draft creation separate from analysis; do not "simplify" into one call.
6. **Offset discipline** — everything anchors on char offsets into the exact source text; any component boundary must forbid text re-normalization (trim/CRLF) between Parser and Writer, or anchors break (several production bugs referenced in comments attest to this).
7. **Lazy requires** hide true dependency edges — dependency audits must grep inline `require(` (several found in §10.3).

---

## 16. Final Verdict

| Component | Verdict | Main blockers |
|---|---|---|
| **Parser Core** | **READY AFTER PREPARATION** | Contract is implicit (duck-typed port); pure code is already package-side; needs frozen DTO + dedicated export path (steps 1–2). No reverse-VBook dependency exists to remove. |
| **AI Analyzer** | **READY AFTER PREPARATION** | PG logging, session/PG+Redis cancellation, and SSE/Redis progress are embedded in `runPipeline`; provider context is Ambient (AsyncLocalStorage). Boundary itself already exists (`structure-detector` merge half + pipeline steps). |
| **Text Importer** | **NOT READY** | Deepest coupling: two-phase HTTP flow, route-owned dedup/ownership/hash, artifact cleanup, cached-scene resume, dead duplicated API. Requires Analyzer and Writer ports first (steps 3–5). |
| **Encoding Detector** | **READY** | Single dep (iconv-lite), result-object errors, no fs/config. Only cosmetics: console.log, size-limit placement. |
| **Book Writer / Port** | **READY AFTER PREPARATION** | Operations are concentrated and DTO-shaped already; blocker is `parse.js`/`create.js` mixing computation with direct fs writes and implicit `chapters_order`/id semantics; interface-over-current-code is low risk. |

**One-sentence boundary answer:** Parser ends where text becomes `ChapterMap` (+ scenes/units/language) with offsets into the exact input; AI Analyzer begins at candidate *classification* and window *semantic* analysis and ends at a validated `WindowAnalysisResult`; the Importer owns decode→draft→bootstrap→window orchestration and progress; processing ends and Book persistence begins at `createFromAnalysis`/`appendToBook`/`lazyParseNextWindow` file writes — today all four live in three physical places, and the fastest path to independence is freezing the already-emerging ports (`setStructureDetector`, `booksRoot`, `callAI`, the `analysis` DTO) rather than moving files.
