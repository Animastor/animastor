// ======================================================
// GENERATION ↔ VBOOK BOUNDARY — S-1 route split guard
// ======================================================
// Guards the seam introduced by S-1 of the Generation extraction sequence
// (docs/architecture/generation-module-extraction-reconnaissance.md §19):
// the Generation route layer must not know VBook internals.
//
//   S1-A  Generation-owned route files contain NO raw SQL against the
//         VBook session tables (agent_sessions / book_generation_sessions /
//         agent_steps) and no direct storage.postgres / database handle for
//         them. VBook session cancel/counts reach the routes ONLY through
//         the AgentSessionControl port.
//   S1-B  The AgentSessionControl port stays NARROW: exactly
//         { cancelSessions, getActiveSessionCount, getSessionStatus } —
//         it is a cancel/counts port, not a VBook API dump.
//   S1-C  The port's implementation is VBook-owned: it lives in
//         services/agent-session-control.js and keeps its SQL inside
//         (the raw handle whitelist entry is pinned by sql-boundary).
//   S1-D  No NEW Generation → VBook edges: the generation route contour
//         may require the port module only — not agent-session.js,
//         agent/bootstrap, window-generator, txt-importer or
//         gen-session-repo (those are VBook-owned internals; the runtime
//         reconciliation edge is frozen separately as documented debt).
//   S1-E  Existing Player/Editor boundaries are untouched by this seam:
//         the generation route files still contain no player/editor
//         requires (mirrors P3/E-series checks; regression pin).
//
// Static source scan (Phase 1 helpers) — CI-safe, zero runtime imports.

const { expect } = require('chai');
const path = require('path');
const {
    BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers,
} = require('./helpers');

const PORT_PATH = path.join(BACKEND_SRC, 'services', 'agent-session-control.js');

// The Generation-owned route contour (files that will move with the future
// @animastor/generation package's route layer; the route split freeze).
const GENERATION_ROUTE_FILES = [
    path.join(BACKEND_SRC, 'routes', 'generation-routes.cjs'),
    path.join(BACKEND_SRC, 'routes', 'book', 'generation-routes.cjs'),
    path.join(BACKEND_SRC, 'routes', 'book', 'progress-panel.cjs'),
];

/** Strip comments so doc mentions are not treated as code edges. */
function codeOf(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\s\/\/.*$/, ''))
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
}

const VBOOK_TABLE_SQL_RE = /\b(agent_sessions|book_generation_sessions|agent_steps)\b/;

// VBook-owned modules the generation route contour must not require
// (the ONLY sanctioned seam is agent-session-control).
const VBOOK_INTERNAL_MODULES = /services\/agent-session(?!-control)|services\/agent\/|window-generator|txt-importer|gen-session-repo|services\/agent-service/;

describe('architecture: Generation route layer vs VBook internals (S-1)', () => {
    it('S1-A: generation route files contain no VBook session SQL and no direct postgres handle', () => {
        const offenders = [];
        for (const file of GENERATION_ROUTE_FILES) {
            const code = codeOf(readSource(file));
            if (VBOOK_TABLE_SQL_RE.test(code)) offenders.push(`${rel(file)}: VBook session table SQL`);
            if (/require\([^)]*storage\/postgres\/database/.test(code)) {
                offenders.push(`${rel(file)}: direct postgres/database handle`);
            }
            // The scenes dirty-unit fallback in regenerate uses
            // storage.postgres.query via the injected storage object — that
            // is generation-owned persistence, not VBook. It must keep
            // targeting generation tables only.
            const rawQueries = [...code.matchAll(/query\(`([\s\S]*?)`\)/g)].map((m) => m[1]);
            for (const sql of rawQueries) {
                if (VBOOK_TABLE_SQL_RE.test(sql)) {
                    offenders.push(`${rel(file)}: storage.postgres.query hits VBook tables`);
                }
            }
        }
        expect(offenders, 'Generation routes must reach VBook session state only via the AgentSessionControl port').to.deep.equal([]);
    });

    it('S1-B: the AgentSessionControl port surface stays narrow (cancel/counts/status only)', () => {
        const { createAgentSessionControl } = require(PORT_PATH);
        const control = createAgentSessionControl();
        expect(Object.keys(control).sort()).to.deep.equal([
            'cancelSessions', 'getActiveSessionCount', 'getSessionStatus',
        ]);
    });

    it('S1-C: the port module is VBook-owned and keeps its SQL inside itself', () => {
        const src = readSource(PORT_PATH);
        expect(src).to.match(/agent_sessions/); // the SQL lives HERE, not in routes
        expect(src).to.include('createAgentSessionControl');
        // The port module must not drag in the wider VBook pipeline — it is
        // a leaf next to agent-session.js.
        const specs = requireSpecifiers(src).filter((s) => s.startsWith('.'));
        expect(specs).to.deep.equal(['../storage/postgres/database']);
    });

    it('S1-D: generation route contour requires the port only (no VBook internals)', () => {
        const offenders = [];
        for (const file of GENERATION_ROUTE_FILES) {
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (VBOOK_INTERNAL_MODULES.test(spec)) offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'new Generation → VBook edges are forbidden; use AgentSessionControl').to.deep.equal([]);
    });

    it('S1-E: generation route files contain no player/editor requires (boundaries not weakened)', () => {
        const offenders = [];
        for (const file of GENERATION_ROUTE_FILES) {
            for (const spec of requireSpecifiers(codeOf(readSource(file)))) {
                if (/routes\/player|@animastor\/player|player-routes|routes\/editor|@animastor\/editor|editor-routes/.test(spec)) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders).to.deep.equal([]);
    });
});
