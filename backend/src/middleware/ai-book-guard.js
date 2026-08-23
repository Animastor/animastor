// ======================================================
// AI Book Guard
// ======================================================
// Authorization guard for the /api/v1/ai/* surface (chat, chat/stream,
// prompt, sessions, lock, ...). The target book is carried in the query,
// body or session (never in the URL path for most AI endpoints), so it is
// resolved here and the AUTHORIZED book is handed to the downstream handler
// via `req.scopedBookId`. Handlers MUST use exactly that id and must not
// re-derive a different one from the request body — the guard/handler
// mismatch that previously allowed "authorized book A, operated on book B"
// (cross-tenant provider use, book data disclosure, book write).
//
// Denial rules (fail closed for authenticated identities):
//   - query.book_id and body.book_id differ → 400 (never legitimate)
//   - explicit book id differs from the session's book → 400
//   - the resolved book is not in the caller's workspace → 403
//   - expired guest workspace → 410
// Pre-auth requests (no identity) pass through unchanged (legacy behaviour);
// in that mode req.scopedBookId stays unset and handlers fall back to their
// historical body/session lookup.

const { query } = require('../storage/postgres/database');

const aiSessionRepoQuery = (id) => query(
    'SELECT book_id FROM ai_chat_sessions WHERE id = $1 LIMIT 1', [id]
).catch(() => null);

const aiBookGuard = async (req, res, next) => {
    const { hasIdentity, checkBookAccess, WorkspaceExpiredError } = require('./auth-context');
    if (!hasIdentity(req)) return next(); // pre-auth compatibility
    try {
        const queryBookId = (req.query && req.query.book_id) || null;
        const bodyBookId = (req.body && req.body.book_id) || null;
        const sessionId = (req.query && req.query.session_id)
            || (req.body && req.body.session_id)
            || (req.params && req.params.id)
            || null;

        // A caller that scopes one book in the query and a different one in
        // the body is asking the handler to operate on a book that was never
        // authorized. Deny outright — never guess which one to trust.
        if (queryBookId && bodyBookId && queryBookId !== bodyBookId) {
            return res.status(400).json({ error: 'book_id mismatch between query and body', code: 'book_id_mismatch' });
        }

        let bookId = queryBookId || bodyBookId || null;

        // Session-derived book: a session belongs to exactly one book. When an
        // explicit book id is also present it MUST match the session's book;
        // otherwise the caller scopes book A while writing into session B.
        if (sessionId) {
            const row = await aiSessionRepoQuery(sessionId);
            const sessionBookId = (row && row.rows && row.rows[0] && row.rows[0].book_id) || null;
            if (bookId && sessionBookId && sessionBookId !== bookId) {
                return res.status(400).json({ error: 'session/book mismatch', code: 'session_book_mismatch' });
            }
            if (!bookId) bookId = sessionBookId;
        }

        if (!bookId) return next(); // endpoint without a book scope — nothing to guard

        const ws = await checkBookAccess(req, bookId);
        console.log('[AI-BOOK-GUARD] bookId:', bookId, 'userId:', req.user?.userId, 'guestId:', req.guest?.guestId, 'ws:', req.workspace?.id, 'access:', ws?.id || null);
        if (!ws) {
            return res.status(403).json({ error: 'Access denied: not a member of the book\'s workspace' });
        }
        req.scopedBookId = bookId;
        req.scopedSessionId = sessionId || null;
        return next();
    } catch (err) {
        if (err instanceof WorkspaceExpiredError) {
            return res.status(410).json({ error: 'Guest workspace expired', code: 'workspace_expired' });
        }
        console.error('[AUTH] AI book guard failed (fail closed):', err.message);
        return res.status(403).json({ error: 'Access denied' });
    }
};

module.exports = { aiBookGuard, aiSessionRepoQuery };