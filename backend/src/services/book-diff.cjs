// ======================================================
// ANIMASTOR BACKEND — BOOK DIFF SERVICE
// ======================================================
// Scene comparison, diff computation, dirty scene marking,
// and profile/layer configuration.
//
// Usage:
//   const bookDiff = require('./services/book-diff.cjs')(redis, config, deps);

const fs = require('fs');
const path = require('path');
const registry = require('./prompt-dependency-registry');

module.exports = function(redis, config, deps) {
    const { state, book, layerConfig, genScope, activeScenes, getChunk, saveChunk } = deps;
    const { log, collectScenes } = deps.utils;

    // ── Deep equality check ───────────────────────────
    function isEqual(a, b) {
        if (a === b) return true;
        if (a == null || b == null) return a === b;
        if (typeof a !== typeof b) return false;
        if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') return a === b;
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                if (!isEqual(a[i], b[i])) return false;
            }
            return true;
        }
        if (typeof a === 'object') {
            const keysA = Object.keys(a);
            const keysB = Object.keys(b);
            if (keysA.length !== keysB.length) return false;
            for (const key of keysA) {
                if (!isEqual(a[key], b[key])) return false;
            }
            return true;
        }
        return a === b;
    }

    // ── Scene diff ────────────────────────────────────
    function diffScene(oldScene, newScene) {
        // Delegated to Prompt Dependency Registry — the single source of truth
        // for which scene-level fields affect which generation layers.
        // See prompt-dependency-registry.js for the full list of fields.
        const result = registry.computeSceneDirtyLayers(oldScene, newScene);
        return {
            dirty_layers: result.dirtyLayers,
            changes: result.changes,
        };
    }

    // ── Merge or add a dirty scene entry ───────────────
    function ensureDirtyScene(dirtyScenes, chapterId, sceneId, reason, dirtyLayers, changes) {
        const existing = dirtyScenes.find(d => d.chapter_id === chapterId && d.scene_id === sceneId);
        if (existing) {
            for (const layer of dirtyLayers) {
                if (!existing.dirty_layers.includes(layer)) {
                    existing.dirty_layers.push(layer);
                }
            }
            if (changes) {
                existing.changes = { ...existing.changes, ...changes };
            }
            // Keep the earliest reason (e.g. 'added' > 'changed' > 'character_changed')
            if (reason === 'added' || reason === 'changed') {
                existing.reason = reason;
            }
            return existing;
        }
        const entry = {
            chapter_id: chapterId,
            scene_id: sceneId,
            reason,
            dirty_layers: [...dirtyLayers],
            changes: changes || null,
        };
        dirtyScenes.push(entry);
        return entry;
    }

    // ── Compute book diff ─────────────────────────────
    function computeBookDiff(oldBook, newBook) {
        const oldScenes = collectScenes(oldBook);
        const newScenes = collectScenes(newBook);

        const oldMap = {};
        for (const s of oldScenes) {
            oldMap[`${s.chapter_id}_${s.scene_id}`] = s;
        }

        const newMap = {};
        for (const s of newScenes) {
            newMap[`${s.chapter_id}_${s.scene_id}`] = s;
        }

        const dirtyScenes = [];
        let reindexNeeded = false;

        // ── Step 1: Scene-level diff (added, removed, changed) ──
        for (const key of Object.keys(newMap)) {
            const newS = newMap[key];
            const oldS = oldMap[key];

            if (!oldS) {
                // New scene
                dirtyScenes.push({
                    chapter_id: newS.chapter_id,
                    scene_id: newS.scene_id,
                    reason: 'added',
                    dirty_layers: ['audio', 'image', 'video'],
                });
            } else {
                // Check for changes
                const diff = diffScene(oldS.scene, newS.scene);
                if (diff.dirty_layers.length > 0) {
                    dirtyScenes.push({
                        chapter_id: newS.chapter_id,
                        scene_id: newS.scene_id,
                        reason: 'changed',
                        dirty_layers: diff.dirty_layers,
                        changes: diff.changes,
                    });
                }
                // Check if scene moved (different index)
                if (oldS.scene_order !== newS.scene_order) {
                    reindexNeeded = true;
                }
            }
        }

        // Check for removed scenes
        for (const key of Object.keys(oldMap)) {
            if (!newMap[key]) {
                dirtyScenes.push({
                    chapter_id: oldMap[key].chapter_id,
                    scene_id: oldMap[key].scene_id,
                    reason: 'removed',
                    dirty_layers: ['audio', 'image', 'video'],
                });
            }
        }

        // ── Step 2: Cross-cutting entity changes ───────────────
        // Use Prompt Dependency Registry to find changed entities
        // (characters, locations) and mark affected scenes.
        const crossFields = registry.getCrossFields();
        const crossChanges = {};  // field.key → count
        for (const field of crossFields) {
            const oldEntities = field.entitySource(oldBook);
            const newEntities = field.entitySource(newBook);

            const oldEntityMap = new Map();
            for (const e of oldEntities) oldEntityMap.set(field.entityId(e), e);
            const newEntityMap = new Map();
            for (const e of newEntities) newEntityMap.set(field.entityId(e), e);

            const changedIds = new Set();

            // Detect changed/added entities
            for (const [id, newEntity] of newEntityMap) {
                const oldEntity = oldEntityMap.get(id);
                if (!oldEntity || field.isChanged(oldEntity, newEntity)) {
                    changedIds.add(id);
                }
            }
            // Detect removed entities
            for (const id of oldEntityMap.keys()) {
                if (!newEntityMap.has(id)) {
                    changedIds.add(id);
                }
            }

            if (changedIds.size > 0) {
                crossChanges[field.key] = changedIds.size;
                log(`📋 ${field.key} changes detected: ${changedIds.size} changed`);
                for (const entityId of changedIds) {
                    const affected = field.findAffectedScenes(newScenes, entityId);
                    for (const s of affected) {
                        const ch = {};
                        ch[field.label] = entityId;
                        ensureDirtyScene(dirtyScenes, s.chapter_id, s.scene_id,
                            field.key.replace(/[.\[\]]/g, '_') + '_changed',
                            field.layers, ch);
                    }
                }
            }
        }

        return {
            dirty_scenes: dirtyScenes,
            changes: {
                added: Object.keys(newMap).filter(k => !oldMap[k]).length,
                removed: Object.keys(oldMap).filter(k => !newMap[k]).length,
                modified: dirtyScenes.filter(d => d.reason === 'changed').length,
                ...crossChanges,
            },
            reindex_needed: reindexNeeded,
        };
    }

    // ── Mark dirty scenes ─────────────────────────────
    async function markDirtyScenes(redis, bookId, buildId, dirtyScenes, layerCfg) {
        if (!dirtyScenes || dirtyScenes.length === 0) {
            log('📋 No dirty scenes to mark');
            return { marked: 0 };
        }

        let marked = 0;
        for (const ds of dirtyScenes) {
            const { chapter_id, scene_id, dirty_layers } = ds;

            // Determine which layers need regeneration
            const resetAudio = layerCfg.audio_enabled !== false && dirty_layers.includes('audio');
            const resetImage = layerCfg.image_enabled !== false && dirty_layers.includes('image');
            const resetVideo = layerCfg.video_enabled !== false && dirty_layers.includes('video');

            if (!resetAudio && !resetImage && !resetVideo) {
                continue;
            }

            // Reset all chunks for this scene (SCAN pattern, not just _0001)
            const chunkPrefix = `animastor:chunk:${bookId}_${chapter_id}_${scene_id}_`;
            let cursor = '0';
            let createdAny = false;
            do {
                const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${chunkPrefix}*`, 'COUNT', 50);
                cursor = nextCursor;
                for (const key of keys) {
                    const raw = await redis.get(key);
                    const ch = raw ? JSON.parse(raw) : {};
                    if (resetAudio) {
                        ch.audio = false;
                        ch.audio_status = 'pending';
                    }
                    if (resetImage) {
                        ch.image = false;
                        ch.image_status = 'pending';
                    }
                    if (resetVideo) {
                        ch.video = false;
                        ch.video_status = 'pending';
                    }
                    await redis.set(key, JSON.stringify({
                        ...ch,
                        build_id: buildId,
                        book_id: bookId,
                        chapter_id,
                        scene_id,
                    }));
                    // Register in chunk set so getAllChunks finds it
                    const chunkId = key.replace('animastor:chunk:', '');
                    await redis.sadd(`animastor:chunks:${bookId}`, chunkId);
                    createdAny = true;
                }
            } while (cursor !== '0');
            // If no chunks existed yet for this scene, create the default one
            if (!createdAny) {
                const chunkId = `${bookId}_${chapter_id}_${scene_id}_0001`;
                const ch = {};
                if (resetAudio) { ch.audio = false; ch.audio_status = 'pending'; }
                if (resetImage) { ch.image = false; ch.image_status = 'pending'; }
                if (resetVideo) { ch.video = false; ch.video_status = 'pending'; }
                await redis.set(`animastor:chunk:${chunkId}`, JSON.stringify({
                    ...ch,
                    build_id: buildId,
                    book_id: bookId,
                    chapter_id,
                    scene_id,
                    chunk_index: '0001',
                    expected_chunk_count: 1,
                }));
                await redis.sadd(`animastor:chunks:${bookId}`, chunkId);
            }

            // Reset scene state in Redis (use direct set, not transitionSceneState,
            // because scenes may be in terminal states like VIDEO_READY which have
            // no outgoing transitions in the FSM — dirty marking is a forced reset).
            let newState;
            if (resetAudio) {
                newState = state.SceneState.AUDIO_PENDING;
            } else if (resetImage) {
                newState = state.SceneState.IMAGE_PENDING;
            } else {
                newState = state.SceneState.VIDEO_PENDING;
            }

            await state.setSceneStateWithBuildId(redis, bookId, chapter_id, scene_id, newState, buildId);
            await activeScenes.addActiveScene(redis, bookId, chapter_id, scene_id);

            // Reset per-asset states so the scheduler doesn't see stale states
            // from a previous (cancelled) generation run:
            // e.g. audio=GENERATING from an aborted run would prevent re-dispatch
            // because shouldScheduleAssets explicitly skips GENERATING.
            const assetUpdates = {};
            if (resetAudio) {
                assetUpdates.audio = state.AssetState.PENDING;
            }
            if (resetImage) {
                assetUpdates.image = state.AssetState.PENDING;
            }
            if (resetVideo) {
                assetUpdates.video = state.AssetState.PENDING;
            }
            if (Object.keys(assetUpdates).length > 0) {
                await state.setAssetStates(redis, bookId, chapter_id, scene_id, assetUpdates);
            }

            log(`📋 Dirty scene marked: ${bookId}/${chapter_id}/${scene_id} → ${newState}`);
            marked++;
        }

        log(`📋 Marked ${marked}/${dirtyScenes.length} dirty scenes`);
        return { marked };
    }

    // ── Apply profile to layer config ─────────────────
    async function applyProfileToLayerConfig(redis, bookId, profile) {
        let newProfile;
        switch (profile) {
            case 'audio_only':
                newProfile = { audio_enabled: true, image_enabled: false, video_enabled: false };
                break;
            case 'image_only':
                newProfile = { audio_enabled: false, image_enabled: true, video_enabled: false };
                break;
            case 'video_only':
                newProfile = { audio_enabled: false, image_enabled: false, video_enabled: true };
                break;
            case 'storyboard':
                newProfile = { audio_enabled: true, image_enabled: true, video_enabled: false };
                break;
            case 'full':
            default:
                newProfile = { audio_enabled: true, image_enabled: true, video_enabled: true };
                break;
        }
        const result = await layerConfig.set(redis, bookId, newProfile);
        log(`📋 Layer profile updated for ${bookId}:`, JSON.stringify(result));
        return result;
    }

    // ── Filter dirty scenes by scope ──────────────────
    function filterDirtyScenesByScope(dirtyScenes, scope, chapterId, sceneId, allScenes) {
        if (!dirtyScenes || dirtyScenes.length === 0) return [];

        switch (scope) {
            case 'whole_book':
                return dirtyScenes;

            case 'current_scene':
                return dirtyScenes.filter(ds =>
                    ds.chapter_id === chapterId && ds.scene_id === sceneId
                );

            case 'current_chapter':
                return dirtyScenes.filter(ds =>
                    ds.chapter_id === chapterId
                );

            case 'from_current_scene':
                if (!allScenes || allScenes.length === 0) return dirtyScenes;
                const currentSceneIndex = allScenes.findIndex(s =>
                    s.chapter_id === chapterId && s.scene_id === sceneId
                );
                if (currentSceneIndex < 0) return dirtyScenes;
                const fromChapter = allScenes[currentSceneIndex].chapter_id;
                return dirtyScenes.filter(ds => {
                    const dsIndex = allScenes.findIndex(s =>
                        s.chapter_id === ds.chapter_id && s.scene_id === ds.scene_id
                    );
                    return dsIndex >= currentSceneIndex || ds.chapter_id === fromChapter;
                });

            default:
                return dirtyScenes;
        }
    }

    // ── Is in scope helper ────────────────────────────
    function isInScope(chunk, scope, chapterId, sceneId) {
        if (scope === 'whole_book') return true;
        if (scope === 'current_scene') {
            return chunk.chapter_id === chapterId && chunk.scene_id === sceneId;
        }
        if (scope === 'current_chapter') {
            return chunk.chapter_id === chapterId;
        }
        return true;
    }

    return {
        isEqual,
        diffScene,
        computeBookDiff,
        markDirtyScenes,
        applyProfileToLayerConfig,
        filterDirtyScenesByScope,
        isInScope,
    };
};
