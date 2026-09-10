# AI Assistant Extraction — Physical Extraction

**Status:** LANDED (`@animastor/assistant` package physically extracted)
**Branch:** `c21.4-physically-extract-analysis-from-backend`
**Predecessor:** `docs/architecture/ai-assistant-extraction-preparation.md` (seams/ports/adapters — A-1…A-5)
**Guard suite:** `backend/tests/architecture/assistant-contour.test.js` (A1–A7, A1c), `backend/tests/architecture/assistant-package-boundary.test.js` (PB1–PB6), `backend/tests/architecture/chat-transport.test.js`

## 1. What was physically extracted

| Item | Source (deleted) | Destination (package) |
|---|---|---|
| Chat engine | `backend/src/services/chat-engine.cjs` | `packages/animastor-assistant/src/chat-engine.cjs` |
| AI routes | `backend/src/routes/ai-routes.cjs` | `packages/animastor-assistant/src/assistant-routes.cjs` |
| Ports contract | `backend/src/services/assistant-ports.cjs` (interface half) | `packages/animastor-assistant/src/assistant-ports-contract.cjs` |
| Session repo contract | inline in route (16× SQL) | `packages/animastor-assistant/src/session-repo-contract.cjs` |
| Public API entrypoint | `require('../routes/ai-routes')` + `require('../services/chat-engine')` | `packages/animastor-assistant/src/index.cjs` |

## 2. What remains host-side

| Component | Why host-side | Wired as |
|---|---|---|
| `chat-session-repo.js` (PG impl) | PostgreSQL infrastructure stays host | `assistantPorts.sessionRepo` |
| `ai-book-guard.js` | Middleware + auth-context + sessionRepo | injected in `backend.cjs` composition root |
| `backend/ai/ai-assistant-profile.md` | Persona file on host filesystem | `deps.aiProfilePath` injected at engine creation |
| `provider-gateway.js` | Cloud resolution, Redis, config | `assistantPorts.resolveChatAI` |
| `url-safety.js` | SSRF guard (shared infra) | `assistantPorts.chatTransport.safeFetch` (wraps url-safety) |
| `shared-pool.js` | Shared inference (private workers) | `assistantPorts.chatTransport.runSharedInference` |
| `bundle-validator.cjs` | Book contract validation | `assistantPorts.validateBundle` + engine `deps.validateBundleObject` |
| `assistant-ports.cjs` (implementation) | Host adapter wiring Book Model + PG + gateway | `backend/src/services/assistant-ports.cjs` |

## 3. Package architecture

```
packages/animastor-assistant/
├── package.json          # ZERO runtime deps; devDependencies: chai, mocha
├── LICENSE
├── src/
│   ├── index.cjs                    # Public API: 4 exports
│   ├── chat-engine.cjs              # Engine: persona, prompts, edit_book tool, patch pipeline, normalizer
│   ├── assistant-routes.cjs         # HTTP contour: sessions CRUD + chat + SSE stream
│   ├── assistant-ports-contract.cjs # Ports interface + assertAssistantPorts()
│   └── session-repo-contract.cjs    # Session repo interface + assertSessionRepo()
└── test/
    └── assistant-package.test.js    # Package-owned unit tests (PT1–PT3)
```

**Dependency direction:** package → host is ZERO. All host legs are injected through the ports seam at registration time. The package has no `require()` calls into `backend/src/`.

## 4. Ports seam (AssistantPorts)

The package declares the contract (`assistant-ports-contract.cjs`); the host implements it (`backend/src/services/assistant-ports.cjs`). The composition root (`backend.cjs`) wires the two.

```
Package (contract)                    Host (implementation)
──────────────────                    ──────────────────────
assertAssistantPorts(ports)           createAssistantPorts({ ... })
                                      ├── loadBook       → bookModel.loadBook(bookId, { mode: 'lazy' })
                                      ├── persistBook    → book.saveBookBundle / targeted file save
                                      ├── validateBundle → bundle-validator (object)
                                      ├── validateBundleFile → bundle-validator (per-file)
                                      ├── resolveChatAI  → providerGateway.chat.resolveProvider
                                      ├── sessionRepo    → chat-session-repo (PG)
                                      ├── purgeForBook   → sessionRepo.purgeSessionsForBook
                                      ├── chatTransport  → { safeFetch, runSharedInference, describeSharedError, chatAiSourceToken }
                                      └── log            → utils.log
```

## 5. Transport legs (chatTransport)

The route historically required `url-safety`, `shared-pool`, and `provider-gateway` directly for the three transport branches (cloud / connector / shared). After extraction, these three are injected as a single `chatTransport` sub-seam inside `assistantPorts`:

| Port | Bound to | Used in |
|---|---|---|
| `safeFetch` | `urlSafety.safeFetch` (SSRF-guarded) | Cloud provider HTTP calls |
| `runSharedInference` | `sharedPool.runSharedInference` | Connector shared-inference path |
| `describeSharedError` | `sharedPool.describeSharedError` | Error message sanitization |
| `chatAiSourceToken` | Maps `{ source, transport }` → consumer token (`'cloud'` / `'system'` / `'shared'`) | `ai_source` in API responses |

The local `sharedPool = { runSharedInference, describeSharedError }` shim inside the route preserves guard string-match compatibility (guards scan for `require('../services/ai-connector/shared-pool')` patterns — the shim name must match).

## 6. Engine injection changes

| Aspect | Before (host) | After (package) |
|---|---|---|
| `validateBundleObject` | Fallback `require('../book/bundle-validator.cjs')` | **Required** injection — throws if missing |
| `AI_PROFILE_PATH` | `const path = require('path')` + env/fallback | `deps.aiProfilePath \|\| process.env.AI_PROFILE_PATH` (path module removed) |
| Persona file read | `fs.readFileSync` hardcoded path | `fs.readFileSync(deps.aiProfilePath)` — fs kept only for persona read |
| `fs` module | Full fs usage (multiple) | Only `fs.readFileSync` + `fs.existsSync` for persona read |

## 7. Architecture guards

### assistant-contour.test.js (A1–A7, A1c)
- **A1/A1b:** No SQL/postgres/storage-barrel in the contour (route + engine + guard + package)
- **A1c:** No host `require()` inside package `src/` — package closure scan
- **A2:** `ai_chat_sessions` SQL only in `chat-session-repo.js` (+ schema.js)
- **A3/A3b:** Narrow route wiring + `AssistantPorts` surface completeness
- **A4:** Book/VBook access via ports only
- **A5:** Purge flows use `purgeAssistantForBook` port
- **A6:** Chat transport contract (SSE frames, tools, AbortController)
- **A7:** Engine validator injectable + composition-root bound

### assistant-package-boundary.test.js (PB1–PB6) — NEW
- **PB1:** Package `package.json` is valid JSON with correct name/version/entrypoint
- **PB2:** Package has ZERO runtime dependencies
- **PB3:** All `src/` files resolve inside the package or to Node builtins (no `backend/src/` requires)
- **PB4:** No host file deep-imports package internals (subpath blocked by `package.json` exports map)
- **PB5:** Host shim (`backend/src/routes/ai-routes.js`) is a one-line re-export of the package entrypoint
- **PB6:** `session-repo-contract.cjs` has all 9 required methods (contract surface frozen)

### chat-transport.test.js (updated)
- Chat routes use package paths (not old host paths)
- SSE meta/delta/done/error contract unchanged

### phase7-extraction-readiness.test.js (baselines updated)
- `RAW_BOOK_BASELINE`: `ai-routes.cjs` removed (deleted); `backend.cjs: ./book/bundle-validator.cjs` present (composition root edge)
- `P7-T6 CONSUMER_BASELINE`: package entrypoint registered in `package.json`

## 8. Test suite

### Package tests (PT1–PT3)
`packages/animastor-assistant/test/assistant-package.test.js` — run from `backend/`:
```
npx mocha --exit ../packages/animastor-assistant/test/*.test.js
```
- PT1: public API surface (4 exports, required deps)
- PT2: port contracts fail closed (assertAssistantPorts, assertSessionRepo)
- PT3: engine logic (participants normalization, patch validation, system prompt, tool modes)

### Host-rewired tests (all pass)
All runtime tests (`ai-patch-validation`, `ai-editor-mode`, `behavior-edit-book`, `ai-participants-doctrine`, `workspace-ai-security`, `ai-model-propagation`, `ai-connector-provider`, `personal-ai-provider-phase4`, `workspace-ai-provider`, `ai-shared-stream`, `ai-connector-acceptance`, `ai-shared-inference`) rewired to use `require('@animastor/assistant').createChatEngine(config, { validateBundleObject, aiProfilePath })`.

### Architecture guards: 819 passing, 0 failing

### Pre-existing environment failures (not caused by extraction)
- `16b. shared snapshot is safe for health checks` — fails on clean HEAD
- Private worker / LLM sharing / share-grants tests — worker infrastructure not available in this environment

## 9. Dependency graph (before → after)

**Before:**
```
backend/src/routes/ai-routes.cjs
  ├── ../services/chat-engine.cjs
  │     ├── ../book/bundle-validator.cjs  ← host fallback
  │     └── path, fs
  ├── ../services/url-safety.js
  ├── ../services/ai-connector/shared-pool.js
  ├── ../services/provider-gateway.js
  ├── storage/postgres/repositories/chat-session-repo.js (16× inline SQL)
  ├── middleware/auth-context.js
  └── storage/postgres/database (raw handle)
```

**After:**
```
packages/animastor-assistant/src/
  ├── chat-engine.cjs          ← deps.validateBundleObject (required)
  │     └── fs (persona read only)
  ├── assistant-routes.cjs     ← assistantPorts.chatTransport.*
  │     └── (zero host requires)
  ├── assistant-ports-contract.cjs
  └── session-repo-contract.cjs

backend/src/
  ├── backend.cjs              ← require('@animastor/assistant')
  │     ├── createChatEngine(config, { validateBundleObject, aiProfilePath })
  │     ├── createAssistantPorts({ ..., urlSafety, sharedPool })
  │     └── createAssistantRoutes(app, redis, { chatEngine, assistantPorts, utils })
  ├── services/assistant-ports.cjs  ← host adapter
  ├── services/chat-session-repo.js ← PG (unchanged)
  └── middleware/ai-book-guard.js    ← host (unchanged)
```

## 10. What is NOT done (out of scope)

- `ai-book-guard.js` stays host-side (middleware + auth-context + sessionRepo)
- Persona file stays on host filesystem (injected via `aiProfilePath`)
- `provider-gateway.js`, `url-safety.js`, `shared-pool.js` stay host-side (transport infra)
- No PG/Redis extraction (PostgreSQL stays host infrastructure)
- No HTTP/SSE contract changes; frontend clients untouched
- Package-level `npm publish` (not yet — monorepo `"file:"` dependency only)

## 11. Remaining work

1. **Package `README.md`** — document public API, ports contract, host integration
2. **Package runtime tests** — engine-level edge cases (optional, current PT1–PT3 cover core)
3. **`npm publish`** — after monorepo stabilization and version freeze
4. **Old host file references** — comment-only references in 5+ test files (cosmetic, non-functional)
