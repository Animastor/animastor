const path = require('path');
const crypto = require('crypto');
const config = require('../../config/runtime-config');

function getBooksDir() { return config.BOOKS_DIR; }
function getBookDir(bookId) { return path.join(getBooksDir(), bookId); }
function getSourcePath(bookDir) { return path.join(bookDir, 'source.txt'); }
function getManifestPath(bookDir) { return path.join(bookDir, 'manifest.json'); }
function getBookMetaPath(bookDir) { return path.join(bookDir, 'book.json'); }
function getCharactersPath(bookDir) { return path.join(bookDir, 'characters.json'); }
function getMentionsPath(bookDir) { return path.join(bookDir, 'mentions.json'); }
function getBiblePath(bookDir) { return path.join(bookDir, 'bible.json'); }
function getLocationsPath(bookDir) { return path.join(bookDir, 'locations.json'); }
function getVoicesPath(bookDir) { return path.join(bookDir, 'voices.json'); }
function getChapterDir(bookDir) { return path.join(bookDir, 'chapters'); }
function getChapterPath(bookDir, file) { return path.join(getChapterDir(bookDir), file); }
function getCoverPath(bookDir) { return path.join(bookDir, 'cover.json'); }

function generateId(prefix) {
    return prefix + '-' + crypto.randomBytes(4).toString('hex');
}
const chapterId = () => generateId('ch');
const sceneId = () => generateId('sc');
const unitId = () => generateId('iu');

function generateBookId(title) {
    const base = title
        ? title.toLowerCase().replace(/[^a-z0-9\u0400-\u04FF]+/g, '_').replace(/^_|_$/g, '').substring(0, 48)
        : 'imported';
    return base + '_' + Date.now();
}

module.exports = {
    getBooksDir, getBookDir, getSourcePath, getManifestPath, getBookMetaPath,
    getCharactersPath, getMentionsPath, getBiblePath, getLocationsPath, getVoicesPath, getChapterDir, getChapterPath, getCoverPath,
    generateId, chapterId, sceneId, unitId, generateBookId,
};
