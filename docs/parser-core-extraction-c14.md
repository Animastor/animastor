# Parser Core Extraction — C14

## Boundary Definition

Parser Core is the deterministic text-parsing subsystem responsible for:
- Chapter/segment detection from raw source text
- Offset calculation (char offsets into the exact source text instance)
- Language detection (pure, tinyld-based)
- Canonical `ParserResult` / `ChapterMap` DTO production
- Legacy chapter DTO projection

Parser Core is **sync, pure, no IO** — no filesystem, no PostgreSQL, no Redis, no AI provider, no Book Writer.

## Parser Core Files

| File | Role | Dependencies |
|------|------|-------------|
| `src/parser-core.js` | Extraction barrel (public API surface) | parser.js, contracts, language-detector |
| `src/lazy-book/parser.js` | Parser facade (splitIntoChapters, etc.) | parser-contract, legacy-projection, language-detector |
| `src/contracts/parser-contract.js` | C13 contract (ParserResult DTO, validation) | **zero requires** |
| `src/contracts/legacy-projection.js` | ParserResult → legacy chapter DTO | **zero requires** |
| `src/language-detector.js` | Language detection (tinyld) | tinyld |

## Dependencies (stays with Parser Core)

| Dependency | Type | Why |
|-----------|------|-----|
| `tinyld` | npm package | Pure JS language detection, zero LLM |

## Dependencies (host-side, NOT in Parser Core)

| Dependency | Why excluded |
|-----------|-------------|
| `services/structure-detector.js` | Contains AI merge (mergeAiDecisions, analyzeStructure) alongside deterministic parser; injected via port |
| `services/txt-importer.js` | Importer — host-side orchestration |
| `services/agent/*` | AI pipeline — host-side |
| `lazy-book/parse.js` | Book Writer — uses fs, draft, paths |
| `lazy-book/draft.js` | Persistence — uses fs, book state |
| `lazy-book/paths.js` | Filesystem paths |
| `lazy-book/constants.js` | VBook state machine constants |
| PostgreSQL / Redis | Infrastructure — host-side |
| `config/runtime-config` | Host config — injected via ports |

## structureDetector Boundary

The `structure-detector.js` file contains both deterministic and AI functions:

| Function | Belongs to | Why |
|----------|-----------|-----|
| `buildDeterministicMap` | Parser Core (algorithm) | Pure, deterministic chapter map production |
| `extractCandidates` | Parser Core (algorithm) | Pure, deterministic candidate scanning |
| `mergeAiDecisions` | Host/AI | Applies LLM classification decisions |
| `analyzeStructure` | Host/AI | Convenience: candidates → optional AI → final map |
| `sanitizeStructure` | Host/AI | Post-processing of AI decisions |
| `mapToStructureChapters` | Host/AI | Legacy AI structure shape conversion |

**Key insight:** `buildDeterministicMap` and `extractCandidates` are conceptually Parser Core, but they're hosted in `structure-detector.js` alongside AI functions. The port abstraction (`setStructureDetector`) means Parser Core doesn't need to own the implementation — it just calls `detector.buildDeterministicMap(sourceText)` through the injected port.

**For physical extraction:** `buildDeterministicMap` + `extractCandidates` + supporting helpers will be extracted from `structure-detector.js` into `@animastor/parser`. The AI functions stay host-side.

## Host Adapters (needed for physical extraction)

When `@animastor/parser` is physically extracted, the host will need:

1. **StructureDetectorPort adapter** — binds `structure-detector.js` implementation into the parser port (already exists: `backend.cjs:40-41`)
2. **booksRoot adapter** — not needed by Parser Core (only needed by Book Writer)

## Planned Public API (`@animastor/parser`)

```js
// Parser facade
splitIntoChapters(text) → ParserChapter[]
splitIntoScenes(chapterText) → ParserScene[]
splitIntoUnits(sceneText) → ParserUnit[]
firstMeaningfulChapter(chapters, sourceText) → ParserChapter|null
detectLanguage(text) → string
injectChapterMarkers(text) → string

// Port binding
setStructureDetector(detector) → void
getStructureDetector() → StructureDetectorPort

// C13 Contract
PARSER_CONTRACT_VERSION: 1
PARSER_SEGMENT_TYPES: string[]
PARSER_SEGMENT_SOURCES: string[]
PARSER_MAP_SOURCES: string[]
validateParserResult(map, opts?) → { ok, errors, contractVersion }
validateParserSegment(seg) → { ok, errors }
assertValidParserResult(map, opts?) → ParserResult (throws on violation)
validateLanguageResult(result) → { ok, errors }
isValidStructureDetectorPort(detector) → boolean
assertStructureDetectorPort(detector) → void (throws on violation)

// Legacy projection
offsetToLine(lines, offset) → number
segmentToLegacyChapter(seg, sourceText) → ParserChapter
mapToLegacyChapters(map, sourceText) → ParserChapter[]

// Language detection
detectLanguageWithConfidence(text) → { code, confidence }|null
```

## What Still Blocks Physical Extraction

1. **`buildDeterministicMap` + `extractCandidates` live in `structure-detector.js`** — need to be extracted into `@animastor/parser` (the algorithm, not the AI functions)
2. **`tinyld` dependency** — already isolated in `language-detector.js`, no issue
3. **Host composition root** — `backend.cjs:40-41` binding stays host-side

## Tests

Architecture guards in `tests/architecture/parser-core-isolation.test.js` verify:
1. Parser Core has no forbidden imports (PostgreSQL, Redis, AI, Book Writer, Importer)
2. Parser Core require graph stays within package boundary
3. `parser-contract.js` is pure (zero requires)
4. `legacy-projection.js` is pure (zero requires)
5. `language-detector.js` depends only on tinyld
6. `parser.js` has no persistence/state imports
7. `parse.js` (Book Writer) is excluded from Parser Core
8. `parser-core.js` barrel re-exports correctly
9. Parser Core works without PostgreSQL/Redis
10. Parser Core works without AI pipeline
11. Parser Core works without Importer
12. Parser Core works without Book Writer
