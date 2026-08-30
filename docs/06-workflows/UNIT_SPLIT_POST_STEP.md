# Unit Split Post-Step — splitLongUnits

## Task

After AI creates Imagination Units (step `stepCreateUnits`), **check the duration of each unit** and, if any unit exceeds ~20 seconds of audio, **split it into multiple logical units**.

## Motivation

- AI creates units semantically ("one act of imagination"), without thinking about seconds — this is correct.
- But a long unit (30-40 seconds of audio) ends up in a single video chunk, because `selectWorkflowGroups` cannot split a single unit.
- Solution: a post-step that measures `estimated_duration_sec` of each unit and, when exceeding the limit, reprompts AI to split it.

## Algorithm

```
Units from AI
  ↓
For each unit: estimateSpeechDurationSec(unit.text)
  ↓
If all ≤ 20s → OK, return units
  ↓
If any unit > 20s → AI reprompt:
  "This unit contains several acts of imagination.
   Split it into separate units, each — one visual frame."
  ↓
Check duration again
  ↓
If still > 20s → second reprompt
  ↓
If still > 20s → emergency fallback:
  1. Split by sentences (. ! ?)
  2. Split by commas (, ; —)
  3. Split by words (in half)
  ↓
Return final units array
```

## Responsibility Split

| Component | Task |
|---|---|
| AI (unit_splitter.md) | Semantic splitting: one imagination act → multiple |
| Code (unit-splitter.js) | Measurement, checking, retry, fallback |
| Pipeline (pipeline-runner.js) | Calling splitLongUnits between `stepCreateUnits` and `stepCreateVisuals` |

## Files

- `backend/ai/rules/unit_splitter.md` — AI prompt for splitting
- `backend/src/services/agent/unit-splitter.js` — implementation
- `backend/src/services/agent-prompts.js` — prompt registration (RULES)
- `backend/src/services/agent/pipeline-runner.js` — call site

## Constants

- `MAX_UNIT_DURATION_SEC = 20` — maximum duration of a single unit (in seconds)
- `MAX_UNIT_SPLIT_RETRIES = 2` — how many times to retry AI reprompt

## Emergency fallback (chain)

If AI couldn't split a unit (2 retries):

1. **Sentence-split**: split by `[.!?]+` with trailing space. Each sentence → separate unit. If sentence > 20s → don't split, leave as-is (extremely rare case).
2. **Comma-split**: split by `[,;—]+` (with optional trailing space). Em-dash often without space. Each segment → unit.
3. **Word-count split**: split by `\s+` into two equal halves by word count.

## Pipeline integration

`splitLongUnits` is called in `pipeline-runner.js` **after** `stepCreateUnits` and **before** `stepCreateVisuals`:

```javascript
const units = await pipelineSteps.stepCreateUnits(sessionId, scene, ...);
const splitUnits = await splitLongUnits(sessionId, scene, units, ...);
const visualUnits = await pipelineSteps.stepCreateVisuals(sessionId, scene, splitUnits, ...);
```

## Test results

- **19 tests**, all passing ✅
- `getUnitDurationSec` — 3 tests
- `findLongUnits` — 3 tests
- `splitBySentences` — 2 tests
- `splitByCommas` — 4 tests (commas, semicolons, em-dash, no delimiters)
- `splitByWordCount` — 2 tests
- `emergencySplit` — 2 tests (narration, dialogue audio preservation)
- `splitLongUnits` (no AI) — 3 tests (short units, empty, null)
