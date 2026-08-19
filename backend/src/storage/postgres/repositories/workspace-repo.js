// ======================================================
// Workspace Repository
// ======================================================
// Manages workspaces: creation, ownership, membership.

const { query } = require('../database');

const logPrefix = '[WORKSPACE-REPO]';

/**
 * Create a new workspace.
 * @param {object} params
 * @param {string} params.name - Workspace name
 * @param {string} params.ownerUserId - Owner user UUID
 * @param {string} [params.type] - 'personal', 'temporary', 'team' (default: 'personal')
 * @returns {Promise<object>} Created workspace row
 */
async function createWorkspace({ name, ownerUserId, type = 'personal' }) {
    const result = await query(`
        INSERT INTO workspaces (name, owner_user_id, type)
        VALUES ($1, $2, $3)
        RETURNING *
    `, [name, ownerUserId, type]);
    const workspace = result.rows[0];

    // Automatically add owner as member with 'owner' role
    await query(`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES ($1, $2, 'owner')
        ON CONFLICT (workspace_id, user_id) DO NOTHING
    `, [workspace.id, ownerUserId]);

    return workspace;
}

/**
 * Find workspace by ID.
 * @param {string} workspaceId - UUID
 * @returns {Promise<object|null>}
 */
async function findById(workspaceId) {
    if (!workspaceId) return null;
    const result = await query(
        `SELECT * FROM workspaces WHERE id = $1 LIMIT 1`,
        [workspaceId]
    );
    return result.rows[0] || null;
}

/**
 * Find personal workspace for a user.
 * @param {string} userId - User UUID
 * @returns {Promise<object|null>}
 */
async function findPersonalWorkspace(userId) {
    if (!userId) return null;
    const result = await query(
        `SELECT * FROM workspaces WHERE owner_user_id = $1 AND type = 'personal' LIMIT 1`,
        [userId]
    );
    return result.rows[0] || null;
}

/**
 * List all workspaces a user is a member of.
 * @param {string} userId
 * @returns {Promise<Array>}
 */
async function listUserWorkspaces(userId) {
    if (!userId) return [];
    const result = await query(`
        SELECT w.*, wm.role as member_role
        FROM workspaces w
        JOIN workspace_members wm ON w.id = wm.workspace_id
        WHERE wm.user_id = $1
        ORDER BY w.created_at ASC
    `, [userId]);
    return result.rows;
}

/**
 * Check if a user is a member of a workspace.
 * @param {string} workspaceId
 * @param {string} userId
 * @returns {Promise<object|null>} Membership row or null
 */
async function getMembership(workspaceId, userId) {
    if (!workspaceId || !userId) return null;
    const result = await query(
        `SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
        [workspaceId, userId]
    );
    return result.rows[0] || null;
}

/**
 * Check if a user can access a book via workspace membership.
 * Returns the workspace_id if authorized, null otherwise.
 * @param {string} bookId
 * @param {string} userId
 * @returns {Promise<string|null>} workspace_id if authorized
 */
async function checkBookAccess(bookId, userId) {
    if (!bookId || !userId) return null;
    const result = await query(`
        SELECT b.workspace_id
        FROM books b
        JOIN workspace_members wm ON b.workspace_id = wm.workspace_id
        WHERE b.book_id = $1 AND wm.user_id = $2
        LIMIT 1
    `, [bookId, userId]);
    return result.rows[0]?.workspace_id || null;
}

module.exports = {
    createWorkspace,
    findById,
    findPersonalWorkspace,
    listUserWorkspaces,
    getMembership,
    checkBookAccess,
};
