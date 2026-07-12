// ======================================================
// Lazy Book — Chapter Utilities
// ======================================================

const fs = require('fs');
const path = require('path');
const { getChapterDir, getBookDir, getBookMetaPath, sceneId, unitId, chapterId } = require('./paths');
const { extractSceneTitle, isGenericSceneTitle } = require('../../utils/scene-title-utils');

function createChapterIntroScene(chapterTitle, chapterNumber, language) {
    const scId = sceneId();

    let cleanTitle = (chapterTitle || '').trim();
    cleanTitle = cleanTitle.replace(/^(?:Глава|Chapter)\s*\d+\s*[.:]?\s*/i, '').trim();

    const sceneText = language === 'ru'
        ? `Глава ${chapterNumber}\n${cleanTitle}`
        : `Chapter ${chapterNumber}\n${cleanTitle}`;

    return {
        scene_id: scId,
        scene_title: `Глава ${chapterNumber}`,
        type: 'chapter_intro',
        style: 'soviet_book_page',
        participants: [],
        audio: {
            voice: 'narrator',
            full_text: sceneText,
        },
        units: [{
            id: unitId(),
            type: 'typography',
            text: sceneText,
            participants: [],
            image: {
                shot: 'wide',
                prompt: `Chapter ${chapterNumber} title page typography, book style, ${cleanTitle}`,
            },
        }],
    };
}

function createCoverChapter(title, author, language) {
    const chId = chapterId();
    const scId = sceneId();
    const displayTitle = title || 'Imported Book';
    const displayAuthor = author || '';

    const textParts = [];
    if (displayAuthor) textParts.push(displayAuthor);
    if (displayTitle) textParts.push(displayTitle);
    const sceneText = textParts.join('\n\n');

    return {
        chapter: chId,
        chapter_title: 'Обложка',
        type: 'cover',
        scenes: [{
            scene_id: scId,
            scene_title: 'Cover',
            type: 'cover',
            style: 'soviet_book_page',
            participants: [],
            audio: {
                voice: 'narrator',
                full_text: sceneText,
            },
            units: [{
                id: unitId(),
                type: 'typography',
                text: sceneText,
                participants: [],
                image: {
                    shot: 'wide',
                    prompt: `Book cover: ${displayTitle}${displayAuthor ? ` by ${displayAuthor}` : ''}, typography, elegant design`,
                },
            }],
        }],
    };
}

function saveCoverChapter(bookId, coverChapter) {
    if (!coverChapter) return;
    const bookDir = getBookDir(bookId);
    const chDir = getChapterDir(bookDir);
    if (!fs.existsSync(chDir)) fs.mkdirSync(chDir, { recursive: true });

    const chFile = `${coverChapter.chapter}.json`;
    const chPath = path.join(chDir, chFile);
    fs.writeFileSync(chPath, JSON.stringify(coverChapter, null, 2));
    console.log(`[LAZY-BOOK] Cover chapter saved to chapters/${chFile} for ${bookId}: "${coverChapter.chapter_title}"`);
}

// extractSceneTitle and isGenericSceneTitle imported from shared utils/scene-title-utils.

module.exports = {
    createChapterIntroScene,
    createCoverChapter,
    saveCoverChapter,
    extractSceneTitle,
    isGenericSceneTitle,
};
