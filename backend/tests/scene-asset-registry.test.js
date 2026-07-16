const { expect } = require('chai');
const sceneHash = require('../src/utils/scene-hash');

describe('Scene Asset Registry (Phase A.4)', () => {
    const testBookId = 'test-book-assets';
    const testChapterId = 'ch-test';
    const testSceneId = 'sc-test';
    let sceneAssetRegistry;

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        sceneAssetRegistry = require('../src/services/scene-asset-registry');
        await sceneAssetRegistry.deleteSceneAssets(testBookId, testChapterId, testSceneId);
    });

    afterEach(async () => {
        await sceneAssetRegistry.deleteSceneAssets(testBookId, testChapterId, testSceneId);
    });

    it('registers an audio asset', async () => {
        const r = await sceneAssetRegistry.registerSceneAudio(
            testBookId, testChapterId, testSceneId,
            { canonicalPath: '/tmp/audio.mp3', duration: 12.5, buildId: 'bld-test-1' }
        );
        expect(r.success).to.be.true;
        expect(r.record.asset_type).to.equal('audio');
        expect(r.record.duration_sec).to.equal(12.5);
    });

    it('registers image, video, storyboard with dimensions', async () => {
        await sceneAssetRegistry.registerSceneImage(
            testBookId, testChapterId, testSceneId,
            { path: '/tmp/img.png', width: 1024, height: 576, buildId: 'bld-test-2' }
        );
        await sceneAssetRegistry.registerSceneVideo(
            testBookId, testChapterId, testSceneId,
            { path: '/tmp/v.mp4', duration: 8.0, buildId: 'bld-test-2' }
        );
        await sceneAssetRegistry.registerStoryboard(
            testBookId, testChapterId, testSceneId,
            { path: '/tmp/sb.json', buildId: 'bld-test-2' }
        );
        const all = await sceneAssetRegistry.getSceneAssets(testBookId, testChapterId, testSceneId);
        expect(all).to.have.property('image');
        expect(all).to.have.property('video');
        expect(all).to.have.property('storyboard');
        expect(all.image.width).to.equal(1024);
        expect(all.video.duration).to.equal(8.0);
    });

    it('getSceneAssets returns legacy-shaped data', async () => {
        await sceneAssetRegistry.registerSceneAudio(
            testBookId, testChapterId, testSceneId,
            { canonicalPath: '/tmp/a2.mp3', duration: 4.0, buildId: 'bld-test-3' }
        );
        const a = await sceneAssetRegistry.getAudioAsset(testBookId, testChapterId, testSceneId);
        expect(a).to.have.property('path');
        expect(a).to.have.property('duration');
        expect(a).to.have.property('ready');
    });

    it('hasAudioAsset / hasImageAsset / hasVideoAsset report correctly', async () => {
        const bookId = testBookId + '-has';
        const ch = 'ch-has';
        const sc = 'sc-has';
        await sceneAssetRegistry.deleteSceneAssets(bookId, ch, sc);

        expect(await sceneAssetRegistry.hasAudioAsset(bookId, ch, sc)).to.be.false;
        expect(await sceneAssetRegistry.hasImageAsset(bookId, ch, sc)).to.be.false;

        await sceneAssetRegistry.registerSceneAudio(bookId, ch, sc, {
            canonicalPath: '/tmp/x.mp3', duration: 1, buildId: 'b1',
        });
        expect(await sceneAssetRegistry.hasAudioAsset(bookId, ch, sc)).to.be.true;

        await sceneAssetRegistry.deleteSceneAssets(bookId, ch, sc);
    });

    it('hasAllAssets requires all three layers', async () => {
        const bookId = testBookId + '-all';
        const ch = 'ch-all';
        const sc = 'sc-all';
        await sceneAssetRegistry.deleteSceneAssets(bookId, ch, sc);

        expect(await sceneAssetRegistry.hasAllAssets(bookId, ch, sc)).to.be.false;

        await sceneAssetRegistry.registerSceneAudio(bookId, ch, sc, { canonicalPath: '/tmp/a.mp3', duration: 1, buildId: 'b1' });
        await sceneAssetRegistry.registerSceneImage(bookId, ch, sc, { path: '/tmp/i.png', buildId: 'b1' });
        expect(await sceneAssetRegistry.hasAllAssets(bookId, ch, sc)).to.be.false;

        await sceneAssetRegistry.registerSceneVideo(bookId, ch, sc, { path: '/tmp/v.mp4', duration: 1, buildId: 'b1' });
        expect(await sceneAssetRegistry.hasAllAssets(bookId, ch, sc)).to.be.true;

        await sceneAssetRegistry.deleteSceneAssets(bookId, ch, sc);
    });

    it('invalidateSceneAssets marks all asset types stale via facade', async () => {
        // T5: invalidateSceneAssets теперь требует redis (через orchestrator.markDirtyScene)
        const { createMockRedis } = require('./mocks/redis-mock');
        const mockRedis = createMockRedis();

        await sceneAssetRegistry.registerSceneAudio(testBookId, testChapterId, testSceneId, {
            canonicalPath: '/tmp/i1.mp3', duration: 1, buildId: 'b-inv',
        });
        await sceneAssetRegistry.registerSceneImage(testBookId, testChapterId, testSceneId, {
            path: '/tmp/i1.png', buildId: 'b-inv',
        });
        const stale = await sceneAssetRegistry.getStaleAssets(testBookId);
        const beforeCount = stale.length;
        await sceneAssetRegistry.invalidateSceneAssets(mockRedis, testBookId, testChapterId, testSceneId);
        const after = await sceneAssetRegistry.getStaleAssets(testBookId);
        expect(after.length).to.be.greaterThan(beforeCount);
    });

    it('updateAssetDuration updates an existing asset', async () => {
        await sceneAssetRegistry.registerSceneAudio(testBookId, testChapterId, testSceneId, {
            canonicalPath: '/tmp/u.mp3', duration: 1, buildId: 'b-upd',
        });
        const r = await sceneAssetRegistry.updateAssetDuration(
            testBookId, testChapterId, testSceneId, 'audio', 9.5, 'b-upd'
        );
        expect(r.success).to.be.true;
        const a = await sceneAssetRegistry.getAudioAsset(testBookId, testChapterId, testSceneId);
        expect(a.duration).to.equal(9.5);
    });

    it('markAssetFailed records an error and status=failed', async () => {
        await sceneAssetRegistry.markAssetFailed(
            testBookId, testChapterId, testSceneId, 'image', 'GPU timeout', 'b-fail'
        );
        const a = await sceneAssetRegistry.getImageAsset(testBookId, testChapterId, testSceneId);
        expect(a.status).to.equal('failed');
        expect(a.error).to.equal('GPU timeout');
    });

    it('recordSceneHash returns hash for a valid scene', async () => {
        const scene = { scene_id: testSceneId, type: 'narration', text: 'hello' };
        const r = await sceneAssetRegistry.recordSceneHash(testBookId, testChapterId, testSceneId, scene);
        expect(r).to.have.property('scene_hash');
        expect(r.scene_hash).to.have.length(64);
    });

    it('getBookAssetSummary returns aggregate counts', async () => {
        const bookId = testBookId + '-sum';
        await sceneAssetRegistry.deleteBookAssets(bookId);
        await sceneAssetRegistry.registerSceneAudio(bookId, 'c1', 's1', { canonicalPath: '/tmp/s1.mp3', duration: 1, buildId: 'b' });
        await sceneAssetRegistry.registerSceneImage(bookId, 'c1', 's1', { path: '/tmp/s1.png', buildId: 'b' });
        const summary = await sceneAssetRegistry.getBookAssetSummary(bookId);
        expect(summary.total).to.be.gte(2);
        await sceneAssetRegistry.deleteBookAssets(bookId);
    });
});
