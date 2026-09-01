// ======================================================
// ANIMASTOR BACKEND — USERS ROUTES (Experimental Beta — SH-2)
// ======================================================
// Minimal, safe recipient-picker for Worker Sharing V2:
//
//   GET /api/v1/users/lookup?username=<exact> — exact-match lookup
//
// Deliberately NOT a social directory: no listing, no prefix/fuzzy search,
// no email or other sensitive fields — the caller must already know the
// exact username (usernames are public identifiers in this model; they are
// shown in "Shared by <username>" anyway). Exact match = single indexed
// row read, no enumeration surface. Authenticated users only (guests are
// rejected — personal sharing targets registered users); kill-switch gated
// so the whole V2 surface stays dormant when sharing is off.

const userRepo = require('../storage/postgres/repositories/user-repo');
const config = require('../config/runtime-config');

const MAX_USERNAME_LEN = 120;

module.exports = function(app) {

    app.get('/api/v1/users/lookup', async (req, res) => {
        if (config.shareFeaturesEnabled() !== true) {
            return res.status(404).json({ error: 'Not found' });
        }
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
        }
        if (req.guest) {
            return res.status(403).json({ error: 'Guests cannot look up users', code: 'guest_forbidden' });
        }
        const raw = req.query && typeof req.query.username === 'string' ? req.query.username.trim() : '';
        if (!raw || raw.length > MAX_USERNAME_LEN) {
            return res.status(400).json({ error: 'username query parameter is required', code: 'invalid_username' });
        }
        try {
            const user = await userRepo.findByUsername(raw);
            if (!user) {
                return res.status(404).json({ error: 'User not found', code: 'unknown_user' });
            }
            // Public projection only — never email, hashes or settings.
            res.json({
                user: {
                    user_id: user.user_id,
                    username: user.username,
                    display_name: user.display_name || null,
                },
            });
        } catch (err) {
            console.error('[USERS] lookup failed:', err.message);
            res.status(500).json({ error: 'Failed to look up user' });
        }
    });

    console.log('[ROUTES] Users routes loaded');
};
