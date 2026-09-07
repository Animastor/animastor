// ======================================================
// animastor-worker — Job Protocol v2 generated-copy parity
// ======================================================
// Phase 9D (blocker B2, option B): the bundle carries an EXPLICITLY
// GENERATED copy of the canonical @animastor/contracts Job Protocol v2
// implementation (worker/job-protocol-v2.cjs). This suite verifies, at the
// package level, that the copy is protocol-identical to the canonical
// source — not a divergent second implementation:
//   - byte parity of the copy body vs contracts/src/job-protocol-v2.js
//     (dev-time check via worker/tools/sync-protocol.cjs, which is the
//     single generator; on a machine without the monorepo this suite is
//     skipped for parity but the self-consistency checks below still run);
//   - frozen wire values: protocol_version = 2, JOB_TYPES family,
//     JOB_ID_SPLIT_RE = /:(iu_image|image|audio|video)$/ — the values the
//     worker uses for task rejection and input-file naming.
// Repo-level guard (incl. negative control):
//   backend/tests/architecture/phase9d-worker-package.test.js

const fs = require('fs');
const path = require('path');
const { describe, it, expect } = require('./harness.cjs');

const BUNDLE_DIR = path.join(__dirname, '..', 'worker');
const protocol = require(path.join(BUNDLE_DIR, 'job-protocol-v2.cjs'));

describe('worker bundle — Job Protocol v2 generated copy (frozen wire values)', () => {
    it('protocol_version is the frozen 2 (literal present in the copy)', () => {
        expect.equal(protocol.PROTOCOL_VERSION, 2);
        const src = fs.readFileSync(path.join(BUNDLE_DIR, 'job-protocol-v2.cjs'), 'utf8');
        expect.match(src, /const PROTOCOL_VERSION = 2;/, 'the copy must pin the literal, not a computed value');
    });

    it('JOB_ID_SPLIT_RE is the frozen split family used by input-file naming', () => {
        expect.equal(String(protocol.JOB_ID_SPLIT_RE), '/:(iu_image|image|audio|video)$/');
        // stateless regex (no /g flag) — safe to share across job splits
        expect.equal(protocol.JOB_ID_SPLIT_RE.global, false);
    });

    it('frozen parse vectors (worker-side subset of the canonical grammar)', () => {
        // The worker only splits the type suffix for input-file naming; the
        // vectors below pin exactly that behavior on the frozen family.
        expect.deepEqual(protocol.parseJobId('b_ch-1_sc-2:video'), {
            kind: 'scene_video', type: 'video', assetId: 'b_ch-1_sc-2',
            bookId: 'b', chapterId: 'ch-1', sceneId: 'sc-2', groupSuffix: '',
        });
        expect.deepEqual(protocol.parseJobId('b_ch-1_sc-2_g3:video'), {
            kind: 'scene_video', type: 'video', assetId: 'b_ch-1_sc-2_g3',
            bookId: 'b', chapterId: 'ch-1', sceneId: 'sc-2', groupSuffix: '_g3',
        });
        expect.deepEqual(protocol.parseJobId('b_ch-1_sc-2_iu-abc:iu_image').kind, 'iu_image');
        expect.equal(protocol.parseJobId('a_b_c:dungeon'), null);
        expect.equal(protocol.parseJobId('garbage'), null);
    });

    it('JOB_TYPES family matches the split family exactly', () => {
        const family = protocol.JOB_ID_SPLIT_RE.source.replace(/^:\(/, '').replace(/\)\$$/, '');
        expect.deepEqual(family.split('|').sort(), [...protocol.JOB_TYPES].sort());
        expect.deepEqual([...protocol.JOB_TYPES].sort(), ['audio', 'image', 'iu_image', 'video']);
    });

    it('split usage in worker.cjs goes through the copy (no inline literals)', () => {
        const workerSrc = fs.readFileSync(path.join(BUNDLE_DIR, 'worker.cjs'), 'utf8');
        const splits = [...workerSrc.matchAll(/job_id\.split\(JOB_ID_SPLIT_RE\)/g)];
        expect.equal(splits.length, 2, 'both input-file naming splits must use JOB_ID_SPLIT_RE');
        expect.notMatch(workerSrc, /job_id\.split\(\/:/, 'no inline split literals may remain in worker.cjs');
        expect.include(workerSrc, 'require("./job-protocol-v2.cjs")');
        expect.notMatch(workerSrc, /const PROTOCOL_VERSION\s*=\s*\d/, 'worker.cjs must not define its own PROTOCOL_VERSION');
    });

    it('byte parity with the canonical contracts source (dev-time, monorepo present)', () => {
        // Monorepo location of @animastor/contracts: repo root (today's
        // boundary depth) or packages/ (post-relocation depth). Without the
        // monorepo the parity check is skipped (repo-level guard D4 covers it).
        const canonicalCandidates = [
            path.join(__dirname, '..', '..', 'packages', 'animastor-contracts', 'src', 'job-protocol-v2.js'),
            path.join(__dirname, '..', '..', '..', 'packages', 'animastor-contracts', 'src', 'job-protocol-v2.js'),
        ];
        const canonicalPath = canonicalCandidates.find((p) => fs.existsSync(p));
        if (!canonicalPath) {
            console.log('  (parity vs canonical source skipped — standalone checkout without monorepo)');
            return;
        }
        const sync = require('../tools/sync-protocol.cjs');
        const res = sync.verify();
        expect.ok(res.ok, `generated copy drift: ${res.errors.join('; ')}`);
    });
});
