# Animastor — Vision: The Spaceship

## Core Idea

The final Animastor interface is **not a dashboard with generators**.

The final interface is **a conversation with an interlocutor**.

The user comes to the "reception" and simply says what they want to create, watch, or listen to today.

> "I want to make a short work in the spirit of 'Solaris'. Cold cosmic space, a lonely person, slightly unsettling but not scary."

The user is not required to know anything about models, workflows, ComfyUI, TTS, LTX, workers, GPUs, or other technical details.

They describe an intention, and the system turns it into a work.

## Reception

The first interface should be extremely simple:

> Hello. What would you like to create today?

The primary interaction method is voice.

The user can talk to the system naturally, ask clarifying questions, change their mind, reject options and accept them.

The system can proactively suggest intermediate results:

> "Does this character work for you?"
>
> "Will this voice work for the narrator?"
>
> "Here are three atmosphere options for the scene. Which feels closest?"

The user answers in plain language:

> "The second one is good, but make it a bit darker."

And work continues.

## Agent as Reception Director

The reception agent does not handle all technical work itself.

It manages Animastor via MCP/API as a tool.

Animastor in this case becomes a production environment, not the final user interface.

Inside Animastor, specialized agents and sub-agents work:

- screenplay;
- visual;
- character;
- audio;
- TTS;
- video;
- editing;
- quality control.

They already work with specific generative systems.

## Generative Systems Are Workshops

ComfyUI, TTS engines, LTX, Qwen, WAN, and other systems exist below the user level.

The internal agent can:

- select the appropriate model;
- find workflows;
- assemble workflows;
- install required components;
- run test generations;
- analyze errors;
- fix configuration;
- retry;
- save successful solutions.

The user only says:

> "I need this result."

Not:

> "Use this model with this sampler and this workflow."

## The Machine Can Learn from Its Own Experience

It is not necessary to solve each task from scratch.

After a successful generation, the system can save the working configuration:

> model + workflow + nodes + parameters + environment + constraints + result.

Over time, a library of proven recipes forms:

- LTX 2.3 + reference image → works.
- Qwen TTS + voice reference → works.
- This model works well for action scenes.
- This model speaks Russian better.
- This configuration requires 24 GB VRAM.

Errors can also become part of memory:

> This model + this node → incompatible.

Thus:

> experiment → successful solution → memory → reuse.

## Humans Can Become Part of Generative Material

Since the user is already talking to the system, the system can suggest:

> "Would you like me to save a sample of your voice for this work?"

At the user's discretion, their voice can become a reference for:

- a narrator;
- a character;
- a personal voice;
- future works.

The same is possible with images and other references.

But all of this happens at the user's discretion and through natural conversation, not through a complex settings form.

## Book World

A work gradually acquires a World — a single source of truth about it. This is the foundation, even more important than the generator itself.

```
Book World
├── Characters
├── Locations
├── Voices
├── Relationships
├── Visual characteristics
├── Historical / cultural context
└── User overrides
```

### The Book as World Source

Book World is not assembled manually — it is **automatically built from the work itself**.

```
Book
  ↓
TXT / speech transcription
  ↓
Book processing agents
  ↓
World extraction
  ├── Characters
  ├── Locations
  ├── Voices
  ├── Relationships
  ├── Visual characteristics
  └── Context / style
  ↓
Book World
```

Sources can be:

- TXT / EPUB / other text;
- a new book the user dictated;
- an existing book from the library;
- user-provided text.

### Canonical World and My Interpretation

When the user says "I want to see Berlioz like this" — this does not create a new character; it creates a **user override / interpretation** of an existing one.

- **Canonical World** — automatically extracted and verified base.
- **My Interpretation** — canon + user preferences.

```
Canonical World
       +
User preferences
       ↓
My Book World
```

Pre-made popular worlds are simply a cache: if "The Master and Margarita" is done a thousand times, there is no point in re-extracting the same world a thousand times.

Three scenarios:

- "Loaded a book → after some time its world appeared."
- "World already exists → use it."
- "Dictated → the system built the world itself."

## World Extraction: Incomplete and Distributed Knowledge

When extracting book world, you cannot assume that all information about an entity is present at its first appearance.

A character may:

- first appear in chapter 1;
- receive a name and role in chapter 1;
- receive a physical description in chapter 2;
- receive personality traits in chapter 5;
- receive additional visual details much later.

Therefore a character passport is an **accumulated entity**, not the result of a single pass.

### Agent Chooses Information Source

If the required information is not yet available in the processed portion of the book, the agent evaluates options:

1. continue processing the book and wait for the description to appear;
2. find information in other parts of the book;
3. perform a web search;
4. use existing information in the World database;
5. temporarily create a probabilistic description with a stated confidence level.

When choosing a source, the following are considered: token cost, time, information availability, source quality and authority, and the need for exact correspondence with the source text.

### External Search as Accelerator

For works in the public domain, if a detailed character description is available in a reliable external source, the agent can fetch it from the internet instead of waiting for further book processing.

External sources are not automatically treated as truth: retrieved information is stored as **external evidence** and cross-referenced with the source text itself.

### Provisional Descriptions

If a character is needed for scene generation but no precise description exists yet, the agent can create a provisional passport:

> "Male of European origin, corresponding to the era and social context of the work; clothing and appearance approximately match the historical context."

Such a passport receives **provisional / low confidence** status. When precise information from the book or an authoritative source becomes available later, the passport is updated and related visual assets are marked for regeneration.

### The Key Rule

Do not force the entire system to wait for perfect knowledge if the work can be continued now.

The system is capable of working with incomplete information, indicating confidence levels, and gradually replacing assumptions with verified data.

### World = Gradually Refined Model

World Extraction becomes not a one-time import but a process of gradually understanding the work — much like human reading: first "probably some guy like that," and twenty pages later "he had enormous mustaches, a crooked nose, and...".

If a significant character trait is discovered later, there is no need to rebuild the entire book: related visual units are marked as dirty and updated incrementally, only those specific ones.

At any moment, the agent knows:

> "This I know for certain. This I am assuming. This I do not yet know. And this I found in an external source."

## Dictation Instead of Typing

Do not force the user to type "Enter chapter title." They simply say:

> "Chapter one. So, it happened..."

And the system then:

- corrects slips of the tongue;
- removes filler words;
- preserves the author's manner;
- identifies chapters;
- builds structure;
- creates book world.

New book pipeline:

> speech → transcript → editorial agent → book text → world extraction → production.

## Two Search Engines

Before generating, the system checks whether a ready answer already exists:

- **World DB Search Agent** — searches its own database: "Do we already have this?" If yes, no further search is needed.
- **Web Research Agent** — if not in the database: "Going to search for information" — and brings results back to World.

```
User request
       ↓
   World DB
   found? ─── yes ──→ use it
       │
       no
       ↓
 Web Research
       ↓
 verification / structuring
       ↓
   World DB
```

## Mobile Interface

The final system must be accessible to someone who is not an engineer at all.

For example, a person on a train speaking into their phone:

> "I want to listen to the Mahabharata today."

The system:

> "Sure. Which voice do you prefer?"
>
> "Female, calm."
>
> "Here are several options."
>
> "The second one is good."

And after some time the user receives the finished work.

- No need to install ComfyUI.
- No need to choose a model.
- No need to understand workflows.
- No need to open ten browser tabs.

You just need to say what you want.

## First Screen

The first mobile screen should not be a panel with twenty-five buttons:

```
┌─────────────────────────────┐
│                       Advanced│
│                             │
│       What are we making?   │
│                             │
│            ◯                │
│       [speak]               │
│                             │
│  ┌───────────────────────┐  │
│  │                       │  │
│  │   references, options │  │
│  │   and results appear  │  │
│  │   here                │  │
│  │                       │  │
│  └───────────────────────┘  │
│                             │
└─────────────────────────────┘
```

The button is simple: **press → speak → press → done**. The agent continues working in the background.

## Asynchronous Operation

The system should not require the user to sit in front of the screen watching a progress bar.

The user leaves — "I'm going to make soup, you keep working" — and the system later says on its own:

> "I finished the first option. Please take a look."

The user opens their phone and sees:

> [reference]
>
> "Here is how I currently imagine Berlioz. Does it work?"

They respond:

> "No, bigger glasses and make him a bit heavier."

And put the phone away again.

## The Technical Interface Does Not Disappear

All existing buttons, panels, workers, profiles, workflows, models, and settings remain.

But they become the engineering layer of the system, not a mandatory user interface.

The user can open the technical mode if they want.

But a regular user does not need it.

Just as a spaceship passenger does not need to know the reactor's internals.

## Where We Are Going

Today we are building the engine room.

Tomorrow the bridge will appear on top of it.

Separately — how the system will learn to improve itself: each
quality book refined by a human becomes a benchmark (Golden Book),
and the gap between raw output and benchmark guides further
improvement of code, prompts, and architecture. More on this in
["Evolutionary Churning"](04-planning/GOLDEN_BOOK_EVOLUTION.md).

And the final destination is not yet another complex generator.

The final destination is **a spaceship you can talk to**.

The user says:

> "Computer, I want..."

And the system figures out how to make it happen.

The human is not operating the machine.

The human is pursuing their creative vision.

## Milestones: How We'll Know the Ship Has Flown

The Vision is considered realized not when all internal components are built, but when the user no longer needs them.

### Milestone 1 — Reception

The user opens Animastor and instead of a technical interface simply says:

> "I want to create..."

The reception agent understands conversation and can invoke Animastor via MCP/API.

**Criterion:** a simple task can be completed without manually navigating technical screens.

### Milestone 2 — Conversation Instead of Technical Brief

The user describes a work in plain words.

The agent itself builds the working structure:

- characters;
- locations;
- scenes;
- visual requirements;
- audio;
- video;
- references.

If information is insufficient, the agent does not show a form with twenty fields but asks the user a question.

**Criterion:** the user can set a task without knowing generative model terminology.

### Milestone 3 — References Instead of Settings

Agents show the user intermediate results:

> "Does this character work?"
>
> "Does this voice work?"
>
> "Does this scene atmosphere work?"

The user answers in plain speech.

Accepted options become part of the project and are used going forward.

**Criterion:** the user controls the artistic result through selection and conversation, not through model parameters.

### Milestone 4 — Agent Manages Production

Animastor becomes an MCP tool for the agent.

The agent is able to:

- create and modify scenes;
- trigger generations;
- receive statuses;
- retry failed tasks;
- select the appropriate backend;
- delegate tasks to specialized agents.

**Criterion:** Animastor's technical interface can be used entirely by the agent without human involvement.

### Milestone 5 — Generative Agent Can Experiment

If no suitable working recipe exists, the internal agent can:

1. find a model;
2. find or assemble a workflow;
3. run a test;
4. analyze the error;
5. fix configuration;
6. retry;
7. obtain a working result.

**Criterion:** a new generative model does not require mandatory manual integration by a developer for each new use case.

### Milestone 6 — Working Solution Memory

Successful configurations are saved as proven recipes.

The system remembers:

- which models work;
- which workflows work;
- which parameters fit;
- which configurations require specific hardware;
- which errors have been encountered before.

**Criterion:** a second run of a similar task is noticeably easier and faster than the first.

### Milestone 7 — Voice Becomes the Primary Interface

The user can perform nearly all primary interactions by voice.

For example:

> "Continue from the previous version."
>
> "We're keeping Berlioz."
>
> "I don't like this voice."
>
> "Make the scene more dynamic."
>
> "Show me how it turned out."

**Criterion:** the user never needs to return to the technical interface for normal creative work.

### Milestone 8 — The Ship

The final criterion.

The system greets the user:

> "Hello. What would you like to create today?"

The user describes their vision.

The system:

> understands → clarifies → suggests → receives approval → plans → generates → corrects → assembles → shows the result.

The human spends most of their time not managing production but working on their creative vision.

### The Moment We Can Say "The Ship Is Ready"

If a user can go from idea to finished work in an extended creative session without knowing model names, workflows, ComfyUI nodes, queues, workers, or technical parameters — then we have achieved the main goal.

Technical complexity does not disappear.

It simply moves to the other side of the conversation.

> **The human talks to the ship.**
> **The ship talks to the engine room.**

## Roadmap

Vision is a document with two layers: **where we are going** and **roughly when**. Timelines are windows, not hard promises.

| Stage | What appears | Target |
| --- | --- | --- |
| 1. Reception prototype | First mobile screen + voice agent + MCP call to Animastor | 1–2 weeks |
| 2. Dialogue + references | Agent talks, shows images/voices, gets "yes / no / redo" | 2–3 weeks |
| 3. Book World | Automatic world building from book, Canonical World + My Interpretation | 2–4 weeks |
| 4. Agent-driven generation | Internal agents select workflows/models and manage generators | 3–6 weeks |
| 5. Recipe memory | Successful workflow/configuration saved and reused | 2–3 weeks |
| 6. Dictation → work | User dictates book/vision, agent edits and structures | 2–4 weeks |
| 7. Advanced | Current technical Animastor becomes engineering mode | parallel |
| 8. First "ship" | From voice to finished work without technical interface | ~2–3 months |

Stages are not necessarily sequential — much can be done in parallel. The target is not a sum of weeks but the first live vertical slice in 2–4 weeks and a complete scenario in 2–3 months.

## Advanced — Engineering Mode

The same Animastor can be **a toy for regular users and a laboratory for engineers**.

Regular user:

> 🎙️ "What would you like to create?"

Engineer (Advanced): Navigator, Generator, Workers, Profiles, Workflows, Models, Logs, Queue, Redis/DB...

We do not simplify the internal system — we hide its complexity behind the right level of communication.

## Principle

> **Complexity should move down, not disappear.**

Complexity does not need to be destroyed. It needs to be moved out of the user's way.
