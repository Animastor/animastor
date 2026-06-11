// ======================================================
// Stage Definitions - v1.0.0
// ======================================================
// Defines all valid scene stages and their properties.
// This is the single source of truth for stage semantics.

// ======================================================
// STAGE CATEGORIES
// ======================================================

const StageCategory = {
    // Initial/queued state
    PENDING: 'pending',
    // Asset preparation states
    PREPARING: 'preparing',
    PREPARING_IMAGE: 'preparing_image',
    PREPARING_VIDEO: 'preparing_video',
    // Asset ready states
    IMAGE_READY: 'image_ready',
    VIDEO_READY: 'video_ready',
    // Finalization states
    FINALIZING: 'finalizing',
    // Terminal states
    COMPLETED: 'completed',
    FAILED: 'failed',
    // Recovery states
    RECOVERING: 'recovering',
    RETRYING: 'retrying'
};

// ======================================================
// STAGE PROPERTIES
// ======================================================

const Stages = {
    // Initial state - scene queued for processing
    [StageCategory.PENDING]: {
        name: StageCategory.PENDING,
        category: 'initial',
        description: 'Scene is queued and waiting for processing',
        validTransitions: [
            StageCategory.PREPARING,
            StageCategory.FAILED,
            StageCategory.RECOVERING
        ],
        requiresAssets: [],
        allowsDispatch: false,
        isTerminal: false,
        isRetryable: true,
        recoveryTransition: StageCategory.PENDING,
        retryTransition: StageCategory.RETRYING
    },

    // Audio preparation state
    [StageCategory.PREPARING]: {
        name: StageCategory.PREPARING,
        category: 'preparing',
        description: 'Scene audio asset is being generated',
        validTransitions: [
            StageCategory.PREPARING_IMAGE,
            StageCategory.PREPARING_VIDEO,
            StageCategory.FAILED,
            StageCategory.RETRYING
        ],
        requiresAssets: [],
        allowsDispatch: false,
        isTerminal: false,
        isRetryable: true,
        recoveryTransition: StageCategory.PENDING,
        retryTransition: StageCategory.RETRYING
    },

    // Image preparation state
    [StageCategory.PREPARING_IMAGE]: {
        name: StageCategory.PREPARING_IMAGE,
        category: 'preparing',
        description: 'Scene image asset is being generated',
        validTransitions: [
            StageCategory.IMAGE_READY,
            StageCategory.FAILED,
            StageCategory.RETRYING
        ],
        requiresAssets: ['audio'],  // Audio must exist or be pending
        allowsDispatch: false,
        isTerminal: false,
        isRetryable: true,
        recoveryTransition: StageCategory.PENDING,
        retryTransition: StageCategory.PREPARING_IMAGE
    },

    // Video preparation state
    [StageCategory.PREPARING_VIDEO]: {
        name: StageCategory.PREPARING_VIDEO,
        category: 'preparing',
        description: 'Scene video asset is being generated',
        validTransitions: [
            StageCategory.VIDEO_READY,
            StageCategory.FAILED,
            StageCategory.RETRYING
        ],
        requiresAssets: ['image'],  // Image must be ready
        allowsDispatch: false,
        isTerminal: false,
        isRetryable: true,
        recoveryTransition: StageCategory.PENDING,
        retryTransition: StageCategory.PREPARING_VIDEO
    },

    // Image ready state
    [StageCategory.IMAGE_READY]: {
        name: StageCategory.IMAGE_READY,
        category: 'ready',
        description: 'Scene image asset is ready',
        validTransitions: [
            StageCategory.PREPARING_VIDEO,
            StageCategory.FINALIZING,
            StageCategory.FAILED
        ],
        requiresAssets: ['image'],
        allowsDispatch: false,
        isTerminal: false,
        isRetryable: true,
        recoveryTransition: StageCategory.PENDING,
        retryTransition: StageCategory.PREPARING_IMAGE
    },

    // Video ready state - requires both assets
    [StageCategory.VIDEO_READY]: {
        name: StageCategory.VIDEO_READY,
        category: 'ready',
        description: 'Scene video asset is ready',
        validTransitions: [
            StageCategory.FINALIZING,
            StageCategory.COMPLETED,
            StageCategory.FAILED
        ],
        requiresAssets: ['image', 'video'],
        allowsDispatch: false,
        isTerminal: false,
        isRetryable: false,
        recoveryTransition: StageCategory.FAILED,
        retryTransition: StageCategory.FAILED
    },

    // Finalization state
    [StageCategory.FINALIZING]: {
        name: StageCategory.FINALIZING,
        category: 'finalization',
        description: 'Scene finalization (cleanup, metadata)',
        validTransitions: [
            StageCategory.COMPLETED,
            StageCategory.FAILED
        ],
        requiresAssets: ['image', 'video'],
        allowsDispatch: false,
        isTerminal: false,
        isRetryable: false,
        recoveryTransition: StageCategory.FAILED,
        retryTransition: StageCategory.FAILED
    },

    // Success terminal state
    [StageCategory.COMPLETED]: {
        name: StageCategory.COMPLETED,
        category: 'terminal',
        description: 'Scene processing completed successfully',
        validTransitions: [],
        requiresAssets: ['image', 'video'],
        allowsDispatch: false,
        isTerminal: true,
        isRetryable: false,
        recoveryTransition: null,
        retryTransition: null
    },

    // Failure terminal state
    [StageCategory.FAILED]: {
        name: StageCategory.FAILED,
        category: 'terminal',
        description: 'Scene processing failed permanently',
        validTransitions: [],
        requiresAssets: [],
        allowsDispatch: false,
        isTerminal: true,
        isRetryable: false,
        recoveryTransition: StageCategory.PENDING,
        retryTransition: StageCategory.FAILED
    },

    // Recovery state - for stuck scenes
    [StageCategory.RECOVERING]: {
        name: StageCategory.RECOVERING,
        category: 'recovery',
        description: 'Scene is being recovered from stuck state',
        validTransitions: [
            StageCategory.PENDING,
            StageCategory.PREPARING,
            StageCategory.FAILED
        ],
        requiresAssets: [],
        allowsDispatch: false,
        isTerminal: false,
        isRetryable: true,
        recoveryTransition: StageCategory.PENDING,
        retryTransition: StageCategory.PENDING
    },

    // Retry state - for retryable failures
    [StageCategory.RETRYING]: {
        name: StageCategory.RETRYING,
        category: 'retry',
        description: 'Scene is being retried after failure',
        validTransitions: [
            StageCategory.PENDING,
            StageCategory.PREPARING,
            StageCategory.PREPARING_IMAGE,
            StageCategory.PREPARING_VIDEO,
            StageCategory.IMAGE_READY,
            StageCategory.VIDEO_READY,
            StageCategory.FAILED
        ],
        requiresAssets: [],
        allowsDispatch: false,
        isTerminal: false,
        isRetryable: true,
        recoveryTransition: StageCategory.PENDING,
        retryTransition: StageCategory.RETRYING
    }
};

// ======================================================
// STAGE SEQUENCE (linear progression)
// ======================================================

const StageSequence = [
    StageCategory.PENDING,
    StageCategory.PREPARING,
    StageCategory.PREPARING_IMAGE,
    StageCategory.IMAGE_READY,
    StageCategory.PREPARING_VIDEO,
    StageCategory.VIDEO_READY,
    StageCategory.FINALIZING,
    StageCategory.COMPLETED
];

// ======================================================
// STATE TRANSITION VALIDATOR
// ======================================================

/**
 * Check if a state transition is valid according to state graph.
 */
function isValidTransition(fromStage, toStage) {
    const fromDef = Stages[fromStage];
    if (!fromDef) {
        return { valid: false, reason: `Invalid from stage: ${fromStage}` };
    }

    if (fromDef.isTerminal) {
        return { valid: false, reason: `Cannot transition from terminal state: ${fromStage}` };
    }

    if (!fromDef.validTransitions.includes(toStage)) {
        return { valid: false, reason: `Transition ${fromStage} → ${toStage} not allowed` };
    }

    // Check asset requirements for target stage
    const toDef = Stages[toStage];
    const missingAssets = toDef.requiresAssets.filter(asset => asset !== 'image' && asset !== 'video');

    return { valid: true, reason: null, missingAssets };
}

/**
 * Get all possible next states from current stage.
 */
function getNextStates(stage) {
    const def = Stages[stage];
    if (!def) return [];
    return def.validTransitions;
}

/**
 * Get the expected stage sequence index.
 */
function getStageIndex(stage) {
    return StageSequence.indexOf(stage);
}

/**
 * Check if stage progression is sequential.
 */
function isSequentialProgression(fromStage, toStage) {
    const fromIdx = getStageIndex(fromStage);
    const toIdx = getStageIndex(toStage);

    if (fromIdx === -1 || toIdx === -1) {
        return false;
    }

    // Allow same stage (retry)
    if (fromIdx === toIdx) return true;

    // Forward progression only
    return toIdx > fromIdx;
}

// ======================================================
// STAGE UTILITIES
// ======================================================

/**
 * Check if stage is terminal.
 */
function isTerminalStage(stage) {
    const def = Stages[stage];
    return def ? def.isTerminal : false;
}

/**
 * Check if stage is retryable.
 */
function isRetryableStage(stage) {
    const def = Stages[stage];
    return def ? def.isRetryable : false;
}

/**
 * Get recovery transition for a stage.
 */
function getRecoveryTransition(stage) {
    const def = Stages[stage];
    return def ? def.recoveryTransition : null;
}

/**
 * Get retry transition for a stage.
 */
function getRetryTransition(stage) {
    const def = Stages[stage];
    return def ? def.retryTransition : null;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    StageCategory,
    Stages,
    StageSequence,
    isValidTransition,
    getNextStates,
    getStageIndex,
    isSequentialProgression,
    isTerminalStage,
    isRetryableStage,
    getRecoveryTransition,
    getRetryTransition
};
