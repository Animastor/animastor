const { expect } = require('chai');
const config = require('../src/config/runtime-config');

// Инварианты единого реестра таймаутов (T1 консолидации, см.
// docs/03-audit/ORCHESTRATION_CONSOLIDATION_TODO.md). Ломающийся тест здесь
// означает, что новое значение создаёт окно рассинхрона между retry-логикой,
// lease и watchdog'ом gpu-hub — сначала пересчитать цепочку, потом менять.
describe('runtime-config TIMEOUTS invariants', () => {
    const { TIMEOUTS, LEASE_TTL_S } = config;

    it('exports TIMEOUTS and LEASE_TTL_S', () => {
        expect(TIMEOUTS).to.be.an('object');
        expect(LEASE_TTL_S).to.be.an('object');
        expect(LEASE_TTL_S).to.have.keys(['AUDIO', 'IMAGE', 'VIDEO']);
    });

    it('audio merge retries finish within the audio dispatch lease', () => {
        const retrySequenceMs = TIMEOUTS.AUDIO_MERGE_RETRY_MAX * TIMEOUTS.AUDIO_MERGE_RETRY_DELAY_MS;
        expect(retrySequenceMs).to.be.below(LEASE_TTL_S.AUDIO * 1000);
    });

    it('retry counter TTL outlives the whole retry sequence', () => {
        const retrySequenceMs = TIMEOUTS.AUDIO_MERGE_RETRY_MAX * TIMEOUTS.AUDIO_MERGE_RETRY_DELAY_MS;
        expect(TIMEOUTS.AUDIO_MERGE_RETRY_COUNTER_TTL_S * 1000).to.be.above(retrySequenceMs);
    });

    it('retry dedup TTL is longer than a single retry delay', () => {
        expect(TIMEOUTS.AUDIO_MERGE_RETRY_DEDUP_TTL_S * 1000).to.be.at.least(TIMEOUTS.AUDIO_MERGE_RETRY_DELAY_MS);
    });

    it('gpu-hub default GPU_TIMEOUT is below the minimum lease TTL', () => {
        // gpu-hub/gpu-hub.js читает GPU_TIMEOUT из env с дефолтом 600 000 мс;
        // при изменении дефолта там — обновить здесь.
        const GPU_HUB_DEFAULT_TIMEOUT_MS = 600000;
        const minLeaseMs = Math.min(...Object.values(LEASE_TTL_S)) * 1000;
        expect(GPU_HUB_DEFAULT_TIMEOUT_MS).to.be.below(minLeaseMs);
    });

    it('lease TTLs are ordered audio <= image <= video', () => {
        expect(LEASE_TTL_S.AUDIO).to.be.at.most(LEASE_TTL_S.IMAGE);
        expect(LEASE_TTL_S.IMAGE).to.be.at.most(LEASE_TTL_S.VIDEO);
    });
});
