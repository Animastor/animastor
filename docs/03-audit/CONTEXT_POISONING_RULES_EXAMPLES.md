# Context Poisoning: Concrete IDs from Rules/Demo Book Examples

Date: 2026-08-09
Status: **Option 1 applied** (examples anonymized); **Option 3 applied**
(hybrid: deterministic detection + LLM rebuild); Option 2 — optional.

## Symptom

During generation of book `royallib_com_1786206633026` (a Russian-language book),
a fabricated id **`zhenshchina_v_budochke`** appeared in
`video.action` — this character does NOT exist in the book's `characters.json`
(only mikhail_berlioz, ivan_ponyrev, prozrachnyy are present). The id itself means
"woman in a kiosk" — an episode character from **"The Master and Margarita"**
by Bulgakov, the very book being generated.

Consequences:
- Video prompt references an id without a passport (`character_id: tokens` in the
  characters section is absent) → character motion mapping breaks.
- Speaker line "zhenshchina_v_budochke speaking with lip movement" — raw
  Russian alias that resolves to nothing.
- In other runs the agent "invented" a passport and voice for her — because the same
  id appears in the character extraction step examples.

## Poisoning Mechanism

The agent copies examples from its context rather than following a closed ID list.
All examples in rules and demo data were hardcoded with IDs from *The Master and Margarita*
— **the very book the user is generating**. When the agent encounters
"kiosk saleswoman" in text, it recalls the "correct" ID from the example and
inserts it, even if it's absent from the Scene Context.

Three independent injection vectors:

| Vector | Where | What the agent sees |
|---|---|---|
| Vector | Where | What the agent sees |
|---|---|---|
| Rules (`ai/rules/*.md`) | Injected into all pipeline steps | `mikhail_berlioz`, `ivan_ponyrev`, `zhenshchina_v_budochke`, "Patriarch's Ponds", "Berlioz", "Bezdomny", "MASSOLIT", "Give me Narzan" |
| Demo book `ai/examples/*.json` | `%EXAMPLES%` in visuals (`buildImageExemplars`) | scene with `berlioz, bezdomny` and ready-made image.prompt/video.action |
| Demo book `ai/examples/*.json` | `refineDraft` (bootstrap) + `formatExamplesForPrompt` | entire catalog, including "Patriarch's Ponds" chapter |
| Default prompts `ai/workflows/video-ltx-*.json` | fallback text of positivePrompt node | M&M storyboard (overwritten at assembly, but it's a landmine) |
| Inline examples in `ai-service.js` (refineDraft) | system prompt | "Berlioz and Bezdomny sat on a bench…", "berlioz:" |

The instability ("sometimes a passport, sometimes just an ID") is explained by the fact that
the ID appears in three independent steps — whichever step the agent hits first,
that's where the poisoning leaks through.

## Solutions

### Option 1 — Anonymize Examples (APPLIED)

Concrete IDs from *The Master and Margarita* replaced with a neutral fictional
demo book **"Evening in the City"** (M. Demin): `anna_smirnova`, `boris_volkov`,
`dmitry_orekhov`, location `city_park`. The same fictional pair is used in
rule examples.

| Before (M&M) | After (neutral) |
|---|---|
| `mikhail_berlioz` / `ivan_ponyrev` | `anna_smirnova` / `boris_volkov` |
| `zhenshchina_v_budochke` (woman in a kiosk) | `kiosk_saleswoman` (woman at the kiosk) |
| `patriarch_ponds` | `city_park` |
| "Berlioz" / "Bezdomny" / "Woland" | Anna / Boris / Dmitry |
| "MASSOLIT" | "magazine chapter" |
| "Give me Narzan" | "Give me water" |
| "transparent citizen" | "stranger in a light coat" |

Files affected: `ai/rules/{characters,visuals,units,scenes,locations,
video_action_polish,video_action_reconciliation,passport_reconciliation,
storyboard_polish}.md`, `ai/examples/*.json` (9 files),
`ai/workflows/video-ltx-{1p,2p,3p,4p}.json` (default prompts),
`src/services/agent/pipeline-steps.js` (injectable alias example),
`src/services/ai-service.js` (inline refineDraft examples).

**Limitation:** any specific id in examples can potentially leak —
including the neutral `kiosk_saleswoman`. Option 1 eliminates *known*
contamination (demo book matching the generated book) but does not close the
mechanism entirely.

### Option 2 — Explicit Warning in Rules (optional)

Add to the beginning of rules: "The examples below are FORMAT only. Their IDs do NOT belong
to your book. Use ONLY IDs from Scene Context / character list."
Minimal changes, but the model may ignore it.

### Option 3 — Hybrid Programmatic Guard (APPLIED)

Two-layer defense — detection is deterministic, recovery is LLM-based
(reverse transliteration doesn't work: the project is multilingual):

1. **Detection (`src/utils/snake-guard.js`, shared with audit script).**
   A snake_case token (`[A-Za-z]` + ≥1 underscore, no possessive `'s`) is
   a fabricated id if it is not among known ids (characters + locations)
   and not in the whitelist of technical/visual words (`close_up`, `park_bench`,
   `street_lamp`, etc.). Real id variants (prefixes) are not counted as fantasy.
2. **LLM repair (`stepRepairFantasyIds`, final visual step in both branches of
   pipeline-runner).** If a fantasy-id is found in `image.prompt` / `video.action`
   — the unit (with original text and known id list) is sent to the agent, which
   rebuilds the prompt, restoring the natural designation from the book
   text (language-dependent, not transliteration). The result is scanned again:
   a non-clean response is discarded, the original is kept.
3. **Write-time barrier (`book/lazy-book/create.js`):** `scene.participants`
   is filtered by known ids — a fantasy-id that survived LLM steps does not
   enter the book (known ids and natural designations are preserved).
4. **Speaker:** fantasy-id in `audio.speaker` also goes through scan/repair
   (rebuilt to natural designation); voice is not invented
   (`stepGenerateVoices` — only characters with described appearance), and for
   unknown speakers the audio pipeline silently uses the narrator's voice.

A preventive hint in `%CONTEXT%` visuals (listing episode participants to the agent
in advance) **was considered and rejected**: it duplicated the visuals.md rule
("unnamed person → describe as extra, do NOT invent id"), added tokens to every
visual call for a rare case, and did not cover the vector itself (fantasy-ids
were still silently discarded). The guarantee comes from the final repair step —
it deterministically catches everything that slipped through.

Cost: repair only triggers on flagged units (rare) — one small LLM call per window.
Tests: `tests/snake-guard.test.js`.

## Audit methodology ("he"/"the" fix)

A false positive on "he" inside "t**he** alley" — classic substring search error.
The audit script `backend/scripts/audit-video-actions.js` uses **word-boundary**
regexes (`\bhe\b`, `\bthe two men\b`), so "the alley" never triggers "he",
and "heat" — "she". See the script.

## Status

- [x] Option 1: examples anonymized (rules + ai/examples + workflow defaults + inline strings)
- [ ] Option 2: warning in rules
- [x] Option 3: hybrid — snake-guard detection + `stepRepairFantasyIds` (final visual step, both branches) + barrier participants/mentions/id in create.js (preventive hint rejected — see above)
- [x] Chimeras: `findCanonicalId` (Tier 1–3) + canonicalization in repair step / create.js / audit
- [x] Audit script: `backend/scripts/audit-video-actions.js` (now uses shared `snake-guard`)

## Chimeras: canonicalization to registry (hybrid layer 2)

Two-class policy:

1. **Episode character with full packaging — not a defect.** If the system
   packaged "the kiosk saleswoman" into a full entity (id, role, passport,
   voice) — this is acceptable and not treated.
2. **Chimera — a defect, always treated.** A snake-id that *looks like* an
   existing character but does not byte-match: half-Russian /
   half-English (`mikhail_berлиоз`), wrong transliteration
   (`ivan_ponerov` vs `ivan_ponyrev`, `y`/`iy`), trailing underscore
   (`mihail_bulgakov_`), 1–2 character typo, noise suffix
   (`anna_smirnova_extra`). To the system this is a different key — no passport behind it.

Protection (`findCanonicalId` in `src/utils/snake-guard.js`) — three tiers of
decreasing confidence, repair ALWAYS takes an existing id from
`characters.json`, no new variant is generated:

1. **Tier 1** — equality after normalization (Cyrillic transliteration via
   `CYR_LATIN_MAP`, lowercase, junk strip): `mikhail_berлиоз` →
   `mikhail_berlioz`, `mihail_bulgakov_` → `mihail_bulgakov`.
2. **Tier 2** — unique nearest by Levenshtein in conservative threshold
   (≤3, ≤15% of length, length ≥8): `mihail_bulgakoviy` → `mihail_bulgakov`,
   `ivan_ponerov` → `ivan_ponyrev`. Two equally close candidates → NOT confident
   → goes to LLM repair.
3. **Tier 3** — known id + noise suffix: `anna_smirnova_extra` →
   `anna_smirnova`.

Where canonicalization is applied (all through single `snake-guard`):

| Point | What it does |
|---|---|
| `stepRepairFantasyIds` | canonicalization BEFORE LLM flagging: chimeras fixed deterministically without calling LLM; only tokens without confident match go to LLM |
| `create.js` participants | chimera participant → canonical id (`onReplace`), true fantasy → drop (`onDrop`) |
| `create.js` mentions | alias target canonicalized or dropped — broken alias not written to book |
| `create.js` char/location id | mixed-script id normalized to pure Latin (`patriarshie_pруды` → `patriarshie_prudy`) |
| `audit-video-actions.js` | CHIMERA check + mixed-script id + mentions targets |

## Hybrid: why not transliteration

Reverse transliteration (`zhenshchina_v_budochke` → "woman in a kiosk")
only works for Cyrillic and "correct" transliteration. The project is multilingual
(ru/en/de/zh/ar/…), so restoring the original designation is delegated to
LLM: detection says "this is a fantasy-id" and the agent returns the
natural designation in the book's language ("the kiosk saleswoman") based on the
unit text. Determinism is only in the "repair or not" decision; meaning is
restored contextually.

## Known Limitations of Option 3

- **Partial fix is not rolled back but completed with deterministic fallback:**
  if the repair agent fixed one field of the unit but left a fantasy-id in another
  (or returned a dirty draft), `mergeRepairResults` preserves the LLM draft and
  programmatically bursts the remaining invented token into plain words
  (`kiosk_saleswoman` → "kiosk saleswoman") via `desnakeifyText` — fantasy-ids
  never enter the book. Revert to original remains only as a last resort
  (if even fallback could not clean the field). The `fallbackFixed` counter
  is visible in the step log. Real-world example: LLM could not remove `kiosk_saleswoman` from
  `video.action` of three units — old code reverted (fantasy-id remained in
  book, audit FAIL), new code outputs "kiosk saleswoman".
- **Fallback is words, not translation:** for Latin ids denakeification produces
  meaningful words ("kiosk saleswoman"); for transliterated ids
  ("zhenshchina_v_budochke") — raw transliteration, which the user explicitly
  rejects. Therefore fallback works ONLY as the last line of defense after LLM:
  the agent primarily restores the natural designation from the unit text.
- **Truncated variants of real ids** (`mikhail_berlio` when the real
  `mikhail_berlioz` exists) are treated as character variants, not fantasy — they
  are deliberately skipped and not repaired (conservative protection against
  false positives).
- **Out-of-format prompts** (> `IMAGE_PROMPT_MAX_CHARS`, legacy/user-created)
  are not scanned and not repaired — policy of "don't touch what the model
  has not seen in full".
- **Fuzzy merge (Tier 2) is disabled in registry paths** (`fuzzy: false` in
  create.js): two real different characters with similar ids
  (`sergey_ivanov` / `sergey_ivanova`) may be different people — in registry
  writes only normalized-equal (Tier 1) and suffix-based (Tier 3)
  variants are aligned; typos go to prompt repair. In prompts (repair step)
  fuzzy remains — there an error affects only frame text.
- **Migration of already-generated books:** old chapters may reference
  mixed-script location ids not in the canonicalized map — new
  windows write canonical ids; remnants caught by the audit script.

## Known Remnants (not injected — intentionally untouched)

- `backend/src/scripts/test-scene-split.cjs` — dev script with M&M fixtures; not
  called from package.json/tests (manual tool).
- Comments in `src/image/iu-processor.js`, `src/image/character-utils.js`,
  `src/audio/segments.js` — mention "Berlioz"/"Narzan" as illustration; do not
  enter prompts.
- `GENERIC_WORDS` in `src/image/helpers.js` / `src/utils/character-identity.js`
  contains `zhenshchina` — this is a guard list (exclusion of common words from aliases),
  do not touch it.
