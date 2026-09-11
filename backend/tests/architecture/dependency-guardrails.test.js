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
    // R4: the VBook runtime now lives in packages/animastor-vbook-runtime
    // (@animastor/vbook-runtime). The old BOOK_ALLOWLIST (language-detector,
    // character-identity, scene-title-utils, snake-guard) is GONE: those
    // companions moved INTO the package (relocation checklist §2.8), and the
    // package's require graph is pinned to builtins + adm-zip + tinyld by
    // vbook-package-boundary.test.js (VB-T4). What remains here:
    //   - the host shim directory backend/src/book/** must stay one-line
    //     re-exports (no logic migrates back into the host);
    //   - the workflows → book violation stays frozen at its baseline.
    // Docs: docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md,
    //       docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md

    it('host book shims stay one-line re-exports of the package (no logic migrates back)', () => {
        const bookDir = path.join(BACKEND_SRC, 'book');
        const offenders = [];
        for (const file of listSourceFiles(bookDir)) {
            const specs = requireSpecifiers(readSource(file)).filter((s) => s.startsWith('.'));
            const codeLines = readSource(file).split('\n')
                .filter((l) => l.trim() && !l.trim().startsWith('//')).length;
            if (codeLines > 1 || specs.length > 0) offenders.push(`${rel(file)}: ${specs.join(', ') || codeLines + ' code lines'}`);
        }
        expect(offenders, 'backend/src/book/** are shims; the runtime lives in packages/animastor-vbook-runtime (VB-T4 pins the package itself)').to.deep.equal([]);
    });

    it('workflows do not import the book domain (R4 violation eliminated by the S-6 BookDataPort)', () => {
        // S-6 UPDATE: the frozen 2-edge violation (workflows/video/
        // video-workflows.js → ../../book + ../../book/lazy-book/appearance)
        // is GONE — video workflow builds read scene data through the
        // Generation-owned BookDataPort (generation/ports/book-data.js),
        // with the host binding the two operations at the composition root.
        // The baseline is now ZERO: no workflows module may import book.
        const wfDir = path.join(BACKEND_SRC, 'workflows');
        const offenders = [];
        for (const file of listSourceFiles(wfDir)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('.') && /\/book(\/|$)/.test(spec)) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'workflows must read book scene data via generation/ports/book-data').to.deep.equal([]);
        // the consumer is pinned to the port (S6-B re-pins contour-wide);
        // S-7: consumed through the package public API
        const wf = readSource(path.join(BACKEND_SRC, 'workflows', 'video', 'video-workflows.js'));
        expect(requireSpecifiers(wf)).to.include('@animastor/generation');
    });
});

describe('architecture: orchestration ↔ runtime cycle freeze (S-5 reduced)', () => {
    // R5 → S-5 → O-1: the runtime→orchestration POLICY cycle is broken. All
    // seven frozen R5 edges (orchestrator/index imports from dispatch-engine,
    // reconciliation-engine, scene-window, runtime-scheduler) were replaced
    // by composition-root seams (runtime/orchestration-seams.js). The event
    // journal lives at state/event-journal.js (canonical owner — a zero-dep
    // append-only observability leaf that cannot form a cycle); the S-5
    // orchestration/event-journal.js relocation shim was deleted at O-1.
    // The multi-module SCC is dissolved (P7-T7 pins its absence). Full
    // before/after evidence: recon doc §26/§32.
    // Docs: docs/architecture/generation-module-extraction-reconnaissance.md §26, §32
    const RUNTIME_TO_ORCH_ALLOWED = [
        'backend/src/runtime/dispatch-engine.js:../state/event-journal',
        'backend/src/runtime/reconciliation-engine.js:../state/event-journal',
    ];

    it('runtime → orchestration edges stay limited to the classified event-journal sink (no policy imports)', () => {
        const edges = [];
        for (const file of listSourceFiles(path.join(BACKEND_SRC, 'runtime'))) {
            for (const spec of requireSpecifiers(readSource(file))) {
                // policy imports are any orchestration require; the journal
                // sink (canonical owner ../state/event-journal) is separately
                // classified by the zero-require check below
                if (/^\.\.\/orchestration/.test(spec) || /event-journal$/.test(spec)) {
                    edges.push(`${rel(file)}:${spec.replace(/^\.\.\//, '../')}`);
                }
            }
        }
        const set = [...new Set(edges)].sort();
        const allowed = [...new Set(RUNTIME_TO_ORCH_ALLOWED)].sort();
        expect(set, 'A runtime→orchestration POLICY edge appeared (orchestrator/index/scene-*) — runtime must reach orchestration behavior ONLY via runtime/orchestration-seams.js (S-5).').to.deep.equal(allowed);
    });

    it('event-journal is a zero-require sink, single-owned by state/event-journal.js (O-1 shim deleted)', () => {
        // The journal is the only runtime→orchestration-directory edge that
        // may exist: it is an append-only observability ledger with ZERO
        // requires of its own (a graph sink — it cannot close a cycle).
        // O-1 deleted the orchestration/event-journal.js relocation shim —
        // pin its absence so the re-export surface cannot return.
        expect(fs.existsSync(path.join(BACKEND_SRC, 'orchestration', 'event-journal.js')),
            'orchestration/event-journal.js was deleted at O-1 — canonical owner is state/event-journal.js')
            .to.equal(false);
        const journal = readSource(path.join(BACKEND_SRC, 'state', 'event-journal.js'));
        expect(requireSpecifiers(journal), 'the journal itself must stay a zero-require sink').to.deep.equal([]);
        // runtime files must consume the canonical owner, never a re-export
        for (const f of ['dispatch-engine.js', 'reconciliation-engine.js']) {
            const specs = requireSpecifiers(readSource(path.join(BACKEND_SRC, 'runtime', f)));
            expect(specs.filter((s) => /event-journal$/.test(s)), `${f} journal require`).to.deep.equal(['../state/event-journal']);
        }
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
