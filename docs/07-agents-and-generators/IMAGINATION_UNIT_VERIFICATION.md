# Imagination Unit — verification checklist

Verification steps for the `feat/imagination-unit-doctrine` branch (commit `f660dc0`).
These confirm the self-contained Imagination Unit doctrine is correctly wired into the
visuals step. Run from the repo root: `/home/sureg/animastor`.

The full checklist was executed on 2026-07-03 and passed green (harness prints
`ALL CHECKS PASSED`, 12/12). Everything below is read-only or a local dry-run — no DB,
no LLM, no network, no writes.

---

## 0. Context

Files changed on the branch:

- `backend/src/services/agent-prompts.js` — `SYSTEM_PROMPTS.visuals` (the doctrine)
- `backend/src/services/agent-service.js` — `stepCreateVisuals` `%CONTEXT%` + `%EXAMPLES%`, `getFallbackVisual`, `buildVisualExemplars`
- `backend/ai/examples/ch-ce87fec4.json` — added `participants:["author"]`
- `backend/scripts/dryrun-visuals-iu.js` — verification harness (new)
- `docs/07-agents-and-generators/IMAGINATION_UNIT.md` — reference spec (new)

Make sure the branch is checked out:

```bash
git rev-parse --abbrev-ref HEAD    # expect: feat/imagination-unit-doctrine
git log --oneline -1               # expect: f660dc0 feat: enforce self-contained Imagination Unit doctrine...
```

---

## 1. Syntax check (must pass)

```bash
node -c backend/src/services/agent-prompts.js
node -c backend/src/services/agent-service.js
```

**Expect:** no output, exit code 0 for both. Any parse error is a blocker.

---

## 2. Dry-run harness (primary check — must print `ALL CHECKS PASSED`)

```bash
node backend/scripts/dryrun-visuals-iu.js
```

**Expect:** the assembled system prompt is printed, then three fallback lines, then an
`ASSERTIONS` block ending with `ALL CHECKS PASSED` (exit code 0). All 12 assertions must
read `PASS`:

1. `CONTEXT has location name` — `%CONTEXT%` contains `patriarch_ponds`
2. `CONTEXT has berlioz anchor` — `position: left, pose: sitting, orientation: right`
3. `CONTEXT has bezdomny anchor` — `position: right, pose: sitting, orientation: left`
4. `prompt bans generic nouns` — rules contain "generic collective nouns"
5. `prompt has guiding question` — contains "WHO exactly is in the frame"
6. `prompt has stable-extras rule` — contains "CONCRETE, REPEATABLE anchor"
7. `fallback is pronoun-free & named` — fallback === `Mikhail Berlioz and Ivan Bezdomny at patriarch_ponds, cinematic shot`
8. `few-shot exemplar block injected` — assembled prompt contains "Worked example"
9. `exemplar block is doctrine-clean` — no pronouns/generic nouns in the exemplars
10. `image-first philosophy present` — contains "Core philosophy" and "no participants"
11. `character-less unit guidance present` — contains "Character-less units"
12. `character rules scoped to when-people-present` — contains "apply ONLY when the unit actually contains people"

If any assertion says `FAIL`, note which number and the printed prompt — that pinpoints
the regression.

---

## 3. Eyeball the assembled prompt (manual, from step 2 output)

In the printed `ASSEMBLED SYSTEM PROMPT`, confirm the section order and content:

- [ ] **Core philosophy** section appears first, stating the unit is a visual image (may
      be landscape/object/dream/symbol), with the "HAS participants → name them / NO
      participants → do not invent" branch.
- [ ] **Character rules** heading reads "apply ONLY when the unit actually contains people".
- [ ] The WRONG/RIGHT examples are present (`two men are sitting on a bench` → `berlioz
      sitting on the left and bezdomny sitting on the right...`).
- [ ] The bench progression example (Unit A/B/C) is present.
- [ ] **Character-less units** section present with landscape/object/symbol examples.
- [ ] **Scene Context** shows `Location (name to use in prompts): patriarch_ponds` and
      both characters with their `[position: … pose: … orientation: …]` anchors.
- [ ] A **Worked example** block appears (few-shot), drawn from `ai/examples`, naming its
      participants and showing repeated base composition.

---

## 4. Examples are doctrine-clean (read-only grep)

No prompt in the example bank should contain a pronoun or generic collective noun for
participants:

```bash
grep -rniE '"prompt".*\b(they|them|two men|the writers|one person|people walking|crowd|pedestrians)\b' backend/ai/examples/*.json
```

**Expect:** no output (empty). Any hit is a doctrine violation in the reference data.

Confirm the `participants:["author"]` fix landed:

```bash
grep -c '"author"' backend/ai/examples/ch-ce87fec4.json    # expect: 6 (scene participants + audio.voice + 4 unit participant lists)
```

All example JSON files must still parse:

```bash
for f in backend/ai/examples/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "OK $f" || echo "BAD $f"; done
```

**Expect:** `OK` for every file, no `BAD`.

---

## 5. `%EXAMPLES%` placeholder is fully substituted (no leakage)

Confirm the placeholder is declared in the prompt and replaced at assembly:

```bash
grep -n '%EXAMPLES%' backend/src/services/agent-prompts.js     # expect: 1 hit (the placeholder in the template)
grep -n "replace('%EXAMPLES%'" backend/src/services/agent-service.js   # expect: 1 hit (the .replace call)
```

In the step-2 output, the assembled prompt must **not** contain the literal string
`%EXAMPLES%`, `%CONTEXT%`, or `%UNITS%` (all placeholders substituted).

---

## 6. (Optional) Character-less scene sanity

The harness scene has participants. To eyeball behaviour for a character-less unit, note
that the doctrine relies on the LLM honouring the "Character-less units" section — there
is no code path that strips participants. This is prompt-guided, not enforced in code, so
step 3's checklist item for the Character-less section is the relevant verification.

---

## Pass criteria (summary)

- [ ] Step 1: both `node -c` pass.
- [ ] Step 2: harness prints `ALL CHECKS PASSED` (12/12).
- [ ] Step 3: assembled prompt section order/content correct.
- [ ] Step 4: grep for pronouns/generic nouns in examples is empty; all example JSON parse.
- [ ] Step 5: no un-substituted `%...%` placeholders in the assembled prompt.

If all pass, the doctrine is correctly wired. Report back any `FAIL` line with its number
and the surrounding prompt text for a targeted fix.
