const { expect } = require('chai');
const layerConfig = require('../src/services/layer-config');

describe('Layer Config Service', () => {
    const fakeRedis = {
        _store: {},
        async get(k) { return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null; },
        async set(k, v) { this._store[k] = v; return 'OK'; },
    };

    beforeEach(() => { fakeRedis._store = {}; });

    it('returns defaults for unknown book', async () => {
        const cfg = await layerConfig.get(fakeRedis, 'unknown-book');
        expect(cfg).to.deep.equal({ audio_enabled: true, image_enabled: true, video_enabled: true });
    });

    it('normalizes legacy single-flag JSON', async () => {
        fakeRedis._store['animastor:layer-config:legacy'] = JSON.stringify({ image_enabled: false });
        const cfg = await layerConfig.get(fakeRedis, 'legacy');
        expect(cfg.image_enabled).to.be.false;
        expect(cfg.audio_enabled).to.be.true;
        expect(cfg.video_enabled).to.be.true;
    });

    it('handles corrupt JSON gracefully', async () => {
        fakeRedis._store['animastor:layer-config:corrupt'] = 'not-json{';
        const cfg = await layerConfig.get(fakeRedis, 'corrupt');
        expect(cfg).to.deep.equal({ audio_enabled: true, image_enabled: true, video_enabled: true });
    });

    it('set merges partial update', async () => {
        await layerConfig.set(fakeRedis, 'b1', { image_enabled: false });
        const cfg = await layerConfig.get(fakeRedis, 'b1');
        expect(cfg).to.deep.equal({ audio_enabled: true, image_enabled: false, video_enabled: true });
    });

    it('set preserves untouched fields', async () => {
        await layerConfig.set(fakeRedis, 'b2', { video_enabled: false });
        await layerConfig.set(fakeRedis, 'b2', { image_enabled: false });
        const cfg = await layerConfig.get(fakeRedis, 'b2');
        expect(cfg).to.deep.equal({ audio_enabled: true, image_enabled: false, video_enabled: false });
    });

    it('set allows audio_enabled=false (image-only mode)', async () => {
        const cfg = await layerConfig.set(fakeRedis, 'b4', { audio_enabled: false });
        expect(cfg.audio_enabled).to.be.false;
        expect(cfg.image_enabled).to.be.true;
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
        expect(cfg).to.deep.equal({ audio_enabled: true, image_enabled: true, video_enabled: true });
        const got = await layerConfig.get(null, 'any');
        expect(got).to.deep.equal({ audio_enabled: true, image_enabled: true, video_enabled: true });
    });
});
