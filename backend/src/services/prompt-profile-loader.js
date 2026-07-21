// ======================================================
// Prompt Profile Loader — v1.0.0
// ======================================================
// Loads model-specific prompt profiles (skills) from
// backend/ai/skills/{type}/{profile}.md and provides
// a lookup API for the agent pipeline.
//
// A "prompt profile" is a set of prompting rules for a
// specific generation model (e.g. LTX 2.3, Qwen Image).
// Profiles are stored as markdown files and loaded on
// demand by the agent pipeline steps.
//
// Usage:
//   const profiles = require('./prompt-profile-loader');
//   const videoSkill = profiles.getVideoProfile('ltx-2.3');
//   // → content of backend/ai/skills/video/ltx-2.3.md

const aiLoader = require('./ai-loader');

/**
 * Get a prompt profile skill by type and profile name.
 *
 * @param {string} profileType — "video" | "image" | "audio"
 * @param {string} profileName — "ltx-2.3" | "qwen-image" | "qwen-tts"
 * @returns {string|null} — markdown content, or null if not found
 */
function getProfile(profileType, profileName) {
    if (!profileType || !profileName) return null;
    const skillKey = `${profileType}/${profileName}`;
    const skill = aiLoader.getSkill(skillKey);
    // Also try without subdirectory (flat skills)
    return skill || aiLoader.getSkill(profileName) || null;
}

/**
 * Get video prompt profile (e.g. "ltx-2.3").
 * @param {string} profileName
 * @returns {string|null}
 */
function getVideoProfile(profileName) {
    return getProfile('video', profileName);
}

/**
 * Get image prompt profile (e.g. "qwen-image").
 * @param {string} profileName
 * @returns {string|null}
 */
function getImageProfile(profileName) {
    return getProfile('image', profileName);
}

/**
 * Get audio prompt profile (e.g. "qwen-tts").
 * @param {string} profileName
 * @returns {string|null}
 */
function getAudioProfile(profileName) {
    return getProfile('audio', profileName);
}

/**
 * Build a system prompt section from a skill file.
 * Returns an empty string if the skill is not found.
 *
 * @param {string} profileType — "video" | "image" | "audio"
 * @param {string} profileName — profile name
 * @returns {string} — formatted section to inject into system prompt
 */
function buildSkillSection(profileType, profileName) {
    const content = getProfile(profileType, profileName);
    if (!content) return '';
    const typeLabel = { video: 'Video', image: 'Image', audio: 'Audio' }[profileType] || profileType;
    return `\n## Prompt Profile: ${typeLabel} (${profileName})\n\n` +
           `The following are model-specific prompting rules for ${profileName}. ` +
           `Follow them carefully when generating prompts for this model.\n\n` +
           `${content}\n`;
}

/**
 * List all available profiles grouped by type.
 * Scans the keys loaded by ai-loader.js for pattern `{type}/{name}`.
 *
 * @returns {{ audio: string[], image: string[], video: string[] }}
 */
function listAvailableProfiles() {
    const allSkills = aiLoader.getSkillNames();
    const grouped = { audio: [], image: [], video: [] };
    for (const key of allSkills) {
        const parts = key.split('/');
        if (parts.length !== 2) continue;
        const [type, name] = parts;
        if (grouped[type]) {
            grouped[type].push(name);
        }
    }
    return grouped;
}

module.exports = {
    getProfile,
    getVideoProfile,
    getImageProfile,
    getAudioProfile,
    buildSkillSection,
    listAvailableProfiles,
};
