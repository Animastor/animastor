# VBook Extraction Readiness Audit — `backend/src/book/` → `@animastor/vbook-runtime`

**Status:** READ-ONLY audit. No production code changed, no refactor performed, no package created, no files moved. Only this document was added.
**Date:** 2026-09-06
**Baseline:** HEAD `7cf3f849` (post Phase-Next reconnaissance)
**Predecessors:** `docs/architecture/PHASE_NEXT_MODULE_EXTRACTION_RECONNAISSANCE.md` (ranked VBook #1), `PHASE_7_EXTRACTION_READINESS.md` §2.1/§4.4, `PHASE_2_CONTRACTS.md` §2–§4, `PHASE_4_BOOK_MODEL.md`, `MODULAR_PRODUCT_ARCHITECTURE.md` §5/§24 (C1/C2)/§26/§30.
**Method:** full require-graph enumeration of all 15 files in `backend/src/book/` (3,520 LOC), full reads of every outward dependency (`structure-detector.js` 1231 LOC, `language-detector.js` 148, `character-identity.js` 294, `snake-guard.js` 614, `scene-title-utils.js` 53), consumer-by-consumer usage analysis, test-suite inventory (28 host test files), guard-test inspection. Every claim is measured at HEAD.

---

## Verdict (summary table)

| Question | Answer |
|---|---|
| Extraction readiness | **READY AFTER PREPARATION** |
| Extraction risk (1–5, lower = better) | **2** |
| Cycles involving book domain | **0** (measured; book is in no SCC) |
| Direct outward requires of `book/` | **7 edges + 2 npm libs** (complete list in §1) |
| Hidden/dynamic deps found | **3** (§7): `process.env.HUB_URL`/`GPU_HUB_API_KEY` inside `book-deletion.cjs`, require-time `BOOKS_DIR` env read, snapshot-path knowledge duplicated host-side |
| C1 JSON Schema | **does not exist** — `bundle-validator.cjs` is the de-facto contract |
| Blockers | 3 (§9) |

---

## 1. Complete dependency inventory of `backend/src/book/`

Package file inventory (15 files, 3,520 LOC):

```
book/index.js 848 | book-model.cjs 165 | bundle-validator.cjs 284 | book-deletion.cjs 201
lazy-book/: index 93, paths 38, constants 32, draft 171, parser 193, parse 249,
            create 720, chapter-utils 222, appearance 179, metadata 48, status 77
```

The **complete** outward require surface (nothing else exists — verified by exhaustive grep over all 15 files):

| # | Edge | Site(s) | What is used |
|---|---|---|---|
| 1 | `adm-zip` (npm) | `index.js:46` | zip extract/create for bundles (`extractBookBundle`, `addDirToZip`) |
| 2 | `config/runtime-config` | `index.js:48,92`; `lazy-book/paths.js:3,5` | **only `BOOKS_DIR`** (two read sites) |
| 3 | `services/language-detector` | `lazy-book/draft.js:15` (top-level); `lazy-book/parser.js:186` (lazy) | `detectLanguage(text)` → writes canonical `book.json.language` |
| 4 | `services/structure-detector` | `lazy-book/parser.js:80` | `buildDeterministicMap(text)` only (parser.js:93) |
| 5 | `utils/character-identity` | `lazy-book/create.js:10` | `findCanonicalCharacter`, `isGenericCharacter`, `isPlaceholderCharacter`, `hasRealAppearance` (registry write barrier) |
| 6 | `utils/snake-guard` | `lazy-book/create.js:11` | `sanitizeParticipants`, `findCanonicalId`, `canonicalizeMixedScriptId`, `isFantasySnakeToken`, `sanitizeEnvironment` |
| 7 | `utils/scene-title-utils` | `lazy-book/chapter-utils.js:8` | `extractSceneTitle`, `isGenericSceneTitle` |

Non-require couplings found inside the directory:

- `book-deletion.cjs` — **zero outward requires** (all adapters injected: `book`, `redis`, `storage.postgres.query`, `config`, `getAllChunks`, `getChunk`, `cleanBookRedisKeys`, `setCancelFlag`), but reads `process.env.HUB_URL` / `process.env.GPU_HUB_API_KEY` directly at `:184,186` (best-effort hub queue clear, step 6 of the cascade).
- `bundle-validator.cjs` — fully self-contained (284 LOC, regexes + shape checks only).
- No `process.env` reads anywhere else in the directory; no Redis, no PG, no runtime/orchestration/routes requires; no dynamic/variable `require()` (verified).

### 1.1 Per-dependency classification

| Dependency | Category | Rationale |
|---|---|---|
| `adm-zip` | **KEEP INSIDE VBOOK** | Pure npm lib; zip I/O is the bundle format's core mechanic. Becomes a declared package dependency. |
| `tinyld` (via `language-detector`) | **EXTRACT WITH VBOOK** | Pure npm lib (zero deps itself); language of the source text is a canonical bundle field (`book.json.language`) — production of canonical content belongs to the package. |
| `services/language-detector` (148 LOC) | **EXTRACT WITH VBOOK** | Fully pure (only `tinyld`), zero host edges, and its *only* semantics is "language of the book source" — book-domain. Host consumers (`agent-prompts.js:169` via parser; `services/agent/*` indirectly) switch to the package export; a one-line re-export shim at the old path keeps the transition behavior-neutral. |
| `services/structure-detector` (1231 LOC) | **REPLACE WITH PORT/INTERFACE** (leave in host initially) | See §2 for the full analysis. Verdict: **C — leave in host, port.** Zero host requires (technically movable), but the agent pipeline is the primary consumer (6 call sites vs 1), the LLM-merge path is import-pipeline doctrine, and the concept doc (§8) is explicit: **Parser ≠ VBook**. A port with a documented ChapterMap shape seeds the future C13 parser contract. |
| `utils/character-identity` (294 LOC) | **EXTRACT WITH VBOOK** | The character-registry identity doctrine ("what is a real character") is enforced by the package's write barrier (`create.js`) — the defining consumer. Pure (zero requires). Agent consumers (`pipeline-runner.js:12`, `pipeline-steps.js:23`) keep importing via a host re-export shim → package. |
| `utils/scene-title-utils` (53 LOC) | **EXTRACT WITH VBOOK** | Pure, trivial; scene-title semantics of the canonical model. Host consumers (`agent-service.js:24`, `agent/text-utils.js:7`) migrate via shim. |
| `utils/snake-guard` (614 LOC) | **EXTRACT WITH VBOOK** (with a recorded caveat) | Its registry-protection half (`sanitizeParticipants`, `findCanonicalId`, `isFantasySnakeToken`, …) IS the package's write barrier. Caveat: the cross-prompt consistency half (`findCrossPromptGaps`, `participantFieldIds`, `GROUP_NOUNS`) is agent-pipeline doctrine riding in the same file; it extracts along (host consumes via package) — a later split into the agent domain is possible but is explicitly out of scope for this extraction. `snake-guard` requires only `character-identity` → the two move together. |
| `config/runtime-config` (`BOOKS_DIR`) | **REPLACE WITH PORT** — **BLOCKER — NEEDS PREPARATION** | The only host-config edge. `runtime-config.js:61` reads `process.env.BOOKS_DIR` **at require time**, so the package would inherit an env/paths dependency (anti-pattern §26). Replaced by a `booksRoot` injection (§3). Two read sites only — mechanically small, but tests set the env pre-require today (§5), so it is a real preparation item, not a one-liner. |
| `book-deletion.cjs` | **LEAVE IN HOST** | It is the host-side deletion *orchestrator*: Redis cancel flags + key purge, PG 24-table cascade, `OUTPUT_DIR` artifact removal, hub queue clear (`process.env.HUB_URL`). None of this is bundle-format logic. Only its step 2 (`book.resetBook` + snapshot unlink) touches canonical state — via the package's public API. Host keeps the file (physically relocating it out of `book/` is optional cosmetics; the package `files` allowlist simply excludes it). |
| snapshot file knowledge (`{booksRoot}/{id}.snapshot.json`) | **LEAVE IN HOST** | Writers/deleters are host-side (`services/task-handler.cjs:242,254`, `book-deletion.cjs:95`); the path lives *next to* the bundle but is not part of the format (never inside the zip, not in the validator). Recorded as a host-owned path convention. |
| `HUB_URL` / `GPU_HUB_API_KEY` env reads in `book-deletion.cjs:184,186` | **LEAVE IN HOST** | Confirms §"book-deletion stays host". Hidden dependency worth pinning in a guard when the package boundary lands (the package directory must not read env). |

Resulting package dependency list: `adm-zip`, `tinyld` — **two pure npm libs, nothing else**. Post-extraction `VBook → backend` edges: **zero**.

---

## 2. Deep dive: `services/structure-detector` (the main question)

### 2.1 What it is (measured, full read of 1231 LOC)

A pure text-structure analysis library implementing the v2 import doctrine (`docs/04-planning/TXT_IMPORT_STRUCTURE_V2.md`): the program finds candidate heading lines, builds a deterministic chapter map, and merges optional LLM classifications onto that deterministic backbone.

**Zero requires.** The file has no `require()` at all — no npm, no host, no node builtins beyond pure JS. It is a self-contained algorithm.

Public surface (module.exports): `STRUCTURE_KEYWORDS`, `extractCandidates`, `matchKeyword`, `buildDeterministicMap`, `mergeAiDecisions`, `mapToStructureChapters`, `analyzeStructure`, `sanitizeStructure`, `isAuthorSurnameACharacter`, plus 4 `_`-prefixed internals exposed for tests.

### 2.2 What VBook actually uses

Exactly **one function**: `buildDeterministicMap(sourceText)` at `lazy-book/parser.js:93`, wrapped by `splitIntoChapters(text)` which converts the map's `segments` (offsets, types, titles, numbers) into the legacy chapter array `{ title, startLine, endLine, startOffset, endOffset, length, type, label, number }`. That array feeds `lazyParseNextWindow`/`lazyParseChapter` (draft window materialization).

### 2.3 Who else uses it (measured)

| Consumer | Call sites | Functions used |
|---|---|---|
| `book/lazy-book/parser.js` (VBook side) | 1 | `buildDeterministicMap` |
| `services/agent/pipeline-steps.js` | 5 (:210,:213,:269,:276,:287,:294) | `extractCandidates`, `buildDeterministicMap`, `analyzeStructure` (LLM merge), `mapToStructureChapters` |
| `services/agent/bootstrap.js` | 1 (:127) | `extractCandidates` |
| tests | `structure-detector.test.js` (**72 `it()` blocks**), `dependency-guardrails.test.js` (allowlist pin) | full surface |

**The agent pipeline is the primary consumer** — both by call-site count and by the semantics of what it uses (the LLM-merge path `analyzeStructure(text, aiResult)` exists solely for the agent bootstrap analysis; VBook's deterministic path is the no-LLM fallback of the same pipeline).

### 2.4 Can the needed part be split out?

Mechanically yes — the file is pure. But a *partial* split (deterministic half in VBook, LLM-merge half in host) would cut one cohesive algorithm into two files with a shared private vocabulary (candidates, anchors, sanitizers) — a real refactor with regression risk across 72 pinned tests, for zero extraction benefit. A *full* move into VBook is technically safe but architecturally wrong: it would put the text-parsing doctrine inside the format package, contradicting the documented **Parser ≠ VBook** separation (concept §8), and would make the future C13 parser contract an afterthought of a done deal.

### 2.5 Does extracting it drag other parts of `services/` with it?

**No.** Verified: structure-detector requires nothing. Its extraction (if ever) would pull only its own test file. The "half of backend" scenario does **not** materialize: the feared pull-chain (txt-importer → agent pipeline → orchestrators) does not exist in the require graph — the agent pipeline consumes the detector, not the other way around.

### 2.6 Verdict for structure-detector

**C — leave in host, replace the direct dependency with a port.** Concretely:

- VBook defines a port: `structureDetector.buildDeterministicMap(sourceText) → ChapterMap` where `ChapterMap = { title?, author?, hasPrologue, hasEpilogue, parts, segments: [{ type, label, title, number, headerLine, startOffset, endOffset, source }] }`. This shape is already the de-facto interface between the two modules — writing it down is the seed of contract **C13** (Parser/import).
- `lazy-book/parser.js:80` (top-level require) becomes an injectable binding (module-level `setStructureDetector()` with a fail-closed getter, or explicit option threading through `parse.js`). Host composition root binds the real implementation once at startup — behavior-neutral.
- The package's own tests exercise `splitIntoChapters` against golden ChapterMap fixtures via an injected stub; the host-side contract test pins real-detector → package output (non-vacuous, survives refactors).
- Evolution path (documented, not scheduled): when C13 work starts, structure-detector becomes its first reference implementation (`@animastor/parser` or equivalent) implementing the same ChapterMap contract — zero changes on the VBook side.

Risk of choosing C vs A (include): A would make the package standalone-richer but cements parser-in-format and adds 1231 LOC (+35%) of non-format code to the package's review surface. C keeps the package at ~3,700 LOC of pure format/registry logic.

---

## 3. `BOOKS_DIR` and filesystem ownership

### 3.1 Measured usage

| Site | Usage |
|---|---|
| `config/runtime-config.js:61` | `const BOOKS_DIR = process.env.BOOKS_DIR \|\| '/data/books'` — **read at module require time** |
| `book/index.js:48,92` | `getBooksDir() { return config.BOOKS_DIR; }` → `getBookDir`, `getBookPath` |
| `lazy-book/paths.js:3,5` | same pattern; all 13 path getters derive from it |
| `book-deletion.cjs:95` | snapshot path via **injected** `config.BOOKS_DIR` (stays host) |
| `services/task-handler.cjs:242,254` | host-side snapshot writer (stays host) |
| 6 test files | set `process.env.BOOKS_DIR` **before requiring** lazy-book (proof of the require-time coupling) |

Path layout computed inside `book/` (all in `paths.js` + `index.js`): `{booksRoot}/{bookId}/` containing `source.txt`, `manifest.json`, `book.json`, `characters.json`, `mentions.json`, `bible.json`, `locations.json`, `voices.json`, `behavior.json`, `cover.json`, `chapters/*`. **No other global config is consumed** — verified: the only `config.*` reads in the directory are `BOOKS_DIR` (package side) and `BOOKS_DIR`/`OUTPUT_DIR` (injected, host-side deletion).

### 3.2 Who should own the filesystem

The package owns the **layout and I/O semantics** (file names, JSON shapes, atomicity of save, id grammar); the host owns the **root location** (`/data/books` volume, docker mounts, env). This is exactly the Phase 7 §4.4 prescription ("lift path constants into module options").

### 3.3 Minimal port (proposed, behavior-neutral)

```js
// package: src/paths.js
let booksRoot = null;                       // fail-closed: no env fallback
function configureBooksRoot(root) {
    if (typeof root !== 'string' || !root.trim()) throw new Error('vbook: booksRoot required');
    booksRoot = root;
}
function getBooksDir() {
    if (!booksRoot) throw new Error('vbook: booksRoot not configured (call configureBooksRoot at composition root)');
    return booksRoot;
}
```

- Host `backend.cjs` (composition root) calls `configureBooksRoot(config.BOOKS_DIR)` once at startup, before any book operation — the same wiring style as the existing `createBookDeletion` DI and the `player/editor` facade injection. Production behavior is bit-identical (same resolved value, same lifetime).
- Package tests call `configureBooksRoot(tmpdir)` — replacing today's fragile `process.env.BOOKS_DIR` pre-require pattern (which exists in 6 test files solely because of the require-time env read).
- The package **never** reads `process.env` (guard-enforceable, §8 Phase E).
- Alternative considered and rejected: passing `booksDir` through every API call — invasive (every draft/parse/create signature changes) and unnecessary, since the books root is process-global by deployment reality (one volume per backend).

Hidden runtime-config coupling: **none beyond the above** (the `snapshot.json` path knowledge duplicated in `task-handler.cjs` is host-side and documented in §1.1).

---

## 4. Contract audit: C2 (Book Model API) and C1 (VBook Bundle 3.1)

### 4.1 C2 — Canonical Book Model API

Public surface of `book-model.cjs` (165 LOC) — **already minimal and correct**: `loadBook(bookId, {mode: 'full'|'lazy'})`, `getBookIdentity`, `getBookManifest`, `BookModelError(INVALID_BOOK_ID|INVALID_MODE)`, `MODE_FULL/MODE_LAZY`. Guarded by `phase4-book-model.test.js` (17 assertions) + P7-T5 facade-edge freeze. **Keep 1:1; nothing here blocks extraction.**

The wider *de-facto* public API (what consumers actually import today):

| Surface | Consumers (measured) | Verdict |
|---|---|---|
| `book/index.js` CRUD: `loadBook`, `saveBookBundle`, `resetBook`, `extractBookBundle`, `buildBookFromBundle` | backend.cjs (DI), import/export routes, agent, book-source, chat flows | **public** (C1 CRUD surface, pinned by `phase2-vbook-contract.test.js:46`) |
| `collectScenes`, `collectSceneList`, `collectSceneUnits`, `findSceneRuntimeData` | redis-helpers, scene-callbacks/scene-orchestrator (via DI), export-routes, workflows | **public** (read projections over the model) |
| `addDirToZip` | export-routes.cjs:61 | **public** (export path) — rename/namespace optional, not required |
| `lazy-book` draft/parse/status/create/metadata: `createDraftBook`, `loadDraftBook`, `updateBookState`, `lazyParseNextWindow`, `lazyParseChapter`, `getBookStatus`, `getChaptersSummary`, `createFromAnalysis`, `appendToBook`, `createOrAppendScenes`, `updateBookMetadata` | txt-importer, agent/bootstrap, agent/pipeline-runner, source-coverage-audit, placeholder-audio | **public** — this is the import/draft half of the API; it is what the "runtime" in `vbook-runtime` means |
| id generators `chapterId`, `sceneId`, `unitId`, `generateBookId` | entity-crud-routes.cjs:25 (direct!), draft.js, create.js | **public** (format-level id grammar) |
| path getters `getBookDir`, `getManifestPath`, `getBookMetaPath`, `getCharactersPath`, `getBiblePath`, `getChapterDir`, `getChapterPath`, `getSourcePath`, `getVoicesPath`, `getBehaviorPath` | bootstrap.js:138,294,483, txt-importer.js:99,162,180-183, placeholder-audio, source-coverage-audit, chat/agent flows | **public, documented** (path layout is part of the format; making these internal would force a `bookDir` handle API — not worth it now) |
| `validateBundleFile`, `validateBundleObject` (bundle-validator.cjs) | ai-routes.cjs:631,1285, chat-engine.cjs:10,518, index.js:49 | **public** (C1 enforcement API) |
| appearance helpers `fragmentAppearanceForVideo`, `extractClothing`, `sanitizeVideoTokens`, `tokensToString` | pipeline-steps.js:21, workflows/video:12 | **public with a note** — these are prompt-domain helpers over character appearance data; they ride along, marked "may move to the agent/generation domain later" |
| `loadBookFromDir` (index.js:579) | not exported | **internal** — correct today; keep private |
| `BookState/SceneStatus/SourceType/UnitType/DEFAULT_WINDOW_SIZE` | txt-importer, bootstrap, pipeline-runner | **public** (enum grammar of the format) |

**Accidentally-available internals:** none found — `module.exports` sets are deliberate and every export has ≥1 consumer. The one *conceptual* smell: `book-deletion.cjs` lives inside `book/` but is host code (see §1.1) — it is not imported by the package surface and must not enter the package `files` allowlist.

**API that cannot move 1:1:** none. Every public function is pure JS over `fs`/`path`/`crypto` + the two npm libs. The only signature-adjacent change in the whole plan is the `booksRoot` configuration (§3.3), which is a new *additive* API, not a change.

### 4.2 C1 — VBook Bundle 3.1 and the JSON Schema state

Measured state: **no JSON Schema exists anywhere** (searched `backend/`, `contracts/`, docs; no `*.schema.json`, no schema references). This matches the registry (§24: C1 "JSON Schema **pending** — Phase 1 open item") and §22.5 (rule 1 names VBook 3.1 as the first canonical schema).

The de-facto contract today is **code**, in three places that agree:
1. `bundle-validator.cjs` — post-mutation/pre-write guard: manifest objectness + `book_id` string; `book.structure.chapters_order` array-of-strings; `voices/locations/behaviors` object-keyed maps; `characters` array; id regexes `^ch-[a-f0-9]{6,}$` / `^sc-…` / `^iu-…`; `scene.participants` array of non-empty strings; JSON-serializability (NaN/circular guard).
2. Producers: `draft.js:29-47` (manifest: `vbook_version: '3.1'`, `book_id`, `build_id`, `source`, `state`, timestamps, `import_meta`; book.json: `book_id`, `version: '3.0'`, `title`, `author`, `language`, `defaults.language`, `structure.{has_prologue, chapters_order}`); `entity-crud-routes.cjs:680` (manifest v3.1 writes).
3. Guards: `phase2-vbook-contract.test.js` (16 assertions: manifest required, round-trip parity, identity semantics, validator-before-write, chapters_order spine).

**What must exist before extraction:** a `vbook-bundle-3.1.schema.json` covering (a) manifest fields incl. `vbook_version: "3.1"`, `book_id`, `state` enum = `BookState`, `source` enum = `SourceType`; (b) the 8 canonical file kinds + `chapters/*` shape; (c) id grammar (`ch|sc|iu-[a-f0-9]{6,}`); (d) `participants` rule. Plus a contract test proving **validator ↔ schema equivalence** (the `lac-contract-sync` pattern: what the validator rejects, the schema rejects, and vice versa). Authoring the schema is content work (the rules are fully enumerable from the validator), estimated small; it must land in Phase A, before the package is published, per §22.5/§23.2 (published = frozen).

---

## 5. Tests: inventory and split

28 test files in `backend/tests/` touch the book domain (measured by require scan). Classification:

**Package-owned candidates** (pure: require only `book/` + the extracting utils + `services/language-detector`; no routes/agent/runtime/PG/Redis):

| Test file | `it()` count | Notes |
|---|---|---|
| `language-detector.test.js` | 17 | moves with the detector |
| `book-metadata-patch.test.js` | 16 | draft/metadata CRUD on temp `BOOKS_DIR` |
| `book-diff-unit.test.js` | 23 | ⚠ tests `services/book-diff.cjs` too — **split**: book-side fixtures → package, diff-engine part stays host (book-diff.cjs is host code) |
| `scene-list.test.js` | 6 | `collectSceneList` unit |
| `behavior-crud.test.js` / `behavior-edit-book.test.js` | 14 / 12 | behavior JSON semantics on temp books (route-independent parts) |
| `character-passport-patch.test.js`, `scene-passport-patch.test.js`, `ai-patch-validation.test.js` (book-shape parts), `video-tokens.test.js`, `ai-participants-doctrine.test.js` (registry doctrine parts) | ~60 combined | partially portable; the doctrine halves (snake-guard/character-identity) become package unit tests |
| **new** (to be authored) | — | schema conformance, booksRoot port, fail-closed unconfigured root, round-trip golden fixtures |
| `structure-detector.test.js` (72) | 72 | **stays in host while the detector is host-side** (it also drives pipeline-runner/text-utils); its book-parser assertions become host-side *contract tests* over the port |

**Backend integration tests (stay in host, untouched or path-pinned):** `entity-crud-routes.test.js`, `behavior-crud` route halves, `txt-import-ownership.test.js`, `bootstrap-cancel-continue.test.js`, `worklist-rebuild.integration.test.js`, `layer-config-*.integration`, `ai-editor-mode.test.js`, `scope-slide.test.js`, `parallel-analysis-acceptance.test.js`, `pipeline-runner-*.test.js`, `coreference-agent.test.js`, `generation-routes.test.js` — they exercise host services/routes over the book layer.

**Architecture guards (stay in host; path/baseline updates in Phase C):** `phase2-vbook-contract.test.js`, `phase4-book-model.test.js`, `phase6-editor-player.test.js` (T3 facades), `phase7-extraction-readiness.test.js` (P7-T4 baseline → replaced by a package-isolation guard), `dependency-guardrails.test.js` (BOOK_ALLOWLIST → package guard; the workflows→book violation baseline re-points to the package entry).

**Minimal package-owned suite for graduation (§26.5):** bundle CRUD round-trip (save→build→load parity), manifest identity (`book_id` canonicalization, missing-manifest rejection), validator unit tests (all rule families incl. id regex + participants + serializability), paths/layout, draft lifecycle (create → load → update → lazy windows), parse window materialization (golden ChapterMap fixtures via stub detector), id generators, language detection, snake-guard/character-identity doctrine units, schema conformance, booksRoot fail-closed. Estimated ~15 files / ~200 assertions — largely assembled by moving the portable halves listed above.

---

## 6. Consumers and migration difficulty

All 23 direct-require sites are pinned by the P7-T4 baseline (`phase7-extraction-readiness.test.js:117-141`); DI consumers receive `book`/`lazyBook` from `backend.cjs` and need no code change. Grouped by migration cost:

| Group | Consumers | What they use | Adapter needed? | Effort |
|---|---|---|---|---|
| **Facades (cleanest)** | `player/index.cjs`, `editor/index.cjs` | `book-model.cjs` only (loadBook/identity/manifest; commit via injected writer) | No — require path change or composition-root injection | trivial |
| **Composition root (DI)** | `backend.cjs` | everything; wires book, bookDeletion, player/editor facades, routes | Binds ports (`configureBooksRoot`, detector) once | trivial |
| **DI-only routes** | core-routes, export-routes, import-routes, generation-routes(book/), chunks-routes, recover-chunks, status-routes | `book.*`/`lazyBook.*` via `deps` | No code change; composition root swap only | trivial |
| **Direct lazyBook users (services)** | `txt-importer.js`, `agent/bootstrap.js`, `agent/pipeline-runner.js`, `source-coverage-audit.js`, `placeholder-audio.js` | draft/parse/create/paths surface | No — re-export shim keeps old paths working; migrate imports opportunistically | low |
| **Direct partial users** | `agent/pipeline-steps.js` (appearance), `agent-prompts.js` (parser.detectLanguage), `entity-crud-routes.cjs` (id generators), `chat-engine.cjs` + `ai-routes.cjs` (bundle-validator) | single surfaces | No — shim or direct package import | low |
| **Runtime readers** | `runtime/scene-window.js:20`, `runtime-scheduler.js:435`, `reconciliation-engine.js:82,2108`, `orchestration/scene-callbacks.js:22`, `orchestration/scene-orchestrator.js`, `helpers/redis-helpers.cjs:75,110,279` | `book.loadBook` + `collectScenes` (read-only) | No — these become *package* consumers through the same facade; the R5/SCC baselines are unaffected (book was never in the SCC) | low |
| **Pinned violation** | `workflows/video/video-workflows.js:9,12` | `book` + `appearance.tokensToString` | Baseline update (ADR) re-pointing to the package public API | low, ADR-required |

**Player/Editor specifically (the downstream question):** they are the *best*-positioned consumers — `phase6-editor-player.test.js` T3 already forbids them from touching anything but the Book Model. After extraction they consume `@animastor/vbook-runtime`'s model facade with zero semantic change; their own extraction (a later phase) becomes possible the moment this package exists — this is the strategic payoff of the whole plan.

---

## 7. Cycles and post-extraction boundary check

Measured edges of the extracted package after Phase C:

```
@animastor/vbook-runtime → { node builtins (fs/path/crypto), adm-zip, tinyld }
```

- **VBook → backend / agent pipeline / runtime config / Redis / generation:** **none possible** — every forbidden edge would have to be a *new* require; the BOOK_ALLOWLIST guard converts into a package-isolation guard (no requires outside the package), making each forbidden edge a failing test by construction.
- **Cycles:** the book domain is a member of **no SCC** today (Phase 5/7 measurements; the 14-module cycle is orchestration↔runtime↔services↔image, the 2-module cycle is workspace-ai-provider⇄system-ai — book is in neither). After extraction the dependency direction is one-way downward: host → package. The only inbound package edge would be host consumers — a DAG, not a cycle.
- **Hidden/dynamic dependencies found (the audit's negative findings):**
  1. `book-deletion.cjs:184,186` reads `process.env.HUB_URL`/`GPU_HUB_API_KEY` — inside the book *directory* but host code; resolved by leaving the file in the host (§1.1) and by a future guard "no `process.env` in package files".
  2. `runtime-config.js:61` reads `BOOKS_DIR` at **require time** — the reason 6 test files must set the env before requiring the module; resolved by the `booksRoot` port (§3.3).
  3. `{booksRoot}/{bookId}.snapshot.json` path knowledge is duplicated host-side (`task-handler.cjs:242,254`) — not format state; documented as a host-owned convention so the package never needs it.
- **Circular-import probe inside the package:** `lazy-book/index.js → parser.js → services/structure-detector` and `agent-prompts.js → book/lazy-book/parser.js` — acyclic today; after extraction, `agent-prompts → package/parser` stays acyclic (the package does not import agent-prompts).

---

## 8. Extraction plan (phased, each step behavior-neutral unless stated)

### Phase A — Preparation (pre-move; doc/test/code-seam only)

| Step | What | Risk | Complexity | Depends on | Parallel-safe |
|---|---|---|---|---|---|
| A1 | Author `vbook-bundle-3.1.schema.json` (manifest/8 file kinds/id grammar) + validator↔schema sync test | LOW | M (content work, rules fully enumerable from bundle-validator) | — | yes (fully parallel) |
| A2 | `booksRoot` port: `configureBooksRoot()` in `paths.js`/`index.js`; bind from `backend.cjs`; migrate the 6 env-pre-require tests to the port | LOW-MED (startup-order sensitive; guarded by existing suite) | S | — | yes (after A1 review, independent) |
| A3 | structure-detector port: injectable binding in `lazy-book/parser.js` (fail-closed getter; host binds at startup); document ChapterMap shape as the C13 seed | LOW | S | — | yes (independent of A1/A2) |
| A4 | Placement decision doc: `book-deletion.cjs` stays host; snapshot-path + env reads recorded as host conventions | LOW | S (doc) | — | yes |
| A5 | Test inventory/split plan (§5) committed as the package-test scaffold map | LOW | S (doc) | A1 (for schema test placement) | yes |

### Phase B — Boundary (contracts formalized; still no physical move)

| Step | What | Risk | Complexity | Depends on | Parallel-safe |
|---|---|---|---|---|---|
| B1 | Public API freeze list (§4.1 table) written into the future package README; C2 marked internal-v1, additive-only from here | LOW | S | A4/A5 | yes |
| B2 | Port contracts: `booksRoot` (§3.3) + `structureDetector.buildDeterministicMap → ChapterMap` (§2.6) as versioned doc + host-side contract test (real detector through the port vs golden maps) | LOW | S | A3 | yes |

### Phase C — Physical extraction (first real move; package appears, host untouched via shims)

| Step | What | Risk | Complexity | Depends on | Parallel-safe |
|---|---|---|---|---|---|
| C1 | Create package dir; move `book/` (minus `book-deletion.cjs`) + `language-detector` + `character-identity` + `scene-title-utils` + `snake-guard`; `package.json` (`@animastor/vbook-runtime@0.1.0`, deps: adm-zip, tinyld; engines ≥18; files allowlist excl. deletion; MIT; README/CHANGELOG). Host keeps one-line re-export shims at old paths (`backend/src/book/index.js` → package) — **zero consumer code changes** | MEDIUM (mechanical but broad: ~15 files, require-path rewrites inside the package) | M | A1–A3, B1–B2 | no (single-owner step) |
| C2 | Guard migration: BOOK_ALLOWLIST → package-isolation guard (P7-T1 analog: package requires only builtins+adm-zip+tinyld; no `process.env`; nothing outside requires into package internals); update path pins in phase2/4/6/7 tests; ADR for the workflows→book baseline re-point | LOW-MED | S-M | C1 | follows C1 immediately, same PR |

### Phase D — Consumers migration (shim → direct package imports, wave by wave)

| Step | Wave | Risk | Complexity | Depends on | Parallel-safe |
|---|---|---|---|---|---|
| D1 | Composition root: bind ports, swap DI wiring to package entry | LOW | S | C1 | first |
| D2 | Services wave: txt-importer, book-source, agent/*, placeholder-audio, source-coverage-audit, agent-prompts | LOW | S | C1 | yes, per-file |
| D3 | Routes/validator wave: entity-crud (id generators), ai-routes + chat-engine (bundle-validator) | LOW | S | C1 | yes, per-file |
| D4 | Runtime readers wave: scene-window, runtime-scheduler, reconciliation-engine, scene-callbacks, scene-orchestrator, redis-helpers | MEDIUM (files sit in the frozen R5/SCC baselines — path-only edits, but every touch needs baseline review) | S-M | C1 | after D2 |
| D5 | Workflows violation re-point (`video-workflows.js` → package entry) + baseline shrink | LOW | S | C2 ADR | with D3 |

### Phase E — Graduation (§26 checklist)

| Step | What | Risk | Complexity | Depends on |
|---|---|---|---|---|
| E1 | Package-owned standalone suite (`npm test` inside the package; no host, no PG/Redis): the §5 minimal set + schema conformance + port fail-closed tests | LOW | M | C1, A1 |
| E2 | Standalone boot smoke: clean env + temp booksRoot → createDraftBook → saveBookBundle → loadBook round-trip → lazyParseNextWindow (Phase 8B/9D precedent) | LOW | S | E1 |
| E3 | Dependency guard green: package require-graph = builtins + 2 npm libs; no env reads; host-side sync tests non-vacuous | LOW | S | C2 |
| E4 | Package metadata complete (§26.7-8): description/keywords/repository/bugs/engines/license/files; `npm pack --dry-run` allowlist review (no book-deletion, no host paths) | LOW | S | E1 |
| E5 | npm publish readiness — **blocked on npm auth** (same gate as `animastor-ai-connector@0.1.0` / `animastor-worker@2.1.0`) | — | — | E4 |

Recommended sequencing: **A1 ∥ A2 ∥ A3 ∥ A4 ∥ A5 → B1 → B2 → C1 → C2 → D1 → D2 ∥ D3 → D4 → D5 → E1–E5.** Phases A and B are fully parallelizable with the ongoing GPU Hub audit and any npm-auth work; C onward should be single-owner (one package, one PR-stream, per §28.2).

---

## 9. Final verdict

## VBook extraction readiness: **READY AFTER PREPARATION**

The package boundary is real in the code today (one directory, 7 enumerated outward edges, no cycles, no Redis/PG/runtime edges, two frozen contracts with guards, consumers 70% behind facades/DI already). What separates it from a physical extraction is a small, fully-enumerable preparation set — none of it a rewrite, all of it behavior-neutral.

### Top 3 blockers

1. **`BOOKS_DIR` require-time env coupling** (`runtime-config.js:61` → `book/index.js:92`, `lazy-book/paths.js:5`; 6 test files depend on the env-pre-require hack) — the package must not read host env/paths (§26 anti-pattern). → `booksRoot` injection port (A2).
2. **`structure-detector` top-level require** (`lazy-book/parser.js:80`) + its placement decision (agent pipeline is the primary consumer; Parser ≠ VBook) — needs the port (A3) and the recorded decision C (§2.6), including the ChapterMap shape as the C13 seed.
3. **C1 JSON Schema does not exist** + the test suite is host-owned (28 files; zero package-owned) — a published format package needs the schema and a standalone suite (A1, E1) before graduation.

### Top 3 preparation steps

1. **A1 — author `vbook-bundle-3.1.schema.json`** + validator↔schema sync test (closes the Phase 1 open item; freezes the format before it is published).
2. **A2 — implement the `booksRoot` port** with fail-closed semantics and bind it in `backend.cjs`; migrate the env-based tests.
3. **A3 — introduce the structure-detector port** (injectable binding in `parser.js`, host binds the real detector, golden-map contract test).

### Risk assessment

**2 / 5** (LOW-MEDIUM). Lower than Worker (Phase 9: live GPU deployment channels, tri-party wire protocol) and far lower than GPU Hub (shared Redis ownership). No wire protocol, no cross-service state, no SCC membership; the canonical layer is pure FS logic guarded by two contract suites. Residual risk concentrates in Phase C path mechanics (~23 pinned consumer sites, ~5 guard baselines) — mitigated by the re-export-shim strategy (consumers do not change until Phase D, wave by wave).

### Recommended next phase

**`PHASE_10B — VBook extraction preparation`** (naming note: the "Phase 10" slot in §30 was already partially consumed by Phase 9C's contracts package; a distinct explicit name avoids the numbering drift recorded in the Phase-Next recon §8): execute A1–A5 + B1–B2 — schema, ports, placement docs, test-split map. Zero production behavior change, fully parallel-safe with the GPU Hub audit. Physical extraction (C1) is green-lit only after all six preparation steps are green and the guard plan (C2) is written down.
