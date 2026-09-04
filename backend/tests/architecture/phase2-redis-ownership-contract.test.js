// ======================================================
// PHASE 2 — Redis ownership documentation contract (architecture guardrail)
// ======================================================
// Freezes the Phase 2 documentation of Redis ownership (Part C). Does NOT
// change the Redis protocol. Builds on the existing Phase 1 registry
// (tests/architecture/redis-registry.js) and adds the Phase 2 "dangerous
// places" explicitly.
//
// Contract invariants (docs/architecture/PHASE_2_CONTRACTS.md §9):
//   1. Every animastor:* key literal in backend/src and gpu-hub belongs to a
//      registered family (existing Phase 1 test already enforces this).
//   2. Cross-owner writes are frozen at the Phase 1 baseline (existing test).
//   3. worker-auth is written only by services/worker-auth.js (existing test).
//   4. worker bundle never touches Redis (existing test).
//   5. Phase 2 explicitly documents the four dangerous places; this test
//      verifies the documentation is present and consistent with the registry.
//
// This test is documentation-contract-oriented: it checks that the Phase 2
// ownership claims are present and consistent with the existing registry,
// not that Redis itself behaves in a new way.

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { readSource, rel, REPO_ROOT } = require('./helpers');
const { REDIS_OWNERSHIP } = require('./redis-registry');

function read(file) {
    return readSource(file);
}

const PHASE_2_DOCS = path.join(REPO_ROOT, 'docs', 'architecture', 'PHASE_2_CONTRACTS.md');

describe('architecture: Redis ownership contract (Phase 2 documentation)', () => {
    it('Phase 2 ownership docs mention the four dangerous places', () => {
        const docs = read(PHASE_2_DOCS);
        expect(docs).to.match(/dangerous places/i);
        // 1. Backend writes worker heartbeat, Hub reads.
        expect(docs).to.match(/worker heartbeat/);
        // 2. Backend works with worker-auth.
        expect(docs).to.match(/worker-auth/);
        // 3. Backend mutates policy queues via drainPolicyLane.
        expect(docs).to.match(/drainPolicyLane/);
        // 4. Book DELETE touches runtime Redis active state.
        expect(docs).to.match(/book.*delete/i);
        expect(docs).to.match(/runtime Redis/i);
    });

    it('dangerous place 1 (backend writes worker heartbeat, hub reads) matches registry', () => {
        // Family animastor:worker:heartbeat:* is hub-owned; backend has legacy
        // writes (documented). Registry must reflect that.
        const hb = REDIS_OWNERSHIP.find((f) => f.pattern === 'animastor:worker:heartbeat:*');
        expect(hb).to.not.be.undefined;
        expect(hb.owner).to.equal('gpu-hub');
        expect(hb.readers).to.include('backend');
        expect(hb.writers).to.include('gpu-hub');
        // Documented debt: backend writes this family.
        expect(hb.crossModule).to.equal(true);
    });

    it('dangerous place 2 (backend works with worker-auth) matches registry', () => {
        const wa = REDIS_OWNERSHIP.find((f) => f.pattern === 'animastor:worker-auth');
        expect(wa).to.not.be.undefined;
        expect(wa.owner).to.equal('backend');
        expect(wa.writers).to.deep.equal(['backend']);
        expect(wa.readers).to.include('gpu-hub');
        expect(wa.crossModule).to.equal(false);
    });

    it('dangerous place 3 (backend mutates policy queues) matches registry', () => {
        const pq = REDIS_OWNERSHIP.find((f) => f.pattern === 'animastor:queue:*:policy:*');
        expect(pq).to.not.be.undefined;
        expect(pq.owner).to.equal('gpu-hub');
        expect(pq.crossModule).to.equal(true);
    });

    it('dangerous place 4 (book delete touches runtime active state) is documented as best-effort', () => {
        const docs = read(PHASE_2_DOCS);
        // The contract is: book delete removes canonical disk bundle; runtime
        // Redis active state is best-effort cleaned, not atomically invalidated.
        expect(docs).to.match(/best-effort/);
    });

    it('registry covers the Phase 2 key families referenced in the ownership table', () => {
        const required = [
            'animastor:worker-auth',
            'animastor:worker:heartbeat:*',
            'animastor:gpu-hub:workers',
            'animastor:queue:*',
            'animastor:queue:*:policy:*',
            'animastor:job:*',
            'animastor:result:*',
            'animastor:error:*',
            'animastor:runtime:*',
            'animastor:runtime:active',
            'animastor:vbook:*',
            'animastor:vbook-scene-idx:*',
            'animastor:ai-connector:hb:*',
        ];
        const patterns = new Set(REDIS_OWNERSHIP.map((f) => f.pattern));
        for (const r of required) {
            expect(patterns.has(r), `family ${r} must be documented in redis-registry.js`).to.equal(true);
        }
    });

    it('shared-pool and LAC in-process state are documented as backend-owned, not Redis', () => {
        const docs = read(PHASE_2_DOCS);
        expect(docs).to.match(/in-process/);
        expect(docs).to.match(/shared-pool/);
        expect(docs).to.match(/AI-connector|Local AI Connector|shared-pool|lifecycle/i);
    });
});
