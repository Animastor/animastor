#!/usr/bin/env node

/**
 * One-time migration script: import existing IU metadata JSON files into PostgreSQL.
 *
 * Scans all build output directories under OUTPUT_DIR for *iu*.json files,
 * parses them, and inserts into the image_units table.
 *
 * Usage:
 *   node scripts/import-iu-json.mjs
 */

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const config = require('../src/config/runtime-config');
const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');

const OUTPUT_DIR = process.env.OUTPUT_DIR || config.OUTPUT_DIR;
const LOG_PREFIX = '[IMPORT-IU]';

function log(msg) {
    console.log(`${LOG_PREFIX} ${msg}`);
}

const INCLUDE_PATTERN = /_iu\d+\.json$/;

async function main() {
    await runMigrations();
    log('PG schema initialized');

    if (!fs.existsSync(OUTPUT_DIR)) {
        log(`OUTPUT_DIR not found: ${OUTPUT_DIR}`);
        process.exit(1);
    }

    const buildDirs = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    let totalImported = 0;
    let totalFiles = 0;

    for (const buildId of buildDirs) {
        const buildPath = path.join(OUTPUT_DIR, buildId);
        const files = fs.readdirSync(buildPath).filter(f => INCLUDE_PATTERN.test(f));

        for (const file of files) {
            totalFiles++;
            const filePath = path.join(buildPath, file);

            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const bookId = data.book_id;
                const chapterId = data.chapter_id;
                const sceneId = data.scene_id;
                const unitId = data.unit_id;

                if (!bookId || !chapterId || !sceneId || !unitId) {
                    log(`Skipping ${file}: missing identifiers`);
                    continue;
                }

                await query(`
                    INSERT INTO image_units (build_id, book_id, chapter_id, scene_id, unit_id, scene_order,
                        text, text_length, text_proportion, scene_duration_sec, estimated_duration_sec, scene_audio_file)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    ON CONFLICT(build_id, book_id, chapter_id, scene_id, unit_id) DO NOTHING
                `, [
                    buildId, bookId, chapterId, sceneId, unitId,
                    0,
                    data.text || null,
                    data.text_length || 0,
                    data.text_proportion || 0,
                    data.scene_duration_sec || 0,
                    data.estimated_duration_sec || 0,
                    data.scene_audio_file || null,
                ]);
                totalImported++;
            } catch (err) {
                log(`Error processing ${file}: ${err.message}`);
            }
        }

        if (files.length > 0) {
            log(`${buildId}: ${files.length} files, ${totalImported} imported`);
        }
    }

    log(`Done. ${totalImported} of ${totalFiles} IU metadata files imported to PG.`);
    process.exit(0);
}

main().catch(err => {
    console.error(`${LOG_PREFIX} Fatal: ${err.message}`);
    process.exit(1);
});
