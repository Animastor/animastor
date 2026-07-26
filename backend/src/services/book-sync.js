// ======================================================
// Book Sync - reconcile Book JSON with derived DB state
// ======================================================
// ⚠️ ARCHITECTURE NOTE ⚠️
// ========================
//
// This module is a READ-ONLY AUDITOR in the production flow.
// PRIMARY diff mechanism: book-diff.cjs (via Prompt Dependency Registry)
//
// Responsibilities:
//   1. reconcileFromDiff() — primary entry point, called after
//      book-diff detects changes. Updates PG hashes, marks assets
//      stale, cancels tasks, purges removed scenes.
//   2. detectChangedScenes() / syncBook() — DEPRECATED, kept for
//      manual audit / PG consistency checks. Not called in production.
//
// Data flow:
//   PUT /book/:bookId → save to disk
//     → POST /regenerate → book-diff.computeBookDiff() → Redis markDirty
//     → book-sync.reconcileFromDiff() → PG hash/assets/tasks update
//
const bookSource = require('./book-source');
const { query } = require('../storage/postgres/database');
const { computeSceneHash } = require('../utils/scene-hash');
const { getOutdatedByVersions } = require('../storage/postgres/repositories/scene-assets-repo');

const logPrefix = '[BOOK-SYNC]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }

const SCENE_KEY = bookSource.SCENE_KEY;
const splitKey = (k) => {
    const i = k.indexOf('::');
    return [k.slice(0, i), k.slice(i + 2)];
};

// ======================================================
// ✨ PRIMARY: reconcileFromDiff (called after book-diff)
// ======================================================

/**
 * Reconcile PG state based on a book-diff result.
 * Called after persisted book content changes have been diffed.
 *
 * @param {string} bookId
 * @param {Array} dirtyScenes - book-diff dirty scenes [{chapter_id, scene_id, reason, dirty_layers}]
 * @param {Object} loadedBook - Current book JSON (for scene hash computation)
 * @returns {Object} reconciliation stats
 */
async function reconcileFromDiff(bookId, dirtyScenes, loadedBook) {
    if (!dirtyScenes || dirtyScenes.length === 0) {
        return { book_id: bookId, reconciled: 0 };
    }

    const changed = dirtyScenes.filter(d => d.reason !== 'removed');
    const removed = dirtyScenes.filter(d => d.reason === 'removed');

    const changedKeys = changed.map(d => SCENE_KEY(d.chapter_id, d.scene_id));
    const removedKeys = removed.map(d => SCENE_KEY(d.chapter_id, d.scene_id));

    let scenesUpdated = 0;
    let assetsStale = 0;
    let tasksCancelled = 0;
    let purged = {};

    // ── Update PG scene hashes for changed/added scenes ──
    if (changedKeys.length > 0) {
        const items = [];
        for (const d of changed) {
            const scene = findSceneData(loadedBook, d.chapter_id, d.scene_id);
            if (scene) {
                const hash = computeSceneHash(scene);
                items.push({ chapter_scene: SCENE_KEY(d.chapter_id, d.scene_id), new_hash: hash });
            } else {
                console.warn(`[BOOK-SYNC] Scene ${d.chapter_id}/${d.scene_id} not found in book JSON — cannot update PG hash`);
            }
        }
        if (items.length > 0) {
            await updateSceneHashes(bookId, items);
            scenesUpdated = items.length;
        }

        // Mark scene_assets as stale for changed scenes
        assetsStale = await markSceneAssetsStale(bookId, changedKeys);

        // Cancel only task types invalidated by the content diff.
        tasksCancelled = await markGenerationTasksStale(bookId, changed);
    }

    // ── Purge DB rows for removed scenes ──
    if (removedKeys.length > 0) {
        purged = await purgeRemovedSceneRows(bookId, removedKeys);
    }

    log(`RECONCILE ${bookId}: ~${scenesUpdated} scene hashes, ${assetsStale} assets stale, ${tasksCancelled} tasks cancelled, ${Object.values(purged).reduce((a, b) => a + b, 0)} rows purged`);

    // R16: Cross-cutting version-based staleness check
    // Find any ready assets whose version is behind the current scene version.
    // This catches stale assets that may have been missed by the dirty-scene-based
    // marking above (e.g., assets that were re-generated with an old version).
    let versionOutdatedCount = 0;
    try {
        const sceneVersionsResult = await query(`
            SELECT chapter_id, scene_id, content_version, audio_config_version
            FROM scenes
            WHERE book_id = $1
        `, [bookId]);
        const sceneVersionMap = new Map();
        for (const row of sceneVersionsResult.rows) {
            const key = `${row.chapter_id}:${row.scene_id}`;
            sceneVersionMap.set(key, {
                content_version: row.content_version,
                audio_config_version: row.audio_config_version,
            });
        }
        if (sceneVersionMap.size > 0) {
            const outdatedAssets = await getOutdatedByVersions(bookId, sceneVersionMap);
            if (outdatedAssets.length > 0) {
                // Log version-based staleness — these assets are stale but might not
                // have been caught by the scene-level dirty marking (e.g., cross-cutting
                // changes that affected these scenes indirectly).
                for (const asset of outdatedAssets) {
                    log(`[VERSION-OUTDATED] ${bookId}/${asset.chapter_id}/${asset.scene_id}: ${asset.asset_type} ${asset._outdated_reason} (expected ${asset._expected_version}, has ${asset.scene_content_version})`);
                }
                versionOutdatedCount = outdatedAssets.length;
            }
        }
    } catch (err) {
        console.warn(`[BOOK-SYNC] Version-based staleness check failed for ${bookId}: ${err.message}`);
    }

    if (versionOutdatedCount > 0) {
        log(`RECONCILE ${bookId}: ${versionOutdatedCount} assets outdated by version check`);
    }

    return {
        book_id: bookId,
        reconciled: changedKeys.length + removedKeys.length,
        scene_hashes_updated: scenesUpdated,
        assets_marked_stale: assetsStale,
        generation_tasks_cancelled: tasksCancelled,
        purged,
        version_outdated: versionOutdatedCount,
    };
}

/**
 * Find raw scene data in loadedBook for hash computation.
 */
function findSceneData(loadedBook, chapterId, sceneId) {
    if (!loadedBook?.chapters) return null;
    for (const ch of loadedBook.chapters) {
        if (ch.chapter !== chapterId) continue;
        if (!ch.scenes) continue;
        return ch.scenes.find(s => s.scene_id === sceneId) || null;
    }
    return null;
}

// ======================================================
// 🔍 AUDIT: detectChangedScenes (read-only, not called in production)
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

        // R15+: Upsert — garantiert, dass für jede geänderte Szene ein
        // scene_assets-Eintrag existiert. So kann die Versionsprüfung in
        // sceneHasValidContent() immer greifen.
        //
        // 1. Bestehende Zeilen aktualisieren: Version propagieren,
        //    'ready'-Einträge auf 'stale' setzen.
        //    Filter by sa.status = 'ready' so rowCount reflects only
        //    assets whose status actually changed — not already-stale rows.
        const updateResult = await query(`
            UPDATE scene_assets sa
            SET status = 'stale',
                scene_content_version = COALESCE(sv.content_version, sa.scene_content_version),
                scene_audio_config_version = COALESCE(sv.audio_config_version, sa.scene_audio_config_version),
                updated_at = EXTRACT(EPOCH FROM NOW())::bigint
            FROM scenes sv
            WHERE sa.book_id = $1 AND sa.chapter_id = $2 AND sa.scene_id = $3
              AND sa.status = 'ready'
              AND sv.book_id = $1 AND sv.chapter_id = $2 AND sv.scene_id = $3
        `, [bookId, chapterId, sceneId]);

        // 2. Falls keine Zeilen existieren, einen synthetischen 'audio'-Eintrag
        //    anlegen, damit der Versionsvergleich in sceneHasValidContent()
        //    die Staleness erkennen kann (asset.scene_content_version < scene.content_version).
        if (updateResult.rowCount === 0) {
            await query(`
                INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, status, scene_content_version, scene_audio_config_version, updated_at)
                SELECT $1, $2, $3, 'audio', 'stale',
                       sv.content_version, sv.audio_config_version,
                       EXTRACT(EPOCH FROM NOW())::bigint
                FROM scenes sv
                WHERE sv.book_id = $1 AND sv.chapter_id = $2 AND sv.scene_id = $3
                ON CONFLICT(book_id, chapter_id, scene_id, asset_type, build_id)
                DO UPDATE SET
                    status = 'stale',
                    scene_content_version = EXCLUDED.scene_content_version,
                    scene_audio_config_version = EXCLUDED.scene_audio_config_version,
                    updated_at = EXTRACT(EPOCH FROM NOW())::bigint
            `, [bookId, chapterId, sceneId]);
            total++;
        } else {
            total += updateResult.rowCount || 0;
        }
    }
    return total;
}

async function markGenerationTasksStale(bookId, dirtyScenes) {
    let total = 0;
    for (const entry of dirtyScenes) {
        const isLegacyKey = typeof entry === 'string';
        const [chapterId, sceneId] = isLegacyKey
            ? splitKey(entry)
            : [entry.chapter_id, entry.scene_id];
        const dirtyLayers = isLegacyKey
            ? ['audio', 'image', 'video']
            : (Array.isArray(entry.dirty_layers)
                ? entry.dirty_layers
                : ['audio', 'image', 'video']).filter(layer =>
                layer === 'audio' || layer === 'image' || layer === 'video'
            );
        if (!chapterId || !sceneId || dirtyLayers.length === 0) continue;

        const r = await query(`
            UPDATE generation_tasks
            SET status = 'cancelled',
                completed_at = EXTRACT(EPOCH FROM NOW())::bigint,
                error = COALESCE(error, '') || ' (cancelled by book-sync)'
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
              AND task_type = ANY($4::text[])
              AND status IN ('queued', 'running')
        `, [bookId, chapterId, sceneId, dirtyLayers]);
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
    reconcileFromDiff,
    updateSceneHashes,
    markSceneAssetsStale,
    markGenerationTasksStale,
    purgeRemovedSceneRows,
};
