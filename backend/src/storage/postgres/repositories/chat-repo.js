const { query } = require('../database');

const logPrefix = '[CHAT-REPO]';

async function appendMessage(bookId, message) {
    const {
        session_id = null,
        scene_id = null,
        character_id = null,
        topic = null,
        role,
        message: text,
        metadata = null,
    } = message;

    if (!role || !text) {
        throw new Error(`${logPrefix} role and message are required`);
    }
    if (!['user', 'assistant', 'system'].includes(role)) {
        throw new Error(`${logPrefix} invalid role: ${role}`);
    }

    const result = await query(`
        INSERT INTO chat_messages (
            session_id, book_id, scene_id, character_id, topic, role, message, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING *
    `, [
        session_id, bookId, scene_id, character_id, topic, role, text,
        metadata ? JSON.stringify(metadata) : null,
    ]);
    return result.rows[0];
}

async function getSessionMessages(sessionId) {
    const result = await query(`
        SELECT * FROM chat_messages
        WHERE session_id = $1
        ORDER BY id ASC
    `, [sessionId]);
    return result.rows;
}

async function getBookHistory(bookId, { limit = 100, beforeId = null } = {}) {
    const params = [bookId, limit];
    let where = 'book_id = $1';
    if (beforeId) {
        where += ' AND id < $3';
        params.push(beforeId);
    }
    const result = await query(`
        SELECT * FROM chat_messages
        WHERE ${where}
        ORDER BY id DESC
        LIMIT $2
    `, params);
    return result.rows.reverse();
}

async function getSceneHistory(bookId, sceneId, { limit = 100 } = {}) {
    const result = await query(`
        SELECT * FROM chat_messages
        WHERE book_id = $1 AND scene_id = $2
        ORDER BY id ASC
        LIMIT $3
    `, [bookId, sceneId, limit]);
    return result.rows;
}

async function getCharacterHistory(bookId, characterId, { limit = 100 } = {}) {
    const result = await query(`
        SELECT * FROM chat_messages
        WHERE book_id = $1 AND character_id = $2
        ORDER BY id DESC
        LIMIT $3
    `, [bookId, characterId, limit]);
    return result.rows.reverse();
}

async function getDiscussionsByTopic(bookId, topic, { limit = 100 } = {}) {
    const result = await query(`
        SELECT * FROM chat_messages
        WHERE book_id = $1 AND topic = $2
        ORDER BY id ASC
        LIMIT $3
    `, [bookId, topic, limit]);
    return result.rows;
}

async function listTopics(bookId) {
    const result = await query(`
        SELECT topic, COUNT(*)::int as count, MAX(created_at) as last_at
        FROM chat_messages
        WHERE book_id = $1 AND topic IS NOT NULL
        GROUP BY topic
        ORDER BY last_at DESC
    `, [bookId]);
    return result.rows;
}

async function searchMessages(bookId, queryText, { limit = 50 } = {}) {
    const result = await query(`
        SELECT * FROM chat_messages
        WHERE book_id = $1 AND message ILIKE $2
        ORDER BY id DESC
        LIMIT $3
    `, [bookId, `%${queryText}%`, limit]);
    return result.rows;
}

async function deleteBookHistory(bookId) {
    await query('DELETE FROM chat_messages WHERE book_id = $1', [bookId]);
}

async function deleteSceneHistory(bookId, sceneId) {
    await query('DELETE FROM chat_messages WHERE book_id = $1 AND scene_id = $2', [bookId, sceneId]);
}

async function getMessageCount(bookId) {
    const result = await query(
        'SELECT COUNT(*)::int as c FROM chat_messages WHERE book_id = $1',
        [bookId]
    );
    return result.rows[0].c;
}

module.exports = {
    appendMessage,
    getBookHistory,
    getSceneHistory,
    getCharacterHistory,
    getDiscussionsByTopic,
    getSessionMessages,
    listTopics,
    searchMessages,
    deleteBookHistory,
    deleteSceneHistory,
    getMessageCount,
};
