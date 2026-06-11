const { query } = require('../database');

const logPrefix = '[CHAT-SESSION-REPO]';

async function createSession({ bookId, title, topicId, mode, userId }) {
    const result = await query(`
        INSERT INTO chat_sessions (user_id, book_id, title, topic_id, mode)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
    `, [userId || null, bookId, title || 'Chat', topicId || 'book', mode || 'conversation']);
    return toSession(result.rows[0]);
}

async function listSessions(bookId) {
    const result = await query(`
        SELECT * FROM chat_sessions
        WHERE book_id = $1
        ORDER BY updated_at DESC
    `, [bookId]);
    return result.rows.map(toSession);
}

async function getSession(sessionId) {
    const result = await query(`
        SELECT * FROM chat_sessions WHERE session_id = $1
    `, [sessionId]);
    return result.rows.length ? toSession(result.rows[0]) : null;
}

async function updateSession(sessionId, updates) {
    const fields = [];
    const params = [];
    let idx = 1;
    if (updates.title !== undefined) { fields.push(`title = $${idx++}`); params.push(updates.title); }
    if (updates.topicId !== undefined) { fields.push(`topic_id = $${idx++}`); params.push(updates.topicId); }
    if (updates.mode !== undefined) { fields.push(`mode = $${idx++}`); params.push(updates.mode); }
    if (updates.messageCount !== undefined) { fields.push(`message_count = $${idx++}`); params.push(updates.messageCount); }
    fields.push(`updated_at = EXTRACT(EPOCH FROM NOW())::bigint`);
    params.push(sessionId);

    const result = await query(`
        UPDATE chat_sessions SET ${fields.join(', ')}
        WHERE session_id = $${params.length}
        RETURNING *
    `, params);
    return result.rows.length ? toSession(result.rows[0]) : null;
}

async function deleteSession(sessionId) {
    await query('DELETE FROM chat_sessions WHERE session_id = $1', [sessionId]);
}

async function incrementMessageCount(sessionId) {
    const result = await query(`
        UPDATE chat_sessions
        SET message_count = message_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE session_id = $1
        RETURNING *
    `, [sessionId]);
    return result.rows.length ? toSession(result.rows[0]) : null;
}

function toSession(row) {
    return {
        sessionId: row.session_id,
        userId: row.user_id,
        bookId: row.book_id,
        title: row.title,
        topicId: row.topic_id,
        mode: row.mode,
        messageCount: row.message_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

module.exports = {
    createSession,
    listSessions,
    getSession,
    updateSession,
    deleteSession,
    incrementMessageCount,
};
