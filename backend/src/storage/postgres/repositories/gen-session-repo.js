// ======================================================
// Book Generation Session Repository
// ======================================================
// Tracks window-by-window generation state in PostgreSQL.
// Source of truth for: which text range was processed,
// which window is next, and whether generation is in progress.
// ======================================================

const { query } = require('../database');

async function createSession(bookId, windowIndex, windowSize) {
    const result = await query(
        `INSERT INTO book_generation_sessions (book_id, window_index, window_size, status)
         VALUES ($1, $2, $3, 'pending') RETURNING *`,
        [bookId, windowIndex || 0, windowSize || 3]
    );
    return result.rows[0];
}

async function updateSession(id, updates) {
    const keys = Object.keys(updates);
    if (keys.length === 0) return null;
    const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
    const values = keys.map(k => updates[k]);
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);
    const result = await query(
        `UPDATE book_generation_sessions SET ${setClauses.join(', ')}, updated_at = $${keys.length + 1} WHERE id = $${keys.length + 2} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

async function getLastSession(bookId) {
    const result = await query(
        `SELECT * FROM book_generation_sessions WHERE book_id = $1 ORDER BY window_index DESC LIMIT 1`,
        [bookId]
    );
    return result.rows[0] || null;
}

async function getSessionsByStatus(bookId, status) {
    const result = await query(
        `SELECT * FROM book_generation_sessions WHERE book_id = $1 AND status = $2 ORDER BY window_index ASC`,
        [bookId, status]
    );
    return result.rows;
}

async function getActiveSessions() {
    const result = await query(
        `SELECT * FROM book_generation_sessions WHERE status IN ('generating', 'pending', 'queued') ORDER BY book_id, window_index ASC`
    );
    return result.rows;
}

async function getHighestCompletedWindow(bookId) {
    const result = await query(
        `SELECT COALESCE(MAX(window_index), -1) as max_window FROM book_generation_sessions WHERE book_id = $1 AND status = 'completed'`,
        [bookId]
    );
    return result.rows[0]?.max_window ?? -1;
}

/**
 * Initialize window 0 as completed after first bootstrap.
 * Called once after bootstrapWithAgent finishes successfully.
 */
async function markFirstWindowCompleted(bookId, sceneCount) {
    // Check if window 0 already exists
    const existing = await query(
        `SELECT * FROM book_generation_sessions WHERE book_id = $1 AND window_index = 0`,
        [bookId]
    );
    if (existing.rows.length > 0) {
        // Already exists — just mark completed
        return updateSession(existing.rows[0].id, { status: 'completed', progress_msg: `First window: ${sceneCount} scenes` });
    }
    const result = await query(
        `INSERT INTO book_generation_sessions (book_id, window_index, window_size, status, progress_msg)
         VALUES ($1, 0, $2, 'completed', $3) RETURNING *`,
        [bookId, 3, `First window: ${sceneCount} scenes`]
    );
    return result.rows[0];
}

/**
 * Get the next window index to generate.
 * Returns 0-based index: last completed + 1.
 */
async function getNextWindowIndex(bookId) {
    const last = await getHighestCompletedWindow(bookId);
    return last + 1;
}

/**
 * Get full generation state for frontend polling.
 */
async function getGenerationState(bookId) {
    const lastSession = await getLastSession(bookId);
    if (!lastSession) {
        return {
            last_window_index: -1,
            status: 'idle',
            active: null,
            error: null,
        };
    }

    const activeSessions = await getSessionsByStatus(bookId, 'generating');
    const pendingSessions = await getSessionsByStatus(bookId, 'pending');
    const queuedSessions = await getSessionsByStatus(bookId, 'queued');

    const active = activeSessions.length > 0 ? activeSessions[0] :
                   pendingSessions.length > 0 ? pendingSessions[0] :
                   queuedSessions.length > 0 ? queuedSessions[0] : null;

    return {
        last_window_index: lastSession.window_index,
        status: lastSession.status,
        active_session_id: active?.id || null,
        active_window_index: active?.window_index ?? null,
        active_status: active?.status || null,
        error: lastSession.error || null,
        has_more: lastSession.window_index >= 0, // optimistic; caller checks source text
    };
}

/**
 * Get all sessions for a book (for startup resume).
 */
async function getSessionsForBook(bookId) {
    const result = await query(
        `SELECT * FROM book_generation_sessions WHERE book_id = $1 ORDER BY window_index ASC`,
        [bookId]
    );
    return result.rows;
}

module.exports = {
    createSession,
    updateSession,
    getLastSession,
    getSessionsByStatus,
    getActiveSessions,
    getHighestCompletedWindow,
    markFirstWindowCompleted,
    getNextWindowIndex,
    getGenerationState,
    getSessionsForBook,
};
