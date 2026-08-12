// ======================================================
// Кирпич №2 — Persistent Layer Configuration
// ======================================================
// Проверяет durability layer-config в book.json:
//   1. set() дублирует конфиг в book.json (durable-копия)
//   2. restoreFromBooks() восстанавливает Redis-ключи из book.json
//      после полной потери Redis (только отсутствующие ключи)
//   3. saveBookBundle() не затирает layer_config при перезаписи book.json
//   4. legacy single-file формат (<bookId>.json) тоже поддерживается

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const layerConfig = require('../src/services/layer-config');
const config = require('../src/config/runtime-config');
const book = require('../src/book');

describe('Layer Config Persistence (Кирпич №2)', () => {
    let tmpDir;
    let savedBooksDir;

    const fakeRedis = {
        _store: {},
        async get(k) {
            return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null;
        },
        async set(k, v) { this._store[k] = v; return 'OK'; },
    };

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-lc-'));
        savedBooksDir = config.BOOKS_DIR;
        config.BOOKS_DIR = tmpDir;
        fakeRedis._store = {};
    });

    afterEach(() => {
        config.BOOKS_DIR = savedBooksDir;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeBookDir(bookId, meta) {
        const bookDir = path.join(tmpDir, bookId);
        fs.mkdirSync(bookDir, { recursive: true });
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify(meta));
        return bookDir;
    }

    // ── 1. set() → durable copy in book.json ──
    it('set() persists the config into book.json', async () => {
        const bookId = 'lc-book-1';
        writeBookDir(bookId, { structure: { chapters_order: [] } });

        await layerConfig.set(fakeRedis, bookId, { image_enabled: false, chunk_size: 5 });

        const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, bookId, 'book.json'), 'utf8'));
        expect(meta.layer_config).to.be.an('object');
        expect(meta.layer_config.image_enabled).to.be.false;
        expect(meta.layer_config.audio_enabled).to.be.true;
        expect(meta.layer_config.chunk_size).to.equal(5);
        expect(meta.layer_config.updated_at).to.be.a('number');
    });

    it('set() merges partial updates into the durable copy', async () => {
        const bookId = 'lc-book-2';
        writeBookDir(bookId, { structure: { chapters_order: [] } });

        await layerConfig.set(fakeRedis, bookId, { image_enabled: false });
        await layerConfig.set(fakeRedis, bookId, { video_enabled: false });

        const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, bookId, 'book.json'), 'utf8'));
        expect(meta.layer_config.image_enabled).to.be.false;
        expect(meta.layer_config.video_enabled).to.be.false;
        expect(meta.layer_config.audio_enabled).to.be.true;
    });

    it('set() skips persistence when the book is not on disk yet (no crash, Redis still set)', async () => {
        const bookId = 'lc-ghost';
        const cfg = await layerConfig.set(fakeRedis, bookId, { image_enabled: false });

        expect(cfg.image_enabled).to.be.false;
        expect(JSON.parse(fakeRedis._store[layerConfig.key(bookId)]).image_enabled).to.be.false;
        // No book.json on disk, no exception — best-effort skip
        expect(fs.existsSync(path.join(tmpDir, bookId))).to.be.false;
    });

    // ── 2. restoreFromBooks() — cold Redis recovery ──
    it('restoreFromBooks() fills missing Redis keys from book.json', async () => {
        const bookId = 'lc-restore-1';
        writeBookDir(bookId, {
            structure: { chapters_order: [] },
            layer_config: { image_enabled: false, video_enabled: false, chunk_size: 5 },
        });

        const count = await layerConfig.restoreFromBooks(fakeRedis);
        expect(count).to.equal(1);

        const restored = JSON.parse(fakeRedis._store[layerConfig.key(bookId)]);
        expect(restored.image_enabled).to.be.false;
        expect(restored.video_enabled).to.be.false;
        expect(restored.audio_enabled).to.be.true; // default filled by normalize
        expect(restored.chunk_size).to.equal(5);
    });

    it('restoreFromBooks() never overwrites live Redis state', async () => {
        const bookId = 'lc-restore-2';
        writeBookDir(bookId, {
            structure: { chapters_order: [] },
            layer_config: { image_enabled: false },
        });
        // Live Redis state (newer than durable copy)
        fakeRedis._store[layerConfig.key(bookId)] = JSON.stringify({ image_enabled: true });

        const count = await layerConfig.restoreFromBooks(fakeRedis);
        expect(count).to.equal(0);
        expect(JSON.parse(fakeRedis._store[layerConfig.key(bookId)]).image_enabled).to.be.true;
    });

    it('restoreFromBooks() supports legacy single-file books (<bookId>.json)', async () => {
        fs.writeFileSync(
            path.join(tmpDir, 'lc-legacy-1.json'),
            JSON.stringify({ structure: {}, layer_config: { audio_enabled: false } })
        );

        const count = await layerConfig.restoreFromBooks(fakeRedis);
        expect(count).to.equal(1);

        const restored = JSON.parse(fakeRedis._store[layerConfig.key('lc-legacy-1')]);
        expect(restored.audio_enabled).to.be.false;
        expect(restored.image_enabled).to.be.true;
    });

    it('restoreFromBooks() skips entries without a durable layer_config', async () => {
        writeBookDir('no-config-book', { structure: { chapters_order: [] } });
        fs.mkdirSync(path.join(tmpDir, 'not-a-book'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'hello');

        const count = await layerConfig.restoreFromBooks(fakeRedis);
        expect(count).to.equal(0);
    });

    // ── 3. persistToBook() legacy single-file ──
    it('persistToBook() writes the legacy single-file format too', () => {
        fs.writeFileSync(path.join(tmpDir, 'lc-legacy-2.json'), JSON.stringify({ structure: {} }));

        const ok = layerConfig.persistToBook('lc-legacy-2', { image_enabled: false });
        expect(ok).to.be.true;

        const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, 'lc-legacy-2.json'), 'utf8'));
        expect(meta.layer_config.image_enabled).to.be.false;
    });

    // ── 4. saveBookBundle() preserves the durable copy ──
    it('saveBookBundle() does not wipe layer_config when rewriting book.json', () => {
        const bookId = 'lc-preserve-1';
        const bookDir = writeBookDir(bookId, {
            structure: { chapters_order: [] },
            layer_config: { image_enabled: false },
        });
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({ book_id: bookId, build_id: 'b1' }));
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });

        // Editor rewrite: book object WITHOUT layer_config (e.g. cached before PUT)
        book.saveBookBundle(
            { manifest: { book_id: bookId }, book: { structure: { chapters_order: [] } }, chapters: [] },
            null
        );

        const meta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(meta.layer_config).to.be.an('object');
        expect(meta.layer_config.image_enabled).to.be.false;
    });

    it('saveBookBundle() raw-files re-import preserves the durable layer_config', () => {
        const bookId = 'lc-reimport-1';
        const bookDir = writeBookDir(bookId, {
            structure: { chapters_order: [] },
            layer_config: { video_enabled: false },
        });
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({ book_id: bookId, build_id: 'b1' }));

        // Re-import bundle whose book.json has NO layer_config (export made
        // before Кирпич №2) — the durable copy must survive the raw-file write.
        book.saveBookBundle(
            { manifest: { book_id: bookId }, book: { structure: { chapters_order: [] } }, chapters: [] },
            {
                'manifest.json': JSON.stringify({ book_id: bookId }),
                'book.json': JSON.stringify({ structure: { chapters_order: [] } }),
            }
        );

        const meta = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
        expect(meta.layer_config).to.be.an('object');
        expect(meta.layer_config.video_enabled).to.be.false;
    });
});
