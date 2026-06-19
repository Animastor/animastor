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

// Connector-aware: resolve nodeId via connector, fallback to hardcoded
const WORKFLOW_NAME = 'img-qwen-image';
const FALLBACK_NODES = {
  positivePrompt: '108',
  negativePrompt: '109'
};

/**
 * Get node ID from connector, or fallback.
 */
function getImageNodeId(entityKey) {
  const connector = wfLoader.getConnector(WORKFLOW_NAME);
  if (connector) {
    const cl = require('../workflows/connector-loader');
    const nodeId = cl.getNodeId(connector, entityKey);
    if (nodeId) return nodeId;
  }
  return FALLBACK_NODES[entityKey] || null;
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
  // Legacy fallback: direct nodeId access
  const nodeId = FALLBACK_NODES[entityKey];
  if (nodeId && wf[nodeId]) {
    wf[nodeId].inputs.text = value;
    return true;
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

function shouldGenerateIUImage(iuId, buildId, OUTPUT_DIR) {
    const { image } = probeIUImage(iuId, buildId, OUTPUT_DIR);
    return !image;
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

function buildCharacterPassport(p) {
    if (!p) return ""
    const parts = []
    if (p.base_appearance) parts.push(p.base_appearance)
    if (p.detailed_appearance) parts.push(p.detailed_appearance)
    if (p.clothing_base) parts.push(p.clothing_base)
    if (p.clothing_details) parts.push(p.clothing_details)
    return cleanJoin(parts)
}

function resolveState(c, chapter, scene) {
    return (
        scene.state?.[c.id] ||
        chapter?.state?.[c.id] ||
        ""
    )
}

function buildCharacters(scenePayload, unit, chapter, book) {
    const participants = unit?.participants || []
    const chars = participants
        .map(id => book.characters?.find(c => c.id === id))
        .filter(Boolean)
    if (!chars.length) {
        return []
    }
    const result = []
    for (const c of chars) {
        const resolvedP = resolvePassport(c, chapter, scenePayload)
        const passport = buildCharacterPassport(resolvedP)
        const state = resolveState(c, chapter, scenePayload)
        const parts = []
        if (passport) parts.push(passport)
        if (state) parts.push(state)
        result.push(`consistent character appearance: ${cleanJoin(parts)}`)
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
        parts.push(loc.visual_style)
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
        debug(`DIRECT PROMPT (IU): ${directPrompt}`)
        parts.push(directPrompt)
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

async function processSingleIU(redis, unit, uIdx, sceneData, loadedBook, buildId, bookId, chapterId, sceneId, sceneDuration, fullText) {
    const canonicalUnitId = String(unit.id);
    if (!canonicalUnitId) {
        error(`IU unit.id missing, skipping: ${chapterId}/${sceneId}`);
        return { sent: false, cached: false };
    }
    const imageIUId = `${bookId}_${chapterId}_${sceneId}_${canonicalUnitId}`;

    const cachedIU = probeIUImage(imageIUId, buildId, config.OUTPUT_DIR);
    const existingIUImage = cachedIU?.image || null;

    try {
        await saveIUMetadata(buildId, bookId, chapterId, sceneId, unit, sceneDuration, fullText, uIdx);
    } catch (err) {
        warn(`Failed to save IU metadata for ${unit.id}: ${err.message}`);
    }

    if (!existingIUImage) {
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

        await saveIURegistry(redis, imageIUId, buildId);
        await gpu.send(`${imageIUId}:image`, wfImg, 'image', buildId);
        return { sent: true, cached: false };
    }

    log(`IMAGE (IU) CACHE HIT: ${imageIUId}`);
    await saveIURegistry(redis, imageIUId, buildId);
    return { sent: false, cached: true };
}

async function generateSceneIUImages(redis, sceneData, loadedBook, buildId, bookId) {
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
    let cacheHitCount = 0;
    for (let uIdx = 0; uIdx < units.length; uIdx++) {
        const result = await processSingleIU(redis, units[uIdx], uIdx, sceneData, loadedBook, buildId, bookId, chapterId, sceneId, sceneDuration, fullText);
        if (result.sent) sentCount++;
        if (result.cached) cacheHitCount++;
    }
    return { sentCount, cacheHitCount, total: units.length };
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
    shouldGenerateIUImage,
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
