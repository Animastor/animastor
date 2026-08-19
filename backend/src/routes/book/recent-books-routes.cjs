// ======================================================
// Recent Books Route — GET /api/v1/books
// ======================================================
// Lets ANY client (native Android, mobile web, web) discover which books exist
// on the server, so a book imported/opened on one device can be restored on
// another. Backed by the book_source PG table (SHA-256 → book_id, registered on
// TXT import) plus a disk scan fallback for books not in PG (e.g. .vbook
// imports). Each entry is joined with the lazy-book manifest for display state,
// title and build_id.
//
// The route handler is exported separately as `collectRecentBooks` so unit
// tests can exercise the merge logic without PG or an HTTP server.
//
// When auth is implemented, this endpoint will filter by workspace membership:
// - Authenticated users see only books in their workspaces
// - Unauthenticated users see all books (pre-auth mode)
// ======================================================

const fs = require('fs');

const DEFAULT_LIMIT = 20;

/** Resolve book status; never throws for a single missing/corrupt book. */
function safeStatus(lazyBook, bookId) {
    try {
        return lazyBook.getBookStatus(bookId);
    } catch (_) {
        return null;
    }
}

/** Resolve build_id from the lazy-book manifest; null when unavailable. */
function buildIdOf(lazyBook, bookId) {
    try {
        const d = lazyBook.loadDraftBook(bookId);
        return (d && d.manifest && d.manifest.build_id) || null;
    } catch (_) {
        return null;
    }
}

function toEntry(lazyBook, bookId, { title, state, sourceType, fileHash, updatedAt, parsedChapters, totalScenes, workspaceId }) {
    return {
        book_id: bookId,
        build_id: buildIdOf(lazyBook, bookId),
        title: title || bookId,
        state: state || null,
        source_type: sourceType || 'txt',
        file_hash: fileHash || null,
        updated_at: updatedAt || 0,
        parsed_chapters: parsedChapters || 0,
        total_scenes: totalScenes || 0,
        workspace_id: workspaceId || null,
    };
}

/**
 * Build the recent-books list.
 *
 * @param {object} deps - { bookSourceRepo, lazyBook, limit?, workspaceId? }
 * @returns {Promise<Array>} sorted newest-first, capped at `limit`.
 */
async function collectRecentBooks({ bookSourceRepo, lazyBook, limit = DEFAULT_LIMIT, workspaceId }) {
    const entries = new Map(); // book_id -> entry
    const seen = new Set();

    // ── Phase 1: PG book_source (fast path — TXT imports register here) ──
    let pgRows = [];
    try {
        pgRows = await bookSourceRepo.listRecent(limit * 2);
    } catch (err) {
        // PG may be down; the disk scan below still yields something.
    }
    for (const row of pgRows || []) {
        seen.add(row.book_id);
        const status = safeStatus(lazyBook, row.book_id);
        if (!status) continue; // book no longer on disk — skip stale reference
        entries.set(row.book_id, toEntry(lazyBook, row.book_id, {
            title: status.title,
            state: status.state,
            sourceType: row.source_type || 'txt',
            fileHash: row.file_hash || null,
            // Prefer manifest update time; fall back to the PG import timestamp
            // so a book whose manifest lacks updated_at still ranks by recency.
            updatedAt: status.updatedAt != null ? status.updatedAt : row.created_at,
            parsedChapters: status.parsedChapters,
            totalScenes: status.parsedScenes,
        }));
    }

    // ── Phase 2: disk scan — books not registered in PG (e.g. .vbook imports) ──
    const booksDir = lazyBook.getBooksDir();
    if (booksDir && fs.existsSync(booksDir)) {
        let dirNames = [];
        try {
            dirNames = fs.readdirSync(booksDir, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name);
        } catch (_) { /* books dir unreadable */ }
        for (const bookId of dirNames) {
            if (seen.has(bookId)) continue;
            const status = safeStatus(lazyBook, bookId);
            if (!status) continue;
            entries.set(bookId, toEntry(lazyBook, bookId, {
                title: status.title,
                state: status.state,
                sourceType: 'disk',
                fileHash: null,
                updatedAt: status.updatedAt,
                parsedChapters: status.parsedChapters,
                totalScenes: status.parsedScenes,
            }));
        }
    }

    let result = [...entries.values()];

    // ── Phase 3: workspace filtering (when auth is implemented) ──
    // For now, this is a no-op. When auth is implemented:
    // - If workspaceId is provided, filter to books in that workspace
    // - If no workspaceId, return all books (pre-auth mode)
    if (workspaceId) {
        result = result.filter(entry => entry.workspace_id === workspaceId);
    }

    const sortKey = (entry) => Number(entry.updated_at) || 0;
    return result
        .sort((a, b) => sortKey(b) - sortKey(a))
        .slice(0, Math.max(1, Number(limit) || DEFAULT_LIMIT));
}

module.exports = function registerRecentBooksRoutes(app, _redis, deps) {
    const { bookSourceRepo, lazyBook } = deps;
    const log = (deps.utils && deps.utils.log) || (() => {});

    app.get('/api/v1/books', async (req, res) => {
        try {
            // When auth is implemented, get workspaceId from req.workspace
            // For now, pass undefined to get all books (pre-auth mode)
            const workspaceId = req.workspace?.id || null;

            const books = await collectRecentBooks({
                bookSourceRepo,
                lazyBook,
                limit: parseInt(req.query.limit, 10) || DEFAULT_LIMIT,
                workspaceId,
            });
            res.json({ books });
        } catch (err) {
            console.error('[RECENT-BOOKS] Error:', err.message);
            res.status(500).json({ error: err.message || 'unknown error' });
        }
    });

    log('[ROUTES] Recent books route loaded');
};

module.exports.collectRecentBooks = collectRecentBooks;
