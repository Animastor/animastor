// Regression test — GET /api/v1/scene/:bookId/:chapterId/:sceneId/audio must
// answer Range requests with 206 Partial Content. Without it the browser <audio>
// engine cannot seek (audio.currentTime = X), so the Edit-page waveform range
// playback silently restarted from position 0 (Android's MediaPlayer buffers the
// whole file and seeks internally, so it never hit this).
const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const AUDIO_ROUTE = '/api/v1/scene/:bookId/:chapterId/:sceneId/audio';
const MODULE = '../src/routes/generation-routes.cjs';

function makeResponse() {
    const chunks = [];
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    res.body = null;
    res.ended = false;
    res.status = function (code) { this.statusCode = code; return this; };
    // Express res.setHeader returns `this` (chainable) — the handler relies on it.
    res.setHeader = function (name, value) { this.headers[name.toLowerCase()] = String(value); return this; };
    res.getHeader = function (name) { return this.headers[name.toLowerCase()]; };
    res.write = function (chunk) { chunks.push(Buffer.from(chunk)); return true; };
    res.end = function () { res.ended = true; };
    res.json = function (obj) { this.body = obj; res.ended = true; };
    Object.defineProperty(res, 'data', { get: () => Buffer.concat(chunks) });
    return res;
}

function stubDeps(tmpDir) {
    const noop = () => {};
    return {
        config: { OUTPUT_DIR: tmpDir },
        state: {}, audio: {}, image: {}, video: {},
        book: { loadBook: () => ({ manifest: { build_id: 'b1' } }) },
        playerModel: { loadBook: () => ({ manifest: { build_id: 'b1' } }) }, // Phase 6 Player boundary fake
        orchestrator: {}, storage: {}, runtime: {}, activeScenes: {},
        layerConfig: {}, genScope: {}, placeholderAudio: {},
        utils: { log: noop },
        saveChunk: noop, getChunk: async () => null, getAllChunks: async () => [],
        getBookWindowStatus: noop, detectAvailableMode: noop,
        recoverChunksFromDisk: noop, recoverAllBooksFromDisk: noop,
        cleanupService: {}, iuRepo: {}, computeWaveform: noop,
    };
}

describe('Scene audio HTTP Range support (Edit waveform seek)', () => {
    const MODULE_RESOLVED = require.resolve(MODULE);
    const originalCacheEntry = require.cache[MODULE_RESOLVED];
    let tmpDir;
    let audioHandler;
    let audioPath;

    // Restore the pre-test module cache entry so other test files in the same
    // mocha process see the pristine module (matches repo save/restore pattern).
    after(() => {
        if (originalCacheEntry) require.cache[MODULE_RESOLVED] = originalCacheEntry;
        else delete require.cache[MODULE_RESOLVED];
    });

    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-range-'));
        audioPath = path.join(tmpDir, 'b1', 'book1_ch1_sc1.mp3');
        fs.mkdirSync(path.dirname(audioPath), { recursive: true });
        // 1000 bytes of identifiable data: byte i = i % 256 (contiguous, checkable).
        fs.writeFileSync(audioPath, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
    });

    after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    beforeEach(() => {
        // Fresh module instance so deps (OUTPUT_DIR) are taken from the stub.
        const resolved = require.resolve(MODULE);
        delete require.cache[resolved];
        const registered = [];
        const app = {
            get: (p, h) => registered.push({ method: 'get', p, h }),
            post: (p, h) => registered.push({ method: 'post', p, h }),
            put: () => {}, delete: () => {},
        };
        require(MODULE)(app, {}, stubDeps(tmpDir));
        const route = registered.find((r) => r.p === AUDIO_ROUTE);
        if (!route) throw new Error(`audio route not registered: ${AUDIO_ROUTE}`);
        audioHandler = route.h;
    });

    function hit(rangeHeader) {
        return hitHeaders(rangeHeader ? { range: rangeHeader } : {});
    }

    function hitHeaders(headers) {
        const req = {
            params: { bookId: 'book1', chapterId: 'ch1', sceneId: 'sc1' },
            query: { build_id: 'stale-build' },
            headers,
        };
        const res = makeResponse();
        const done = audioHandler(req, res).then(() => {
            // The read stream pipes asynchronously; wait for res.end().
            return new Promise((resolve) => {
                const check = () => (res.ended ? resolve(res) : setTimeout(check, 5));
                check();
            });
        });
        return done;
    }

    it('serves the full file with 200 when no Range header is sent', async () => {
        const res = await hit(null);
        expect(res.statusCode).to.equal(200);
        expect(res.getHeader('accept-ranges')).to.equal('bytes');
        expect(Number(res.getHeader('content-length'))).to.equal(1000);
        expect(res.data.length).to.equal(1000);
    });

    it('answers a byte range with 206 Partial Content (bytes=0-99)', async () => {
        const res = await hit('bytes=0-99');
        expect(res.statusCode).to.equal(206);
        expect(res.getHeader('content-range')).to.equal('bytes 0-99/1000');
        expect(res.data.length).to.equal(100);
        expect(res.data[0]).to.equal(0);
        expect(res.data[99]).to.equal(99);
    });

    it('answers an open-ended range (bytes=500-)', async () => {
        const res = await hit('bytes=500-');
        expect(res.statusCode).to.equal(206);
        expect(res.getHeader('content-range')).to.equal('bytes 500-999/1000');
        expect(res.data.length).to.equal(500);
        expect(res.data[0]).to.equal(500 % 256);
        expect(res.data[499]).to.equal(999 % 256);
    });

    it('answers a suffix range (bytes=-200 → last 200 bytes)', async () => {
        const res = await hit('bytes=-200');
        expect(res.statusCode).to.equal(206);
        expect(res.getHeader('content-range')).to.equal('bytes 800-999/1000');
        expect(res.data.length).to.equal(200);
        expect(res.data[0]).to.equal(800 % 256);
    });

    it('rejects an out-of-range start with 416 and Content-Range */size', async () => {
        const res = await hit('bytes=999999-');
        expect(res.statusCode).to.equal(416);
        expect(res.getHeader('content-range')).to.equal('bytes */1000');
    });

    it('rejects a malformed Range header with 416', async () => {
        const res = await hit('bytes=abc');
        expect(res.statusCode).to.equal(416);
        expect(res.getHeader('content-range')).to.equal('bytes */1000');
    });

    it('advertises cache validators (ETag/Last-Modified/Cache-Control)', async () => {
        const res = await hit(null);
        expect(res.statusCode).to.equal(200);
        expect(res.getHeader('etag')).to.be.a('string').and.not.equal('');
        expect(res.getHeader('last-modified')).to.be.a('string').and.not.equal('');
        expect(res.getHeader('cache-control')).to.equal('public, max-age=0, must-revalidate');
    });

    it('answers a conditional GET with 304 when the ETag matches', async () => {
        const first = await hit(null);
        const etag = first.getHeader('etag');
        const res = await hitHeaders({ 'if-none-match': etag });
        expect(res.statusCode).to.equal(304);
        expect(res.data.length).to.equal(0);
    });

    it('serves a fresh 200 when the ETag does not match', async () => {
        const res = await hitHeaders({ 'if-none-match': '"deadbeef-0"' });
        expect(res.statusCode).to.equal(200);
        expect(res.data.length).to.equal(1000);
    });

    it('serves 206 for a Range when If-Range matches the ETag (resume cached ranges)', async () => {
        const first = await hit(null);
        const etag = first.getHeader('etag');
        const res = await hitHeaders({ range: 'bytes=500-599', 'if-range': etag });
        expect(res.statusCode).to.equal(206);
        expect(res.getHeader('content-range')).to.equal('bytes 500-599/1000');
        expect(res.data.length).to.equal(100);
    });

    it('ignores the Range and serves full 200 when If-Range mismatches (regenerated file)', async () => {
        const res = await hitHeaders({ range: 'bytes=500-599', 'if-range': '"deadbeef-0"' });
        expect(res.statusCode).to.equal(200);
        expect(res.data.length).to.equal(1000);
    });
});
