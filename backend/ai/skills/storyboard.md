# Storyboard

## Storyboard Element Structure
Each storyboard element describes one unit's visual composition:
```json
{
  "unit_id": "unit_01",
  "camera_angle": "medium",
  "composition": "Character stands at left third, sunset behind",
  "lighting": "Warm backlight with cool ambient fill",
  "background": "Mountain ridge at dusk",
  "transition": "cut"
}
```

## Storyboard Flow Rules
- Avoid two consecutive close-ups without a wider establishing shot.
- Vary camera angles to maintain visual interest.
- Use transitions intentionally:
  - `cut`: standard, invisible, for pace.
  - `fade`: passage of time, scene change.
  - `dissolve`: connection between related scenes.
  - `wipe`: energetic transition, genre-specific.

## Scene Coverage
- Each unit should have its own storyboard element.
- For dialogue: use shot-reverse-shot with medium/close-up alternation.
- For action: use wider shots with more movement.
- For emotional moments: prefer close-ups with soft lighting.

## Composition Notes
- Describe what is in the frame, not just the subject.
- Include background, foreground elements, and color palette.
- Reference the mood established in the scene metadata.
