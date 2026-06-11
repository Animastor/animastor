# Validation Rules

## Severity Levels
- **error**: Must fix — breaks the book structure.
- **warning**: Should fix — may cause issues.
- **info**: Suggestion — optional improvement.

## Structural Checks
- All referenced `character_id` values must exist in `characters[]`.
- All referenced `location_id` values must exist in `locations[]`.
- All `scene_id` values must be unique.
- Scene `chapter_id` must reference a valid chapter.
- Unit `unit_index` values must be sequential starting from 0.

## Content Checks
- No empty `text` fields in units.
- `duration_ms` must be > 0.
- Each scene must have at least one unit.
- Each chapter must have at least one scene.

## Integrity Checks
- No dangling references to deleted entities.
- No duplicate names within the same entity type.
- Scene order within a chapter must be consistent.
