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
        const dirtyLayers = [];
        const changes = {};

        // Audio changes
        if (!isEqual(oldScene.audio?.full_text, newScene.audio?.full_text) ||
            !isEqual(oldScene.audio?.voice, newScene.audio?.voice)) {
            dirtyLayers.push('audio', 'video');
            changes.audio = {
                full_text_changed: !isEqual(oldScene.audio?.full_text, newScene.audio?.full_text),
                voice_changed: !isEqual(oldScene.audio?.voice, newScene.audio?.voice),
            };
        }

        // Unit/image changes
        const oldUnits = (oldScene.units || []).concat(
            (oldScene.dialogue_blocks || []).flatMap(db => db.units || [])
        );
        const newUnits = (newScene.units || []).concat(
            (newScene.dialogue_blocks || []).flatMap(db => db.units || [])
        );

        if (!isEqual(oldUnits, newUnits)) {
            dirtyLayers.push('image', 'video');
            changes.units = {
                old_count: oldUnits.length,
                new_count: newUnits.length,
            };
        }

        // Scene-level changes
        if (!isEqual(oldScene.location, newScene.location) ||
            !isEqual(oldScene.participants, newScene.participants) ||
            !isEqual(oldScene.style, newScene.style)) {
            dirtyLayers.push('image', 'video');
            changes.scene = {
                location_changed: !isEqual(oldScene.location, newScene.location),
                participants_changed: !isEqual(oldScene.participants, newScene.participants),
                style_changed: !isEqual(oldScene.style, newScene.style),
            };
        }

        return {
            dirty_layers: [...new Set(dirtyLayers)],
            changes: Object.keys(changes).length > 0 ? changes : null,
        };
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

        // Check for added, removed, or changed scenes
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

        return {
            dirty_scenes: dirtyScenes,
            changes: {
                added: Object.keys(newMap).filter(k => !oldMap[k]).length,
                removed: Object.keys(oldMap).filter(k => !newMap[k]).length,
                modified: dirtyScenes.filter(d => d.reason === 'changed').length,
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

            // Build chunk ID
            const chunkId = `${bookId}_${chapter_id}_${scene_id}_0001`;
            const chunk = await getChunk(chunkId) || {};

            // Reset state based on dirty layers
            if (resetAudio) {
                chunk.audio = false;
                chunk.audio_status = 'pending';
            }
            if (resetImage) {
                chunk.image = false;
                chunk.video_status = 'pending';
            }
            if (resetVideo) {
                chunk.video = false;
                chunk.video_status = 'pending';
            }

            await saveChunk(chunkId, {
                ...chunk,
                build_id: buildId,
                book_id: bookId,
                chapter_id,
                scene_id,
                chunk_index: '0001',
            });

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
            case 'AUDIO_ONLY':
                newProfile = { audio_enabled: true, image_enabled: false, video_enabled: false };
                break;
            case 'STORYBOARD':
                newProfile = { audio_enabled: true, image_enabled: true, video_enabled: false };
                break;
            case 'FULL':
            default:
                newProfile = { audio_enabled: true, image_enabled: true, video_enabled: true };
                break;
        }
        await layerConfig.set(redis, bookId, newProfile);
        log(`📋 Layer profile updated for ${bookId}:`, JSON.stringify(newProfile));
        return newProfile;
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
