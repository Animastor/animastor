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

    it('set forces image_enabled when video_enabled=true', async () => {
        await layerConfig.set(fakeRedis, 'b3', { image_enabled: false });
        const cfg = await layerConfig.set(fakeRedis, 'b3', { video_enabled: true });
        expect(cfg.image_enabled).to.be.true;
        expect(cfg.video_enabled).to.be.true;
    });

    it('set allows audio_enabled=false (image-only mode)', async () => {
        const cfg = await layerConfig.set(fakeRedis, 'b4', { audio_enabled: false });
        expect(cfg.audio_enabled).to.be.false;
        expect(cfg.image_enabled).to.be.true;
    });

    it('resolveProfile maps layer config to profile', () => {
        expect(layerConfig.resolveProfile({ audio_enabled: true, image_enabled: false, video_enabled: false })).to.equal('audio_only');
        expect(layerConfig.resolveProfile({ audio_enabled: false, image_enabled: true, video_enabled: false })).to.equal('image_only');
        expect(layerConfig.resolveProfile({ audio_enabled: true, image_enabled: true, video_enabled: false })).to.equal('storyboard');
        expect(layerConfig.resolveProfile({ audio_enabled: true, image_enabled: true, video_enabled: true })).to.equal('full');
        expect(layerConfig.resolveProfile(null)).to.equal('full');
        expect(layerConfig.resolveProfile(undefined)).to.equal('full');
    });

    it('isValidProfile / isValidScope accept only known values', () => {
        expect(layerConfig.isValidProfile('audio_only')).to.be.true;
        expect(layerConfig.isValidProfile('image_only')).to.be.true;
        expect(layerConfig.isValidProfile('storyboard')).to.be.true;
        expect(layerConfig.isValidProfile('full')).to.be.true;
        expect(layerConfig.isValidProfile('unknown')).to.be.false;
        expect(layerConfig.isValidProfile('')).to.be.false;
        expect(layerConfig.isValidScope('current_scene')).to.be.true;
        expect(layerConfig.isValidScope('current_chapter')).to.be.true;
        expect(layerConfig.isValidScope('from_current_scene')).to.be.true;
        expect(layerConfig.isValidScope('whole_book')).to.be.true;
        expect(layerConfig.isValidScope('everywhere')).to.be.false;
    });

    it('key() returns namespaced redis key', () => {
        expect(layerConfig.key('mybook')).to.equal('animastor:layer-config:mybook');
    });

    it('PROFILES and SCOPES are frozen', () => {
        expect(Object.isFrozen(layerConfig.PROFILES)).to.be.true;
        expect(Object.isFrozen(layerConfig.SCOPES)).to.be.true;
    });

    it('set with null redis safely no-ops', async () => {
        const cfg = await layerConfig.set(null, 'any', { image_enabled: false });
        expect(cfg).to.deep.equal({ audio_enabled: true, image_enabled: true, video_enabled: true });
        const got = await layerConfig.get(null, 'any');
        expect(got).to.deep.equal({ audio_enabled: true, image_enabled: true, video_enabled: true });
    });
});
