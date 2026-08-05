const aiLoader = require('./ai-loader');

// ── Config constants (keep inline, not in .md) ──

const PROGRESS_STAGES = {
    analyzing_structure: '⟳ Анализирую структуру документа...',
    extracting_chars:    '⟳ Извлекаю персонажей...',
    extracting_locs:     '⟳ Извлекаю локации...',
    creating_scenes:     '⟳ Создаю сцены...',
    creating_units:      sc => `⟳ Создаю юниты для сцены ${sc + 1}...`,
    creating_visuals:    sc => `⟳ Создаю visual prompts для сцены ${sc + 1}...`,
    polishing_storyboard: '⟳ Согласовываю визуальный ряд сториборда...',
    passport_reconciliation: '⟳ Сверяю описания с паспортами персонажей...',
    video_action_reconciliation: '⟳ Согласовываю видеоряд с сюжетом...',
    video_action_polish: '⟳ Полирую непрерывность движений...',
    voice_generation: '⟳ Подбираю голоса для персонажей...',
    splitting_long_units: sc => `⟳ Проверяю длительность юнитов сцены ${sc + 1}...`,
};

const STEP_RETRIES = 3;

// Scene duration targets (narration seconds). Scenes are now narrative units
// (coherent episodes), NOT timed fragments.
// Duration limits are soft guidance — the scene agent focuses on narrative
// coherence, and video chunking splits long scenes into ~20s chunks.
// At ~0.3s/word (see placeholder-audio.estimateSpeechDurationSec):
//   SCENE_TARGET_SEC 60s ≈ ~200 words, SCENE_MAX_SEC 120s ≈ ~400 words.
const SCENE_TARGET_SEC = 60;
const SCENE_MAX_SEC = 120;
// Technical minimum scene length. Scenes shorter than ~5 seconds (~15 words)
// cause artifacts in video generation models. If an episode is this short,
// merge it with an adjacent scene when narratively coherent.
const SCENE_MIN_SEC = 5;
// Upper bound on scenes produced per window.
// This is a HARD UPPER BOUND, NOT a target — if the text naturally forms
// fewer scenes, that is correct.
// Reduced because scenes are now longer (2min max vs 30s).
const MAX_SCENES_PER_CHUNK = 2;

// Window size = overhead + scenes × per-scene budget.
// CHARS_PER_SCENE calibrated for the new scene concept: a scene can be
// up to ~2 minutes (~400 words). Russian text averages ~6.7 chars/word,
// so 400 words ≈ 2700 chars. Round up to account for dialogue markup.
// At ~0.3s/word: 2700 chars ≈ 400 words ≈ 120s = 2 min per scene.
const CHARS_PER_SCENE = 2700;
const WINDOW_OVERHEAD = 100;
const MAX_WINDOW_CHARS = WINDOW_OVERHEAD + MAX_SCENES_PER_CHUNK * CHARS_PER_SCENE;

/**
 * Compute window char budget from a given chunk size (scenes per pass).
 * Allows the pipeline to dynamically override MAX_SCENES_PER_CHUNK
 * without re-importing the module.
 */
function computeWindowChars(chunkSize) {
    const scenes = Math.max(1, Math.min(5, chunkSize || MAX_SCENES_PER_CHUNK));
    return WINDOW_OVERHEAD + scenes * CHARS_PER_SCENE;
}

// ── Prompt length policy ─────────────────────────────────────────────
// A frame prompt (image.prompt / video.action) longer than the ceiling is
// treated as OUT OF FORMAT: either a legacy value or a stray paste from the
// editor. Such prompts are rejected at the save boundary (core-routes.cjs)
// and are NEVER sent to the reconciliation/polish passes — a model that only
// sees a fragment would silently rewrite the unseen part, destroying content
// the user may have typed deliberately.
// Normal AI-generated prompts are ~150–200 chars; the ~2×-text worst case is
// ~900 chars; 2000 leaves generous headroom while bounding the AI context.
const IMAGE_PROMPT_MAX_CHARS = 2000;
// Verbatim unit text shown to reconciliation/polish agents (a 20s unit ≈ 450 chars).
const UNIT_TEXT_MAX_CHARS = 500;
// Full scene text is passed to polish passes (a scene is ≤ 120s ≈ 2700 chars by design).
const SCENE_TEXT_MAX_CHARS = 2700;

// ── Load SYSTEM_PROMPTS from ai/rules/*.md ──
const SYSTEM_PROMPTS = {};
const RULES = [
    'structure', 'characters', 'locations', 'scenes',
    'units', 'visuals', 'storyboard_polish',
    'voice_generation', 'passport_reconciliation',
    'video_action_reconciliation', 'video_action_polish',
    'unit_splitter',
];

for (const name of RULES) {
    SYSTEM_PROMPTS[name] = aiLoader.getRule(name) || '';
}

// ── Language architecture ──────────────────────────────────────────
// Rule (docs/07-agents-and-generators/LANGUAGE_ARCHITECTURE.md):
//   - AI-facing fields (image.prompt, video.action, passports, env,
//     voice instructions) are ALWAYS English, regardless of book language.
//   - User-facing literary text (scene titles, names, descriptions) is
//     localized per the book's `language` field.
//   - scene.text / unit.text / audio.full_text stay VERBATIM (book language).
// The pipeline passes `language` into the text-generating steps; visual
// steps do NOT get it (their output is English by design).

const LANG_NAMES = {
    ru: 'Russian', en: 'English', de: 'German', es: 'Spanish', fr: 'French',
    it: 'Italian', pt: 'Portuguese', uk: 'Ukrainian', pl: 'Polish', zh: 'Chinese',
    ja: 'Japanese', ko: 'Korean', tr: 'Turkish', ar: 'Arabic',
};

/**
 * Map a language code to its English display name.
 * @param {string} lang - e.g. 'ru', 'en', 'de'
 * @returns {string} e.g. 'Russian'
 */
function langName(lang) {
    const code = (lang || 'ru').toLowerCase();
    return LANG_NAMES[code] || code;
}

/**
 * Build the VALUE substituted for the %LANGUAGE% placeholder.
 * The .md rule files carry the placeholder point-wise next to user-facing
 * fields, e.g. `"name": "Full Name (in %LANGUAGE%)"` — and the pipeline
 * replaces %LANGUAGE% with this value at prompt build time, producing e.g.
 * "Full Name (in Russian (ru))". GPU-facing fields (appearance, environment)
 * are NOT localized — they stay English via explicit mandates in the rules.
 * Used ONLY in text-generating steps whose OUTPUT is user-facing text
 * (structure, characters, locations, scenes, voice_generation).
 * GPU-facing steps (visuals, polish, reconcile) do NOT use this placeholder —
 * their .md files state a fixed "Result language: English (en)".
 * @param {string} lang - book language code (ru/en/de/...)
 * @returns {string} e.g. "Russian (ru)"
 */
function buildLangInstruction(lang) {
    const code = (lang || 'ru').toLowerCase();
    const name = langName(code);
    return `${name} (${code})`;
}

/**
 * Resolve the effective book language from a loaded draft book.
 * Order: book.language → defaults.language → detectLanguage(sourceText) → 'ru'.
 * @param {{book?: object, sourceText?: string}|null} draft
 * @returns {string}
 */
function resolveBookLanguage(draft) {
    if (!draft) return 'ru';
    const book = draft.book || {};
    if (book.language) return book.language;
    if (book.defaults && book.defaults.language) return book.defaults.language;
    // parser.js is dependency-free — safe to require directly (no circular import).
    const { detectLanguage } = require('../book/lazy-book/parser');
    return detectLanguage(draft.sourceText || '') || 'ru';
}

module.exports = {
    PROGRESS_STAGES, MAX_WINDOW_CHARS, STEP_RETRIES, SYSTEM_PROMPTS,
    SCENE_TARGET_SEC, SCENE_MAX_SEC, SCENE_MIN_SEC, MAX_SCENES_PER_CHUNK,
    CHARS_PER_SCENE, WINDOW_OVERHEAD, computeWindowChars,
    IMAGE_PROMPT_MAX_CHARS, UNIT_TEXT_MAX_CHARS, SCENE_TEXT_MAX_CHARS,
    LANG_NAMES, langName, buildLangInstruction, resolveBookLanguage,
};
