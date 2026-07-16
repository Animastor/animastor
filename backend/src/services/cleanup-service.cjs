// ======================================================
// ANIMASTOR BACKEND — CLEANUP SERVICE
// ======================================================
// Build lifecycle management, distributed cleanup locks,
// and periodic stale lock cleanup.
//
// Usage:
//   const cleanup = require('./services/cleanup-service.cjs')(redis, config, { log });

const path = require('path');
const fs = require('fs');


module.exports = function(redis, config, { log }) {
    const OUTPUT_DIR = config.OUTPUT_DIR;

    // ── Runtime counters ──────────────────────────────
    const stats = {
        audio_jobs_started: 0,
        image_jobs_started: 0,
        video_jobs_started: 0,
        failed_jobs: 0,
        active_video_locks: 0,
    };

    // ── Safe path builder ─────────────────────────────
    function safeBuildPath(buildId) {
        if (!buildId || buildId === '.' || buildId === '..') {
            console.error('⚠️ Invalid buildId (empty, ., ..):', buildId);
            return null;
        }
        if (buildId.includes('/') || buildId.includes('\\\\')) {
            console.error('⚠️ buildId contains path separators:', buildId);
            return null;
        }
        const regex = /^[a-zA-Z0-9._-]+$/;
        if (!regex.test(buildId)) {
            console.error('⚠️ buildId fails regex validation:', buildId);
            return null;
        }

        const safeId = path.basename(buildId);
        const fullPath = path.resolve(OUTPUT_DIR, safeId);
        const outputDirResolved = path.resolve(OUTPUT_DIR);

        const relative = path.relative(outputDirResolved, fullPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            console.error('⚠️ Path traversal attempt detected:', buildId, fullPath, relative);
            return null;
        }
        if (fullPath === outputDirResolved) {
            console.error('⚠️ Attempt to target OUTPUT_DIR root:', buildId, fullPath);
            return null;
        }
        return fullPath;
    }

    // ── Build cleanup ─────────────────────────────────
    function cleanupBuild(buildId) {
        const buildPath = safeBuildPath(buildId);
        if (!buildPath) {
            console.error('❌ Cannot cleanup build, invalid path for buildId:', buildId);
            return { ok: false, reason: 'invalid_path', path: buildId };
        }
        const outputDirResolved = path.resolve(OUTPUT_DIR);
        if (buildPath === outputDirResolved) {
            console.error('❌ Cannot cleanup OUTPUT_DIR root:', buildPath);
            return { ok: false, reason: 'cannot_delete_root', path: buildPath };
        }

        if (fs.existsSync(buildPath)) {
            try {
                fs.rmSync(buildPath, { recursive: true, force: true });
                log('🗑 Cleaned up build:', buildId);
                return { ok: true, reason: 'success', path: buildPath };
            } catch (err) {
                console.error('❌ Failed to cleanup build:', buildId, err.message);
                return { ok: false, reason: 'fs_error', path: buildPath, error: err.message };
            }
        } else {
            console.log('⚠️ Build directory does not exist, nothing to cleanup:', buildId);
            return { ok: true, reason: 'does_not_exist', path: buildPath };
        }
    }

    // ── Distributed cleanup lock ──────────────────────
    let cleanupLockToken = null;

    async function acquireCleanupLock() {
        const lockKey = 'animastor:cleanup-lock';
        const token = `cleanup-token:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const locked = await redis.set(lockKey, JSON.stringify({ token }), 'NX', 'EX', 120);
        if (locked) {
            cleanupLockToken = token;
            return { acquired: true, token };
        }
        return { acquired: false, token: null };
    }

    async function releaseCleanupLock() {
        const lockKey = 'animastor:cleanup-lock';
        if (!cleanupLockToken) return { released: false, reason: 'no_token' };
        try {
            const current = await redis.get(lockKey);
            if (current) {
                const data = JSON.parse(current);
                if (data.token === cleanupLockToken) {
                    await redis.del(lockKey);
                    cleanupLockToken = null;
                    return { released: true, reason: 'success' };
                }
            }
        } catch (e) {
            console.error('❌ FAILED TO RELEASE CLEANUP LOCK:', e.message);
        }
        return { released: false, reason: 'token_mismatch' };
    }

    // ── Periodic cleanup of expired audio scene locks ──
    async function cleanupExpiredAudioSceneLocks() {
        const lockResult = await acquireCleanupLock();
        if (!lockResult.acquired) {
            console.log('⚠️ Cleanup already running (distributed lock held), skipping this cycle');
            return;
        }

        try {
            let cursor = 0;
            do {
                const result = await redis.scan(cursor, 'MATCH', 'animastor:audio-scene-failsafe:*', 'COUNT', 100);
                cursor = parseInt(result[0], 10);
                const keys = result[1];

                for (const failsafeKey of keys) {
                    const exists = await redis.exists(failsafeKey);
                    if (exists) continue;

                    const parts = failsafeKey.split(':');
                    if (parts.length < 7) continue;

                    const buildId = parts[3];
                    const bookId = parts[4];
                    const chapterId = parts[5];
                    const sceneId = parts[6];

                    const audioStatusKey = `animastor:scene-audio-status:${bookId}:${chapterId}:${sceneId}`;
                    const audioStatus = await redis.get(audioStatusKey);

                    if (audioStatus === 'ready') {
                        const lockKey = `animastor:audio-scene-lock:${bookId}:${chapterId}:${sceneId}`;
                        const current = await redis.get(lockKey);
                        if (current) {
                            const data = JSON.parse(current);
                            const token = data?.token;
                            if (token) {
                                await redis.del(lockKey);
                                log('✅ Stale audio lock released (audio ready):', lockKey);
                            }
                        }
                    }
                }
            } while (cursor !== 0);
        } catch (err) {
            console.error('❌ Audio scene stale lock cleanup error:', err.message);
        } finally {
            await releaseCleanupLock();
        }
    }

    // ── Start periodic cleanup ────────────────────────
    function startCleanupInterval() {
        setInterval(cleanupExpiredAudioSceneLocks, config.TIMEOUTS.CLEANUP_INTERVAL_MS);
        cleanupExpiredAudioSceneLocks(); // Run immediately on startup
    }

    // ── Asset path resolution ─────────────────────────
    function resolveAssetPath(job_id, buildId) {
        if (!job_id || !buildId) return null;

        const outputDir = path.join(OUTPUT_DIR, buildId);

        if (job_id.endsWith(':audio')) {
            const assetId = job_id.replace(/:audio$/, '');
            return {
                type: 'audio_chunk',
                extension: 'mp3',
                fullPath: path.join(outputDir, `${assetId}.mp3`),
            };
        }

        if (job_id.endsWith(':video')) {
            let assetId = job_id.replace(/:video$/, '');
            const groupMatch = assetId.match(/^(.+?)(_g\d+)$/);
            const groupSuffix = groupMatch ? groupMatch[2] : '';
            if (groupMatch) assetId = groupMatch[1];

            return {
                type: 'scene_video',
                extension: 'mp4',
                fullPath: path.join(outputDir, `${assetId}${groupSuffix}.mp4`),
            };
        }

        // :iu_image suffix (new format) — unambiguous IU image marker
    if (job_id.endsWith(':iu_image')) {
            const assetId = job_id.replace(/:iu_image$/, '');
            return {
                type: 'iu_image',
                extension: 'png',
                fullPath: path.join(outputDir, `${assetId}.png`),
            };
        }

        if (job_id.endsWith(':image')) {
            const assetId = job_id.replace(/:image$/, '');
            // Legacy detection: check for _iu substring (works with iu-XXXX unit IDs)
            if (assetId.includes('_iu')) {
                return {
                    type: 'iu_image',
                    extension: 'png',
                    fullPath: path.join(outputDir, `${assetId}.png`),
                };
            }
            return {
                type: 'scene_image',
                extension: 'png',
                fullPath: path.join(outputDir, `${assetId}.png`),
            };
        }

        return null;
    }



    return {
        stats,
        safeBuildPath,
        cleanupBuild,
        acquireCleanupLock,
        releaseCleanupLock,
        cleanupExpiredAudioSceneLocks,
        startCleanupInterval,
        resolveAssetPath,
    };
};
