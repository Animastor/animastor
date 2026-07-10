// ======================================================
// ANIMASTOR BACKEND — BOOK EXPORT / DOWNLOAD ROUTES
// ======================================================
// GET /api/v1/book/:bookId/download   → .vbook bundle (book dir zipped)
// GET /api/v1/book/:bookId/storyboard → .zip of the build's images
// GET /api/v1/book/:bookId/audio      → merged book .mp3
// GET /api/v1/book/:bookId/export     → merged + muxed final .mp4
//
// build_id is resolved from manifest.json on the backend (manifest wins).
// The client may send ?build_id= but it is only a fallback hint.
//
// Usage:
//   require('./book/export-routes.cjs')(app, redis, deps);

const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const videoMerge = require('../../video/video-merge');

module.exports = function(app, redis, deps) {
    const { config, book, audio, utils } = deps;
    const { log } = utils;
    const OUTPUT_DIR = config.OUTPUT_DIR;
    const BOOKS_DIR = config.BOOKS_DIR;

    // Load the book, resolve its build_id from the manifest, and collect ordered
    // scenes. Returns null when the book does not exist on disk.
    function loadContext(bookId, requestedBuildId) {
        const loaded = book.loadBook(bookId);
        if (!loaded) return null;
        const buildId = (loaded.manifest && loaded.manifest.build_id) || requestedBuildId || 'default';
        const scenes = book.collectScenes(loaded);
        return { loaded, buildId, scenes };
    }

    function streamFile(res, filePath, contentType, filename) {
        const stat = fs.statSync(filePath);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        fs.createReadStream(filePath).pipe(res);
    }

    function sendBuffer(res, buf, contentType, filename) {
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', buf.length);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.end(buf);
    }

    // ======================================================
    // DOWNLOAD BOOK (.vbook bundle)
    // ======================================================
    app.get('/api/v1/book/:bookId/download', async (req, res) => {
        try {
            const { bookId } = req.params;
            const bookDir = path.join(BOOKS_DIR, bookId);
            if (!fs.existsSync(bookDir)) return res.status(404).json({ error: 'book not found' });

            const zip = new AdmZip();
            book.addDirToZip(zip, bookDir, '');
            const buf = zip.toBuffer();
            log(`[EXPORT] vbook ${bookId} (${buf.length} bytes)`);
            sendBuffer(res, buf, 'application/zip', `${bookId}.vbook`);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // DOWNLOAD STORYBOARD (.zip of build images)
    // ======================================================
    app.get('/api/v1/book/:bookId/storyboard', async (req, res) => {
        try {
            const { bookId } = req.params;
            const ctx = loadContext(bookId, req.query.build_id);
            if (!ctx) return res.status(404).json({ error: 'book not found' });

            const dir = path.join(OUTPUT_DIR, ctx.buildId);
            if (!fs.existsSync(dir)) return res.status(404).json({ error: 'no build output for this book' });

            const pngs = fs.readdirSync(dir)
                .filter(f => f.startsWith(`${bookId}_`) && f.endsWith('.png'))
                .sort();
            if (pngs.length === 0) return res.status(404).json({ error: 'no storyboard images to export' });

            const zip = new AdmZip();
            for (const f of pngs) zip.addLocalFile(path.join(dir, f));
            const buf = zip.toBuffer();
            log(`[EXPORT] storyboard ${bookId} build=${ctx.buildId} (${pngs.length} images)`);
            sendBuffer(res, buf, 'application/zip', `${bookId}_storyboard.zip`);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // DOWNLOAD AUDIO (merged .mp3)
    // ======================================================
    app.get('/api/v1/book/:bookId/audio', async (req, res) => {
        try {
            const { bookId } = req.params;
            const ctx = loadContext(bookId, req.query.build_id);
            if (!ctx) return res.status(404).json({ error: 'book not found' });

            const finalPath = await audio.mergeBookAudio(ctx.buildId, bookId, ctx.scenes);
            if (!finalPath || !fs.existsSync(finalPath)) {
                return res.status(404).json({ error: 'no audio to export' });
            }
            log(`[EXPORT] audio ${bookId} build=${ctx.buildId}`);
            streamFile(res, finalPath, 'audio/mpeg', `${bookId}.mp3`);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // EXPORT VIDEO (merged scene videos + book audio → final .mp4)
    // ======================================================
    app.get('/api/v1/book/:bookId/export', async (req, res) => {
        try {
            const { bookId } = req.params;
            const ctx = loadContext(bookId, req.query.build_id);
            if (!ctx) return res.status(404).json({ error: 'book not found' });

            const dir = path.join(OUTPUT_DIR, ctx.buildId);
            if (!fs.existsSync(dir)) return res.status(404).json({ error: 'no build output for this book' });

            // Concatenate scene videos into a single book video. mergeBookVideos
            // returns null for a single scene, so fall back to that lone file.
            let bookVideo = await videoMerge.mergeBookVideos(redis, bookId, ctx.buildId, ctx.scenes);
            if (!bookVideo) {
                const singles = ctx.scenes
                    .map(s => path.join(dir, `${bookId}_${s.chapter_id}_${s.scene_id}.mp4`))
                    .filter(p => fs.existsSync(p));
                if (singles.length === 1) bookVideo = singles[0];
            }
            if (!bookVideo || !fs.existsSync(bookVideo)) {
                return res.status(404).json({ error: 'no scene videos to export' });
            }

            // Mux the merged book audio onto the merged video when audio exists.
            let finalPath = bookVideo;
            const bookAudio = await audio.mergeBookAudio(ctx.buildId, bookId, ctx.scenes);
            if (bookAudio && fs.existsSync(bookAudio)) {
                const muxed = path.join(dir, `${bookId}_final.mp4`);
                const r = await videoMerge.muxVideoAudio(bookVideo, bookAudio, muxed);
                if (r && fs.existsSync(r)) finalPath = r;
            }
            log(`[EXPORT] video ${bookId} build=${ctx.buildId} → ${path.basename(finalPath)}`);
            streamFile(res, finalPath, 'video/mp4', `${bookId}_final.mp4`);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
