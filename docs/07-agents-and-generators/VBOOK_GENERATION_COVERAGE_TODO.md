# vBook Generation Coverage — TODO

## Context

Current TXT import uses an agent pipeline with a sliding text window:

- `MAX_WINDOW_CHARS = 4000` — reconnaissance context for characters and locations.
- `SCENE_CHUNK_SIZE = 1500` — text span passed to scene creation.
- `WINDOW_SIZE = 3` — target number of scenes per agent call.

The current architecture can skip source text because `currentOffset` is advanced by the planned chunk length, not by verified coverage of the source text by generated scenes. The concrete reproduced case is `book_1782899569732_1782899572803`, where text between the end of the fourth scene and the beginning of the fifth scene is missing.

## P0 — Stop Source Text Skips

- [x] Add a coverage validator immediately after `stepCreateScenes()`.
- [x] Verify that generated `scene.text` values cover the intended source span without non-whitespace gaps.
- [x] Normalize text before coverage comparison:
  - `\r\n` / `\r` -> `\n`
  - `NBSP` -> regular space
  - preserve meaningful punctuation and dialogue dashes
- [x] Advance `currentOffset` by verified `coveredEndOffset`, not by `sceneConsumedLength`.
- [x] If coverage fails, use deterministic fallback before saving the window.
- [x] Retry the scene-generation step with explicit feedback describing the missing source fragment.
- [x] After retry/fallback budget is exhausted, fail the import window loudly instead of silently skipping text.

## P1 — Store Source Spans

- [x] Add `source_start` and `source_end` to every generated narrative scene.
- [x] Add source span metadata to units where possible:
  - `unit.source_start`
  - `unit.source_end`
- [x] Persist coverage metadata in `agent_sessions.window_data`:
  - `windowStartOffset`
  - `plannedEndOffset`
  - `coveredStartOffset`
  - `coveredEndOffset`
  - `coverageStatus`
  - `coverageGapChars`
- [x] Store source spans in `chapters/*.json` so coverage can be audited after generation.
- [x] Keep raw source offsets as the canonical coordinate system; do not compute offsets from transformed prompt text.

## P2 — Fix Window Boundaries

- [x] Split agent context into two explicit concepts:
  - `analysis_window` — larger lookahead for entities and continuity.
  - `generation_span` — exact source span that must be fully covered by scenes.
- [x] Build `generation_span` deterministically from source text before calling the agent.
- [x] Choose span boundaries on sentence, paragraph, or dialogue-turn boundaries.
- [x] Avoid cutting inside dialogue question/answer pairs.
- [x] Fix first-window chapter header handling so `getWindowText()` starts at narrative text, not at a blank line before `Глава N`.
- [x] Ensure chapter boundary detection and offsets work correctly with CRLF source files.

## P3 — Relax Conflicting Prompt Requirements

- [x] Replace "EXACTLY 3 scenes" with "up to 3 scenes covering the provided span fully".
- [x] Treat `WINDOW_SIZE = 3` as a batching limit, not as a semantic requirement.
- [x] Keep the 65-word guideline as a soft duration target.
- [x] Prefer full source coverage over scene length when constraints conflict.
- [x] Move source coverage responsibility out of the prompt and into deterministic validation.

## P4 — Deterministic Fallback

- [x] If the agent cannot produce valid coverage, create fallback scenes programmatically.
- [x] Fallback should split by paragraph boundaries.
- [x] Run the agent only for enrichment after fallback:
  - title
  - participants
  - location
  - character anchors
  - visual metadata
- [x] Do not allow enrichment to change `scene.text`.
- [x] Validate unit coverage against each scene before saving.

## P5 — Tests

- [x] Add a regression test for `book_1782899569732_1782899572803`.
- [x] Assert that the dialogue block starting with `Дайте нарзану` is not dropped.
- [x] Add a unit test where the model returns scenes that start after the beginning of `generation_span`.
- [x] Add a unit test where the model omits text between two generated scenes.
- [x] Add a unit test for CRLF input and chapter header offsets.
- [x] Add a unit test for NBSP in dialogue text.
- [ ] Add a test that failed coverage prevents `currentOffset` advancement.

## P6 — Diagnostics

- [x] Add a debug report for source coverage:
  - total source chars
  - covered chars
  - gap count
  - overlap count
  - first gap preview
- [x] Add structured logs per generated window:
  - `plannedStart`
  - `plannedEnd`
  - `coveredStart`
  - `coveredEnd`
  - `gapChars`
  - `retryCount`
- [x] Add a CLI or debug route to audit existing books by matching scene text back to `source.txt`.
- [ ] Display coverage errors in import progress instead of generic agent failure messages.

## Recommended Implementation Order

1. [x] Implement normalized coverage validator.
2. [x] Use `coveredEndOffset` for `currentOffset`.
3. [x] Add regression test for the current skipped-dialogue case.
4. [x] Add `source_start` / `source_end` to scenes.
5. [x] Refactor window construction into `analysis_window` and `generation_span`.
6. [x] Add deterministic fallback scene splitting.
