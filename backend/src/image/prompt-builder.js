// ======================================================
// Image Prompt Builder
// ======================================================
// Builds image prompts from scene/unit/character data.
// Uses connectors for workflow node resolution.

const helpers = require('./helpers');
const charUtils = require('./character-utils');
const assembly = require('./assembly-profile');

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
        appearance: sceneOverride.appearance ?? resolveField("appearance", globalP, chapterP, sceneV),
        clothes: sceneOverride.clothes ?? resolveField("clothes", globalP, chapterP, sceneV),
    };
}

function buildCharacterPassport(p) {
    if (!p) return { appearance: "", clothing: "" };
    const appearance = p.appearance && !helpers.isPlaceholder(p.appearance) ? p.appearance : null;
    const clothing = p.clothes && !helpers.isPlaceholder(p.clothes) ? p.clothes : null;
    return { appearance: (appearance || "").trim(), clothing: (clothing || "").trim() };
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
            // appearance is a full description that may end with '.', so strip the
            // trailing punctuation before appending clothing to avoid "…expression., a suit".
            desc = clothing ? appearance.replace(/[\s.;:!?]+$/, '') : appearance;
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
    // Safety net: the pipeline normally fills image.shot on every unit, but if
    // it is ever missing the wrapper must still emit a shot (and never silently
    // drop the section for a profile that assembles the full wrapper).
    return 'wide shot';
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
            locId.toLowerCase(),
        ];
        for (const name of namesToCheck) {
            if (name && name.length >= 4 && prompt.includes(name)) {
                return { id: locId, data: locData, matchType: 'exact' };
            }
        }

        const candidates = [
            helpers.normalizeForMatch(locId),
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

// ======================================================
// Final image prompt assembly — driven by the selected ASSEMBLY PROFILE.
//
// The ORDER of sections, the SUPPRESSED sections, and the DEFAULTS (quality,
// negative base) come from ai/profiles/{type}/{profileName}.json, resolved by
// assembly-profile.resolveAssembly(). With no profile configured the built-in
// default applies — the pipeline's baseline "general → specific" order:
//
//   1. Global context:  render mode → visual style → country → epoch →
//                       location description → time/season/weather/mood →
//                       lighting → atmosphere
//   2. Shot:            before the objects — the frame is chosen first
//   3. Characters:      ONE semantic block per participant
//   4. Action / spatial:the AI-authored unit.image.prompt — the CORE written
//                       by the agent (inserted as a block)
//   5. Fine details:    image quality LAST
//
// Division of labor: the agent writes ONLY the core sentence (directPrompt);
// the wrapper assembles every other section from structured fields (image.shot,
// image.style) and the environment (time/season/weather/mood/lighting) plus
// character passports. suppressSections is an OPTIONAL per-profile mechanism —
// currently no image profile suppresses anything (qwen-image used to suppress
// style/lighting/mood/shot on the assumption the skill made the agent write
// them itself; that assumption was dropped because it silently lost data).
//
// NOTE: typography/title-card units assemble via a separate, simpler branch and
// are NOT profile-driven.
// ======================================================

// One emitter per assembly section name. Each receives the build context (see
// buildSectionCtx) plus the resolved profile defaults, and returns a string,
// an array of strings, or null.
const IMAGE_SECTIONS = {
    renderMode: ({ renderMode }) => (renderMode ? `style ${renderMode.replace(/_/g, " ")}` : null),
    visualStyle: ({ visualStyle }) => visualStyle || null,
    country: ({ env, bookPayload }) => (env?.country || bookPayload?.bible?.country) || null,
    epoch: ({ env, bookPayload }) => (env?.epoch || bookPayload?.bible?.epoch) || null,
    location: ({ loc }) => loc?.description || null,
    time: ({ env }) => env?.time || null,
    season: ({ env }) => env?.season || null,
    weather: ({ env }) => env?.weather || null,
    mood: ({ env }) => env?.mood || null,
    lighting: ({ iuPayload, scenePayload, env }) =>
        resolveImageField(iuPayload, 'lighting')
        || scenePayload?.visual?.lighting
        || env?.lighting
        || null,
    atmosphere: ({ env }) => env?.atmosphere || null,
    shot: ({ iuPayload }) => buildShotPrompt(iuPayload),
    characters: ({ scenePayload, iuPayload, chapterPayload, bookPayload }) =>
        buildCharacters(scenePayload, iuPayload, chapterPayload, bookPayload),
    directPrompt: ({ directPrompt, bookPayload }) =>
        directPrompt ? charUtils.normalizeCharacterRefs(directPrompt, bookPayload?.characters) : null,
    quality: ({ iuPayload, scenePayload, defaults }) => {
        if (resolveImageField(iuPayload, 'quality')) return `image quality: ${resolveImageField(iuPayload, 'quality')}`;
        if (scenePayload?.visual?.quality) return `image quality: ${scenePayload.visual.quality}`;
        return defaults.quality || 'image quality: highly detailed, sharp focus';
    },
};

function buildSectionCtx(iuPayload, scenePayload, chapterPayload, bookPayload) {
    const directPrompt = resolveImageField(iuPayload, 'prompt');
    const renderMode = resolveRenderMode(scenePayload, bookPayload);
    const visualStyle = resolveVisualStyle(iuPayload, scenePayload, bookPayload);
    const resolvedLocation = resolveSceneLocation(scenePayload);
    // Location environment is a global template — the scene environment
    // overrides it per-field (same pattern as character passports).
    // buildImagePrompt only sees the merged result.
    const env = {
        ...(bookPayload?.locations?.[resolvedLocation.id]?.environment || {}),
        ...(resolvedLocation.environment || {}),
    };
    let loc = bookPayload?.locations?.[resolvedLocation.id];
    if (!loc && directPrompt && bookPayload?.locations) {
        const matched = resolveLocationFromPrompt(directPrompt, bookPayload.locations);
        if (matched) loc = matched.data;
    }
    return { iuPayload, scenePayload, chapterPayload, bookPayload, directPrompt, renderMode, visualStyle, env, loc };
}

function buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload, options = {}) {
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

    const assemblyCfg = assembly.resolveAssembly('image', options.profile);
    const ctx = {
        ...buildSectionCtx(iuPayload, scenePayload, chapterPayload, bookPayload),
        defaults: assemblyCfg.defaults,
    };

    const parts = [];
    for (const sectionName of assemblyCfg.sections) {
        if (assemblyCfg.suppress.has(sectionName)) continue;
        const emit = IMAGE_SECTIONS[sectionName];
        if (!emit) continue; // unknown section name → skip safely (forward compat)
        const value = emit(ctx);
        if (Array.isArray(value)) parts.push(...value.filter(Boolean));
        else if (value) parts.push(value);
    }

    const finalPrompt = helpers.cleanJoin(parts);
    return finalPrompt || 'cinematic illustration';
}

function buildIUImageWorkflow(iuPayload, scenePayload, chapterPayload, bookPayload) {
    const renderMode = iuPayload.render || scenePayload.render || bookPayload.render?.mode || 'standard';
    const baseNegative = assembly.resolveAssembly('image').defaults.negativeBase || 'blurry, low quality, artifacts';
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

    const baseNegative = assembly.resolveAssembly('image').defaults.negativeBase || 'blurry, low quality, artifacts';
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
