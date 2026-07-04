// ======================================================
// Shared String & Path Utilities
// ======================================================
// Centralized implementations used by audio/, image/, and other subsystems.
// Import from here instead of duplicating in local helpers.

const path = require('path');
const config = require('../config/runtime-config');

/**
 * Join path segments under the configured OUTPUT_DIR.
 * @param {...string} parts
 * @returns {string}
 */
function getOutputPath(...parts) {
    return path.join(config.OUTPUT_DIR, ...parts.filter(Boolean));
}

/**
 * Escape a string for use in a RegExp pattern.
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    getOutputPath,
    escapeRegExp,
};
