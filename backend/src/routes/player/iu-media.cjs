// ======================================================
// PLAYER ROUTES — IU MEDIA (iu-image / preview / chunk storyboard+status)
// ======================================================
// Byte-for-byte relocation from routes/generation-routes.cjs (Player route
// split — preparation stage, no behavior change). The preview route may
// GENERATE a preview via the injected image.getOrCreatePreview dep
// (host image-pipeline internal — documented hidden write, audit §4 R3).
// Consumers: web Edit zoom/Navigate thumbs/player IU, Android Repository,
// tests.

const fs = require('fs');
const path = require('path');
const naming = require('./artifact-naming.cjs');

module.exports = function(app, ctx, deps) {
    const { image, state, activeScenes, placeholderAudio } = deps;

    // ── Chunk status (playback readiness, auto-redispatch repair) ────────
    app.get('/api/v1/chunk/:id', async (req, res) => {
        try {
            const c = await ctx.getChunk(req.params.id);
            if (!c) return res.json({ status: 'processing' });
            if (await ctx.rejectIfChunkBookDenied(req, res, c.book_id)) return;

            const buildDir = ctx.buildDir(c.build_id);
            const audioPath = path.join(buildDir, naming.sceneAudioName(c.book_id, c.chapter_id, c.scene_id));
            const imagePath = path.join(buildDir, naming.sceneImageName(c.book_id, c.chapter_id, c.scene_id));
            const videoPath = path.join(buildDir, naming.sceneVideoName(c.book_id, c.chapter_id, c.scene_id));

            // Auto-redispatch if audio flag says ready but file is missing
            if (c.audio && !fs.existsSync(audioPath)) {
                try {
                    const phResult = await placeholderAudio.ensurePlaceholderAudio(
                        c.build_id || 'default', c.book_id, c.chapter_id, c.scene_id
                    );
                    const phOk = !!phResult && (phResult.created || (phResult.reason === 'already_exists' && phResult.path));
                    if (phOk && fs.existsSync(audioPath)) {
                        ctx.log(`Placeholder audio on-demand for ${req.params.id} — keeping chunk ready`);
                        c.audio_status = 'placeholder';
                        await ctx.redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c));
                    } else {
                        // Don't reset c.audio = false — the chunk has audio:
                        // true, and audio_ready is computed as !!(c.audio ||
                        // fileExists). Resetting permanently breaks the
                        // scene for the player.
                        ctx.log(`Placeholder audio generation returned ${JSON.stringify(phResult)} for ${req.params.id} — keeping chunk as-is`);
                    }
                } catch (phErr) {
                    ctx.log(`Placeholder audio check failed for ${req.params.id}: ${phErr.message} — keeping chunk as-is`);
                    if (c.chapter_id && c.scene_id) {
                        const jobKey = `animastor:job:${c.book_id}_${c.chapter_id}_${c.scene_id}_0001:audio`;
                        await ctx.redis.del(jobKey);
                        await activeScenes.addActiveScene(ctx.redis, c.book_id, c.chapter_id, c.scene_id);
                    }
                }
            }

            // Reverse: file exists but flag says not ready
            if (!c.audio && fs.existsSync(audioPath)) {
                ctx.log(`Audio file exists for ${req.params.id} — updating flag`);
                c.audio = true;
                c.audio_status = 'ready';
                await ctx.redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c));
            }

            // Auto-redispatch for image
            if (c.image && !fs.existsSync(imagePath)) {
                const iuPrefix = naming.iuImagePrefix(c.book_id, c.chapter_id, c.scene_id);
                let hasIuFiles = false;
                try {
                    const dirFiles = fs.readdirSync(buildDir);
                    hasIuFiles = dirFiles.some(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                } catch {}
                if (!hasIuFiles) {
                    ctx.log(`Missing image file for ${req.params.id} — resetting state for redispatch`);
                    c.image = false;
                    await ctx.redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c));
                    if (c.chapter_id && c.scene_id) {
                        const jobKey = `animastor:job:${c.book_id}_${c.chapter_id}_${c.scene_id}_0002:image`;
                        await ctx.redis.del(jobKey);
                        await activeScenes.addActiveScene(ctx.redis, c.book_id, c.chapter_id, c.scene_id);
                    }
                }
            }

            const audioReady = !!(c.audio || fs.existsSync(audioPath));
            let imageReady = !!c.image;
            if (!imageReady && c.chapter_id && c.scene_id) {
                // Check per-asset state for image readiness
                try {
                    const assetStates = await state.getAssetStates(ctx.redis, c.book_id, c.chapter_id, c.scene_id);
                    if (assetStates.image === state.AssetState.READY || assetStates.image === state.AssetState.PLACEHOLDER) {
                        imageReady = true;
                        c.image = true;
                        await ctx.redis.set(`animastor:chunk:${req.params.id}`, JSON.stringify(c));
                    }
                } catch (_) {}
                if (!imageReady) {
                    imageReady = fs.existsSync(imagePath);
                    if (!imageReady) {
                        const iuPrefix = naming.iuImagePrefix(c.book_id, c.chapter_id, c.scene_id);
                        try {
                            const dirFiles = fs.readdirSync(buildDir);
                            imageReady = dirFiles.some(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                        } catch {}
                    }
                }
            }
            const videoReady = !!(c.video && fs.existsSync(videoPath));
            const allReady = audioReady;

            res.json({
                status: allReady ? 'ready' : 'processing', image_ready: imageReady,
                audio_ready: audioReady, video_ready: videoReady,
                audio_status: c.audio_status || 'pending',
                video_status: c.video_status || 'pending',
                scene_type: c.scene_type || 'narration',
                scene_id: c.scene_id,
                chapter_id: c.chapter_id,
            });
        } catch (err) {
            console.error('❌ CHUNK STATUS ERROR:', err.message);
            res.status(500).json({ error: 'Internal error fetching chunk status' });
        }
    });

    // ── Chunk-keyed storyboard (Android legacy) ──────────────────────────
    app.get('/api/v1/chunk/:id/storyboard', async (req, res) => {
        try {
            const { id } = req.params;
            const c = await ctx.getChunk(id);
            if (!c) return res.status(404).json({ error: 'chunk not found' });
            if (await ctx.rejectIfChunkBookDenied(req, res, c.book_id)) return;

            const { build_id, book_id, chapter_id, scene_id } = c;
            const dir = ctx.buildDir(build_id);
            if (!fs.existsSync(dir)) return res.status(404).json({ error: 'build directory not found' });

            let ius = [];
            try {
                const pgRows = await ctx.iuRepo.getImageUnitsForScene(build_id, book_id, chapter_id, scene_id);
                if (pgRows && pgRows.length > 0) {
                    ius = pgRows.map(r => ({
                        unit_id: r.unit_id, scene_id: r.scene_id, text: r.text,
                        text_proportion: r.text_proportion, estimated_duration_sec: r.estimated_duration_sec,
                        audio_file: r.scene_audio_file,
                        // Note: start_ms=0 maps to null here, but unlike the
                        // timings GET route this is self-corrected by the pgMap
                        // merge below (rows with end_ms>0 override the nulls).
                        start_ms: r.start_ms != null && (Number(r.start_ms) || 0) > 0 ? Number(r.start_ms) : null,
                        end_ms: r.end_ms != null && (Number(r.end_ms) || 0) > 0 ? Number(r.end_ms) : null,
                    }));
                }
            } catch (dbErr) {
                console.warn('[STORYBOARD] PG read failed, falling back to book data:', dbErr.message);
            }

            if (ius.length === 0) {
                try {
                    const b = ctx.playerModel.loadBook(book_id);
                    if (b) {
                        for (const ch of b.chapters || []) {
                            if (ch.chapter_id !== chapter_id) continue;
                            for (const sc of ch.scenes || []) {
                                if (sc.scene_id !== scene_id) continue;
                                let order = 0;
                                for (const u of sc.units || []) {
                                    ius.push({ unit_id: u.id, scene_id, text: u.text, text_proportion: 0, estimated_duration_sec: 0, audio_file: null, start_ms: null, end_ms: null, _order: order });
                                    order++;
                                }
                                for (const db of sc.dialogue_blocks || []) {
                                    for (const u of db.units || []) {
                                        ius.push({ unit_id: u.id, scene_id, text: u.text, text_proportion: 0, estimated_duration_sec: 0, audio_file: null, start_ms: null, end_ms: null, _order: order });
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

            const needsDuration = ius.every(iu => !iu.estimated_duration_sec || iu.estimated_duration_sec === 0);
            if (needsDuration && ius.length > 0) {
                const sceneDuration = await image.getSceneDuration(build_id, book_id, chapter_id, scene_id);
                if (sceneDuration > 0) {
                    for (const iu of ius) {
                        iu.estimated_duration_sec = parseFloat((sceneDuration * (iu.text_proportion || 0)).toFixed(3));
                    }
                }
                // Compute timing boundaries (start_ms/end_ms) from cumulative durations
                const sceneDurationMs = Math.round(sceneDuration * 1000);
                let cursorMs = 0;
                for (const iu of ius) {
                    const durMs = Math.max(200, Math.round((iu.estimated_duration_sec || 1) * 1000));
                    iu._start_ms = cursorMs;
                    let endMs = cursorMs + durMs;
                    if (sceneDurationMs > 0 && endMs > sceneDurationMs) endMs = sceneDurationMs;
                    iu._end_ms = endMs;
                    cursorMs = endMs;
                }
                for (const [idx, iu] of ius.entries()) {
                    try {
                        await ctx.iuRepo.upsertImageUnit(build_id, book_id, chapter_id, scene_id, iu.unit_id, {
                            scene_order: idx, text: iu.text, text_length: (iu.text || '').length,
                            text_proportion: iu.text_proportion || 0, scene_duration_sec: sceneDuration || 0,
                            estimated_duration_sec: iu.estimated_duration_sec || 0,
                            scene_audio_file: naming.sceneAudioName(book_id, chapter_id, scene_id),
                            start_ms: iu._start_ms != null ? iu._start_ms : null,
                            end_ms: iu._end_ms != null ? iu._end_ms : null,
                        });
                    } catch (pgErr) {
                        console.warn('[STORYBOARD] Failed to persist IU to PG:', pgErr.message);
                    }
                }
            }

            try {
                const pgRows = await ctx.iuRepo.getImageUnitsForScene(build_id, book_id, chapter_id, scene_id);
                if (pgRows && pgRows.length > 0) {
                    const pgMap = {};
                    for (const r of pgRows) {
                        if ((r.start_ms || 0) > 0 || (r.end_ms || 0) > 0) pgMap[r.unit_id] = r;
                    }
                    for (const iu of ius) {
                        const pg = pgMap[iu.unit_id];
                        if (pg) { iu.start_ms = pg.start_ms; iu.end_ms = pg.end_ms; }
                    }
                }
            } catch (dbErr) {
                console.warn('[STORYBOARD] DB timing merge failed:', dbErr.message);
            }

            // Server-computed playback duration per IU so clients never
            // re-derive it. Rule: real interval (end-start) if positive, else
            // estimated_duration_sec, else a 2000ms default. Mirrors the
            // former client fallbackDurationMs().
            for (const iu of ius) {
                const real = (iu.start_ms != null && iu.end_ms != null) ? (iu.end_ms - iu.start_ms) : 0;
                if (real > 0) {
                    iu.duration_ms = real;
                } else if (iu.estimated_duration_sec && iu.estimated_duration_sec > 0) {
                    iu.duration_ms = Math.round(iu.estimated_duration_sec * 1000);
                } else {
                    iu.duration_ms = 2000;
                }
            }

            res.json({ chunk_id: id, book_id, chapter_id, scene_id, build_id, scene_type: c.scene_type || 'narration', ius });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── IU image ─────────────────────────────────────────────────────────
    app.get('/api/v1/iu-image/:bookId/:chapterId/:sceneId/:iuId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId, iuId } = req.params;
            const buildId = ctx.getEffectiveBuildId(bookId, req.query.build_id, ctx.log);
            const imagePath = path.join(ctx.buildDir(buildId), naming.iuImageName(bookId, chapterId, sceneId, iuId));
            if (!fs.existsSync(imagePath)) return res.status(404).json({ error: 'IU image not found' });
            res.setHeader('Content-Type', 'image/png');
            fs.createReadStream(imagePath).pipe(res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Preview (may generate via injected image.getOrCreatePreview) ─────
    app.get('/api/v1/preview/:bookId/:chapterId/:sceneId/:iuId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId, iuId } = req.params;
            const buildId = ctx.getEffectiveBuildId(bookId, req.query.build_id, ctx.log);
            const result = await image.getOrCreatePreview(bookId, chapterId, sceneId, iuId, buildId);
            if (!result) return res.status(404).json({ error: 'IU image not found, cannot generate preview' });
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('X-Preview-Created', String(result.created));
            fs.createReadStream(result.path).pipe(res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
