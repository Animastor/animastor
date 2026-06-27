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

    // ── Lua script: atomic scene dirty reset ────────
    // Atomically resets chunks, asset state, and active index
    // for one scene via FSM-valid transitions.
    // Scene state is NOT set here — syncLinearState() derives it from
    // per-asset states after the script returns.
    //
    // FSM transition validation:
    //   - Asset state is transitioned to 'pending' from any source state
    //     through the shortest valid FSM path:
    //       NEW → pending (valid: NEW→PENDING)
    //       DIRTY → pending (valid: DIRTY→PENDING)
    //       PENDING → pending (same state, no-op)
    //       GENERATING → pending (valid: GENERATING→DIRTY→PENDING)
    //       READY → pending (valid: READY→DIRTY→PENDING)
    //       FAILED → pending (valid: FAILED→PENDING)
    //       PLACEHOLDER → pending (valid: PLACEHOLDER→DIRTY→PENDING)
    const RESET_SCENE_LUA = `
        local args = cjson.decode(ARGV[1])
        local prefix = 'animastor:chunk:' .. args.bookId .. '_' .. args.chapterId .. '_' .. args.sceneId .. '_'
        local chunkSetKey = KEYS[4]
        local cursor = '0'
        local created = false

        -- PHASE 1: SCAN and reset all existing chunks
        repeat
            local result = redis.call('SCAN', cursor, 'MATCH', prefix .. '*', 'COUNT', 50)
            cursor = result[1]
            for _, key in ipairs(result[2]) do
                local raw = redis.call('GET', key)
                local ch = {}
                if raw and raw ~= '' then
                    ch = cjson.decode(raw)
                end
                if args.resetAudio then
                    ch.audio = false; ch.audio_status = 'pending'
                end
                if args.resetImage then
                    ch.image = false; ch.image_status = 'pending'
                end
                if args.resetVideo then
                    ch.video = false; ch.video_status = 'pending'
                end
                ch.build_id = args.buildId
                ch.book_id = args.bookId
                ch.chapter_id = args.chapterId
                ch.scene_id = args.sceneId
                redis.call('SET', key, cjson.encode(ch))
                local chunkId = key:gsub('^animastor:chunk:', '')
                redis.call('SADD', chunkSetKey, chunkId)
                created = true
            end
        until cursor == '0'

        -- PHASE 2: If no chunks existed, create default chunk
        if not created then
            local defaultChunk = {
                build_id = args.buildId,
                book_id = args.bookId,
                chapter_id = args.chapterId,
                scene_id = args.sceneId,
                chunk_index = '0001',
                expected_chunk_count = 1,
                padded_text = false
            }
            if args.resetAudio then
                defaultChunk.audio = false; defaultChunk.audio_status = 'pending'
            end
            if args.resetImage then
                defaultChunk.image = false; defaultChunk.image_status = 'pending'
            end
            if args.resetVideo then
                defaultChunk.video = false; defaultChunk.video_status = 'pending'
            end
            local defaultId = args.bookId .. '_' .. args.chapterId .. '_' .. args.sceneId .. '_0001'
            redis.call('SET', 'animastor:chunk:' .. defaultId, cjson.encode(defaultChunk))
            redis.call('SADD', chunkSetKey, defaultId)
        end

        -- PHASE 3: FSM-valid asset state transitions
        -- Reads current asset states via HGETALL (same format as JS code),
        -- validates the path to 'pending' exists for each dirty layer,
        -- then writes atomically via HSET. Must NOT use SET/GET here —
        -- the JS code (scene-state.js) uses HSET/HGETALL and would throw
        -- WRONGTYPE on a string-typed key, losing the new asset states.
        local existingFields = redis.call('HGETALL', KEYS[2])
        local assetData = {}
        for i = 1, #existingFields, 2 do
            assetData[existingFields[i]] = existingFields[i + 1]
        end

        local function transitionToPending(current)
            -- All states can reach PENDING via valid FSM paths
            if current == 'new' then return 'pending' end
            if current == 'dirty' then return 'pending' end
            if current == 'pending' then return 'pending' end
            if current == 'ready' then return 'pending' end   -- ready->dirty->pending
            if current == 'generating' then return 'pending' end    -- generating->dirty->pending
            if current == 'failed' then return 'pending' end  -- failed->pending
            if current == 'placeholder' then return 'pending' end   -- placeholder->dirty->pending
            return 'pending'  -- fallback for unknown values
        end

        if args.resetAudio then assetData['audio'] = transitionToPending(assetData['audio'] or 'new') end
        if args.resetImage then assetData['image'] = transitionToPending(assetData['image'] or 'new') end
        if args.resetVideo then assetData['video'] = transitionToPending(assetData['video'] or 'new') end
        -- Write via HSET to maintain hash type compatibility with JS code
        redis.call('DEL', KEYS[2])
        for k, v in pairs(assetData) do
            redis.call('HSET', KEYS[2], k, v)
        end

        -- PHASE 4: Add to active scenes
        redis.call('SADD', KEYS[3], args.bookId .. ':' .. args.chapterId .. ':' .. args.sceneId)

        -- Scene state (KEYS[1]) is NOT set here.
        -- syncLinearState() derives it from per-asset states after this script returns.

        return { marked = true }
    `;

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

            // Determine new scene state
            let newState;
            if (resetAudio) {
                newState = state.SceneState.AUDIO_PENDING;
            } else if (resetImage) {
                newState = state.SceneState.IMAGE_PENDING;
            } else {
                newState = state.SceneState.VIDEO_PENDING;
            }

            // Build Redis keys for this scene
            const sceneStateKey = `${state.SCENE_STATE_KEY_PREFIX}:${bookId}:${chapter_id}:${scene_id}`;
            const assetStateKey = `${state.ASSET_STATE_KEY_PREFIX}:${bookId}:${chapter_id}:${scene_id}`;
            const activeScenesKey = 'animastor:active-scenes';
            const chunksSetKey = `animastor:chunks:${bookId}`;

            // Build args for Lua script
            const luaArgs = JSON.stringify({
                bookId,
                chapterId: chapter_id,
                sceneId: scene_id,
                buildId,
                newState,
                resetAudio,
                resetImage,
                resetVideo,
                sceneType: ds.scene_type || 'narration',
            });

            // Execute atomic scene reset via Lua
            // KEYS[1] (sceneStateKey) — unused by Lua; linear state is synced after
            try {
                await redis.eval(
                    RESET_SCENE_LUA,
                    4,  // numKeys
                    sceneStateKey,    // KEYS[1] (unused by Lua, kept for key slot consistency)
                    assetStateKey,    // KEYS[2]
                    activeScenesKey,  // KEYS[3]
                    chunksSetKey,     // KEYS[4]
                    luaArgs           // ARGV[1]
                );
            } catch (luaErr) {
                // Fallback: do it non-atomically via JS
                log(`⚠️ Lua atomic reset failed, falling back to JS: ${luaErr.message}`);
                await fallbackMarkSceneDirty(redis, bookId, buildId, chapter_id, scene_id,
                    resetAudio, resetImage, resetVideo);
            }

            // Sync linear FSM state from per-asset states (FSM-valid),
            // passing buildId so it's preserved in the scene state for
            // the dispatch engine to use when progressing to next stage.
            // Without buildId, image/video dispatch fails with null path.
            await state.syncLinearState(redis, bookId, chapter_id, scene_id, buildId);

            log(`📋 Dirty scene marked: ${bookId}/${chapter_id}/${scene_id}`);
            marked++;
        }

        log(`📋 Marked ${marked}/${dirtyScenes.length} dirty scenes`);
        return { marked };
    }

    // ── Fallback (non-atomic) — FSM-valid asset transitions ──
    async function fallbackMarkSceneDirty(redis, bookId, buildId, chapterId, sceneId,
                                           resetAudio, resetImage, resetVideo) {
        const chunkPrefix = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_`;
        let cursor = '0';
        let createdAny = false;
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${chunkPrefix}*`, 'COUNT', 50);
            cursor = nextCursor;
            for (const key of keys) {
                const raw = await redis.get(key);
                const ch = raw ? JSON.parse(raw) : {};
                if (resetAudio) { ch.audio = false; ch.audio_status = 'pending'; }
                if (resetImage) { ch.image = false; ch.image_status = 'pending'; }
                if (resetVideo) { ch.video = false; ch.video_status = 'pending'; }
                await redis.set(key, JSON.stringify({ ...ch, build_id: buildId, book_id: bookId, chapter_id: chapterId, scene_id: sceneId }));
                const chunkId = key.replace('animastor:chunk:', '');
                await redis.sadd(`animastor:chunks:${bookId}`, chunkId);
                createdAny = true;
            }
        } while (cursor !== '0');
        if (!createdAny) {
            const chunkId = `${bookId}_${chapterId}_${sceneId}_0001`;
            const ch = {};
            if (resetAudio) { ch.audio = false; ch.audio_status = 'pending'; }
            if (resetImage) { ch.image = false; ch.image_status = 'pending'; }
            if (resetVideo) { ch.video = false; ch.video_status = 'pending'; }
            await redis.set(`animastor:chunk:${chunkId}`, JSON.stringify({
                ...ch, build_id: buildId, book_id: bookId, chapter_id: chapterId,
                scene_id: sceneId, chunk_index: '0001', expected_chunk_count: 1,
            }));
            await redis.sadd(`animastor:chunks:${bookId}`, chunkId);
        }

        // Read current asset states once before the loop
        const currentStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);

        // FSM-valid asset transitions: build PENDING-only updates.
        // For READY/GENERATING, the valid path is →DIRTY→PENDING.
        // Since setAssetStates writes atomically, we skip the intermediate DIRTY
        // and write PENDING directly — the path READY→DIRTY→PENDING (and
        // GENERATING→DIRTY→PENDING) both exist in the FSM.
        const assetUpdates = {};
        for (const [asset, reset] of [['audio', resetAudio], ['image', resetImage], ['video', resetVideo]]) {
            if (!reset) continue;
            const current = currentStates[asset] || state.AssetState.NEW;
            // Validate that a path to PENDING exists from this state
            // NEW→PENDING, DIRTY→PENDING, FAILED→PENDING, PLACEHOLDER→DIRTY→PENDING
            // READY→DIRTY→PENDING, GENERATING→DIRTY→PENDING, PENDING (same)
            const valid = state.validateAssetTransition(current, state.AssetState.PENDING);
            if (!valid.valid) {
                log(`⚠️ FSM: cannot transition ${asset} ${current} → PENDING (${valid.reason}), forcing anyway`);
            }
            assetUpdates[asset] = state.AssetState.PENDING;
        }

        if (Object.keys(assetUpdates).length > 0) {
            await state.setAssetStates(redis, bookId, chapterId, sceneId, assetUpdates);
        }

        // Sync linear FSM from per-asset states instead of force-setting scene state.
        // Pass buildId so scene state preserves it for dispatch engine.
        await state.syncLinearState(redis, bookId, chapterId, sceneId, buildId);

        await activeScenes.addActiveScene(redis, bookId, chapterId, sceneId);
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
