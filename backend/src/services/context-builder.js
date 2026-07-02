// ======================================================
// Context Builder — G.2.1 / G.2.2 / G.2.3
// ======================================================
// Assembles the full system prompt for the AI assistant:
//   [Mode header] + [Rules] + [Skills] + [Examples] + [Project Context]
// Uses ai-loader for rules/skills/examples and book data for project context.
// ======================================================

const aiLoader = require('./ai-loader');

// ======================================================
// G.2.3 — Mode ↔ defaults mapping
// ======================================================
const MODE_MAPPING = {
    conversation: {
        rules: ['general'],
        skills: [],
        examples: [],
    },
    edit: {
        rules: ['json_rules', 'edit_mode'],
        skills: [],
        examples: [],  // all examples loaded automatically
    },
    director: {
        rules: [],
        skills: ['composition', 'camera_language', 'lighting', 'directing'],
        examples: [],  // all examples loaded automatically
    },
    extraction: {
        rules: ['extraction_rules'],
        skills: ['entity_extraction'],
        examples: [],
    },
    import: {
        rules: ['import_rules', 'json_rules'],
        skills: [],
        examples: [],  // all examples loaded automatically
    },
    validation: {
        rules: ['json_schema', 'validation'],
        skills: [],
        examples: [],
    },
};

function getModeMapping(modeId) {
    return MODE_MAPPING[modeId] || MODE_MAPPING.conversation;
}

// ======================================================
// G.2.2 — Build rule/skill/example sections
// ======================================================

function buildRulesSection(rules) {
    if (!rules || rules.length === 0) return '';
    const parts = ['## Rules'];
    for (const name of rules) {
        const content = aiLoader.getRule(name);
        if (content) {
            parts.push(`\n### ${name}\n${content}`);
        }
    }
    return parts.join('\n');
}

function buildSkillsSection(skills) {
    if (!skills || skills.length === 0) return '';
    const parts = ['## Skills'];
    for (const name of skills) {
        const content = aiLoader.getSkill(name);
        if (content) {
            parts.push(`\n### ${name}\n${content}`);
        }
    }
    return parts.join('\n');
}

function buildExamplesSection(examples) {
    // If no specific examples requested, load ALL from the examples folder.
    const names = (examples && examples.length > 0) ? examples : Object.keys(aiLoader.getExamples());
    if (!names || names.length === 0) return '';
    const parts = ['## Examples'];
    for (const name of names) {
        const data = aiLoader.getExample(name);
        if (data) {
            // Show a compact summary rather than full JSON to avoid token waste
            const keys = Object.keys(data);
            const topFields = keys.slice(0, 5).join(', ');
            const extra = keys.length > 5 ? ` … and ${keys.length - 5} more` : '';
            parts.push(`\n### ${name}\n_${keys.length} top-level field(s): ${topFields}${extra}_`);
            parts.push('\n```json\n' + JSON.stringify(data, null, 2).substring(0, 600) + '\n```');
        }
    }
    return parts.join('\n');
}

// ======================================================
// G.2.1 — Project Context assembly
// ======================================================

function buildProjectContext(bookData, options = {}) {
    if (!bookData) return '';
    const { sceneId, characterId } = options;
    const lines = ['## Project Context'];

    const meta = bookData.metadata || {};
    const manifest = bookData.manifest || {};
    lines.push(`- Book: "${meta.title || 'Untitled'}" (id: ${manifest.book_id || 'unknown'})`);

    if (sceneId) {
        const scene = (bookData.scenes || []).find(s => s.id === sceneId);
        if (scene) {
            const chapter = (bookData.chapters || []).find(c => c.id === scene.chapter_id);
            lines.push(`- Current scene: "${scene.title}" (id: ${sceneId}, chapter: ${chapter ? chapter.title : scene.chapter_id})`);
            lines.push(`- Scene mood: ${scene.mood || 'not set'}`);
            lines.push(`- Scene pacing: ${scene.pacing || 'not set'}`);
            lines.push(`- Units in scene: ${(scene.units || []).length}`);
            const chars = scene.characters_present || scene.participants || [];
            if (chars.length > 0) {
                lines.push(`- Characters present: ${chars.join(', ')}`);
            }
        } else {
            lines.push(`- Scene id: ${sceneId} (not found in book)`);
        }
    }

    if (characterId) {
        const char = (bookData.characters || []).find(c => c.id === characterId);
        if (char) {
            lines.push(`- Active character: "${char.name}" (role: ${char.role})`);
        } else {
            lines.push(`- Character id: ${characterId} (not found)`);
        }
    }

    lines.push(`- Total characters: ${(bookData.characters || []).length}`);
    lines.push(`- Total scenes: ${(bookData.scenes || []).length}`);
    lines.push(`- Total chapters: ${(bookData.chapters || []).length}`);
    lines.push(`- Locked: ${manifest.locked === true}`);

    return lines.join('\n');
}

// ======================================================
// G.2.2 — Full context assembly
// ======================================================

function buildSystemPrompt(modeId, bookData, options = {}) {
    const { sceneId, characterId, userSystem, profilePrompt } = options;
    const mapping = getModeMapping(modeId);
    const parts = [];

    // Mode header
    const modeTitle = modeId.charAt(0).toUpperCase() + modeId.slice(1);
    parts.push(`# Mode: ${modeTitle}`);

    if (profilePrompt) {
        parts.push(`\n${profilePrompt}`);
    }

    // Rules
    const rulesSection = buildRulesSection(mapping.rules);
    if (rulesSection) parts.push(rulesSection);

    // Skills
    const skillsSection = buildSkillsSection(mapping.skills);
    if (skillsSection) parts.push(skillsSection);

    // Examples
    const examplesSection = buildExamplesSection(mapping.examples);
    if (examplesSection) parts.push(examplesSection);

    // Project Context
    const projectCtx = buildProjectContext(bookData, { sceneId, characterId });
    if (projectCtx) parts.push(projectCtx);

    // Full book JSON (for edit/director modes that need it)
    if (bookData && (modeId === 'edit' || modeId === 'director' || modeId === 'validation' || modeId === 'import')) {
        parts.push('\n## Full Book JSON\n```json\n' + JSON.stringify(bookData, null, 2) + '\n```');
    }

    // User system extra
    if (userSystem) {
        parts.push(`\n## User Context\n${userSystem}`);
    }

    // Position context
    if (options.positionCtx) {
        parts.push(`\n## Current Position\n${options.positionCtx}`);
    }

    return parts.join('\n\n');
}

module.exports = {
    buildSystemPrompt,
    buildProjectContext,
    getModeMapping,
    MODE_MAPPING,
};
