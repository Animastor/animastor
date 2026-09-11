// ======================================================
// O-2 ARCHITECTURE GUARDS — PersistencePort extraction seam
// ======================================================
// Freezes the O-2 state of docs/architecture/generation-module-extraction-
// reconnaissance.md §32.9 ("PersistencePort"): runtime/** and orchestration/**
// consume persistence ONLY through runtime/persistence-port.js (tier-owned
// contract); the host adapter (storage/runtime-persistence-adapter.js) owns
// every repository, SQL string and table. Composition root: backend.cjs.
//
// This suite TIGHTENS the reconnaissance baseline:
//   O2-G1  zero requires of any persistence implementation from the two
//          tiers (storage barrel, storage/postgres, repositories, database
//          handle, pg driver) — static AND dynamic require scan; the ONLY
//          pinned exception is gpu-dispatcher (host GPU transport adapter,
//          §32.5 — leaves runtime/** at O-3/O-4);
//   O2-G2  the port is a zero-require contract: persistence-port.js has no
//          requires, no SQL, no table names in its source;
//   O2-G3  the port op set is minimal: every tier persist('…') call is
//          declared in the port OPS list (the reverse direction — adapter
//          coverage of OPS — is enforced by setPersistencePort fail-fast);
//   O2-G4  the composition root wires the adapter BEFORE any tier module
//          is required (wiring precedes the first tier require);
//   O2-G5  no SQL may leak back into the two tiers (statement shapes and
//          tier-relevant table names in SQL position);
//   O2-G6  the O-1 event-journal shim stays deleted and the S-5 seam
//          direction is untouched (runtime never requires orchestration).
//
// Non-duplication note: requires of storage OUTSIDE the two tiers are
// guarded by the frozen sql-boundary (DIRECT_SQL_WHITELIST) and PG-4
// (BARREL_SQL_WHITELIST) baselines — this suite adds only the tier-level
// tightening O-2 introduced.
//
// Docs: generation-module-extraction-reconnaissance.md §32.9 (O-2 DONE)
// ======================================================

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const {
    BACKEND_SRC,
    listSourceFiles,
    readSource,
    requireSpecifiers,
    rel,
} = require('./helpers');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNTIME_DIR = path.join(BACKEND_SRC, 'runtime');
const ORCH_DIR = path.join(BACKEND_SRC, 'orchestration');
const PORT_FILE = path.join(RUNTIME_DIR, 'persistence-port.js');

// The ONLY tier file allowed to require persistence implementations: the
// host GPU transport adapter (§32.5). It is expected to leave runtime/**
// at O-3/O-4 — shrink this list when it moves, never grow it.
const TIER_STORAGE_ALLOWLIST = ['backend/src/runtime/gpu-dispatcher.js'];

// Persistence-implementation require shapes.
const PERSISTENCE_IMPL_SPEC_RE = /(^|[\\/])storage([\\/]|['"])/;   // ../storage, ../../storage
const PERSISTENCE_IMPL_SPEC_POSTGRES = /storage[\\/]postgres/;

function allTierFiles() {
    return [...listSourceFiles(RUNTIME_DIR), ...listSourceFiles(ORCH_DIR)];
}

// Static persistence-implementation requires in a tier file.
function staticPersistenceRequires(file) {
    const hits = [];
    for (const s of requireSpecifiers(readSource(file))) {
        if (
            PERSISTENCE_IMPL_SPEC_RE.test(s) ||
            PERSISTENCE_IMPL_SPEC_POSTGRES.test(s) ||
            s === 'pg' || s.startsWith('pg/')
        ) {
            hits.push(s);
        }
    }
    return hits;
}

// Dynamic/computed require calls in a tier file whose surrounding text
// (±300 chars) mentions persistence-implementation plumbing — the shape a
// smuggled `require(someStoragePath)` would take (S5-A proximity scan
// convention). Generic lazy plumbing (require(identifier) with literal call
// sites, e.g. runtime/index.js lazyRequire) stays clean by proximity.
function dynamicPersistenceRequires(file) {
    const src = readSource(file);
    const dyn = src.match(/require\(\s*[A-Za-z_$][\w$.]*\s*\)/g) || [];
    return dyn.filter((call) => {
        const idx = src.indexOf(call);
        const near = src.slice(Math.max(0, idx - 300), idx + 300);
        return /storage\/|postgres|repositor/.test(near);
    });
}

// ── O2-G5 helpers ─────────────────────────────────────
const SQL_STATEMENT_RE = /\bSELECT\s+[A-Za-z_*,\s]+\s+FROM\s+\w+|\bINSERT\s+INTO\s+\w+|\bUPDATE\s+\w+\s+SET\s|\bDELETE\s+FROM\s+\w+/;
const SQL_TABLE_RE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:scenes|scene_assets|generation_tasks|image_units|generation_cancellations)\b/i;

describe('§32.9 O-2 guards: persistence arrives only via the PersistencePort', () => {

    it('O2-G1: the two tiers require ZERO persistence implementations (static + dynamic)', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/persistence-port.js') continue;
            if (TIER_STORAGE_ALLOWLIST.includes(rel(file))) continue;
            for (const s of staticPersistenceRequires(file)) {
                offenders.push(`${rel(file)} -> ${s}`);
            }
            for (const d of dynamicPersistenceRequires(file)) {
                offenders.push(`${rel(file)} -> dynamic ${d}`);
            }
        }
        expect(offenders, 'runtime/** + orchestration/** must consume persistence only via runtime/persistence-port (host adapter stays in storage/**)').to.deep.equal([]);
    });

    it('O2-G2: the port is a zero-require contract with no SQL/table knowledge', () => {
        const src = readSource(PORT_FILE);
        expect(requireSpecifiers(src), 'persistence-port.js must require nothing (S-6 port convention)').to.deep.equal([]);
        expect(src, 'the port must never mention SQL statements').to.not.match(SQL_STATEMENT_RE);
        expect(src, 'the port must never name a PostgreSQL table').to.not.match(SQL_TABLE_RE);
    });

    it('O2-G3: the port op set stays minimal — every tier persistence consumer uses persist()', () => {
        // Every persist('…') literal used by the tiers must exist in the
        // port's OPS list (wiring fail-fast covers the reverse direction).
        const portSrc = readSource(PORT_FILE);
        const opBlock = portSrc.match(/const OPS = \[([\s\S]*?)\];/);
        expect(opBlock, 'OPS list must stay declarative').to.not.be.null;
        const declaredOps = new Set(
            (opBlock[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1))
        );
        const usedOps = new Set();
        for (const file of allTierFiles()) {
            if (rel(file) === 'backend/src/runtime/persistence-port.js') continue;
            for (const m of readSource(file).match(/persist\('([^']+)'\)/g) || []) {
                usedOps.add(m.slice("persist('".length, -2));
            }
        }
        const undeclared = [...usedOps].filter((op) => !declaredOps.has(op)).sort();
        expect(undeclared, 'tier persist() calls must be declared in the port OPS list').to.deep.equal([]);
        expect(declaredOps.size, 'the port contract stays minimal — every op must have a live consumer; do not add CRUD "for later"').to.be.greaterThan(0);
    });

    it('O2-G4: the composition root wires the adapter before any tier module loads', () => {
        const rootSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs')).replace(/\s+/g, ' ');
        const wireIdx = rootSrc.indexOf('setPersistencePort(');
        expect(wireIdx, 'backend.cjs must call setPersistencePort(...)').to.be.greaterThan(-1);
        // First TOP-LEVEL tier require: strip lazy `=> require(...)` arrow
        // bodies (they execute at dispatch time, long after module evaluation),
        // then exclude the persistence-port contract module itself (zero side
        // effects, loadable before wiring).
        const topLevelSrc = rootSrc.replace(/\)\s*=>\s*require\([^)]*\)/g, '=>LAZY');
        const firstTierRequire = topLevelSrc.search(/require\('\.\/(?:runtime|orchestration)(?:\/(?!persistence-port)|')/);
        expect(firstTierRequire, 'backend.cjs must require at least one tier module at top level').to.be.greaterThan(-1);
        expect(wireIdx, 'wiring must happen BEFORE the first top-level runtime/orchestration require').to.be.lessThan(firstTierRequire);
        expect(/require\(\s*'\.\/storage\/runtime-persistence-adapter'\s*\)/.test(rootSrc),
            'the wired adapter must be the host-side storage adapter').to.equal(true);
    });

    it('O2-G5: no SQL statements or PG table names leak back into the two tiers', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            for (const line of readSource(file).split('\n')) {
                const code = line.replace(/(^|\s)\/\/.*$/, '').replace(/^\s*\*.*$/, '');
                if (SQL_STATEMENT_RE.test(code) || SQL_TABLE_RE.test(code)) {
                    offenders.push(`${rel(file)}: ${line.trim().slice(0, 80)}`);
                }
            }
        }
        expect(offenders, 'SQL and table names are host-adapter knowledge — consume persistence ops through the port').to.deep.equal([]);
    });

    it('O2-G6: O-1 shim stays deleted and S-5 seam direction is untouched', () => {
        expect(fs.existsSync(path.join(ORCH_DIR, 'event-journal.js')),
            'the O-1 deleted shim must not come back').to.equal(false);
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const specs = requireSpecifiers(readSource(file));
            expect(specs.filter((s) => s.startsWith('../orchestration')),
                `${rel(file)} must not require orchestration directly (S-5 parity)`).to.deep.equal([]);
        }
    });
});
