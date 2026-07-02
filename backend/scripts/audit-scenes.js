#!/usr/bin/env node
// Scene audit script — run after scene-splitting changes to verify existing books.
// Usage: node scripts/audit-scenes.js [bookId]
//
// Checks:
//   1. Each scene's estimated duration fits within SCENE_MAX_SEC (soft)
//   2. Scene source offsets are contiguous (no gaps/overlaps)
//   3. Each scene text is a verbatim substring of the source (coverage)

const path = require('path');
const fs = require('fs');

const BOOKS_DIR = process.env.BOOKS_DIR || '/data/books';
const { estimateSpeechDurationSec } = require('../src/services/placeholder-audio');
const sourceCoverage = require('../src/services/source-coverage');
const { SCENE_TARGET_SEC, SCENE_MAX_SEC } = require('../src/services/agent-prompts');

const PASS = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

function logOk(msg) { console.log(`${PASS} ${msg}`); }
function logWarn(msg) { console.log(`${WARN} ${msg}`); }
function logFail(msg) { console.log(`${FAIL} ${msg}`); }

function loadBookFromDir(bookDir) {
    const manifestPath = path.join(bookDir, 'manifest.json');
    const metaPath = path.join(bookDir, 'book.json');
    const sourcePath = path.join(bookDir, 'source.txt');
    const chaptersDir = path.join(bookDir, 'chapters');

    if (!fs.existsSync(manifestPath)) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
    const sourceText = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';

    const chapters = [];
    if (fs.existsSync(chaptersDir)) {
        const files = fs.readdirSync(chaptersDir)
            .filter(f => f.endsWith('.json'))
            .sort();
        for (const file of files) {
            const ch = JSON.parse(fs.readFileSync(path.join(chaptersDir, file), 'utf8'));
            chapters.push(ch);
        }
    }

    return { manifest, meta, sourceText, chapters, bookId: manifest.book_id, dir: bookDir };
}

function auditBook(book) {
    const { manifest, chapters, sourceText, bookId } = book;
    const state = manifest.state;
    console.log(`\n## ${bookId} [${state}]`);

    if (state === 'RAW_IMPORTED') {
        logOk('RAW_IMPORTED — no scenes to audit');
        return { ok: true, scenes: 0, issues: [] };
    }

    const allScenes = [];
    for (const ch of chapters) {
        for (const sc of (ch.scenes || [])) {
            allScenes.push({ ...sc, chapterId: ch.chapter, chapterTitle: ch.chapter_title });
        }
    }

    if (allScenes.length === 0) {
        logWarn('No scenes found');
        return { ok: true, scenes: 0, issues: [] };
    }

    console.log(`  ${allScenes.length} scenes in ${chapters.length} chapters`);
    const issues = [];

    // ── 1. Duration audit ──
    const targetCount = { ok: 0, near: 0, over: 0 };
    for (const sc of allScenes) {
        const dur = estimateSpeechDurationSec(sc.audio?.full_text || sc.text || '');
        if (dur <= SCENE_TARGET_SEC * 1.2) {
            targetCount.ok++;
        } else if (dur <= SCENE_MAX_SEC) {
            targetCount.near++;
        } else {
            targetCount.over++;
            issues.push({ type: 'duration', sceneId: sc.scene_id, dur, max: SCENE_MAX_SEC });
        }
    }
    console.log(`  Duration: ${targetCount.ok} within target, ${targetCount.near} near-limit, ${targetCount.over} over max`);
    for (const issue of issues.filter(i => i.type === 'duration').slice(0, 5)) {
        logWarn(`scene ${issue.sceneId}: ${issue.dur.toFixed(1)}s (max ${issue.max}s)`);
    }

    // ── 2. Source coverage by chapter ──
    let covOk = 0;
    let covFail = 0;
    for (const ch of chapters) {
        const sceneTexts = (ch.scenes || [])
            .map(sc => sc.audio?.full_text || sc.text || '')
            .filter(Boolean);
        if (sceneTexts.length === 0) continue;

        // Use source coverage on the concatenated chapter narrative text.
        // Since we may not have per-chapter source slices, use the full source
        // and rely on source_start offsets if available.
        if (ch.scenes[0]?.source_start != null) {
            const chStart = ch.scenes[0].source_start;
            const chEnd = ch.scenes[ch.scenes.length - 1]?.source_end || sourceText.length;
            const chSlice = sourceText.slice(chStart, chEnd);
            const cov = sourceCoverage.computeSceneCoverage(chSlice, sceneTexts, { sourceOffsetBase: chStart });
            if (cov.ok) covOk++;
            else {
                covFail++;
                issues.push({ type: 'coverage', chapterId: ch.chapter, reason: cov.reason, gap: cov.gap_chars });
            }
        }
    }
    if (covOk + covFail > 0) {
        console.log(`  Coverage: ${covOk} chapters OK, ${covFail} failed`);
        for (const issue of issues.filter(i => i.type === 'coverage').slice(0, 3)) {
            logFail(`chapter ${issue.chapterId}: ${issue.reason} (gap ${issue.gap} chars)`);
        }
    }

    const ok = targetCount.over === 0 && covFail === 0;
    if (ok) logOk('All checks passed');
    return { ok, scenes: allScenes.length, issues };
}

async function main() {
    const targetBookId = process.argv[2];
    let books = [];

    if (targetBookId) {
        const dir = path.join(BOOKS_DIR, targetBookId);
        if (!fs.existsSync(dir)) {
            console.error(`Book ${targetBookId} not found at ${dir}`);
            process.exit(1);
        }
        const book = loadBookFromDir(dir);
        if (book) books.push(book);
    } else {
        if (!fs.existsSync(BOOKS_DIR)) {
            console.log(`No books directory found at ${BOOKS_DIR}.`);
            console.log(`Skipping disk audit. Run tests instead: npm test`);
            return;
        }
        const entries = fs.readdirSync(BOOKS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const book = loadBookFromDir(path.join(BOOKS_DIR, entry.name));
                if (book) books.push(book);
            }
        }
    }

    if (books.length === 0) {
        console.log('No books found to audit.');
        return;
    }

    let totalOk = 0;
    let totalIssues = 0;
    for (const book of books) {
        const result = auditBook(book);
        if (result.ok) totalOk++;
        totalIssues += result.issues.length;
    }

    console.log(`\n== Summary ==`);
    console.log(`Books: ${books.length}, passing: ${totalOk}, with issues: ${books.length - totalOk}, total issues: ${totalIssues}`);
    if (totalIssues > 0) process.exit(1);
}

main().catch(err => {
    console.error('Audit failed:', err.message);
    process.exit(1);
});
