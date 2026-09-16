# NPM ↔ Git Inventory Audit

**Date:** 2026-09-16
**Branch:** `c21.4-physically-extract-analysis-from-backend`
**Scope:** `packages/` directory

---

## Summary

| Metric | Count |
|--------|-------|
| Directories in `packages/` | 28 |
| Packages with `package.json` | 27 |
| Private / not for NPM | 1 (`@animastor/installer`) |
| No `package.json` (not an npm package) | 1 (`animastor-worker/`) |
| **Published & version-matched (MATCH)** | **25** |
| Published but not in Git | 1 (`animastor-worker`) |
| In Git but not on NPM (`@animastor/*`) | 1 (`@animastor/installer`) |

**Total MATCH: 25 / 27 publishable packages (92.6%)**

---

## Detailed Table

| Git package (dir) | npm name | Git version | NPM exists | NPM latest | Current version published | Status |
|--------------------|----------|-------------|------------|------------|---------------------------|--------|
| `animastor-ai-agent` | `@animastor/ai-agent` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-ai-analysis` | `@animastor/ai-analysis` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-ai-connector` | `animastor-ai-connector` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-assistant` | `@animastor/assistant` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-comfyui-workflow-connector` | `animastor-comfyui-workflow-connector` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-contracts` | `@animastor/contracts` | 0.1.1 | ✅ | 0.1.1 | ✅ | **MATCH** |
| `animastor-editor` | `@animastor/editor` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-generation` | `@animastor/generation` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-gpu-hub` | `@animastor/gpu-hub` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-installer` | `@animastor/installer` | 0.1.0 | ❌ | — | — | **PRIVATE / NOT_FOR_NPM** |
| `animastor-orchestration` | `@animastor/orchestration` | 0.1.1 | ✅ | 0.1.1 | ✅ | **MATCH** |
| `animastor-parser` | `@animastor/parser` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-player` | `@animastor/player` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-vbook-runtime` | `@animastor/vbook-runtime` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-ai-chat` | `@animastor/web-ai-chat` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-book-session` | `@animastor/web-book-session` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-editor` | `@animastor/web-editor` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-file` | `@animastor/web-file` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-generator` | `@animastor/web-generator` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-generator-config` | `@animastor/web-generator-config` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-generator-sse` | `@animastor/web-generator-sse` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-generator-vbook` | `@animastor/web-generator-vbook` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-local-ai` | `@animastor/web-local-ai` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-navigator` | `@animastor/web-navigator` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-player` | `@animastor/web-player` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-settings` | `@animastor/web-settings` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-web-workers` | `@animastor/web-workers` | 0.1.0 | ✅ | 0.1.0 | ✅ | **MATCH** |
| `animastor-worker` | *(no package.json)* | — | — | — | — | **NOT_AN_NPM_PACKAGE** |

---

## Packages on NPM but NOT in `packages/` Git directory

| npm name | NPM latest | Notes |
|----------|------------|-------|
| `animastor-worker` | 2.1.1 | Unscoped package. The `packages/animastor-worker/` directory exists but contains scripts/tools (no `package.json`). This appears to be a separate legacy or utility package. |

---

## Private / Workspace packages (not counted as errors)

| Package | npm name | Reason |
|---------|----------|--------|
| `animastor-installer` | `@animastor/installer` | `"private": true` in `package.json`. Not intended for NPM publication. |

---

## Notes

1. **Naming inconsistency:** Two packages use unscoped names (`animastor-ai-connector`, `animastor-comfyui-workflow-connector`) while the rest use `@animastor/*` scoped names. Consider standardizing.

2. **`packages/animastor-worker/`** is not an npm package — it contains shell scripts, Docker helpers, and worker tooling. No `package.json` found.

3. **`animastor-worker` on NPM** (v2.1.1) is an unrelated unscoped package. It is not linked to the `@animastor/*` scope and has a significantly higher version number, suggesting it predates the monorepo restructuring.

4. **No version mismatches found.** Every publishable Git package that exists on NPM has its exact Git version published as `latest`.

---

## Git

```
Branch: c21.4-physically-extract-analysis-from-backend
Commit: <will be filled after commit>
```
