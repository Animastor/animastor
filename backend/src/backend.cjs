// ======================================================
// Animastor Backend - v1.0.0
// ======================================================
//
// Version:        1.0.0
// Release Date:   2026-05-17
// Codename:       SCENE_STATE_MACHINE
//
// Description:
//   Монолитный бэкенд с явной scene state machine для оркестрации генерации.
//   Архитектура: Backend -> GPU HUB -> GPU Worker -> SceneStateMachine
//   Вход: .vbook архив (JSON-файлы книги)
//   Процесс: Разбор книги -> Планирование задач -> Состояние сцены -> GPU HUB -> Обработка воркерами
//   Выход: Готовые медиафайлы (MP3, PNG, MP4) и API для получения состояния.
//
// Engine Pipeline:
//   [00] Scene State Machine - Explicit lifecycle with formal state transitions
//   [01] Core Init           - Инициализация зависимостей, конфигурации, Redis, директорий.
//   [02] Helpers             - Вспомогательные функции (логирование, форматирование ID, длительность аудио).
//   [02.1] LTX Frame Helpers - Функции для корректного вычисления количества кадров для LTX.
//   [02.2] File Helpers      - Функции сохранения файлов на диск.
//   [02.3] Safe File Helpers  - Безопасное чтение файлов.
//   [02.4] Safe Directory Helpers - Безопасная работа с путями.
//   [02.5] Build Lifecycle Helpers - Управление жизненным циклом билдов.
//   [02.6] Observability     - Счетчики и статистика.
//   [03] Book Storage        - Функции сохранения, загрузки и сброса данных книги.
//   [04] ZIP Loader          - Функции извлечения и сборки книги из .vbook архива.
//   [05] Scene Collector     - Функция сбора runtime представления сцен.
//   [06] Redis Cache         - Функции взаимодействия с Redis для метаданных.
//   [07] Prompts             - Функции генерации промптов для ComfyUI.
//   [08] Chunking            - Функции разделения текста сцены на чанки.
//   [08.1] Segments          - Функция сбора сегментов из сцены.
//   [09] Workflows           - Загрузка шаблонов ComfyUI workflows.
//   [10] Job Dispatcher      - Функции отправки задач в GPU HUB.
//   [11] Scene Generation    - Основная логика генерации сцены.
//   [12] Scene State Transitions - Explicit state machine orchestration
//   [13] API                 - Эндпоинты для взаимодействия с клиентом и GPU HUB.
//   [14] Server              - Отладочные эндпоинты и запуск сервера.
//
// ======================================================

const path = require('path');

// ======================================================
// MODULE IMPORTS (MODULAR MONOLITH)
// ======================================================
const state = require('./state');
const audio = require('./audio');
const image = require('./image');
const video = require('./video');
const workflows = require('./workflows');
const { resumeIncompleteSessions } = require('./startup-resume');
const orchestrator = require('./orchestration');
const journal = require('./orchestration/event-journal');
const storage = require('./storage');
const runtime = require('./runtime');
const activeScenes = require('./runtime/active-scenes-index');
const book = require('./book');
const config = require('./config/runtime-config');
const aiLoader = require('./services/ai-loader');
const txtImporter = require('./services/txt-importer');
const lazyBook = require('./book/lazy-book');
const genSessionRepo = require('./storage/postgres/repositories/gen-session-repo');
const placeholderAudio = require('./services/placeholder-audio');

const filesystem = storage.filesystem;
const layerConfig = storage.layerConfig;
const genScope = storage.genScope;

// Audio path helpers (audio module exports getOutputPath, not getSceneAudioPath)
const getSceneAudioPath = (buildId, bookId, chapterId, sceneId) =>
    audio.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);

// Service exports for convenience
const audioService = audio;
const imageService = image;
const videoService = video;

// Re-export state machine constants for backward compatibility
const SceneState = state.SceneState;
const SceneTransitions = state.SceneTransitions;
const SCENE_STATE_KEY_PREFIX = state.SCENE_STATE_KEY_PREFIX;
const SCENE_TRANSITION_LOCK_PREFIX = state.SCENE_TRANSITION_LOCK_PREFIX;
const SCENE_TRANSITION_LOCK_TTL = state.SCENE_TRANSITION_LOCK_TTL || 15; // Default if not exported
const SCENE_STUCK_THRESHOLDS = config.STUCK_THRESHOLDS;

// State function wrappers (inject global redis)
const transitionSceneState = (bookId, chapterId, sceneId, newState) =>
    state.transitionSceneState(redis, bookId, chapterId, sceneId, newState);
const sceneHeartbeat = (bookId, chapterId, sceneId) =>
    state.sceneHeartbeat(redis, bookId, chapterId, sceneId);
const startSceneHeartbeatTimer = (bookId, chapterId, sceneId, intervalMs) =>
    state.startSceneHeartbeatTimer(redis, bookId, chapterId, sceneId, intervalMs);
const stopSceneHeartbeatTimer = (bookId, chapterId, sceneId) =>
    state.stopSceneHeartbeatTimer(bookId, chapterId, sceneId);
const getSceneState = (bookId, chapterId, sceneId) =>
    state.getSceneState(redis, bookId, chapterId, sceneId);
const isSceneAudioReady = (buildId, bookId, chapterId, sceneId) =>
    audio.isSceneAudioReady(buildId, bookId, chapterId, sceneId);

// ======================================================
// [02] CORE INIT
// ======================================================
const Redis = require("ioredis")
const express = require("express")
const cors = require("cors")
const multer = require("multer")
const AdmZip = require("adm-zip")
const fs = require("fs")
const fetch = global.fetch || require("node-fetch") // Используем глобальный fetch или node-fetch
const { PORT = 3000, HUB_URL = "https://animastor.in/gpu", BUILD_TTL_HOURS = 48 } = process.env
const redis = new Redis({
    host: "redis",
    port: 6379
})
const app = express()
app.use(cors())
app.use(express.json({ limit: "50mb" }))
const OUTPUT_DIR = config.OUTPUT_DIR
// ======================================================
// [02] HELPERS
// ======================================================
function log(...args) {
    console.log(new Date().toISOString(), ...args)
}

// Pad number with leading zeros (e.g., pad(1) -> "0001")
function pad(n) {
    return String(n).padStart(4, '0')
}

// ======================================================
// CANONICAL ID VALIDATION
// ======================================================
// Format: ch-XXXXXXXX, sc-XXXXXXXX, iu-XXXXXXXX
// Chapters use ch prefix (few, order-stable).
// Scenes use sc prefix (random ID, order-independent).
// Units use iu prefix (random ID, order-independent).
//
// Validation performed ONCE on book load.
// After validation, backend TRUSTS all IDs implicitly.

// [02.9] ID HELPERS
// ======================================================

// Parses chunk ID to extract bookId, chapterId, sceneId, chunkIndex
// Chunk ID format: book_chapter_scene_chunkIndex.mp3
// Example: master_margarita_demo_ch-XXXXXXXX_sc-XXXXXXXX_0001
function parseChunkId(chunkId) {
    const parts = chunkId.split('_')
    
    if (parts.length < 4) {
        console.error("❌ Invalid chunk ID (too few parts):", chunkId)
        return null
    }
    
    // Last part is chunk index (always 4 digits)
    const chunkIndex = parts.pop()  // 0001
    
    // Second-to-last is sceneId (has prefix scXXXX)
    const sceneId = parts.pop()     // sc-XXXXXXXX
    
    // Third-to-last is chapterId (has prefix chXXXX)
    const chapterId = parts.pop()   // ch-XXXXXXXX
    
    // Everything else is bookId (can contain underscores)
    const bookId = parts.join('_')
    
    return { bookId, chapterId, sceneId, chunkIndex }
}

// [02.14] AUDIO/STORAGE CONSOLIDATION - USE MODULES DIRECTLY
// ======================================================
// No wrapper layer - use storage.filesystem and audio modules directly

// Storage path helpers - use storage.filesystem directly
// Note: storage.filesystem functions expect OUTPUT_DIR as first parameter
const STORAGE_OUTPUT_DIR = OUTPUT_DIR;

// Audio helpers - use audio module directly
// (audioService already declared at line 47)

// Безопасное построение пути для buildId.
function safeBuildPath(buildId) {
    // 1. Проверка на пустую строку, "." и ".."
    if (!buildId || buildId === '.' || buildId === '..') {
        console.error("⚠️ Invalid buildId (empty, ., ..):", buildId);
        return null;
    }
    // 2. Проверка на наличие слэшей или бэкслэшей (после basename)
    // basename сам по себе уже защищает от path traversal, но дополнительная проверка.
    if (buildId.includes('/') || buildId.includes('\\')) {
        console.error("⚠️ buildId contains path separators:", buildId);
        return null;
    }
    // 3. Regex allowlist: ^[a-zA-Z0-9._-]+$
    const regex = /^[a-zA-Z0-9._-]+$/;
    if (!regex.test(buildId)) {
        console.error("⚠️ buildId fails regex validation:", buildId);
        return null;
    }

    const safeId = path.basename(buildId); // basename уже защищает от path traversal
    const fullPath = path.resolve(OUTPUT_DIR, safeId);
    const outputDirResolved = path.resolve(OUTPUT_DIR);

    // 4. Проверка на path traversal через path.relative
    const relative = path.relative(outputDirResolved, fullPath);
    // Если путь выходит за пределы OUTPUT_DIR, relative начнётся с '..' или будет абсолютным
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        console.error("⚠️ Path traversal attempt detected via relative path in safeBuildPath:", buildId, fullPath, relative);
        return null; // или выбросить ошибку
    }
    // 5. Защита от удаления корневой директории OUTPUT_DIR
    if (fullPath === outputDirResolved) {
        console.error("⚠️ Attempt to target OUTPUT_DIR root:", buildId, fullPath);
        return null;
    }
    return fullPath;
}

// [02.5] BUILD LIFECYCLE HELPERS
// ======================================================
// Удаляет директорию билда безопасно.
function cleanupBuild(buildId) {
    const buildPath = safeBuildPath(buildId);
    if (!buildPath) {
        console.error("❌ Cannot cleanup build, invalid path for buildId:", buildId);        return { ok: false, reason: "invalid_path", path: buildId };
    }
    // Проверка, что путь не является корневой директорией OUTPUT_DIR
    const outputDirResolved = path.resolve(OUTPUT_DIR);
    if (buildPath === outputDirResolved) {
        console.error("❌ Cannot cleanup OUTPUT_DIR root:", buildPath);
        return { ok: false, reason: "cannot_delete_root", path: buildPath };
    }

    if (fs.existsSync(buildPath)) {
        try {
            fs.rmSync(buildPath, { recursive: true, force: true });
            log("🗑 Cleaned up build:", buildId);
            return { ok: true, reason: "success", path: buildPath };
        } catch (err) {
            console.error("❌ Failed to cleanup build:", buildId, err.message);
            return { ok: false, reason: "fs_error", path: buildPath, error: err.message };
        }
    } else {
        console.log("⚠️ Build directory does not exist, nothing to cleanup:", buildId);
        return { ok: true, reason: "does_not_exist", path: buildPath }; // или false, если это ошибка
    }
}


// Distributed cleanup lock - prevents parallel cleanup across replicas
let cleanupLockToken = null

// Acquire Redis distributed lock for cleanup
async function acquireCleanupLock() {
    const lockKey = 'animastor:cleanup-lock'
    const token = `cleanup-token:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    const locked = await redis.set(lockKey, token, 'NX', 'EX', 120) // 2 min TTL
    if (locked) {
        cleanupLockToken = token
        return { acquired: true, token }
    }
    return { acquired: false, token: null }
}

// Release cleanup lock
async function releaseCleanupLock() {
    const lockKey = 'animastor:cleanup-lock'
    if (!cleanupLockToken) return { released: false, reason: 'no_token' }
    try {
        const current = await redis.get(lockKey)
        if (current) {
            const data = JSON.parse(current)
            if (data.token === cleanupLockToken) {
                await redis.del(lockKey)
                cleanupLockToken = null
                return { released: true, reason: 'success' }
            }
        }
    } catch (e) {
        console.error('❌ FAILED TO RELEASE CLEANUP LOCK:', e.message)
    }
    return { released: false, reason: 'token_mismatch' }
}

// ======================================================
// [02.14] AUDIO SCENE STALE LOCK CLEANUP
// ======================================================

/**
 * [PRIORITY 3] Cleanup expired audio scene locks that might be stuck.
 * Uses SCAN to avoid blocking Redis - no KEYS used.
 * Scans failsafe keys, releases stale locks if audio is ready.
 * Prevents deadlock scenarios for long-running jobs.
 */
async function cleanupExpiredAudioSceneLocks() {
    // [PRIORITY 3] Use distributed Redis lock to prevent parallel cleanup across replicas
    const lockResult = await acquireCleanupLock()
    if (!lockResult.acquired) {
        console.log("⚠️ Cleanup already running (distributed lock held), skipping this cycle")
        return
    }

    try {
        // [PRIORITY 1] Use SCAN instead of KEYS to avoid blocking Redis
        let cursor = 0

        do {
            // Scan for failsafe keys in batches
            const result = await redis.scan(cursor, 'MATCH', 'animastor:audio-scene-failsafe:*', 'COUNT', 100)
            cursor = parseInt(result[0], 10)
            const keys = result[1]

            for (const failsafeKey of keys) {
                // Check if failsafe key exists (not expired yet)
                const exists = await redis.exists(failsafeKey)
                if (exists) continue // Not expired yet

                // [PRIORITY 2] Fixed: no fake buildId - extract from valid key
                // Format: animastor:audio-scene-failsafe:buildId:bookId:chapterId:sceneId
                const parts = failsafeKey.split(':')
                if (parts.length < 7) continue // Need 7 parts

                const buildId = parts[3]
                const bookId = parts[4]
                const chapterId = parts[5]
                const sceneId = parts[6]

                // Check audio status - only release if audio is ready
                const audioStatusKey = `animastor:scene-audio-status:${bookId}:${chapterId}:${sceneId}`
                const audioStatus = await redis.get(audioStatusKey)

                if (audioStatus === 'ready') {
                    const lockKey = `animastor:audio-scene-lock:${bookId}:${chapterId}:${sceneId}`
                    const current = await redis.get(lockKey)
                    if (current) {
                        const data = JSON.parse(current)
                        const token = data?.token

                        if (token) {
                            await redis.del(lockKey)
                            log(`✅ Stale audio lock released (audio ready):`, lockKey)
                        }
                    }
                }
            }
        } while (cursor !== 0) // Continue until SCAN returns cursor = 0
    } catch (err) {
        console.error("❌ Audio scene stale lock cleanup error:", err.message)
    } finally {
        await releaseCleanupLock()
    }
}

// Start periodic cleanup in background
// [PRIORITY 5] Run first immediately, then every 60 seconds
setInterval(cleanupExpiredAudioSceneLocks, 60000) // 60 seconds
cleanupExpiredAudioSceneLocks() // Run immediately on startup

// ======================================================
// [02.9] AUDIO PIPELINE UNIFIED - CANONICAL SCENE AUDIO
// [02.6] OBSERVABILITY
// ======================================================
// Простые runtime счетчики
const stats = {
    audio_jobs_started: 0,
    image_jobs_started: 0,
    video_jobs_started: 0,
    failed_jobs: 0,
    // [PRIORITY 1] REAL ACTIVE VIDEO LOCK METRICS
    active_video_locks: 0 // Теперь будет учитываться реальное количество
};

// [02.7] ASSET PATH RESOLUTION - ARCHITECTURAL LAYER SEPARATION
// ======================================================
// Filesystem = asset storage layer (primary)
// Redis      = orchestration layer (metadata only)
// Filesystem save MUST NOT depend on Redis lookup.

/**
 * Resolves asset path and type from job_id.
 * 
 * ARCHITECTURAL RULE: This function determines filesystemsave WITHOUT Redis.
 * Redis is only used AFTER successful filesystem save for orchestration updates.
 *
 * Examples:
 * - "master_ch-XXXXXXXX_sc-XXXXXXXX_0001:audio" -> { type: "audio_chunk", extension: "mp3", fullPath: ".../master_ch-XXXXXXXX_sc-XXXXXXXX_0001.mp3" }
 * - "master_ch-XXXXXXXX_sc-XXXXXXXX_iu-XXXXXXXX:image" -> { type: "iu_image", extension: "png", fullPath: ".../master_ch-XXXXXXXX_sc-XXXXXXXX_iu-XXXXXXXX.png" }
 * - "master_ch-XXXXXXXX_sc-XXXXXXXX:video" -> { type: "scene_video", extension: "mp4", fullPath: ".../master_ch-XXXXXXXX_sc-XXXXXXXX.mp4" }
 *
 * @param {string} job_id - The job ID from GPU HUB callback
 * @param {string} buildId - The build ID for output directory
 * @returns {Object|null} { type, extension, fullPath } or null if unresolved
 */
function resolveAssetPath(job_id, buildId) {
    if (!job_id || !buildId) return null;

    const outputDir = path.join(OUTPUT_DIR, buildId);

    // Determine asset type and extension from job_id suffix
    if (job_id.endsWith(":audio")) {
        const assetId = job_id.replace(/:audio$/, "");
        return {
            type: "audio_chunk",
            extension: "mp3",
            fullPath: path.join(outputDir, `${assetId}.mp3`)
        };
    }

    if (job_id.endsWith(":video")) {
        let assetId = job_id.replace(/:video$/, "");
        // Handle multi-group suffix (_g1, _g2, etc.)
        const groupMatch = assetId.match(/^(.+?)(_g\d+)$/);
        const groupSuffix = groupMatch ? groupMatch[2] : '';
        if (groupMatch) assetId = groupMatch[1];
        
        // assetId already has correct format: bookId_chapterId_sceneId
        return {
            type: "scene_video",
            extension: "mp4",
            fullPath: path.join(outputDir, `${assetId}${groupSuffix}.mp4`)
        };
    }

    if (job_id.endsWith(":image")) {
        const assetId = job_id.replace(/:image$/, "");
        // Check if this is an IU image (contains _iu prefix)
        // IU format: book_ch-XXXXXXXX_sc-XXXXXXXX_iu-XXXXXXXX
        if (assetId.includes("_iu")) {
            return {
                type: "iu_image",
                extension: "png",
                fullPath: path.join(outputDir, `${assetId}.png`)
            };
        }
        return {
            type: "scene_image",
            extension: "png",
            fullPath: path.join(outputDir, `${assetId}.png`)
        };
    }

    return null;
}

// [02.9] SCENE LOOKUP HELPER
// ======================================================
function findSceneRuntimeData(loadedBook, chapterId, sceneId) {
    if (book.findSceneRuntimeData) {
        return book.findSceneRuntimeData(loadedBook, chapterId, sceneId);
    }
    // Fallback local implementation
    const chapters = loadedBook.chapters || []
    for (const ch of chapters) {
        if (ch.chapter === chapterId) {
            const scenes = ch.scenes || []
            for (const sc of scenes) {
                if (sc.scene_id === sceneId) {
                    return {
                        runtime_type: "scene",
                        chapter_id: ch.chapter,
                        scene_id: sc.scene_id,
                        scene_type: sc.type || "narration",
                        location: sc.location || null,
                        participants: sc.participants || [],
                        chapter: ch,
                        scene: sc,
                        payload: sc
                    }
                }
            }
        }
    }
    return null
}

// ======================================================
// [05] SCENE COLLECTOR
// ======================================================
// Собирает все сцены из JSON. All scenes are now consistent:
// - chapter_intro is part of scenes array (scene_id: sc-XXXXXXXX)
// - No special cover/chapter_intro handling needed
function collectScenes(book) {
    const runtime = []

    // CHAPTERS - chapter_intro is now in scenes array (with canonical IDs)
    const chapters = book.chapters || []
    for (let chIndex = 0; chIndex < chapters.length; chIndex++) {
        const ch = chapters[chIndex]
        // chapter.chapter is already canonical (ch-XXXXXXXX) after strict validation
        const canonicalChapterId = ch.chapter

        // SCENES - include chapter_intro (with canonical IDs)
        for (let scIndex = 0; scIndex < (ch.scenes || []).length; scIndex++) {
            const scene = ch.scenes[scIndex]
            // scene.scene_id is already canonical (sc-XXXXXXXX) after strict validation
            runtime.push({
                runtime_type: "scene",
                chapter_id: canonicalChapterId,
                scene_id: scene.scene_id,
                scene_type: scene.type || "narration",
                location: scene.location || null,
                participants: scene.participants || [],
                // render context
                chapter: ch,
                scene,
                // indexing
                sceneIndex: scIndex,
                // runtime ordering
                scene_order: runtime.length + 1,
                payload: scene
            })
        }
    }
    return runtime
}

// [05.1] Scene Units Helper (HEADER ONLY)
// Секция для хелпера сбора юнитов. Функция определена в [02.7].
// TODO: future: preserve parent block context (e.g., { unit, parent_block, order, runtime_context })
// TODO: future: runtime units must be cloned before enrichment

// ======================================================
// [06] REDIS CACHE
// ======================================================
// Сохраняет чанк в Redis. ТЕПЕРЬ ТОЛЬКО МЕТАДАННЫЕ!
// chunk.image, chunk.audio, chunk.video - boolean флаги готовности файла на диске.
async function saveChunk(id, data) {
    const chunkForRedis = {
        build_id: data.build_id,
        book_id: data.book_id,
        scene_order: data.scene_order,
        chapter_id: data.chapter_id,
        scene_id: data.scene_id,
        chunk_index: data.chunk_index,
        expected_chunk_count: data.expected_chunk_count || null,
        // Runtime context for scene-level orchestration
        runtime_type: data.runtime_type || "scene", // "scene" (all scenes are uniform now)
        scene_type: data.scene_type || "narration", // "narration", "dialogue"
        // Сохраняем ТОЛЬКО boolean флаги готовности файлов
        image: !!data.image, // Если data.image true, флаг в Redis будет true
        audio: !!data.audio, // Если data.audio true, флаг в Redis будет true
        video: !!data.video, // Если data.video true, флаг в Redis будет true
        video_status: data.video_status || "pending",
        audio_status: data.audio_status || "pending",
        padded_text: !!data.padded_text
    };
    await redis.set(`animastor:chunk:${id}`, JSON.stringify(chunkForRedis))
    await redis.sadd(`animastor:chunks:${data.book_id}`, id)
}

// Получает чанк из Redis и нормализует его структуру.
// ВНИМАНИЕ: данные о файлах - только boolean флаги готовности!
async function getChunk(id) {
    const raw = await redis.get(`animastor:chunk:${id}`)
    if (!raw) return null
    const c = JSON.parse(raw)
    // --- NORMALIZE (важно для старых чанков)
    if (c.video === undefined) c.video = false // Было null, теперь false
    if (!c.video_status) c.video_status = "pending"
    if (!c.audio_status) c.audio_status = "pending"
    // Normalize chunk_index to canonical string format (0001, 0002, etc.)
    c.chunk_index = pad(parseInt(c.chunk_index) || 0)
    // Ensure chapter_id, scene_id exist for newer chunks
    c.chapter_id = c.chapter_id || null
    c.scene_id = c.scene_id || null
    // Default runtime context for older chunks
    c.runtime_type = c.runtime_type || "scene"
    c.scene_type = c.scene_type || "narration"
    return c
}

// Получает список всех ID чанков для книги.
async function getAllChunks(bookId) {
    const ids = await redis.smembers(`animastor:chunks:${bookId}`)
    if (ids.length <= 1) return ids
    try {
        const keys = ids.map(id => `animastor:chunk:${id}`)
        const raw = await redis.mget(keys)
        const pairs = ids.map((id, i) => {
            const data = raw[i] ? JSON.parse(raw[i]) : {}
            return { id, scene_order: data.scene_order || 0, chunk_index: data.chunk_index || '0001' }
        })
        pairs.sort((a, b) => a.scene_order - b.scene_order || a.chunk_index.localeCompare(b.chunk_index))
        return pairs.map(p => p.id)
    } catch (e) {
        log(`getAllChunks sort failed, falling back: ${e.message}`)
        return ids.sort((a, b) => a.localeCompare(b))
    }
}

async function getBookWindowStatus(bookId) {
    const bookData = book.loadBook(bookId)
    const scenes = bookData ? book.collectScenes(bookData) : []
    const totalScenes = scenes.length
    const nextIdx = parseInt(await redis.get(config.BOOK_SCENE_NEXT(bookId)) || '0', 10)
    const startedScenes = Math.min(nextIdx, totalScenes)
    let readyScenes = 0

    for (const s of scenes) {
        const raw = await redis.get(`${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${s.chapter_id}:${s.scene_id}`)
        if (!raw) continue
        try {
            const data = JSON.parse(raw)
            const st = data.state
            if (st === state.SceneState.IMAGE_READY ||
                st === state.SceneState.VIDEO_PENDING ||
                st === state.SceneState.VIDEO_GENERATING ||
                st === state.SceneState.VIDEO_READY) {
                readyScenes++
            }
        } catch {}
    }

    return {
        total_scenes: totalScenes,
        started_scenes: startedScenes,
        ready_scenes: readyScenes,
        next_idx: nextIdx
    }
}

async function detectAvailableMode(redis, bookId) {
    const workerHealth = require('./runtime/worker-health');
    const hasAudio = await workerHealth.isAvailable(redis, 'audio');
    const hasImage = await workerHealth.isAvailable(redis, 'image');
    const hasVideo = await workerHealth.isAvailable(redis, 'video');

    let mode;
    if (!hasAudio) mode = 'need_audio_worker';
    else if (!hasImage) mode = 'need_image_worker';
    else if (hasAudio && hasImage && hasVideo) mode = 'full';
    else mode = 'storyboard';

    await redis.set(`animastor:mode:${bookId}`, mode);
    log(`Mode detected: ${mode} (aw=${hasAudio} iw=${hasImage} vw=${hasVideo})`);
    return mode;
}

// ======================================================
// [06.1] IU REGISTRY
// ======================================================

async function saveIURegistry(iuId, buildId) {
    await redis.set(
        `animastor:iu:${iuId}`,
        JSON.stringify({
            build_id: buildId
        })
    )
}

// ======================================================
// [08] CHUNKING
// ======================================================
// Разделение текста на чанки по предложениям.
function splitTextIntoChunks(text, maxChars = 500) {
    if (!text?.trim()) {
        return []
    }
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text]
    const chunks = []
    let current = ""
    for (const sentence of sentences) {
        const test = current ? current + " " + sentence : sentence
        if (test.length > maxChars) {
            if (current.trim()) {                chunks.push(current.trim())
            }
            current = sentence
        } else {
            current = test
        }
    }
    if (current.trim()) {
        chunks.push(current.trim())
    }
    return chunks
}

// Разделение текста диалога на чанки по репликам.
function splitDialogueIntoChunks(text, maxChars = 500) {
    if (!text?.trim()) {
        return []
    }
    text = text.replace(/\r/g, "").trim()

    const lines = text.match(/[a-z0-9_]+:\s.*?(?=\n[a-z0-9_]+:|$)/gis) || [text]
    const chunks = []
    let current = ""
    for (const rawLine of lines) {
        const line = rawLine.trim()
        const test = current ? current + "\n" + line : line
        if (test.length > maxChars) {
            if (current.trim()) {
                chunks.push(current.trim())
            }
            current = line
        } else {
            current = test
        }
    }
    if (current.trim()) {
        chunks.push(current.trim())
    }
    return chunks
}

// ======================================================
// [08.1] SEGMENTS (FIXED)
// ======================================================
// Функция, которая была potentially missing. Восстановлена.
function buildSegments(runtimeEntry) {
    // ======================================================
    // NARRATION
    // ======================================================
    if (
        runtimeEntry.runtime_type === "scene" &&
        runtimeEntry.scene_type === "narration"
    ) {
        const fullText =
            runtimeEntry.payload?.audio?.full_text || ""
        const chunks =
            splitTextIntoChunks(fullText)
        return chunks.map((text, i) => ({
            segment_id:
                String(i + 1).padStart(4, "0"),
            segment_type:
                "narration",            text
        }))
    }
    // ======================================================
    // DIALOGUE
    // ======================================================
    if (
        runtimeEntry.runtime_type === "scene" &&
        runtimeEntry.scene_type === "dialogue"
    ) {
        console.log(
            "DIALOGUE PAYLOAD:",
            JSON.stringify(
                runtimeEntry.payload,
                null,
                2
            )
        )
        const fullText =
            runtimeEntry.payload?.audio?.full_text || ""
        const chunks =
            splitDialogueIntoChunks(fullText)
        return chunks.map((text, i) => ({
            segment_id:
                String(i + 1).padStart(4, "0"),
            segment_type:
                "dialogue",
            text
        }))
    }
    return []
}

// ======================================================
// [12.5] RECOVER CHUNKS FROM DISK (when Redis is empty)
// ======================================================

async function recoverChunksFromDisk(redis, bookId, buildId, scenes) {
    const dir = path.join(config.OUTPUT_DIR, buildId);
    if (!fs.existsSync(dir)) {
        log(`Recovery: output dir not found: ${dir}`);
        return [];
    }

    const recovered = [];
    for (const scene of scenes) {
        const chapterId = scene.chapter_id;
        const sceneId = scene.scene_id;
        const audioPath = path.join(dir, `${bookId}_${chapterId}_${sceneId}.mp3`);
        if (!fs.existsSync(audioPath)) continue;

        // Check for IU images
        const scenePrefix = `${bookId}_${chapterId}_${sceneId}_iu`;
        let dirFiles = [];
        try { dirFiles = fs.readdirSync(dir); } catch {}
        const hasIuImages = dirFiles.some(f => f.startsWith(scenePrefix) && f.endsWith('.png'));

        // Check for video
        const videoPath = path.join(dir, `${bookId}_${chapterId}_${sceneId}.mp4`);
        const hasVideo = fs.existsSync(videoPath);

        const chunkId = `${bookId}_${chapterId}_${sceneId}_0001`;

        // Reset scene state to completed (VIDEO_READY) with build_id
        const sceneStateKey = `${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
        try {
            await redis.del(sceneStateKey);
            await state.setSceneStateWithBuildId(redis, bookId, chapterId, sceneId, state.SceneState.VIDEO_READY, buildId);
        } catch (err) {
            console.warn(`Recovery: failed to reset scene state for ${chapterId}/${sceneId}: ${err.message}`);
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
            video: hasVideo,
            video_status: hasVideo ? 'ready' : 'pending'
        });

        recovered.push(chunkId);
        log(`Recovered chunk: ${chunkId} (audio=${true} image=${hasIuImages} video=${hasVideo})`);
    }

    return recovered;
}

/**
 * Scan /data/output/ on startup and recover Redis chunk metadata from disk files.
 * Handles the case where Redis was flushed/cleared but output files still exist.
 * Does NOT require re-generation via workers.
 */
async function recoverAllBooksFromDisk() {
    log("🔍 [RECOVERY] Scanning /data/output/ for existing build outputs to restore Redis...");

    const outputDir = config.OUTPUT_DIR;
    if (!fs.existsSync(outputDir)) {
        log("[RECOVERY] Output directory not found:", outputDir);
        return;
    }

    const buildDirs = fs.readdirSync(outputDir).filter(name => {
        const fullPath = path.join(outputDir, name);
        try { return fs.statSync(fullPath).isDirectory(); } catch { return false; }
    });

    if (buildDirs.length === 0) {
        log("[RECOVERY] No build directories found in", outputDir);
        return;
    }

    let totalRecovered = 0;
    for (const buildId of buildDirs) {
        const buildPath = path.join(outputDir, buildId);
        log(`[RECOVERY] Scanning build: ${buildId}`);

        // Find scene audio files: bookId_chXXXX_scXXXX.mp3
        let files = [];
        try { files = fs.readdirSync(buildPath); } catch { continue; }
        const sceneFiles = files.filter(f =>
            f.endsWith('.mp3') && f.includes('_ch') && f.includes('_sc')
        );

        // Group by bookId
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
            bookScenes[bookId].add(`${chapterId}:${sceneId}`);
        }

        if (Object.keys(bookScenes).length === 0) {
            log(`[RECOVERY] No recoverable scenes in ${buildId}, skipping`);
            continue;
        }

        for (const [bookId, sceneSet] of Object.entries(bookScenes)) {
            // Skip if chunks already exist in Redis for this book
            const existingIds = await getAllChunks(bookId);
            if (existingIds.length > 0) {
                log(`[RECOVERY] Chunks already exist in Redis for ${bookId}, skipping`);
                continue;
            }

            const bookData = book.loadBook(bookId);
            const allScenes = bookData ? book.collectScenes(bookData) : [];
            const scenes = allScenes.filter(s => sceneSet.has(`${s.chapter_id}:${s.scene_id}`));

            if (scenes.length === 0) continue;

            log(`[RECOVERY] Recovering ${scenes.length} scenes for book ${bookId} in build ${buildId}`);
            const recovered = await recoverChunksFromDisk(redis, bookId, buildId, scenes);
            if (recovered.length > 0) {
                totalRecovered += recovered.length;
                await redis.set(config.BOOK_SCENE_TOTAL(bookId), scenes.length);
                await redis.set(config.BOOK_SCENE_NEXT(bookId), recovered.length);
                log(`[RECOVERY] Recovered ${recovered.length}/${scenes.length} chunks for ${bookId}`);
            } else {
                log(`[RECOVERY] No files found on disk for ${bookId} in build ${buildId}`);
            }
        }
    }

    log(`[RECOVERY] Complete: ${totalRecovered} chunks recovered across ${buildDirs.length} build(s)`);
}

// ======================================================
// [13] API ENDPOINTS
// ======================================================

/**
 * POST /api/v1/book/load-vbook
 * Multipart: file=<vbook.zip>
 *
 * Loads a vbook bundle (parse + save to disk if new, or load existing
 * edited version) and returns book metadata — does NOT start the
 * generation pipeline. The client must explicitly call
 * POST /api/v1/book/{bookId}/regenerate to start generation.
 *
 * This is the "open book" path; the legacy /generate endpoint is
 * preserved for backward compatibility but is no longer used by the
 * client when a user simply opens a vbook file.
 */
app.post("/api/v1/book/load-vbook", multer().single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "file missing" })
        }

        // LOAD BUNDLE
        const files = book.extractBookBundle(req.file.buffer)
        log("[LOAD-VBOOK] bundle loaded:", Object.keys(files))

        // BUILD BOOK (validation, canonical IDs, etc.)
        const bookData = book.buildBookFromBundle(files)
        const bookId = bookData.manifest.book_id
        const buildId = bookData.manifest.build_id || "default"

        // If book already exists on disk, keep the edited version
        const existingBook = book.loadBook(bookId)
        let loadedBook
        if (existingBook) {
            log(`[LOAD-VBOOK] Book ${bookId} already exists — keeping existing (edited) version`)
            loadedBook = existingBook

            const existingScenes = book.collectScenes(existingBook)
            const chunks = await getAllChunks(bookId)
            if (chunks.length === 0) {
                log(`[LOAD-VBOOK] No chunks in Redis — attempting recovery from disk for ${existingScenes.length} scenes`)
                const recovered = await recoverChunksFromDisk(redis, bookId, buildId, existingScenes)
                if (recovered.length > 0) {
                    log(`[LOAD-VBOOK] Recovered ${recovered.length}/${existingScenes.length} chunks from disk for ${bookId}`)
                    await redis.set(config.BOOK_SCENE_TOTAL(bookId), existingScenes.length)
                    await redis.set(config.BOOK_SCENE_NEXT(bookId), recovered.length)
                } else {
                    log(`[LOAD-VBOOK] No files on disk for ${bookId} — generation needed`)
                }
            } else {
                log(`[LOAD-VBOOK] Found ${chunks.length} chunks in Redis for ${bookId}`)
            }
        } else {
            // SAVE BOOK (НА ДИСК)
            await book.resetBook(bookId)
            book.saveBookBundle(bookData, files)
            loadedBook = book.loadBook(bookId)
            console.log(`[LOAD-VBOOK] Loaded book from disk: ${bookId}, chapters: ${loadedBook?.chapters?.length}`);
        }

        const scenes = book.collectScenes(loadedBook || bookData)
        const chapterCount = loadedBook?.chapters?.length || bookData.chapters?.length || 0
        const sceneCount = scenes.length
        const title = bookData.manifest?.title || loadedBook?.manifest?.title || bookId

        log(`[LOAD-VBOOK] ${bookId}: ${chapterCount} chapters, ${sceneCount} scenes`)

        // Create chunks + placeholder audio for all scenes
        //  - For new books: create chunks + placeholders synchronously
        //  - For existing books: generate placeholders async (chunk endpoint handles on-demand fallback)
        const existingChunksAfterLoad = await getAllChunks(bookId);
        if (existingChunksAfterLoad.length === 0) {
            // No chunks exist — create them + placeholders synchronously so the frontend can start playback immediately
            log(`[LOAD-VBOOK] Creating chunks + placeholder audio for ${scenes.length} scenes...`);
            for (const s of scenes) {
                const chunkId = `${bookId}_${s.chapter_id}_${s.scene_id}_0001`;
                try {
                    await saveChunk(chunkId, {
                        build_id: buildId,
                        book_id: bookId,
                        scene_order: s.scene_order || 0,
                        chapter_id: s.chapter_id,
                        scene_id: s.scene_id,
                        chunk_index: '0001',
                        expected_chunk_count: 1,
                        scene_type: s.scene_type || 'narration',
                        audio: true,
                        audio_status: 'placeholder',
                        image: false,
                        video: false,
                        video_status: 'pending',
                        padded_text: false,
                    });
                } catch (chunkErr) {
                    console.warn(`[LOAD-VBOOK] Failed to create chunk ${chunkId}: ${chunkErr.message}`);
                }
            }
            // Generate placeholder audio for all scenes (synchronous — blocks response until done)
            const phScenes = scenes.map(s => ({ chapter_id: s.chapter_id, scene_id: s.scene_id }));
            const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
            log(`[LOAD-VBOOK] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
            try {
                await redis.set(config.BOOK_SCENE_TOTAL(bookId), scenes.length);
                await redis.set(config.BOOK_SCENE_NEXT(bookId), scenes.length);
            } catch (idxErr) {
                console.warn(`[LOAD-VBOOK] Failed to set scene index: ${idxErr.message}`);
            }
        } else {
            // Chunks exist — generate placeholders async for any missing ones
            log(`[LOAD-VBOOK] ${existingChunksAfterLoad.length} chunks exist — async placeholder generation`);
            setImmediate(async () => {
                try {
                    const phScenes = scenes.map(s => ({ chapter_id: s.chapter_id, scene_id: s.scene_id }));
                    const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
                    log(`[LOAD-VBOOK] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                } catch (phErr) {
                    console.warn(`[LOAD-VBOOK] Placeholder audio generation failed: ${phErr.message}`);
                }
            });
        }

        return res.json({
            book_id: bookId,
            build_id: buildId,
            title,
            chapter_count: chapterCount,
            scene_count: sceneCount,
            was_existing: !!existingBook,
        })
    } catch (err) {
        console.error("LOAD-VBOOK ERROR:", err)
        return res.status(400).json({
            error: err.message || "unknown error"
        })
    }
})

// ======================================================
// TXT IMPORT ENDPOINTS
// ======================================================

/**
 * POST /api/v1/book/import-txt
 * Multipart: file=<file.txt>
 *
 * Step 1: Validate TXT + create draft in RAW_IMPORTED state.
 * Does NOT extract characters, locations, or create scenes.
 * Call POST /api/v1/book/{bookId}/bootstrap to complete the import.
 */
app.post("/api/v1/book/import-txt", multer().single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "file missing" })
        }

        const decoded = txtImporter.decodeTxtBuffer(req.file.buffer)
        if (decoded.error) {
            return res.status(400).json({ error: decoded.error })
        }

        const sourceText = decoded.text
        const title = require('path').basename(req.file.originalname, '.txt')
        const draft = lazyBook.createDraftBook(sourceText, lazyBook.SourceType.TXT, title)

        // Store original filename
        const bookDir = lazyBook.getBookDir(draft.bookId)
        const mp = lazyBook.getManifestPath(bookDir)
        const m = JSON.parse(require('fs').readFileSync(mp, 'utf8'))
        m.import_meta.original_filename = req.file.originalname
        require('fs').writeFileSync(mp, JSON.stringify(m, null, 2))

        log(`[IMPORT-TXT] RAW_IMPORTED: ${draft.bookId} (${Buffer.byteLength(sourceText, 'utf8')} bytes)`)

        return res.json({
            book_id: draft.bookId,
            title: title,
            state: lazyBook.BookState.RAW_IMPORTED,
        })
    } catch (err) {
        console.error("IMPORT-TXT ERROR:", err)
        return res.status(400).json({
            error: err.message || "unknown error"
        })
    }
})

/**
 * POST /api/v1/book/{bookId}/bootstrap
 *
 * Step 2: Analyze text, extract characters, locations, narrator,
 * create bible, and build first 3 scenes.
 * Transitions book from RAW_IMPORTED to BOOTSTRAPPED.
 */
app.post("/api/v1/book/:bookId/bootstrap", async (req, res) => {
    try {
        const { bookId } = req.params
        const result = await txtImporter.bootstrapImportedText(bookId)

        // Mark first window as completed in PG (source of truth)
        try {
            const scenesCount = result.scenes || 0;
            await genSessionRepo.markFirstWindowCompleted(bookId, scenesCount);
            log(`[BOOTSTRAP] Marked window 0 completed in PG for ${bookId}`);
        } catch (pgErr) {
            console.warn(`[BOOTSTRAP] Failed to mark window 0 in PG: ${pgErr.message}`);
        }

        log(`[BOOTSTRAP] ${bookId}: ${result.characters} chars, ${result.locations} locs, ${result.scenes} scenes`)

        // Generate placeholder audio for all scenes in the bootstrap result
        if (result.chapter && result.chapter.scenes && result.chapter.scenes.length > 0) {
            setImmediate(async () => {
                try {
                    const buildId = 'default';
                    const scenes = result.chapter.scenes.map(s => ({
                        chapter_id: result.chapter.chapter,
                        scene_id: s.scene_id,
                    }));
                    log(`[BOOTSTRAP] Generating placeholder audio for ${scenes.length} scenes...`);
                    const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, scenes);
                    log(`[BOOTSTRAP] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                } catch (phErr) {
                    console.warn(`[BOOTSTRAP] Placeholder audio generation failed: ${phErr.message}`);
                }
            });
        }

        return res.json({
            book_id: result.bookId,
            title: result.title,
            author: result.author,
            language: result.language,
            state: result.state,
            characters: result.characters,
            locations: result.locations,
            scenes: result.scenes,
            session_id: result.session_id || null,
            total_scenes_found: result.total_scenes_found || null,
            remaining_scenes: result.remaining_scenes || null,
            chapters: result.chapter ? [{
                chapter: result.chapter.chapter,
                chapter_title: result.chapter.chapter_title,
                chapter_index: result.chapter.chapter_index,
                status: result.chapter.status,
                scene_count: result.chapter.scenes ? result.chapter.scenes.length : 0,
            }] : [],
        })
    } catch (err) {
        console.error("BOOTSTRAP ERROR:", err)
        return res.status(400).json({
            error: err.message || "unknown error"
        })
    }
})

/**
 * POST /api/v1/book/{bookId}/bootstrap-next-window
 *
 * Process the next window of scenes (up to 3) from the source text.
 * Uses cached analysis if available, or makes a new AI call.
 * Continues adding scenes to the existing book structure.
 */
app.post("/api/v1/book/:bookId/bootstrap-next-window", async (req, res) => {
    try {
        const { bookId } = req.params
        const result = await txtImporter.bootstrapNextWindow(bookId)

        log(`[BOOTSTRAP-NEXT] ${bookId}: added ${result.added_scenes} scenes, cached=${result.cached}, all_done=${result.all_done}`)

        return res.json(result)
    } catch (err) {
        console.error("BOOTSTRAP-NEXT ERROR:", err)
        return res.status(400).json({
            error: err.message || "unknown error"
        })
    }
})

// ======================================================
// BACKGROUND WINDOW GENERATION — runs async, no chat progress
// ======================================================

async function runBackgroundWindowGeneration(bookId, sessionId) {
    log(`[BG-GEN] Starting background window generation for ${bookId}, session=${sessionId}`);

    try {
        await genSessionRepo.updateSession(sessionId, { status: 'generating' });

        // Silent progress — no chat messages, just log
        const silentProgress = () => {};

        const result = await txtImporter.bootstrapNextWindow(bookId);

        if (result.all_done) {
            await genSessionRepo.updateSession(sessionId, {
                status: 'completed',
                progress_msg: 'All text processed',
            });
            log(`[BG-GEN] ${bookId}: all done after window`);
        } else {
            await genSessionRepo.updateSession(sessionId, {
                status: 'completed',
                progress_msg: `Added ${result.added_scenes} scenes`,});
            log(`[BG-GEN] ${bookId}: completed, added ${result.added_scenes} scenes`);
        }

        // Process the next queued session if any
        const queued = await genSessionRepo.getSessionsByStatus(bookId, 'queued');
        if (queued.length > 0) {
            const nextSession = queued[0];
            log(`[BG-GEN] ${bookId}: processing queued window ${nextSession.window_index}`);
            await genSessionRepo.updateSession(nextSession.id, { status: 'pending' });
            await runBackgroundWindowGeneration(bookId, nextSession.id);
        }
    } catch (err) {
        console.error(`[BG-GEN] ${bookId} FAILED:`, err.message);
        await genSessionRepo.updateSession(sessionId, {
            status: 'failed',
            error: err.message,
        }).catch(() => {});
    }
}

/**
 * POST /api/v1/book/{bookId}/trigger-next-window
 *
 * Called by the frontend when the user activates the last unit of
 * the last scene in the current window.
 *
 * Body: { chapter_id: string, scene_id: string, unit_id: string }
 *
 * Backend validates the position, creates a generation session in PG,
 * spawns background generation, and returns immediately.
 * If a generation is already running, queues the next window.
 * Source of truth: book_generation_sessions table in PostgreSQL.
 */
app.post("/api/v1/book/:bookId/trigger-next-window", async (req, res) => {
    try {
        const { bookId } = req.params;
        const { chapter_id, scene_id, unit_id } = req.body || {};

        if (!bookId) {
            return res.status(400).json({ error: "bookId required" });
        }

        const draft = lazyBook.loadDraftBook(bookId);
        if (!draft || !draft.sourceText) {
            return res.status(404).json({ error: "Book not found" });
        }

        if (draft.manifest.state !== lazyBook.BookState.BOOTSTRAPPED) {
            return res.status(400).json({
                error: "Book not ready for next window, state: " + draft.manifest.state,
            });
        }

        // Validate that the position corresponds to the last scene of the current window
        // If chapter_id/scene_id/unit_id provided, verify they exist in the book
        if (chapter_id && scene_id) {
            const bookData = lazyBook.loadBook(bookId);
            if (bookData) {
                let found = false;
                for (const ch of (bookData.chapters || [])) {
                    if (ch.chapter === chapter_id) {
                        for (const sc of (ch.scenes || [])) {
                            if (sc.scene_id === scene_id) {
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            log(`[TRIGGER] ${bookId}: scene ${scene_id} not in chapter ${chapter_id}, continuing anyway`);
                        }
                        break;
                    }
                }
            }
        }

        // Get next window index from PostgreSQL (source of truth)
        const lastWindow = await genSessionRepo.getHighestCompletedWindow(bookId);
        const nextWindowIndex = lastWindow + 1;

        // Check if we still have source text to process
        const chapters = lazyBook.splitIntoChapters(draft.sourceText);
        if (nextWindowIndex >= chapters.length) {
            return res.json({
                triggered: false,
                error: "No more text to process",
                all_done: true,
            });
        }

        // Check for existing active sessions from PG
        const activeSessions = await genSessionRepo.getSessionsByStatus(bookId, 'generating');
        const pendingSessions = await genSessionRepo.getSessionsByStatus(bookId, 'pending');

        if (activeSessions.length > 0 || pendingSessions.length > 0) {
            // Queue next window
            const queuedSession = await genSessionRepo.createSession(bookId, nextWindowIndex, 3);
            await genSessionRepo.updateSession(queuedSession.id, { status: 'queued' });
            log(`[TRIGGER] ${bookId}: queued window ${nextWindowIndex} (generation already active)`);
            return res.json({
                triggered: false,
                queued: true,
                session_id: queuedSession.id,
                window_index: nextWindowIndex,
            });
        }

        // Create session in PG and spawn background generation
        const session = await genSessionRepo.createSession(bookId, nextWindowIndex, 3);

        // Source offsets for tracking (from chapter structure)
        const chInfo = chapters[nextWindowIndex];
        const sourceOffsetStart = chInfo ? chInfo.startOffset || 0 : 0;
        const sourceOffsetEnd = chInfo ? chInfo.endOffset || 0 : 0;
        await genSessionRepo.updateSession(session.id, {
            source_offset_start: sourceOffsetStart,
            source_offset_end: sourceOffsetEnd,
        });

        // Spawn async background generation (fire and forget, no chat progress)
        setImmediate(() => {
            runBackgroundWindowGeneration(bookId, session.id).catch(err => {
                console.error(`[TRIGGER] Background gen crashed: ${err.message}`);
            });
        });

        log(`[TRIGGER] ${bookId}: started background window ${nextWindowIndex}, session=${session.id} (from PG ${lastWindow})`);

        return res.json({
            triggered: true,
            session_id: session.id,
            window_index: nextWindowIndex,
        });
    } catch (err) {
        console.error("[TRIGGER-NEXT-WINDOW] Error:", err.message);
        return res.status(500).json({ error: err.message });
    }
})

/**
 * GET /api/v1/book/{bookId}/agent-status
 *
 * Get current agent pipeline status for a book being imported.
 * Frontend polls this every 2s during bootstrap.
 */
app.get("/api/v1/book/:bookId/agent-status", async (req, res) => {
    try {
        const { bookId } = req.params
        const result = await storage.postgres.query(`
            SELECT session_id, status as session_status, progress_msg,
                   window_data, knowledge_base, source_type
            FROM agent_sessions
            WHERE book_id = $1
            ORDER BY created_at DESC
            LIMIT 1
        `, [bookId])

        const row = result.rows[0]
        if (!row) {
            return res.json({ active: false, message: "No active agent session" })
        }

        // Parse window_data if present
        let windowData = null
        let windowIndex = null
        let createdScenes = null
        let totalScenes = null
        let remainingCached = null

        if (row.window_data) {
            try {
                windowData = typeof row.window_data === 'string'
                    ? JSON.parse(row.window_data)
                    : row.window_data
                windowIndex = windowData.window_index
                createdScenes = windowData.created_scenes
                totalScenes = windowData.total_scenes
                remainingCached = windowData.remaining_scenes ? windowData.remaining_scenes.length : 0
            } catch (e) {/* ignore */}
        }

        return res.json({
            active: row.session_status === 'running',
            session_id: row.session_id,
            session_status: row.session_status,
            progress_msg: row.progress_msg || 'Working...',
            source_type: row.source_type,
            window_index: windowIndex,
            created_scenes: createdScenes,
            total_scenes: totalScenes,
            remaining_cached: remainingCached,
        })
    } catch (err) {
        console.error("[AGENT-STATUS] Error:", err.message)
        return res.status(500).json({ error: err.message })
    }
})

/**
 * GET /api/v1/book/{bookId}/generation-state
 *
 * Get the background generation state for a book.
 * Frontend polls this to detect new scenes after trigger-next-window.
 * Source of truth: book_generation_sessions table in PostgreSQL.
 * Returns: last completed window, active generation status, errors.
 */
app.get("/api/v1/book/:bookId/generation-state", async (req, res) => {
    try {
        const { bookId } = req.params;
        const state = await genSessionRepo.getGenerationState(bookId);

        // Also get book status for scene count info
        const bookStatus = lazyBook.getBookStatus(bookId);
        const totalChapters = bookStatus?.totalChapters || 0;
        const parsedChapters = bookStatus?.parsedChapters || 0;

        return res.json({
            ...state,
            book_id: bookId,
            total_chapters: totalChapters,
            parsed_chapters: parsedChapters,
            remaining: totalChapters - parsedChapters,
        });
    } catch (err) {
        console.error("[GENERATION-STATE] Error:", err.message);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/book/{bookId}/status
 *
 * Get the current status of a lazy-imported book.
 */
app.get("/api/v1/book/:bookId/status", async (req, res) => {
    try {
        const { bookId } = req.params
        const status = lazyBook.getBookStatus(bookId)

        if (!status) {
            return res.status(404).json({ error: "Book not found" })
        }

        // Add generation state from PG sessions
        const genState = await genSessionRepo.getGenerationState(bookId);

        return res.json({
            ...status,
            generation_status: genState.status,
            last_window_index: genState.last_window_index,
            generation_error: genState.error,
            active_generation: genState.active_status,
        })
    } catch (err) {
        console.error("BOOK STATUS ERROR:", err)
        return res.status(400).json({ error: err.message || "unknown error" })
    }
})

/**
 * GET /api/v1/book/{bookId}/source-chapters
 *
 * Get the detected chapter breakdown from the source text.
 * Returns a list of detected chapters with line ranges.
 */
app.get("/api/v1/book/:bookId/source-chapters", async (req, res) => {
    try {
        const { bookId } = req.params
        const draft = lazyBook.loadDraftBook(bookId)

        if (!draft) {
            return res.status(404).json({ error: "Book not found" })
        }

        if (!draft.sourceText) {
            return res.status(400).json({ error: "Book has no source text" })
        }

        const chapters = lazyBook.splitIntoChapters(draft.sourceText)
        return res.json({ chapters, total: chapters.length })
    } catch (err) {
        console.error("SOURCE-CHAPTERS ERROR:", err)
        return res.status(400).json({ error: err.message || "unknown error" })
    }
})

/**
 * GET /api/v1/book/{bookId}/chapters-summary
 *
 * Get the list of all chapters with their parse status.
 */
app.get("/api/v1/book/:bookId/chapters-summary", async (req, res) => {
    try {
        const { bookId } = req.params
        const summary = txtImporter.getParsedChaptersSummary(bookId)

        if (!summary) {
            return res.status(404).json({ error: "Book not found" })
        }

        return res.json(summary)
    } catch (err) {
        console.error("CHAPTERS SUMMARY ERROR:", err)
        return res.status(400).json({ error: err.message || "unknown error" })
    }
})

/**
 * POST /api/v1/book/{bookId}/lazy-parse
 *
 * Parse the next window of scenes (lazy structuring).
 * Only parses windowSize scenes at a time.
 * Body: { windowSize: number } (optional, default: config.LAZY_WINDOW_SIZE)
 */
app.post("/api/v1/book/:bookId/lazy-parse", async (req, res) => {
    try {
        const { bookId } = req.params
        const windowSize = req.body?.windowSize || config.LAZY_WINDOW_SIZE

        const result = txtImporter.lazyParseNext(bookId, windowSize)

        log(`[LAZY-PARSE] ${bookId}: parsed ${result.parsed} chapters (window ${result.windowStart}-${result.windowEnd}, complete=${result.complete})`)

        // Generate placeholder audio for all scenes (including newly parsed)
        setImmediate(async () => {
            try {
                const buildId = 'default';
                const scenes = await placeholderAudio.getScenesNeedingPlaceholder(bookId);
                log(`[LAZY-PARSE] Checking placeholder audio for ${scenes.length} total scenes...`);
                const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, scenes);
                log(`[LAZY-PARSE] Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
            } catch (phErr) {
                console.warn(`[LAZY-PARSE] Placeholder audio generation failed: ${phErr.message}`);
            }
        });

        return res.json({
            parsed: result.parsed,
            window_start: result.windowStart,
            window_end: result.windowEnd,
            complete: result.complete,
            chapters: result.chapters.map(ch => ({
                chapter: ch.chapter,
                chapter_title: ch.chapter_title,
                chapter_index: ch.chapter_index,
                status: ch.status,
                scene_count: ch.scenes ? ch.scenes.length : 0,
            })),
        })
    } catch (err) {
        console.error("LAZY-PARSE ERROR:", err)
        return res.status(400).json({ error: err.message || "unknown error" })
    }
})

/**
 * POST /api/v1/book/{bookId}/lazy-parse-to
 *
 * Parse a specific chapter (and pre-parse up to windowSize ahead).
 * Body: { chapterIndex: number, windowSize: number }
 */
app.post("/api/v1/book/:bookId/lazy-parse-to", async (req, res) => {
    try {
        const { bookId } = req.params
        const chapterIndex = req.body?.chapterIndex
        const windowSize = req.body?.windowSize || config.LAZY_WINDOW_SIZE

        if (chapterIndex === undefined || chapterIndex === null) {
            return res.status(400).json({ error: "chapterIndex is required" })
        }

        const result = txtImporter.lazyParseToPosition(bookId, chapterIndex, windowSize)

        log(`[LAZY-PARSE-TO] ${bookId}: parsed chapter ${chapterIndex}`)

        return res.json({
            chapter: result.chapter,
            was_existing: result.wasExisting,
            pre_parsed_ahead: result.preParsedAhead || 0,
        })
    } catch (err) {
        console.error("LAZY-PARSE-TO ERROR:", err)
        return res.status(400).json({ error: err.message || "unknown error" })
    }
})

/**
 * POST /api/v1/book/import-text
 *
 * Import text via AI (same mechanism as TXT import).
 * Body: { text: string, title: string }
 */
app.post("/api/v1/book/import-text", async (req, res) => {
    try {
        const { text, title } = req.body

        if (!text) {
            return res.status(400).json({ error: "text is required" })
        }

        // Validate + create draft only (bootstrap is separate call)
        const validation = txtImporter.validateAiText(text)
        if (!validation.valid) {
            return res.status(400).json({ error: validation.errors.join("; ") })
        }

        const draft = lazyBook.createDraftBook(text, lazyBook.SourceType.AI_IMPORT, title || 'Imported Text')

        log(`[IMPORT-TEXT] RAW_IMPORTED: ${draft.bookId} (${Buffer.byteLength(text, 'utf8')} bytes)`)

        return res.json({
            book_id: draft.bookId,
            title: title || 'Imported Text',
            state: lazyBook.BookState.RAW_IMPORTED,
        })
    } catch (err) {
        console.error("IMPORT-TEXT ERROR:", err)
        return res.status(400).json({ error: err.message || "unknown error" })
    }
})

/**
 * GET /api/v1/book/{bookId}/source
 *
 * Get the original source text of a lazy book.
 */
app.get("/api/v1/book/:bookId/source", async (req, res) => {
    try {
        const { bookId } = req.params
        const draft = lazyBook.loadDraftBook(bookId)

        if (!draft || !draft.sourceText) {
            return res.status(404).json({ error: "Source text not found" })
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        return res.send(draft.sourceText)
    } catch (err) {
        console.error("SOURCE ERROR:", err)
        return res.status(400).json({ error: err.message || "unknown error" })
    }
})

app.post("/api/v1/generate", multer().single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "file missing" })
        }

        // LOAD BUNDLE
        const files = book.extractBookBundle(req.file.buffer)
        log("📦 bundle loaded:", Object.keys(files))

        // BUILD BOOK
        const bookData = book.buildBookFromBundle(files)

        const bookId = bookData.manifest.book_id

        // /generate always operates on the whole book
        await genScope.setScope(redis, bookId, layerConfig.SCOPES.WHOLE_BOOK, null, null);

        // If book already exists on disk, keep the edited version
        const existingBook = book.loadBook(bookId)
        if (existingBook) {
            log(`Book ${bookId} already exists — keeping existing (edited) version`)
            const buildId = existingBook.manifest?.build_id || bookData.manifest.build_id || "default"
            const layerCfgBody = {
                audio_enabled: req.body.audio_enabled !== 'false',
                image_enabled: req.body.image_enabled !== 'false',
                video_enabled: req.body.video_enabled !== 'false',
            };
            await layerConfig.set(redis, bookId, layerCfgBody)
            const scenes = book.collectScenes(existingBook)
            const ids = await getAllChunks(bookId)
            if (ids.length === 0) {
                // Redis was cleared — recover chunk metadata from disk or start pipeline
                log(`No chunks in Redis for existing book ${bookId} — recovering from disk`)
                const recovered = await recoverChunksFromDisk(redis, bookId, buildId, scenes)
                if (recovered.length > 0) {
                    log(`Recovered ${recovered.length}/${scenes.length} chunks from disk`)
                    ids.push(...recovered)
                    await redis.set(config.BOOK_SCENE_TOTAL(bookId), scenes.length)
                    await redis.set(config.BOOK_SCENE_NEXT(bookId), recovered.length)
                    if (recovered.length < scenes.length) {
                        log(`Sliding window to process remaining ${scenes.length - recovered.length} scenes`)
                        const windowModule = require('./runtime/scene-window');
                        await windowModule.slideWindow(redis, bookId, existingBook, buildId)
                    }
                } else {
                    log(`No files on disk — starting pipeline for ${scenes.length} scenes`)
                    const windowModule = require('./runtime/scene-window');
                    const started = await windowModule.initSceneWindow(redis, scenes, existingBook, buildId, bookId)
                    log(`Window init: ${started}/${scenes.length} scenes started`)
                    const newIds = await getAllChunks(bookId)
                    ids.push(...newIds)
                }
            }
            if (ids.length === 0) {
                log(`⚠️ Still no chunks after init — waiting 500ms and retrying for ${bookId}`)
                await new Promise(r => setTimeout(r, 500))
                const retry = await getAllChunks(bookId)
                if (retry.length > 0) { log(`✅ Retry found ${retry.length} chunks`); ids.push(...retry) }
            }
            const mode = await detectAvailableMode(redis, bookId)
            return res.json({ book_id: bookId, build_id: buildId, chunk_ids: ids, mode: mode })
        }

        // SAVE BOOK (НА ДИСК)
        await book.resetBook(bookId)
        book.saveBookBundle(bookData, files)

        // RELOAD BOOK (с dir)
        const buildId = bookData.manifest.build_id || "default"
        const loadedBook = book.loadBook(bookId)
        console.log(`[API] Loaded book from disk: ${bookId}, chapters: ${loadedBook.chapters?.length}`);

        // Layer config
        const layerCfgBody = {
            audio_enabled: req.body.audio_enabled !== 'false',
            image_enabled: req.body.image_enabled !== 'false',
            video_enabled: req.body.video_enabled !== 'false',
        };
        await layerConfig.set(redis, bookId, layerCfgBody)
        console.log(`[LAYER] book=${bookId} audio=${layerCfgBody.audio_enabled} image=${layerCfgBody.image_enabled} video=${layerCfgBody.video_enabled}`);

        // SCENES (теперь можно)
        const scenes = book.collectScenes(loadedBook)
        console.log(`[API] Collected ${scenes.length} scenes from book`);
        scenes.forEach(s => console.log(`[API]   Scene: ${s.chapter_id}/${s.scene_id} type=${s.scene_type}`));
        log("📚 chapters:", loadedBook?.chapters?.length || 0)
        log("🎬 scenes total:", scenes.length)

        const ids = await getAllChunks(bookId)
        if (ids.length === 0) {
            // Redis was cleared — recover chunk metadata from files on disk
            log(`No chunks in Redis — recovering from disk for book ${bookId}`)
            const recovered = await recoverChunksFromDisk(redis, bookId, buildId, scenes)
            if (recovered.length > 0) {
                log(`Recovered ${recovered.length}/${scenes.length} chunks from disk`)
                ids.push(...recovered)
                // Mark recovered scenes as started, not all of them
                await redis.set(config.BOOK_SCENE_TOTAL(bookId), scenes.length)
                await redis.set(config.BOOK_SCENE_NEXT(bookId), recovered.length)
                // Slide window to process remaining scenes
                if (recovered.length < scenes.length) {
                    log(`Sliding window to process remaining ${scenes.length - recovered.length} scenes`)
                    const windowModule = require('./runtime/scene-window');
                    await windowModule.slideWindow(redis, bookId, loadedBook, buildId)
                }
            } else {
                // No files on disk either — start pipeline via sliding window
                log(`No files on disk — starting pipeline for ${scenes.length} scenes`)
                const windowModule = require('./runtime/scene-window');
                const started = await windowModule.initSceneWindow(redis, scenes, loadedBook, buildId, bookId)
                log(`Window init: ${started}/${scenes.length} scenes started`)
                // Re-fetch chunks after window init
                const newIds = await getAllChunks(bookId)
                ids.push(...newIds)
            }
        } else {
            // Chunks exist in Redis — mark only existing chunks as started
            log(`Chunks found in Redis: ${ids.length}/${scenes.length}`)
            await redis.set(config.BOOK_SCENE_TOTAL(bookId), scenes.length)
            await redis.set(config.BOOK_SCENE_NEXT(bookId), ids.length)
            // Slide window to process remaining scenes
            if (ids.length < scenes.length) {
                log(`Sliding window to process remaining ${scenes.length - ids.length} scenes`)
                const windowModule = require('./runtime/scene-window');
                await windowModule.slideWindow(redis, bookId, loadedBook, buildId)
            }
        }
        const mode = await detectAvailableMode(redis, bookId)
        return res.json({
            book_id: bookId,
            build_id: buildId,
            chunk_ids: ids,
            mode: mode
        })
    } catch (err) {
        console.error("❌ GENERATE ERROR:", err)
        return res.status(400).json({
            error: err.message || "unknown error"
        })
    }
})

app.get("/api/v1/book/:bookId/chunks", async (req, res) => {
    const allIds = await getAllChunks(req.params.bookId)
    const windowStatus = await getBookWindowStatus(req.params.bookId)
    res.json({ chunk_ids: allIds, total: allIds.length, ...windowStatus })
})

// Generate next batch of scenes (slide window)
app.post("/api/v1/book/:bookId/generate-next", async (req, res) => {
    try {
        const bookId = req.params.bookId
        const loadedBook = book.loadBook(bookId)
        if (!loadedBook) {
            return res.status(404).json({ error: "book not found" })
        }
        // Get build_id from existing chunk or manifest
        const ids = await getAllChunks(bookId)
        let buildId = loadedBook.manifest?.build_id || "default"
        if (ids.length > 0) {
            const firstChunk = await getChunk(ids[0])
            if (firstChunk?.build_id) buildId = firstChunk.build_id
        }
        const windowModule = require('./runtime/scene-window')
        const result = await windowModule.slideWindow(redis, bookId, loadedBook, buildId)
        const newIds = await getAllChunks(bookId)
        res.json({
            started: result.started,
            remaining: result.remaining,
            chunk_ids: newIds
        })
    } catch (err) {
        console.error("❌ GENERATE-NEXT ERROR:", err)
        res.status(500).json({ error: err.message })
    }
})

// VERIFIED: проверяет реальное наличие файлов на диске, а не только флаги в Redis
app.get("/api/v1/chunk/:id", async (req, res) => {
    try {
    const c = await getChunk(req.params.id)
    if (!c) return res.json({ status: "processing" })

    const buildDir = path.join(config.OUTPUT_DIR, c.build_id)

    const audioPath = path.join(buildDir, `${c.book_id}_${c.chapter_id}_${c.scene_id}.mp3`)
    const imagePath = path.join(buildDir, `${c.book_id}_${c.chapter_id}_${c.scene_id}.png`)
    const videoPath = path.join(buildDir, `${c.book_id}_${c.chapter_id}_${c.scene_id}.mp4`)

    // Auto-redispatch if chunk claims audio is ready but file is missing (deleted/expired)
    // BUT: if placeholder audio exists, generate it on-demand and skip redispatch
    if (c.audio && !fs.existsSync(audioPath)) {
        let placeholderOk = false;
        try {
            const phResult = await placeholderAudio.ensurePlaceholderAudio(
                c.build_id || 'default', c.book_id, c.chapter_id, c.scene_id
            );
            placeholderOk = !!phResult && (phResult.created || (phResult.reason === 'already_exists' && phResult.path));
            // Verify file actually exists after ensurePlaceholderAudio
            if (placeholderOk && fs.existsSync(audioPath)) {
                log(`Placeholder audio on-demand for ${req.params.id} — keeping chunk ready`);
                c.audio_status = 'placeholder';
                await redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c));
            } else {
                placeholderOk = false;
            }
        } catch (phErr) {
            log(`Placeholder audio check failed for ${req.params.id}: ${phErr.message}`);
        }

        if (!placeholderOk) {
            log(`Missing audio file for ${req.params.id} — resetting state for redispatch`)
            c.audio = false
            c.audio_status = "pending"
            await redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c))
            if (c.chapter_id && c.scene_id) {
                const stateKey = `animastor:scene-state:${c.book_id}:${c.chapter_id}:${c.scene_id}`
                await redis.set(stateKey, JSON.stringify({
                    state: state.SceneState.AUDIO_PENDING,
                    updated_at: Date.now(),
                    build_id: c.build_id || 'default',
                    error: null
                }))
                // Clear stale GPU hub job key so it can be re-queued
                const jobKey = `animastor:job:${c.book_id}_${c.chapter_id}_${c.scene_id}_0001:audio`
                await redis.del(jobKey)
                await activeScenes.addActiveScene(redis, c.book_id, c.chapter_id, c.scene_id)
            }
        }
    }

    // Reverse: file exists but flag says not ready — update flag from disk
    if (!c.audio && fs.existsSync(audioPath)) {
        log(`Audio file exists for ${req.params.id} — updating flag`)
        c.audio = true
        c.audio_status = "ready"
        await redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c))
        if (c.chapter_id && c.scene_id) {
            const stateKey = `animastor:scene-state:${c.book_id}:${c.chapter_id}:${c.scene_id}`
            const raw = await redis.get(stateKey)
            if (raw) {
                const st = JSON.parse(raw)
                if (st.state !== 'image_ready' && st.state !== 'video_ready') {
                    st.state = 'audio_ready'
                    st.updated_at = Date.now()
                    await redis.set(stateKey, JSON.stringify(st))
                }
            }
        }
    }

    // Auto-redispatch for image similarly
    if (c.image && !fs.existsSync(imagePath)) {
        const iuPrefix = `${c.book_id}_${c.chapter_id}_${c.scene_id}_iu`;
        let hasIuFiles = false;
        try {
            const dirFiles = fs.readdirSync(buildDir);
            hasIuFiles = dirFiles.some(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
        } catch {}
        if (!hasIuFiles) {
            log(`Missing image file for ${req.params.id} — resetting state for redispatch`)
            c.image = false
            c.image_status = "pending"
            await redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c))
            if (c.chapter_id && c.scene_id) {
                const stateKey = `animastor:scene-state:${c.book_id}:${c.chapter_id}:${c.scene_id}`
                await redis.set(stateKey, JSON.stringify({
                    state: state.SceneState.IMAGE_PENDING,
                    updated_at: Date.now(),
                    build_id: c.build_id || 'default',
                    error: null
                }))
                const jobKey = `animastor:job:${c.book_id}_${c.chapter_id}_${c.scene_id}_0002:image`
                await redis.del(jobKey)
                await activeScenes.addActiveScene(redis, c.book_id, c.chapter_id, c.scene_id)
            }
        }
    }

    const audioReady = !!(c.audio || fs.existsSync(audioPath))
    let imageReady = !!c.image
    if (!imageReady && c.chapter_id && c.scene_id) {
        // Primary check: scene state — IMAGE_READY means ALL IUs are done
        const stateKey = `animastor:scene-state:${c.book_id}:${c.chapter_id}:${c.scene_id}`
        const stateRaw = await redis.get(stateKey)
        if (stateRaw) {
            const st = JSON.parse(stateRaw)
            if (st.state === 'image_ready' || st.state === 'video_pending' ||
                st.state === 'video_generating' || st.state === 'video_ready') {
                imageReady = true
                c.image = true
                await redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c))
            }
            // If state says NOT ready — trust it, skip file fallback
        } else {
            // No scene state in Redis — fall back to file checks
            imageReady = fs.existsSync(imagePath)
            if (!imageReady) {
                const iuPrefix = `${c.book_id}_${c.chapter_id}_${c.scene_id}_iu`;
                try {
                    const dirFiles = fs.readdirSync(buildDir);
                    imageReady = dirFiles.some(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                } catch {}
            }
        }
    }
    const videoReady = !!(c.video && fs.existsSync(videoPath))
    const allReady = audioReady

    res.json({
        status: allReady ? "ready" : "processing",
        image_ready: imageReady,
        audio_ready: audioReady,
        video_ready: videoReady,
        video_status: c.video_status || "pending",
    })
    } catch (err) {
        console.error("❌ CHUNK STATUS ERROR:", err.message);
        res.status(500).json({ error: "Internal error fetching chunk status" });
    }
})

// ======================================================
// STORYBOARD — scene audio + IU metadata for a chunk
// ======================================================

app.get("/api/v1/chunk/:id/storyboard", async (req, res) => {
    try {
        const { id } = req.params;
        const c = await getChunk(id);
        if (!c) return res.status(404).json({ error: "chunk not found" });

        const { build_id, book_id, chapter_id, scene_id } = c;
        const dir = path.join(config.OUTPUT_DIR, build_id);
        if (!fs.existsSync(dir)) return res.status(404).json({ error: "build directory not found" });

        // IU metadata — try PG first, fall back to book data
        let ius = [];
        try {
            const pgRows = await iuRepo.getImageUnitsForScene(build_id, book_id, chapter_id, scene_id);
            if (pgRows && pgRows.length > 0) {
                ius = pgRows.map(r => ({
                    unit_id: r.unit_id,
                    scene_id: r.scene_id,
                    text: r.text,
                    text_proportion: r.text_proportion,
                    estimated_duration_sec: r.estimated_duration_sec,
                    audio_file: r.scene_audio_file,
                    start_ms: r.start_ms != null && (Number(r.start_ms) || 0) > 0 ? Number(r.start_ms) : null,
                    end_ms: r.end_ms != null && (Number(r.end_ms) || 0) > 0 ? Number(r.end_ms) : null
                }));
            }
        } catch (dbErr) {
            console.warn('[STORYBOARD] PG read failed, falling back to book data:', dbErr.message);
        }

        if (ius.length === 0) {
            try {
                const b = book.loadBook(book_id);
                if (b) {
                    for (const ch of b.chapters || []) {
                        if (ch.chapter !== chapter_id) continue;
                        for (const sc of ch.scenes || []) {
                            if (sc.scene_id !== scene_id) continue;
                            let order = 0;
                            for (const u of sc.units || []) {
                                ius.push({
                                    unit_id: u.id,
                                    scene_id,
                                    text: u.text,
                                    text_proportion: 0,
                                    estimated_duration_sec: 0,
                                    audio_file: null,
                                    start_ms: null,
                                    end_ms: null,
                                    _order: order
                                });
                                order++;
                            }
                            for (const db of sc.dialogue_blocks || []) {
                                for (const u of db.units || []) {
                                    ius.push({
                                        unit_id: u.id,
                                        scene_id,
                                        text: u.text,
                                        text_proportion: 0,
                                        estimated_duration_sec: 0,
                                        audio_file: null,
                                        start_ms: null,
                                        end_ms: null,
                                        _order: order
                                    });
                                    order++;
                                }
                            }
                            const totalTextLen = ius.reduce((s, i) => s + (i.text || '').length, 0);
                            ius.sort((a, b) => a._order - b._order);
                            for (const iu of ius) {
                                iu.text_proportion = totalTextLen > 0 ? (iu.text || '').length / totalTextLen : 1;
                                delete iu._order;
                                delete iu._text;
                            }
                            break;
                        }
                    }
                }
            } catch (bookErr) {
                console.warn('[STORYBOARD] Book data fallback failed:', bookErr.message);
            }
        }

        // Compute estimated durations from scene audio when PG data is missing,
        // and persist computed IU data to PG so subsequent reads skip the fallback.
        const needsDuration = ius.every(iu => !iu.estimated_duration_sec || iu.estimated_duration_sec === 0);
        if (needsDuration && ius.length > 0) {
            const sceneDuration = await image.getSceneDuration(build_id, book_id, chapter_id, scene_id);
            if (sceneDuration > 0) {
                for (const iu of ius) {
                    iu.estimated_duration_sec = parseFloat((sceneDuration * (iu.text_proportion || 0)).toFixed(3));
                }
            }
            for (const [idx, iu] of ius.entries()) {
                try {
                    await iuRepo.upsertImageUnit(build_id, book_id, chapter_id, scene_id, iu.unit_id, {
                        scene_order: idx,
                        text: iu.text,
                        text_length: (iu.text || '').length,
                        text_proportion: iu.text_proportion || 0,
                        scene_duration_sec: sceneDuration || 0,
                        estimated_duration_sec: iu.estimated_duration_sec || 0,
                        scene_audio_file: `${book_id}_${chapter_id}_${scene_id}.mp3`,
                        start_ms: null,
                        end_ms: null,
                    });
                } catch (pgErr) {
                    console.warn('[STORYBOARD] Failed to persist IU to PG:', pgErr.message);
                }
            }
        }

        // Merge DB timing overrides (start_ms/end_ms) into IU items
        try {
            const pgRows = await iuRepo.getImageUnitsForScene(build_id, book_id, chapter_id, scene_id);
            if (pgRows && pgRows.length > 0) {
                const pgMap = {};
                for (const r of pgRows) {
                    if ((r.start_ms || 0) > 0 || (r.end_ms || 0) > 0) {
                        pgMap[r.unit_id] = r;
                    }
                }
                for (const iu of ius) {
                    const pg = pgMap[iu.unit_id];
                    if (pg) {
                        iu.start_ms = pg.start_ms;
                        iu.end_ms = pg.end_ms;
                    }
                }
            }
        } catch (dbErr) {
            console.warn('[STORYBOARD] DB timing merge failed:', dbErr.message);
        }

        res.json({
            chunk_id: id,
            book_id,
            chapter_id,
            scene_id,
            build_id,
            ius
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/iu-image/:bookId/:chapterId/:sceneId/:iuId", async (req, res) => {
    try {
        const { bookId, chapterId, sceneId, iuId } = req.params;
        const buildId = req.query.build_id;
        if (!buildId) return res.status(400).json({ error: "build_id query param required" });
        const imagePath = path.join(config.OUTPUT_DIR, buildId, `${bookId}_${chapterId}_${sceneId}_${iuId}.png`);
        if (!fs.existsSync(imagePath)) return res.status(404).json({ error: "IU image not found" });
        res.setHeader("Content-Type", "image/png");
        fs.createReadStream(imagePath).pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/preview/:bookId/:chapterId/:sceneId/:iuId", async (req, res) => {
    try {
        const { bookId, chapterId, sceneId, iuId } = req.params;
        const buildId = req.query.build_id;
        if (!buildId) return res.status(400).json({ error: "build_id query param required" });
        const result = await image.getOrCreatePreview(bookId, chapterId, sceneId, iuId, buildId);
        if (!result) return res.status(404).json({ error: "IU image not found, cannot generate preview" });
        res.setHeader("Content-Type", "image/png");
        res.setHeader("X-Preview-Created", String(result.created));
        fs.createReadStream(result.path).pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// WORKER HEARTBEAT — workers ping to signal availability
// ======================================================
app.post("/api/v1/worker/heartbeat", async (req, res) => {
    try {
        const workerHealth = require('./runtime/worker-health');
        const { type, worker_id } = req.body || {};

        if (!type || !worker_id) {
            return res.status(400).json({ error: "type and worker_id required" });
        }
        if (!config.WORKER_HEARTBEAT_TYPES.includes(type)) {
            return res.status(400).json({ error: `invalid type, must be one of: ${config.WORKER_HEARTBEAT_TYPES.join(', ')}` });
        }

        await workerHealth.reportHeartbeat(redis, type, worker_id);
        res.json({ ok: true, type, worker_id, ttl: config.WORKER_HEARTBEAT_TTL });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
})

app.get("/api/v1/worker/status", async (req, res) => {
    try {
        const workerHealth = require('./runtime/worker-health');
        const status = await workerHealth.getStatus(redis);
        res.json({ workers: status, heartbeat_ttl_sec: config.WORKER_HEARTBEAT_TTL });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
})

app.get("/api/v1/worker/counts", async (req, res) => {
    try {
        const workerHealth = require('./runtime/worker-health');
        const status = await workerHealth.getStatus(redis);
        const activeAudio = parseInt(await redis.get('animastor:runtime:active-audio') || '0', 10);
        const activeImage = parseInt(await redis.get('animastor:runtime:active-image') || '0', 10);
        const activeVideo = parseInt(await redis.get('animastor:runtime:active-video') || '0', 10);
        // Also check 3s debounce keys set by dispatch-engine on acquire/release
        const debounceAudio = parseInt(await redis.get('animastor:runtime:last-active:audio') || '0', 10);
        const debounceImage = parseInt(await redis.get('animastor:runtime:last-active:image') || '0', 10);
        const debounceVideo = parseInt(await redis.get('animastor:runtime:last-active:video') || '0', 10);
        res.json({
            audio: status.audio || 0,
            image: status.image || 0,
            video: status.video || 0,
            active_audio: status.audio > 0 ? (activeAudio || debounceAudio) : 0,
            active_image: status.image > 0 ? (activeImage || debounceImage) : 0,
            active_video: status.video > 0 ? (activeVideo || debounceVideo) : 0
        });
    } catch (err) {
        res.json({ audio: 0, image: 0, video: 0, active_audio: 0, active_image: 0, active_video: 0 });
    }
})

// Media serving endpoints for Android client
// Files are on disk at OUTPUT_DIR/buildId/bookId_chapterId_sceneId.{ext}
app.get("/api/v1/chunk/:id/audio", async (req, res) => {
    try {
        const c = await getChunk(req.params.id)
        if (!c) return res.status(404).json({ error: "chunk not found" })
        const audioPath = path.join(config.OUTPUT_DIR, c.build_id, `${c.book_id}_${c.chapter_id}_${c.scene_id}.mp3`)
        if (!fs.existsSync(audioPath)) return res.status(404).json({ error: "audio not ready" })
        res.setHeader("Content-Type", "audio/mpeg")
        fs.createReadStream(audioPath).pipe(res)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get("/api/v1/chunk/:id/image", async (req, res) => {
    const c = await getChunk(req.params.id);
    if (!c) return res.status(404).json({ error: "chunk not found" });
    if (!c.image) return res.status(404).json({ error: "image not ready" });
    const dir = path.join(config.OUTPUT_DIR, c.build_id);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: "build directory not found" });
    const files = fs.readdirSync(dir).filter(f => f.startsWith(`${c.book_id}_${c.chapter_id}_${c.scene_id}`) && f.endsWith('.png'));
    if (!files.length) return res.status(404).json({ error: "no image files" });
    const filePath = path.join(dir, files[0]);
    res.setHeader("Content-Type", "image/png");
    fs.createReadStream(filePath).pipe(res);
});

app.get("/api/v1/chunk/:id/video", async (req, res) => {
    try {
        const c = await getChunk(req.params.id);
        if (!c) return res.status(404).json({ error: "chunk not found" });
        const dir = path.join(config.OUTPUT_DIR, c.build_id);
        if (!fs.existsSync(dir)) return res.status(404).json({ error: "build directory not found" });
        const prefix = `${c.book_id}_${c.chapter_id}_${c.scene_id}`;
        const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.mp4'));
        if (!files.length) return res.status(404).json({ error: "video not ready" });
        const filePath = path.join(dir, files[0]);
        res.setHeader("Content-Type", "video/mp4");
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// AUDIO TIMELINE — Waveform, IU timings, scene audio
// ======================================================

const { computeWaveform } = require('./services/waveform-service');
const iuRepo = require('./storage/postgres/repositories/iu-repo');

// Serve scene audio file directly (by book/chapter/scene)
app.get("/api/v1/scene/:bookId/:chapterId/:sceneId/audio", async (req, res) => {
    try {
        const { bookId, chapterId, sceneId } = req.params;
        const buildId = req.query.build_id;
        if (!buildId) return res.status(400).json({ error: "build_id query param required" });
        const audioPath = getSceneAudioPath(buildId, bookId, chapterId, sceneId);
        if (!fs.existsSync(audioPath)) return res.status(404).json({ error: "audio not ready" });
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Accept-Ranges", "bytes");
        fs.createReadStream(audioPath).pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Return waveform peak data for a scene
app.get("/api/v1/scene/:bookId/:chapterId/:sceneId/waveform", async (req, res) => {
    try {
        const { bookId, chapterId, sceneId } = req.params;
        const buildId = req.query.build_id;
        if (!buildId) return res.status(400).json({ error: "build_id query param required" });
        const audioPath = getSceneAudioPath(buildId, bookId, chapterId, sceneId);
        if (!fs.existsSync(audioPath)) return res.status(404).json({ error: "audio not ready" });
        const peaks = await computeWaveform(audioPath);
        const duration = await image.getSceneDuration(buildId, bookId, chapterId, sceneId);
        res.json({ peaks, duration_sec: Math.round(duration * 1000) / 1000, peak_count: peaks.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Return IU timing boundaries for a scene
app.get("/api/v1/scene/:bookId/:chapterId/:sceneId/timings", async (req, res) => {
    try {
        const { bookId, chapterId, sceneId } = req.params;
        const buildId = req.query.build_id;
        if (!buildId) return res.status(400).json({ error: "build_id query param required" });

        // IU timings — try PG first, fall back to book data
        let ius = [];
        try {
            const pgRows = await iuRepo.getImageUnitsForScene(buildId, bookId, chapterId, sceneId);
            if (pgRows && pgRows.length > 0) {
                ius = pgRows.map(r => ({
                    unit_id: r.unit_id,
                    scene_order: r.scene_order || 0,
                    start_ms: r.start_ms != null && (Number(r.start_ms) || 0) > 0 ? Number(r.start_ms) : null,
                    end_ms: r.end_ms != null && (Number(r.end_ms) || 0) > 0 ? Number(r.end_ms) : null,
                    estimated_duration_sec: r.estimated_duration_sec || 0,
                    text_proportion: r.text_proportion || 0
                }));
            }
        } catch (dbErr) {
            console.warn('[TIMINGS] PG read failed, falling back to book data:', dbErr.message);
        }

        if (ius.length === 0) {
            try {
                const b = book.loadBook(bookId);
                if (b) {
                    for (const ch of b.chapters || []) {
                        if (ch.chapter !== chapterId) continue;
                        for (const sc of ch.scenes || []) {
                            if (sc.scene_id !== sceneId) continue;
                            let order = 0;
                            for (const u of sc.units || []) {
                                ius.push({
                                    unit_id: u.id,
                                    scene_order: order,
                                    start_ms: null,
                                    end_ms: null,
                                    estimated_duration_sec: 0,
                                    text_proportion: 0,
                                    _text: u.text || ''
                                });
                                order++;
                            }
                            for (const db of sc.dialogue_blocks || []) {
                                for (const u of db.units || []) {
                                    ius.push({
                                        unit_id: u.id,
                                        scene_order: order,
                                        start_ms: null,
                                        end_ms: null,
                                        estimated_duration_sec: 0,
                                        text_proportion: 0,
                                        _text: u.text || ''
                                    });
                                    order++;
                                }
                            }
                            const totalTextLen = ius.reduce((s, i) => s + i._text.length, 0);
                            for (const iu of ius) {
                                iu.text_proportion = totalTextLen > 0 ? iu._text.length / totalTextLen : 1;
                                delete iu._order;
                                delete iu._text;
                            }
                            break;
                        }
                    }
                }
            } catch (bookErr) {
                console.warn('[TIMINGS] Book data fallback failed:', bookErr.message);
            }
        }

        if (ius.length === 0) return res.json({ units: [], total_duration_ms: 0 });

        // Get scene audio duration for clamping boundaries
        const sceneDuration = await image.getSceneDuration(buildId, bookId, chapterId, sceneId);
        const sceneDurationMs = Math.round(sceneDuration * 1000);

        // Compute estimated durations from scene audio when PG data is missing
        const needsDuration = ius.every(iu => !iu.estimated_duration_sec || iu.estimated_duration_sec === 0);
        if (needsDuration && ius.length > 0) {
            if (sceneDuration > 0) {
                for (const iu of ius) {
                    iu.estimated_duration_sec = parseFloat((sceneDuration * (iu.text_proportion || 0)).toFixed(3));
                }
            }
        }

        ius.sort((a, b) => a.scene_order - b.scene_order);

        let cursorMs = 0;
        const units = ius.map(iu => {
            if (iu.start_ms != null && iu.end_ms != null) {
                cursorMs = iu.end_ms;
                const clampedEndMs = sceneDurationMs > 0 ? Math.min(iu.end_ms, sceneDurationMs) : iu.end_ms;
                return {
                    unit_id: iu.unit_id, scene_order: iu.scene_order,
                    start_ms: iu.start_ms, end_ms: clampedEndMs,
                    estimated_duration_sec: iu.estimated_duration_sec,
                    text_proportion: iu.text_proportion
                };
            }
            const durMs = Math.max(200, Math.round((iu.estimated_duration_sec || 1) * 1000));
            const start = cursorMs;
            let end = cursorMs + durMs;
            if (sceneDurationMs > 0 && end > sceneDurationMs) {
                end = sceneDurationMs;
            }
            cursorMs = end;
            return {
                unit_id: iu.unit_id, scene_order: iu.scene_order,
                start_ms: start, end_ms: end,
                estimated_duration_sec: iu.estimated_duration_sec || 0,
                text_proportion: iu.text_proportion || 0
            };
        });

        const totalMs = units.reduce((sum, u) => sum + (u.end_ms - u.start_ms), 0);
        res.json({ units, total_duration_ms: totalMs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update IU timing boundaries (receive boundaries list, recalculate neighbors)
app.put("/api/v1/scene/:bookId/:chapterId/:sceneId/timings", async (req, res) => {
    try {
        const { bookId, chapterId, sceneId } = req.params;
        const { build_id, units } = req.body || {};
        if (!build_id) return res.status(400).json({ error: "build_id required" });
        if (!units || !Array.isArray(units)) return res.status(400).json({ error: "units array required" });

        const rows = await iuRepo.getImageUnitsForScene(build_id, bookId, chapterId, sceneId);
        const existingMap = {};
        for (const r of rows) {
            existingMap[r.unit_id] = r;
        }

        // Sort incoming units by DB scene_order to preserve logical order
        const sorted = [...units].sort((a, b) => {
            const orderA = existingMap[a.unit_id]?.scene_order ?? 0;
            const orderB = existingMap[b.unit_id]?.scene_order ?? 0;
            return orderA - orderB;
        });

        // Get scene audio duration for clamping
        const sceneDuration = await image.getSceneDuration(build_id, bookId, chapterId, sceneId);
        const sceneDurationMs = Math.round(sceneDuration * 1000);

        // Propagate changes forward: walk through in order, ensure no overlaps
        // and shift subsequent units when a unit expands.
        const recalculated = [];
        let cursorMs = 0;

        for (const unit of sorted) {
            const preferredStart = unit.start_ms;
            const preferredEnd = unit.end_ms;

            // No overlap with previous: start cannot be before cursor
            const startMs = Math.max(preferredStart, cursorMs);

            // Enforce minimum 50ms duration, clamp to scene duration
            let endMs = Math.max(startMs + 50, preferredEnd);
            if (sceneDurationMs > 0 && endMs > sceneDurationMs) {
                endMs = sceneDurationMs;
            }

            recalculated.push({
                unit_id: unit.unit_id,
                start_ms: startMs,
                end_ms: endMs
            });

            cursorMs = endMs;
        }

        // Write to DB
        for (const u of recalculated) {
            await iuRepo.upsertIuTiming(build_id, bookId, chapterId, sceneId, u.unit_id, u.start_ms, u.end_ms);
        }

        res.json({ units: recalculated, recalculated: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// AI CHAT — Proxy to NVIDIA (or any OpenAI-compatible API)
// ======================================================

const AI_PROFILE_PATH = process.env.AI_PROFILE_PATH || '/data/ai-assistant-profile.md';
const AI_API_BASE_URL = process.env.AI_API_BASE_URL || 'https://integrate.api.nvidia.com/v1';

/**
 * Read the AI assistant profile file and extract the system prompt.
 * Falls back to a built-in prompt if file not found.
 */
function loadSystemPrompt() {
    try {
        if (fs.existsSync(AI_PROFILE_PATH)) {
            return fs.readFileSync(AI_PROFILE_PATH, 'utf-8').trim();
        }
    } catch (_) { /* ignore */ }
    return `# AI Assistant Profile: Анимастор

## Identity
Ты — **Анимастор**, умный помощник для создания интерактивных историй и книг на платформе Animastor.

## Mission
Ты помогаешь пользователям создавать, редактировать и публиковать мультимедийные книги.

## Capabilities
- Помогаешь придумывать сюжеты, персонажей, диалоги и сценарии
- Разбиваешь текст на сцены, главы, описываешь визуальные и аудио-элементы
- Объясняешь формат .vbook и процесс генерации
- Отвечаешь на вопросы по платформе
- Предлагаешь креативные идеи

## Rules
- Всегда представляешься как Анимастор
- Не выдаёшь себя за человека
- Отвечаешь на том же языке, на котором к тебе обратились
- Если вопрос вне твоей компетенции — честно говоришь об этом`;
}

const systemPrompt = loadSystemPrompt();

/**
 * Build book context — full book JSON for AI to read and edit.
 */
function buildBookContext(bookData) {
    if (!bookData) return '';
    const isLocked = bookData.manifest?.locked === true;
    const lines = [];
    lines.push(`Locked: ${isLocked}`);
    lines.push('');
    lines.push('Below is the full book JSON data. Read it, modify it as needed, and return the full changed version in your response.');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(bookData, null, 2));
    lines.push('```');
    return lines.join('\n');
}

// ======================================================
// G.3 — Mode-specific tool definitions
// ======================================================

const EDIT_BOOK_TOOL = {
    type: "function",
    function: {
        name: "edit_book",
        description: "Apply changes to the current book. Call this when the user asks to edit the book content (title, author, characters, scenes, text, etc.). Do NOT call if the book is locked.",
        parameters: {
            type: "object",
            properties: {
                patches: {
                    type: "array",
                    description: "List of JSON Patch operations",
                    items: {
                        type: "object",
                        properties: {
                            op: {
                                type: "string",
                                enum: ["replace", "add", "remove"],
                                description: "Operation type"
                            },
                            path: {
                                type: "string",
                                description: "JSON path like /book/title, /chapters/0/scenes/1/units/0/text"
                            },
                            value: {
                                description: "New value (for replace/add)"
                            }
                        },
                        required: ["op", "path"]
                    }
                }
            },
            required: ["patches"]
        }
    }
};

const STORYBOARD_TOOL = {
    type: "function",
    function: {
        name: "write_storyboard",
        description: "Write storyboard elements for a scene. Use this in Director mode to set camera angles, composition, lighting, and transitions for each unit.",
        parameters: {
            type: "object",
            properties: {
                scene_id: {
                    type: "string",
                    description: "The scene id to update"
                },
                elements: {
                    type: "array",
                    description: "List of storyboard elements, one per unit",
                    items: {
                        type: "object",
                        properties: {
                            unit_id: {
                                type: "string",
                                description: "Unit id within the scene"
                            },
                            camera_angle: {
                                type: "string",
                                enum: ["wide", "medium", "closeup", "birds_eye", "low_angle", "dutch"],
                                description: "Camera angle for this unit"
                            },
                            composition: {
                                type: "string",
                                description: "Visual composition description"
                            },
                            lighting: {
                                type: "string",
                                description: "Lighting description for this unit"
                            },
                            background: {
                                type: "string",
                                description: "Background / environment description"
                            },
                            transition: {
                                type: "string",
                                enum: ["cut", "fade", "dissolve", "wipe"],
                                description: "Transition from previous unit"
                            }
                        },
                        required: ["unit_id", "camera_angle"]
                    }
                }
            },
            required: ["scene_id", "elements"]
        }
    }
};

const IMPORT_BOOK_TOOL = {
    type: "function",
    function: {
        name: "import_book",
        description: "Import arbitrary text into the book structure. Creates or extends the book with auto-detected chapters, scenes, and units. Call this in Import mode when the user provides raw text to convert into book structure.",
        parameters: {
            type: "object",
            properties: {
                book: {
                    type: "object",
                    description: "Complete book JSON with manifest, metadata, chapters (each with scenes and units), characters, and locations",
                    properties: {
                        manifest: {
                            type: "object",
                            description: "Book manifest with version and timestamps"
                        },
                        metadata: {
                            type: "object",
                            description: "Book metadata: title, author, description, language"
                        },
                        chapters: {
                            type: "array",
                            description: "Array of chapters, each containing scenes with units",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string", description: "snake_case chapter id" },
                                    title: { type: "string" },
                                    chapter_index: { type: "integer" },
                                    scenes: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            properties: {
                                                id: { type: "string" },
                                                title: { type: "string" },
                                                scene_index: { type: "integer" },
                                                characters_present: { type: "array", items: { type: "string" } },
                                                units: {
                                                    type: "array",
                                                    items: {
                                                        type: "object",
                                                        properties: {
                                                            id: { type: "string" },
                                                            text: { type: "string" }
                                                        },
                                                        required: ["id", "text"]
                                                    }
                                                }
                                            },
                                            required: ["id", "title", "scene_index", "units"]
                                        }
                                    }
                                },
                                required: ["id", "title", "chapter_index", "scenes"]
                            }
                        },
                        characters: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    name: { type: "string" },
                                    role: { type: "string", enum: ["protagonist", "antagonist", "supporting", "minor"] },
                                    description: { type: "string" },
                                    traits: { type: "array", items: { type: "string" } }
                                },
                                required: ["id", "name"]
                            }
                        },
                        locations: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    name: { type: "string" },
                                    type: { type: "string", enum: ["indoor", "outdoor", "abstract"] },
                                    description: { type: "string" }
                                },
                                required: ["id", "name"]
                            }
                        }
                    },
                    required: ["manifest", "metadata", "chapters"]
                },
                action: {
                    type: "string",
                    enum: ["new_book", "new_chapter", "extend_chapter", "extend_scene"],
                    description: "What to do with the imported structure: 'new_book' if no book exists, 'new_chapter' if adding a new chapter, 'extend_chapter' if continuing current chapter, 'extend_scene' if expanding current scene"
                },
                chapter_id: {
                    type: "string",
                    description: "If extending an existing chapter, the chapter id to extend"
                },
                scene_id: {
                    type: "string",
                    description: "If extending an existing scene, the scene id to extend"
                }
            },
            required: ["book", "action"]
        }
    }
};

const EXTRACTION_TOOL = {
    type: "function",
    function: {
        name: "extract_entities",
        description: "Extract structured entities from text. Returns characters, locations, objects, relationships, and facts in JSON format.",
        parameters: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "The raw text to analyze"
                },
                entities: {
                    type: "object",
                    description: "Extracted entities will be placed here",
                    properties: {
                        characters: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: { type: "string" },
                                    role: { type: "string", enum: ["protagonist", "antagonist", "supporting", "minor"] },
                                    description: { type: "string" },
                                    traits: { type: "array", items: { type: "string" } }
                                },
                                required: ["name"]
                            }
                        },
                        locations: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: { type: "string" },
                                    type: { type: "string", enum: ["indoor", "outdoor", "abstract"] },
                                    description: { type: "string" }
                                },
                                required: ["name"]
                            }
                        },
                        objects: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: { type: "string" },
                                    type: { type: "string" },
                                    description: { type: "string" }
                                },
                                required: ["name"]
                            }
                        },
                        relationships: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    source: { type: "string" },
                                    target: { type: "string" },
                                    type: { type: "string", enum: ["family", "friend", "enemy", "ally", "love", "neutral", "unknown"] },
                                    description: { type: "string" }
                                },
                                required: ["source", "target", "type"]
                            }
                        },
                        facts: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    fact: { type: "string" },
                                    category: { type: "string", enum: ["plot", "character", "location", "lore", "event"] },
                                    confidence: { type: "number", minimum: 0, maximum: 1 }
                                },
                                required: ["fact", "category"]
                            }
                        }
                    }
                }
            },
            required: ["text", "entities"]
        }
    }
};

const VALIDATION_TOOL = {
    type: "function",
    function: {
        name: "validate_book",
        description: "Validate book JSON for correctness, completeness, and integrity. Returns a list of violations with severity levels.",
        parameters: {
            type: "object",
            properties: {
                checks: {
                    type: "object",
                    description: "Results of validation checks",
                    properties: {
                        violations: {
                            type: "array",
                            description: "List of violations found",
                            items: {
                                type: "object",
                                properties: {
                                    severity: {
                                        type: "string",
                                        enum: ["error", "warning", "info"],
                                        description: "Severity level"
                                    },
                                    path: {
                                        type: "string",
                                        description: "JSON path to the issue"
                                    },
                                    message: {
                                        type: "string",
                                        description: "Human-readable description"
                                    },
                                    rule: {
                                        type: "string",
                                        description: "Rule that was violated"
                                    }
                                },
                                required: ["severity", "path", "message"]
                            }
                        },
                        summary: {
                            type: "object",
                            properties: {
                                total: { type: "integer" },
                                errors: { type: "integer" },
                                warnings: { type: "integer" },
                                info: { type: "integer" }
                            }
                        }
                    }
                }
            },
            required: ["checks"]
        }
    }
};

function getToolsForMode(mode, bookId, isLocked) {
    if (!bookId || isLocked) return [];
    switch (mode) {
        case 'edit': return [EDIT_BOOK_TOOL];
        case 'director': return [STORYBOARD_TOOL];
        case 'extraction': return [EXTRACTION_TOOL];
        case 'validation': return [VALIDATION_TOOL];
        case 'import': return [IMPORT_BOOK_TOOL];
        default: return [];
    }
}

/**
 * Extract patches from AI response.
 * Looks for \`\`\`patches ... \`\`\` block (NOT \`\`\`json).
 * Returns { reply: string, patches: Array|null }
 */
function parseAIResponse(text) {
    const blockRegex = /```patches\s*\n?([\s\S]*?)\n?\s*```/;
    const match = text.match(blockRegex);
    if (!match) return { reply: text.trim(), patches: null };

    let patches = null;
    try {
        const parsed = JSON.parse(match[1].trim());
        patches = parsed.patches || null;
    } catch (_) {
        return { reply: text.trim(), patches: null };
    }

    const reply = text.replace(match[0], '').trim();
    return { reply, patches };
}

/**
 * Resolve a JSON path (e.g. "/chapters/0/scenes/1/units/2/text") to a value and parent.
 * Returns { parent, key, value } or null.
 */
function resolvePath(obj, path) {
    if (!path || !path.startsWith('/')) return null;
    const parts = path.slice(1).split('/');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (current == null || typeof current !== 'object') return null;
        const idx = isNaN(Number(key)) ? key : Number(key);
        current = current[idx];
        if (current === undefined) return null;
    }
    const lastKey = parts[parts.length - 1];
    const idx = isNaN(Number(lastKey)) ? lastKey : Number(lastKey);
    return {
        parent: current,
        key: idx,
        value: current != null ? current[idx] : undefined
    };
}

/**
 * Apply JSON Patch operations to an object (simplified RFC 6902).
 * Supports: replace, add, remove.
 */
function applyPatches(obj, patches) {
    if (!Array.isArray(patches)) return { ok: false, error: 'patches must be an array' };

    for (const p of patches) {
        const { op, path, value } = p;
        if (!op || !path) {
            return { ok: false, error: `patch missing op or path: ${JSON.stringify(p)}` };
        }

        // Handle "-" for array append (e.g. "/chapters/0/scenes/-")
        if (op === 'add' && path.endsWith('/-')) {
            const parentPath = path.slice(0, -2);
            const resolved = resolvePath(obj, parentPath);
            if (!resolved || !Array.isArray(resolved.value)) {
                return { ok: false, error: `cannot add to non-array: ${parentPath}` };
            }
            resolved.value.push(value);
            continue;
        }

        const resolved = resolvePath(obj, path);
        if (!resolved) {
            return { ok: false, error: `cannot resolve path: ${path}` };
        }

        switch (op) {
            case 'replace':
                resolved.parent[resolved.key] = value;
                break;
            case 'add':
                if (Array.isArray(resolved.parent)) {
                    resolved.parent.splice(resolved.key, 0, value);
                } else {
                    resolved.parent[resolved.key] = value;
                }
                break;
            case 'remove':
                if (Array.isArray(resolved.parent)) {
                    resolved.parent.splice(resolved.key, 1);
                } else {
                    delete resolved.parent[resolved.key];
                }
                break;
            default:
                return { ok: false, error: `unsupported op: ${op}` };
        }
    }

    return { ok: true };
}

// ======================================================
// AI CHAT SESSIONS — CRUD
// ======================================================

app.get("/api/v1/ai/sessions", async (req, res) => {
    try {
        const { bookId } = req.query;
        if (!bookId) return res.status(400).json({ error: "bookId required" });
        const sessions = await storage.chatStore.listSessions(bookId);
        res.json({ sessions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/v1/ai/sessions", async (req, res) => {
    try {
        const { bookId, title, topicId, mode } = req.body;
        if (!bookId) return res.status(400).json({ error: "bookId required" });
        const session = await storage.chatStore.createSession(bookId, { title, topicId, mode });
        res.json({ session });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/ai/sessions/:sessionId", async (req, res) => {
    try {
        const session = await storage.chatStore.getSession(req.params.sessionId);
        if (!session) return res.status(404).json({ error: "session not found" });
        res.json({ session });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch("/api/v1/ai/sessions/:sessionId", async (req, res) => {
    try {
        const { title, topicId, mode } = req.body;
        const updates = {};
        if (title !== undefined) updates.title = title;
        if (topicId !== undefined) updates.topicId = topicId;
        if (mode !== undefined) updates.mode = mode;
        const session = await storage.chatStore.updateSession(req.params.sessionId, updates);
        if (!session) return res.status(404).json({ error: "session not found" });
        res.json({ session });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/v1/ai/sessions/:sessionId", async (req, res) => {
    try {
        await storage.chatStore.deleteSession(req.params.sessionId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/ai/sessions/:sessionId/messages", async (req, res) => {
    try {
        const messages = await storage.chatStore.getSessionMessages(req.params.sessionId);
        res.json({ messages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// AI CHAT NON-STREAMING — POST /api/v1/ai/chat (G.2.3)
// ======================================================

app.post("/api/v1/ai/chat", async (req, res) => {
    try {
        const { messages, bookId, lang, system: clientSystem, mode, sceneId, characterId, sessionId } = req.body;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: "messages array required" });
        }
        const apiKey = config.OPENROUTER_API_KEY;
        if (!apiKey) {
            return res.status(503).json({ error: "AI not configured" });
        }

        const bookData = bookId ? book.loadBook(bookId) : null;
        const isLocked = bookData?.manifest?.locked === true;

        const ctxBuilder = require('./services/context-builder');
        const positionCtx = clientSystem || null;
        const effectivePrompt = ctxBuilder.buildSystemPrompt(
            mode || 'conversation',
            bookData,
            {
                sceneId: sceneId || null,
                characterId: characterId || null,
                userSystem: clientSystem || null,
                profilePrompt: systemPrompt,
            }
        );

        const fullMessages = [
            { role: "system", content: effectivePrompt },
        ];
        const effectiveMode = mode || 'conversation';
        const tools = getToolsForMode(effectiveMode, bookId, isLocked);
        fullMessages.push(...messages);
        const response = await fetch(`${AI_API_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
                ...(AI_API_BASE_URL.includes('openrouter') ? {
                    "HTTP-Referer": "https://animastor.in",
                    "X-Title": "Animastor"
                } : {})
            },
            body: JSON.stringify({
                model: config.OPENROUTER_MODEL || "qwen/qwen3.5-122b-a10b",
                messages: fullMessages,
                tools: tools.length > 0 ? tools : undefined,
                max_tokens: 16384,
                stream: false
            })
        });
        if (!response.ok) {
            const errText = await response.text();
            return res.status(response.status).json({ error: `AI API error: ${errText}` });
        }
        const data = await response.json();
        const choice = data.choices[0].message;
        const reply = choice.content || choice.reasoning_content || '';

        // G.3 — Handle tool calls per mode
        if (choice.tool_calls && choice.tool_calls.length > 0) {
            for (const tc of choice.tool_calls) {
                const fnName = tc.function?.name;

                // --- EDIT mode: edit_book ---
                if (fnName === 'edit_book') {
                    try {
                        const args = JSON.parse(tc.function.arguments);
                        const patches = args.patches;
                        if (!Array.isArray(patches) || patches.length === 0) continue;

                        if (isLocked) {
                            return res.json({ reply: 'Эта книга защищена от редактирования.', book_edited: false });
                        }

                        if (!bookId) continue;
                        const bd = book.loadBook(bookId);
                        if (!bd) continue;

                        // Apply patches directly (confirmation can be added on frontend)
                        const result = applyPatches(bd, patches);
                        if (result.ok) {
                            await saveBookSnapshot(bookId);
                            book.saveBookBundle(bd, null);
                            console.log(`[AI] Tool edit_book applied to ${bookId}:`, JSON.stringify(patches));
                            const summary = patches.map(p => {
                                const parts = p.path.split('/');
                                const field = parts[parts.length - 1];
                                const val = p.op === 'remove' ? '' : ` → ${JSON.stringify(p.value)}`;
                                return `${p.op} ${field}${val}`;
                            }).join('; ');
                            const toolReply = reply || `✅ Изменения применены: ${summary}.`;
                            return res.json({
                                reply: toolReply,
                                book_edited: true,
                                book_id: bookId,
                                mode: 'edit',
                            });
                        } else {
                            console.error('[AI] Tool patch error:', result.error);
                            return res.json({ reply: reply + '\n\n⚠️ Ошибка при применении изменений: ' + result.error, book_edited: false });
                        }
                    } catch (e) {
                        console.error('[AI] Failed to parse tool call:', e.message);
                        return res.json({ reply: reply + '\n\n⚠️ Ошибка обработки изменений.', book_edited: false });
                    }
                }

                // --- DIRECTOR mode: write_storyboard ---
                if (fnName === 'write_storyboard') {
                    try {
                        const args = JSON.parse(tc.function.arguments);
                        const { scene_id, elements } = args;
                        if (!scene_id || !Array.isArray(elements)) continue;
                        if (!bookId) continue;
                        const bd = book.loadBook(bookId);
                        if (!bd) continue;

                        const scene = (bd.scenes || []).find(s => s.id === scene_id);
                        if (!scene) {
                            return res.json({ reply: 'Сцена не найдена.', storyboard_applied: false });
                        }

                        scene.storyboard_elements = elements;
                        book.saveBookBundle(bd, null);
                        console.log(`[AI] Tool write_storyboard applied to ${bookId}/${scene_id}: ${elements.length} elements`);
                        const toolReply = reply || `✅ Storyboard применён: ${elements.length} элементов для сцены "${scene.title}".`;
                        return res.json({
                            reply: toolReply,
                            storyboard_applied: true,
                            scene_id,
                            elements_count: elements.length,
                            mode: 'director',
                        });
                    } catch (e) {
                        console.error('[AI] Tool storyboard error:', e.message);
                        return res.json({ reply: reply + '\n\n⚠️ Ошибка применения storyboard.', storyboard_applied: false });
                    }
                }

                // --- EXTRACTION mode: extract_entities ---
                if (fnName === 'extract_entities') {
                    try {
                        const args = JSON.parse(tc.function.arguments);
                        const entities = args.entities || {};
                        const toolReply = reply || '✅ Сущности извлечены.';
                        return res.json({
                            reply: toolReply,
                            extracted_entities: entities,
                            mode: 'extraction',
                        });
                    } catch (e) {
                        console.error('[AI] Extraction error:', e.message);
                        return res.json({ reply: reply + '\n\n⚠️ Ошибка извлечения сущностей.', mode: 'extraction' });
                    }
                }

                // --- IMPORT mode: import_book ---
                if (fnName === 'import_book') {
                    try {
                        const args = JSON.parse(tc.function.arguments);
                        const { book: importedBook, action, chapter_id, scene_id } = args;
                        if (!importedBook || !importedBook.chapters) {
                            return res.json({ reply: '⚠️ Ошибка: структура книги не найдена в ответе.', mode: 'import' });
                        }

                        // New book creation
                        if (action === 'new_book' || !bookId) {
                            const newBookId = importedBook.metadata?.title
                                ? importedBook.metadata.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + Date.now()
                                : 'imported_' + Date.now();
                            importedBook.manifest = importedBook.manifest || { version: "1.0", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
                            importedBook.manifest.book_id = newBookId;
                            book.saveBookBundle(importedBook, null);
                            const title = importedBook.metadata?.title || 'Imported Book';
                            return res.json({
                                reply: `✅ Книга "${title}" создана на основе вашего текста.`,
                                book_edited: true,
                                book_id: newBookId,
                                mode: 'import',
                            });
                        }

                        // Extend existing book
                        if (bookId && importedBook) {
                            const bd = book.loadBook(bookId);
                            if (!bd) {
                                return res.json({ reply: '⚠️ Книга не найдена.', mode: 'import' });
                            }

                            if (isLocked) {
                                return res.json({ reply: '⚠️ Книга защищена от изменений.', mode: 'import' });
                            }

                            // Import new chapters from the AI result
                            for (const newCh of (importedBook.chapters || [])) {
                                const newChId = newCh.id || 'ch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                                const chapter = {
                                    id: newChId,
                                    title: newCh.title || 'New Chapter',
                                    chapter_index: (bd.chapters || []).length,
                                    scenes: []
                                };
                                for (const newSc of (newCh.scenes || [])) {
                                    const newScId = newSc.id || 'sc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                                    const scene = {
                                        id: newScId,
                                        title: newSc.title || 'New Scene',
                                        scene_index: chapter.scenes.length,
                                        characters_present: newSc.characters_present || [],
                                        units: []
                                    };
                                    for (const newUnit of (newSc.units || [])) {
                                        scene.units.push({
                                            id: newUnit.id || 'iu_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                                            text: newUnit.text || ''
                                        });
                                    }
                                    chapter.scenes.push(scene);
                                }
                                bd.chapters = bd.chapters || [];
                                bd.chapters.push(chapter);
                            }

                            // Import characters from AI result
                            bd.characters = bd.characters || [];
                            for (const newChar of (importedBook.characters || [])) {
                                if (!bd.characters.find(c => c.id === newChar.id || c.name === newChar.name)) {
                                    bd.characters.push(newChar);
                                }
                            }

                            // Import locations from AI result
                            bd.locations = bd.locations || [];
                            for (const newLoc of (importedBook.locations || [])) {
                                if (!bd.locations.find(l => l.id === newLoc.id || l.name === newLoc.name)) {
                                    bd.locations.push(newLoc);
                                }
                            }

                            await saveBookSnapshot(bookId);
                            book.saveBookBundle(bd, null);
                            const chCount = (importedBook.chapters || []).length;
                            return res.json({
                                reply: `✅ Импортировано: ${chCount} глав(а) добавлено в книгу.`,
                                book_edited: true,
                                book_id: bookId,
                                mode: 'import',
                            });
                        }
                    } catch (e) {
                        console.error('[AI] Import error:', e.message);
                        return res.json({ reply: reply + '\n\n⚠️ Ошибка импорта: ' + e.message, mode: 'import' });
                    }
                }

                // --- VALIDATION mode: validate_book ---
                if (fnName === 'validate_book') {
                    try {
                        const args = JSON.parse(tc.function.arguments);
                        const checks = args.checks || { violations: [], summary: { total: 0, errors: 0, warnings: 0, info: 0 } };
                        const toolReply = reply || `✅ Проверка завершена. Найдено ${checks.summary?.total || 0} нарушений.`;
                        return res.json({
                            reply: toolReply,
                            validation: checks,
                            mode: 'validation',
                        });
                    } catch (e) {
                        console.error('[AI] Validation error:', e.message);
                        return res.json({ reply: reply + '\n\n⚠️ Ошибка проверки.', mode: 'validation' });
                    }
                }
            }
        }

        // Fallback: text-based edit patches (backward compatible, only in edit mode)
        if (effectiveMode === 'edit' && !isLocked && bookId) {
            const { reply: cleanReply, patches } = parseAIResponse(reply);
            if (patches) {
                const bd = book.loadBook(bookId);
                if (bd) {
                    const result = applyPatches(bd, patches);
                    if (result.ok) {
                        try {
                            await saveBookSnapshot(bookId);
                            book.saveBookBundle(bd, null);
                            console.log(`[AI] Fallback patches applied to ${bookId}`);
                            return res.json({ reply: cleanReply, book_edited: true, book_id: bookId, mode: 'edit' });
                        } catch (saveErr) {
                            return res.json({ reply: cleanReply + '\n\n⚠️ Не удалось сохранить изменения.', book_edited: false });
                        }
                    }
                }
            }
        }

        // Persist to session if sessionId provided
        if (sessionId && bookId) {
            const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
            if (lastUserMsg) {
                storage.chatStore.appendUserMessage(bookId, lastUserMsg.content, { sessionId, topic: mode || 'conversation' }).catch(() => {});
                // Auto-update session title from the first user message
                storage.chatStore.getSession(sessionId).then(s => {
                    if (s && s.messageCount <= 1 && lastUserMsg) {
                        storage.chatStore.updateSession(sessionId, { title: String(lastUserMsg.content).slice(0, 50) }).catch(() => {});
                    }
                }).catch(() => {});
            }
            storage.chatStore.appendAssistantMessage(bookId, reply, { sessionId, topic: mode || 'conversation' }).catch(() => {});
        }

        res.json({ reply, book_edited: false, mode: effectiveMode, ...(bookId ? { book_id: bookId } : {}) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// AI CHAT STREAMING — POST /api/v1/ai/chat/stream (G.2.4)
// ======================================================
app.post("/api/v1/ai/chat/stream", async (req, res) => {
    try {
        const { messages, bookId, lang, system: clientSystem, mode, sceneId, characterId } = req.body;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: "messages array required" });
        }
        const apiKey = config.OPENROUTER_API_KEY;
        if (!apiKey) {
            return res.status(503).json({ error: "AI not configured" });
        }

        const bookData = bookId ? book.loadBook(bookId) : null;
        const isLocked = bookData?.manifest?.locked === true;

        const ctxBuilder = require('./services/context-builder');
        const effectivePrompt = ctxBuilder.buildSystemPrompt(
            mode || 'conversation',
            bookData,
            {
                sceneId: sceneId || null,
                characterId: characterId || null,
                userSystem: clientSystem || null,
                profilePrompt: systemPrompt,
            }
        );

        const fullMessages = [
            { role: "system", content: effectivePrompt },
        ];
        const effectiveMode = mode || 'conversation';
        const tools = getToolsForMode(effectiveMode, bookId, isLocked);
        fullMessages.push(...messages);

        // SSE headers
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });

        const response = await fetch(`${AI_API_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
                ...(AI_API_BASE_URL.includes('openrouter') ? {
                    "HTTP-Referer": "https://animastor.in",
                    "X-Title": "Animastor"
                } : {})
            },
            body: JSON.stringify({
                model: config.OPENROUTER_MODEL || "qwen/qwen3.5-122b-a10b",
                messages: fullMessages,
                tools: tools.length > 0 ? tools : undefined,
                max_tokens: 16384,
                stream: true
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            res.write(`data: ${JSON.stringify({ error: `AI API error: ${errText}` })}\n\n`);
            res.end();
            return;
        }

        let fullReply = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;
                if (!trimmed.startsWith('data: ')) continue;

                try {
                    const json = JSON.parse(trimmed.slice(6));
                    const delta = json.choices?.[0]?.delta;
                    if (delta?.content) {
                        fullReply += delta.content;
                        res.write(`data: ${JSON.stringify({ token: delta.content })}\n\n`);
                    }
                    if (delta?.reasoning_content) {
                        res.write(`data: ${JSON.stringify({ reasoning: delta.reasoning_content })}\n\n`);
                    }
                } catch (e) {
                    // skip malformed lines
                }
            }
        }

        res.write(`data: ${JSON.stringify({ done: true, fullReply })}\n\n`);
        res.end();
    } catch (err) {
        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error: err.message });
        }
    }
});

// ======================================================
// AI MODE ROUTER — POST /assistant/route (G.1.6)
// ======================================================
app.post("/api/v1/assistant/route", async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({ error: "text field required" });
        }

        const input = text.toLowerCase().trim();

        // Keyword-based routing
        const modeKeywords = {
            edit: ['edit', 'change', 'modify', 'update', 'rewrite', 'rename', 'add ', 'remove ', 'delete', 'fix', 'correct', 'insert', 'replace'],
            director: ['camera', 'light', 'composition', 'angle', 'shot', 'director', 'frame', 'cinematic', 'storyboard', 'atmosphere', 'mood lighting', 'visual'],
            extraction: ['extract', 'parse', 'find characters', 'find locations', 'identify', 'entities', 'analyze text', 'read this'],
            validation: ['validate', 'check', 'verify', 'inspect', 'audit', 'integrity', 'schema', 'errors', 'warnings', 'review json'],
            conversation: ['hello', 'hi', 'what', 'how', 'why', 'tell me', 'explain', 'discuss', 'think', 'idea', 'suggest', 'help', '?'],
        };

        // Count keyword matches per mode
        const scores = {};
        for (const [mode, keywords] of Object.entries(modeKeywords)) {
            scores[mode] = keywords.filter(kw => input.includes(kw)).length;
        }

        let mode;
        const maxScore = Math.max(...Object.values(scores));

        if (maxScore > 0) {
            // Pick mode with highest score; tie → first by priority
            const priority = ['edit', 'director', 'extraction', 'validation', 'conversation'];
            mode = priority.find(m => scores[m] === maxScore);
        } else {
            mode = 'conversation';
        }

        res.json({
            mode,
            confidence: maxScore > 3 ? 'high' : maxScore > 0 ? 'medium' : 'low',
            keyword_matches: scores,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/book/:bookId", (req, res) => {
    try {
        const { bookId } = req.params;
        const bookData = book.loadBook(bookId);
        if (!bookData) {
            return res.status(404).json({ error: "Book not found" });
        }
        res.json(bookData);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put("/api/v1/book/:bookId", (req, res) => {
    try {
        const { bookId } = req.params;
        const bookData = req.body;
        if (!bookData || !bookData.manifest || !bookData.manifest.book_id) {
            return res.status(400).json({ error: "Invalid book JSON" });
        }
        book.saveBookBundle(bookData, null);
        res.json({ ok: true, book_id: bookId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/v1/book/:bookId/reorder", (req, res) => {
    try {
        const { bookId } = req.params;
        const { chapters } = req.body;
        if (!Array.isArray(chapters)) {
            return res.status(400).json({ error: "chapters array required" });
        }
        const bookData = book.loadBook(bookId);
        if (!bookData) {
            return res.status(404).json({ error: "Book not found" });
        }

        // Build a map of chapter_id -> { scenes: [...] } from incoming chapters
        // Each chapter in the request has: { chapter: "ch-XXXXXXXX", scenes: ["sc-XXXXXXXX", "sc-YYYYYYYY", ...] }
        // We reorder bookData.chapters to match, and reorder scenes within each chapter
        const incomingMap = {};
        for (const ch of chapters) {
            incomingMap[ch.chapter || ch.id] = ch.scenes || [];
        }

        // Reorder top-level chapters to match incoming order
        const incomingOrder = chapters.map(ch => ch.chapter || ch.id);
        const oldChapters = bookData.chapters || [];
        const chapterMap = {};
        for (const ch of oldChapters) {
            chapterMap[ch.chapter] = ch;
        }
        const newChapters = [];
        for (const chId of incomingOrder) {
            const ch = chapterMap[chId];
            if (ch) {
                // Reorder scenes within this chapter
                const scenes = ch.scenes || [];
                const sceneMap = {};
                for (const sc of scenes) {
                    sceneMap[sc.scene_id] = sc;
                }
                const order = incomingMap[chId] || [];
                const reordered = [];
                for (const scId of order) {
                    if (sceneMap[scId]) {
                        reordered.push(sceneMap[scId]);
                    }
                }
                // Append any scenes not in the incoming order (e.g. new)
                for (const sc of scenes) {
                    if (!order.includes(sc.scene_id)) {
                        reordered.push(sc);
                    }
                }
                ch.scenes = reordered;
                newChapters.push(ch);
            }
        }
        // Append any chapters not in incoming order
        for (const ch of oldChapters) {
            if (!incomingOrder.includes(ch.chapter)) {
                newChapters.push(ch);
            }
        }
        bookData.chapters = newChapters;
        book.saveBookBundle(bookData, null);
        res.json({ ok: true, book_id: bookId, chapter_count: newChapters.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/book/:bookId/download", (req, res) => {
    try {
        const { bookId } = req.params;
        const booksDir = config.BOOKS_DIR;
        const bookDir = path.join(booksDir, bookId);

        // Multi-file directory format — ZIP the entire book directory
        if (fs.existsSync(bookDir)) {
            const stat = fs.statSync(bookDir);
            if (stat.isDirectory()) {
                const zip = new AdmZip();
                book.addDirToZip(zip, bookDir, '');
                const zipBuffer = zip.toBuffer();
                res.set({
                    'Content-Type': 'application/octet-stream',
                    'Content-Disposition': `attachment; filename="${bookId}.vbook"`,
                    'Content-Length': zipBuffer.length
                });
                res.send(zipBuffer);
                return;
            }
        }

        // Legacy single-file fallback
        const bookData = book.loadBook(bookId);
        if (!bookData) {
            return res.status(404).json({ error: "Book not found" });
        }
        const zip = new AdmZip();
        zip.addFile("book.json", Buffer.from(JSON.stringify(bookData, null, 2), 'utf-8'));
        const zipBuffer = zip.toBuffer();
        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${bookId}.vbook"`,
            'Content-Length': zipBuffer.length
        });
        res.send(zipBuffer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/book/:bookId/export", async (req, res) => {
    try {
        const { bookId } = req.params;
        const buildId = req.query.build_id;
        if (!buildId) {
            return res.status(400).json({ error: "build_id query param required" });
        }

        const bookData = book.loadBook(bookId);
        if (!bookData) {
            return res.status(404).json({ error: "Book not found" });
        }

        const outDir = path.join(config.OUTPUT_DIR, buildId);
        if (!fs.existsSync(outDir)) {
            return res.status(404).json({ error: `Build directory not found: ${buildId}` });
        }

        const scenes = [];
        if (bookData.chapters) {
            for (const chapter of bookData.chapters) {
                if (chapter.scenes) {
                    for (const scene of chapter.scenes) {
                        scenes.push({ chapter_id: chapter.chapter, scene_id: scene.scene_id });
                    }
                }
            }
        }

        if (scenes.length === 0) {
            return res.status(400).json({ error: "No scenes found in book" });
        }

        const videoPaths = [];
        const audioPaths = [];
        for (const s of scenes) {
            const vp = path.join(outDir, `${bookId}_${s.chapter_id}_${s.scene_id}.mp4`);
            if (fs.existsSync(vp)) videoPaths.push(vp);
            const ap = path.join(outDir, `${bookId}_${s.chapter_id}_${s.scene_id}.mp3`);
            if (fs.existsSync(ap)) audioPaths.push(ap);
        }

        const videoMerge = require('./video/video-merge');
        const audioService = require('./audio');

        const tempDir = '/tmp';
        const vidMerged = path.join(tempDir, `${bookId}_vid_merged_${Date.now()}.mp4`);
        const audMerged = path.join(tempDir, `${bookId}_aud_merged_${Date.now()}.mp3`);
        const finalPath = path.join(tempDir, `${bookId}_final_${Date.now()}.mp4`);

        let vidResult = null;
        if (videoPaths.length > 0) {
            if (videoPaths.length === 1) {
                vidResult = videoPaths[0];
            } else {
                vidResult = await videoMerge.concatVideos(videoPaths, vidMerged);
            }
        }

        let audResult = null;
        if (audioPaths.length > 0) {
            if (audioPaths.length === 1) {
                audResult = audioPaths[0];
            } else {
                const concatFile = path.join(tempDir, `aconcat_${bookId}_${Date.now()}.txt`);
                const content = audioPaths.map(f => `file '${f}'`).join('\n');
                fs.writeFileSync(concatFile, content);
                try {
                    const ffArgs = ['-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', audMerged, '-y'];
                    await audioService.runFFmpegMerge(ffArgs);
                    audResult = audMerged;
                } finally {
                    try { fs.unlinkSync(concatFile); } catch (e) {}
                }
            }
        }

        if (!vidResult && !audResult) {
            if (videoPaths.length === 0 && audioPaths.length === 0) {
                return res.status(404).json({ error: "No media files generated yet. Please wait for video generation to complete." });
            }
            return res.status(404).json({ error: "No media files found for export" });
        }

        const result = await videoMerge.muxVideoAudio(vidResult, audResult, finalPath);
        if (!result) {
            return res.status(500).json({ error: "Export failed during muxing" });
        }
        log(`[EXPORT] Final video created: ${result} (${(fs.statSync(result).size / 1024 / 1024).toFixed(1)} MB)`);

        res.set({
            'Content-Type': 'video/mp4',
            'Content-Disposition': `attachment; filename="${bookId}_final.mp4"`,
            'Content-Length': fs.statSync(result).size
        });
        fs.createReadStream(result).pipe(res);
    } catch (err) {
        console.error("[EXPORT] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Download Storyboard ZIP — entire build folder excluding merged book-level files
app.get("/api/v1/book/:bookId/storyboard", async (req, res) => {
    try {
        const { bookId } = req.params;
        const buildId = req.query.build_id;
        if (!buildId) {
            return res.status(400).json({ error: "build_id query param required" });
        }
        const bookData = book.loadBook(bookId);
        if (!bookData) {
            return res.status(404).json({ error: "Book not found" });
        }
        const outDir = path.join(config.OUTPUT_DIR, buildId);
        if (!fs.existsSync(outDir)) {
            return res.status(404).json({ error: `Build directory not found: ${buildId}` });
        }

        const zip = new AdmZip();
        const bookAudioName = `${bookId}.mp3`;

        function shouldExclude(name) {
            return name === bookAudioName || name.endsWith('_final.mp4');
        }

        const entries = fs.readdirSync(outDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile() && !shouldExclude(entry.name)) {
                const fullPath = path.join(outDir, entry.name);
                zip.addFile(entry.name, fs.readFileSync(fullPath));
            }
        }

        const zipBuffer = zip.toBuffer();
        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${bookId}_storyboard.zip"`,
            'Content-Length': zipBuffer.length
        });
        res.send(zipBuffer);
    } catch (err) {
        console.error("[STORYBOARD] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Download Merged Audio — concatenates all scene audio into one MP3
app.get("/api/v1/book/:bookId/audio", async (req, res) => {
    try {
        const { bookId } = req.params;
        const buildId = req.query.build_id;
        if (!buildId) {
            return res.status(400).json({ error: "build_id query param required" });
        }
        const bookData = book.loadBook(bookId);
        if (!bookData) {
            return res.status(404).json({ error: "Book not found" });
        }
        const outDir = path.join(config.OUTPUT_DIR, buildId);
        if (!fs.existsSync(outDir)) {
            return res.status(404).json({ error: `Build directory not found: ${buildId}` });
        }

        const scenes = [];
        if (bookData.chapters) {
            for (const chapter of bookData.chapters) {
                if (chapter.scenes) {
                    for (const scene of chapter.scenes) {
                        scenes.push({ chapter_id: chapter.chapter, scene_id: scene.scene_id });
                    }
                }
            }
        }
        if (scenes.length === 0) {
            return res.status(400).json({ error: "No scenes found in book" });
        }

        const resultPath = await audioService.mergeBookAudio(buildId, bookId, scenes);
        if (!resultPath || !fs.existsSync(resultPath)) {
            return res.status(404).json({ error: "No audio files generated yet" });
        }

        res.set({
            'Content-Type': 'audio/mpeg',
            'Content-Disposition': `attachment; filename="${bookId}.mp3"`,
            'Content-Length': fs.statSync(resultPath).size
        });
        fs.createReadStream(resultPath).pipe(res);
    } catch (err) {
        console.error("[AUDIO EXPORT] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

async function handleTaskResult(job_id, result_base64, build_id) {
    console.log(`📥 handleTaskResult: job_id=${job_id}, build_id=${build_id}`);

    if (!job_id || !build_id) {
        console.error("❌ Missing job_id or build_id");
        return;
    }

    const assetPathInfo = resolveAssetPath(job_id, build_id)
    if (!assetPathInfo) {
        console.error("❌Could not resolve asset path from job_id:", job_id)
        return;
    }

    const { type, fullPath } = assetPathInfo

    const assetDir = path.dirname(fullPath)
    if (!fs.existsSync(assetDir)) {
        fs.mkdirSync(assetDir, { recursive: true })
    }

    storage.filesystem.saveFile(result_base64, fullPath)
    console.log("✅ ASSET SAVED (" + type + "):", path.basename(fullPath))

    if (type === "iu_image") {
        const id = job_id.replace(/:image$/, "")
        const chunk = await getChunk(id)

        const match = id.match(/^(.+?)_(ch[^_]+)_(sc[^_]+)_iu[^_]+$/)
        if (match) {
            const bookId = match[1]
            const chapterId = match[2]
            const sceneId = match[3]
            const buildIdFinal = chunk?.build_id || build_id

            try { await redis.set('animastor:runtime:last-active:image', '1', 'EX', 10) } catch {}

            const sceneBook = book.loadBook(bookId)
            const scene = sceneBook ? book.findSceneRuntimeData(sceneBook, chapterId, sceneId) : null

            if (scene) {
                console.log(`✅ IU IMAGE HANDLED: ${id} for ${bookId}/${chapterId}/${sceneId}`)
                await saveIURegistry(id, buildIdFinal)

                // Count completed IUs by files on disk. Redis IU registry is written at dispatch time,
                // so using it here marks a scene ready after the first callback.
                const iuFilePrefix = `${bookId}_${chapterId}_${sceneId}_iu`;
                let completedIUs = 0;
                try {
                    const buildDir = path.join(config.OUTPUT_DIR, buildIdFinal);
                    completedIUs = fs.readdirSync(buildDir)
                        .filter(f => f.startsWith(iuFilePrefix) && f.endsWith('.png'))
                        .length;
                } catch (err) {
                    log(`IU file count failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
                }

                const totalIUs = book.collectSceneUnits(scene.payload).length;
                log(`IU progress: ${completedIUs}/${totalIUs} for ${bookId}/${chapterId}/${sceneId}`);

                if (completedIUs >= totalIUs) {
                    // All IUs done — complete image stage
                    try {
                        const handled = await orchestrator.handleImageCompleted(redis, scene, sceneBook, buildIdFinal)
                        if (handled.handled) {
                            const allChunks = await getAllChunks(bookId)
                            const scenePrefix = `${bookId}_${chapterId}_${sceneId}_`
                            for (const cid of allChunks) {
                                if (cid.startsWith(scenePrefix)) {
                                    const ch = await getChunk(cid)
                                    if (ch && !ch.image) {
                                        ch.image = true
                                        await saveChunk(cid, ch)
                                    }
                                }
                            }
                            try { await runtime.dispatch.markDispatchCompleted(redis, bookId, chapterId, sceneId, 'image') } catch (e) { log(`markDispatchCompleted: ${e.message}`) }
                        }
                    } catch (err) {
                        console.log(`⚠️ IU image handled, state check failed: ${err.message}`)
                    }
                } else {
                    log(`Waiting for more IUs: ${completedIUs}/${totalIUs} for ${bookId}/${chapterId}/${sceneId}`);
                }
            } else {
                console.log(`⚠️ IU IMAGE: Scene data not found for ${id}`)
                await saveIURegistry(id, buildIdFinal)
            }
        } else {
            console.log(`⚠️ IU IMAGE: Invalid format ${id}`)
            await saveIURegistry(id, build_id)
        }
    } else if (type === "audio_chunk") {
        try {
            const chunkId = job_id.replace(/:audio$/, "")
            const chunk = await getChunk(chunkId)
            if (chunk) {
                chunk.audio = true
                chunk.audio_status = 'ready'
                await saveChunk(chunkId, chunk)
                console.log(`🔊 Audio chunk ready: ${chunkId}`)
                await triggerAudioMerge(chunk)
            } else {
                console.log(`⚠️ Audio chunk metadata not found in Redis for: ${chunkId}`)
            }
        } catch (err) {
            console.log(`⚠️ Audio result handling failed: ${err.message}`)
        }
    } else if (type === "scene_video") {
        try {
            await handleVideoCompleted(job_id, result_base64, build_id)
        } catch (err) {
            console.log(`⚠️ Video result handling failed: ${err.message}`)
        }
    } else if (type === "scene_image") {
        try {
            await handleSceneImageCompleted(job_id, result_base64, build_id)
        } catch (err) {
            console.log(`⚠️ Scene image handling failed: ${err.message}`)
        }
    }
}

app.post("/gpu/task/result", async (req, res) => {
    const { job_id, result_base64, build_id } = req.body

    console.log(`📥 POST /gpu/task/result: job_id=${job_id}, build_id=${build_id}`);

    if (!job_id || !build_id) {
        console.error("❌ Missing job_id or build_id in body");
        return res.status(400).json({ error: "Missing fields" })
    }

    try {
        await handleTaskResult(job_id, result_base64, build_id);
        await redis.del(`animastor:result:${job_id}`);
    } catch (err) {
        console.error("❌ Task result error:", err.message);
    }

    res.json({ ok: true })
})

// ======================================================
// [SIMPLIFIED] AUDIO TRIGGER - Bootstrap layer
// ======================================================
// Delegates to orchestrator.handleAudioCompleted
// - Validates chunk inputs
// - Calls orchestrator (orchestrator DOES its own state validation)

async function triggerAudioMerge(chunk) {
    const chapterId = chunk.chapter_id
    const sceneId = chunk.scene_id
    const chunkIndex = String(chunk.chunk_index)
    const buildId = chunk.build_id
    const bookId = chunk.book_id

    // Only process valid chunk indices (4 digits)
    if (!chapterId || !sceneId || !chunkIndex || !/^\d{4}$/.test(chunkIndex)) {
        return
    }

    // Ensure book is loaded for runtime data lookup
    const sceneBook = book.loadBook(bookId)
    if (!sceneBook) {
        log(`Cannot load book for audio merge: ${bookId}`)
        return
    }

    // Check if canonical audio already exists
    if (await isSceneAudioReady(buildId, bookId, chapterId, sceneId)) {
        // Already ready — delegate to orchestrator
        const scene = book.findSceneRuntimeData(sceneBook, chapterId, sceneId)
        if (scene) {
            await orchestrator.handleAudioCompleted(redis, scene, sceneBook, buildId)
            try { await runtime.dispatch.markDispatchCompleted(redis, bookId, chapterId, sceneId, 'audio') } catch (e) { log(`markDispatchCompleted: ${e.message}`) }
        }
        return
    }

    // Try to merge: check if all expected chunks exist
    const expectedCount = chunk.expected_chunk_count || null
    const chunkCheck = audio.allSceneChunksExist(bookId, chapterId, sceneId, buildId, expectedCount)
    if (!chunkCheck.exists) {
        log(`Audio chunks not all present yet: ${bookId}/${chapterId}/${sceneId} (${chunkCheck.chunkCount}/${expectedCount || '?'})`)
        return
    }

    log(`All audio chunks present, merging: ${bookId}/${chapterId}/${sceneId}`)
    const mergeResult = await audio.mergeSceneAudioChunks(redis, bookId, chapterId, sceneId, buildId, expectedCount)
    if (!mergeResult) {
        log(`Audio merge failed: ${bookId}/${chapterId}/${sceneId}`)
        return
    }

    log(`Audio merge successful: ${bookId}/${chapterId}/${sceneId}`)

    // Trim padded audio (short texts doubled for clean TTS) to remove repetition
    if (chunk.padded_text) {
        try {
            await audio.trimPaddedSceneAudio(mergeResult)
        } catch (e) { log(`trimPaddedSceneAudio failed: ${e.message}`) }
    }

    // Also try to merge if a single chunk is present (for immediate audio output)
    // Even if expectedChunkCount is not met, if there's at least one chunk, merge it
    const singleChunkCheck = audio.allSceneChunksExist(bookId, chapterId, sceneId, buildId, null)
    if (singleChunkCheck.exists && singleChunkCheck.chunkCount === 1) {
        log(`Single audio chunk present, merging immediately: ${bookId}/${chapterId}/${sceneId}`)
        const singleMergeResult = await audio.mergeSceneAudioChunks(redis, bookId, chapterId, sceneId, buildId, 1)
        if (singleMergeResult) {
            log(`Single chunk merge successful: ${bookId}/${chapterId}/${sceneId}`)

            // Trim padded audio from single-chunk merge too
            if (chunk.padded_text) {
                try {
                    await audio.trimPaddedSceneAudio(singleMergeResult)
                } catch (e) { log(`trimPaddedSceneAudio (single) failed: ${e.message}`) }
            }
        }
    }

    log(`Audio merge successful: ${bookId}/${chapterId}/${sceneId}`)

    // Delegate to orchestrator (it validates state and registers completion)
    const scene = book.findSceneRuntimeData(sceneBook, chapterId, sceneId)
    if (scene) {
        await orchestrator.handleAudioCompleted(redis, scene, sceneBook, buildId)
        try { await runtime.dispatch.markDispatchCompleted(redis, bookId, chapterId, sceneId, 'audio') } catch (e) { log(`markDispatchCompleted: ${e.message}`) }
    }
}

// ======================================================
// [SNAPSHOT] Book state snapshot for diff tracking
// ======================================================

/**
 * Save a snapshot of the current book state to SQLite.
 * This serves as the "old" state for future diff comparisons.
 * Persistent (no TTL), with version history.
 */
async function saveBookSnapshot(bookId) {
    try {
        const bookData = book.loadBook(bookId);
        if (!bookData) return { ok: false, reason: 'book_not_found' };
        const result = await storage.postgres.repos.book.saveBookSnapshot(bookId, bookData);
        await redis.set(`animastor:book-snapshot:${bookId}`, JSON.stringify(bookData), 'EX', 86400);
        log(`[SNAPSHOT] Saved snapshot v${result.version} for ${bookId} (PG)`);
        return { ok: true, version: result.version };
    } catch (err) {
        console.error(`[SNAPSHOT] Error saving snapshot for ${bookId}: ${err.message}`);
        return { ok: false, reason: err.message };
    }
}

async function loadBookSnapshot(bookId) {
    try {
        const pgSnapshot = await storage.postgres.repos.book.loadLatestSnapshot(bookId);
        if (pgSnapshot) {
            log(`[SNAPSHOT] Loaded from PG: ${bookId} v${pgSnapshot.version}`);
            return pgSnapshot.snapshot;
        }
        const raw = await redis.get(`animastor:book-snapshot:${bookId}`);
        if (raw) {
            log(`[SNAPSHOT] Loaded from Redis cache: ${bookId}`);
            return JSON.parse(raw);
        }
        return null;
    } catch (err) {
        console.error(`[SNAPSHOT] Error loading snapshot for ${bookId}: ${err.message}`);
        try {
            const raw = await redis.get(`animastor:book-snapshot:${bookId}`);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }
}

// ======================================================
// [SNAPSHOT] API Endpoint
// ======================================================

app.post("/api/v1/book/:bookId/snapshot", async (req, res) => {
    try {
        const { bookId } = req.params;
        const result = await saveBookSnapshot(bookId);
        if (!result.ok) {
            return res.status(404).json({ error: result.reason });
        }
        res.json({ ok: true, book_id: bookId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// [DIFF] SCENE-LEVEL DETECTION HELPERS
// ======================================================

/**
 * Deep-compare two values (primitives, arrays, objects).
 * Returns true if equal (shallow for objects — enough for diff detection).
 */
function isEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a === 'object') {
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            return a.every((v, i) => isEqual(v, b[i]));
        }
        const aKeys = Object.keys(a).sort();
        const bKeys = Object.keys(b).sort();
        if (!isEqual(aKeys, bKeys)) return false;
        return aKeys.every(k => isEqual(a[k], b[k]));
    }
    return false;
}

/**
 * Compute diff between old and new scene.
 * Returns { dirty_layers: string[], changes: object }
 * dirty_layers = set of layer types that need regeneration
 */
function diffScene(oldScene, newScene) {
    const dirtyLayers = new Set();
    const changes = {};

    // Audio changes
    const oldAudio = oldScene?.audio || {};
    const newAudio = newScene?.audio || {};
    if (!isEqual(oldAudio.full_text, newAudio.full_text)) {
        dirtyLayers.add('audio');
        dirtyLayers.add('video');
        changes.audio = ['full_text'];
    }
    if (!isEqual(oldAudio.voice, newAudio.voice)) {
        dirtyLayers.add('audio');
        dirtyLayers.add('video');
        if (!changes.audio) changes.audio = [];
        changes.audio.push('voice');
    }

    // Visual / IU changes (per-unit)
    const oldUnits = oldScene?.units || [];
    const newUnits = newScene?.units || [];
    const maxUnits = Math.max(oldUnits.length, newUnits.length);
    for (let i = 0; i < maxUnits; i++) {
        const oldU = oldUnits[i];
        const newU = newUnits[i];
        if (!oldU || !newU) {
            dirtyLayers.add('image');
            dirtyLayers.add('video');
            changes.units = changes.units || {};
            changes.units[i] = !oldU ? 'added' : 'removed';
            continue;
        }
        if (!isEqual(oldU.visual, newU.visual) || !isEqual(oldU.type, newU.type) || !isEqual(oldU.participants, newU.participants) || !isEqual(oldU.text, newU.text)) {
            dirtyLayers.add('image');
            dirtyLayers.add('video');
            changes.units = changes.units || {};
            changes.units[i] = 'visual_changed';
            changes.dirty_unit_ids = changes.dirty_unit_ids || [];
            if (newU.id) changes.dirty_unit_ids.push(String(newU.id));
        }
    }

    // Scene-level visual changes (location, environment, participants, style)
    if (!isEqual(oldScene?.location, newScene?.location)) {
        dirtyLayers.add('image');
        dirtyLayers.add('video');
        changes.location = true;
    }
    if (!isEqual(oldScene?.participants, newScene?.participants)) {
        dirtyLayers.add('image');
        dirtyLayers.add('video');
        changes.participants = true;
    }
    if (!isEqual(oldScene?.style, newScene?.style)) {
        dirtyLayers.add('image');
        dirtyLayers.add('video');
        changes.style = true;
    }

    return {
        dirty_layers: [...dirtyLayers],
        changes: Object.keys(changes).length > 0 ? changes : null
    };
}

/**
 * Compute full diff between old and new book state.
 * Returns:
 * {
 *   book_id,
 *   summary: { total_scenes_old, total_scenes_new, changed, added, removed },
 *   dirty_scenes: [ { chapter_id, scene_id, dirty_layers, changes } ],
 *   reindex_needed: boolean
 * }
 */
function computeBookDiff(oldBook, newBook) {
    const oldChapters = oldBook?.chapters || [];
    const newChapters = newBook?.chapters || [];

    // Build old scene map: "chXXXX_scXXXX" →{ chapter, scene, chapterIndex, sceneIndex }
    const oldSceneMap = {};
    oldChapters.forEach((ch, ci) => {
        (ch.scenes || []).forEach((sc, si) => {
            const key = `${ch.chapter}_${sc.scene_id}`;
            oldSceneMap[key] = { chapter: ch, scene: sc, chapterIndex: ci, sceneIndex: si };
        });
    });

    const newSceneMap = {};
    newChapters.forEach((ch, ci) => {
        (ch.scenes || []).forEach((sc, si) => {
            const key = `${ch.chapter}_${sc.scene_id}`;
            newSceneMap[key] = { chapter: ch, scene: sc, chapterIndex: ci, sceneIndex: si };
        });
    });

    const oldKeys = new Set(Object.keys(oldSceneMap));
    const newKeys = new Set(Object.keys(newSceneMap));

    const dirtyScenes = [];
    let added = 0, removed = 0, changed = 0;

    for (const key of oldKeys) {
        if (!newKeys.has(key)) {
            removed++;
            dirtyScenes.push({
                chapter_id: oldSceneMap[key].chapter.chapter,
                scene_id: oldSceneMap[key].scene.scene_id,
                dirty_layers: ['filesystem'],
                changes: { _removed: true }
            });
        }
    }

    for (const key of newKeys) {
        const n = newSceneMap[key];
        if (!oldKeys.has(key)) {
            added++;
            dirtyScenes.push({
                chapter_id: n.chapter.chapter,
                scene_id: n.scene.scene_id,
                dirty_layers: ['audio', 'image', 'video', 'filesystem'],
                changes: { _added: true }
            });
        } else {
            const o = oldSceneMap[key];
            const diff = diffScene(o.scene, n.scene);
            if (diff.dirty_layers.length > 0) {
                changed++;
                // Check if scene moved (reindex needed)
                if (o.chapterIndex !== n.chapterIndex || o.sceneIndex !== n.sceneIndex) {
                    diff.dirty_layers.push('filesystem');
                    diff.changes = diff.changes || {};
                    diff.changes._moved = true;
                    diff.changes._oldIndex = o.sceneIndex;
                    diff.changes._newIndex = n.sceneIndex;
                }
                dirtyScenes.push({
                    chapter_id: n.chapter.chapter,
                    scene_id: n.scene.scene_id,
                    dirty_layers: diff.dirty_layers,
                    changes: diff.changes
                });
            }
        }
    }

    const reindexNeeded = added > 0 || removed > 0 || dirtyScenes.some(d => d.dirty_layers.includes('filesystem'));
    const oldSceneCount = Object.keys(oldSceneMap).length;
    const newSceneCount = Object.keys(newSceneMap).length;

    return {
        summary: {
            total_scenes_old: oldSceneCount,
            total_scenes_new: newSceneCount,
            changed,
            added,
            removed
        },
        dirty_scenes: dirtyScenes,
        reindex_needed: reindexNeeded
    };
}

/**
 * Given a list of dirty scenes, mark the affected chunks in Redis as needing regeneration.
 * Resets their state to trigger re-dispatch by the runtime scheduler.
 *
 * `layerCfg` controls which layers to reset:
 *   { audio_enabled, image_enabled, video_enabled } — booleans.
 *   If a layer is disabled in config, dirty_layers that target it are ignored.
 */
async function markDirtyScenes(redis, bookId, buildId, dirtyScenes, layerCfg) {
    const depGraph = require('./dependency-graph');
    const audioOn = !layerCfg || layerCfg.audio_enabled !== false;
    const imageOn = !layerCfg || layerCfg.image_enabled !== false;
    const videoOn = !layerCfg || layerCfg.video_enabled !== false;
    const activeLayers = [];
    if (audioOn) activeLayers.push('audio');
    if (imageOn) activeLayers.push('image');
    if (videoOn) activeLayers.push('video');
    let marked = 0;
    for (const ds of dirtyScenes) {
        const { chapter_id, scene_id, dirty_layers, changes } = ds;
        const effectiveLayers = dirty_layers.filter(l => activeLayers.includes(l));

        // Reset chunk flags for dirty layers
        const allChunks = await getAllChunks(bookId);
        const scenePrefix = `${bookId}_${chapter_id}_${scene_id}_`;
        for (const cid of allChunks) {
            if (cid.startsWith(scenePrefix)) {
                const chunk = await getChunk(cid);
                if (!chunk) continue;

                if (effectiveLayers.includes('audio')) {
                    chunk.audio = false;
                    chunk.audio_status = 'pending';
                }
                if (effectiveLayers.includes('image')) {
                    chunk.image = false;
                    // Delete only IU image files for changed unit IDs
                    const dirtyUnitIds = changes?.dirty_unit_ids || [];
                    const buildDir = path.join(STORAGE_OUTPUT_DIR, buildId);
                    if (dirtyUnitIds.length > 0) {
                        try {
                            for (const uid of dirtyUnitIds) {
                                const iuFile = `${bookId}_${chapter_id}_${scene_id}_${uid}.png`;
                                const iuPath = path.join(buildDir, iuFile);
                                if (fs.existsSync(iuPath)) {
                                    fs.unlinkSync(iuPath);
                                    log(`[DIRTY] Deleted stale IU image: ${iuFile}`);
                                }
                                // Also delete stale preview thumbnail
                                const prFile = iuFile.replace('_iu', '_pr');
                                const prPath = path.join(buildDir, prFile);
                                if (fs.existsSync(prPath)) {
                                    fs.unlinkSync(prPath);
                                    log(`[DIRTY] Deleted stale preview: ${prFile}`);
                                }
                                // Clear gpu-hub job lock so new task isn't rejected as duplicate
                                const jobKey = `animastor:job:${bookId}_${chapter_id}_${scene_id}_${uid}:image`;
                                try { await redis.del(jobKey); } catch {}
                            }
                        } catch (e) {
                            log(`[DIRTY] Failed to clean IU images for ${bookId}/${chapter_id}/${scene_id}: ${e.message}`);
                        }
                    }
                }
                if (effectiveLayers.includes('video')) {
                    chunk.video = false;
                    chunk.video_status = 'pending';
                }
                await saveChunk(cid, chunk);
            }
        }

        // Set per-asset states for selective regeneration (v2.0.0)
        // Cascade dirty layers through dependency graph before setting states
        const cascadedLayers = depGraph.resolveDirtyLayers(effectiveLayers);
        const assetUpdates = {};
        for (const layer of ['audio', 'image', 'video']) {
            if (cascadedLayers.includes(layer)) {
                assetUpdates[layer] = state.AssetState.DIRTY;
            }
        }
        if (Object.keys(assetUpdates).length > 0) {
            await state.setAssetStates(redis, bookId, chapter_id, scene_id, assetUpdates);
        }

        // Keep linear FSM in sync for backward compat (derived from asset states)
        const currentAssetStates = await state.getAssetStates(redis, bookId, chapter_id, scene_id);
        const derivedState = state.deriveLinearState(currentAssetStates);
        await state.setSceneStateWithBuildId(redis, bookId, chapter_id, scene_id, derivedState, buildId);

        // Clear dispatch leases so scheduler picks them up
        for (const layer of effectiveLayers) {
            const leaseKey = `animastor:dispatch-lease:${bookId}:${chapter_id}:${scene_id}:${layer}`;
            await redis.del(leaseKey);
        }

        // PG dirty propagation: mark cache entries as stale + update asset states
        try {
            for (const layer of effectiveLayers) {
                if (['audio', 'image', 'video'].includes(layer)) {
                    await storage.manifest.recordAsset(bookId, chapter_id, scene_id, layer, null);
                    await storage.postgres.repos.cache.markAssetStale(bookId, chapter_id, scene_id, layer);
                }
            }
            // Mark scene as dirty in asset_states
            const now = Math.floor(Date.now() / 1000);
            for (const layer of dirty_layers) {
                await storage.postgres.query(`
                    INSERT INTO asset_states (book_id, chapter_id, scene_id, layer, status, updated_at)
                    VALUES ($1, $2, $3, $4, 'dirty', $5)
                    ON CONFLICT(book_id, chapter_id, scene_id, layer)
                    DO UPDATE SET status = 'dirty', updated_at = EXCLUDED.updated_at
                `, [bookId, chapter_id, scene_id, layer, now]);
            }
        } catch (e) {
            log(`[PG-DIRTY] Propagation error for ${bookId}/${chapter_id}/${scene_id}: ${e.message}`);
        }

        // Re-add to active index so scheduler re-dispatches
        try {
            const activeScenes = require('./runtime/active-scenes-index');
            await activeScenes.addActiveScene(redis, bookId, chapter_id, scene_id);
        } catch (e) {
            // Runtime module may not be available
        }

        marked++;
    }
    return marked;
}

// ======================================================
// SELECTIVE REGENERATION — API ENDPOINTS
// ======================================================

/**
 * POST /api/v1/book/{bookId}/diff
 * Body: { new_book: BookData }
 * Receives a modified book, diffs against the stored "old" book,
 * returns the diff result without applying changes.
 */
app.post("/api/v1/book/:bookId/diff", (req, res) => {
    try {
        const { bookId } = req.params;
        const { new_book } = req.body;
        if (!new_book) {
            return res.status(400).json({ error: "new_book required" });
        }

        const oldBook = book.loadBook(bookId);
        if (!oldBook) {
            return res.status(404).json({ error: "Book not found" });
        }

        const diff = computeBookDiff(oldBook, new_book);
        res.json({
            book_id: bookId,
            ...diff
        });
    } catch (err) {
        console.error("[DIFF] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Map a generation profile to a layer config update and persist it.
 */
async function applyProfileToLayerConfig(redis, bookId, profile) {
    const update = {};
    if (profile === layerConfig.PROFILES.AUDIO_ONLY) {
        update.audio_enabled = true;
        update.image_enabled = false;
        update.video_enabled = false;
    } else if (profile === layerConfig.PROFILES.STORYBOARD) {
        update.audio_enabled = true;
        update.image_enabled = true;
        update.video_enabled = false;
    } else if (profile === layerConfig.PROFILES.FULL) {
        update.audio_enabled = true;
        update.image_enabled = true;
        update.video_enabled = true;
    }
    if (Object.keys(update).length > 0) {
        await layerConfig.set(redis, bookId, update);
    }
}

/**
 * Filter dirty scenes to a scope. `allScenes` is the canonical ordered list
 * of scenes in the book (used for from_current_scene).
 */
function filterDirtyScenesByScope(dirtyScenes, scope, chapterId, sceneId, allScenes) {
    if (!scope || scope === layerConfig.SCOPES.WHOLE_BOOK) return dirtyScenes;
    if (scope === layerConfig.SCOPES.CURRENT_SCENE) {
        if (!chapterId || !sceneId) return [];
        return dirtyScenes.filter(s => s.chapter_id === chapterId && s.scene_id === sceneId);
    }
    if (scope === layerConfig.SCOPES.CURRENT_CHAPTER) {
        if (!chapterId) return [];
        return dirtyScenes.filter(s => s.chapter_id === chapterId);
    }
    if (scope === layerConfig.SCOPES.FROM_CURRENT_SCENE) {
        if (!chapterId || !sceneId) return dirtyScenes;
        const fromIdx = (allScenes || []).findIndex(s => s.chapter_id === chapterId && s.scene_id === sceneId);
        if (fromIdx < 0) return [];
        const tail = (allScenes || []).slice(fromIdx);
        const tailKeys = new Set(tail.map(s => `${s.chapter_id}::${s.scene_id}`));
        return dirtyScenes.filter(s => tailKeys.has(`${s.chapter_id}::${s.scene_id}`));
    }
    return dirtyScenes;
}

/**
 * POST /api/v1/book/{bookId}/regenerate
 * Body: {
 *   new_book?: BookData,
 *   rebuild_all?: boolean,
 *   profile?: 'audio_only' | 'storyboard' | 'full',
 *   scope?: 'current_scene' | 'current_chapter' | 'from_current_scene' | 'whole_book',
 *   chapter_id?: string,
 *   scene_id?: string,
 * }
 * Saves the new book state, computes diff, marks dirty scenes,
 * and re-activates them in the runtime scheduler for selective regeneration.
 */
app.post("/api/v1/book/:bookId/regenerate", async (req, res) => {
    try {
        const { bookId } = req.params;
        const { new_book, rebuild_all, profile, scope, chapter_id, scene_id } = req.body;
        log(`[REGENERATE] Request for ${bookId}, new_book=${!!new_book}, rebuild_all=${!!rebuild_all}, profile=${profile || '-'}, scope=${scope || '-'}`);

        // Clear any previous cancellation flag so generation can proceed
        const windowModule = require('./runtime/scene-window');
        await windowModule.clearCancelFlag(redis, bookId);

        if (profile && !layerConfig.isValidProfile(profile)) {
            return res.status(400).json({ error: `Invalid profile: ${profile}` });
        }
        if (scope && !layerConfig.isValidScope(scope)) {
            return res.status(400).json({ error: `Invalid scope: ${scope}` });
        }
        if (scope && scope !== layerConfig.SCOPES.WHOLE_BOOK) {
            if (!chapter_id) {
                return res.status(400).json({ error: `scope=${scope} requires chapter_id` });
            }
            if ((scope === layerConfig.SCOPES.CURRENT_SCENE || scope === layerConfig.SCOPES.FROM_CURRENT_SCENE) && !scene_id) {
                return res.status(400).json({ error: `scope=${scope} requires scene_id` });
            }
        }

        // Persist scope so background auto-slide and assets-state know the scope.
        await genScope.setScope(redis, bookId, scope || layerConfig.SCOPES.WHOLE_BOOK, chapter_id, scene_id);

        let targetBook;

        if (new_book) {
            // Client provided new book state — diff against old on disk
            targetBook = new_book;
        } else {
            // No new book provided — use snapshot for diff (AI edit case)
            const snapshot = await loadBookSnapshot(bookId);
            if (!snapshot) {
                // No snapshot either — rebuild everything
                targetBook = book.loadBook(bookId);
                if (!targetBook) {
                    return res.status(404).json({ error: "Book not found and no snapshot available" });
                }
                const allScenesDirty = computeBookDiff({ chapters: [] }, targetBook).dirty_scenes;
                const allCanonical = book.collectScenes(targetBook);
                const scopedDirty = filterDirtyScenesByScope(allScenesDirty, scope, chapter_id, scene_id, allCanonical);
                const ids = await getAllChunks(bookId);
                let buildId = targetBook.manifest?.build_id || "default";
                if (ids.length > 0) {
                    const firstChunk = await getChunk(ids[0]);
                    if (firstChunk?.build_id) buildId = firstChunk.build_id;
                }
            const layerCfg = await layerConfig.get(redis, bookId);
            const marked = await markDirtyScenes(redis, bookId, buildId, scopedDirty, layerCfg);
                log(`[REGENERATE] No snapshot — marking ${marked} scenes as dirty (scope=${scope || 'whole_book'})`);
                await saveBookSnapshot(bookId);
                try {
                    const loadedBook = book.loadBook(bookId);
                    const windowModule = require('./runtime/scene-window');
                    const allScenesForScope = book.collectScenes(loadedBook);
                    await windowModule.setWindowBounds(redis, bookId, await genScope.getScope(redis, bookId), allScenesForScope);
                    await windowModule.slideWindow(redis, bookId, loadedBook, buildId);
                } catch (e) {}
                return res.json({
                    book_id: bookId,
                    build_id: buildId,
                    message: `Full regeneration triggered for ${marked} scenes (no snapshot)`,
                    dirty_scenes: scopedDirty,
                    summary: { total_scenes_old: 0, total_scenes_new: scopedDirty.length, changed: 0, added: scopedDirty.length, removed: 0 },
                    rebuild_all: true,
                    scope: scope || layerConfig.SCOPES.WHOLE_BOOK
                });
            }
            // Diff snapshot (old) against current book on disk (new)
            const currentBook = book.loadBook(bookId);
            if (!currentBook) {
                return res.status(404).json({ error: "Book not found on disk" });
            }
            const diffResult = computeBookDiff(snapshot, currentBook);
            if (diffResult.dirty_scenes.length === 0) {
                // Try full rebuild as fallback
                const allDirty = computeBookDiff({ chapters: [] }, currentBook).dirty_scenes;
                const allCanonical = book.collectScenes(currentBook);
                const scopedDirty = filterDirtyScenesByScope(allDirty, scope, chapter_id, scene_id, allCanonical);
                const ids = await getAllChunks(bookId);
                let buildId = currentBook.manifest?.build_id || "default";
                if (ids.length > 0) {
                    const firstChunk = await getChunk(ids[0]);
                    if (firstChunk?.build_id) buildId = firstChunk.build_id;
                }
            const layerCfg = await layerConfig.get(redis, bookId);
            const marked = await markDirtyScenes(redis, bookId, buildId, scopedDirty, layerCfg);
                await saveBookSnapshot(bookId);
                try {
                    const loadedBook = book.loadBook(bookId);
                    const windowModule = require('./runtime/scene-window');
                    const allScenesForScope = book.collectScenes(loadedBook);
                    await windowModule.setWindowBounds(redis, bookId, await genScope.getScope(redis, bookId), allScenesForScope);
                    await windowModule.slideWindow(redis, bookId, loadedBook, buildId);
                } catch (e) {}
                return res.json({
                    book_id: bookId,
                    build_id: buildId,
                    message: `No diff from snapshot — full regeneration of ${marked} scenes`,
                    dirty_scenes: scopedDirty,
                    summary: { total_scenes_old: 0, total_scenes_new: scopedDirty.length, changed: 0, added: scopedDirty.length, removed: 0 },
                    rebuild_all: true,
                    scope: scope || layerConfig.SCOPES.WHOLE_BOOK
                });
            }
            log(`[REGENERATE] Snapshot diff: ${diffResult.summary.changed} changed, ${diffResult.summary.added} added, ${diffResult.summary.removed} removed`);
            // Don't save again — book is already on disk. Just mark dirty + clear snapshot.
            const allCanonical = book.collectScenes(currentBook);
            const scopedDirty = filterDirtyScenesByScope(diffResult.dirty_scenes, scope, chapter_id, scene_id, allCanonical);
            const ids = await getAllChunks(bookId);
            let buildId = currentBook.manifest?.build_id || "default";
            if (ids.length > 0) {
                const firstChunk = await getChunk(ids[0]);
                if (firstChunk?.build_id) buildId = firstChunk.build_id;
            }
            const layerCfg = await layerConfig.get(redis, bookId);
            const marked = await markDirtyScenes(redis, bookId, buildId, scopedDirty, layerCfg);
            await saveBookSnapshot(bookId);
            if (diffResult.summary.added > 0 || diffResult.summary.changed > 0) {
                try {
                    const loadedBook = book.loadBook(bookId);
                    const windowModule = require('./runtime/scene-window');
                    const allScenesForScope = book.collectScenes(loadedBook);
                    await windowModule.setWindowBounds(redis, bookId, await genScope.getScope(redis, bookId), allScenesForScope);
                    await windowModule.slideWindow(redis, bookId, loadedBook, buildId);
                } catch (e) {}
            }
            return res.json({
                book_id: bookId,
                build_id: buildId,
                message: `Selective regeneration from snapshot: ${marked} scenes`,
                dirty_scenes: scopedDirty,
                summary: diffResult.summary,
                rebuild_all: false,
                scope: scope || layerConfig.SCOPES.WHOLE_BOOK
            });
        }

        // Standard flow: client provided new_book
        const oldBook = book.loadBook(bookId);
        if (!oldBook) {
            return res.status(404).json({ error: "Book not found" });
        }

        const diff = computeBookDiff(oldBook, targetBook);
        const allDirty = rebuild_all
            ? computeBookDiff({ chapters: [] }, targetBook).dirty_scenes
            : diff.dirty_scenes;
        const allCanonical = book.collectScenes(targetBook);
        const dirtyScenes = filterDirtyScenesByScope(allDirty, scope, chapter_id, scene_id, allCanonical);

        if (dirtyScenes.length === 0) {
            book.saveBookBundle(targetBook, null);
            if (profile) await applyProfileToLayerConfig(redis, bookId, profile);
            return res.json({
                book_id: bookId,
                message: "No changes detected, book saved",
                dirty_scenes: [],
                summary: diff.summary,
                scope: scope || layerConfig.SCOPES.WHOLE_BOOK
            });
        }

        book.saveBookBundle(targetBook, null);

        // Get build_id
        const ids = await getAllChunks(bookId);
        let buildId = targetBook.manifest?.build_id || "default";
        if (ids.length > 0) {
            const firstChunk = await getChunk(ids[0]);
            if (firstChunk?.build_id) buildId = firstChunk.build_id;
        }

        // Apply profile override (if any) before reading layer config
        if (profile) await applyProfileToLayerConfig(redis, bookId, profile);

        // Read layer config (audio/image/video enabled)
        const layerCfg = await layerConfig.get(redis, bookId);

        // Mark dirty scenes in Redis + scene state machine
        const marked = await markDirtyScenes(redis, bookId, buildId, dirtyScenes, layerCfg);

        log(`[REGENERATE] Marked ${marked}/${dirtyScenes.length} scenes as dirty for ${bookId} (scope=${scope || 'whole_book'}, profile=${profile || 'current'})`);

        // If there are new scenes, slide the window to pick them up
        if (diff.summary.added > 0 || diff.summary.changed > 0) {
            try {
                const loadedBook = book.loadBook(bookId);
                const windowModule = require('./runtime/scene-window');
                const allScenesForScope = book.collectScenes(loadedBook);
                await windowModule.setWindowBounds(redis, bookId, await genScope.getScope(redis, bookId), allScenesForScope);
                await windowModule.slideWindow(redis, bookId, loadedBook, buildId);
            } catch (e) {
                log(`[REGENERATE] Window slide (optional): ${e.message}`);
            }
        }

        res.json({
            book_id: bookId,
            build_id: buildId,
            message: `Selective regeneration triggered for ${marked} scenes`,
            dirty_scenes: dirtyScenes,
            summary: diff.summary,
            rebuild_all: !!rebuild_all,
            scope: scope || layerConfig.SCOPES.WHOLE_BOOK,
            profile: profile || layerConfig.resolveProfile(layerCfg)
        });
    } catch (err) {
        console.error("[REGENERATE] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// LAYER CONFIG — read/write per-book generation profile
// ======================================================

app.get("/api/v1/book/:bookId/layer-config", async (req, res) => {
    try {
        const { bookId } = req.params;
        const cfg = await layerConfig.get(redis, bookId);
        res.json({
            book_id: bookId,
            ...cfg,
            profile: layerConfig.resolveProfile(cfg),
        });
    } catch (err) {
        console.error("[LAYER-CONFIG GET] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.put("/api/v1/book/:bookId/layer-config", async (req, res) => {
    try {
        const { bookId } = req.params;
        const { audio_enabled, image_enabled, video_enabled, profile } = req.body || {};
        let update = { audio_enabled, image_enabled, video_enabled };
        if (profile) {
            if (!layerConfig.isValidProfile(profile)) {
                return res.status(400).json({ error: `Invalid profile: ${profile}` });
            }
            if (profile === layerConfig.PROFILES.AUDIO_ONLY) {
                update = { audio_enabled: true, image_enabled: false, video_enabled: false };
            } else if (profile === layerConfig.PROFILES.STORYBOARD) {
                update = { audio_enabled: true, image_enabled: true, video_enabled: false };
            } else if (profile === layerConfig.PROFILES.FULL) {
                update = { audio_enabled: true, image_enabled: true, video_enabled: true };
            }
        }
        const next = await layerConfig.set(redis, bookId, update);
        res.json({
            book_id: bookId,
            ...next,
            profile: layerConfig.resolveProfile(next),
        });
    } catch (err) {
        console.error("[LAYER-CONFIG PUT] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// ASSETS STATE — aggregate state of book assets
// Used by clients to detect generate vs regenerate mode
// ======================================================

function isInScope(chunk, scope, chapterId, sceneId) {
    if (!scope || scope === layerConfig.SCOPES.WHOLE_BOOK) return true;
    if (!chunk) return false;
    if (scope === layerConfig.SCOPES.CURRENT_SCENE) {
        return chunk.chapter_id === chapterId && chunk.scene_id === sceneId;
    }
    if (scope === layerConfig.SCOPES.CURRENT_CHAPTER) {
        return chunk.chapter_id === chapterId;
    }
    if (scope === layerConfig.SCOPES.FROM_CURRENT_SCENE) {
        return chunk.chapter_id === chapterId && chunk.scene_id === sceneId;
    }
    return true;
}

app.get("/api/v1/book/:bookId/assets-state", async (req, res) => {
    try {
        const { bookId } = req.params;
        const scope = (req.query.scope || '').toString() || null;
        const chapterId = (req.query.chapter_id || '').toString() || null;
        const sceneId = (req.query.scene_id || '').toString() || null;
        const ids = await getAllChunks(bookId);
        const total = ids.length;
        const cfg = await layerConfig.get(redis, bookId);

        let audioReady = 0;
        let imageReady = 0;
        let videoReady = 0;
        const inScopeIds = [];
        for (const cid of ids) {
            const c = await getChunk(cid);
            if (!c) continue;
            if (c.audio) audioReady++;
            if (c.image) imageReady++;
            if (c.video) videoReady++;
            if (isInScope(c, scope, chapterId, sceneId)) inScopeIds.push({ cid, c });
        }

        const allHaveAudio = total > 0 && audioReady === total;
        const anyHaveAudio = audioReady > 0;
        const allHaveImage = total > 0 && imageReady === total;
        const anyHaveImage = imageReady > 0;
        const allHaveVideo = total > 0 && videoReady === total;
        const anyHaveVideo = videoReady > 0;

        const hasAssets = anyHaveAudio;

        // Scope-aware counts
        const scopeTotal = inScopeIds.length;
        let scopeAudio = 0;
        let scopeImage = 0;
        let scopeVideo = 0;
        for (const { c } of inScopeIds) {
            if (c.audio) scopeAudio++;
            if (c.image) scopeImage++;
            if (c.video) scopeVideo++;
        }
        const scopeAllAudio = scopeTotal > 0 && scopeAudio === scopeTotal;
        const scopeAllImage = scopeTotal > 0 && scopeImage === scopeTotal;
        const scopeAllVideo = scopeTotal > 0 && scopeVideo === scopeTotal;

        res.json({
            book_id: bookId,
            scope: scope || 'whole_book',
            total_chunks: total,
            audio_ready: audioReady,
            image_ready: imageReady,
            video_ready: videoReady,
            has_audio: anyHaveAudio,
            has_image: anyHaveImage,
            has_video: anyHaveVideo,
            all_audio_ready: allHaveAudio,
            all_image_ready: allHaveImage,
            all_video_ready: allHaveVideo,
            has_assets: hasAssets,
            layer_config: cfg,
            profile: layerConfig.resolveProfile(cfg),
            scope_total: scopeTotal,
            scope_audio_ready: scopeAudio,
            scope_image_ready: scopeImage,
            scope_video_ready: scopeVideo,
            scope_all_audio_ready: scopeAllAudio,
            scope_all_image_ready: scopeAllImage,
            scope_all_video_ready: scopeAllVideo,
        });
    } catch (err) {
        console.error("[ASSETS-STATE] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// SLIDE WINDOW — triggers next batch of scenes
// ======================================================
app.post("/api/v1/book/:bookId/slide-window", async (req, res) => {
    try {
        const { bookId } = req.params;
        const loadedBook = book.loadBook(bookId);
        if (!loadedBook) {
            return res.status(404).json({ error: "Book not found" });
        }
        const buildId = loadedBook.manifest?.build_id || "default";
        const windowModule = require('./runtime/scene-window');
        const result = await windowModule.trySlideWindowOnComplete(redis, bookId, loadedBook, buildId);
        const windowStatus = await getBookWindowStatus(bookId);
        res.json({
            ok: true,
            book_id: bookId,
            started: result.started,
            remaining: result.remaining,
            reason: result.reason || null,
            ...windowStatus
        });
    } catch (err) {
        console.error("[SLIDE-WINDOW] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// CANCEL GENERATION — stops generation for a book
// ======================================================
app.post("/api/v1/book/:bookId/cancel-generation", async (req, res) => {
    try {
        const { bookId } = req.params;
        log(`[CANCEL] Cancelling generation for ${bookId}`);

        const windowModule = require('./runtime/scene-window');
        const scheduler = require('./runtime/runtime-scheduler');

        // Set the cancel flag so all in-flight checks stop immediately
        await windowModule.setCancelFlag(redis, bookId);

        // Remove all active scenes for this book so scheduler stops processing them
        await scheduler.clearBookFromActiveIndex(redis, bookId);

        // Clear generation scope so progress reports stop
        await genScope.clearScope(redis, bookId);

        // Reset window bounds so no more scenes are started
        await redis.set(windowModule.BOOK_SCENE_TOTAL(bookId), 0);
        await redis.set(windowModule.BOOK_SCENE_NEXT(bookId), 0);
        await redis.set(windowModule.BOOK_WINDOW_START(bookId), 0);

        log(`[CANCEL] Generation cancelled for ${bookId}`);
        res.json({ ok: true, book_id: bookId, message: "Generation cancelled" });
    } catch (err) {
        console.error("[CANCEL] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// MIDDLEWARE: Attach redis to request for debug API handlers
// ======================================================
app.use('/api/v1/debug/runtime', (req, res, next) => {
    req.redis = redis;
    next();
});

// [14] SERVER (DEBUG ENDPOINTS & START)
// ======================================================

// ═══════════════════════════════════════════════════════════
// ⚠️  НЕ УДАЛЯТЬ — раскомментировать на продакшене
//  Очистка устаревших билдов (TTL: BUILD_TTL_HOURS).
//  Отключена, чтобы не удалять output при разработке.
// ═══════════════════════════════════════════════════════════
// cleanupExpiredBuildsOnStartup();

app.get("/api/v1/debug/book/:bookId", (req, res) => {
    try {
        const loadedBook = book.loadBook(req.params.bookId)
        res.json({
            manifest: loadedBook.manifest,
            book: loadedBook.book,
            chapters: loadedBook.chapters.map(ch => ch.chapter)
        })
    } catch (err) {
        console.error(err)
        res.status(500).json({
            error: err.message
        })
    }
})

app.get("/api/v1/debug/runtime/:bookId", (req, res) => {
    try {
        const loadedBook = book.loadBook(req.params.bookId)
        const runtime = collectScenes(loadedBook)
        res.json(runtime)
    } catch (err) {
        console.error(err)
        res.status(500).json({
            error: err.message
        })
    }
})

app.get("/api/v1/debug/scene-state/:bookId/:chapterId/:sceneId", async (req, res) => {
    try {
        const { bookId, chapterId, sceneId } = req.params
        const state = await getSceneState(bookId, chapterId, sceneId)
        
        if (!state) {
            return res.json({ 
                state: SceneState.NEW,
                message: "Scene not yet initialized"
            })
        }
        
        res.json({
            book_id: bookId,
            chapter_id: chapterId,
            scene_id: sceneId,
            state: state.state,
            timestamp: state.updated_at,
            error: state.error || null,
            human_readable: {
                current: state.state,
                transitions: SceneTransitions[state.state] || []
            }
        })
    } catch (err) {
        console.error(err)
        res.status(500).json({
            error: err.message
        })
    }
})

app.get("/api/v1/debug/segments/:bookId", (req, res) => {
    try {
        const loadedBook = book.loadBook(req.params.bookId)
        const runtime = collectScenes(loadedBook)
        const result = runtime.map(entry => ({
            runtime_type: entry.runtime_type,
            chapter_id: entry.chapter_id,
            scene_id: entry.scene_id,
            scene_type: entry.scene_type || null,
            segments: buildSegments(entry) // ИСПОЛЬЗУЕМ ВОССТАНОВЛЕННУЮ ФУНКЦИЮ
        }))
        res.json(result)
    } catch (err) {
        console.error(err)
        res.status(500).json({
            error: err.message
        })
    }
})

// ======================================================
// DEBUG ENDPOINTS - EVENT JOURNAL & ASSET REGISTRY
// ======================================================

app.get("/api/v1/debug/scene-events/:bookId/:chapterId/:sceneId", async (req, res) => {
    try {
        const { bookId, chapterId, sceneId } = req.params
        const events = await journal.getSceneEvents(redis, bookId, chapterId, sceneId)
        res.json({
            bookId,
            chapterId,
            sceneId,
            eventCount: events.length,
            events
        })
    } catch (err) {
        console.error(err)
        res.status(500).json({
            error: err.message
        })
    }
})

app.get("/api/v1/debug/scene-assets/:bookId/:chapterId/:sceneId", async (req, res) => {
    try {
        const { bookId, chapterId, sceneId } = req.params
        const assets = await storage.registry.getSceneAssets(redis, bookId, chapterId, sceneId)
        res.json({
            bookId,
            chapterId,
            sceneId,
            assets
        })
    } catch (err) {
        console.error(err)
        res.status(500).json({
            error: err.message
        })
    }
})

app.get("/api/v1/debug/asset-registry/check", async (req, res) => {
    try {
        // Get all registered scenes from journal
        const journalPattern = 'animastor:event-journal:*'
        let cursor = 0
        const journalScenes = new Set()
        
        do {
            const result = await redis.scan(cursor, 'MATCH', journalPattern, 'COUNT', 500)
            cursor = parseInt(result[0], 10)
            const keys = result[1]
            
            for (const key of keys) {
                const parts = key.split(':')
                if (parts.length >= 4) {
                    // animastor:event-journal:bookId:chapterId:sceneId
                    const bookId = parts[2]
                    const chapterId = parts[3]
                    const sceneId = parts[4]
                    journalScenes.add(`${bookId}:${chapterId}:${sceneId}`)
                }
            }
        } while (cursor !== 0)
        
        // Get all registered scenes from asset registry
        const registryPattern = 'animastor:assets:*'
        cursor = 0
        const registryScenes = new Set()

        do {
            const result = await redis.scan(cursor, 'MATCH', registryPattern, 'COUNT', 500)
            cursor = parseInt(result[0], 10)
            const keys = result[1]

            for (const key of keys) {
                const parts = key.split(':')
                if (parts.length >= 4) {
                    // animastor:assets:bookId:chapterId:sceneId
                    const bookId = parts[2]
                    const chapterId = parts[3]
                    const sceneId = parts[4]
                    registryScenes.add(`${bookId}:${chapterId}:${sceneId}`)
                }
            }
        } while (cursor !== 0)

        // Calculate set operations manually (Node.js Set doesn't have intersection/difference)
        let intersection = 0
        let onlyJournal = 0
        let onlyRegistry = 0

        for (const scene of journalScenes) {
            if (registryScenes.has(scene)) {
                intersection++
            } else {
                onlyJournal++
            }
        }

        for (const scene of registryScenes) {
            if (!journalScenes.has(scene)) {
                onlyRegistry++
            }
        }

        res.json({
            journalScenes: journalScenes.size,
            registryScenes: registryScenes.size,
            scenesInBoth: intersection,
            scenesOnlyInJournal: onlyJournal,
            scenesOnlyInRegistry: onlyRegistry
        })
    } catch (err) {
        console.error(err)
        res.status(500).json({
            error: err.message
        })
    }
})

app.get("/api/v1/debug/asset-registry/orphan/:type", async (req, res) => {
    try {
        const { type } = req.params
        let pattern, charset
        
        switch (type) {
            case 'audio':
                pattern = 'animastor:assets:*:audio'
                break
            case 'image':
                pattern = 'animastor:assets:*:image'
                break
            case 'video':
                pattern = 'animastor:assets:*:video'
                break
            default:
                return res.status(400).json({ error: 'Invalid type: audio/image/video' })
        }
        
        let cursor = 0
        const orphanPaths = []
        
        do {
            const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500)
            cursor = parseInt(result[0], 10)
            const keys = result[1]
            
            for (const key of keys) {
                const assetRaw = await redis.hget(key, type)
                if (assetRaw) {
                    try {
                        const asset = JSON.parse(assetRaw)
                        if (asset.path && !fs.existsSync(asset.path)) {
                            const parts = key.split(':')
                            orphanPaths.push({
                                scene: `${parts[2]}:${parts[3]}:${parts[4]}`,
                                path: asset.path
                            })
                        }
                    } catch (e) {
                        // Skip invalid entries
                    }
                }
            }
        } while (cursor !== 0)
        
        res.json({
            type,
            orphanCount: orphanPaths.length,
            orphanPaths
        })
    } catch (err) {
        console.error(err)
        res.status(500).json({
            error: err.message
        })
    }
})

// ======================================================
// DEBUG ENDPOINT: RUNTIME STATUS
// ======================================================

app.get("/api/v1/debug/runtime", async (req, res) => {
    try {
        const { handleRuntimeDebug } = require('./api/runtime');
        await handleRuntimeDebug(req, res);
    } catch (err) {
        console.error("Runtime debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/leases", async (req, res) => {
    try {
        const { handleRuntimeLeases } = require('./api/runtime');
        await handleRuntimeLeases(req, res);
    } catch (err) {
        console.error("Runtime leases debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/dispatches", async (req, res) => {
    try {
        const { handleRuntimeDispatches } = require('./api/runtime');
        await handleRuntimeDispatches(req, res);
    } catch (err) {
        console.error("Runtime dispatches debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/quotas", async (req, res) => {
    try {
        const { handleRuntimeQuotas } = require('./api/runtime');
        await handleRuntimeQuotas(req, res);
    } catch (err) {
        console.error("Runtime quotas debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/metrics", async (req, res) => {
    try {
        const { handleRuntimeMetrics } = require('./api/runtime');
        await handleRuntimeMetrics(req, res);
    } catch (err) {
        console.error("Runtime metrics debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/counters", async (req, res) => {
    try {
        const { handleRuntimeCounters } = require('./api/runtime');
        await handleRuntimeCounters(req, res);
    } catch (err) {
        console.error("Runtime counters debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/drift", async (req, res) => {
    try {
        const { handleRuntimeDrift } = require('./api/runtime');
        await handleRuntimeDrift(req, res);
    } catch (err) {
        console.error("Runtime drift debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/snapshot/:bookId/:chapterId/:sceneId", async (req, res) => {
    try {
        const { handleRuntimeSnapshot } = require('./api/runtime');
        await handleRuntimeSnapshot(req, res);
    } catch (err) {
        console.error("Runtime snapshot debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/snapshots/:bookId", async (req, res) => {
    try {
        const { handleRuntimeSnapshots } = require('./api/runtime');
        await handleRuntimeSnapshots(req, res);
    } catch (err) {
        console.error("Runtime snapshots debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/failures", async (req, res) => {
    try {
        const { handleRuntimeFailures } = require('./api/runtime');
        await handleRuntimeFailures(req, res);
    } catch (err) {
        console.error("Runtime failures debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/retries", async (req, res) => {
    try {
        const { handleRuntimeRetries } = require('./api/runtime');
        await handleRuntimeRetries(req, res);
    } catch (err) {
        console.error("Runtime retries debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/retention", async (req, res) => {
    try {
        const { handleRuntimeRetention } = require('./api/runtime');
        await handleRuntimeRetention(req, res);
    } catch (err) {
        console.error("Runtime retention debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/v1/debug/runtime/cleanup/retention", async (req, res) => {
    try {
        const { handleRuntimeCleanupRetention } = require('./api/runtime');
        await handleRuntimeCleanupRetention(req, res);
    } catch (err) {
        console.error("Runtime cleanup retention error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/stuck-scenes", async (req, res) => {
    try {
        const { handleRuntimeStuckScenes } = require('./api/runtime');
        await handleRuntimeStuckScenes(req, res);
    } catch (err) {
        console.error("Runtime stuck scenes debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/v1/debug/runtime/stuck-scenes", async (req, res) => {
    try {
        const { handleRuntimeClearStuckScenes } = require('./api/runtime');
        await handleRuntimeClearStuckScenes(req, res);
    } catch (err) {
        console.error("Runtime clear stuck scenes error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/circuits", async (req, res) => {
    try {
        const { handleRuntimeCircuits } = require('./api/runtime');
        await handleRuntimeCircuits(req, res);
    } catch (err) {
        console.error("Runtime circuits debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/priorities", async (req, res) => {
    try {
        const { handleRuntimePriorities } = require('./api/runtime');
        await handleRuntimePriorities(req, res);
    } catch (err) {
        console.error("Runtime priorities debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/fairness", async (req, res) => {
    try {
        const { handleRuntimeFairness } = require('./api/runtime');
        await handleRuntimeFairness(req, res);
    } catch (err) {
        console.error("Runtime fairness debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/retry-budgets", async (req, res) => {
    try {
        const { handleRuntimeRetryBudgets } = require('./api/runtime');
        await handleRuntimeRetryBudgets(req, res);
    } catch (err) {
        console.error("Runtime retry budgets debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/policies", async (req, res) => {
    try {
        const { handleRuntimePolicies } = require('./api/runtime');
        await handleRuntimePolicies(req, res);
    } catch (err) {
        console.error("Runtime policies debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/workloads", async (req, res) => {
    try {
        const { handleRuntimeWorkloads } = require('./api/runtime');
        await handleRuntimeWorkloads(req, res);
    } catch (err) {
        console.error("Runtime workloads debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/v1/debug/runtime/costs", async (req, res) => {
    try {
        const { handleRuntimeCosts } = require('./api/runtime');
        await handleRuntimeCosts(req, res);
    } catch (err) {
        console.error("Runtime costs debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// EMERGENCY VIDEO RECOVERY
// ======================================================
// Scans all scenes and re-adds IMAGE_READY scenes to active index
// so the scheduler picks them up for video dispatch.
app.post("/api/v1/debug/runtime/recover-video", async (req, res) => {
    try {
        const activeScenes = require('./runtime/active-scenes-index');
        const sceneState = require('./state');
        const keys = await redis.keys(`${sceneState.SCENE_STATE_KEY_PREFIX}:*`);
        let added = 0;
        let skipped = 0;
        let reset = 0;
        for (const key of keys) {
            const raw = await redis.get(key);
            if (!raw) continue;
            const data = JSON.parse(raw);

            // Reset video_ready/video_generating/video_pending → image_ready for video retry
            if (data.state === 'video_ready' || data.state === 'video_generating' || data.state === 'image_ready' || data.state === 'video_pending') {
                const parts = key.split(':');
                const bookId = parts[2];
                const chapterId = parts[3];
                const sceneId = parts[4];

                // Check if video actually exists on disk
                const videoPath = `/data/output/${data.build_id}/${bookId}_${chapterId}_${sceneId}.mp4`;
                if (fs.existsSync(videoPath)) {
                    skipped++;
                    continue;
                }

                // Reset state to image_ready for video dispatch
                data.state = 'image_ready';
                data.updated_at = Date.now();
                data.error = null;
                await redis.set(key, JSON.stringify(data));

                // Clear dispatch lease so scheduler can re-dispatch
                const leaseKey = `animastor:dispatch-lease:${bookId}:${chapterId}:${sceneId}:video`;
                await redis.del(leaseKey);
                log(`[VIDEO-RECOVERY] Cleared lease: ${leaseKey}`);

                // Reset chunk video flags
                const allChunks = await redis.keys(`animastor:chunk:${bookId}_${chapterId}_${sceneId}_*`);
                for (const ck of allChunks) {
                    const cr = await redis.get(ck);
                    if (cr) {
                        const ch = JSON.parse(cr);
                        ch.video = false;
                        ch.video_status = 'pending';
                        await redis.set(ck, JSON.stringify(ch));
                    }
                }

                await activeScenes.addActiveScene(redis, bookId, chapterId, sceneId);

                // Clear dedup keys for all video job variants (main + multi-group)
                const dedupPattern = `animastor:job:${bookId}_${chapterId}_${sceneId}*`;
                const dedupKeys = await redis.keys(dedupPattern);
                if (dedupKeys.length) {
                    await redis.del(...dedupKeys);
                    log(`[VIDEO-RECOVERY] Cleared ${dedupKeys.length} dedup key(s)`);
                }

                added++;
                log(`[VIDEO-RECOVERY] Reset ${bookId}/${chapterId}/${sceneId}: video_ready/image_generating → image_ready, added to active index`);
            } else {
                skipped++;
            }
        }

        // Nuke stale processing items so they don't interfere
        const procCount = await redis.llen('animastor:processing');
        if (procCount > 0) {
            await redis.del('animastor:processing');
            log(`[VIDEO-RECOVERY] Cleared animastor:processing (${procCount} stale items)`);
        }

        res.json({ added, reset, skipped, total: keys.length });
    } catch (err) {
        console.error("[VIDEO-RECOVERY] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Load workflow templates
const wfLoader = require('./workflows/workflow-loader');
wfLoader.loadWorkflows();

// Initialize PostgreSQL persistent storage
(async () => {
    try {
        await storage.postgres.initialize();
        log('[PG] Persistent storage initialized');
    } catch (err) {
        console.error('[PG] Failed to initialize:', err.message);
        process.exit(1);
    }
})();

app.listen(PORT, () => {
    log("🚀 Backend v15 PHASE 10 POLICY ENGINE + WORKLOAD + COST-AWARE SCHEDULING ACTIVATED");

    // Start the runtime loop
    const loopResult = runtime.loop.start(redis, runtime.scheduler.SCHEDULER_TICK_MS);
    if (loopResult.success) {
        log(`[RUNTIME] Loop started with ${runtime.scheduler.SCHEDULER_TICK_MS}ms interval`);
        log(`[RUNTIME] Dispatch Engine: scheduler is authority, dispatch engine launches jobs`);
        log(`[RUNTIME] Leases: single dispatch guarantee per scene:stage`);
        log(`[RUNTIME] Backpressure: ${JSON.stringify(runtime.dispatch.QUOTAS)}`);
        log(`[RUNTIME] Circuit Breakers: audio/image/video/redis/filesystem/worker`);
        log(`[RUNTIME] Retry Budgets: per-scene, per-type, global limits`);
        log(`[RUNTIME] Priority Scheduling: high/normal/low levels with starvation boost`);
        log(`[RUNTIME] Runtime Fairness: round-robin, quota partitioning, throttling`);
        log(`[RUNTIME] Lease Renewal: renewable leases with 30s interval`);
        log(`[RUNTIME] Counter Reconciliation: leases=truth, counters=derived`);
        log(`[RUNTIME] Failure Taxonomy: transient, permanent, infrastructure, orchestration`);
        log(`[RUNTIME] Runtime Snapshots: point-in-time scene state views`);
        log(`[RUNTIME] Retry Policies: per-failure-type backoff and classification`);
        log(`[RUNTIME] Retention: event journal, metrics, snapshots cleanup`);
        log(`[RUNTIME] Policy Engine: unified runtime decision authority`);
        log(`[RUNTIME] Workload Classification: LIGHT/MEDIUM/HEAVY/EXTREME classes`);
        log(`[RUNTIME] Cost Estimation: GPU seconds prediction with time-based inflation`);
        log(`[RUNTIME] Cost-Aware Scheduling: budget tracking per book`);
        log(`[RUNTIME] Adaptive Throttling: dynamic rate control under overload`);
        log(`[RUNTIME] Priority Normalization: unified priority scoring system`);
    } else {
        log(`[RUNTIME] Loop start failed: ${loopResult.reason}`);
    }

    // Recover Redis from disk files (if Redis was cleared but output files exist)
    recoverAllBooksFromDisk().catch(err => {
        console.error("[RECOVERY] Fatal error during startup recovery:", err);
    });

    // Reconcile leaked active counters (e.g. after crash/restart)
    const { reconcileCounters } = require('./runtime/counter-reconciliation');
    // Resume incomplete background generation sessions from PostgreSQL
    reconcileCounters(redis).catch(err => {
        console.error("[RECOVERY] Counter reconciliation error:", err);
    });
});

// ======================================================
// [CACHE] Cache manifest API endpoint
// ======================================================

/**
 * GET /api/v1/book/{bookId}/cache
 * Returns per-scene cache status from PG manifest.
 */
app.get("/api/v1/book/:bookId/cache", async (req, res) => {
    try {
        const { bookId } = req.params;
        const [allEntries, staleResult, readyResult] = await Promise.all([
            storage.postgres.repos.cache.getCacheSummary(bookId),
            storage.postgres.query(`
                SELECT * FROM cache_entries
                WHERE book_id = $1 AND status IN ('stale', 'pending')
                ORDER BY scene_id, asset_type
            `, [bookId]),
            storage.postgres.query(`
                SELECT * FROM cache_entries
                WHERE book_id = $1 AND status = 'ready'
                ORDER BY scene_id, asset_type
            `, [bookId]),
        ]);

        const staleAssets = staleResult.rows;
        const readyAssets = readyResult.rows;

        const sceneStatus = {};
        for (const asset of readyAssets) {
            const key = `${asset.chapter_id}:${asset.scene_id}`;
            if (!sceneStatus[key]) sceneStatus[key] = { chapter_id: asset.chapter_id, scene_id: asset.scene_id, ready: [], stale: [], pending: [] };
            sceneStatus[key].ready.push(asset.asset_type);
        }
        for (const asset of staleAssets) {
            const key = `${asset.chapter_id}:${asset.scene_id}`;
            if (!sceneStatus[key]) sceneStatus[key] = { chapter_id: asset.chapter_id, scene_id: asset.scene_id, ready: [], stale: [], pending: [] };
            sceneStatus[key][asset.status === 'stale' ? 'stale' : 'pending'].push(asset.asset_type);
        }

        res.json({
            book_id: bookId,
            summary: {
                total: allEntries.total,
                ready: allEntries.ready,
                stale: allEntries.stale,
                pending: allEntries.pending
            },
            scenes: Object.values(sceneStatus)
        });
    } catch (err) {
        console.error("[CACHE] Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// CLEAR CACHE — удаляет сгенерированные файлы книги, Redis-метаданные и SQLite-записи
// ======================================================
app.delete("/api/v1/book/:bookId/cache", async (req, res) => {
    try {
        const { bookId } = req.params;

        // 1. Собрать buildId из чанков
        const chunkIds = await getAllChunks(bookId);
        const buildIds = new Set();
        const buildId = req.query.build_id || null;
        if (buildId) {
            buildIds.add(buildId);
        } else {
            for (const cid of chunkIds) {
                const c = await getChunk(cid);
                if (c?.build_id) buildIds.add(c.build_id);
            }
        }

        // 2. Удалить build-директории
        let deletedBuilds = 0;
        for (const bid of buildIds) {
            const result = cleanupBuild(bid);
            if (result.ok) deletedBuilds++;
        }

        // 3. Удалить все Redis-ключи для этой книги
        const redisPatterns = [
            `animastor:chunk:${bookId}_*`,
            `animastor:chunks:${bookId}`,
            `animastor:assets:${bookId}:*`,
            `animastor:scene-state:${bookId}:*`,
            `animastor:dispatch-lease:${bookId}:*`,
            `animastor:dispatch-meta:${bookId}:*`,
            `animastor:scene-video:${bookId}:*`,
            `animastor:scene-transition-lock:${bookId}:*`,
            `animastor:layer-config:${bookId}`,
            `animastor:book-snapshot:${bookId}`,
            `animastor:book-scenes:${bookId}:*`,
            `animastor:event-journal:${bookId}:*`,
            `animastor:job:${bookId}_*`,
            `animastor:audio-scene-lock:${bookId}:*`,
            `animastor:video-lock:${bookId}:*`,
            `animastor:scene-audio-status:${bookId}:*`,
            `animastor:iu:${bookId}_*`,
            `animastor:iu-registry:${bookId}_*`

        ];

        let redisDeleted = 0;
        for (const pattern of redisPatterns) {
            try {
                let cursor = 0;
                do {
                    const scanResult = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
                    cursor = parseInt(scanResult[0], 10);
                    const keys = scanResult[1];
                    if (keys.length > 0) {
                        redisDeleted += await redis.del(keys);
                    }
                } while (cursor !== 0);
            } catch (_) {}
        }

        // 4. Очистить PG-записи
        try { await storage.postgres.repos.cache.deleteBookCache(bookId); } catch (_) {}
        try {
            await storage.postgres.query('DELETE FROM asset_states WHERE book_id = $1', [bookId]);
            await storage.postgres.query('DELETE FROM scenes WHERE book_id = $1', [bookId]);
            await storage.postgres.query('DELETE FROM image_units WHERE book_id = $1', [bookId]);
            await storage.postgres.repos.book.deleteBookSnapshots(bookId);
        } catch (_) {}

        // 4.5. Очистить active-scenes index для этой книги
        try {
            const activeScenesKey = 'animastor:active-scenes';
            const allActive = await redis.smembers(activeScenesKey);
            const toRemove = allActive.filter(key => key.startsWith(bookId + ':'));
            if (toRemove.length > 0) {
                await redis.srem(activeScenesKey, toRemove);
                log(`[CACHE] Removed ${toRemove.length} scenes from active index`);
            }
        } catch (_) {}

        // 4.6. Сбросить runtime-счётчики
        try {
            await redis.set('animastor:runtime:active-audio', '0');
            await redis.set('animastor:runtime:active-image', '0');
            await redis.set('animastor:runtime:active-video', '0');
        } catch (_) {}

        // 5. Сбросить активный счётчик (если он есть в runtime)
        try {
            const { reconcileCounters } = require('./runtime/counter-reconciliation');
            await reconcileCounters(redis);
        } catch (_) {}

        // 6. Очистить gpu-hub очереди для этой книги
        try {
            const hubUrl = config.HUB_URL;
            if (hubUrl) {
                const url = new URL(`${hubUrl}/queue/clear`);
                url.searchParams.set('book_id', bookId);
                await fetch(url.toString(), { method: 'DELETE' });
                log(`[CACHE] Sent queue clear to gpu-hub for book ${bookId}`);
            }
        } catch (_) {
            log('[CACHE] gpu-hub queue clear skipped (not available)');
        }

        log(`[CACHE] Cleared cache for book ${bookId}: ${deletedBuilds} build dirs, ${redisDeleted} redis keys`);

        res.json({
            ok: true,
            book_id: bookId,
            deleted_builds: deletedBuilds,
            deleted_redis_keys: redisDeleted,
            deleted_chunks: chunkIds.length
        });
    } catch (err) {
        console.error("[CACHE-DELETE] Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// AUDIO RESULT RECOVERY - FOR NETWORK ISSUE HANDLING
// ======================================================
// This function retrieves audio results from Redis and saves them to disk
// It's needed when webhook callbacks fail (e.g., network issues)
async function recoverAudioResults() {
    try {
        // Use SCAN instead of KEYS to avoid blocking Redis
        let cursor = 0;
        let resultCount = 0;
        const resultKeys = [];

        do {
            const scanResult = await redis.scan(cursor, 'MATCH', 'animastor:result:*', 'COUNT', 100);
            cursor = parseInt(scanResult[0], 10);
            resultKeys.push(...scanResult[1]);
        } while (cursor !== 0);

        // Log when checking even if no results
        if (resultKeys.length > 0) {
            log(`🔍 Audio recovery: found ${resultKeys.length} pending results`);
        } else {
            return; // No pending results, skip
        }

        for (const resultKey of resultKeys) {
            const resultData = await redis.get(resultKey);
            if (!resultData) continue;

            const job_id = resultKey.replace('animastor:result:', '');

            // Handle image results by calling the task result handler
            if (job_id.endsWith(':image')) {
                try {
                    await handleTaskResult(job_id, resultData, 'demo_static_007');
                    await redis.del(resultKey);
                    log(`[RECOVERY] Processed pending image result: ${job_id}`);
                } catch (e) {
                    log(`[RECOVERY] Failed to process image result ${job_id}: ${e.message}`);
                }
                continue;
            }

            // Handle image results (IU images)
            if (job_id.endsWith(':image')) {
                const assetId = job_id.replace(/:image$/, '');
                const outputDir = config.OUTPUT_DIR;
                const buildId = 'demo_static_007'; // will try all build dirs
                const imgPath = path.join(outputDir, buildId, `${assetId}.png`);
                if (!fs.existsSync(imgPath)) {
                    // Try to find asset by scanning directories
                    const dirs = fs.readdirSync(outputDir).filter(d => fs.statSync(path.join(outputDir, d)).isDirectory());
                    let found = false;
                    for (const dir of dirs) {
                        const candidate = path.join(outputDir, dir, `${assetId}.png`);
                        if (fs.existsSync(candidate)) {
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        // Need to process this result via HTTP handler
                        try {
                            await handleTaskResult(job_id, resultData, 'demo_static_007');
                        } catch (e) {
                            log(`[RECOVERY] Failed to process image result ${job_id}: ${e.message}`);
                        }
                    }
                }
                await redis.del(resultKey);
                continue;
            }

            const baseId = job_id.replace(/:audio$/, '');

            // Skip if we already have the canonical file
            const chunk = await getChunk(baseId);
            if (!chunk) {
                log(`⚠️ Audio recovery: chunk not found - ${baseId}`);
                continue;
            }
            
            const buildId = chunk.build_id;
            const bookId = chunk.book_id;
            const chapterId = chunk.chapter_id;
            const sceneId = chunk.scene_id;
            
            const canonicalAudioPath = getSceneAudioPath(buildId, bookId, chapterId, sceneId);
            if (fs.existsSync(canonicalAudioPath)) {
                // Already processed, cleanup result key
                await redis.del(resultKey);
                log(`✔️ Audio recovery: already exists - ${canonicalAudioPath}`);
                continue;
            }
            
            // Check if canonical is ready
            if (await isSceneAudioReady(buildId, bookId, chapterId, sceneId)) {
                await redis.del(resultKey);
                log(`✔️ Audio recovery: already ready - ${canonicalAudioPath}`);
                continue;
            }
            
            // Save chunk file from result
            const chunkPath = audio.getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}_${chunk.chunk_index}.mp3`);
            if (fs.existsSync(chunkPath)) {
                // Chunk already saved, try to merge
                triggerAudioMerge(chunk).catch(err => {
                    log(`❌ Audio merge after recovery failed: ${err.message}`);
                });
                continue;
            }
            
            // Save chunk from result
            try {
                const chunkDir = path.dirname(chunkPath);
                if (!fs.existsSync(chunkDir)) {
                    fs.mkdirSync(chunkDir, { recursive: true });
                }
                const saveResult = filesystem.saveFile(resultData, chunkPath);
                if (saveResult) {
                    log(`💾 Audio recovery: saved chunk - ${chunkPath}`);
                    
                    // Update chunk metadata
                    chunk.audio = true;
                    await saveChunk(baseId, chunk);
                    
                    // Try to merge
                    triggerAudioMerge(chunk).catch(err => {
                        log(`❌ Audio merge after recovery failed: ${err.message}`);
                    });
                }
            } catch (err) {
                log(`❌ Audio recovery save error: ${err.message}`);
            }
            
            // Cleanup result key
            await redis.del(resultKey);
        }
    } catch (err) {
        log(`❌ Audio recovery error: ${err.message}`);
    }
}

// Start audio result recovery loop
setInterval(() => {
    log(`⏰ Audio recovery: tick`);
    recoverAudioResults().catch(err => {
        log(`❌ Audio recovery error: ${err.message}`);
    });
}, 5000); // Run every 5 seconds
log(`[AUDIOROCUS] Recovery loop started: checking Redis for missed results...`);

// ======================================================
