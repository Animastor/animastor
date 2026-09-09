// ======================================================
// AGENT SESSION CONTROL — VBook-owned session boundary (S-1)
// ======================================================
// Narrow host-side contract (P-6 from the Generation extraction
// reconnaissance, docs/architecture/generation-module-extraction-
// reconnaissance.md §15/§19 S-1):
//
//   Generation routes ──(AgentSessionControl port)──► VBook sessions
//
// Generation-owned route logic must not know VBook internals
// (`agent_sessions` / `book_generation_sessions` / `agent_steps` tables,
// status grammar, session bookkeeping). It may only:
//
//   cancelSessions(bookId)        — VBook session cancellation
//   getActiveSessionCount()        — 1 when any agent session is running
//   getSessionStatus(bookId)       — { status, row } of the latest session
//
// Everything else (bootstrap, pipeline bookkeeping, window sessions)
// stays in the VBook-owned modules (services/agent-session.js,
// services/agent/*, gen-session-repo) and is NOT exposed here.
//
// The SQL below is intentionally kept in this VBook-owned module — it is
// the implementation of the port, not a Generation concern.

const { query } = require('../storage/postgres/database');

function createAgentSessionControl() {
    /**
     * Cancel every running/paused VBook agent session for a book.
     * Mirrors the semantics previously inlined in cancel-worker /
     * cancel-generation routes (best-effort: the caller decides whether a
     * PG failure is fatal — it never was there).
     * @returns {Promise<{cancelled: boolean}>}
     */
    async function cancelSessions(bookId) {
        const result = await query(
            `UPDATE agent_sessions SET status = 'cancelled', updated_at = $1
             WHERE book_id = $2 AND status IN ('running', 'paused')`,
            [Math.floor(Date.now() / 1000), bookId]
        );
        return { cancelled: (result.rowCount || 0) > 0 };
    }

    /**
     * Worker-counts health leg: 1 when at least one agent session is
     * actually running, 0 otherwise (PG failure reports 0 — matches the
     * previous route behavior of defaulting to 0 on query failure).
     * @returns {Promise<number>}
     */
    async function getActiveSessionCount() {
        const result = await query(
            `SELECT COUNT(*)::int as cnt FROM agent_sessions WHERE status = 'running'`
        );
        return (result.rows[0]?.cnt || 0) > 0 ? 1 : 0;
    }

    /**
     * Latest session row for a book (raw row shape consumed only by
     * VBook-adjacent callers; Generation routes never need it today).
     * @returns {Promise<object|null>}
     */
    async function getSessionStatus(bookId) {
        const result = await query(
            `SELECT session_id, status, progress_msg, window_data, source_type
             FROM agent_sessions
             WHERE book_id = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [bookId]
        );
        return result.rows[0] || null;
    }

    return {
        cancelSessions,
        getActiveSessionCount,
        getSessionStatus,
    };
}

module.exports = { createAgentSessionControl };
