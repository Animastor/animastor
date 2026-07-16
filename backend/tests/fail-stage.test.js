// ======================================================
// orchestrator.failStage — T3 консолидации
// ======================================================
// Канал ошибок worker → gpu-hub → backend: сбой генерации становится
// командой фасада (FAILED → PENDING для передиспатча планировщиком),
// а не истёкшим dispatch-lease через 15–30 минут.

const { expect } = require('chai');
const orchestrator = require('../src/orchestration/orchestrator');
const state = require('../src/state');

class FakeRedis {
    constructor() {
        this.store = new Map();
        this.lists = new Map();
    }
    async get(k) {
        const v = this.store.get(k);
        return v === undefined ? null : v;
    }
    async set(k, v, ...args) {
        if (args.includes('NX') && this.store.has(k)) return null;
        this.store.set(k, v);
        return 'OK';
    }
    async del(...keys) {
        let n = 0;
        for (const k of keys) if (this.store.delete(k)) n++;
        return n;
    }
    async incr(k) {
        const v = (parseInt(this.store.get(k), 10) || 0) + 1;
        this.store.set(k, String(v));
        return v;
    }
    async decr(k) {
        const v = (parseInt(this.store.get(k), 10) || 0) - 1;
        this.store.set(k, String(v));
        return v;
    }
    async expire() { return 1; }
    async exists(k) { return this.store.has(k) ? 1 : 0; }
    async hset(k, field, value) {
        let h = this.store.get(k);
        if (!h || typeof h !== 'object') { h = {}; this.store.set(k, h); }
        if (typeof field === 'object') { Object.assign(h, field); return Object.keys(field).length; }
        h[field] = value;
        return 1;
    }
    async hget(k, f) {
        const h = this.store.get(k);
        return h && typeof h === 'object' ? (h[f] ?? null) : null;
    }
    async hgetall(k) {
        const h = this.store.get(k);
        return h && typeof h === 'object' ? h : null;
    }
    async rpush(k, ...items) {
        const l = this.lists.get(k) || [];
        l.push(...items);
        this.lists.set(k, l);
        return l.length;
    }
    async lrange(k, s, e) {
        const l = this.lists.get(k) || [];
        return e === -1 ? l.slice(s) : l.slice(s, e + 1);
    }
    async eval() { return 1; }
    async scan() { return ['0', []]; }
    async keys() { return []; }
    async zrem() { return 0; }
}

const B = 'test_book', C = 'ch-1', S = 'sc-1';

async function setStage(redis, stage, value) {
    await state.setAssetState(redis, B, C, S, stage, value);
}

async function getStage(redis, stage) {
    const states = await state.getAssetStates(redis, B, C, S);
    return states[stage];
}

describe('orchestrator.failStage (T3)', () => {
    let redis;
    beforeEach(() => { redis = new FakeRedis(); });

    it('GENERATING → FAILED → PENDING (redispatch по умолчанию)', async () => {
        await setStage(redis, 'audio', state.AssetState.GENERATING);
        const result = await orchestrator.failStage(redis, B, C, S, 'audio', 'b1', 'worker_timeout');
        expect(result.failed).to.equal(true);
        expect(result.redispatch).to.equal(true);
        expect(await getStage(redis, 'audio')).to.equal(state.AssetState.PENDING);
    });

    it('пишет событие *_FAILED в event journal', async () => {
        await setStage(redis, 'video', state.AssetState.GENERATING);
        await orchestrator.failStage(redis, B, C, S, 'video', 'b1', 'oom');
        const events = (await redis.lrange(`animastor:event-journal:${B}:${C}:${S}`, 0, -1))
            .map(JSON.parse);
        const failed = events.find(e => e.type === 'VIDEO_FAILED');
        expect(failed).to.exist;
        expect(failed.details.reason).to.equal('oom');
    });

    it('redispatch:false оставляет FAILED', async () => {
        await setStage(redis, 'image', state.AssetState.GENERATING);
        await orchestrator.failStage(redis, B, C, S, 'image', 'b1', 'err', { redispatch: false });
        expect(await getStage(redis, 'image')).to.equal(state.AssetState.FAILED);
    });

    it('поздняя ошибка после READY игнорируется (валидация перехода)', async () => {
        await setStage(redis, 'audio', state.AssetState.READY);
        const result = await orchestrator.failStage(redis, B, C, S, 'audio', 'b1', 'late_error');
        expect(result.failed).to.equal(false);
        expect(await getStage(redis, 'audio')).to.equal(state.AssetState.READY);
        const events = (await redis.lrange(`animastor:event-journal:${B}:${C}:${S}`, 0, -1))
            .map(JSON.parse);
        expect(events.some(e => e.type === 'INVALID_STATE_CALLBACK')).to.equal(true);
    });

    it('PENDING → FAILED допустим (ошибка до фактического dispatch)', async () => {
        await setStage(redis, 'image', state.AssetState.PENDING);
        const result = await orchestrator.failStage(redis, B, C, S, 'image', 'b1', 'dispatch_error');
        expect(result.failed).to.equal(true);
    });

    it('неизвестный stage бросает ошибку', async () => {
        try {
            await orchestrator.failStage(redis, B, C, S, 'music', 'b1', 'x');
            expect.fail('should have thrown');
        } catch (err) {
            expect(err.message).to.match(/unknown stage/);
        }
    });
});
