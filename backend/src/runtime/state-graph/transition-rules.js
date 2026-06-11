// ======================================================
// Transition Rules - v1.0.0
// ======================================================
// Each transition declares its requirements, side effects, and invariants.
// State graph is the single authority for transition validity.

const Stage = require('./stage-definitions');

// ======================================================
// TRANSITION TYPES
// ======================================================

const TransitionType = {
    // Initial scheduling
    SCHEDULE: 'schedule',
    // Asset generation progression
    GENERATE_AUDIO: 'generate_audio',
    GENERATE_IMAGE: 'generate_image',
    GENERATE_VIDEO: 'generate_video',
    // Completion transitions
    COMPLETE_IMAGE: 'complete_image',
    COMPLETE_VIDEO: 'complete_video',
    COMPLETE_SCENE: 'complete_scene',
    // Failure handling
    FAIL: 'fail',
    RETRY: 'retry',
    RECOVER: 'recover',
    // Recovery transitions
    RECOVER_TO_PENDING: 'recover_to_pending',
    RECOVER_TO_PREPARING: 'recover_to_preparing',
    // State downgrades (for recovery)
    DOWNGRADE: 'downgrade'
};

// ======================================================
// TRANSITION CONTRACTS
// ======================================================

/**
 * Base transition contract template.
 * All transitions must declare:
 * - from: source stage(s)
 * - to: target stage
 * - requiredAssets: assets that must exist
 * - requiredLeases: lease requirements
 * - invariants: invariants that must hold
 * - sideEffects: what changes as a result
 */
const TransitionContracts = {
    // --------------------------------------------------
    // INITIAL SCHEDULING
    // --------------------------------------------------

    [TransitionType.SCHEDULE]: {
        type: TransitionType.SCHEDULE,
        from: Stage.StageCategory.PENDING,
        to: Stage.StageCategory.PREPARING,
        description: 'Scene scheduled for audio processing',
        requiredAssets: [],
        requiredLeases: [],
        invariants: [
            {
                category: Stage.StageCategory.PENDING,
                check: 'scene_exists',
                description: 'Scene must exist in registry'
            },
            {
                category: 'governance',
                check: 'admission_allowed',
                description: 'Scene admission must be allowed'
            },
            {
                category: 'fairness',
                check: 'not_overloaded',
                description: 'Runtime not overloaded for this book'
            }
        ],
        sideEffects: [
            'lease acquired for audio stage',
            'dispatch metadata recorded',
            'counter incremented',
            'event journal entry created'
        ],
        allowedOverrides: ['safety_override', 'recovery_override'],
        minDelay: 0,
        maxRetries: Stage.Stages[Stage.StageCategory.PENDING].isRetryable ? 10 : 0
    },

    // --------------------------------------------------
    // AUDIO GENERATION
    // --------------------------------------------------

    [TransitionType.GENERATE_AUDIO]: {
        type: TransitionType.GENERATE_AUDIO,
        from: Stage.StageCategory.PREPARING,
        to: Stage.StageCategory.PREPARING_IMAGE,
        description: 'Audio generation completed, moving to image prep',
        requiredAssets: ['audio'],
        requiredLeases: [
            { stage: 'audio', optional: false },
            { stage: 'image', optional: true }
        ],
        invariants: [
            {
                category: 'lifecycle',
                check: 'sequential_progression',
                description: 'Must progress sequentially through stages'
            },
            {
                category: 'lease',
                check: 'valid_lease_ownership',
                description: 'Dispatch owner must hold valid lease'
            },
            {
                category: 'dispatch',
                check: 'within_quota',
                description: 'Dispatch must not exceed quota'
            }
        ],
        sideEffects: [
            'audio duration recorded',
            'lease released for audio',
            'new lease acquired for image',
            'dispatch metadata updated'
        ],
        allowedOverrides: [],
        minDelay: 0,
        maxRetries: Stage.Stages[Stage.StageCategory.PREPARING].isRetryable ? 3 : 0
    },

    // --------------------------------------------------
    // IMAGE GENERATION
    // --------------------------------------------------

    [TransitionType.GENERATE_IMAGE]: {
        type: TransitionType.GENERATE_IMAGE,
        from: Stage.StageCategory.PREPARING_IMAGE,
        to: Stage.StageCategory.IMAGE_READY,
        description: 'Image generation completed',
        requiredAssets: ['audio', 'image'],
        requiredLeases: [
            { stage: 'image', optional: false }
        ],
        invariants: [
            {
                category: 'lifecycle',
                check: 'image_asset_exists',
                description: 'Image asset must exist'
            },
            {
                category: 'lease',
                check: 'lease_not_expired',
                description: 'Image lease must be valid'
            },
            {
                category: 'governance',
                check: 'policy_allowed',
                description: 'Active policy must allow image completion'
            }
        ],
        sideEffects: [
            'image dimensions recorded',
            'image checksum stored',
            'lease released for image',
            'dispatch metadata updated',
            'asset registered'
        ],
        allowedOverrides: [],
        minDelay: 0,
        maxRetries: Stage.Stages[Stage.StageCategory.PREPARING_IMAGE].isRetryable ? 3 : 0
    },

    // --------------------------------------------------
    // VIDEO GENERATION
    // --------------------------------------------------

    [TransitionType.GENERATE_VIDEO]: {
        type: TransitionType.GENERATE_VIDEO,
        from: Stage.StageCategory.IMAGE_READY,
        to: Stage.StageCategory.PREPARING_VIDEO,
        description: 'Image ready, moving to video prep',
        requiredAssets: ['image', 'pending_audio'],
        requiredLeases: [
            { stage: 'video', optional: true }
        ],
        invariants: [
            {
                category: 'lifecycle',
                check: 'image_ready',
                description: 'Image must be ready before video'
            },
            {
                category: 'fairness',
                check: 'video_quota_available',
                description: 'Video quota must be available'
            }
        ],
        sideEffects: [
            'audio merged with image preview',
            'lease acquired for video stage',
            'dispatch metadata updated'
        ],
        allowedOverrides: [],
        minDelay: 0,
        maxRetries: Stage.Stages[Stage.StageCategory.PREPARING_IMAGE].isRetryable ? 3 : 0
    },

    [TransitionType.GENERATE_VIDEO_SEQUENCE]: {
        type: TransitionType.GENERATE_VIDEO_SEQUENCE,
        from: Stage.StageCategory.PREPARING_VIDEO,
        to: Stage.StageCategory.VIDEO_READY,
        description: 'Video generation completed',
        requiredAssets: ['image', 'video'],
        requiredLeases: [
            { stage: 'video', optional: false }
        ],
        invariants: [
            {
                category: 'lifecycle',
                check: 'video_meets_requirements',
                description: 'Video must meet quality and format requirements'
            },
            {
                category: 'lease',
                check: 'video_lease_valid',
                description: 'Video lease must be valid and not expired'
            },
            {
                category: 'retry',
                check: 'retry_budget_available',
                description: 'Retry budget must be available'
            }
        ],
        sideEffects: [
            'video duration recorded',
            'video checksum stored',
            'lease released for video',
            'dispatch metadata finalized',
            'asset registered as complete'
        ],
        allowedOverrides: [],
        minDelay: 0,
        maxRetries: Stage.Stages[Stage.StageCategory.PREPARING_VIDEO].isRetryable ? 2 : 0
    },

    // --------------------------------------------------
    // COMPLETION TRANSITIONS
    // --------------------------------------------------

    [TransitionType.COMPLETE_IMAGE]: {
        type: TransitionType.COMPLETE_IMAGE,
        from: Stage.StageCategory.IMAGE_READY,
        to: Stage.StageCategory.FINALIZING,
        description: 'Image ready, finalizing (no video required)',
        requiredAssets: ['image'],
        requiredLeases: [],
        invariants: [
            {
                category: 'lifecycle',
                check: 'image_exists',
                description: 'Image asset must exist'
            },
            {
                category: 'governance',
                check: 'video_optional_or_optional',
                description: 'Video is optional or not required'
            }
        ],
        sideEffects: [
            'scene marked as image-only',
            'final metadata recorded',
            'asset registered'
        ],
        allowedOverrides: [],
        minDelay: 0,
        maxRetries: 0
    },

    [TransitionType.COMPLETE_VIDEO]: {
        type: TransitionType.COMPLETE_VIDEO,
        from: Stage.StageCategory.VIDEO_READY,
        to: Stage.StageCategory.FINALIZING,
        description: 'Video ready, finalizing',
        requiredAssets: ['image', 'video'],
        requiredLeases: [],
        invariants: [
            {
                category: 'lifecycle',
                check: 'both_assets_exist',
                description: 'Both image and video must exist'
            },
            {
                category: 'dispatch',
                check: 'all_leases_released',
                description: 'All dispatch leases must be released'
            }
        ],
        sideEffects: [
            'final metadata recorded',
            'video metadata stored',
            'scene marked as completed'
        ],
        allowedOverrides: [],
        minDelay: 0,
        maxRetries: 0
    },

    [TransitionType.COMPLETE_SCENE]: {
        type: TransitionType.COMPLETE_SCENE,
        from: Stage.StageCategory.FINALIZING,
        to: Stage.StageCategory.COMPLETED,
        description: 'Scene finalization completed',
        requiredAssets: ['image', 'video'],
        requiredLeases: [],
        invariants: [
            {
                category: 'lifecycle',
                check: 'all_assets_complete',
                description: 'All required assets must be complete'
            },
            {
                category: 'lease',
                check: 'no_active_leases',
                description: 'No active leases remaining'
            },
            {
                category: 'governance',
                check: 'finalization_allowed',
                description: 'Policy allows finalization'
            },
            {
                category: 'retry',
                check: 'no_pending_retries',
                description: 'No pending retries for scene'
            }
        ],
        sideEffects: [
            'scene marked completed',
            'lease counters finalized',
            'metrics recorded',
            'event journal finalized'
        ],
        allowedOverrides: [],
        minDelay: 0,
        maxRetries: 0
    },

    // --------------------------------------------------
    // FAILURE TRANSITIONS
    // --------------------------------------------------

    [TransitionType.FAIL]: {
        type: TransitionType.FAIL,
        from: [
            Stage.StageCategory.PENDING,
            Stage.StageCategory.PREPARING,
            Stage.StageCategory.PREPARING_IMAGE,
            Stage.StageCategory.PREPARING_VIDEO
        ],
        to: Stage.StageCategory.FAILED,
        description: 'Scene failed permanently',
        requiredAssets: [],
        requiredLeases: [],
        invariants: [
            {
                category: 'retry',
                check: 'retry_budget_exhausted',
                description: 'Retry budget must be exhausted'
            },
            {
                category: 'governance',
                check: 'failure_reported',
                description: 'Failure must be reported'
            }
        ],
        sideEffects: [
            'scene marked failed',
            'lease released',
            'retry budget decremented',
            'failure event recorded'
        ],
        allowedOverrides: ['safety_override'],
        minDelay: 0,
        maxRetries: 0
    },

    [TransitionType.RETRY]: {
        type: TransitionType.RETRY,
        from: [
            Stage.StageCategory.PENDING,
            Stage.StageCategory.FAILED
        ],
        to: Stage.StageCategory.PENDING,
        description: 'Scene marked for retry',
        requiredAssets: [],
        requiredLeases: [],
        invariants: [
            {
                category: 'retry',
                check: 'retry_budget_available',
                description: 'Retry budget must be available'
            },
            {
                category: 'governance',
                check: 'retry_allowed',
                description: 'Policy allows retry'
            }
        ],
        sideEffects: [
            'retry counter incremented',
            'backoff delay applied',
            'lease released',
            'retry event recorded'
        ],
        allowedOverrides: [],
        minDelay: 0,
        maxRetries: 10
    },

    // --------------------------------------------------
    // RECOVERY TRANSITIONS
    // --------------------------------------------------

    [TransitionType.RECOVER]: {
        type: TransitionType.RECOVER,
        from: Stage.StageCategory.RECOVERING,
        to: [
            Stage.StageCategory.PENDING,
            Stage.StageCategory.PREPARING
        ],
        description: 'Scene recovered from stuck state',
        requiredAssets: [],
        requiredLeases: [],
        invariants: [
            {
                category: 'lease',
                check: 'stale_lease_released',
                description: 'Stale lease must be released'
            },
            {
                category: 'dispatch',
                check: 'stale_dispatch_cleared',
                description: 'Stale dispatch must be cleared'
            },
            {
                category: 'governance',
                check: 'recovery_allowed',
                description: 'Recovery must be allowed by policy'
            }
        ],
        sideEffects: [
            'stale lease released',
            'stale dispatch lease released',
            'lease counters reconciled',
            'recovery event recorded'
        ],
        allowedOverrides: ['safety_override', 'recovery_override'],
        minDelay: 0,
        maxRetries: 0
    },

    [TransitionType.RECOVER_TO_PENDING]: {
        type: TransitionType.RECOVER_TO_PENDING,
        from: [
            Stage.StageCategory.RECOVERING,
            Stage.StageCategory.PREPARING,
            Stage.StageCategory.PREPARING_IMAGE,
            Stage.StageCategory.PREPARING_VIDEO
        ],
        to: Stage.StageCategory.PENDING,
        description: 'Recover to pending state',
        requiredAssets: [],
        requiredLeases: [],
        invariants: [
            {
                category: 'lifecycle',
                check: 'any_state',
                description: 'Any state can recover to pending'
            },
            {
                category: 'lease',
                check: 'all_leases_released',
                description: 'All leases must be released'
            }
        ],
        sideEffects: [
            'all leases released',
            'stale dispatch released',
            'recovery timestamp recorded'
        ],
        allowedOverrides: ['safety_override', 'recovery_override'],
        minDelay: 0,
        maxRetries: 0
    },

    [TransitionType.RECOVER_TO_PREPARING]: {
        type: TransitionType.RECOVER_TO_PREPARING,
        from: [
            Stage.StageCategory.PREPARING_IMAGE,
            Stage.StageCategory.PREPARING_VIDEO
        ],
        to: Stage.StageCategory.PREPARING,
        description: 'Recover to preparing state',
        requiredAssets: [],
        requiredLeases: [],
        invariants: [
            {
                category: 'lifecycle',
                check: 'preparing_state',
                description: 'Must be in preparing substage'
            },
            {
                category: 'lease',
                check: 'stale_lease_released',
                description: 'Stale lease must be released'
            }
        ],
        sideEffects: [
            'stale lease released',
            'asset metadata cleared',
            'retry counter preserved'
        ],
        allowedOverrides: ['safety_override', 'recovery_override'],
        minDelay: 0,
        maxRetries: 0
    },

    // --------------------------------------------------
    // DOWNGRADE TRANSITIONS (for state correction)
    // --------------------------------------------------

    [TransitionType.DOWNGRADE]: {
        type: TransitionType.DOWNGRADE,
        from: [
            Stage.StageCategory.IMAGE_READY,
            Stage.StageCategory.VIDEO_READY
        ],
        to: Stage.StageCategory.PREPARING,
        description: 'Downgrade to earlier stage',
        requiredAssets: [],
        requiredLeases: [],
        invariants: [
            {
                category: 'lifecycle',
                check: 'allowed_downgrade',
                description: 'Downgrade must be explicitly allowed'
            },
            {
                category: 'lease',
                check: 'new_lease_required',
                description: 'New lease must be acquired'
            }
        ],
        sideEffects: [
            'downgrade counter incremented',
            'new lease acquired',
            'downgrade event recorded'
        ],
        allowedOverrides: ['recovery_override'],
        minDelay: 0,
        maxRetries: 3
    }
};

// ======================================================
// TRANSITION VALIDATOR
// ======================================================

/**
 * Validate a transition against its contract.
 * Returns { valid: boolean, errors: string[] }
 */
function validateTransition(fromStage, toStage, context = {}) {
    const errors = [];

    // Check if source stage exists
    if (!Stage.Stages[fromStage]) {
        errors.push(`Invalid source stage: ${fromStage}`);
        return { valid: false, errors };
    }

    // Check if target stage is valid for source
    const sourceDef = Stage.Stages[fromStage];
    if (!sourceDef.validTransitions.includes(toStage)) {
        errors.push(`Transition ${fromStage} → ${toStage} not allowed by state graph`);
        return { valid: false, errors };
    }

    // Get transition contract
    let contract = null;
    for (const [type, c] of Object.entries(TransitionContracts)) {
        const fromMatches = Array.isArray(c.from) ? c.from.includes(fromStage) : c.from === fromStage;
        if (fromMatches && c.to === toStage) {
            contract = c;
            break;
        }
    }

    // Check invariants
    if (contract && contract.invariants) {
        for (const invariant of contract.invariants) {
            const checkResult = context.invariants?.[invariant.check];
            if (checkResult === false) {
                errors.push(`Invariant failed: ${invariant.check} - ${invariant.description}`);
            }
        }
    }

    // Check allowed overrides
    if (contract && contract.allowedOverrides) {
        for (const override of context.overrides || []) {
            if (!contract.allowedOverrides.includes(override)) {
                errors.push(`Override not allowed: ${override}`);
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Get transition contract for a from→to transition.
 */
function getTransitionContract(fromStage, toStage) {
    for (const [type, contract] of Object.entries(TransitionContracts)) {
        const fromMatches = Array.isArray(contract.from) ? contract.from.includes(fromStage) : contract.from === fromStage;
        if (fromMatches && contract.to === toStage) {
            return { type, ...contract };
        }
    }
    return null;
}

/**
 * Check if transition is allowed with overrides.
 */
function isTransitionAllowed(fromStage, toStage, context = {}) {
    const validation = validateTransition(fromStage, toStage, context);
    return validation.valid;
}

/**
 * Get all possible transitions from a stage.
 */
function getPossibleTransitions(stage) {
    const def = Stage.Stages[stage];
    if (!def) return [];

    const transitions = [];
    for (const toStage of def.validTransitions) {
        const contract = getTransitionContract(stage, toStage);
        transitions.push({
            from: stage,
            to: toStage,
            contract
        });
    }

    return transitions;
}

// ======================================================
// TRANSITION SEMANTICS
// ======================================================

/**
 * Get transition semantics (what must happen during transition).
 */
function getTransitionSemantics(fromStage, toStage) {
    const contract = getTransitionContract(fromStage, toStage);
    if (!contract) return null;

    return {
        type: contract.type,
        phase: 'precondition',
        actions: [
            // Validate preconditions
            { action: 'validate_invariants', invariants: contract.invariants },
            { action: 'check_leases', leases: contract.requiredLeases },
            { action: 'check_assets', assets: contract.requiredAssets },
            { action: 'check_overrides', overrides: contract.allowedOverrides }
        ]
    };
}

/**
 * Get post-transition semantics.
 */
function getPostTransitionSemantics(fromStage, toStage) {
    const contract = getTransitionContract(fromStage, toStage);
    if (!contract) return null;

    return {
        type: contract.type,
        phase: 'postcondition',
        actions: [
            // Apply side effects
            { action: 'release_leases', leases: contract.requiredLeases.filter(l => !l.optional) },
            { action: 'acquire_leases', leases: contract.requiredLeases.filter(l => l.optional) },
            { action: 'record_event', event: `STATE_${toStage.toUpperCase()}` },
            { action: 'update_dispatch_meta', meta: 'transition' },
            { action: 'update_metrics', category: contract.type }
        ]
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    TransitionType,
    TransitionContracts,
    validateTransition,
    getTransitionContract,
    isTransitionAllowed,
    getPossibleTransitions,
    getTransitionSemantics,
    getPostTransitionSemantics
};
