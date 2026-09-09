# @animastor/ai-analysis

Semantic analysis layer for the Animastor book pipeline — structure, character, location, scene, unit analysis and voice authoring.

Uses `@animastor/ai-agent` for the execution mechanism; owns prompts, contracts, and domain-specific analysis logic.

## What this is

This package provides all AI analysis tasks:

| Task | Feature | Description |
|---|---|---|
| `analyzeBookStructure` | F1/F6 | Structure/chapter analysis with deterministic fallback |
| `extractCharacters` | F2 | Character extraction from text |
| `generateVoices` | F7 | Voice description authoring for characters |
| `extractLocations` | F3 | Location extraction from text |
| `createScenes` | F4 | Scene analysis and splitting |
| `createUnits` | F5 | Unit decomposition from scenes |

Plus shared utilities:
- `buildLocationsContext` — prompt-context builder for location data
- `assertHostPorts` — re-exported from `@animastor/ai-agent` for convenience

## Installation

```bash
npm install @animastor/ai-analysis
```

Requires Node.js >= 18. Depends on `@animastor/ai-agent` and `@animastor/vbook-runtime`.

## Usage

```js
const {
    analyzeBookStructure,
    extractCharacters,
    extractLocations,
    createScenes,
    createUnits,
    generateVoices,
} = require('@animastor/ai-analysis');

// All tasks follow the execute() lifecycle from @animastor/ai-agent.
// They require host-injected ports (callAI, session management, etc.)
const structure = await analyzeBookStructure(input, ports);
const characters = await extractCharacters(input, ports);
```

## Subpath exports

| Import path | Module |
|---|---|
| `@animastor/ai-analysis` | Main barrel (all tasks + utilities) |
| `@animastor/ai-analysis/context` | `buildLocationsContext` prompt-context builder |
| `@animastor/ai-analysis/tasks/structure-analyzer` | Structure analysis task + AI merge |
| `@animastor/ai-analysis/tasks/character-analyzer` | Character extraction + voice authoring |
| `@animastor/ai-analysis/tasks/structure-detector-deterministic` | Deterministic structure detector (fallback) |

## Dependency direction

```
@animastor/ai-agent          (pure mechanism)
        ↑
@animastor/ai-analysis       (semantic tasks)
        ↑
backend / host               (composition + persistence)
```

## License

MIT
