// ======================================================
// bootstrapNextWindow — explicit Continue clears the cancellation tombstone
// ======================================================
// Cathedral Recon #3 §5.4 follow-up: the VBook "Continue" action is an
// explicit NEW run (same semantics as POST /regenerate). It must clear the
// persistent cancellation tombstone — otherwise a cancelled-then-continued
// book would be skipped by startup-resume after a Redis loss even though the
// user explicitly resumed it.
//
// bootstrapNextWindow throws "cannot determine next window offset" BEFORE
// starting the pipeline (no saved windows), but AFTER the tombstone-clear
// block — so we can assert the clear happens without exercising the pipeline.

const { expect } = require('chai');

const TEST_BOOK = 'bootstrap-continue-test';

const postgres = require('../src/storage/postgres');
const generationCancelRepo = require('../src/storage/postgres/repositories/generation-cancel-repo');
const { createMockRedis } = require('./mocks/redis-mock');

describe('bootstrapNextWindow — explicit Continue clears cancellation tombstone', function () {
    this.timeout(20000);

    const modulePaths = [
        '../src/services/agent/bootstrap',
        '../src/book/lazy-book',
    ];
    const savedCache = new Map();
    let draftToReturn;

    beforeEach(() => {
        savedCache.clear();
        for (const request of modulePaths) {
            const resolved = require.resolve(request);
            savedCache.set(resolved, require.cache[resolved]);
            delete require.cache[resolved];
        }
        // Re-stub after the cache clear (the stub must be in place when
        // bootstrap.js re-requires lazy-book). A draft whose chapters dir does
        // not exist → getLastSourceEnd() = null → bootstrapNextWindow throws
        // before pipeline. Exactly what we need: the tombstone-clear block runs
        // BEFORE the offset determination.
        draftToReturn = {
            sourceText: 'Some source text for the continue test.',
            book: { language: 'en' },
            manifest: { build_id: `build_${TEST_BOOK}`, state: 'bootstrapped' },
        };
        stub('../src/book/lazy-book', {
            loadDraftBook: () => draftToReturn,
            getBookDir: () => '/tmp/nonexistent-bootstrap-dir',
            getBookMetaPath: () => '/tmp/nonexistent-bootstrap-dir/meta.json',
            getChapterDir: () => '/tmp/nonexistent-bootstrap-dir/chapters',
            SourceType: { TXT: 'txt' },
            BookState: { BOOTSTRAPPED: 'bootstrapped', ACTIVE: 'active' },
        });
    });

    afterEach(async () => {
        for (const request of modulePaths) {
            const resolved = require.resolve(request);
            const saved = savedCache.get(resolved);
            if (saved) require.cache[resolved] = saved;
            else delete require.cache[resolved];
        }
        await postgres.query('DELETE FROM generation_cancellations WHERE book_id = $1', [TEST_BOOK]);
        await postgres.query('DELETE FROM agent_sessions WHERE book_id = $1', [TEST_BOOK]);
    });

    function stub(request, exports) {
        const resolved = require.resolve(request);
        require.cache[resolved] = { exports, id: resolved, filename: resolved, loaded: true };
    }

    before(async () => {
        await postgres.initialize();
    });

    it('clears the tombstone when the user explicitly continues (Continue = new run)', async () => {
        // User cancelled earlier → tombstone present.
        await generationCancelRepo.setCancelled(TEST_BOOK, { reason: 'user_cancelled' });
        expect(await generationCancelRepo.isCancelled(TEST_BOOK)).to.equal(true);

        const { bootstrapNextWindow } = require('../src/services/agent/bootstrap');
        const redis = createMockRedis();

        // No saved windows → throws before pipeline, but after tombstone clear.
        let thrown = null;
        try {
            await bootstrapNextWindow(TEST_BOOK, () => {}, null, redis);
        } catch (err) {
            thrown = err;
        }
        expect(thrown, 'bootstrapNextWindow should throw').to.exist;
        expect(thrown.message).to.match(/cannot determine next window offset/);

        // The explicit Continue cleared the persistent tombstone.
        expect(await generationCancelRepo.isCancelled(TEST_BOOK)).to.equal(false);
    });

    it('does NOT clear the tombstone when the book is not found (no explicit run)', async () => {
        await generationCancelRepo.setCancelled(TEST_BOOK, { reason: 'user_cancelled' });

        draftToReturn = null; // book missing → throw before tombstone-clear block
        const { bootstrapNextWindow } = require('../src/services/agent/bootstrap');
        const redis = createMockRedis();

        let thrown = null;
        try {
            await bootstrapNextWindow(TEST_BOOK, () => {}, null, redis);
        } catch (err) {
            thrown = err;
        }
        expect(thrown, 'bootstrapNextWindow should throw').to.exist;
        expect(thrown.message).to.match(/not found/);

        // The tombstone is untouched — no explicit continuation happened.
        expect(await generationCancelRepo.isCancelled(TEST_BOOK)).to.equal(true);
    });
});
