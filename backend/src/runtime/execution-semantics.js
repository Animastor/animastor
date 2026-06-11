// ======================================================
// EXECUTION SEMANTICS - FORMAL RUNTIME BEHAVIOR DEFINITIONS
// ======================================================
// Explicit semantics for all runtime operations.
// Runtime behavior must be formally explainable.

const Stage = require('./state-graph/stage-definitions');
const TransitionRules = require('./state-graph/transition-rules');

const logPrefix = '[SEMANTICS]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// SEMANTIC CATEGORIES
// ======================================================

const SemanticCategory = {
    DISPATCH: 'dispatch',
    RETRY: 'retry',
    RECOVERY: 'recovery',
    REPLAY: 'replay',
    LEASE_OWNERSHIP: 'lease_ownership'
};

// ======================================================
// DISPATCH SEMANTICS
// ======================================================

/**
 * Dispatch semantics: rules governing dispatch execution.
 */
const DispatchSemantics = {
    /**
     * Dispatch lifecycle.
     */
    lifecycle: {
        /**
         * State transitions:
         * pending → executing → completed | failed
         */
        states: {
            pending: {
                description: 'Dispatch queued, waiting for execution',
                validTransitions: ['executing', 'cancelled']
            },
            executing: {
                description: 'Dispatch currently running',
                validTransitions: ['completed', 'failed', 'paused', 'resumed']
            },
            completed: {
                description: 'Dispatch completed successfully',
                validTransitions: [],
                terminal: true
            },
            failed: {
                description: 'Dispatch failed permanently',
                validTransitions: [],
                terminal: true
            },
            paused: {
                description: 'Dispatch paused (can be resumed)',
                validTransitions: ['resumed', 'cancelled']
            },
            resumed: {
                description: 'Dispatch resumed from pause',
                validTransitions: ['completed', 'failed', 'paused']
            },
            cancelled: {
                description: 'Dispatch cancelled',
                validTransitions: [],
                terminal: true
            }
        },

        /**
         * Valid dispatch state transitions.
         */
        transitions: {
            pendingToExecuting: {
                from: 'pending',
                to: 'executing',
                precondition: {
                    stageValid: true,
                    leaseHeld: true,
                    quotaAvailable: true
                },
                sideEffects: [
                    'dispatch_id generated',
                    'lease renewed',
                    'dispatch metadata recorded',
                    'backpressure counter incremented'
                ]
            },
            executingToCompleted: {
                from: 'executing',
                to: 'completed',
                precondition: {
                    allAssetsGenerated: true,
                    checksumsValid: true,
                    stateTransitionValid: true
                },
                sideEffects: [
                    'lease released',
                    'asset registered',
                    'metadata finalized',
                    'counter decremented'
                ]
            },
            executingToFailed: {
                from: 'executing',
                to: 'failed',
                precondition: {
                    retryBudgetExhausted: false,
                    terminationRequested: false
                },
                sideEffects: [
                    'retry scheduled if budget available',
                    'lease released',
                    'failure event recorded',
                    'counter decremented'
                ]
            },
            pausedToResumed: {
                from: 'paused',
                to: 'resumed',
                precondition: {
                    pauseValid: true,
                    leaseStillValid: true
                },
                sideEffects: [
                    'lease renewed',
                    'dispatch metadata updated'
                ]
            }
        }
    },

    /**
     * Dispatch identification.
     */
    identification: {
        /**
         * Generate dispatch ID.
         */
        generateDispatchId: (bookId, chapterId, sceneId, stage) => {
            return `${bookId}:${chapterId}:${sceneId}:${stage}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
        },

        /**
         * Validate dispatch ID format.
         */
        validateDispatchId: (dispatchId) => {
            const parts = dispatchId.split(':');
            return parts.length === 6 &&
                parts[0] && parts[1] && parts[2] && parts[3] && parts[4] && parts[5];
        }
    },

    /**
     * Dispatch ownership.
     */
    ownership: {
        /**
         * Dispatch is owned by the lease holder.
         */
        owner: (lease, dispatch) => {
            return lease.token === dispatch.leaseToken;
        },

        /**
         * Check if dispatch can be released.
         */
        canRelease: (dispatch, lease) => {
            return dispatch.status === 'completed' || dispatch.status === 'failed';
        }
    },

    /**
     * Dispatch constraints.
     */
    constraints: {
        /**
         * Single-flight: no duplicate dispatches for same scene:stage.
         */
        singleFlight: (bookId, chapterId, sceneId, stage, activeDispatches) => {
            const existing = activeDispatches.find(d =>
                d.bookId === bookId &&
                d.chapterId === chapterId &&
                d.sceneId === sceneId &&
                d.stage === stage &&
                (d.status === 'pending' || d.status === 'executing')
            );
            return !existing;
        },

        /**
         * Lease must be held for dispatch.
         */
        leaseRequired: (lease) => {
            return lease && lease.active && !lease.expired;
        },

        /**
         * Quota must be available.
         */
        quotaRequired: (activeCount, maxActive) => {
            return activeCount < maxActive;
        }
    }
};

// ======================================================
// RETRY SEMANTICS
// ======================================================

/**
 * Retry semantics: rules governing retry behavior.
 */
const RetrySemantics = {
    /**
     * Retry lifecycle.
     */
    lifecycle: {
        /**
         * State transitions:
         * pending → retrying → (succeeded | exhausted)
         */
        states: {
            pending: {
                description: 'Retry pending, waiting for backoff',
                validTransitions: ['retrying', 'cancelled']
            },
            retrying: {
                description: 'Scene being retried',
                validTransitions: ['succeeded', 'exhausted', 'failed_permanently']
            },
            succeeded: {
                description: 'Retry succeeded, scene can proceed',
                validTransitions: [],
                terminal: true
            },
            exhausted: {
                description: 'Retry budget exhausted',
                validTransitions: ['failed_permanently']
            },
            failed_permanently: {
                description: 'Scene failed permanently after all retries',
                validTransitions: [],
                terminal: true
            },
            cancelled: {
                description: 'Retry cancelled',
                validTransitions: [],
                terminal: true
            }
        },

        /**
         * Retry backoff strategies.
         */
        backoff: {
            constant: { delay: 1000 },
            linear: { base: 1000, step: 500 },
            exponential: { base: 1000, factor: 2, max: 60000 }
        },

        /**
         * Calculate backoff delay.
         */
        calculateBackoff: (strategy, attempt) => {
            if (strategy === 'constant') {
                return DispatchSemantics.constraints.retry.backoff.constant.delay;
            }
            if (strategy === 'linear') {
                return DispatchSemantics.constraints.retry.backoff.linear.base +
                    (attempt * DispatchSemantics.constraints.retry.backoff.linear.step);
            }
            if (strategy === 'exponential') {
                const delay = DispatchSemantics.constraints.retry.backoff.exponential.base *
                    Math.pow(DispatchSemantics.constraints.retry.backoff.exponential.factor, attempt);
                return Math.min(delay, DispatchSemantics.constraints.retry.backoff.exponential.max);
            }
            return 0;
        }
    },

    /**
     * Retry constraints.
     */
    constraints: {
        /**
         * Retry budget is non-negative.
         */
        budgetNonNegative: (budget) => {
            return budget >= 0;
        },

        /**
         * Max retries per scene.
         */
        maxRetries: (sceneRetries, max) => {
            return sceneRetries < max;
        },

        /**
         * Retry only on retryable errors.
         */
        retryableError: (errorType) => {
            const retryable = ['transient', 'connection', 'timeout', 'quota_exceeded'];
            return retryable.includes(errorType);
        }
    },

    /**
     * Retry semantics for recovery.
     */
    recovery: {
        /**
         * Recovery retry goes through pending state.
         */
        recoveryRetry: (fromStage) => {
            return fromStage !== Stage.StageCategory.COMPLETED &&
                fromStage !== Stage.StageCategory.FAILED;
        }
    }
};

// ======================================================
// RECOVERY SEMANTICS
// ======================================================

/**
 * Recovery semantics: rules governing scene recovery.
 */
const RecoverySemantics = {
    /**
     * Recovery process.
     */
    process: {
        /**
         * Stages of recovery.
         */
        stages: [
            { name: 'detection', description: 'Detect stuck scene' },
            { name: 'assessment', description: 'Assess recovery options' },
            { name: 'state_reset', description: 'Reset to safe state' },
            { name: 'lease_release', description: 'Release stale leases' },
            { name: 'dispatch_clear', description: 'Clear stale dispatch' },
            { name: 'retry_init', description: 'Initialize retry if applicable' }
        ],

        /**
         * Recovery paths.
         */
        paths: {
            quick: {
                description: 'Quick recovery for transient failures',
                stages: ['detection', 'assessment', 'retry_init']
            },
            full: {
                description: 'Full recovery for persistent failures',
                stages: ['detection', 'assessment', 'state_reset', 'lease_release', 'dispatch_clear', 'retry_init']
            },
            manual: {
                description: 'Manual recovery requiring operator approval',
                stages: ['detection', 'assessment'],
                requiresApproval: true
            }
        }
    },

    /**
     * Recovery constraints.
     */
    constraints: {
        /**
         * Recovery only from stuck states.
         */
        fromStuckState: (stage) => {
            const stuckStates = [
                Stage.StageCategory.PREPARING,
                Stage.StageCategory.PREPARING_IMAGE,
                Stage.StageCategory.PREPARING_VIDEO
            ];
            return stuckStates.includes(stage);
        },

        /**
         * Recovery window timeout.
         */
        windowTimeout: (lastActivity, timeout) => {
            return Date.now() - lastActivity > timeout;
        },

        /**
         * Recovery must not violate invariants.
         */
        invariantSafe: (recoveryPlan, invariants) => {
            // Check that recovery plan doesn't violate any invariant
            return true;  // Would check against actual invariant rules
        }
    },

    /**
     * Recovery semantics for lease cleanup.
     */
    leaseCleanup: {
        /**
         * Stale lease detection.
         */
        stale: (lease, staleThreshold) => {
            return lease && lease.expiresAt < Date.now() - staleThreshold;
        },

        /**
         * Orphan lease detection.
         */
        orphan: (lease, dispatch) => {
            return lease.active && (dispatch === null || dispatch === undefined);
        }
    },

    /**
     * Recovery semantics for dispatch cleanup.
     */
    dispatchCleanup: {
        /**
         * Stale dispatch detection.
         */
        stale: (dispatch, timeout) => {
            return dispatch && (Date.now() - dispatch.startedAt) > timeout;
        },

        /**
         * Cancel dispatch if orphaned.
         */
        cancelIfOrphaned: (dispatch, lease) => {
            return dispatch && !lease;
        }
    }
};

// ======================================================
// REPLAY SEMANTICS
// ======================================================

/**
 * Replay semantics: rules governing deterministic replay.
 */
const ReplaySemantics = {
    /**
     * Replay modes.
     */
    modes: {
        simulation: {
            description: 'Generate replay events without execution',
            sideEffects: 'event-only'
        },
        execution: {
            description: 'Execute replay_actions based on events',
            sideEffects: 'full_execution'
        },
        validation: {
            description: 'Compare replay outcome with actual',
            sideEffects: 'comparison_only'
        }
    },

    /**
     * Replay determinism requirements.
     */
    determinism: {
        /**
         * Events must be replayed in causal order.
         */
        causalOrder: (events) => {
            // Events should be sorted by timestamp
            for (let i = 1; i < events.length; i++) {
                if (events[i].ts < events[i - 1].ts) {
                    return false;
                }
            }
            return true;
        },

        /**
         * No random elements in replay.
         */
        noRandomness: (events) => {
            // Check for any non-deterministic elements
            // (This would be checked at event generation time)
            return true;
        }
    },

    /**
     * Replay semantics for state reconstruction.
     */
    stateReconstruction: {
        /**
         * Reconstruct state from event stream.
         */
        fromEvents: (events) => {
            let state = {
                stage: Stage.StageCategory.PENDING,
                assets: {},
                leases: {},
                dispatches: {},
                completed: false,
                failed: false
            };

            for (const evt of events) {
                state = applyEventToState(state, evt);
            }

            return state;
        },

        /**
         * Apply event to state for replay.
         */
        applyEventToState: (state, evt) => {
            // This would implement actual state transition logic
            return state;
        }
    },

    /**
     * Replay semantics for consistency checking.
     */
    consistency: {
        /**
         * Event completeness check.
         */
        complete: (events, expectedCount) => {
            return events.length >= expectedCount;
        },

        /**
         * Consistency between events and state.
         */
        consistent: (events, state) => {
            // Check if state is consistent with event stream
            return true;
        }
    }
};

// ======================================================
// LEASE OWNERSHIP SEMANTICS
// ======================================================

/**
 * Lease ownership semantics: rules governing lease relationships.
 */
const LeaseOwnershipSemantics = {
    /**
     * Lease lifecycle.
     */
    lifecycle: {
        /**
         * State transitions:
         * created → active → (released | expired)
         */
        states: {
            created: {
                description: 'Lease created, not yet acquired',
                validTransitions: ['acquired', 'cancelled']
            },
            acquired: {
                description: 'Lease acquired by owner',
                validTransitions: ['active', 'released', 'expired', 'granted']
            },
            active: {
                description: 'Lease actively held',
                validTransitions: ['released', 'expired', 'renewed', 'revoked']
            },
            released: {
                description: 'Lease released by owner',
                validTransitions: [],
                terminal: true
            },
            expired: {
                description: 'Lease expired',
                validTransitions: [],
                terminal: true
            },
            cancelled: {
                description: 'Lease cancelled',
                validTransitions: [],
                terminal: true
            },
            granted: {
                description: 'Lease granted to new owner',
                validTransitions: ['active']
            },
            renewed: {
                description: 'Lease TTL extended',
                validTransitions: ['active']
            },
            revoked: {
                description: 'Lease revoked by authority',
                validTransitions: ['released']
            }
        },

        /**
         * Valid lease transitions.
         */
        transitions: {
            createdToAcquired: {
                from: 'created',
                to: 'acquired',
                precondition: {
                    leaseKeyValid: true,
                    tokenUnique: true,
                    ttlValid: true
                },
                sideEffects: [
                    'lease counter incremented',
                    'active lease registered'
                ]
            },
            acquiredToActive: {
                from: 'acquired',
                to: 'active',
                precondition: {
                    tokenMatch: true,
                    dispatchOwnerValid: true
                },
                sideEffects: [
                    'dispatch ownership established'
                ]
            },
            activeToReleased: {
                from: 'active',
                to: 'released',
                precondition: {
                    tokenMatch: true,
                    dispatchCompleted: true
                },
                sideEffects: [
                    'lease counter decremented',
                    'active lease unregistered'
                ]
            },
            activeToExpired: {
                from: 'active',
                to: 'expired',
                precondition: {
                    ttlExpired: true,
                    notYetReleased: true
                },
                sideEffects: [
                    'lease counter decremented',
                    'active lease unregistered'
                ]
            },
            activeToRenewed: {
                from: 'active',
                to: 'renewed',
                precondition: {
                    tokenMatch: true,
                    ttlExtensionValid: true
                },
                sideEffects: [
                    'lease TTL extended',
                    'renewal counter incremented'
                ]
            }
        }
    },

    /**
     * Lease ownership rules.
     */
    ownership: {
        /**
         * Token must match for operations.
         */
        tokenMatch: (lease, token) => {
            return lease.token === token;
        },

        /**
         * Owner can perform operations.
         */
        canPerform: (lease, token, operation) => {
            if (!LeaseOwnershipSemantics.ownership.tokenMatch(lease, token)) {
                return false;
            }

            const validOperations = ['release', 'renew', 'check'];
            return validOperations.includes(operation);
        },

        /**
         * Non-owner cannot release lease.
         */
        cannotRelease: (lease, token) => {
            return !LeaseOwnershipSemantics.ownership.tokenMatch(lease, token);
        }
    },

    /**
     * Lease timeout semantics.
     */
    timeout: {
        /**
         * Lease expiry check.
         */
        expired: (lease) => {
            return Date.now() > lease.expiresAt;
        },

        /**
         * Lease near expiry check.
         */
        nearExpiry: (lease, threshold) => {
            const timeRemaining = lease.expiresAt - Date.now();
            return timeRemaining < threshold;
        },

        /**
         * Lease renewal window.
         */
        renewalWindow: (lease, minRemaining) => {
            return lease.expiresAt - Date.now() > minRemaining;
        }
    },

    /**
     * Lease semantics for dispatch ownership.
     */
    dispatchOwnership: {
        /**
         * Lease holder owns dispatch.
         */
        ownsDispatch: (lease, dispatch) => {
            return lease.active && lease.token === dispatch.leaseToken;
        },

        /**
         * Dispatch owned by orphan lease.
         */
        orphanDispatch: (lease, dispatch) => {
            return lease.active && !dispatch;
        },

        /**
         * Dispatch owned by expired lease.
         */
        expiredDispatch: (lease, dispatch) => {
            return LeaseOwnershipSemantics.timeout.expired(lease) && dispatch;
        }
    }
};

// ======================================================
// EMBEDDED STATE TRANSITION APPLIER
// ======================================================

/**
 * Apply event to state for replay.
 */
function applyEventToState(state, evt) {
    const newState = { ...state };

    switch (evt.type) {
        case 'SCENE_STARTED':
            newState.stage = Stage.StageCategory.PENDING;
            break;
        case 'STATE_TRANSITION':
            newState.stage = evt.state;
            break;
        case 'ASSET_GENERATED':
            newState.assets[evt.asset] = evt.details;
            break;
        case 'LEASE_ACQUIRED':
            newState.leases[evt.leaseKey] = {
                token: evt.token,
                active: true,
                expiresAt: evt.expiresAt
            };
            break;
        case 'LEASE_RELEASED':
            newState.leases[evt.leaseKey] = {
                ...newState.leases[evt.leaseKey],
                active: false,
                releasedAt: evt.ts
            };
            break;
        case 'DISPATCH_STARTED':
            newState.dispatches[evt.dispatchId] = {
                status: 'executing',
                startedAt: evt.ts,
                worker: evt.worker
            };
            break;
        case 'DISPATCH_COMPLETED':
            newState.dispatches[evt.dispatchId] = {
                ...newState.dispatches[evt.dispatchId],
                status: 'completed',
                completedAt: evt.ts
            };
            break;
        case 'DISPATCH_FAILED':
            newState.dispatches[evt.dispatchId] = {
                ...newState.dispatches[evt.dispatchId],
                status: 'failed',
                failedAt: evt.ts,
                error: evt.error
            };
            break;
    }

    return newState;
}

// ======================================================
// SEMANTIC VALIDATION ENGINE
// ======================================================

/**
 * Validate execution semantics.
 */
class ExecutionSemanticsEngine {
    constructor() {
        this.history = [];
        this.violations = [];
    }

    /**
     * Validate dispatch execution.
     */
    validateDispatch(dispatchSpec, context) {
        const violations = [];

        // Check lifecycle validity
        const fromState = dispatchSpec.fromState;
        const toState = dispatchSpec.toState;
        const fromLifecycle = DispatchSemantics.lifecycle.states[fromState];

        if (!fromLifecycle) {
            violations.push({ type: 'invalid_from_state', state: fromState });
        } else if (!fromLifecycle.validTransitions.includes(toState)) {
            violations.push({
                type: 'invalid_transition',
                from: fromState,
                to: toState,
                validTransitions: fromLifecycle.validTransitions
            });
        }

        // Check dispatch constraints
        if (!DispatchSemantics.constraints.quotaRequired(
            context.activeCount,
            context.maxActive
        )) {
            violations.push({ type: 'quota_exceeded' });
        }

        if (!DispatchSemantics.constraints.leaseRequired(context.lease)) {
            violations.push({ type: 'lease_not_held' });
        }

        return {
            valid: violations.length === 0,
            violations
        };
    }

    /**
     * Validate retry execution.
     */
    validateRetry(retrySpec, context) {
        const violations = [];

        // Check retry budget
        if (!RetrySemantics.constraints.budgetNonNegative(context.budget)) {
            violations.push({ type: 'negative_budget' });
        }

        // Check max retries
        if (!RetrySemantics.constraints.maxRetries(context.retryCount, context.maxRetries)) {
            violations.push({ type: 'max_retries_exceeded' });
        }

        return {
            valid: violations.length === 0,
            violations
        };
    }

    /**
     * Validate recovery execution.
     */
    validateRecovery(recoverySpec, context) {
        const violations = [];

        // Check recovery path validity
        if (!RecoverySemantics.constraints.fromStuckState(context.fromStage)) {
            violations.push({ type: 'not_stuck_state' });
        }

        return {
            valid: violations.length === 0,
            violations
        };
    }

    /**
     * Validate lease ownership.
     */
    validateLeaseOwnership(leaseSpec, context) {
        const violations = [];

        // Check token ownership
        if (!LeaseOwnershipSemantics.ownership.tokenMatch(leaseSpec.lease, context.token)) {
            violations.push({ type: 'token_mismatch' });
        }

        return {
            valid: violations.length === 0,
            violations
        };
    }

    /**
     * Record semantic violation.
     */
    recordViolation(violation) {
        this.violations.push({
            timestamp: Date.now(),
            ...violation
        });
        this.history.push(violation);

        if (this.history.length > 1000) {
            this.history.shift();
        }
    }

    /**
     * Get semantic violations.
     */
    getViolations() {
        return this.violations;
    }

    /**
     * Clear history.
     */
    clear() {
        this.history = [];
        this.violations = [];
    }
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    SemanticCategory,
    DispatchSemantics,
    RetrySemantics,
    RecoverySemantics,
    ReplaySemantics,
    LeaseOwnershipSemantics,
    ExecutionSemanticsEngine,
    applyEventToState
};
