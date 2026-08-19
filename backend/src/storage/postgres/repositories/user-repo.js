// ======================================================
// User Repository
// ======================================================
// Manages user accounts: creation, lookup, authentication foundation.

const { query } = require('../database');

const logPrefix = '[USER-REPO]';

/**
 * Create a new user.
 * @param {object} params
 * @param {string} params.username - Unique username
 * @param {string} [params.passwordHash] - Argon2/bcrypt hash (nullable for OAuth/anonymous)
 * @param {string} [params.email] - Optional email for recovery
 * @param {string} [params.displayName] - Display name (defaults to username)
 * @returns {Promise<object>} Created user row
 */
async function createUser({ username, passwordHash, email, displayName }) {
    const result = await query(`
        INSERT INTO users (username, password_hash, email, display_name)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (username) DO UPDATE SET
            password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
            email = COALESCE(EXCLUDED.email, users.email),
            display_name = COALESCE(EXCLUDED.display_name, users.display_name),
            updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        RETURNING *
    `, [username, passwordHash || null, email || null, displayName || username]);
    return result.rows[0];
}

/**
 * Find a user by username.
 * @param {string} username
 * @returns {Promise<object|null>}
 */
async function findByUsername(username) {
    if (!username) return null;
    const result = await query(
        `SELECT * FROM users WHERE username = $1 LIMIT 1`,
        [username]
    );
    return result.rows[0] || null;
}

/**
 * Find a user by user_id.
 * @param {string} userId - UUID
 * @returns {Promise<object|null>}
 */
async function findById(userId) {
    if (!userId) return null;
    const result = await query(
        `SELECT * FROM users WHERE user_id = $1 LIMIT 1`,
        [userId]
    );
    return result.rows[0] || null;
}

/**
 * Find a user by email.
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function findByEmail(email) {
    if (!email) return null;
    const result = await query(
        `SELECT * FROM users WHERE email = $1 LIMIT 1`,
        [email]
    );
    return result.rows[0] || null;
}

/**
 * Update user fields.
 * @param {string} userId
 * @param {object} updates - Fields to update
 * @returns {Promise<object|null>}
 */
async function updateUser(userId, updates) {
    const allowed = ['username', 'password_hash', 'email', 'recovery_key_hash', 'display_name', 'avatar_url', 'settings'];
    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (allowed.includes(key)) {
            setClauses.push(`${key} = $${idx}`);
            values.push(value);
            idx++;
        }
    }

    if (setClauses.length === 0) return findById(userId);

    setClauses.push(`updated_at = EXTRACT(EPOCH FROM NOW())::bigint`);
    values.push(userId);

    const result = await query(
        `UPDATE users SET ${setClauses.join(', ')} WHERE user_id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

module.exports = {
    createUser,
    findByUsername,
    findById,
    findByEmail,
    updateUser,
};
