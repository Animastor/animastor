// ======================================================
// Coreference Resolution — Cleanup Tests (P7)
// ======================================================
// Tests for:
//   - cleanupBookResolutions    — CASCADE delete by book_id
//   - cleanupSceneResolutionRows — delete mentions + sentences by scene
//
// These tests use the real PostgreSQL database (same as
// other integration tests in the project).
// ======================================================

const { expect } = require('chai');
const { query } = require('../src/storage/postgres/database');
const crypto = require('crypto');

// Reuse the cleanup factory to get actual functions
const config = require('../src/config/runtime-config');
const cleanupService = require('../src/services/cleanup-service.cjs');

// Mock Redis with minimal implementation
const mockRedis = {
    set: async () => 'OK',
    get: async () => null,
    del: async () => 1,
    scan: async () => ['0', []],
    exists: async () => 0,
};

const cleanup = cleanupService(mockRedis, config, { log: () => {} });

// Generate a valid UUID v4
function uuid() {
    return crypto.randomUUID();
}

describe('Coreference — cleanupBookResolutions', function () {
    // Allow more time for DB operations
    this.timeout(10000);

    const TEST_BOOK_ID = 'test_book_cleanup_' + Date.now();
    const TEST_RUN_ID = uuid();

    before(async () => {
        // Insert test data: resolution run, window candidate, mention, sentence
        await query(
            `INSERT INTO character_resolution_runs (run_id, book_id, analysis_window_index, run_type, status, resolver_version, source_start, source_end, character_registry_hash, source_hash, created_at)
             VALUES ($1, $2, 0, 'coarse_candidates', 'completed', '1.0.0', 0, 100, 'test_hash', 'test_hash', EXTRACT(EPOCH FROM NOW())::bigint)`,
            [TEST_RUN_ID, TEST_BOOK_ID]
        );
        await query(
            `INSERT INTO character_window_candidates (run_id, book_id, analysis_window_index, source_start, source_end, character_id)
             VALUES ($1, $2, 0, 0, 100, 'berlioz')`,
            [TEST_RUN_ID, TEST_BOOK_ID]
        );
        await query(
            `INSERT INTO character_mentions (run_id, book_id, scene_id, sentence_index, source_start, source_end, mention_text, mention_norm, mention_type)
             VALUES ($1, $2, 'scene_test', 0, 0, 50, 'Берлиоз', 'berlioz', 'name')`,
            [TEST_RUN_ID, TEST_BOOK_ID]
        );
    });

    it('deletes resolution runs for a book', async () => {
        const before = await query(
            'SELECT COUNT(*) as cnt FROM character_resolution_runs WHERE book_id = $1',
            [TEST_BOOK_ID]
        );
        expect(parseInt(before.rows[0].cnt, 10)).to.be.at.least(1);

        const result = await cleanup.cleanupBookResolutions(TEST_BOOK_ID);
        expect(result.ok).to.be.true;
        expect(result.deleted_runs).to.be.at.least(1);
    });

    it('returns ok: false for empty book_id', async () => {
        const result = await cleanup.cleanupBookResolutions('');
        expect(result.ok).to.be.false;
    });

    it('returns ok: true for non-existent book_id', async () => {
        const result = await cleanup.cleanupBookResolutions('non_existent_book_xyz');
        expect(result.ok).to.be.true;
    });
});

describe('Coreference — cleanupSceneResolutionRows', function () {
    this.timeout(10000);

    const TEST_BOOK_ID = 'test_scene_cleanup_' + Date.now();
    const TEST_RUN_ID = uuid();
    const TEST_SCENE_ID = 'test_scene_001';

    before(async () => {
        await query(
            `INSERT INTO character_resolution_runs (run_id, book_id, analysis_window_index, run_type, status, resolver_version, source_start, source_end, character_registry_hash, source_hash, created_at)
             VALUES ($1, $2, 0, 'fine_mentions', 'completed', '1.0.0', 0, 100, 'test_hash', 'test_hash', EXTRACT(EPOCH FROM NOW())::bigint)`,
            [TEST_RUN_ID, TEST_BOOK_ID]
        );
        await query(
            `INSERT INTO character_mentions (run_id, book_id, scene_id, sentence_index, source_start, source_end, mention_text, mention_norm, mention_type)
             VALUES ($1, $2, $3, 0, 0, 50, 'Берлиоз', 'berlioz', 'name')`,
            [TEST_RUN_ID, TEST_BOOK_ID, TEST_SCENE_ID]
        );
        await query(
            `INSERT INTO sentence_resolutions (run_id, book_id, scene_id, sentence_index, source_start, source_end, sentence_text)
             VALUES ($1, $2, $3, 0, 0, 50, 'Берлиоз шёл.')`,
            [TEST_RUN_ID, TEST_BOOK_ID, TEST_SCENE_ID]
        );
    });

    it('deletes mentions and sentences for a scene', async () => {
        const result = await cleanup.cleanupSceneResolutionRows(TEST_BOOK_ID, null, TEST_SCENE_ID);
        expect(result.ok).to.be.true;

        const mentions = await query(
            'SELECT COUNT(*) as cnt FROM character_mentions WHERE book_id = $1 AND scene_id = $2',
            [TEST_BOOK_ID, TEST_SCENE_ID]
        );
        expect(parseInt(mentions.rows[0].cnt, 10)).to.equal(0);
    });

    it('returns ok: false for missing IDs', async () => {
        const result = await cleanup.cleanupSceneResolutionRows(null, null, null);
        expect(result.ok).to.be.false;
    });

    it('handles non-existent scene gracefully', async () => {
        const result = await cleanup.cleanupSceneResolutionRows(TEST_BOOK_ID, null, 'non_existent_scene');
        expect(result.ok).to.be.true;
    });
});
