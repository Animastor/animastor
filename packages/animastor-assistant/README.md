# @animastor/assistant

The AI assistant contour of the Animastor backend, packaged as a standalone,
host-agnostic module.

## What this is

`@animastor/assistant` owns the assistant logic and its HTTP contract:

- **Chat engine** — persona/system prompt assembly, book-context builders
  (full + compact), mode/topic prompts, the `edit_book` tool definition,
  AI response parsing and the JSON-patch pipeline with bundle-contract
  validation and a deterministic scene-participants normalizer.
- **HTTP contour** — the `/api/v1/ai/*` surface: session CRUD, the
  non-streaming chat route and the SSE stream route
  (`meta` / `delta` / `done` / `error` frames), tool-call orchestration,
  connector shared-inference and cloud-provider transports.
- **Contracts** — the `AssistantPorts` seam and the chat-session repository
  interface the host must implement.

The package is **pure logic + contracts**. It has **zero runtime
dependencies**, does **not** touch the filesystem, does **not** read
`process.env`, and imports nothing from the host. Every host capability
arrives through an injected dependency or port.

## Requirements

- Node.js >= 18

## Installation

```bash
npm install @animastor/assistant
```

## Public API

The package exposes a single root entrypoint — deep imports are blocked by
the `exports` map:

```js
const {
    createChatEngine,
    createAssistantRoutes,
    assertAssistantPorts,
    assertSessionRepo,
} = require('@animastor/assistant');
```

## Basic usage

```js
const {
    createChatEngine,
    createAssistantRoutes,
    assertAssistantPorts,
} = require('@animastor/assistant');
const express = require('express');

// 1. Build the engine with injected host dependencies.
const chatEngine = createChatEngine(config, {
    // REQUIRED — host bundle-contract validator (object form).
    validateBundleObject: (bundle) => ({ valid: true, errors: [] }),

    // OPTIONAL — persona CONTENT (the host reads its own file and passes
    // the resulting string; the package never sees the path or filesystem).
    aiProfile: personaMarkdown,

    // OPTIONAL — chat fallback provider base URL (operator config).
    aiApiBaseUrl: process.env.AI_API_BASE_URL,
});

// 2. Build the host port adapter and validate it fail-fast.
const assistantPorts = assertAssistantPorts({
    loadBook,           // (bookId) => book bundle | null
    persistBook,        // (bookId, bundle) => void
    validateBundle,     // (bundle) => { valid, errors }
    validateBundleFile, // (name, data) => { valid, errors }
    resolveChatAI,      // (bookId) => provider snapshot
    sessionRepo,        // chat-session repository (see contract below)
    purgeForBook,       // (bookId) => Promise<void>
    chatTransport: {
        safeFetch,          // SSRF-guarded fetch
        runSharedInference, // connector / shared inference
        describeSharedError,// (code) => string
        chatAiSourceToken,  // (ai) => 'cloud' | 'system' | 'shared' | ...
    },
    log,                // host logger
});

// 3. Register the HTTP contour.
const app = express();
app.use(express.json());
createAssistantRoutes(app, redis, {
    chatEngine,
    assistantPorts,
    utils: { log },
});
```

## Required injected ports

| Port | Purpose |
|---|---|
| `loadBook(bookId)` | Canonical-or-draft book read |
| `persistBook(bookId, bundle)` | Book save (single semantics) |
| `validateBundle(bundle)` | Bundle-contract validation |
| `validateBundleFile(name, data)` | Per-file validation |
| `resolveChatAI(bookId)` | Chat provider resolution |
| `sessionRepo` | Chat-session persistence (see below) |
| `purgeForBook(bookId)` | Assistant-data purge on book deletion |
| `chatTransport.safeFetch` | SSRF-guarded outbound fetch |
| `chatTransport.runSharedInference` | Connector/shared inference |
| `chatTransport.describeSharedError` | Sanitized error text |
| `chatTransport.chatAiSourceToken` | Safe consumer source token |
| `log` | Host logger |

`sessionRepo` must implement:
`listSessionsForBook`, `getSession`, `getMessages`, `createSession`,
`setMessages`, `renameSession`, `deleteSession`, `getBookIdForSession`,
`purgeSessionsForBook` (validated by `assertSessionRepo`).

## Architecture / dependency model

```
Host
 ├── provider adapter      ─┐
 ├── book adapter           │
 ├── session repository     ├── injected ports (AssistantPorts)
 ├── transport adapter      │
 └── AI profile loader     ─┘
             ↓
     @animastor/assistant
             ↓
        public API
```

Dependency direction is **host → package**. The package never imports host
code; the host supplies concrete implementations at composition time. This
keeps storage, filesystem, provider and transport concerns on the host side.

## Versioning / release

- Current version: `0.1.0` (first publishable release; `npm pack` verified).
- SemVer: the four public factories, the root-only export map, the
  `AssistantPorts` shape and the `/api/v1/ai/*` HTTP/SSE contract are the
  public contract — breaking any of them requires a major bump.
- Publication is a manual, explicit step and is **not** automated in CI.

## License

MIT
