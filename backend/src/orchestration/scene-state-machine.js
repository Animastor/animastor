const state = require('../state');

const Stage = {
    AUDIO: 'audio',
    IMAGE: 'image',
    VIDEO: 'video'
};

function determineNextStage(currentState, videoAvailable = true) {
    const stateName = currentState.state;

    if (stateName === state.SceneState.NEW) {
        return { stage: Stage.AUDIO, reason: 'new_scene' };
    }
    if (stateName === state.SceneState.AUDIO_PENDING) {
        return { stage: Stage.AUDIO, reason: 'first_stage' };
    }
    if (stateName === state.SceneState.AUDIO_READY) {
        return { stage: Stage.IMAGE, reason: 'audio_ready' };
    }
    if (stateName === state.SceneState.IMAGE_PENDING) {
        return { stage: Stage.IMAGE, reason: 'image_pending' };
    }
    if (stateName === state.SceneState.IMAGE_READY) {
        if (!videoAvailable) {
            return { stage: null, reason: 'no_video_worker' };
        }
        return { stage: Stage.VIDEO, reason: 'image_ready' };
    }
    return { stage: null, reason: 'no_progression' };
}

module.exports = { Stage, determineNextStage };
