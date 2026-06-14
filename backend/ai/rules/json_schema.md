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

## Cover (separate file)
The book cover is stored in a **separate** `cover.json` file at the book root directory, NOT inside any chapter.

```json
{
  "scene_id": "sc-cover-example",
  "scene_title": "Cover",
  "type": "cover",
  "style": "title_page",
  "participants": [],
  "audio": {
    "voice": "narrator",
    "full_text": "Author\n\nTitle"
  },
  "units": [
    {
      "id": "iu-cover-example",
      "type": "typography",
      "text": "Author\n\nTitle",
      "visual": {
        "prompt": "book cover design, vertical composition, elegant typography...",
        "quality": "highly detailed, sharp typography, clean composition",
        "text_render": true,
        "negative": ""
      }
    }
  ]
}
```

**Cover rules:**
- `type` must be `"cover"` (not `"chapter_intro"` or `"narration"`)
- Cover does NOT have a `chapter_id` — it is a standalone file, not a scene inside any chapter
- Cover always has exactly 1 unit of type `typography` with `visual.text_render: true`
- `audio.full_text` contains the author and title for TTS narration
- See `cover_example.json` in the examples directory

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
  "chapter_id": "string (required except for Cover — Cover has its own cover.json)",
  "title": "string",
  "mood": "string (optional)",
  "pacing": "slow | medium | fast",
  "units": [ Unit ],
  "storyboard_elements": [ StoryboardElement ],
  "characters_present": ["character_id"]
}
```

> **Note:** The Cover scene is an exception — it does NOT have a `chapter_id` because it lives in its own `cover.json` file, separate from all chapters.

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
