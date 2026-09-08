# Changelog

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
