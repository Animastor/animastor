const aiLoader = require('./ai-loader');

// ── Config constants (keep inline, not in .md) ──

const PROGRESS_STAGES = {
    analyzing_structure: '⟳ Анализирую структуру документа...',
    extracting_chars:    '⟳ Извлекаю персонажей...',
    extracting_locs:     '⟳ Извлекаю локации...',
    creating_scenes:     '⟳ Создаю сцены...',
    enriching_scenes:    '⟳ Обогащаю сцены атмосферой...',
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
// (location, time, participants, logical completeness), NOT timed fragments.
// Duration limits are soft guidance — the scene agent focuses on logical
// completeness, and video chunking splits long scenes into ~20s chunks.
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
// This ensures text density stays constant when MAX_SCENES_PER_CHUNK changes.
const CHARS_PER_SCENE = 1300;
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

// ── Load SYSTEM_PROMPTS from ai/rules/*.md ──
const SYSTEM_PROMPTS = {};
const RULES = [
    'structure', 'characters', 'locations', 'scenes',
    'enrich_scenes', 'units', 'visuals', 'storyboard_polish',
    'voice_generation', 'passport_reconciliation',
    'video_action_reconciliation', 'video_action_polish',
    'unit_splitter',
];

for (const name of RULES) {
    SYSTEM_PROMPTS[name] = aiLoader.getRule(name) || '';
}

module.exports = {
    PROGRESS_STAGES, MAX_WINDOW_CHARS, STEP_RETRIES, SYSTEM_PROMPTS,
    SCENE_TARGET_SEC, SCENE_MAX_SEC, SCENE_MIN_SEC, MAX_SCENES_PER_CHUNK,
    CHARS_PER_SCENE, WINDOW_OVERHEAD, computeWindowChars,
};
