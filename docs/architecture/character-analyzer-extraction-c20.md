# C20 — Character Analyzer: Physical Extraction

**Status:** EXTRACTED. Physical file split + module boundary; behavior-preserving; no prompt, algorithm, provider, fallback, or merge change.
**Date:** 2026-09-08
**Baseline:** HEAD `dd85db71` (`arch(ai): C19.1 harden structure analyzer boundary`)
**Predecessors:** `docs/architecture/ai-functional-decomposition-c18.md` (C18 froze the F2/F7 contracts, H1 merge-ownership decision, extraction order §10 stage "Character Analyzer (F2/F7)"), `docs/architecture/structure-analyzer-extraction-c19.md` (the module+ports pattern C20 follows; C19.1 dependency-direction rules).
**Artifacts:** physical code move (`backend/src/services/character-analyzer/`) + port-based entry points + thin host adapters in `pipeline-steps.js` + one new guard suite (`backend/tests/architecture/character-analyzer-extraction-c20.test.js`, 29 assertions) + one behavior suite (`backend/tests/character-analyzer-extraction-c20.test.js`, 12 assertions) + updated C17/C18 guard file lists + `pipeline-step-types` scan extended to analyzer modules.

---

## 1. Old boundary (as found, C18)

The Character/Entity functional area (C18 F2 + F7) lived inline in the mega-file `pipeline-steps.js` mixed with ten sibling steps:

| Concern | Old location | Notes |
|---|---|---|
| Character extraction (AI) | `pipeline-steps.stepExtractCharacters` (239–263) | prompt assembly + `aiCaller.callAI` + PG step bookkeeping inline |
| Character attributes (voice authoring, F7) | `pipeline-steps.stepGenerateVoices` (422–515) | mutates `characters[i].voice` in place; audio-skill injection |
| Merge / dedup / placeholders / identity | `@animastor/vbook-runtime/character-identity` (pure) via host shim `utils/character-identity.js` | applied by `pipeline-runner` (367, 462–480) — **runner-owned**, not in the step |
| Mentions (alias → character_id) | produced by the AI step; merged **additively in the runner** (474–478, first alias wins); consumed by unit/visual steps as prompt context | registry persistence: host |
| Fallback / degradation | runner-owned: `charResult` empty → keep existing set (empty ≠ 'unknown', no placeholder synthesis) | the step itself throws after `failStep` |
| Persistence | host: `bootstrap.js` `window_data.all_characters/all_mentions` (PG) → Book Writer (`createFromAnalysis`/`appendToBook` → characters.json/mentions.json) | analyzers never persist |

Not part of Character flow (verified, not extracted): `entity-cleanup.cjs` (scene/unit deletion cleanup — editor domain), `entity-id.js` (editor id grammar), `normalizeCharacterRefs` (F14, generation merge util), passport reconciliation (F9, generation).

C18 §10 scheduled exactly this extraction: *"Character Analyzer (F2/F7) — same pattern: module + ports, merge contract made explicit (C18 H1 decision #3), prompt characters.md/voice_generation.md via prompt port."*

## 2. New boundary (as built)

```
HOST (composition)
  agent/pipeline-steps.stepExtractCharacters ── thin host adapter:
        injects ports { callAI, logConversation, updateSession, createStep,
                        completeStep, failStep, extractingCharactersMessage,
                        prompt, fillLang }
            → character-analyzer.extractCharacters(input, ports)
  agent/pipeline-steps.stepGenerateVoices ── thin host adapter:
        injects the same ports + { voiceGenerationMessage,
                        buildSkill: promptProfileLoader.buildSkillSection }
            → character-analyzer.generateVoices(input, ports)
  agent/pipeline-runner.runPipeline ── applies the shared PURE merge
        (mergeCharacterLists + isPlaceholderCharacter + mentions additive merge)
        to the module output — unchanged (C18 H1: merge stays host-side code,
        shared impl stays in vbook-runtime)
  agent/parallel-analysis-orchestrator ── unchanged; the analyzers map
        (pipelineSteps) is injected, the characters task routes through the
        same stepExtractCharacters adapter
  bootstrap.js ── persistence of { characters, mentions } (window_data +
        Book Writer) — unchanged

CHARACTER ANALYZER (backend/src/services/character-analyzer/)
  index.js    extractCharacters(input, ports)  ← the C20 contract entry point
              + re-export of the F7 voice seam
  voices.js   generateVoices(input, ports)     ← F7 voice authoring (in-place
              voice write-back contract unchanged); consumes the shared
              hasRealAppearance predicate from
              @animastor/vbook-runtime/character-identity
```

**Deliberate decisions (per the C20 brief §6):**
1. **The merge/dedup implementation is NOT copied into the module.** `mergeCharacterLists` / `findCanonicalCharacter` / `isPlaceholderCharacter` are owned by `@animastor/vbook-runtime/character-identity` and are **shared with the Book Writer write barrier** (`packages/animastor-vbook-runtime/src/lazy-book/create.js`). Duplicating them inside the AI module would create a second implementation that could drift from the write barrier (exactly what C19.1 forbids for the parser adapter). The runner keeps consuming the shared shim; the C20 guard pins that the analyzer never re-implements the merge.
2. **F7 voices move WITH the module** (semi-final seam): it is character-attribute authoring that consumes the merged character set; the C18 verdict places it on the analysis side by position. Its in-place `characters[i].voice` write-back and skip rules are preserved verbatim. Physical move into an audio-domain module remains possible later without re-opening the extraction.
3. **Degradation ("no characters → keep existing set") stays runner-owned** — it reads `existingChars` state the module never sees.

## 3. Input contract (frozen, minimal — C18 §6 F2 unchanged)

```js
extractCharacters({
  windowText,      // window text as produced by the host (markers included);
                   // passed to the LLM verbatim
  language,        // prompt localization (%LANGUAGE% fill)
  sessionId, stepIndex, progress,   // session/progress context (ports below)
}, ports)           // ports missing → fail-closed throw (C20 guard)

generateVoices({
  windowText,      // window text (8000-char cap for dialogue analysis, unchanged)
  characters,      // the MERGED character set — mutated in place (voice field)
  promptProfiles,  // { audioProfile } → skill injection via ports.buildSkill
  language, sessionId, stepIndex, progress,
}, ports)           // ports missing → fail-closed throw
```

`ports` (host-injected, no ambient access inside the module):

| Port | Default source | Role |
|---|---|---|
| `callAI(messages, opts)` | `ai-caller.callAI` | **the single LLM seam** — provider from ALS context threaded by host; no provider/transport/SDK knowledge in the module |
| `logConversation(sessionId, stepId, messages, response)` | `ai-caller.logConversation` | conversation log (PG) |
| `updateSession` / `createStep` / `completeStep` / `failStep` | `agent-session` | session & step persistence (PG); step types `analyze_characters` / `generate_voices` unchanged (PG CHECK pinned) |
| `extractingCharactersMessage` / `voiceGenerationMessage` | `PROGRESS_STAGES.extracting_chars` / `.voice_generation` | user-facing progress text |
| `prompt(name)` | `SYSTEM_PROMPTS.characters` / `.voice_generation` | prompt source (`ai/rules/characters.md`, `ai/rules/voice_generation.md` via `ai-loader`, content unchanged) |
| `fillLang(t, lang)` | `agent-prompts.fillLang` | `%LANGUAGE%` fill |
| `buildSkill(domain, profile)` | `prompt-profile-loader.buildSkillSection` | audio skill injection for voice authoring (F7) |

## 4. Output contract (frozen — downstream shape unchanged)

```js
extractCharacters → { characters: Character[], mentions: {alias → character_id} }
generateVoices    → { voices: {charId: {instruction}} }
                    AND side effect: characters[i].voice written in place
```

**Fail behavior (unchanged):**
- `extractCharacters`: any AI failure → `failStep` + **throw**. The RUNNER keeps the existing character set (no info ≠ 'unknown'; empty ≠ placeholder synthesis). Malformed/partial AI output is normalized (`result.characters || []`, `result.mentions || {}`) exactly as before.
- `generateVoices`: any AI failure → `failStep` + warn, returns `{ voices: {} }`; existing voices kept. Voices are never overwritten for characters that already have meaningful ones; dialogue-only participants without described appearance get no voice.

Downstream consumers of this shape (verified unchanged): runner merge (462–480) + mentions map, `stepGenerateVoices` slot (497), unit/visual prompt context (mentions), `stepCreateScenes` characters context, bootstrap `window_data.all_characters/all_mentions` (PG round-trip between windows), Book Writer `createFromAnalysis`/`appendToBook` (`analysis.characters/mentions` → characters.json/mentions.json), passport reconciliation (passport-bearing characters).

## 5. Dependency graph (after extraction)

```
                  HOST
  pipeline-runner.js ─── mergeCharacterLists (shared vbook-runtime impl)
      │ analyzers injected            │ apply to module output
      ▼                               ▼
  parallel-analysis-orchestrator    mentions additive merge (runner)
      │ (characters task)
      ▼
  pipeline-steps.stepExtractCharacters / stepGenerateVoices (thin adapters)
      │ inject ports {callAI, log, session/steps, prompt, fillLang, buildSkill}
      ▼
  character-analyzer/index.js ── extractCharacters   (+ re-export)
      │ require (only)
      ▼
  character-analyzer/voices.js ── generateVoices (F7)
      │ require (only)
      ▼
  @animastor/vbook-runtime/character-identity (pure shared predicate)
      ▲ consumed equally by the Book Writer write barrier (packages/…/create.js)

  bootstrap.js ── persistence (window_data PG, Book Writer) — host-only
```

- **No import cycles** (C18 DAG guard re-run with the two new files in the contour set: green). The module's requires are exactly `./voices` + the vbook-runtime identity export — no back-edges into host code (C20 guard 8).
- The host adapters are ≤25 LOC each, port wiring only.
- `parallel-analysis-orchestrator` / `pipeline-runner` / `bootstrap` are untouched.

## 6. Dependency direction — verified + hardened (C19.1 method)

**Correct direction (enforced by guards):**
- Host adapters → Character Analyzer (ports) ✓
- Character Analyzer → `@animastor/vbook-runtime/character-identity` (pure shared predicate) ✓
- Runner → shared merge for the analyzer's output ✓ (merge stays host-applied)

**Forbidden directions (guards prevent):**
- Character Analyzer → Book Writer / Importer ✗ (guard 1, 2)
- Character Analyzer → ai-service / fetch / OpenAI/Anthropic SDK ✗ (guard 3 — LLM arrives only via the injected `callAI` port)
- Character Analyzer → Location / Scene / Structure analyzers, pipeline-steps/runner/orchestrator ✗ (guard 4 — no reverse sibling dependency, no hidden import of the mega-pipeline)
- Character Analyzer → DB / Redis / fs / agent-session / agent-prompts / prompt-profile-loader ✗ (guards 5, 6 — persistence + prompts + skills are ports)
- Character Analyzer → compatibility barrels ✗ (guard 8 — dependency surface closed)
- Merge duplication ✗ (guard 7 — `mergeCharacterLists` etc. must not be re-implemented inside the module)

**What stays host-side and why:**
1. **Merge/dedup/placeholder filtering** — shared implementation with the Book Writer write barrier; a copy inside the AI module would be a drift hazard (C18 H1; C20 brief §6 "не вырывай искусственно").
2. **Degradation policy** (empty extraction → keep existing set) — reads runner state.
3. **Mentions additive merge** (first alias wins) — registry-accumulation across windows, orchestration concern.
4. **Persistence** — window_data (PG) + characters.json/mentions.json (Book Writer), host-owned by bootstrap.
5. **Prompt/skill assets** — `ai/rules/characters.md`, `ai/rules/voice_generation.md`, skills/audio/* stay host fs behind the `prompt`/`buildSkill` ports (C18 H8 load-once semantics preserved).

## 7. Final contract (summary)

```js
extractCharacters(input, ports) → { characters[], mentions{} }
generateVoices(input, ports)    → { voices{} }  (+ in-place voice write-back)

input:  { windowText, language, sessionId, stepIndex, progress }
        generateVoices additionally: { characters, promptProfiles }
ports:  { callAI, logConversation, updateSession, createStep, completeStep,
          failStep, extractingCharactersMessage|voiceGenerationMessage,
          prompt, fillLang, buildSkill(voices only) }
fail:   extract → failStep + throw (runner keeps existing set)
        voices  → failStep + { voices: {} } (existing voices kept)
```

## 8. Guards

New: `backend/tests/architecture/character-analyzer-extraction-c20.test.js` —
1. no Book Writer; 2. no Importer; 3. no ai-service/SDK/fetch (provider only via port); 4. no sibling-analyzer / mega-pipeline imports + no sibling output fields; 5. host capabilities only via ports (fail-closed pin + adapter wiring pin); 6. no persistence inside the analyzer (comment-stripped scan) + persistence pinned host-side; 7. shared merge not duplicated + runner keeps applying the shared merge + host shim stays a one-line re-export; 8. closed dependency surface (index → ./voices only; voices → identity package only) + no back-edge cycles; 9. frozen contract exports + host routing through the seam + frozen PG step types.

Updated: `ai-analyzer-boundary.test.js` (C17 file list + C17 Guard 2/3 now cover the new module), `ai-functional-decomposition-c18.test.js` (contour DAG file set + Book Writer NON_HOST list), `pipeline-step-types.test.js` (step-type scan extended to analyzer modules).

## 9. Behavior verification (all green)

| Suite | Result |
|---|---|
| `tests/character-analyzer-extraction-c20.test.js` (new, behavior pins: happy path, empty/malformed AI, transport failure, fail-closed ports, voice write-back/no-overwrite/phantom-skip, skill injection) | 12 passing |
| `tests/architecture/character-analyzer-extraction-c20.test.js` (new, 29 assertions) | passing |
| `npm run test:arch` (all architecture suites incl. C17/C18/C19/C20) | 572 passing |
| `tests/pipeline-runner-parallel/placeholder`, `parallel-analysis-{orchestrator,acceptance,concurrency}` (analysis dispatch, merge, degradation, cancellation) | 42 passing |
| `tests/structure-detector.test.js` (golden), `coreference-agent.test.js` (merge golden), `unit-splitter.test.js` | 106 passing |
| `tests/happy-path.test.js`, `agent-status.test.js` | 81 passing |
| `tests/scene-cache/scene-split/source-coverage` | 50 passing |
| `tests/snake-guard`, `visuals-duration`, `video-action-{polish,reconciliation}`, `pipeline-step-types` | 93 passing |
| `packages/animastor-vbook-runtime` package suite (identity/merge shared impl) | 24 passing |
| `packages/animastor-parser` package suite | 32 passing |
| `npm run test:syntax` | green |

`tests/bootstrap-cancel-continue.test.js` has 1 pre-existing failure reproduced identically on the unmodified baseline (`git stash` check) — environment-dependent, not a C20 regression.

Prompt text, extraction prompt assembly, voice skip rules, in-place voice write-back, merge algorithm, mentions rule, fallback/throw split, `[AGENT] Step 1 (characters)` / `Step voice_generation` log lines — all byte-identical. Production code changes: two steps in `pipeline-steps.js` became thin adapters; everything else is additive (new module + tests).

## 10. Further extraction order (per C18 §10, updated)

1. **Location Analyzer (F3)** — same pattern; the runner's env-sanitize + description-merge block (513–556) must move into the module contract first.
2. **Scene Analysis (F4/F5)** — needs `source-coverage` + duration heuristic ownership decision; biggest port surface.
3. **File split of `pipeline-steps.js`** (C18 stage 2) — remaining steps (scenes/units/visuals/reconciliation/polish/repair) split into analysis vs generation halves; the character/structure adapters move wholesale.
4. **Merge ownership evolution (C18 H1 decision #3)** — when a second consumer for character merge appears, the pure merge can be re-exported through a shared seam; today the vbook-runtime single-implementation rule wins.
5. **Package extraction (`@animastor/ai-analyzer`)** — `structure-analyzer/` + `character-analyzer/` are the first package-boundary seeds; promote when Location/Scene reach the same shape.

## Verdict

**Character/Entity is now an independent functional boundary** (F2 extraction + F7 attributes behind one module seam) that can be developed, replaced, or tested without touching Structure (C19), Location, Scene, Generation passes, the Importer, the Book Writer, or provider/persistence infrastructure — without creating a new mega-module and without duplicating the shared identity/merge implementation.
