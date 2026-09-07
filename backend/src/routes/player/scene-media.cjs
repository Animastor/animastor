// ======================================================
// PLAYER ROUTES — SCENE MEDIA (audio / video / image serving)
// ======================================================
// Byte-for-byte relocation of the media-serving handlers from
// routes/generation-routes.cjs (Player route split — preparation stage, no
// behavior change). Dependencies arrive exclusively through the shared
// context (player-shared.cjs): playerModel, outputRoot, playerPorts,
// naming grammar. Consumers: web playbackStore/EditPage, Android
// Repository, tests/scene-audio-range.test.js.

const fs = require('fs');
const path = require('path');
const naming = require('./artifact-naming.cjs');

module.exports = function(app, ctx) {
    // ── Chunk-keyed media (Android legacy, tests) ────────────────────────
    app.get('/api/v1/chunk/:id/audio', async (req, res) => {
        try {
            const c = await ctx.getChunk(req.params.id);
            if (!c) return res.status(404).json({ error: 'chunk not found' });
            if (await ctx.rejectIfChunkBookDenied(req, res, c.book_id)) return;
            const audioPath = ctx.sceneAudioPath(c.build_id, c.book_id, c.chapter_id, c.scene_id);
            if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'audio not ready' });
            res.setHeader('Content-Type', 'audio/mpeg');
            fs.createReadStream(audioPath).pipe(res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/chunk/:id/image', async (req, res) => {
        const c = await ctx.getChunk(req.params.id);
        if (!c) return res.status(404).json({ error: 'chunk not found' });
        if (await ctx.rejectIfChunkBookDenied(req, res, c.book_id)) return;
        if (!c.image) return res.status(404).json({ error: 'image not ready' });
        const dir = ctx.buildDir(c.build_id);
        if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });
        const files = fs.readdirSync(dir).filter(f => f.startsWith(naming.sceneArtifactPrefix(c.book_id, c.chapter_id, c.scene_id)) && f.endsWith('.png'));
        if (!files.length) return res.status(404).json({ error: 'no image files' });
        const filePath = path.join(dir, files[0]);
        res.setHeader('Content-Type', 'image/png');
        fs.createReadStream(filePath).pipe(res);
    });

    app.get('/api/v1/chunk/:id/video', async (req, res) => {
        try {
            const c = await ctx.getChunk(req.params.id);
            if (!c) return res.status(404).json({ error: 'chunk not found' });
            if (await ctx.rejectIfChunkBookDenied(req, res, c.book_id)) return;
            const dir = ctx.buildDir(c.build_id);
            if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });
            const filePath = ctx.resolveSceneVideoFile(dir, c.book_id, c.chapter_id, c.scene_id);
            if (!filePath) return res.status(404).json({ error: 'video not ready' });
            ctx.streamFileWithRange(req, res, filePath, 'video/mp4');
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Scene-keyed media (web + Android) ────────────────────────────────
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/audio', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = ctx.getEffectiveBuildId(bookId, req.query.build_id, ctx.log);
            const audioPath = ctx.sceneAudioPath(buildId, bookId, chapterId, sceneId);
            if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'audio not ready' });
            ctx.streamFileWithRange(req, res, audioPath, 'audio/mpeg');
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/video', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = ctx.getEffectiveBuildId(bookId, req.query.build_id, ctx.log);
            const dir = ctx.buildDir(buildId);
            if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });
            const filePath = ctx.resolveSceneVideoFile(dir, bookId, chapterId, sceneId);
            if (!filePath) return res.status(404).json({ error: 'video not ready' });
            ctx.streamFileWithRange(req, res, filePath, 'video/mp4');
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/image', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = ctx.getEffectiveBuildId(bookId, req.query.build_id, ctx.log);
            const dir = ctx.buildDir(buildId);
            if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });
            const files = fs.readdirSync(dir).filter(f => f.startsWith(naming.sceneArtifactPrefix(bookId, chapterId, sceneId)) && f.endsWith('.png'));
            if (!files.length) return res.status(404).json({ error: 'no image files' });
            const filePath = path.join(dir, files[0]);
            res.setHeader('Content-Type', 'image/png');
            fs.createReadStream(filePath).pipe(res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
