// ======================================================
// Placeholder Audio Service - v1.0.0
// ======================================================
// Generates silent audio placeholders for scenes that don't
// have real audio yet. This enables the timeline to have a
// duration-based playback timeline even before TTS generation.
//
// Key behaviors:
//   1. Scene Estimated Duration = sum(unit.estimated_duration_sec)
//      Uses existing image_units data — no separate duration calc.
//   2. Placeholder is a valid MP3 file containing pure silence.
//   3. Placeholder is registered as status='placeholder' (not 'ready').
//   4. When real audio arrives, placeholder is replaced (status → ready).
//   5. Dirty-flagged placeholders are recreated on scene change.
//
// Integration points:
//   - Called after bootstrap (initial book import)
//   - Called after lazy-parse (new scenes from source text)
//   - Called after scene content changes (dirty regeneration)

const path = require('path');
const fs = require('fs');

const config = require('../config/runtime-config');
const audio = require('../audio');
const sceneAssetsRepo = require('../storage/postgres/repositories/scene-assets-repo');
const iuRepo = require('../storage/postgres/repositories/iu-repo');

const logPrefix = '[PLACEHOLDER-AUDIO]';

function log(msg) { console.log(`${logPrefix} ${msg}`); }
function warn(msg) { console.warn(`${logPrefix} ⚠️  ${msg}`); }

// ======================================================
// SCENE ESTIMATED DURATION
// ======================================================

/**
 * Calculate Scene Estimated Duration from existing unit data.
 * Sum of all unit estimated_duration_sec values in the scene.
 * Uses PostgreSQL image_units table (created during IU generation).
 *
 * @param {string} buildId
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<number>} Total estimated duration in seconds
 */
async function getSceneEstimatedDurationSec(buildId, bookId, chapterId, sceneId) {
    try {
        const units = await iuRepo.getImageUnitsForScene(buildId, bookId, chapterId, sceneId);
        if (!units || units.length === 0) {
            log(`No image_units found for ${bookId}/${chapterId}/${sceneId}, estimating from text length`);
            return await estimateDurationFromSceneText(bookId, chapterId, sceneId);
        }
        const total = units.reduce((sum, u) => sum + (parseFloat(u.estimated_duration_sec) || 0), 0);
        log(`Scene estimated duration: ${bookId}/${chapterId}/${sceneId} = ${total.toFixed(2)}s (${units.length} units)`);
        return Math.max(total, 1); // Minimum 1 second
    } catch (err) {
        warn(`Failed to get image_units for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        return await estimateDurationFromSceneText(bookId, chapterId, sceneId);
    }
}

/**
 * Fallback duration estimation when no image_units exist yet.
 * Uses a simple heuristic: ~0.3 seconds per word of scene text.
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<number>}
 */
async function estimateDurationFromSceneText(bookId, chapterId, sceneId) {
    try {
        const bookSource = require('./book-source');
        const scene = bookSource.getCanonicalScene(bookId, chapterId, sceneId);
        if (!scene || !scene.payload) return 5; // Default fallback: 5 seconds

        const fullText = scene.payload.audio?.full_text || '';
        const wordCount = fullText.split(/\s+/).filter(Boolean).length;
        const estimated = Math.max(wordCount * 0.3, 2); // ~0.3s per word, min 2s
        log(`Fallback duration from text: ${bookId}/${chapterId}/${sceneId} = ${estimated.toFixed(1)}s (${wordCount} words)`);
        return Math.round(estimated * 10) / 10;
    } catch (err) {
        warn(`Fallback duration failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        return 5; // Hard fallback: 5 seconds
    }
}

// ======================================================
// PLACEHOLDER MANAGEMENT
// ======================================================

/**
 * Check if a scene already has a placeholder audio asset.
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string} buildId
 * @returns {Promise<boolean>}
 */
async function hasPlaceholderAudio(bookId, chapterId, sceneId, buildId) {
    try {
        const asset = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'audio', buildId);
        return !!(asset && (asset.status === 'placeholder' || asset.status === 'ready'));
    } catch {
        return false;
    }
}

/**
 * Check if a scene has real (non-placeholder) audio.
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string} buildId
 * @returns {Promise<boolean>}
 */
async function hasRealAudio(bookId, chapterId, sceneId, buildId) {
    try {
        const asset = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'audio', buildId);
        return !!(asset && asset.status === 'ready');
    } catch {
        return false;
    }
}

/**
 * Generate and register placeholder audio for a single scene.
 *
 * Steps:
 *   1. Skip if real audio already exists (status='ready')
 *   2. Calculate Scene Estimated Duration
 *   3. Generate silence MP3 via ffmpeg
 *   4. Register in scene_assets with status='placeholder'
 *
 * @param {string} buildId
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<{created: boolean, path: string|null, durationSec: number, reason: string}>}
 */
async function ensurePlaceholderAudio(buildId, bookId, chapterId, sceneId) {
    // 1. Skip if real audio already exists AND file is on disk
    const existingAsset = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'audio', buildId);
    if (existingAsset && existingAsset.status === 'ready') {
        if (existingAsset.path && fs.existsSync(existingAsset.path)) {
            log(`Real audio already exists for ${bookId}/${chapterId}/${sceneId}, skipping placeholder`);
            return { created: false, path: existingAsset.path, durationSec: existingAsset.duration_sec, reason: 'real_audio_exists' };
        }
        log(`Stale ready record for ${bookId}/${chapterId}/${sceneId} (file missing), regenerating placeholder`);
    }

    // If a placeholder already exists and is not stale, skip
    if (existingAsset && existingAsset.status === 'placeholder' && existingAsset.path) {
        if (fs.existsSync(existingAsset.path)) {
            log(`Placeholder already exists and valid for ${bookId}/${chapterId}/${sceneId}`);
            return { created: false, path: existingAsset.path, durationSec: existingAsset.duration_sec || 0, reason: 'already_exists' };
        }
        log(`Placeholder file missing for ${bookId}/${chapterId}/${sceneId}, regenerating`);
    }

    // 2. Calculate scene estimated duration
    const durationSec = await getSceneEstimatedDurationSec(buildId, bookId, chapterId, sceneId);
    if (durationSec <= 0) {
        warn(`Zero duration for ${bookId}/${chapterId}/${sceneId}, using minimum 2s`);
    }
    const effectiveDuration = Math.max(durationSec, 2);

    // 3. Generate silent audio
    const outputDir = path.join(config.OUTPUT_DIR, buildId);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    const audioPath = path.join(outputDir, `${bookId}_${chapterId}_${sceneId}.mp3`);

    try {
        await audio.generateSilentAudio(audioPath, effectiveDuration);
        log(`Silent audio generated: ${path.basename(audioPath)} (${effectiveDuration.toFixed(1)}s)`);
    } catch (err) {
        warn(`Failed to generate silent audio for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        return { created: false, path: null, durationSec: 0, reason: 'generation_failed' };
    }

    // 4. Register as placeholder in PostgreSQL
    try {
        await sceneAssetsRepo.upsertAsset({
            book_id: bookId,
            chapter_id: chapterId,
            scene_id: sceneId,
            asset_type: 'audio',
            path: audioPath,
            duration_sec: effectiveDuration,
            format: 'mp3',
            sample_rate: 24000,
            channel_count: 1,
            build_id: buildId,
            status: 'placeholder',
        });
        log(`REGISTERED placeholder audio: ${bookId}/${chapterId}/${sceneId} (${effectiveDuration.toFixed(1)}s)`);
    } catch (err) {
        warn(`Failed to register placeholder in DB: ${err.message}`);
        return { created: false, path: null, durationSec: 0, reason: 'db_failed' };
    }

    return { created: true, path: audioPath, durationSec: effectiveDuration, reason: 'created' };
}

// ======================================================
// BATCH OPERATIONS
// ======================================================

/**
 * Generate placeholder audio for all scenes in a book that don't
 * have real audio yet. Skips scenes that already have ready audio
 * or valid placeholder.
 *
 * @param {string} buildId
 * @param {string} bookId
 * @param {Array<{chapter_id: string, scene_id: string}>} scenes - Array of scene references
 * @returns {Promise<{total: number, created: number, skipped: number, errors: string[]}>}
 */
async function ensureAllPlaceholderAudio(buildId, bookId, scenes) {
    const results = { total: scenes.length, created: 0, skipped: 0, errors: [] };

    for (const scene of scenes) {
        try {
            const result = await ensurePlaceholderAudio(buildId, bookId, scene.chapter_id, scene.scene_id);
            if (result.created) results.created++;
            else results.skipped++;
        } catch (err) {
            warn(`Failed to create placeholder for ${bookId}/${scene.chapter_id}/${scene.scene_id}: ${err.message}`);
            results.errors.push(`${scene.chapter_id}/${scene.scene_id}: ${err.message}`);
        }
    }

    log(`Placeholder audio for ${bookId}: ${results.created} created, ${results.skipped} skipped, ${results.errors.length} errors`);
    return results;
}

/**
 * Get all scenes from a book that need placeholder audio.
 *
 * @param {string} bookId
 * @returns {Promise<Array<{chapter_id: string, scene_id: string, chapter: Object, scene: Object, payload: Object}>>}
 */
async function getScenesNeedingPlaceholder(bookId) {
    const bookLoader = require('../book');
    const loadedBook = bookLoader.loadBook(bookId);
    if (!loadedBook) return [];

    const scenes = bookLoader.collectScenes(loadedBook);
    return scenes;
}

/**
 * Replace a placeholder audio with real audio when generation completes.
 *
 * Called when handleAudioCompleted transitions a scene to AUDIO_READY.
 * Updates scene_assets status from 'placeholder' → 'ready'.
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string} buildId
 * @param {string} realAudioPath - Path to the real generated audio
 * @param {number} realDuration - Duration of the real audio in seconds
 * @returns {Promise<{replaced: boolean, reason: string}>}
 */
async function replacePlaceholderWithRealAudio(bookId, chapterId, sceneId, buildId, realAudioPath, realDuration) {
    try {
        const existing = await sceneAssetsRepo.getAsset(bookId, chapterId, sceneId, 'audio', buildId);
        if (!existing) {
            log(`No existing audio asset for ${bookId}/${chapterId}/${sceneId} — registering as ready`);
            await sceneAssetsRepo.upsertAsset({
                book_id: bookId,
                chapter_id: chapterId,
                scene_id: sceneId,
                asset_type: 'audio',
                path: realAudioPath,
                duration_sec: realDuration,
                build_id: buildId,
                status: 'ready',
            });
            return { replaced: false, reason: 'new_asset' };
        }

        if (existing.status === 'placeholder') {
            log(`Replacing placeholder audio with real audio: ${bookId}/${chapterId}/${sceneId}`);
            await sceneAssetsRepo.upsertAsset({
                book_id: bookId,
                chapter_id: chapterId,
                scene_id: sceneId,
                asset_type: 'audio',
                path: realAudioPath,
                duration_sec: realDuration,
                build_id: buildId,
                status: 'ready',
            });
            // Only delete placeholder file if it's at a different path than the real audio
            // (they usually share the same canonical path, so real audio already overwrote it)
            if (existing.path && existing.path !== realAudioPath && fs.existsSync(existing.path)) {
                try { fs.unlinkSync(existing.path); } catch (e) {
                    warn(`Failed to delete old placeholder file: ${e.message}`);
                }
            }
            return { replaced: true, reason: 'placeholder_replaced' };
        }

        if (existing.status === 'ready') {
            log(`Audio already ready for ${bookId}/${chapterId}/${sceneId} — updating path`);
            await sceneAssetsRepo.upsertAsset({
                book_id: bookId,
                chapter_id: chapterId,
                scene_id: sceneId,
                asset_type: 'audio',
                path: realAudioPath,
                duration_sec: realDuration,
                build_id: buildId,
                status: 'ready',
            });
            return { replaced: false, reason: 'already_ready_updated' };
        }

        log(`Audio in status ${existing.status} for ${bookId}/${chapterId}/${sceneId} — updating to ready`);
        await sceneAssetsRepo.upsertAsset({
            book_id: bookId,
            chapter_id: chapterId,
            scene_id: sceneId,
            asset_type: 'audio',
            path: realAudioPath,
            duration_sec: realDuration,
            build_id: buildId,
            status: 'ready',
        });
        return { replaced: true, reason: `upgraded_from_${existing.status}` };
    } catch (err) {
        warn(`replacePlaceholderWithRealAudio failed: ${err.message}`);
        return { replaced: false, reason: `error: ${err.message}` };
    }
}

/**
 * Mark placeholder audio as stale for scenes that changed.
 * Part of the dirty system integration.
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string} buildId
 * @returns {Promise<boolean>}
 */
async function markPlaceholderStale(bookId, chapterId, sceneId, buildId) {
    try {
        const affected = await sceneAssetsRepo.markStale(bookId, chapterId, sceneId, 'audio', buildId);
        const marked = affected > 0;
        if (marked) {
            log(`Placeholder marked stale: ${bookId}/${chapterId}/${sceneId}`);
        }
        return marked;
    } catch (err) {
        warn(`Failed to mark placeholder stale: ${err.message}`);
        return false;
    }
}

// ======================================================
// RECOVERY — check + create missing placeholders
// ======================================================

/**
 * Recover missing placeholder MP3 files for a book.
 * Scans all scenes in the book JSON and creates placeholder
 * audio for any scene that is missing its MP3 file on disk.
 *
 * This handles the case where scenes were created by window
 * generation but placeholder audio was never generated (e.g.,
 * due to a transient error or an old bug that has since been fixed).
 *
 * @param {string} buildId - Build directory (usually 'default')
 * @param {string} bookId  - Book ID
 * @returns {Promise<{checked: number, created: number, skipped: number, errors: string[]}>}
 */
async function recoverMissingPlaceholders(buildId, bookId) {
    const result = { checked: 0, created: 0, skipped: 0, errors: [] };

    try {
        const lazyBook = require('../book/lazy-book');
        const draft = lazyBook.loadDraftBook(bookId);
        if (!draft) {
            log(`[RECOVER] Book ${bookId} not found on disk, skipping`);
            return result;
        }

        // If book is in RAW_IMPORTED state, no scenes exist yet
        if (draft.manifest.state === lazyBook.BookState.RAW_IMPORTED) {
            log(`[RECOVER] Book ${bookId} is RAW_IMPORTED, no scenes to check`);
            return result;
        }

        const scenes = [];
        for (const ch of draft.chapters) {
            for (const sc of (ch.scenes || [])) {
                scenes.push({ chapter_id: ch.chapter, scene_id: sc.scene_id });
            }
        }

        if (scenes.length === 0) {
            log(`[RECOVER] Book ${bookId} has no scenes in chapters, skipping`);
            return result;
        }

        result.checked = scenes.length;
        log(`[RECOVER] Checking ${scenes.length} scenes for ${bookId}...`);

        const outputDir = path.join(config.OUTPUT_DIR, buildId);
        const needsRecovery = [];

        for (const s of scenes) {
            const audioPath = path.join(outputDir, `${bookId}_${s.chapter_id}_${s.scene_id}.mp3`);

            // Check if file already exists
            if (fs.existsSync(audioPath)) {
                result.skipped++;
                continue;
            }

            // Check if scene has real audio (skip if real audio exists in DB)
            try {
                const asset = await sceneAssetsRepo.getAsset(bookId, s.chapter_id, s.scene_id, 'audio', buildId);
                if (asset && asset.status === 'ready' && fs.existsSync(asset.path)) {
                    result.skipped++;
                    continue;
                }
            } catch (_) {
                // DB error — proceed with recovery attempt
            }

            needsRecovery.push(s);
        }

        if (needsRecovery.length === 0) {
            log(`[RECOVER] ${bookId}: all ${scenes.length} scenes have valid audio, nothing to do`);
            return result;
        }

        log(`[RECOVER] ${bookId}: recovering placeholder audio for ${needsRecovery.length} scenes`);

        for (const s of needsRecovery) {
            try {
                const phResult = await ensurePlaceholderAudio(buildId, bookId, s.chapter_id, s.scene_id);
                if (phResult.created) {
                    result.created++;
                } else {
                    result.skipped++;
                }
            } catch (err) {
                warn(`[RECOVER] Failed for ${bookId}/${s.chapter_id}/${s.scene_id}: ${err.message}`);
                result.errors.push(`${s.chapter_id}/${s.scene_id}: ${err.message}`);
            }
        }

        log(`[RECOVER] ${bookId}: ${result.created} placeholders created, ${result.skipped} skipped, ${result.errors.length} errors`);
    } catch (err) {
        warn(`[RECOVER] Error recovering placeholders for ${bookId}: ${err.message}`);
        result.errors.push(`global: ${err.message}`);
    }

    return result;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    getSceneEstimatedDurationSec,
    estimateDurationFromSceneText,
    hasPlaceholderAudio,
    hasRealAudio,
    ensurePlaceholderAudio,
    ensureAllPlaceholderAudio,
    getScenesNeedingPlaceholder,
    replacePlaceholderWithRealAudio,
    markPlaceholderStale,
    recoverMissingPlaceholders,
};
