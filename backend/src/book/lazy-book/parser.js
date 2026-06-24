/**
 * Inject [ГЛАВА: TITLE] markers into text for chapters that use
 * ALL-CAPS headings WITHOUT the word "Глава" or "Chapter".
 *
 * Rules:
 * - An ALL-CAPS line (>=2 words, >10 chars, all uppercase + punctuation)
 *   after >=2 blank lines is a candidate chapter heading
 * - Skip lines that already contain Глава/Chapter/Часть/Part/Пролог/etc.
 * - Skip first 5 lines (metadata: author, title, etc.)
 * - Skip lines > 100 chars (narrative text that happens to be caps)
 *
 * @param {string} text - Raw source text
 * @returns {string} Text with [ГЛАВА: ...] markers injected
 */
function injectChapterMarkers(text) {
    const lines = text.split('\n');
    const result = [];
    let blankCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) {
            blankCount++;
            result.push(line);
            continue;
        }

        // Skip metadata lines (first 5 content lines, skip part/chapter keywords)
        const isEarlyLine = i < 5;

        // Check ALL-CAPS: only uppercase letters (Cyrillic + Latin), spaces, punctuation
        const isAllCaps = /^[A-ZА-ЯЁ\s\d\-–—.,!?;:'"«»()]+$/.test(trimmed);
        const hasChapterKeyword = /Глава|Chapter|Часть|Part|Пролог|Prologue|Эпилог|Epilogue|Введение|Introduction|Предисловие|Preface|Послесловие|Afterword/i.test(trimmed);
        const words = trimmed.split(/\s+/).filter(w => w.length > 0);
        const isLongEnough = trimmed.length > 10 && trimmed.length < 100;
        const hasEnoughWords = words.length >= 2;
        // Must contain at least one letter (excludes pure number lines like "1929 — 1940")
        const hasLetter = /[A-Za-zА-Яа-яЁё]/.test(trimmed);
        const isPotentialHeading = isAllCaps && !hasChapterKeyword && isLongEnough && hasEnoughWords && hasLetter && !isEarlyLine;

        if (isPotentialHeading && blankCount >= 2) {
            // ── DEDUP: skip if there's a "Глава N" within 10 lines above ──
            // This ALL-CAPS line is likely a chapter title that is ALREADY
            // preceded by a "Глава N" header — no need for a duplicate marker.
            const nearbyLines = lines.slice(Math.max(0, i - 10), i).join('\n');
            const hasNearbyChapterMarker = /Глава\s+\d+|Chapter\s+\d+/i.test(nearbyLines);

            if (!hasNearbyChapterMarker) {
                // Inject marker 2 lines above the heading
                result.push('');
                result.push(`[ГЛАВА: ${trimmed}]`);
                result.push('');
            }
            result.push(line);
            blankCount = 0;
            continue;
        }

        result.push(line);
        if (trimmed) blankCount = 0;
    }

    return result.join('\n');
}

function splitIntoChapters(text) {
    const lines = text.split('\n');

    const chapterRe = /^(?:Глава|Chapter)\s*[.:]?\s*(.+)$/i;
    const prologueRe = /^(?:Пролог|Prologue|Эпилог|Epilogue|Введение|Introduction|Предисловие|Preface|Послесловие|Afterword)$/i;
    // ALL-CAPS chapter heading (for books without explicit "Глава" markers)
    const allCapsHeadingRe = /^\[ГЛАВА:\s+(.+)\]$/;

    const chapters = [];
    let curStart = 0;
    let curTitle = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        let match;
        if ((match = prologueRe.exec(line))) {
            if (curTitle !== null) {
                chapters.push({ title: curTitle, startLine: curStart, endLine: i - 1 });
            }
            curStart = i;
            curTitle = match[0];
        } else if ((match = chapterRe.exec(line))) {
            if (curTitle !== null) {
                chapters.push({ title: curTitle, startLine: curStart, endLine: i - 1 });
            }
            curStart = i;
            curTitle = match[1] ? match[1].trim() : line;
        } else if ((match = allCapsHeadingRe.exec(line))) {
            // Detected injected [ГЛАВА: TITLE] marker — treat as chapter boundary
            if (curTitle !== null) {
                chapters.push({ title: curTitle, startLine: curStart, endLine: i - 1 });
            }
            curStart = i + 1; // content starts after marker line
            curTitle = match[1].trim();
        }
    }

    if (curTitle !== null) {
        chapters.push({ title: curTitle, startLine: curStart, endLine: lines.length - 1 });
    }

    if (chapters.length === 0) {
        const parts = text.split(/\n\s*\n\s*\n+/);
        if (parts.length >= 2) {
            let offset = 0;
            for (let pi = 0; pi < Math.min(parts.length, 10); pi++) {
                const pLines = parts[pi].split('\n');
                chapters.push({
                    title: `Chapter ${pi + 1}`,
                    startLine: offset,
                    endLine: offset + pLines.length - 1,
                });
                offset += pLines.length + 2;
            }
        } else {
            chapters.push({ title: 'Chapter 1', startLine: 0, endLine: lines.length - 1 });
        }
    }

    for (const ch of chapters) {
        const startOff = lines.slice(0, ch.startLine).join('\n').length;
        const endOff = lines.slice(0, ch.endLine + 1).join('\n').length;
        ch.startOffset = startOff;
        ch.endOffset = endOff;
        ch.length = endOff - startOff;
    }

    return chapters;
}

function firstMeaningfulChapter(chapters, sourceText) {
    if (!chapters || chapters.length === 0) return null;
    for (const ch of chapters) {
        const text = sourceText.substring(ch.startOffset || 0, ch.endOffset || sourceText.length).trim();
        if (text.length >= 50) return ch;
    }
    return chapters[0];
}

function splitIntoScenes(chapterText) {
    const breakRe = /(?:\n\s*\n\s*\n+|^\s*[-–—]{3,}\s*$|^\s*\*{3,}\s*$|^\s*_{3,}\s*$)/gm;

    const parts = chapterText.split(breakRe).filter(s => s.trim());

    if (parts.length >= 2 && parts.length <= 20) {
        return parts.map(p => p.trim());
    }

    const paragraphs = chapterText.split(/\n\s*\n/).filter(p => p.trim());
    if (paragraphs.length >= 2) {
        const maxParas = Math.min(paragraphs.length, 30);
        const result = [];
        const perScene = Math.max(1, Math.floor(maxParas / 3));
        for (let i = 0; i < maxParas && result.length < 3; i += perScene) {
            const group = paragraphs.slice(i, i + perScene).join('\n\n');
            result.push(group);
        }
        return result;
    }

    return [chapterText.trim()];
}

function splitIntoUnits(sceneText) {
    const t = sceneText.trim();
    if (!t) return [{ type: 'narration', text: '', participants: [] }];
    return [{
        type: 'narration',
        text: t,
        participants: [],
    }];
}

function detectLanguage(text) {
    const sample = text.slice(0, 2000);
    const cyrillicCount = (sample.match(/[\u0400-\u04FF]/g) || []).length;
    const latinCount = (sample.match(/[a-zA-Z]/g) || []).length;
    if (cyrillicCount > latinCount) return 'ru';
    return 'en';
}

module.exports = {
    splitIntoChapters, splitIntoScenes, splitIntoUnits,
    firstMeaningfulChapter, detectLanguage,
    injectChapterMarkers,
};
