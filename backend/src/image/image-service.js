// ======================================================
// Image Service - v1.1.0 (Connector-aware)
// ======================================================
// Handles IU image generation, registration, and validation.
// Uses the connector system to resolve workflow nodeIds instead
// of hardcoded constants.

const config = require('../config/runtime-config');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const gpu = require('../runtime/gpu-dispatcher');
const wfLoader = require('../workflows/workflow-loader');
const { makeIUImageFilename, makePreviewFilename } = require('../storage/filesystem-store');

// Connector-aware: resolve nodeId via connector (connectors required)
const WORKFLOW_NAME = 'img-qwen-image';

/**
 * Get node ID from connector.
 */
function getImageNodeId(entityKey) {
  const connector = wfLoader.getConnector(WORKFLOW_NAME);
  if (connector) {
    const cl = require('../workflows/connector-loader');
    const nodeId = cl.getNodeId(connector, entityKey);
    if (nodeId) return nodeId;
  }
  return null;
}

/**
 * Apply value to workflow JSON via connector binding.
 */
function applyImageValue(wf, entityKey, value) {
  const connector = wfLoader.getConnector(WORKFLOW_NAME);
  if (connector) {
    const cl = require('../workflows/connector-loader');
    return cl.setValue(wf, connector, entityKey, value);
  }
  return false;
}

// Helper to build output paths
function getOutputPath(...parts) {
    return path.join(config.OUTPUT_DIR, ...parts.filter(Boolean));
}

/**
 * Get image metadata (dimensions) using native Node.js fs operations.
 */
const getImageMetadata = async (imagePath) => {
    try {
        if (!fs.existsSync(imagePath)) {
            return null;
        }
        const stats = fs.statSync(imagePath);
        const metadata = await sharp(imagePath).metadata();
        return {
            exists: true,
            size: stats.size,
            width: metadata.width || null,
            height: metadata.height || null,
            format: metadata.format || null
        };
    } catch {
        return null;
    }
};

const logPrefix = '[IMAGE]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} 🐞 DEBUG: ${msg}`);
}

// ======================================================
// IU IMAGE REGISTRY
// ======================================================

async function saveIURegistry(redis, iuId, buildId) {
    const key = `${config.REDIS.IU_REGISTRY_PREFIX}:${iuId}`;
    await redis.set(key, JSON.stringify({ build_id: buildId, iu_id: iuId, ts: Date.now() }), 'EX', 86400);
}

async function getIURegistry(redis, iuId) {
    const key = `${config.REDIS.IU_REGISTRY_PREFIX}:${iuId}`;
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
}

// ======================================================
// IU IMAGE HELPERS
// ======================================================

function probeIUImage(iuId, buildId, OUTPUT_DIR) {
    const dir = path.join(OUTPUT_DIR, buildId);
    try {
        if (!fs.existsSync(dir)) {
            return { image: false, path: null };
        }
        const imgPath = path.join(dir, `${iuId}.png`);
        if (fs.existsSync(imgPath)) {
            return { image: true, path: imgPath };
        }
        return { image: false, path: null };
    } catch (err) {
        error(`probeIUImage error: ${err.message}`);
        return { image: false, path: null };
    }
}

// ======================================================
// SCENE IMAGE HELPERS
// ======================================================

function resolveCanonicalSceneImage(OUTPUT_DIR, buildId, bookId, chapterId, sceneId) {
    const dir = path.join(OUTPUT_DIR, buildId);
    const scenePrefix = `${bookId}_${chapterId}_${sceneId}_iu`;

    try {
        if (!fs.existsSync(dir)) {
            return null;
        }
        const files = fs.readdirSync(dir);

        const iuImages = files.filter(f => f.startsWith(scenePrefix) && f.endsWith('.png'));

        if (iuImages.length > 0) {
            iuImages.sort();
            log(`CANONICAL IU IMAGE: ${iuImages[0]}`);
            return iuImages[0];
        }
    } catch (err) {
        error(`Error scanning IU images for scene: ${bookId}/${chapterId}/${sceneId}`, err.message);
    }

    return null;
}

function collectSceneUnits(scenePayload) {
    const result = [];
    if (scenePayload?.units?.length) {
        result.push(...scenePayload.units);
    }
    if (scenePayload?.dialogue_blocks?.length) {
        for (const block of scenePayload.dialogue_blocks) {
            if (block?.units?.length) {
                result.push(...block.units);
            }
        }
    }
    return result;
}

// ======================================================
// PROMPT HELPERS
// ======================================================

function cleanJoin(parts) {
    return parts.filter(Boolean).join(", ")
}

function resolveRenderMode(scene, book) {
    if (scene?.visual?.render) {
        if (scene.visual.render === "none") return null
        return scene.visual.render
    }
    const globalRender = book?.manifest?.render?.mode
    if (!globalRender || globalRender === "none") return null
    return globalRender
}

function resolveSceneLocation(scene) {
    if (!scene?.location) {
        return { id: null, environment: {} }
    }
    if (typeof scene.location === "string") {
        return { id: scene.location, environment: {} }
    }
    return {
        id: scene.location.id || null,
        environment: scene.location.environment || {}
    }
}

function resolveField(field, globalP, chapterP, sceneP) {
    return sceneP?.[field]
        || chapterP?.[field]
        || globalP?.[field]
        || ""
}

function resolvePassport(c, chapter, scene) {
    const globalP = c.passport || {}
    const chapterP = chapter?.character?.[c.id] || {}
    const sceneP = scene.visual?.character?.[c.id] || {}
    return {
        base_appearance: resolveField("base_appearance", globalP, chapterP, sceneP),
        detailed_appearance: resolveField("detailed_appearance", globalP, chapterP, sceneP),
        clothing_base: resolveField("clothing_base", globalP, chapterP, sceneP),
        clothing_details: resolveField("clothing_details", globalP, chapterP, sceneP)
    }
}

function isPlaceholder(text) {
    return /unspecified|not specified|unknown|tbd|to be determined|as described/i.test(text)
}

function buildCharacterPassport(p) {
    if (!p) return { appearance: "", clothing: "" }
    const appearance = [
        p.base_appearance && !isPlaceholder(p.base_appearance) ? p.base_appearance : null,
        p.detailed_appearance && !isPlaceholder(p.detailed_appearance) ? p.detailed_appearance : null,
    ].filter(Boolean).join(" ")
    const clothing = [
        p.clothing_base && !isPlaceholder(p.clothing_base) ? p.clothing_base : null,
        p.clothing_details && !isPlaceholder(p.clothing_details) ? p.clothing_details : null,
    ].filter(Boolean).join(" ")
    return { appearance: appearance.trim(), clothing: clothing.trim() }
}

function resolveState(c, chapter, scene) {
    return (
        scene.state?.[c.id] ||
        chapter?.state?.[c.id] ||
        ""
    )
}

function buildCharacters(scenePayload, unit, chapter, book) {
    // Passports are keyed by character id and injected from the participant id
    // list. Per prompt-dependency-registry, scene.participants is the source of
    // truth; unit.participants is almost always empty (units are created with
    // participants: []). Union both, preferring ids that resolve to a character.
    const participants = [
        ...(scenePayload?.participants || []),
        ...(unit?.participants || []),
    ]
    const seen = new Set()
    const chars = participants
        .filter(id => (seen.has(id) ? false : (seen.add(id), true)))
        .map(id => book.characters?.find(c => c.id === id))
        .filter(Boolean)
    if (!chars.length) {
        return []
    }
    const result = []
    for (const c of chars) {
        const resolvedP = resolvePassport(c, chapter, scenePayload)
        const { appearance, clothing } = buildCharacterPassport(resolvedP)
        const state = resolveState(c, chapter, scenePayload)
        let desc
        if (appearance) {
            desc = appearance
            if (clothing) desc += ", " + clothing
        } else {
            desc = c.name || c.id
        }
        const parts = [desc]
        if (state) parts.push(state)
        result.push(`${c.id}: ${cleanJoin(parts)}`)
    }
    return result
}

function buildShotPrompt(unit) {
    const shot = unit?.visual?.shot;
    if (shot) {
        return `${shot.replace(/_/g, " ")} shot`;
    }
    return null;
}

const CYR_LATIN_MAP = {
    'А':'A','а':'a','Б':'B','б':'b','В':'V','в':'v','Г':'G','г':'g','Д':'D','д':'d',
    'Е':'Ye','е':'e','Ё':'Yo','ё':'yo','Ж':'Zh','ж':'zh','З':'Z','з':'z','И':'I','и':'i',
    'Й':'Y','й':'y','К':'K','к':'k','Л':'L','л':'l','М':'M','м':'m','Н':'N','н':'n',
    'О':'O','о':'o','П':'P','п':'p','Р':'R','р':'r','С':'S','с':'s','Т':'T','т':'t',
    'У':'U','у':'u','Ф':'F','ф':'f','Х':'Kh','х':'kh','Ц':'Ts','ц':'ts','Ч':'Ch','ч':'ch',
    'Ш':'Sh','ш':'sh','Щ':'Shch','щ':'shch','Ъ':'','ъ':'','Ы':'Y','ы':'y','Ь':'','ь':'',
    'Э':'E','э':'e','Ю':'Yu','ю':'yu','Я':'Ya','я':'ya',
}

function cyrToLatin(text) {
    return text.split('').map(ch => CYR_LATIN_MAP[ch] || ch).join('')
}

function buildCharacterAliases(c) {
    const aliases = new Set()
    // last segment of character_id is usually the surname — most common reference
    const idParts = (c.id || '').split('_')
    const surname = idParts[idParts.length - 1]
    if (surname && surname.length >= 3) {
        aliases.add(surname.charAt(0).toUpperCase() + surname.slice(1))
    }
    // parenthesized alias from name, e.g. "Иван Николаевич Понырев (Бездомный)" → "Бездомный"
    const paren = c.name?.match(/\(([^)]+)\)/)
    if (paren) {
        for (const w of paren[1].split(/[\s,]+/).filter(Boolean)) {
            if (w.length >= 2) {
                aliases.add(w)
                const latin = cyrToLatin(w)
                    .replace(/yy$/i, 'y')
                    .replace(/yi$/i, 'y')
                if (latin !== w) aliases.add(latin)
            }
        }
    }
    // full name words (useful when AI writes in Russian)
    for (const w of (c.name || '').split(/[\s,()]+/).filter(Boolean)) {
        if (w.length >= 3) {
            aliases.add(w)
            const latin = cyrToLatin(w)
                .replace(/yy$/i, 'y')
                .replace(/yi$/i, 'y')
            if (latin !== w) aliases.add(latin)
        }
    }
    // sort longest first so longer matches take priority
    return [...aliases].sort((a, b) => b.length - a.length)
}

function normalizeCharacterRefs(text, characters) {
    if (!text || !characters?.length) return text
    let result = text
    // collect all aliases to avoid id-as-alias collisions
    for (const c of characters) {
        const aliases = buildCharacterAliases(c)
        for (const alias of aliases) {
            // avoid matching inside underscore-connected identifiers
            const re = new RegExp('(?<!\\w)' + alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\w)', 'gi')
            result = result.replace(re, c.id)
        }
    }
    return result
}

function resolveNegativePrompt(unit, scenePayload) {
    return unit?.visual?.negative
        || unit?.negative
        || unit?.negative_prompt
        || unit?.visual?.negative_prompt
        || scenePayload?.negative
        || scenePayload?.visual?.negative
        || scenePayload?.negative_prompt
        || scenePayload?.visual?.negative_prompt
        || '';
}

function buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload) {
    if (!bookPayload) {
        error("buildImagePrompt: bookPayload is undefined")
        return "cinematic illustration"
    }

    if (iuPayload?.type === "typography") {
        const parts = []
        const renderMode = resolveRenderMode(scenePayload, bookPayload)
        if (renderMode) {
            parts.push(`style ${renderMode.replace(/_/g, " ")}`)
        }
        const directPrompt = iuPayload?.visual?.prompt
        if (directPrompt) {
            parts.push(directPrompt)
        }
        if (iuPayload?.visual?.quality) {
            parts.push(`image quality: ${iuPayload.visual.quality}`)
        } else {
            parts.push("image quality: highly detailed, sharp typography, clean composition, professional typesetting")
        }
        const finalPrompt = cleanJoin(parts)
        debug(`TYPOGRAPHY IU PROMPT: ${finalPrompt}`)
        return finalPrompt || 'cinematic illustration'
    }

    const parts = []

    const renderMode = resolveRenderMode(scenePayload, bookPayload)
    if (renderMode) {
        parts.push(`style ${renderMode.replace(/_/g, " ")}`)
    }

    if (iuPayload?.visual?.style) {
        parts.push(iuPayload.visual.style)
    } else if (scenePayload?.visual?.style) {
        parts.push(scenePayload.visual.style)
    }

    const resolvedLocation = resolveSceneLocation(scenePayload)
    const loc = bookPayload?.bible?.locations?.[resolvedLocation.id]
    if (loc?.visual_style) {
        parts.push(loc.visual_style.replace(/\s+matching\s+narrative\s+context.*/i, '').trim())
    }
    if (loc?.description) {
        parts.push(loc.description)
    }

    const env = resolvedLocation.environment
    if (env?.time) parts.push(env.time)
    if (env?.weather) parts.push(env.weather)
    if (env?.mood) parts.push(env.mood)

    if (iuPayload?.visual?.lighting) {
        parts.push(iuPayload.visual.lighting)
    } else if (scenePayload?.visual?.lighting) {
        parts.push(scenePayload.visual.lighting)
    } else if (env?.lighting) {
        parts.push(env.lighting)
    }

    const shotPrompt = buildShotPrompt(iuPayload)
    if (shotPrompt) {
        parts.push(shotPrompt)
    }

    parts.push(...buildCharacters(scenePayload, iuPayload, chapterPayload, bookPayload))

    const directPrompt = iuPayload?.visual?.prompt
    if (directPrompt) {
        const normalized = normalizeCharacterRefs(directPrompt, bookPayload?.characters)
        debug(`DIRECT PROMPT (IU): ${directPrompt}`)
        debug(`NORMALIZED: ${normalized}`)
        parts.push(normalized)
    }

    if (iuPayload?.visual?.quality) {
        parts.push(`image quality: ${iuPayload.visual.quality}`)
    } else if (scenePayload?.visual?.quality) {
        parts.push(`image quality: ${scenePayload.visual.quality}`)
    } else {
        parts.push("image quality: highly detailed, sharp focus")
    }

    const finalPrompt = cleanJoin(parts)
    debug(`FINAL IMAGE PROMPT: ${finalPrompt}`)
    return finalPrompt || 'cinematic illustration'
}

function buildIUImageWorkflow(iuPayload, scenePayload, chapterPayload, bookPayload) {
    const renderMode = iuPayload.render || scenePayload.render || bookPayload.render?.mode || 'standard';
    const baseNegative = 'blurry, low quality, artifacts';
    const customNegative = resolveNegativePrompt(iuPayload, scenePayload);

    return {
        workflow: WORKFLOW_NAME,
        render_mode: renderMode,
        prompt: buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload),
        negative_prompt: customNegative ? `${customNegative}, ${baseNegative}` : baseNegative,
        scene: scenePayload,
        iu: iuPayload,
        chapter: chapterPayload,
        book: bookPayload
    };
}

function generateIUImageWorkflow(unit, scenePayload, chapterPayload, bookPayload) {
    const renderMode = unit.render || scenePayload.render || bookPayload.render?.mode;
    if (renderMode === 'none') return null;

    const baseNegative = 'blurry, low quality, artifacts';
    const customNegative = resolveNegativePrompt(unit, scenePayload);

    return {
        workflow: WORKFLOW_NAME,
        render_mode: renderMode,
        prompt: buildImagePrompt(unit, scenePayload, chapterPayload, bookPayload),
        negative_prompt: customNegative ? `${customNegative}, ${baseNegative}` : baseNegative,
        unit_id: unit.id,
        scene: scenePayload,
        iu: unit,
        chapter: chapterPayload,
        book: bookPayload
    };
}

// ======================================================
// IU METADATA
// ======================================================

async function saveIUMetadata(buildId, bookId, chapterId, sceneId, unit, sceneDuration, fullText, sceneOrder) {
    const iuText = unit.text || '';
    const proportion = fullText.length > 0 ? iuText.length / fullText.length : 0;
    const iuDuration = sceneDuration * proportion;

    try {
        const { iu } = require('../storage/postgres/repositories');
        await iu.upsertImageUnit(buildId, bookId, chapterId, sceneId, String(unit.id), {
            scene_order: sceneOrder != null ? sceneOrder : 0,
            text: iuText,
            text_length: iuText.length,
            text_proportion: parseFloat(proportion.toFixed(6)),
            scene_duration_sec: sceneDuration,
            estimated_duration_sec: parseFloat(iuDuration.toFixed(3)),
            scene_audio_file: `${bookId}_${chapterId}_${sceneId}.mp3`,
        });
        log(`IU metadata saved to PG: ${unit.id} (${iuDuration.toFixed(3)}s)`);
    } catch (err) {
        warn(`Failed to save IU metadata to PG: ${err.message}`);
    }
}

async function getSceneDuration(buildId, bookId, chapterId, sceneId) {
    try {
        const { query } = require('../storage/postgres/database');
        const result = await query(`
            SELECT scene_duration_sec FROM image_units
            WHERE build_id = $1 AND book_id = $2 AND chapter_id = $3 AND scene_id = $4
            LIMIT 1
        `, [buildId, bookId, chapterId, sceneId]);
        if (result.rows.length > 0 && result.rows[0].scene_duration_sec > 0) return result.rows[0].scene_duration_sec;
    } catch {}

    const audioPath = getOutputPath(buildId, `${bookId}_${chapterId}_${sceneId}.mp3`);
    if (fs.existsSync(audioPath)) {
        try {
            const mm = require('music-metadata');
            const metadata = await mm.parseFile(audioPath);
            if (metadata.format.duration > 0) return metadata.format.duration;
        } catch {}
    }

    try {
        const { query } = require('../storage/postgres/database');
        const result = await query(`
            SELECT duration_sec FROM scene_assets
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
              AND asset_type = 'audio' AND build_id = $4 AND status IN ('placeholder', 'ready')
            LIMIT 1
        `, [bookId, chapterId, sceneId, buildId]);
        if (result.rows.length > 0 && result.rows[0].duration_sec > 0) return result.rows[0].duration_sec;
    } catch {}

    return 0;
}

async function processSingleIU(redis, unit, uIdx, sceneData, loadedBook, buildId, bookId, chapterId, sceneId, sceneDuration, fullText, dirtyUnitIds = new Set()) {
    const canonicalUnitId = String(unit.id);
    if (!canonicalUnitId) {
        error(`IU unit.id missing, skipping: ${chapterId}/${sceneId}`);
        return { sent: false, cached: false };
    }
    const imageIUId = `${bookId}_${chapterId}_${sceneId}_${canonicalUnitId}`;
    // Redis key tracking in-flight regeneration (set after gpu.send(),
    // cleared in handleImageCompleted). Used to prevent duplicate dispatches.
    const inFlightKey = `animastor:iu-in-flight:${imageIUId}`;

    // If this unit is in dirtyUnitIds set, skip disk cache — force regenerate
    const force = dirtyUnitIds.size > 0 && dirtyUnitIds.has(canonicalUnitId);
    if (!force) {
        // Check in-flight marker to prevent duplicate dispatch across ticks
        const alreadyInFlight = await redis.get(inFlightKey);
        if (alreadyInFlight) {
            log(`[IU-ALREADY-IN-FLIGHT] Skipping ${imageIUId} — already dispatched (marker exists)`);
            return { sent: false, cached: false, skipped: true };
        }
        const cachedIU = probeIUImage(imageIUId, buildId, config.OUTPUT_DIR);
        if (cachedIU?.image) {
            try {
                await saveIUMetadata(buildId, bookId, chapterId, sceneId, unit, sceneDuration, fullText, uIdx);
            } catch (err) {
                warn(`Failed to save IU metadata for ${unit.id}: ${err.message}`);
            }
            log(`IMAGE (IU) CACHE HIT: ${imageIUId}`);
            await saveIURegistry(redis, imageIUId, buildId);
            return { sent: false, cached: true };
        }
    } else {
        log(`[DIRTY-UNIT-REGEN] Force-regenerating ${imageIUId} — this unit was modified`);
        const oldPng = path.join(config.OUTPUT_DIR, buildId, `${imageIUId}.png`);

        // Check if this dirty unit was already dispatched by a prior scheduler tick
        // or by the /regenerate handler (which pre-deletes files + clears dedup).
        // Redis marker prevents duplicate dispatches.
        const alreadyInFlight = await redis.get(inFlightKey);
        if (alreadyInFlight) {
            log(`[IU-ALREADY-IN-FLIGHT] Skipping ${imageIUId} — already dispatched (marker exists)`);
            return { sent: false, cached: false, skipped: true };
        }

        // Clear GPU hub dedup keys BEFORE sending the new task — the hub checks
        //   animastor:job:{iuId}:iu_image  to reject duplicate /task submissions.
        // Without clearing, the hub would reject our regen task as duplicate.
        //   animastor:result-processed:{iuId}:iu_image:{buildId}  is our OWN
        // backend dedup (blocks /gpu/task/result retries). We clear it AFTER
        // gpu.send() to prevent a stale hub retry from grabbing it before the
        // new task is accepted. See race analysis below.
        try {
            await redis.del(
                `animastor:job:${imageIUId}:iu_image`,
                `animastor:job:${imageIUId}:image`
            );
            log(`[DEDUP-CLEAR] Cleared hub dedup keys for ${imageIUId}`);
        } catch (e) {
            warn(`[DEDUP-CLEAR] Failed: ${e.message}`);
        }

        // Delete stale PNG if it still exists (may have been pre-deleted by /regenerate handler).
        try {
            if (fs.existsSync(oldPng)) {
                fs.unlinkSync(oldPng);
                log(`[DIRTY-UNIT-REGEN] Deleted stale PNG: ${oldPng}`);
            }
        } catch (delErr) {
            warn(`[DIRTY-UNIT-REGEN] Failed to delete stale PNG ${oldPng}: ${delErr.message}`);
        }

        // Also delete stale preview thumbnail (pr-*.png) so getOrCreatePreview
        // regenerates it from the new IU image instead of returning the old one.
        const strippedUnitId = canonicalUnitId.replace(/^iu/, '');
        const oldPreview = path.join(config.OUTPUT_DIR, buildId,
            `${bookId}_${chapterId}_${sceneId}_pr${strippedUnitId}.png`);
        try {
            if (fs.existsSync(oldPreview)) {
                fs.unlinkSync(oldPreview);
                log(`[DIRTY-UNIT-REGEN] Deleted stale preview: ${oldPreview}`);
            }
        } catch (delErr) {
            warn(`[DIRTY-UNIT-REGEN] Failed to delete stale preview ${oldPreview}: ${delErr.message}`);
        }
    }

    try {
        await saveIUMetadata(buildId, bookId, chapterId, sceneId, unit, sceneDuration, fullText, uIdx);
    } catch (err) {
        warn(`Failed to save IU metadata for ${unit.id}: ${err.message}`);
    }

    const finalPrompt = buildImagePrompt(unit, sceneData.payload, sceneData.chapter, loadedBook);
    const workflow = buildIUImageWorkflow(unit, sceneData.payload, sceneData.chapter, loadedBook);

    debug(`📸 IMAGE DISPATCH:\n  - final_image_prompt: ${finalPrompt}\n  - workflow_id: ${workflow?.workflow || 'unknown'}\n  - scene_id: ${chapterId}/${sceneId}\n  - iu_id: ${canonicalUnitId}`);

    log(`GENERATE IMAGE (IU): ${imageIUId}, unit.id: ${canonicalUnitId}`);

    // Use connector to resolve nodeIds instead of hardcoded "108"/"109"
    const wfImg = wfLoader.getWorkflow(WORKFLOW_NAME);
    const baseNegative = 'blurry, low quality, artifacts';
    const customNegative = resolveNegativePrompt(unit, sceneData.payload);

    // Apply via connector
    applyImageValue(wfImg, 'positivePrompt', finalPrompt);
    applyImageValue(wfImg, 'negativePrompt', customNegative ? `${customNegative}, ${baseNegative}` : baseNegative);

    // Set in-flight marker BEFORE gpu.send() to prevent race condition:
    // without this, a second tick between PNG-delete and gpu.send() would
    // also delete the (already deleted) PNG, find no file, clear dedup again,
    // and send a duplicate GPU task. The first such task to finish triggers
    // handleImageCompleted (4/4 files on disk) while others are still running.
    // TTL = 1200s (20 min) — covers max generation time for any IU type.
    try {
        await redis.set(inFlightKey, '1', 'EX', 1200);
    } catch (e) {
        warn(`[IU-IN-FLIGHT] Failed to set marker for ${imageIUId}: ${e.message}`);
    }

    // ── Clear stale backend dedup BEFORE gpu.send() ────────────
    //
    // Clearing animastor:result-processed BEFORE gpu.send() prevents the
    // OLD dedup key (from the first generation, TTL 1h) from blocking the
    // NEW generation's result. Without this, a fast GPU hub that processes
    // the task during the gpu.send() await would see the old dedup key and
    // silently skip the result — the progress counter never increments.
    //
    // We also clear AFTER gpu.send() to handle the (rare) case where a
    // stale hub retry sneaks in between the two clears.
    try {
        await redis.del(`animastor:result-processed:${imageIUId}:iu_image:${buildId}`);
        log(`[DEDUP-CLEAR-BACKEND] Pre-cleared result-processed dedup for ${imageIUId}`);
    } catch (e) {
        warn(`[DEDUP-CLEAR-BACKEND] Pre-clear failed: ${e.message}`);
    }

    await saveIURegistry(redis, imageIUId, buildId);
    // Use :iu_image suffix for unambiguous type detection in resolveAssetPath
    await gpu.send(`${imageIUId}:iu_image`, wfImg, 'image', buildId);

    // ── Post-send safety clear ──────────────────────────────────
    // After the hub has accepted the new task, stale retries from the
    // previous generation are no longer in-flight. A second clear is
    // cheap insurance against any race between the pre-clear and gpu.send().
    try {
        await redis.del(`animastor:result-processed:${imageIUId}:iu_image:${buildId}`);
        log(`[DEDUP-CLEAR-BACKEND] Post-cleared result-processed dedup for ${imageIUId}`);
    } catch (e) {
        warn(`[DEDUP-CLEAR-BACKEND] Post-clear failed: ${e.message}`);
    }

    return { sent: true, cached: false };
}

async function generateSceneIUImages(redis, sceneData, loadedBook, buildId, bookId, dirtyUnitIds = new Set()) {
    const units = collectSceneUnits(sceneData.payload);
    const chapterId = sceneData.chapter_id;
    const sceneId = sceneData.scene_id;
    log(`[IMG-DEBUG] generateSceneIUImages buildId=${buildId} bookId=${bookId} chapterId=${chapterId} sceneId=${sceneId}`);
    if (!buildId) {
        error(`[IMG-DEBUG] buildId is null for ${bookId}/${chapterId}/${sceneId}!`);
    }

    const sceneDuration = await getSceneDuration(buildId, bookId, chapterId, sceneId);
    const fullText = sceneData.payload?.audio?.full_text || '';

    let sentCount = 0;
    for (let uIdx = 0; uIdx < units.length; uIdx++) {
        const result = await processSingleIU(redis, units[uIdx], uIdx, sceneData, loadedBook, buildId, bookId, chapterId, sceneId, sceneDuration, fullText, dirtyUnitIds);
        if (result.sent) sentCount++;
    }
    return { sentCount, total: units.length };
}

// ======================================================
// PREVIEW THUMBNAILS
// ======================================================

const PREVIEW_WIDTH = 240;

async function getOrCreatePreview(bookId, chapterId, sceneId, iuId, buildId) {
    const strippedId = iuId.replace(/^iu/, '');
    const sourceName = makeIUImageFilename(bookId, chapterId, sceneId, strippedId);
    const previewName = makePreviewFilename(bookId, chapterId, sceneId, strippedId);

    const outputDir = config.OUTPUT_DIR;
    const dirs = [];
    const requestedDir = path.join(outputDir, buildId);
    if (fs.existsSync(requestedDir)) {
        dirs.push(requestedDir);
    }
    try {
        const allDirs = fs.readdirSync(outputDir)
            .filter(d => d !== buildId)
            .map(d => path.join(outputDir, d))
            .filter(d => fs.statSync(d).isDirectory());
        dirs.push(...allDirs);
    } catch (_) {}

    for (const dir of dirs) {
        const previewPath = path.join(dir, previewName);
        if (fs.existsSync(previewPath)) {
            return { path: previewPath, created: false };
        }
        const sourcePath = path.join(dir, sourceName);
        if (fs.existsSync(sourcePath)) {
            try {
                await sharp(sourcePath)
                    .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
                    .png()
                    .toFile(previewPath);
                log(`preview created: ${previewName} (in ${path.basename(dir)})`);
                return { path: previewPath, created: true };
            } catch (err) {
                error(`preview generation failed for ${sourceName}: ${err.message}`);
                return null;
            }
        }
    }

    warn(`preview source not found for ${sourceName} in any build dir`);
    return null;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    getOutputPath,
    saveIURegistry,
    getIURegistry,
    probeIUImage,
    resolveCanonicalSceneImage,
    collectSceneUnits,
    buildIUImageWorkflow,
    buildImagePrompt,
    generateIUImageWorkflow,
    generateSceneIUImages,
    processSingleIU,
    getImageMetadata,
    saveIUMetadata,
    getSceneDuration,
    getOrCreatePreview,
    // Exposed for connector-aware usage
    applyImageValue,
    getImageNodeId,
    WORKFLOW_NAME,
};
