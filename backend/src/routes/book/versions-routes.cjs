// Book version-introspection routes.
//
// Split out of the monolithic book-routes.cjs (Architectural Debt #3) using the
// sub-registrar pattern: the parent builds a `ctx` of shared dependencies once
// and hands it to each route group. Behavior is identical to the inline version.
//
//   require('./book/versions-routes.cjs')(app, ctx);
//
// ctx fields used here: { storage, sceneAssetsRepo, log }

module.exports = function registerVersionRoutes(app, ctx) {
    const { storage, sceneAssetsRepo, log } = ctx;

    // GET /api/v1/book/:bookId/versions
    // Returns per-scene + per-asset version info and detected version mismatches.
    app.get('/api/v1/book/:bookId/versions', async (req, res) => {
        try {
            const { bookId } = req.params;

            // 1. Scene-level versions from scenes table
            const sceneResult = await storage.postgres.query(`
                SELECT chapter_id, scene_id, content_version, audio_config_version, scene_hash, updated_at
                FROM scenes
                WHERE book_id = $1
                ORDER BY chapter_id, scene_id
            `, [bookId]);

            // 2. Asset-level versions from scene_assets table
            const assetResult = await storage.postgres.query(`
                SELECT chapter_id, scene_id, asset_type, scene_content_version, scene_audio_config_version, status, build_id
                FROM scene_assets
                WHERE book_id = $1
                ORDER BY chapter_id, scene_id, asset_type
            `, [bookId]);

            // Build per-scene view
            const sceneVersions = {};
            for (const row of sceneResult.rows) {
                const key = `${row.chapter_id}/${row.scene_id}`;
                sceneVersions[key] = {
                    chapter_id: row.chapter_id,
                    scene_id: row.scene_id,
                    content_version: row.content_version,
                    audio_config_version: row.audio_config_version,
                    scene_hash: row.scene_hash,
                    updated_at: row.updated_at,
                    assets: [],
                };
            }
            for (const row of assetResult.rows) {
                const key = `${row.chapter_id}/${row.scene_id}`;
                if (sceneVersions[key]) {
                    sceneVersions[key].assets.push({
                        asset_type: row.asset_type,
                        scene_content_version: row.scene_content_version,
                        scene_audio_config_version: row.scene_audio_config_version,
                        status: row.status,
                        build_id: row.build_id,
                    });
                }
            }

            // R16: Use getOutdatedByVersions for accurate mismatch detection
            // Build sceneVersionMap in the format expected by getOutdatedByVersions
            const sceneVersionMap = new Map();
            for (const row of sceneResult.rows) {
                const key = `${row.chapter_id}:${row.scene_id}`;
                sceneVersionMap.set(key, {
                    content_version: row.content_version,
                    audio_config_version: row.audio_config_version,
                });
            }

            let mismatches = [];
            try {
                const outdatedAssets = await sceneAssetsRepo.getOutdatedByVersions(bookId, sceneVersionMap);
                mismatches = outdatedAssets.map(a => ({
                    key: `${a.chapter_id}/${a.scene_id}`,
                    type: a._outdated_reason,
                    scene_version: a._expected_version,
                    asset_version: a.scene_content_version,
                    asset_type: a.asset_type,
                    status: a.status,
                }));
            } catch (verErr) {
                // Fallback to inline comparison if getOutdatedByVersions fails
                for (const [key, sv] of Object.entries(sceneVersions)) {
                    for (const asset of sv.assets) {
                        if (asset.scene_content_version != null && sv.content_version != null &&
                            asset.scene_content_version < sv.content_version) {
                            mismatches.push({
                                key,
                                type: 'content_version',
                                scene_version: sv.content_version,
                                asset_version: asset.scene_content_version,
                                asset_type: asset.asset_type,
                                status: asset.status,
                            });
                        }
                        if (asset.scene_audio_config_version != null && sv.audio_config_version != null &&
                            asset.scene_audio_config_version < sv.audio_config_version) {
                            mismatches.push({
                                key,
                                type: 'audio_config_version',
                                scene_version: sv.audio_config_version,
                                asset_version: asset.scene_audio_config_version,
                                asset_type: asset.asset_type,
                                status: asset.status,
                            });
                        }
                    }
                }
            }

            res.json({
                book_id: bookId,
                scenes: Object.values(sceneVersions),
                scene_count: sceneResult.rows.length,
                asset_count: assetResult.rows.length,
                mismatches,
                mismatch_count: mismatches.length,
            });
        } catch (err) {
            console.error('[VERSIONS] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Book version routes loaded');
};
