function splitIntoChapters(text) {
    const lines = text.split('\n');

    const chapterRe = /^(?:Глава|Chapter)\s*[.:]?\s*(.+)$/i;
    const prologueRe = /^(?:Пролог|Prologue|Эпилог|Epilogue|Введение|Introduction|Предисловие|Preface)$/i;

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
};
