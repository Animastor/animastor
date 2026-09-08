# C18 — Functional Decomposition of the AI Pipeline

**Status:** READ-ONLY architectural reconnaissance + contract freeze. No code moved, no npm package created, no prompts/algorithms/provider behavior changed, no runtime behavior change.
**Date:** 2026-09-08
**Baseline:** HEAD `c2b0fc2d` (`arch(editor): Phase 1.1 — editor-ports.cjs holds zero host require() calls`)
**Predecessor:** `docs/architecture/ai-analyzer-boundary-c17.md` (C17 froze the *AI Analyzer as a whole*). C18 goes one level down: it decomposes the AI contour into **independent functional modules**, separates **Analysis from Generation**, and freezes the minimal contracts between them so each function can later be developed, replaced or physically extracted independently.
**Artifacts:** this document + one read-only architecture guard test (`backend/tests/architecture/ai-functional-decomposition-c18.test.js`).

---

## 1. Scope / baseline

Files studied (call graph and data flow traced from code, not names):

| File | LOC | Role in the contour |
|---|---|---|
| `backend/src/services/structure-detector.js` | 1231 | Deterministic candidate scan + deterministic chapter map + **AI decision merge** (`mergeAiDecisions`, `analyzeStructure`, `sanitizeStructure`). Zero requires (pure). Dual role: deterministic half is host-injected into `@animastor/parser` (`backend.cjs:41 setStructureDetector`), AI-merge half is called by the pipeline. |
| `backend/src/services/agent/pipeline-steps.js` | 1594 | **All AI step functions**: structure (202), characters (311), locations (337), scenes (368), units (437), voices (494), visuals (1080), passport reconciliation (653), video action reconciliation (754), storyboard polish (850), video action polish (982), fantasy-snake repair (1490) + pure merge/guard helpers. |
| `backend/src/services/agent/pipeline-runner.js` | 1370 | **Window orchestration**: `runPipeline` (286) and `processCachedScenes` (1015); window slicing `getWindowText` (105); scene coverage loop; post-pass chaining; result merge. |
| `backend/src/services/agent/parallel-analysis-orchestrator.js` | 441 | Fixed 3-task graph (`characters`, `locations`, `voices`) with wave scheduling (p-limit). Analyzers are **injected** (`analyzers` param), task table `ANALYZERS` frozen. |
| `backend/src/services/agent/ai-caller.js` | 86 | **Provider seam**: `callAI` (retry ×`STEP_RETRIES`, JSON parse), AsyncLocalStorage provider context, `logConversation` → PG. |
| `backend/src/services/ai-service.js` | 656 | **Transport**: OpenAI-compatible HTTP (`POST {baseUrl}/chat/completions`, safeFetch + SSRF guard, 4xx-no-retry) **or** LAC connector WS (`sharedPool.runSharedInference`); `parseJsonResponse` (fence/`<think>` strip, truncated-JSON repair); `refineDraft` (legacy import path); `checkAIHealth`. |
| `backend/src/services/agent-prompts.js` | 179 | Prompt assembly (`SYSTEM_PROMPTS` from `ai/rules/*.md` via `ai-loader`, fs/env `AI_DIR`), `fillLang`, window/scene budgets, `PROGRESS_STAGES`, `STEP_RETRIES`. |
| `backend/src/services/agent/unit-splitter.js` | 298 | AI split of long units (> 20 s) + deterministic emergency fallback chain. |
| `backend/src/services/agent/text-utils.js` | 183 | Deterministic: sentence/paragraph splitting, `buildFallbackScenes`, `stripStructureFromText` (currently unused outside barrel). |
| `backend/src/services/agent/image-utils.js` | 106 | Deterministic fallback image prompt + exemplars from `ai/examples`. |
| `backend/src/services/agent/bootstrap.js` | 802 | **Host orchestrator**: provider resolution, windows, session lifecycle, cancellation cleanup, offset discipline, metadata write, Book Writer calls. |
| `backend/src/services/agent-session.js` | 86 | PG sessions/steps (create/update/complete/fail, cancellation checks). |
| `backend/src/services/txt-importer.js` | 298 | Importer façade → `agent-service` (barrel) → `agent/bootstrap`. |
| `backend/src/services/source-coverage.js` | 445 | Pure coverage/offset validation (the scene-progress truth). |
| `backend/src/services/prompt-profile-loader.js` | 107 | Skills (`ai/skills/{video,image,audio}/*.md`) injected into generation prompts. |

Related but **outside** the AI contour: `workspace-ai-provider` (provider resolution, host), `layer-config` (Redis options, host), `lazyBook` (Book Writer / parser facade), `image/prompt-builder.js` + `workflows/video/video-workflows.js` (GPU-side **consumers** of `scene.passport[charId].video_tokens` produced here), `window-generator.cjs` (background driver that calls `bootstrapNextWindow`).

---

## 2. Current AI call graph (as-built, verified)

```
POST /book/:id/bootstrap (import-routes.cjs)          window-generator.cjs (background continue)
  → txt-importer.bootstrapImportedText / bootstrapNextWindow
    → agent-service (barrel)
      → agent/bootstrap.js
          bootstrapWithAgent (bootstrap.js:50)
            resolveAIForBook(bookId)                   ← HOST: provider resolution (workspace-ai-provider)
            aiCaller.runWithProvider(provider, …)      ← AsyncLocalStorage context (ai-caller.js:20)
            createSession (PG agent_sessions)          ← agent-session.js:3
            structureDetector.extractCandidates        ← DETERMINISTIC (bootstrap.js:128)
            pipelineSteps.stepAnalyzeStructure (:131)
                aiCaller.callAI  → LLM classify candidates (ai/rules/structure.md)
                structureDetector.analyzeStructure → mergeAiDecisions (deterministic backbone
                                                      + sanitizeStructure-guarded LLM merge)
                AI failure → buildDeterministicMap fallback (pipeline-steps.js:269-308)
            pipelineRunner.getWindowText(sourceText, …, {chapterMap: structure.segments}) (:133)
                ← AI-refined segments drive window slicing; fallback lazyBook.splitIntoChapters
            bookMeta write (title/author/structure)    ← fs, HOST (bootstrap.js:136-152)
            pipelineRunner.runPipeline (:165)          ← see below
            lazyBook.createFromAnalysis(...)           ← BOOK WRITER (bootstrap.js:227)

          bootstrapNextWindow (bootstrap.js:330)
            getLastSourceEnd (disk) + windowData (PG) → offset resolution (:436-459)
            cached scenes → pipelineRunner.processCachedScenes (:490) → appendToBook (:514)
            AI path → getWindowText (:604) → runPipeline (:675) → appendToBook (:713)

runPipeline (pipeline-runner.js:286) — ONE window:
  [analysis phase — sequential OR parallel]
    parallel → parallelOrchestrator.run({taskIds:['characters','locations'], analyzers: pipelineSteps}) (:412-457)
        waves: {characters, locations}  (voices registered in ANALYZERS but not scheduled here;
               it needs the MERGED character set — runs in the legacy sequential slot)
    sequential → stepExtractCharacters (:459)
    merge: mergeCharacterLists + mentions merge (:462-480)          ← runner-owned business logic
    stepGenerateVoices (:497)  → mutates characters[i].voice in place
    stepExtractLocations (:511, sequential) + environment sanitize + description-merge (:513-556)
  [scene phase]
    stepCreateScenes (:616) → coverage validation → repair retry with repairHint (:630)
              → deterministic fallback textUtils.buildFallbackScenes (:640)
    per scene loop (:675-751):
        stepCreateUnits (:695) → splitLongUnits (unit-splitter, :698) → stepCreateVisuals (:719)
        unit-level source_coverage annotation (:723-743)
  [generation post-processing chain — flat visual-unit projections repeated inline 5×]
    stepReconcilePassports (:778) → applySceneVideoTokens → scene.passport (:802)
    stepReconcileVideoActions (:830)
    stepPolishStoryboard (:869)
    stepPolishVideoActions (:918)
    final sweep: needsVideoActionReconciliation → stepReconcileVideoActions (:961-976)
    stepRepairFantasyIds (:990) + applyRepairToScenes (in-place write into enrichedScenes)
  → { characters, locations, mentions, scenes, coverage, nextOffset, extraScenes }
→ Book Writer (lazyBook.createFromAnalysis / appendToBook)
```

**Data flow (the real spine):**

```
raw sourceText
  → structure { segments[], title, author, country, epoch }
  → window text (chapter-map slicing, marker injection)
  → characters[] + mentions{} + locations[] (+ voice instructions)
  → scenes[] { title, text, type, participants[], location{id, environment{}} }
  → units[] { text (verbatim), type, audio.speaker? }
  → visual units[] { image{shot,prompt,style,negative}, video{action} }
  → reconciled / polished / repaired visual units (+ scene.passport[*].video_tokens)
  → Book Writer (chapters/scenes/characters.json/bible.json on disk)
```

---

## 3. Functional decomposition

Four classes of functionality live in the contour. **A = Semantic Analysis** (what is in the text), **G = Generation / post-processing** (what is created from already-analyzed data), **I = Infrastructure** (capabilities, not business logic), **O = Orchestration** (ordering, cancellation, progress, host integration).

| ID | Function | Class | Implementation today |
|---|---|---|---|
| F1 | **Structure / Chapter Analysis** | A | `structure-detector.js` (deterministic half + AI-merge half) + `pipeline-steps.stepAnalyzeStructure` (202-309) |
| F2 | **Character Analysis** | A | `stepExtractCharacters` (311-335) + merge `mergeCharacterLists` (`utils/character-identity`) + mentions map, merged in runner (462-480) |
| F3 | **Location Analysis** | A | `stepExtractLocations` (337-366) + env sanitization + description merge in runner (513-556) |
| F4 | **Scene Analysis** | A | `stepCreateScenes` (368-435) + `normalizeSceneEnvironment` (177) + coverage validation/retry (runner 616-645) + `text-utils.buildFallbackScenes` |
| F5 | **Unit Analysis / Splitting** | A | `stepCreateUnits` (437-492) + `unit-splitter.splitLongUnits` (AI-first, deterministic fallback chain) |
| F6 | **Metadata Analysis** | A | title/author/country/epoch inside F1 result; persisted by bootstrap (fs bookMeta, 136-152) |
| F7 | **Voice Description Authoring** | A→G hybrid | `stepGenerateVoices` (494-587): analyzes dialogue, **writes** `characters[i].voice` in place |
| F8 | **Visual Prompt Generation** | G | `stepCreateVisuals` (1080-1281) + `image-utils` (fallback prompt, exemplars) + prompt-profile skills |
| F9 | **Passport / Video Reconciliation** | G | `stepReconcilePassports` (653-752) + `parseSceneVideoTokens` + `applySceneVideoTokens` (runner 79-103) → `scene.passport[*].video_tokens` |
| F10 | **Video Action Reconciliation** | G | `stepReconcileVideoActions` (754-848) + static-copy guards `isStaticActionCopy` / `needsVideoActionReconciliation` (76-100) + final sweep (runner 944-977) |
| F11 | **Storyboard Polish** | G | `stepPolishStoryboard` (850-980) + cross-prompt hints (`buildCrossPromptHints`, `stillMissingIds`) |
| F12 | **Video Action Polish** | G | `stepPolishVideoActions` (982-1078) |
| F13 | **Fantasy-Snake Repair** | G (deterministic + LLM) | `stepRepairFantasyIds` (1490-1564) + pure helpers `canonicalizeVisualUnit`, `mergeRepairResults`, `applyRepairToScenes` (1292-1488) |
| F14 | **Entity Mention Normalization** | G (shared util) | `normalizeVisualText` (32-39) → `image/image-service.normalizeCharacterRefs`; applied at every AI merge point of F8-F12 |
| F15 | **LLM Call Infrastructure** | I | `ai-caller.js` (retry, JSON parse, provider context, PG conversation log) |
| F16 | **AI Transport** | I | `ai-service.callAI` (HTTP / connector branches), `parseJsonResponse`, `checkAIHealth` |
| F17 | **Provider Selection** | I (host) | `workspace-ai-provider.resolveAIForBook` + `system-ai` kill switch; threaded via `runWithProvider` |
| F18 | **Prompt Loading** | I | `agent-prompts` (rules via `ai-loader`), `prompt-profile-loader` (skills), `profile-override` (host config) |
| F19 | **Session / Step Persistence** | I | `agent-session.js` (PG agent_sessions / agent_steps); conversation log in `ai-caller.logConversation` (PG) |
| F20 | **Progress / Events** | I | `publishVBook` closures (runner 372-391, 1052-1067), `PROGRESS_STAGES`, Redis scene-idx key |
| F21 | **Cancellation** | I | 3-level `checkCancelled` (runner 322-363, duplicated 1022-1050): PG session, PG book, Redis set |
| F22 | **Window Slicing / Coverage** | O | `getWindowText` (runner 105-248), `resolveSceneProgress` (250-284), `source-coverage.js` (pure) |
| F23 | **Analysis Orchestration** | O | `parallel-analysis-orchestrator.js` (fixed task graph, injected analyzers) + dispatch in runner (399-461) |
| F24 | **Pipeline Orchestration** | O | `runPipeline` / `processCachedScenes` (runner), merge logic, post-pass chaining |
| F25 | **Host / Import Orchestration** | O | `agent/bootstrap.js` (windows, offsets, dedup, sessions, Book Writer calls), `txt-importer`, `window-generator.cjs` |

---

## 4. Analysis vs Generation boundary

This is the central C18 finding: `pipeline-steps.js` and the back half of `runPipeline` **fuse two different functional domains** that happen to share one file and one loop.

### Semantic Analysis (F1–F6) — "what is in the text"
- **Input:** raw text (or window text), existing registries (characters, locations, mentions), language, book defaults.
- **Output:** structure/chapters, characters+mentions, locations+environments, scenes (participants, location, env), units (verbatim text decomposition), metadata.
- **Invariant:** `unit.text` / `scene.text` stay **verbatim**; coverage (`source-coverage`) is the progress truth; fallbacks are deterministic.
- Steps: F1 structure, F2 characters, F3 locations, F4 scenes, F5 units, F6 metadata.

### Generation / post-processing (F8–F14) — "what is created from analyzed data"
- **Input:** the *already analyzed* enriched scenes + registries (never raw book text directly; scene/unit text only as context).
- **Output:** `unit.image.{shot,prompt,style,negative}`, `unit.video.action`, `scene.passport[charId].video_tokens`, repaired prompts/speakers, voice instructions (F7).
- **Invariant:** merge-back is **keyed and field-scoped** (`scene_index`/`unit_index`), out-of-format fields (>`IMAGE_PROMPT_MAX_CHARS`) are never touched, agent-authored actions are never overwritten, fantasy ids never reach the book.
- Steps: F8 visuals, F9 passport reconciliation, F10 video action reconciliation, F11 storyboard polish, F12 video action polish, F13 fantasy repair, F14 mention normalization util.

### F7 — the deliberate hybrid
`stepGenerateVoices` *analyzes* dialogue from text but *writes a generative attribute* (`characters[i].voice`) used later by the audio domain. It sits on the analysis side by position (runs right after character merge) but is generative by nature. It is **not** part of the semantic analyzer contract; treat it as an audio-domain authoring step that consumes the merged character set.

### What is co-located only for historical reasons
1. **F8–F13 inside `pipeline-steps.js` next to F1–F5** — one file, one `require` block, one session/progress idiom. Nothing in the analysis steps needs the generation steps or vice versa (verified: no analysis step references `image.prompt`/`video.action` production; no generation step re-analyzes structure).
2. **The generation post-pass chain inside `runPipeline`** — five inline `flatMap` projections of `enrichedScenes` (runner 760-774, 813-827, 852-866, 901-915, 945-959) + merge-back loops; the same chain duplicated wholesale in `processCachedScenes` (1136-1350). Orchestration (ordering, `checkCancelled`, progress) is interleaved with the passes' business result.
3. **`normalizeVisualText` (F14)** lives in the same file as analysis steps but is used only by generation steps.
4. **`stepGenerateVoices` in the same ANALYZERS table** as characters/locations — it has a different dependency shape (mutates a registry, depends on merge).

---

## 5. Potential modules — independence & replaceability

Legend: **Repl** = replaceable by an alternative implementation behind the frozen contract; **Iso-test** = testable in isolation today; **Solo-dev** = another developer can own it without touching other analyzers; **Only-LLM** = needs just the generic `callAI` port; **Host deps** = Book Writer / Importer / Redis / PG it currently touches; **Pkg** = future standalone npm package candidate (`@animastor/ai-analyzer` scope per C17 §12 unless noted).

| ID | Module | Repl | Iso-test | Solo-dev | Only-LLM | Host deps today | Pkg candidate |
|---|---|---|---|---|---|---|---|
| F1 | Structure Analysis | **Yes** (deterministic fallback already is the alternative) | Yes (pure detector + golden tests) | Yes, via `StructureDetectorPort` (C17 §8) | Yes (LLM only classifies candidates) | none (pure file); session/log via step wrapper | Yes (AI-merge half) |
| F2 | Character Analysis | Yes (prompt/merge strategy swappable) | Yes (step + merge fns) | Yes | Yes | PG steps/log, session progress | Yes |
| F3 | Location Analysis | Yes | Yes | Yes | Yes | PG steps/log | Yes |
| F4 | Scene Analysis | Yes (deterministic fallback scenes exist) | Yes (coverage + fallback tested) | Yes | Yes + `source-coverage` + duration heuristic | PG steps/log | Yes |
| F5 | Unit Analysis/Splitting | Yes (deterministic emergency split exists) | Yes (`unit-splitter.test.js`) | Yes | Yes + `estimateSpeechDurationSec` | PG steps/log | Yes |
| F6 | Metadata Analysis | Yes | Yes (part of F1 result) | Yes (same owner as F1) | Yes | fs write is host-side | with F1 |
| F7 | Voice Authoring | Yes | Yes (needs character fixture) | Yes | Yes + `hasRealAppearance` | PG steps/log; mutates shared registry | Yes, audio-adjacent |
| F8 | Visual Prompt Generation | Yes (fallback prompt is the degraded impl) | Yes (fixture scenes/units) | Yes | Yes + skills/profiles + `image-utils` | PG steps/log | **Not yet** (generation, host-internal first) |
| F9 | Passport/Video Reconciliation | Yes (no-op pass = current degraded mode) | Yes (pure merge/token fns exported) | Yes | Yes | PG steps/log; writes `scene.passport` (consumed by `workflows/video`) | Not yet |
| F10 | Video Action Reconciliation | Yes | Yes (pure guards exported) | Yes | Yes | PG steps/log | Not yet |
| F11 | Storyboard Polish | Yes | Yes (pure hint fns) | Yes | Yes | PG steps/log | Not yet |
| F12 | Video Action Polish | Yes | Yes | Yes | Yes | PG steps/log | Not yet |
| F13 | Fantasy-Snake Repair | Partially (deterministic canonicalization is fixed policy; LLM half replaceable) | Yes (pure helpers exported) | Yes | Yes + `snake-guard` | PG steps/log | Not yet |
| F15/F16 | LLM infra + transport | Yes (connector branch already proves it) | Yes (transport tests exist) | Yes | — | PG conversation log, runtime-config, system-ai | No (premature; seam exists) |
| F18 | Prompt loading | Yes (port per C17 §11) | Yes | Yes | — | fs `AI_DIR` | No (assets ship with analyzer later) |
| F19–F21 | Session/log/cancel/events | Yes as ports | Yes | n/a (host capability) | — | PG, Redis, SSE | **No** — host infra |
| F22 | Windowing/coverage | Yes | Yes (`source-coverage.test.js`) | Yes | — | lazyBook facade fallback | No (orchestration concern) |
| F23 | Analysis orchestrator | Partially (intentionally NOT a generic DAG engine) | Yes (`pipeline-runner-parallel.test.js`) | Yes | — | none (analyzers injected) | No |
| F24 | Pipeline orchestration | No (this *is* the product flow) | Integration-level | n/a | — | PG, Redis, SSE, lazyBook | No |
| F25 | Host/bootstrap | No | Integration-level | n/a | — | everything host | No |

**Answers to the seven boundary questions (condensed):**
1. *Replaceable?* Every AI step has a defined degraded mode (deterministic fallback or no-op pass) — replaceability is real, not theoretical.
2. *Testable separately?* Yes today for all pure helpers and every step given a `callAI` stub; the friction is only the embedded PG step/session calls (F19) threaded through every step.
3. *Independent development?* Yes **after** the ports of §8 exist; today all steps share `pipeline-steps.js` and `agent-prompts.js` in one file — file split (not package split) is the first move.
4. *Only generic AI Provider needed?* Yes — no step knows provider/model/endpoint; all reach the LLM exclusively via `ai-caller.callAI` (frozen by C17 guard 5).
5. *Book Writer / Importer / Redis / PG needed?* Analysis & generation steps: no Book Writer, no Importer, no Redis; only PG step logging + cancellation checks (must become ports). Host (F25) owns the rest.
6. *Standalone internal module?* F1–F6 (analysis) — yes after port-ification. F8–F13 (generation) — yes as an internal "visual post-processing" module; package extraction deferred.
7. *npm package?* One package candidate exists: the **semantic analyzer** (F1–F6 + validation utils), per C17 §12. Generation passes stay host-side until a second consumer appears. Infra (F15–F21) and orchestration (F22–F25) — never as separate packages now.

---

## 6. Input / output contracts (frozen as-is, minimal)

Contracts are the *existing* function signatures and data shapes — no new abstractions.

### F1 Structure Analysis
```
in:  { sourceText: string (exact instance, offsets anchor into it),
       candidates?: CandidateLine[],          // optional; re-derived via extractCandidates
       language: string, sessionId, stepIndex, progress }   // session/progress = port-to-be
out: { author, title, has_prologue, has_epilogue, parts[],
       chapters: LegacyChapterDTO[],          // mapToStructureChapters projection
       segments: ParserSegment[],             // canonical chapter map → drives window slicing
       country, epoch }
fail: → deterministic fallbackStructure (buildDeterministicMap) — NEVER fails the import
```

### F2 Character Analysis
```
in:  { windowText, language, sessionId, stepIndex, progress }
out: { characters: Character[], mentions: {alias → character_id} }
fail: throw (runner keeps existing set; empty ≠ 'unknown' — no placeholder synthesis)
merge contract (runner-owned): mergeCharacterLists(existing, extracted, {skipGeneric:true});
       mentions merged additively (first alias wins)
```

### F3 Location Analysis
```
in:  { windowText, characters (EXISTING set, context only), language, … }
out: Location[] { id, name, type, description, environment? }
fail: throw → runner keeps existing set; environment sanitized via sanitizeEnvironment
merge contract (runner-owned): by id; longer description concatenates; no env placeholders
```

### F4 Scene Analysis
```
in:  { sceneText (window), characters, locations, bookDefault{country,epoch}, language,
       repairHint? (coverage failure reason + gap preview), chunkSize }
out: Scene[] { title, text (verbatim), type, participants|characters_present,
               location{ id, environment?{time,season,lighting,weather,mood,atmosphere,country,epoch} } }
validation: source_coverage over sceneText; 1 repair retry; then deterministic
            textUtils.buildFallbackScenes; only then hard-fail
```

### F5 Unit Analysis / Splitting
```
in:  { scene {text, type}, characters, mentions, sessionId, sceneIndex, … }
out: Unit[] { text (verbatim from scene), type, audio{speaker?, text?} }
     splitLongUnits: in {scene, units} → out units, each ≤ 20 s estimated,
     AI-first (unit_splitter.md), fallback sentence→comma→word-count
fail: stepCreateUnits → single fallback unit (whole scene text);
      splitLongUnits → emergency split (never throws)
```

### F7 Voice Authoring
```
in:  { windowText, characters (merged set, mutated!), language, promptProfiles.audioProfile }
out: { voices: {charId: {instruction}} }  AND side effect: characters[i].voice written in place
skip rules: only hasRealAppearance(c); only meaningful-voice gaps; voices never overwritten
fail: → { voices: {} }, existing voices kept
```

### F8 Visual Prompt Generation
```
in:  { scene, units, characters, locations, nextScene (lookahead), mentions, promptProfiles }
out: units[] each + image{shot,prompt,style?,negative?} + video{action}
     action fallback = prompt (static copy) — reconciled later by F10
     prompts normalized via normalizeVisualText (ids, never display names)
fail: → deterministic imageUtils.getFallbackImage per unit
```

### F9 Passport/Video Reconciliation (+ video_tokens)
```
in:  { allVisualUnits (flat: sceneIndex,unitIndex,text,participants,image,video),
       characters (passport-bearing), scenes (participants + current tokens) }
out: { units (merged, keyed scene_index/unit_index, only image/video touched, in-range only),
       videoTokens: [{scene_index, tokens:{charId: string[]}}] }
side effect (runner): applySceneVideoTokens → scene.passport[charId].video_tokens
       ONLY for scene participants, ONLY when differing from effective tokens
       consumer outside AI contour: backend/src/workflows/video/video-workflows.js:99-100
fail: → original units, videoTokens [] (no-op pass)
```

### F10 / F11 / F12 Reconciliation & Polish passes
```
shared in:  { allVisualUnits, characters, locations (F11/F12), promptProfiles (skill injection) }
shared out: units merged back by (sceneIndex, unitIndex), field-scoped:
            F10/F12 → video.action only; F11 → image.prompt (+shot) only
guards (pure, exported): inPromptRange/inActionRange (≤ IMAGE_PROMPT_MAX_CHARS),
            isStaticActionCopy, needsVideoActionReconciliation (F10 + final sweep),
            buildCrossPromptHints/stillMissingIds (F11 hard direction: video ids ⊆ image ids)
fail: → original units (pass = no-op)
```

### F13 Fantasy-Snake Repair
```
in:  { allVisualUnits, characters, locations }
out: units; repair written into enrichedScenes via applyRepairToScenes (image.prompt,
     video.action, audio.speaker — speaker only if unit originally had audio)
pipeline: canonicalizeVisualUnit (deterministic) → flag unverified snake tokens →
     LLM reassembly → mergeRepairResults (per-field clean check → desnakeify fallback → revert)
fail: → original units
```

### F15/F16 LLM infrastructure (the port every AI module sees)
```
callAI(messages, { maxTokens?, timeout?, temperature?, retries? }) → parsed JSON object
   retry ×STEP_RETRIES(3), linear backoff; provider from options || ALS context; model default chain
logConversation(sessionId, stepId, messages, response)  → PG (port-to-be)
fail: throws after retries; step decides degradation
```

---

## 7. Dependency graph (as-built)

```
                       HOST (not part of AI contour)
  import-routes / window-generator → txt-importer → agent-service (barrel)
                                         │
                                         ▼
                              agent/bootstrap.js (F25)
              provider resolution (F17) · sessions (F19) · windows (F22 host part)
              metadata write (fs) · BOOK WRITER lazyBook.createFromAnalysis/appendToBook
                                         │ runWithProvider
                                         ▼
                     pipeline-runner.js (F22+F24, O) ──────────────┐
                       │ getWindowText → lazyBook facade (splitIntoChapters,
                       │   injectChapterMarkers, firstMeaningfulChapter)
                       │                                            │
        ┌──────────────┼────────────────────────────┐               │
        ▼              ▼                            ▼               ▼
 parallel-analysis-  analysis steps (A)          generation steps (G)
 orchestrator (F23)  pipeline-steps.js:          pipeline-steps.js:
   │ analyzers          F1 stepAnalyzeStructure     F8 stepCreateVisuals
   │ injected           F2 stepExtractCharacters    F9 stepReconcilePassports
   ▼                    F3 stepExtractLocations     F10 stepReconcileVideoActions
 [characters, locations] F4 stepCreateScenes        F11 stepPolishStoryboard
   waves (p-limit)      F5 stepCreateUnits          F12 stepPolishVideoActions
   (voices F7 runs      F7 stepGenerateVoices       F13 stepRepairFantasyIds
    AFTER merge,        unit-splitter (F5)          F14 normalizeVisualText
    sequential slot)    text-utils (F4 fallback)    image-utils (F8)
        │                    │                            │
        └──────────────┬─────┴────────────────────────────┘
                       ▼  EVERY AI module reaches the LLM ONLY here
              ai-caller.js (F15) ── retry, JSON parse, ALS provider context
                       │                      │ logConversation → PG
                       ▼
              ai-service.js (F16) ── HTTP (safeFetch/SSRF, 4xx-no-retry)
                                  ── connector WS (shared-pool, fail-closed)
                       │
        ┌──────────────┼──────────────────────┐
        ▼              ▼                      ▼
 workspace-ai-provider (F17)   system-ai kill switch   runtime-config

 shared deterministic utils (no AI):  source-coverage (F22 core),
 snake-guard/character-identity/scene-title-utils (@animastor/vbook-runtime re-exports),
 placeholder-audio.estimateSpeechDurationSec, image-service.normalizeCharacterRefs (F14)
 prompts (F18): ai/rules/*.md → agent-prompts.SYSTEM_PROMPTS (require-time fs load)
                ai/skills/{image,video,audio} → prompt-profile-loader → G steps only
```

### Cyclic dependencies
**No import cycles exist** within the contour (verified by scanning every `require`, including lazy inline ones; pinned by the new C18 guard test). The graph is a clean DAG: orchestration → steps → ai-caller → ai-service → provider resolution.

### Hidden / shared-state dependencies (the real findings)

| # | Finding | Where | Why it matters |
|---|---|---|---|
| H1 | **Orchestration ↔ business fusion**: merge logic for characters/locations/mentions lives inside `runPipeline` (runner 462-480, 513-556), not in the analyzers | pipeline-runner | Extracting F2/F3 without moving merge changes behavior; merge must be assigned to the module contract explicitly |
| H2 | **Generation chain duplicated**: the flat-projection + pass + merge-back block is copy-pasted 5× in `runPipeline` and 5× in `processCachedScenes` (~200 dup lines) | runner 760-977 vs 1136-1350 | Any change to a pass's merge contract must be made twice; the composer must be extracted before any pass is moved |
| H3 | **In-place mutations across module boundaries**: `stepGenerateVoices` mutates `characters[i].voice`; `applySceneVideoTokens` mutates `scene.passport`; `applyRepairToScenes` mutates `enrichedScenes` | runner 79-103, 497-502; steps 1469-1488 | Result-carrying contracts (F7, F9, F13) hide write-backs; a replacement impl must reproduce the side effect or the runner must own it |
| H4 | **Ambient provider context**: ALS `runWithProvider` instead of explicit `callAI` injection | ai-caller 11-28 | Every AI module silently depends on being called inside the context (C17 §11 blocker) |
| H5 | **PG embedded in every step**: `createStep/completeStep/failStep/updateSession` + `logConversation` called from business functions | pipeline-steps (every step), unit-splitter | Persistence contract interleaved with AI logic; port needed before any extraction (C17 step 2) |
| H6 | **Lazy inline requires** obscuring edges: `structure-detector` (steps 210), `parallel-analysis-orchestrator` (runner 413), `ai-caller` (bootstrap 80/349), `ai-service`→`shared-pool`/`system-ai` (ai-service 38, 143) | various | Hidden on casual read; pinned by the C18 graph guard which scans whole source |
| H7 | **Dual-role file**: `structure-detector.js` is simultaneously the Parser port implementation (`backend.cjs:41 setStructureDetector`) and the AI merge seam | structure-detector | Splitting analysis from parser needs a compatibility barrel; behavior frozen by `structure-detector.test.js` (~900 golden lines) |
| H8 | **require-time prompt loading**: `SYSTEM_PROMPTS` and skills are read from fs once at module load; `IMAGE_PROMPT_MAX_CHARS` budget constants are shared state used by steps *and* guards | agent-prompts 76-87, 69-73 | A prompt-port (C17 §11) must preserve load-once semantics or hot-reload becomes a behavior change |
| H9 | **Cross-contour contract**: `scene.passport[charId].video_tokens` written here is consumed by GPU-side `video-workflows.js:99-100` and `image/prompt-builder.js:45` | F9 | The AI contour has an external consumer; any change to F9's output shape breaks generation silently |
| H10 | **Image-module util inside AI steps**: `normalizeCharacterRefs` from `image/image-service` is a core part of every generation merge | pipeline-steps 20, 32-39 | F14 belongs to the analyzer/generation domain, not to the image module; util move required for a clean package edge |
| H11 | **Voices' dependency shape differs from siblings**: depends on the *merged* character set; that is why it cannot run in the parallel wave | runner 424-433 comment, orchestrator ANALYZERS | Any future "parallelize voices" change must first move the merge inside the orchestrator — a documented, deliberate non-goal |

**Orchestration mixed with business logic** (per the task checklist): runner 462-480 & 513-556 (H1), the post-pass chaining itself (ordering + cancellation + progress + projection + merge-back in one block, H2), and coverage bookkeeping (`resolveSceneProgress`) which is analysis-adjacent but runner-owned. Bootstrap mixes host duties (sessions, dedup, fs, Book Writer) with analyzer hosting (provider context, candidate scan) — already documented in C17 §10; unchanged.

---

## 8. Infrastructure / ports

Capabilities that are **not** part of any specific analyzer. Classification per C17 §9/§11, re-stated per function:

| Capability | Today | Classification |
|---|---|---|
| LLM call (messages+opts → parsed JSON) | `ai-caller.callAI` | **PORT** — the single seam every AI module uses; make explicitly injectable (remove ALS dependence, H4) |
| Provider selection | `workspace-ai-provider` + `system-ai` | **HOST-ONLY** — resolved once, threaded in |
| Transport (HTTP / connector WS) | `ai-service` | **INFRA** — behind the port; swappable, no package |
| Retry / timeout | `ai-caller` (×3 linear) + `ai-service` (×3 exp, no 4xx) + `AbortSignal.timeout` | **INFRA** — stays under the port; step-level `retries` option already exists |
| Prompt loading | `ai-loader` (rules/examples) + `prompt-profile-loader` (skills) | **PORT** (`getPrompt`/`getSkill`); assets stay host fs for now (H8) |
| Session / step persistence | `agent-session` (PG) | **PORT** (`logStep`, `updateProgress`) — today embedded in steps (H5) |
| Conversation log | `ai-caller.logConversation` (PG) | **PORT** (log callback) |
| Progress / events | `publishVBook`, `PROGRESS_STAGES`, Redis scene-idx | **PORT** (progress callback) / HOST sink |
| Cancellation | 3-level `checkCancelled` (PG×2, Redis) | **PORT** (`isCancelled()` throwing `SESSION_CANCELLED`) — already a callback into the orchestrator, the right shape |
| Orchestration | runner / parallel orchestrator / bootstrap | **HOST** — not a port; the orchestrator is the consumer of all ports above |
| Persistence of analysis results | Book Writer (`lazyBook`), `window_data` (PG JSONB) | **HOST-ONLY** — analyzers never persist books (C17 guard 2) |
| Coverage / duration heuristics | `source-coverage`, `estimateSpeechDurationSec` | **KEEP with analyzers** (pure, deterministic validators) |

---

## 9. Cycles & hidden dependencies — summary verdict

- Import cycles: **none** (guard test pins acyclicity of the 12-file contour graph).
- The dangerous couplings are not cycles but **shared mutable state and duplicated orchestration** (H1–H3, H9): they are the reason "improve one analyzer" currently risks touching `pipeline-runner.js`.
- Apparent independence that is not real: F2/F3 look independent but their **merge contracts live in the runner** (H1); F9–F13 look independent but share the inline projection/merge-back scaffolding (H2); all steps look independent but share PG step bookkeeping (H5) and require-time prompts (H8).

---

## 10. Recommended extraction order

Risk-ascending; each step preserves runtime behavior. "Extract" = physical move (file split or package) — **not** scheduled in C18.

| Stage | What | Why this order |
|---|---|---|
| 0 (keep in host) | F17 provider resolution, F19 sessions, F20 events, F21 cancellation, F24/F25 orchestration, windowing host half | These are the host capabilities the analyzers consume via ports; extracting them would invert the dependency and freeze infra prematurely |
| 1 (lowest risk) | **Freeze the `callAI` port shape + make provider injection explicit** in `ai-caller` (replace ALS read with explicit param defaulting to context) | One 86-LOC file, single seam, already delegated by `provider-gateway.agent`; unblocks every later stage (H4) |
| 2 (low risk) | **File split of `pipeline-steps.js`** into `analysis-steps.js` (F1–F7) and `visual-generation-steps.js` (F8–F14) + shared `visual-post-processing.js` composer for the runner's duplicated chain (H2) | Pure file moves with a barrel; kills the biggest historical co-location; no package boundary yet |
| 3 (needs contract first) | **Port-ify** session/log/progress/cancellation (`logStep`, `updateProgress`, `isCancelled`, `logConversation`) with current PG/Redis impls as defaults | C17 §14 step 2; precondition for moving any analyzer anywhere (H5) |
| 4 (needs contract first) | **Structure Analysis package-half**: split `structure-detector.js` AI-merge half from the deterministic half behind the frozen `StructureDetectorPort` (compatibility barrel keeps `setStructureDetector` working) | H7; golden tests exist; enables `@animastor/ai-analyzer` to own F1/F6 without owning parser |
| 5 | **Extract `@animastor/ai-analyzer`**: F1–F5 (+ source-coverage, text-utils, unit-splitter, snake-guard/character-identity re-exports, prompt port) with the C17 §12 DTOs | Analysis has clean inputs (text + registries), clean outputs (JSON DTOs), deterministic fallbacks pinned by tests; generation stays behind |
| 6 (last, or never) | **Generation passes** (F8–F13): keep as host-internal module behind the §6 contracts; package only if a second consumer (e.g. re-generation service) appears | Generation contracts are entangled with the visual-unit DTO consumed by GPU workflows (H9); premature packaging would freeze a UI-coupled shape |
| never | `parallel-analysis-orchestrator` as a generic engine, `agent-session`, `bootstrap/windowing`, prompt assets as their own npm package, `ai-service` as a provider package | Orchestrator is deliberately non-generic (its own header says so); the rest are host infra whose API would be frozen by accident |

For every stage: run `npm run test:arch` + agent suite (`pipeline-runner-parallel`, `bootstrap-cancel-continue`, `scene-cache`, `scene-split`, `unit-splitter`, `structure-detector`, `source-coverage`) + import smoke.

---

## 11. What NOT to extract (yet)

1. **Generation passes as npm package** — visual-unit DTO is consumed GPU-side (`video-workflows`, `prompt-builder`); freeze contract, keep host-internal (H9, stage 6).
2. **`parallel-analysis-orchestrator` generalization** — explicitly a proving ground, not a DAG framework; adding task types by editing `ANALYZERS` is the design.
3. **`ai-caller`/`ai-service` as a "provider" package** — single consumer class, seam already exists; a package would freeze one transport abstraction prematurely (C17 §7 verdict stands).
4. **`agent-session` / cancellation / SSE** — host capabilities; making them packages inverts ownership.
5. **`bootstrap.js` split** — its Importer/analyzer-host duality is documented (C17 §10); splitting it is a host refactor, not a boundary win.
6. **`structure-detector.js` physical split before the port freeze** — the parser binding (`setStructureDetector`) must keep receiving the whole object; split only behind a compatibility barrel.
7. **Prompts (`ai/rules`, `ai/skills`) into packages** — they are analyzer *data*; ship with the analyzer package later, behind `getPrompt`, not as a standalone asset package.

---

## 12. Open questions / blockers

1. **ALS provider context (H4)** — blocker for stage 1; mechanical, must land before any analyzer moves.
2. **Ports for PG step/session/log (H5)** — blocker for stage 3; C17 §14 step 2 defines the shape.
3. **Merge-logic ownership (H1)** — decision needed: do character/location merges belong to the analyzers' output contract (pure `merge(existing, extracted)`) or stay runner-owned? Recommended: pure merge functions owned by the analyzer module, called by the runner.
4. **F7 voice step placement** — analysis pipeline vs audio domain; affects whether `@animastor/ai-analyzer` includes it. Recommended: leave in the window pipeline, exclude from the analyzer package contract until the audio domain defines its authoring contract.
5. **`normalizeCharacterRefs` residence (H10)** — `image/image-service` exports a deterministic util the AI contour depends on; move to a shared util (or `@animastor/vbook-runtime`) before the analyzer package edge is clean.
6. **Duplicated post-pass composer (H2)** — must be unified *inside the host* before any generation pass moves; otherwise behavior drift between the two paths becomes likely.
7. **`refineDraft` legacy path** (`ai-service.js:263-504`, used by old import flow) — contains its own full analysis prompt + validation, parallel to the agent pipeline. Out of C18 scope; decide deprecate-or-port before packaging the analyzer.
8. **`window_data.structure` round-trip** — structure DTO persists through PG JSONB between windows; DTO evolution must stay additive (C13 rule).

---

## 13. Readiness criterion — "improve X without touching the rest"

After reading this document a developer can answer, e.g.:

> **"I need to improve only Character Analysis (F2)."**
> Change: `stepExtractCharacters` (after stage-2 split: `analysis-steps.js`), its prompt `ai/rules/characters.md`, and the merge (`utils/character-identity.mergeCharacterLists` + runner merge block, or the pure merge once stage-3 decision #3 lands). Register in `parallel-analysis-orchestrator.ANALYZERS` only if task shape changes.
> Do NOT touch: Book Writer (`lazyBook`), `agent/bootstrap.js` window/offset logic, `ai-service`/provider resolution, other step functions, GPU workflows, routes.

Analogously: **Scene Analysis** → `stepCreateScenes` + `scenes.md` + coverage loop + `text-utils.buildFallbackScenes`; **Structure** → `structure-detector` + `structure.md` + `stepAnalyzeStructure`; **Location** → `stepExtractLocations` + `locations.md` + env sanitize; **Unit Analysis** → `stepCreateUnits` + `unit-splitter` + `units.md`/`unit_splitter.md`; **Generation** → the visual-generation module + `visuals.md`/`passport_reconciliation.md`/`video_action_*.md`/`storyboard_polish.md`/`fantasy_snake_repair.md` + the post-pass composer — never the analysis steps, Book Writer, or provider infra.

---

## Verdict

**READY FOR STAGED DECOMPOSITION.** The contour is already a DAG with one LLM seam and pure deterministic validators; no cyclic imports exist. What stands between today's shape and independent functional modules is exactly three things: (1) ambient provider context, (2) PG persistence embedded in steps, (3) the analysis/generation co-location inside one file and one orchestration loop with duplicated post-pass chains. All three have concrete, low-risk remediations sequenced in §10 — none of them is a package decision. The contracts in §6 are frozen as-is so each future stage can proceed independently.
