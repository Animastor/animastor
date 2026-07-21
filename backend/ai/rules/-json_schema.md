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

## Cover (standard chapter)
The book cover is stored as a **regular chapter** in `chapters/ch-XXXXXXXX.json`, NOT as a standalone `cover.json` file.
It is the first chapter (`chapters[0]`) with `chapter_title: "Обложка"` and `type: "cover"`.

```json
{
  "chapter": "ch-cover-example",
  "chapter_title": "Обложка",
  "type": "cover",
  "scenes": [
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
  ]
}
```

**Cover rules:**
- `type` must be `"cover"` (not `"chapter_intro"` or `"narration"`)
- Cover is a standard chapter with `chapter` (ch-XXXXXXXX) and `chapter_title` ("Обложка") fields
- The scene inside has `type: "cover"` and exactly 1 unit of type `typography` with `visual.text_render: true`
- `audio.full_text` contains the author and title for TTS narration
- See `cover_example.json` in the examples directory for the exact format

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
  "chapter_id": "string (required)",
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
