// ======================================================
// REGISTRATION UNIT-OF-WORK (Auth Extraction Phase 1)
// ======================================================
// The concrete PostgreSQL implementation of the auth domain's
// `registrationTx` port (audit §6, blocker §13.2): user + workspace +
// owner membership + guest→personal conversion in ONE transaction.
//
// The SQL is moved verbatim from the former auth-service.register() inline
// transaction (the DIRECT_SQL_WHITELIST debt) — rollback/error behaviour is
// byte-for-byte identical:
//   - INSERT users ON CONFLICT (lower(username)) DO NOTHING → null row means
//     a concurrent insert won the race (caller maps it to 409);
//   - guest conversion converts the TEMPORARY workspace IN PLACE (same
//     workspace_id, zero book copying) via guestRepo.convertTemporaryWorkspace
//     inside the SAME transaction;
//   - fresh path inserts a 'personal' workspace + owner membership;
//   - any error → ROLLBACK → rethrow (caller distinguishes AuthError /
//     unique-violation / unexpected).
// ======================================================

'use strict';

const { getPool } = require('../database');
const guestRepo = require('./guest-repo');

/**
 * @param {object} params
 * @param {string} params.username - canonical (trimmed) username
 * @param {string} params.passwordHash - scrypt-encoded hash
 * @param {string|null} params.email - normalized (lowercased) email
 * @param {string} params.displayName - defaults to username upstream
 * @param {object|null} params.guestConversion - { workspaceId, username } when
 *   a live guest token was presented (converted in place instead of fresh ws)
 * @returns {Promise<{userRow:object, workspaceRow:object, converted:boolean}>}
 */
async function registerUserWithWorkspace({ username, passwordHash, email, displayName, guestConversion }) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        let userRow;
        let workspaceRow;

        const { rows } = await client.query(`
            INSERT INTO users (username, password_hash, email, display_name)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (lower(username)) DO NOTHING
            RETURNING *
        `, [username, passwordHash, email, displayName || username]);
        userRow = rows[0];
        if (!userRow) {
            // Concurrent insert won the race (or canonical collision caught
            // DB-side). Rollback and surface a MARKED error — the domain core
            // resolves the dup via the users port and maps it to the exact
            // historical 409s (register_email_taken | register_username_taken).
            await client.query('ROLLBACK');
            const raceErr = new Error('username registration race (canonical collision)');
            raceErr.registerRace = true;
            throw raceErr;
        }

        if (guestConversion) {
            // CONVERSION: the guest's temporary workspace becomes this user's
            // personal workspace — books keep their workspace_id. Also revokes
            // every guest identity bound to that workspace (repo semantics).
            workspaceRow = await guestRepo.convertTemporaryWorkspace(client, guestConversion.workspaceId, userRow.user_id, guestConversion.username);
        } else {
            const { rows: wsRows } = await client.query(`
                INSERT INTO workspaces (name, owner_user_id, type)
                VALUES ($1, $2, 'personal')
                RETURNING *
            `, [displayName ? `${displayName}'s Workspace` : 'Personal workspace', userRow.user_id]);
            workspaceRow = wsRows[0];
        }

        await client.query(`
            INSERT INTO workspace_members (workspace_id, user_id, role)
            VALUES ($1, $2, 'owner')
            ON CONFLICT (workspace_id, user_id) DO NOTHING
        `, [workspaceRow.id, userRow.user_id]);

        await client.query('COMMIT');
        return { userRow, workspaceRow, converted: !!guestConversion };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { registerUserWithWorkspace };
