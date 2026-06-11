const { expect } = require('chai');
const sceneHash = require('../src/utils/scene-hash');

describe('Scene Hash (Phase A.3)', () => {
    describe('computeSceneHash', () => {
        it('returns null for empty input', () => {
            expect(sceneHash.computeSceneHash(null)).to.equal(null);
            expect(sceneHash.computeSceneHash(undefined)).to.equal(null);
        });

        it('returns a 64-char hex string for a valid scene', () => {
            const scene = { scene_id: 'sc-1', type: 'narration', text: 'hello' };
            const h = sceneHash.computeSceneHash(scene);
            expect(h).to.be.a('string');
            expect(h).to.have.length(64);
            expect(h).to.match(/^[0-9a-f]{64}$/);
        });

        it('is deterministic for same content', () => {
            const a = { scene_id: 's1', text: 'foo', units: [{ id: 'u1', text: 'a' }] };
            const b = { scene_id: 's1', text: 'foo', units: [{ id: 'u1', text: 'a' }] };
            expect(sceneHash.computeSceneHash(a)).to.equal(sceneHash.computeSceneHash(b));
        });

        it('changes when creative text changes', () => {
            const a = { scene_id: 's1', text: 'foo' };
            const b = { scene_id: 's1', text: 'bar' };
            expect(sceneHash.computeSceneHash(a)).to.not.equal(sceneHash.computeSceneHash(b));
        });

        it('changes when a unit visual prompt changes', () => {
            const a = { units: [{ id: 'u1', text: 'a', visual: { prompt: 'red' } }] };
            const b = { units: [{ id: 'u1', text: 'a', visual: { prompt: 'blue' } }] };
            expect(sceneHash.computeSceneHash(a)).to.not.equal(sceneHash.computeSceneHash(b));
        });

        it('is invariant to key order', () => {
            const a = { text: 'foo', type: 'narration' };
            const b = { type: 'narration', text: 'foo' };
            expect(sceneHash.computeSceneHash(a)).to.equal(sceneHash.computeSceneHash(b));
        });

        it('ignores runtime fields (build_id, status, created_at)', () => {
            const a = { text: 'foo', build_id: 'bld-1', status: 'ready', created_at: 1 };
            const b = { text: 'foo', build_id: 'bld-2', status: 'failed', created_at: 2 };
            expect(sceneHash.computeSceneHash(a)).to.equal(sceneHash.computeSceneHash(b));
        });

        it('ignores unit id (unit id is structural, not creative)', () => {
            const a = { units: [{ id: 'u1', text: 'a' }] };
            const b = { units: [{ id: 'u2', text: 'a' }] };
            expect(sceneHash.computeSceneHash(a)).to.equal(sceneHash.computeSceneHash(b));
        });

        it('produces different hashes for materially different scenes', () => {
            const a = { scene_id: 's1', text: 'a', audio: { full_text: 'a' } };
            const b = { scene_id: 's2', text: 'b', audio: { full_text: 'b' } };
            expect(sceneHash.computeSceneHash(a)).to.not.equal(sceneHash.computeSceneHash(b));
        });
    });

    describe('shortHash', () => {
        it('returns first 12 chars of the hash', () => {
            const scene = { text: 'foo' };
            const full = sceneHash.computeSceneHash(scene);
            const short = sceneHash.shortHash(full);
            expect(short).to.equal(full.slice(0, 12));
        });
        it('returns null for null', () => {
            expect(sceneHash.shortHash(null)).to.equal(null);
        });
    });

    describe('generateBuildId', () => {
        it('returns a string with default prefix', () => {
            const id = sceneHash.generateBuildId();
            expect(id).to.be.a('string');
            expect(id).to.match(/^bld-[a-z0-9]+-[a-f0-9]{8}$/);
        });
        it('respects custom prefix', () => {
            const id = sceneHash.generateBuildId('exp');
            expect(id).to.match(/^exp-/);
        });
        it('produces unique ids', () => {
            const ids = new Set();
            for (let i = 0; i < 50; i++) ids.add(sceneHash.generateBuildId());
            expect(ids.size).to.equal(50);
        });
    });

    describe('computeBookHash', () => {
        it('is null for null book', () => {
            expect(sceneHash.computeBookHash(null)).to.equal(null);
        });
        it('hashes book content deterministically', () => {
            const a = { title: 'X', chapters: [{ id: 'c1' }] };
            const b = { chapters: [{ id: 'c1' }], title: 'X' };
            expect(sceneHash.computeBookHash(a)).to.equal(sceneHash.computeBookHash(b));
        });
    });
});
