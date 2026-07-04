// ======================================================
// Image Preview Thumbnails
// ======================================================

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const config = require('../config/runtime-config');
const helpers = require('./helpers');
const { makeIUImageFilename, makePreviewFilename } = require('../storage/filesystem-store');

async function getOrCreatePreview(bookId, chapterId, sceneId, iuId, buildId) {
    const strippedId = iuId.replace(/^iu/, '');
    const sourceName = makeIUImageFilename(bookId, chapterId, sceneId, strippedId);
    const previewName = makePreviewFilename(bookId, chapterId, sceneId, strippedId);

    const outputDir = config.OUTPUT_DIR;
    const dirs = [];
    const requestedDir = path.join(outputDir, buildId);
    if (fs.existsSync(requestedDir)) {
        dirs.push(requestedDir);
    }
    try {
        const allDirs = fs.readdirSync(outputDir)
            .filter(d => d !== buildId)
            .map(d => path.join(outputDir, d))
            .filter(d => fs.statSync(d).isDirectory());
        dirs.push(...allDirs);
    } catch (_) {}

    for (const dir of dirs) {
        const previewPath = path.join(dir, previewName);
        if (fs.existsSync(previewPath)) {
            return { path: previewPath, created: false };
        }
        const sourcePath = path.join(dir, sourceName);
        if (fs.existsSync(sourcePath)) {
            try {
                await sharp(sourcePath)
                    .resize({ width: helpers.PREVIEW_WIDTH, withoutEnlargement: true })
                    .png()
                    .toFile(previewPath);
                helpers.log(`preview created: ${previewName} (in ${path.basename(dir)})`);
                return { path: previewPath, created: true };
            } catch (err) {
                helpers.error(`preview generation failed for ${sourceName}: ${err.message}`);
                return null;
            }
        }
    }

    helpers.warn(`preview source not found for ${sourceName} in any build dir`);
    return null;
}

/**
 * Get image metadata (dimensions) using sharp.
 */
const getImageMetadata = async (imagePath) => {
    try {
        if (!fs.existsSync(imagePath)) {
            return null;
        }
        const stats = fs.statSync(imagePath);
        const metadata = await sharp(imagePath).metadata();
        return {
            exists: true,
            size: stats.size,
            width: metadata.width || null,
            height: metadata.height || null,
            format: metadata.format || null,
        };
    } catch {
        return null;
    }
};

module.exports = {
    getOrCreatePreview,
    getImageMetadata,
};
