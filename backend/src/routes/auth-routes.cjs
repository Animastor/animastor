// ======================================================
// ANIMASTOR BACKEND — AUTH ROUTES (Authentication MVP + Guest Workspace MVP)
// ======================================================
// POST /api/v1/auth/register — create account (+ personal workspace + session);
//                              when called with a live guest cookie, the guest
//                              workspace is converted in place instead.
// POST /api/v1/auth/login    — username/password → session cookie
// POST /api/v1/auth/logout   — invalidate session OR guest identity (safe/
//                              idempotent)
// GET  /api/v1/auth/me       — current identity: user | guest | none
//
// Public/pre-auth endpoints — no auth required (that's the point of them).
// Cookies are HttpOnly; responses never contain tokens, password hashes or
// any secret.
//
// Usage:
//   require('./routes/auth-routes.cjs')(app, redis, deps);

module.exports = function(app, _redis, deps) {
    const authService = (deps && deps.authService) || require('../auth/auth-service');
    const guestRepo = (deps && deps.guestRepo) || require('../storage/postgres/repositories/guest-repo');
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
            // The guest identity comes from the HttpOnly cookie — never from
            // the body, so a client cannot point the conversion at someone
            // else's workspace.
            const guestToken = authService.readCookie(req, authService.GUEST_COOKIE_NAME);
            const result = await authService.register({ username, password, email, guestToken });
            const cookies = [authService.sessionCookieHeader(result.session.token, { secure: isSecure(req) })];
            if (result.converted) {
                // The old guest token must never open that workspace again.
                cookies.push(authService.clearGuestCookieHeader({ secure: isSecure(req) }));
            }
            res.setHeader('Set-Cookie', cookies);
            res.status(201).json({
                authenticated: true,
                converted: !!result.converted,
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
            const secure = isSecure(req);
            const cookies = [];
            const sessionToken = authService.readCookie(req, authService.SESSION_COOKIE_NAME);
            if (sessionToken) {
                await authService.logout(sessionToken); // idempotent
                cookies.push(authService.clearSessionCookieHeader({ secure }));
            }
            const guestToken = authService.readCookie(req, authService.GUEST_COOKIE_NAME);
            if (guestToken) {
                await guestRepo.revokeByToken(guestToken).catch(() => {});
                cookies.push(authService.clearGuestCookieHeader({ secure }));
                res.setHeader('Set-Cookie', cookies);
                return res.json({ ok: true, guest: true });
            }
            cookies.push(authService.clearGuestCookieHeader({ secure }));
            res.setHeader('Set-Cookie', cookies);
            res.json({ ok: true });
        } catch (err) {
            console.error('[AUTH] logout error:', err.message);
            // Still clear the cookies — logout must never strand the client.
            res.setHeader('Set-Cookie', [
                authService.clearSessionCookieHeader({ secure: isSecure(req) }),
                authService.clearGuestCookieHeader({ secure: isSecure(req) }),
            ]);
            res.json({ ok: true });
        }
    });

    app.get('/api/v1/auth/me', async (req, res) => {
        try {
            // Route handler runs after authContext: a valid session has
            // already populated req.user/req.workspace, or the request may
            // carry a guest identity (guest workspaces have status
            // 'active'|'expired' so the client can render both).
            if (req.user) {
                return res.json({
                    authenticated: true,
                    identity: 'user',
                    user: { id: req.user.userId, username: req.user.username, display_name: req.user.displayName || null },
                    workspace: req.workspace,
                });
            }
            if (req.guest && req.workspace) {
                return res.json({
                    authenticated: false,
                    identity: 'guest',
                    user: null,
                    workspace: {
                        id: req.workspace.id,
                        name: req.workspace.name,
                        type: req.workspace.type,
                        status: req.workspace.status || 'active',
                        expires_at: req.workspace.expiresAt || null,
                    },
                });
            }
            return res.json({ authenticated: false, identity: 'none', user: null, workspace: null });
        } catch (err) {
            console.error('[AUTH] me error:', err.message);
            res.status(500).json({ error: 'Failed to resolve current user' });
        }
    });

    log('[ROUTES] Auth routes loaded');
};
