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
 * Extract a meaningful scene title from the scene's text content.
 * @param {string} sceneText
 * @param {number} fallbackIndex
 * @returns {string}
 */
function extractSceneTitle(sceneText, fallbackIndex) {
    const t = (sceneText || '').trim();
    if (!t) return `Scene ${fallbackIndex + 1}`;

    let title = t;

    if (/^[—–\-]/.test(t)) {
        const newlinePos = t.indexOf('\n');
        const firstLine = newlinePos > 0 ? t.substring(0, newlinePos) : t;
        title = firstLine.replace(/^[—–\-\s\"]+/, '').replace(/[\"»]+$/, '').trim();
    } else {
        const dotEnd = t.search(/[.!?](?:\s|$)/);
        const sentenceEnd = dotEnd >= 0 ? dotEnd : t.search(/…(?:\s|$)/);
        if (sentenceEnd > 3) {
            title = t.substring(0, sentenceEnd + 1);
        }
        title = title.replace(/^[—–\-\s\"]+/, '').replace(/[.!?…]+$/, '').trim();
    }

    const words = title.split(/\s+/).filter(Boolean);
    if (words.length > 8) {
        title = words.slice(0, 8).join(' ');
        if (title.length < t.length) title += '…';
    }

    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title || `Scene ${fallbackIndex + 1}`;
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
