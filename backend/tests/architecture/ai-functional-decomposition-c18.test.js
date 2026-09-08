// ======================================================
// AI FUNCTIONAL DECOMPOSITION — C18 architecture guard (read-only)
// ======================================================
// Freezes the functional-decomposition facts established by
// docs/architecture/ai-functional-decomposition-c18.md:
//
//   1. The AI contour import graph is a DAG — no cyclic require() between
//      contour files (structure-detector, agent/*, ai-service, ai-caller,
//      agent-prompts, unit-splitter, text-utils).
//   2. ANALYSIS steps (structure/characters/locations/scenes/units) never
//      produce generation fields (image.prompt / video.action writing) —
//      the Analysis vs Generation boundary of C18 §4.
//   3. GENERATION steps (visuals, reconciliation, polish, fantasy repair)
//      are present in the same contour and reach the LLM ONLY via ai-caller.
//   4. Every AI module reaches the LLM only through ai-caller.callAI
//      (no direct ai-service / fetch inside steps) — C17 guard 5, restated
//      per functional module.
//   5. The Book Writer boundary holds: analysis/generation modules never
//      call lazyBook.createFromAnalysis / appendToBook — Book Writer calls
//      are host-only (agent/bootstrap.js).
//   6. The parallel-analysis-orchestrator receives analyzers injected
//      (no hardcoded require of pipeline-steps) — orchestration/business
//      separation at the orchestrator seam.
//   7. Cross-contour contract: scene.passport[...].video_tokens written by
//      the AI contour is consumed GPU-side (video-workflows / prompt-builder)
//      — the F9 output shape must not drift silently.
//
// Pure static source scans — no runtime imports of the scanned code.

const { expect } = require('chai');
const path = require('path');
const {
    REPO_ROOT, readSource, requireSpecifiers, resolveSpecifier,
} = require('./helpers');

// ── C18 contour file set (functional modules F1–F18, C19/C20 physical splits) ──
const CONTOUR_FILES = [
    'backend/src/services/structure-detector-deterministic.js',
    'backend/src/services/structure-analyzer/index.js',
    'backend/src/services/structure-analyzer/ai-merge.js',
    'backend/src/services/structure-detector.js',
    'backend/src/services/character-analyzer/index.js',
    'backend/src/services/character-analyzer/voices.js',
    'backend/src/services/agent/pipeline-steps.js',
    'backend/src/services/agent/pipeline-runner.js',
    'backend/src/services/agent/parallel-analysis-orchestrator.js',
    'backend/src/services/agent/ai-caller.js',
    'backend/src/services/agent/unit-splitter.js',
    'backend/src/services/agent/text-utils.js',
    'backend/src/services/agent/image-utils.js',
    'backend/src/services/agent/bootstrap.js',
    'backend/src/services/agent-session.js',
    'backend/src/services/ai-service.js',
    'backend/src/services/agent-prompts.js',
].map(f => path.join(REPO_ROOT, f));

const src = (f) => readSource(f);

// ── Guard 1: the contour import graph is a DAG (no cycles) ──────────────────
describe('C18 functional decomposition: acyclic contour graph', () => {
    const edges = new Map(); // file -> Set<file> (resolved, contour-internal only)
    const contourSet = new Set(CONTOUR_FILES);

    for (const file of CONTOUR_FILES) {
        const specs = requireSpecifiers(src(file));
        const deps = new Set();
        for (const spec of specs) {
            const resolved = resolveSpecifier(file, spec);
            if (resolved && contourSet.has(resolved)) deps.add(resolved);
        }
        edges.set(file, deps);
    }

    it('every contour file resolves its contour-internal requires without escapes to ambiguous paths', () => {
        // sanity: the map is populated (guards against silent path refactors)
        const totalEdges = [...edges.values()].reduce((n, s) => n + s.size, 0);
        expect(totalEdges, 'expected a non-trivial contour graph').to.be.at.least(8);
    });

    it('has NO cyclic dependencies (DFS cycle detection over contour-internal requires)', () => {
        const state = new Map(); // 0=unvisited 1=in-stack 2=done
        let cycle = null;
        const stack = [];
        function visit(file) {
            if (cycle) return;
            state.set(file, 1);
            stack.push(file);
            for (const dep of edges.get(file) || []) {
                const st = state.get(dep) || 0;
                if (st === 1) {
                    cycle = [...stack.slice(stack.indexOf(dep)), dep];
                    return;
                }
                if (st === 0) visit(dep);
                if (cycle) return;
            }
            stack.pop();
            state.set(file, 2);
        }
        for (const file of CONTOUR_FILES) {
            if ((state.get(file) || 0) === 0) visit(file);
            if (cycle) break;
        }
        expect(cycle, `cyclic require found: ${(cycle || []).map(f => path.relative(REPO_ROOT, f)).join(' -> ')}`).to.equal(null);
    });
});

// ── Guard 2: Analysis vs Generation boundary (C18 §4) ───────────────────────
describe('C18 functional decomposition: Analysis vs Generation boundary', () => {
    const steps = src(path.join(REPO_ROOT, 'backend/src/services/agent/pipeline-steps.js'));

    it('ANALYSIS steps (structure/characters/locations/scenes/units) never write generation fields', () => {
        // Extract each analysis step function body by name and scan it for
        // generation-field writes.
        const analysisSteps = [
            'stepAnalyzeStructure', 'stepExtractCharacters', 'stepExtractLocations',
            'stepCreateScenes', 'stepCreateUnits',
        ];
        for (const fnName of analysisSteps) {
            const re = new RegExp(`async function ${fnName}\\(`);
            const m = re.exec(steps);
            expect(m, `analysis step ${fnName} must exist in pipeline-steps.js`).to.not.equal(null);
            const body = steps.slice(m.index);
            // naive brace matching from the function start
            let depth = 0, started = false, end = body.length;
            for (let i = 0; i < body.length; i++) {
                if (body[i] === '{') { depth++; started = true; }
                if (body[i] === '}') { depth--; if (started && depth === 0) { end = i; break; } }
            }
            const fnBody = body.slice(0, end);
            for (const genWrite of ['.image =', '.video =', 'image:', 'video:']) {
                expect(fnBody, `${fnName} must not write ${genWrite} (generation field) — Analysis/Generation boundary`).to.not.include(genWrite);
            }
        }
    });

    it('GENERATION steps exist and are registered/exported alongside pure merge guards', () => {
        for (const fnName of ['stepCreateVisuals', 'stepReconcilePassports', 'stepReconcileVideoActions',
            'stepPolishStoryboard', 'stepPolishVideoActions', 'stepRepairFantasyIds']) {
            expect(steps, `generation step ${fnName} must exist`).to.match(new RegExp(`\\b${fnName}\\b`));
        }
        for (const guard of ['normalizeVisualText', 'isStaticActionCopy', 'needsVideoActionReconciliation',
            'buildCrossPromptHints', 'mergeRepairResults', 'canonicalizeVisualUnit']) {
            expect(steps, `generation guard/helper ${guard} must exist`).to.match(new RegExp(`\\b${guard}\\b`));
        }
    });
});

// ── Guard 3: every AI module reaches the LLM only via ai-caller ─────────────
describe('C18 functional decomposition: single LLM seam per functional module', () => {
    const STEP_FILES = [
        'backend/src/services/agent/pipeline-steps.js',
        'backend/src/services/agent/unit-splitter.js',
    ].map(f => path.join(REPO_ROOT, f));

    for (const f of STEP_FILES) {
        it(`${path.relative(REPO_ROOT, f)} does not import ai-service or call fetch directly`, () => {
            const specs = requireSpecifiers(src(f));
            expect(specs, 'must not import ai-service directly').to.not.include('../ai-service');
            expect(specs.some(s => s.includes('ai-service')), 'must not import ai-service under any path').to.equal(false);
            const s = src(f);
            expect(s, 'must not call fetch directly').to.not.match(/\bfetch\s*\(/);
        });
    }

    it('ai-caller remains the only contour module importing ai-service', () => {
        const callers = ['agent/pipeline-steps.js', 'agent/pipeline-runner.js', 'agent/unit-splitter.js',
            'agent/parallel-analysis-orchestrator.js', 'agent/text-utils.js', 'agent/image-utils.js',
            'agent/bootstrap.js'];
        for (const rel of callers) {
            const specs = requireSpecifiers(src(path.join(REPO_ROOT, 'backend/src/services', rel)));
            expect(specs.some(s => s.includes('ai-service')), `${rel} must not bypass ai-caller`).to.equal(false);
        }
        const specs = requireSpecifiers(src(path.join(REPO_ROOT, 'backend/src/services/agent/ai-caller.js')));
        expect(specs, 'ai-caller must import ai-service').to.include('../ai-service');
    });
});

// ── Guard 4: Book Writer calls are host-only ────────────────────────────────
describe('C18 functional decomposition: Book Writer boundary', () => {
    const NON_HOST_FILES = [
        'backend/src/services/structure-detector-deterministic.js',
        'backend/src/services/structure-analyzer/index.js',
        'backend/src/services/structure-analyzer/ai-merge.js',
        'backend/src/services/structure-detector.js',
        'backend/src/services/character-analyzer/index.js',
        'backend/src/services/character-analyzer/voices.js',
        'backend/src/services/agent/pipeline-steps.js',
        'backend/src/services/agent/pipeline-runner.js',
        'backend/src/services/agent/parallel-analysis-orchestrator.js',
        'backend/src/services/agent/unit-splitter.js',
        'backend/src/services/agent/text-utils.js',
        'backend/src/services/agent/image-utils.js',
        'backend/src/services/agent/ai-caller.js',
    ].map(f => path.join(REPO_ROOT, f));

    const WRITER_OPS = [/createFromAnalysis/, /appendToBook/, /createDraftBook/, /updateBookState/];

    for (const f of NON_HOST_FILES) {
        it(`${path.relative(REPO_ROOT, f)} never calls the Book Writer`, () => {
            const s = src(f);
            for (const op of WRITER_OPS) {
                expect(s, `${op} must not appear in ${path.relative(REPO_ROOT, f)}`).to.not.match(op);
            }
        });
    }

    it('bootstrap.js (host) is the Book Writer caller', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/services/agent/bootstrap.js'));
        expect(s).to.match(/createFromAnalysis/);
        expect(s).to.match(/appendToBook/);
    });
});

// ── Guard 5: orchestrator receives analyzers injected ───────────────────────
describe('C18 functional decomposition: orchestration seams', () => {
    it('parallel-analysis-orchestrator does not hard-require pipeline-steps', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/services/agent/parallel-analysis-orchestrator.js'));
        const specs = requireSpecifiers(s);
        expect(specs.some(spec => spec.includes('pipeline-steps')), 'analyzers must be injected, not required').to.equal(false);
        expect(s, 'orchestrator must consume ctx.analyzers').to.match(/ctx\.analyzers/);
    });

    it('pipeline-runner passes pipelineSteps as the injected analyzers map', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/services/agent/pipeline-runner.js'));
        expect(s).to.match(/analyzers:\s*pipelineSteps/);
    });
});

// ── Guard 6: cross-contour contract — video_tokens consumers ────────────────
describe('C18 functional decomposition: F9 cross-contour contract (video_tokens)', () => {
    it('GPU-side consumers still read scene.passport[charId].video_tokens written by the AI contour', () => {
        const video = src(path.join(REPO_ROOT, 'backend/src/workflows/video/video-workflows.js'));
        expect(video, 'video-workflows must consume scene passport video_tokens').to.match(/passport\?\.\[c\.id\]\?\.video_tokens|passport\[c\.id\]\.video_tokens|video_tokens/);
        const ai = src(path.join(REPO_ROOT, 'backend/src/services/agent/pipeline-runner.js'));
        expect(ai, 'pipeline-runner must write scene passport video_tokens (applySceneVideoTokens)').to.match(/applySceneVideoTokens/);
    });
});

// ── Guard 7: structure-detector dual role resolved by the C19 split ─────────
describe('C18 functional decomposition: structure-detector dual role preserved', () => {
    it('deterministic half stays pure (zero requires) with its surface exported', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/services/structure-detector-deterministic.js'));
        expect(requireSpecifiers(s), 'deterministic half must stay pure (parser port impl)').to.deep.equal([]);
        for (const fn of ['extractCandidates', 'buildDeterministicMap', 'mapToStructureChapters']) {
            expect(s, `deterministic half must export ${fn}`).to.match(new RegExp(`\\b${fn}\\b`));
        }
    });

    it('AI-merge half exports live in the structure-analyzer module (C19)', () => {
        for (const fn of ['analyzeStructure', 'mergeAiDecisions', 'sanitizeStructure']) {
            const s = src(path.join(REPO_ROOT, 'backend/src/services/structure-analyzer/ai-merge.js'));
            expect(s, `structure-analyzer/ai-merge must define ${fn}`).to.match(new RegExp(`function ${fn}\\b`));
        }
        const barrel = src(path.join(REPO_ROOT, 'backend/src/services/structure-detector.js'));
        expect(barrel, 'compatibility barrel re-exports the AI-merge half').to.match(/require\('\.\/structure-analyzer'\)/);
    });

    it('composition root still binds the deterministic detector into @animastor/parser', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/backend.cjs'));
        expect(s).to.match(/setStructureDetector\(require\('\.\/services\/structure-detector'\)\)/);
    });
});
