const { expect } = require('chai');
const layerConfig = require('../src/services/layer-config');

describe('Layer Config Service', () => {
    const fakeRedis = {
        _store: {},
        async get(k) { return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null; },
        async set(k, v) { this._store[k] = v; return 'OK'; },
    };

    beforeEach(() => { fakeRedis._store = {}; });

    const DEFAULTS = {
        audio_enabled: true,
        image_enabled: true,
        video_enabled: true,
        chunk_size: 3,
        audio_timeout_minutes: 30,
        image_timeout_minutes: 30,
        video_timeout_minutes: 60,
    };

    it('returns defaults for unknown book', async () => {
        const cfg = await layerConfig.get(fakeRedis, 'unknown-book');
        expect(cfg).to.deep.equal(DEFAULTS);
    });

    it('normalizes legacy single-flag JSON', async () => {
        fakeRedis._store['animastor:layer-config:legacy'] = JSON.stringify({ image_enabled: false });
        const cfg = await layerConfig.get(fakeRedis, 'legacy');
        expect(cfg.image_enabled).to.be.false;
        expect(cfg.audio_enabled).to.be.true;
        expect(cfg.video_enabled).to.be.true;
        expect(cfg.chunk_size).to.equal(3);
    });

    it('handles corrupt JSON gracefully', async () => {
        fakeRedis._store['animastor:layer-config:corrupt'] = 'not-json{';
        const cfg = await layerConfig.get(fakeRedis, 'corrupt');
        expect(cfg).to.deep.equal(DEFAULTS);
    });

    it('set merges partial update', async () => {
        await layerConfig.set(fakeRedis, 'b1', { image_enabled: false });
        const cfg = await layerConfig.get(fakeRedis, 'b1');
        expect(cfg).to.deep.equal({ ...DEFAULTS, image_enabled: false });
    });

    it('set preserves untouched fields', async () => {
        await layerConfig.set(fakeRedis, 'b2', { video_enabled: false });
        await layerConfig.set(fakeRedis, 'b2', { image_enabled: false });
        const cfg = await layerConfig.get(fakeRedis, 'b2');
        expect(cfg).to.deep.equal({ ...DEFAULTS, image_enabled: false, video_enabled: false });
    });

    it('set allows audio_enabled=false (image-only mode)', async () => {
        const cfg = await layerConfig.set(fakeRedis, 'b4', { audio_enabled: false });
        expect(cfg.audio_enabled).to.be.false;
        expect(cfg.image_enabled).to.be.true;
        expect(cfg.chunk_size).to.equal(3);
    });

    it('set supports chunk_size field', async () => {
        const cfg = await layerConfig.set(fakeRedis, 'b5', { chunk_size: 5 });
        expect(cfg.chunk_size).to.equal(5);
        // Reload from Redis
        const got = await layerConfig.get(fakeRedis, 'b5');
        expect(got.chunk_size).to.equal(5);
    });

    it('set clamps chunk_size to valid range [1,5]', async () => {
        const cfgLow = await layerConfig.set(fakeRedis, 'b6', { chunk_size: 0 });
        expect(cfgLow.chunk_size).to.equal(1);
        const cfgHigh = await layerConfig.set(fakeRedis, 'b6', { chunk_size: 10 });
        expect(cfgHigh.chunk_size).to.equal(5);
    });

    it('set clamps timeout values to valid ranges', async () => {
        const cfgLow = await layerConfig.set(fakeRedis, 'b7', { audio_timeout_minutes: 1 });
        expect(cfgLow.audio_timeout_minutes).to.equal(5);
        const cfgHigh = await layerConfig.set(fakeRedis, 'b7', { video_timeout_minutes: 999 });
        expect(cfgHigh.video_timeout_minutes).to.equal(180);
    });

    it('isValidScope accepts only known values', () => {
        expect(layerConfig.isValidScope('current_scene')).to.be.true;
        expect(layerConfig.isValidScope('current_chapter')).to.be.true;
        expect(layerConfig.isValidScope('from_current_scene')).to.be.true;
        expect(layerConfig.isValidScope('whole_book')).to.be.true;
        expect(layerConfig.isValidScope('everywhere')).to.be.false;
    });

    it('key() returns namespaced redis key', () => {
        expect(layerConfig.key('mybook')).to.equal('animastor:layer-config:mybook');
    });

    it('SCOPES is frozen', () => {
        expect(Object.isFrozen(layerConfig.SCOPES)).to.be.true;
    });

    it('set with null redis safely no-ops', async () => {
        const cfg = await layerConfig.set(null, 'any', { image_enabled: false });
        expect(cfg).to.deep.equal(DEFAULTS);
        const got = await layerConfig.get(null, 'any');
        expect(got).to.deep.equal(DEFAULTS);
    });
});
