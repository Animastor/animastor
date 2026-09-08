// ======================================================
// C13 Parser Contract tests — freeze the Parser Core boundary
// ======================================================
// Pins the CURRENT behavior of the Parser/AI boundary (no behavior change):
//   - canonical ParserResult/ChapterMap validation (contracts/parser-contract);
//   - legacy chapter DTO = projection of the canonical map (identity with
//     the live splitIntoChapters output);
//   - golden fixtures (docs/parser-contract-c13.md §9) — the regression
//     baseline for the future physical extraction of @animastor/parser;
//   - StructureDetectorPort binding via setStructureDetector (fail-closed).
// The AI merge itself (structure-detector.test.js) stays the AI-side suite.
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

require('./vbook-test-bindings.cjs'); // binds the real structure-detector port

const sd = require('../src/services/structure-detector');
const parser = require('@animastor/parser');
const contracts = require('@animastor/parser/contracts/parser-contract');
const legacyProjection = require('@animastor/parser/contracts/legacy-projection');

// ── Fixtures ─────────────────────────────────────────────────────────────

const PROSE = (t) => t.repeat(3);

const SINGLE_CHAPTER_RU = [
    'Глава 1. Начало',
    '',
    PROSE('Утро выдалось тихим, и город ещё не проснулся. Он шёл по пустой улице, слушая, как под ногами хрустит свежий песок, и думал о том, что всё только начинается. '),
].join('\n');

const NO_CHAPTERS_RU = PROSE('Она открыла дверь и вошла. В комнате пахло кофе и старой бумагой. Кто-то ждал её у окна, и этот кто-то не обернулся, когда скрипнула половица. ');

const EN_CHAPTERS = [
    'The Long Road Home',
    '',
    'John Smith',
    '',
    'Chapter 1. Departure',
    '',
    PROSE('The morning train pulled out of the station under a grey sky, and Thomas watched the city dissolve into fields and rivers he had never learned to name. '),
    '',
    'Chapter 2. Arrival',
    '',
    PROSE('By the time the letter reached him, the road home had already changed its shape, and the house at the end of it no longer waited for anyone. '),
].join('\n');

const GOLDEN = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'parser-contract', 'golden', 'parser-golden-fixtures.json'),
    'utf8',
));

// ── Contract validation (pure helper) ────────────────────────────────────

describe('C13: validateParserResult (contract validation, never mutates)', () => {
    it('accepts a canonical deterministic map built from real text', () => {
        const map = sd.buildDeterministicMap(SINGLE_CHAPTER_RU);
        const snapshot = JSON.stringify(map);
        const res = contracts.validateParserResult(map, { sourceText: SINGLE_CHAPTER_RU });
        expect(res.ok, JSON.stringify(res.errors)).to.equal(true);
        expect(res.contractVersion).to.equal(1);
        expect(JSON.stringify(map)).to.equal(snapshot); // validation did not mutate
    });

    it('treats an absent contractVersion as 1 and rejects a wrong explicit one', () => {
        const map = sd.buildDeterministicMap(SINGLE_CHAPTER_RU);
        expect(contracts.validateParserResult(map).ok).to.equal(true);

        const v2 = { ...map, contractVersion: 2 };
        const res = contracts.validateParserResult(v2);
        expect(res.ok).to.equal(false);
        expect(res.errors.map(e => e.code)).to.include('INVALID_CONTRACT_VERSION');
    });

    it('rejects: segments missing / not an array', () => {
        const res = contracts.validateParserResult({ hasPrologue: false, hasEpilogue: false, parts: [], source: 'detect' });
        expect(res.ok).to.equal(false);
        expect(res.errors.map(e => e.code)).to.include('SEGMENTS_MISSING');
    });

    it('rejects: non-empty source with zero segments (no body fallback)', () => {
        const map = { hasPrologue: false, hasEpilogue: false, parts: [], segments: [], source: 'detect' };
        const res = contracts.validateParserResult(map, { sourceText: 'какой-то текст' });
        expect(res.ok).to.equal(false);
        expect(res.errors.map(e => e.code)).to.include('NO_BODY_FALLBACK');
        // Zero segments stay valid only for an empty source (documented §4).
        const empty = contracts.validateParserResult(map, { sourceText: '' });
        expect(empty.ok).to.equal(true);
    });

    it('rejects: startOffset > endOffset', () => {
        const map = {
            hasPrologue: false, hasEpilogue: false, parts: [], source: 'detect',
            segments: [{ type: 'body', label: null, title: null, number: null, headerLine: null, startOffset: 10, endOffset: 5, source: 'detect' }],
        };
        const res = contracts.validateParserResult(map, { sourceText: 'x'.repeat(50) });
        expect(res.ok).to.equal(false);
        expect(res.errors.map(e => e.code)).to.include('OFFSET_ORDER');
    });

    it('rejects: offsets outside the exact source text', () => {
        const map = {
            hasPrologue: false, hasEpilogue: false, parts: [], source: 'detect',
            segments: [{ type: 'body', label: null, title: null, number: null, headerLine: null, startOffset: 0, endOffset: 100, source: 'detect' }],
        };
        const res = contracts.validateParserResult(map, { sourceText: 'x'.repeat(50) });
        expect(res.ok).to.equal(false);
        expect(res.errors.map(e => e.code)).to.include('OFFSET_OUT_OF_RANGE');
    });

    it('rejects: overlapping / out-of-order segments', () => {
        const map = {
            hasPrologue: false, hasEpilogue: false, parts: [], source: 'detect',
            segments: [
                { type: 'body', label: null, title: null, number: null, headerLine: null, startOffset: 0, endOffset: 20, source: 'detect' },
                { type: 'body', label: null, title: null, number: null, headerLine: null, startOffset: 10, endOffset: 30, source: 'detect' },
            ],
        };
        const res = contracts.validateParserResult(map, { sourceText: 'x'.repeat(50) });
        expect(res.ok).to.equal(false);
        expect(res.errors.map(e => e.code)).to.include('SEGMENT_OVERLAP');
    });

    it('rejects: bad segment type / field types / map source', () => {
        const base = (over) => ({
            hasPrologue: false, hasEpilogue: false, parts: [], source: 'detect',
            segments: [{ type: 'body', label: null, title: null, number: null, headerLine: null, startOffset: 0, endOffset: 10, source: 'detect' }],
            ...over,
        });
        const badType = base();
        badType.segments[0].type = 'volume';
        expect(contracts.validateParserResult(badType, { sourceText: 'x'.repeat(20) }).errors.map(e => e.code))
            .to.include('INVALID_SEGMENT_TYPE');

        const badField = base();
        badField.segments[0].title = 42;
        expect(contracts.validateParserResult(badField, { sourceText: 'x'.repeat(20) }).errors.map(e => e.code))
            .to.include('INVALID_SEGMENT_FIELD');

        const badNumber = base();
        badNumber.segments[0].number = 0;
        expect(contracts.validateParserResult(badNumber, { sourceText: 'x'.repeat(20) }).errors.map(e => e.code))
            .to.include('INVALID_SEGMENT_NUMBER');

        const badSource = base({ source: 'llm' });
        expect(contracts.validateParserResult(badSource, { sourceText: 'x'.repeat(20) }).errors.map(e => e.code))
            .to.include('INVALID_MAP_SOURCE');

        const badFlag = base({ hasPrologue: 'yes' });
        expect(contracts.validateParserResult(badFlag, { sourceText: 'x'.repeat(20) }).errors.map(e => e.code))
            .to.include('INVALID_FIELD_TYPE');

        const badPart = base({ parts: [{ name: '', order: 'first' }] });
        expect(contracts.validateParserResult(badPart, { sourceText: 'x'.repeat(20) }).errors.map(e => e.code))
            .to.include('INVALID_PART');

        const badMeta = base({ title: { source: 'detect' } });
        expect(contracts.validateParserResult(badMeta, { sourceText: 'x'.repeat(20) }).errors.map(e => e.code))
            .to.include('INVALID_META_FIELD');

        expect(contracts.validateParserResult(null).errors.map(e => e.code)).to.include('MAP_NOT_AN_OBJECT');
    });

    it('assertValidParserResult passes the map through and throws on violation', () => {
        const map = sd.buildDeterministicMap(SINGLE_CHAPTER_RU);
        expect(contracts.assertValidParserResult(map, { sourceText: SINGLE_CHAPTER_RU })).to.equal(map);
        expect(() => contracts.assertValidParserResult({})).to.throw(/violates the C13 contract/);
    });

    it('validateLanguageResult: {code,confidence} ok, null ok, garbage rejected', () => {
        expect(contracts.validateLanguageResult({ code: 'ru', confidence: 0.84 }).ok).to.equal(true);
        expect(contracts.validateLanguageResult(null).ok).to.equal(true);
        expect(contracts.validateLanguageResult({ code: 'RU', confidence: 2 }).ok).to.equal(false);
        expect(contracts.validateLanguageResult('ru').ok).to.equal(false);
    });
});

// ── Deterministic behavior (empty / tiny / degenerate inputs) ────────────

describe('C13: Parser deterministic behavior on degenerate inputs', () => {
    const cases = [
        ['empty text', ''],
        ['1-character text', 'a'],
        ['whitespace-only text', '   \n\t  '],
        ['text without chapters', NO_CHAPTERS_RU],
    ];
    for (const [name, text] of cases) {
        it(`${name}: deterministic map is stable, valid, and falls back to body`, () => {
            const a = sd.buildDeterministicMap(text);
            const b = sd.buildDeterministicMap(text);
            expect(JSON.stringify(a)).to.equal(JSON.stringify(b)); // deterministic
            const res = contracts.validateParserResult(a, { sourceText: text });
            expect(res.ok, JSON.stringify(res.errors)).to.equal(true);
            const chapters = parser.splitIntoChapters(text);
            expect(chapters).to.have.lengthOf(1); // legacy fallback never empty
            expect(chapters[0].startOffset).to.equal(0);
            expect(chapters[0].endOffset).to.equal(text.length);
            expect(chapters[0].length).to.equal(text.length);
        });
    }
});

// ── Standard chapters / prologue / epilogue / multiple segments ──────────

describe('C13: canonical map semantics (chapters, prologue, epilogue, offsets)', () => {
    it('single chapter: type/number/offsets anchor the exact text', () => {
        const map = sd.buildDeterministicMap(SINGLE_CHAPTER_RU);
        expect(map.segments).to.have.lengthOf(1);
        expect(map.segments[0].type).to.equal('chapter');
        expect(map.segments[0].number).to.equal(1);
        expect(map.segments[0].headerLine).to.equal('Глава 1. Начало');
        expect(map.segments[0].startOffset).to.equal(0);
        expect(map.segments[0].endOffset).to.equal(SINGLE_CHAPTER_RU.length);
    });

    it('multiple chapters: ordered, contiguous, no overlap, whole-text coverage', () => {
        const text = [
            'Глава 1. Земля',
            '',
            PROSE('Юра, инженер по искусственному интеллекту, всё чаще замечал странный парадокс: чем совершеннее становились технологии, тем реже человек пытался понять самого себя. '),
            '',
            'Глава 2. Первый полёт',
            '',
            PROSE('Пока большинство людей спорило о будущем, небольшая группа инженеров, учёных и исследователей просто начала его строить. '),
        ].join('\n');
        const map = sd.buildDeterministicMap(text);
        expect(map.segments.map(s => s.type)).to.deep.equal(['chapter', 'chapter']);
        expect(map.segments.map(s => s.number)).to.deep.equal([1, 2]);
        expect(map.segments.map(s => s.title)).to.deep.equal(['Земля', 'Первый полёт']);
        expect(map.segments[0].startOffset).to.equal(0);
        expect(map.segments[map.segments.length - 1].endOffset).to.equal(text.length);
        for (let i = 1; i < map.segments.length; i++) {
            expect(map.segments[i].startOffset).to.equal(map.segments[i - 1].endOffset);
        }
        for (const seg of map.segments) {
            expect(text.slice(seg.startOffset, seg.endOffset)).to.include(seg.headerLine);
        }
    });

    it('prologue and epilogue are classified, not numbered', () => {
        const text = [
            'Пролог. Мир на переломе эпох',
            '',
            PROSE('Первая половина XXI века стала временем стремительного научного прогресса. '),
            '',
            'Эпилог. Новый рассвет',
            '',
            PROSE('Прошли годы. Кольцевая станция превратилась в живой научный город, и город встретил новый рассвет. '),
        ].join('\n');
        const map = sd.buildDeterministicMap(text);
        expect(map.hasPrologue).to.equal(true);
        expect(map.hasEpilogue).to.equal(true);
        expect(map.segments.map(s => s.type)).to.deep.equal(['prologue', 'epilogue']);
        expect(map.segments.every(s => s.number === null)).to.equal(true);
    });
});

// ── Legacy DTO compatibility (projection is 1:1 with splitIntoChapters) ──

describe('C13: legacy chapter DTO is a projection of the canonical map', () => {
    const texts = [SINGLE_CHAPTER_RU, EN_CHAPTERS, NO_CHAPTERS_RU, '', 'a'];

    for (const text of texts) {
        const label = text === '' ? 'empty text' : (text.length < 3 ? '1-char text' : text.slice(0, 24) + '…');
        it(`projection === splitIntoChapters for ${label}`, () => {
            const map = sd.buildDeterministicMap(text);
            const projected = legacyProjection.mapToLegacyChapters(map, text);
            const live = parser.splitIntoChapters(text);
            expect(projected).to.deep.equal(live);
            // Legacy DTO shape: exactly the frozen field set.
            for (const ch of live) {
                expect(Object.keys(ch).sort()).to.deep.equal([
                    'endLine', 'endOffset', 'label', 'length', 'number',
                    'startLine', 'startOffset', 'title', 'type',
                ]);
            }
        });
    }

    it('legacy chapter DTO carries the documented fields with correct types', () => {
        const chapters = parser.splitIntoChapters(EN_CHAPTERS);
        expect(chapters.length).to.be.greaterThan(0);
        const numbered = chapters.find(c => c.number === 1);
        expect(numbered.title).to.equal('Departure');
        expect(numbered.type).to.equal('chapter');
        expect(numbered.startOffset).to.be.a('number');
        expect(numbered.endOffset).to.be.a('number');
        expect(numbered.length).to.equal(numbered.endOffset - numbered.startOffset);
        expect(numbered.startLine).to.be.at.least(0);
        expect(numbered.endLine).to.be.at.least(numbered.startLine);
    });

    it('canonical map does NOT carry legacy-only fields (clean separation)', () => {
        const map = sd.buildDeterministicMap(SINGLE_CHAPTER_RU);
        expect(map.segments[0]).to.not.have.property('startLine');
        expect(map.segments[0]).to.not.have.property('length');
    });

    it('documented discrepancies (not silently "fixed")', () => {
        // D1: 'poem' segments collapse into plain 'chapter' rows in the legacy
        // DTO — the legacy type vocabulary has no 'poem'.
        // D2: the head zone (title/author lines) is EXCLUDED from segment
        // coverage — offsets start at the first segment (header line or body
        // fallback), so text.slice(0, first.startOffset) is the head zone.
        const text = EN_CHAPTERS;
        const map = sd.buildDeterministicMap(text);
        expect(map.segments[0].startOffset).to.be.greaterThan(0); // head zone skipped
        expect(text.slice(0, map.segments[0].startOffset)).to.include('The Long Road Home');
    });
});

// ── Language contract ────────────────────────────────────────────────────

describe('C13: LanguageResult contract (detectLanguage)', () => {
    const { detectLanguage, detectLanguageWithConfidence } = require('@animastor/parser/language-detector');

    it('detectLanguage returns an ISO 639-1 string and never throws on degenerate input', () => {
        expect(detectLanguage('Привет, как дела? Как проходит твой день?')).to.equal('ru');
        expect(detectLanguage('Hello there, my friend, how is your day going today?')).to.equal('en');
        for (const degenerate of ['', null, undefined, '   ', '12345 !?*']) {
            expect(detectLanguage(degenerate)).to.equal('en'); // documented fallback
        }
    });

    it('detectLanguageWithConfidence returns a valid LanguageResult or null', () => {
        const ru = detectLanguageWithConfidence('Вот тебе и начало повести. Двадцать пятого числа, в самый разгар летней жары.');
        expect(contracts.validateLanguageResult(ru).ok).to.equal(true);
        expect(contracts.validateLanguageResult(detectLanguageWithConfidence('')).ok).to.equal(true);
        expect(detectLanguageWithConfidence('')).to.equal(null);
    });
});

// ── StructureDetectorPort binding ────────────────────────────────────────

describe('C13: StructureDetectorPort binding (fail-closed, composition root)', () => {
    it('the bound port passes the contract shape check', () => {
        expect(contracts.isValidStructureDetectorPort(parser.getStructureDetector())).to.equal(true);
        expect(contracts.isValidStructureDetectorPort(sd)).to.equal(true);
        expect(contracts.isValidStructureDetectorPort(null)).to.equal(false);
        expect(contracts.isValidStructureDetectorPort({})).to.equal(false);
    });

    it('the real detector output satisfies the canonical contract on all golden texts', () => {
        for (const fixture of GOLDEN.fixtures) {
            const map = sd.buildDeterministicMap(fixture.text);
            const res = contracts.validateParserResult(map, { sourceText: fixture.text });
            expect(res.ok, `${fixture.name}: ${JSON.stringify(res.errors)}`).to.equal(true);
        }
    });

    it('unbound port is fail-closed; rejections keep the frozen message', () => {
        // Fresh module instance: binding state is process-global, so probe an
        // isolated copy and restore the original afterwards.
        // Save ALL @animastor/parser cache entries — setStructureDetector
        // mutates parser.js's module-level state, not just index.js.
        const parserPrefix = require.resolve('@animastor/parser').replace(/\/index\.js$/, '/');
        const savedCache = {};
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(parserPrefix)) {
                savedCache[key] = require.cache[key];
                delete require.cache[key];
            }
        }
        try {
            const fresh = require('@animastor/parser');
            expect(() => fresh.splitIntoChapters('текст')).to.throw(/structureDetector is not bound/);
            expect(() => fresh.setStructureDetector({})).to.throw(/buildDeterministicMap/);
            expect(() => fresh.setStructureDetector(null)).to.throw(/buildDeterministicMap/);
            // The documented alias is accepted by the contract check.
            fresh.setStructureDetector({ buildChapterMap: (t) => ({ hasPrologue: false, hasEpilogue: false, parts: [], segments: [], source: 'detect' }) });
            const chapters = fresh.splitIntoChapters('текст');
            expect(chapters).to.have.lengthOf(1);
            expect(chapters[0]).to.deep.equal({
                title: null, type: 'chapter', label: null, number: null,
                startLine: 0, endLine: 0, startOffset: 0, endOffset: 5, length: 5,
            });
        } finally {
            for (const key of Object.keys(require.cache)) {
                if (key.startsWith(parserPrefix)) delete require.cache[key];
            }
            Object.assign(require.cache, savedCache);
        }
    });

    it('buildChapterMap alias drives splitIntoChapters end-to-end (same offsets contract)', () => {
        const parserPrefix = require.resolve('@animastor/parser').replace(/\/index\.js$/, '/');
        const savedCache = {};
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(parserPrefix)) {
                savedCache[key] = require.cache[key];
                delete require.cache[key];
            }
        }
        try {
            const fresh = require('@animastor/parser');
            const text = 'Глава 1\n\n' + 'x'.repeat(60);
            fresh.setStructureDetector({
                buildChapterMap: (t) => ({
                    title: null, author: null, hasPrologue: false, hasEpilogue: false, parts: [],
                    segments: [{ type: 'chapter', label: 'Глава', title: null, number: 1, headerLine: 'Глава 1', startOffset: 0, endOffset: t.length, source: 'detect' }],
                    source: 'detect',
                }),
            });
            const chapters = fresh.splitIntoChapters(text);
            expect(chapters[0]).to.include({ type: 'chapter', number: 1, startOffset: 0, endOffset: text.length });
        } finally {
            for (const key of Object.keys(require.cache)) {
                if (key.startsWith(parserPrefix)) delete require.cache[key];
            }
            Object.assign(require.cache, savedCache);
        }
    });
});

// ── Golden fixtures ──────────────────────────────────────────────────────

describe('C13: golden fixtures (extraction baseline)', () => {
    it('fixture file declares contractVersion 1 and the documented corpus', () => {
        expect(GOLDEN.contractVersion).to.equal(1);
        expect(GOLDEN.fixtures.map(f => f.name)).to.deep.equal([
            'single-chapter-ru',
            'multiple-chapters-ru',
            'prologue-chapters-epilogue-ru',
            'no-explicit-chapters-ru',
            'russian-titled-body',
            'english-chapters-en',
        ]);
    });

    for (const fixture of GOLDEN.fixtures) {
        it(`${fixture.name}: byte-stable canonical map + valid legacy projection`, () => {
            const live = sd.buildDeterministicMap(fixture.text);
            // Structural equivalence with the recorded golden map.
            expect(JSON.stringify(live)).to.equal(JSON.stringify(fixture.expectedMap));
            // The golden map itself satisfies the canonical contract.
            const res = contracts.validateParserResult(fixture.expectedMap, { sourceText: fixture.text });
            expect(res.ok, JSON.stringify(res.errors)).to.equal(true);
            // Legacy projection matches the live splitIntoChapters output.
            expect(legacyProjection.mapToLegacyChapters(fixture.expectedMap, fixture.text))
                .to.deep.equal(parser.splitIntoChapters(fixture.text));
            // Offsets anchor the exact fixture text instance.
            for (const seg of live.segments) {
                expect(seg.endOffset).to.be.at.most(fixture.text.length);
                expect(seg.startOffset).to.be.at.most(seg.endOffset);
            }
        });
    }
});
