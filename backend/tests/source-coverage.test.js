const { expect } = require('chai');
const {
    findNarrativeStartOffset,
    isAllCapsHeading,
} = require('../src/services/source-coverage');

describe('source-coverage: findNarrativeStartOffset (chapter-name heading)', () => {

    it('skips a classic "Глава N" header line plus its all-caps name', () => {
        const text = 'Глава 1\r\n\r\n\r\nНИКОГДА НЕ РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ\r\n\r\nОднажды весною, в час небывало жаркого заката...';
        const skip = findNarrativeStartOffset(text);
        expect(skip).to.be.greaterThan(0);
        expect(text.substring(skip).trimStart()).to.match(/^Однажды весною/);
    });

    it('skips an all-caps chapter NAME when the window opens directly with it (no "Глава N" line)', () => {
        // v2 structure map splits "Глава 1" and its all-caps name into separate
        // segments, so the window text may begin at the name line itself.
        const text = 'НИКОГДА НЕ РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ\r\n\r\nОднажды весною, в час небывало жаркого заката, в Москве...';
        const skip = findNarrativeStartOffset(text);
        expect(skip).to.be.greaterThan(0);
        expect(text.substring(skip).trimStart()).to.match(/^Однажды весною/);
    });

    it('skips a mixed-case part heading (ЧАСТЬ ПЕРВАЯ is handled by CHAPTER_HEADER_RE)', () => {
        const text = 'ЧАСТЬ ПЕРВАЯ\r\n\r\n\r\nГлава 1\r\n\r\n\r\nНИКОГДА НЕ РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ\r\n\r\nОднажды весною...';
        const skip = findNarrativeStartOffset(text);
        expect(skip).to.be.greaterThan(0);
        expect(text.substring(skip).trimStart()).to.match(/^Однажды весною/);
    });

    it('returns 0 when the text starts with a normal narrative sentence', () => {
        const text = 'Однажды весною, в час небывало жаркого заката, в Москве, на Патриарших прудах появились два гражданина.';
        expect(findNarrativeStartOffset(text)).to.equal(0);
    });

    it('returns 0 when the text starts with a short non-heading sentence', () => {
        // A short narrative line without punctuation is NOT treated as a heading
        // (looksLikeChapterTitle's weak branch must not fire for the first line).
        const text = 'Он встал и вышел\r\n\r\nОднажды весною...';
        expect(findNarrativeStartOffset(text)).to.equal(0);
    });

    it('skips leading blank lines before a heading', () => {
        const text = '\r\n\r\nНИКОГДА НЕ РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ\r\n\r\nОднажды весною...';
        const skip = findNarrativeStartOffset(text);
        expect(skip).to.be.greaterThan(0);
        expect(text.substring(skip).trimStart()).to.match(/^Однажды весною/);
    });

    it('consumes at most ONE weak title line after a strong header (short sentences are safe)', () => {
        // "Глава N" is a strong header; the weak branch may eat ONE following
        // title-like line, but must stop before consecutive narrative sentences.
        const text = 'Глава 1\r\nОн встал\r\nОн вышел\r\n\r\nОднажды весною...';
        const skip = findNarrativeStartOffset(text);
        expect(skip).to.be.greaterThan(0);
        expect(text.substring(skip).trimStart()).to.match(/^Он вышел/);
    });

    it('a strong all-caps name re-opens the weak slot for the real title', () => {
        const text = 'Глава 1\r\nНИКОГДА НЕ РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ\r\nНазвание\r\n\r\nОднажды весною...';
        const skip = findNarrativeStartOffset(text);
        expect(skip).to.be.greaterThan(0);
        expect(text.substring(skip).trimStart()).to.match(/^Однажды весною/);
    });

    describe('isAllCapsHeading', () => {
        it('recognizes all-caps multi-word lines as headings', () => {
            expect(isAllCapsHeading('НИКОГДА НЕ РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ')).to.equal(true);
            expect(isAllCapsHeading('ЧАСТЬ ПЕРВАЯ')).to.equal(true);
            expect(isAllCapsHeading('THE MASTER AND MARGARITA')).to.equal(true);
        });

        it('rejects single-word, mixed-case, and short-sentence lines', () => {
            expect(isAllCapsHeading('Глава')).to.equal(false);          // single word
            expect(isAllCapsHeading('Никогда не разговаривайте')).to.equal(false); // mixed case
            expect(isAllCapsHeading('Он встал и вышел')).to.equal(false);
            expect(isAllCapsHeading('')).to.equal(false);
            expect(isAllCapsHeading(null)).to.equal(false);
        });
    });
});
