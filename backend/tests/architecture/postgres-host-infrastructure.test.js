// ======================================================
// POSTGRES HOST-INFRASTRUCTURE BOUNDARY (PG-1 … PG-5)
// ======================================================
// Freeze of docs/architecture/postgresql-extraction-audit.md (§13):
// PostgreSQL stays HOST-SIDE infrastructure. Product packages must not
// know about PostgreSQL, SQL, the pool, concrete tables or the host
// storage implementation — they receive persistence through narrow
// domain ports implemented by the host.
//
// Guards (channels not covered by sql-boundary.test.js / per-package
// boundary suites — see audit §2.3 for the channel taxonomy):
//
//   PG-1  the pg driver is required ONLY by storage/postgres/database.js
//   PG-2  no package under packages/** requires pg / postgres /
//         storage/postgres / a host barrel (first-level require scan;
//         the per-package closure suites pin the transitive level —
//         G7-C for generation; this guard covers ALL packages static)
//   PG-3  process.env.PG_* is read ONLY by storage/postgres/database.js
//         (no DB configuration leaks into modules or frontends)
//   PG-4  the storage-barrel raw-SQL channel is FROZEN: outside
//         backend/src/storage only the current 8 barrel-query users may
//         keep raw SQL; the list may only shrink (same discipline as
//         DIRECT_SQL_WHITELIST in sql-boundary.test.js)
//   PG-5  all DDL (CREATE/ALTER/DROP TABLE|INDEX, ADD COLUMN) lives in
//         storage/postgres/schema.js — nowhere else in backend or
//         packages
//
// Docs: docs/architecture/postgresql-extraction-audit.md

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { listSourceFiles, readSource, rel, REPO_ROOT, requireSpecifiers } = require('./helpers');

const BACKEND_SRC = path.join(REPO_ROOT, 'backend', 'src');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

// ── PG-4 — frozen barrel raw-SQL baseline (audit §9 L1–L8) ───────────
// Files outside backend/src/storage that issue raw SQL through the
// storage barrel (`storage.postgres.query(...)` / destructure). Do NOT
// add entries without an ADR; REMOVE entries when the file migrates to
// a repository (mirror of DIRECT_SQL_WHITELIST discipline).
const BARREL_SQL_WHITELIST = [
    'backend/src/routes/book/agent-routes.cjs',
    'backend/src/routes/book/cache-routes.cjs',
    'backend/src/routes/book/generation-routes.cjs',
    'backend/src/routes/book/import-routes.cjs',
    'backend/src/routes/book/versions-routes.cjs',
    'backend/src/runtime/reconciliation-engine.js',
    'backend/src/services/book-deletion.cjs',
    'backend/src/services/entity-cleanup.cjs',
].sort();
// NOTE: backend.cjs wires storage.postgres (initialize/closePool/deps) but
// issues no barrel SQL — deliberately NOT whitelisted here.

const PG_DRIVER_RE = /require\(\s*['"]pg['"]\s*\)/;
const PG_ENV_RE = /process\.env\.PG_/;
// Raw SQL THROUGH THE BARREL: storage.postgres.query(...) or a captured
// `postgres` handle taken from the barrel / injected deps and used as
// `postgres.query(...)`. The injection channel (deps.postgres) is the
// same raw-handle class — covered by the whitelist entries.
const BARREL_SQL_RE = /postgres\.query\s*\(/;
// DDL statements (any form, incl. template literals)
const DDL_RE = /\b(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+INDEX|ADD\s+COLUMN|DROP\s+COLUMN)\b/i;

function isBackendStorage(filePath) {
    return rel(filePath).startsWith('backend/src/storage/');
}

function isSchemaJs(filePath) {
    return rel(filePath) === 'backend/src/storage/postgres/schema.js';
}

// All package source files (js/cjs/mjs), node_modules excluded.
// Test files are EXCLUDED from the SQL/table scans by packageSourceFiles(false):
// package seam tests legitimately quote the host SQL contract they mock
// (e.g. the editor entity-cleanup seam asserts the host's DELETE statements) —
// that is contract documentation, not package SQL. The require-level guards
// (PG-1, PG-2 first test) scan everything.
function packageSourceFiles(includeTests = false) {
    const out = [];
    if (!fs.existsSync(PACKAGES_DIR)) return out;
    for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgDir = path.join(PACKAGES_DIR, entry.name);
        const files = listSourceFiles(pkgDir, ['.js', '.cjs', '.mjs']);
        for (const file of files) {
            if (!includeTests && /[\\/](__tests__|test|tests)[\\/]/.test(file)) continue;
            out.push(file);
        }
    }
    return out;
}

describe('architecture: PostgreSQL stays host-side infrastructure', () => {

    // ── PG-1 — single pg driver import point ─────────────────────────
    it('PG-1: the pg driver is required ONLY by backend/src/storage/postgres/database.js', () => {
        const offenders = [];
        for (const file of [...listSourceFiles(BACKEND_SRC), ...packageSourceFiles()]) {
            if (rel(file) === 'backend/src/storage/postgres/database.js') continue;
            if (PG_DRIVER_RE.test(readSource(file))) offenders.push(rel(file));
        }
        expect(offenders, 'pg is a host-infrastructure detail — the pool factory is the single import point').to.deep.equal([]);
    });

    // ── PG-2 — packages never touch PostgreSQL ──────────────────────
    it('PG-2: no package requires pg / postgres / storage/postgres / a host storage barrel', () => {
        const offenders = [];
        const FORBIDDEN = [
            /^pg$/,
            /postgres/i,
            /(^|[\\/])storage([\\/]|['"])/,      // ../storage, ../../storage, ./storage …
            /storage\/postgres/,
        ];
        for (const file of packageSourceFiles()) {
            for (const spec of requireSpecifiers(readSource(file))) {
                for (const re of FORBIDDEN) {
                    if (re.test(spec)) offenders.push(`${rel(file)}: '${spec}'`);
                }
            }
        }
        expect(offenders, 'packages must not know about PostgreSQL, the pool or the host storage — persistence arrives via ports').to.deep.equal([]);
    });

    it('PG-2: no package file contains raw SQL statements (SELECT…FROM / INSERT INTO / UPDATE…SET / DELETE FROM / ON CONFLICT)', () => {
        const offenders = [];
        // Strict SQL shapes: uppercase keyword followed by a table token and
        // a SQL-continuation (WHERE/VALUES/SET/RETURNING/LIMIT/params) on the
        // same line. English prose ("delete from disk", "into scenes") and
        // block-comment prose do not match — real SQL statements do.
        const SQL_RE = /\bSELECT\s+[A-Za-z_*,\s]+\s+FROM\s+\w+|\bINSERT\s+INTO\s+\w+\s*\(|\bINSERT\s+INTO\s+\w+\s+\w|\bUPDATE\s+\w+\s+SET\s|\bDELETE\s+FROM\s+\w+|\bON\s+CONFLICT\s*\(/;
        for (const file of packageSourceFiles()) {
            const src = readSource(file);
            for (const line of src.split('\n')) {
                const code = line.replace(/(^|\s)\/\/.*$/, '').replace(/^\s*\*.*$/, ''); // strip line + block-comment prose
                if (SQL_RE.test(code)) offenders.push(`${rel(file)}: ${line.trim().slice(0, 80)}`);
            }
        }
        expect(offenders, 'SQL dialect knowledge must not live inside product packages').to.deep.equal([]);
    });

    it('PG-2: no package file names a PostgreSQL table in SQL position', () => {
        const TABLES = [
            'users', 'workspaces', 'workspace_members', 'guests', 'workspace_ai_providers',
            'system_settings', 'system_ai_providers', 'books', 'book_snapshots', 'book_source',
            'scenes', 'asset_states', 'cache_entries', 'asset_dependencies', 'generation_tasks',
            'workers', 'share_policies', 'share_policy_grants', 'ai_connectors', 'ai_endpoints',
            'ai_endpoint_share_policies', 'reconciliation_events', 'output_manifests',
            'image_units', 'storyboard_elements', 'audio_layers', 'scene_assets',
            'ai_chat_sessions', 'book_events', 'agent_sessions', 'agent_steps',
            'agent_conversations', 'agent_messages', 'character_resolution_runs',
            'character_window_candidates', 'sentence_resolutions', 'character_mentions',
            'character_aliases', 'book_generation_sessions', 'generation_cancellations',
            'sessions',
        ].join('|');
        // SQL-position table use: a SQL keyword DIRECTLY followed by a known
        // table name AND a SQL-continuation token — comment prose like
        // "alias index from character_mentions rows" does not match.
        const SQL_TABLE_RE = new RegExp(
            `\\b(?:FROM|INTO|UPDATE|JOIN)\\s+(?:${TABLES})\\s*(?:\\(|WHERE|VALUES|SET|USING|RETURNING|LIMIT|ORDER|GROUP|AS|;|$)`,
            'i'
        );
        const offenders = [];
        for (const file of packageSourceFiles()) {
            const src = readSource(file);
            for (const line of src.split('\n')) {
                const code = line.replace(/(^|\s)\/\/.*$/, '').replace(/^\s*\*.*$/, '');
                if (SQL_TABLE_RE.test(code)) offenders.push(`${rel(file)}: ${line.trim().slice(0, 80)}`);
            }
        }
        expect(offenders, 'concrete table names are host-infrastructure knowledge').to.deep.equal([]);
    });

    // ── PG-3 — DB configuration stays in the pool factory ─────────────
    it('PG-3: process.env.PG_* is read ONLY by storage/postgres/database.js', () => {
        const roots = [
            BACKEND_SRC,
            path.join(REPO_ROOT, 'frontends', 'app', 'src'),
            path.join(REPO_ROOT, 'frontends', 'website'),
            path.join(REPO_ROOT, 'frontends', 'android', 'app', 'src'),
            PACKAGES_DIR,
        ];
        const offenders = [];
        for (const root of roots) {
            if (!fs.existsSync(root)) continue;
            for (const file of listSourceFiles(root, ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.kt'])) {
                if (rel(file) === 'backend/src/storage/postgres/database.js') continue;
                if (PG_ENV_RE.test(readSource(file))) offenders.push(rel(file));
            }
        }
        expect(offenders, 'PG connection configuration is a host-infrastructure secret').to.deep.equal([]);
    });

    // ── PG-4 — barrel raw-SQL channel frozen ────────────────────────
    it('PG-4: no NEW raw SQL through the storage barrel outside the frozen baseline', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            if (isBackendStorage(file)) continue;
            if (BARREL_SQL_RE.test(readSource(file))) offenders.push(rel(file));
        }
        const sorted = offenders.sort();
        const newOffenders = sorted.filter((f) => !BARREL_SQL_WHITELIST.includes(f));
        expect(newOffenders, 'Raw SQL belongs in storage/postgres/repositories (or the frozen DIRECT_SQL_WHITELIST files). The storage barrel must not become a new SQL channel — if you must extend the baseline, update BARREL_SQL_WHITELIST in tests/architecture/postgres-host-infrastructure.test.js WITH an ADR reference.').to.deep.equal([]);
    });

    it('PG-4: barrel baseline stays exact (stale entries are removed, nothing hidden)', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            if (isBackendStorage(file)) continue;
            if (BARREL_SQL_RE.test(readSource(file))) offenders.push(rel(file));
        }
        const sorted = offenders.sort();
        expect(sorted).to.deep.equal(BARREL_SQL_WHITELIST);
    });

    it('PG-4: whitelist entries still exist (no dead baseline)', () => {
        const missing = BARREL_SQL_WHITELIST.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
        expect(missing).to.deep.equal([]);
    });

    // ── PG-5 — single DDL owner ──────────────────────────────────────
    it('PG-5: DDL lives ONLY in storage/postgres/schema.js (backend + packages)', () => {
        const offenders = [];
        for (const file of [...listSourceFiles(BACKEND_SRC), ...packageSourceFiles()]) {
            if (isSchemaJs(file)) continue;
            const src = readSource(file);
            for (const line of src.split('\n')) {
                const code = line.replace(/(^|\s)\/\/.*$/, '');
                if (DDL_RE.test(code)) offenders.push(`${rel(file)}: ${line.trim().slice(0, 80)}`);
            }
        }
        expect(offenders, 'schema.js is the ONLY DDL/migrations owner (audit §2.1)').to.deep.equal([]);
    });
});
