# Backend Dead Code Cleanup Plan

> **Goal:** Step-by-step cleanup of unused backend code with maximum safety.
> **Principle:** Small independent stages, each — separate Git commit with push.
> **Verification after each stage:** `npm test` + `npm run test:syntax`.

---

## Stage 1 ✅ (completed)

**Removed:**
- `backend/src/services/startup-recovery.js` — 0 imports, superseded by reconciliation-engine
- `backend/src/storage/manifest.js` — 0 imports, export removed from `storage/index.js`

**Verified (kept):**
- `backend/src/services/encoding-detect.js` — alive, used by `txt-importer.js`
- `backend/src/services/knowledge-base.js` — alive, used by `agent-service.js`
- `backend/src/services/source-coverage-audit.js` — alive, used by `book/core-routes.cjs`

**Commit:** `5f07d34`

---

## Stage 2 ✅ (completed)

**Removed from `helpers/utils.cjs`:**
- `pad` — 0 calls
- `parseChunkId` — 0 calls
- `splitTextIntoChunks` — 0 calls (duplicated in `audio/segments.js`)
- `splitDialogueIntoChunks` — 0 calls (duplicated in `audio/segments.js`)
- `buildSegments` — 0 calls (duplicated in `audio/segments.js`)
- `findSceneRuntimeData` — 0 calls (duplicated in `book/index.js`)
- `resolveAssetPath` — private function, not exported, 0 calls

**Kept in export:** `log` and `collectScenes` (used in `book-diff.cjs`)

**Updated destructuring in 12 files:** `backend.cjs`, `generation-routes.cjs`, `ai-routes.cjs`, `debug-routes.cjs`, `book/generation-routes.cjs`, `book/agent-routes.cjs`, `book/chunks-routes.cjs`, `book/core-routes.cjs`, `book/import-routes.cjs`, `book/recovery-routes.cjs`, `task-handler.cjs`, `audio-recovery.cjs`

**Commit:** `6c9a065`

---

## Stage 3: Unused runtime modules

**Verification:** All 4 candidates (`job-schema.js`, `circuit-breaker.js`, `retry-budget-manager.js`, `runtime-persistence.js`) — alive, used by other modules. Nothing removed.

**Status:** ✅ Skipped (no dead code)

---

## Stage 4: (merged with Stage 1 — manifest.js removed)

---

## Stage 5: Unused audio/video/image services

**Verification:** All 6 candidates (`silence.js`, `chunks.js`, `video-merge.js`, `preview.js`, `character-utils.js`, `registry.js`) — alive, imported via `audio-service.js`, `image-service.js` or directly.

**Status:** ✅ Skipped (no dead code)

---

## Stage 6: Unused book/lazy-book modules

**Verification:** All 5 candidates — alive. `create.js` uses `appearance.js` and `metadata.js` internally. `status.js` and `draft.js` used externally via routes.

**Status:** ✅ Skipped (no dead code)

---

## Stage 7: Unused orchestration modules

**Verification:** All 3 candidates — alive. `scene-callbacks.js` — core audio/video/image callback hub. `scene-utils.js` — logging utilities for all orchestration files. `scene-restoration.js` — chunk restoration.

**Status:** ✅ Skipped (no dead code)

---

## Stage 8: Unused PostgreSQL repositories

**Removed:**
- `cache-repo.js` — 0 production references (former consumer `manifest.js` removed in Stage 1, functions never called)
- `chat-session-repo.js` — 0 production references (only exported via barrel)

**Kept:**
- `events-repo.js` — alive, used in `book-event-log.js`
- `task-repo.js` — dead in production, but used in tests (`book-sync.test.js`). Kept.
- `chat-repo.js` — alive, used in `agent/bootstrap.js`

**Also fixed:**
- `scene-callbacks.js` — removed 3 calls to `storage.manifest.recordAsset()` that would have failed with runtime error after `manifest.js` removal in Stage 1

**Commit:** `c6c992e`

---

## Stage 9 ✅ (completed)

**Scope:** `backend/src/services/agent/`

**Removed:**
- `backend/src/services/agent/agent-prompts.js` — 0 production imports (replaced by `ai/prompts/`)
- `backend/src/services/agent/agent-session.js` — 0 production imports (replaced by `agent-session-pg.js`)
- `backend/src/services/agent/agent-service.js` — 0 production imports (replaced by `agent-service-pg.js`)

**Commit:** `d8c3c3e`

---

## Stage 10: Unused frontend components

**Verification:** All candidates — alive or used in tests. Nothing removed.

**Status:** ✅ Skipped (no dead code)

---

## Summary

| Stage | Status | Files removed | Commit |
|---|---|---|---|
| 1 | ✅ Completed | 2 | `5f07d34` |
| 2 | ✅ Completed | 7 functions | `6c9a065` |
| 3 | ✅ Skipped | 0 | — |
| 4 | ✅ Merged with 1 | 0 | — |
| 5 | ✅ Skipped | 0 | — |
| 6 | ✅ Skipped | 0 | — |
| 7 | ✅ Skipped | 0 | — |
| 8 | ✅ Completed | 2 | `c6c992e` |
| 9 | ✅ Completed | 3 | `d8c3c3e` |
| 10 | ✅ Skipped | 0 | — |

**Total:** 9 files removed, 7 dead functions removed, 4 commits.

---

## Verification Commands

After each stage:
```bash
npm test
npm run test:syntax
```

To verify dead code:
```bash
# Check for unused imports
npx depcheck backend/src/

# Check for unused exports
npx ts-prune backend/src/ 2>/dev/null | head -20

# Manual grep for function usage
grep -r "functionName" backend/src/ --include="*.js" --include="*.cjs"
```
