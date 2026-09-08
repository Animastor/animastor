// ======================================================
// C13 Parser Contract — package-owned contract tests (standalone)
// ======================================================
// Pure contract surface of @animastor/vbook-runtime: the canonical
// ParserResult DTO validation, the StructureDetectorPort shape check and
// the legacy chapter DTO projection. No host, no PG/Redis, no fs.
// The real deterministic detector lives host-side — the full contract +
// golden fixture suite runs there (backend/tests/parser-contract.test.js).
const { expect } = require('chai');
const contracts = require('../src/contracts/parser-contract');
const legacyProjection = require('../src/contracts/legacy-projection');
const parser = require('../src/lazy-book/parser');

// ── Minimal canonical maps (stub level — Parser ≠ VBook doctrine) ────────

const validMap = (text, over = {}) => ({
    title: null,
    author: null,
    hasPrologue: false,
    hasEpilogue: false,
    parts: [],
    segments: [{ type: 'body', label: null, title: null, number: null, headerLine: null, startOffset: 0, endOffset: text.length, source: 'detect' }],
    source: 'detect',
    ...over,
});

const stubMap = (text) => ({
    title: { text: 'Stub title', source: 'detect', candidateId: 'c0' },
    author: null,
    hasPrologue: false,
    hasEpilogue: false,
    parts: [],
    segments: [
        { type: 'chapter', label: 'Глава', title: 'Первая', number: 1, headerLine: 'Глава 1', startOffset: 0, endOffset: Math.floor(text.length / 2), source: 'detect' },
        { type: 'body', label: null, title: null, number: null, headerLine: null, startOffset: Math.floor(text.length / 2), endOffset: text.length, source: 'detect' },
    ],
    source: 'detect',
});

describe('C13 parser contract — package surface', () => {
    it('freezes contract version 1 and the canonical segment vocabulary', () => {
        expect(contracts.PARSER_CONTRACT_VERSION).to.equal(1);
        expect(contracts.PARSER_SEGMENT_TYPES).to.deep.equal([
            'chapter', 'prologue', 'epilogue', 'part',
            'introduction', 'afterword', 'appendix', 'body', 'poem',
        ]);
    });

    it('validateParserResult accepts a canonical map (no mutation)', () => {
        const text = 'a'.repeat(40);
        const map = validMap(text);
        const snapshot = JSON.stringify(map);
        expect(contracts.validateParserResult(map, { sourceText: text }).ok).to.equal(true);
        expect(JSON.stringify(map)).to.equal(snapshot);
    });

    it('validateParserResult rejects broken maps with explicit codes', () => {
        const text = 'a'.repeat(40);
        const broken = validMap(text);
        broken.segments[0].endOffset = 100; // outside the source text
        const res = contracts.validateParserResult(broken, { sourceText: text });
        expect(res.ok).to.equal(false);
        expect(res.errors.map(e => e.code)).to.include('OFFSET_OUT_OF_RANGE');

        expect(contracts.validateParserResult({ ...validMap(text), contractVersion: 2 }).errors.map(e => e.code))
            .to.include('INVALID_CONTRACT_VERSION');
        expect(contracts.validateParserResult(null).errors.map(e => e.code)).to.include('MAP_NOT_AN_OBJECT');
    });

    it('assertValidParserResult throws on violation and passes through on success', () => {
        const text = 'a'.repeat(40);
        expect(() => contracts.assertValidParserResult(validMap(text), { sourceText: text })).to.not.throw();
        expect(() => contracts.assertValidParserResult({})).to.throw(/C13 contract/);
    });

    it('StructureDetectorPort shape check: buildDeterministicMap or buildChapterMap alias', () => {
        expect(contracts.isValidStructureDetectorPort({ buildDeterministicMap: (t) => t })).to.equal(true);
        expect(contracts.isValidStructureDetectorPort({ buildChapterMap: (t) => t })).to.equal(true);
        expect(contracts.isValidStructureDetectorPort({})).to.equal(false);
        expect(contracts.isValidStructureDetectorPort(null)).to.equal(false);
        expect(() => contracts.assertStructureDetectorPort({})).to.throw(/buildDeterministicMap/);
    });

    it('legacy projection: mapToLegacyChapters === splitIntoChapters (fresh port instance)', () => {
        // Fresh module instance: binding state is process-global, so probe an
        // isolated copy (the original instance keeps its package-suite stub).
        const parserPath = require.resolve('../src/lazy-book/parser.js');
        const cached = require.cache[parserPath];
        delete require.cache[parserPath];
        let fresh;
        try {
            fresh = require('../src/lazy-book/parser.js');
            const text = 'Глава 1. Первая\n\n' + 'x'.repeat(40) + '\n\nхвост текста';
            const map = stubMap(text);
            fresh.setStructureDetector({ buildDeterministicMap: () => map });
            expect(fresh.splitIntoChapters(text)).to.deep.equal(legacyProjection.mapToLegacyChapters(map, text));
            expect(fresh.splitIntoChapters(text)[0]).to.include({ title: 'Первая', type: 'chapter', number: 1 });
            expect(fresh.splitIntoChapters(text)[1]).to.include({ title: null, type: 'chapter', number: null });
        } finally {
            delete require.cache[parserPath];
            if (cached) require.cache[parserPath] = cached;
        }
    });

    it('offsetToLine maps char offsets to 0-based lines (shared definition)', () => {
        const lines = ['abc', 'de', ''];
        expect(legacyProjection.offsetToLine(lines, 0)).to.equal(0);
        expect(legacyProjection.offsetToLine(lines, 2)).to.equal(0);
        expect(legacyProjection.offsetToLine(lines, 3)).to.equal(1); // the '\n' position belongs to the next line
        expect(legacyProjection.offsetToLine(lines, 4)).to.equal(1);
        expect(legacyProjection.offsetToLine(lines, 6)).to.equal(2);
        expect(legacyProjection.offsetToLine(lines, 99)).to.equal(2);
    });

    it('parser facade exposes the contract surface additively', () => {
        expect(parser.PARSER_CONTRACT_VERSION).to.equal(1);
        expect(parser.validateParserResult).to.be.a('function');
        expect(parser.mapToLegacyChapters).to.be.a('function');
    });

    it('empty legacy projection falls back to one full-text plain chapter', () => {
        const text = 'ab\ncd';
        expect(legacyProjection.mapToLegacyChapters({ segments: [] }, text)).to.deep.equal([{
            title: null, type: 'chapter', label: null, number: null,
            startLine: 0, endLine: 1, startOffset: 0, endOffset: 5, length: 5,
        }]);
    });
});
