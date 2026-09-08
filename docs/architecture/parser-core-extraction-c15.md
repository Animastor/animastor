# Parser Core Physical Extraction — C15

**Date:** 2026-09-08
**Prerequisite:** C14 commit `f0b26560` (extraction seam prepared)
**Status:** COMPLETE

## What changed

Parser Core was physically extracted from `@animastor/vbook-runtime` into a standalone `@animastor/parser` package with **zero reverse dependency** on VBook runtime, AI, DB, or filesystem.

### New package: `packages/animastor-parser/`

| File | Origin |
|------|--------|
| `src/index.js` | New barrel (public API) |
| `src/lazy-book/parser.js` | Moved from `vbook-runtime/src/lazy-book/parser.js` |
| `src/contracts/parser-contract.js` | Moved from `vbook-runtime/src/contracts/parser-contract.js` |
| `src/contracts/legacy-projection.js` | Moved from `vbook-runtime/src/contracts/legacy-projection.js` |
| `src/language-detector.js` | Moved from `vbook-runtime/src/language-detector.js` |
| `test/parser.test.js` | New standalone smoke/functional tests |
| `test/package-boundary.test.js` | New architecture guards |

**Dependencies:** Only `tinyld` (pure JS language detection).

### Deleted from `@animastor/vbook-runtime`

- `src/parser-core.js` (C14 extraction barrel — was never shipped)
- `src/lazy-book/parser.js` → moved to `@animastor/parser`
- `src/contracts/parser-contract.js` → moved to `@animastor/parser`
- `src/contracts/legacy-projection.js` → moved to `@animastor/parser`
- `src/language-detector.js` → moved to `@animastor/parser`

### Updated in `@animastor/vbook-runtime`

- `src/lazy-book/parse.js` — imports `splitIntoChapters`, `splitIntoScenes` from `@animastor/parser`
- `src/lazy-book/create.js` — imports `firstMeaningfulChapter` from `@animastor/parser`
- `src/lazy-book/status.js` — imports `splitIntoChapters` from `@animastor/parser`
- `src/lazy-book/draft.js` — imports `detectLanguage` from `@animastor/parser/language-detector`
- `src/lazy-book/index.js` — re-exports parser facade from `@animastor/parser`
- `package.json` — depends on `@animastor/parser` (removed `tinyld`); removed parser subpath exports

### Host-side shims

- `backend/src/book/lazy-book/parser.js` — re-exports from `@animastor/parser`
- `backend/src/services/language-detector.js` — re-exports from `@animastor/parser/language-detector`
- `backend/src/backend.cjs:40` — `require('@animastor/parser')`

### Architecture guards updated

- `parser-core-isolation.test.js` — paths updated to `packages/animastor-parser/src/`
- `vbook-package-boundary.test.js` — VB-T1, VB-T3, VB-T4 updated for new dependency surface
- `parser-contract.test.js` — cache isolation fix: save/restore ALL `@animastor/parser` sub-module cache entries (not just `index.js`) when testing unbound state

## Test results

| Suite | Pass |
|-------|------|
| `@animastor/parser` package tests | 32/32 |
| `@animastor/vbook-runtime` package tests | 24/24 |
| Backend parser + structure-detector + architecture | 543/543 |

## Dependency graph (after)

```
backend → @animastor/parser  (composition root binding)
backend → @animastor/vbook-runtime  (book domain)

@animastor/vbook-runtime → @animastor/parser  (parser facade)
@animastor/parser → tinyld  (language detection only)
```

## Design decisions

1. **Structure-detector stays host-side** — `structure-detector.js` remains in the backend because it combines AI (LLM decisions) with deterministic parsing. It is injected into `@animastor/parser` via `setStructureDetector()` at the composition root.

2. **Structure-detector port preserved** — `setStructureDetector()` / `getStructureDetector()` are still the composition root seam. The host binds the real detector; the package is fail-closed until bound.

3. **Legacy projection stays in `@animastor/parser`** — `mapToLegacyChapters()` converts the canonical `ParserResult` map to the legacy chapter DTO format. This is a pure projection with zero dependencies.

4. **No behavior changes** — parsing algorithms, chapter detection, segment classification, offset calculations are identical. The only change is the physical location of the code.
