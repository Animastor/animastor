# TXT Import: Structure Detection v2 (Candidates → LLM → Chapter Map)

> Status: approved for implementation. Replaces v1 "window → chapter" approach.

## 1. v1 Problem (Audit `ba_1785985491053` Findings)

Current import is built inverted: windows are sliced by character count,
and chapters are "grown" from windows. Real book boundaries (`splitIntoChapters`,
regex) are computed but don't control structure. Consequences (confirmed by
code tracing and actual JSON):

| Problem | Cause |
|---|---|
| Title not detected | First line doesn't enter any chapter; window 0 starts inside chapter 1 — title doesn't reach either structure analysis or scenes |
| Prologue ignored | `prologueRe` requires exact string "Prologue"; string "Prologue. World at the Epoch Turning Point" doesn't match, prologue text lost |
| Chapter 1 detected incorrectly | "Chapter 1" heading sliced from window — LLM "doesn't see" chapter 1 |
| Other chapters merge | Book fits in one window → all scenes in single chapter file; `structure.chapters` LLM saves as metadata but doesn't affect structure |
| Cover uses filename as title | `createCoverChapter` falls back to `bookMeta.title` (= filename) |

## 2. v2 Architecture: Separation of Responsibilities

```
┌─────────────────────────┐   ┌──────────────────────────┐
│ Program (deterministic)  │   │ LLM (semantics)          │
│ structure-detector.js   │   │ structure.md v2          │
│                         │   │                          │
│ finds CANDIDATES:       │   │ classifies:              │
│  - short line before    │   │  "Is this book title?"   │
│    long paragraph       │   │  "Is this prologue?"     │
│  - line between empty   │   │  "Is this chapter?"      │
│    lines                │   │  "Is this regular header │
│  - first line           │   │   inside text?"          │
│  - ALL-CAPS / numbered /│   │  + confidence 0..1       │
│    roman numeral        │   │                          │
│  - regex words          │   │ "find what exists",      │
│    (Chapter/...)        │   │ NOT "build a novel"      │
│    as hint only         │   │                          │
└───────────┬─────────────┘   └────────────┬─────────────┘
            │  candidates (id + text +     │ decisions by id
            │  context, offsets)            │ (no invented offsets)
            ▼                              ▼
      ┌─────────────────────────────────────────┐
      │ CHAPTER MAP (canonical): title, author,  │
      │ segments[{type,label,title,number,       │
      │ startOffset,endOffset}]                  │
      │ + has_prologue, parts                    │
      └─────────────────┬───────────────────────┘
                        ▼
      ┌─────────────────────────────────────────┐
      │ Pipeline: windows don't cross chapter    │
      │ boundaries; each chapter → separate JSON;│
      │ typographic scene at chapter start;      │
      │ cover only if title exists              │
      └─────────────────────────────────────────┘
```

Rules:
- **Program makes no decisions.** Regex and keyword dictionaries are only
  hypothesis sources and confidence boosts (multilingualism achieved by
  LLM making the decision).
- **LLM invents no offsets.** All text bindings go through
  `candidate_id` (or exact line match in source). Not found → decision
  discarded.
- **Universality.** Structure not imposed: novel, short story, poem,
  few sentences, excerpt — all valid inputs. Missing author, title,
  prologue, or chapters — normal, not error.

## 3. Candidate Format

```js
{
  id: 'c12',               // anchor for LLM
  lineIndex: 41,           // index in lines[]
  startOffset, endOffset,  // offsets in sourceText
  text: 'Chapter 2. First Flight',
  length, wordCount,
  firstNonEmpty: false,    // first non-empty line of document
  inHeadBlock: false,      // first ~8 non-empty lines (title/author zone)
  blankLinesBefore: 1, blankLinesAfter: 1,
  standalone: true,        // empty line above AND below (or document edge)
  allCaps: false,
  sentencePunctuation: false,  // ends with .!?… or contains ,;:
  followedByLongParagraph: true,
  nextParagraphPreview: 'While most people argued about the future…',
  separatorAbove: false, separatorBelow: false,
  keyword: 'chapter',      // from hypothesis dictionary | null
  numbered: true, romanNumeral: false,
  prefixDash: false,       // dialogue line "— …"
  headingLikelihood: 0.83  // program estimate (not decision!)
}
```

Candidate is a non-empty line ≤ 120 characters with "suspicion" indicators;
strong candidates (`headingLikelihood ≥ 0.55` or keyword) become
potential chapter boundaries.

## 4. Chapter Map Format

```js
{
  title:  { text: 'Beyond Algorithms', source: 'ai' | 'detect' } | null,
  author: { text: null, source } | null,
  hasPrologue: true, hasEpilogue: false,
  parts: [{ name: 'PART ONE', order: 1 }],
  segments: [
    { type: 'prologue', label: 'Prologue', title: 'World at the Epoch Turning Point',
      number: null, headerLine: 'Prologue. World at the Epoch Turning Point',
      startOffset: 26, endOffset: 772, source: 'ai' },
    { type: 'chapter', label: 'Chapter', title: 'Earth',
      number: 1, headerLine: 'Chapter 1. Earth',
      startOffset: 773, endOffset: 1313, source: 'detect' },
    // …
  ],
}
```

- `type`: `prologue | chapter | epilogue | introduction | preface | afterword |
  appendix | part | poem | body`. `body`/`poem` — unstructured text
  (typographic scene NOT created).
- `label` — word from source ("Chapter", "Prologue"…), so scene header
  is in book's language.
- `startOffset` — start of header line (header stays inside segment
  text, as in v1; `findNarrativeStartOffset` strips it for window).
- Prologue = index 0, chapters = 1..N (frontend already reads this way). Cover is utility
  chapter without `chapter_index`.

## 5. Deterministic Map (Fallback Without LLM)

`buildDeterministicMap(sourceText)`:
1. Collect candidates.
2. Title/author (title zone, see below).
3. Boundaries: strong candidates outside title zone, not dialogue ("— …").
4. Multi-line header merging: "Chapter 1" + (up to 2 empty lines) + "HEADING" —
   single boundary; ALL-CAPS line is heading even with punctuation inside
   ("SCHIZOPHRENIA, AS WAS SAID", "TIME! TIME!").
5. Chapter number: `Chapter 1.`, `Chapter 12:`, roman numerals (`extractNumber`).
6. If no boundaries → single `body` segment with all text (minus title/author).

### Title Zone: Three Layouts

| Layout | Example | Indicators |
|---|---|---|
| `Title. Author.` on one line | "Beyond Algorithms. S.A. Khabarov." | `splitTitleAuthor` by last separator `. ` / `—` before name-pattern |
| `Title FullName` without separator | "Beyond Algorithms S. A. Khabarov" | `trailingFullNameIndex`: full name at END of line, has initials, heading part ≥ 3 words (otherwise "His name was D. I. Ivanov" won't split); name inside title text ("Khabarov's Life") — part of title |
| Inverted title | "Mikhail Afanasyevich Bulgakov" / "Master and Margarita"; "S.A. Khabarov" / "Beyond Algorithms." | author first line: full name (≥ 3 words OR with initial — "S.A. Khabarov"), below short non-name line = title (decorative period stripped, `?`/`!`/`…` preserved). Trade-off: epigraph "K. Simonov" + title structurally indistinguishable — treated as author+title, LLM may override |

### Surname-Frequency Check (Author vs Character)

After any of three parsing approaches, author candidate's surname is run through
narrative: `extractSurname` (last word-not-initial) + `countSurnameInText`
(accounting for Russian declensions: Khabarov/Khabarova/Khabarovym; case-sensitive —
in prose names start with capital). Surname appears in text AFTER title
line ≥ 2 times → it's a CHARACTER, not author ("Khabarov's Life", where Khabarov is hero):
author discarded, clean title preserved. 0 occurrences → author
confirmed. Works in both deterministic path and LLM merge
(`sanitizeStructure`), where it's part of anti-hallucination layer: agent said
"there's a name" — program verified text.

## 5a. Chapter Template Learning + Poster Filter

If first 2+ strong boundaries are chapters of form "Chapter N" (`learnKeywordTemplate`,
reuses `extractNumber`, so understands roman numerals too), remaining
chapters of the book must follow THE SAME template — this is "style learning": style
of first recognized chapters (whether word "Chapter" present, how heading separated,
ALL-CAPS or not) applied to others.

`applyKeywordTemplate(merged, sourceText)` discards strong lines WITHOUT
structural keyword — these are decorative posters inside chapters (poster
"PROFESSOR VOLAND" in "Master and Margarita"), not boundaries. Discarding is TARGETED:

- **(a) attached** within ≤ 4 lines to previous keyword heading;
- **(b) multi-line poster block:** next line is one short (≤ 60 chars)
  without period (continuation of poster "Black Magic Seances with Full Exposure",
  often in regular case), followed by long prose (≥ 120 chars). Indicator needed because
  in real book poster stands 28 lines below "Chapter 10" — proximity alone insufficient.

Distant unnumbered section ("INSTEAD OF EPILOGUE", interlude, section in mixed
book) NOT discarded — distance from keyword heading is large, structure not
lost. Books without word "Chapter" (only ALL-CAPS headings) don't activate
template — behavior unchanged.

### Other Deterministic Rules

- **"PART ONE/TWO" — decorative division:** remains text split point
  and mentioned in `parts`, but does NOT create chapter segment (heading
  drops from content).
- **Year range** ("1929 — 1940") at book end — colophon data, never
  chapter (`DATE_RANGE_RE`).
- **Punctuation penalty softened for ALL-CAPS lines** (−0.15 instead of −0.4): ALL-CAPS —
  classic "shouting" chapter heading in Russian editions; otherwise headings with `!`/`,`
  near "Chapter N" didn't reach strong threshold (0.55).

## 6. LLM Step (structure.md v2)

Single call. Input: document top (~15 lines with context) + candidate list
(`id`, text, `nextParagraphPreview`). Output JSON:

```json
{
  "title":       { "text": "…", "candidate_id": "c1", "confidence": 0.92 },
  "author":      { "text": "…", "candidate_id": "c2", "confidence": 0.7 },
  "has_prologue": true, "has_epilogue": false,
  "parts":       [{ "name": "PART ONE", "order": 1 }],
  "elements": [
    { "candidate_id": "c5", "kind": "prologue", "title": "World at the Epoch Turning Point",
      "number": null, "confidence": 0.95 },
    { "candidate_id": "c8", "kind": "chapter", "title": "Earth",
      "number": 1, "confidence": 0.98 },
    { "candidate_id": "c9", "kind": "reject", "confidence": 0.9 }
  ],
  "country": null, "epoch": null
}
```

- `kind`: `prologue | chapter | part | epilogue | introduction | preface |
  afterword | appendix | poem | heading | reject`.
- Element references ONLY `candidate_id` (or exact `line_text` from
  source). No anchor → element ignored (LLM invents no offsets).
- `confidence < 0.5` → treated as `reject`.
- Model instruction: "Element not present — calmly return empty/null, don't invent."
  This is the "find what actually exists" principle.

`mergeAiDecisions`: v2 map = deterministic map + LLM decisions
(add/remove boundaries by lineIndex, refine titles/numbers/types,
title/author). Validation: each boundary is real source line.

### Anti-Hallucination Layer (`sanitizeStructure`)

Before applying, LLM response runs through deterministic validator.
Regex here does NOT decide what a line is — it only **forbids impossible**:

- **Anchor**: element must reference existing `candidate_id` (or
  `line_text` found verbatim in source). No anchor → fabrication, element
  discarded. LLM physically cannot input non-existent offset.
- **Author**: 2–4 tokens, each a capitalized word or initial ("S.A."),
  no digits/URL; length ≤ 60; at least one full word (surname).
  "999 doesn't exist" or full sentence → not author.
- **Title/chapter heading**: length 1–120, ≤ 14 words; if longer 60 —
  no `,;:` (otherwise it's a sentence, not title).
- **Chapter number**: integer 1–999.
- **Consistency**: author ≠ title; two elements on one candidate —
  last wins; `confidence < 0.5` = `reject`.
- **Rejected element** (reject/failed check) removes boundary —
  text remains narrative of previous segment.

Title and author on ONE line ("Beyond Algorithms. S.A. Khabarov.")
parsed deterministically via `splitTitleAuthor` (last separator
". "/"— " before name-pattern) — both in LLM step and fallback.

## 7. Pipeline Integration

| File | Change |
|---|---|
| `services/structure-detector.js` (new) | candidates + deterministic map + LLM decision merge |
| `book/lazy-book/parser.js` | `splitIntoChapters` → deterministic map (prologue = index 0, correct boundaries); array contract preserved |
| `book/lazy-book/create.js` | cover only with real title; "Prologue/…" scene; scene from map; `body` without scene |
| `book/lazy-book/chapter-utils.js` | `buildSegmentIntro()` — typographic scene from segment |
| `services/agent/pipeline-steps.js` | `stepAnalyzeStructure` → candidate classification (old call remains compatible) |
| `services/agent/pipeline-runner.js` | `getWindowText` — window doesn't cross chapter boundary; optional `chapterMap` |
| `services/agent/bootstrap.js` | structure computed BEFORE window slicing; AI-refined map persisted in `window_data.structure.segments` |
| `ai/rules/structure.md` | v2: classification without imposition |

v2 import flow:
1. `createDraftBook` (as now).
2. `extractCandidates(sourceText)` + `stepAnalyzeStructure` → `structure`
   (title/author/parts/segments). On LLM error → deterministic map.
3. `getWindowText(..., { chapterMap })` — window 0 = first segment (usually prologue),
   window doesn't exceed segment end.
4. `runPipeline` creates window scenes; `createFromAnalysis`/`appendToBook`
   materialize chapter by `chapterIndex` (= segment index): heading, type
   (`prologue`/`chapter`/…), typographic scene, cover from `structure.title`.
5. `bootstrapNextWindow` takes offset from saved scenes, continues in next
   map segment (map from `window_data.structure.segments`).

## 8. Universality (Acceptance Table)

| Input | Expectation |
|---|---|
| Title + prologue + chapters (test) | cover(title) + prologue(0) + chapters 1..3, each with typographic scene |
| Title then text immediately | cover(title) + one `chapter` segment without number… no — `body` with text, no "Chapter 1" |
| Only text, no title | no cover; one `body` segment; scenes from first sentences |
| Title and author | cover(author + title) |
| Author without title | author in metadata, no cover |
| Poem without headings | one `body`/`poem` segment, no "Chapter 1" scene |
| Few sentences | one `body` segment |
| Large novel | chapters by map; large chapters sliced with windows appending to same file |
| Novel with "Chapter N" + ALL-CAPS headings, parts and posters (verified: "Master and Margarita", 8093 lines) | inverted title (author+title), 32 chapters + epilogue, parts decorative, poster "PROFESSOR VOLAND" and year range "1929 — 1940" discarded, headings with `,`/`!` merged |

## 9. Scaling

Same mechanism (candidate → classification) later covers without changing
program part: epilogues, prefaces, afterwords, appendices, poetic
inserts (`poem`), footnotes, parts (`part`). Sufficient to extend `kind` in
`structure.md` and add scene type — candidate detector unchanged.
