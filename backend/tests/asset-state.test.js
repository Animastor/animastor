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

    describe('deriveLinearState (asset -> linear, backward compat)', () => {
        it('all READY -> VIDEO_READY', () => {
            expect(sceneState.deriveLinearState({ audio: 'ready', image: 'ready', video: 'ready' }))
                .to.equal('video_ready');
        });

        it('audio=DIRTY, image=READY, video=READY -> AUDIO_PENDING', () => {
            expect(sceneState.deriveLinearState({ audio: 'dirty', image: 'ready', video: 'ready' }))
                .to.equal('audio_pending');
        });

        it('audio=READY, image=DIRTY, video=DIRTY -> IMAGE_PENDING (selective regen)', () => {
            expect(sceneState.deriveLinearState({ audio: 'ready', image: 'dirty', video: 'dirty' }))
                .to.equal('image_pending');
        });

        it('audio=READY, image=READY, video=DIRTY -> VIDEO_PENDING (video-only regen)', () => {
            expect(sceneState.deriveLinearState({ audio: 'ready', image: 'ready', video: 'dirty' }))
                .to.equal('video_pending');
        });

        it('audio=READY, image=PENDING, video=NEW -> IMAGE_PENDING', () => {
            expect(sceneState.deriveLinearState({ audio: 'ready', image: 'pending', video: 'new' }))
                .to.equal('image_pending');
        });

        it('audio=READY, image=GENERATING, video=NEW -> IMAGE_GENERATING', () => {
            expect(sceneState.deriveLinearState({ audio: 'ready', image: 'generating', video: 'new' }))
                .to.equal('image_generating');
        });

        it('any FAILED -> FAILED', () => {
            expect(sceneState.deriveLinearState({ audio: 'failed', image: 'ready', video: 'ready' }))
                .to.equal('failed');
            expect(sceneState.deriveLinearState({ audio: 'ready', image: 'failed', video: 'ready' }))
                .to.equal('failed');
            expect(sceneState.deriveLinearState({ audio: 'ready', image: 'ready', video: 'failed' }))
                .to.equal('failed');
        });

        it('all NEW -> NEW', () => {
            expect(sceneState.deriveLinearState({ audio: 'new', image: 'new', video: 'new' }))
                .to.equal('new');
        });

        it('audio=placeholder, image=new -> AUDIO_READY', () => {
            expect(sceneState.deriveLinearState({ audio: 'placeholder', image: 'new', video: 'new' }))
                .to.equal('audio_ready');
        });

        it('audio=placeholder, image=pending -> IMAGE_PENDING', () => {
            expect(sceneState.deriveLinearState({ audio: 'placeholder', image: 'pending', video: 'new' }))
                .to.equal('image_pending');
        });

        it('audio=placeholder, image=ready -> IMAGE_READY', () => {
            expect(sceneState.deriveLinearState({ audio: 'placeholder', image: 'ready', video: 'new' }))
                .to.equal('image_ready');
        });
    });
});
