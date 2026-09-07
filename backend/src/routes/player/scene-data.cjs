// ======================================================
// PLAYER ROUTES — SCENE DATA (status / storyboard / timings / waveform)
// ======================================================
// Byte-for-byte relocation of the scene-data handlers from
// routes/generation-routes.cjs (Player route split — preparation stage, no
// behavior change). Ports: videoTimeline/computeVideoStartMs and
// computeWaveform arrive via playerPorts (host keeps ffprobe/ffmpeg +
// workflows knowledge); image.getSceneDuration / getOrCreatePreview stay
// injected deps on the shared context (host image-pipeline internals the
// player must not import). Consumers: web playbackStore/EditPage/Navigate,
// Android Repository, tests/scene-timings.test.js.

const fs = require('fs');
const path = require('path');
const naming = require('./artifact-naming.cjs');

module.exports = function(app, ctx, deps) {
    const { image, videoTimelinePort } = deps;

    // ── Scene status ────────────────────────────────────────────────────
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/status', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = ctx.getEffectiveBuildId(bookId, req.query.build_id, ctx.log);
            const buildDir = ctx.buildDir(buildId);
            const audioPath = path.join(buildDir, naming.sceneAudioName(bookId, chapterId, sceneId));
            const videoPath = path.join(buildDir, naming.sceneVideoName(bookId, chapterId, sceneId));
            const imagePath = path.join(buildDir, naming.sceneImageName(bookId, chapterId, sceneId));

            const audioReady = fs.existsSync(audioPath);
            const videoReady = fs.existsSync(videoPath);

            // Content version of the scene video: the file mtime (same source
            // as the ETag in streamFileWithRange). build_id is immutable per
            // book and regeneration replaces files IN PLACE (same URL, new
            // bytes), so a client-side video cache keyed by URL alone would
            // serve STALE video after a regeneration. The Android player
            // appends this as ?v= to the video URL → the cache key changes
            // exactly when the content changes (no wholesale cache wipe).
            // 0 = no video file.
            let videoVersion = 0;
            if (videoReady) {
                try {
                    videoVersion = Math.floor(fs.statSync(videoPath).mtimeMs);
                } catch {}
            }

            // Image readiness: check for either the scene .png file or IU images
            let imageReady = fs.existsSync(imagePath);
            if (!imageReady && fs.existsSync(buildDir)) {
                const iuPrefix = naming.iuImagePrefix(bookId, chapterId, sceneId);
                try {
                    const dirFiles = fs.readdirSync(buildDir);
                    imageReady = dirFiles.some(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                } catch {}
            }

            // Scene type from book JSON
            let sceneType = 'narration';
            try {
                const b = ctx.playerModel.loadBook(bookId);
                if (b) {
                    for (const ch of b.chapters || []) {
                        if (ch.chapter_id !== chapterId) continue;
                        for (const sc of ch.scenes || []) {
                            if (sc.scene_id === sceneId) {
                                sceneType = sc.type || sc.scene_type || 'narration';
                                break;
                            }
                        }
                    }
                }
            } catch {}

            res.json({
                book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
                build_id: buildId, scene_type: sceneType,
                audio_ready: audioReady, video_ready: videoReady, image_ready: imageReady,
                video_version: videoVersion,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Scene storyboard (PG-first, book-JSON fallback, timing merge) ────
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/storyboard', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = ctx.getEffectiveBuildId(bookId, req.query.build_id, ctx.log);

            let ius = [];
            try {
                const pgRows = await ctx.iuRepo.getImageUnitsForScene(buildId, bookId, chapterId, sceneId);
                // Only use PG rows if they have text — stale rows with null/empty
                // text (e.g. after DELETE /cache) should fall back to book JSON
                // which has the real text.
                if (pgRows && pgRows.length > 0 && pgRows.some(r => r.text != null && r.text !== '')) {
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
                console.warn('[SCENE STORYBOARD] PG read failed, falling back to book data:', dbErr.message);
            }

            if (ius.length === 0) {
                try {
                    const b = ctx.playerModel.loadBook(bookId);
                    if (b) {
                        const sceneData = deps.book.findSceneRuntimeData(b, chapterId, sceneId);
                        if (sceneData && sceneData.payload) {
                            const sceneUnits = deps.book.collectSceneUnits(sceneData.payload);
                            let order = 0;
                            for (const u of sceneUnits) {
                                ius.push({ unit_id: u.id, scene_id: sceneId, text: u.text, text_proportion: 0, estimated_duration_sec: 0, audio_file: null, start_ms: null, end_ms: null, _order: order });
                                order++;
                            }
                            const totalTextLen = ius.reduce((s, i) => s + (i.text || '').length, 0);
                            ius.sort((a, b) => a._order - b._order);
                            for (const iu of ius) {
                                iu.text_proportion = totalTextLen > 0 ? (iu.text || '').length / totalTextLen : 1;
                                delete iu._order;
                            }
                        }
                    }
                } catch (bookErr) {
                    console.warn('[SCENE STORYBOARD] Book data fallback failed:', bookErr.message);
                }
            }

            const needsDuration = ius.every(iu => !iu.estimated_duration_sec || iu.estimated_duration_sec === 0);
            if (needsDuration && ius.length > 0) {
                const sceneDuration = await image.getSceneDuration(buildId, bookId, chapterId, sceneId);
                if (sceneDuration > 0) {
                    for (const iu of ius) {
                        iu.estimated_duration_sec = parseFloat((sceneDuration * (iu.text_proportion || 0)).toFixed(3));
                    }
                }
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
                        await ctx.iuRepo.upsertImageUnit(buildId, bookId, chapterId, sceneId, iu.unit_id, {
                            scene_order: idx, text: iu.text, text_length: (iu.text || '').length,
                            text_proportion: iu.text_proportion || 0, scene_duration_sec: sceneDuration || 0,
                            estimated_duration_sec: iu.estimated_duration_sec || 0,
                            scene_audio_file: naming.sceneAudioName(bookId, chapterId, sceneId),
                            start_ms: iu._start_ms != null ? iu._start_ms : null,
                            end_ms: iu._end_ms != null ? iu._end_ms : null,
                        });
                    } catch (pgErr) {
                        console.warn('[SCENE STORYBOARD] Failed to persist IU to PG:', pgErr.message);
                    }
                }
            }

            try {
                const pgRows = await ctx.iuRepo.getImageUnitsForScene(buildId, bookId, chapterId, sceneId);
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
                console.warn('[SCENE STORYBOARD] DB timing merge failed:', dbErr.message);
            }

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

            // Per-unit positions on the WHOLE-SCENE VIDEO timeline. Players
            // seek the scene video by video_start_ms (its real timeline,
            // measured from the merged/group files) instead of start_ms (the
            // audio timeline) — on LTX builds the video drifts ahead of
            // audio, and seeking to start_ms lands in the previous unit.
            // Model-agnostic: on exact-timed builds (e.g. Minimax H3) the
            // measurement equals start_ms and is a no-op. Best-effort:
            // failures leave video_start_ms absent.
            try {
                await videoTimelinePort.computeVideoStartMs(ius, buildId, bookId, chapterId, sceneId, ctx.outputRoot);
            } catch (tlErr) {
                console.warn(`[SCENE STORYBOARD] video_start_ms failed for ${bookId}/${chapterId}/${sceneId}: ${tlErr.message}`);
            }

            res.json({ book_id: bookId, chapter_id: chapterId, scene_id: sceneId, build_id: buildId, ius });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Scene waveform (ffmpeg peaks via injected port) ──────────────────
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/waveform', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = ctx.getEffectiveBuildId(bookId, req.query.build_id, ctx.log);
            const audioPath = ctx.sceneAudioPath(buildId, bookId, chapterId, sceneId);
            if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'audio not ready' });
            const peaks = await ctx.playerPorts.computeWaveform(audioPath);
            const duration = await image.getSceneDuration(buildId, bookId, chapterId, sceneId);
            res.json({ peaks, duration_sec: Math.round(duration * 1000) / 1000, peak_count: peaks.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Scene timings (GET + PUT) ────────────────────────────────────────
    app.get('/api/v1/scene/:bookId/:chapterId/:sceneId/timings', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = ctx.getEffectiveBuildId(bookId, req.query.build_id, ctx.log);

            let ius = [];
            try {
                const pgRows = await ctx.iuRepo.getImageUnitsForScene(buildId, bookId, chapterId, sceneId);
                if (pgRows && pgRows.length > 0) {
                    ius = pgRows.map(r => ({
                        unit_id: r.unit_id, scene_order: r.scene_order || 0,
                        // start_ms=0 is VALID — the first unit of every scene
                        // starts at 0. Treating it as null made needsCompute
                        // true on every GET, and the recompute-all path
                        // (5a401fb) then wiped the user-saved timings right
                        // after PUT. Rows that were never timed are 0/0 and
                        // still fail the end>start check below.
                        start_ms: r.start_ms != null ? Number(r.start_ms) : null,
                        end_ms: r.end_ms != null ? Number(r.end_ms) : null,
                        estimated_duration_sec: r.estimated_duration_sec || 0,
                        text_proportion: r.text_proportion || 0,
                    }));
                }
            } catch (dbErr) {
                console.warn('[TIMINGS] PG read failed, falling back to book data:', dbErr.message);
            }

            if (ius.length === 0) {
                try {
                    const b = ctx.playerModel.loadBook(bookId);
                    if (b) {
                        for (const ch of b.chapters || []) {
                            if (ch.chapter_id !== chapterId) continue;
                            for (const sc of ch.scenes || []) {
                                if (sc.scene_id !== sceneId) continue;
                                let order = 0;
                                for (const u of sc.units || []) {
                                    ius.push({ unit_id: u.id, scene_order: order, start_ms: null, end_ms: null, estimated_duration_sec: 0, text_proportion: 0, _text: u.text || '' });
                                    order++;
                                }
                                for (const db of sc.dialogue_blocks || []) {
                                    for (const u of db.units || []) {
                                        ius.push({ unit_id: u.id, scene_order: order, start_ms: null, end_ms: null, estimated_duration_sec: 0, text_proportion: 0, _text: u.text || '' });
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

            const sceneDuration = await image.getSceneDuration(buildId, bookId, chapterId, sceneId);
            const sceneDurationMs = Math.round(sceneDuration * 1000);

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
            const needsCompute = ius.some(iu => iu.start_ms == null || iu.end_ms == null || (Number(iu.end_ms) - Number(iu.start_ms)) <= 0);
            // When needsCompute is true, always recompute ALL units from
            // scratch using cumulative cursorMs. Trusting existing
            // start_ms/end_ms values when some units are being recomputed
            // creates inconsistent gaps: unit0 may be recomputed with the
            // current scene_duration_sec, but unit1's "valid" timings from a
            // different audio duration are kept unchanged, causing overlaps
            // or gaps.
            const units = ius.map(iu => {
                if (!needsCompute && iu.start_ms != null && iu.end_ms != null && (Number(iu.end_ms) - Number(iu.start_ms)) > 0) {
                    cursorMs = iu.end_ms;
                    const clampedEndMs = sceneDurationMs > 0 ? Math.min(iu.end_ms, sceneDurationMs) : iu.end_ms;
                    return { unit_id: iu.unit_id, scene_order: iu.scene_order, start_ms: iu.start_ms, end_ms: clampedEndMs, estimated_duration_sec: iu.estimated_duration_sec, text_proportion: iu.text_proportion };
                }
                const durMs = Math.max(200, Math.round((iu.estimated_duration_sec || 1) * 1000));
                const start = cursorMs;
                let end = cursorMs + durMs;
                if (sceneDurationMs > 0 && end > sceneDurationMs) end = sceneDurationMs;
                cursorMs = end;
                return { unit_id: iu.unit_id, scene_order: iu.scene_order, start_ms: start, end_ms: end, estimated_duration_sec: iu.estimated_duration_sec || 0, text_proportion: iu.text_proportion || 0 };
            });

            // Persist computed start_ms/end_ms back to PG so subsequent calls
            // don't recompute from scratch.
            if (needsCompute && units.length > 0) {
                for (const u of units) {
                    try {
                        await ctx.iuRepo.upsertIuTiming(buildId, bookId, chapterId, sceneId, u.unit_id, u.start_ms, u.end_ms);
                    } catch (persistErr) {
                        console.warn('[TIMINGS] Failed to persist timing:', persistErr.message);
                    }
                }
                ctx.log(`[TIMINGS] Persisted ${units.length} timing boundaries for ${bookId}/${chapterId}/${sceneId}`);
            }

            const totalMs = units.reduce((sum, u) => sum + (u.end_ms - u.start_ms), 0);
            res.json({ units, total_duration_ms: totalMs });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/v1/scene/:bookId/:chapterId/:sceneId/timings', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const { build_id: rawBuildId, units } = req.body || {};
            const build_id = ctx.getEffectiveBuildId(bookId, rawBuildId, ctx.log);
            if (!units || !Array.isArray(units)) return res.status(400).json({ error: 'units array required' });

            const rows = await ctx.iuRepo.getImageUnitsForScene(build_id, bookId, chapterId, sceneId);
            const existingMap = {};
            for (const r of rows) existingMap[r.unit_id] = r;

            const sorted = [...units].sort((a, b) => (existingMap[a.unit_id]?.scene_order ?? 0) - (existingMap[b.unit_id]?.scene_order ?? 0));

            const sceneDuration = await image.getSceneDuration(build_id, bookId, chapterId, sceneId);
            const sceneDurationMs = Math.round(sceneDuration * 1000);

            const recalculated = [];
            let cursorMs = 0;

            for (const unit of sorted) {
                const preferredStart = unit.start_ms ?? 0;
                const preferredEnd = unit.end_ms ?? 0;
                let endMs = Math.max(preferredStart + 50, preferredEnd);
                if (sceneDurationMs > 0 && endMs > sceneDurationMs) endMs = sceneDurationMs;
                // Gapless boundary model: the handles are SHARED boundaries —
                // the right handle of a unit is the left handle of the next
                // one. When a unit would start AFTER the previous unit ended
                // (a gap — e.g. the user dragged the shared boundary earlier
                // and the next unit's start didn't follow), pull the start
                // back to the previous unit's end so the timeline stays
                // gapless and the next unit's left handle tracks the drag.
                // Net effect: every non-first unit starts exactly where the
                // previous one ends, so a client that reports a later start
                // for a non-first unit (didn't cascade a shared boundary) is
                // corrected server-side. cursorMs === 0 marks the FIRST unit
                // — its left edge may intentionally sit after 0 (lead-in
                // silence), so its preferred start is kept.
                let startMs = Math.max(preferredStart, cursorMs);
                if (cursorMs > 0 && preferredStart > cursorMs) {
                    startMs = cursorMs;
                }
                // Clamp the start so the interval is never zero-width or
                // inverted (e.g. a handle dragged to the very end of the
                // audio). A saved row with start >= end would make the next
                // GET treat the whole scene as needsCompute and recompute ALL
                // timings from text proportions — discarding the user's edits.
                startMs = Math.min(startMs, Math.max(0, endMs - 50));
                recalculated.push({ unit_id: unit.unit_id, start_ms: startMs, end_ms: endMs });
                cursorMs = endMs;
            }

            for (const u of recalculated) {
                await ctx.iuRepo.upsertIuTiming(build_id, bookId, chapterId, sceneId, u.unit_id, u.start_ms, u.end_ms);
            }

            res.json({ units: recalculated, recalculated: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
