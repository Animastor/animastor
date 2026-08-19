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
// Workspace ownership (Account System foundation):
// - When `workspaceId` is provided the list is restricted to books whose
//   books.workspace_id matches; PG rows are pre-filtered server-side
//   (book_source JOIN books), so no row can leak by anything but the filter.
// - The disk-scan fallback is skipped entirely under a workspace filter: a
//   disk-only book has no known owner in PG, and listing it would leak the
//   "knows the path → sees the book" assumption into a multi-tenant world.
// - Books whose registry row is missing workspace_id are self-healed through
//   an optional `resolveBookWorkspace` callback before filtering.
// - Pre-auth mode (no workspaceId) keeps today's behaviour: all books, with
//   workspace_id exposed as metadata on every entry.
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
 * @param {object} deps
 * @param {object} deps.bookSourceRepo
 * @param {object} deps.lazyBook
 * @param {number} [deps.limit]
 * @param {string} [deps.workspaceId] - restrict the list to this workspace.
 *   Under a filter only PG-known books with ownership are eligible; the
 *   disk-scan fallback is skipped.
 * @param {function} [deps.resolveBookWorkspace] - async (bookId, title) =>
 *   workspaceId|null. Self-heals books whose registry row lacks a workspace
 *   (e.g. created before ownership existed or while PG was down). When set,
 *   every entry's workspace_id is resolved before (optional) filtering.
 * @returns {Promise<Array>} sorted newest-first, capped at `limit`.
 */
async function collectRecentBooks({ bookSourceRepo, lazyBook, limit = DEFAULT_LIMIT, workspaceId, resolveBookWorkspace, bookRepo }) {
    const entries = new Map(); // book_id -> entry
    const seen = new Set();

    // ── Phase 1: PG book_source (fast path — TXT imports register here) ──
    let pgRows = [];
    try {
        pgRows = await bookSourceRepo.listRecent(limit * 2, { workspaceId });
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
            workspaceId: row.workspace_id || null,
            // Prefer manifest update time; fall back to the PG import timestamp
            // so a book whose manifest lacks updated_at still ranks by recency.
            updatedAt: status.updatedAt != null ? status.updatedAt : row.created_at,
            parsedChapters: status.parsedChapters,
            totalScenes: status.parsedScenes,
        }));
    }

    // ── Phase 1.5: ownership registry merge (workspace-scoped only) ──
    // book_source indexes TXT imports only; blank books and .vbook imports have
    // ownership in the books table alone. Merge them so the workspace list is
    // complete. Never merged pre-auth (the books registry then adds nothing the
    // disk scan doesn't already cover, and keeps the disk-only path intact).
    if (workspaceId && bookRepo) {
        try {
            const ownedRows = await bookRepo.listBookIdsByWorkspace(workspaceId);
            for (const row of ownedRows || []) {
                if (seen.has(row.book_id)) continue;
                seen.add(row.book_id);
                const status = safeStatus(lazyBook, row.book_id);
                if (!status) continue; // book no longer on disk — skip stale reference
                entries.set(row.book_id, toEntry(lazyBook, row.book_id, {
                    title: status.title,
                    state: status.state,
                    sourceType: 'registry',
                    fileHash: null,
                    workspaceId: row.workspace_id,
                    updatedAt: status.updatedAt,
                    parsedChapters: status.parsedChapters,
                    totalScenes: status.parsedScenes,
                }));
            }
        } catch (err) {
            // PG may be down; Phase 1 rows still apply.
        }
    }

    // ── Phase 2: disk scan — books not registered in PG (e.g. .vbook imports) ──
    // Skipped under a workspace filter: disk-only books have no owner record.
    if (!workspaceId) {
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
    }

    let result = [...entries.values()];

    // ── Phase 3: workspace ownership resolution + filtering ──
    if (resolveBookWorkspace) {
        for (let i = 0; i < result.length; i++) {
            const entry = result[i];
            if (!entry.workspace_id) {
                try {
                    entry.workspace_id = await resolveBookWorkspace(entry.book_id, entry.title) || null;
                } catch (_) {
                    entry.workspace_id = null;
                }
            }
        }
        // Never leak books owned by another workspace.
        result = workspaceId
            ? result.filter(entry => entry.workspace_id === workspaceId)
            : result.filter(entry => entry.workspace_id != null);
    } else if (workspaceId) {
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
    const bookRepo = require('../../storage/postgres/repositories/book-repo');
    const workspaceOwnership = deps.workspaceOwnership
        || require('../../middleware/workspace-ownership');

    app.get('/api/v1/books', async (req, res) => {
        try {
            // Pre-auth: req.workspace is always null → all books. Once auth
            // lands, req.workspace.id restricts the list to the caller.
            const workspaceId = req.workspace?.id || null;

            const books = await collectRecentBooks({
                bookSourceRepo,
                lazyBook,
                limit: parseInt(req.query.limit, 10) || DEFAULT_LIMIT,
                workspaceId,
                bookRepo: workspaceId ? bookRepo : undefined,
                // Self-heal ownership rows under a workspace scope; pre-auth keeps
                // listing everything so a brief PG outage never empties the page.
                ...(workspaceId ? {
                    resolveBookWorkspace: (bookId, title) => workspaceOwnership
                        .resolveWorkspaceForBook(bookId, { bookTitle: title, preferredWorkspaceId: workspaceId }),
                } : {}),
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
