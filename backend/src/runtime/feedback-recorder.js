const { log, warn, FEEDBACK_CONFIG, FEEDBACK_PREFIX } = require('./feedback-config');

function createSample({
    type,
    timestamp = Date.now(),
    value,
    context = {},
    metadata = {}
}) {
    return {
        sample_id: `sample-${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
        type,
        timestamp,
        value,
        context,
        metadata,
        created_at: new Date().toISOString()
    };
}

async function recordRenderDuration(redis, scene, durationMs) {
    const key = `${FEEDBACK_PREFIX}:render_duration`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.RENDER_DURATION,
        value: durationMs,
        context: { ...scene },
        metadata: { durationMs }
    });
    await storeSample(redis, key, sample);
    return sample;
}

async function recordRetryOutcome(redis, scene, success) {
    const key = `${FEEDBACK_PREFIX}:retry_outcome`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.RETRY_SUCCESS_RATE,
        value: success ? 1 : 0,
        context: { ...scene },
        metadata: { success }
    });
    await storeSample(redis, key, sample);
    return sample;
}

async function recordFailure(redis, scene, type, stage) {
    const key = `${FEEDBACK_PREFIX}:failures`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.FAILURE_RATE,
        value: 1,
        context: { ...scene, failureType: type, stage },
        metadata: { type, stage }
    });
    await storeSample(redis, key, sample);
    return sample;
}

async function recordOverloadEvent(redis, runtimeState) {
    const key = `${FEEDBACK_PREFIX}:overload_events`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.OVERLOAD_FREQUENCY,
        value: 1,
        context: { runtimeState },
        metadata: { runtimeState }
    });
    await storeSample(redis, key, sample);
    return sample;
}

async function recordQueueWaitTime(redis, scene, waitMs) {
    const key = `${FEEDBACK_PREFIX}:queue_wait`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.QUEUE_WAIT_TIME,
        value: waitMs,
        context: { ...scene },
        metadata: { waitMs }
    });
    await storeSample(redis, key, sample);
    return sample;
}

async function recordStarvationEvent(redis, scene) {
    const key = `${FEEDBACK_PREFIX}:starvation_events`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.STARVATION_COUNT,
        value: 1,
        context: { ...scene },
        metadata: { scene }
    });
    await storeSample(redis, key, sample);
    return sample;
}

async function recordCircuitEvent(redis, stage, eventData) {
    const key = `${FEEDBACK_PREFIX}:circuit_events`;
    const sample = createSample({
        type: FEEDBACK_CONFIG.feedbackTypes.CIRCUIT_OPEN_COUNT,
        value: 1,
        context: { stage },
        metadata: { ...eventData }
    });
    await storeSample(redis, key, sample);
    return sample;
}

async function storeSample(redis, key, sample) {
    const sampleKey = `${key}:${sample.sample_id}`;
    await redis.set(sampleKey, JSON.stringify(sample), 'EX', 86400000);

    const seriesKey = `${key}:series`;
    await redis.zadd(seriesKey, sample.timestamp, JSON.stringify(sample));

    await redis.zremrangebyscore(seriesKey, '-inf', Date.now() - FEEDBACK_CONFIG.maxHistorySamples * 1000);

    return sample.sample_id;
}

async function getSamples(redis, type, limit = 100) {
    const key = `${FEEDBACK_PREFIX}:${type}:series`;
    const samples = await redis.zrange(key, -limit, -1);
    return samples.map(s => JSON.parse(s));
}

async function getRecentSamples(redis, type, minutes = 60) {
    const key = `${FEEDBACK_PREFIX}:${type}:series`;
    const cutoff = Date.now() - minutes * 60000;

    const samples = await redis.zrangebyscore(key, cutoff, '+inf');
    return samples.map(s => JSON.parse(s));
}

module.exports = {
    createSample,
    recordRenderDuration, recordRetryOutcome, recordFailure,
    recordOverloadEvent, recordQueueWaitTime,
    recordStarvationEvent, recordCircuitEvent,
    storeSample, getSamples, getRecentSamples,
};
