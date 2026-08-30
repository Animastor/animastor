# Scene Pipeline Architecture

## Core Principle

**AI does the literary work. Code does the technical work.**

```
┌─────────────────────────────────────────────────────────┐
│                      LLM (AI Agent)                      │
│                                                         │
│  Task: "Read the text and split into natural             │
│         narrative episodes (scenes)"                     │
│                                                         │
│  DOES NOT KNOW about: limits, windows, cache,           │
│  number of scenes                                        │
└──────────────────────┬──────────────────────────────────┘
                       │ returns N scenes
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   Pipeline (code)                        │
│                                                         │
│  1. Takes first K scenes (chunk_size from settings)      │
│  2. Sends them for units + visuals                       │
│  3. Rest (N − K) → cached_scenes in DB                  │
│  4. Next step: if cached_scenes exist →                  │
│     processes them without AI call                       │
│  5. When cache empty → new AI call with next             │
│     text segment                                        │
└─────────────────────────────────────────────────────────┘
```

## Responsibility Split

### LLM (agent) — literary task only

- Reads a fragment of source text (typically ~5500 characters)
- Splits into **natural narrative episodes**
- Scene criteria: one location, one time, one set of participants, one coherent episode
- **Has no constraints** on number of scenes
- Doesn't know about chunk_size, cache, windows, video chunks — nothing

### Pipeline (code) — data management

| Step | What happens |
|------|-------------|
| **Scene creation** | AI call → get N scenes |
| **Capping** | Take first `chunkSize` (typically 2) for immediate processing |
| **Caching** | Remaining N−k scenes → `window_data.cached_scenes` in PostgreSQL |
| **Processing** | For each scene: title/location.id/environment-override (at creation step) → units → split long units → visuals → reconciliation |
| **Cache drain** | Next step: if `cached_scenes` exist, process them without AI |
| **Next window** | When cache empty and text remains → new AI call |

## Data Flow

```
Window 1:
  Source text (5500 chars)
       │
       ▼
  AI → 5 natural scenes
       │
       ├── [scene 1, scene 2] → units → visuals → save to book
       │
       └── [scene 3, scene 4, scene 5] → cached_scenes in DB

Window 2:
  cached_scenes = [scene 3, scene 4, scene 5]
       │
       ├── [scene 3, scene 4] → units → visuals → save to book
       │
       └── [scene 5] → cached_scenes in DB

Window 3:
  cached_scenes = [scene 5]
       │
       └── [scene 5] → units → visuals → save to book

Window 4:
  cached_scenes = []
  remaining_text = text remains
       │
       ▼
  AI → next text segment → ...
```

## Token savings

Without cache: each window = 1 AI call for scenes.
With cache: 1 AI call generates multiple processing windows.

```
Example: book 30,000 characters, chunk_size=2, AI makes ~5 scenes/window

Without cache:  5 windows × 1 AI = 5 AI calls
With cache:     2 AI calls + 3 processCachedScenes (0 AI)
Savings:        ~60% AI calls
```

## Key files

| File | Role |
|------|------|
| `ai/rules/scenes.md` | AI prompt — purely literary, no limits |
| `services/agent/pipeline-steps.js` | `stepCreateScenes()` — calls AI |
| `services/agent/pipeline-runner.js` | `runPipeline()` — orchestrator, `processCachedScenes()` — cache |
| `services/agent/bootstrap.js` | `bootstrapWithAgent()` and `bootstrapNextWindow()` — window management |
| `services/agent-prompts.js` | `MAX_SCENES_PER_CHUNK`, `CHARS_PER_SCENE`, `MAX_WINDOW_CHARS` |

## cached_scenes structure in DB

Stored in `agent_sessions.window_data` as JSON field `cached_scenes`:

```json
{
  "window_index": 0,
  "cached_scenes": [
    {
      "title": "Берлиоз's Strange Vision",
      "text": "And then the scorching air thickened before him...",
      "type": "narration",
      "characters_present": ["mikhail_berlioz"],
      "location": { "id": "patriarch_ponds" }
    }
  ],
  "created_scenes": 2,
  "remaining_text": "...",
  "currentOffset": 5500
}
```

## Technical constants (don't affect AI)

These constants define the text window size for the LLM and the number of scenes
processed per pass. They **do not affect** how AI splits scenes.
Scene size is determined by the agent based on literary logic, not
a fixed number of characters.

| Constant | Value | Purpose |
|-----------|----------|-------|
| `MAX_SCENES_PER_CHUNK` | 2 | How many ready scenes are simultaneously sent for further processing |
| `CHARS_PER_SCENE` | 2700 | Technical multiplier for calculating `MAX_WINDOW_CHARS` |
| `MAX_WINDOW_CHARS` | 5500 | Text window size passed to LLM per call |
| scene limit | none | AI creates as many scenes as naturally flow from the text |

## Changelog

- **2026-07-29**: Removed last artificial limit from AI prompt. AI doesn't know about `%MAX_SCENES%`. Added `processCachedScenes()` for processing cached scenes without AI call. `cached_scenes` stored in `window_data` PostgreSQL.
