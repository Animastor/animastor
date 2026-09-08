# @animastor/parser npm publication — C16

**Date:** 2026-09-08
**Prerequisite:** C15 commit `c8de3b34` (Parser Core physically extracted)

## What was checked

### 1. Package metadata

- `name`: `@animastor/parser`
- `version`: `0.1.0`
- `main`: `src/index.js`
- `exports`: 4 subpath entries (`.`, `./contracts/parser-contract`, `./contracts/legacy-projection`, `./language-detector`)
- `files`: `src/`, `README.md`, `LICENSE`, `CHANGELOG.md`
- `engines`: `node >= 18`
- `license`: MIT
- `publishConfig.access`: public
- `repository.directory`: `packages/animastor-parser`
- `dependencies`: `tinyld ^1.3.4`
- `devDependencies`: `chai`, `mocha`

### 2. Publication files

| File | Status |
|------|--------|
| `README.md` | Created — describes Parser Core, public API, subpath exports, composition root seam, minimal usage example |
| `LICENSE` | Created — MIT (2026 Animastor) |
| `CHANGELOG.md` | Created — 0.1.0 entry listing all features |

### 3. npm tarball

```
npm pack --dry-run → 9 files, 13.7 kB packed / 44.8 kB unpacked

Contents:
  CHANGELOG.md
  LICENSE
  README.md
  package.json
  src/contracts/legacy-projection.js
  src/contracts/parser-contract.js
  src/index.js
  src/language-detector.js
  src/lazy-book/parser.js
```

No test files, no `node_modules`, no backend artifacts, no VBook runtime code.

### 4. Clean install

Installed `animastor-parser-0.1.0.tgz` in a fresh `/tmp/parser-pkg-test` directory:

| Check | Result |
|-------|--------|
| `require('@animastor/parser')` | ✓ exports all public functions |
| Subpath `contracts/parser-contract` | ✓ importable |
| Subpath `contracts/legacy-projection` | ✓ importable |
| Subpath `language-detector` | ✓ importable |
| `detectLanguage('Привет мир...')` | ✓ returns `'ru'` |
| `splitIntoChapters` without detector | ✓ throws (fail-closed) |
| `splitIntoChapters` with stub detector | ✓ returns chapter DTO |
| `@animastor/vbook-runtime` not installed | ✓ no reverse dependency |

### 5. Public API surface

Exported functions/constants (no host-side modules exposed):

- Parser facade: `splitIntoChapters`, `splitIntoScenes`, `splitIntoUnits`, `firstMeaningfulChapter`, `detectLanguage`, `injectChapterMarkers`
- Port binding: `setStructureDetector`, `getStructureDetector`
- C13 contract: `PARSER_CONTRACT_VERSION`, `PARSER_SEGMENT_TYPES`, `PARSER_SEGMENT_SOURCES`, `PARSER_MAP_SOURCES`, `isValidStructureDetectorPort`, `assertStructureDetectorPort`, `validateParserSegment`, `validateParserResult`, `assertValidParserResult`, `validateLanguageResult`
- Legacy projection: `offsetToLine`, `segmentToLegacyChapter`, `mapToLegacyChapters`
- Language detection: `detectLanguageWithConfidence`

Not exposed: `structure-detector`, AI Analyzer, Importer, Book Writer internals.

### 6. Test results

| Suite | Result |
|-------|--------|
| `@animastor/parser` (standalone) | 32/32 |
| `@animastor/vbook-runtime` | 24/24 |
| Backend parser + architecture | 144/144 |

### 7. Architecture not changed

No behavior changes, no new dependencies, no moved modules beyond what C15 established.

## Known blockers before `npm publish`

- None. Package is publication-ready.
