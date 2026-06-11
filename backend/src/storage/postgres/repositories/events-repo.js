const { query } = require('../database');

const logPrefix = '[EVENTS-REPO]';

async function appendEvent(event) {
    const {
        book_id, chapter_id = null, scene_id = null,
        event_type, state = null, actor = null,
        ref_type = null, ref_id = null, details = null,
    } = event;

    if (!book_id || !event_type) {
        throw new Error(`${logPrefix} book_id and event_type are required`);
    }

    const result = await query(`
        INSERT INTO book_events (
            book_id, chapter_id, scene_id, event_type, state,
            actor, ref_type, ref_id, details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING *
    `, [
        book_id, chapter_id, scene_id, event_type, state,
        actor, ref_type, ref_id,
        details ? JSON.stringify(details) : null,
    ]);
    return result.rows[0];
}

async function appendBatch(events) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const client = await require('../database').getPool().connect();
    try {
        await client.query('BEGIN');
        const results = [];
        for (const event of events) {
            const {
                book_id, chapter_id = null, scene_id = null,
                event_type, state = null, actor = null,
                ref_type = null, ref_id = null, details = null,
            } = event;
            const r = await client.query(`
                INSERT INTO book_events (
                    book_id, chapter_id, scene_id, event_type, state,
                    actor, ref_type, ref_id, details
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
                RETURNING *
            `, [
                book_id, chapter_id, scene_id, event_type, state,
                actor, ref_type, ref_id,
                details ? JSON.stringify(details) : null,
            ]);
            results.push(r.rows[0]);
        }
        await client.query('COMMIT');
        return results;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function getBookEvents(bookId, { limit = 200, beforeId = null, eventType = null } = {}) {
    const params = [bookId, limit];
    let where = 'book_id = $1';
    if (beforeId) {
        where += ' AND id < $3';
        params.push(beforeId);
    }
    if (eventType) {
        where += ` AND event_type = $${params.length + 1}`;
        params.push(eventType);
    }
    const result = await query(`
        SELECT * FROM book_events
        WHERE ${where}
        ORDER BY id DESC
        LIMIT $2
    `, params);
    return result.rows.reverse();
}

async function getSceneEvents(bookId, chapterId, sceneId, { limit = 200, eventType = null } = {}) {
    const params = [bookId, chapterId, sceneId, limit];
    let where = 'book_id = $1 AND chapter_id = $2 AND scene_id = $3';
    if (eventType) {
        where += ' AND event_type = $5';
        params.push(eventType);
    }
    const result = await query(`
        SELECT * FROM book_events
        WHERE ${where}
        ORDER BY id DESC
        LIMIT $4
    `, params);
    return result.rows.reverse();
}

async function getEventsByRef(bookId, refType, refId, { limit = 100 } = {}) {
    const result = await query(`
        SELECT * FROM book_events
        WHERE book_id = $1 AND ref_type = $2 AND ref_id = $3
        ORDER BY id DESC
        LIMIT $4
    `, [bookId, refType, refId, limit]);
    return result.rows.reverse();
}

async function getRecentByType(bookId, eventType, sinceTs, { limit = 200 } = {}) {
    const result = await query(`
        SELECT * FROM book_events
        WHERE book_id = $1 AND event_type = $2 AND created_at >= $3
        ORDER BY id ASC
        LIMIT $4
    `, [bookId, eventType, sinceTs, limit]);
    return result.rows;
}

async function countByType(bookId, sinceTs) {
    const result = await query(`
        SELECT event_type, COUNT(*)::int as c
        FROM book_events
        WHERE book_id = $1 AND created_at >= $2
        GROUP BY event_type
    `, [bookId, sinceTs]);
    return result.rows;
}

async function deleteBookEvents(bookId) {
    await query('DELETE FROM book_events WHERE book_id = $1', [bookId]);
}

async function deleteSceneEvents(bookId, chapterId, sceneId) {
    await query(`
        DELETE FROM book_events
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId]);
}

async function deleteEventsBefore(beforeTs) {
    const result = await query(
        'DELETE FROM book_events WHERE created_at < $1',
        [beforeTs]
    );
    return result.rowCount || 0;
}

module.exports = {
    appendEvent,
    appendBatch,
    getBookEvents,
    getSceneEvents,
    getEventsByRef,
    getRecentByType,
    countByType,
    deleteBookEvents,
    deleteSceneEvents,
    deleteEventsBefore,
};
