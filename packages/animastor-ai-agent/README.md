# @animastor/ai-agent

Generic AI execution engine — the shared mechanism for running any AI task through a standard lifecycle.

**Core mechanism only** — no domain knowledge, no persistence, no generation. The AI Analysis layer (`@animastor/ai-analysis`) owns the semantic analysis tasks.

## What this is

This package provides two primitives:

- **`assertHostPorts(ports, required, taskName)`** — fail-closed validation that required host-injected ports are present. A task refuses to run without its host ports instead of silently degrading.
- **`execute(task, input, ports)`** — a generic async lifecycle runner that takes a declarative task definition and runs it through a standard `buildMessages → callAI → normalize → log → complete` pipeline with shielded error handling.

## Installation

```bash
npm install @animastor/ai-agent
```

Requires Node.js >= 18.

## Usage

```js
const { execute, assertHostPorts } = require('@animastor/ai-agent');

// Define a task
const myTask = {
    requiredPorts: ['callAI', 'logConversation', 'updateSession', 'createStep', 'completeStep', 'failStep'],
    taskName: 'my-task',
    stage: 'running',
    progressMessage: (ports) => 'Running...',
    stepType: 'my_step',
    buildMessages: (input, ports) => ({
        messages: [{ role: 'user', content: input.text }],
        options: { maxTokens: 1024 },
    }),
    normalize: (result) => result,
};

// Run it with host-injected ports
const result = await execute(myTask, { sessionId: 's1', text: 'hello' }, ports);
```

## Task definition contract

| Field | Required | Description |
|---|---|---|
| `requiredPorts` | yes | Port names this task needs |
| `taskName` | yes | e.g. `'ai-agent/locations'` |
| `stage` | yes | Progress stage key |
| `progressMessage` | yes | `(ports) => string` |
| `stepType` | yes | PG step type, e.g. `'analyze_locations'` |
| `buildMessages` | yes | `(input, ports) => { messages, options? }` |
| `normalize` | no | `(result, input, ports) => any` — task-owned validation |
| `failMessage` | no | `(err) => string` |
| `onError` | no | `(err, step, ports, input) => any` — degradation |

## License

MIT
