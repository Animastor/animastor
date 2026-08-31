package com.example.animastor.ui

/**
 * Parallel AI Analysis per-task progress (web parity f661a922 —
 * frontends/app/src/state/generateStore.ts AnalysisProgress).
 *
 * One row per AI analysis task (characters / locations / voices). The
 * backend parallel-analysis-orchestrator emits { type:'analysis', task,
 * status, ... } events over the existing SSE progress stream; this state
 * mirrors the orchestrator's view so the UI can render one row per task
 * with its own timer + status. resetAnalysisProgress() wipes the state —
 * called on cancel / new generation / book close.
 *
 * Wire contract: each row records status and startedAt / finishedAt
 * (epoch ms). duration_ms from the orchestrator is the final
 * authoritative value when a task ends (backend clock).
 *
 * Pure JVM (no Android framework imports) — unit-testable like the web
 * applyAnalysisEvent suite. Timers are injectable via [nowMs] params so
 * tests are deterministic.
 */

enum class AnalysisStatus {
    PENDING, RUNNING, COMPLETED, FAILED, CANCELLED;

    companion object {
        /** Map a backend wire status string; null when unknown (caller keeps prev). */
        fun fromWire(s: String?): AnalysisStatus? = when (s) {
            "pending" -> PENDING
            "running" -> RUNNING
            "completed" -> COMPLETED
            "failed" -> FAILED
            "cancelled" -> CANCELLED
            else -> null
        }
    }
}

enum class AnalysisTaskId {
    CHARACTERS, LOCATIONS, VOICES;

    companion object {
        /**
         * Task ids below are exactly the canonical names defined in
         * backend/src/services/agent/parallel-analysis-orchestrator.js
         * (ANALYZERS table). Unknown ids return null — event ignored,
         * matching the web isAnalysisTaskId guard.
         */
        fun fromWire(s: String?): AnalysisTaskId? = when (s) {
            "characters" -> CHARACTERS
            "locations" -> LOCATIONS
            "voices" -> VOICES
            else -> null
        }
    }
}

data class AnalysisTaskRow(
    val id: AnalysisTaskId,
    val status: AnalysisStatus = AnalysisStatus.PENDING,
    /** Epoch ms — set when status first transitions to RUNNING. */
    val startedAt: Long? = null,
    /** Epoch ms — set when status transitions to a terminal state. */
    val finishedAt: Long? = null,
    /** Wall-clock ms spent in RUNNING. Authoritative from the orchestrator
     *  (event duration_ms) when finished. */
    val durationMs: Long? = null,
    /** Set only when status == FAILED. */
    val error: String? = null,
)

data class AnalysisProgress(
    /** Total tasks the orchestrator has scheduled (3 today). */
    val totalTasks: Int = 3,
    val completedTasks: Int = 0,
    /** Failure isolation — a failed task does not stop its siblings. */
    val failedTasks: Int = 0,
    val cancelledTasks: Int = 0,
    /** Epoch ms — analysis phase start (first task → running). Null until then. */
    val phaseStartedAt: Long? = null,
    /** Epoch ms — all tasks terminal. Freezes the overall timer. */
    val phaseFinishedAt: Long? = null,
    /** Total elapsed wall-clock ms for the phase. Authoritative when
     *  phaseFinishedAt is set; live nowMs - phaseStartedAt while running. */
    val phaseDurationMs: Long? = null,
    /** Per-task rows keyed by id. */
    val tasks: Map<AnalysisTaskId, AnalysisTaskRow> =
        AnalysisTaskId.entries.associateWith { AnalysisTaskRow(it) },
    /** True once any analysis event has been observed. Sequential mode never
     *  populates this — callers fall back to the legacy single-row VBook UI. */
    val active: Boolean = false,
) {
    val allTerminal: Boolean
        get() = tasks.values.all {
            it.status == AnalysisStatus.COMPLETED ||
                it.status == AnalysisStatus.FAILED ||
                it.status == AnalysisStatus.CANCELLED
        }
}

/** Fresh empty state. Idempotent — same as initialAnalysisProgress(). */
fun resetAnalysisProgress(): AnalysisProgress = AnalysisProgress()

/**
 * Backend wire value → normalized mode (web + backend _clampAnalysisMode
 * parity): anything other than "parallel" maps to "sequential", so a
 * missing/unknown field never flips a book into a non-default mode.
 */
fun analysisModeFromWire(v: String?): String = if (v == "parallel") "parallel" else "sequential"

/** Aggregate health percent for the overall row. Failed tasks count as
 *  "done" for the bar (the row stops moving) but are surfaced as failures
 *  separately — web analysisOverallPercent parity. */
fun analysisOverallPercent(p: AnalysisProgress): Int {
    if (p.totalTasks <= 0) return 0
    return (((p.completedTasks + p.failedTasks).toDouble() / p.totalTasks) * 100)
        .let { Math.round(it) }
        .toInt()
        .coerceIn(0, 100)
}

/**
 * Pure transition for one type:"analysis" SSE event (web applyAnalysisEvent
 * parity). Same input produces the same output; the SSE handler wraps it
 * once the event has been JSON-parsed.
 */
fun applyAnalysisEvent(
    prev: AnalysisProgress,
    taskId: AnalysisTaskId,
    wireStatus: String?,
    durationMs: Long?,
    error: String?,
    nowMs: Long,
): AnalysisProgress {
    val prevRow = prev.tasks[taskId] ?: return prev
    val nextStatus = AnalysisStatus.fromWire(wireStatus) ?: prevRow.status

    var row = prevRow.copy(status = nextStatus)
    if (row.status == AnalysisStatus.RUNNING && prevRow.startedAt == null) {
        row = row.copy(startedAt = nowMs)
    }
    if (row.status != AnalysisStatus.RUNNING &&
        row.startedAt != null &&
        prevRow.status == AnalysisStatus.RUNNING
    ) {
        row = row.copy(finishedAt = nowMs)
    }
    if (durationMs != null && durationMs >= 0) {
        row = row.copy(durationMs = durationMs)
        val started = row.startedAt
        if (started != null) row = row.copy(finishedAt = started + durationMs)
    }
    if (row.status == AnalysisStatus.FAILED && !error.isNullOrBlank()) {
        row = row.copy(error = error)
    }

    // Recompute totals from the per-row statuses — never trust the
    // orchestrator's counters blindly because a late event with a stale
    // counter could roll the numbers backwards. Single source of truth
    // is the row statuses (web parity).
    val tasks = prev.tasks + (taskId to row)
    var completed = 0
    var failed = 0
    var cancelled = 0
    for (t in tasks.values) {
        when (t.status) {
            AnalysisStatus.COMPLETED -> completed++
            AnalysisStatus.FAILED -> failed++
            AnalysisStatus.CANCELLED -> cancelled++
            else -> {}
        }
    }

    var phaseStartedAt = prev.phaseStartedAt
    if (phaseStartedAt == null && tasks.values.any { it.startedAt != null }) {
        phaseStartedAt = tasks.values.mapNotNull { it.startedAt }.min()
    }
    var phaseFinishedAt = prev.phaseFinishedAt
    val allTerminal = tasks.values.all {
        it.status == AnalysisStatus.COMPLETED ||
            it.status == AnalysisStatus.FAILED ||
            it.status == AnalysisStatus.CANCELLED
    }
    if (allTerminal && phaseStartedAt != null && phaseFinishedAt == null) {
        phaseFinishedAt = nowMs
    }
    val phaseDurationMs = phaseStartedAt?.let { (phaseFinishedAt ?: nowMs) - it }

    return prev.copy(
        completedTasks = completed,
        failedTasks = failed,
        cancelledTasks = cancelled,
        phaseStartedAt = phaseStartedAt,
        phaseFinishedAt = phaseFinishedAt,
        phaseDurationMs = phaseDurationMs,
        tasks = tasks,
        active = true,
    )
}

/**
 * Parallel-mode heartbeat (web parity): the orchestrator publishes one
 * { stage:'analysis_parallel', analysis_completed, ... } vbook event
 * between waves. Counters use Math.max so a stale late heartbeat never
 * rolls the numbers backwards.
 */
fun applyAnalysisHeartbeat(
    prev: AnalysisProgress,
    analysisCompleted: Int?,
    analysisFailed: Int?,
    analysisTotal: Int?,
): AnalysisProgress = prev.copy(
    totalTasks = maxOf(prev.totalTasks, analysisTotal ?: prev.totalTasks),
    completedTasks = maxOf(prev.completedTasks, analysisCompleted ?: prev.completedTasks),
    failedTasks = maxOf(prev.failedTasks, analysisFailed ?: prev.failedTasks),
    active = true,
)

/**
 * Route one parsed SSE event into the analysis state (web handleProgressEvent
 * parity): type=="analysis" applies the per-task transition; a vbook event
 * with stage=="analysis_parallel" applies the inter-wave heartbeat. Everything
 * else leaves the analysis state untouched — existing vbook/generation/
 * import handling is unaffected (sequential compatibility).
 */
fun applyProgressEventToAnalysis(
    prev: AnalysisProgress,
    type: String?,
    stage: String?,
    task: String?,
    status: String?,
    durationMs: Long?,
    error: String?,
    analysisCompleted: Int?,
    analysisFailed: Int?,
    analysisTotal: Int?,
    nowMs: Long,
): AnalysisProgress {
    if (type == "analysis") {
        val id = AnalysisTaskId.fromWire(task) ?: return prev
        return applyAnalysisEvent(prev, id, status, durationMs, error, nowMs)
    }
    if (type == "vbook" && stage == "analysis_parallel") {
        return applyAnalysisHeartbeat(prev, analysisCompleted, analysisFailed, analysisTotal)
    }
    return prev
}
