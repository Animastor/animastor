// ======================================================
// Chat Session Repository (ai_chat_sessions) — HOST ADAPTER
// ======================================================
// The ONLY production module (besides schema.js migrations) that knows the
// ai_chat_sessions table. The Assistant contour (@animastor/assistant
// package — the contracts live in its session-repo-contract.cjs) and the
// purge flows (services/book-deletion.cjs, routes/book/cache-routes.cjs)
// reach chat-session storage exclusively through this repository — no SQL,
// no storage barrel, no postgres knowledge leaks into the Assistant
// boundary (the package holds only the interface).
// (docs/architecture/ai-assistant-extraction.md)

const { query } = require('../database');

/**
 * List session metadata for a book (messages live behind /messages).
 * @returns {Promise<Array>} rows: id, book_id, mode, topic_id, created_at,
 *   updated_at, title (COALESCE'd to ''), message_count.
 */
async function listSessionsForBook(bookId) {
    const result = await query(
        `SELECT id, book_id, mode, topic_id, created_at, updated_at,
                COALESCE(title, '') AS title,
                jsonb_array_length(messages) AS message_count
         FROM ai_chat_sessions WHERE book_id = $1 ORDER BY created_at DESC`,
        [bookId]
    );
    return result.rows;
}

/**
 * Get a full session row by id.
 * `messages` is normalized to a JS array (JSONB may arrive as object or
 * string depending on driver/config — consumers get one shape).
 * @returns {Promise<object|null>} row or null when not found.
 */
async function getSession(id) {
    const result = await query('SELECT * FROM ai_chat_sessions WHERE id = $1', [id]);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    row.messages = parseMessages(row.messages);
    return row;
}

/**
 * Read only the messages array of a session (failed-turn persistence path).
 * Throws on a broken JSON payload — same as the historical inline read.
 * @returns {Promise<Array>}
 */
async function getMessages(id) {
    const result = await query('SELECT messages FROM ai_chat_sessions WHERE id = $1', [id]);
    return parseMessages(result.rows[0]?.messages);
}

/**
 * Create a session. Fields set to `undefined` are omitted from the INSERT
 * and fall back to the table defaults ('Chat' title, '{}' context, false
 * locked) — byte-identical to the historical two INSERT shapes.
 * @param {object} session
 */
async function createSession(session) {
    const cols = [];
    const params = [];
    const add = (col, val) => { cols.push(col); params.push(val); };
    add('id', session.id);
    add('book_id', session.book_id);
    if (session.title !== undefined) add('title', session.title);
    add('mode', session.mode);
    add('topic_id', session.topic_id);
    add('messages', JSON.stringify(session.messages ?? []));
    add('created_at', session.created_at);
    add('updated_at', session.updated_at);
    if (session.context !== undefined) {
        add('context', session.context === null ? null : JSON.stringify(session.context));
    }
    if (session.locked !== undefined) add('locked', session.locked);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await query(
        `INSERT INTO ai_chat_sessions (${cols.join(', ')}) VALUES (${placeholders})`,
        params
    );
}

/**
 * Replace the stored message history of a session (the route owns the
 * merge semantics: full stored history + user + assistant turn).
 * @param {string} id
 * @param {Array} messages
 * @param {number} [updatedAt=Date.now()]
 */
async function setMessages(id, messages, updatedAt = Date.now()) {
    await query(
        'UPDATE ai_chat_sessions SET messages = $1, updated_at = $2 WHERE id = $3',
        [JSON.stringify(messages), updatedAt, id]
    );
}

/**
 * Rename a session (Android parity: PATCH title).
 * @returns {Promise<string|null>} id when renamed, null when not found.
 */
async function renameSession(id, title, updatedAt = Date.now()) {
    const result = await query(
        'UPDATE ai_chat_sessions SET title = $1, updated_at = $2 WHERE id = $3 RETURNING id',
        [title, updatedAt, id]
    );
    return result.rows[0]?.id || null;
}

/**
 * Delete a session by id.
 * @returns {Promise<string|null>} id when deleted, null when not found.
 */
async function deleteSession(id) {
    const result = await query('DELETE FROM ai_chat_sessions WHERE id = $1 RETURNING id', [id]);
    return result.rows[0]?.id || null;
}

/**
 * Resolve the book a session belongs to (authz guard lookup).
 * @returns {Promise<string|null>}
 */
async function getBookIdForSession(id) {
    const result = await query('SELECT book_id FROM ai_chat_sessions WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0]?.book_id || null;
}

/**
 * Purge every chat session of a book — the single seam used by book
 * deletion and cache teardown instead of a raw table-name purge list.
 */
async function purgeSessionsForBook(bookId) {
    await query('DELETE FROM ai_chat_sessions WHERE book_id = $1', [bookId]);
}

function parseMessages(raw) {
    if (typeof raw === 'string') return JSON.parse(raw);
    return Array.isArray(raw) ? raw : [];
}

module.exports = {
    listSessionsForBook,
    getSession,
    getMessages,
    createSession,
    setMessages,
    renameSession,
    deleteSession,
    getBookIdForSession,
    purgeSessionsForBook,
};
