// Regression test — scene timing persistence (Edit page waveform handles).
//
// Bug: dragging a Waveform range handle and releasing saved the new timings via
// PUT /timings, but the next GET /timings recomputed ALL units from text
// proportions and returned the pre-edit values — the handles snapped back on
// navigation (Android + mobile web share this backend endpoint).
//
// Root cause: the first unit of every scene has start_ms = 0, but the GET route
// mapped `0` to null ("missing"). needsCompute then evaluated true on every
// request, and the recompute-all path (5a401fb) discarded the saved values.
const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const GET_ROUTE = '/api/v1/scene/:bookId/:chapterId/:sceneId/timings';
const MODULE = '../src/routes/generation-routes.cjs';

// In-memory image_units store: unit_id → row (mirrors the PG table columns the
// timings routes read/write).
function makeIuRepo(initialRows) {
    const rows = new Map();
    for (const r of initialRows || []) rows.set(r.unit_id, { ...r });
    const upsertCalls = [];
    return {
        upsertCalls,
        async getImageUnitsForScene() {
            return [...rows.values()];
        },
        async upsertIuTiming(buildId, bookId, chapterId, sceneId, unitId, startMs, endMs) {
            upsertCalls.push({ unitId, startMs, endMs });
            const existing = rows.get(unitId) || { unit_id: unitId, scene_order: rows.size, text: '', text_length: 0, text_proportion: 0, estimated_duration_sec: 0, scene_duration_sec: 0 };
            rows.set(unitId, { ...existing, start_ms: startMs, end_ms: endMs });
            return rows.get(unitId);
        },
    };
}

function stubDeps(tmpDir, iuRepo) {
    const noop = () => {};
    return {
        config: { OUTPUT_DIR: tmpDir },
        state: {}, audio: {}, video: {},
        image: { getSceneDuration: async () => 30 }, // 30s scene audio
        book: { loadBook: () => null },              // no book JSON → getEffectiveBuildId falls back to requested
        playerModel: { loadBook: () => null },       // Phase 6: Player boundary fake (same source as book)
        orchestrator: {}, storage: {}, runtime: {}, activeScenes: {},
        layerConfig: {}, genScope: {}, placeholderAudio: {},
        utils: { log: noop },
        saveChunk: noop, getChunk: async () => null, getAllChunks: async () => [],
        getBookWindowStatus: noop, detectAvailableMode: noop,
        recoverChunksFromDisk: noop, recoverAllBooksFromDisk: noop,
        cleanupService: {}, iuRepo, computeWaveform: noop,
    };
}

function makeResponse() {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    res.body = null;
    res.status = function (code) { this.statusCode = code; return this; };
    res.setHeader = function (name, value) { this.headers[name.toLowerCase()] = String(value); return this; };
    res.getHeader = function (name) { return this.headers[name.toLowerCase()]; };
    res.write = function () { return true; };
    res.end = function () { res.ended = true; };
    res.json = function (obj) { this.body = obj; res.ended = true; };
    return res;
}

// Three units with equal text (equal proportions) on a 30s scene.
const UNITS = [
    { unit_id: 'u0', scene_order: 0, text: 'aaaa', text_length: 4, text_proportion: 1 / 3, estimated_duration_sec: 10, scene_duration_sec: 30, start_ms: 0, end_ms: 8000 },
    { unit_id: 'u1', scene_order: 1, text: 'bbbb', text_length: 4, text_proportion: 1 / 3, estimated_duration_sec: 10, scene_duration_sec: 30, start_ms: 8000, end_ms: 16000 },
    { unit_id: 'u2', scene_order: 2, text: 'cccc', text_length: 4, text_proportion: 1 / 3, estimated_duration_sec: 10, scene_duration_sec: 30, start_ms: 16000, end_ms: 30000 },
];

describe('Scene timings persistence (Edit waveform handles)', () => {
    const MODULE_RESOLVED = require.resolve(MODULE);
    const originalCacheEntry = require.cache[MODULE_RESOLVED];
    let tmpDir;
    let handlers; // { getTimings, putTimings }
    let iuRepo;

    after(() => {
        if (originalCacheEntry) require.cache[MODULE_RESOLVED] = originalCacheEntry;
        else delete require.cache[MODULE_RESOLVED];
    });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-timings-'));
        iuRepo = makeIuRepo(UNITS);
        delete require.cache[MODULE_RESOLVED];
        const registered = [];
        const app = {
            get: (p, h) => registered.push({ method: 'get', p, h }),
            post: (p, h) => registered.push({ method: 'post', p, h }),
            put: (p, h) => registered.push({ method: 'put', p, h }),
            delete: () => {},
        };
        require(MODULE)(app, {}, stubDeps(tmpDir, iuRepo));
        const get = registered.find((r) => r.method === 'get' && r.p === GET_ROUTE);
        const put = registered.find((r) => r.method === 'put' && r.p === GET_ROUTE);
        if (!get || !put) throw new Error('timings routes not registered');
        handlers = { getTimings: get.h, putTimings: put.h };
    });

    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    function hit(handler, body) {
        const req = {
            params: { bookId: 'book1', chapterId: 'ch1', sceneId: 'sc1' },
            query: { build_id: 'b1' },
            headers: {},
            body,
        };
        const res = makeResponse();
        return Promise.resolve(handler(req, res)).then(() => res);
    }

    it('PUT then GET round-trip preserves the saved timings (start_ms=0 is valid)', async () => {
        // User drags u0's end handle back and u1's start with it (cascade).
        const put = await hit(handlers.putTimings, {
            build_id: 'b1',
            units: [
                { unit_id: 'u0', start_ms: 0, end_ms: 6000 },
                { unit_id: 'u1', start_ms: 6000, end_ms: 12000 },
                { unit_id: 'u2', start_ms: 12000, end_ms: 30000 },
            ],
        });
        expect(put.statusCode).to.equal(200);
        expect(put.body.recalculated).to.equal(true);

        // Re-open the editor: GET must return exactly what was saved.
        const get = await hit(handlers.getTimings);
        expect(get.statusCode).to.equal(200);
        expect(get.body.units.map((u) => [u.unit_id, u.start_ms, u.end_ms])).to.deep.equal([
            ['u0', 0, 6000],
            ['u1', 6000, 12000],
            ['u2', 12000, 30000],
        ]);
        // A pure reload must not rewrite rows (no recompute persist).
        expect(iuRepo.upsertCalls).to.have.length(3); // only the PUT writes
    });

    it('GET recomputes from text proportions only when rows are truly untimed (0/0)', async () => {
        // Scene without any audio-pipeline timings yet.
        iuRepo = makeIuRepo([
            { unit_id: 'u0', scene_order: 0, text: 'a', text_length: 1, text_proportion: 0.25, estimated_duration_sec: 0, scene_duration_sec: 0, start_ms: 0, end_ms: 0 },
            { unit_id: 'u1', scene_order: 1, text: 'b', text_length: 1, text_proportion: 0.25, estimated_duration_sec: 0, scene_duration_sec: 0, start_ms: 0, end_ms: 0 },
            { unit_id: 'u2', scene_order: 2, text: 'cc', text_length: 2, text_proportion: 0.5, estimated_duration_sec: 0, scene_duration_sec: 0, start_ms: 0, end_ms: 0 },
        ]);
        delete require.cache[MODULE_RESOLVED];
        const registered = [];
        const app = {
            get: (p, h) => registered.push({ method: 'get', p, h }),
            post: (p, h) => registered.push({ method: 'post', p, h }),
            put: (p, h) => registered.push({ method: 'put', p, h }),
            delete: () => {},
        };
        require(MODULE)(app, {}, stubDeps(tmpDir, iuRepo));
        const get = registered.find((r) => r.method === 'get' && r.p === GET_ROUTE);
        handlers = { getTimings: get.h };

        const res = await hit(handlers.getTimings);
        expect(res.statusCode).to.equal(200);
        expect(res.body.units.map((u) => [u.unit_id, u.start_ms, u.end_ms])).to.deep.equal([
            ['u0', 0, 7500],
            ['u1', 7500, 15000],
            ['u2', 15000, 30000],
        ]);
        expect(iuRepo.upsertCalls.length).to.be.greaterThan(0); // persisted
    });

    it('PUT clamps a handle dragged to the very end so the interval stays valid', async () => {
        // User drags u2's START handle (shared boundary) to the end of the 30s
        // audio (30000ms); the client cascades u1's end to follow the boundary.
        const put = await hit(handlers.putTimings, {
            build_id: 'b1',
            units: [
                { unit_id: 'u0', start_ms: 0, end_ms: 8000 },
                { unit_id: 'u1', start_ms: 8000, end_ms: 30000 },
                { unit_id: 'u2', start_ms: 30000, end_ms: 30000 },
            ],
        });
        expect(put.statusCode).to.equal(200);
        const u2 = put.body.units.find((u) => u.unit_id === 'u2');
        expect(u2.end_ms - u2.start_ms).to.be.at.least(50);

        // The saved rows must still be returned as-is on the next GET (no wipe).
        const get = await hit(handlers.getTimings);
        expect(get.body.units.find((u) => u.unit_id === 'u2').end_ms).to.equal(30000);
        expect(get.body.units.find((u) => u.unit_id === 'u2').start_ms)
            .to.be.lessThan(get.body.units.find((u) => u.unit_id === 'u2').end_ms);
    });

    it('PUT heals a gap: next unit start pulled back to the shared boundary', async () => {
        // User drags u1's RIGHT handle (shared boundary) from 15000 back to 12000,
        // but the client did NOT cascade — u2's start is stale at 15000. The server
        // must close the gap so u2's left handle tracks the dragged boundary.
        // (This mirrors the real DB case: end 31278 / next start 31549.)
        const put = await hit(handlers.putTimings, {
            build_id: 'b1',
            units: [
                { unit_id: 'u0', start_ms: 0, end_ms: 10000 },
                { unit_id: 'u1', start_ms: 10000, end_ms: 12000 },
                { unit_id: 'u2', start_ms: 15000, end_ms: 30000 },
            ],
        });
        expect(put.statusCode).to.equal(200);
        const u2 = put.body.units.find((u) => u.unit_id === 'u2');
        expect(u2.start_ms).to.equal(12000); // gap closed
        expect(u2.end_ms).to.equal(30000);

        // Stored rows stay gapless on reload.
        const get = await hit(handlers.getTimings);
        expect(get.body.units.map((u) => [u.unit_id, u.start_ms, u.end_ms])).to.deep.equal([
            ['u0', 0, 10000],
            ['u1', 10000, 12000],
            ['u2', 12000, 30000],
        ]);
    });

    it('PUT keeps a lead-in gap before the first unit (the only allowed gap)', async () => {
        // Unit 0's left edge sits after 0 (lead-in silence); the pull-back must
        // not snap it back to 0, and unit 1 must start at unit 0's end.
        const put = await hit(handlers.putTimings, {
            build_id: 'b1',
            units: [
                { unit_id: 'u0', start_ms: 1000, end_ms: 8000 },
                { unit_id: 'u1', start_ms: 8000, end_ms: 16000 },
                { unit_id: 'u2', start_ms: 16000, end_ms: 30000 },
            ],
        });
        expect(put.statusCode).to.equal(200);
        expect(put.body.units.map((u) => [u.unit_id, u.start_ms, u.end_ms])).to.deep.equal([
            ['u0', 1000, 8000],
            ['u1', 8000, 16000],
            ['u2', 16000, 30000],
        ]);
    });

    it('PUT cascades the left handle: previous unit end follows the dragged boundary', async () => {
        // User drags u1's LEFT handle (shared boundary) EARLIER from 8000 to 5000;
        // the client cascades u0's end to 5000. Both directions must persist gapless.
        const earlier = await hit(handlers.putTimings, {
            build_id: 'b1',
            units: [
                { unit_id: 'u0', start_ms: 0, end_ms: 5000 },
                { unit_id: 'u1', start_ms: 5000, end_ms: 16000 },
                { unit_id: 'u2', start_ms: 16000, end_ms: 30000 },
            ],
        });
        expect(earlier.statusCode).to.equal(200);
        expect(earlier.body.units.map((u) => [u.unit_id, u.start_ms, u.end_ms])).to.deep.equal([
            ['u0', 0, 5000],
            ['u1', 5000, 16000],
            ['u2', 16000, 30000],
        ]);

        // Same drag LATER: u1's left handle from 8000 to 10000 → u0's end 10000.
        const later = await hit(handlers.putTimings, {
            build_id: 'b1',
            units: [
                { unit_id: 'u0', start_ms: 0, end_ms: 10000 },
                { unit_id: 'u1', start_ms: 10000, end_ms: 16000 },
                { unit_id: 'u2', start_ms: 16000, end_ms: 30000 },
            ],
        });
        expect(later.statusCode).to.equal(200);
        expect(later.body.units.map((u) => [u.unit_id, u.start_ms, u.end_ms])).to.deep.equal([
            ['u0', 0, 10000],
            ['u1', 10000, 16000],
            ['u2', 16000, 30000],
        ]);

        // Reload returns the gapless values as-is.
        const get = await hit(handlers.getTimings);
        expect(get.body.units.map((u) => [u.unit_id, u.start_ms, u.end_ms])).to.deep.equal([
            ['u0', 0, 10000],
            ['u1', 10000, 16000],
            ['u2', 16000, 30000],
        ]);
    });
});
