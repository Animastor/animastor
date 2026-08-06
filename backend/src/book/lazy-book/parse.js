// ======================================================
// Lazy Book — Lazy Parsing
// ======================================================

const fs = require('fs');
const path = require('path');
const { BookState, SceneStatus, UnitType, DEFAULT_WINDOW_SIZE } = require('./constants');
const { getBookDir, getChapterDir, getBookMetaPath, chapterId, sceneId, unitId } = require('./paths');
const { splitIntoChapters, splitIntoScenes, splitIntoUnits, detectLanguage } = require('./parser');
const chapterUtils = require('./chapter-utils');
const draft = require('./draft');

// Typography intro scene for the lazy-parse path — mirrors the AI path so
// every chapter (incl. prologue) starts with a narrator-voiced title card.
function buildLazyChapterIntro(chInfo, language) {
    const introData = chapterUtils.buildSegmentIntro(
        { type: chInfo.type, title: chInfo.title, number: chInfo.number, label: chInfo.label },
        language
    );
    if (!introData || !introData.text) return null;
    return {
        scene_id: sceneId(),
        scene_title: introData.scene_title,
        type: 'chapter_intro',
        style: introData.style || 'soviet_book_page',
        participants: [],
        audio: { voice: 'narrator', full_text: introData.text },
        units: [{
            id: unitId(),
            type: 'typography',
            text: introData.text,
            participants: [],
            image: { shot: 'wide', prompt: `${introData.scene_title} title page typography, book style` },
        }],
    };
}

function lazyParseNextWindow(bookId, windowSize) {
    const d = draft.loadDraftBook(bookId);
    if (!d) throw new Error(`Book ${bookId} not found`);
    if (!d.sourceText) throw new Error(`Book ${bookId} has no source text`);

    const ws = windowSize || DEFAULT_WINDOW_SIZE;
    const chapters = splitIntoChapters(d.sourceText);

    const parsedIndices = new Set();
    for (const ch of d.chapters) {
        if (ch.chapter_index !== undefined) parsedIndices.add(ch.chapter_index);
    }

    let nextIdx = -1;
    for (let i = 0; i < chapters.length; i++) {
        if (!parsedIndices.has(i)) { nextIdx = i; break; }
    }

    if (nextIdx === -1) {
        draft.updateBookState(bookId, BookState.ACTIVE);
        return { parsed: 0, complete: true, chapters: [] };
    }

    const endIdx = Math.min(nextIdx + ws, chapters.length);
    const bookDir = getBookDir(bookId);
    const chDir = getChapterDir(bookDir);
    if (!fs.existsSync(chDir)) fs.mkdirSync(chDir, { recursive: true });

    const parsedChapters = [];

    for (let ci = nextIdx; ci < endIdx; ci++) {
        const chInfo = chapters[ci];
        const chId = chapterId();
        const fullChapterText = d.sourceText.substring(
            chInfo.startOffset || 0,
            chInfo.endOffset || d.sourceText.length
        );
        const chLines = fullChapterText.split('\n');
        const chFirst = chLines[0]?.trim() || '';
        const chapterText = /^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(chFirst)
            ? chLines.slice(1).join('\n').trim() : fullChapterText.trim();
        const sceneTexts = splitIntoScenes(chapterText);

        const chObj = {
            chapter: chId,
            chapter_title: chInfo.title || null,
            type: chInfo.type || 'chapter',
            chapter_index: ci,
            status: SceneStatus.PARSED,
            scenes: [],
        };

        const introScene = buildLazyChapterIntro(chInfo, d.book?.language || detectLanguage(d.sourceText));
        if (introScene) chObj.scenes.push(introScene);

        for (let si = 0; si < sceneTexts.length; si++) {
            const sceneText = sceneTexts[si];
            const units = splitIntoUnits(sceneText);
            // unit.participants removed — scenes use scene-level participants only
            const participants = [];

            const sceneStyle = units.some(u => u.type === UnitType.TYPOGRAPHY) ? 'soviet_book_page' : undefined;
            chObj.scenes.push({
                scene_id: sceneId(),
                scene_title: si === 0 ? chInfo.title : `Scene ${si + 1}`,
                type: units.some(u => u.type === UnitType.DIALOGUE) && units.filter(u => u.type === UnitType.DIALOGUE).length > units.length / 3
                    ? 'dialogue' : 'narration',
                style: sceneStyle,
                participants,
                audio: { voice: 'narrator', full_text: sceneText },
                units: units.map(u => ({
                    id: unitId(),
                    type: u.type,
                    text: u.text,
                })),
            });
        }

        const chFile = `${chId}.json`;
        fs.writeFileSync(path.join(chDir, chFile), JSON.stringify(chObj, null, 2));
        parsedChapters.push(chObj);
    }

    const bookMeta = JSON.parse(fs.readFileSync(getBookMetaPath(bookDir), 'utf8'));
    const existingFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort();
    bookMeta.structure.chapters_order = existingFiles;
    fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(bookMeta, null, 2));

    const complete = endIdx >= chapters.length;
    draft.updateBookState(bookId, complete ? BookState.ACTIVE : BookState.BOOTSTRAPPED);

    return {
        parsed: parsedChapters.length,
        windowStart: nextIdx,
        windowEnd: endIdx - 1,
        complete,
        chapters: parsedChapters.map(ch => ({
            chapter_id: ch.chapter_id,
            chapter_title: ch.chapter_title,
            chapter_index: ch.chapter_index,
            status: ch.status,
            scene_count: ch.scenes.length,
        })),
    };
}

function lazyParseChapter(bookId, chapterIndex) {
    const d = draft.loadDraftBook(bookId);
    if (!d || !d.sourceText) throw new Error(`Book ${bookId} not found`);

    const chapters = splitIntoChapters(d.sourceText);
    if (chapterIndex < 0 || chapterIndex >= chapters.length) throw new Error(`Chapter ${chapterIndex} out of range (0-${chapters.length - 1})`);

    const bookDir = getBookDir(bookId);
    const chDir = getChapterDir(bookDir);
    if (!fs.existsSync(chDir)) fs.mkdirSync(chDir, { recursive: true });

    for (const cf of fs.readdirSync(chDir).filter(f => f.endsWith('.json'))) {
        try {
            const ch = JSON.parse(fs.readFileSync(path.join(chDir, cf), 'utf8'));
            if (ch.chapter_index === chapterIndex) return { chapter: ch, wasExisting: true };
        } catch (e) { /* skip */ }
    }

    const chInfo = chapters[chapterIndex];
    const chId = chapterId();
    const fullChText = d.sourceText.substring(
        chInfo.startOffset || 0, chInfo.endOffset || d.sourceText.length
    );
    const chLines = fullChText.split('\n');
    const chFirst = chLines[0]?.trim() || '';
    const chapterText = /^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(chFirst)
        ? chLines.slice(1).join('\n').trim() : fullChText.trim();
    const sceneTexts = splitIntoScenes(chapterText);

    const chObj = {
        chapter: chId,
        chapter_title: chInfo.title || null,
        type: chInfo.type || 'chapter',
        chapter_index: chapterIndex,
        status: SceneStatus.PARSED,
        scenes: [],
    };

    const introScene = buildLazyChapterIntro(chInfo, d.book?.language || detectLanguage(d.sourceText));
    if (introScene) chObj.scenes.push(introScene);

    for (const sceneText of sceneTexts) {
        const units = splitIntoUnits(sceneText);
        // unit.participants removed — scene-level participants only
        const participants = [];

        const sceneStyle = units.some(u => u.type === UnitType.TYPOGRAPHY) ? 'soviet_book_page' : undefined;
        chObj.scenes.push({
            scene_id: sceneId(),
            scene_title: `${chObj.scenes.length + 1}`,
            type: units.some(u => u.type === UnitType.DIALOGUE) && units.filter(u => u.type === UnitType.DIALOGUE).length > units.length / 3
                ? 'dialogue' : 'narration',
            style: sceneStyle,
            participants,
            audio: { voice: 'narrator', full_text: sceneText },
            units: units.map(u => ({
                id: unitId(),
                type: u.type,
                text: u.text,
            })),
        });
    }

    const chFile = `${chId}.json`;
    fs.writeFileSync(path.join(chDir, chFile), JSON.stringify(chObj, null, 2));

    const bookMeta = JSON.parse(fs.readFileSync(getBookMetaPath(bookDir), 'utf8'));
    const existingFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort();
    bookMeta.structure.chapters_order = existingFiles;
    fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(bookMeta, null, 2));

    return { chapter: chObj, wasExisting: false };
}

module.exports = {
    lazyParseNextWindow,
    lazyParseChapter,
};
