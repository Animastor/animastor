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

    it('AUDIO_CHUNK_STALL_MS is defined', () => {
        expect(TIMEOUTS.AUDIO_CHUNK_STALL_MS).to.be.a('number').and.above(0);
    });

    it('stall watchdog fires before the audio dispatch lease expires', () => {
        // reconcileCycle срабатывает раз в 60с; при первом же прогоне после
        // AUDIO_CHUNK_STALL_MS без новых чанков → failWaitingScene.
        // Должно успеть до протухания lease (LEASE_TTL_S.AUDIO).
        expect(TIMEOUTS.AUDIO_CHUNK_STALL_MS).to.be.below(LEASE_TTL_S.AUDIO * 1000);
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

    it('retired retry constants are no longer present', () => {
        // Убедиться, что никто случайно не вернул старые константы.
        expect(TIMEOUTS).to.not.have.property('AUDIO_MERGE_RETRY_DELAY_MS');
        expect(TIMEOUTS).to.not.have.property('AUDIO_MERGE_RETRY_MAX');
        expect(TIMEOUTS).to.not.have.property('AUDIO_MERGE_RETRY_DEDUP_TTL_S');
        expect(TIMEOUTS).to.not.have.property('AUDIO_MERGE_RETRY_COUNTER_TTL_S');
    });
});
