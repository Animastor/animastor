// ======================================================
// C13 Parser Contract — re-export verification tests
// ======================================================
// Verifies that the VBook runtime correctly re-exports the Parser Core
// from @animastor/parser. The canonical contract tests live in
// packages/animastor-parser/test/parser.test.js.
const { expect } = require('chai');
const parser = require('@animastor/parser');
const contracts = require('@animastor/parser/contracts/parser-contract');
const legacyProjection = require('@animastor/parser/contracts/legacy-projection');

const STUB_TEXT = [
    'Пролог. Мир на переломе эпох',
    '',
    'x'.repeat(60),
    '',
    'Глава 1. Земля',
    '',
    'y'.repeat(60),
].join('\n');

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

describe('VBook runtime re-exports @animastor/parser', () => {
    it('parser facade is re-exported from @animastor/parser', () => {
        expect(parser.splitIntoChapters).to.be.a('function');
        expect(parser.setStructureDetector).to.be.a('function');
        expect(parser.PARSER_CONTRACT_VERSION).to.equal(1);
    });

    it('contracts are re-exported from @animastor/parser', () => {
        expect(contracts.PARSER_CONTRACT_VERSION).to.equal(1);
        expect(contracts.validateParserResult).to.be.a('function');
    });

    it('legacy projection is re-exported from @animastor/parser', () => {
        expect(legacyProjection.offsetToLine).to.be.a('function');
        expect(legacyProjection.mapToLegacyChapters).to.be.a('function');
    });

    it('splitIntoChapters works via re-export with stub detector', () => {
        parser.setStructureDetector({ buildDeterministicMap: stubMap });
        const chapters = parser.splitIntoChapters(STUB_TEXT);
        expect(chapters).to.have.length(2);
        expect(chapters[0].type).to.equal('prologue');
        expect(chapters[1].type).to.equal('chapter');
    });

    it('legacy projection matches splitIntoChapters via re-export', () => {
        const map = stubMap(STUB_TEXT);
        const projected = legacyProjection.mapToLegacyChapters(map, STUB_TEXT);
        const live = parser.splitIntoChapters(STUB_TEXT);
        expect(projected).to.deep.equal(live);
    });
});
