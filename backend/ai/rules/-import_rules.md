# Import Mode Rules

## Core Objective
Convert arbitrary user-provided text into a valid Animastor book JSON structure. The user must NOT manually annotate the text with "Chapter", "Scene", or "Unit" markers — determine the structure from content analysis.

## Structure Detection
- Detect chapter boundaries from: chapter titles, scene breaks (---, ***, blank lines), narrative shifts, time jumps, location changes, POV changes.
- Detect scene boundaries within chapters from: location changes, character entrances/exits, time passages, paragraph breaks with narrative shifts.
- Detect units (atomic narrative beats) within scenes from: individual actions, dialogue exchanges, description blocks, camera-worthy moments.

## If No Book Is Open
Create a complete new book structure:
1. Generate a `manifest` with a descriptive `book_id` (snake_case from content) and `title`
2. Create `metadata` with `title`, `author` (if detectable), `language` ("ru" or "en"), `description`
3. Create a `chapters` array with auto-detected chapters
4. Each chapter has `scenes` array with auto-detected scenes
5. Each scene has `units` array with auto-detected units
6. Each unit has `text` field with the actual content
7. Try to extract characters, locations, and add them to `characters` and `locations` arrays

## Cover (standard chapter)
The book cover is now a **standard chapter** (`chapters/ch-XXXXXXXX.json`), NOT a standalone file.
It is stored as `chapters[0]` with `chapter_title: "Обложка"` and `type: "cover"`.

When creating a new book:
1. If the book has a clear title and author, create a Cover chapter with:
   - `chapter` (ch-XXXXXXXX), `chapter_title: "Обложка"`, `type: "cover"`
   - One scene inside with `type: "cover"`
   - `audio.full_text`: author and title (e.g. `"Author Name\n\nBook Title"`)
   - A single `typography` unit with `visual.text_render: true` and a prompt describing the book cover design
2. The Cover chapter is placed first in `chapters_order` in `book.json`
3. See `cover_example.json` in the examples directory for the exact format
4. See the real Cover chapter in `master_margarita_demo/chapters/ch-2a7fee78.json`

## If a Book Is Already Open
- **New chapter detected**: Create a new chapter at the end of the book's chapters array. Inside it, create scenes and units from the text.
- **Current chapter continuation**: Add new scenes and units to the end of the current chapter's scenes array.
- **Current scene extension**: Add new units to the end of the current scene's units array.

## Output Format
Always call the `import_book` tool with the complete result structure. The result must be a valid Animastor book JSON that can be saved directly.

## Quality Guidelines
- Every unit must have non-empty `text` content
- Scene-level elements (storyboard, characters_present) are optional
- IDs must be snake_case (e.g., `the_dark_forest`)
- Titles should be human-readable
- If the text is very short (one paragraph), still create a valid structure with one chapter, one scene, and one unit
