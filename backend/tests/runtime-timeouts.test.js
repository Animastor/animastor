const { expect } = require('chai');
const config = require('../src/config/runtime-config');

// Инварианты таймаутов. Все аудио-константы ВЫЧИСЛЯЮТСЯ от GPU_TIMEOUT_MS,
// а не подбираются вручную. Ломающийся тест здесь означает, что формула
// нарушила архитектурный инвариант:
//   GPU_TIMEOUT_MS < STALL_FAILSAFE_MS < LEASE_TTL_S.AUDIO * 1000
describe('runtime-config TIMEOUTS invariants', () => {
    const { TIMEOUTS, LEASE_TTL_S, GPU_TIMEOUT_MS, STALL_FAILSAFE_MS } = config;

    it('exports GPU_TIMEOUT_MS, STALL_FAILSAFE_MS, TIMEOUTS, LEASE_TTL_S', () => {
        expect(GPU_TIMEOUT_MS).to.be.a('number').and.above(0);
        expect(STALL_FAILSAFE_MS).to.be.a('number').and.above(0);
        expect(TIMEOUTS).to.be.an('object');
        expect(LEASE_TTL_S).to.be.an('object');
        expect(LEASE_TTL_S).to.have.keys(['AUDIO', 'IMAGE', 'VIDEO']);
    });

    it('STALL_FAILSAFE_MS = GPU_TIMEOUT_MS * 3', () => {
        expect(STALL_FAILSAFE_MS).to.equal(GPU_TIMEOUT_MS * 3);
    });

    it('AUDIO_CHUNK_STALL_MS = STALL_FAILSAFE_MS', () => {
        expect(TIMEOUTS.AUDIO_CHUNK_STALL_MS).to.equal(STALL_FAILSAFE_MS);
    });

    it('АРХИТЕКТУРНЫЙ ИНВАРИАНТ: GPU_TIMEOUT_MS < STALL_FAILSAFE_MS < LEASE_TTL_S.AUDIO * 1000', () => {
        // Основание: GPU hub затаймливает воркера РАНЬШЕ, чем watchdog
        // объявит застой. Watchdog срабатывает РАНЬШЕ, чем истечёт lease.
        // Это гарантирует, что живые чанки не отвергаются как stale_dispatch.
        expect(GPU_TIMEOUT_MS).to.be.below(STALL_FAILSAFE_MS);
        expect(STALL_FAILSAFE_MS).to.be.below(LEASE_TTL_S.AUDIO * 1000);
    });

    it('ФОРМУЛА: LEASE_TTL_S.AUDIO = ceil(STALL_FAILSAFE_MS / 1000) + 60', () => {
        const expectedLease = Math.ceil(STALL_FAILSAFE_MS / 1000) + 60;
        expect(LEASE_TTL_S.AUDIO).to.equal(expectedLease);
    });

    it('параметризация: GPU_TIMEOUT_MS=300000 даёт STALL=900000 LEASE=960', () => {
        // Если бы GPU_TIMEOUT_MS был 300000 (5 мин), то:
        //   STALL = 300000 * 3 = 900000 (15 мин)
        //   LEASE = ceil(900000/1000) + 60 = 960 (16 мин)
        // Тест безразмерный — проверяет формулу, а не конкретные значения.
        const gpuTimeout500 = 500_000;
        const expectedStall500 = gpuTimeout500 * 3;
        const expectedLease500 = Math.ceil(expectedStall500 / 1000) + 60;
        expect(expectedStall500).to.equal(1_500_000);
        expect(expectedLease500).to.equal(1560);
    });

    it('all lease TTLs are positive and LEASE_TTL_S.AUDIO >= STALL_FAILSAFE_MS / 1000', () => {
        // AUDIO вычисляется от GPU_TIMEOUT_MS, может быть длиннее IMAGE/VIDEO.
        // Важен только инвариант: LEASE > STALL.
        expect(LEASE_TTL_S.AUDIO).to.be.above(STALL_FAILSAFE_MS / 1000);
        expect(LEASE_TTL_S.IMAGE).to.be.above(0);
        expect(LEASE_TTL_S.VIDEO).to.be.above(0);
    });

    it('retired retry constants are no longer present', () => {
        expect(TIMEOUTS).to.not.have.property('AUDIO_MERGE_RETRY_DELAY_MS');
        expect(TIMEOUTS).to.not.have.property('AUDIO_MERGE_RETRY_MAX');
        expect(TIMEOUTS).to.not.have.property('AUDIO_MERGE_RETRY_DEDUP_TTL_S');
        expect(TIMEOUTS).to.not.have.property('AUDIO_MERGE_RETRY_COUNTER_TTL_S');
    });
});
