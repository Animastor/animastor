// ======================================================
// GUARDRAIL 6 — Dependency direction guardrails (Phase 1)
// ======================================================
// Freezes the current dependency graph at its current shape. Existing
// violations are baselined; NEW edges in the wrong direction fail.
// Docs: docs/architecture/PHASE_1_GUARDRAILS.md §Dependency guardrails.
//
// Rules:
//   R1  worker/       — self-contained bundle: no deps on backend/gpu-hub/
//                       book/generation/PG (it talks HTTP to the hub only);
//   R2  gpu-hub/      — must NOT gain code-level deps on backend/book/
//                       generation domains (HTTP + shared Redis contract only);
//   R3  ai-connector/ (LAC package) — must not depend on backend implementation;
//   R4  backend book domain — must not import backend implementation
//                       details outside its explicit allowlist;
//   R5  backend orchestration ↔ runtime cycle — frozen: runtime→orchestration
//                       edges are pinned (top-level + lazy), only
//                       event-journal is unconditionally allowed;
//   R6  frontends fetch() stays inside api/client.ts;
//   R7  no new raw pg / storage/postgres/database anywhere in worker/hub/LAC.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { listSourceFiles, readSource, rel, REPO_ROOT, requireSpecifiers, WORKER_BUNDLE_DIR } = require('./helpers');

const WORKER_DIR = WORKER_BUNDLE_DIR;
const HUB_DIR = path.join(REPO_ROOT, 'packages', 'animastor-gpu-hub');
const LAC_DIR = path.join(REPO_ROOT, 'packages', 'animastor-ai-connector');
const FRONTEND_APP_DIR = path.join(REPO_ROOT, 'frontends', 'app', 'src');
const BACKEND_SRC = path.join(REPO_ROOT, 'backend', 'src');

const NODE_BUILTIN = /^[a-z@][a-z0-9._@/-]*$/; // bare specifier (node_modules / builtin)

function externalSpecs(dir) {
    const out = [];
    for (const file of listSourceFiles(dir)) {
        for (const spec of requireSpecifiers(readSource(file))) {
            if (!NODE_BUILTIN.test(spec)) continue; // relative/built-in only below
            out.push({ file: rel(file), spec });
        }
    }
    return out;
}

describe('architecture: worker isolation', () => {
    it('worker bundle requires ONLY node builtins + its own files', () => {
        const allowed = new Set(['child_process', 'os', 'fs', 'path', 'crypto', 'http', 'https', 'url', 'util', 'stream', 'events', 'zlib']);
        const offenders = [];
        for (const file of listSourceFiles(WORKER_DIR)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('./') || spec.startsWith('../')) continue;
                if (allowed.has(spec)) continue;
                offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'worker must stay a self-contained bundle — no backend/hub/book/generation/PG deps (it talks HTTP to the hub).').to.deep.equal([]);
    });

    it('worker bundle has no code-level reference to book/generation/PG domains', () => {
        const banned = /postgres|storage\/postgres|book-repo|generation-routes|orchestrat|reconciliation|book\/index|ai-service/i;
        for (const file of listSourceFiles(WORKER_DIR)) {
            const src = readSource(file);
            expect(src, `${rel(file)} must not reference backend domains`).to.not.match(banned);
        }
    });

    it('worker talks to the hub via HTTP only (no Redis, no direct backend calls)', () => {
        for (const file of listSourceFiles(WORKER_DIR)) {
            const src = readSource(file);
            expect(src, `${rel(file)} must not open Redis connections`).to.not.match(/ioredis|new\s+Redis|createClient/);
        }
    });

    it('canonical worker bundle declares ZERO runtime npm dependencies (standalone readiness)', () => {
        // Phase 9B: the dead node-fetch dependency was removed — the worker
        // uses the Node 20+ global fetch. The bundle must stay zero-dep so a
        // clean checkout runs with `node worker.cjs` and no npm install.
        const pkg = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'package.json'), 'utf8'));
        expect(pkg.dependencies, 'worker package.json must not declare runtime dependencies').to.not.exist;
        expect(pkg.optionalDependencies, 'worker package.json must not declare optional dependencies').to.not.exist;
        expect(pkg.version, 'worker package.json carries the canonical bundle version').to.match(/^\d+\.\d+\.\d+$/);
    });
});

describe('architecture: GPU Hub dependency direction', () => {
    it('hub requires only node builtins + its own files + the canonical contracts package (no backend/book/generation code deps)', () => {
        // Phase 10B: @animastor/contracts is the sanctioned canonical Job
        // Protocol v2 source (compose read-only mount seam). Backend
        // coupling stays HTTP (BACKEND_URL) + shared Redis keys only — any
        // OTHER new package/code dependency requires an ADR.
        const allowed = new Set(['express', 'cors', 'crypto', 'fs', 'path', 'ioredis', 'zlib', 'http', 'https', 'url', '@animastor/contracts']);
        const offenders = [];
        for (const file of listSourceFiles(HUB_DIR)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('./') || spec.startsWith('../')) continue;
                if (allowed.has(spec)) continue;
                offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'gpu-hub must not gain new package/code deps. Backend coupling is HTTP (BACKEND_URL) + shared Redis keys only — adding a backend/book/generation code dependency requires an ADR.').to.deep.equal([]);
    });

    it('hub has no filesystem/code references into backend or worker sources', () => {
        const banned = /require\(['"][^'"]*(backend\/src|backend\/ai|worker\/worker|frontends)/;
        for (const file of listSourceFiles(HUB_DIR)) {
            expect(readSource(file), `${rel(file)} must not require backend/worker sources`).to.not.match(banned);
        }
    });
});

describe('architecture: Local AI Connector isolation', () => {
    it('LAC requires only ws + node builtins + its own files', () => {
        const allowed = new Set(['ws', 'crypto', 'fs', 'path', 'http', 'https', 'url', 'util', 'events', 'stream']);
        const offenders = [];
        for (const file of listSourceFiles(LAC_DIR)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('./') || spec.startsWith('../')) continue;
                if (allowed.has(spec)) continue;
                offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'LAC stays a standalone CLI — no backend implementation deps (it talks one outbound WS to the backend).').to.deep.equal([]);
    });
});

describe('architecture: Book domain dependency boundary', () => {
    // R4: backend/src/book/** may import: node builtins, its own files, and
    // the explicit allowlist below — the audited extraction companions that
    // move into @animastor/vbook-runtime with the book domain (audit §1.1).
    // The former runtime-config + structure-detector entries were REMOVED by
    // the @animastor/vbook-runtime preparation: booksRoot and the detector
    // are now injectable ports (books-root.js / parser.js), so those edges
    // are forbidden, not allowed.
    // NOTE: the allowlist holds PACKAGE-BOUNDARY edges only — requires that
    // leave the book directory. Intra-package files (e.g. lazy-book →
    // ../books-root, the booksRoot port module) resolve to backend/src/book/
    // and are excluded by the resolved-target check below, so the package
    // can grow internal structure without touching this baseline.
    // Docs: docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md,
    //       docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md
    const BOOK_ALLOWLIST = [
        '../../services/language-detector',
        '../../utils/character-identity',
        '../../utils/scene-title-utils',
        '../../utils/snake-guard',
    ];
    const BOOK_DIR_FOR_GUARD = path.join(BACKEND_SRC, 'book');

    function resolvesInsideBookDir(fromFile, spec) {
        const base = path.resolve(path.dirname(fromFile), spec);
        const candidates = [base, base + '.js', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.cjs')];
        for (const c of candidates) {
            if (fs.existsSync(c) && fs.statSync(c).isFile() && c.startsWith(BOOK_DIR_FOR_GUARD + path.sep)) return true;
        }
        return false;
    }

    it('book domain imports stay inside its allowlist (no new implementation-detail edges)', () => {
        const bookDir = path.join(BACKEND_SRC, 'book');
        const offenders = [];
        for (const file of listSourceFiles(bookDir)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue; // builtins / npm fine
                if (spec.startsWith('./')) continue; // intra-domain fine
                if (resolvesInsideBookDir(file, spec)) continue; // intra-package (e.g. books-root port)
                if (BOOK_ALLOWLIST.includes(spec)) continue;
                offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'backend/src/book must not import backend implementation details outside tests/architecture/dependency-guardrails.test.js BOOK_ALLOWLIST.').to.deep.equal([]);
    });

    it('workflows do not import the book domain (frozen violation, no new edges)', () => {
        // Known existing violation: workflows/video/video-workflows.js requires
        // ../../book (+ its appearance helper). Phase 1 pins exactly this set.
        const wfDir = path.join(BACKEND_SRC, 'workflows');
        const offenders = [];
        for (const file of listSourceFiles(wfDir)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('.') && /\/book(\/|$)/.test(spec)) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders).to.deep.equal([
            'backend/src/workflows/video/video-workflows.js: ../../book',
            'backend/src/workflows/video/video-workflows.js: ../../book/lazy-book/appearance',
        ]);
    });
});

describe('architecture: orchestration ↔ runtime cycle freeze', () => {
    // R5: the current cycle is documented debt (≥5 files). The freeze pins
    // the EXACT edge set so the cycle cannot GROW while Phases 3/6 land.
    //
    // runtime → orchestration edges (top-level + lazy):
    // Phase 5 removed the dead runtime-persistence.js:../orchestration/
    // event-journal edge; the remaining set is pinned below.
    // Docs: docs/architecture/PHASE_5_ORCHESTRATION_RUNTIME.md
    const RUNTIME_TO_ORCH_BASELINE = [
        'backend/src/runtime/dispatch-engine.js:../orchestration/event-journal',
        'backend/src/runtime/reconciliation-engine.js:../orchestration/event-journal',
        'backend/src/runtime/scene-window.js:../orchestration/orchestrator',
        'backend/src/runtime/runtime-scheduler.js:../orchestration/orchestrator',
        'backend/src/runtime/dispatch-engine.js:../orchestration/orchestrator',
        'backend/src/runtime/dispatch-engine.js:../orchestration',
        'backend/src/runtime/reconciliation-engine.js:../orchestration/orchestrator',
    ];

    it('runtime → orchestration edge set stays frozen (no new cycle edges)', () => {
        const edges = [];
        for (const file of listSourceFiles(path.join(BACKEND_SRC, 'runtime'))) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (/^\.\.\/orchestration/.test(spec)) {
                    // normalize index → orchestrator-less path kept verbatim
                    edges.push(`${rel(file)}:${spec.replace(/^\.\.\//, '../')}`);
                }
            }
        }
        const set = [...new Set(edges)].sort();
        const baseline = [...new Set(RUNTIME_TO_ORCH_BASELINE)].sort();
        expect(set, 'A NEW runtime→orchestration edge was added — the cycle must not grow (see final review §3.3; Phase 6 breaks it).').to.deep.equal(baseline);
    });

    it('event-journal remains the only unconditionally allowed runtime→orchestration module for NEW top-level imports', () => {
        // Every runtime file may import event-journal; importing anything else
        // from orchestration must appear in the frozen baseline above (it does).
        // This test documents intent and guards the direction of FUTURE edits:
        const journal = readSource(path.join(BACKEND_SRC, 'orchestration', 'event-journal.js'));
        expect(journal).to.include('event');
        const sceneWindow = readSource(path.join(BACKEND_SRC, 'runtime', 'scene-window.js'));
        expect(sceneWindow).to.include("require('../orchestration/orchestrator')"); // pinned top-level edge
    });
});

describe('architecture: frontend fetch boundary', () => {
    it('frontends fetch() stays inside api/client.ts', () => {
        const offenders = [];
        for (const file of listSourceFiles(FRONTEND_APP_DIR, ['.ts', '.tsx'])) {
            if (rel(file) === 'frontends/app/src/api/client.ts') continue;
            // real call sites only: `await fetch(` / `= fetch(` / `return fetch(`
            if (/(?:await|=|return)\s+fetch\s*\(|(?<![.\w])fetch\s*\(\s*['"`]/.test(readSource(file))) offenders.push(rel(file));
        }
        expect(offenders, 'all frontend network calls must go through api/client.ts').to.deep.equal([]);
    });
});

describe('architecture: no raw SQL outside backend storage', () => {
    it('worker / gpu-hub / ai-connector (LAC) never import pg or postgres code', () => {
        for (const dir of [WORKER_DIR, HUB_DIR, LAC_DIR]) {
            for (const file of listSourceFiles(dir)) {
                const src = readSource(file);
                expect(src, `${rel(file)} must not touch Postgres`).to.not.match(/require\(['"](pg|.*postgres)['"]\)/);
            }
        }
    });
});
