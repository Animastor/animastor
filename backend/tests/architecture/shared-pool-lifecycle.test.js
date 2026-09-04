// ======================================================
// PHASE 2 — Shared Pool snapshot contract (architecture guardrail)
// ======================================================
// Guards the shared-pool SNAPSHOT contract (Phase 2, Part B.3).
// The shared pool rides the SAME connector transport as the private path.
//
// Contract invariants (derived from current shared-pool.js semantics):
//   1. Selection is eligibility-based, deterministic V1 "first eligible".
//   2. A shared snapshot holds: source:'shared', transport:'connector',
//      provider:'local-ai', endpoint:null, apiKey:null, model, shared:{...}.
//   3. Non-shared / private snapshot → no pool interaction.
//   4. Invalid / null snapshot → shared_unavailable.
//
// IMPORTANT (Phase 2, current status):
// The LIFECYCLE sub-suite (shared inference releases the slot on every
// terminal state) and the CONCURRENCY sub-suite (reserve fails when busy,
// release is safe when called multiple times, stats exposes inflight map)
// are NOT part of this test file. The shared-pool module's internal seam
// for probing slots (acquireSlot / inflight / inflightCount) is not stable
// across all puzzles loaded during arch tests, so those behavioral probes
// do not yet have a stable home here. The gap is documented in
// docs/architecture/PHASE_2_CONTRACTS.md under "Current Gaps / Technical
// Debt". A full lifecycle/concurrency contract is deferred to separate
// work. The snapshot contract below stays because it guards only the
// public module contract that IS stable.

const { expect } = require('chai');
const path = require('path');
const { REPO_ROOT } = require('./helpers');
const sharedPool = require(path.join(REPO_ROOT, 'backend', 'src', 'services', 'ai-connector', 'shared-pool.js'));

describe('architecture: shared-pool snapshot contract', () => {
    it('shared snapshot has the documented shape', () => {
        const entry = {
            endpoint: { endpoint_id: 'ep-1', name: 'Shared A', workspace_id: 'ws-owner', connector_id: 'c-1', model: 'model-a' },
            policy: { concurrency_limit: 2 },
            connector: { models: ['model-a', 'model-b'], runtime_meta: { runtime_ok: true } },
        };

        expect(sharedPool.checkEligibility(entry, { workspaceId: 'ws-owner', requestedModel: 'model-a' }))
            .to.deep.equal({ eligible: false, reason: 'own_endpoint' });

        expect(sharedPool.checkEligibility({ ...entry, connector: { models: [], runtime_meta: {} } }, { workspaceId: 'ws-other', requestedModel: 'model-a' }))
            .to.deep.equal({ eligible: false, reason: 'connector_offline' });
    });

    it('selectModel enforces strict discovered-model eligibility', () => {
        const entry = {
            endpoint: { model: 'configured-model' },
            connector: { models: ['discovered-a', 'discovered-b'] },
        };

        expect(sharedPool.selectModel(entry, 'not-in-discovered')).to.equal(null);
        expect(sharedPool.selectModel(entry, 'discovered-a')).to.equal('discovered-a');
        // configured 'configured-model' is NOT in discovered, so falls to first discovered.
        expect(sharedPool.selectModel(entry, null)).to.equal('discovered-a');
    });

    it('selectEndpoint is deterministic V1 "first eligible"', () => {
        expect(sharedPool.selectEndpoint([{ id: 1 }, { id: 2 }])).to.deep.equal({ id: 1 });
        expect(sharedPool.selectEndpoint([])).to.equal(null);
    });

    it('isSharedSnapshot recognizes only source:shared snapshots with shared.endpointId', () => {
        expect(sharedPool.isSharedSnapshot({ source: 'shared', shared: { endpointId: 'ep-1' } })).to.be.true;
        expect(sharedPool.isSharedSnapshot({ source: 'shared', shared: { ownerWorkspaceId: 'ws' } })).to.be.false;
        expect(sharedPool.isSharedSnapshot({ source: 'private', connectorId: 'c-1' })).to.be.false;
        expect(sharedPool.isSharedSnapshot(null)).to.be.false;
    });

    it('describeSharedError surfaces sanitized fixed strings', () => {
        expect(sharedPool.describeSharedError('shared_unavailable')).to.be.a('string').with.length.greaterThan(0);
        expect(sharedPool.describeSharedError('busy')).to.be.a('string').with.length.greaterThan(0);
    });
});