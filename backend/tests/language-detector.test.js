// ======================================================
// Language Detector — programmatic source-language detection
// ======================================================
// Tests for services/language-detector.js (tinyld-based):
//   - detectLanguage(text)  — ISO 639-1 code, 'en' fallback, never 'ru'
//   - detectLanguageWithConfidence(text) — null on empty/low-confidence
//   - extractSample(text)   — strips Gutenberg/Flibusta boilerplate
// Plus wiring into the import pipeline (TXT → detection → book.json):
//   - createDraftBook writes book.language + defaults.language from the source
//   - loadDraftBook backfills empty language once; never overwrites explicit

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    detectLanguage,
    detectLanguageWithConfidence,
    extractSample,
} = require('../src/services/language-detector');
const lazyBook = require('../src/book/lazy-book');
const config = require('../src/config/runtime-config');

const RU_TEXT = 'Вот тебе и начало повести. Двадцать пятого числа, в самый разгар летней жары, на площади перед собором сидел старик и смотрел, как над городом собираются тучи. Он думал о прошлом и о том, что всё в этом мире повторяется: войны, любовь, предательства, надежды. Дождь начался внезапно, и люди разбежались по домам, оставив площадь пустой. Только мокрая брусчатка отражала серое небо, и где-то вдалеке слышался гром.';
const EN_TEXT = 'This is the beginning of the story. On the twenty-fifth of June, in the middle of the summer heat, an old man sat on the square in front of the cathedral and watched the clouds gather over the city. He thought about the past and about how everything in this world repeats itself: wars, love, betrayal, hope. The rain began suddenly, and people scattered to their homes, leaving the square empty. Only the wet cobblestones reflected the gray sky, and thunder could be heard in the distance.';
const UK_TEXT = 'Ось і початок повісті. Двадцять п\'ятого червня, у самісіньку спеку, на площі перед собором сидів старий і дивився, як над містом збираються хмари. Він думав про минуле і про те, що все у цьому світі повторюється: війни, кохання, зради, надії. Дощ почався раптово, і люди розбіглися по домівках, залишивши площу порожньою.';
const BG_TEXT = 'Ето е началото на повестта. На двадесет и пети юни, в разгара на лятната жега, на площада пред катедралата седеше старец и гледаше как над града се събират облаци. Той мислеше за миналото и за това, че всичко на този свят се повтаря: войни, любов, предателство, надежда.';
const DE_TEXT = 'Das ist der Anfang der Geschichte. Am fünfundzwanzigsten Juni, mitten in der Sommerhitze, saß ein alter Mann auf dem Platz vor der Kathedrale und sah zu, wie sich Wolken über der Stadt zusammenballten. Er dachte an die Vergangenheit und daran, dass sich in dieser Welt alles wiederholt: Kriege, Liebe, Verrat, Hoffnung.';

describe('detectLanguage — programmatic source-language detection', () => {

    it('detects Russian', () => {
        expect(detectLanguage(RU_TEXT)).to.equal('ru');
    });

    it('detects English', () => {
        expect(detectLanguage(EN_TEXT)).to.equal('en');
    });

    it('distinguishes Ukrainian from Russian (Cyrillic heuristic could not)', () => {
        expect(detectLanguage(UK_TEXT)).to.equal('uk');
    });

    it('distinguishes Bulgarian from Russian', () => {
        expect(detectLanguage(BG_TEXT)).to.equal('bg');
    });

    it('detects German', () => {
        expect(detectLanguage(DE_TEXT)).to.equal('de');
    });

    it('falls back to en for empty/whitespace text (never ru)', () => {
        expect(detectLanguage('')).to.equal('en');
        expect(detectLanguage(null)).to.equal('en');
        expect(detectLanguage(undefined)).to.equal('en');
        expect(detectLanguage('   \n\t  ')).to.equal('en');
    });

    it('falls back to en for symbol-only text', () => {
        expect(detectLanguage('!!! 123 ... --- ***')).to.equal('en');
    });

    it('detects short texts reliably', () => {
        expect(detectLanguage('Привет, как дела?')).to.equal('ru');
        expect(detectLanguage('Hello, how are you?')).to.equal('en');
    });
});

describe('detectLanguageWithConfidence — low-confidence handling', () => {

    it('returns a code with confidence for a normal text', () => {
        const result = detectLanguageWithConfidence(RU_TEXT);
        expect(result).to.be.an('object');
        expect(result.code).to.equal('ru');
        expect(result.confidence).to.be.a('number');
    });

    it('returns null for empty input', () => {
        expect(detectLanguageWithConfidence('')).to.equal(null);
        expect(detectLanguageWithConfidence(null)).to.equal(null);
    });
});

describe('extractSample — boilerplate cleaning', () => {

    it('strips a Gutenberg-style preamble before the narrative', () => {
        const text = [
            'The Project Gutenberg eBook of Pride and Prejudice',
            '',
            'This eBook is for the use of anyone anywhere in the United States and',
            'most other parts of the world at no cost and with almost no restrictions.',
            '',
            '*** START OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***',
            '',
            'It is a truth universally acknowledged, that a single man in possession',
        ].join('\n');
        const sample = extractSample(text);
        expect(sample.startsWith('It is a truth')).to.equal(true);
        expect(sample).to.not.include('Project Gutenberg');
    });

    it('strips a Flibusta-style preamble', () => {
        const text = [
            'Издано на Флибусте',
            '',
            'Глава первая. В которой всё начинается',
        ].join('\n');
        const sample = extractSample(text);
        expect(sample.startsWith('Глава первая')).to.equal(true);
    });

    it('caps the sample length', () => {
        const long = (RU_TEXT + '\n').repeat(200);
        const sample = extractSample(long);
        expect(sample.length).to.be.at.most(5000);
    });
});

describe('import pipeline wiring — TXT → detection → book.json', () => {

    const ORIG_BOOKS_DIR = config.BOOKS_DIR;
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-detect-test-'));
        config.BOOKS_DIR = tmpDir;
    });

    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    it('createDraftBook writes the detected language into book.json', () => {
        const ru = lazyBook.createDraftBook(RU_TEXT, lazyBook.SourceType.TXT, 'rus.txt');
        const en = lazyBook.createDraftBook(EN_TEXT, lazyBook.SourceType.TXT, 'eng.txt');

        const ruMeta = JSON.parse(fs.readFileSync(lazyBook.getBookMetaPath(lazyBook.getBookDir(ru.bookId)), 'utf8'));
        const enMeta = JSON.parse(fs.readFileSync(lazyBook.getBookMetaPath(lazyBook.getBookDir(en.bookId)), 'utf8'));

        expect(ruMeta.language).to.equal('ru');
        expect(ruMeta.defaults.language).to.equal('ru');
        expect(enMeta.language).to.equal('en');
        expect(enMeta.defaults.language).to.equal('en');
    });

    it('createDraftBook writes en fallback for an empty source (no ru default)', () => {
        const d = lazyBook.createDraftBook('', lazyBook.SourceType.TXT, 'empty.txt');
        const meta = JSON.parse(fs.readFileSync(lazyBook.getBookMetaPath(lazyBook.getBookDir(d.bookId)), 'utf8'));
        expect(meta.language).to.equal('en');
        expect(meta.defaults.language).to.equal('en');
    });

    it('loadDraftBook backfills an empty language once from the source text', () => {
        const d = lazyBook.createDraftBook(EN_TEXT, lazyBook.SourceType.TXT, 'eng.txt');
        // Simulate a legacy book: language never written by the old pipeline.
        const metaPath = lazyBook.getBookMetaPath(lazyBook.getBookDir(d.bookId));
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.language = null;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        const loaded = lazyBook.loadDraftBook(d.bookId);
        expect(loaded.book.language).to.equal('en');

        const persisted = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        expect(persisted.language).to.equal('en');
        expect(persisted.defaults.language).to.equal('en');
    });

    it('never overwrites an explicitly set language', () => {
        const d = lazyBook.createDraftBook(RU_TEXT, lazyBook.SourceType.TXT, 'rus.txt');
        // User (or metadata PATCH) explicitly set the language to German —
        // detection must NOT overwrite it even though the source is Russian.
        const metaPath = lazyBook.getBookMetaPath(lazyBook.getBookDir(d.bookId));
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.language = 'de';
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        const loaded = lazyBook.loadDraftBook(d.bookId);
        expect(loaded.book.language).to.equal('de');
    });
});
