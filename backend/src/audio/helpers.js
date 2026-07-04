// ======================================================
// Audio Helpers
// ======================================================
// getOutputPath and escapeRegExp imported from shared utils/string-utils.

const { getOutputPath, escapeRegExp } = require('../utils/string-utils');

const logPrefix = '[AUDIO]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

module.exports = {
    getOutputPath,
    log,
    warn,
    error,
    escapeRegExp,
};
