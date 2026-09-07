// ======================================================
// PLAYER ROUTES — SHARED CONTOUR HELPERS (seam)
// ======================================================
// Dependency-injection seam shared by every player route sub-module.
// The playback contour must reach host infrastructure ONLY through:
//   - deps.playerModel   (Phase 6 facade — book content reads)
//   - deps.outputRoot    (artifact root; replaces direct config.OUTPUT_DIR
//                         reads — booksRoot injection precedent fb411c61)
//   - deps.playerPorts   ({ assertBookAccess, computeVideoStartMs,
//                         computeWaveform } — host implementations injected
//                         by the composition root; the player must not
//                         import auth middleware, video-timeline (which
//                         knows workflows/), or waveform-service directly)
//   - deps.redis / deps.getChunk / ... (runtime state — infrastructural,
//                         stays host-side; a full playback-projection port
//                         is deliberately premature at this stage)
//
// Grammar for artifact filenames comes from artifact-naming.cjs — never
// reconstructed ad-hoc in route handlers.
//
// Static dependency rules are guarded by
// tests/architecture/player-route-split.test.js and Phase 6 T3-style scans.

const path = require('path');
const fs = require('fs');
const naming = require('./artifact-naming.cjs');

/**
 * Create the shared player-route context.
 *
 * @param {object} deps routeDeps subset (see player-routes.cjs)
 *   - outputRoot: absolute artifact root (config.OUTPUT_DIR injected by
 *     the composition root). Semantics preserved: joined as
 *     path.join(outputRoot, buildId, filename) — absolute/relative behavior
 *     identical to the previous OUTPUT_DIR joins.
 *   - playerPorts: { assertBookAccess, computeVideoStartMs, computeWaveform }
 */
function createPlayerShared(deps) {
    const { playerModel, playerPorts, redis, getChunk, iuRepo, log } = deps;
    const outputRoot = deps.outputRoot;
    const ports = playerPorts || {};

    // ── Build id resolution ────────────────────────────────────────────
    // manifest.json is the single source of truth for build_id (Phase 6:
    // the read goes through the Player boundary, not a raw loader). The
    // requested value is used only as a fallback when the manifest can't
    // be read; the client build_id is a cache key, never an address.
    function getEffectiveBuildId(bookId, requestedBuildId, logFn) {
        const _log = logFn || (() => {});
        try {
            const loadedBook = playerModel.loadBook(bookId);
            if (loadedBook && loadedBook.manifest && loadedBook.manifest.build_id) {
                const manifestBuildId = loadedBook.manifest.build_id;
                if (requestedBuildId && manifestBuildId !== requestedBuildId) {
                    _log(`buildId resolved: "${requestedBuildId}" → "${manifestBuildId}" for ${bookId}`);
                }
                return manifestBuildId;
            }
        } catch (_) {}
        return requestedBuildId || 'default';
    }

    // ── Artifact paths (naming grammar seam) ─────────────────────────────
    function buildDir(buildId) {
        return path.join(outputRoot, buildId);
    }
    function sceneAudioPath(buildId, bookId, chapterId, sceneId) {
        return path.join(buildDir(buildId), naming.sceneAudioName(bookId, chapterId, sceneId));
    }
    function sceneVideoPath(buildId, bookId, chapterId, sceneId) {
        return path.join(buildDir(buildId), naming.sceneVideoName(bookId, chapterId, sceneId));
    }
    function sceneImagePath(buildId, bookId, chapterId, sceneId) {
        return path.join(buildDir(buildId), naming.sceneImageName(bookId, chapterId, sceneId));
    }

    // ── Book ownership guard for chunk-keyed routes ──────────────────────
    // The target book comes from the chunk record, not the URL, so it is
    // verified in-handler after the chunk is loaded. Pre-auth passes
    // through (existing behaviour); authenticated requests must own the
    // book. Returns true (and responds 403) when access is denied.
    // The host middleware implementation arrives via playerPorts
    // .assertBookAccess (middleware/auth-context.checkBookAccess injected
    // at the composition root — the player package must not own auth).
    async function rejectIfChunkBookDenied(req, res, bookId) {
        if (!ports.assertBookAccess) return false; // no auth host → legacy open behaviour
        const ws = await ports.assertBookAccess(req, bookId);
        if (!ws) {
            res.status(403).json({ error: 'Access denied: not a member of the book\'s workspace' });
            return true;
        }
        return false;
    }

    // ── Video file resolution ──────────────────────────────────────────
    // The merged `scene.mp4` (result of group concat for the player) takes
    // priority; otherwise the first group file `_gN.mp4` (scene
    // mid-generation). Returns null when none exists.
    function resolveSceneVideoFile(buildDirectory, bookId, chapterId, sceneId) {
        const mergedPath = path.join(buildDirectory, naming.sceneVideoName(bookId, chapterId, sceneId));
        if (fs.existsSync(mergedPath)) {
            log(`[VIDEO-SERVE] ${bookId}/${chapterId}/${sceneId}: merged scene.mp4 → ${path.basename(mergedPath)}`);
            return mergedPath;
        }
        let files = [];
        try {
            files = fs.readdirSync(buildDirectory).filter(f =>
                f.startsWith(naming.sceneArtifactPrefix(bookId, chapterId, sceneId))
                && f.endsWith('.mp4')
                && f !== naming.sceneVideoName(bookId, chapterId, sceneId)
            );
        } catch (_) {}
        if (files.length === 0) {
            log(`[VIDEO-SERVE] ${bookId}/${chapterId}/${sceneId}: no video files found`);
            return null;
        }
        files.sort((a, b) => {
            const na = parseInt((a.match(/_g(\d+)/) || [0, 0])[1], 10);
            const nb = parseInt((b.match(/_g(\d+)/) || [0, 0])[1], 10);
            return na - nb;
        });
        log(`[VIDEO-SERVE] ${bookId}/${chapterId}/${sceneId}: no merged file, serving first group → ${files[0]}`);
        return path.join(buildDirectory, files[0]);
    }

    // ── Range streaming ─────────────────────────────────────────────────
    // Stream a media file with HTTP Range support (206 Partial Content).
    // The browser <audio>/<video> engine seeks (currentTime = X) by issuing
    // Range requests; without 206 handling the seek silently fails and
    // playback restarts from position 0.
    function streamFileWithRange(req, res, filePath, contentType) {
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        // Content is served per build_id URL, but the backend REGENERATES
        // files IN PLACE (same build_id → same URL, new bytes). So responses
        // are cacheable but MUST be revalidated: ETag/Last-Modified +
        // If-None-Match / If-Range let a browser media cache serve repeat
        // plays and resume buffered ranges WITHOUT re-downloading the whole
        // 20-43 MB file, while a regenerated file still propagates (changed
        // ETag → full fresh 200).
        const etag = `"${fileSize.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        const lastModified = stat.mtime.toUTCString();
        const lastModifiedSec = Math.floor(stat.mtimeMs / 1000) * 1000;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', lastModified);
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');

        const range = req.headers.range;
        if (!range) {
            // Conditional GET: 304 when the cached entity is still current.
            const inm = (req.headers['if-none-match'] || '').split(',').map((s) => s.trim());
            if (inm.includes(etag) || inm.includes('*')) {
                res.status(304).end();
                return;
            }
            const ims = req.headers['if-modified-since'];
            if (ims && Date.parse(ims) >= lastModifiedSec) {
                res.status(304).end();
                return;
            }
            res.setHeader('Content-Length', fileSize);
            fs.createReadStream(filePath).pipe(res);
            return;
        }

        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
            res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
            return;
        }
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        if (match[1] === '' && match[2] !== '') {
            // Suffix range "bytes=-N" — last N bytes.
            start = Math.max(0, fileSize - parseInt(match[2], 10));
            end = fileSize - 1;
        }
        if (start >= fileSize || start > end) {
            res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
            return;
        }
        // If-Range: the client's cached entity must still match ours (ETag
        // or date) — otherwise the Range is ignored and the full 200 entity
        // is served. Media players send this to resume buffered ranges
        // without re-downloading; a regenerated file gets the full body.
        let ifRangeOk = true;
        const ifRange = req.headers['if-range'];
        if (ifRange) {
            if (ifRange.startsWith('"') || ifRange.startsWith('W/')) {
                ifRangeOk = ifRange === etag;
            } else {
                ifRangeOk = Date.parse(ifRange) === lastModifiedSec;
            }
        }
        if (!ifRangeOk) {
            res.setHeader('Content-Length', fileSize);
            fs.createReadStream(filePath).pipe(res);
            return;
        }
        end = Math.min(end, fileSize - 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    return {
        getEffectiveBuildId,
        buildDir,
        sceneAudioPath,
        sceneVideoPath,
        sceneImagePath,
        rejectIfChunkBookDenied,
        resolveSceneVideoFile,
        streamFileWithRange,
        // direct access to the injected seams (read-only for sub-modules)
        get playerModel() { return playerModel; },
        get playerPorts() { return ports; },
        get redis() { return redis; },
        get getChunk() { return getChunk; },
        get iuRepo() { return iuRepo; },
        get outputRoot() { return outputRoot; },
        get log() { return log; },
    };
}

module.exports = { createPlayerShared };
