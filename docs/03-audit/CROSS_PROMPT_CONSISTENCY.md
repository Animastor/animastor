# Cross-Prompt Consistency: image.prompt ↔ video.action

## Problem (benchmark case)

In book `import_1786254623004_1786254631346`, scene `sc-027e9c81`, unit `iu-a373c502` (first line of *The Master and Margarita*: *"…two citizens appeared"*):

- `image.prompt`: **"Two citizens** under a blistering sunset at Patriarshie Ponds: one center-left in a summer suit, one center-right in a checkered cap…"
- `video.action`: **"Slow horizontal pan from left (mikhail_berlioz entering with hat) to right (ivan_ponyrev approaching from opposite side), heat shimmer intensifying…"**
- `scene.participants`: `[mikhail_berlioz, ivan_ponyrev, kiosk_saleswoman]`

The same unit produces a benchmark pair: in `video.action` the agent used correct snake-ids, but in `image.prompt` replaced the characters with generic "two citizens". Meanwhile passports in the image pipeline are substituted by id — meaning the frame would show **two anonymous men**, while the following motion scene shows **specific Berlioz and Bezdomny**. Identity inconsistency within a single unit.

## Why This Happened

1. **Both fields are written by a single call** to `stepCreateVisuals` (visuals.md). The agent applied different standards to the two fields: for the static frame, it copied the source text's anonymity ("two citizens" — the narrator intentionally doesn't name them), while for motion, it tied movement to ids (the video model maps storyboard strings to identity anchors by id). Stylistic emulation of source text beat the hard rule "no generic nouns when IDs available" from visuals.md.
2. **Existing checks don't catch this class:**
   - `stepReconcileVideoActions` skips the action (it's agent-authored, differs from prompt — `keptAuthored`); and it only fixes action, not prompt.
   - `anchorGroupRefs` (deterministic fix at render time, video-workflows.js) works **only in `video.action`** and only when it contains **no ids at all**. Here ids are present in action → no fix needed. And `image.prompt` is not fixed by anyone.
   - Audit: the GROUP_NOUNS list didn't contain "two citizens", and check #2 only fires when ids are absent from both fields (`!hasCharId`).

## Rule — ASYMMETRIC

`video.action` and `image.prompt` serve different functions, so the check is not symmetric:

**Hard rule: `video IDs ⊆ image IDs`** — every character that specifically participates in `video.action` via a valid snake-id **must** be specifically identified in `image.prompt`. "Two citizens" when `berlioz_id + bezdomny_id` are in action — an `image.prompt` specificity error, fixed during polish.

**Reverse is NOT an error**: `image.prompt` shows Berlioz and Bezdomny, but `video.action` only names Berlioz — that's fine. In video, only one character may actively move; the other is in passive state/background (the model automatically animates it slightly). Requiring `image IDs ⊆ video IDs` is not allowed.

The reverse direction is left only as a **soft heuristic** (diagnostics, never an error). One more constraint: only **valid snake-ids from `characters.json`** are checked — a random chimera cannot serve as grounds for fixing another prompt.

## Mechanism (hybrid: deterministic detection + LLM at polish)

The new single source of truth — **`src/utils/snake-guard.js`**:

- `findKnownIdsInText(text, candidateIds)` — which of the candidates are present in the text (word-boundary, possessive handled).
- `findGenericPersonTerms(text, knownIds)` — generic designations: group/undefined nouns (`two citizens`, `the two men`, `a man`, `people`, `both characters`…) **always**; pronouns (`he/his/they/them`) — **only when no id is present in the field** (after an id, pronouns are natural: "ivan_ponyrev raises his hand" — not anonymization).
- `findCrossPromptGaps(unit, participants, knownIds)` — for each unit:
  - `idsInPrompt` / `idsInAction` — only among **scene.participants ∩ registry** (valid ids from characters.json; chimeric ids are not counted and don't trigger the check);
  - **HARD** (`direction: 'prompt'`) — **pure subset**: action names a participant by id, prompt doesn't → specificity error in prompt. Generic term NOT required — the mere absence of id is already an error (then `generic_terms` is empty, hint simply lists the missing ids);
  - **SOFT** (`direction: 'action'`, `severity: 'soft'`): prompt names a participant, action doesn't — not an error, diagnostics only (here generic term is mandatory so that pure subset differences don't noise).

**Conservatism (by design):**
- Only the HARD direction acts: the action side is never forced to name all characters from the prompt.
- Background/extras never trigger: the trigger requires that the **other field** names the participant by id, and extras don't have ids.
- A subset without a generic term ("ivan_ponyrev leans forward" when two characters are in frame) — not flagged.
- A participant named by id outside the scene (fantasy) is handled by a different mechanism (`stepRepairFantasyIds`), not here.

## Where It Runs

1. **`pipeline-steps.js` → `stepPolishStoryboard`** (only fixes `image.prompt`): if `video.action` names participants but `image.prompt` uses generic → a "Cross-prompt consistency — image.prompt must use character_ids" block is added to the user message with a list of units (`missing_ids`, `generic_terms`). The agent rebuilds only the under-specified prompt, preserving composition and meaning.
2. **`stepPolishVideoActions`** — intentionally WITHOUT cross-prompt hints: the reverse direction is not an error. Rule 5c in video polish explicitly states that action may animate a subset of the frame and is NOT required to name all ids from `image.prompt`.
3. **Post-merge validation** (HARD direction only): for each flagged unit, it's verified that `missing_ids` are **now present** in the polished prompt (the agent received exact ids — their absence means the fix didn't stick, even if the generic term disappeared). Unresolved units are marked `unresolved` and logged (they end up in the book but are visible in the audit). No rollback: the field may have received other legitimate fixes, and the fact is visible through the audit.
4. **Only in-range units** are included in hints — out-of-format fields (`> IMAGE_PROMPT_MAX_CHARS`) are not taken to polish and not returned in merge, so flagging them would only create noise.
5. **Rule** `storyboard_polish.md` (section 6) describes how to handle hint blocks; `video_action_polish.md` (5c) — about subset in action being normal.
6. **Audit** `audit-video-actions.js` — check #5 `CROSS-PROMPT`: **HARD → WARN** (prompt doesn't specify ids from action), **SOFT → INFO** (not an error, diagnostics). Shared `GROUP_NOUNS` list from `snake-guard` (single source of truth with the pipeline). Note: audit check #2 (generic in action without id in either field) now uses the **shared expanded list** (~60 terms vs previous 9) — on old books this produces more WARNs (these are real violations, but the audit behavior is expanded).
7. `pipeline-runner.js` — flat unit projections now carry `scene.participants` (otherwise polish steps wouldn't know the scene composition).

## Known Limitations

- If both fields are anonymous (no ids in either) — the HARD check is silent (no anchor in action); this is audit zone #2/#4 (generic in action without id) and rules.
- Candidates are **scene.participants ∩ registry** only. This is intentionally narrower than "all ids from characters.json": a character mentioned in action but not a scene participant (e.g., a voice from the next room) does NOT force the prompt to show them in frame.
- The fix is a **hint to the agent on an existing polish step**, not a separate hard barrier: if the agent fails to fix it twice, the unit remains in the book with a WARN in the audit (pipeline is not blocked).
- The generic term list is English (prompts per rules are written in en); for other field languages, extend the list in `GROUP_NOUNS`.
