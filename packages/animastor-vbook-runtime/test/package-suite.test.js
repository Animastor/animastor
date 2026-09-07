// ======================================================
// @animastor/vbook-runtime — package-owned standalone suite (audit E1/E2)
// ======================================================
// Runs with plain `npm test` inside the package: no host, no PG/Redis, no
// env. booksRoot is bound to a temp dir via the package port (fail-closed
// semantics covered explicitly); the structureDetector port gets a stub
// ChapterMap (Parser ≠ VBook — the real detector is host doctrine).
// Docs: docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md §5/§8 (E1/E2),
//       docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md §2.9.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vbook = require('../src/index');
const validator = require('../src/bundle-validator.cjs');
const bookModel = require('../src/book-model.cjs');
const lazyBook = require('../src/lazy-book');
const parser = require('../src/lazy-book/parser');
const { configureBooksRoot, getBooksRoot, createBooksRootPort } = require('../src/books-root');
const { detectLanguage } = require('../src/language-detector');
const { sanitizeParticipants } = require('../src/snake-guard');
const { isPlaceholderCharacter } = require('../src/character-identity');
const { extractSceneTitle, isGenericSceneTitle } = require('../src/scene-title-utils');
const { BookModelError } = require('../src/book-model.cjs');

// ── Port bindings (package-level, before any book operation) ─────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vbook-pkg-suite-'));
configureBooksRoot(tmpRoot);

const STUB_TEXT = [
    'За пределами алгоритмов. С.А. Хабаров.',
    '',
    'Пролог. Мир на переломе эпох',
    '',
    'x'.repeat(60),
    '',
    'Глава 1. Земля',
    '',
    'y'.repeat(60),
    '',
    'Глава 2. Первый полёт',
    '',
    'z'.repeat(60),
].join('\n');

function stubMap(text) {
    // Minimal ChapterMap over the stub text (port contract, checklist §2.6).
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
                headerLine: i,
                startOffset: offset,
                endOffset: offset + line.length,
                source: line,
            });
        }
        offset += line.length + 1;
    }
    // Extend each segment to the start of the next one (body coverage).
    for (let i = 0; i < segments.length; i++) {
        segments[i].endOffset = i + 1 < segments.length ? segments[i + 1].startOffset : text.length;
        segments[i].source = text.slice(segments[i].startOffset, segments[i].endOffset);
    }
    return {
        title: { text: 'За пределами алгоритмов', candidate_id: null, confidence: 0.7 },
        author: { text: 'С.А. Хабаров', candidate_id: null, confidence: 0.7 },
        hasPrologue: true,
        hasEpilogue: false,
        parts: [],
        segments,
    };
}

parser.setStructureDetector({ buildDeterministicMap: stubMap });

// ── BooksRoot port ───────────────────────────────────────────────────────
describe('booksRoot port (fail-closed, injection-only)', () => {
    it('is bound for this suite and resolves the temp root', () => {
        expect(getBooksRoot()).to.equal(tmpRoot);
    });

    it('an isolated port instance throws until configured', () => {
        const port = createBooksRootPort();
        expect(() => port.get()).to.throw(/not configured/);
        port.configure(tmpRoot);
        expect(port.get()).to.equal(tmpRoot);
    });

    it('layout getters derive from the bound root', () => {
        const dir = lazyBook.getBookDir('layout-probe');
        expect(dir).to.equal(path.join(tmpRoot, 'layout-probe'));
        expect(lazyBook.getBookMetaPath(dir)).to.equal(path.join(dir, 'book.json'));
        expect(lazyBook.getChapterDir(dir)).to.equal(path.join(dir, 'chapters'));
    });
});

// ── Id grammar ───────────────────────────────────────────────────────────
describe('canonical id grammar', () => {
    it('chapter/scene/unit ids match the ^ch|^sc|^iu-[a-f0-9]{6,}$ grammar', () => {
        expect(lazyBook.chapterId()).to.match(/^ch-[a-f0-9]{6,}$/);
        expect(lazyBook.sceneId()).to.match(/^sc-[a-f0-9]{6,}$/);
        expect(lazyBook.unitId()).to.match(/^iu-[a-f0-9]{6,}$/);
        expect(lazyBook.generateBookId()).to.be.a('string');
    });
});

// ── Draft lifecycle + bundle round-trip (audit E2 smoke) ─────────────────
describe('draft lifecycle → bundle round-trip (standalone boot smoke)', () => {
    let bookId;

    it('createDraftBook writes manifest + book.json with detected language', () => {
        const draft = lazyBook.createDraftBook(STUB_TEXT, lazyBook.SourceType.TXT, 'probe.txt');
        bookId = draft.bookId;
        expect(draft.manifest.vbook_version).to.equal('3.1');
        expect(draft.manifest.state).to.equal(lazyBook.BookState.RAW_IMPORTED);
        const meta = JSON.parse(fs.readFileSync(lazyBook.getBookMetaPath(lazyBook.getBookDir(bookId)), 'utf8'));
        expect(meta.language).to.be.a('string').with.lengthOf(2);
        expect(meta.defaults.language).to.equal(meta.language);
    });

    it('splitIntoChapters drives chapters from the injected stub detector', () => {
        const chapters = parser.splitIntoChapters(STUB_TEXT);
        expect(chapters.length).to.equal(3);
        expect(chapters[0].type).to.equal('prologue');
        expect(chapters[1].number).to.equal(1);
        expect(chapters[chapters.length - 1].endOffset).to.equal(STUB_TEXT.length);
    });

    it('lazyParseNextWindow materializes a draft window', function () {
            this.timeout(5000);
            this.retries(0);
        const win = lazyBook.lazyParseNextWindow(bookId, { maxScenes: 2 });
        expect(win).to.exist;
    });

    it('updateBookState persists the state machine', () => {
        lazyBook.updateBookState(bookId, lazyBook.BookState.BOOTSTRAPPED);
        const loaded = lazyBook.loadDraftBook(bookId);
        expect(loaded.manifest.state).to.equal(lazyBook.BookState.BOOTSTRAPPED);
    });

    it('buildBookFromBundle rebuilds a book from raw bundle files (validator-backed)', () => {
        const dir = lazyBook.getBookDir(bookId);
        const book = vbook.loadBook(bookId);
        // Give the bundle one canonical chapter so buildBookFromBundle has content.
        const chapter = {
            chapter_id: 'ch-aaa001',
            title: 'Глава 1',
            scenes: [{ scene_id: 'sc-aaa001', participants: [], units: [] }],
        };
        vbook.saveBookBundle({ ...book, chapters: [chapter] }, null);
        const files = {};
        for (const f of ['manifest.json', 'book.json', 'bible.json', 'locations.json', 'voices.json', 'behavior.json', 'chapters/ch-aaa001.json']) {
            const p = path.join(dir, f);
            if (fs.existsSync(p)) files[f] = fs.readFileSync(p);
        }
        const rebuilt = vbook.buildBookFromBundle(files);
        expect(rebuilt.book.book_id).to.equal(bookId);
        expect(rebuilt.manifest.book_id).to.equal(bookId);
        expect(rebuilt.chapters).to.have.lengthOf(1);
    });

    it('resetBook removes the bundle', () => {
        vbook.resetBook(bookId);
        expect(fs.existsSync(lazyBook.getBookDir(bookId))).to.equal(false);
    });
});

// ── Book Model facade ────────────────────────────────────────────────────
describe('Book Model facade (C2 internal-v1)', () => {
    let bookId;

    before(() => {
        bookId = lazyBook.createDraftBook(STUB_TEXT, lazyBook.SourceType.TXT, 'model.txt').bookId;
    });

    after(() => {
        vbook.resetBook(bookId);
    });

    it('loadBook(lazy) resolves the draft state for an in-progress book', () => {
        const d = bookModel.loadBook(bookId, { mode: bookModel.MODE_LAZY });
        expect(d.manifest.book_id).to.equal(bookId); // canonical bundle view of an in-progress book
        expect(d.book.book_id).to.equal(bookId);
    });

    it('getBookIdentity resolves null (not throw) for an unknown book', () => {
        expect(bookModel.getBookIdentity('no-such-book')).to.equal(null);
    });

    it('loadBook rejects invalid ids and modes', () => {
        expect(() => bookModel.loadBook('')).to.throw(BookModelError);
        expect(() => bookModel.loadBook('x', { mode: 'nope' })).to.throw(BookModelError);
    });
});

// ── Validator (C1 enforcement) ───────────────────────────────────────────
describe('bundle-validator (C1 guard)', () => {
    it('validates a canonical bundle object (no errors) and rejects a broken manifest', () => {
        const good = {
            manifest: { book_id: 'roundtrip-ok', vbook_version: '3.1' },
            book: { book_id: 'roundtrip-ok', structure: { chapters_order: [] } },
            characters: [],
            locations: {},
            voices: {},
            behaviors: {},
            chapters: [],
        };
        const verdict = validator.validateBundleObject(good);
        expect(verdict.valid, verdict.errors.join('; ')).to.equal(true);
        const bad = { ...good, manifest: {} };
        expect(validator.validateBundleObject(bad).valid).to.equal(false);
    });

    it('validateBundleFile rejects a broken voices resource', () => {
        const verdict = validator.validateBundleFile('voices.json', { narrator: 'not-an-object' });
        expect(verdict.valid).to.equal(false);
    });
});

// ── Doctrine companions ──────────────────────────────────────────────────
describe('extraction companions', () => {
    it('language-detector detects Russian and falls back to en', () => {
        expect(detectLanguage('Вот тебе и начало повести. Двадцать пятого числа, в самый разгар летней жары.')).to.equal('ru');
        expect(detectLanguage('')).to.equal('en');
    });

    it('snake-guard sanitizes participants (registry write barrier)', () => {
        const out = sanitizeParticipants(['alice', 'placeholder_1', ''], ['alice'], { onDrop: null });
        expect(out).to.deep.equal(['alice']);
    });

    it('character-identity flags placeholder characters without real appearance', () => {
        expect(isPlaceholderCharacter(null)).to.equal(true);
        expect(isPlaceholderCharacter({ id: 'hero', name: 'Hero' })).to.equal(false);
    });

    it('scene-title-utils classifies generic titles', () => {
        expect(isGenericSceneTitle('Глава 1')).to.equal(true);
        expect(isGenericSceneTitle('Побег из крепости')).to.equal(false);
        expect(extractSceneTitle('Глава 3. Побег из крепости')).to.be.a('string');
    });
});
