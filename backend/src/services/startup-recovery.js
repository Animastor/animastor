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
 * Scan output directories for IU images (.png files) and log findings.
 * Phase 1 (R1.1): Log-only — does NOT update Redis chunk metadata.
 * The runtime scheduler's tick() will naturally discover pending scenes
 * and dispatch them. This is safer than silently marking images 'ready'
 * without version verification.
 *
 * @param {Object} redis
 * @param {Object} deps
 * @returns {Promise<number>} Number of scenes with IU images found (informational)
 */
async function recoverIuImagesFromDisk(redis, deps) {
    const OUTPUT_DIR = deps.config?.OUTPUT_DIR || '/data/output';
    if (!fs.existsSync(OUTPUT_DIR)) return 0;

    const buildDirs = fs.readdirSync(OUTPUT_DIR).filter(name => {
        const fullPath = path.join(OUTPUT_DIR, name);
        try { return fs.statSync(fullPath).isDirectory(); } catch { return false; }
    });

    let totalFound = 0;

    for (const buildId of buildDirs) {
        const buildPath = path.join(OUTPUT_DIR, buildId);
        let allFiles;
        try { allFiles = fs.readdirSync(buildPath); } catch { continue; }

        // Find all scenes that have IU images (.png files)
        const sceneIuMap = {};
        for (const f of allFiles) {
            if (!f.endsWith('.png')) continue;
            const match = f.match(/^(.+)_(ch[^_]+)_(sc[^_]+)_iu/);
            if (match) {
                const key = `${match[1]}:${match[2]}:${match[3]}`;
                sceneIuMap[key] = true;
            }
        }

        if (Object.keys(sceneIuMap).length > 0) {
            const sceneCount = Object.keys(sceneIuMap).length;
            log(`[IU-LOG-ONLY] Found ${sceneCount} scenes with IU images in build ${buildId} — NOT updating Redis (scheduler will dispatch naturally)`);
            totalFound += sceneCount;
        }
    }

    return totalFound;
}

// ======================================================
// STEP 3: Reconcile missing scene state
// ======================================================

/**
 * Log missing Redis scene counters for books that exist in PG.
 * Phase 1 (R1.1): Log-only — does NOT restore counters or placeholders.
 * The book must be naturally loaded via PUT or /regenerate to create
 * Redis state. Crash recovery must not mask the fact that Redis was
 * flushed — that's a signal that something went wrong.
 *
 * @param {Object} redis
 * @param {Object} deps
 * @returns {Promise<number>} Number of books with missing counters (informational)
 */
async function reconcileMissingSceneState(redis, deps) {
    const { postgres } = deps;
    if (!postgres || !postgres.query) return 0;

    const bookResult = await postgres.query(`
        SELECT DISTINCT book_id FROM scenes
    `);

    let totalMissing = 0;

    for (const row of bookResult.rows) {
        const bookId = row.book_id;

        const totalKey = `animastor:book-scenes:${bookId}:total`;
        const totalRaw = await redis.get(totalKey);
        if (totalRaw && parseInt(totalRaw, 10) > 0) {
            continue;
        }

        // Log but don't restore — book must be reloaded naturally
        log(`[COUNTER-LOG-ONLY] Book ${bookId} has PG records but no Redis scene counters — NOT restoring (book must be loaded via PUT/regenerate)`);
        totalMissing++;
    }

    return totalMissing;
}

// ======================================================
// STEP 4: Check version staleness
// ======================================================

/**
 * Query PG for version-based staleness, log findings (deduplicated),
 * and proactively reset stale assets in Redis so the scheduler
 * picks them up immediately on startup.
 *
 * Assets whose scene_content_version < scenes.content_version
 * are outdated and need regeneration.
 *
 * @param {Object} redis
 * @param {Object} deps
 * @returns {Promise<number>} Count of outdated assets found
 */
async function checkVersionStaleness(redis, deps) {
    const { postgres, state, config: cfg } = deps;
    if (!postgres || !postgres.query) return 0;

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

    // Aggregate staleness per unique scene (the LEFT JOIN may produce
    // multiple rows per scene for different asset types).
    const sceneMap = new Map();
    for (const row of result.rows) {
        const key = `${row.book_id}|${row.chapter_id}|${row.scene_id}`;
        if (!sceneMap.has(key)) {
            sceneMap.set(key, {
                bookId: row.book_id,
                chapterId: row.chapter_id,
                sceneId: row.scene_id,
                contentStale: false,
                audioConfigStale: false,
            });
        }
        const entry = sceneMap.get(key);
        if (row.scene_content_version != null && row.content_version != null &&
            row.scene_content_version < row.content_version) {
            entry.contentStale = true;
        }
        if (row.scene_audio_config_version != null && row.audio_config_version != null &&
            row.scene_audio_config_version < row.audio_config_version) {
            entry.audioConfigStale = true;
        }
    }

    let outdatedCount = 0;
    let resetCount = 0;

    for (const entry of sceneMap.values()) {
        const { bookId, chapterId, sceneId, contentStale, audioConfigStale } = entry;

        if (contentStale) {
            log(`[VERSION-STALE] ${bookId}/${chapterId}/${sceneId}: content_version stale`);
            outdatedCount++;
        }
        if (audioConfigStale) {
            log(`[VERSION-STALE] ${bookId}/${chapterId}/${sceneId}: audio_config_version stale`);
            outdatedCount++;
        }

        // Proactively reset stale assets in Redis so the scheduler
        // dispatches them on the very first tick instead of relying
        // on per-scene PG checks during shouldScheduleAssets().
        if ((contentStale || audioConfigStale) && state && state.setAssetStates && state.AssetState) {
            await state.setAssetStates(redis, bookId, chapterId, sceneId, {
                audio: state.AssetState.DIRTY,
                image: state.AssetState.DIRTY,
                video: state.AssetState.DIRTY,
            });
            resetCount++;

            // Ensure the scene is in the active index so tick() finds it
            try {
                const activeScenesIndex = require('../runtime/active-scenes-index');
                await activeScenesIndex.addActiveScene(redis, bookId, chapterId, sceneId);
            } catch (_) {}
        }
    }

    if (outdatedCount > 0) {
        log(`[VERSION-STALE] Found ${outdatedCount} outdated assets, reset ${resetCount} scenes in Redis`);
    } else {
        log(`No version-stale assets found`);
    }

    return outdatedCount;
}

module.exports = {
    recoverAll,
    recoverIuImagesFromDisk,
    reconcileMissingSceneState,
    checkVersionStaleness,
};
