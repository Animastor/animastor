// ======================================================
// POLICY MODULES EXPORTS
// ======================================================
// Composable policy modules for Phase 11 runtime governance.
// Each policy module handles one concern with clear boundaries.

module.exports = {
    // Fairness policy - prevent starvation, ensure equitable progress
    fairness: require('./fairness-policy'),

    // Retry policy - manage retry pressure, prevent retry storms
    retry: require('./retry-policy'),

    // Overload policy - detect and respond to runtime overload
    overload: require('./overload-policy'),

    // Workload policy - classify and route by computational cost
    workload: require('./workload-policy'),

    // Circuit policy - respond to circuit breaker state
    circuit: require('./circuit-policy'),

    // Priority policy - handle priority normalization and boosts
    priority: require('./priority-policy')
};
