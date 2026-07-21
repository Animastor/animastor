const { query } = require('../storage/postgres/database');

async function createSession(bookId, sourceType) {
    const result = await query(
        `INSERT INTO agent_sessions (book_id, source_type, status) VALUES ($1, $2, 'running') RETURNING *`,
        [bookId, sourceType || 'txt_import']
    );
    return result.rows[0];
}

// Whitelist of allowed column names for updateSession to prevent SQL injection.
// Must match the agent_sessions table schema (see storage/postgres/schema.js).
const ALLOWED_UPDATE_COLUMNS = {
    status: true,
    progress_msg: true,
    knowledge_base: true,
    window_data: true,
};

async function isSessionCancelled(sessionId) {
    const result = await query(`SELECT status FROM agent_sessions WHERE session_id = $1`, [sessionId]);
    return result.rows[0]?.status === 'cancelled';
}

/**
 * Check if ANY agent session for this book has been cancelled.
 * This catches cases where cancel-worker cancelled old sessions and
 * a new session was created afterwards (which has status='running' but
 * the book as a whole should be considered cancelled).
 */
async function isBookCancelled(bookId) {
    const result = await query(
        `SELECT COUNT(*) as cnt FROM agent_sessions WHERE book_id = $1 AND status = 'cancelled'`,
        [bookId]
    );
    return parseInt(result.rows[0]?.cnt || '0', 10) > 0;
}

async function updateSession(sessionId, updates) {
    const keys = Object.keys(updates).filter(k => ALLOWED_UPDATE_COLUMNS[k]);
    if (keys.length === 0) return;
    const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
    const values = keys.map(k => updates[k]);
    values.push(Math.floor(Date.now() / 1000));
    values.push(sessionId);

    await query(
        `UPDATE agent_sessions SET ${setClauses.join(', ')}, updated_at = $${keys.length + 1} WHERE session_id = $${keys.length + 2}`,
        values
    );
}

async function getSession(sessionId) {
    const result = await query(`SELECT * FROM agent_sessions WHERE session_id = $1`, [sessionId]);
    return result.rows[0] || null;
}

async function createStep(sessionId, stepType, stepIndex, sceneIndex) {
    const result = await query(
        `INSERT INTO agent_steps (session_id, step_type, step_index, scene_index, status)
         VALUES ($1, $2, $3, $4, 'running') RETURNING *`,
        [sessionId, stepType, stepIndex || 0, sceneIndex != null ? sceneIndex : null]
    );
    return result.rows[0];
}

async function completeStep(stepId, stepResult) {
    await query(
        `UPDATE agent_steps SET status = 'completed', result = $1, finished_at = $2 WHERE step_id = $3`,
        [JSON.stringify(stepResult), Math.floor(Date.now() / 1000), stepId]
    );
}

async function failStep(stepId, error) {
    await query(
        `UPDATE agent_steps SET status = 'failed', error = $1, finished_at = $2 WHERE step_id = $3`,
        [error, Math.floor(Date.now() / 1000), stepId]
    );
}

module.exports = {
    createSession, isSessionCancelled, isBookCancelled, updateSession, getSession,
    createStep, completeStep, failStep,
};
