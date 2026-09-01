# behavior.json Lifecycle — Research Report

## 1. Book Creation Pipeline

### Files created during new book creation

| Stage | Files created | behavior.json? |
|-------|--------------|----------------|
| `createDraftBook()` | `manifest.json`, `book.json`, `source.txt` | ❌ |
| `createOrAppendScenes()` (pipeline) | `characters.json`, `locations.json`, `voices.json`, `bible.json`, `mentions.json`, `chapters/*.json` | ❌ |

**behavior.json is never created during book creation or pipeline execution.**

`lazy-book/paths.js` has no `getBehaviorPath()` helper — unlike `getCharactersPath`, `getVoicesPath`, `getLocationsPath`, `getBiblePath`, etc.

---

## 2. behavior.json Lifecycle

### Schema (v2.1)

```json
{
  "<character_id>": {
    "baseline": "string",
    "quirks": ["string"],
    "reactions": [
      { "trigger": "string", "reaction": "string" }
    ]
  }
}
```

### Load

- `buildBookFromBundle()` (zip import): if `behavior.json` absent → `behaviors = {}`
- `loadBookFromDir()` (disk load): `fs.existsSync(behaviorPath)` → parse or default `{}`
- Both return `behaviors` as top-level key in book object

### Save (`saveBookBundle` in `book/index.js`)

```js
const hasBehaviors = book.behaviors && Object.keys(book.behaviors).length > 0;
if (hasBehaviors) {
    fs.writeFileSync(bhPath, JSON.stringify(book.behaviors, null, 2));
} else if (fs.existsSync(bhPath)) {
    fs.unlinkSync(bhPath);  // ← empty behaviors → file deleted
}
```

**Empty `behaviors: {}` → file unlinked.** This is by design but creates a gap for AI-agent.

### CRUD (entity-crud-routes.cjs)

| Endpoint | Behavior |
|----------|----------|
| `POST /book/:bookId/behaviors` | Seeds `{baseline}` for existing character_id (400/404/409 guards) |
| `PATCH /book/:bookId/behaviors/:characterId` | Merges fields via `setDeep` (passthrough for unknown keys) |
| `DELETE /book/:bookId/behaviors/:characterId` | Deletes entry; file unlinked when last behavior removed |

### Character deletion cleanup

When a character is deleted, its behavior entry is also deleted (`entity-crud-routes.cjs:146-151`).

---

## 3. AI Agent Pipeline — What Files Are Visible

### AI Chat (`ai-routes.cjs` + `chat-engine.cjs`)

| Aspect | Detail |
|--------|--------|
| System prompt | Mode-based (conversation/edit/director/import). **No mention of behavior.** |
| Book context | Full `bookData` serialized as JSON — includes `behaviors: {}` when file absent |
| Tool: `edit_book` | JSON Patch ops on full book object. **Can write to `/behaviors/...` paths.** |
| Validation | `applyPatchesValidated()` → `validateBundleObject()` → `saveBookBundle()` |
| Knowledge base | `ai/examples/behavior.json` exists but **NOT loaded into chat context** |

### Agent Pipeline (lazy-book/create.js)

- Pipeline **does not reference** `behavior.json` at all
- `pipeline-runner.js`, `pipeline-steps.js` — zero mentions of behavior
- Characters, locations, voices are created; behavior is intentionally excluded

### Schema Discovery

| Source | Available to AI chat? |
|--------|----------------------|
| `ai/examples/behavior.json` | ❌ Not loaded into chat context |
| `ai/rules/*.md` | ❌ No behavior rules exist |
| System prompt | ❌ No behavior schema description |
| Book context | ⚠️ Only shows `{behaviors: {}}` — no schema guidance |
| `loadKnowledgeBase()` | ❌ Not integrated into `chat-engine.cjs` |

---

## 4. Hypothesis Verification

> "If today we create a new Visual Book and immediately ask AI-agent to create Behavior for characters, can it do so without manually creating behavior.json first?"

**Answer: Formally yes, but practically no.**

| Check | Status |
|-------|--------|
| Agent sees `characters.json` → knows character_id | ✅ |
| `edit_book` tool can patch `/behaviors/...` | ✅ |
| Bundle validator accepts correct behavior object | ✅ |
| AI knows behavior schema (baseline/quirks/reactions) | ❌ No schema in context |
| AI knows behavior is a supported artifact | ❌ No mention in prompt/rules |
| `behavior.json` exists on disk | ❌ Never created during book creation |
| `saveBookBundle` would persist it | ⚠️ Only if behaviors object is non-empty |

**The agent has the mechanism (edit_book tool + validation) but lacks the knowledge (schema + awareness).**

---

## 5. Architectural Analysis

### Current design intent

- **Characters/locations/voices** = creation-time entities (pipeline creates them)
- **Behavior** = enrichment entity (added later by user via Editor tab)
- **Behavior is deliberately optional** — many books may never need it

### Gap for AI-agent

The `edit_book` tool can technically apply behavior patches, but:
1. No schema example in chat context
2. No rule/prompt telling the agent behavior exists
3. No `getBehaviorPath` helper in `lazy-book/paths.js`
4. Empty behavior object → file deleted on save (unlink logic)

---

## 6. Recommendations

### Option A: Create behavior.json at book creation

**Changes:**
1. `lazy-book/paths.js` — add `getBehaviorPath(bookDir)`
2. `lazy-book/create.js` — write `behavior.json: {}` during first window
3. `book/index.js:saveBookBundle()` — change unlink logic: keep empty `{}` file (like voices/locations pattern, but without auto-creation)

**Pros:** Simple, deterministic, file always exists
**Cons:** Empty file on disk for books that never use behavior

### Option B: Create on first access

**Changes:**
1. In `POST /behaviors` handler — auto-create `behavior.json` if absent
2. In `edit_book` tool path — no change needed (validation already handles it)

**Pros:** Lazy, no empty files
**Cons:** Race conditions on concurrent access, more complex

### Option C: Dedicated Behavior tool/API for AI-agent

**Changes:**
1. Add `create_behavior` tool to `chat-engine.cjs` tool definitions
2. Tool handler: validates character_id, creates entry, saves via `saveBookBundle`
3. Optionally: inject schema example into chat context

**Pros:** Clean AI-agent interface, explicit schema, future extensible
**Cons:** More code, new tool to maintain

### Recommendation

**Minimal set (Option A + context enrichment):**

| File | Change |
|------|--------|
| `backend/src/book/lazy-book/paths.js` | Add `getBehaviorPath(bookDir)` |
| `backend/src/book/lazy-book/create.js` | Write `behavior.json: {}` at first window |
| `backend/src/book/index.js` | Keep empty behavior file (change unlink to write `{}`) |
| `backend/src/services/chat-engine.cjs` | Add behavior schema example to `buildBookContext()` |

**Optional follow-up (Option C):**
- Add `create_behavior` tool for explicit AI-agent behavior creation

---

## 7. Bugs Found

### Minor: inconsistent unlink behavior

`saveBookBundle` unlinks `behavior.json` when empty but keeps `characters.json` (empty array) and `locations.json`/`voices.json` (empty objects). This is not a bug per se — behavior was designed as optional enrichment — but creates inconsistency for AI-agent use.

**Severity:** Low. Does not affect current functionality.

---

## 8. Files Referenced

| File | Relevance |
|------|-----------|
| `backend/src/book/index.js` | `saveBookBundle`, `loadBookFromDir`, `buildBookFromBundle` |
| `backend/src/book/lazy-book/create.js` | Pipeline scene/character creation — no behavior |
| `backend/src/book/lazy-book/draft.js` | `createDraftBook` — 3 files only |
| `backend/src/book/lazy-book/paths.js` | No `getBehaviorPath` helper |
| `backend/src/book/bundle-validator.cjs` | `validateBehaviors` — validates object structure |
| `backend/src/routes/book/entity-crud-routes.cjs` | POST/PATCH/DELETE `/behaviors` |
| `backend/src/routes/book/core-routes.cjs` | PATCH `/behaviors/:characterId` |
| `backend/src/routes/ai-routes.cjs` | AI chat — `edit_book` tool handling |
| `backend/src/services/chat-engine.cjs` | `buildBookContext`, `getToolsForMode`, `EDIT_BOOK_TOOL` |
| `backend/src/services/knowledge-base.js` | Loads `ai/examples/` — not used in chat |
| `backend/ai/examples/behavior.json` | Schema example — exists but not loaded |
| `backend/tests/behavior-crud.test.js` | CRUD lifecycle tests |
