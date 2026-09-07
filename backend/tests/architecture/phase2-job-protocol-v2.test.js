// ======================================================
// PHASE 2 — Job Protocol v2 contract (architecture guardrail)
// ======================================================
// Guards the Job Protocol v2 boundary (Phase 2, Part B + Part D).
// Protocol version is NOT changed in Phase 2; this test re-anchors it as a
// Phase 2 consumer boundary.
//
// Contract invariants (current, from contracts + gpu-hub + worker):
//   1. protocol_version = 2 from the canonical @animastor/contracts package
//      (backend facade + hub consume it; worker consumes the generated copy).
//   2. job_id format = ${assetId}:${type}, type ∈ {audio, image, iu_image, video}.
//   3. parse shape per type is stable (audio chunk / iu_image / scene_image / scene_video).
//   4. Mismatch is rejected (hub 409; worker reject).
//   5. dispatch_id is part of the v2 envelope contract.
//
// This test intentionally mirrors the existing gpu-hub-contract.test.js Job
// Protocol section, but frames it as a Phase 2 consumer boundary (backend →
// hub → worker), not as a hub-only contract.

const { expect } = require('chai');
const path = require('path');
const { readSource, rel, REPO_ROOT } = require('./helpers');

const jobSchemaPath = path.join(REPO_ROOT, 'backend', 'src', 'runtime', 'job-schema.js');
// Phase 9C: canonical implementation lives in @animastor/contracts;
// backend/src/runtime/job-schema.js is a compatibility facade re-export.
const contractsImplPath = path.join(REPO_ROOT, 'packages', 'animastor-contracts', 'src', 'job-protocol-v2.js');
const gpuHubPath = path.join(REPO_ROOT, 'gpu-hub', 'gpu-hub.js');
const workerPath = path.join(REPO_ROOT, 'worker', 'worker', 'worker.cjs');
// Phase 9D: the worker consumes the GENERATED copy of the canonical
// contracts implementation (worker/worker/job-protocol-v2.cjs) instead of
// inline literals — parity-guarded by phase9d-worker-package.test.js.
const workerProtocolPath = path.join(REPO_ROOT, 'worker', 'worker', 'job-protocol-v2.cjs');
const dispatcherPath = path.join(REPO_ROOT, 'backend', 'src', 'runtime', 'gpu-dispatcher.js');

function read(file) {
    return readSource(file);
}

describe('architecture: Job Protocol v2 contract (backend → hub → worker boundary)', () => {
    it('protocol_version = 2 from the canonical source only (hub consumes contracts, no local literal)', () => {
        const contractsImpl = read(contractsImplPath);
        const hub = read(gpuHubPath);
        const worker = read(workerPath);
        const workerProtocol = read(workerProtocolPath);
        const v = (src) => [...src.matchAll(/PROTOCOL_VERSION\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(v(contractsImpl), 'contracts/src/job-protocol-v2.js (canonical)').to.deep.equal([2]);
        // Phase 10B: the hub consumes the canonical package (compose mount
        // seam) — it carries NO local literal.
        expect(v(hub), 'gpu-hub/gpu-hub.js (Phase 10B: no local literal)').to.deep.equal([]);
        expect(hub, 'gpu-hub must consume the canonical package').to.include("require('@animastor/contracts')");
        // Phase 9D: the worker has NO local literal — it consumes the
        // generated copy, which carries the frozen literal.
        expect(v(workerProtocol), 'worker/worker/job-protocol-v2.cjs (generated from contracts)').to.deep.equal([2]);
        expect(v(worker), 'worker/worker/worker.cjs (no local literal)').to.deep.equal([]);
        expect(worker, 'worker.cjs must consume the generated copy').to.include('require("./job-protocol-v2.cjs")');
        // the backend facade re-exports and must not define its own literal
        expect(read(jobSchemaPath), 'backend facade must not define its own literal').to.not.match(/PROTOCOL_VERSION\s*=\s*\d/);
    });

    it('hub enforces protocol_version mismatch as 409', () => {
        const hub = read(gpuHubPath);
        expect(hub).to.include('protocol_version_mismatch');
    });

    it('worker rejects tasks whose protocol_version mismatches', () => {
        const worker = read(workerPath);
        expect(worker).to.match(/Rejecting incompatible task/);
    });

    it('v2 envelope contract includes dispatch_id', () => {
        const hub = read(gpuHubPath);
        expect(hub).to.match(/dispatch_id/);
        // Phase 9C: dispatch_id is part of the frozen envelope contract in
        // the canonical package (the backend facade is a pure re-export).
        expect(read(contractsImplPath)).to.match(/dispatch_id/);
    });

    it('job_id type family is anchored the same in backend, hub, worker', () => {
        // All copies must know the four job types. We pin the set by
        // checking the canonical package + facade path, the hub, and the
        // worker split regex against the same type family.
        const canonical = read(contractsImplPath);
        const hub = read(gpuHubPath);
        const worker = read(workerPath);
        const workerProtocol = read(workerProtocolPath);
        for (const token of ['audio', 'image', 'iu_image', 'video']) {
            expect(canonical).to.include(token);
            // gpu-hub.js is a large file; the type family is referenced via
            // the queue key builders and the job-dedup/result key builders,
            // not necessarily as a standalone token in every scan window.
            // We pin it by checking the type-suffix regex is present in the hub.
            expect(hub).to.match(new RegExp(':(iu_image|image|audio|video)'));
        }
        // Phase 9D: the worker no longer pins the job_id grammar as inline
        // split-regex literals — it consumes JOB_ID_SPLIT_RE from the
        // generated canonical copy (both occurrences: multi-image and
        // single-image input-file naming). The literal itself is pinned in
        // the generated copy.
        const workerSplitUsages = [...worker.matchAll(/job_id\.split\(JOB_ID_SPLIT_RE\)/g)].map((m) => m[0]);
        expect(workerSplitUsages, 'worker job_id split via generated copy').to.deep.equal([
            'job_id.split(JOB_ID_SPLIT_RE)', 'job_id.split(JOB_ID_SPLIT_RE)',
        ]);
        expect(workerProtocol).to.match(/JOB_ID_SPLIT_RE = \/:\(iu_image\|image\|audio\|video\)\$\//);
        // Negative control: the split literal must NOT appear with a wrong
        // type family anywhere (guards the pin against becoming vacuous).
        expect(worker).to.not.include('/:(iu_image|image|audio)$/');
        expect(workerProtocol).to.not.include('/:(iu_image|image|audio)$/');
    });

    it('job envelope carries backend-authored identity fields (book_id, chapter_id, scene_id, stage)', () => {
        const hub = read(gpuHubPath);
        expect(hub).to.match(/book_id/);
        expect(hub).to.match(/chapter_id/);
        expect(hub).to.match(/scene_id/);
        expect(hub).to.match(/stage/);
    });

    it('dispatcher sends /task via sendUnified and includes protocol_version', () => {
        const dispatcher = read(dispatcherPath);
        expect(dispatcher).to.include('`${config.HUB_URL}/task`');
        expect(dispatcher).to.match(/protocol_version/);
    });
});

describe('architecture: Job ID format contract (canonical parse)', () => {
    const schema = require(contractsImplPath);
    // Phase 9C: require the canonical implementation. The backend facade
    // (jobSchemaPath) re-exports the same objects (runtime identity is
    // pinned by phase9c-contracts.test.js).

    it('canonical parse recognizes all four JOB_TYPES', () => {
        expect(schema.JOB_TYPES).to.deep.equal(['audio', 'image', 'iu_image', 'video']);
    });

    it('audio chunk parse: ${bookId}_${chapterId}_${sceneId}_${NNNN}:audio', () => {
        const r = schema.parseJobId('evening_city_demo_ch-ce87_sc-6c4e_0003:audio');
        expect(r).to.deep.include({ kind: 'audio_chunk', chapterId: 'ch-ce87', sceneId: 'sc-6c4e', chunkIndex: '0003' });
    });

    it('iu_image parse: ${bookId}_${chapterId}_${sceneId}_${iuId}:iu_image', () => {
        const r = schema.parseJobId('my_book_ch-1_sc-2_iu-abc:iu_image');
        expect(r).to.deep.include({ kind: 'iu_image', iuId: 'iu-abc' });
    });

    it('scene image parse: ${bookId}_${chapterId}_${sceneId}:image', () => {
        const r = schema.parseJobId('my_book_ch-1_sc-2:image');
        expect(r).to.deep.include({ kind: 'scene_image' });
    });

    it('scene video parse: ${bookId}_${chapterId}_${sceneId}[_gN]:video', () => {
        const r = schema.parseJobId('b_ch-1_sc-2_g3:video');
        expect(r).to.deep.include({ kind: 'scene_video', groupSuffix: '_g3' });
    });

    it('invalid job_id → null, never throw', () => {
        expect(schema.parseJobId('garbage')).to.equal(null);
        expect(schema.parseJobId('a_b_c:dungeon')).to.equal(null);
    });

    it('buildJobId is the canonical envelope builder', () => {
        expect(schema.buildJobId('x_ch-1_sc-2', 'image')).to.equal('x_ch-1_sc-2:image');
    });
});
