// ======================================================
// Assistant Profile Loader — HOST ADAPTER
// ======================================================
// Reads the host-owned AI assistant persona (markdown) and returns its
// CONTENT. The @animastor/assistant package has no filesystem and no path
// knowledge: the composition root calls this loader and injects the
// resulting string as `deps.aiProfile`. A missing file yields '' so the
// package falls back to its built-in profile — the historical behavior.
//
// Env override `AI_PROFILE_PATH` is unchanged (operator knob).
// (docs/architecture/ai-assistant-extraction.md)

const fs = require('fs');
const path = require('path');

const DEFAULT_PROFILE_PATH = process.env.AI_PROFILE_PATH
    || path.join(__dirname, '..', '..', 'ai', 'ai-assistant-profile.md');

/**
 * Load the AI assistant persona markdown content.
 * @param {string} [profilePath] — override for tests/wiring
 * @returns {string} trimmed content, or '' when unavailable (package fallback)
 */
function loadAssistantProfile(profilePath = DEFAULT_PROFILE_PATH) {
    try {
        if (profilePath && fs.existsSync(profilePath)) {
            return fs.readFileSync(profilePath, 'utf-8').trim();
        }
    } catch (_) { /* best-effort: package falls back to its built-in profile */ }
    return '';
}

module.exports = { loadAssistantProfile, DEFAULT_PROFILE_PATH };
