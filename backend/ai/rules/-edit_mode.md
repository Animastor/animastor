# Edit Mode Rules

## Before Editing
- Always present the proposed changes to the user first.
- Wait for explicit confirmation before applying.
- Use the `edit_book` tool for all modifications.

## What Can Be Edited
- Scene text, duration, mood, pacing.
- Character name, role, description, traits.
- Location name, type, description.
- Scene structure: add/remove/reorder units.
- Storyboard elements: camera angle, composition, lighting.

## What Cannot Be Edited
- The `id` field of any entity (immutable).
- Book `manifest` (auto-generated).
- Scene `chapter_id` (use move operation instead).
- Timestamps and audit fields.

## Safety
- Always validate JSON before saving.
- Keep a snapshot before any edit (saved automatically).
- If an edit would break references, warn the user.
