// ======================================================
// Image Prompt Builder
// ======================================================
// Builds image prompts from scene/unit/character data.
// Uses connectors for workflow node resolution.

const helpers = require('./helpers');
const charUtils = require('./character-utils');

function resolveRenderMode(scene, book) {
    if (scene?.visual?.render) {
        if (scene.visual.render === "none") return null;
        return scene.visual.render;
    }
    const globalRender = book?.manifest?.render?.mode;
    if (!globalRender || globalRender === "none") return null;
    return globalRender;
}

function resolveSceneLocation(scene) {
    if (!scene?.location) {
        return { id: null, environment: {} };
    }
    if (typeof scene.location === "string") {
        return { id: scene.location, environment: {} };
    }
    return {
        id: scene.location.id || null,
        environment: scene.location.environment || {},
    };
}

function resolveField(field, globalP, chapterP, sceneP) {
    return sceneP?.[field]
        || chapterP?.[field]
        || globalP?.[field]
        || "";
}

function resolvePassport(c, chapter, scene) {
    const globalP = c.passport || {};
    const chapterP = chapter?.character?.[c.id] || {};
    const sceneP = scene.visual?.character?.[c.id] || {};
    return {
        base_appearance: resolveField("base_appearance", globalP, chapterP, sceneP),
        detailed_appearance: resolveField("detailed_appearance", globalP, chapterP, sceneP),
        clothing_base: resolveField("clothing_base", globalP, chapterP, sceneP),
        clothing_details: resolveField("clothing_details", globalP, chapterP, sceneP),
    };
}

function buildCharacterPassport(p) {
    if (!p) return { appearance: "", clothing: "" };
    const appearance = [
        p.base_appearance && !helpers.isPlaceholder(p.base_appearance) ? p.base_appearance : null,
        p.detailed_appearance && !helpers.isPlaceholder(p.detailed_appearance) ? p.detailed_appearance : null,
    ].filter(Boolean).join(" ");
    const clothing = [
        p.clothing_base && !helpers.isPlaceholder(p.clothing_base) ? p.clothing_base : null,
        p.clothing_details && !helpers.isPlaceholder(p.clothing_details) ? p.clothing_details : null,
    ].filter(Boolean).join(" ");
    return { appearance: appearance.trim(), clothing: clothing.trim() };
}

function resolveState(c, chapter, scene) {
    return (
        scene.state?.[c.id] ||
        chapter?.state?.[c.id] ||
        ""
    );
}

function buildCharacters(scenePayload, unit, chapter, book) {
    let source = 'unit_scene';
    let participants = [];

    if (unit?.participants?.length) {
        participants = unit.participants;
        source = 'unit_coreference';
    } else if (scenePayload?.participants?.length) {
        participants = scenePayload.participants;
        source = 'scene';
    } else {
        const prompt = unit?.visual?.prompt || scenePayload?.visual?.prompt || '';
        const inferred = charUtils.inferCharactersFromPrompt(prompt, book);
        if (inferred.length > 0) {
            helpers.warn(`[COREFERENCE] Fallback inferCharactersFromPrompt for unit/visual prompt — ${inferred.length} chars inferred`);
            participants = inferred.map(c => c.id);
            source = 'fallback_infer';
        }
    }

    if (participants.length === 0) {
        return [];
    }

    const seen = new Set();
    const chars = participants
        .filter(id => (seen.has(id) ? false : (seen.add(id), true)))
        .map(id => {
            const exact = book.characters?.find(c => c.id === id);
            if (exact) return exact;
            const idNorm = helpers.normalizeForMatch(id);
            for (const c of (book.characters || [])) {
                const cNameNorm = helpers.normalizeForMatch(c.name || '');
                if (idNorm && cNameNorm) {
                    const idTokens = new Set(idNorm.split(/\s+/).filter(Boolean));
                    const nameTokens = cNameNorm.split(/\s+/).filter(Boolean);
                    if ([...idTokens].some(t => t.length >= 4 && nameTokens.some(nt =>
                        nt.startsWith(t.slice(0, 4)) || t.startsWith(nt.slice(0, 4))
                    ))) {
                        return c;
                    }
                }
            }
            return null;
        })
        .filter(Boolean);

    if (!chars.length) return [];

    const result = [];
    for (const c of chars) {
        const resolvedP = resolvePassport(c, chapter, scenePayload);
        const { appearance, clothing } = buildCharacterPassport(resolvedP);
        const state = resolveState(c, chapter, scenePayload);
        let desc;
        if (appearance) {
            desc = appearance;
            if (clothing) desc += ", " + clothing;
        } else {
            desc = c.name || c.id;
        }
        const parts = [desc];
        if (state) parts.push(state);
        result.push(`${c.id}: ${helpers.cleanJoin(parts)}`);
    }
    return result;
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

/**
 * Resolve visual style for a narrative IU.
 */
function resolveVisualStyle(iuPayload, scenePayload, bookPayload) {
    if (iuPayload?.visual?.style) return iuPayload.visual.style;
    if (scenePayload?.visual?.style) return scenePayload.visual.style;
    if (scenePayload?.style && !helpers.isTypographyStyle(scenePayload.style)) return scenePayload.style;
    const renderStyle = bookPayload?.bible?.render_rules?.style;
    if (renderStyle && !helpers.isTypographyStyle(renderStyle)) return renderStyle.replace(/_/g, ' ');
    return null;
}

/**
 * Try to find matching location in bible by scanning the direct prompt text.
 */
function resolveLocationFromPrompt(directPrompt, bible) {
    if (!directPrompt || !bible?.locations) return null;
    const prompt = directPrompt.toLowerCase();
    const normalizedPrompt = helpers.normalizeForMatch(directPrompt);
    const promptWords = normalizedPrompt.split(/\s+/).filter(Boolean);

    const entries = Object.entries(bible.locations);
    let bestMatch = null;
    let bestScore = 0;

    for (const [locId, locData] of entries) {
        const namesToCheck = [
            locId.replace(/_/g, ' ').toLowerCase(),
            (locData.cinematic_space || '').toLowerCase(),
            locId.toLowerCase(),
        ];
        for (const name of namesToCheck) {
            if (name && name.length >= 4 && prompt.includes(name)) {
                return { id: locId, data: locData, matchType: 'exact' };
            }
        }

        const candidates = [
            helpers.normalizeForMatch(locId),
            helpers.normalizeForMatch(locData.cinematic_space),
            helpers.normalizeForMatch(locData.description),
        ];
        for (const candidate of candidates) {
            if (!candidate || candidate.length < 3) continue;
            const candidateWords = candidate.split(/\s+/).filter(Boolean);
            const score = helpers.wordOverlapScore(promptWords, candidateWords);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = { id: locId, data: locData, matchType: 'word_overlap', score };
            }
        }
    }

    if (bestMatch && bestScore >= 0.25) {
        return bestMatch;
    }
    return null;
}

function buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload) {
    if (!bookPayload) {
        helpers.error("buildImagePrompt: bookPayload is undefined");
        return "cinematic illustration";
    }

    if (iuPayload?.type === "typography") {
        const parts = [];
        const renderMode = resolveRenderMode(scenePayload, bookPayload);
        if (renderMode) {
            parts.push(`style ${renderMode.replace(/_/g, " ")}`);
        }
        const directPrompt = iuPayload?.visual?.prompt;
        if (directPrompt) {
            parts.push(directPrompt);
        }
        if (iuPayload?.visual?.quality) {
            parts.push(`image quality: ${iuPayload.visual.quality}`);
        } else {
            parts.push("image quality: highly detailed, sharp typography, clean composition, professional typesetting");
        }
        const finalPrompt = helpers.cleanJoin(parts);
        helpers.debug(`TYPOGRAPHY IU PROMPT: ${finalPrompt}`);
        return finalPrompt || 'cinematic illustration';
    }

    const parts = [];
    const directPrompt = iuPayload?.visual?.prompt;

    const renderMode = resolveRenderMode(scenePayload, bookPayload);
    if (renderMode) {
        parts.push(`style ${renderMode.replace(/_/g, " ")}`);
    }

    const visualStyle = resolveVisualStyle(iuPayload, scenePayload, bookPayload);
    if (visualStyle) {
        parts.push(visualStyle);
    }

    const resolvedLocation = resolveSceneLocation(scenePayload);
    let loc = bookPayload?.bible?.locations?.[resolvedLocation.id];
    let matchedLocFromPrompt = null;

    if (!loc && directPrompt && bookPayload?.bible?.locations) {
        matchedLocFromPrompt = resolveLocationFromPrompt(directPrompt, bookPayload.bible);
        if (matchedLocFromPrompt) {
            loc = matchedLocFromPrompt.data;
            helpers.debug(`LOCATION MATCHED FROM PROMPT: ${matchedLocFromPrompt.id}`);
        }
    }

    if (loc?.visual_style) {
        const cleaned = loc.visual_style.replace(/\s+matching\s+narrative\s+context.*/i, '').trim();
        if (cleaned && !helpers.isTypographyStyle(cleaned)) {
            parts.push(cleaned);
        }
    }
    if (loc?.description && loc.description !== loc?.visual_style) {
        parts.push(loc.description);
    }

    const env = resolvedLocation.environment;
    if (env?.epoch) parts.push(env.epoch);
    if (env?.time) parts.push(env.time);
    if (env?.season) parts.push(env.season);
    if (env?.weather) parts.push(env.weather);
    if (env?.mood) parts.push(env.mood);

    if (iuPayload?.visual?.lighting) {
        parts.push(iuPayload.visual.lighting);
    } else if (scenePayload?.visual?.lighting) {
        parts.push(scenePayload.visual.lighting);
    } else if (env?.lighting) {
        parts.push(env.lighting);
    }

    if (env?.atmosphere) {
        parts.push(env.atmosphere);
    }

    const shotPrompt = buildShotPrompt(iuPayload);
    if (shotPrompt) {
        parts.push(shotPrompt);
    }

    const charParts = buildCharacters(scenePayload, iuPayload, chapterPayload, bookPayload);
    if (charParts.length === 0 && directPrompt && bookPayload?.characters?.length) {
        const inferred = charUtils.inferCharactersFromPrompt(directPrompt, bookPayload);
        if (inferred.length > 0) {
            helpers.debug(`INFERRED CHARACTERS FROM PROMPT: ${inferred.map(c => c.id).join(', ')}`);
            for (const c of inferred) {
                const resolvedP = resolvePassport(c, chapterPayload, scenePayload);
                const { appearance, clothing } = buildCharacterPassport(resolvedP);
                let desc;
                if (appearance) {
                    desc = appearance;
                    if (clothing) desc += ", " + clothing;
                } else {
                    desc = c.name || c.id;
                }
                charParts.push(`${c.id}: ${desc}`);
            }
        }
    }
    parts.push(...charParts);

    if (directPrompt) {
        const normalized = charUtils.normalizeCharacterRefs(directPrompt, bookPayload?.characters);
        helpers.debug(`DIRECT PROMPT (IU): ${directPrompt}`);
        helpers.debug(`NORMALIZED: ${normalized}`);
        parts.push(normalized);
    }

    if (iuPayload?.visual?.quality) {
        parts.push(`image quality: ${iuPayload.visual.quality}`);
    } else if (scenePayload?.visual?.quality) {
        parts.push(`image quality: ${scenePayload.visual.quality}`);
    } else {
        parts.push("image quality: highly detailed, sharp focus");
    }

    const finalPrompt = helpers.cleanJoin(parts);
    helpers.debug(`FINAL IMAGE PROMPT: ${finalPrompt}`);
    return finalPrompt || 'cinematic illustration';
}

function buildIUImageWorkflow(iuPayload, scenePayload, chapterPayload, bookPayload) {
    const renderMode = iuPayload.render || scenePayload.render || bookPayload.render?.mode || 'standard';
    const baseNegative = 'blurry, low quality, artifacts';
    const customNegative = resolveNegativePrompt(iuPayload, scenePayload);

    return {
        workflow: 'img-qwen-image',
        render_mode: renderMode,
        prompt: buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload),
        negative_prompt: customNegative ? `${customNegative}, ${baseNegative}` : baseNegative,
        scene: scenePayload,
        iu: iuPayload,
        chapter: chapterPayload,
        book: bookPayload,
    };
}

function generateIUImageWorkflow(unit, scenePayload, chapterPayload, bookPayload) {
    const renderMode = unit.render || scenePayload.render || bookPayload.render?.mode;
    if (renderMode === 'none') return null;

    const baseNegative = 'blurry, low quality, artifacts';
    const customNegative = resolveNegativePrompt(unit, scenePayload);

    return {
        workflow: 'img-qwen-image',
        render_mode: renderMode,
        prompt: buildImagePrompt(unit, scenePayload, chapterPayload, bookPayload),
        negative_prompt: customNegative ? `${customNegative}, ${baseNegative}` : baseNegative,
        unit_id: unit.id,
        scene: scenePayload,
        iu: unit,
        chapter: chapterPayload,
        book: bookPayload,
    };
}

module.exports = {
    resolveRenderMode,
    resolveSceneLocation,
    resolveField,
    resolvePassport,
    buildCharacterPassport,
    resolveState,
    buildCharacters,
    buildShotPrompt,
    resolveNegativePrompt,
    resolveVisualStyle,
    resolveLocationFromPrompt,
    buildImagePrompt,
    buildIUImageWorkflow,
    generateIUImageWorkflow,
};
