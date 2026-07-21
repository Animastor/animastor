# LTX 2.3 Prompting Skill

> When LTX Image-to-Video is used, assume the reference image is the first frame.
> Do not waste tokens re-describing visible appearance. Concentrate on temporal
> evolution: actions, camera movement, environmental motion, and audio.

## Core Principle

With a reference image, the image already defines:
- character appearance
- clothing
- facial features
- environment
- composition
- colors
- lighting

Therefore the prompt should primarily describe:
- motion
- actions
- camera movement
- environmental animation
- audio (if used)

Do NOT repeat obvious visual details already visible in the reference image
unless they must change.

## General Structure

Write one continuous paragraph.

Recommended order:
1. Subject motion
2. Secondary motion
3. Camera movement
4. Environment motion
5. Lighting changes (optional)
6. Audio (optional)

## Template

The subject...
The subject begins to...
The camera...
The environment...
Ambient movement...
Audio...

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

Avoid: becomes alive, dynamic, cinematic feeling, emotional, dramatic atmosphere

Motion should always be explicit.

## Environment Motion

Good additions: leaves sway, grass moves, rain falls, snow drifts, dust rises,
smoke curls upward, waves roll, clouds drift, curtains move, particles float.

## Image-to-Video Rules

Reference image defines identity. Describe only:
- what changes
- who moves
- how they move
- camera movement

Avoid re-describing: face, clothes, hairstyle, composition, colors, background
unless those should change.

## What Works Well

✓ Specific actions
✓ Clear camera movement
✓ Physical movement
✓ Environmental animation
✓ Present tense
✓ One flowing paragraph

## What to Avoid

✗ Long lists of adjectives
✗ Internal emotions — describe visible behavior instead
✗ Static photo descriptions
✗ Contradictory lighting
✗ Too many independent actions
✗ Too many characters moving simultaneously

## Mental Model

Reference Image = Appearance
Prompt = Motion

Image defines WHAT EXISTS.
Prompt defines WHAT HAPPENS NEXT.
