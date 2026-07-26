const { query } = require('../database');

async function createTask(taskId, bookId, chapterId, sceneId, taskType, metadata) {
    await query(`
        INSERT INTO generation_tasks (task_id, book_id, chapter_id, scene_id, task_type, metadata)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `, [taskId, bookId, chapterId || null, sceneId || null, taskType,
        metadata ? JSON.stringify(metadata) : null]);
    return { task_id: taskId };
}

async function updateTaskStatus(taskId, status, error) {
    const now = Math.floor(Date.now() / 1000);
    const setClauses = ['status = $1'];
    const params = [status];

    if (status === 'running') {
        setClauses.push('started_at = $' + (params.length + 1));
        params.push(now);
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        setClauses.push('completed_at = $' + (params.length + 1));
        params.push(now);
    }
    if (error) {
        setClauses.push('error = $' + (params.length + 1));
        params.push(error);
    }

    params.push(taskId);
    await query(`UPDATE generation_tasks SET ${setClauses.join(', ')} WHERE task_id = $${params.length}`, params);
}

async function incrementRetry(taskId) {
    await query(`
        UPDATE generation_tasks SET retry_count = retry_count + 1, status = 'queued'
        WHERE task_id = $1 AND retry_count < max_retries
    `, [taskId]);
}

async function getPendingTasks(bookId, limit = 50) {
    const result = await query(`
        SELECT * FROM generation_tasks
        WHERE book_id = $1 AND status = 'queued'
        ORDER BY created_at LIMIT $2
    `, [bookId, limit]);
    return result.rows;
}

async function getFailedTasks(bookId) {
    const result = await query(`
        SELECT * FROM generation_tasks
        WHERE book_id = $1 AND status = 'failed'
        ORDER BY created_at DESC
    `, [bookId]);
    return result.rows;
}

async function getSceneTasks(bookId, chapterId, sceneId) {
    const result = await query(`
        SELECT * FROM generation_tasks
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
        ORDER BY created_at
    `, [bookId, chapterId, sceneId]);
    return result.rows;
}

async function cancelActiveTasksForBook(bookId, error = 'Cancelled by user') {
    const now = Math.floor(Date.now() / 1000);
    const result = await query(`
        UPDATE generation_tasks
        SET status = 'cancelled', completed_at = $1, error = COALESCE(error, $2)
        WHERE book_id = $3 AND status IN ('queued', 'running')
    `, [now, error, bookId]);
    return result.rowCount || 0;
}

module.exports = {
    createTask,
    updateTaskStatus,
    incrementRetry,
    getPendingTasks,
    getFailedTasks,
    getSceneTasks,
    cancelActiveTasksForBook,
};
