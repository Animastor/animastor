# Video Prompting Skill (default)

> Generic video prompting baseline, used when no model-specific video profile is
> selected. The assembly profile (ai/profiles/video/default.json) defines the
> final prompt structure programmatically; this skill governs how the agent
> WRITES `video.action`.

## Core Principle

`video.action` describes TEMPORAL / DYNAMIC change only — what moves or changes
while the frame plays. It is NOT a static composition: who is where and how the
frame is arranged belongs in `image.prompt`.

Therefore the action should describe:

- motion and gestures of characters
- actions (walking, turning, reaching, speaking)
- camera movement
- environmental animation (leaves, rain, smoke, waves)
- dialogue delivery (visible behavior, not internal emotion)

Do NOT repeat the static composition from `image.prompt`.

## Length and Structure

- SHORT: 3–15 words, one clause, present tense.
- One flowing sentence per unit — not a list of adjectives.

Recommended order within an action:

1. Subject motion
2. Secondary motion
3. Camera movement
4. Environment motion
5. Lighting changes (optional)

## Camera Vocabulary

Use cinematic language:

- slow push-in
- dolly forward / backward
- tracking shot
- handheld
- orbit camera
- pan left / right
- tilt up / down
- crane shot
- low angle / high angle
- close-up / medium shot / wide shot

## Motion Vocabulary

Prefer concrete verbs:

- walks, turns, looks, smiles, blinks
- reaches, sits down, stands up
- opens, closes, runs, raises, lowers
- rotates, leans, nods

Avoid: becomes alive, dynamic, cinematic feeling, emotional, dramatic atmosphere.

Motion should always be explicit.

## Environment Motion

Good additions: leaves sway, grass moves, rain falls, snow drifts, dust rises,
smoke curls upward, waves roll, clouds drift, curtains move, particles float.

## Align Motion with Time

Each unit has an approximate play time (`estimated_duration_sec`). Match the
motion to it: a short unit (~2–4s) suits one quick gesture or a small camera
move; a long unit (~10–20s) suits a fuller behavior with a pause or follow-up.

## What to Avoid

✗ Long lists of adjectives
✗ Internal emotions — describe visible behavior instead
✗ Static photo descriptions
✗ Contradictory lighting
✗ Too many independent actions
✗ Too many characters moving simultaneously
