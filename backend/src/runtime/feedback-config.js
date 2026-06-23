const logPrefix = '[FEEDBACK]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

const FEEDBACK_CONFIG = {
    sampleIntervalMs: 60000,
    minSamplesForAdjustment: 5,
    maxHistorySamples: 1000,
    thresholdAdjustmentRate: 0.1,
    thresholdUpdateMinDelayMs: 300000,
    costAdjustmentFactor: 1.2,
    costAdjustmentFactorOptimistic: 0.9,
    feedbackTypes: {
        RENDER_DURATION: 'render_duration',
        RETRY_SUCCESS_RATE: 'retry_success_rate',
        FAILURE_RATE: 'failure_rate',
        OVERLOAD_FREQUENCY: 'overload_frequency',
        QUEUE_WAIT_TIME: 'queue_wait_time',
        STARVATION_COUNT: 'starvation_count',
        CIRCUIT_OPEN_COUNT: 'circuit_open_count'
    },
    adjustments: {
        QUOTAS: 'quotas',
        RETRY_DELAY: 'retry_delay',
        OVERLOAD_THRESHOLD: 'overload_threshold',
        STARVATION_BOOST: 'starvation_boost',
        COST_ESTIMATION: 'cost_estimation',
        ADMISSION_STRICTNESS: 'admission_strictness'
    }
};

const FEEDBACK_PREFIX = 'animastor:runtime:feedback';
const ADJUSTMENT_HISTORY_KEY = 'animastor:runtime:adjustments';
const METRICS_HISTORY_KEY = 'animastor:runtime:metrics-history';
const COST_HISTORY_KEY = 'animastor:runtime:cost-history';

module.exports = {
    log, warn, FEEDBACK_CONFIG, FEEDBACK_PREFIX,
    ADJUSTMENT_HISTORY_KEY, METRICS_HISTORY_KEY, COST_HISTORY_KEY,
};
