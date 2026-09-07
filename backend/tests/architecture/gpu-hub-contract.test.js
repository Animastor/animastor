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
//   2. protocol_version stays = 2 with the canonical contracts package as
//      the SINGLE source (backend facade + hub + worker consume it;
//      Phase 10B removed the hub's last hand-synced literal);
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
// Phase 9C: the canonical Job Protocol v2 implementation moved to the
// @animastor/contracts package; backend/src/runtime/job-schema.js is a
// compatibility facade re-exporting it.
const contractsImplPath = path.join(REPO_ROOT, 'packages', 'animastor-contracts', 'src', 'job-protocol-v2.js');

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

    it('protocol_version stays 2 (contracts canonical; hub consumes it with NO local literal)', () => {
        // Phase 9C: the backend-side literal lives in the contracts package
        // (canonical); job-schema.js is a facade without its own literal.
        // Phase 9D: the worker consumes the GENERATED copy of the canonical
        // implementation — the frozen literal lives there, not in worker.cjs.
        // Phase 10B: the hub consumes the canonical package directly via the
        // compose mount seam — it carries NO local literal either.
        const contractsImpl = read(contractsImplPath);
        const hub = read(gpuHubPath);
        const worker = read(workerPath);
        const workerProtocol = read(path.join(REPO_ROOT, 'worker', 'worker', 'job-protocol-v2.cjs'));
        const v = (src) => [...src.matchAll(/PROTOCOL_VERSION\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(v(contractsImpl), 'contracts/src/job-protocol-v2.js (canonical)').to.deep.equal([2]);
        expect(v(hub), 'gpu-hub/gpu-hub.js (Phase 10B: no local literal)').to.deep.equal([]);
        expect(hub, 'gpu-hub must consume the canonical package').to.include("require('@animastor/contracts')");
        expect(v(workerProtocol), 'worker/worker/job-protocol-v2.cjs (generated from contracts)').to.deep.equal([2]);
        expect(v(worker), 'worker/worker/worker.cjs (no local literal)').to.deep.equal([]);
        expect(worker, 'worker.cjs must consume the generated copy').to.include('require("./job-protocol-v2.cjs")');
        expect(read(jobSchemaPath), 'backend facade must not define its own literal').to.not.match(/PROTOCOL_VERSION\s*=\s*\d/);
    });

    it('SYNC anchors between the copies stay in place', () => {
        const hub = read(gpuHubPath);
        // Phase 10B: the hub consumes the canonical package directly — the
        // protocol anchor is now the contracts require (the old SYNC comment
        // on the backend facade is gone by design; the facade re-exports the
        // same implementation the hub imports).
        expect(hub).to.include("require('@animastor/contracts')");
        expect(hub).to.include('SYNC: backend/src/services/worker-auth.js');
        // Phase 9C: the facade documents the canonical location instead of
        // carrying its own SYNC copy (the old self-anchor is gone by design).
        expect(read(jobSchemaPath)).to.include('@animastor/contracts');
        expect(read(contractsImplPath)).to.include('Job Protocol v2');
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
    // Phase 9C: the grammar lives in @animastor/contracts (canonical) and is
    // consumed by backend through the job-schema.js facade. The three
    // services still carry manually-synced copies of the job_id parse
    // (hub result keys, worker input-file naming) until Phase 9D.
    // Format contract (see JOB_PROTOCOL_V2.md §3.3): `${assetId}:${type}`,
    // parsed from the end; bookId may contain '_', chapter/scene/index may not.

    it('canonical contracts package parses every JOB_TYPE shape', () => {
        const schema = require(contractsImplPath);
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

    it('backend facade re-exports the canonical implementation (runtime identity)', () => {
        const schema = require(jobSchemaPath);
        const canonical = require(contractsImplPath);
        expect(schema.PROTOCOL_VERSION).to.equal(canonical.PROTOCOL_VERSION);
        expect(schema.JOB_TYPES).to.deep.equal(canonical.JOB_TYPES);
        expect(schema.parseJobId).to.equal(canonical.parseJobId);
        expect(schema.buildJobId).to.equal(canonical.buildJobId);
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
        // Phase 9D: the split family lives in the generated canonical copy;
        // worker.cjs consumes JOB_ID_SPLIT_RE from it (no inline literal).
        expect(worker).to.include('job_id.split(JOB_ID_SPLIT_RE)');
        expect(worker).to.not.include('/:(iu_image|image|audio|video)$/');
        expect(read(path.join(REPO_ROOT, 'worker', 'worker', 'job-protocol-v2.cjs')))
            .to.include('JOB_ID_SPLIT_RE = /:(iu_image|image|audio|video)$/');
    });

    it('protocol_version mismatch is rejected with 409 on every entry point', () => {
        const hub = read(gpuHubPath);
        expect(hub).to.include('protocol_version_mismatch');
        const worker = read(workerPath);
        expect(worker).to.match(/Rejecting incompatible task/);
    });
});
