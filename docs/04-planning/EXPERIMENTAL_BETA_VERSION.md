# Animastor Experimental Beta Version

> **Status:** Near-term architecture target  
> **Scope:** Experimental / self-hosted-resource beta  
> **Principle:** Bring Your Own AI + Bring Your Own GPU

---

## 1. Purpose

The immediate goal is to move Animastor from an internally operated system into a usable **Experimental Beta** as quickly as possible.

The Beta does **not** need to provide centralized AI credits, shared GPU infrastructure, billing, marketplace functionality, or a polished SaaS experience.

Instead, the user brings the resources required to run the system:

- their own AI API;
- their own AI model/provider;
- their own GPU/worker;
- optionally, a remote GPU rented by the user.

Animastor provides the application, orchestration, book-processing pipeline, generation logic, workspace isolation, and user interface.

### Core Beta promise

> **Animastor Experimental Beta is free to use when the user provides their own AI and generation resources.**

This gives us a very short path from the current authenticated system to a genuinely usable experimental product.

---

# 2. Current Position

The project already contains most of the infrastructure required for this direction.

The current architecture has:

- user identity;
- authentication;
- sessions;
- workspaces;
- workspace ownership;
- book ownership/authorization;
- guest workspaces;
- guest lifecycle cleanup;
- AI service abstraction;
- agent / TXT-import processing;
- audio/image/video workers;
- worker heartbeat;
- dispatch and leases;
- GPU Hub;
- generation orchestration;
- worker settings;
- existing Settings UI.

The main missing step is that several resources are still configured globally rather than being selected from the current workspace.

The Beta therefore should **extend the existing architecture rather than replace it.**

---

# 3. Beta Architecture

The intended resource hierarchy is:

```text
User
  |
  +-- Workspace
        |
        +-- AI Provider Configuration
        |
        +-- Books
        |
        +-- Private Workers
        |
        +-- Generation Resources
```

The important architectural principle is:

> **Resources belong to a Workspace, not directly to a User.**

A user may own several workspaces in the future, and a workspace may eventually be shared by several users.

This makes Workspace the correct boundary for:

- AI credentials;
- worker ownership;
- generation quotas;
- resource policies;
- future billing;
- future shared GPU access.

---

# 4. Experimental Beta Scope

The Beta should contain only the minimum functionality required to complete this loop:

```text
Register
   ↓
Create / enter Workspace
   ↓
Configure personal AI provider
   ↓
Connect personal worker
   ↓
Import TXT book
   ↓
AI analyzes / structures the book
   ↓
Generate audio / images / video
   ↓
Play the resulting visual book
```

If this loop works reliably, Animastor has reached a meaningful Experimental Beta.

Everything outside this loop is secondary.

---

# 5. BYO AI — Bring Your Own AI

## 5.1 Goal

Remove the dependency on a single global Animastor AI API key.

Instead, every workspace may define its own AI provider configuration.

Current architecture:

```text
Animastor
   ↓
global OPENROUTER_API_KEY
   ↓
AI
```

Target architecture:

```text
Animastor
   ↓
Current Workspace
   ↓
Workspace AI Provider
   ↓
User's API endpoint / key / model
   ↓
AI
```

---

## 5.2 Minimal Beta configuration

Settings should expose an **AI Provider** section.

Minimum fields:

```text
Provider
Endpoint
API Key
Model
```

Optional:

```text
Temperature
Max Tokens
```

The first implementation should preferably support an **OpenAI-compatible API interface**.

This allows the user to connect services such as:

- OpenRouter;
- compatible aggregators;
- compatible hosted APIs;
- local OpenAI-compatible servers;
- other providers without changing the Animastor AI pipeline.

OpenRouter can be presented as the recommended starting option, but Animastor should not become architecturally dependent on OpenRouter.

---

## 5.3 Provider storage

Conceptually:

```text
Workspace
   |
   +-- AI Provider
        +-- provider
        +-- endpoint
        +-- encrypted API key
        +-- model
        +-- enabled
```

Credentials must not be exposed to the frontend after storage.

The backend should resolve the active provider for the current workspace and inject credentials only into the server-side AI call.

---

# 6. AI Operations Covered by BYO AI

The workspace AI provider should become the source for all user-facing AI operations that currently depend on the global configuration.

At minimum:

### Chat

```text
Workspace AI
   ↓
Assistant Chat
```

### TXT import / book analysis

```text
TXT
 ↓
Workspace AI
 ↓
literary analysis
 ↓
characters
locations
scenes
units
visual prompts
```

### Agent processing

All agent steps should use the workspace-selected provider.

The existing agent prompts, skills, examples, validation and JSON processing should remain unchanged unless a separate quality problem is discovered.

**The first goal is to replace the credential/configuration source, not to rewrite the agent.**

---

# 7. AI Model Recommendation

Animastor should not hard-code a single model as a quality requirement during Experimental Beta.

The UI/documentation may provide a recommendation such as:

> For reliable book analysis and structured generation, use a strong instruction-following model with good JSON/tool-following capability and a sufficiently large context window.

A concrete recommended model can be documented separately after real experiments.

This is important because the project currently does not yet have enough empirical data to define a universal minimum model.

The architecture should therefore support:

```text
cheap model
medium model
strong model
local model
free model
```

The user accepts that output quality depends on the selected model.

---

# 8. BYO GPU — Bring Your Own Worker

The second half of the Beta is personal generation infrastructure.

A user should be able to run Animastor workers on:

- their own PC;
- their own workstation;
- a home server;
- a rented GPU server;
- a supported remote GPU environment.

The application itself does not need to own the GPU.

---

# 9. Private Worker Mode

The first Beta worker mode should be:

> **Private Worker**

A private worker belongs to one workspace and processes only jobs authorized for that workspace.

Conceptually:

```text
Worker
  |
  +-- worker_id
  +-- type
  +-- capabilities
  +-- workspace_id
  +-- authentication token
  +-- heartbeat
```

Routing:

```text
Generation Job
     ↓
Workspace A
     ↓
Private Worker A
```

The worker must never accidentally receive another workspace's private jobs.

This should reuse the existing worker registration, heartbeat, lease, dispatch and orchestration infrastructure.

---

# 10. Worker Authentication

A user should be able to create/connect a worker from Settings.

Conceptually:

```text
Settings
  ↓
Workers
  ↓
Add Worker
  ↓
Generate Worker Token
```

The worker authenticates using a workspace-scoped credential/token.

The worker then establishes:

```text
Worker → Workspace
```

and the backend uses that relationship when routing jobs.

The exact token format and registration protocol are implementation details and should be determined during the implementation reconnaissance.

---

# 11. Worker Types

The existing worker architecture should remain the foundation.

Initial worker categories:

```text
Audio Worker
Image Worker
Video Worker
```

The Beta does not require a new worker architecture.

It requires:

```text
existing worker system
        +
workspace ownership
        +
private routing
```

---

# 12. Private vs Shared Workers

The long-term worker model should support two policies:

```text
PRIVATE
SHARED
```

### PRIVATE

The worker serves only its owner's workspace.

```text
Worker
  ↓
Workspace A only
```

### SHARED

The worker voluntarily contributes capacity to the Animastor shared GPU pool.

```text
Worker
  ↓
Shared GPU Pool
  ↓
jobs from eligible workspaces
```

**Shared mode is NOT part of the first Experimental Beta.**

The architecture should leave room for it without implementing the full marketplace/pooling system now.

---

# 13. Future Shared GPU Model

The long-term direction is:

```text
Personal Worker
      ↓
Shared Worker
      ↓
GPU Pool
      ↓
Distributed Animastor Generation
```

A user could eventually choose:

> Keep my GPU private.

or:

> Allow Animastor to use my idle GPU.

This could later support:

- contribution credits;
- quotas;
- reputation;
- scheduling;
- marketplace mechanics;
- community GPU sharing.

None of these should block the Experimental Beta.

---

# 14. Remote GPU

The user should not be required to own a powerful local computer.

The same Private Worker model should work on a remote GPU:

```text
User
 ↓
GPU provider
 ↓
Worker
 ↓
Workspace
 ↓
Animastor
```

Examples may include rented GPU services or user-managed servers.

Animastor's responsibility is the worker protocol and orchestration, not ownership of the underlying GPU.

---

# 15. Docker / Installation Direction

After the Private Worker path works, provide simple deployment artifacts.

Preferred direction:

```text
Animastor Worker
    ↓
Docker image
    ↓
User machine / GPU server
```

Potentially provide ready-made configurations for:

- local installation;
- ComfyUI/HomeUI-based environments;
- remote GPU servers.

The first Beta does not require a polished installer.

A documented Docker/Compose path is sufficient.

---

# 16. Settings Structure

The Settings page should evolve toward:

```text
Settings
│
├── General
│
├── AI Provider
│     ├── Provider
│     ├── Endpoint
│     ├── API Key
│     ├── Model
│     └── Test Connection
│
├── Workers
│     ├── Audio
│     ├── Image
│     ├── Video
│     └── Add Worker
│
├── Visual Book
│
└── Cache / Debug
```

The current Settings implementation already contains VBook and Worker sections, so the new AI section should fit into the existing structure rather than creating a parallel settings system.

---

# 17. Security Boundary

The Beta must preserve the new multi-user architecture.

The critical invariant is:

```text
User
  ↓
Workspace
  ↓
Resource
```

A request must never be able to select another workspace's:

- AI provider;
- API credential;
- book;
- generation job;
- private worker;
- worker token.

Credentials should remain server-side.

Worker credentials must be scoped to the appropriate workspace.

The existing authorization and cross-tenant guards remain the foundation.

---

# 18. What We Should NOT Build Yet

The following are explicitly outside the immediate Beta horizon:

### Billing

No:

- subscriptions;
- payments;
- credits marketplace;
- invoices.

### Centralized AI credits

No need to subsidize AI usage.

Users bring their own API.

### Shared GPU marketplace

Not yet.

### Complex RBAC

Basic workspace ownership is sufficient.

### OAuth

Simple authentication is sufficient for Experimental Beta.

### Collaboration

No need for advanced multi-user workspace collaboration yet.

### Perfect onboarding

A functional setup flow is enough.

### Universal model compatibility

Support a practical OpenAI-compatible interface first.

### Full cloud infrastructure

Do not make Animastor dependent on centrally operated GPU infrastructure.

---

# 19. Development Strategy

The current period is particularly useful for architectural work because powerful models are temporarily available at low or zero cost.

Use strong models for:

- architecture;
- cross-module refactoring;
- security boundaries;
- resource ownership;
- AI provider abstraction;
- worker authentication;
- orchestration changes;
- difficult debugging.

Use cheaper/free models for:

- UI polishing;
- translations;
- tests;
- small bug fixes;
- mechanical refactoring;
- documentation updates;
- simple frontend work.

The principle is:

> **Spend expensive reasoning on architectural decisions. Spend cheap tokens on repetitive implementation.**

---

# 20. Recommended Implementation Order

## Phase A — Reconnaissance

Before changing code, map:

```text
AI calls
├── chat
├── TXT import
├── agent
├── bootstrap
└── other

AI configuration
├── API key
├── endpoint
├── model
└── environment variables

Worker lifecycle
├── registration
├── authentication
├── heartbeat
├── dispatch
├── leases
└── routing

Workspace ownership
├── existing tables
├── authorization
├── book ownership
└── available resource boundaries
```

No major code changes during reconnaissance.

---

## Phase B — Workspace AI Provider

> **Status: IMPLEMENTED (commit `feat(beta): add workspace-scoped AI providers`).**
> Storage: `workspace_ai_providers` (PK `workspace_id` enforces ONE provider
> per workspace; FK → `workspaces(id) ON DELETE CASCADE`; `api_key_enc` is
> AES-256-GCM ciphertext keyed by `WORKSPACE_SECRET_KEY`).
> Service: `backend/src/services/workspace-ai-provider.js` (CRUD + resolver
> `resolveAIForWorkspace`/`resolveAIForBook` + 30s cache invalidated on
> writes + `testConnection`). Global env config stays the fallback.
> Transport separation: `ai-service.callAI(messages, options, provider)`;
> the agent receives the provider once via `ai-caller.runWithProvider`
> (AsyncLocalStorage) around `bootstrapWithAgent`/`bootstrapNextWindow`.
> Chat (`/api/v1/ai/chat|stream|prompt`) and worker health
> (`/worker/counts`) resolve the book's workspace provider first.
> Settings API: `GET/PUT/DELETE /api/v1/settings/ai/provider`,
> `POST /api/v1/settings/ai/test` — plaintext key never leaves the server.
> Frontend: `/settings/ai` section in SettingsPage.
> Tests: `backend/tests/workspace-ai-provider.test.js` (real PG, mocked LLM).
> Fixed in passing: `/api/v1/ai/prompt` `parsed.reply` scope bug.

Implement:

```text
workspace_ai_providers
```

or the equivalent schema chosen after reconnaissance.

Then:

1. Add secure storage.
2. Add backend CRUD/API.
3. Add Settings UI.
4. Add Test Connection.
5. Resolve provider from current workspace.
6. Replace global key usage in AI operations.
7. Keep environment configuration as an optional server/admin fallback during migration.

---

## Phase C — Private Workers

Implement:

1. worker registration;
2. workspace binding;
3. worker authentication;
4. private routing;
5. Settings UI;
6. connection/heartbeat status;
7. worker installation instructions.

Reuse existing orchestration infrastructure.

Do not create a second worker system.

---

## Phase D — End-to-End Beta Test

The acceptance test is:

```text
New account
   ↓
Workspace
   ↓
Own AI API configured
   ↓
Own worker connected
   ↓
TXT imported
   ↓
Book parsed
   ↓
Scenes generated
   ↓
Audio generated
   ↓
Images generated
   ↓
Video generated
   ↓
Player works
```

The test should be performed with:

- one user;
- one workspace;
- one private worker;
- one external AI provider.

Then test isolation with a second workspace.

---

# 21. Beta Definition of Done

Animastor Experimental Beta is ready when a new user can independently:

- create an account;
- enter a workspace;
- configure their own AI API;
- select a model;
- successfully test the AI connection;
- import a TXT book;
- run the AI book analysis;
- connect a private worker;
- generate at least the supported media pipeline;
- play the resulting visual book;
- disconnect/reconnect their worker;
- use the system without Animastor paying for their AI/GPU usage.

The system does **not** need to be perfect.

It needs to be:

> **usable, isolated, understandable, and reproducible.**

---

# 22. Architectural North Star

The Experimental Beta is the first practical form of the larger Animastor architecture:

```text
                    ANIMASTOR
                        │
              ┌─────────┴─────────┐
              │                   │
          Workspace            Workspace
              │
       ┌──────┴──────┐
       │             │
    Own AI        Own GPU
       │             │
       ▼             ▼
   AI Provider     Worker
       │             │
       └──────┬──────┘
              │
          Generation
              │
              ▼
         Visual Book
```

Later:

```text
                    ANIMASTOR
                        │
                  Workspace
                        │
          ┌─────────────┼─────────────┐
          │             │             │
       Own AI       Private GPU    Shared GPU
          │             │             │
          └─────────────┼─────────────┘
                        │
                  Orchestration
                        │
                        ▼
                  Visual Book
```

The Beta therefore should be viewed not as a temporary prototype, but as the **smallest useful realization of the long-term architecture**.

---

# 23. Immediate Horizon

The immediate development horizon is deliberately narrow:

```text
1. Workspace-scoped AI
        ↓
2. Personal/private worker
        ↓
3. End-to-end self-funded generation
        ↓
4. Experimental Beta
```

Do not expand the scope until this loop works.

Once it works, Animastor can be opened to experimental users without requiring Animastor itself to finance their AI inference or GPU generation.

---

## Final Principle

> **Animastor provides the orchestration and creative pipeline.**
>
> **The user may provide the intelligence and compute.**
>
> **Shared resources come later.**

This is the fastest path from the current multi-user foundation to a real Experimental Beta.
