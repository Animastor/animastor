# Documentation Consistency Report

> **Date:** 30 August 2026
> **Scope:** Full audit and translation of Russian documentation to English
> **Author:** Buffy (AI documentation agent)

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| Total markdown files scanned | 199 |
| Files containing Russian text | ~68 |
| Files translated (this session) | 29 |
| Files remaining with Russian | ~39 |
| Estimated work remaining | ~20% of files |

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

### docs/02-orchestration/ (8 files)
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

### docs/03-audit/ (8 files)
| File | Status | Notes |
|------|--------|-------|
| `ARCHITECTURAL_AUDIT.md` | ✅ Translated | Architectural audit |
| `ARCHITECTURAL_AUDIT_TODO.md` | ✅ Translated | Audit TODO list |
| `ARCHITECTURAL_DEBT.md` | ✅ Translated | Technical debt analysis |
| `CATHEDRAL.md` | ✅ Translated | Cathedral architecture review |
| `CONFLICTING_SUBSYSTEMS.md` | ✅ Translated | Conflicting subsystems analysis |
| `DOCUMENTATION_AUDIT.md` | ✅ Translated | Documentation audit |
| `COMFYUI_CLEANUP_RECOVERY_AUDIT.md` | ✅ Translated | ComfyUI cleanup recovery |
| `COMFYUI_TEMP_FILES_CLEANUP_AUDIT.md` | ✅ Translated | ComfyUI temp files cleanup |

### docs/04-planning/ (3 files)
| File | Status | Notes |
|------|--------|-------|
| `ROADMAP_6M.md` | ✅ Translated | 6-month roadmap |
| `GOLDEN_BOOK_EVOLUTION.md` | ✅ Translated | Golden book evolution plan |
| `TXT_IMPORT_STRUCTURE_V2.md` | ✅ Translated | TXT import structure v2 |

### docs/05-frontend/ (10 files)
| File | Status | Notes |
|------|--------|-------|
| `PROGRESS_HANDOFF.md` | ✅ Translated | GPU progress frontend handoff |
| `PLAYER_STATE_MACHINE_DESIGN.md` | ✅ Translated | Player state machine design |
| `SCENE_LENGTH_REFACTOR.md` | ✅ Translated | Scene length refactoring |
| `TASK_ARCHITECTURE.md` | ✅ Translated | Task architecture (progress panel) |
| `EDITOR_ENTITY_CRUD.md` | ✅ Translated | Editor entity add/delete |
| `PLAYER_STATE.md` | ✅ Translated | Player state after regeneration |
| `PLAYER_SEEK_ENGINEERING.md` | ✅ Translated | Player unit positioning engineering |
| `PLAYER_STATE_MACHINE_T4_MANUAL_REGRESSION.md` | ✅ Translated | T4 manual regression test plan |
| `PLAYER_STATE_MACHINE_AUDIT_T6.md` | ✅ Translated | Player audit after T6 |
| `PLAYER_STATE_MACHINE_ANDROID_WEB_PARITY_AUDIT.md` | ✅ Translated | Android/Web parity audit |

### docs/06-workflows/ (3 files)
| File | Status | Notes |
|------|--------|-------|
| `UNIT_SPLIT_POST_STEP.md` | ✅ Translated | Unit split post-step |
| `WORKFLOWS.md` | ✅ Translated | Workflow system overview |
| `SCENE_PIPELINE.md` | ✅ Translated | Scene pipeline architecture |

### docs/07-agents-and-generators/ (2 files)
| File | Status | Notes |
|------|--------|-------|
| `AGENTS.md` | ✅ Translated | Agent pipeline architecture |
| `GENERATORS.md` | ✅ Translated | Generator types and interfaces |

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

### Remaining Work (43 files)

#### docs/08-mobile-web-migration/ (9 files)
- `01-MIGRATION-STRATEGY.md`, `02-DESIGN-PRESERVATION-PRINCIPLES.md`, `03-MOBILE-WEB-ARCHITECTURE.md`, `04-MAPPING-TABLES.md`, `05-SCREEN-IMPLEMENTATION-ORDER.md`, `06-RISKS-AND-ALTERNATIVES.md`, `07-MOBILE-WEB-TESTER.md`, `TODO.md`, `README.md`

#### docs/09-desktop-migration/ (2 files)
- `README.md`, `02-PROGRESS.md`

#### docs/99-archive/ (28 files)
- Archived documents — lower priority for translation

#### docs/architecture/ (4 files)
- Architecture documentation with Russian content

### Low Priority (Archive and Legacy)
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
