// ======================================================
// ANIMASTOR BACKEND — REDIS CACHE HELPERS
// ======================================================
// Redis chunk metadata helpers extracted from backend.cjs.
// Usage:
//   const { saveChunk, getChunk, getAllChunks } = require('./helpers/redis-helpers.cjs')(redis);

const path = require('path');
const fs = require('fs');
const state = require('../state');
const config = require('../config/runtime-config');

module.exports = function(redis) {
    const pad = (n) => String(n).padStart(4, '0');
    const log = (...args) => console.log(new Date().toISOString(), ...args);

    async function saveChunk(id, data) {
        const chunkForRedis = {
            build_id: data.build_id,
            book_id: data.book_id,
            scene_order: data.scene_order,
            chapter_id: data.chapter_id,
            scene_id: data.scene_id,
            chunk_index: data.chunk_index,
            expected_chunk_count: data.expected_chunk_count || null,
            runtime_type: data.runtime_type || 'scene',
            scene_type: data.scene_type || 'narration',
            image: !!data.image,
            audio: !!data.audio,
            video: !!data.video,
            image_status: data.image_status || 'pending',
            video_status: data.video_status || 'pending',
            audio_status: data.audio_status || 'pending',
            padded_text: !!data.padded_text,
        };
        await redis.set(`animastor:chunk:${id}`, JSON.stringify(chunkForRedis));
        await redis.sadd(`animastor:chunks:${data.book_id}`, id);
    }

    async function getChunk(id) {
        const raw = await redis.get(`animastor:chunk:${id}`);
        if (!raw) return null;
        const c = JSON.parse(raw);
        if (c.video === undefined) c.video = false;
        if (!c.video_status) c.video_status = 'pending';
        if (!c.audio_status) c.audio_status = 'pending';
        if (!c.image_status) c.image_status = c.image ? 'ready' : 'pending';
        c.chunk_index = pad(parseInt(c.chunk_index) || 0);
        c.chapter_id = c.chapter_id || null;
        c.scene_id = c.scene_id || null;
        c.runtime_type = c.runtime_type || 'scene';
        c.scene_type = c.scene_type || 'narration';
        return c;
    }

    async function getAllChunks(bookId) {
        const ids = await redis.smembers(`animastor:chunks:${bookId}`);
        if (ids.length <= 1) return ids;
        try {
            const keys = ids.map(id => `animastor:chunk:${id}`);
            const raw = await redis.mget(keys);
            const pairs = ids.map((id, i) => {
                const data = raw[i] ? JSON.parse(raw[i]) : {};
                return { id, chapter_id: data.chapter_id || '', scene_id: data.scene_id || '', chunk_index: data.chunk_index || '0001' };
            });

            // Derive global scene order from the book structure so that chunks
            // are returned in correct playback order even if the stored
            // per-chapter scene_order conflicts across chapters (e.g. cover
            // scene_order=1 vs chapter_intro scene_order=0).
            let sceneIndexMap = null;
            try {
                const book = require('../book');
                const bookData = book.loadBook(bookId);
                if (bookData) {
                    const allScenes = book.collectScenes(bookData);
                    sceneIndexMap = new Map();
                    allScenes.forEach((s, idx) => {
                        sceneIndexMap.set(`${s.chapter_id}:${s.scene_id}`, idx);
                    });
                }
            } catch (_) {}

            pairs.sort((a, b) => {
                const aSceneIdx = sceneIndexMap ? (sceneIndexMap.get(`${a.chapter_id}:${a.scene_id}`) ?? null) : null;
                const bSceneIdx = sceneIndexMap ? (sceneIndexMap.get(`${b.chapter_id}:${b.scene_id}`) ?? null) : null;

                // Primary sort by scene index (from book structure)
                if (aSceneIdx !== null && bSceneIdx !== null) {
                    if (aSceneIdx !== bSceneIdx) return aSceneIdx - bSceneIdx;
                    // Same scene — secondary sort by chunk_index (defensive)
                    return String(a.chunk_index || '0000').localeCompare(String(b.chunk_index || '0000'));
                }

                // Fallback when sceneIndexMap is missing: sort by chunk_index
                const aChunk = String(a.chunk_index || '0000');
                const bChunk = String(b.chunk_index || '0000');
                return aChunk.localeCompare(bChunk);
            });
            return pairs.map(p => p.id);
        } catch (e) {
            log('getAllChunks sort failed, falling back:', e.message);
            return ids.sort((a, b) => a.localeCompare(b));
        }
    }

    async function getBookWindowStatus(bookId) {
        const book = require('../book');
        const bookData = book.loadBook(bookId);
        const scenes = bookData ? book.collectScenes(bookData) : [];
        const totalScenes = scenes.length;
        const nextIdx = parseInt(await redis.get(config.BOOK_SCENE_NEXT(bookId)) || '0', 10);
        const startedScenes = Math.min(nextIdx, totalScenes);
        let readyScenes = 0;

        for (const s of scenes) {
            const raw = await redis.get(`${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${s.chapter_id}:${s.scene_id}`);
            if (!raw) continue;
            try {
                const data = JSON.parse(raw);
                const st = data.state;
                if (st === state.SceneState.IMAGE_READY ||
                    st === state.SceneState.VIDEO_PENDING ||
                    st === state.SceneState.VIDEO_GENERATING ||
                    st === state.SceneState.VIDEO_READY) {
                    readyScenes++;
                }
            } catch (_) {}
        }

        return {
            total_scenes: totalScenes,
            started_scenes: startedScenes,
            ready_scenes: readyScenes,
            next_idx: nextIdx,
        };
    }

    async function detectAvailableMode(redis, bookId) {
        const workerHealth = require('../runtime/worker-health');
        const hasImage = await workerHealth.isAvailable(redis, 'image');
        const hasVideo = await workerHealth.isAvailable(redis, 'video');

        let mode;
        if (hasImage && hasVideo) mode = 'full';
        else if (hasImage) mode = 'storyboard';
        else mode = 'need_audio_worker';

        await redis.set(`animastor:mode:${bookId}`, mode);
        log('Mode detected:', mode, '(iw=' + hasImage + ' vw=' + hasVideo + ')');
        return mode;
    }

    async function saveIURegistry(iuId, buildId) {
        await redis.set(
            `animastor:iu:${iuId}`,
            JSON.stringify({ build_id: buildId })
        );
    }

    async function recoverChunksFromDisk(bookId, buildId, scenes) {
        const dir = path.join(config.OUTPUT_DIR, buildId);
        if (!fs.existsSync(dir)) {
            log('Recovery: output dir not found:', dir);
            return [];
        }

        const recovered = [];
        for (const scene of scenes) {
            const chapterId = scene.chapter_id;
            const sceneId = scene.scene_id;
            const audioPath = path.join(dir, `${bookId}_${chapterId}_${sceneId}.mp3`);
            if (!fs.existsSync(audioPath)) continue;

            const scenePrefix = `${bookId}_${chapterId}_${sceneId}_iu`;
            let dirFiles = [];
            try { dirFiles = fs.readdirSync(dir); } catch (_) {}
            const hasIuImages = dirFiles.some(f => f.startsWith(scenePrefix) && f.endsWith('.png'));
            const videoPath = path.join(dir, `${bookId}_${chapterId}_${sceneId}.mp4`);
            const hasVideo = fs.existsSync(videoPath);

            const chunkId = `${bookId}_${chapterId}_${sceneId}_0001`;

            const sceneStateKey = `${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
            try {
                await redis.del(sceneStateKey);
                // L5: Set per-asset to all READY (files exist on disk), then derive VIDEO_READY
                await state.setAssetStates(redis, bookId, chapterId, sceneId, {
                    audio: state.AssetState.READY,
                    image: state.AssetState.READY,
                    video: state.AssetState.READY
                });
                await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);
            } catch (err) {
                console.warn('Recovery: failed to reset scene state for', chapterId + '/' + sceneId + ':', err.message);
            }

            await saveChunk(chunkId, {
                build_id: buildId,
                book_id: bookId,
                scene_order: scene.scene_order || 0,
                chapter_id: chapterId,
                scene_id: sceneId,
                chunk_index: '0001',
                expected_chunk_count: 1,
                scene_type: scene.scene_type || 'narration',
                audio: true,
                audio_status: 'ready',
                image: hasIuImages,
                image_status: hasIuImages ? 'ready' : 'pending',
                video: hasVideo,
                video_status: hasVideo ? 'ready' : 'pending',
            });

            recovered.push(chunkId);
            log('Recovered chunk:', chunkId, '(audio=true image=' + hasIuImages + ' video=' + hasVideo + ')');
        }

        return recovered;
    }

    async function recoverAllBooksFromDisk() {
        log('[RECOVERY] Scanning ' + config.OUTPUT_DIR + ' for existing build outputs to restore Redis...');

        const outputDir = config.OUTPUT_DIR;
        if (!fs.existsSync(outputDir)) {
            log('[RECOVERY] Output directory not found:', outputDir);
            return;
        }

        const buildDirs = fs.readdirSync(outputDir).filter(name => {
            const fullPath = path.join(outputDir, name);
            try { return fs.statSync(fullPath).isDirectory(); } catch (_) { return false; }
        });

        if (buildDirs.length === 0) {
            log('[RECOVERY] No build directories found in', outputDir);
            return;
        }

        let totalRecovered = 0;
        for (const buildId of buildDirs) {
            const buildPath = path.join(outputDir, buildId);
            log('[RECOVERY] Scanning build:', buildId);

            let files = [];
            try { files = fs.readdirSync(buildPath); } catch (_) { continue; }
            const sceneFiles = files.filter(f => f.endsWith('.mp3') && f.includes('_ch') && f.includes('_sc'));

            const bookScenes = {};
            for (const f of sceneFiles) {
                const base = f.replace(/\.mp3$/, '');
                const parts = base.split('_');
                if (parts.length < 3) continue;
                const sceneId = parts.pop();
                const chapterId = parts.pop();
                if (!chapterId.startsWith('ch') || !sceneId.startsWith('sc')) continue;
                const bookId = parts.join('_');
                if (!bookScenes[bookId]) bookScenes[bookId] = new Set();
                bookScenes[bookId].add(chapterId + ':' + sceneId);
            }

            if (Object.keys(bookScenes).length === 0) {
                log('[RECOVERY] No recoverable scenes in', buildId + ', skipping');
                continue;
            }

            for (const [bookId, sceneSet] of Object.entries(bookScenes)) {
                const existingIds = await getAllChunks(bookId);
                if (existingIds.length > 0) {
                    log('[RECOVERY] Chunks already exist in Redis for', bookId + ', skipping');
                    continue;
                }

                const book = require('../book');
                const bookData = book.loadBook(bookId);
                const allScenes = bookData ? book.collectScenes(bookData) : [];
                const scenes = allScenes.filter(s => sceneSet.has(s.chapter_id + ':' + s.scene_id));
                if (scenes.length === 0) continue;

                log('[RECOVERY] Recovering', scenes.length, 'scenes for book', bookId, 'in build', buildId);
                const recovered = await recoverChunksFromDisk(bookId, buildId, scenes);
                if (recovered.length > 0) {
                    totalRecovered += recovered.length;
                    await redis.set(config.BOOK_SCENE_TOTAL(bookId), scenes.length);
                    await redis.set(config.BOOK_SCENE_NEXT(bookId), recovered.length);
                    log('[RECOVERY] Recovered', recovered.length + '/' + scenes.length, 'chunks for', bookId);
                } else {
                    log('[RECOVERY] No files on disk for', bookId, 'in build', buildId);
                }
            }
        }

        log('[RECOVERY] Complete:', totalRecovered, 'chunks recovered across', buildDirs.length, 'build(s)');
    }

    return {
        saveChunk,
        getChunk,
        getAllChunks,
        getBookWindowStatus,
        detectAvailableMode,
        saveIURegistry,
        recoverChunksFromDisk,
        recoverAllBooksFromDisk,

        /**
         * Clean ALL Redis keys associated with a book.
         * Covers all known key patterns: chunks, scene states, asset states,
         * dispatch leases/metadata, retry counters, fairness, event journals,
         * video cache, locks, job queue, active scenes, concurrency counters.
         *
         * @param {RedisClient} redis
         * @param {string} bookId
         * @param {Object} [options]
         * @param {boolean} [options.skipChunks=false]  — preserve chunk/chunks keys
         * @param {boolean} [options.skipSceneStates=false] — preserve scene state keys
         */
        cleanBookRedisKeys: async function cleanBookRedisKeys(redis, bookId, options = {}) {
            const log = (...args) => console.log(new Date().toISOString(), ...args);

            const patterns = [
                // Core data
                ...(options.skipChunks ? [] : [
                    `animastor:chunk:${bookId}_*`,
                    `animastor:chunks:${bookId}`,
                ]),
                ...(options.skipSceneStates ? [] : [
                    `animastor:scene-state:${bookId}:*`,
                ]),
                // Per-asset states (NEW canonical source of truth)
                `animastor:asset-state:${bookId}:*`,
                // Generation scope
                `animastor:gen-scope:${bookId}`,
                // Layer config
                `animastor:layer-config:${bookId}`,
                // Runtime dispatch leases & metadata
                `animastor:dispatch-lease:${bookId}:*`,
                `animastor:dispatch-meta:${bookId}:*`,
                // Retry counters (per-scene)
                `animastor:runtime:retry:${bookId}:*`,
                // Fairness engine
                `animastor:fairness:starvation-boost:${bookId}:*`,
                `animastor:fairness:book:${bookId}`,
                `animastor:fairness:retry-throttle:${bookId}`,
                // Event journal
                `animastor:event-journal:${bookId}:*`,
                // Video cache
                `animastor:scene-video:${bookId}:*`,
                // Scene window counters
                `animastor:book-scenes:${bookId}:*`,
                // Audio locks
                `animastor:audio-scene-lock:${bookId}:*`,
                `animastor:audio-scene-failsafe:*:${bookId}:*`,
                // Video locks
                `animastor:video-lock:${bookId}:*`,
                // Snapshot
                `animastor:snapshot:${bookId}`,
                // GPU hub job queue
                `animastor:job:${bookId}_*`,
                // GPU hub results (stale result blobs)
                `animastor:result:${bookId}_*`,
                // Scene audio status (used by cleanup-service)
                `animastor:scene-audio-status:${bookId}:*`,
                // Generation cancel flag
                `animastor:generation:cancel:${bookId}`,
                // Mode
                `animastor:mode:${bookId}`,
                // Legacy patterns (catch-all)
                `animastor:book:${bookId}:*`,
                `animastor:scope:${bookId}`,
                `animastor:asset:*:${bookId}:*`,
                `animastor:lease:*:${bookId}:*`,
                `animastor:scene:*:*:${bookId}`,
            ];

            let totalDeleted = 0;
            for (const pattern of patterns) {
                try {
                    let cursor = 0;
                    do {
                        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
                        cursor = parseInt(result[0], 10);
                        const keys = result[1];
                        if (keys.length > 0) {
                            await redis.del(...keys);
                            totalDeleted += keys.length;
                        }
                    } while (cursor !== 0);
                } catch (err) {
                    console.warn('[CLEAN] Scan failed for pattern', pattern, ':', err.message);
                }
            }

            // ── Active scenes set (iterate, pattern match, srem individually) ──
            try {
                const allActive = await redis.smembers('animastor:active-scenes');
                let removedActive = 0;
                for (const sceneKey of allActive) {
                    if (sceneKey.startsWith(`${bookId}:`)) {
                        await redis.srem('animastor:active-scenes', sceneKey);
                        removedActive++;
                    }
                }
                log(`[CLEAN] ${bookId}: removed ${removedActive} scenes from active-scenes set`);
            } catch (err) {
                console.warn('[CLEAN] Failed to clean active-scenes:', err.message);
            }

            // ── Concurrency counters (decrement by removing from set) ──
            // These are GLOBAL counters — we can't decrement by exact amount
            // without knowing how many scenes this book had. Best-effort: reset to 0
            // if the counter only had scenes from this book. Otherwise leave them.
            // For safety, we don't touch global counters here.

            log(`[CLEAN] ${bookId}: deleted ${totalDeleted} Redis keys`);
            return { deleted: totalDeleted };
        },
    };
};
