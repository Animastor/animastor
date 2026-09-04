// ======================================================
// GUARDRAIL 1 — SQL boundary (Phase 1)
// ======================================================
// Rule: no module outside backend/src/storage/** may require the raw
// postgres database handle (storage/postgres/database). New modules must
// go through a repository in storage/postgres/repositories (or storage/index).
//
// The list below is the frozen Phase 1 baseline: files that already hold a
// direct handle on HEAD at the time the guardrail was introduced. They are
// documented debt (Phase 3 of the roadmap moves them to repositories) —
// the guardrail's job is only to stop the list from GROWING.
//
// Docs: docs/architecture/PHASE_1_GUARDRAILS.md §SQL boundary.

const { expect } = require('chai');
const { listSourceFiles, readSource, rel, BACKEND_SRC } = require('./helpers');

// Direct postgres handle (getPool/query) outside storage — frozen baseline.
// Sorted; do NOT add entries here without an ADR accepted by Phase 3+.
const DIRECT_SQL_WHITELIST = [
    'backend/src/auth/auth-service.js',
    'backend/src/image/iu-processor.js',
    'backend/src/middleware/ai-book-guard.js',
    'backend/src/orchestration/orchestrator.js',
    'backend/src/orchestration/scene-restoration.js',
    'backend/src/routes/ai-endpoint-routes.cjs',
    'backend/src/routes/book/generation-routes.cjs',
    'backend/src/runtime/runtime-scheduler.js',
    'backend/src/runtime/scene-window.js',
    'backend/src/services/agent-session.js',
    'backend/src/services/agent/ai-caller.js',
    'backend/src/services/agent/bootstrap.js',
    'backend/src/services/book-sync.js',
    'backend/src/services/placeholder-audio.js',
    'backend/src/services/system-ai.js',
    'backend/src/services/workspace-ai-provider.js',
    'backend/src/workflows/video/video-workflows.js',
].sort();

// Matches requires of the raw postgres handle from OUTSIDE storage.
const POSTGRES_HANDLE_RE = /require\(\s*['"][^'"]*storage\/postgres\/database['"]\s*\)/;

function isOutsideStorage(filePath) {
    return !rel(filePath).startsWith('backend/src/storage/');
}

function filesWithDirectHandle() {
    return listSourceFiles(BACKEND_SRC)
        .filter(isOutsideStorage)
        .filter((f) => POSTGRES_HANDLE_RE.test(readSource(f)))
        .map(rel)
        .sort();
}

describe('architecture: SQL boundary', () => {
    it('no NEW direct postgres/database requires outside storage (whitelist is frozen)', () => {
        const offenders = filesWithDirectHandle();
        const newOffenders = offenders.filter((f) => !DIRECT_SQL_WHITELIST.includes(f));
        expect(newOffenders, 'New modules must not require storage/postgres/database directly — add a repository in storage/postgres/repositories instead. If you genuinely must extend the baseline, update DIRECT_SQL_WHITELIST in tests/architecture/sql-boundary.test.js WITH an ADR reference and do it consciously.').to.deep.equal([]);
    });

    it('whitelist stays minimal: entries that stop offending are REMOVED', () => {
        const offenders = new Set(filesWithDirectHandle());
        const stale = DIRECT_SQL_WHITELIST.filter((f) => !offenders.has(f));
        expect(stale, 'These whitelist entries no longer hold a direct handle — delete them from DIRECT_SQL_WHITELIST so the baseline keeps shrinking (Phase 3).').to.deep.equal([]);
    });

    it('whitelist files still exist (no dead baseline entries)', () => {
        const fs = require('fs');
        const path = require('path');
        const missing = DIRECT_SQL_WHITELIST.filter((f) => !fs.existsSync(path.join(__dirname, '..', '..', '..', f)));
        expect(missing).to.deep.equal([]);
    });

    it('backend/src/storage remains the only place importing postgres/database among backend src', () => {
        // Everything else must be covered by the whitelist; combined with the
        // first test this pins the exact current surface.
        const offenders = filesWithDirectHandle();
        expect(offenders).to.deep.equal(DIRECT_SQL_WHITELIST);
    });
});
