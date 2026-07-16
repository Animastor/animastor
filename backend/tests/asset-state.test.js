const { expect } = require('chai');
const sceneState = require('../src/state/scene-state');

describe('AssetState (v2.0.0 per-asset model)', () => {
    it('has 7 asset states defined', () => {
        const expected = ['NEW', 'DIRTY', 'PENDING', 'GENERATING', 'READY', 'FAILED', 'PLACEHOLDER'];
        const actual = Object.keys(sceneState.AssetState);
        expect(actual).to.have.members(expected);
    });

    it('has 3 asset types', () => {
        expect(sceneState.ASSETS).to.deep.equal(['audio', 'image', 'video']);
    });

    describe('validateAssetTransition', () => {
        it('NEW -> DIRTY is valid', () => {
            const result = sceneState.validateAssetTransition('new', 'dirty');
            expect(result.valid).to.be.true;
        });

        it('NEW -> PENDING is valid', () => {
            const result = sceneState.validateAssetTransition('new', 'pending');
            expect(result.valid).to.be.true;
        });

        it('NEW -> READY is invalid (skips pipeline)', () => {
            const result = sceneState.validateAssetTransition('new', 'ready');
            expect(result.valid).to.be.false;
            expect(result.reason).to.equal('invalid_asset_transition');
        });

        it('READY -> DIRTY is valid (selective regeneration)', () => {
            const result = sceneState.validateAssetTransition('ready', 'dirty');
            expect(result.valid).to.be.true;
        });

        it('PENDING -> GENERATING is valid', () => {
            const result = sceneState.validateAssetTransition('pending', 'generating');
            expect(result.valid).to.be.true;
        });

        it('GENERATING -> READY is valid', () => {
            const result = sceneState.validateAssetTransition('generating', 'ready');
            expect(result.valid).to.be.true;
        });

        it('GENERATING -> FAILED is valid', () => {
            const result = sceneState.validateAssetTransition('generating', 'failed');
            expect(result.valid).to.be.true;
        });

        it('FAILED -> PENDING is valid (retry)', () => {
            const result = sceneState.validateAssetTransition('failed', 'pending');
            expect(result.valid).to.be.true;
        });

        it('FAILED -> DIRTY is valid (re-mark)', () => {
            const result = sceneState.validateAssetTransition('failed', 'dirty');
            expect(result.valid).to.be.true;
        });

        it('NEW -> PLACEHOLDER is valid', () => {
            const result = sceneState.validateAssetTransition('new', 'placeholder');
            expect(result.valid).to.be.true;
        });

        it('PLACEHOLDER -> DIRTY is valid (re-generate)', () => {
            const result = sceneState.validateAssetTransition('placeholder', 'dirty');
            expect(result.valid).to.be.true;
        });

        it('PLACEHOLDER -> GENERATING is valid (upgrade to real)', () => {
            const result = sceneState.validateAssetTransition('placeholder', 'generating');
            expect(result.valid).to.be.true;
        });

        it('DIRTY -> GENERATING is invalid (must go through PENDING)', () => {
            const result = sceneState.validateAssetTransition('dirty', 'generating');
            expect(result.valid).to.be.false;
        });

        it('GENERATING -> GENERATING returns same_state', () => {
            const result = sceneState.validateAssetTransition('generating', 'generating');
            expect(result.valid).to.be.true;
            expect(result.reason).to.equal('same_state');
        });
    });

    describe('deriveAssetStatesFromLinear (backward compat)', () => {
        it('null state -> all NEW', () => {
            const result = sceneState.deriveAssetStatesFromLinear(null);
            expect(result).to.deep.equal({ audio: 'new', image: 'new', video: 'new' });
        });

        it('VIDEO_READY -> all READY', () => {
            const result = sceneState.deriveAssetStatesFromLinear({ state: 'video_ready' });
            expect(result).to.deep.equal({ audio: 'ready', image: 'ready', video: 'ready' });
        });

        it('AUDIO_PENDING -> audio=PENDING, rest=NEW', () => {
            const result = sceneState.deriveAssetStatesFromLinear({ state: 'audio_pending' });
            expect(result).to.deep.equal({ audio: 'pending', image: 'new', video: 'new' });
        });

        it('AUDIO_GENERATING -> audio=GENERATING, rest=NEW', () => {
            const result = sceneState.deriveAssetStatesFromLinear({ state: 'audio_generating' });
            expect(result).to.deep.equal({ audio: 'generating', image: 'new', video: 'new' });
        });

        it('IMAGE_PENDING -> audio=READY, image=PENDING, video=NEW', () => {
            const result = sceneState.deriveAssetStatesFromLinear({ state: 'image_pending' });
            expect(result).to.deep.equal({ audio: 'ready', image: 'pending', video: 'new' });
        });

        it('IMAGE_READY -> audio=READY, image=READY, video=NEW', () => {
            const result = sceneState.deriveAssetStatesFromLinear({ state: 'image_ready' });
            expect(result).to.deep.equal({ audio: 'ready', image: 'ready', video: 'new' });
        });

        it('VIDEO_PENDING -> audio=READY, image=READY, video=PENDING', () => {
            const result = sceneState.deriveAssetStatesFromLinear({ state: 'video_pending' });
            expect(result).to.deep.equal({ audio: 'ready', image: 'ready', video: 'pending' });
        });

        it('VIDEO_GENERATING -> audio=READY, image=READY, video=GENERATING', () => {
            const result = sceneState.deriveAssetStatesFromLinear({ state: 'video_generating' });
            expect(result).to.deep.equal({ audio: 'ready', image: 'ready', video: 'generating' });
        });
    });

    // deriveLinearState removed in v2.2.0 — per-asset state is canonical
});
