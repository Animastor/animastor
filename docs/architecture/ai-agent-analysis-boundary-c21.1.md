# C21.2 — AI Agent Core: Generic Execution Lifecycle

**Status:** IMPLEMENTED. The generic `execute()` lifecycle replaces per-task lifecycle boilerplate. All analysis tasks delegate to the core lifecycle; C19/C20 backend modules also use it (except voices, which has a pre-check skip pattern).
**Date:** 2026-09-08
**Baseline:** C21.1 (package separation)
**Predecessors:** C18 (functional decomposition), C19 (structure-analyzer), C20 (character-analyzer), C21 (contour extraction), C21.1 (package separation)

---

## 1. What changed (C21.1 → C21.2)

C21.1 established the two-package structure but left each analysis task defining its own lifecycle boilerplate (port validation, progress, step creation, AI call, logging, error handling). C21.2 extracts that into a single generic `execute()` function in `@animastor/ai-agent`.

### Before (each task duplicated the lifecycle):
```javascript
async function extractLocations(input, ports) {
    const _ports = ports || {};
    const REQUIRED_PORTS = [...];
    const missing = REQUIRED_PORTS.filter(p => !_ports[p]);
    if (missing.length) throw new Error(...);
    const { callAI, logConversation, ... } = _ports;
    _progress({ stage: 'extracting_locs', message: extractingLocationsMessage });
    await updateSession(sessionId, { progress_msg: ... });
    const step = await createStep(sessionId, 'analyze_locations', stepIndex || 0);
    const messages = [...];
    try {
        const result = await callAI(messages, { maxTokens: 4096 });
        const locations = result.locations || [];
        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, result);
        return locations;
    } catch (err) {
        await failStep(step.step_id, err.message);
        throw err;
    }
}
```

### After (task defines only what's unique):
```javascript
const locationsTask = {
    requiredPorts: [...],
    taskName: 'ai-agent/locations',
    stage: 'extracting_locs',
    progressMessage: (ports) => ports.extractingLocationsMessage,
    stepType: 'analyze_locations',
    buildMessages(input, ports) { return { messages: [...], options: { maxTokens: 4096 } }; },
    normalize(result) { return result.locations || []; },
};

async function extractLocations(input, ports) {
    return execute(locationsTask, input, ports);
}
```

## 2. The execute() lifecycle

```
assertHostPorts → progress → updateSession → createStep → buildMessages
  → callAI → normalize → logConversation → completeStep → return

  on error: failStep → onError (or rethrow)
```

### Task definition contract:

| Field | Required | Description |
|---|---|---|
| `requiredPorts` | yes | Port names this task needs |
| `taskName` | yes | e.g. `'ai-agent/locations'` |
| `stage` | yes | Progress stage key |
| `progressMessage` | yes | `(ports) => string` — resolve progress text from ports |
| `stepType` | yes | PG step type, e.g. `'analyze_locations'` |
| `buildMessages` | yes | `(input, ports) => { messages, options? }` — build AI request |
| `normalize` | no | `(result, input, ports) => any` — post-process raw AI result |
| `failMessage` | no | `(err) => string` — custom failStep message (default: `err.message`) |
| `onError` | no | `(err, step, ports) => any` — custom degradation (default: rethrow) |

## 3. What's in Core vs. Semantic

### @animastor/ai-agent (Core)
- `execute()` — generic lifecycle
- `assertHostPorts()` — fail-closed port validation
- Zero dependencies, zero domain knowledge

### @animastor/ai-analysis (Semantic Layer)
- All analysis task definitions (locations, scenes, units, structure, characters, voices)
- C19/C20 analyzer modules
- Prompt assembly, normalization, context builders

## 4. Task adoption status

| Task | Uses execute() | Notes |
|---|---|---|
| locations | ✅ | Default throw degradation |
| scenes | ✅ | Custom error message in normalize |
| units | ✅ | Custom onError + failMessage for fallback |
| structure-analyzer | ✅ | Custom onError with deterministic fallback |
| character-analyzer | ✅ | Default throw degradation |
| voices | ❌ | Pre-check skip (no viable chars → return before step creation) |

**voices** is intentionally excluded: it has a pre-AI-call skip check (no viable characters → return `{ voices: {} }` before creating a step). This doesn't fit the execute() lifecycle which always creates a step first.

## 5. Architecture guards (updated)

The guard test enforces:
- All contour tasks import and call `execute()` from `@animastor/ai-agent`
- Core contains only `index.js`, `ports.js`, and `execute.js`
- No domain-specific functions exported from core
- Degradation semantics preserved (throw vs. fallback)

## 6. Evolution path

**Add a new analysis task:** Define a task object, call `execute()`. The lifecycle is handled.

**Custom degradation:** Set `onError(err, step, ports)` to return a fallback value. Set `failMessage(err)` to customize the failStep message.

**Pre-check skip pattern:** If your task needs to skip before step creation (like voices), keep it as a standalone function with manual lifecycle.
