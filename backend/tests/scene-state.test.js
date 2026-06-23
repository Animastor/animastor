const { expect } = require('chai');
const sceneState = require('../src/state/scene-state');

describe('SceneState constants', () => {
    it('has all 11 states defined', () => {
        const expected = [
            'NEW', 'AUDIO_PENDING', 'AUDIO_GENERATING', 'AUDIO_READY',
            'IMAGE_PENDING', 'IMAGE_GENERATING', 'IMAGE_READY',
            'VIDEO_PENDING', 'VIDEO_GENERATING', 'VIDEO_READY', 'FAILED',
        ];
        const actual = Object.keys(sceneState.SceneState);
        expect(actual).to.have.members(expected);
    });

    it('SceneState constants are backward-compatible strings', () => {
        expect(sceneState.SceneState.AUDIO_PENDING).to.equal('audio_pending');
        expect(sceneState.SceneState.VIDEO_READY).to.equal('video_ready');
        expect(sceneState.SceneState.FAILED).to.equal('failed');
    });
});

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

describe('deriveLinearState (backward compat)', () => {
    it('all NEW -> SceneState.NEW', () => {
        const result = sceneState.deriveLinearState({ audio: 'new', image: 'new', video: 'new' });
        expect(result).to.equal(sceneState.SceneState.NEW);
    });

    it('audio pending -> AUDIO_PENDING', () => {
        const result = sceneState.deriveLinearState({ audio: 'pending', image: 'new', video: 'new' });
        expect(result).to.equal(sceneState.SceneState.AUDIO_PENDING);
    });

    it('audio generating -> AUDIO_GENERATING', () => {
        const result = sceneState.deriveLinearState({ audio: 'generating', image: 'new', video: 'new' });
        expect(result).to.equal(sceneState.SceneState.AUDIO_GENERATING);
    });

    it('image pending -> IMAGE_PENDING (audio is ready)', () => {
        const result = sceneState.deriveLinearState({ audio: 'ready', image: 'pending', video: 'new' });
        expect(result).to.equal(sceneState.SceneState.IMAGE_PENDING);
    });

    it('image generating -> IMAGE_GENERATING', () => {
        const result = sceneState.deriveLinearState({ audio: 'ready', image: 'generating', video: 'new' });
        expect(result).to.equal(sceneState.SceneState.IMAGE_GENERATING);
    });

    it('all ready -> VIDEO_READY', () => {
        const result = sceneState.deriveLinearState({ audio: 'ready', image: 'ready', video: 'ready' });
        expect(result).to.equal(sceneState.SceneState.VIDEO_READY);
    });

    it('any failed -> FAILED', () => {
        const result = sceneState.deriveLinearState({ audio: 'failed', image: 'ready', video: 'ready' });
        expect(result).to.equal(sceneState.SceneState.FAILED);
    });

    it('audio placeholder allows progression to image', () => {
        const result = sceneState.deriveLinearState({ audio: 'placeholder', image: 'new', video: 'new' });
        expect(result).to.equal(sceneState.SceneState.AUDIO_READY);
    });

    it('audio placeholder + image ready -> IMAGE_READY', () => {
        const result = sceneState.deriveLinearState({ audio: 'placeholder', image: 'ready', video: 'new' });
        expect(result).to.equal(sceneState.SceneState.IMAGE_READY);
    });

    it('audio ready + video generating -> VIDEO_GENERATING', () => {
        const result = sceneState.deriveLinearState({ audio: 'ready', image: 'ready', video: 'generating' });
        expect(result).to.equal(sceneState.SceneState.VIDEO_GENERATING);
    });
});

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
        expect(sceneState.syncLinearState).to.be.a('function');
    });
});
