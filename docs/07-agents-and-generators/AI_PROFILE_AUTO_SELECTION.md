# AI Profile Auto-Selection — Automatic agent profile selection based on conversation analysis

> **Status:** Direction / concept (RFC). Not implemented.
> **Date:** July 2026.
> **Relation to other documents:** continues the story from
> `docs/07-agents-and-generators/AGENT_PROMPT_PROFILES.md` (profiles for generation models)
> and `SYSTEM_PROMPT_RULES_MIGRATION.md` (rules in .md files).
> This is about **chat assistant** (AI Chat), not generation pipeline.

---

## 1. Problem and Motivation

Previously on the AI screen there were two rows of buttons:

- **Modes** (Chat → Editor → Import → Director → Extraction → Validation) —
  explicit user intent, actually changes available tools.
- **Topics** (Book / Scene / Characters / Screenplay) — **soft hints**,
  only affected `TOPIC_PROMPTS` in system prompt, didn't limit anything.

The topic row was removed in July 2026 (see `frontend`:
`ChatTopic.kt` deleted, `topic_id` hardcoded to `"book"`). Reason — classic
UX anti-pattern of manual "soft focus" switching:

> User forgets to switch button → agent answers "wrong topic" →
> unclear why it's glitching → trust lost.

**Conclusion:** soft hints should not be managed by buttons. Their place is
automatic detection from conversation context. Manual control justified
only for **hard constraints** (sandboxes), where user must see
current change scope.

## 2. Idea

**Automatically detect conversation "focus" and load corresponding
profile/skill into system prompt** — without user involvement.

```
Conversation (last messages + position + mode)
        ↓
  Context analysis (focus detection)
        ↓
  Mapping focus → profile/skill
        ↓
  Skill injection into system prompt (buildChatSystemPrompt)
        ↓
  Response generation
```

The model already receives everything needed for self-determining focus:

- **position** — `Current context: Chapter X / Scene Y` (always injected,
  regardless of topic);
  **mode** — explicit user intent (Edit / Director / …);
- **full book JSON** in context (`buildBookContext`).

So, focus detection is about *how to formulate task for model*, not
about *what data to give it*.

## 3. What already exists (infrastructure)

| Component | File | Role for this task |
|---|---|---|
| System prompt assembly | `backend/src/services/chat-engine.cjs` → `buildChatSystemPrompt({ mode, topic, lang, bookData, chapterId, sceneId, unitIndex })` | Point where selected skill will be loaded |
| Soft topic hints | `TOPIC_PROMPTS` in same file | Candidate for removal (only `book` remains) |
| Rules/skills loader | `backend/src/services/ai-loader.js` | Loads `backend/ai/rules/`, `backend/ai/skills/`, `backend/ai/examples/` (TTL cache 1 min) |
| Profiles-per-model | `backend/src/services/prompt-profile-loader.js` → `getProfile(type, name)`, `buildSkillSection()`, `listAvailableProfiles()` | Already can convert .md skill to prompt section |
| Existing skills | `backend/ai/skills/video/ltx-2.3.md`, `image/qwen-image.md`, `audio/qwen-tts.md` + legacy | Currently for generation models, not conversation focus |
| Chat endpoint | `backend/src/routes/ai-routes.cjs` → `POST /api/v1/ai/chat` | Assembles prompt server-side (F6), detection will be built in here |
| Modes (frontend) | `frontend/.../ui/AssistantMode.kt` | First row of buttons — stays as-is |

Key conclusion: **skill infrastructure already exists** (`.md` → `ai-loader` →
`buildSkillSection`). Only missing step is "which skill to select" and skills
for conversation focus.

## 4. Separation principle (important for future sandboxes)

| Impact type | Who chooses | UI |
|---|---|---|
| **Soft hint** (emphasis, focus) | Automatically from conversation context | No buttons (or only status indicator) |
| **Hard sandbox** (change boundary, protection) | Explicitly by user + visible status | Badge/toggle that can't be "forgotten" |

Sandboxes (book → chapter → scene → global sections) return with
Book World in DB — see discussion. Focus auto-detection is **separate**,
independent direction that can be done now and
coexists with sandboxes in future.

## 5. Implementation Options

### Option A — minimum: self-inference in prompt (≈10 lines)

Add one instruction to `buildChatSystemPrompt` so model itself
determines focus:

```
Infer what the user is focused on (whole book / current scene /
characters / plot & story arc) from the conversation and position
context, and tailor your help accordingly.
```

**Pros:** Zero code changes, model already has all data.
**Cons:** Depends on model's inference quality, no auditability, no
override/sandbox capability.

### Option B — lightweight context detector (≈50 lines)

Separate function `detectConversationFocus(conversation, position)` that
returns `{ focus: 'book' | 'scene' | 'characters' | 'plot', confidence }`.
Injected into system prompt as structured context.

**Pros:** Deterministic, auditable, can be overridden.
**Cons:** Small implementation effort, needs rules for focus detection.

### Option C — full profile system (future)

Each focus maps to a complete profile (system prompt + rules + examples).
Loaded via existing `prompt-profile-loader.js`.

**Pros:** Maximum flexibility, reuse existing infrastructure.
**Cons:** Requires creating focus-specific profiles, more complex management.

## 6. Recommended Approach

Start with **Option A** (self-inference) for immediate value, then
evolve to **Option B** when more control is needed.

Implementation steps:
1. Add focus inference instruction to `buildChatSystemPrompt`
2. Monitor model's focus detection accuracy
3. If needed, implement lightweight `detectConversationFocus`
4. Create focus-specific skills when patterns emerge

## 7. Files to Modify

### Backend
- `backend/src/services/chat-engine.cjs` — add focus inference instruction
- `backend/src/services/ai-loader.js` — (future) focus-specific skill loading

### Frontend
- No changes needed for Option A
- (Future) Status indicator for detected focus

## 8. Relation to Sandbox System

Focus auto-detection and sandboxes are independent:

- **Focus** = what model should pay attention to (soft, automatic)
- **Sandbox** = what user is allowed to change (hard, manual)

They can coexist: focus detection helps model understand context,
sandboxes restrict actual modifications.

## 9. Open Questions

1. Should focus detection be visible to user? (status indicator vs invisible)
2. How to handle conflicting signals (user says "edit scene" but context is book-level)?
3. Should focus affect available tools (not just prompt)?
4. Integration with future Book World sandbox system?

## 10. Timeline

- **Now:** Option A implementation (minimal, immediate value)
- **Q4 2026:** Option B if focus detection accuracy is insufficient
- **2027:** Option C when sandbox system is ready
