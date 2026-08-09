#!/usr/bin/env node
// Audit video.action / image.prompt for continuity violations in a generated book.
// Usage: node scripts/audit-video-actions.js <bookId>
//
// Word-boundary matching: pronouns and group nouns are matched as WHOLE WORDS
// ("\bhe\b"), so "the alley" never triggers "he" and "heat" never triggers "she".
//
// Checks:
//   1. FAIL — invented snake_case ids that are NOT in the book's character list
//      (context poisoning: agent copied an id from rules/examples, e.g.
//      "zhenshchina_v_budochke").
//   2. WARN — generic group nouns ("the two men", "both characters", "the men")
//      in video.action when the scene has participants but no character_id is used.
//   3. WARN — display-name possessive forms ("Mikhail's glasses") instead of the id.
//   4. INFO — standalone pronouns (he/she/his/her/they/them) with participants in
//      the scene but no character_id in the action (may be legit for extras).
//
// Exit code 0 when no FAIL/WARN; 1 otherwise.

const path = require('path');
const fs = require('fs');
const { findCanonicalId, snakeTokensInText, KNOWN_NON_CHARACTER_SNAKE, hasMixedScript, isSnakeLike } = require('../src/utils/snake-guard');

const BOOKS_DIR = process.env.BOOKS_DIR || '/data/books';
const PASS = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

function wordRegex(word) {
    return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
}

// ── Word-boundary matching only ──────────────────────────────────────
// Group-noun list mirrors anchorGroupRefs in src/workflows/video/video-workflows.js
// (source of truth for the deterministic repair) — keep both in sync.
const GROUP_NOUNS = [
    'the two of them', 'the two men', 'both characters', 'the characters',
    'the men', 'the two', 'both of them', 'the women', 'these two',
];
const PRONOUNS = ['he', 'him', 'his', 'she', 'her', 'they', 'them'];

function hasWord(text, word) {
    return wordRegex(word).test(text);
}

function hasAnyWord(text, words) {
    return words.some(w => hasWord(text, w));
}

// Snake_case token detection lives in src/utils/snake-guard.js — the SAME source
// of truth used by the pipeline repair step (stepRepairFantasyIds) and the
// lazy-book write barrier. Keeps audit and pipeline in lockstep.

function loadBook(bookId) {
    const dir = path.join(BOOKS_DIR, bookId);
    if (!fs.existsSync(dir)) {
        console.error(`Book ${bookId} not found at ${dir}`);
        process.exit(1);
    }
    const characters = fs.existsSync(path.join(dir, 'characters.json'))
        ? JSON.parse(fs.readFileSync(path.join(dir, 'characters.json'), 'utf8'))
        : [];
    const locations = fs.existsSync(path.join(dir, 'locations.json'))
        ? JSON.parse(fs.readFileSync(path.join(dir, 'locations.json'), 'utf8'))
        : {};
    const charIds = new Set(characters.map(c => c.id).filter(Boolean));
    const locIds = new Set(Object.keys(locations || {}));
    // Display-name words ("Mikhail", "Berlioz") for possessive detection
    const nameWords = new Set();
    for (const c of characters) {
        const name = (c.name || c.id || '').replace(/\(.*?\)/g, ' ').split(/[\s,.;!?]+/);
        for (const w of name) {
            const norm = w.toLowerCase();
            if (norm.length >= 3 && !charIds.has(norm)) nameWords.add(norm);
        }
    }

    const chapters = [];
    const chDir = path.join(dir, 'chapters');
    if (fs.existsSync(chDir)) {
        for (const f of fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort()) {
            chapters.push(JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8')));
        }
    }
    return { bookId, charIds, locIds, nameWords, chapters };
}

function auditUnit(unit, scene, ctx) {
    const findings = [];
    const action = (unit.video && unit.video.action) || '';
    const prompt = (unit.image && unit.image.prompt) || '';
    const participants = scene.participants || [];
    const where = `${scene.scene_id} ${unit.id}`;
    const hasCharId = ctx.charIds.size > 0 && [...ctx.charIds].some(id =>
        wordRegex(id).test(action) || wordRegex(id).test(prompt));

    // 1. Invented / chimera snake_case ids — shared snake-guard (one source of
    // truth with the pipeline repair step and the write barrier).
    //    INVENTED — no confident relation to the registry (context poisoning).
    //    CHIMERA  — confidently matches a known id but differs by script/typo/
    //               transliteration ("mikhail_berлиоз" → "mikhail_berlioz").
    const knownIds = [...ctx.charIds, ...ctx.locIds];
    for (const field of [['video.action', action], ['image.prompt', prompt]]) {
        const [label, text] = field;
        if (!text) continue;
        for (const token of snakeTokensInText(text)) {
            const low = token.toLowerCase();
            if (ctx.charIds.has(low) || ctx.locIds.has(low)) continue;        // exact valid id
            if (KNOWN_NON_CHARACTER_SNAKE.has(low)) continue;                 // technical/object word
            const canonical = findCanonicalId(token, knownIds);
            if (canonical && canonical.toLowerCase() !== low) {
                findings.push({ level: 'FAIL', where, msg: `CHIMERA id "${token}" in ${label} -> should be "${canonical}" (script/transliteration variant)` });
            } else if (!canonical) {
                findings.push({ level: 'FAIL', where, msg: `INVENTED id "${token}" in ${label} (not in character list)` });
            }
        }
    }

    // 2. Generic group nouns when participants exist but no id used
    if (participants.length > 0 && !hasCharId) {
        const hit = GROUP_NOUNS.find(w => hasWord(action, w));
        if (hit) {
            findings.push({ level: 'WARN', where, msg: `generic group noun "${hit}" in video.action, participants=${participants.join(',')}, no character_id` });
        }
    }

    // 3. Display-name possessive forms without an id
    if (ctx.nameWords.size > 0 && !hasCharId) {
        for (const w of ctx.nameWords) {
            if (hasWord(action, `${w}'s`)) {
                findings.push({ level: 'WARN', where, msg: `display-name possessive "${w}'s" in video.action (should be character_id's)` });
                break;
            }
        }
    }

    // 4. Standalone pronouns (info — may be legit for extras)
    if (participants.length > 0 && !hasCharId) {
        const hit = PRONOUNS.find(w => hasWord(action, w));
        if (hit) {
            findings.push({ level: 'INFO', where, msg: `pronoun "${hit}" in video.action, participants=${participants.join(',')}, no character_id` });
        }
    }

    return findings;
}

function main() {
    const targetBookId = process.argv[2];
    if (!targetBookId) {
        console.error('Usage: node scripts/audit-video-actions.js <bookId>');
        process.exit(1);
    }

    const ctx = loadBook(targetBookId);
    console.log(`\n## ${ctx.bookId}`);
    console.log(`Characters: ${[...ctx.charIds].join(', ') || '(none)'}`);

    const all = [];
    let unitsSeen = 0;
    for (const ch of ctx.chapters) {
        for (const sc of ch.scenes || []) {
            for (const u of sc.units || []) {
                unitsSeen++;
                all.push(...auditUnit(u, sc, ctx));
            }
        }
    }

    // Mixed-script registry ids ("patriarshie_pруды") — the chimera class in the
    // registries themselves. The write barrier normalizes them on creation, so
    // a surviving one means the fix did not run.
    const dir = path.join(BOOKS_DIR, targetBookId);
    for (const id of ctx.charIds) {
        if (hasMixedScript(id)) all.push({ level: 'FAIL', where: 'characters.json', msg: `mixed-script (latin+cyrillic) id "${id}" — should be normalized` });
    }
    for (const id of ctx.locIds) {
        if (hasMixedScript(id)) all.push({ level: 'FAIL', where: 'locations.json', msg: `mixed-script (latin+cyrillic) id "${id}" — should be normalized` });
    }

    // mentions.json — alias targets must resolve to a real character id
    const mentionsPath = path.join(dir, 'mentions.json');
    if (fs.existsSync(mentionsPath)) {
        const mentions = JSON.parse(fs.readFileSync(mentionsPath, 'utf8')) || {};
        for (const [alias, target] of Object.entries(mentions)) {
            const low = String(target).toLowerCase();
            if (ctx.charIds.has(low)) continue;
            // Natural-designation targets ("женщина в будочке") are not ids —
            // only snake-shaped targets are checked for chimeras/inventions.
            if (!isSnakeLike(target)) continue;
            const canonical = findCanonicalId(target, ctx.charIds);
            if (canonical) {
                all.push({ level: 'FAIL', where: 'mentions.json', msg: `CHIMERA mention "${alias}" -> ${target} should be "${canonical}"` });
            } else {
                all.push({ level: 'FAIL', where: 'mentions.json', msg: `INVENTED mention target "${target}" for "${alias}" (not in characters.json)` });
            }
        }
    }

    const byLevel = { FAIL: [], WARN: [], INFO: [] };
    for (const f of all) byLevel[f.level].push(f);

    for (const f of byLevel.FAIL) console.log(`${FAIL} ${f.where}: ${f.msg}`);
    for (const f of byLevel.WARN) console.log(`${WARN} ${f.where}: ${f.msg}`);
    for (const f of byLevel.INFO) console.log(`  i ${f.where}: ${f.msg}`);

    console.log(`\n  ${unitsSeen} units checked — FAIL: ${byLevel.FAIL.length}, WARN: ${byLevel.WARN.length}, INFO: ${byLevel.INFO.length}`);
    if (byLevel.FAIL.length === 0 && byLevel.WARN.length === 0) {
        console.log(`${PASS} No violations`);
    }
    process.exit(byLevel.FAIL.length + byLevel.WARN.length > 0 ? 1 : 0);
}

main();
