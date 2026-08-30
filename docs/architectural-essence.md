# The Architectural Essence of Animastor

Think of a book not as a collection of text, but as a reading process.

Animastor does not model a literary critic or a complete analysis system.

Animastor models a reader.

---

## Core Principle

A book is read sequentially.

The system knows only what has already been read.

Book world is not built in advance.

Book world gradually forms as the work is read.

---

## Sources of Truth

**Source of Truth #1:**

The book's TXT file.

This is the original text of the work.

**Source of Truth #2:**

`currentOffset`.

This is the current reading position.

The reading position is the absolute source of truth for the entire system.

The next window always begins at the position where the previous window ended.

**Source of Truth #3:**

The book's JSON.

JSON is the memory of what has been read.

It is not just a generation result.

It is structured memory of what has already been read and understood by the system.

---

## What JSON Is

JSON is the first level of book memory.

It is essentially the skeleton of the read work.

TXT contains the book.

JSON contains the understanding of the already-read portion of the book.

Thus, the transformation is:

```
TXT
→ Reading
→ Understanding
→ JSON
```

Each new reading window must be able to use the accumulated memory from the previously formed JSON.

---

## Book World Formation

Book world does not emerge before reading.

Book world emerges during reading.

Each new window:

- reads the next text fragment;
- uses accumulated memory;
- extends existing memory;
- saves the result back to JSON.

Thus, memory grows gradually along with progress through the book.

---

## Characters

Characters are not fixed objects.

Characters are refined gradually as reading progresses.

New information can:

- supplement the image;
- refine the image;
- replace outdated characteristics.

For example:

Chapter 1:
character is clean-shaven.

Chapter 20:
character wears a beard.

For visualization, the most current state of the character at the current reading moment is used.

Thus, the character evolves with the narrative.

---

## Locations

Locations are also accumulated.

If a new location description appears, it supplements the existing description.

If clarifications appear, the location memory is extended.

Missing details may be filled in by the model, based on the work's context and the text's cultural setting.

---

## Forward Scouting

A limited forward look at the text is permitted.

Scouting serves only to improve local context.

Scouting must not change the reading order.

Scouting must not change `currentOffset`.

Scouting must not be used to skip ahead in the book.

---

## Memory Development

At the current stage, JSON is the primary book memory.

In the future, memory may expand with additional data structures and a database.

But these structures should be seen as evolution of existing memory, not a separate system.

The foundation remains the accumulation of knowledge through sequential reading.

---

## Target Model

```
TXT
→ Sequential reading
→ Read memory (JSON)
→ Knowledge accumulation
→ Book world enrichment
```

We do not build a book model in advance.

We read the book and gradually build memory about it.

Memory is born from reading.
