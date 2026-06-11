// ======================================================
// Book Sync - reconcile Book JSON with derived DB state
// ======================================================
// Whenever the Book JSON is updated (file re-saved, hot
// reload, or version bump), the derived database state
// (scene_assets, generation_tasks, image_units, etc.) must
// be brought back into alignment:
//
//   1. Detect added/removed/changed scenes via scene_hash
//   2. Update scenes.scene_hash for changed scenes
//   3. Mark scene_assets stale for changed scenes
//   4. Mark generation_tasks stale for changed scenes
//   5. Purge DB rows for scenes that no longer exist in JSON
//
// This module is the single reconciliation entry point
// for "Book JSON was touched → catch the DB up".

const bookSource = require('./book-source');
const { query } = require('../storage/postgres/database');
const { computeSceneHash } = require('../utils/scene-hash');

const logPrefix = '[BOOK-SYNC]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }

const SCENE_KEY = bookSource.SCENE_KEY;
const splitKey = (k) => {
    const i = k.indexOf('::');
    return [k.slice(0, i), k.slice(i + 2)];
};

// ======================================================
// DIFF
// ======================================================

async function detectChangedScenes(bookId) {
    const canonical = bookSource.getBookFingerprint(bookId);
    const r = await query(`
        SELECT chapter_id, scene_id, scene_hash
        FROM scenes WHERE book_id = $1
    `, [bookId]);
    const stored = new Map();
    for (const row of r.rows) {
        stored.set(SCENE_KEY(row.chapter_id, row.scene_id), row.scene_hash);
    }

    const added = [];
    const changed = [];
    const removed = [];

    for (const [key, hash] of canonical) {
        const prev = stored.get(key);
        if (prev === undefined || prev === null) {
            added.push({ chapter_scene: key, new_hash: hash });
        } else if (prev !== hash) {
            changed.push({ chapter_scene: key, old_hash: prev, new_hash: hash });
        }
    }
    for (const [key, hash] of stored) {
        if (!canonical.has(key)) {
            removed.push({ chapter_scene: key, old_hash: hash });
        }
    }

    return { added, changed, removed, canonical_count: canonical.size, stored_count: stored.size };
}

// ======================================================
// SYNC
// ======================================================

async function updateSceneHashes(bookId, items) {
    for (const item of items) {
        const [chapterId, sceneId] = splitKey(item.chapter_scene);
        await query(`
            INSERT INTO scenes (book_id, chapter_id, scene_id, scene_hash, updated_at)
            VALUES ($1, $2, $3, $4, EXTRACT(EPOCH FROM NOW())::bigint)
            ON CONFLICT(book_id, chapter_id, scene_id) DO UPDATE SET
                scene_hash = EXCLUDED.scene_hash,
                updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        `, [bookId, chapterId, sceneId, item.new_hash]);
    }
}

async function markSceneAssetsStale(bookId, chapterSceneKeys) {
    let total = 0;
    for (const key of chapterSceneKeys) {
        const [chapterId, sceneId] = splitKey(key);
        const r = await query(`
            UPDATE scene_assets
            SET status = 'stale', updated_at = EXTRACT(EPOCH FROM NOW())::bigint
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND status = 'ready'
        `, [bookId, chapterId, sceneId]);
        total += r.rowCount || 0;
    }
    return total;
}

async function markGenerationTasksStale(bookId, chapterSceneKeys) {
    let total = 0;
    for (const key of chapterSceneKeys) {
        const [chapterId, sceneId] = splitKey(key);
        const r = await query(`
            UPDATE generation_tasks
            SET status = 'cancelled', error = COALESCE(error, '') || ' (cancelled by book-sync)'
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
              AND status IN ('queued', 'running')
        `, [bookId, chapterId, sceneId]);
        total += r.rowCount || 0;
    }
    return total;
}

async function purgeRemovedSceneRows(bookId, removedKeys) {
    const out = {};
    if (removedKeys.length === 0) return out;

    for (const key of removedKeys) {
        const [chapterId, sceneId] = splitKey(key);
        for (const table of ['scene_assets', 'generation_tasks', 'image_units',
                              'storyboard_elements', 'audio_layers']) {
            const r = await query(`
                DELETE FROM ${table}
                WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
            `, [bookId, chapterId, sceneId]);
            out[table] = (out[table] || 0) + (r.rowCount || 0);
        }
        await query(`
            DELETE FROM scenes
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
        `, [bookId, chapterId, sceneId]);
    }
    return out;
}

async function syncBook(bookId, { dryRun = false, purgeRemoved = true } = {}) {
    const diff = await detectChangedScenes(bookId);

    const changedKeys = [
        ...diff.added.map(x => x.chapter_scene),
        ...diff.changed.map(x => x.chapter_scene),
    ];

    if (dryRun) {
        return {
            book_id: bookId,
            dry_run: true,
            added: diff.added.length,
            changed: diff.changed.length,
            removed: diff.removed.length,
            canonical_count: diff.canonical_count,
            stored_count: diff.stored_count,
        };
    }

    let assetsStale = 0;
    let tasksStale = 0;
    if (changedKeys.length > 0) {
        await updateSceneHashes(bookId, [...diff.added, ...diff.changed]);
        assetsStale = await markSceneAssetsStale(bookId, changedKeys);
        tasksStale = await markGenerationTasksStale(bookId, changedKeys);
    }

    let purged = {};
    if (purgeRemoved && diff.removed.length > 0) {
        purged = await purgeRemovedSceneRows(bookId, diff.removed.map(x => x.chapter_scene));
    }

    log(`SYNC ${bookId}: +${diff.added.length} ~${diff.changed.length} -${diff.removed.length} ` +
        `(assets_stale=${assetsStale} tasks_cancelled=${tasksStale})`);

    return {
        book_id: bookId,
        dry_run: false,
        added: diff.added.length,
        changed: diff.changed.length,
        removed: diff.removed.length,
        canonical_count: diff.canonical_count,
        stored_count: diff.stored_count,
        assets_marked_stale: assetsStale,
        generation_tasks_cancelled: tasksStale,
        purged,
    };
}

module.exports = {
    detectChangedScenes,
    syncBook,
    updateSceneHashes,
    markSceneAssetsStale,
    markGenerationTasksStale,
    purgeRemovedSceneRows,
};
