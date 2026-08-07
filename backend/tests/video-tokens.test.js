const { expect } = require('chai');
const app = require('../src/book/lazy-book/appearance');
const pipelineSteps = require('../src/services/agent/pipeline-steps');
const { applySceneVideoTokens } = require('../src/services/agent/pipeline-runner');
const wf = require('../src/workflows/video/video-workflows');

describe('sanitizeVideoTokens (stage 1 validation)', () => {
    it('trims, drops empties, caps at 4 features', () => {
        const r = app.sanitizeVideoTokens(['tie', '', '  glasses ', 'hat', 'beard', 'cane']);
        expect(r).to.deep.equal(['tie', 'glasses', 'hat', 'beard']);
    });

    it('drops features longer than 60 chars or more than 6 words', () => {
        const long = 'a very long feature sentence that goes on and on about nothing at all';
        const r = app.sanitizeVideoTokens(['tie', long]);
        expect(r).to.deep.equal(['tie']);
    });

    it('returns null for non-array input', () => {
        expect(app.sanitizeVideoTokens('tie')).to.be.null;
        expect(app.sanitizeVideoTokens(undefined)).to.be.null;
        expect(app.sanitizeVideoTokens(null)).to.be.null;
    });
});

describe('tokensToString (render)', () => {
    it('joins array features with commas', () => {
        expect(app.tokensToString(['tie', 'round glasses'])).to.equal('tie, round glasses');
    });
    it('passes legacy strings through', () => {
        expect(app.tokensToString('hero token description')).to.equal('hero token description');
    });
    it('returns empty for empty input', () => {
        expect(app.tokensToString([])).to.equal('');
        expect(app.tokensToString('')).to.equal('');
        expect(app.tokensToString(undefined)).to.equal('');
    });
});

describe('fragmentAppearanceForVideo regression ($2 artifact)', () => {
    it('never leaks the literal $2 replacement token', () => {
        const r = app.fragmentAppearanceForVideo(
            'Short stature, bald head, and large black-rimmed glasses. His face is well-groomed, with a stern expression.',
            'mikhail_berlioz'
        );
        expect(r).not.to.include('$2');
        expect(r).to.equal('short stature');
    });
});

describe('parseSceneVideoTokens (stage 2 response parsing)', () => {
    const rows = [
        // valid — numeric string scene_index, sanitized features
        { scene_index: '0', tokens: { a: ['tie', '', 'hat'], b: 'plain string' } },
        // dropped: non-integer scene_index
        { scene_index: 1.5, tokens: { a: ['x'] } },
        // dropped: empty tokens map
        { scene_index: 2, tokens: {} },
        // dropped: feature too long/wordy
        { scene_index: '3', tokens: { a: ['a very long feature sentence that goes on and on about nothing at all'] } },
    ];

    it('sanitizes tokens, coerces string scene_index, drops invalid rows', () => {
        const r = pipelineSteps.parseSceneVideoTokens(rows);
        expect(r).to.deep.equal([
            { scene_index: 0, tokens: { a: ['tie', 'hat'] } },
        ]);
    });

    it('returns [] for non-array input', () => {
        expect(pipelineSteps.parseSceneVideoTokens(undefined)).to.deep.equal([]);
        expect(pipelineSteps.parseSceneVideoTokens({})).to.deep.equal([]);
    });
});

describe('buildSceneTokensContext (stage 2 prompt context)', () => {
    const characters = [
        { id: 'a', name: 'A', appearance: 'bald', clothes: 'suit', video_tokens: ['tie'] },
        { id: 'b', name: 'B', appearance: 'beard', clothes: 'coat', video_tokens: ['hat'] },
        { id: 'c', name: 'C', appearance: 'tall' }, // no tokens
    ];

    it('lists only scenes with 2+ token-bearing participants', () => {
        const scenes = [
            { title: 'Duet', participants: ['a', 'b'] },
            { title: 'Solo', participants: ['a'] },
            { title: 'One has no tokens', participants: ['a', 'c'] },
        ];
        const ctx = pipelineSteps.buildSceneTokensContext(scenes, characters);
        expect(ctx).to.include('Scene 0 "Duet":');
        expect(ctx).to.include('- a (A): current_tokens="tie" appearance="bald" clothes="suit"');
        expect(ctx).to.include('- b (B): current_tokens="hat"');
        expect(ctx).not.to.include('Scene 1');
        expect(ctx).not.to.include('Scene 2');
    });

    it('returns None when no scene qualifies', () => {
        const scenes = [{ title: 'Solo', participants: ['a'] }];
        expect(pipelineSteps.buildSceneTokensContext(scenes, characters)).to.equal('None');
        expect(pipelineSteps.buildSceneTokensContext([], characters)).to.equal('None');
    });

    it('prefers scene override tokens over global for the context', () => {
        const scenes = [{ title: 'S', participants: ['a', 'b'], passport: { a: { video_tokens: ['red scarf'] } } }];
        const ctx = pipelineSteps.buildSceneTokensContext(scenes, characters);
        expect(ctx).to.include('current_tokens="red scarf"');
    });
});

describe('applySceneVideoTokens (stage 2 persistence)', () => {
    const characters = [
        { id: 'a', name: 'A', video_tokens: ['tie'] },
        { id: 'b', name: 'B', video_tokens: ['hat'] },
    ];

    it('writes scene.passport override when agent tokens differ from global', () => {
        const scenes = [{ participants: ['a', 'b'] }];
        applySceneVideoTokens(scenes, [
            { scene_index: 0, tokens: { a: ['red scarf'], b: ['hat'] } },
        ], characters);
        // a changed → override written; b unchanged → global still applies (no override)
        expect(scenes[0].passport.a.video_tokens).to.deep.equal(['red scarf']);
        expect(scenes[0].passport.b).to.be.undefined;
    });

    it('does not write when agent tokens equal the global tokens', () => {
        const scenes = [{ participants: ['a', 'b'] }];
        applySceneVideoTokens(scenes, [
            { scene_index: 0, tokens: { a: ['tie'], b: ['hat'] } },
        ], characters);
        expect(scenes[0].passport).to.be.undefined;
    });

    it('merges into existing scene.passport preserving other fields', () => {
        const scenes = [{
            participants: ['a', 'b'],
            passport: { b: { video_tokens: ['x'], appearance: 'keep me' } },
        }];
        applySceneVideoTokens(scenes, [
            { scene_index: 0, tokens: { a: ['red scarf'] } },
        ], characters);
        expect(scenes[0].passport.a.video_tokens).to.deep.equal(['red scarf']);
        expect(scenes[0].passport.b.appearance).to.equal('keep me');
        expect(scenes[0].passport.b.video_tokens).to.deep.equal(['x']);
    });

    it('ignores tokens for characters that are not scene participants', () => {
        const scenes = [{ participants: ['a'] }];
        applySceneVideoTokens(scenes, [
            { scene_index: 0, tokens: { z: ['intruder'], a: ['red scarf'] } },
        ], characters);
        expect(scenes[0].passport.z).to.be.undefined;
        expect(scenes[0].passport.a.video_tokens).to.deep.equal(['red scarf']);
    });

    it('keeps an existing scene override as the current value (no downgrade)', () => {
        const scenes = [{
            participants: ['a', 'b'],
            passport: { a: { video_tokens: ['scarf'] } },
        }];
        applySceneVideoTokens(scenes, [
            { scene_index: 0, tokens: { a: ['scarf'] } },
        ], characters);
        // unchanged — no write, but the existing override stays
        expect(scenes[0].passport.a.video_tokens).to.deep.equal(['scarf']);
    });

    it('does nothing for empty rows or unknown scene indexes', () => {
        const scenes = [{ participants: ['a', 'b'] }];
        applySceneVideoTokens(scenes, [], characters);
        applySceneVideoTokens(scenes, [{ scene_index: 7, tokens: { a: ['x'] } }], characters);
        expect(scenes[0].passport).to.be.undefined;
    });
});

describe('buildCharLines duplicate guard (order-insensitive)', () => {
    it('treats the same feature set in different order as a collision', () => {
        const book = {
            characters: [
                { id: 'a', name: 'A', passport: { video_tokens: ['tie', 'red jacket'] } },
                { id: 'b', name: 'B', passport: { video_tokens: ['blue shirt'] } },
            ],
        };
        const scene = {
            passport: {
                a: { video_tokens: ['tie', 'red jacket'] },
                b: { video_tokens: ['red jacket', 'tie'] }, // same set, different order
            },
        };
        const lines = wf.buildCharLines(['a', 'b'], book, scene);
        // a keeps its scene override; b falls back to its global token
        expect(lines).to.deep.equal(['A: tie, red jacket', 'B: blue shirt']);
    });
});
