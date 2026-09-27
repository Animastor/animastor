# Changelog

## 0.1.1 (2026-09-26)

Text-ingest analysis tier adopted from the Animastor host
(`refactor(backend): adopt pure analysis into packages`, 1900d931).
Additive release — no existing export, signature, or behavior changed.

### Features

- New module `src/source-coverage.js` — verbatim text-coverage analysis
  (`normalizeTextForCoverage`, `buildCoverageIndex`, `skipWhitespaceForward`,
  `rawOffsetToNormalizedIndex`, `looksLikeChapterTitle`, `isAllCapsHeading`,
  `findNarrativeStartOffset`, `getLastSentenceFragment`, `buildSceneEndNeedles`,
  `findLastSceneEndOffset`, `splitTextIntoNormalizedSentences`,
  `trySentenceLevelMatch`, `computeSceneCoverage`); 13 new exports on the
  root entrypoint.
- New module `src/encoding-detect.js` — ingest decode / encoding detection
  (`decodeBuffer`, `detectBom`, `scoreText`, `ENCODING_LABELS`); 4 new exports
  on the root entrypoint (root total now 39).
- New subpath exports: `@animastor/parser/source-coverage`,
  `@animastor/parser/encoding-detect`.

### Dependencies

- Added `iconv-lite ^0.6.3` (buffer decode behind `decodeBuffer`).

## 0.1.0 (2026-09-08)

First release — Parser Core extracted from `@animastor/vbook-runtime`.

### Features

- `splitIntoChapters(text)` — chapter/segment detection via injectable structure-detector port
- `splitIntoScenes(chapterText)` — scene splitting (paragraph/break-based)
- `splitIntoUnits(sceneText)` — unit segmentation
- `firstMeaningfulChapter(chapters, sourceText)` — skip short/preface chapters
- `detectLanguage(text)` — ISO 639-1 language detection (tinyld)
- `detectLanguageWithConfidence(text)` — language detection with confidence score
- `injectChapterMarkers(text)` — inject `[ГЛАВА: ...]` markers for ALL-CAPS headings
- `setStructureDetector(detector)` / `getStructureDetector()` — composition root seam
- C13 Parser contract: `validateParserResult`, `validateParserSegment`, `assertValidParserResult`, `validateLanguageResult`, `isValidStructureDetectorPort`, `assertStructureDetectorPort`
- `ParserResult` / `ChapterMap` canonical DTOs
- Legacy chapter projection: `mapToLegacyChapters`, `segmentToLegacyChapter`, `offsetToLine`
- Subpath exports: `@animastor/parser/contracts/parser-contract`, `@animastor/parser/contracts/legacy-projection`, `@animastor/parser/language-detector`
