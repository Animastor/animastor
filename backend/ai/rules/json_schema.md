# JSON Schema Reference

## Book Root
```json
{
  "manifest": { "version": "1.0", "created_at": "...", "updated_at": "..." },
  "metadata": { "title": "...", "author": "...", "description": "..." },
  "characters": [ Character ],
  "locations": [ Location ],
  "chapters": [ Chapter ],
  "scenes": [ Scene ],
  "objects": [ Object ]
}
```

## Character
```json
{
  "id": "string (snake_case)",
  "name": "string",
  "role": "protagonist | antagonist | supporting | minor",
  "description": "string",
  "traits": ["string"],
  "voice": "string (optional)",
  "appearance": "string (optional)"
}
```

## Location
```json
{
  "id": "string (snake_case)",
  "name": "string",
  "type": "indoor | outdoor | abstract",
  "description": "string",
  "mood": "string (optional)",
  "time_of_day": "string (optional)"
}
```

## Scene
```json
{
  "id": "string (snake_case)",
  "chapter_id": "string",
  "title": "string",
  "mood": "string (optional)",
  "pacing": "slow | medium | fast",
  "units": [ Unit ],
  "storyboard_elements": [ StoryboardElement ],
  "characters_present": ["character_id"]
}
```

## Unit
```json
{
  "id": "string (snake_case)",
  "unit_index": "integer >= 0",
  "text": "string",
  "duration_ms": "integer > 0",
  "speaker": "character_id (optional)",
  "emotion": "string (optional)"
}
```

## Chapter
```json
{
  "id": "string (snake_case)",
  "title": "string",
  "chapter_index": "integer >= 0",
  "description": "string (optional)"
}
```

## StoryboardElement
```json
{
  "unit_id": "string",
  "camera_angle": "wide | medium | closeup | birds_eye | low_angle | dutch",
  "composition": "string (description)",
  "lighting": "string (description)",
  "background": "string (description)",
  "transition": "cut | fade | dissolve | wipe"
}
```
