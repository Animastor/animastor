const { expect } = require('chai');

// ======================================================
// C21.4 — Dirty-grammar adoption regression guard
// ======================================================
// The dirty-layer grammar (Prompt Dependency Registry) was physically
// adopted into @animastor/generation (packages/animastor-generation/src/
// dirty-grammar) — the host copy backend/src/services/
// prompt-dependency-registry.js is DELETED. The host book-diff service now
// delegates to the package namespace. This guard freezes the integration
// contract end-to-end: whatever the package grammar computes, the host
// book-diff must surface unchanged (dirty_layers + changes), for every
// representative scene-change shape.
//
// If this test fails, someone changed one side without the other — restore
// parity before shipping (the package grammar is the canonical owner).

const generation = require('@animastor/generation');
const bookDiffFactory = require('../src/services/book-diff.cjs');

// Minimal deps: diffScene() only needs the package grammar; the factory
// destructure requires deps.utils to exist.
function createBookDiff() {
    return bookDiffFactory({}, {}, { utils: { log: () => {}, collectScenes: () => [] } });
}

// Representative scene-change fixtures (one per grammar field class).
const FIXTURES = [
    {
        name: 'identical scenes → no dirty layers',
        oldScene: { audio: { full_text: 'Hello', voice: 'narrator' }, visual: { style: 'cinematic' } },
        newScene: { audio: { full_text: 'Hello', voice: 'narrator' }, visual: { style: 'cinematic' } },
    },
    {
        name: 'audio full_text change → audio + image + video',
        oldScene: { audio: { full_text: 'Hello' } },
        newScene: { audio: { full_text: 'Hello world' } },
    },
    {
        name: 'audio voice change → audio only',
        oldScene: { audio: { voice: 'narrator' } },
        newScene: { audio: { voice: 'character' } },
    },
    {
        name: 'visual style change → image + video (no audio)',
        oldScene: { visual: { style: 'cinematic' } },
        newScene: { visual: { style: 'cartoon' } },
    },
    {
        name: 'location change → image + video',
        oldScene: { location: { id: 'forest' } },
        newScene: { location: { id: 'castle' } },
    },
    {
        name: 'participants change → image + video',
        oldScene: { participants: ['char-1'] },
        newScene: { participants: ['char-1', 'char-2'] },
    },
    {
        name: 'scene.passport override change → image + video (no audio)',
        oldScene: { passport: { 'char-1': { clothing_base: 'grey coat' } } },
        newScene: { passport: { 'char-1': { clothing_base: 'black suit' } } },
    },
    {
        name: 'units change → image + video + audio',
        oldScene: { units: [{ id: 'u1', text: 'Hello' }] },
        newScene: { units: [{ id: 'u1', text: 'Hello world' }] },
    },
    {
        name: 'dialogue_blocks units change → image + video + audio',
        oldScene: { dialogue_blocks: [{ units: [{ id: 'u1', text: 'A' }] }] },
        newScene: { dialogue_blocks: [{ units: [{ id: 'u1', text: 'B' }] }] },
    },
    {
        name: 'combined audio + visual change → all three layers (deduplicated)',
        oldScene: { audio: { full_text: 'Hello' }, visual: { style: 'cinematic' } },
        newScene: { audio: { full_text: 'World' }, visual: { style: 'cartoon' } },
    },
    {
        name: 'null scenes → no crash, no dirty layers',
        oldScene: null,
        newScene: null,
    },
];

describe('C21.4 dirty-grammar adoption: host book-diff ≡ package dirtyGrammar', () => {
    let bookDiff;

    before(() => {
        bookDiff = createBookDiff();
    });

    for (const f of FIXTURES) {
        it(`${f.name} — host output equals package output`, () => {
            const host = bookDiff.diffScene(f.oldScene, f.newScene);
            const pkg = generation.dirtyGrammar.computeSceneDirtyLayers(f.oldScene, f.newScene);
            expect(host.dirty_layers, 'dirty_layers must match the package grammar').to.deep.equal(pkg.dirtyLayers);
            expect(host.changes, 'changes must match the package grammar').to.deep.equal(pkg.changes);
        });
    }

    it('the host book-diff delegates through the package namespace (host copy deleted)', () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'book-diff.cjs'), 'utf8');
        expect(src).to.match(/require\(['"]@animastor\/generation['"]\)\.dirtyGrammar/);
        const fs = require('fs');
        expect(fs.existsSync(require('path').join(__dirname, '..', 'src', 'services', 'prompt-dependency-registry.js')),
            'the host prompt-dependency-registry.js copy must stay deleted').to.equal(false);
    });

    it('the package dirtyGrammar surface exposes the frozen helpers the host consumed', () => {
        const dg = generation.dirtyGrammar;
        for (const fn of ['computeSceneDirtyLayers', 'getFieldsForLayer', 'getCrossFields',
            'getLayerDependencies', 'sceneReferencesCharacter', 'isEqual']) {
            expect(dg[fn], `dirtyGrammar.${fn}`).to.be.a('function');
        }
    });
});
