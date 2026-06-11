// ======================================================
// State Graph Engine - v1.0.0
// ======================================================
// State graph is the single authority for scene lifecycle semantics.
// All runtime execution must respect state graph constraints.

const Stage = require('./stage-definitions');
const Transitions = require('./transition-rules');

// ======================================================
// STATE GRAPH ENGINE CONFIGURATION
// ======================================================

const StateGraphConfig = {
    // Validation modes
    modes: {
        STRICT: 'strict',       // Full validation, no overrides allowed
        PERMISSIVE: 'permissive', // Allow safety/recovery overrides
        DEBUG: 'debug'          // Log all transitions
    },

    // Tracking
    tracking: {
        enabled: true,
        maxHistory: 1000,
        historyKey: 'animastor:state-graph:history'
    }
};

// ======================================================
// STATE GRAPH ENGINE CLASS
// ======================================================

class StateGraphEngine {
    constructor(redis, config = {}) {
        this.redis = redis;
        this.config = { ...StateGraphConfig, ...config };
        this.history = [];
        this.violationCount = 0;
    }

    // ==================================================
    // STATE TRANSITION VALIDATION
    // ==================================================

    /**
     * Validate a state transition before execution.
     * Returns { valid: boolean, errors: string[], warnings: string[] }
     */
    async validateTransition(fromStage, toStage, context = {}) {
        const errors = [];
        const warnings = [];

        // Check source state validity
        if (!Stage.Stages[fromStage]) {
            errors.push(`Unknown source stage: ${fromStage}`);
            return { valid: false, errors, warnings };
        }

        // Check target state validity
        if (!Stage.Stages[toStage]) {
            errors.push(`Unknown target stage: ${toStage}`);
            return { valid: false, errors, warnings };
        }

        // Check if transition is in state graph
        const sourceDef = Stage.Stages[fromStage];
        if (!sourceDef.validTransitions.includes(toStage)) {
            errors.push(`Transition ${fromStage} → ${toStage} not in state graph`);
            this.violationCount++;
            return { valid: false, errors, warnings };
        }

        // Check terminal state constraints
        if (sourceDef.isTerminal) {
            errors.push(`Cannot transition from terminal state: ${fromStage}`);
            return { valid: false, errors, warnings };
        }

        // Validate against transition contract
        const contract = Transitions.getTransitionContract(fromStage, toStage);
        if (contract) {
            const validation = await Transitions.validateTransition(fromStage, toStage, context);
            if (!validation.valid) {
                errors.push(...validation.errors);
            }
        }

        // Check sequential progression (if in strict mode)
        if (this.config.modes === StateGraphConfig.modes.STRICT) {
            const progression = Stage.isSequentialProgression(fromStage, toStage);
            if (!progression && fromStage !== toStage) {
                warnings.push(`Non-sequential transition: ${fromStage} → ${toStage}`);
            }
        }

        // Check retry constraints
        if (toStage === Stage.Stages.RETRYING) {
            const retryable = Stage.isRetryableStage(fromStage);
            if (!retryable) {
                errors.push(`Stage ${fromStage} is not retryable`);
            }
        }

        const valid = errors.length === 0;
        if (valid) {
            this.logTransition(fromStage, toStage, 'VALIDATED');
        } else {
            this.logTransition(fromStage, toStage, 'REJECTED', errors);
        }

        return { valid, errors, warnings };
    }

    /**
     * Execute a state transition (returns contract to apply).
     */
    async executeTransition(fromStage, toStage, context = {}) {
        // First validate
        const validation = await this.validateTransition(fromStage, toStage, context);
        if (!validation.valid) {
            return {
                success: false,
                errors: validation.errors,
                warnings: validation.warnings
            };
        }

        // Get transition contract
        const contract = Transitions.getTransitionContract(fromStage, toStage);
        if (!contract) {
            return {
                success: false,
                errors: [`No contract found for ${fromStage} → ${toStage}`]
            };
        }

        // Record transition in history
        await this.recordTransition(fromStage, toStage, context);

        return {
            success: true,
            contract,
            warnings: validation.warnings
        };
    }

    // ==================================================
    // STATE GRAPH QUERY
    // ==================================================

    /**
     * Get all valid transitions from a state.
     */
    getAvailableTransitions(stage) {
        return Stage.getNextStates(stage).map(to => {
            const contract = Transitions.getTransitionContract(stage, to);
            return {
                from: stage,
                to,
                type: contract?.type || 'unknown',
                contract
            };
        });
    }

    /**
     * Get path to terminal state (simple forward path).
     */
    getPathToCompletion(startStage) {
        const path = [];
        let current = startStage;

        while (current && !Stage.isTerminalStage(current)) {
            const nextStates = Stage.getNextStates(current);
            if (nextStates.length === 0) break;

            path.push({
                from: current,
                to: nextStates[0]
            });

            current = nextStates[0];
        }

        return path;
    }

    /**
     * Check if state is reachable from another state.
     */
    async isReachable(fromStage, toStage, maxDepth = 10) {
        if (fromStage === toStage) return true;

        const visited = new Set();
        const queue = [fromStage];

        while (queue.length > 0 && visited.size < maxDepth) {
            const current = queue.shift();
            if (visited.has(current)) continue;
            visited.add(current);

            if (current === toStage) return true;

            const nextStates = Stage.getNextStates(current);
            for (const next of nextStates) {
                if (!visited.has(next)) {
                    queue.push(next);
                }
            }
        }

        return false;
    }

    // ==================================================
    // STATE GRAPH EVENTS
    // ==================================================

    /**
     * Record transition to history.
     */
    async recordTransition(fromStage, toStage, context = {}) {
        const transition = {
            from: fromStage,
            to: toStage,
            timestamp: Date.now(),
            context,
            id: `transition-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        };

        this.history.unshift(transition);
        if (this.history.length > this.config.tracking.maxHistory) {
            this.history.pop();
        }

        // In production, also persist to Redis
        if (this.redis) {
            const key = this.config.tracking.historyKey;
            await this.redis.lpush(key, JSON.stringify(transition));
            await this.redis.ltrim(key, 0, this.config.tracking.maxHistory - 1);
        }

        return transition;
    }

    /**
     * Get transition history.
     */
    getHistory(limit = 100) {
        return this.history.slice(0, limit);
    }

    /**
     * Get state graph statistics.
     */
    async getStats() {
        const stats = {
            totalTransitions: this.history.length,
            violationCount: this.violationCount,
            stages: Object.keys(Stage.Stages).length,
            terminalStages: Object.values(Stage.Stages)
                .filter(s => s.isTerminal).length,
            retryableStages: Object.values(Stage.Stages)
                .filter(s => s.isRetryable).length,
            modes: this.config.modes
        };

        if (this.redis) {
            const key = this.config.tracking.historyKey;
            const count = await this.redis.llen(key);
            stats.totalRedisTransitions = count;
        }

        return stats;
    }

    // ==================================================
    // STATE GRAPH VALIDATION HELPERS
    // ==================================================

    /**
     * Check if a scene state is valid.
     */
    isValidSceneState(scene) {
        const stage = scene.stage || scene.currentStage;
        if (!Stage.Stages[stage]) {
            return { valid: false, reason: `Invalid scene stage: ${stage}` };
        }

        // Check terminal constraints
        const def = Stage.Stages[stage];
        if (def.isTerminal && (scene.isTerminal === true || scene.completed === true)) {
            return { valid: true, isTerminal: true };
        }

        // Check asset requirements
        const required = def.requiresAssets || [];
        for (const asset of required) {
            const hasAsset = scene[asset] || scene[`${asset}_required`];
            if (!hasAsset && asset !== 'pending_audio') {
                return { valid: false, reason: `Missing required asset: ${asset}` };
            }
        }

        return { valid: true, isTerminal: false };
    }

    /**
     * Validate feeback loop (runtime state matches graph).
     */
    async validateFeedbackLoop(scene, runtimeState) {
        const issues = [];

        // Check stage validity
        if (!Stage.Stages[runtimeState.stage]) {
            issues.push({ severity: 'high', issue: `Invalid runtime stage: ${runtimeState.stage}` });
        }

        // Check terminal state consistency
        if (Stage.isTerminalStage(runtimeState.stage) !== scene.isTerminal) {
            issues.push({
                severity: 'critical',
                issue: `Terminal state mismatch: runtime says ${runtimeState.isTerminal}, scene says ${scene.isTerminal}`
            });
        }

        // Check if runtime state allows transitions from scene stage
        const available = this.getAvailableTransitions(scene.stage);
        if (available.length === 0 && !Stage.isTerminalStage(scene.stage)) {
            issues.push({
                severity: 'medium',
                issue: `No transitions available from stage: ${scene.stage}`
            });
        }

        return {
            valid: issues.length === 0,
            issues
        };
    }

    // ==================================================
    // LOGGING
    // ==================================================

    logTransition(fromStage, toStage, status, details = []) {
        if (this.config.modes === StateGraphConfig.modes.DEBUG) {
            const msg = `[STATE-GRAPH] ${status}: ${fromStage} → ${toStage}`;
            if (details.length > 0) {
                console.log(`${msg} | ${details.join(', ')}`);
            } else {
                console.log(msg);
            }
        }
    }

    logWarning(msg) {
        console.warn(`[STATE-GRAPH] ⚠️ ${msg}`);
    }

    logError(msg) {
        console.error(`[STATE-GRAPH] ❌ ${msg}`);
    }
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    StateGraphEngine,
    StateGraphConfig
};
