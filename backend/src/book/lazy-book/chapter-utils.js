// ======================================================
// Lazy Book — Chapter Utilities
// ======================================================

const fs = require('fs');
const path = require('path');
const { getChapterDir, getBookDir, getBookMetaPath, sceneId, unitId, chapterId } = require('./paths');
const { extractSceneTitle, isGenericSceneTitle } = require('../../utils/scene-title-utils');

// ── Typography page prompt ───────────────────────────────────────────
// A typography page (title card / cover) must tell the generator WHAT text to
// typeset, not just how to style the page. The prompt is assembled in a fixed
// structure the image model can read directly:
//
//   <instructions, comma-separated> — page kind, style, composition, layout,
//                                     quality — ALWAYS in English
//   . text on the page: "<content>"  — the exact page content (the book's own
//                                     language), clearly delimited at the end
//
// The content block is the ONLY place the page text appears — never in the
// instructions — so nothing is duplicated and instruction vs content is
// unambiguous. Title cards have no dynamics, so the video action copies the
// image prompt (a typography page still plays in the video sequence, so an
// empty video.action is never written).

const TYPOGRAPHY_LAYOUT = 'vertical full-page composition, centered text layout';
const TYPOGRAPHY_QUALITY = 'image quality: high detail, crisp lettering, sharp focus';

// English wording for a stored style token (scene.style) inside image prompts.
function typographyStyleDescriptor(style) {
    const s = String(style || '').toLowerCase().replace(/[\s_-]+/g, '_');
    const map = {
        soviet_book_page: 'soviet book style',
        book_style: 'classic book style',
        typography_only: 'minimalist typography',
        chapter_title: 'chapter title page',
        cover: 'book cover',
    };
    const fallback = String(style || '').replace(/_/g, ' ').trim();
    // Unknown tokens are used verbatim ONLY when pure ASCII — the instructions
    // block must stay English-only (a Cyrillic style token would leak into it).
    return map[s] || (fallback && /^[\x00-\x7F]*$/.test(fallback) ? fallback : 'book style');
}

function buildTypographyPagePrompt(pageText, basePrompt) {
    const text = String(pageText || '').trim();
    const base = String(basePrompt || '').trim();
    const instructions = base ? `${base}, ${TYPOGRAPHY_QUALITY}` : TYPOGRAPHY_QUALITY;
    if (!text) return instructions;
    return `${instructions}. text on the page: "${text.replace(/"/g, "'")}"`;
}

function createChapterIntroScene(chapterTitle, chapterNumber, language) {
    const scId = sceneId();

    let cleanTitle = (chapterTitle || '').trim();
    cleanTitle = cleanTitle.replace(/^(?:Глава|Chapter)\s*\d+\s*[.:]?\s*/i, '').trim();

    const sceneText = language === 'ru'
        ? `Глава ${chapterNumber}\n${cleanTitle}`
        : `Chapter ${chapterNumber}\n${cleanTitle}`;

    // Typography page: image.prompt carries the page text verbatim; the static
    // title card copies it into video.action (still plays in the video sequence).
    const prompt = buildTypographyPagePrompt(
        sceneText,
        `title page typography, soviet book style, ${TYPOGRAPHY_LAYOUT}`
    );

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
                prompt,
            },
            video: {
                action: prompt,
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

    // Typography page: image.prompt carries the cover text verbatim; video.action
    // copies it (static title card, still plays in the video sequence). The
    // VISUAL text is title-first (a cover shows the title above the author);
    // unit.text / audio keep the original source order.
    const coverText = [displayTitle, displayAuthor].filter(Boolean).join('\n\n');
    const prompt = buildTypographyPagePrompt(
        coverText,
        `book cover typography, soviet book style, ${TYPOGRAPHY_LAYOUT}, prominent title`
    );

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
                    prompt,
                },
                video: {
                    action: prompt,
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
    buildTypographyPagePrompt,
    typographyStyleDescriptor,
    TYPOGRAPHY_LAYOUT,
    extractSceneTitle,
    isGenericSceneTitle,
};
