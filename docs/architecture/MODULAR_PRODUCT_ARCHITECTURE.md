# Animastor — Modular Product Architecture

**Status:** Architectural Direction
**Date:** 2026-09-02

---

## 1. Purpose

Animastor should gradually evolve toward a modular architecture in which major logical capabilities are designed as independent modules.

A module should not merely be a folder or a collection of files.

A well-designed Animastor module should represent a coherent capability with:

- a clear responsibility;
- a defined public interface;
- minimal knowledge of internal implementation of other modules;
- its own tests;
- its own domain logic;
- controlled dependencies;
- the potential to be extracted into an independent product in the future.

**Core principle**

> «Every major module should be designed so that it could eventually become an independent product without requiring a fundamental rewrite.»

This does not mean that every module must immediately become a separate service, package, repository, or Docker container.

The initial goal is **logical modularity**, not microservices.

---

## 2. Why This Architecture

Animastor is gradually accumulating multiple substantial capabilities:

- books and book processing;
- visual book format;
- parsing and analysis;
- generation;
- AI provider integrations;
- ComfyUI integration;
- GPU orchestration;
- workers;
- player;
- editor;
- navigation;
- caching;
- future local AI/model infrastructure.

Keeping all of these capabilities tightly coupled inside one backend will gradually increase architectural complexity.

Instead, Animastor should grow as a collection of cooperating modules.

The backend may remain a **modular monolith** for a long time.

The important distinction is:

```
Modular monolith  ≠  Monolithic architecture
```

A modular monolith can later be split into independent services or products when there is a real reason to do so.

---

## 3. Module Extraction Principle

Every significant module should answer four questions:

### 3.1 What does this module own?

The module should have a clearly defined area of responsibility.

### 3.2 What does the outside world need from it?

The module should expose a small public interface.

### 3.3 What should remain private?

Internal implementation details should not become dependencies of other modules.

### 3.4 Could it be extracted?

If the module were moved into another repository, what would be required?

The goal is to progressively reduce that list.

---

## 4. Target Architectural Map

The target architecture is approximately:

```
                         ┌─────────────────────┐
                         │      Animastor      │
                         │        Core         │
                         └──────────┬──────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
          ▼                         ▼                         ▼
      Book Domain              Generation               Projects
          │                         │
    ┌─────┴─────┐           ┌───────┴────────┐
    ▼           ▼           ▼                ▼
 Parser       VBook      Providers       Compute
    │           │           │                │
    │           │      ┌────┼────┐            ▼
    │           │      ▼    ▼    ▼         GPU Hub
    │           │   API   Local  ...          │
    │           │                          Workers
    │           │
    └──────┬────┘
           ▼
      Book Model
           │
      ┌────┼─────────────┐
      ▼    ▼             ▼
   Player Editor      Navigator
```

The exact boundaries may evolve.

The important part is that each major capability has a recognizable architectural identity.

---

## 5. Candidate Independent Modules

### 5.1 VBook

The VBook format should eventually be treated as a first-class format module.

**Potential future product:** Animastor VBook

**Responsibilities:**

- VBook format specification;
- versioning;
- manifest;
- validation;
- serialization;
- deserialization;
- asset references;
- compatibility;
- migration between VBook versions;
- runtime representation.

The VBook module should not depend on the Animastor web application.

**Potential future usage:**

```
.vbook
   │
   ▼
VBook Runtime
   │
   ├── Web
   ├── Android
   ├── Desktop
   └── Third-party applications
```

---

## 6. Player

The Player is a strong candidate for future extraction.

**Potential future product:** Animastor Player

The Player should consume a canonical book/runtime representation rather than directly depending on backend implementation details.

**Conceptually:**

```
VBook / Book Model
        │
        ▼
   Book Runtime
        │
        ▼
      Player
        │
        ├── Web renderer
        ├── Android renderer
        └── Desktop renderer
```

The Player should ideally be capable of operating locally.

A future user could potentially download a `.vbook` and open it directly without requiring the full Animastor backend.

---

## 7. Editor

The Editor should become a distinct logical module.

**Potential future product:** Animastor Editor

The Editor operates on a canonical book/project model.

It should not need to understand how the backend stores database records internally.

**Conceptually:**

```
Book Model
    │
    ▼
Editor Engine
    ├── scenes
    ├── characters
    ├── timeline
    ├── assets
    ├── audio
    └── metadata
    │
    ▼
VBook / Project Export
```

This creates the possibility of eventually providing the editor independently from the main Animastor application.

---

## 8. Parser / Import System

Parsing should be considered separate from the VBook format.

A parser converts an external source into a canonical Animastor Book Model.

**Potential inputs:**

- EPUB
- PDF
- DOCX
- TXT
- HTML
- Web content
- Other formats

**Conceptually:**

```
External Format
       │
       ▼
    Parser
       │
       ▼
Canonical Book Model
       │
       ├── analysis
       ├── structure
       ├── characters
       ├── scenes
       └── generation
```

Then:

```
Canonical Book Model
       │
       ▼
VBook Exporter
       │
       ▼
.vbook
```

This separation is important.

**Parser ≠ VBook.**

Parser understands how to import something.

VBook understands how to store and distribute the Animastor visual-book representation.

---

## 9. Generation

Generation should gradually become a provider-independent module.

**Conceptually:**

```
Generation API
      │
      ▼
Provider Gateway
      │
 ┌────┼───────────────┐
 ▼    ▼               ▼
ComfyUI  Paid APIs   Local Models
```

The generation domain should not be tightly coupled to a specific provider.

This allows Animastor to add:

- cloud providers;
- ComfyUI;
- user-provided API keys;
- local models;
- shared models;
- future providers.

without redesigning the generation domain.

---

## 10. Compute / GPU Hub

GPU Hub is already an important architectural boundary.

It should remain an independent infrastructure component.

**Conceptually:**

```
Generation / Jobs
       │
       ▼
   Compute API
       │
       ▼
    GPU Hub
       │
 ┌─────┼────────────┐
 ▼     ▼            ▼
Worker Worker      Worker
```

GPU Hub should own:

- worker registration;
- worker availability;
- task dispatch;
- queues;
- scheduling;
- worker health;
- worker capabilities;
- shared/private worker routing.

The business logic of a generated artifact should not be embedded into GPU Hub.

GPU Hub should primarily answer:

> «Where and how should this compute task execute?»

---

## 11. Worker

Workers should be treated as independently deployable compute agents.

**Potential future product:** Animastor Worker

A worker should know how to:

- connect to GPU Hub;
- advertise capabilities;
- receive jobs;
- execute jobs;
- report progress;
- return results;
- maintain its local runtime.

It should not need the complete Animastor application.

This is especially important for:

- private user GPUs;
- shared workers;
- future worker marketplace;
- local installations;
- distributed compute.

---

## 12. Provider Gateway

External AI APIs should be behind a provider abstraction.

**Examples:**

- OpenAI
- OpenRouter
- Other paid APIs
- ComfyUI
- Local LLM
- Future providers

**Conceptually:**

```
Application
     │
     ▼
Provider Gateway
     │
 ┌───┼────┬────────┐
 ▼   ▼    ▼        ▼
API Local ComfyUI  ...
```

The application should request a capability rather than directly depending on a provider implementation.

For example:

```js
generateText(...)
generateImage(...)
generateAudio(...)
```

rather than:

```js
callOpenRouter(...)
callComfy(...)
```

in arbitrary business logic.

---

## 13. Player, Editor and VBook Relationship

These three modules should be particularly clean.

```
              Canonical Book Model
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
          Editor              Player
             │                   │
             ▼                   │
           VBook ◄───────────────┘
```

**Possible long-term ecosystem:**

```
Animastor VBook
       │
       ├── Animastor Player
       ├── Animastor Editor
       ├── Animastor Parser
       └── Third-party ecosystem
```

This could eventually become an ecosystem rather than merely an internal implementation detail.

---

## 14. Modular Monolith First

The immediate architectural strategy is not to split Animastor into many microservices.

Instead:

**Current:**

```
backend
 ├── book
 ├── auth
 ├── generation
 ├── services
 └── ...
```

**Target:**

```
backend
 ├── core
 └── modules
      ├── book
      ├── parser
      ├── vbook
      ├── generation
      ├── providers
      └── ...
```

These modules may initially run in the same process.

Only later, when justified by:

- scale;
- deployment requirements;
- independent release cycles;
- resource isolation;
- external reuse;
- performance;
- organizational boundaries;

should a module become a separate service or product.

---

## 15. Rules for New Development

When adding substantial new functionality, developers should ask:

### Rule 1 — Is this a new capability?

If yes, consider creating a module boundary rather than adding more code to an existing generic service.

### Rule 2 — Does this module have a clear owner?

A module should have an obvious responsibility.

### Rule 3 — Can another module use it through an interface?

Prefer public APIs/interfaces over direct access to internal implementation.

### Rule 4 — Avoid reverse dependencies

A low-level module should not unexpectedly depend on the entire application.

### Rule 5 — Do not leak database structures

Other modules should preferably consume domain objects/interfaces rather than raw database implementation details.

### Rule 6 — Keep extraction in mind

When implementing a module, ask:

> «If we wanted to extract this into a separate repository in two years, what would prevent us?»

Avoid creating those dependencies unnecessarily.

---

## 16. What This Document Does NOT Require

This document does not require:

- immediate refactoring;
- moving existing files;
- creating microservices;
- creating new Docker containers;
- splitting repositories;
- changing production behavior;
- rewriting working code.

It is an **architectural direction**.

Existing code should be migrated gradually and opportunistically.

---

## 17. Gradual Migration Strategy

Migration should happen when code is already being modified.

**Preferred approach:**

```
New feature
    │
    ▼
Identify logical module
    │
    ▼
Define boundary
    │
    ▼
Implement new code inside boundary
    │
    ▼
Gradually move related old code
    │
    ▼
Reduce dependencies
```

Avoid large "big bang" architectural migrations.

A module becomes cleaner over time.

---

## 18. Definition of Architectural Success

Animastor does not need to become a collection of dozens of services.

Success means that major capabilities become logically independent enough that:

- Animastor Player
- Animastor Editor
- Animastor VBook
- Animastor Parser
- Animastor Worker
- Animastor GPU Hub

could potentially exist as independent products or packages if the future business direction requires it.

The architecture should make this possible **without requiring a rewrite**.

---

## 19. Guiding Principle

> «Build Animastor as an ecosystem of capabilities, not as one ever-growing application.»

Keep the deployment simple.

Keep the backend practical.

Keep working code working.

But when new capabilities are created, give them boundaries.

Over time, those boundaries become the architecture.
