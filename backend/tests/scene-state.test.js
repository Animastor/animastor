const { expect } = require('chai');
const sceneState = require('../src/state/scene-state');

describe('SceneState', () => {
    it('has all 11 states defined', () => {
        const expected = [
            'NEW', 'AUDIO_PENDING', 'AUDIO_GENERATING', 'AUDIO_READY',
            'IMAGE_PENDING', 'IMAGE_GENERATING', 'IMAGE_READY',
            'VIDEO_PENDING', 'VIDEO_GENERATING', 'VIDEO_READY', 'FAILED',
        ];
        const actual = Object.keys(sceneState.SceneState);
        expect(actual).to.have.members(expected);
    });

    it('every state has transitions defined', () => {
        for (const [state, transitions] of Object.entries(sceneState.SceneTransitions)) {
            expect(transitions).to.be.an('array');
        }
    });

    it('NOOP transitions return same_state', () => {
        const result = sceneState.validateTransition('audio_pending', 'audio_pending');
        expect(result.valid).to.be.true;
        expect(result.reason).to.equal('same_state');
    });

    it('validates NEW -> AUDIO_PENDING', () => {
        const result = sceneState.validateTransition('new', 'audio_pending');
        expect(result.valid).to.be.true;
    });

    it('rejects NEW -> VIDEO_READY (skip pipeline)', () => {
        const result = sceneState.validateTransition('new', 'video_ready');
        expect(result.valid).to.be.false;
        expect(result.reason).to.equal('invalid_transition');
    });

    it('pipeline is linear forward-only', () => {
        const pipeline = [
            ['new', 'audio_pending'],
            ['new', 'image_pending'],  // bypass audio
            ['audio_pending', 'audio_generating'],
            ['audio_generating', 'audio_ready'],
            ['audio_ready', 'image_pending'],
            ['image_pending', 'image_generating'],
            ['image_generating', 'image_ready'],
            ['image_ready', 'video_pending'],
            ['video_pending', 'video_generating'],
            ['video_generating', 'video_ready'],
        ];
        for (const [from, to] of pipeline) {
            expect(sceneState.isValidTransition(from, to), `${from} -> ${to}`).to.be.true;
        }
    });

    it('FAILED can retry any pending stage', () => {
        expect(sceneState.isValidTransition('failed', 'audio_pending')).to.be.true;
        expect(sceneState.isValidTransition('failed', 'image_pending')).to.be.true;
        expect(sceneState.isValidTransition('failed', 'video_pending')).to.be.true;
    });

    it('no backward transitions allowed', () => {
        const backward = [
            ['audio_ready', 'audio_generating'],
            ['audio_generating', 'audio_pending'],
            ['image_ready', 'image_generating'],
            ['video_ready', 'video_generating'],
        ];
        for (const [from, to] of backward) {
            expect(sceneState.isValidTransition(from, to), `${from} -> ${to}`).to.be.false;
        }
    });
});

describe('SceneState helpers', () => {
    it('isValidTransition returns false for unknown states', () => {
        expect(sceneState.isValidTransition('nonexistent', 'new')).to.be.false;
    });

    it('validateTransition returns allowed transitions on invalid', () => {
        const result = sceneState.validateTransition('new', 'video_ready');
        expect(result.allowed).to.deep.equal(['audio_pending', 'image_pending']);
    });

    it('getRecoveryPendingState maps _GENERATING back to _PENDING', () => {
        expect(sceneState.getRecoveryPendingState('audio_generating')).to.equal('audio_pending');
        expect(sceneState.getRecoveryPendingState('image_generating')).to.equal('image_pending');
        expect(sceneState.getRecoveryPendingState('video_generating')).to.equal('video_pending');
    });

    it('getRecoveryPendingState keeps _PENDING as-is', () => {
        expect(sceneState.getRecoveryPendingState('audio_pending')).to.equal('audio_pending');
        expect(sceneState.getRecoveryPendingState('image_pending')).to.equal('image_pending');
        expect(sceneState.getRecoveryPendingState('video_pending')).to.equal('video_pending');
    });

    it('getRecoveryPendingState returns undefined for terminal states', () => {
        expect(sceneState.getRecoveryPendingState('video_ready')).to.be.undefined;
        expect(sceneState.getRecoveryPendingState('failed')).to.be.undefined;
        expect(sceneState.getRecoveryPendingState('new')).to.be.undefined;
    });
});
