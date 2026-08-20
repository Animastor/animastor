// ======================================================
// ANIMASTOR BACKEND — AUTH ROUTES (Authentication MVP)
// ======================================================
// POST /api/v1/auth/register — create account (+ personal workspace + session)
// POST /api/v1/auth/login    — username/password → session cookie
// POST /api/v1/auth/logout   — invalidate session (idempotent)
// GET  /api/v1/auth/me       — current user + workspace (or {authenticated:false})
//
// Public/pre-auth endpoints — no auth required (that's the point of them).
// The session cookie is HttpOnly; responses never contain the token, password
// hash or any secret.
//
// Usage:
//   require('./routes/auth-routes.cjs')(app, redis, deps);

module.exports = function(app, _redis, deps) {
    const authService = (deps && deps.authService) || require('../auth/auth-service');
    const log = (deps && deps.utils && deps.utils.log) || (() => {});

    /** Detect production/HTTPS context for the Secure cookie flag. */
    function isSecure(req) {
        if (process.env.NODE_ENV === 'production') return true;
        const proto = (req.headers && req.headers['x-forwarded-proto']) || '';
        return proto.split(',')[0].trim() === 'https';
    }

    app.post('/api/v1/auth/register', async (req, res) => {
        try {
            const { username, password, email } = req.body || {};
            const result = await authService.register({ username, password, email });
            res.setHeader('Set-Cookie', authService.sessionCookieHeader(result.session.token, { secure: isSecure(req) }));
            res.status(201).json({
                authenticated: true,
                user: result.user,
                workspace: result.workspace,
            });
        } catch (err) {
            if (err instanceof authService.AuthError) {
                return res.status(err.status).json({ error: err.message, reason: err.reason });
            }
            console.error('[AUTH] register error:', err.message);
            res.status(500).json({ error: 'Registration failed' });
        }
    });

    app.post('/api/v1/auth/login', async (req, res) => {
        try {
            const { username, password } = req.body || {};
            const result = await authService.login({ username, password });
            res.setHeader('Set-Cookie', authService.sessionCookieHeader(result.session.token, { secure: isSecure(req) }));
            res.json({
                authenticated: true,
                user: result.user,
                workspace: result.workspace,
            });
        } catch (err) {
            if (err instanceof authService.AuthError) {
                return res.status(err.status).json({ error: err.message, reason: err.reason });
            }
            console.error('[AUTH] login error:', err.message);
            res.status(500).json({ error: 'Login failed' });
        }
    });

    app.post('/api/v1/auth/logout', async (req, res) => {
        try {
            const token = authService.readCookie(req, authService.SESSION_COOKIE_NAME);
            await authService.logout(token); // safe for null/unknown/already-revoked
            res.setHeader('Set-Cookie', authService.clearSessionCookieHeader({ secure: isSecure(req) }));
            res.json({ ok: true });
        } catch (err) {
            console.error('[AUTH] logout error:', err.message);
            // Still clear the cookie — logout must never strand the client.
            res.setHeader('Set-Cookie', authService.clearSessionCookieHeader({ secure: isSecure(req) }));
            res.json({ ok: true });
        }
    });

    app.get('/api/v1/auth/me', async (req, res) => {
        try {
            // Route handler runs after authContext, so a valid session has
            // already populated req.user/req.workspace.
            if (!req.user) {
                return res.json({ authenticated: false, user: null, workspace: null });
            }
            res.json({
                authenticated: true,
                user: { id: req.user.userId, username: req.user.username, display_name: req.user.displayName || null },
                workspace: req.workspace,
            });
        } catch (err) {
            console.error('[AUTH] me error:', err.message);
            res.status(500).json({ error: 'Failed to resolve current user' });
        }
    });

    log('[ROUTES] Auth routes loaded');
};
