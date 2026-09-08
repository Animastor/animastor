// ======================================================
// AI ANALYZER BOUNDARY — C17 architecture guard (read-only)
// ======================================================
// Freezes the AI Analyzer boundary facts established by
// docs/architecture/ai-analyzer-boundary-c17.md:
//
//   1. structure-detector.js is PURE (zero requires) — the deterministic
//      candidates/map and the AI-merge seam live in one injectable module.
//   2. The AI Analyzer layer (pipeline steps/runner/orchestrator) never
//      writes books (no Book Writer calls) — persistence is bootstrap-only.
//   3. The AI Analyzer layer never imports the Importer — the Importer
//      calls the analyzer, never the reverse.
//   4. No direct AI SDK (openai/anthropic) anywhere in backend/src —
//      the provider seam is ai-caller → ai-service only.
//   5. Agent pipeline steps reach the LLM ONLY through ai-caller —
//      no direct ai-service/fetch usage inside the steps.
//   6. @animastor/parser does not depend on the AI Analyzer — the edge is
//      host→parser (setStructureDetector), never parser→analyzer.
//
// Pure static source scans — no runtime imports of the scanned code.

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { REPO_ROOT, readSource, rel, requireSpecifiers } = require('./helpers');

// ── AI Analyzer file set (C17 boundary) ─────────────────────────────────────
const AI_ANALYZER_FILES = [
    'backend/src/services/structure-detector.js',
    'backend/src/services/agent/pipeline-steps.js',
    'backend/src/services/agent/pipeline-runner.js',
    'backend/src/services/agent/parallel-analysis-orchestrator.js',
    'backend/src/services/agent/ai-caller.js',
    'backend/src/services/agent/unit-splitter.js',
    'backend/src/services/agent/text-utils.js',
].map(f => path.join(REPO_ROOT, f));

const src = (f) => readSource(f);

// ── Guard 1: structure-detector is pure (zero requires) ─────────────────────
describe('C17 AI Analyzer boundary: structure-detector purity', () => {
    it('structure-detector.js has ZERO require/import specifiers', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/services/structure-detector.js'));
        expect(requireSpecifiers(s), 'structure-detector.js must stay pure — it is the host-injected parser port AND the AI-merge seam').to.deep.equal([]);
    });

    it('structure-detector exports the frozen analyzer seam (analyzeStructure + mergeAiDecisions + sanitizeStructure + buildDeterministicMap)', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/services/structure-detector.js'));
        for (const fn of ['analyzeStructure', 'mergeAiDecisions', 'sanitizeStructure', 'buildDeterministicMap', 'extractCandidates', 'mapToStructureChapters']) {
            expect(s, `structure-detector.js must export ${fn}`).to.match(new RegExp(`\\b${fn}\\b`));
        }
    });
});

// ── Guard 2: analyzer layer never writes books (Book Writer boundary) ───────
describe('C17 AI Analyzer boundary: no Book Writer coupling', () => {
    const WRITER_OPS = [
        /createFromAnalysis/,
        /appendToBook/,
        /createDraftBook/,
        /updateBookState/,
        /writeFileSync/,
    ];
    for (const f of AI_ANALYZER_FILES) {
        it(`${rel(f)} performs no Book Writer operations`, () => {
            const s = src(f);
            const hits = WRITER_OPS.filter((re) => re.test(s)).map(String);
            expect(hits, `${rel(f)} must not persist books (Writer boundary is bootstrap.js)`).to.deep.equal([]);
        });
    }
});

// ── Guard 3: analyzer layer never imports the Importer ──────────────────────
describe('C17 AI Analyzer boundary: no Importer coupling', () => {
    for (const f of AI_ANALYZER_FILES) {
        it(`${rel(f)} never requires txt-importer or agent-service`, () => {
            const s = src(f);
            const specs = requireSpecifiers(s);
            const offenders = specs.filter((spec) => /txt-importer|agent-service/.test(spec));
            expect(offenders, `${rel(f)} must not import Importer modules`).to.deep.equal([]);
        });
    }
});

// ── Guard 4: no AI SDK; single provider seam ────────────────────────────────
describe('C17 AI Analyzer boundary: provider seam', () => {
    it('backend/src has no openai/anthropic SDK imports', () => {
        const backendSrc = path.join(REPO_ROOT, 'backend', 'src');
        const offenders = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!/\.(js|cjs)$/.test(entry.name)) continue;
                const specs = requireSpecifiers(src(full));
                if (specs.some((spec) => /^(openai|anthropic)(\/|$)/.test(spec))) offenders.push(rel(full));
            }
        })(backendSrc);
        expect(offenders, 'AI access must go through the ai-service transport, not SDKs').to.deep.equal([]);
    });

    it('pipeline steps + unit-splitter reach the LLM only via ai-caller', () => {
        for (const f of ['backend/src/services/agent/pipeline-steps.js', 'backend/src/services/agent/unit-splitter.js']) {
            const s = src(path.join(REPO_ROOT, f));
            const specs = requireSpecifiers(s);
            expect(specs, `${f} must require ./ai-caller`).to.include('./ai-caller');
            expect(specs, `${f} must not import ai-service directly`).to.not.include('../ai-service');
        }
    });

    it('ai-service implements the two documented transports (OpenAI-compatible HTTP + LAC connector)', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/services/ai-service.js'));
        expect(s).to.include('/chat/completions');
        expect(s).to.include("transport === 'connector'");
        expect(s).to.include('parseJsonResponse');
    });
});

// ── Guard 5: parser package has no AI Analyzer dependency ───────────────────
describe('C17 AI Analyzer boundary: parser package independence', () => {
    it('@animastor/parser src never requires analyzer/host AI modules', () => {
        const parserSrc = path.join(REPO_ROOT, 'packages', 'animastor-parser', 'src');
        const offenders = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.js')) continue;
                const specs = requireSpecifiers(src(full));
                if (specs.some((spec) => /ai-analyzer|pipeline-steps|ai-caller|ai-service|structure-detector/.test(spec))) {
                    offenders.push(rel(full));
                }
            }
        })(parserSrc);
        expect(offenders, 'Parser package must not depend on the AI Analyzer (edge is host→parser via setStructureDetector)').to.deep.equal([]);
    });

    it('composition root binds the host detector into the parser package (setStructureDetector)', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/backend.cjs'));
        expect(s).to.include('setStructureDetector');
        expect(s).to.include('./services/structure-detector');
    });
});
