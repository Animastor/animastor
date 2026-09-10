// ======================================================
// S5-R5: runtime → orchestration cycle reduction (S-5)
// ======================================================
// S-5 broke the frozen R5 cycle: runtime/** no longer requires orchestration
// implementation (orchestrator facade, orchestration index, scene-* modules).
// Orchestration-owned behavior (stage executor entry, FSM-safe facade
// writers) reaches runtime ONLY through composition-root-injected function
// seams (runtime/orchestration-seams.js). The event journal is the single
// classified sink exception (state/event-journal.js — zero-require
// observability leaf).
//
// This guard checks DEPENDENCY DIRECTION (not just filenames):
//   S5-A  runtime → orchestration policy requires: ZERO (incl. lazy/dynamic)
//   S5-B  the seams registry stays hollow (no orchestration import)
//   S5-C  composition root wires all six seams (fail-fast unwired seams)
//   S5-D  no duplicated FSM-writer implementations in runtime/** (ownership
//         stays with state/scene-state-ops.js; facade re-exports only)
//   S5-E  event journal: canonical owner + shim remain, shim is one-line
//   S5-F  runtime→Generation core direction (media-registry/artifact-naming)
//         stays downward — no reverse orchestration→generation policy edges
//         beyond the pre-existing media-registry bootstrap pair
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §26

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { BACKEND_SRC, listSourceFiles, readSource, requireSpecifiers, rel } = require('./helpers');

const RUNTIME_DIR = path.join(BACKEND_SRC, 'runtime');
const ORCH_DIR = path.join(BACKEND_SRC, 'orchestration');

const SEAM_NAMES = [
    'dispatchStage',
    'rollbackStageToPending',
    'markDirtyScene',
    'setScenePending',
    'setSceneAllReady',
    'setScenePlaceholder',
];

function allRuntimeFiles() {
    return listSourceFiles(RUNTIME_DIR);
}

describe('S5-R5: runtime → orchestration cycle reduction', () => {

    it('S5-A: no runtime file requires orchestration policy modules (direct, lazy or dynamic)', () => {
        const offenders = [];
        for (const file of allRuntimeFiles()) {
            const src = readSource(file);
            // static scan over the WHOLE source: catches top-level requires,
            // lazy in-function requires, require(previouslyComputedVar) hints
            const specs = requireSpecifiers(src);
            if (specs.some((s) => s.startsWith('../orchestration') || s.startsWith('../../orchestration'))) {
                offenders.push(rel(file));
            }
            // dynamic require with a computed specifier that mentions orchestration
            const dyn = src.match(/require\(\s*[A-Za-z_$][\w$.]*\s*\)/g) || [];
            const surrounding = dyn.filter((call) => {
                const idx = src.indexOf(call);
                return /orchestration/.test(src.slice(Math.max(0, idx - 400), idx));
            });
            if (surrounding.length > 0) offenders.push(`${rel(file)} (dynamic require near an orchestration specifier)`);
        }
        expect(offenders, 'runtime must reach orchestration behavior only via runtime/orchestration-seams.js (S-5)').to.deep.equal([]);
    });

    it('S5-B: the seams registry stays hollow — zero requires at all', () => {
        const src = readSource(path.join(RUNTIME_DIR, 'orchestration-seams.js'));
        expect(requireSpecifiers(src), 'the seam registry must not require any module — it is a pure function registry').to.deep.equal([]);
        // it must expose the frozen seam surface
        const seams = require('../../src/runtime/orchestration-seams');
        expect(seams.SEAM_NAMES.sort()).to.deep.equal([...SEAM_NAMES].sort());
        // fail-fast: unwired seams throw (no silent no-op)
        seams.clearOrchestrationSeams();
        expect(() => seams.getOrchestrationSeam('markDirtyScene')).to.throw(/not wired/);
        // unknown seam names are rejected — the surface cannot grow silently
        expect(() => seams.registerOrchestrationSeams({ notASeam: async () => {} })).to.throw(/unknown seam/);
        seams.clearOrchestrationSeams();
    });

    it('S5-C: the composition root wires all six seams with orchestration facade functions', () => {
        const backend = fs.readFileSync(path.join(BACKEND_SRC, 'backend.cjs'), 'utf8');
        expect(backend).to.include('registerOrchestrationSeams');
        for (const name of SEAM_NAMES) {
            expect(backend, `composition root must wire seam '${name}'`).to.include(`${name}: orchestrator.${name}`);
        }
    });

    it('S5-D: FSM-writer implementations live ONLY in state/scene-state-ops.js — no duplicates in runtime or orchestration', () => {
        const WRITER_BODIES = [
            'async function markDirtyScene',
            'async function setScenePending',
            'async function setSceneGenerating',
            'async function setSceneAllReady',
            'async function setScenePlaceholder',
        ];
        // canonical owner has them all
        const canonical = readSource(path.join(BACKEND_SRC, 'state', 'scene-state-ops.js'));
        for (const marker of WRITER_BODIES) {
            expect(canonical.includes(marker), `canonical owner must define ${marker}`).to.equal(true);
        }
        // no runtime file defines a duplicate
        for (const file of allRuntimeFiles()) {
            const src = readSource(file);
            for (const marker of WRITER_BODIES) {
                expect(src.includes(marker), `${rel(file)} must not re-implement ${marker}`).to.equal(false);
            }
        }
        // orchestration: the facade re-exports (stateOps.X) instead of defining
        for (const file of listSourceFiles(ORCH_DIR)) {
            const src = readSource(file);
            for (const marker of WRITER_BODIES) {
                expect(src.includes(marker), `${rel(file)} must not re-implement ${marker} — use state/scene-state-ops.js`).to.equal(false);
            }
        }
        // facade re-export identity: orchestrator.setX === stateOps.setX
        const facade = require('../../src/orchestration/orchestrator');
        const ops = require('../../src/state/scene-state-ops');
        for (const name of ['markDirtyScene', 'setScenePending', 'setSceneGenerating', 'setSceneAllReady', 'setScenePlaceholder']) {
            expect(facade[name], `facade must re-export ${name} from the state layer`).to.equal(ops[name]);
        }
    });

    it('S5-E: the event journal keeps a single canonical owner + one-line shim (no duplicate locations)', () => {
        const canonical = readSource(path.join(BACKEND_SRC, 'state', 'event-journal.js'));
        expect(requireSpecifiers(canonical), 'journal must stay a zero-require sink').to.deep.equal([]);
        expect(canonical).to.include('animastor:event-journal:'); // key grammar owner
        const shim = readSource(path.join(ORCH_DIR, 'event-journal.js'));
        expect(requireSpecifiers(shim), 'orchestration/event-journal.js stays a one-line re-export shim').to.deep.equal(['../state/event-journal']);
        // no journal implementation copies elsewhere in orchestration/runtime
        for (const file of [...listSourceFiles(ORCH_DIR), ...allRuntimeFiles()]) {
            const r = rel(file);
            if (r.endsWith('orchestration/event-journal.js')) continue;
            const src = readSource(file);
            expect(src.includes('async function appendSceneEvent'), `${r} must not re-implement the journal appender`).to.equal(false);
        }
    });

    it('S5-F: services and media contours reachable from runtime no longer call orchestration policy', () => {
        // placeholder-audio (reachable from scene-window) and scene-restoration
        // were re-pointed to the state-layer canonical owner in S-5. Pin the
        // re-pointing so the services→orchestration bridge cannot return.
        const placeholder = readSource(path.join(BACKEND_SRC, 'services', 'placeholder-audio.js'));
        const restoration = readSource(path.join(BACKEND_SRC, 'orchestration', 'scene-restoration.js'));
        for (const [name, src] of [['placeholder-audio.js', placeholder], ['scene-restoration.js', restoration]]) {
            const specs = requireSpecifiers(src).filter((s) => /orchestration\/orchestrator/.test(s));
            expect(specs, `${name} must not require the orchestrator facade (use state/scene-state-ops.js)`).to.deep.equal([]);
        }
    });

    it('S5-G: dispatch-engine resolves the executor via seams (seam call sites pinned)', () => {
        const dispatch = readSource(path.join(RUNTIME_DIR, 'dispatch-engine.js'));
        expect(dispatch).to.include("orchestrationSeams.getOrchestrationSeam('dispatchStage')");
        expect(dispatch).to.include("orchestrationSeams.getOrchestrationSeam('rollbackStageToPending')");
        const recon = readSource(path.join(RUNTIME_DIR, 'reconciliation-engine.js'));
        for (const name of ['markDirtyScene', 'setScenePending', 'rollbackStageToPending']) {
            expect(recon).to.include(`getOrchestrationSeam('${name}')`);
        }
        const sceneWindow = readSource(path.join(RUNTIME_DIR, 'scene-window.js'));
        for (const name of ['setSceneAllReady', 'setScenePending', 'setScenePlaceholder']) {
            expect(sceneWindow).to.include(`getOrchestrationSeam('${name}')`);
        }
        const scheduler = readSource(path.join(RUNTIME_DIR, 'runtime-scheduler.js'));
        expect(scheduler).to.include("getOrchestrationSeam('markDirtyScene')");
    });
});
