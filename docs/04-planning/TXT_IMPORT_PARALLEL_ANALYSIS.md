# TXT Import: Parallel / Subagent Analysis — Architecture Recon

> **Статус:** Reconnaissance + proposed architecture · подготовлено ДО реализации.
> Цель: понять текущий pipeline, выделить независимые шаги и предложить
> расширяемую модель `Task → AgentProfile → Provider/Model` для перехода от
> последовательного AI-анализа к параллельному — без поломки текущего
> Sequential-режима.
>
> **Не реализует код.** Только разведка и архитектурные решения.

---

## 0. TL;DR

- **Сейчас:** AI-pipeline TXT-импорта полностью последовательный. Один
  `agent_sessions` + последовательность `agent_steps` (analyze_structure →
  characters → voices → locations → scenes → units → visuals → reconcile →
  polish → repair). Шаги вызываются через `agent/ai-caller.js → ai-service.callAI`
  с единственным заранее разрешённым провайдером.
- **Зависимости шагов:** characters/voices/locations независимы между собой и
  могут выполняться параллельно. Scenes зависят от characters+locations. Units
  и visuals — per-scene, можно частично параллелить внутри окна, но это за
  рамками recon.
- **Можно сделать:** минимум-инвазивно параллелить шаги A (characters, voices,
  locations) на входе `runPipeline`. Sequential-режим сохраняется без изменений.
- **Нельзя использовать повторно как есть:** dispatch-engine / lease-manager /
  circuit-breaker / retry-budget-manager заточены под **scene-level GPU jobs**,
  а не под LLM-анализ текста. Их принципы (lease, idempotency, journal) —
  переносимы, код — нет.
- **Модель данных для Parallel:**
  ```
  AnalysisTask ──▶ AgentProfile ──▶ Provider (workspace / system / env)
                                       └──▶ Model (per-task override)
  ```
  4 независимых Task могут иметь один AgentProfile и один Provider, но разные
  модели — либо все шарить одну — оба варианта должны поддерживаться
  конфигурацией без правок orchestrator'а.

---

## 1. Audit: текущий pipeline

### 1.1 Входная точка

- `POST /api/v1/book/import-txt` → создаёт RAW_IMPORTED draft (lazy-book).
- `POST /api/v1/book/:bookId/bootstrap` → `txtImporter.bootstrapImportedText`
  → `agentService.bootstrapWithAgent` → `bootstrap.js:bootstrapWithAgentInner`
  → `pipelineRunner.runPipeline(sessionId, text, …)` для первого окна.
- `POST /api/v1/book/:bookId/bootstrap-next-window` → `bootstrapNextWindow`
  → пропускает шаг 0 (structure уже есть), вызывает `runPipeline` для
  следующего чанка.

См. `backend/src/routes/book/import-routes.cjs:646` (`/bootstrap`).

### 1.2 Sequence of AI steps в `runPipeline` (первое окно)

| # | Файл | step | Зависимости | Примечание |
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

## 3. Параллелизация: где именно выигрыш

### 3.1 Узкое место

`runPipeline` для первого окна последовательно делает:

```
T_struct   = время AI для analyze_structure     (~20-40s)
T_chars    = время AI для extract_characters     (~30-60s)
T_voices   = время AI для generate_voices        (~30-60s)
T_locs     = время AI для extract_locations      (~30-60s)
T_scenes   = время AI для create_scenes          (~40-90s)
T_units    = per-scene × N_scenes                (~15s × 3)
T_visuals  = per-scene × N_scenes                (~15s × 3)
T_reconcile/polish (×4)                          (~30-60s каждый)
T_repair   = final snake_case                   (~15-30s)
```

Sequential T_total ≈ 8–14 минут на окно. Параллелизация шага A
(characters/voices/locations):

```
T_a_parallel ≈ max(T_chars, T_voices, T_locs, T_struct) ≈ 30-60s
```

Экономия: ~60–120s на первом окне. На 5+ окнах это может стать существенным.

### 3.2 Что НЕ нужно трогать в первом релизе

- Per-scene units/visuals (Sequential в текущем коде, stability reasons).
- Post-processing polish/reconcile порядок.
- `stepAnalyzeStructure` — он отдельно в `bootstrap.js:106` ДО `runPipeline`,
  не блокирует наш параллелизм, можно оставить sequential.
- `stepRepairFantasyIds` — финальный sequential barrier.

---

## 4. Proposed Architecture

### 4.1 Концептуальные слои (разделение «Subagent ≠ API»)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Task                                                                   │
│   "что сделать" — функциональная единица анализа                       │
│   { id, type, dependencies, input, outputSchema, status, retryPolicy } │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ references
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ AgentProfile                                                            │
│   "кто умеет делать" — конфигурируемый профиль (system prompt + rules) │
│   { id, promptFile, examplesPath?, stepType, outputSchema }            │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ uses
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Provider + Model                                                        │
│   "через что говорить с LLM" — транспорт                               │
│   { source: 'workspace'|'system'|'env', endpoint?, apiKey?, model? }    │
└──────────────────────────────────────────────────────────────────────────┘
```

**Главное:** четыре task могут иметь:
- один и тот же `AgentProfile` + один `Provider` + одну `Model` (наш
  Sequential сегодня)
- один `AgentProfile`, разные `Provider` (например, characters — workspace,
  voices — system fallback)
- разные `AgentProfile`, разные `Provider` и `Model` (например, scenes через
  большую модель, voices через маленькую)

Orchestrator **не знает** про Provider/Model — он знает про Task. Resolution
Task→AgentProfile→Provider делает один resolver.

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

### 4.3 Минимальная архитектура для первого Parallel режима

Цель: распараллелить шаги `extract_characters` + `generate_voices` +
`extract_locations` на входе `runPipeline`, сохранив Sequential fallback.

**Новые файлы:**
- `backend/src/services/agent/analysis-workflow.js` — определение `WORKFLOW_TXT_IMPORT_V1`
- `backend/src/services/agent/analysis-scheduler.js` — DAG planner
  (topological order → batch of parallelizable tasks)
- `backend/src/services/agent/analysis-runner.js` — исполнитель batch'а:
  `Promise.allSettled` для independent tasks, write через существующие
  `createStep/completeStep/failStep`
- `backend/src/services/agent/concurrency.js` — простой семафор (без
  зависимостей; ~30 LOC; обёртка вокруг Promise queue)

**Изменения существующего кода (минимальные):**
- `pipeline-runner.js:runPipeline` → вынести шаги 1/1b/2 в `analysis-runner.js`,
  передать результат в `stepCreateScenes`.
- `agent/bootstrap.js:bootstrapWithAgentInner` — после `stepAnalyzeStructure`
  (который остаётся sequential), передать `text` в `analysis-runner` для
  параллельной фазы A.

**Конфигурация:**
- Флаг `TXT_IMPORT_PARALLEL_ANALYSIS_ENABLED` (env, default ON для dev /
  OFF для production до стабилизации).
- Static workflow definition `WORKFLOW_TXT_IMPORT_V1` — hardcoded JS-объект
  (как `PROGRESS_STAGES` сейчас). БД-схема `agent_steps` уже подходит.

### 4.4 Расширяемая архитектура (future-state)

**Когда понадобится:**
- >5 задач в workflow
- per-task provider/model routing (разные workspaces)
- динамическое добавление tasks (admin UI)

**Расширения:**
- `agent_workflows` (PG) — JSONB с версионированным workflow definition
- `agent_profiles` (PG) — AgentProfile storage
- `agent_tasks` (PG, nullable FK в `agent_steps.step_type='analysis_task'`)
- `agent_providers` (PG) — per-workspace provider routing (уже есть
  `workspace_ai_providers`)

**НЕ НУЖНО в первой итерации:**
- DB-driven workflow (hardcoded JS достаточно)
- UI редактор workflow (не нужен — конфиг через env + файлы)
- Runtime dispatch через dispatch-engine (для LLM-задач не нужен lease —
  см. §5.3)

---

## 5. Механизмы runtime: что переиспользовать, что делать своё

### 5.1 Переиспользуем **как есть**

| Механизм | Файл | Что переиспользуем |
|---|---|---|
| Provider resolution | `workspace-ai-provider.js` (`resolveAIProvider`) | purpose='agent' → resolution → AsyncLocalStorage |
| AI HTTP transport | `ai-service.callAI` | уже принимает `{ model, maxTokens, timeout, retries, provider }` |
| AI retry+parse | `agent/ai-caller.js:callAI` | `STEP_RETRIES`, exponential backoff, `parseJsonResponse` |
| Prompt loading | `agent-prompts.SYSTEM_PROMPTS`, `ai-loader.js` | Уже загружает `ai/rules/*.md` |
| Session lifecycle | `agent-session.js` (createSession/updateSession/isSessionCancelled) | Уже работает на PG |
| Step lifecycle | `agent-session.js` (createStep/completeStep/failStep) | Уже работает на PG, расширяем step_type whitelist |
| Cancellation | Redis `cancelled-workers:{book}` + `agent_sessions.status` | Тот же контракт, нужно вызывать `checkCancelled` в parallel-batch |
| Progress pub/sub | `progress-pubsub.cjs` | Расширяем payload (новый `type='analysis'`) |
| Workspace provider encryption | `workspace-ai-provider.encryptSecret/decryptSecret` | Без изменений |

### 5.2 Переиспользуем **принципы**, но НЕ код

| Из `runtime/` | Принцип | Как применяем к Parallel |
|---|---|---|
| `circuit-breaker.js` | Stop dispatching when downstream fails | Можно обернуть AI call в breaker per provider |
| `retry-budget-manager.js` | Глобальный лимит ретраев на book | Для LLM это менее релевантно (у нас уже per-step retry), но глобальный budget на book избежит «убегания» |
| `dispatch-engine.js` leases | Mutual exclusion на GPU jobs | **Не применимо** — LLM-вызовы не занимают GPU leases, конкурентность регулируется семафором |
| `reconciliation-engine.js` startup recovery | Пересоздать state на старте | Для Parallel: cleanup stale parallel tasks на startup, восстановить intermediate result из `agent_steps.result` |

### 5.3 Что **точно нужно сделать своё**

- **Concurrency control.** Нет p-limit/semaphore. ~30 LOC wrapper.
- **Per-task dependency DAG.** Существующий `dependency-graph.js` —
  про layer-regen (image/audio/video), не про agent tasks. Расширять его
  смысла нет: разные domain. Делаем **отдельный** `analysis-scheduler.js`
  с topological sort + batch grouping.
- **Partial-failure aggregation.** Sequential режим валится на первой
  ошибке. Parallel должен решать: какие tasks optional, какие mandatory,
  какие fallback'ить на deterministic (как `buildFallbackScenes`).
- **Intermediate result persistence.** Чтобы crash не терял результат
  characters — сохраняем `agent_steps.result` сразу после каждой task
  (через существующий `completeStep`).

---

## 6. API/Config recommendations

### 6.1 Public API — НЕ менять

Существующие routes остаются без правок:
- `POST /api/v1/book/import-txt` (RAW_IMPORTED)
- `POST /api/v1/book/:bookId/bootstrap` (run analysis)
- `POST /api/v1/book/:bookId/bootstrap-next-window` (continue)
- `GET /api/v1/book/:bookId/agent-status` (poll для UI)

### 6.2 SSE payload — additive расширение

Добавляем в publishProgress новое событие:
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

Frontend может игнорировать это событие (back-compat) или показать новый
"2/4 tasks completed" indicator.

### 6.3 Config — env + hardcoded workflow

- `TXT_IMPORT_PARALLEL_ANALYSIS_ENABLED` (env, bool) — kill switch для
  всей Parallel-фичи, default ON в dev / OFF в prod до стабилизации.
- `TXT_IMPORT_PARALLEL_MAX_CONCURRENCY` (env, int, default 3) — per-book
  concurrency limit (для rate-limit handling).
- `TXT_IMPORT_PARALLEL_TASK_TIMEOUT_MS` (env, int, default 180000) —
  per-task timeout (override 180s дефолт `ai-caller`).
- `WORKFLOW_TXT_IMPORT` — hardcoded JS-объект (как `PROGRESS_STAGES`).
  Никакой DB в первой итерации.

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

Resolution в `agent-bootstrap.js`:
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

## 7. Файлы, которые нужно будет изменить / создать

### 7.1 Создать (новые)

| Файл | Назначение | LOC est. |
|---|---|---|
| `backend/src/services/agent/concurrency.js` | Простой семафор (Promise-queue) | ~30 |
| `backend/src/services/agent/analysis-workflow.js` | Definition of `WORKFLOW_TXT_IMPORT_V1` (hardcoded DAG) | ~80 |
| `backend/src/services/agent/analysis-scheduler.js` | Topological sort → batch grouping → plan | ~100 |
| `backend/src/services/agent/analysis-runner.js` | Executor: per-batch `Promise.allSettled` + cancellation + write to PG | ~150 |
| `docs/04-planning/TXT_IMPORT_PARALLEL_ANALYSIS.md` | **Этот документ** | — |

### 7.2 Изменить (минимально-инвазивно)

| Файл | Изменение |
|---|---|
| `backend/src/services/agent/pipeline-runner.js` | Заменить sequential-блок шагов 1/1b/2 на вызов `analysis-runner.runBatch({ phase: 'extract-entities', text, existingChars })`. Возвращаемая форма должна быть совместима с существующим `stepCreateScenes` (character/locations/mentions). |
| `backend/src/services/agent/bootstrap.js` | После `stepAnalyzeStructure` (всё ещё sequential), передать `text` в новый orchestrator. Никаких других правок. |
| `backend/src/services/agent-prompts.js` | Добавить `STEP_RETRIES_PER_TASK` опционально (default 3). Никаких других правок. |
| `backend/src/services/agent/ai-caller.js` | **Минимально:** добавить параметр `cancelledChecker` (async fn) в `callAI`, чтобы проверять между retry-iterations. Альтернатива: вызывающий код сам делает `checkCancelled` между task'ами. Рекомендую второе. |
| `backend/src/storage/postgres/schema.js` | Расширить `agent_steps.step_type` CHECK constraint: добавить `analyze_scenes`, `analyze_voices` (если ещё нет). **Без миграции данных** — constraint уже поддерживает `IF NOT EXISTS`. |
| `backend/src/config/runtime-config.js` | Новые env flags (`TXT_IMPORT_PARALLEL_*`). |

### 7.3 НЕ менять

- `backend/src/runtime/*` — всё про GPU jobs. Не наш домен.
- `backend/src/orchestration/orchestrator.js` и `scene-orchestrator.js` —
  scene-level lifecycle, не agent-task lifecycle.
- `backend/src/dependency-graph.js` — про layer-regen (image/audio/video),
  не agent tasks.
- Существующие шаги `pipeline-steps.js` — переиспользуем без правок.
- Frontend — additive расширение SSE payload. Старые клиенты игнорируют
  новые поля.

---

## 8. Risks & Edge Cases

### 8.1 Concurrency

- **Rate limiting на API:** workspace provider может иметь rate-limit.
  Semaphore `maxConcurrency=3` снижает риск, но не убирает. Нужен
  backoff/retry (уже есть в `ai-service.callAI`). В перспективе — circuit
  breaker per provider.
- **Sequential-mode side-effects:** characters merge зависит от порядка
  (mentions dict записи могут shadow'ить друг друга). Parallel режим
  заменяет шаги 1/1b/2 единым batch'ом, но merge ordering внутри шагов
  должен сохраниться (sequential внутри одной task).

### 8.2 Cancellation

- **Race:** task A завершилась, task B выполняется, пользователь жмёт Stop.
  Нужно: после каждого batch completion вызвать `checkCancelled`; если
  cancelled — дропаем pending results, помечаем session cancelled,
  публикуем `import_complete` (cancelled).
- **Hang в одной task:** нужен per-task `AbortController` + timeout
  (180s default). При timeout task помечается failed, продолжаем если
  optional; иначе весь workflow fails.

### 8.3 Partial failure

- **Mandatory task fails:** весь workflow fails (как сегодня). Retry policy
  применяется (3 attempts), потом fail.
- **Optional task fails:** помечаем `agent_steps.status='failed'`,
  продолжаем с пустым/частичным результатом. Помечаем в
  `agent_sessions.window_data.partial_failures[]`.
- **Reconciliation:** при resume (`bootstrapNextWindow`) — восстановить
  `agent_steps.result` последней completed task, не перезапускать.

### 8.4 Provider failure

- Если workspace AI down, **все** параллельные tasks упадут. Надёжное
  решение: **provider-aware fan-out** — каждая task знает свой provider;
  если провайдер один, failure задевает все. Это и есть желаемое поведение
  (одна модель — единая семантика).
- Multi-provider: future, не первая итерация.

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

## 9. Пошаговый план реализации (small commits)

> Каждый коммит ≤300 LOC изменений в существующем коде + новый файл ≤200 LOC.
> Каждый коммит — отдельный, откатываемый.

### Commit 1 — Foundation (this doc + base scaffolding)
- Создать `docs/04-planning/TXT_IMPORT_PARALLEL_ANALYSIS.md` (этот документ).
- Создать `backend/src/services/agent/concurrency.js` — простой семафор
  (no dependencies). Тесты: ~5 unit-tests.
- **No behavior change.**

### Commit 2 — Workflow definition (no runner)
- Создать `backend/src/services/agent/analysis-workflow.js` с
  `WORKFLOW_TXT_IMPORT_V1`. Hardcoded JS-объект, тот же набор шагов, что
  сейчас. Только definition, **no executor**.
- Тесты: snapshot of `WORKFLOW_TXT_IMPORT_V1`.

### Commit 3 — Scheduler (DAG → batches)
- Создать `backend/src/services/agent/analysis-scheduler.js`. Topological
  sort + batch grouping. **НЕ вызывает** AI, только строит план.
- Тесты: 4-5 unit-tests на разных DAG-формах (linear, diamond, fan-out).
- **No behavior change.**

### Commit 4 — Runner (sequential execution via new path)
- Создать `backend/src/services/agent/analysis-runner.js`. Executor берёт
  план от scheduler и запускает tasks **sequentially** (maxConcurrency=1).
  Использует существующий `ai-caller.callAI` + `agent-session.createStep/completeStep/failStep`.
- Тесты: 4 unit-tests на mock-AI-call (success / fail / retry / cancel).
- **No behavior change** — sequential execution = текущий pipeline.

### Commit 5 — Wire in (parallel=off, flag-gated)
- Подключить orchestrator в `pipeline-runner.js`: шаги 1/1b/2
  заменяются вызовом `analysis-runner.runBatch(phase='extract-entities')`.
- Флаг `TXT_IMPORT_PARALLEL_ANALYSIS_ENABLED=false` (default) → orchestrator
  использует maxConcurrency=1 = sequential.
- Расширить `agent_steps.step_type` whitelist.
- Тесты: integration test TXT-import с flag=off, должен пройти ровно
  как раньше.

### Commit 6 — Parallel enable
- maxConcurrency=3 по умолчанию при flag=on.
- Тесты: integration test TXT-import с flag=on, проверка:
  - 3 параллельных AI calls (mock delays)
  - character/voice/location результаты идентичны sequential
  - cancellation работает
  - 1 task fail (optional) — workflow продолжается

### Commit 7 — Progress event extension
- Добавить publishProgress с `type='analysis'` events.
- Frontend (опционально): progress bar "2/4 tasks completed".
- **Back-compat:** старый UI игнорирует новый тип.

### Commit 8 — Recovery semantics
- При resume (bootstrapNextWindow): если parallel tasks уже completed
  в прошлой сессии — пропускаем, не перезапускаем.
- reconcile: cleanup stale parallel tasks on startup.

### Commit 9 — Observability
- Метрики: `analysis_tasks_completed_total`, `analysis_tasks_failed_total`,
  `analysis_batch_duration_seconds`.
- Tests: 1 chaos test (random task fail).

### Commit 10 (future) — Per-task provider routing
- AgentProfile config (file-based или DB), provider override per task.
- Только после стабилизации базового Parallel.

---

## 10. Test strategy

### 10.1 Unit tests

- `concurrency.js`: семафор acquire/release, FIFO ordering, max N.
- `analysis-scheduler.js`: topological sort correctness; cycle detection;
  batch grouping.
- `analysis-runner.js`: mock AI calls; success / fail / retry / cancel.

### 10.2 Integration tests

- **Sequential back-compat:** `TXT_IMPORT_PARALLEL_ANALYSIS_ENABLED=false` →
  бутстрап импорта produces same result как до изменений (snapshot test
  на fixtures). Это критический backstop — если sequential mode ломается,
  CI должен это поймать.
- **Parallel equivalence:** с flag=on, сравнить character/locations/voices
  extraction на тех же fixtures. Параллельный режим может давать
  недетерминированные результаты из-за race на merge order → использовать
  fuzzy-match на множествах, не exact-equality.
- **Cancellation:** запустить import, на середине cancel → должен
  остановиться, померить cancelled state в `agent_sessions`.

### 10.3 Manual smoke

- Реальный TXT import (RU, ~5 глав) с flag=off и flag=on — визуально
  сравнить chapters/scenes/characters/locations.
- Метрики wall-clock: parallel должен быть на 60-120s быстрее на 1-м окне.

### 10.4 Что НЕ нужно тестировать (первая итерация)

- Multi-provider routing (будущая фича).
- Dynamic workflow definition (будет hardcoded).
- Cross-book parallelism (всё ещё serial — `book_id → CANCELLED` tombstone).

---

## 11. Что НЕ нужно делать на первом этапе

> **Out of scope для commit'ов 1-9.** Явно фиксируем, чтобы не
> «расползтись».

| Не делаем | Почему |
|---|---|
| Multi-workspace parallel orchestration | Один book = один run. Параллелизм внутри **одного** book_id, не между book_id. |
| Per-scene parallel units/visuals | Стабильность coverage/source_offsets. Отдельная задача, за пределами recon. |
| DB-driven workflow definition | Hardcoded JS — достаточно. DB добавляет сложность без явной выгоды на этом этапе. |
| Multi-provider per-task routing | У большинства users один workspace AI. Сначала Parallel-с-одним-провайдером, потом routing. |
| UI «tasks completed» indicator | Только если пользователи попросят. Back-compat важнее красоты. |
| Полный рефакторинг orchestrator.js / dispatch-engine.js | Не наш домен. AI-task scheduling ≠ GPU-job scheduling. |
| Замена AsyncLocalStorage на другой context | Работает, не трогаем. |
| Новые AI providers (multi-modal, multi-API) | Уже поддержано через workspace-ai-provider. Наш слой не зависит от конкретного provider. |
| Dynamic step retry budget per task | Используем существующий `STEP_RETRIES=3`. |
| Subagent self-reflection / quality loops | Это уже существует как `polish_*` шаги. Не часть Parallel-orchestrator. |
| Замена `pipeline-steps.js` | Переиспользуем **as-is**. Только добавляем обёртку. |
| Изменения публичного API | Никаких breaking changes в routes/SSE. |

---

## 12. Open questions

1. **Tasks batching внутри окна:** может ли `stepAnalyzeStructure` идти
   параллельно с extract-characters? Сейчас он sequential ДО runPipeline.
   Выигрыш мал, риск есть — **оставляем sequential**.

2. **Voices / locations merge ordering:** если characters завершится ПОСЛЕ
   voices (parallel race), нужно ли retry voices? **Нет** — voices
   идемпотентен (override weak voice). Merge order зафиксирован в
   `mergeCharacterLists` post-merge, а не в order of completion.

3. **Test coverage для Parallel mode:** какой baseline использовать?
   Рекомендую `data/seed-fixtures/` (если есть) или создать в commit 5
   synthetic fixtures с известным ground-truth.

4. **Reconciliation при Parallel partial failure:** если characters OK,
   locations failed (optional), scenes стартует с пустым locations →
   scenes AI должен сам извлечь environment. Текущий pipeline
   обрабатывает это (см. `mergeCharacterLists` skipGeneric).

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