const { expect } = require('chai');
const sceneState = require('../src/state/scene-state');
const { createMockRedis } = require('./mocks/redis-mock');

// SceneState enum removed in v2.2.0 — inline strings used instead

describe('AssetState (per-asset) — source of truth', () => {
    it('has all states defined', () => {
        const expected = ['NEW', 'DIRTY', 'PENDING', 'GENERATING', 'READY', 'FAILED', 'PLACEHOLDER'];
        const actual = Object.keys(sceneState.AssetState);
        expect(actual).to.have.members(expected);
    });

    it('validateAssetTransition rejects invalid transitions', () => {
        const result = sceneState.validateAssetTransition('new', 'ready');
        expect(result.valid).to.be.false;
        expect(result.reason).to.equal('invalid_asset_transition');
    });

    it('validateAssetTransition accepts same state', () => {
        const result = sceneState.validateAssetTransition('ready', 'ready');
        expect(result.valid).to.be.true;
        expect(result.reason).to.equal('same_state');
    });

    it('validateAssetTransition accepts NEW → PENDING', () => {
        expect(sceneState.validateAssetTransition('new', 'pending').valid).to.be.true;
    });

    it('validateAssetTransition accepts NEW → DIRTY', () => {
        expect(sceneState.validateAssetTransition('new', 'dirty').valid).to.be.true;
    });

    it('validateAssetTransition accepts PENDING → GENERATING', () => {
        expect(sceneState.validateAssetTransition('pending', 'generating').valid).to.be.true;
    });

    it('validateAssetTransition accepts GENERATING → READY', () => {
        expect(sceneState.validateAssetTransition('generating', 'ready').valid).to.be.true;
    });

    it('validateAssetTransition accepts READY → DIRTY (regeneration)', () => {
        expect(sceneState.validateAssetTransition('ready', 'dirty').valid).to.be.true;
    });

    it('setAssetState rejects an unknown status without writing it', async () => {
        const redis = createMockRedis();
        const result = await sceneState.setAssetState(
            redis, 'book', 'chapter', 'scene', 'audio', 'finished'
        );
        expect(result).to.equal(null);
        expect(await sceneState.getAssetStates(redis, 'book', 'chapter', 'scene'))
            .to.deep.equal({ audio: 'new', image: 'new', video: 'new' });
    });

    it('setAssetStates rejects unknown assets atomically', async () => {
        const redis = createMockRedis();
        const result = await sceneState.setAssetStates(
            redis,
            'book',
            'chapter',
            'scene',
            { audio: 'ready', music: 'ready' }
        );
        expect(result).to.equal(null);
        expect(await sceneState.getAssetStates(redis, 'book', 'chapter', 'scene'))
            .to.deep.equal({ audio: 'new', image: 'new', video: 'new' });
    });
});

// deriveLinearState removed in v2.2.0 — per-asset state is canonical
// deriveAssetStatesFromLinear, transitionSceneState, getSceneState, setSceneState removed in v3.0.0
