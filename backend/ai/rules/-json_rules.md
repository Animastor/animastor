# JSON Rules

## Structure
- Book JSON must follow the Animastor schema.
- Top-level keys: `manifest`, `metadata`, `characters`, `locations`, `chapters`, `scenes`, `objects`.
- Each scene belongs to exactly one chapter via `chapter_id`.
- Units within a scene are ordered by `unit_index`.

## Required Fields
- Each character: `id`, `name`, `role` (protagonist/antagonist/supporting/minor).
- Each scene: `id`, `chapter_id`, `title`, `units[]`.
- Each unit: `id`, `unit_index`, `text`, `duration_ms`.
- Each location: `id`, `name`, `type`.

## Naming
- `id` fields: snake_case, unique across the book.
- `scene_id` references must point to existing scenes.
- `character_id` references must point to existing characters.

## Types
- `duration_ms`: positive integer, milliseconds.
- `unit_index`: non-negative integer, sequential within scene.
- `role`: one of `protagonist`, `antagonist`, `supporting`, `minor`.
