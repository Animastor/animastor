// ======================================================
// @animastor/parser — standalone smoke tests
// ======================================================
// Verifies the package works independently with a stub detector.
const { expect } = require('chai');
const parser = require('../src/index');
const contracts = require('../src/contracts/parser-contract');
const legacyProjection = require('../src/contracts/legacy-projection');

// ── Stub detector ────────────────────────────────────────────────────────────
function stubMap(text) {
    const lines = text.split('\n');
    let offset = 0;
    const segments = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^(Пролог|Глава \d+)/.test(line.trim())) {
            segments.push({
                type: line.startsWith('Пролог') ? 'prologue' : 'body',
                label: null,
                title: line.includes('. ') ? line.split('. ').slice(1).join('. ') : line,
                number: line.startsWith('Пролог') ? null : Number(line.match(/\d+/)?.[0] || 0),
                headerLine: line,
                startOffset: offset,
                endOffset: offset + line.length,
                source: 'detect',
            });
        }
        offset += line.length + 1;
    }
    for (let i = 0; i < segments.length; i++) {
        segments[i].endOffset = i + 1 < segments.length ? segments[i + 1].startOffset : text.length;
    }
    return {
        title: null, author: null, hasPrologue: segments.some(s => s.type === 'prologue'),
        hasEpilogue: false, parts: [], segments,
        source: 'detect',
    };
}

const STUB_TEXT = [
    'Пролог. Мир на переломе эпох',
    '',
    'x'.repeat(60),
    '',
    'Глава 1. Земля',
    '',
    'y'.repeat(60),
].join('\n');

// ── Package surface ──────────────────────────────────────────────────────────
describe('@animastor/parser — package surface', () => {
    before(() => {
        parser.setStructureDetector({ buildDeterministicMap: stubMap });
    });

    it('exports all Parser Core functions', () => {
        expect(parser.splitIntoChapters).to.be.a('function');
        expect(parser.splitIntoScenes).to.be.a('function');
        expect(parser.splitIntoUnits).to.be.a('function');
        expect(parser.firstMeaningfulChapter).to.be.a('function');
        expect(parser.detectLanguage).to.be.a('function');
        expect(parser.injectChapterMarkers).to.be.a('function');
        expect(parser.setStructureDetector).to.be.a('function');
        expect(parser.getStructureDetector).to.be.a('function');
    });

    it('exports C13 contract surface', () => {
        expect(parser.PARSER_CONTRACT_VERSION).to.equal(1);
        expect(parser.validateParserResult).to.be.a('function');
        expect(parser.validateParserSegment).to.be.a('function');
        expect(parser.assertValidParserResult).to.be.a('function');
        expect(parser.validateLanguageResult).to.be.a('function');
        expect(parser.isValidStructureDetectorPort).to.be.a('function');
        expect(parser.assertStructureDetectorPort).to.be.a('function');
        expect(parser.PARSER_SEGMENT_TYPES).to.be.an('array');
        expect(parser.PARSER_SEGMENT_SOURCES).to.be.an('array');
        expect(parser.PARSER_MAP_SOURCES).to.be.an('array');
    });

    it('exports legacy projection', () => {
        expect(parser.offsetToLine).to.be.a('function');
        expect(parser.segmentToLegacyChapter).to.be.a('function');
        expect(parser.mapToLegacyChapters).to.be.a('function');
    });

    it('exports language detection', () => {
        expect(parser.detectLanguageWithConfidence).to.be.a('function');
    });
});

// ── Contract subpath imports ─────────────────────────────────────────────────
describe('@animastor/parser — subpath imports', () => {
    it('contracts/parser-contract is importable via subpath', () => {
        const c = require('@animastor/parser/contracts/parser-contract');
        expect(c.PARSER_CONTRACT_VERSION).to.equal(1);
        expect(c.validateParserResult).to.be.a('function');
    });

    it('contracts/legacy-projection is importable via subpath', () => {
        const lp = require('@animastor/parser/contracts/legacy-projection');
        expect(lp.offsetToLine).to.be.a('function');
        expect(lp.mapToLegacyChapters).to.be.a('function');
    });

    it('language-detector is importable via subpath', () => {
        const ld = require('@animastor/parser/language-detector');
        expect(ld.detectLanguage).to.be.a('function');
        expect(ld.detectLanguageWithConfidence).to.be.a('function');
    });
});

// ── Functional tests ────────────────────────────────────────────────────────
describe('@animastor/parser — functional', () => {
    before(() => {
        parser.setStructureDetector({ buildDeterministicMap: stubMap });
    });

    it('splitIntoChapters produces legacy chapter DTO via stub detector', () => {
        const chapters = parser.splitIntoChapters(STUB_TEXT);
        expect(chapters).to.have.length(2);
        expect(chapters[0].type).to.equal('prologue');
        expect(chapters[1].type).to.equal('chapter');
        expect(chapters[1].number).to.equal(1);
    });

    it('validateParserResult accepts a valid map', () => {
        const map = stubMap(STUB_TEXT);
        const res = parser.validateParserResult(map, { sourceText: STUB_TEXT });
        expect(res.ok).to.equal(true);
    });

    it('detectLanguage detects Russian', () => {
        expect(parser.detectLanguage('Привет, как дела?')).to.equal('ru');
    });

    it('detectLanguageWithConfidence returns a valid result', () => {
        const r = parser.detectLanguageWithConfidence('Привет, как дела?');
        expect(contracts.validateLanguageResult(r).ok).to.equal(true);
    });

    it('legacy projection matches splitIntoChapters', () => {
        const map = stubMap(STUB_TEXT);
        const projected = legacyProjection.mapToLegacyChapters(map, STUB_TEXT);
        const live = parser.splitIntoChapters(STUB_TEXT);
        expect(projected).to.deep.equal(live);
    });
});

// ── Fail-closed (separate block — no before() binding) ──────────────────────
describe('@animastor/parser — fail-closed', () => {
    it('splitIntoChapters throws without bound detector', () => {
        // Clear ALL parser-related modules from require cache
        const toClear = [];
        for (const key of Object.keys(require.cache)) {
            if (key.includes('animastor-parser/src/')) toClear.push(key);
        }
        for (const key of toClear) delete require.cache[key];
        try {
            const fresh = require('../src/index');
            expect(() => fresh.splitIntoChapters('text')).to.throw(/structureDetector is not bound/);
        } finally {
            for (const key of Object.keys(require.cache)) {
                if (key.includes('animastor-parser/src/') && !toClear.includes(key)) {
                    delete require.cache[key];
                }
            }
        }
    });
});
