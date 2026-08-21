// ======================================================
// GPU Hub — worker source endpoint (Experimental Beta onboarding)
// ======================================================
// GET /worker-source serves the self-contained worker.cjs so a Private
// Worker operator can obtain it from the hub itself (the repo mirror is
// private). No auth required — the file contains no secrets.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const { createMockRedis } = require('./mocks/redis-mock');
const { buildHubApp } = require('../../gpu-hub/gpu-hub');

const REAL_WORKER_SOURCE = path.join(__dirname, '../../worker/worker/worker.cjs');

async function startHub(workerSourcePath) {
    const redis = createMockRedis();
    const app = buildHubApp({
        redis,
        config: {
            BACKEND_URL: 'http://backend.test',
            GPU_TIMEOUT_MS: 600000,
            GPU_HUB_API_KEY: null,
            WORKER_SOURCE_PATH: workerSourcePath,
        },
        fetchImpl: async () => ({ ok: true, status: 200 }),
        intervals: false,
    });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}

describe('GPU hub — GET /worker-source', () => {
    let hub;

    afterEach(async () => {
        if (hub) { await new Promise((r) => hub.server.close(r)); hub = null; }
    });

    it('serves worker.cjs with a download disposition and no-store cache', async () => {
        hub = await startHub(REAL_WORKER_SOURCE);
        const res = await fetch(`${hub.base}/worker-source`);
        expect(res.status).to.equal(200);
        expect(res.headers.get('content-type')).to.contain('application/javascript');
        expect(res.headers.get('content-disposition')).to.contain('worker.cjs');
        expect(res.headers.get('cache-control')).to.equal('no-store');
        const body = await res.text();
        expect(body).to.equal(fs.readFileSync(REAL_WORKER_SOURCE, 'utf8'));
    });

    it('answers 404 (never 500) when the source file is absent', async () => {
        hub = await startHub('/nonexistent/worker.cjs');
        const res = await fetch(`${hub.base}/worker-source`);
        expect(res.status).to.equal(404);
        const body = await res.json();
        expect(body.error).to.equal('worker_source_unavailable');
    });
});
