// ======================================================
// Parallel Analysis Orchestrator
// ======================================================
// Lightweight task graph for the first parallel phase of TXT AI analysis.
//
// Scope (Milestone #1, Reconnaissance plan, §"Наша первая parallel-фаза"):
//
//     ┌─ extract_characters ─┐
//     │                      ├─ merge ─► existing pipeline (create scenes, ...)
//     └─ extract_locations ──┘
//                    │
//     (after extract_characters) ─► generate_voices ─► merge
//
// Notes:
//   - generate_voices DEPENDS on extract_characters (it consumes the merged
//     character set and mutates characters[i].voice). The dependency is
//     enforced by the orchestrator — voices never starts before characters
//     has completed.
//   - extract_locations does NOT depend on extract_characters: it receives
//     the EXISTING character set as a textual context (a `%EXISTING_CHARACTERS%`
//     placeholder in the prompt), but never reads the just-extracted set.
//   - This module is intentionally NOT a generic DAG engine. Adding new task
//     types or new dependency shapes requires editing the ANALYZERS table —
//     that is the design. We are proving parallel extraction works first;
//     generalisation comes later (Reconnaissance plan, §11 "Не трогать пока").
//   - The AI transport is unchanged: each analyzer ultimately calls
//     `ai-caller.callAI(...)`, which threads the AsyncLocalStorage provider
//     context set by `bootstrap.js`. One provider can serve several tasks
//     concurrently; per-task provider/model overrides are passed through the
//     analyzer's `taskOptions` (Commit 4).
//   - Cancellation is honoured through the `checkCancelled` callback supplied
//     by the pipeline runner — see parallel-analysis-orchestrator.test.js for
//     the contract tests.

const pLimit = require('p-limit');

const TASK_STATUS = Object.freeze({
    PENDING:   'pending',
    RUNNING:   'running',
    COMPLETED: 'completed',
    FAILED:    'failed',
    CANCELLED: 'cancelled',
});

/**
 * Built-in analyzer registry. Each entry describes a single AI analysis task:
 *   - id:           machine id used in logs and progress events
 *   - label:        human-readable label (Russian — matches PROGRESS_STAGES)
 *   - dependsOn:    ids of tasks that must complete first
 *   - execute(ctx): runs the analyzer; returns a result object
 *
 * `execute(ctx)` receives:
 *   {
 *     text,              window text
 *     characters,        post-merge character set (mutated by characters step)
 *     existingLocations, already-known locations from previous windows
 *     existingMentions,  alias→characterId map from previous windows
 *     language,
 *     promptProfiles,
 *     stepIndex,
 *     publishVBook,
 *     checkCancelled,
 *     sessionId,
 *     stepResults,       map: taskId → result (read-only, populated so far)
 *   }
 *
 * It MUST honour `checkCancelled()` (it throws on cancellation) and return a
 * plain object — failures are surfaced by throwing.
 */
const ANALYZERS = Object.freeze({
    characters: {
        id: 'characters',
        label: 'Извлечение персонажей',
        dependsOn: [],
        execute: async (ctx) => {
            return ctx.analyzers.stepExtractCharacters(
                ctx.sessionId,
                ctx.text,
                ctx.stepIndex,
                ctx.publishVBook,
                ctx.language,
            );
        },
    },
    locations: {
        id: 'locations',
        label: 'Извлечение локаций',
        dependsOn: [],
        execute: async (ctx) => {
            // Locations receive the EXISTING characters (pre-AI-extraction) for
            // the `%EXISTING_CHARACTERS%` context — same as the sequential path.
            return ctx.analyzers.stepExtractLocations(
                ctx.sessionId,
                ctx.text,
                ctx.characters || [],
                ctx.stepIndex,
                ctx.publishVBook,
                ctx.language,
            );
        },
    },
    voices: {
        id: 'voices',
        label: 'Генерация голосов',
        dependsOn: ['characters'],
        execute: async (ctx) => {
            if (!ctx.characters || ctx.characters.length === 0) {
                // Same rule as the sequential step: nothing to voice.
                return { voices: {} };
            }
            return ctx.analyzers.stepGenerateVoices(
                ctx.sessionId,
                ctx.text,
                ctx.characters,
                ctx.stepIndex,
                ctx.publishVBook,
                ctx.language,
                ctx.promptProfiles,
            );
        },
    },
});

/**
 * Build the plan: list of task ids in dependency order. Voices MUST come
 * after characters. Characters and locations are siblings — they will run
 * concurrently when the orchestrator schedules them.
 */
function planTasks(taskIds) {
    const tasks = [];
    const seen = new Set();
    for (const id of taskIds) {
        if (!ANALYZERS[id]) {
            throw new Error(`Unknown analysis task id: ${id}`);
        }
        if (seen.has(id)) continue;
        const t = ANALYZERS[id];
        // Append dependencies first if they are not already in the plan.
        for (const dep of t.dependsOn) {
            if (!ANALYZERS[dep]) {
                throw new Error(`Unknown dependency ${dep} for task ${id}`);
            }
            if (!seen.has(dep)) {
                tasks.push(ANALYZERS[dep]);
                seen.add(dep);
            }
        }
        if (!seen.has(id)) {
            tasks.push(ANALYZERS[id]);
            seen.add(id);
        }
    }
    return tasks;
}

/**
 * Orchestrate the parallel analysis phase.
 *
 * @param {Object} input
 * @param {string[]} input.taskIds             ids from ANALYZERS to run (default: all three)
 * @param {Object}   input.analyzers           map of step functions (stepExtractCharacters, ...)
 * @param {string}   input.sessionId
 * @param {string}   input.text                window text
 * @param {Array}    input.characters          character array (mutated by voices step)
 * @param {Array}    [input.existingLocations]
 * @param {Object}   [input.existingMentions]
 * @param {string}   input.language
 * @param {Object}   input.promptProfiles
 * @param {number}   input.stepIndex
 * @param {Function} input.publishVBook        progress publisher (side-effect free)
 * @param {Function} input.checkCancelled      async fn that throws on cancellation
 * @param {number}   [input.parallelism=3]     max concurrent AI calls (1..8)
 * @param {Function} [input.onTaskEvent]       optional hook (event, task, completed, total)
 *
 * @returns {Promise<{
 *   tasks: Array<{
 *     id, status, result?, error?, startedAt?, finishedAt?, durationMs?
 *   }>,
 *   ok: boolean,     // true if all tasks completed; false if any failed
 *   cancelled: boolean,
 *   failedTaskIds: string[],
 * }>}
 *
 * Lifecycle:
 *   pending → running → completed | failed | cancelled
 *
 * Failure isolation:
 *   - If one task fails, the orchestrator does NOT abort siblings. They keep
 *     running until they complete or fail. The caller decides what to do with
 *     partial results.
 *   - On cancellation, NEW tasks are not scheduled; in-flight tasks are not
 *     cancelled by force (the AI transport has its own retry/timeout policy) —
 *     they are simply NOT awaited past the cancellation check.
 */
async function run(input) {
    const {
        taskIds = ['characters', 'locations', 'voices'],
        analyzers,
        sessionId,
        text,
        characters,
        existingLocations,
        existingMentions,
        language,
        promptProfiles,
        stepIndex,
        publishVBook = () => {},
        checkCancelled = async () => {},
        parallelism = 3,
        onTaskEvent = null,
    } = input || {};

    if (!analyzers) {
        throw new Error('parallel-analysis-orchestrator: analyzers map is required');
    }
    if (!sessionId) {
        throw new Error('parallel-analysis-orchestrator: sessionId is required');
    }

    const plan = planTasks(taskIds);
    const limitN = _clampParallelism(parallelism);
    const limit = pLimit(limitN);

    // Initial state — all tasks pending. Order in the array matches `plan`.
    const tasks = plan.map((t) => ({
        id: t.id,
        status: TASK_STATUS.PENDING,
        result: undefined,
        error: undefined,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        dependsOn: t.dependsOn.slice(),
        label: t.label,
    }));

    const results = new Map();
    let cancelled = false;

    // Group tasks into "waves" by dependency depth — siblings run in parallel.
    // voices (depends on characters) starts in wave 2; characters & locations
    // (no deps) start in wave 1.
    const waves = _buildWaves(plan);

    const total = tasks.length;
    let completedCount = 0;
    let failedCount = 0;

    const fire = (event, task, statusOverride) => {
        if (typeof onTaskEvent === 'function') {
            try {
                onTaskEvent(event, task, completedCount, total, statusOverride);
            } catch (_) { /* best-effort */ }
        }
    };

    const ctx = {
        text,
        characters,
        existingLocations,
        existingMentions,
        language,
        promptProfiles,
        stepIndex,
        sessionId,
        publishVBook,
        checkCancelled,
        analyzers,
        stepResults: results,
        charactersResult: null,
        locationsResult: null,
        voicesResult: null,
    };

    for (const wave of waves) {
        if (cancelled) break;

        const promises = wave.map((taskDef) => {
            const task = tasks.find((t) => t.id === taskDef.id);
            return limit(async () => {
                if (cancelled) {
                    task.status = TASK_STATUS.CANCELLED;
                    fire('task_skipped', task);
                    return;
                }
                task.status = TASK_STATUS.RUNNING;
                task.startedAt = Date.now();
                fire('task_started', task);
                try {
                    // Cancellation gate at task start — fast no-op when not cancelled.
                    await checkCancelled();
                    const out = await taskDef.execute(ctx);
                    task.result = out;
                    task.status = TASK_STATUS.COMPLETED;
                    results.set(task.id, out);
                    completedCount++;
                    task.finishedAt = Date.now();
                    task.durationMs = task.finishedAt - task.startedAt;
                    fire('task_completed', task);
                } catch (err) {
                    // Cancellation propagates as a thrown error from the
                    // step itself or from checkCancelled. Mark cancelled
                    // globally so subsequent waves don't start.
                    if (err && (err.code === 'SESSION_CANCELLED' || err.code === 'TASK_CANCELLED')) {
                        task.status = TASK_STATUS.CANCELLED;
                        task.error = err.message;
                        cancelled = true;
                        fire('task_cancelled', task);
                        return;
                    }
                    task.status = TASK_STATUS.FAILED;
                    task.error = err && err.message ? err.message : String(err);
                    failedCount++;
                    task.finishedAt = Date.now();
                    task.durationMs = task.finishedAt - task.startedAt;
                    // Log full stack at warn (NOT error) — a single task failing
                    // does not mean the pipeline failed (failure isolation).
                    console.warn(`[PARALLEL-ANALYSIS] task ${task.id} failed: ${task.error}`);
                    fire('task_failed', task);
                }
            });
        });

        // Drain the wave before starting the next one — dependencies between
        // waves (e.g. voices depends on characters) MUST be respected.
        await Promise.all(promises);

        // After each wave, surface a progress heartbeat to the SSE channel
        // so the frontend can render "Analysis: N/M" without waiting for the
        // orchestrator to finish.
        try {
            publishVBook({
                stage: 'analysis_parallel',
                analysis_completed: completedCount,
                analysis_failed: failedCount,
                analysis_total: total,
                analysis_mode: 'parallel',
            });
        } catch (_) { /* best-effort */ }
    }

    // Final sweep: any task still PENDING at the end (because cancellation
    // tripped before the wave containing it ran) gets marked CANCELLED so
    // callers see a uniform lifecycle.
    for (const t of tasks) {
        if (t.status === TASK_STATUS.PENDING) {
            t.status = TASK_STATUS.CANCELLED;
            fire('task_skipped', t);
        }
    }

    return {
        tasks,
        ok: failedCount === 0 && !cancelled,
        cancelled,
        failedTaskIds: tasks.filter((t) => t.status === TASK_STATUS.FAILED).map((t) => t.id),
    };
}

/**
 * Group tasks into waves by topological depth. Tasks with no unsatisfied
 * dependencies land in the same wave and run concurrently (subject to the
 * p-limit concurrency cap).
 */
function _buildWaves(plan) {
    const done = new Set();
    const waves = [];
    let remaining = plan.slice();
    while (remaining.length > 0) {
        const wave = [];
        const next = [];
        for (const t of remaining) {
            if (t.dependsOn.every((d) => done.has(d))) {
                wave.push(t);
            } else {
                next.push(t);
            }
        }
        if (wave.length === 0) {
            // Defensive: cycle or missing dependency — should be impossible
            // because planTasks() validated `dependsOn` references.
            throw new Error('parallel-analysis-orchestrator: cannot schedule remaining tasks (cycle?)');
        }
        waves.push(wave);
        for (const t of wave) done.add(t.id);
        remaining = next;
    }
    return waves;
}

function _clampParallelism(n) {
    const parsed = parseInt(n, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 3;
    return Math.min(8, parsed);
}

module.exports = {
    TASK_STATUS,
    ANALYZERS,
    planTasks,
    run,
};