// ======================================================
// Startup Recovery — centralized Redis state restoration
// ======================================================
// On backend restart, Redis is empty (volatile). This module
// restores critical Redis state from persistent sources:
//
//   1. Disk (OUTPUT_DIR/*.mp3, *.png, *.mp4) — chunk metadata
//   2. PostgreSQL (scenes, scene_assets) — version info
//   3. Incomplete generation sessions — resume logic
//
// Data flow:
//   backend.cjs startup →
//     startupRecovery.recoverAll() →
//       recoverChunksFromDisk()    (existing, Redis chunks)
//       reconcileSceneCounters()   (BOOK_SCENE_TOTAL/NEXT)
//       checkVersionStaleness()    (PG version vs asset version)
//       resumeIncompleteSessions() (existing, PG sessions)
//
const path = require('path');
const fs = require('fs');

const { computeSceneHash } = require('../utils/scene-hash');

const logPrefix = '[STARTUP-RECOVERY]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }
function warn(msg) { console.warn(`${logPrefix} ⚠️  ${msg}`); }

// ======================================================
// MAIN ENTRY POINT
// ======================================================

/**
 * Run all startup recovery steps.
 * Called once when the backend starts.
 *
 * @param {Object} redis - Redis client
 * @param {Object} deps - Dependencies { recoverAllBooksFromDisk, postgres, state, config, placeholderAudio }
 * @returns {Promise<{recovered: number, version_outdated: number, sessions_resumed: number, errors: string[]}>}
 */
async function recoverAll(redis, deps) {
    const startTime = Date.now();
    const result = { recovered: 0, version_outdated: 0, sessions_resumed: 0, errors: [] };

    log('Starting full startup recovery...');

    // ── Step 1: Recover Redis chunks from disk (existing logic) ──
    try {
        if (deps.recoverAllBooksFromDisk) {
            await deps.recoverAllBooksFromDisk();
            log('Step 1 complete: Redis chunks recovered from disk');
        } else {
            warn('recoverAllBooksFromDisk not available, skipping chunk recovery');
        }
    } catch (err) {
        warn(`Step 1 failed (chunk recovery): ${err.message}`);
        result.errors.push(`chunk_recovery: ${err.message}`);
    }

    // ── Step 2: For each book, additionally recover IU images from disk ──
    // This catches scenes that have .mp3 + .png files but no Redis chunks
    // (e.g., if recoverAllBooksFromDisk only found .mp3 files).
    try {
        const recoveredImages = await recoverIuImagesFromDisk(redis, deps);
        if (recoveredImages > 0) {
            log(`Step 2 complete: ${recoveredImages} IU image flags restored`);
        }
        result.recovered += recoveredImages;
    } catch (err) {
        warn(`Step 2 failed (IU image recovery): ${err.message}`);
        result.errors.push(`iu_image_recovery: ${err.message}`);
    }

    // ── Step 3: Reconcile scene counters and chunk statuses from PG ──
    // For scenes registered in PG but with missing Redis state,
    // restore counters and mark chunks as ready if files exist.
    try {
        const reconciled = await reconcileMissingSceneState(redis, deps);
        if (reconciled > 0) {
            log(`Step 3 complete: ${reconciled} scene counters reconciled`);
        }
        result.recovered += reconciled;
    } catch (err) {
        warn(`Step 3 failed (scene counter reconciliation): ${err.message}`);
        result.errors.push(`counter_reconciliation: ${err.message}`);
    }

    // ── Step 4: Check version-based staleness from PG ──
    try {
        const outdated = await checkVersionStaleness(redis, deps);
        if (outdated > 0) {
            log(`Step 4 complete: ${outdated} assets outdated by version`);
        }
        result.version_outdated = outdated;
    } catch (err) {
        warn(`Step 4 failed (version staleness check): ${err.message}`);
        result.errors.push(`version_staleness: ${err.message}`);
    }

    // ── Step 5: Resume incomplete PG sessions ──
    try {
        if (deps.resumeIncompleteSessions && deps.runBackgroundWindowGeneration) {
            await deps.resumeIncompleteSessions(log, deps.runBackgroundWindowGeneration);
            result.sessions_resumed = 1; // just a flag
            log('Step 5 complete: incomplete sessions resumed');
        }
    } catch (err) {
        warn(`Step 5 failed (session resume): ${err.message}`);
        result.errors.push(`session_resume: ${err.message}`);
    }

    const elapsed = Date.now() - startTime;
    log(`Startup recovery complete in ${elapsed}ms: ${result.recovered} items recovered, ` +
        `${result.version_outdated} version stale, ${result.errors.length} errors`);

    return result;
}

// ======================================================
// STEP 2: Recover IU images from disk
// ======================================================

/**
 * Scan output directories for IU images (.png files) and update
 * chunk metadata for any scenes that have images but are still
 * marked as 'pending'.
 *
 * @param {Object} redis
 * @param {Object} deps
 * @returns {Promise<number>} Number of chunks updated
 */
async function recoverIuImagesFromDisk(redis, deps) {
    const OUTPUT_DIR = deps.config?.OUTPUT_DIR || '/data/output';
    if (!fs.existsSync(OUTPUT_DIR)) return 0;

    const buildDirs = fs.readdirSync(OUTPUT_DIR).filter(name => {
        const fullPath = path.join(OUTPUT_DIR, name);
        try { return fs.statSync(fullPath).isDirectory(); } catch { return false; }
    });

    let totalUpdated = 0;

    for (const buildId of buildDirs) {
        const buildPath = path.join(OUTPUT_DIR, buildId);
        let allFiles;
        try { allFiles = fs.readdirSync(buildPath); } catch { continue; }

        // Find all scenes that have IU images (.png files)
        const sceneIuMap = {};  // bookId:chapterId:sceneId → true
        for (const f of allFiles) {
            if (!f.endsWith('.png')) continue;
            // Pattern: bookId_chapterId_sceneId_iu*.png
            const match = f.match(/^(.+)_(ch[^_]+)_(sc[^_]+)_iu/);
            if (match) {
                const key = `${match[1]}:${match[2]}:${match[3]}`;
                sceneIuMap[key] = true;
            }
        }

        if (Object.keys(sceneIuMap).length === 0) continue;

        // For each scene with IU images, update chunk metadata
        for (const sceneKey of Object.keys(sceneIuMap)) {
            const parts = sceneKey.split(':');
            const bookId = parts[0];
            const chapterId = parts[1];
            const sceneId = parts[2];

            const chunkKey = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_0001`;
            try {
                const raw = await redis.get(chunkKey);
                if (!raw) continue; // No chunk to update
                const chunk = JSON.parse(raw);
                if (chunk.image_status === 'pending') {
                    chunk.image = true;
                    chunk.image_status = 'ready';
                    await redis.set(chunkKey, JSON.stringify(chunk));
                    totalUpdated++;
                    log(`[IU-RECOVERY] Updated chunk image status: ${chunkKey}`);
                }
            } catch (err) {
                // Skip — chunk may not exist or invalid JSON
            }
        }
    }

    return totalUpdated;
}

// ======================================================
// STEP 3: Reconcile missing scene state
// ======================================================

/**
 * For scenes that exist in PG (scenes table) but have missing Redis
 * state, restore the scene counters and chunk metadata.
 *
 * @param {Object} redis
 * @param {Object} deps
 * @returns {Promise<number>} Number of scenes reconciled
 */
async function reconcileMissingSceneState(redis, deps) {
    const { postgres, config: cfg, book, placeholderAudio } = deps;
    if (!postgres || !postgres.query) return 0;

    // Get all books that have PG scene records
    const bookResult = await postgres.query(`
        SELECT DISTINCT book_id FROM scenes
    `);

    let totalReconciled = 0;

    for (const row of bookResult.rows) {
        const bookId = row.book_id;

        // Check if book has scene counters in Redis
        const totalKey = `animastor:book-scenes:${bookId}:total`;
        const totalRaw = await redis.get(totalKey);
        if (totalRaw && parseInt(totalRaw, 10) > 0) {
            continue; // Already has counters
        }

        // Get scene count from PG
        const sceneCountResult = await postgres.query(`
            SELECT COUNT(*)::int as cnt FROM scenes WHERE book_id = $1
        `, [bookId]);
        const pgSceneCount = sceneCountResult.rows[0]?.cnt || 0;
        if (pgSceneCount === 0) continue;

        // Check if book JSON exists on disk
        const bookData = book?.loadBook ? book.loadBook(bookId) : null;
        const totalScenes = bookData ? book.collectScenes(bookData).length : pgSceneCount;

        // Set scene counters
        await redis.set(totalKey, totalScenes);
        await redis.set(`animastor:book-scenes:${bookId}:next-index`, totalScenes);
        await redis.set(`animastor:book-scenes:${bookId}:window-start`, 0);

        totalReconciled++;

        // Restore placeholder audio for missing scenes
        if (placeholderAudio && bookData) {
            try {
                const scenes = book.collectScenes(bookData);
                const buildId = bookData.manifest?.build_id || 'default';
                for (const s of scenes) {
                    await placeholderAudio.ensurePlaceholderAudio(buildId, bookId, s.chapter_id, s.scene_id);
                }
                log(`[COUNTER-RECOVERY] Restored placeholders + counters for ${bookId} (${scenes.length} scenes)`);
            } catch (_) {
                // Non-fatal
            }
        }

        // Restore scene_hashes from book JSON → PG
        // This prevents full regeneration after crash (scene_hash matches,
        // so detection won't flag all scenes as changed).
        if (bookData) {
            try {
                const scenes = book.collectScenes(bookData);
                for (const s of scenes) {
                    const hash = computeSceneHash(s.scene || s.payload || s);
                    await postgres.query(`
                        INSERT INTO scenes (book_id, chapter_id, scene_id, scene_hash, updated_at)
                        VALUES ($1, $2, $3, $4, EXTRACT(EPOCH FROM NOW())::bigint)
                        ON CONFLICT(book_id, chapter_id, scene_id) DO UPDATE SET
                            scene_hash = EXCLUDED.scene_hash,
                            updated_at = EXTRACT(EPOCH FROM NOW())::bigint
                    `, [bookId, s.chapter_id, s.scene_id, hash]);
                }
                log(`[HASH-RECOVERY] Restored scene_hashes for ${bookId} (${scenes.length} scenes)`);
            } catch (_) {
                // Non-fatal
            }
        }
    }

    return totalReconciled;
}

// ======================================================
// STEP 4: Check version staleness
// ======================================================

/**
 * Query PG for version-based staleness and log findings.
 * Assets whose scene_content_version < scenes.content_version
 * are outdated and need regeneration.
 *
 * @param {Object} redis
 * @param {Object} deps
 * @returns {Promise<number>} Count of outdated assets found
 */
async function checkVersionStaleness(redis, deps) {
    const { postgres, config: cfg } = deps;
    if (!postgres || !postgres.query) return 0;

    // Query all books with version info
    const result = await postgres.query(`
        SELECT s.book_id, s.chapter_id, s.scene_id, s.content_version, s.audio_config_version,
               a.asset_type, a.scene_content_version, a.scene_audio_config_version, a.status
        FROM scenes s
        LEFT JOIN scene_assets a ON a.book_id = s.book_id
            AND a.chapter_id = s.chapter_id
            AND a.scene_id = s.scene_id
        WHERE s.content_version > 1 OR s.audio_config_version > 1
        ORDER BY s.book_id, s.chapter_id, s.scene_id, a.asset_type
    `);

    let outdatedCount = 0;

    for (const row of result.rows) {
        // Check content version mismatch
        if (row.scene_content_version != null && row.content_version != null &&
            row.scene_content_version < row.content_version) {
            log(`[VERSION-STALE] ${row.book_id}/${row.chapter_id}/${row.scene_id}: ` +
                `${row.asset_type || 'asset'} content_version=${row.scene_content_version} < scene=${row.content_version}`);
            outdatedCount++;
        }
        // Check audio config version mismatch
        if (row.scene_audio_config_version != null && row.audio_config_version != null &&
            row.scene_audio_config_version < row.audio_config_version) {
            log(`[VERSION-STALE] ${row.book_id}/${row.chapter_id}/${row.scene_id}: ` +
                `${row.asset_type || 'asset'} audio_config_version=${row.scene_audio_config_version} < scene=${row.audio_config_version}`);
            outdatedCount++;
        }
    }

    if (outdatedCount > 0) {
        log(`[VERSION-STALE] Found ${outdatedCount} outdated assets across ${result.rows.length} rows`);
    }

    return outdatedCount;
}

module.exports = {
    recoverAll,
    recoverIuImagesFromDisk,
    reconcileMissingSceneState,
    checkVersionStaleness,
};
