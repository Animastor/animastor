// ======================================================
// SUBSYSTEM ISOLATION - RUNTIME SUBSYSTEM BOUNDARIES
// ======================================================
// Subsystems communicate ONLY through well-defined interfaces.
// No direct state modification across subsystem boundaries.

const Stage = require('../state-graph/stage-definitions');

const logPrefix = '[SUBSYSTEM]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

// ======================================================
// SUBSYSTEM TYPES
// ======================================================

const SubsystemType = {
    SCHEDULING: 'scheduling',
    GOVERNANCE: 'governance',
    REPLAY: 'replay',
    INVARIANTS: 'invariants',
    ADAPTATION: 'adaptation'
};

// ======================================================
// SUBSYSTEM ISOLATION CONTRACT
// ======================================================

class SubsystemIsolationContract {
    constructor(name, type, config = {}) {
        this.name = name;
        this.type = type;
        this.config = config;
        this.state = {};
        this.interfaces = [];
        this.restrictions = [];
    }

    /**
     * Add an interface that this subsystem provides to others.
     */
    provideInterface(interfaceName, implementation) {
        this.interfaces.push({ name: interfaceName, implementation });
        return this;
    }

    /**
     * Add a restriction on what this subsystem can do.
     */
    addRestriction(restriction) {
        this.restrictions.push(restriction);
        return this;
    }

    /**
     * Check if action is allowed by contract.
     */
    isActionAllowed(action, context = {}) {
        for (const restriction of this.restrictions) {
            if (restriction(action, context) === false) {
                return {
                    allowed: false,
                    reason: `Restriction violated: ${restriction.name}`
                };
            }
        }
        return { allowed: true };
    }

    /**
     * Get all interfaces provided by this subsystem.
     */
    getInterfaces() {
        return this.interfaces;
    }
}

// ======================================================
// SUBSYSTEM ISOLATION ENFORCEMENT
// ======================================================

class SubsystemIsolationEnforcer {
    constructor() {
        this.subsystems = new Map();
        this.communications = [];
    }

    /**
     * Register a subsystem.
     */
    registerSubsystem(subsystem) {
        this.subsystems.set(subsystem.name, subsystem);
        return this;
    }

    /**
     * Get subsystem by name.
     */
    getSubsystem(name) {
        return this.subsystems.get(name);
    }

    /**
     * Get all subsystems.
     */
    getAllSubsystems() {
        return Array.from(this.subsystems.values());
    }

    /**
     * Check if subsystem can communicate with another.
     */
    canCommunicate(fromSubsystem, toSubsystem, message) {
        const from = this.subsystems.get(fromSubsystem);
        const to = this.subsystems.get(toSubsystem);

        if (!from || !to) {
            return { allowed: false, reason: 'Unknown subsystem' };
        }

        // Check if message type is in to-subsystem's accepted interfaces
        const acceptedTypes = to.interfaces.map(i => i.name);
        if (!acceptedTypes.includes(message.type)) {
            return {
                allowed: false,
                reason: `Subsystem ${toSubsystem} does not accept message type: ${message.type}`
            };
        }

        return { allowed: true };
    }

    /**
     * Record communication between subsystems.
     */
    recordCommunication(from, to, message) {
        this.communications.push({
            from,
            to,
            message,
            timestamp: Date.now()
        });
    }

    /**
     * Get communication history.
     */
    getCommunicationHistory(limit = 100) {
        return this.communications.slice(-limit);
    }

    /**
     * Report cross-boundary state access violation.
     */
    reportViolation(violation) {
        console.error(`[SUBSYSTEM-VIOLATION] ${JSON.stringify(violation)}`);
        return {
            reported: true,
            violation
        };
    }
}

// ======================================================
// SCHEDULING SUBSYSTEM CONTRACT
// ======================================================

const SchedulingContract = new SubsystemIsolationContract(
    'scheduling',
    SubsystemType.SCHEDULING,
    {
        name: 'scheduling',
        description: 'Scheduler subsystem - schedules dispatches, enforces isolation',
        isolationLevel: 'strict'
    }
)
    .provideInterface('scheduleDispatch', (dispatchSpec, context) => {
        // Schedule a dispatch
        return { scheduled: true, dispatchId: `dispatch-${Date.now()}` };
    })
    .provideInterface('getQueuedScenes', () => {
        // Get scenes waiting for scheduling
        return { scenes: [], queueLength: 0 };
    })
    .addRestriction({
        name: 'no_direct_dispatch',
        check: (action, context) => {
            if (action === 'directDispatch') {
                return false;
            }
            return true;
        }
    })
    .addRestriction({
        name: 'no_governance_state_modification',
        check: (action, context) => {
            if (action === 'modifyAdmissionControl' || action === 'modifyPolicy') {
                return false;
            }
            return true;
        }
    });

// ======================================================
// GOVERNANCE SUBSYSTEM CONTRACT
// ======================================================

const GovernanceContract = new SubsystemIsolationContract(
    'governance',
    SubsystemType.GOVERNANCE,
    {
        name: 'governance',
        description: 'Governance subsystem - admission control, policy enforcement',
        isolationLevel: 'strict'
    }
)
    .provideInterface('checkAdmission', (scene, context) => {
        // Check if scene can enter runtime
        return { allowed: true, reason: null };
    })
    .provideInterface('evaluatePolicy', (scene, policy, context) => {
        // Evaluate a policy for a scene
        return { allowed: true, advice: [] };
    })
    .provideInterface('getPolicies', () => {
        // Get active policies
        return { policies: [] };
    })
    .provideInterface('adaptPolicy', (adaptation, context) => {
        // Apply policy adaptation
        return { adapted: true };
    })
    .addRestriction({
        name: 'no_direct_scheduling',
        check: (action, context) => {
            if (action === 'scheduleDispatch') {
                return false;
            }
            return true;
        }
    })
    .addRestriction({
        name: 'no_direct_lease_modification',
        check: (action, context) => {
            if (action === 'modifyLease' || action === 'releaseLease') {
                return false;
            }
            return true;
        }
    })
    .addRestriction({
        name: 'no_invariant_override_without_safety',
        check: (action, context) => {
            if (action === 'overrideInvariant' && !context.safetyOverride) {
                return false;
            }
            return true;
        }
    });

// ======================================================
// REPLAY SUBSYSTEM CONTRACT
// ======================================================

const ReplayContract = new SubsystemIsolationContract(
    'replay',
    SubsystemType.REPLAY,
    {
        name: 'replay',
        description: 'Replay subsystem - deterministic replay and consistency checking',
        isolationLevel: 'strict'
    }
)
    .provideInterface('replayEvents', (events, context) => {
        // Replay a set of events
        return { replayedEvents: events.length, outcome: {} };
    })
    .provideInterface('validateReplayConsistency', () => {
        // Validate replay consistency
        return { consistent: true, discrepancies: [] };
    })
    .provideInterface('exportReplayData', () => {
        // Export replay data for analysis
        return { data: {} };
    })
    .addRestriction({
        name: 'no_dispatch_execution',
        check: (action, context) => {
            if (action === 'executeDispatch') {
                return false;
            }
            return true;
        }
    })
    .addRestriction({
        name: 'no_state_modification',
        check: (action, context) => {
            if (action === 'modifyRuntimeState') {
                return false;
            }
            return true;
        }
    });

// ======================================================
// INVARIANTS SUBSYSTEM CONTRACT
// ======================================================

const InvariantsContract = new SubsystemIsolationContract(
    'invariants',
    SubsystemType.INVARIANTS,
    {
        name: 'invariants',
        description: 'Invariants subsystem - runtime safety guarantees',
        isolationLevel: 'strict'
    }
)
    .provideInterface('checkInvariants', (state, context) => {
        // Check all invariants for a state
        return { valid: true, violations: [] };
    })
    .provideInterface('validateTransition', (fromStage, toStage, context) => {
        // Validate a state transition
        return { valid: true, errors: [] };
    })
    .provideInterface('getInvariantStatus', () => {
        // Get current invariant status
        return { status: {} };
    })
    .addRestriction({
        name: 'no_policy_modification',
        check: (action, context) => {
            if (action === 'modifyPolicy') {
                return false;
            }
            return true;
        }
    })
    .addRestriction({
        name: 'no_scheduling_control',
        check: (action, context) => {
            if (action === 'scheduleDispatch' || action === 'cancelDispatch') {
                return false;
            }
            return true;
        }
    })
    .addRestriction({
        name: 'no_adaptation_control',
        check: (action, context) => {
            if (action === 'adaptPolicy') {
                return false;
            }
            return true;
        }
    });

// ======================================================
// ADAPTATION SUBSYSTEM CONTRACT
// ======================================================

const AdaptationContract = new SubsystemIsolationContract(
    'adaptation',
    SubsystemType.ADAPTATION,
    {
        name: 'adaptation',
        description: 'Adaptation subsystem - adaptive policy tuning',
        isolationLevel: 'strict'
    }
)
    .provideInterface('analyzeMetrics', (metrics, context) => {
        // Analyze runtime metrics
        return { analysis: {}, recommendations: [] };
    })
    .provideInterface('proposeAdaptation', (adaptation, context) => {
        // Propose an adaptation
        return { proposed: true, adaptation };
    })
    .provideInterface('executeAdaptation', (adaptation, context) => {
        // Execute an adaptation (through governance)
        return { executed: true };
    })
    .addRestriction({
        name: 'no_direct_policy_modification',
        check: (action, context) => {
            if (action === 'directPolicyWrite') {
                return false;
            }
            return true;
        }
    })
    .addRestriction({
        name: 'no_invariant_override',
        check: (action, context) => {
            if (action === 'overrideInvariant') {
                return false;
            }
            return true;
        }
    })
    .addRestriction({
        name: 'max_adaptation_rate',
        check: (action, context) => {
            const maxRate = context.maxAdaptationRate || 1.0; // 100% max
            return context.currentRate <= maxRate;
        }
    });

// ======================================================
// SUBSYSTEM MESSAGE TYPES
// ======================================================

const SubsystemMessage = {
    // Scheduling messages
    SCHEDULE_DISPATCH: { type: 'SCHEDULE_DISPATCH' },
    DISPATCH_SCHEDULED: { type: 'DISPATCH_SCHEDULED' },
    DISPATCH_COMPLETED: { type: 'DISPATCH_COMPLETED' },

    // Governance messages
    CHECK_ADMISSION: { type: 'CHECK_ADMISSION' },
    ADMISSION_RESULT: { type: 'ADMISSION_RESULT' },
    EVALUATE_POLICY: { type: 'EVALUATE_POLICY' },
    POLICY_RESULT: { type: 'POLICY_RESULT' },

    // Replay messages
    REPLAY_REQUEST: { type: 'REPLAY_REQUEST' },
    REPLAY_RESULT: { type: 'REPLAY_RESULT' },
    CONSISTENCY_CHECK: { type: 'CONSISTENCY_CHECK' },

    // Invariant messages
    CHECK_INVARIANTS: { type: 'CHECK_INVARIANTS' },
    INVARIANT_RESULT: { type: 'INVARIANT_RESULT' },
    TRANSITION_VALIDATION: { type: 'TRANSITION_VALIDATION' },
    INVALID_TRANSITION: { type: 'INVALID_TRANSITION' },

    // Adaptation messages
    ANALYZE_METRICS: { type: 'ANALYZE_METRICS' },
    METRICS_ANALYSIS: { type: 'METRICS_ANALYSIS' },
    PROPOSE_ADAPTATION: { type: 'PROPOSE_ADAPTATION' },
    EXECUTE_ADAPTATION: { type: 'EXECUTE_ADAPTATION' }
};

// ======================================================
// SUBSYSTEM MESSAGEBus (simulated)
// ======================================================

class SubsystemMessageBus {
    constructor() {
        this.subsystems = new Map();
        this.messages = [];
        this.blockedMessages = [];
    }

    /**
     * Register a subsystem with its interfaces.
     */
    registerSubsystem(name, subsystem) {
        this.subsystems.set(name, subsystem);
        return this;
    }

    /**
     * Send message from one subsystem to another.
     */
    sendMessage(from, to, message) {
        const fromSub = this.subsystems.get(from);
        const toSub = this.subsystems.get(to);

        if (!fromSub || !toSub) {
            this.blockedMessages.push({
                from,
                to,
                message,
                reason: 'Unknown subsystem'
            });
            return { success: false, reason: 'Unknown subsystem' };
        }

        // Check if message type is accepted
        const acceptedTypes = toSub.interfaces.map(i => i.name);
        if (!acceptedTypes.includes(message.type)) {
            this.blockedMessages.push({
                from,
                to,
                message,
                reason: 'Message type not accepted'
            });
            return { success: false, reason: 'Message type not accepted' };
        }

        // Find implementation and call it
        const interfaceImpl = toSub.interfaces.find(i => i.name === message.type);
        if (interfaceImpl) {
            const result = interfaceImpl.implementation(message.payload || {});
            this.messages.push({
                from,
                to,
                message: message.type,
                result
            });
            return { success: true, result };
        }

        return { success: false, reason: 'No implementation found' };
    }

    /**
     * Broadcast message to all subsystems.
     */
    broadcast(type, payload) {
        const results = [];
        for (const [name, sub] of this.subsystems) {
            const interfaceImpl = sub.interfaces.find(i => i.name === type);
            if (interfaceImpl) {
                results.push({
                    subsystem: name,
                    result: interfaceImpl.implementation(payload)
                });
            }
        }
        return results;
    }

    /**
     * Get message history.
     */
    getMessageHistory(limit = 100) {
        return this.messages.slice(-limit);
    }

    /**
     * Get blocked messages.
     */
    getBlockedMessages() {
        return this.blockedMessages;
    }
}

// ======================================================
// SUBSYSTEM ISOLATION PROXY
// ======================================================

/**
 * Proxy for cross-subsystem access.
 * Enforces isolation by only allowing interface-based communication.
 */
class SubsystemProxy {
    constructor(bus, fromSubsystem) {
        this.bus = bus;
        this.fromSubsystem = fromSubsystem;
    }

    scheduleDispatch(dispatchSpec) {
        return this.bus.sendMessage(this.fromSubsystem, 'scheduling', {
            type: SubsystemMessage.SCHEDULE_DISPATCH.type,
            payload: { dispatchSpec }
        });
    }

    checkAdmission(scene) {
        return this.bus.sendMessage(this.fromSubsystem, 'governance', {
            type: SubsystemMessage.CHECK_ADMISSION.type,
            payload: { scene }
        });
    }

    checkInvariants(state) {
        return this.bus.sendMessage(this.fromSubsystem, 'invariants', {
            type: SubsystemMessage.CHECK_INVARIANTS.type,
            payload: { state }
        });
    }

    replayEvents(events) {
        return this.bus.sendMessage(this.fromSubsystem, 'replay', {
            type: SubsystemMessage.REPLAY_REQUEST.type,
            payload: { events }
        });
    }

    analyzeMetrics(metrics) {
        return this.bus.sendMessage(this.fromSubsystem, 'adaptation', {
            type: SubsystemMessage.ANALYZE_METRICS.type,
            payload: { metrics }
        });
    }
}

// ======================================================
// ISOLATION VIOLATION DETECTOR
// ======================================================

class IsolationViolationDetector {
    constructor() {
        this.violations = [];
    }

    /**
     * Detect if subsystem attempted direct state access.
     */
    detectDirectStateAccess(violation) {
        this.violations.push({
            type: 'direct_state_access',
            ...violation
        });

        console.error(`[ISOLATION-VIOLATION] ${JSON.stringify(violation)}`);

        return { reported: true, violation };
    }

    /**
     * Detect if governance attempted scheduling.
     */
    detectGovernanceScheduling(violation) {
        this.violations.push({
            type: 'governance_scheduling',
            ...violation
        });

        return { reported: true, violation };
    }

    /**
     * Detect if scheduling attempted policy modification.
     */
    detectSchedulingPolicyModification(violation) {
        this.violations.push({
            type: 'scheduling_policy_modification',
            ...violation
        });

        return { reported: true, violation };
    }

    /**
     * Detect if adaptation attempted invariant override.
     */
    detectAdaptationInvariantOverride(violation) {
        this.violations.push({
            type: 'adaptation_invariant_override',
            ...violation
        });

        return { reported: true, violation };
    }

    /**
     * Get all violations.
     */
    getViolations() {
        return this.violations;
    }

    /**
     * Clear violations.
     */
    clearViolations() {
        this.violations = [];
    }
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    SubsystemType,
    SubsystemIsolationContract,
    SubsystemIsolationEnforcer,
    SchedulingContract,
    GovernanceContract,
    ReplayContract,
    InvariantsContract,
    AdaptationContract,
    SubsystemMessage,
    SubsystemMessageBus,
    SubsystemProxy,
    IsolationViolationDetector
};
