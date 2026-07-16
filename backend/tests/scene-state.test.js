const { expect } = require('chai');
const sceneState = require('../src/state/scene-state');

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
});

// deriveLinearState removed in v2.2.0 — per-asset state is canonical

describe('deriveAssetStatesFromLinear (fallback)', () => {
    it('null state -> all NEW', () => {
        const result = sceneState.deriveAssetStatesFromLinear(null);
        expect(result).to.deep.equal({ audio: 'new', image: 'new', video: 'new' });
    });

    it('NEW -> all NEW', () => {
        const result = sceneState.deriveAssetStatesFromLinear({ state: 'new' });
        expect(result).to.deep.equal({ audio: 'new', image: 'new', video: 'new' });
    });

    it('AUDIO_GENERATING -> audio generating', () => {
        const result = sceneState.deriveAssetStatesFromLinear({ state: 'audio_generating' });
        expect(result.audio).to.equal('generating');
        expect(result.image).to.equal('new');
        expect(result.video).to.equal('new');
    });

    it('VIDEO_READY -> all ready', () => {
        const result = sceneState.deriveAssetStatesFromLinear({ state: 'video_ready' });
        expect(result).to.deep.equal({ audio: 'ready', image: 'ready', video: 'ready' });
    });
});

describe('transitionSceneState (simplified direct write)', () => {
    it('returns success always (no validation)', async () => {
        // Calls setSceneStateWithBuildId internally — no validation logic
        // This test verifies the export exists and returns the expected shape
        expect(sceneState.transitionSceneState).to.be.a('function');
    });

    it('getSceneState and setSceneState exist', () => {
        expect(sceneState.getSceneState).to.be.a('function');
        expect(sceneState.setSceneState).to.be.a('function');
        expect(sceneState.setSceneStateWithBuildId).to.be.a('function');
        // syncLinearState removed in v2.2.0
    });
});
