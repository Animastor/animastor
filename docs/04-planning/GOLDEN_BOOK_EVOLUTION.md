# Code Evolutionary Patching via Reference Visual Books

> Working concept name: **"Evolutionary Patching"**
> English technical name: **Golden Book Evolution / Visual Book Evolution Loop**

## 1. Idea

After the super-beta release, the visual book prototype can already
independently create raw books, but individual component quality
requires manual refinement.

Instead of trying to pre-write perfect architecture, each
human-refined book can be turned into a **reference (Golden Book)**
and used as a template for further automatic system improvement.

Core principle:

> **Raw book → human refinement → reference book →
> automatic comparison → system change → new raw book →
> new comparison.**

Thus, development gradually transforms from manual programming
into an **evolutionary cycle of finding higher-quality system behavior**.

---

## 2. Two Types of Books

### Raw Book — unrefined book

Book created by current Animastor version with no or minimal human intervention.

It shows what the system can do **independently right now**.

### Golden Book — reference book

The same book after human refinement to desired quality.

Golden Book is not just a finished result, but a **quality and behavior
template** the system should converge toward.

Important to preserve both versions:

```
raw_book/
    ↓
human editing
    ↓
golden_book/
```

The `Raw → Golden` pair is especially valuable because it shows not only
the correct result, but the **gap between current system behavior and
desired behavior**.

---

## 3. Why Reference Books Are Needed

One reference book shows a single quality example.

Many reference books gradually form the **system requirement space**.

For example:

- scenario segmentation quality;
- scene length and rhythm;
- character consistency;
- correct scene participant identification;
- visual prompt quality;
- frame composition;
- video quality;
- camera movement;
- TTS quality;
- audio/video synchronization;
- typography;
- regeneration correctness;
- artifact absence;
- correct fallback behavior;
- generation cost;
- processing speed;
- pipeline stability.

The reference doesn't have to be perfect in all aspects. It is the
**best available template at this moment**.

---

## 4. Evolutionary Cycle

Each system generation goes through roughly this cycle:

```
                    ┌─────────────────────┐
                    │  Golden Books       │
                    │  reference books    │
                    └──────────┬──────────┘
                               │
                               ▼
┌──────────────┐      ┌─────────────────────┐
│ Current Code │ ───► │ Generate Raw Books  │
└──────────────┘      └──────────┬──────────┘
                                 │
                                 ▼
                       ┌─────────────────────┐
                       │ Quality Evaluation  │
                       │ Raw vs Golden       │
                       └──────────┬──────────┘
                                  │
                                  ▼
                       ┌─────────────────────┐
                       │ Find Quality Gaps   │
                       └──────────┬──────────┘
                                  │
                                  ▼
                       ┌─────────────────────┐
                       │ Agent Experiments   │
                       │ code / prompts /    │
                       │ architecture        │
                       └──────────┬──────────┘
                                  │
                                  ▼
                       ┌─────────────────────┐
                       │ New Candidate       │
                       │ System Version      │
                       └──────────┬──────────┘
                                  │
                                  ▼
                       ┌─────────────────────┐
                       │ Benchmark Again     │
                       └──────────┬──────────┘
                                  │
                         better?  │
                         ┌────────┴────────┐
                         │                 │
                        YES                NO
                         │                 │
                         ▼                 ▼
                    keep version       reject
                         │
                         └──────► next generation
```

---

## 5. Role of Multiple AI Agents

Not necessary to use a single agent.

Multiple agents can search for different solutions to the same
problem in parallel.

For example:

- Agent A — architecture;
- Agent B — prompts;
- Agent C — character consistency;
- Agent D — scene segmentation;
- Agent E — video pipeline;
- Agent F — regeneration;
- Agent G — performance/cost;
- Agent H — discovering new architectural solutions.

Each agent creates a change hypothesis.

Then the system automatically runs the candidate through benchmark and
evaluates the result.

Thus:

> **The agent doesn't decide if its code is good. The benchmark decides
> whether the result improved.**

---

## 6. Main Optimization Object — Not Code

This is a key point.

System goal is NOT:

> "write beautiful code."

The goal is:

> **produce higher-quality visual books.**

Therefore internal code can become increasingly complex,
experimental, and even partially incomprehensible to humans, as long as
objectively measurable results show sustained improvement.

Consider:

```
Generation 0    Quality 71
Generation 1    Quality 74
Generation 2    Quality 77
Generation 3    Quality 76  ← rejected
Generation 4    Quality 81
Generation 5    Quality 83
...
Generation 97   Quality 94
```

Humans don't need to understand every internal detail of generation #97.

They need to understand:

- what changed;
- why the evaluator considers the result better;
- how stable the improvement is;
- whether other characteristics degraded.

---

## 7. Overfitting Protection on Reference Books

Cannot simply optimize the system on a fixed set of 100 books.

Otherwise the system may start optimizing specifically for those books
and their characteristics.

Therefore the set should be split:

```
Training / Development Set
≈ 70 books

Validation Set
≈ 20 books

Hidden Test Set
≈ 10 books
```

Proportional numbers may vary.

Key criterion:

> System must be able to produce not just 100 known reference books, but
> also the **101st unknown book**.

Therefore new books should periodically be added to the benchmark.

---

## 8. Golden Book as Result of Human System Training

At early stage, human is the main quality editor.

For example:

```
Raw Book #001
    ↓
30 manual corrections
    ↓
Golden Book #001

Raw Book #002
    ↓
17 manual corrections
    ↓
Golden Book #002

Raw Book #003
    ↓
8 manual corrections
    ↓
Golden Book #003
```

If the system is truly developing, the number of required manual
corrections should gradually decrease.

This creates a natural maturity indicator:

```
Human correction effort

30%
 ↓
20%
 ↓
12%
 ↓
7%
 ↓
3%
 ↓
<1%
```

Ideally, human gradually shifts from directly correcting books to:

1. verifying results;
2. accepting/rejecting;
3. formulating new quality criteria;
4. adding new references.

---

## 9. Quality Delta

Especially valuable is not just the Golden Book, but the **gap between
Raw and Golden**.

For each book, can store:

```
Raw Book
Golden Book
Quality Score Raw
Quality Score Golden
Quality Delta
Human Corrections
Detected Failure Modes
Accepted Improvements
```

For example:

```
Character consistency     82 → 96   +14
Scene coherence           76 → 91   +15
Typography                88 → 97   +9
Video quality             79 → 94   +15
Audio synchronization     93 → 98   +5
Regeneration correctness  61 → 95   +34
```

Such deltas allow agents to find recurring failure causes.

If the same problem appears in 30 books, it's no longer a random
defect but a **systemic architectural defect**.

---

## 10. Not Only Code Evolves

In the process, can change:

- Python/TypeScript/other code;
- pipeline architecture;
- prompts;
- agent skills;
- models;
- model parameters;
- orchestration rules;
- data schemas;
- fallback mechanisms;
- evaluator;
- quality criteria;
- regeneration approaches;
- model selection approaches;
- step execution order.

So the evolution object is not the repository in the narrow sense.

It is:

> **the entire visual book production system.**

---

## 11. Closed Loop

In mature version, process can work nearly autonomously:

```
Golden Dataset
      ↓
Generate
      ↓
Evaluate
      ↓
Diagnose
      ↓
Propose Changes
      ↓
Implement
      ↓
Test
      ↓
Benchmark
      ↓
Select Best Candidate
      ↓
Repeat
```

Multiple agents can work around the clock, creating and testing
new system generations.

Human controls direction and quality but doesn't need to
manually examine every line of code.

---

## 12. Transition from Programming to Quality Management

Traditional model:

```
Human
  ↓
Architecture
  ↓
Code
  ↓
Application
  ↓
Result
```

Evolutionary model:

```
Human
  ↓
Quality Definition
  ↓
Golden Dataset
  ↓
Evaluator
  ↓
AI Evolution
  ↓
Software
  ↓
Result
  ↺
```

Human gradually stops being the direct author of each system component.

They become:

> **architect of the quality space.**

---

## 13. End Goal — "Black Box"

In the limiting case, the internal system can become so complex
that humans no longer need to understand its internal workings.

This is analogous to a neural network with enormous parameter count.

Users don't need to know:

> "Why do exactly these parameters inside the model produce this result?"

They evaluate:

> "Is the result good or bad?"

Same with visual books:

> **Input → AI Production System → Visual Book**

Inside may be hundreds of agents, models, rules,
fallback mechanisms, and evolving components.

If the system consistently produces high quality on new data,
its internal workings become secondary.

---

## 14. End-User Interface

Final Animastor form should aim not at increasing button count,
but at reducing the need to understand internal mechanics.

User says:

> "Make a visual book from this novel."

System:

> "OK. I propose three visual directions."

User:

> "This one. Use these references."

System:

> "Accepted. Starting production."

After this, the most complex internal system works autonomously.

Thus, the final interface may become a **voice or conversational
interface**, similar to interacting with a spaceship AI:

> human talks about the result;
> system chooses the way to achieve it.

---

## 15. Key Philosophical Principle

Main project idea:

> **Don't try to pre-write perfect code. Create a system that
> can continuously improve itself.**

And shorter:

> **Code is a hypothesis. Book is the result. Benchmark is the judge.**

---

## 16. Practical First Step for Animastor

At current stage, no need to build full evolutionary programming system.

Enough to start collecting history:

```
Raw Book
    +
Human-edited Golden Book
    +
description of corrections made
    +
quality assessment
```

Each subsequent book increases corpus value.

When enough Golden Books accumulate, can build first
experimental evolutionary loop:

1. take current Animastor version;
2. run it on book set;
3. collect raw outputs;
4. compare with Golden Books;
5. automatically find quality gaps;
6. have multiple AI agents propose fixes;
7. collect several candidate versions;
8. run all versions through benchmark;
9. keep the best;
10. repeat cycle.

This could become a separate experimental development mode:

**Experimental Evolution Mode.**

---

## 17. Working Terminology

For documentation, recommended terms:

| Term | Meaning |
|---|---|
| **Raw Book** | book produced by current system without manual refinement |
| **Golden Book** | book refined by human to reference quality |
| **Golden Dataset** | set of reference books |
| **Quality Delta** | gap between Raw and Golden |
| **Evaluator** | quality assessment system |
| **Quality Gap** | detected divergence from reference |
| **Candidate** | experimental system version |
| **Generation** | system version after an change cycle |
| **Evolution Loop** | generation → evaluation → change → re-generation cycle |
| **Evolutionary Patching** | automatic iterative system refinement by agents |
| **Golden Book Evolution** | overall approach name |

---

## 18. Honest Critique of the Concept

This section written intentionally: concept is interesting, but at current
stage is more vision than plan. Below — what's wrong with it, no sugarcoating.

### 18.1. Main Bottleneck — Evaluator, Not Agents

Entire scheme hinges on "Benchmark decides." But automatically measuring
visual book quality is very hard: what is "good frame composition,"
"character consistency," or "artifact absence" in numbers? Either it's
an expensive LLM judge (unstable, with its own systematic errors), or
heuristics that miss the main issues.

If evaluator is poor, evolution optimizes not quality but the score —
classic Goodhart's Law. Building evaluator is not easier than building
the generation system itself. Until it's concretely defined,
"evolutionary cycle" is a beautiful diagram with an empty center.

### 18.2. Benchmark Cost Not Accounted

Running ~100 books through full pipeline (video on GPU, TTS, audio
sync) for each candidate — hours of GPU time and tokens.
If agents generate dozens of candidates per generation, budget
multiplies instantly. Document names "generation cost" as metric
but doesn't estimate evolution process cost itself. In practice: full
benchmark — once per N generations, light smoke run — on each candidate.

### 18.3. LLM Nondeterminism Turns Delta into Noise

Raw books are non-reproducible: same system version with different
seeds produces different results. Quality Delta between one Raw and one
Golden may be coincidence, not signal. Without multi-run statistics
(or at least "raw #1 vs raw #2" pairs to estimate noise), evolution
will "fix" non-existent defects.

### 18.4. "Black Box" Conflicts with Maintainability

Section 13 promises code can become "incomprehensible to humans." But
project is small, and `ROADMAP_6M.md` explicitly prioritizes reliability
and maintainability. Project history (see `DONT_DO.md`) is a list of
what already broke the system; agents freely changing code is a direct
risk of repeating those mistakes. Evolution without human understanding
accumulates unmaintainable debt faster than it can be recognized.

### 18.5. Error of "Human Not Needed in Loop"

Even in "mature" version, human cannot disappear from the loop: who
accepts Golden Books? Who formulates new quality criteria? Who
decides evaluator stopped reflecting real user desires?
Document partially acknowledges this (section 8), but "agents work
around the clock, human only monitors" — more optimistic than reality.
At best, human shifts from code author to criteria author — same
intellectual work, different form.

### 18.6. What's Genuinely Valuable in the Idea

To make critique honest, must name strengths:

- **Raw → Golden pairs are real data.** Even without any evolution,
  they provide a corpus of "what the system does wrong" suitable for
  manual analysis and developer training.
- **Quality Delta and "30 books with same problem = systemic defect"** —
  correct diagnostic logic.
- **Training / Validation / Hidden split** — correct overfitting
  protection from classical ML.
- **"Code is hypothesis, book is result" principle** — healthy priority
  criterion even without automation.

### 18.7. Critique Summary

Concept is raw and at current stage fanciful: its main components
(evaluator, statistics, budget, controlled agent code editing)
are not worked out, and "black box" conflicts with small project needs.
Don't dive in immediately.

But it's valuable as **direction**: already today, without building anything,
can start collecting Raw + Golden pairs with correction descriptions (section 16).
If someday a reliable evaluator and reasonable budget appear —
first evolutionary cycle can be assembled from this data. For now —
it's a vision, not a roadmap, and this status is honestly documented.

---

# Short Definition

**Evolutionary Patching** is an Animastor development approach where
raw visual books created by the system are compared with reference
Golden Books refined by humans to desired quality. AI agents analyze
divergences, independently change code, prompts, and architecture,
after which new system versions pass benchmark again. Best versions
are saved, and cycle repeats.

End goal — create a self-improving production system where human
sets quality standard and evaluates results, while internal
implementation gradually becomes a complex evolving "black box."

> **Raw → Human → Golden → Evaluate → Evolve → Raw → ...**
