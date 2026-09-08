# C13 — Parser Contract (typed, frozen)

**Status:** implemented (contract + validation + tests + golden fixtures). Production behavior unchanged.
**Date:** 2026-09-08
**Baseline:** HEAD `a0f3b3bb`
**Source audit:** `docs/parser-ai-importer-boundary-audit.md` (§11.1 proposed the contract; this document freezes the real one, confirmed against code).
**Contract code:** `packages/animastor-vbook-runtime/src/contracts/parser-contract.js`, `packages/animastor-vbook-runtime/src/contracts/legacy-projection.js`
**Contract tests:** `backend/tests/parser-contract.test.js`, `packages/animastor-vbook-runtime/test/parser-contract.test.js`, golden fixtures `backend/tests/fixtures/parser-contract/golden/parser-golden-fixtures.json` (regenerator: `scripts/generate-parser-golden-fixtures.js`).

---

## 1. Purpose

Turn the implicit, duck-typed Parser contract into an explicit, validated, versioned contract **without changing behavior**, and prepare (not perform) the physical extraction of `@animastor/parser`. After the future extraction, the package must produce byte-stable results for the same input — the golden fixtures are the baseline.

## 2. Parser responsibility

```
Text (exact string instance)
  ↓  Parser — deterministic, synchronous, pure
ParserResult  (≈ ChapterMap)
```

The Parser (facade: `packages/animastor-vbook-runtime/src/lazy-book/parser.js`) **is**:

- deterministic (same input → same output, verified by contract tests);
- synchronous (all current entry points are sync; keep it that way);
- filesystem-free, PostgreSQL-free, Redis-free, AI-provider-free, Book-Writer-free.

The Parser **is not**: a window materializer (`lazy-book/parse.js` is Book Writer), an LLM caller, an orchestrator. `injectChapterMarkers` is an auxiliary deterministic helper whose only consumer today is the AI window prompt (`pipeline-runner.getWindowText`).

Language detection (`language-detector.js`, tinyld) is deterministic and part of the Parser surface: `detectLanguage(text) → ISO 639-1 string ('en' fallback)`, `detectLanguageWithConfidence(text) → LanguageResult`.

## 3. ParserResult (canonical ChapterMap)

Producer of record: `structure-detector.buildDeterministicMap(sourceText)` (host-side, bound via port); the AI merge `mergeAiDecisions` emits the same shape with `source: 'ai'`.

```ts
interface ParserResult {                 // v1
  contractVersion?: 1;                   // absence = 1; presence must be 1
  title:  TextMetaField | null;          // { text, source: 'detect'|'ai', candidateId? }
  author: TextMetaField | null;
  hasPrologue: boolean;
  hasEpilogue: boolean;
  parts: { name: string; order: number }[];
  segments: ParserSegment[];             // typically ≥1 (body fallback) — see §4
  source: 'detect' | 'ai';
}

interface ParserSegment {
  type: 'chapter'|'prologue'|'epilogue'|'part'|'introduction'|'afterword'|'appendix'|'body'|'poem';
  label: string | null;                  // verbatim keyword ("Глава", "Пролог", …)
  title: string | null;
  number: number | null;                 // chapter number, positive integer
  headerLine: string | null;             // verbatim header line
  startOffset: number;                   // char offset into the EXACT input Text
  endOffset: number;                     // exclusive; 0 ≤ start ≤ end ≤ text.length
  source: 'detect' | 'ai';
}
```

Auxiliary entities (typed, matching real outputs — nothing speculative):

- `ParserScene = string` — `splitIntoScenes(chapterText)` returns trimmed, non-empty scene texts;
- `ParserUnit = { type: 'narration', text: string, participants: string[] }` — `splitIntoUnits(sceneText)` returns exactly one narration unit today;
- `LanguageResult = { code: string, confidence: number } | null` — `detectLanguageWithConfidence` output; `detectLanguage` collapses it to a string;
- `Parser` facade typedef — `splitIntoChapters / splitIntoScenes / splitIntoUnits / firstMeaningfulChapter / detectLanguage / injectChapterMarkers / setStructureDetector / getStructureDetector`.

Validation: `validateParserResult(map, { sourceText? })` and `validateParserSegment(seg)` (pure, never mutate; `ok:false` + explicit `errors[{code,message,path}]`); `assertValidParserResult` throws. Checks: shape/types of every field, `contractVersion` correctness, `startOffset ≤ endOffset`, offsets within `[0, text.length]` (when `sourceText` is provided), segment order non-decreasing, no overlap (`next.startOffset ≥ prev.endOffset`; strict contiguity is NOT required — dropped `part` segments legitimately leave gaps), non-empty source ⇒ ≥1 segment (body fallback), `LanguageResult` shape. Consumers run it explicitly; it is not wired into the hot parse path (see §10).

## 4. Offset invariants and documented discrepancies

**Invariant (critical):** `startOffset`/`endOffset` anchor **the exact Text instance** passed to the Parser. Between the Parser and any consumer it is forbidden to trim, normalize line endings, re-decode, or change Unicode representation — anchors would silently corrupt. `pipeline-runner`, `txt-importer`, `status-routes` and the Book Writer all slice `sourceText` with these offsets and must keep receiving the untouched string.

Confirmed against code; discrepancies recorded, NOT fixed:

1. **Segments do not cover the head zone.** Title/author lines (detected by the head-zone heuristics) and their trailing newlines are excluded from segment coverage: the first segment starts at the first header line or at `headEndOffset` (body fallback). `text.slice(0, segments[0].startOffset)` is the head zone (pinned by test "documented discrepancies").
2. **Empty / all-head-zone sources yield `segments: []`.** `buildDeterministicMap('')` filters the zero-length body fallback away (`endOffset ≤ startOffset`), and a text fully consumed by title/author leaves no content segment. The canonical "≥1 body segment" guarantee therefore holds only for non-empty, not fully-head-zone sources. Downstream safety net: `splitIntoChapters` never returns an empty list — it emits one full-text plain chapter. `validateParserResult` encodes exactly this rule (`NO_BODY_FALLBACK` error only for non-empty sources; zero segments stay valid for `''`).
3. **`contractVersion` is not yet emitted.** v1 producers omit the field (absence = 1). Emitting it explicitly is allowed additively and is expected with the physical extraction / v2.
4. **`number` may be any integer ≥ 0 at the port boundary** (stub detectors); the real detector emits `1..N` for chapters and `null` otherwise. Validation requires a positive integer or null.

## 5. Legacy DTO compatibility

The legacy chapter DTO — `{ title, type, label, number, startLine, endLine, startOffset, endOffset, length }` — is now **defined as a projection** of the canonical map: `contracts/legacy-projection.js` (`segmentToLegacyChapter`, `mapToLegacyChapters`), and `splitIntoChapters()` delegates to it (was an inline loop; byte-identical semantics, now single-source). Projection rules: `body|poem → type 'chapter'` with `title/label` nulled; `startLine = offsetToLine(startOffset)`, `endLine = offsetToLine(endOffset − 1)`; `length = endOffset − startOffset`; empty projection → full-text fallback chapter.

Projection is 1:1 for every real map (contract tests pin `mapToLegacyChapters(map, text) ≡ splitIntoChapters(text)` for all fixtures and degenerate inputs). **No mismatch found.** Lossy (documented, acceptable): `headerLine` and the `body|poem` vs `chapter` distinction are not representable in the legacy DTO; reverse projection (`legacy → canonical`) is therefore not provided as a live contract — only the forward direction.

## 6. StructureDetectorPort

The `setStructureDetector()` binding is the formal port (composition root: `backend.cjs:40-41`; test mirror: `backend/tests/vbook-test-bindings.cjs`).

- **Required API (exactly one method):** `buildDeterministicMap(sourceText: string) → ParserResult`. Accepted alias: `buildChapterMap` (audit's port-level name) — `splitIntoChapters` resolves it when the primary name is absent. Fail-closed: before binding, `splitIntoChapters` throws `structureDetector is not bound…`; invalid implementations are rejected with the frozen message. Shape helpers: `isValidStructureDetectorPort` / `assertStructureDetectorPort`.
- **Not part of the port:** `extractCandidates` (deterministic candidate scan — Parser-side module, consumed by the AI stage), `analyzeStructure` / `mergeAiDecisions` / `sanitizeStructure` (AI merge seam). Host code (`pipeline-steps.js`, `bootstrap.js`) uses them directly; they do not go through the port. The port belongs to the Parser contract; the merge functions belong to the AI Analyzer boundary (below).

## 7. Parser vs AI boundary

```
Parser Core (deterministic):
  Text → buildDeterministicMap → ParserResult ('detect')
  Text → extractCandidates → Candidate[]        (input preparation for AI)

AI Analyzer (host-side today, same file — mergeAiDecisions/analyzeStructure):
  Text + Candidate[] (+ AI provider) → sanitized semantic result
  → ParserResult ('ai')                          (deterministic result stays the backbone)
```

The Parser contract contains no LLM, no AI provider, no prompts, no PG, no Redis, no SSE. `structure-detector.js` hosts BOTH halves (deterministic detection + AI merge with hallucination guard) — the boundary is documented here; the physical split is explicitly **deferred**. Until then: Parser-side = `extractCandidates`, `buildDeterministicMap`, keyword/number/surname heuristics; Analyzer-side = `sanitizeStructure`, `mergeAiDecisions`, `analyzeStructure`, `mapToStructureChapters`.

## 8. Error semantics

- Malformed **text is never an error** — it degrades deterministically (body fallback, empty-segment map, fallback chapter). Preserved as-is.
- **Contract misuse is an error:** unbound port (fail-closed), port without the required method, `assertValidParserResult`/`assertStructureDetectorPort` on violation (`Error` with `[CODE] path: message` summary).
- Validation is check-only: valid → `ok:true`, invalid → explicit error codes (`MAP_NOT_AN_OBJECT`, `INVALID_CONTRACT_VERSION`, `INVALID_META_FIELD`, `INVALID_FIELD_TYPE`, `INVALID_PART`, `INVALID_MAP_SOURCE`, `SEGMENTS_MISSING`, `NO_BODY_FALLBACK`, `INVALID_SEGMENT_TYPE/FIELD/NUMBER/SOURCE`, `INVALID_OFFSET`, `OFFSET_ORDER`, `OFFSET_OUT_OF_RANGE`, `SEGMENT_OVERLAP`, `INVALID_LANGUAGE_CODE/CONFIDENCE`). No normalization, no silent repair, no data mutation.

## 9. Examples

Input (`multiple-chapters-ru` fixture):

```
Глава 1. Земля

<prose>

Глава 2. Первый полёт

<prose>

Глава 3. Процветание

<prose>
```

Canonical result (excerpt, real golden value):

```json
{
  "title": null, "author": null,
  "hasPrologue": false, "hasEpilogue": false, "parts": [],
  "source": "detect",
  "segments": [
    { "type": "chapter", "label": "Глава", "title": "Земля", "number": 1,
      "headerLine": "Глава 1. Земля", "startOffset": 0, "endOffset": 510, "source": "detect" },
    { "type": "chapter", "label": "Глава", "title": "Первый полёт", "number": 2,
      "headerLine": "Глава 2. Первый полёт", "startOffset": 510, "endOffset": 1024, "source": "detect" },
    { "type": "chapter", "label": "Глава", "title": "Процветание", "number": 3,
      "headerLine": "Глава 3. Процветание", "startOffset": 1024, "endOffset": 1454, "source": "detect" }
  ]
}
```

Golden corpus (`backend/tests/fixtures/parser-contract/golden/`): `single-chapter-ru`, `multiple-chapters-ru`, `prologue-chapters-epilogue-ru`, `no-explicit-chapters-ru`, `russian-titled-body`, `english-chapters-en`. Each records the exact canonical map + legacy projection for its input; tests require `JSON.stringify(live) === JSON.stringify(golden)`.

## 10. Contract versioning

`PARSER_CONTRACT_VERSION = 1`. Rules: additive optional fields only; absent `contractVersion` = 1; a present field must equal 1 (else `INVALID_CONTRACT_VERSION`); v2 must bump the constant, emit the field from all producers, and regenerate golden fixtures (`scripts/generate-parser-golden-fixtures.js`). Breaking changes to existing fields (renames, offset semantics, type vocabulary) require v2 and a migration note here. Validation is opt-in for consumers — deliberately NOT wired into the parse hot path in this step, so no production behavior depends on it yet; wiring it (with the §4 empty-map allowance) is part of the extraction step.

## 11. Future extraction notes

- `@animastor/parser` (next stage, NOT done here): move `lazy-book/parser.js`, `language-detector.js`, `src/contracts/*` and (host-side) the deterministic half of `structure-detector.js`; port the golden fixture suite 1:1 — it must stay byte-stable.
- `lazy-book/parse.js`, `create.js`, `draft.js` stay in `@animastor/vbook-runtime` (Book Writer / Book Model).
- The `buildChapterMap` alias, the contract validators, and `offsetToLine` are the intended public surface of the new package; `splitIntoChapters`' legacy projection stays for host compatibility.
- All current legacy-DTO consumers verified in this step and unchanged: `pipeline-runner.js:114` (window slicing), `txt-importer.js:267`, `status-routes.cjs:63`, `import-routes.cjs:943` (trigger-next-window), `source-coverage-audit.js:53`, `lazy-book/parse.js`, `lazy-book/status.js`.
