// ======================================================
// Lazy Book — Metadata
// ======================================================

const fs = require('fs');
const { getBookMetaPath } = require('./paths');

function updateBookMetadata(bookDir, updates) {
    const bp = getBookMetaPath(bookDir);
    if (!fs.existsSync(bp)) return;
    const bookMeta = JSON.parse(fs.readFileSync(bp, 'utf8'));
    let changed = false;
    if (updates.author && !bookMeta.author) {
        bookMeta.author = updates.author;
        changed = true;
    }
    if (updates.title && !bookMeta.title) {
        bookMeta.title = updates.title;
        changed = true;
    }
    if (updates.structure) {
        if (updates.structure.has_prologue !== undefined) {
            bookMeta.structure.has_prologue = updates.structure.has_prologue;
            changed = true;
        }
        if (updates.structure.has_epilogue !== undefined) {
            bookMeta.structure.has_epilogue = updates.structure.has_epilogue;
            changed = true;
        }
        if (updates.structure.parts) {
            bookMeta.structure.parts = updates.structure.parts;
            changed = true;
        }
        if (updates.structure.chapters) {
            bookMeta.structure.chapters = updates.structure.chapters;
            changed = true;
        }
    }
    if (changed) {
        bookMeta.updated_at = new Date().toISOString();
        fs.writeFileSync(bp, JSON.stringify(bookMeta, null, 2));
        console.log(`[LAZY-BOOK] Metadata updated: ${Object.keys(updates).join(', ')}`);
    }
}

module.exports = {
    updateBookMetadata,
};
