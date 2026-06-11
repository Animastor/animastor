// ======================================================
// Book Integrity - reference integrity for derived DB state
// ======================================================
// Verifies that every row in scene-keyed tables references
// a scene that still exists in the Book JSON. Detects
// "orphan" rows caused by:
//   - scenes removed from the Book JSON
//   - scene IDs renamed in the Book JSON
//   - books that no longer have a JSON file on disk
//
// Provides both a report-only mode (read-only checks) and
// a purge mode (delete orphans, with safety flags).

const bookSource = require('./book-source');
const bookLoader = require('../book');
const { query } = require('../storage/postgres/database');

const logPrefix = '[BOOK-INTEGRITY]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }

const SCENE_KEY = bookSource.SCENE_KEY;

// Tables whose rows are keyed by (book, chapter, scene)
const SCENE_TABLES = [
    { table: 'scene_assets', columns: ['id', 'asset_type', 'path', 'status', 'build_id'] },
    { table: 'generation_tasks', columns: ['id', 'task_id', 'task_type', 'status'] },
    { table: 'image_units', columns: ['id', 'unit_id', 'text'] },
    { table: 'storyboard_elements', columns: ['id', 'element_type'] },
    { table: 'audio_layers', columns: ['id', 'layer_type'] },
    { table: 'scenes', columns: ['scene_id', 'status', 'scene_hash'] },
];

// ======================================================
// ORPHAN DETECTION
// ======================================================

async function getOrphanRows(bookId, tableName) {
    const canonical = bookSource.getCanonicalScenes(bookId);
    const result = await query(`SELECT * FROM ${tableName} WHERE book_id = $1`, [bookId]);
    return result.rows.filter(row => !canonical.has(SCENE_KEY(row.chapter_id, row.scene_id)));
}

async function getOrphansForBook(bookId) {
    const out = { book_id: bookId, tables: {}, total_orphans: 0 };
    for (const { table } of SCENE_TABLES) {
        const orphans = await getOrphanRows(bookId, table);
        out.tables[table] = orphans;
        out.total_orphans += orphans.length;
    }
    return out;
}

async function getOrphanSummary(bookId) {
    const out = { book_id: bookId, counts: {}, total: 0 };
    for (const { table } of SCENE_TABLES) {
        const orphans = await getOrphanRows(bookId, table);
        out.counts[table] = orphans.length;
        out.total += orphans.length;
    }
    return out;
}

// ======================================================
// INTEGRITY REPORT
// ======================================================

async function generateIntegrityReport(bookId) {
    const bookJson = bookLoader.loadBook(bookId);
    const bookJsonPresent = bookJson !== null;

    const canonicalScenes = bookJsonPresent
        ? bookSource.getCanonicalScenes(bookId)
        : new Set();

    const canonicalCount = canonicalScenes.size;
    const orphanSummary = bookJsonPresent
        ? await getOrphanSummary(bookId)
        : null;

    return {
        book_id: bookId,
        book_json_present: bookJsonPresent,
        canonical_scene_count: canonicalCount,
        canonical_chapter_count: bookJsonPresent
            ? bookSource.getCanonicalChapters(bookId).length
            : 0,
        orphans: orphanSummary
            ? orphanSummary.counts
            : 'book_json_missing',
        orphan_total: orphanSummary ? orphanSummary.total : null,
        generated_at: Math.floor(Date.now() / 1000),
    };
}

async function generateIntegrityReportAllBooks() {
    const r = await query(`
        SELECT DISTINCT book_id FROM (
            SELECT book_id FROM scene_assets
            UNION SELECT book_id FROM generation_tasks
            UNION SELECT book_id FROM image_units
            UNION SELECT book_id FROM storyboard_elements
            UNION SELECT book_id FROM audio_layers
            UNION SELECT book_id FROM scenes
        ) AS b
        ORDER BY book_id
    `);
    const reports = [];
    for (const row of r.rows) {
        reports.push(await generateIntegrityReport(row.book_id));
    }
    return reports;
}

// ======================================================
// PURGE
// ======================================================

async function purgeOrphansForTable(bookId, tableName, { dryRun = true } = {}) {
    const orphans = await getOrphanRows(bookId, tableName);
    if (orphans.length === 0) return { table: tableName, deleted: 0, dry_run: dryRun };

    if (dryRun) {
        log(`[DRY-RUN] Would delete ${orphans.length} orphan rows from ${tableName}`);
        return { table: tableName, deleted: 0, would_delete: orphans.length, dry_run: true };
    }

    let total = 0;
    for (const o of orphans) {
        const r = await query(`
            DELETE FROM ${tableName}
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
        `, [bookId, o.chapter_id, o.scene_id]);
        total += r.rowCount || 0;
    }
    log(`PURGED ${total} orphan rows from ${tableName} (book=${bookId})`);
    return { table: tableName, deleted: total, dry_run: false };
}

async function purgeOrphans(bookId, { dryRun = true, tables = null } = {}) {
    const targetTables = tables || SCENE_TABLES.map(t => t.table);
    const results = [];
    for (const table of targetTables) {
        results.push(await purgeOrphansForTable(bookId, table, { dryRun }));
    }
    return { book_id: bookId, dry_run: dryRun, results };
}

module.exports = {
    SCENE_TABLES,
    getOrphanRows,
    getOrphansForBook,
    getOrphanSummary,
    generateIntegrityReport,
    generateIntegrityReportAllBooks,
    purgeOrphans,
    purgeOrphansForTable,
};
