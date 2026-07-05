// ======================================================
// Shared Scene Title Utilities
// ======================================================
// Centralized implementations used by agent-service (text-utils.js)
// and lazy-book (chapter-utils.js). Import from here instead of
// maintaining parallel copies.
//
// NOTE: Was previously duplicated in:
//   - services/agent/text-utils.js
//   - book/lazy-book/chapter-utils.js

/**
 * Extract a scene title fallback from the scene's text content.
 * Uses first 4 words + "..." for a clean, predictable title.
 * @param {string} sceneText
 * @param {number} fallbackIndex
 * @returns {string}
 */
function extractSceneTitle(sceneText, fallbackIndex) {
    const t = (sceneText || '').trim();
    if (!t) return `Scene ${fallbackIndex + 1}`;

    // Strip leading dashes, quotes, whitespace
    const clean = t.replace(/^[—–\-\s\"]+/, '').trim();
    if (!clean) return `Scene ${fallbackIndex + 1}`;

    const words = clean.split(/\s+/).filter(Boolean);
    const first4 = words.slice(0, 4).join(' ');

    if (words.length <= 4) {
        return first4.charAt(0).toUpperCase() + first4.slice(1);
    }

    return first4.charAt(0).toUpperCase() + first4.slice(1) + '…';
}

/**
 * Check whether a scene title is generic / auto-generated.
 * @param {string} title
 * @returns {boolean}
 */
function isGenericSceneTitle(title) {
    if (!title) return true;
    const trimmed = title.trim();
    if (trimmed.length < 3) return true;
    if (/^(Scene|Сцена|Chapter|Глава|Part|Часть)\s*\d*$/i.test(trimmed)) return true;
    return false;
}

module.exports = {
    extractSceneTitle,
    isGenericSceneTitle,
};
