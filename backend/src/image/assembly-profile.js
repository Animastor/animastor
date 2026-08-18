// ======================================================
// Assembly Profile Resolver
// ======================================================
// Resolves MACHINE-READABLE prompt-assembly profiles from ai/profiles/**/*.json.
// A profile drives how the programmatic builder (buildImagePrompt) assembles the
// final prompt: the ORDER of sections, optional SUPPRESSED sections (a per-profile
// mechanism — currently unused by every shipped profile: the wrapper always
// assembles the full prompt), and DEFAULTS (quality, negative base).
//
// Resolution chain (per type):
//   1. ai/profiles/{type}/{profileName}.json  — the selected profile
//   2. Built-in DEFAULT_* constants           — hardcoded fallback (used when
//      no profile is configured or the named profile file is missing)
//
// The built-in fallback guarantees backward compatibility: when no profile file
// exists, assembly behaves exactly like the pre-profile pipeline. There is no
// 'default' profile file — real profiles only.

const aiLoader = require('../services/ai-loader');

// Built-in default assembly — the pipeline's baseline "general → specific" order.
// Mirrors ai/profiles/image/default.json; used when the file is missing/unreadable.
const DEFAULT_IMAGE_SECTIONS = [
    'renderMode', 'visualStyle', 'country', 'epoch', 'location',
    'time', 'season', 'weather', 'mood', 'lighting', 'atmosphere',
    'shot', 'characters', 'directPrompt', 'quality',
];

const DEFAULT_IMAGE_DEFAULTS = {
    quality: 'image quality: highly detailed, sharp focus',
    negativeBase: 'blurry, low quality, artifacts',
};

// Built-in default assembly for VIDEO prompts. The final video prompt is a
// timed storyboard, so the sections are coarser than image: the character
// identity block, the per-IU storyboard, and the fps/render footer.
// Mirrors ai/profiles/video/default.json.
const DEFAULT_VIDEO_SECTIONS = [
    'characters', 'storyboard', 'renderInfo',
];

const DEFAULT_VIDEO_DEFAULTS = {
    negativeBase: 'blurry, low quality, still frame, jitter, flicker, artifacts',
};

// Built-in default assembly for AUDIO prompts. TTS has no section-assembled
// final text — the profile documents the assembly units the agent/engine
// produce (voiceInstruction — the natural-language voice description written by
// stepGenerateVoices; defaultInstruct — the dialogue workflow's default TTS
// instruction) and carries the programmatic defaults (defaultInstruct).
// Mirrors ai/profiles/audio/default.json.
const DEFAULT_AUDIO_SECTIONS = [
    'voiceInstruction', 'defaultInstruct',
];

const DEFAULT_AUDIO_DEFAULTS = {
    defaultInstruct: '',
};

// Per-type built-in fallbacks. Types without an entry (e.g. a future 'music'
// type) fall back to the IMAGE built-in — keep them out of the map until a
// type-specific default exists.
const TYPE_DEFAULTS = {
    image: { sections: DEFAULT_IMAGE_SECTIONS, defaults: DEFAULT_IMAGE_DEFAULTS },
    video: { sections: DEFAULT_VIDEO_SECTIONS, defaults: DEFAULT_VIDEO_DEFAULTS },
    audio: { sections: DEFAULT_AUDIO_SECTIONS, defaults: DEFAULT_AUDIO_DEFAULTS },
};

function normalizeAssembly(profile, type, profileName) {
    const base = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.image;
    const sections = Array.isArray(profile?.assembly?.sections) && profile.assembly.sections.length > 0
        ? profile.assembly.sections
        : base.sections;
    const suppress = new Set(
        Array.isArray(profile?.assembly?.suppressSections)
            ? profile.assembly.suppressSections
            : []
    );
    const defaults = { ...base.defaults, ...(profile?.assembly?.defaults || {}) };
    // Pass through model-specific video metadata (frameAlignment, requiresTrim,
    // requiresKeyframeForcing) when present in the profile JSON. Downstream
    // video merge/assembly uses this to decide alignment strategy per model.
    const video = profile?.video || null;
    return { profileName, type, sections, suppress, defaults, video };
}

/**
 * Resolve the assembly config for a profile type + name.
 * @param {string} type — 'image' | 'video' | 'audio'
 * @param {string} [profileName] — 'qwen-image', 'ltx-2.3', ...
 * @returns {{ profileName: string, type: string, sections: string[], suppress: Set<string>, defaults: object }}
 */
function resolveAssembly(type, profileName) {
    const name = (profileName && profileName !== 'default') ? profileName : null;
    const profile = name ? aiLoader.getAssemblyProfile(`${type}/${name}`) || null : null;
    return normalizeAssembly(profile, type, name);
}

module.exports = {
    resolveAssembly,
    DEFAULT_IMAGE_SECTIONS,
    DEFAULT_IMAGE_DEFAULTS,
    DEFAULT_VIDEO_SECTIONS,
    DEFAULT_VIDEO_DEFAULTS,
    DEFAULT_AUDIO_SECTIONS,
    DEFAULT_AUDIO_DEFAULTS,
};
