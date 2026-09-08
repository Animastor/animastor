# @animastor/parser

Deterministic text parser for structured book content.

**Parser Core** — chapter/segment detection, byte-accurate offsets, language detection, canonical `ParserResult`/`ChapterMap` DTO, and legacy chapter projection. Pure sync, no IO, no AI, no database, no filesystem.

## What this is

This is the **Parser Core** extracted from the Animastor book pipeline. It provides:

- Chapter/segment detection with deterministic structure maps
- Byte-accurate offset calculations anchored to the source text
- Language detection (ISO 639-1) via `tinyld`
- Canonical `ParserResult` / `ChapterMap` contract with validation
- Legacy chapter DTO projection for backward compatibility
- Scene splitting and unit segmentation

This package does **not** include the AI-powered structure analyzer, the text importer, or the book writer. Those remain in the host application.

## Installation

```bash
npm install @animastor/parser
```

Requires Node.js >= 18.

## Usage

```js
const parser = require('@animastor/parser');

// Bind the structure detector at the composition root.
// The host provides the real detector (deterministic + AI merge).
parser.setStructureDetector(myDetector);

// Split source text into chapters.
const chapters = parser.splitIntoChapters(sourceText);
// → [{ title, type, label, number, startLine, endLine, startOffset, endOffset, length }]

// Detect language.
const lang = parser.detectLanguage(sourceText);
// → 'ru'
```

## Subpath exports

| Import path | Module |
|---|---|
| `@animastor/parser` | Main barrel (parser facade + contracts + projection + language) |
| `@animastor/parser/contracts/parser-contract` | C13 contract types, validation, constants |
| `@animastor/parser/contracts/legacy-projection` | `mapToLegacyChapters`, `segmentToLegacyChapter`, `offsetToLine` |
| `@animastor/parser/language-detector` | `detectLanguageWithConfidence` (tinyld-based) |

## Composition root seam

`setStructureDetector(detector)` binds the structure-detector implementation. The detector must expose `buildDeterministicMap(sourceText)` returning a canonical `ParserResult`.

Until a detector is bound, `splitIntoChapters()` throws — the package is **fail-closed**.

## License

MIT
