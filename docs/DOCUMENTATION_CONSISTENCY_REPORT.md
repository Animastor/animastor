# Documentation Consistency Report

> **Date:** 30 August 2026
> **Scope:** Full audit and translation of Russian documentation to English
> **Author:** Buffy (AI documentation agent)

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| Total markdown files scanned | 199 |
| Files containing Russian text | 111 |
| Files translated (this session) | 14 |
| Files remaining with Russian | ~97 |
| Estimated work remaining | ~85% of files |

---

## Language Distribution (Pre-Translation)

| Category | Files | Description |
|----------|-------|-------------|
| **EN** (pure English) | 88 | Already in English, no changes needed |
| **MIXED_LIGHT** (<30% RU) | 13 | Minor Russian phrases, mostly English |
| **MIXED_HEAVY** (30-70% RU) | 85 | Significant Russian content mixed with English |
| **RU** (mostly Russian) | 13 | Predominantly Russian, requires full translation |

---

## Files Translated This Session

### Root-Level Documentation
| File | Status | Notes |
|------|--------|-------|
| `ARCHITECTURE.md` | ✅ Translated | Domain map and repository layout |
| `MEMORY.md` | ✅ Translated | GPU instance work notes |

### docs/01-overview/ (5 files)
| File | Status | Notes |
|------|--------|-------|
| `ARCHITECTURE.md` | ✅ Translated | Backend architecture, components, dependencies |
| `DATA_FLOW.md` | ✅ Translated | 11 data flow scenarios |
| `PROJECT_STRUCTURE.md` | ✅ Translated | File tree with module descriptions |
| `SYSTEM_MAP.md` | ✅ Translated | Current system state map |
| `SYSTEM_OVERVIEW.md` | ✅ Translated | Subsystems, use cases, data flow |

### docs/02-orchestration/ (7 files)
| File | Status | Notes |
|------|--------|-------|
| `ORCHESTRATION.md` | ✅ Translated | Single orchestration document |
| `ORCHESTRATION_TODO.md` | ✅ Translated | Consolidated TODO status |
| `AUDIO_ORCH_ARCHITECTURAL_FIXES.md` | ✅ Translated | Audio orchestration architectural fixes |
| `AUDIO_ORCH_ARCHITECTURAL_TODO.md` | ✅ Translated | Audio orchestration migration TODO |
| `AUDIO_VIDEO_SYNC.md` | ✅ Translated | Audio/video synchronization |
| `ORCHESTRATION_AUDIT_2026-07-27.md` | ✅ Translated | Orchestration system audit |
| `ORCHESTRATION_FOLLOWUP_REVIEW_2026-07-27.md` | ✅ Translated | Follow-up review of recent commits |
| `VIDEO_ORCHESTRATION.md` | ✅ Translated | Video orchestration architecture |

---

## Terminology Unification

### Key Terms Standardized

| Russian Term | English Standard | Usage |
|--------------|------------------|-------|
| воркер | worker | GPU compute worker |
| сцена | scene | Generation unit |
| чанк | chunk | Audio/video segment |
| оркестратор | orchestrator | Lifecycle state manager |
| диспетчер | dispatcher / dispatch engine | Task scheduling |
| коннектор | connector | Declarative task description |
| провайдер | provider | AI API provider |
|.workspace | workspace | User/project container |
| ключ | key | Redis key |
| очередь | queue | Job queue |
| аренда | lease | Dispatch lease |
| квота | quota | Backpressure quota |
| размыкатель цепи | circuit breaker | Error threshold breaker |
| бюджет повторов | retry budget | Retry attempt limiter |
| fairness engine | fairness engine | Anti-starvation |
|.elapsed | elapsed | Time measurement |

### Component Names Preserved

All component names, API endpoints, CLI commands, class names, file paths,
environment variables, model names, and architectural terms were preserved
as-is in the translation. Examples:

- `orchestrator.js`, `scene-orchestrator.js`, `dispatch-engine.js`
- `POST /api/v1/book/import-txt`
- `ANIMASTOR_WORKER_TOKEN`, `GPU_HUB_API_KEY`
- `qwen3-32b`, `LTX 2.3`
- `MobileShell`, `DesktopShell`
- `animastor:asset-state:*`, `animastor:queue:{type}`

---

## Issues Found

### 1. Inconsistent Terminology (Pre-Translation)
- "agent" vs "AI agent" vs "LLM agent" — standardized to "AI agent"
- "воркер" vs "worker" vs "GPU worker" — standardized to "worker" / "GPU worker"
- "сцена" vs "scene" vs "generation unit" — standardized to "scene"

### 2. Broken Relative Links
Some relative links between markdown files may need updating after translation:
- `docs/02-orchestration/GPU_HUB_CLEANUP.md` → referenced in ORCHESTRATION.md
- `docs/05-frontend/TASK_ARCHITECTURE.md` → referenced in follow-up review

### 3. Code Blocks Preserved
All code blocks, commands, identifiers, paths, API names, and model names
were preserved unchanged during translation. This includes:
- Redis key patterns (`animastor:asset-state:*`)
- SQL queries
- JavaScript code snippets
- Shell commands
- JSON structures

### 4. Russian in AI Rules/Skills
Several files in `backend/ai/rules/` contain minor Russian text (2-6%):
- `units.md` (6.0% RU)
- `structure.md` (3.5% RU)
- `locations.md` (3.2% RU)
- `characters.md` (2.2% RU)
- `fantasy_snake_repair.md` (2.0% RU)

These are AI prompt files and should be translated carefully to preserve
prompt engineering intent.

---

## Remaining Work

### High Priority (Core Documentation)
- `docs/03-audit/` — 20+ files with Russian content
- `docs/04-planning/` — 15+ files with Russian content
- `docs/05-frontend/` — 12+ files with Russian content
- `docs/07-agents-and-generators/` — 12+ files with Russian content

### Medium Priority (Supporting Documentation)
- `docs/06-workflows/` — 7 files with Russian content
- `docs/08-mobile-web-migration/` — 9 files with Russian content
- `docs/09-desktop-migration/` — 3 files with Russian content
- `docs/architecture/` — 10+ files with Russian content

### Low Priority (Archive and Legacy)
- `docs/99-archive/` — 20+ files with Russian content (archived, lower priority)
- `docs/CHANGELOG.md` — 60% Russian, 23k words (massive, defer)
- `docs/VISION.md` — 79.5% Russian (defer)
- `docs/Animastor_Близкие_горизонты.md` — 67% Russian (defer)

### Backend AI Files
- `backend/ai/ai-assistant-profile.md` — 79% Russian
- `backend/ai/rules/*.md` — 2-6% Russian (minor)

### Worker Files
- `worker/new/MEMORY.md` — 57.5% Russian
- `worker/new/SYSTEM.md` — 36.3% Russian

---

## Recommendations

1. **Continue systematic translation** starting with docs/03-audit/ and docs/04-planning/
2. **Defer CHANGELOG.md** — at 23k words, it's a massive translation effort; consider
   translating only recent entries
3. **Defer docs/99-archive/** — archived documents may not need translation
4. **Translate backend/ai/ rules carefully** — these are AI prompts where
   Russian terms may have specific meaning
5. **Verify links** after all translations complete
6. **Run final consistency check** with the audit script

---

## Audit Script

The Python audit script at `scripts/translate_docs.py` can be re-run at any time
to verify translation progress:

```bash
python3 scripts/translate_docs.py
```

This will produce an updated language distribution report showing remaining
Russian content.
