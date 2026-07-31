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
    const sceneV = scene?.visual?.character?.[c.id] || {};
    // scene.passport[characterId] — прямое переопределение паспорта на уровне сцены.
    // Любое поле, заданное здесь, ПОЛНОСТЬЮ замещает соответствующее глобальное поле.
    const sceneOverride = scene?.passport?.[c.id] || {};
    return {
        base_appearance: sceneOverride.base_appearance ?? resolveField("base_appearance", globalP, chapterP, sceneV),
        detailed_appearance: sceneOverride.detailed_appearance ?? resolveField("detailed_appearance", globalP, chapterP, sceneV),
        clothing_base: sceneOverride.clothing_base ?? resolveField("clothing_base", globalP, chapterP, sceneV),
        clothing_details: sceneOverride.clothing_details ?? resolveField("clothing_details", globalP, chapterP, sceneV),
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
    // Participants come DIRECTLY from scene.participants (set during scene creation).
    // The visual prompt text contains character_ids from the AI, but those IDs were
    // also sourced from scene.participants — so we use the authoritative source directly.
    const participantIds = scenePayload?.participants || [];
    if (!participantIds.length) {
        return [];
    }

    const seen = new Set();
    const chars = participantIds
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

function resolveImageField(unit, field) {
    return unit?.image?.[field];
}

function buildShotPrompt(unit) {
    const shot = resolveImageField(unit, 'shot');
    if (shot) {
        return `${shot.replace(/_/g, " ")} shot`;
    }
    return null;
}

function resolveNegativePrompt(unit, scenePayload) {
    return resolveImageField(unit, 'negative')
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
    if (iuPayload?.image?.style) return iuPayload.image.style;
    if (scenePayload?.visual?.style) return scenePayload.visual.style;
    if (scenePayload?.style && !helpers.isTypographyStyle(scenePayload.style)) return scenePayload.style;
    const renderStyle = bookPayload?.bible?.render_rules?.style;
    if (renderStyle && !helpers.isTypographyStyle(renderStyle)) return renderStyle.replace(/_/g, ' ');
    return null;
}

/**
 * Try to find matching location by scanning the direct prompt text.
 */
function resolveLocationFromPrompt(directPrompt, locations) {
    if (!directPrompt || !locations) return null;
    const prompt = directPrompt.toLowerCase();
    const normalizedPrompt = helpers.normalizeForMatch(directPrompt);
    const promptWords = normalizedPrompt.split(/\s+/).filter(Boolean);

    const entries = Object.entries(locations);
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
        const directPrompt = resolveImageField(iuPayload, 'prompt');
        if (directPrompt) {
            parts.push(directPrompt);
        }
        if (resolveImageField(iuPayload, 'quality')) {
            parts.push(`image quality: ${resolveImageField(iuPayload, 'quality')}`);
        } else {
            parts.push("image quality: highly detailed, sharp typography, clean composition, professional typesetting");
        }
        const finalPrompt = helpers.cleanJoin(parts);
        return finalPrompt || 'cinematic illustration';
    }

    const parts = [];
    const directPrompt = resolveImageField(iuPayload, 'prompt');

    const renderMode = resolveRenderMode(scenePayload, bookPayload);
    if (renderMode) {
        parts.push(`style ${renderMode.replace(/_/g, " ")}`);
    }

    const visualStyle = resolveVisualStyle(iuPayload, scenePayload, bookPayload);
    if (visualStyle) {
        parts.push(visualStyle);
    }

    const resolvedLocation = resolveSceneLocation(scenePayload);
    // Location environment is a global template — the scene environment
    // overrides it per-field (same pattern as character passports).
    // buildImagePrompt only sees the merged result.
    const env = {
        ...(bookPayload?.locations?.[resolvedLocation.id]?.environment || {}),
        ...(resolvedLocation.environment || {}),
    };

    // Country: scene environment overrides bible default
    const effectiveCountry = env?.country || bookPayload?.bible?.country;
    if (effectiveCountry) parts.push(effectiveCountry);

    // Epoch: scene environment overrides bible default
    const effectiveEpoch = env?.epoch || bookPayload?.bible?.epoch;
    if (effectiveEpoch) parts.push(effectiveEpoch);

    let loc = bookPayload?.locations?.[resolvedLocation.id];
    let matchedLocFromPrompt = null;

    if (!loc && directPrompt && bookPayload?.locations) {
        matchedLocFromPrompt = resolveLocationFromPrompt(directPrompt, bookPayload.locations);
        if (matchedLocFromPrompt) {
            loc = matchedLocFromPrompt.data;
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

    if (env?.time) parts.push(env.time);
    if (env?.time) parts.push(env.time);
    if (env?.season) parts.push(env.season);
    if (env?.weather) parts.push(env.weather);
    if (env?.mood) parts.push(env.mood);

    if (resolveImageField(iuPayload, 'lighting')) {
        parts.push(resolveImageField(iuPayload, 'lighting'));
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
    parts.push(...charParts);

    if (directPrompt) {
        const normalized = charUtils.normalizeCharacterRefs(directPrompt, bookPayload?.characters);
        parts.push(normalized);
    }

    if (resolveImageField(iuPayload, 'quality')) {
        parts.push(`image quality: ${resolveImageField(iuPayload, 'quality')}`);
    } else if (scenePayload?.visual?.quality) {
        parts.push(`image quality: ${scenePayload.visual.quality}`);
    } else {
        parts.push("image quality: highly detailed, sharp focus");
    }

    const finalPrompt = helpers.cleanJoin(parts);
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
