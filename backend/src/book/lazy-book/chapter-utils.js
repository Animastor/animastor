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
        chapter_id: chId,
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

    const chFile = `${coverChapter.chapter_id}.json`;
    const chPath = path.join(chDir, chFile);
    fs.writeFileSync(chPath, JSON.stringify(coverChapter, null, 2));
    console.log(`[LAZY-BOOK] Cover chapter saved to chapters/${chFile} for ${bookId}: "${coverChapter.chapter_title}"`);
}

// ── Segment-driven typography intro (v2 structure map) ──────────────
// Builds the narrator-voiced typography scene for a chapter segment:
//   prologue → "Пролог\nМир на переломе эпох"
//   chapter  → "Глава 1\nЗемля"
//   epilogue → "Эпилог\n..."
// Returns null for plain 'body'/'poem' segments — unstructured text gets
// NO forced "Глава 1" title card (universality: find what exists).

const SEGMENT_LABELS = {
    prologue: { ru: 'Пролог', en: 'Prologue' },
    epilogue: { ru: 'Эпилог', en: 'Epilogue' },
    introduction: { ru: 'Введение', en: 'Introduction' },
    preface: { ru: 'Предисловие', en: 'Preface' },
    afterword: { ru: 'Послесловие', en: 'Afterword' },
    appendix: { ru: 'Приложение', en: 'Appendix' },
    part: { ru: 'Часть', en: 'Part' },
};
const CHAPTER_LABELS = { ru: 'Глава', en: 'Chapter' };

function buildSegmentIntro(segInfo, language) {
    const info = segInfo || {};
    const type = info.type || 'chapter';
    const lang = language === 'ru' ? 'ru' : 'en';

    let label;
    if (type === 'chapter') label = CHAPTER_LABELS[lang];
    else label = SEGMENT_LABELS[type]?.[lang] || SEGMENT_LABELS[type]?.ru || null;
    if (!label) return null; // body/poem — no title card

    // Normalize titles that (despite the LLM rule) include the structural
    // prefix: "Глава 1. Земля" → "Земля" (prevents "Глава 1\nГлава 1. Земля").
    const title = String(info.title || '')
        .replace(/^(?:Глава|Chapter|Пролог|Prologue|Эпилог|Epilogue)\s*\d*\s*[.:]?\s*/i, '')
        .trim();
    const num = info.number != null ? info.number : null;
    const head = num != null ? `${label} ${num}` : label;
    const text = title ? `${head}\n${title}` : head;

    return {
        text,
        scene_title: head,
        style: 'soviet_book_page',
        label,
    };
}

// extractSceneTitle and isGenericSceneTitle imported from shared utils/scene-title-utils.

module.exports = {
    createChapterIntroScene,
    createCoverChapter,
    saveCoverChapter,
    buildSegmentIntro,
    extractSceneTitle,
    isGenericSceneTitle,
};
