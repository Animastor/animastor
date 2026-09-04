// ======================================================
// Book Deletion / Purge boundary (Phase 4)
// ======================================================
// Single architectural seam for deleting a book. Route controllers must NOT
// implement book deletion cascade themselves — they call deleteBook() and
// map its result/errors to HTTP. The full cascade/purge knowledge lives
// here (moved verbatim from core-routes.cjs DELETE handler — behavior
// preserved; internal detail is now hidden behind the contract).
//
// Deletion spans (behavior preserved exactly):
//   Canonical     — disk bundle removal (book.resetBook) + snapshot file.
//   Runtime       — Redis runtime state (cancelled-workers signal, active
//                   audio/image/video, all book-keyed key families via
//                   cleanBookRedisKeys), build output dirs, GPU-hub queue.
//   Derived/PG    — cancel-first agent sessions, then per-table deletes
//                   (derived indexes, assets, tasks, events; books LAST
//                   for FK order).
//
// This file owns the ORDER (cancel → runtime → derived/canonical) so future
// decomposition only changes internals, not the contract.

const fs = require('fs');
const path = require('path');

/**
 * @param {Object} deps - injected adapters:
 *   book            - canonical book module (resetBook)
 *   redis           - ioredis client
 *   storage         - { postgres: { query } }
 *   config          - runtime config (BOOKS_DIR, OUTPUT_DIR)
 *   getAllChunks    - redis helper
 *   getChunk        - redis helper
 *   cleanBookRedisKeys - redis purge helper (book-keyed key families)
 *   log             - logger (optional)
 *   setCancelFlag   - runtime scene-window cancel flag adapter (required;
 *                     injected from backend.cjs, keeps the book layer free
 *                     of direct runtime-module requires)
 */
function createBookDeletion(deps) {
    const {
        book, redis, storage, config,
        getAllChunks, getChunk, cleanBookRedisKeys,
        log = console.log,
        setCancelFlag = null,
    } = deps;

    /**
     * Delete a book and everything derived from it.
     * @param {string} bookId
     * @param {{ onEvent?: (msg: string) => void }} [options]
     * @returns {Promise<{ deleted: boolean, book_id: string }>}
     *   Throws only on unexpected top-level failures; every individual
     *   cascade step is best-effort (warn + continue), matching the
     *   historical route behavior.
     */
    async function deleteBook(bookId, options = {}) {
        const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

        // ── 1. Canonical: remove the disk bundle + snapshot file ──
        await book.resetBook(bookId);
        const snapshotPath = path.join(config.BOOKS_DIR || '/data/books', `${bookId}.snapshot.json`);
        if (fs.existsSync(snapshotPath)) {
            try { fs.unlinkSync(snapshotPath); } catch (_) {}
        }

        // ── 2. Build output dirs (runtime artifacts on disk) ──
        const OUTPUT_DIR = config.OUTPUT_DIR;
        const chunkIds = await getAllChunks(bookId).catch(() => []);
        const buildIds = new Set();
        for (const cid of chunkIds) {
            try {
                const chunk = await getChunk(cid);
                if (chunk?.build_id) buildIds.add(chunk.build_id);
            } catch (_) {}
        }
        for (const buildId of buildIds) {
            const buildPath = path.join(OUTPUT_DIR, buildId);
            if (fs.existsSync(buildPath)) {
                try { fs.rmSync(buildPath, { recursive: true, force: true }); } catch (_) {}
            }
        }
        if (fs.existsSync(OUTPUT_DIR)) {
            for (const entry of fs.readdirSync(OUTPUT_DIR)) {
                if (entry.startsWith(bookId)) {
                    const entryPath = path.join(OUTPUT_DIR, entry);
                    try { fs.rmSync(entryPath, { recursive: true, force: true }); } catch (_) {}
                }
            }
        }

        // ── 3. Cancel-first ordering (runtime signal before purge) ──
        // КРИТИЧЕСКИ важно: сначала ОТМЕНИТЬ активные agent-сессии, потом чистить.
        // Если сначала почистить Redis и PG, running agent никогда не узнает об отмене:
        //   - cleanBookRedisKeys удалит animastor:cancelled-workers:{bookId}
        //   - DELETE agent_sessions удалит все сессии
        // Агент продолжит работу — он не может обнаружить отмену.
        //
        // Сначала сигнализируем агенту через cancelled-workers (Redis) и статус
        // сессий (PG), потом чистим Redis и PG. Агент увидит отмену на следующем
        // checkCancelled().
        try {
            await redis.sadd(`animastor:cancelled-workers:${bookId}`, 'vbook');
            log(`[DELETE-BOOK] Set cancelled-workers for ${bookId} — VBook agent will be stopped`);
        } catch (redisErr) {
            console.warn(`[DELETE-BOOK] Failed to set cancelled-workers: ${redisErr.message}`);
        }
        try {
            await storage.postgres.query(
                `UPDATE agent_sessions SET status = 'cancelled', updated_at = $1 WHERE book_id = $2 AND status IN ('running', 'paused')`,
                [Math.floor(Date.now() / 1000), bookId]
            );
        } catch (pgErr) {
            console.warn(`[DELETE-BOOK] Failed to cancel agent sessions: ${pgErr.message}`);
        }

        // ── 4. Runtime / ephemeral state (Redis) ──
        // setCancelFlag is injected (runtime scene-window adapter) — the book
        // layer itself does not require runtime modules (see
        // tests/architecture/dependency-guardrails.test.js BOOK_ALLOWLIST).
        if (typeof setCancelFlag !== 'function') {
            throw new Error('bookDeletion: setCancelFlag adapter is required');
        }
        await setCancelFlag(redis, bookId);
        await redis.del('animastor:runtime:active-audio');
        await redis.del('animastor:runtime:active-image');
        await redis.del('animastor:runtime:active-video');
        await cleanBookRedisKeys(redis, bookId);

        // ── 5. Derived PostgreSQL state — clean ALL PG tables, each with an
        //    individual try/catch so one failure (e.g. table doesn't exist in
        //    an older schema) doesn't block cleanup of the remaining tables ──
        const pgTables = [
            // Per-layer & asset tables (book_id as plain TEXT, no FK)
            'image_units',
            'scenes',
            'asset_states',
            'asset_dependencies',
            'generation_tasks',
            'reconciliation_events',
            'output_manifests',
            'cache_entries',
            'book_source',
            'agent_sessions',
            'book_generation_sessions',
            'generation_cancellations',
            'ai_chat_sessions',
            'book_events',
            'scene_assets',
            // Coreference resolution tables
            'character_resolution_runs',
            'character_window_candidates',
            'sentence_resolutions',
            'character_mentions',
            'character_aliases',
            // Tables with FK to books — delete before books
            'storyboard_elements',
            'audio_layers',
            'book_snapshots',
            // books LAST (may have FK cascades)
            'books',
        ];
        for (const table of pgTables) {
            try {
                await storage.postgres.query(`DELETE FROM ${table} WHERE book_id = $1`, [bookId]);
            } catch (tblErr) {
                // Table may not exist in older schemas — non-fatal
                console.warn(`[DELETE-BOOK] DB cleanup: ${table}: ${tblErr.message}`);
            }
        }

        // ── 6. GPU-hub queue clear (best-effort, external runtime) ──
        try {
            const HUB_URL = process.env.HUB_URL || 'https://animastor.in/gpu';
            const hubHeaders = { method: 'DELETE' };
            const apiKey = process.env.GPU_HUB_API_KEY;
            if (apiKey) {
                hubHeaders.headers = { 'x-api-key': apiKey };
            }
            await fetch(`${HUB_URL}/queue/clear?book_id=${bookId}`, hubHeaders).catch(() => {});
        } catch (_) {}

        log(`[DELETE-BOOK] Book completely deleted: ${bookId}`);
        if (onEvent) onEvent(`Book completely deleted: ${bookId}`);
        return { deleted: true, book_id: bookId };
    }

    return { deleteBook };
}

module.exports = { createBookDeletion };
