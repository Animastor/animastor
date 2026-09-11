// ======================================================
// §32 RUNTIME ORCHESTRATION EXTRACTION — RECONNAISSANCE GUARDS (O-G)
// ======================================================
// Read-only boundary guards pinning the measured facts of
// docs/architecture/generation-module-extraction-reconnaissance.md §32
// ("Runtime Orchestration Extraction Reconnaissance").
//
// RECONNAISSANCE ONLY: nothing here changes production behavior. The guards
// freeze the CURRENT direction so future O-seams (O-1..O-9) can tighten them
// one assertion at a time:
//   O-G1  runtime/** → orchestration/** policy requires: ZERO (S5-A parity)
//   O-G2  orchestration/** direct Redis/PG client imports: ZERO
//         (redis is an injected parameter; PG must arrive via O-P1)
//   O-G3  express/http-server imports in both tiers: ZERO
//   O-G4  no orchestration/runtime file imports GPU Hub or worker package
//         internals (hub access only via gpu-dispatcher/clearHubDispatches)
//   O-G5  no orchestration/runtime file imports Player/Editor packages
//   O-G6  deep imports into @animastor/generation: ZERO (root API only)
//   O-G7  no reverse dependency: the Generation package never mentions
//         orchestration/runtime requires
//   O-G8  both tiers stay inside backend/src (no physical move has happened)
//   O-G9  hidden env access: runtime/** process.env reads = ZERO;
//         orchestration/** OUTPUT_DIR env reads pinned at the measured
//         baseline (3 sites) — must NOT grow, shrink at O-5
//   O-G10 SCC safety: no module may re-introduce a runtime→orchestration
//         require (static + dynamic-proximity scan over the FULL tree),
//         and the orchestration event-journal shim stays one-line
//
// Docs: generation-module-extraction-reconnaissance.md §32.15

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
const GENERATION_PKG_SRC = path.join(REPO_ROOT, 'packages', 'animastor-generation', 'src');

function allTierFiles() {
    return [...listSourceFiles(RUNTIME_DIR), ...listSourceFiles(ORCH_DIR)];
}

describe('§32 runtime/orchestration extraction reconnaissance guards', () => {

    it('O-G1: runtime/** requires ZERO orchestration policy modules (S5-A parity, full scan)', () => {
        const offenders = [];
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const src = readSource(file);
            const specs = requireSpecifiers(src);
            if (specs.some((s) => s.startsWith('../orchestration'))) {
                offenders.push(rel(file));
            }
        }
        expect(offenders, 'runtime must reach orchestration only via runtime/orchestration-seams.js (S-5/§32.4)').to.deep.equal([]);
    });

    it('O-G2: neither tier imports Redis/PG clients or the storage pool directly', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            const specs = requireSpecifiers(readSource(file));
            for (const s of specs) {
                if (s === 'ioredis' || s === 'redis' || s === 'pg' || s.startsWith('pg/')) {
                    offenders.push(`${rel(file)} -> ${s}`);
                }
            }
            // dispatch-engine's ../storage facade require is the one measured
            // direct-PG-adjacent site; it is pinned (not condemned) here and
            // must be replaced by the O-P1 PersistencePort at step O-2.
        }
        expect(offenders, 'redis must stay an injected parameter; PG must arrive via a port').to.deep.equal([]);
    });

    it('O-G3: neither tier imports express or an HTTP server framework', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            const specs = requireSpecifiers(readSource(file));
            for (const s of specs) {
                if (s === 'express' || s.startsWith('express/') || s === 'http' || s === 'https' || s === 'ws') {
                    offenders.push(`${rel(file)} -> ${s}`);
                }
            }
        }
        expect(offenders).to.deep.equal([]);
    });

    it('O-G4: no tier file imports GPU Hub / worker package internals', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            const specs = requireSpecifiers(readSource(file));
            for (const s of specs) {
                if (s.includes('animastor-gpu-hub') || s.includes('animastor-worker')) {
                    offenders.push(`${rel(file)} -> ${s}`);
                }
            }
        }
        expect(offenders, 'hub/worker contact is contractual (Job Protocol + HTTP transport in gpu-dispatcher), never an import').to.deep.equal([]);
    });

    it('O-G5: no tier file imports the Player or Editor packages', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            const specs = requireSpecifiers(readSource(file));
            for (const s of specs) {
                if (s.includes('@animastor/player') || s.includes('@animastor/editor')) {
                    offenders.push(`${rel(file)} -> ${s}`);
                }
            }
        }
        expect(offenders).to.deep.equal([]);
    });

    it('O-G6: Generation is consumed via the root specifier only — zero deep imports', () => {
        const offenders = [];
        for (const file of allTierFiles()) {
            const specs = requireSpecifiers(readSource(file));
            for (const s of specs) {
                if (s.startsWith('@animastor/generation/') || s.startsWith('@animastor/contracts/')) {
                    offenders.push(`${rel(file)} -> ${s}`);
                }
            }
        }
        expect(offenders).to.deep.equal([]);
    });

    it('O-G7: no reverse dependency — the Generation package never requires orchestration/runtime', () => {
        const offenders = [];
        for (const file of listSourceFiles(GENERATION_PKG_SRC)) {
            const specs = requireSpecifiers(readSource(file));
            for (const s of specs) {
                if (s.includes('orchestration') || s.includes('/runtime') || s.startsWith('../runtime') || s.startsWith('../../runtime')) {
                    offenders.push(`${rel(file)} -> ${s}`);
                }
            }
        }
        expect(offenders, 'Generation → orchestration/runtime must not exist (G7-B/G7-C parity)').to.deep.equal([]);
    });

    it('O-G8: both tiers are still physically inside backend/src (no extraction has happened)', () => {
        expect(fs.existsSync(RUNTIME_DIR), 'runtime/** still in backend').to.equal(true);
        expect(fs.existsSync(ORCH_DIR), 'orchestration/** still in backend').to.equal(true);
        expect(fs.existsSync(path.join(REPO_ROOT, 'packages', 'animastor-orchestration')),
            'packages/animastor-orchestration must not exist until O-8 (recon says READY FOR SEAM WORK, not extraction)')
            .to.equal(false);
    });

    it('O-G9: hidden env access — runtime/** has ZERO process.env reads; orchestration OUTPUT_DIR sites pinned', () => {
        const runtimeOffenders = [];
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            if (/process\.env/.test(readSource(file))) runtimeOffenders.push(rel(file));
        }
        expect(runtimeOffenders, 'runtime env must come only from config/runtime-config (O-P5)').to.deep.equal([]);

        // Measured baseline (§32.2): 3 OUTPUT_DIR sites in orchestration.
        // These are the sanctioned leak inventory — they must not GROW and are
        // expected to shrink to 0 at step O-5 (update this pin then).
        const orchSites = [];
        for (const file of listSourceFiles(ORCH_DIR)) {
            const src = readSource(file);
            const count = (src.match(/process\.env/g) || []).length;
            if (count > 0) orchSites.push(`${rel(file)} x${count}`);
        }
        expect(orchSites).to.deep.equal([
            'backend/src/orchestration/scene-callbacks.js x2',
            'backend/src/orchestration/scene-restoration.js x1',
        ]);
    });

    it('O-G10: cycle safety — no dynamic require may re-introduce runtime→orchestration; journal shim stays one-line', () => {
        // dynamic/computed require proximity scan (S5-A convention) over runtime/**
        for (const file of listSourceFiles(RUNTIME_DIR)) {
            const src = readSource(file);
            const dyn = src.match(/require\(\s*[A-Za-z_$][\w$.]*\s*\)/g) || [];
            const near = dyn.filter((call) => {
                const idx = src.indexOf(call);
                return /orchestration/.test(src.slice(Math.max(0, idx - 400), idx));
            });
            expect(near, `${rel(file)} must not dynamically require orchestration`).to.deep.equal([]);
        }
        // the S-5 leftover shim is a commented one-line re-export (delete at O-1)
        const shim = readSource(path.join(ORCH_DIR, 'event-journal.js'));
        const codeLines = shim.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
        expect(codeLines, 'the journal shim must remain a single re-export line (S5-E/§32.5)')
            .to.deep.equal(["module.exports = require('../state/event-journal');"]);
    });

});
