// ======================================================
// TRACE COMPACTOR - AGGREGATE OLD TRACES
// ======================================================
// Aggregates old, low-value decision traces into summaries.
// Prevents trace explosion and reduces Redis storage.
//
// Key idea: Old traces become summaries.

const logPrefix = '[COMPACTOR]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function debug(msg) {
    console.debug(`${logPrefix} • ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

// ======================================================
// TRACE COMPACTOR CONFIGURATION
// ======================================================

const TRACE_COMPACTOR_CONFIG = {
    // Trace aging
    traceRetentionMs: 86400000, // 24 hours before compaction
    summaryTtlMs: 86400000 * 7, // 7 days for summaries

    // Aggregation thresholds
    overloadThrottleThreshold: 100, // Aggregate after 100 overload throttles
    admissionDecisionThreshold: 50, // Aggregate after 50 admission decisions
    policyDecisionThreshold: 50,    // Aggregate after 50 policy decisions
    healthyDecisionThreshold: 200,  // Aggressively compact healthy decisions

    // Keep detailed traces for these types
    detailedTraceTypes: [
        'failure', 'recovery', 'starvation', 'circuit_open',
        'policy_conflict', 'oscillation', 'recovery'
    ],

    // Skip compaction for these types
    neverCompactTypes: ['failure', 'recovery', 'oscillation']
};

// ======================================================
// TRACE COMPACTOR KEY PATTERNS
// ======================================================

const COMPACTOR_PREFIX = 'animastor:trace:compaction';
const SUMMARY_KEY = `${COMPACTOR_PREFIX}:summary`;
const DETAILED_TRACE_KEY = 'animastor:trace:detailed';
const COMPACTED_TRACE_KEY = 'animastor:trace:compacted';

// ======================================================
// TRACE CATEGORIZATION
// ======================================================

/**
 * Categorize trace by importance.
 */
function categorizeTrace(trace) {
    const type = trace.type;
    const outcome = trace.outcome;
    const decision = trace.decision;

    // High priority - keep detailed
    if (TRACE_COMPACTOR_CONFIG.detailedTraceTypes.some(t => type === t || type.includes(t))) {
        return { category: 'detailed', reason: 'high_importance' };
    }

    if (trace.outcome === 'failure' || trace.outcome === 'error') {
        return { category: 'detailed', reason: 'failure_trace' };
    }

    if (trace.outcome === 'recovery' || trace.outcome === 'reconciled') {
        return { category: 'detailed', reason: 'recovery_trace' };
    }

    if (trace.confidence && trace.confidence < 50) {
        return { category: 'detailed', reason: 'low_confidence' };
    }

    // Can compact - check threshold
    if (type === 'admission' && decision === 'accepted' && trace.confidence > 90) {
        return { category: 'compact_aggressive', reason: 'healthy_accepted' };
    }

    if (type === 'dispatch' && outcome === 'completed') {
        return { category: 'compact_normal', reason: 'normal_completion' };
    }

    if (type === 'retry' && outcome === 'success') {
        return { category: 'compact_normal', reason: 'retry_success' };
    }

    // Default to keep for a while
    return { category: 'keep', reason: 'default' };
}

/**
 * Check if trace should be kept detailed.
 */
function shouldKeepDetailed(trace) {
    const categories = ['detailed', 'high_confidence_failure'];
    const cat = categorizeTrace(trace);
    return categories.includes(cat.category);
}

// ======================================================
// TRACE QUANTIZATION
// ======================================================

/**
 * Quantize trace for aggregation.
 */
function quantizeTrace(trace) {
    const category = categorizeTrace(trace);

    return {
        type: trace.type,
        decision: trace.decision,
        outcome: trace.outcome,
        category: category.category,
        confidenceBucket: quantizeConfidence(trace.confidence || 0),
        timestampBucket: quantizeTimestamp(trace.timestamp),
        policyCount: trace.policyChain ? trace.policyChain.length : 0,
        hasFailures: trace.policyChain ? trace.policyChain.some(p => !p.allowed) : false,
        overloadCount: trace.policyChain ? trace.policyChain.filter(p => p.policy === 'overload').length : 0
    };
}

/**
 * Quantize confidence to buckets.
 */
function quantizeConfidence(confidence) {
    if (confidence > 95) return '>95';
    if (confidence > 90) return '90-95';
    if (confidence > 80) return '80-90';
    if (confidence > 70) return '70-80';
    if (confidence > 50) return '50-70';
    return '<50';
}

/**
 * Quantize timestamp to hourly buckets.
 */
function quantizeTimestamp(timestamp) {
    const hour = Math.floor(timestamp / 3600000) * 3600000;
    return hour;
}

// ======================================================
// SUMMARY CREATION
// ======================================================

/**
 * Create summary from traces.
 */
function createSummary(traces, summaryId) {
    if (!traces || traces.length === 0) {
        return null;
    }

    // Quantize all traces
    const quantized = traces.map(quantizeTrace);

    // Aggregate statistics
    const summary = {
        summary_id: summaryId,
        type: 'trace_summary',
        timestamp: Date.now(),
        createdAt: new Date().toISOString(),
        totalTraces: traces.length,
        originatingTraces: traces.map(t => t.trace_id || 'unknown'),
        byDecision: {},
        byOutcome: {},
        byCategory: {},
        byConfidenceBucket: {},
        byTimestampBucket: {},
        policyStats: {
            totalPolicies: 0,
            allowed: 0,
            blocked: 0,
            avgConfidence: 0,
            byPolicy: {}
        },
        hasOverloadEvents: false,
        hasPolicyConflicts: false,
        avgConfidence: 0
    };

    // Aggregate
    quantized.forEach(q => {
        // Decision counts
        const decision = q.decision || 'unknown';
        summary.byDecision[decision] = (summary.byDecision[decision] || 0) + 1;

        // Outcome counts
        const outcome = q.outcome || 'unknown';
        summary.byOutcome[outcome] = (summary.byOutcome[outcome] || 0) + 1;

        // Category counts
        const category = q.category;
        summary.byCategory[category] = (summary.byCategory[category] || 0) + 1;

        // Confidence buckets
        const confBucket = q.confidenceBucket;
        summary.byConfidenceBucket[confBucket] = (summary.byConfidenceBucket[confBucket] || 0) + 1;

        // Time buckets
        const timeBucket = q.timestampBucket;
        summary.byTimestampBucket[timeBucket] = (summary.byTimestampBucket[timeBucket] || 0) + 1;

        // Policy stats
        summary.policyStats.totalPolicies += q.policyCount;
        summary.policyStats.allowed += q.policyCount - (q.hasFailures ? q.policyCount : 0);
        summary.policyStats.blocked += q.hasFailures ? q.policyCount : 0;

        summary.hasOverloadEvents = summary.hasOverloadEvents || q.overloadCount > 0;

        if (!summary.policyStats.byPolicy.overload) {
            summary.policyStats.byPolicy.overload = q.overloadCount;
        }
    });

    // Calculate average confidence
    const confidenceSum = traces.reduce((sum, t) => sum + (t.confidence || 0), 0);
    summary.avgConfidence = Math.round(confidenceSum / traces.length);

    // Determine summary type
    if (summary.hasOverloadEvents) {
        summary.summaryType = 'overload_aggregate';
    } else if (summary.byOutcome.failure > 0 || summary.byOutcome.error > 0) {
        summary.summaryType = 'failure_aggregate';
    } else if (summary.byCategory['high_confidence_failure'] > 0) {
        summary.summaryType = 'policy_conflict_aggregate';
    } else if (summary.byDecision.accepted > summary.byDecision.rejected * 2) {
        summary.summaryType = 'healthy_aggregate';
    } else {
        summary.summaryType = 'general_aggregate';
    }

    return summary;
}

// ======================================================
// TRACE COMPACTION
// ======================================================

/**
 * Check if trace needs compaction.
 */
async function needsCompaction(redis, trace) {
    const category = categorizeTrace(trace);

    // Never compact these types
    if (TRACE_COMPACTOR_CONFIG.neverCompactTypes.includes(trace.type || '')) {
        return false;
    }

    // Keep detailed traces
    if (category.category === 'detailed') {
        return false;
    }

    // Check thresholds based on category
    const threshold = {
        'compact_aggressive': TRACE_COMPACTOR_CONFIG.healthyDecisionThreshold,
        'compact_normal': TRACE_COMPACTOR_CONFIG.policyDecisionThreshold,
        default: TRACE_COMPACTOR_CONFIG.admissionDecisionThreshold
    };

    // For aggregate types, check if threshold reached
    if (category.category === 'compact_aggressive' || category.category === 'compact_normal') {
        const key = `${COMPACTOR_PREFIX}:${category.category}:count`;
        const count = parseInt(await redis.get(key) || '0', 10);

        if (count >= threshold[category.category] || threshold.default) {
            return true;
        }
    }

    return false;
}

/**
 * Compact traces by type.
 */
async function compactTracesByType(redis, type) {
    const decayKey = `${COMPACTOR_PREFIX}:${type}:threshold_reached`;

    // Check if threshold reached
    const decay = await redis.get(decayKey);
    if (!decay) {
        await redis.set(decayKey, '1', 'EX', 3600); // 1 hour decay window
        return { thresholdReached: false, reason: 'not_yet_met' };
    }

    // Get recent traces of this type
    const pattern = `${COMPACTOR_PREFIX}:traces:${type}:*`;
    const keys = await redis.keys(pattern);
    const traceKeys = keys.slice(0, TRACE_COMPACTOR_CONFIG.admissionDecisionThreshold);

    if (traceKeys.length < TRACE_COMPACTOR_CONFIG.admissionDecisionThreshold) {
        return { thresholdReached: false, reason: 'insufficient_traces', count: traceKeys.length };
    }

    // Fetch traces
    const traces = [];
    for (const key of traceKeys) {
        const raw = await redis.get(key);
        if (raw) {
            try {
                traces.push(JSON.parse(raw));
            } catch (e) {
                // Skip invalid entries
            }
        }
    }

    if (traces.length < TRACE_COMPACTOR_CONFIG.admissionDecisionThreshold) {
        return { thresholdReached: false, reason: 'insufficient_parsable', count: traces.length };
    }

    // Create summary
    const summaryId = `trace_summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const summary = createSummary(traces, summaryId);

    // Store summary
    const summaryKey = `${SUMMARY_KEY}:${summaryId}`;
    await redis.set(summaryKey, JSON.stringify(summary), 'EX', TRACE_COMPACTOR_CONFIG.summaryTtlMs);

    // Delete original traces
    const deleted = await redis.del(traceKeys);
    await redis.set(`${COMPACTOR_PREFIX}:${type}:count`, '0');

    log(`TRACE_COMPACTED: ${type} (${traces.length} traces → summary)`);

    return {
        thresholdReached: true,
        summaryId,
        originalCount: traces.length,
        deleted,
        summary
    };
}

/**
 * Run compaction on all types.
 */
async function compactAllTraces(redis) {
    const results = {
        admission: await compactTracesByType(redis, 'admission'),
        dispatch: await compactTracesByType(redis, 'dispatch'),
        retry: await compactTracesByType(redis, 'retry'),
        policy: await compactTracesByType(redis, 'policy'),
        overload: await compactTracesByType(redis, 'overload')
    };

    return results;
}

// ======================================================
// SUMMARIES
// ======================================================

/**
 * Get summary by ID.
 */
async function getSummary(redis, summaryId) {
    const key = `${SUMMARY_KEY}:${summaryId}`;
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
}

/**
 * Get recent summaries.
 */
async function getRecentSummaries(redis, limit = 20) {
    const keys = await redis.keys(`${SUMMARY_KEY}:*`);
    const summaries = [];

    for (const key of keys.slice(0, limit)) {
        const raw = await redis.get(key);
        if (raw) {
            try {
                summaries.push(JSON.parse(raw));
            } catch (e) {
                // Skip
            }
        }
    }

    return summaries.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Get summaries by type.
 */
async function getSummariesByType(redis, type, limit = 10) {
    const keys = await redis.keys(`${SUMMARY_KEY}:*`);
    const summaries = [];

    for (const key of keys) {
        const raw = await redis.get(key);
        if (raw) {
            try {
                const summary = JSON.parse(raw);
                if (summary.type === type) {
                    summaries.push(summary);
                }
            } catch (e) {
                // Skip
            }
        }
    }

    return summaries.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

/**
 * Get summary statistics.
 */
async function getSummaryStats(redis) {
    const keys = await redis.keys(`${SUMMARY_KEY}:*`);
    const summaries = await Promise.all(keys.map(async key => {
        const raw = await redis.get(key);
        return raw ? JSON.parse(raw) : null;
    }).filter(Boolean));

    const stats = {
        totalSummaries: summaries.length,
        byType: {},
        bySummaryType: {},
        avgTracesPerSummary: 0,
        totalTracesAggregated: 0
    };

    for (const s of summaries) {
        stats.byType[s.type] = (stats.byType[s.type] || 0) + 1;
        stats.bySummaryType[s.summaryType || 'unknown'] = (stats.bySummaryType[s.summaryType || 'unknown'] || 0) + 1;
        stats.totalTracesAggregated += s.totalTraces || 0;
    }

    stats.avgTracesPerSummary = summaries.length > 0
        ? Math.round(stats.totalTracesAggregated / summaries.length)
        : 0;

    return stats;
}

// ======================================================
// TRACE STORAGE WITH COMPACTION
// ======================================================

/**
 * Store trace with automatic compaction check.
 */
async function storeTraceWithCompaction(redis, trace) {
    // Store original
    const traceKey = `${COMPACTOR_PREFIX}:traces:${trace.type}:${trace.trace_id}`;
    await redis.set(traceKey, JSON.stringify(trace), 'EX', TRACE_COMPACTOR_CONFIG.traceRetentionMs);

    // Check if this type has reached compaction threshold
    const needsCompact = await needsCompaction(redis, trace);

    if (needsCompact) {
        return compactTracesByType(redis, trace.type);
    }

    return { compactionNeeded: false, stored: true };
}

/**
 * Get recent detailed traces.
 */
async function getRecentDetailedTraces(redis, limit = 50) {
    const keys = await redis.keys(`${DETAILED_TRACE_KEY}:*`);
    const traces = [];

    for (const key of keys.slice(0, limit)) {
        const raw = await redis.get(key);
        if (raw) {
            try {
                traces.push(JSON.parse(raw));
            } catch (e) {
                // Skip
            }
        }
    }

    return traces.sort((a, b) => b.timestamp - a.timestamp);
}

// ======================================================
// COMPACTION STATUS
// ======================================================

/**
 * Get compaction status.
 */
async function getCompactionStatus(redis) {
    const [thresholds, summaries, detailed] = await Promise.all([
        getCompactionThresholds(redis),
        getSummaryStats(redis),
        redis.keys(`${DETAILED_TRACE_KEY}:*`).then(k => k.length)
    ]);

    return {
        timestamp: Date.now(),
        thresholds,
        summaries,
        detailedTraceCount: detailed,
        config: TRACE_COMPACTOR_CONFIG
    };
}

/**
 * Get compaction thresholds.
 */
async function getCompactionThresholds(redis) {
    const thresholds = {
        overloadThrottle: parseInt(await redis.get(`${COMPACTOR_PREFIX}:overload_throttle:count`) || '0', 10),
        admissionDecision: parseInt(await redis.get(`${COMPACTOR_PREFIX}:admission:count`) || '0', 10),
        policyDecision: parseInt(await redis.get(`${COMPACTOR_PREFIX}:policy:count`) || '0', 10),
        healthyDecision: parseInt(await redis.get(`${COMPACTOR_PREFIX}:healthy:count`) || '0', 10)
    };

    return thresholds;
}

/**
 * Increment compaction counter.
 */
async function incrementCompactionCounter(redis, type) {
    const key = `${COMPACTOR_PREFIX}:${type}:count`;
    const current = await redis.incr(key);
    await redis.expire(key, 86400); // 24 hour TTL
    return current;
}

// ======================================================
// TRACE DELETION (old traces cleanup)
// ======================================================

/**
 * Delete old traces beyond retention.
 */
async function cleanupOldTraces(redis) {
    const cutoff = Date.now() - TRACE_COMPACTOR_CONFIG.traceRetentionMs;
    const keys = await redis.keys(`${COMPACTOR_PREFIX}:traces:*`);

    let deleted = 0;
    for (const key of keys) {
        const raw = await redis.get(key);
        if (raw) {
            try {
                const trace = JSON.parse(raw);
                if (trace.timestamp < cutoff) {
                    await redis.del(key);
                    deleted++;
                }
            } catch (e) {
                // Invalid entry
                await redis.del(key);
                deleted++;
            }
        }
    }

    log(`TRACE_CLEANUP: deleted ${deleted} old traces`);

    return { deleted, cutoff };
}

/**
 * Get trace age distribution.
 */
async function getTraceAgeDistribution(redis) {
    const keys = await redis.keys(`${COMPACTOR_PREFIX}:traces:*`);
    const now = Date.now();
    const ageBuckets = {
        '0-1h': 0,
        '1-6h': 0,
        '6-24h': 0,
        '1-7d': 0,
        '7d+': 0
    };

    for (const key of keys) {
        const raw = await redis.get(key);
        if (raw) {
            try {
                const trace = JSON.parse(raw);
                const age = now - trace.timestamp;

                if (age < 3600000) ageBuckets['0-1h']++;
                else if (age < 21600000) ageBuckets['1-6h']++;
                else if (age < 86400000) ageBuckets['6-24h']++;
                else if (age < 604800000) ageBuckets['1-7d']++;
                else ageBuckets['7d+']++;
            } catch (e) {
                // Skip invalid
            }
        }
    }

    return ageBuckets;
}

// ======================================================
// COMPACTION REPORT
// ======================================================

/**
 * Generate compaction report.
 */
async function generateCompactionReport(redis) {
    const [status, summaries, ageDist] = await Promise.all([
        getCompactionStatus(redis),
        getRecentSummaries(redis, 50),
        getTraceAgeDistribution(redis)
    ]);

    // Calculate compression ratio
    const originalCount = await redis.keys(`${COMPACTOR_PREFIX}:traces:*`).then(k => k.length);
    const summaryCount = summaries.length;
    const totalTracesInSummaries = summaries.reduce((sum, s) => sum + (s.totalTraces || 0), 0);

    return {
        timestamp: Date.now(),
        reportGenerated: new Date().toISOString(),
        status,
        summaries: summaries.slice(0, 20),
        ageDistribution: ageDist,
        compression: {
            originalTraces: originalCount,
            summaryEntries: summaryCount,
            totalTracesInSummaries,
            compressionRatio: originalCount > 0 ? (totalTracesInSummaries / originalCount).toFixed(2) : 'N/A'
        },
        recommendations: generateRecommendations(status, ageDist)
    };
}

/**
 * Generate recommendations based on compaction data.
 */
function generateRecommendations(status, ageDist) {
    const recommendations = [];

    // High percentage of old traces
    if (ageDist['7d+'] > ageDist['0-1h']) {
        recommendations.push({
            priority: 'high',
            action: 'increase_compaction_frequency',
            reason: `More 7d+ traces (${ageDist['7d+']}) than recent traces (${ageDist['0-1h']})`
        });
    }

    // High summary count suggests aggressive compaction
    if (status.summaries.totalSummaries > 100) {
        recommendations.push({
            priority: 'medium',
            action: 'review_compaction_thresholds',
            reason: `High summary count (${status.summaries.totalSummaries}) during this period`
        });
    }

    // Poor compression ratio
    if (status.config && originalCount > 0 && totalTracesInSummaries / originalCount < 0.5) {
        recommendations.push({
            priority: 'low',
            action: 'consider_more_aggressive_compaction',
            reason: 'Compression ratio is lower than expected'
        });
    }

    return recommendations;
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    TRACE_COMPACTOR_CONFIG,

    // Categorization
    categorizeTrace,
    shouldKeepDetailed,
    quantizeTrace,
    quantizeConfidence,
    quantizeTimestamp,

    // Summary creation
    createSummary,
    getSummary,
    getRecentSummaries,
    getSummariesByType,
    getSummaryStats,

    // Compaction
    needsCompaction,
    compactTracesByType,
    compactAllTraces,
    storeTraceWithCompaction,

    // Status
    getCompactionStatus,
    getCompactionThresholds,
    incrementCompactionCounter,

    // Cleanup
    cleanupOldTraces,
    getTraceAgeDistribution,

    // Reports
    generateCompactionReport,
    getRecentDetailedTraces
};
