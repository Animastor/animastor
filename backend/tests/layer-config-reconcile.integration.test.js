// ======================================================
// Кирпич №2 — integration test: layer-config restore через РЕАЛЬНЫЙ reconcileCycle
// ======================================================
// Доказательство для ACCEPT: фаза C6 вызывается настоящим циклом
// reconciliation-engine (не изолированно), с реальным layer-config-сервисом,
// реальной файловой системой (tmp BOOKS_DIR) и mock redis. Прочие фазы цикла
// (A/B/C1-C5/D) работают на реальных модулях с mock redis — не стабим их,
// а даём им проявить себя: цикл должен завершиться ok:true в любом случае.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockRedis } = require('./mocks/redis-mock');

const config = require('../src/config/runtime-config');
const layerConfig = require('../src/services/layer-config');
const reconciliation = require('../src/runtime/reconciliation-engine');

describe('Layer-config restore through real reconcileCycle (Кирпич №2, C6)', () => {
    let tmpDir;
    let savedBooksDir;
    let redis;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-lcr-'));
        savedBooksDir = config.BOOKS_DIR;
        config.BOOKS_DIR = tmpDir;
        redis = createMockRedis();
    });

    afterEach(() => {
        config.BOOKS_DIR = savedBooksDir;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeBookDir(bookId, meta) {
        const bookDir = path.join(tmpDir, bookId);
        fs.mkdirSync(bookDir, { recursive: true });
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify(meta));
        return bookDir;
    }

    it('startup cycle (C6) restores missing Redis keys from book.json and reports the phase', async () => {
        const bookId = 'lc-rc-1';
        writeBookDir(bookId, {
            structure: { chapters_order: [] },
            layer_config: { image_enabled: false, video_enabled: false },
        });

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        expect(result.summary.errors).to.deep.equal([]); // весь цикл прошёл чисто
        expect(result.phases).to.include('layer_config_restore:1');
        const restored = JSON.parse(await redis.get(layerConfig.key(bookId)));
        expect(restored.image_enabled).to.be.false;
        expect(restored.video_enabled).to.be.false;
        expect(restored.audio_enabled).to.be.true; // default
    });

    it('periodic (non-startup) cycle also heals a missing key — cache-clear case', async () => {
        const bookId = 'lc-rc-2';
        writeBookDir(bookId, {
            structure: { chapters_order: [] },
            layer_config: { chunk_size: 5, image_enabled: false },
        });

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: false });

        expect(result.ok).to.be.true;
        expect(result.summary.errors).to.deep.equal([]);
        const restored = JSON.parse(await redis.get(layerConfig.key(bookId)));
        expect(restored.chunk_size).to.equal(5);
        expect(restored.image_enabled).to.be.false;
    });

    it('C6 never overwrites live Redis state (SETNX semantics through the real cycle)', async () => {
        const bookId = 'lc-rc-3';
        writeBookDir(bookId, {
            structure: { chapters_order: [] },
            layer_config: { image_enabled: false },
        });
        // Живое состояние (новее durable-копии) — цикл не должен его затронуть.
        await redis.set(layerConfig.key(bookId), JSON.stringify({ image_enabled: true }));

        const result = await reconciliation.reconcileCycle(redis, {}, { startup: true });

        expect(result.ok).to.be.true;
        expect(result.summary.errors).to.deep.equal([]);
        expect(result.phases).to.not.include('layer_config_restore:1');
        expect(JSON.parse(await redis.get(layerConfig.key(bookId))).image_enabled).to.be.true;
    });

    it('restore is idempotent across repeated cycles — NX no-op, key byte-identical', async () => {
        const bookId = 'lc-rc-4';
        writeBookDir(bookId, {
            structure: { chapters_order: [] },
            layer_config: { image_enabled: false, chunk_size: 5 },
        });

        const first = await reconciliation.reconcileCycle(redis, {}, { startup: true });
        expect(first.phases).to.include('layer_config_restore:1');
        const afterFirst = await redis.get(layerConfig.key(bookId));

        // Второй цикл (тот же 60-сек ритм): ключ уже есть → NX no-op → фаза не
        // появляется, значение байт-в-байт не изменилось.
        const second = await reconciliation.reconcileCycle(redis, {}, { startup: false });
        expect(second.ok).to.be.true;
        expect(second.summary.errors).to.deep.equal([]);
        expect(second.phases).to.not.include('layer_config_restore:1');
        expect(await redis.get(layerConfig.key(bookId))).to.equal(afterFirst);
    });
});
