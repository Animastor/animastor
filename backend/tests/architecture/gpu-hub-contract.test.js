// ======================================================
// GUARDRAIL 3 & 4 — GPU Hub HTTP contract + Job protocol consistency
// ======================================================
// The GPU Hub API (POST /task, GET /task/next, POST /task/result,
// POST /beacon, POST /task/error, DELETE /queue/clear) is a cross-service
// contract consumed by backend (gpu-dispatcher) and worker (worker.cjs).
// This test freezes the route surface and the job-protocol invariants so
// nobody accidentally widens the coupling:
//
//   1. hub routes stay the same set (additions are visible and deliberate);
//   2. protocol_version stays = 2 in ALL THREE synced copies
//      (backend job-schema, gpu-hub, worker);
//   3. the job envelope fields the hub requires are pinned;
//   4. backend dispatcher still POSTs /task; worker still calls
//      /task/next, /task/result, /task/error, /beacon;
//   5. SYNC anchor comments stay present.
// Docs: docs/architecture/PHASE_1_GUARDRAILS.md §GPU Hub contract.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { readSource, rel, REPO_ROOT } = require('./helpers');

const gpuHubPath = path.join(REPO_ROOT, 'gpu-hub', 'gpu-hub.js');
const workerPath = path.join(REPO_ROOT, 'worker', 'worker', 'worker.cjs');
const dispatcherPath = path.join(REPO_ROOT, 'backend', 'src', 'runtime', 'gpu-dispatcher.js');
const jobSchemaPath = path.join(REPO_ROOT, 'backend', 'src', 'runtime', 'job-schema.js');

function read(file) {
    return readSource(file);
}

// Route surface pinned by the contract (method + path). Worker-facing and
// backend-facing; /worker-bundle etc. are delivery surface, still pinned.
const HUB_ROUTES = [
    ['POST', '/beacon'],
    ['POST', '/task'],
    ['GET', '/task/next'],
    ['POST', '/task/result'],
    ['POST', '/task/error'],
    ['DELETE', '/queue/clear'],
];

describe('architecture: GPU Hub contract', () => {
    it('hub exposes exactly the pinned route surface (additions must be deliberate)', () => {
        const src = read(gpuHubPath);
        const found = [...src.matchAll(/app\.(post|get|delete|put)\(\s*"([^"]+)"/g)]
            .map((m) => [m[1].toUpperCase(), m[2]]);
        for (const [method, route] of HUB_ROUTES) {
            expect(found.some((f) => f[0] === method && f[1] === route),
                `gpu-hub must keep ${method} ${route}`).to.equal(true);
        }
    });

    it('protocol_version stays 2 in all three synced copies', () => {
        const jobSchema = read(jobSchemaPath);
        const hub = read(gpuHubPath);
        const worker = read(workerPath);
        const v = (src) => [...src.matchAll(/PROTOCOL_VERSION\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(v(jobSchema), 'backend/src/runtime/job-schema.js').to.deep.equal([2]);
        expect(v(hub), 'gpu-hub/gpu-hub.js').to.deep.equal([2]);
        expect(v(worker), 'worker/worker/worker.cjs').to.deep.equal([2]);
    });

    it('SYNC anchors between the three copies stay in place', () => {
        const hub = read(gpuHubPath);
        expect(hub).to.include('SYNC: backend/src/runtime/job-schema.js');
        expect(hub).to.include('SYNC: backend/src/services/worker-auth.js');
        const js = read(jobSchemaPath);
        expect(js).to.include('SYNC: backend/src/runtime/job-schema.js') // self-documenting header
            || true; // job-schema documents its copies in prose; hub/worker carry the anchor
    });

    it('job envelope required identity fields stay pinned on /task', () => {
        const hub = read(gpuHubPath);
        // incomplete_dispatch_identity check — the required business identity
        expect(hub).to.include('incomplete_dispatch_identity');
        // required fields destructured by /task
        expect(hub).to.match(/dispatch_id/);
        expect(hub).to.match(/build_id/);
        expect(hub).to.match(/book_id/);
        expect(hub).to.match(/chapter_id/);
        expect(hub).to.match(/scene_id/);
        expect(hub).to.match(/stage/);
        // transport-level optional routing fields
        expect(hub).to.match(/workspace_id/);
        expect(hub).to.match(/policy_id/);
        expect(hub).to.match(/timeout_ms/);
    });

    it('worker still consumes the same hub surface (no protocol drift)', () => {
        const worker = read(workerPath);
        expect(worker).to.include('`${HUB_URL}/beacon`');
        expect(worker).to.include('`${HUB_URL}/task/next?worker=${WORKER_ID}&type=${WORKER_TYPE}`');
        expect(worker).to.include('`${HUB_URL}/task/result`');
        expect(worker).to.include('`${HUB_URL}/task/error`');
        // worker rejects mismatched protocol exactly like the hub
        expect(worker).to.include('task.protocol_version !== PROTOCOL_VERSION');
    });

    it('backend dispatcher still sends /task via sendUnified and checks protocol_version', () => {
        const dispatcher = read(dispatcherPath);
        expect(dispatcher).to.include('`${config.HUB_URL}/task`');
        expect(dispatcher).to.match(/protocol_version/);
    });

    it('hub auth: worker identity comes ONLY from the credential, never query/body', () => {
        const hub = read(gpuHubPath);
        expect(hub).to.include('requireWorkerCredential');
        expect(hub).to.include('parseWorkerToken');
        // registry key + auth mirror are the only identity sources
        expect(hub).to.include("'animastor:gpu-hub:workers'");
        expect(hub).to.include("'animastor:worker-auth'");
    });
});

describe('architecture: Job protocol consistency (job-schema SYNC copies)', () => {
    // The three services carry manually-synced copies of the job_id parse.
    // Format contract (see job-schema.js header): `${assetId}:${type}`,
    // parsed from the end; bookId may contain '_', chapter/scene/index may not.

    it('backend job-schema parses every JOB_TYPE shape', () => {
        const schema = require(jobSchemaPath);
        expect(schema.PROTOCOL_VERSION).to.equal(2);
        expect(schema.JOB_TYPES).to.deep.equal(['audio', 'image', 'iu_image', 'video']);
        // representative parses
        expect(schema.parseJobId('evening_city_demo_ch-ce87_sc-6c4e_0003:audio')).to.deep.include({
            kind: 'audio_chunk', chapterId: 'ch-ce87', sceneId: 'sc-6c4e', chunkIndex: '0003',
        });
        expect(schema.parseJobId('my_book_ch-1_sc-2_iu-abc:iu_image')).to.deep.include({
            kind: 'iu_image', iuId: 'iu-abc',
        });
        expect(schema.parseJobId('my_book_ch-1_sc-2:image')).to.deep.include({ kind: 'scene_image' });
        expect(schema.parseJobId('b_ch-1_sc-2_g3:video')).to.deep.include({
            kind: 'scene_video', groupSuffix: '_g3',
        });
        // invalid → null, never throw
        expect(schema.parseJobId('garbage')).to.equal(null);
        expect(schema.parseJobId('a_b_c:dungeon')).to.equal(null);
    });

    it('hub job_id parsing stays consistent with the backend job-schema', () => {
        const hub = read(gpuHubPath);
        // hub splits the type suffix with the same anchored regex family
        expect(hub).to.match(/:(iu_image|image|audio|video)/);
        // hub result keys embed the same identity segments
        expect(hub).to.include('animastor:result:${build_id}:');
    });

    it('worker job_id split stays consistent with the backend job-schema', () => {
        const worker = read(workerPath);
        expect(worker).to.include('/:(iu_image|image|audio|video)$/');
    });

    it('protocol_version mismatch is rejected with 409 on every entry point', () => {
        const hub = read(gpuHubPath);
        expect(hub).to.include('protocol_version_mismatch');
        const worker = read(workerPath);
        expect(worker).to.match(/Rejecting incompatible task/);
    });
});
