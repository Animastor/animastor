const { expect } = require('chai');
const iconv = require('iconv-lite');
const {
    decodeBuffer,
    detectBom,
    scoreText,
    ENCODING_LABELS,
} = require('../src/encoding-detect');

// ======================================================
// @animastor/parser/encoding-detect — direct package tests
// ======================================================
// The module was adopted from the host (backend/src/services/
// encoding-detect.js → packages/animastor-parser/src/encoding-detect.js,
// C21.4 post-reconnaissance adoption). These tests pin the behavioral
// surface the host TXT importer consumes: BOM detection, UTF-8 passthrough,
// 8-bit Cyrillic detection, binary/empty rejection and the scorer's
// replacement-character penalty.

describe('parser/encoding-detect', () => {

    describe('detectBom', () => {
        it('detects a UTF-8 BOM', () => {
            const buf = Buffer.from([0xEF, 0xBB, 0xBF, 0x41]);
            const bom = detectBom(buf);
            expect(bom).to.not.equal(null);
            expect(bom.encoding).to.equal('utf-8');
            expect(bom.name).to.equal('UTF-8 BOM');
        });

        it('detects UTF-16 LE and BE BOMs', () => {
            expect(detectBom(Buffer.from([0xFF, 0xFE, 0x00])).name).to.equal('UTF-16 LE');
            expect(detectBom(Buffer.from([0xFE, 0xFF, 0x00])).name).to.equal('UTF-16 BE');
        });

        it('returns null for a BOM-less buffer', () => {
            expect(detectBom(Buffer.from('plain text'))).to.equal(null);
        });
    });

    describe('decodeBuffer', () => {
        it('decodes valid UTF-8 text and reports utf-8', () => {
            const text = 'Однажды весною, в час небывало жаркого заката...';
            const result = decodeBuffer(Buffer.from(text, 'utf8'));
            expect(result.error).to.equal(null);
            expect(result.encoding).to.equal('utf-8');
            expect(result.label).to.equal('UTF-8');
            expect(result.text).to.equal(text);
        });

        it('strips a UTF-8 BOM and warns', () => {
            const text = 'Заголовок';
            const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
            const result = decodeBuffer(buf);
            expect(result.error).to.equal(null);
            expect(result.text).to.equal(text);
            expect(result.warnings.some(w => /BOM/.test(w))).to.equal(true);
        });

        it('detects Windows-1251 Cyrillic text', () => {
            const text = 'Никогда не разговаривайте с неизвестными. Он встал и вышел из комнаты.';
            const buf = iconv.encode(text, 'win1251');
            const result = decodeBuffer(buf);
            expect(result.error).to.equal(null);
            expect(result.encoding).to.equal('win1251');
            expect(ENCODING_LABELS[result.encoding]).to.equal('Windows-1251');
            expect(result.text).to.equal(text);
        });

        it('rejects binary content', () => {
            const buf = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from('binary')]);
            const result = decodeBuffer(buf);
            expect(result.text).to.equal(null);
            expect(result.error).to.match(/binary/i);
        });

        it('rejects an empty buffer', () => {
            const result = decodeBuffer(Buffer.alloc(0));
            expect(result.text).to.equal(null);
            expect(result.error).to.match(/empty/i);
        });
    });

    describe('scoreText', () => {
        it('scores clean Cyrillic text high', () => {
            const clean = scoreText('Однажды весною, в час небывало жаркого заката, в Москве.');
            const mojibake = scoreText('Îäíàæäû âåñíîþ â ÷àñ íåáûâàëî æàðêîãî çàêàòà');
            expect(clean.score).to.be.greaterThan(mojibake.score);
        });

        it('counts replacement characters as a penalty signal', () => {
            const scored = scoreText('текст \uFFFD\uFFFD\uFFFD');
            expect(scored.replacementCount).to.equal(3);
        });

        it('returns counters for the decoded sample', () => {
            const s = scoreText('Привет');
            expect(s.totalChars).to.equal(6);
            expect(s.cyrillicCount).to.be.greaterThan(0);
        });
    });

    describe('ENCODING_LABELS', () => {
        it('exposes human-readable labels for the detection order', () => {
            expect(ENCODING_LABELS['utf-8']).to.equal('UTF-8');
            expect(ENCODING_LABELS['cp1251']).to.equal('Windows-1251');
            expect(ENCODING_LABELS['koi8-r']).to.equal('KOI8-R');
        });
    });
});
