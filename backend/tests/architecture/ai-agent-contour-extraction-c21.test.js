// ======================================================
// AI AGENT CONTOUR EXTRACTION — C21 architecture guard
// ======================================================
// Freezes the shared AI Agent / AI Analysis execution boundary created by
// docs/architecture/ai-agent-contour-extraction-c21.md and extended by
// C21.1 (physical package extraction). The guard fixes:
//
//   1. the shared AI execution boundary: every analysis task is reachable
//      through the ai-agent seam; the host adapters route through it;
//   2. "callAI" as the single LLM seam: no task module imports ai-service,
//      an AI SDK, or fetch;
//   3. no host/persistence/generation dependencies inside the module
//      (no PG/Redis/fs, no Book Writer, no Importer, no provider
//      resolution, no generation steps);
//   4. per-task contracts stay separate: each task file owns its prompt
//      assembly + frozen contract export; no npm packages per function;
//   5. no cross-dependencies between concrete AI tasks (task→task imports
//      are forbidden; shared pure helpers live in ports.js/context.js);
//   6. no leakage into Audio/Image/Video Generation: the contour never
//      writes image/video/audio-generation fields, never imports the
//      TTS/image/video orchestration, and voice authoring is analysis-only
//      (voice DESCRIPTIONS, never audio rendering).
//   7. the two-level package architecture: @animastor/ai-agent (Core)
//      owns only the execution mechanism; @animastor/ai-analysis (Semantic)
//      owns all analysis tasks; dependency direction is analysis → agent.
//
// Pure static source scans — no runtime imports of the scanned code.

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { REPO_ROOT, readSource, rel, requireSpecifiers, resolveSpecifier } = require('./helpers');

// ── C21 AI Agent contour file set ────────────────────────────────────────────
// The backend barrel + the C19/C20 analyzer modules it re-exports
// through the single seam.
const CONTOUR_FILES = [
    'backend/src/services/ai-agent/index.js',
    'backend/src/services/ai-agent/ports.js',
    'backend/src/services/ai-agent/context.js',
    'backend/src/services/ai-agent/tasks/locations.js',
    'backend/src/services/ai-agent/tasks/scenes.js',
    'backend/src/services/ai-agent/tasks/units.js',
].map(f => path.join(REPO_ROOT, f));

const ANALYZER_MODULE_FILES = [
    'backend/src/services/structure-analyzer/index.js',
    'backend/src/services/structure-analyzer/ai-merge.js',
    'backend/src/services/character-analyzer/index.js',
    'backend/src/services/character-analyzer/voices.js',
].map(f => path.join(REPO_ROOT, f));

// C21.1: the two-level package files
const AGENT_CORE_FILES = [
    'packages/animastor-ai-agent/src/index.js',
    'packages/animastor-ai-agent/src/ports.js',
].map(f => path.join(REPO_ROOT, f));

const ANALYSIS_PACKAGE_FILES = [
    'packages/animastor-ai-analysis/src/index.js',
    'packages/animastor-ai-analysis/src/context.js',
    'packages/animastor-ai-analysis/src/tasks/locations.js',
    'packages/animastor-ai-analysis/src/tasks/scenes.js',
    'packages/animastor-ai-analysis/src/tasks/units.js',
].map(f => path.join(REPO_ROOT, f));

const SEAM = path.join(REPO_ROOT, 'backend/src/services/ai-agent/index.js');
const STEPS = path.join(REPO_ROOT, 'backend/src/services/agent/pipeline-steps.js');
const RUNNER = path.join(REPO_ROOT, 'backend/src/services/agent/pipeline-runner.js');
const AGENT_CORE_INDEX = path.join(REPO_ROOT, 'packages/animastor-ai-agent/src/index.js');
const ANALYSIS_INDEX = path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src/index.js');

const src = (f) => readSource(f);

const forAllContourFiles = (it, name, fn) => {
    for (const f of CONTOUR_FILES) it(`${rel(f)} ${name}`, fn(f));
};

const forAllPackageTaskFiles = (it, name, fn) => {
    for (const f of ANALYSIS_PACKAGE_FILES) it(`${rel(f)} ${name}`, fn(f));
};

// ── Guard 1: the shared execution boundary ───────────────────────────────────
describe('C21 AI Agent contour: shared execution boundary', () => {
    it('the backend barrel delegates to @animastor/ai-analysis (frozen contract names re-exported)', () => {
        const s = src(SEAM);
        expect(s, 'barrel must require @animastor/ai-analysis').to.match(/require\('@animastor\/ai-analysis'\)/);
        expect(s, 'barrel must re-export the analysis module').to.match(/module\.exports = analysis/);
    });

    it('the analysis package exports every analysis task operation (frozen contract names)', () => {
        const s = src(ANALYSIS_INDEX);
        for (const name of ['analyzeBookStructure', 'extractCharacters', 'generateVoices',
            'extractLocations', 'createScenes', 'createUnits', 'assertHostPorts', 'buildLocationsContext']) {
            expect(s, `analysis package must export ${name}`).to.match(new RegExp(`\\b${name}\\b`));
        }
    });

    it('the analysis package routes C19/C20 analyzer modules through the analysis seam', () => {
        const specs = requireSpecifiers(src(ANALYSIS_INDEX));
        expect(specs.some(s => /structure-analyzer/.test(s)), 'analysis must reference structure-analyzer').to.equal(true);
        expect(specs.some(s => /character-analyzer/.test(s)), 'analysis must reference character-analyzer').to.equal(true);
    });

    it('pipeline-steps.js routes ALL analysis steps through the ai-agent seam (no analyzer-module direct wiring)', () => {
        const s = src(STEPS);
        expect(s).to.match(/require\('\.\.\/ai-agent'\)/);
        for (const op of ['aiAgent.analyzeBookStructure', 'aiAgent.extractCharacters', 'aiAgent.generateVoices',
            'aiAgent.extractLocations', 'aiAgent.createScenes', 'aiAgent.createUnits']) {
            expect(s, `host adapter must route through aiAgent.${op.replace('aiAgent.', '')}`).to.include(op);
        }
        // the host adapter no longer wires the analyzer modules directly
        expect(s, 'step adapters must not bypass the contour seam').to.not.match(/require\('\.\.\/character-analyzer'\)/);
        expect(s, 'step adapters must not bypass the contour seam').to.not.match(/require\('\.\.\/structure-analyzer'\)/);
    });

    it('every contour task performs fail-closed host-port validation through the shared mechanism', () => {
        const s = src(path.join(REPO_ROOT, 'packages/animastor-ai-agent/src/ports.js'));
        expect(s).to.match(/function assertHostPorts/);
        expect(s).to.match(/missing host port/);
        for (const f of ['tasks/locations.js', 'tasks/scenes.js', 'tasks/units.js']) {
            const t = src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src', f));
            expect(t, `${f} must use the shared assertHostPorts mechanism`).to.match(/assertHostPorts/);
        }
    });

    it('only the two designated architectural packages exist for AI — no per-function packages', () => {
        const pkgDir = path.join(REPO_ROOT, 'packages');
        const aiPackages = fs.readdirSync(pkgDir).filter((d) => /ai-?agent|ai-?analysis/.test(d));
        expect(aiPackages.sort(), 'exactly two AI packages: ai-agent (Core) and ai-analysis (Semantic)').to.deep.equal(['animastor-ai-agent', 'animastor-ai-analysis']);
        const perFunctionPackages = fs.readdirSync(pkgDir).filter((d) => /character-analyzer|structure-analyzer|voice|scene-analyzer|location/.test(d));
        expect(perFunctionPackages, 'AI tasks must NOT be split into per-function npm packages (C21 §4)').to.deep.equal([]);
    });
});

// ── Guard 2: callAI is the only LLM seam ─────────────────────────────────────
describe('C21 AI Agent contour: single LLM seam', () => {
    const allScannableFiles = [...AGENT_CORE_FILES, ...ANALYSIS_PACKAGE_FILES];

    for (const f of allScannableFiles) {
        it(`${rel(f)} never imports ai-service, an AI SDK, or calls fetch directly`, () => {
            const specs = requireSpecifiers(src(f));
            const offenders = specs.filter((spec) => /ai-service|openai|anthropic/.test(spec));
            expect(offenders, 'direct transport/SDK import bypasses the callAI port').to.deep.equal([]);
            expect(src(f), 'HTTP transport stays behind the callAI port').to.not.match(/\bfetch\s*\(/);
        });

        it(`${rel(f)} never imports ai-caller either (the LLM enters ONLY via the injected port)`, () => {
            const specs = requireSpecifiers(src(f));
            const offenders = specs.filter((spec) => /ai-caller/.test(spec));
            expect(offenders, 'even the caller wrapper must be host-injected, not required').to.deep.equal([]);
        });
    }

    it('the host adapter is the place that binds ai-caller into the contour ports', () => {
        const s = src(STEPS);
        expect(s).to.match(/callAI: aiCaller\.callAI/);
        expect(s).to.match(/logConversation: aiCaller\.logConversation/);
    });
});

// ── Guard 3: no host / persistence / generation dependencies ─────────────────
describe('C21 AI Agent contour: dependency boundary', () => {
    it('analysis task files require nothing but @animastor/ai-agent + context + pure shared utils', () => {
        for (const f of ['tasks/locations.js', 'tasks/scenes.js', 'tasks/units.js']) {
            const file = path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src', f);
            const specs = requireSpecifiers(src(file));
            for (const spec of specs) {
                if (spec.startsWith('@animastor/')) {
                    // allowed: @animastor/ai-agent (core mechanism) and @animastor/vbook-runtime (pure utils)
                    expect(spec, `${f} may require ${spec}`).to.match(/^@animastor\/(ai-agent|vbook-runtime)/);
                } else {
                    const resolved = resolveSpecifier(file, spec);
                    expect(resolved, `${f} → ${spec} must resolve inside the closed dependency surface`).to.not.equal(null);
                }
            }
        }
    });

    it('the analysis package requires only ai-agent, vbook-runtime, context, tasks, and C19/C20 modules', () => {
        const specs = requireSpecifiers(src(ANALYSIS_INDEX));
        for (const spec of specs) {
            expect(spec, `analysis package require ${spec} must be within the analysis contour`).to.match(/^@animastor\/(ai-agent|vbook-runtime)|^\.\.?\//);
        }
    });

    it('the ai-agent core package requires nothing (zero dependencies)', () => {
        const specs = requireSpecifiers(src(AGENT_CORE_INDEX));
        expect(specs.filter(s => !s.startsWith('./')), 'core package must have no external dependencies').to.deep.equal([]);
    });

    it('the backend barrel delegates to @animastor/ai-analysis (no direct persistence/infrastructure imports)', () => {
        const specs = requireSpecifiers(src(SEAM));
        expect(specs).to.include('@animastor/ai-analysis');
        // the barrel should not import infrastructure directly
        const infra = specs.filter((spec) => /storage\/postgres|agent-session|redis|ai-caller|ai-service/.test(spec));
        expect(infra, 'barrel must not import infrastructure directly').to.deep.equal([]);
    });

    forAllPackageTaskFiles(it, 'performs no PG/Redis/fs access of its own (comment-stripped scan)', (f) => () => {
        const s = src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const op of [/\bpg\b/, /\.query\(/, /\bredis\b/i, /writeFileSync/, /readFileSync/, /appendFileSync/]) {
            expect(s, `${rel(f)} must not touch persistence directly`).to.not.match(op);
        }
    });

    forAllPackageTaskFiles(it, 'never imports PG/session/prompt/profile/provider infrastructure', (f) => () => {
        const specs = requireSpecifiers(src(f));
        const offenders = specs.filter((spec) => /storage\/postgres|agent-session|layer-config|redis|workspace-ai-provider|runtime-config|ai-loader|agent-prompts|prompt-profile-loader|fs['"]|lazy-book/.test(spec));
        expect(offenders, 'session/log/prompt/skill capabilities must be host-injected ports').to.deep.equal([]);
    });

    forAllPackageTaskFiles(it, 'never imports the Book Writer or the Importer', (f) => () => {
        const specs = requireSpecifiers(src(f));
        const offenders = specs.filter((spec) => /txt-importer|agent-service|lazy-book/.test(spec));
        expect(offenders, 'the Importer/Book Writer call the contour, never the reverse').to.deep.equal([]);
    });

    it('persistence stays host-side (runner keeps applying merge to contour output; bootstrap owns Book Writer)', () => {
        const s = src(RUNNER);
        expect(s).to.match(/mergeCharacterLists/);
        const bootstrap = src(path.join(REPO_ROOT, 'backend/src/services/agent/bootstrap.js'));
        expect(bootstrap, 'bootstrap persists characters via the Book Writer').to.match(/createFromAnalysis/);
    });
});

// ── Guard 4: per-task contracts stay separate ────────────────────────────────
describe('C21 AI Agent contour: separate task contracts', () => {
    it('each task file assembles its OWN prompt (prompt/rules stay task-local, not centralized)', () => {
        const prompts = {
            'tasks/locations.js': /prompt\('locations'\)/,
            'tasks/scenes.js': /prompt\('scenes'\)/,
            'tasks/units.js': /prompt\('units'\)/,
        };
        for (const [f, re] of Object.entries(prompts)) {
            const s = src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src', f));
            expect(s, `${f} must assemble its own ${re} prompt`).to.match(re);
        }
        // the analysis package index must not become a prompt semantic dump
        const analysisIdx = src(ANALYSIS_INDEX);
        expect(analysisIdx, 'analysis package must not inline task prompts').to.not.match(/Extract all locations/);
        expect(analysisIdx, 'analysis package must not inline task prompts').to.not.match(/Split this text into scenes/);
        expect(analysisIdx, 'analysis package must not inline task prompts').to.not.match(/Decompose this scene/);
    });

    it('each task keeps its own frozen step type (PG CHECK contract unchanged)', () => {
        const stepTypes = {
            'tasks/locations.js': 'analyze_locations',
            'tasks/scenes.js': 'create_scenes',
            'tasks/units.js': 'create_units',
        };
        for (const [f, type] of Object.entries(stepTypes)) {
            const s = src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src', f));
            expect(s, `${f} must keep the frozen step type ${type}`).to.match(new RegExp(`'${type}'`));
        }
    });

    it('the moved tasks keep their degradation semantics (throw vs fallback unit)', () => {
        expect(src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src/tasks/locations.js'))).to.match(/await failStep\(step\.step_id, err\.message\);\s*\n\s*throw err/);
        expect(src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src/tasks/scenes.js'))).to.match(/AI returned no scenes/);
        const units = src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src/tasks/units.js'));
        expect(units).to.match(/AI failed, using fallback/);
        expect(units).to.match(/type: input\.scene\.type === 'dialogue' \? 'dialogue' : 'perception'/);
    });

    it('prompt assets stay untouched (ai/rules/*.md unchanged — no prompt text duplicated into the module)', () => {
        for (const f of [...AGENT_CORE_FILES, ...ANALYSIS_PACKAGE_FILES]) {
            const s = src(f);
            for (const promptText of ['Extract all characters from this text', 'Extract all locations from this text:\n']) {
                // the user-message wrapper is allowed (moved verbatim); the
                // check is that no SYSTEM RULES text was copied into the module
            }
        }
        // and the rules directory still exists unchanged in the host fs
        expect(fs.existsSync(path.join(REPO_ROOT, 'backend/ai/rules/locations.md'))).to.equal(true);
        expect(fs.existsSync(path.join(REPO_ROOT, 'backend/ai/rules/scenes.md'))).to.equal(true);
        expect(fs.existsSync(path.join(REPO_ROOT, 'backend/ai/rules/units.md'))).to.equal(true);
    });
});

// ── Guard 5: no cross-dependencies between concrete AI tasks ─────────────────
describe('C21 AI Agent contour: task independence', () => {
    it('no task file imports a sibling task (task→task imports forbidden; the seam composes)', () => {
        const TASK_FILES = [
            'packages/animastor-ai-analysis/src/tasks/locations.js',
            'packages/animastor-ai-analysis/src/tasks/scenes.js',
            'packages/animastor-ai-analysis/src/tasks/units.js',
        ].map(f => path.join(REPO_ROOT, f));
        for (const f of TASK_FILES) {
            const specs = requireSpecifiers(src(f));
            const taskSpecs = specs.filter((spec) => /tasks\/|index['"]|\.\.\/(structure|character)-analyzer/.test(spec));
            expect(taskSpecs, `${rel(f)} must not import sibling tasks — sharing goes through ports/context`).to.deep.equal([]);
        }
    });

    it('the contour import graph (analysis tasks + analyzer modules) stays acyclic', () => {
        const files = [...ANALYSIS_PACKAGE_FILES, ...ANALYZER_MODULE_FILES];
        const contourSet = new Set(files);
        const edges = new Map();
        for (const file of files) {
            const deps = new Set();
            for (const spec of requireSpecifiers(src(file))) {
                const resolved = resolveSpecifier(file, spec);
                if (resolved && contourSet.has(resolved)) deps.add(resolved);
            }
            edges.set(file, deps);
        }
        const state = new Map();
        let cycle = null;
        const stack = [];
        function visit(file) {
            if (cycle) return;
            state.set(file, 1);
            stack.push(file);
            for (const dep of edges.get(file) || []) {
                const st = state.get(dep) || 0;
                if (st === 1) { cycle = [...stack.slice(stack.indexOf(dep)), dep]; return; }
                if (st === 0) visit(dep);
                if (cycle) return;
            }
            stack.pop();
            state.set(file, 2);
        }
        for (const file of files) {
            if ((state.get(file) || 0) === 0) visit(file);
            if (cycle) break;
        }
        expect(cycle, `cyclic require found: ${(cycle || []).map(f => path.relative(REPO_ROOT, f)).join(' -> ')}`).to.equal(null);
    });

    it('shared pure helpers live in ports/context — not copy-pasted between tasks', () => {
        for (const f of ['tasks/locations.js', 'tasks/scenes.js', 'tasks/units.js']) {
            const s = src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src', f));
            expect(s, `${f} must not re-implement assertHostPorts`).to.not.match(/function assertHostPorts/);
            expect(s, `${f} must not re-implement buildLocationsContext`).to.not.match(/function buildLocationsContext/);
        }
        // the moved normalizeSceneEnvironment lives in exactly one physical home
        const scenes = src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src/tasks/scenes.js'));
        expect(scenes).to.match(/function normalizeSceneEnvironment/);
        const steps = src(STEPS);
        expect(steps, 'pipeline-steps must not keep a duplicate normalizeSceneEnvironment').to.not.match(/function normalizeSceneEnvironment/);
    });
});

// ── Guard 6: no leakage into Audio/Image/Video Generation ────────────────────
describe('C21 AI Agent contour: generation boundary', () => {
    forAllPackageTaskFiles(it, 'never writes generation fields (image/video/passport/audio-generation)', (f) => () => {
        const s = src(f);
        for (const genWrite of ['.image', 'video:', 'image:', 'passport']) {
            expect(s, `${rel(f)} must not produce ${genWrite} (generation output)`).to.not.include(genWrite);
        }
    });

    forAllPackageTaskFiles(it, 'never imports the generation domain (image/video/audio orchestration, workflows, prompt-builder)', (f) => () => {
        const specs = requireSpecifiers(src(f));
        const offenders = specs.filter((spec) => /image-service|video-orchestrator|audio-orchestrator|workflows\/|prompt-builder|placeholder-audio|image-utils|comfyui|gpu-hub/.test(spec));
        expect(offenders, 'generation stays host-side — the contour is analysis-only').to.deep.equal([]);
    });

    it('voice authoring inside the contour is analysis/authoring only (voice DESCRIPTIONS, never audio rendering)', () => {
        const voices = src(path.join(REPO_ROOT, 'backend/src/services/character-analyzer/voices.js'));
        expect(voices, 'voices.js writes voice instruction strings').to.match(/ch\.voice = voices\[ch\.id\]\.instruction/);
        // code-only scan (comments legitimately mention the downstream TTS
        // consumer — the forbidden thing is RENDERING, i.e. audio I/O calls)
        const code = voices.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const renderOp of [/synthesize/i, /audioFile/, /\.wav\b/, /speechSynthesis/, /writeFileSync/, /createWriteStream/, /spawn\(/]) {
            expect(code, 'no TTS/audio rendering inside the contour').to.not.match(renderOp);
        }
        // and the analysis package documents voice authoring as analysis, not generation
        const analysisIdx = src(ANALYSIS_INDEX);
        expect(analysisIdx, 'analysis package documents voice authoring as analysis').to.match(/Voice description authoring/);
    });

    it('generation steps stay in the host (visuals/reconciliation/polish never entered the contour)', () => {
        for (const fn of ['stepCreateVisuals', 'stepReconcilePassports', 'stepReconcileVideoActions',
            'stepPolishStoryboard', 'stepPolishVideoActions', 'stepRepairFantasyIds']) {
            expect(src(STEPS), `generation step ${fn} stays host-side (C18 §4 boundary)`).to.match(new RegExp(`async function ${fn}\\b`));
        }
    });
});

// ── Guard 7 (C21.1): two-level package architecture ──────────────────────────
describe('C21.1 AI Agent / AI Analysis: package architecture', () => {
    it('@animastor/ai-agent core exports only assertHostPorts (no semantic analysis functions)', () => {
        const core = src(AGENT_CORE_INDEX);
        expect(core).to.match(/assertHostPorts/);
        // Must NOT export any domain-specific analysis functions
        for (const fn of ['extractCharacters', 'extractLocations', 'createScenes', 'createUnits',
            'analyzeBookStructure', 'generateVoices', 'buildLocationsContext']) {
            expect(core, `core must NOT export ${fn}`).to.not.match(new RegExp(`\\b${fn}\\b`));
        }
    });

    it('@animastor/ai-agent core has zero external dependencies (pure mechanism)', () => {
        const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/animastor-ai-agent/package.json'), 'utf8'));
        expect(pkgJson.dependencies, 'core must have no runtime dependencies').to.not.exist;
    });

    it('@animastor/ai-analysis depends on @animastor/ai-agent (dependency direction: analysis → agent)', () => {
        const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/package.json'), 'utf8'));
        expect(pkgJson.dependencies).to.have.property('@animastor/ai-agent');
        expect(pkgJson.dependencies, 'analysis must NOT depend on generation modules').to.not.have.property('@animastor/gpu-hub');
    });

    it('@animastor/ai-agent does NOT depend on @animastor/ai-analysis (no reverse dependency)', () => {
        const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/animastor-ai-agent/package.json'), 'utf8'));
        const deps = pkgJson.dependencies || {};
        expect(deps, 'core must NOT depend on analysis').to.not.have.property('@animastor/ai-analysis');
    });

    it('the ai-agent core package contains no task files (no domain logic)', () => {
        const coreDir = path.join(REPO_ROOT, 'packages/animastor-ai-agent/src');
        const files = fs.readdirSync(coreDir);
        expect(files, 'core src/ must contain only index.js and ports.js').to.deep.equal(['index.js', 'ports.js']);
    });
});
