# TXT Import: Parallel / Subagent Analysis — Architecture Recon

> **Status:** Reconnaissance + proposed architecture · prepared BEFORE implementation.
> Goal: understand current pipeline, identify independent steps and propose
> extensible model `Task → AgentProfile → Provider/Model` for transitioning from
> sequential AI analysis to parallel — without breaking current
> Sequential mode.
>
> **No code implementation.** Only reconnaissance and architectural decisions.

---

## 0. TL;DR

- **Current:** TXT-import AI-pipeline fully sequential. Single
  `agent_sessions` + sequence of `agent_steps` (analyze_structure →
  characters → voices → locations → scenes → units → visuals → reconcile →
  polish → repair). Steps called via `agent/ai-caller.js → ai-service.callAI`
  with single pre-resolved provider.
- **Step dependencies:** characters/voices/locations independent of each other and
  can run in parallel. Scenes depend on characters+locations. Units
  and visuals — per-scene, partially parallelizable within window, but
  outside recon scope.
- **Can be done:** minimally invasive parallelization of steps A (characters, voices,
  locations) at `runPipeline` entry. Sequential mode preserved unchanged.
- **Cannot reuse as-is:** dispatch-engine / lease-manager /
  circuit-breaker / retry-budget-manager designed for **scene-level GPU jobs**,
  not LLM text analysis. Their principles (lease, idempotency, journal) —
  transferable, code — not.
- **Data model for Parallel:**
  ```
  AnalysisTask ──▶ AgentProfile ──▶ Provider (workspace / system / env)
                                       └──▶ Model (per-task override)
  ```
  4 independent Tasks can share one AgentProfile and one Provider, but different
  models — or all share one — both options must be supported
  by configuration without orchestrator changes.

---

## 1. Audit: current pipeline

### 1.1 Entry point

- `POST /api/v1/book/import-txt` → создаёт RAW_IMPORTED draft (lazy-book).
- `POST /api/v1/book/:bookId/bootstrap` → `txtImporter.bootstrapImportedText`
  → `agentService.bootstrapWithAgent` → `bootstrap.js:bootstrapWithAgentInner`
  → `pipelineRunner.runPipeline(sessionId, text, …)` для первого окна.
- `POST /api/v1/book/:bookId/bootstrap-next-window` → `bootstrapNextWindow`
  → пропускает шаг 0 (structure уже есть), вызывает `runPipeline` для
  следующего чанка.

См. `backend/src/routes/book/import-routes.cjs:646` (`/bootstrap`).

### 1.2 Sequence of AI steps in `runPipeline` (first window)

| # | File | step | Dependencies | Note |
|---|---|---|---|---|
| 0 | bootstrap.js | `stepAnalyzeStructure` | только `text` | Возвращает `author/title/parts/segments`. Сохраняется в `window_data.structure`. |
| 1 | pipeline-runner.js:372 | `stepExtractCharacters` | `text` | `result.characters`, `result.mentions`. |
| 1b | pipeline-runner.js:403 | `stepGenerateVoices` | `characters` (после шага 1) | Override voice на новых персонажах. **Опережает `locations` по контракту**, но обе ветки можно выпустить параллельно, если передать characters как input, а не использовать как цепочку. |
| 2 | pipeline-runner.js:414 | `stepExtractLocations` | `text` + `characters` | Технически нужны character ids для mentions, но merge в шаге 3 сцен. Можно ослабить зависимость — locations только получает список существующих char ids. |
| 3 | pipeline-runner.js:478 | `stepCreateScenes` | `characters`, `locations` | Возвращает сцены с environment-overrides. |
| 4 | pipeline-steps.js:437 | `stepCreateUnits` | `scene`, `characters` | Per-scene, **последовательно по сценам в окне**. |
| 5 | pipeline-steps.js:1080 | `stepCreateVisuals` | `scene`, `units`, `characters`, `locations`, `nextScene?` | Per-scene, последовательно. |
| 6a | pipeline-steps.js:653 | `stepReconcilePassports` | `allVisualUnits`, `characters` | Window-level, один проход. |
| 6b | pipeline-steps.js:754 | `stepReconcileVideoActions` | `allVisualUnits`, `characters` | Window-level. |
| 7a | pipeline-steps.js:850 | `stepPolishStoryboard` | `allVisualUnits`, `characters`, `locations` (≥ 2 units) | Window-level. |
| 7b | pipeline-steps.js:982 | `stepPolishVideoActions` | `allVisualUnits`, `characters`, `locations` (≥ 2) | Window-level. |
| — | pipeline-steps.js:1490 | `stepRepairFantasyIds` | `allVisualUnits`, `characters`, `locations` | Финальный барьер. |

Между шагами 1/1b/2/3/4/5/6/7 стоят `await checkCancelled()` — отмена
пробрасывается через Redis + PG (`animastor:cancelled-workers:{bookId}`,
`agent_sessions.status='cancelled'`). Контракт отмены должен сохраниться при
параллелизации.

### 1.3 AI transport

- **Resolution:** `agent/bootstrap.js:47` вызывает
  `workspaceAiProvider.resolveAIForBook(bookId)` → возвращает
  `{ source, provider, endpoint, apiKey, model, workspaceId, purpose }`.
  Существует уже purpose-aware API: `resolveAIProvider(workspaceId, 'agent')`
  (`workspace-ai-provider.js:462`). Это — наш hook для будущего per-task
  routing.
- **AsyncLocalStorage:** `agent/ai-caller.js:17` — `runWithProvider(provider, fn)`
  оборачивает весь pipeline. `callAI` берёт provider из context, иначе из
  `options.provider`, иначе env fallback.
- **Transport:** `ai-service.callAI(messages, options, provider)` —
  POST на `${baseUrl}/chat/completions` с `Bearer ${apiKey}` (AES-GCM
  encryption для workspace, kill-switch для system AI). maxRetries=3
  (`ai-service.js:51`); per-step retry `STEP_RETRIES=3` (`agent-prompts.js:21`)
  в `ai-caller.js:38`. timeout=180s по умолчанию, maxTokens=2048.
- **Concurrency:** отсутствует. `dispatch-engine` использует Redis-атомики
  (Lua quota, NX lease), но это для GPU scene-jobs, не для LLM. p-limit /
  semaphore не подключены.

### 1.4 Lifecycle в PG

| Таблица | Поля | Что нам даёт |
|---|---|---|
| `agent_sessions` | `session_id`, `book_id`, `status` (running/paused/completed/failed/cancelled), `progress_msg`, `window_data` | **уже подходит** для параллельного режима: один session = один run. |
| `agent_steps` | `step_id`, `step_type` (whitelist с analyze_characters/analyze_locations/generate_voices), `status`, `result`, `error`, `started_at`, `finished_at` | **уже подходит** для per-task lifecycle. Step types для Parallel нужно расширить whitelist (`analyze_scenes` отсутствует). |
| `agent_conversations` / `agent_messages` | prompt/response log per step | **переиспользуем без правок** для каждой sub-task. |

Whitelist step_type сейчас:
`analyze_structure, analyze_characters, analyze_locations, create_scenes,
enrich_scenes, create_units, create_visual_prompts,
collect_character_candidates, resolve_character_mentions, generate_voices,
polish_storyboard, reconcile_passports, reconcile_video_actions,
polish_video_actions, repair_fantasy_snakes`
(`storage/postgres/schema.js:505`).

Замечание: для текущего кода в `pipeline-steps.js` создание steps
осуществляется через `createStep/completeStep/failStep`, но **большинство
существующих step-функций НЕ вызывают `createStep`** — это исторически
неполное покрытие. Можно использовать для будущего Parallel уже существующий
API, расширив coverage.

### 1.5 Cancellation flow

Три уровня (`pipeline-runner.js:295`):
1. `isSessionCancelled(sessionId)` — session.status='cancelled'
2. `isBookCancelled(bookId)` — любая сессия книги cancelled
3. Redis `animastor:cancelled-workers:{bookId}` sismember 'vbook'

Parallel orchestrator должен вызывать `checkCancelled()` между этапами и
**между запуском каждой task** (на старте task — тоже чек; на завершении —
ещё чек).

### 1.6 Progress pub/sub

`backend/src/services/progress-pubsub.cjs` — Redis publish в
`animastor:progress:{bookId}`. Frontend уже читает и рендерит
`{ type: 'vbook', stage, message, scene_index, total_scenes, window_scene_index, window_total_scenes, … }`.

Для Parallel нам достаточно добавить новое поле в payload, например
`{ type: 'analysis', task: 'characters', status: 'running' | 'completed',
total_tasks, completed_tasks }` — чтобы UI мог показать "2/4 tasks completed"
без ломки существующего vbook-progress события.

---

## 2. Dependency Graph текущих analysis tasks

```
[text] ──┬──▶ stepAnalyzeStructure ──────▶ window_data.structure
         │
         ├──▶ stepExtractCharacters ──┐
         │                            │
         ├──▶ stepGenerateVoices ◀────┤  (voices depends on characters)
         │                            │
         ├──▶ stepExtractLocations ◀──┤  (locations знает про character ids,
         │                            │   но merge реально происходит в step 3)
         │                            │
         │   ┌────────────────────────┴────────────┐
         │   ▼                                     ▼
         │ stepCreateScenes ──▶ scenes[]     (per-window)
         │       │
         │       ▼
         │ stepCreateUnits  ─▶ units[]  (per-scene, последовательно)
         │       │
         │       ▼
         │ stepCreateVisuals ─▶ visualUnits[] (per-scene, последовательно)
         │       │
         │       ▼
         │ stepReconcilePassports  ┐
         │ stepReconcileVideoActions├─▶ все window-level, могут идти
         │ stepPolishStoryboard    │   в любом порядке после visuals,
         │ stepPolishVideoActions  ┘   но зависят друг от друга по данным
         │       │
         │       ▼
         └─▶ stepRepairFantasyIds (финальный барьер)
```

### 2.1 Независимые ветки на входе

Три задачи, которые могут выполняться параллельно без потери качества
(порядок сейчас: characters → voices → locations, но **нет зависимости по
данным между ними** кроме того, что voices ожидает список персонажей):

| Task | Input | Output |
|---|---|---|
| `extract_characters` | `text` | `characters[]`, `mentions{}` |
| `generate_voices` | `text`, `characters[]` (от предыдущего шага) | `voices{}` override per character |
| `extract_locations` | `text`, `characters[]` (id-list для ссылок) | `locations[]` |
| `analyze_structure` | `text` (первые ~80 строк) | `structure` |

Реальные технические зависимости:

- **characters → voices**: voices использует character_ids. Если опустить —
  голоса не смогут ссылаться на персонажей. Но pipeline уже имеет
  `mergeCharacterLists` (учитывает placeholder-skipping); практически шаги
  можно запустить параллельно, если передать characters **как предварительный
  список**, даже если он ещё обогащается параллельной задачей. Простое решение:
  - characters финиширует → pipeline получает финальный набор.
  - voices финиширует → мерджится поверх (override weak/generic voice).
  - Альтернатива: voices стартует параллельно, используя черновой
    placeholder-список (existing_chars), обогащает результат characters когда
    тот придёт. Более сложная логика.

- **locations → scenes**: scenes нужен и `characters[]`, и `locations[]`. Это
  жёсткая зависимость. Поэтому scenes — sequential **после** параллельной
  тройки.

### 2.2 Per-scene зависимости (внутри окна)

Создание units и visuals сейчас строго последовательно по сценам. Это даёт
стабильные `scene_index/unit_index` для reconciliation. Parallelism per-scene
внутри одного окна — отдельная задача, **выходит за рамки текущего recon**.

### 2.3 Post-processing (window-level)

Все 4-5 постпроцессинговых шагов работают на финальном наборе
`enrichedScenes`. Они независимы по входу, но:
- `ReconcilePassports` пишет `image.prompt`, потом
- `ReconcileVideoActions` пишет `video.action`,
- `PolishStoryboard` снова трогает `image.prompt`,
- `PolishVideoActions` снова трогает `video.action`,
- `stepRepairFantasyIds` — финальный барьер.

Порядок важен: image-шаги → video-шаги → repair. Этот уровень лучше
оставить Sequential в первой итерации. **За рамками recon.**

---

## 3. Parallelization: where exactly the gain is

### 3.1 Bottleneck

`runPipeline` for first window sequentially does:

```
T_struct   = AI time for analyze_structure     (~20-40s)
T_chars    = AI time for extract_characters     (~30-60s)
T_voices   = AI time for generate_voices        (~30-60s)
T_locs     = AI time for extract_locations      (~30-60s)
T_scenes   = AI time for create_scenes          (~40-90s)
T_units    = per-scene × N_scenes                (~15s × 3)
T_visuals  = per-scene × N_scenes                (~15s × 3)
T_reconcile/polish (×4)                          (~30-60s each)
T_repair   = final snake_case                   (~15-30s)
```

Sequential T_total ≈ 8–14 minutes per window. Parallelizing step A
(characters/voices/locations):

```
T_a_parallel ≈ max(T_chars, T_voices, T_locs, T_struct) ≈ 30-60s
```

Savings: ~60–120s on first window. On 5+ windows this becomes significant.

### 3.2 What NOT to touch in first release

- Per-scene units/visuals (Sequential in current code, stability reasons).
- Post-processing polish/reconcile order.
- `stepAnalyzeStructure` — separate in `bootstrap.js:106` BEFORE `runPipeline`,
  doesn't block our parallelization, can stay sequential.
- `stepRepairFantasyIds` — final sequential barrier.

---

## 4. Proposed Architecture

### 4.1 Conceptual layers (separation "Subagent ≠ API")

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Task                                                                   │
│   "what to do" — functional analysis unit                              │
│   { id, type, dependencies, input, outputSchema, status, retryPolicy } │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ references
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ AgentProfile                                                            │
│   "who can do it" — configurable profile (system prompt + rules)       │
│   { id, promptFile, examplesPath?, stepType, outputSchema }            │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ uses
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Provider + Model                                                        │
│   "how to talk to LLM" — transport                                     │
│   { source: 'workspace'|'system'|'env', endpoint?, apiKey?, model? }    │
└──────────────────────────────────────────────────────────────────────────┘
```

**Key point:** four tasks can have:
- same `AgentProfile` + single `Provider` + single `Model` (our
  Sequential today)
- same `AgentProfile`, different `Provider` (e.g., characters — workspace,
  voices — system fallback)
- different `AgentProfile`, different `Provider` and `Model` (e.g., scenes via
  large model, voices via small model)

Orchestrator **doesn't know** about Provider/Model — it knows about Task. Resolution
Task→AgentProfile→Provider done by single resolver.

### 4.2 AnalysisWorkflow — определение

```ts
interface AnalysisWorkflow {
  id: string;                     // "txt-import-v1"
  version: number;                // bump для safe-migration
  tasks: AnalysisTask[];
}

interface AnalysisTask {
  id: string;                     // "extract_characters"
  stepType: AgentStepType;        // для PG whitelist
  agentProfile: string;           // id профиля
  provider?: string;              // явный provider id (overrides default)
  model?: string;                 // явная модель (overrides provider default)
  input: TaskInputSpec;           // какие поля из context передавать
  output: TaskOutputSpec;         // куда писать результат
  dependencies: string[];         // ids других tasks
  retryPolicy?: RetryPolicy;
  timeoutMs?: number;
  maxTokens?: number;
  optional?: boolean;             // failure не валит весь run
}

interface RetryPolicy {
  maxAttempts: number;            // default 3 (STEP_RETRIES)
  baseDelayMs: number;            // default 2000 (ai-caller)
  backoff?: 'linear' | 'exponential';
}

interface AgentProfile {
  id: string;                     // "character-extractor"
  promptFile: string;             // ai/rules/<file>.md
  examplesPath?: string;          // ai/examples/<dir>/...
  outputSchema: string;           // имя схемы для validation
}

interface TaskInputSpec {
  from: ('text' | 'windowText' | 'characters' | 'locations' |
         'scenes' | 'units' | 'visuals')[];
}

interface TaskOutputSpec {
  writes: ('characters' | 'locations' | 'mentions' | 'voices' |
           'scenes' | 'structure' | 'units' | 'visuals')[];
}
```

**Текущий Sequential pipeline** = `AnalysisWorkflow` со всеми
`dependencies: [...]` указывающими на единственный предыдущий шаг. Никаких
правок orchestrator'а — тот же код, просто `dependency-aware scheduler`.

### 4.3 Minimal architecture for first Parallel mode

Goal: parallelize `extract_characters` + `generate_voices` +
`extract_locations` at `runPipeline` entry, preserving Sequential fallback.

**New files:**
- `backend/src/services/agent/analysis-workflow.js` — `WORKFLOW_TXT_IMPORT_V1` definition
- `backend/src/services/agent/analysis-scheduler.js` — DAG planner
  (topological order → batch of parallelizable tasks)
- `backend/src/services/agent/analysis-runner.js` — batch executor:
  `Promise.allSettled` for independent tasks, write via existing
  `createStep/completeStep/failStep`
- `backend/src/services/agent/concurrency.js` — simple semaphore (no
  dependencies; ~30 LOC; Promise queue wrapper)

**Existing code changes (minimal):**
- `pipeline-runner.js:runPipeline` → extract steps 1/1b/2 to `analysis-runner.js`,
  pass result to `stepCreateScenes`.
- `agent/bootstrap.js:bootstrapWithAgentInner` — after `stepAnalyzeStructure`
  (remains sequential), pass `text` to `analysis-runner` for
  parallel phase A.

**Configuration:**
- Flag `TXT_IMPORT_PARALLEL_ANALYSIS_ENABLED` (env, default ON for dev /
  OFF for production until stabilized).
- Static workflow definition `WORKFLOW_TXT_IMPORT_V1` — hardcoded JS object
  (like `PROGRESS_STAGES` currently). DB schema `agent_steps` already suitable.

### 4.4 Extensible architecture (future-state)

**When needed:**
- >5 tasks in workflow
- per-task provider/model routing (different workspaces)
  dynamic task addition (admin UI)

**Extensions:**
- `agent_workflows` (PG) — JSONB with versioned workflow definition
- `agent_profiles` (PG) — AgentProfile storage
- `agent_tasks` (PG, nullable FK in `agent_steps.step_type='analysis_task'`)
- `agent_providers` (PG) — per-workspace provider routing (already exists
  `workspace_ai_providers`)

**NOT NEEDED in first iteration:**
- DB-driven workflow (hardcoded JS sufficient)
- UI workflow editor (not needed — config via env + files)
  Runtime dispatch via dispatch-engine (LLM tasks don't need lease —
  see §5.3)

---

## 5. Runtime mechanisms: what to reuse, what to build custom

### 5.1 Reuse **as-is**

| Mechanism | File | What we reuse |
|---|---|---|
| Provider resolution | `workspace-ai-provider.js` (`resolveAIProvider`) | purpose='agent' → resolution → AsyncLocalStorage |
| AI HTTP transport | `ai-service.callAI` | already accepts `{ model, maxTokens, timeout, retries, provider }` |
| AI retry+parse | `agent/ai-caller.js:callAI` | `STEP_RETRIES`, exponential backoff, `parseJsonResponse` |
| Prompt loading | `agent-prompts.SYSTEM_PROMPTS`, `ai-loader.js` | Already loads `ai/rules/*.md` |
| Session lifecycle | `agent-session.js` (createSession/updateSession/isSessionCancelled) | Already works on PG |
| Step lifecycle | `agent-session.js` (createStep/completeStep/failStep) | Already works on PG, extend step_type whitelist |
| Cancellation | Redis `cancelled-workers:{book}` + `agent_sessions.status` | Same contract, must call `checkCancelled` in parallel-batch |
| Progress pub/sub | `progress-pubsub.cjs` | Extend payload (new `type='analysis'`) |
| Workspace provider encryption | `workspace-ai-provider.encryptSecret/decryptSecret` | No changes |

### 5.2 Reuse **principles**, but NOT code

| From `runtime/` | Principle | How applied to Parallel |
|---|---|---|
| `circuit-breaker.js` | Stop dispatching when downstream fails | Can wrap AI call in breaker per provider |
| `retry-budget-manager.js` | Global retry limit per book | Less relevant for LLM (we already have per-step retry), but global budget prevents "runaway" |
| `dispatch-engine.js` leases | Mutual exclusion on GPU jobs | **Not applicable** — LLM calls don't hold GPU leases, concurrency controlled by semaphore |
| `reconciliation-engine.js` startup recovery | Recreate state on startup | For Parallel: cleanup stale parallel tasks on startup, restore intermediate result from `agent_steps.result` |

### 5.3 What **definitely needs custom implementation**

- **Concurrency control.** No p-limit/semaphore. ~30 LOC wrapper.
- **Per-task dependency DAG.** Existing `dependency-graph.js` —
  about layer-regen (image/audio/video), not agent tasks. Extending it
  pointless: different domain. Build **separate** `analysis-scheduler.js`
  with topological sort + batch grouping.
- **Partial-failure aggregation.** Sequential mode fails on first
  error. Parallel must decide: which tasks optional, which mandatory,
  which fallback to deterministic (like `buildFallbackScenes`).
- **Intermediate result persistence.** So crash doesn't lose
  characters result — save `agent_steps.result` immediately after each task
  (via existing `completeStep`).

---

## 6. API/Config recommendations

### 6.1 Public API — don't change

Existing routes remain unchanged:
- `POST /api/v1/book/import-txt` (RAW_IMPORTED)
- `POST /api/v1/book/:bookId/bootstrap` (run analysis)
- `POST /api/v1/book/:bookId/bootstrap-next-window` (continue)
- `GET /api/v1/book/:bookId/agent-status` (poll для UI)

### 6.2 SSE payload — additive extension

Add new event to publishProgress:
```js
publishProgress(redis, bookId, {
  type: 'analysis',           // new
  workflow_id: 'txt-import-v1',
  task_id: 'extract_characters',
  status: 'running',          // running | completed | failed | skipped
  total_tasks: 4,
  completed_tasks: 1,
  window_size: 3,
  message: PROGRESS_STAGES.extracting_chars,
});
```

Frontend can ignore this event (back-compat) or show new
"2/4 tasks completed" indicator.

### 6.3 Config — env + hardcoded workflow

- `TXT_IMPORT_PARALLEL_ANALYSIS_ENABLED` (env, bool) — kill switch for
  entire Parallel feature, default ON in dev / OFF in prod until stabilized.
- `TXT_IMPORT_PARALLEL_MAX_CONCURRENCY` (env, int, default 3) — per-book
  concurrency limit (for rate-limit handling).
- `TXT_IMPORT_PARALLEL_TASK_TIMEOUT_MS` (env, int, default 180000) —
  per-task timeout (override 180s default `ai-caller`).
- `WORKFLOW_TXT_IMPORT` — hardcoded JS object (like `PROGRESS_STAGES`).
  No DB in first iteration.

### 6.4 Per-task provider/model routing (future)

```js
// backend/src/services/agent/agent-profiles.js (future)
module.exports = {
  'character-extractor-v1': {
    promptFile: 'characters.md',
    provider: 'workspace',       // default
    model: null,                 // use provider default
    outputSchema: 'CharactersV1',
  },
  'voice-generator-fast': {
    promptFile: 'voice_generation.md',
    provider: 'system',
    model: 'qwen/qwen3-8b',      // smaller model, faster
    outputSchema: 'VoicesV1',
  },
};
```

Resolution in `agent-bootstrap.js`:
```js
// parallel-future (НЕ в первой итерации)
const profile = profiles[task.agentProfile];
const provider = await resolveProviderById(profile.provider);
const callOptions = {
  model: profile.model || provider.model,
  maxTokens: task.maxTokens,
  timeoutMs: task.timeoutMs,
};
```

---

## 7. Files to change / create

### 7.1 Create (new)

| File | Purpose | LOC est. |
|---|---|---|
| `backend/src/services/agent/concurrency.js` | Simple semaphore (Promise-queue) | ~30 |
| `backend/src/services/agent/analysis-workflow.js` | Definition of `WORKFLOW_TXT_IMPORT_V1` (hardcoded DAG) | ~80 |
| `backend/src/services/agent/analysis-scheduler.js` | Topological sort → batch grouping → plan | ~100 |
| `backend/src/services/agent/analysis-runner.js` | Executor: per-batch `Promise.allSettled` + cancellation + write to PG | ~150 |
| `docs/04-planning/TXT_IMPORT_PARALLEL_ANALYSIS.md` | **This document** | — |

### 7.2 Change (minimally invasive)

| File | Change |
|---|---|
| `backend/src/services/agent/pipeline-runner.js` | Replace sequential block of steps 1/1b/2 with `analysis-runner.runBatch({ phase: 'extract-entities', text, existingChars })` call. Return shape must be compatible with existing `stepCreateScenes` (character/locations/mentions). |
| `backend/src/services/agent/bootstrap.js` | After `stepAnalyzeStructure` (still sequential), pass `text` to new orchestrator. No other changes. |
| `backend/src/services/agent-prompts.js` | Add optional `STEP_RETRIES_PER_TASK` (default 3). No other changes. |
| `backend/src/services/agent/ai-caller.js` | **Minimal:** add `cancelledChecker` parameter (async fn) to `callAI` to check between retry iterations. Alternative: calling code does `checkCancelled` between tasks. Recommend latter. |
| `backend/src/storage/postgres/schema.js` | Extend `agent_steps.step_type` CHECK constraint: add `analyze_scenes`, `analyze_voices` (if not present). **No data migration** — constraint already supports `IF NOT EXISTS`. |
| `backend/src/config/runtime-config.js` | New env flags (`TXT_IMPORT_PARALLEL_*`). |

### 7.3 Don't change

- `backend/src/runtime/*` — all about GPU jobs. Not our domain.
- `backend/src/orchestration/orchestrator.js` and `scene-orchestrator.js` —
  scene-level lifecycle, not agent-task lifecycle.
- `backend/src/dependency-graph.js` — about layer-regen (image/audio/video),
  not agent tasks.
- Existing `pipeline-steps.js` steps — reuse without changes.
  Frontend — additive SSE payload extension. Old clients ignore
  new fields.

---

## 8. Risks & Edge Cases

### 8.1 Concurrency

- **API rate limiting:** workspace provider may have rate-limit.
  Semaphore `maxConcurrency=3` reduces risk, but doesn't eliminate.
  Need backoff/retry (already in `ai-service.callAI`). Future — circuit
  breaker per provider.
- **Sequential-mode side-effects:** characters merge depends on order
  (mentions dict entries may shadow each other). Parallel mode
  replaces steps 1/1b/2 with single batch, but merge ordering within steps
  must be preserved (sequential within one task).

### 8.2 Cancellation

- **Race:** task A completed, task B running, user clicks Stop.
  Need: after each batch completion call `checkCancelled`; if
  cancelled — drop pending results, mark session cancelled,
  publish `import_complete` (cancelled).
  **Hang in one task:** need per-task `AbortController` + timeout
  (180s default). On timeout task marked failed, continue if
  optional; otherwise entire workflow fails.

### 8.3 Partial failure

- **Mandatory task fails:** entire workflow fails (as today). Retry policy
  applies (3 attempts), then fail.
- **Optional task fails:** mark `agent_steps.status='failed'`,
  continue with empty/partial result. Record in
  `agent_sessions.window_data.partial_failures[]`.
- **Reconciliation:** on resume (`bootstrapNextWindow`) — restore
  `agent_steps.result` of last completed task, don't restart.

### 8.4 Provider failure

- If workspace AI down, **all** parallel tasks fail. Reliable
  solution: **provider-aware fan-out** — each task knows its provider;
  if single provider, failure affects all. This is desired behavior
  (single model — unified semantics).
- Multi-provider: future, not first iteration.

### 8.5 Step type whitelist migration

- Существующий whitelist содержит `analyze_characters`, `analyze_locations`,
  `generate_voices` — уже подходят. Для Parallel вводим `analyze_scenes`
  (отдельно от `create_scenes`). Migration: расширить CHECK constraint
  через `ALTER TABLE … DROP/ADD CONSTRAINT` (см.
  `storage/postgres/schema.js:685` существующий паттерн).

### 8.6 Coverage / dedup

- `stepCreateScenes` сейчас retry'ит при coverage failure и падает в
  `buildFallbackScenes`. Это sequential внутри Parallel-фазы не ломает —
  scenes останется sequential. Защищаем: `stepCreateScenes` остаётся
  вызовом из `runPipeline`, **не** в Parallel-batch.

### 8.7 Memory & event-loop

- 3 параллельных AI call'а — нормально для Node.js (Promise-based).
- Никакой I/O между ними, кроме fetch. Connection pool / fetch'и
  независимы.
- Размер ответа max 8K tokens (~32KB JSON) — суммарно <100KB на batch,
  negligible.

### 8.8 Frontend regression

- Старый UI ждёт `stage='extracting_chars' → extracting_locs →
  voice_generation → creating_scenes`. В Parallel-режиме порядок событий
  может меняться (3 события parallel). Решение: новое SSE `type='analysis'`
  событие содержит `task_id`, старые vbook-события публикуются
  **вперёд** как обычно (при входе в step), `task_id` — для опционального
  прогресс-индикатора "2/4 tasks completed".

### 8.9 DB writes contention

- `agent_steps` INSERT в начале task, UPDATE на завершении. 3 параллельных
  INSERT — стандартная нагрузка для PG, не проблема.

### 8.10 Sequential режим остаётся прежним

- **Kill switch:** `TXT_IMPORT_PARALLEL_ANALYSIS_ENABLED=false` →
  orchestrator использует **тот же** sequential код. Никакого нового пути
  для существующих клиентов.
- **Back-compat agent_steps:** все шаги имеют те же `step_type` →
  существующие логи (аналитика, retry-counter) работают.

---

## 9. Step-by-step implementation plan (small commits)

> Each commit ≤300 LOC changes in existing code + new file ≤200 LOC.
> Each commit — separate, rollbackable.

### Commit 1 — Foundation (this doc + base scaffolding)
- Create `docs/04-planning/TXT_IMPORT_PARALLEL_ANALYSIS.md` (this document).
- Create `backend/src/services/agent/concurrency.js` — simple semaphore
  (no dependencies). Tests: ~5 unit-tests.
- **No behavior change.**

### Commit 2 — Workflow definition (no runner)
- Create `backend/src/services/agent/analysis-workflow.js` with
  `WORKFLOW_TXT_IMPORT_V1`. Hardcoded JS object, same step set as
  current. Definition only, **no executor**.
  Tests: snapshot of `WORKFLOW_TXT_IMPORT_V1`.

### Commit 3 — Scheduler (DAG → batches)
- Create `backend/src/services/agent/analysis-scheduler.js`. Topological
  sort + batch grouping. **Does NOT call** AI, only builds plan.
  Tests: 4-5 unit-tests on different DAG shapes (linear, diamond, fan-out).
- **No behavior change.**

### Commit 4 — Runner (sequential execution via new path)
- Create `backend/src/services/agent/analysis-runner.js`. Executor takes
  plan from scheduler and runs tasks **sequentially** (maxConcurrency=1).
  Uses existing `ai-caller.callAI` + `agent-session.createStep/completeStep/failStep`.
  Tests: 4 unit-tests on mock-AI-call (success / fail / retry / cancel).
- **No behavior change** — sequential execution = current pipeline.

### Commit 5 — Wire in (parallel=off, flag-gated)
- Connect orchestrator in `pipeline-runner.js`: steps 1/1b/2
  replaced with `analysis-runner.runBatch(phase='extract-entities')` call.
- Flag `TXT_IMPORT_PARALLEL_ANALYSIS_ENABLED=false` (default) → orchestrator
  uses maxConcurrency=1 = sequential.
- Extend `agent_steps.step_type` whitelist.
  Tests: integration test TXT-import with flag=off, must pass exactly
  as before.

### Commit 6 — Parallel enable
- maxConcurrency=3 default when flag=on.
  Tests: integration test TXT-import with flag=on, verify:
  - 3 parallel AI calls (mock delays)
  - character/voice/location results identical to sequential
  - cancellation works
  - 1 task fail (optional) — workflow continues

### Commit 7 — Progress event extension
- Add publishProgress with `type='analysis'` events.
- Frontend (optional): progress bar "2/4 tasks completed".
- **Back-compat:** old UI ignores new type.

### Commit 8 — Recovery semantics
- On resume (bootstrapNextWindow): if parallel tasks already completed
  in previous session — skip, don't restart.
  reconcile: cleanup stale parallel tasks on startup.

### Commit 9 — Observability
- Metrics: `analysis_tasks_completed_total`, `analysis_tasks_failed_total`,
  `analysis_batch_duration_seconds`.
  Tests: 1 chaos test (random task fail).

### Commit 10 (future) — Per-task provider routing
- AgentProfile config (file-based or DB), provider override per task.
  Only after basic Parallel stabilized.

---

## 10. Test strategy

### 10.1 Unit tests

- `concurrency.js`: semaphore acquire/release, FIFO ordering, max N.
- `analysis-scheduler.js`: topological sort correctness; cycle detection;
  batch grouping.
- `analysis-runner.js`: mock AI calls; success / fail / retry / cancel.

### 10.2 Integration tests

- **Sequential back-compat:** `TXT_IMPORT_PARALLEL_ANALYSIS_ENABLED=false` →
  import bootstrap produces same result as before changes (snapshot test
  on fixtures). This is critical backstop — if sequential mode breaks,
  CI must catch it.
- **Parallel equivalence:** with flag=on, compare character/locations/voices
  extraction on same fixtures. Parallel mode may produce
  non-deterministic results due to merge order race → use
  fuzzy-match on sets, not exact-equality.
- **Cancellation:** start import, cancel mid-way → must
  stop, check cancelled state in `agent_sessions`.

### 10.3 Manual smoke

- Real TXT import (RU, ~5 chapters) with flag=off and flag=on — visually
  compare chapters/scenes/characters/locations.
  Wall-clock metrics: parallel should be 60-120s faster on 1st window.

### 10.4 What NOT to test (first iteration)

- Multi-provider routing (future feature).
- Dynamic workflow definition (will be hardcoded).
  Cross-book parallelism (still serial — `book_id → CANCELLED` tombstone).

---

## 11. What NOT to do in first phase

> **Out of scope for commits 1-9.** Explicitly documented to prevent
> scope creep.

| Don't do | Why |
|---|---|
| Multi-workspace parallel orchestration | One book = one run. Parallelism within **single** book_id, not between book_id. |
| Per-scene parallel units/visuals | Stability of coverage/source_offsets. Separate task, outside recon. |
| DB-driven workflow definition | Hardcoded JS — sufficient. DB adds complexity without clear benefit at this stage. |
| Multi-provider per-task routing | Most users have single workspace AI. First Parallel-with-single-provider, then routing. |
| UI "tasks completed" indicator | Only if users request. Back-compat more important than aesthetics. |
| Full refactor of orchestrator.js / dispatch-engine.js | Not our domain. AI-task scheduling ≠ GPU-job scheduling. |
| Replace AsyncLocalStorage with other context | Works, don't touch. |
| New AI providers (multi-modal, multi-API) | Already supported via workspace-ai-provider. Our layer doesn't depend on specific provider. |
| Dynamic step retry budget per task | Use existing `STEP_RETRIES=3`. |
| Subagent self-reflection / quality loops | Already exists as `polish_*` steps. Not part of Parallel-orchestrator. |
| Replace `pipeline-steps.js` | Reuse **as-is**. Only add wrapper. |
| Public API changes | No breaking changes in routes/SSE. |

---

## 12. Open questions

1. **Tasks batching within window:** can `stepAnalyzeStructure` run
   parallel with extract-characters? Currently sequential BEFORE runPipeline.
   Gain small, risk exists — **keep sequential**.

2. **Voices / locations merge ordering:** if characters completes AFTER
   voices (parallel race), need to retry voices? **No** — voices
   idempotent (override weak voice). Merge order fixed in
   `mergeCharacterLists` post-merge, not in completion order.

3. **Test coverage for Parallel mode:** which baseline to use?
   Recommend `data/seed-fixtures/` (if exists) or create in commit 5
   synthetic fixtures with known ground-truth.

4. **Reconciliation on Parallel partial failure:** if characters OK,
   locations failed (optional), scenes starts with empty locations →
   scenes AI must extract environment itself. Current pipeline
   handles this (see `mergeCharacterLists` skipGeneric).

---

## 13. Cross-references

- `docs/architecture/architecture-map.md` §3.5 — AI agent pipeline map
- `docs/architecture/recoverable-work-set.md` §5.4b — book-level concurrency
- `docs/07-agents-and-generators/AGENTS.md` — полное описание pipeline
- `docs/04-planning/TXT_IMPORT_STRUCTURE_V2.md` — структурный анализ (фаза 0)
- `backend/src/services/agent/bootstrap.js` — текущий orchestrator
- `backend/src/services/agent/pipeline-runner.js` — текущий pipeline
- `backend/src/services/agent/pipeline-steps.js` — все step-функции
- `backend/src/services/agent/ai-caller.js` — provider context + retry
- `backend/src/services/ai-service.js` — transport layer
- `backend/src/services/workspace-ai-provider.js` — provider resolution
- `backend/src/services/agent-session.js` — lifecycle helpers
- `backend/src/storage/postgres/schema.js` — `agent_sessions`, `agent_steps`

## 11. Status — Milestone #1 implemented

The minimal vertical slice proposed in §4.3 is implemented (commits
`39bde6c0` → `4227369c`, plus this documentation update):

- `analysis_mode = sequential | parallel` lives in per-book layer-config
  with default `sequential` (backwards compatible).
- `analysis_parallelism = 1..8` (default 3) caps in-flight LLM calls
  via the existing `p-limit` dependency (no new transport).
- `backend/src/services/agent/parallel-analysis-orchestrator.js`
  orchestrates the first parallel phase; voices stays in its legacy
  sequential slot because it needs the merged character set.
- All §12 acceptance criteria pass; the §11 "не трогать пока" list was
  respected (no generic DAG engine, no scene-level parallelism, no
  marketplace, no GPU/LLM mixing). See AGENTS.md "Parallel Analysis
  Mode" for the full contract.

Next milestone candidates (out of scope for this slice): per-task
provider/model routing UI, scene-level parallelism, dynamic agent
spawning, generic DAG engine for arbitrary workflows.