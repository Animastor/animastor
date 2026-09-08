// ======================================================
// STRUCTURE ANALYZER EXTRACTION — C19 architecture guard
// ======================================================
// Freezes the physical boundary created by
// docs/architecture/structure-analyzer-extraction-c19.md:
//
//   1. The Structure Analyzer module does not call the Book Writer.
//   2. The Structure Analyzer module does not import the Importer.
//   3. The Structure Analyzer module does not reach ai-service directly
//      (the LLM seam is the injected callAI port → ai-caller).
//   4. The Structure Analyzer module contains no direct fetch.
//   5. The Structure Analyzer module does not depend on the
//      Character/Location/Scene analyzers (no pipeline-steps / orchestrator
//      imports, no mention/scene/visual logic).
//   6. Parser Core receives no reverse dependency on the AI module — the
//      @animastor/parser package never requires the analyzer; the
//      composition root binds the deterministic adapter via
//      setStructureDetector.
//   7. Host capabilities (PG session/steps, conversation log, prompts,
//      provider context) reach the analyzer ONLY through the port object —
//      the module body performs no PG/Redis/SSE/fs access.
//   8. The old structure-detector path is a re-export-only compatibility
//      barrel — no hidden duplicated implementation of either half.
//
// Pure static source scans — no runtime imports of the scanned code.

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { REPO_ROOT, readSource, rel, requireSpecifiers } = require('./helpers');

// ── C19 Structure Analyzer module file set ──────────────────────────────────
const ANALYZER_FILES = [
    'backend/src/services/structure-analyzer/index.js',
    'backend/src/services/structure-analyzer/ai-merge.js',
].map(f => path.join(REPO_ROOT, f));

const PARSER_ADAPTER = path.join(REPO_ROOT, 'backend/src/services/structure-detector-deterministic.js');
const BARREL = path.join(REPO_ROOT, 'backend/src/services/structure-detector.js');
const COMPOSITION_ROOT = path.join(REPO_ROOT, 'backend/src/backend.cjs');

const src = (f) => readSource(f);

const forAllAnalyzers = (it, name, fn) => {
    for (const f of ANALYZER_FILES) it(`${rel(f)} ${name}`, fn(f));
};

// ── Guard 1: no Book Writer ──────────────────────────────────────────────────
describe('C19 Structure Analyzer boundary: Book Writer', () => {
    const WRITER_OPS = [/createFromAnalysis/, /appendToBook/, /createDraftBook/, /updateBookState/, /writeFileSync/, /lazyBook/];
    forAllAnalyzers(it, 'never calls the Book Writer', (f) => () => {
        const s = src(f);
        const hits = WRITER_OPS.filter((re) => re.test(s)).map(String);
        expect(hits, 'Book Writer calls are host-only (agent/bootstrap.js)').to.deep.equal([]);
    });
});

// ── Guard 2: no Importer ─────────────────────────────────────────────────────
describe('C19 Structure Analyzer boundary: Importer', () => {
    forAllAnalyzers(it, 'never requires the Importer (txt-importer / agent-service)', (f) => () => {
        const specs = requireSpecifiers(src(f));
        const offenders = specs.filter((spec) => /txt-importer|agent-service/.test(spec));
        expect(offenders, 'the Importer calls the analyzer, never the reverse').to.deep.equal([]);
    });
});

// ── Guard 3: no direct ai-service ────────────────────────────────────────────
describe('C19 Structure Analyzer boundary: LLM seam', () => {
    forAllAnalyzers(it, 'never imports ai-service (LLM access is the injected callAI port)', (f) => () => {
        const specs = requireSpecifiers(src(f));
        expect(specs.some((spec) => spec.includes('ai-service')), 'direct ai-service import bypasses the port').to.equal(false);
    });

    it('pipeline-steps.js (host adapter) does not import ai-service either', () => {
        const specs = requireSpecifiers(src(path.join(REPO_ROOT, 'backend/src/services/agent/pipeline-steps.js')));
        expect(specs.some((spec) => spec.includes('ai-service'))).to.equal(false);
    });
});

// ── Guard 4: no direct fetch ─────────────────────────────────────────────────
describe('C19 Structure Analyzer boundary: transport', () => {
    forAllAnalyzers(it, 'contains no direct fetch()', (f) => () => {
        expect(src(f), 'HTTP transport stays behind the callAI port').to.not.match(/\bfetch\s*\(/);
    });
});

// ── Guard 5: no Character/Location/Scene analyzer dependency ─────────────────
describe('C19 Structure Analyzer boundary: sibling analyzers', () => {
    forAllAnalyzers(it, 'never imports pipeline-steps / orchestrator / runner (sibling analyzers)', (f) => () => {
        const specs = requireSpecifiers(src(f));
        const offenders = specs.filter((spec) => /pipeline-steps|parallel-analysis-orchestrator|pipeline-runner|unit-splitter|image-utils|text-utils/.test(spec));
        expect(offenders, 'replacing Structure Analysis must not require sibling analyzer code').to.deep.equal([]);
    });

    it('the analyzer module never writes sibling output fields (mentions/voice/image/video/passport)', () => {
        for (const f of ANALYZER_FILES) {
            const s = src(f);
            for (const genWrite of ['.image =', '.video =', 'mentions:', '.voice', 'passport']) {
                expect(s, `${rel(f)} must not produce ${genWrite} (sibling analyzer output)`).to.not.include(genWrite);
            }
        }
    });
});

// ── Guard 6: no parser → analyzer reverse dependency ─────────────────────────
describe('C19 Structure Analyzer boundary: Parser independence', () => {
    it('@animastor/parser never requires the Structure Analyzer or the adapter', () => {
        const parserSrc = path.join(REPO_ROOT, 'packages', 'animastor-parser', 'src');
        const offenders = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.js')) continue;
                const specs = requireSpecifiers(src(full));
                if (specs.some((spec) => /structure-analyzer|structure-detector|pipeline-steps|ai-caller|ai-service/.test(spec))) {
                    offenders.push(rel(full));
                }
            }
        })(parserSrc);
        expect(offenders, 'the parser consumes the detector only through the injected port').to.deep.equal([]);
    });

    it('the deterministic adapter stays pure (zero requires) — no AI-module import', () => {
        expect(requireSpecifiers(src(PARSER_ADAPTER)), 'the Parser adapter must stay pure').to.deep.equal([]);
    });

    it('the composition root binds the adapter into @animastor/parser (setStructureDetector)', () => {
        const s = src(COMPOSITION_ROOT);
        expect(s).to.match(/setStructureDetector\(require\('\.\/services\/structure-detector'\)\)/);
    });
});

// ── Guard 7: host capabilities enter only through ports ──────────────────────
describe('C19 Structure Analyzer boundary: host ports', () => {
    forAllAnalyzers(it, 'never imports PG/Redis/SSE/fs infrastructure', (f) => () => {
        const specs = requireSpecifiers(src(f));
        const offenders = specs.filter((spec) => /storage\/postgres|agent-session|layer-config|redis|node-slack|workspace-ai-provider|runtime-config|ai-loader|fs['"]|lazy-book/.test(spec));
        expect(offenders, 'session/log/prompt/provider capabilities must be host-injected ports').to.deep.equal([]);
    });

    it('analyzeBookStructure requires the port object (fail-closed when ports are missing)', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/services/structure-analyzer/index.js'));
        expect(s).to.match(/missing host port/);
        expect(s).to.match(/ports\.callAI|_ports\.callAI|callAI, logConversation/);
    });

    it('pipeline-steps.js passes the host ports explicitly (composition adapter)', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/services/agent/pipeline-steps.js'));
        for (const port of ['callAI: aiCaller.callAI', 'logConversation: aiCaller.logConversation', 'updateSession', 'createStep', 'completeStep', 'failStep', 'prompt:', 'fillLang']) {
            expect(s, `host adapter must inject the ${port} port`).to.include(port);
        }
    });
});

// ── Guard 8: barrel is re-export-only (no hidden duplicate) ──────────────────
describe('C19 Structure Analyzer boundary: compatibility barrel', () => {
    it('structure-detector.js re-exports both halves and defines no functions of its own', () => {
        const s = src(BARREL);
        expect(requireSpecifiers(s)).to.include('./structure-detector-deterministic');
        expect(requireSpecifiers(s)).to.include('./structure-analyzer');
        const fnDefs = [...s.matchAll(/\b(?:async\s+)?function\s+(\w+)\s*\(/g)].map((m) => m[1]);
        expect(fnDefs, 'the barrel must contain zero local function implementations').to.deep.equal([]);
    });

    it('no duplicate AI-merge implementation escaped into other host files', () => {
        for (const f of [PARSER_ADAPTER]) {
            const s = src(f);
            for (const fn of ['mergeAiDecisions', 'sanitizeStructure']) {
                expect(s, `${fn} must live only in structure-analyzer/ai-merge.js (C19 physical home)`).to.not.match(new RegExp(`function ${fn}\\b`));
            }
        }
    });

    it('the module exports the frozen C19 contract (analyzeBookStructure + AI-merge seam)', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/services/structure-analyzer/index.js'));
        for (const name of ['analyzeBookStructure', 'analyzeStructure', 'mergeAiDecisions', 'sanitizeStructure', 'extractCandidates', 'buildDeterministicMap', 'mapToStructureChapters']) {
            expect(s, `structure-analyzer must export ${name}`).to.match(new RegExp(`\\b${name}\\b`));
        }
    });

    it('bootstrap + pipeline-steps reach the analyzer through the new seam (no old inline logic)', () => {
        const steps = src(path.join(REPO_ROOT, 'backend/src/services/agent/pipeline-steps.js'));
        expect(steps).to.match(/structure-analyzer/);
        expect(steps).to.match(/analyzeBookStructure/);
        const bootstrap = src(path.join(REPO_ROOT, 'backend/src/services/agent/bootstrap.js'));
        expect(bootstrap).to.match(/structure-analyzer/);
        expect(bootstrap, 'bootstrap must not build the structure prompt inline anymore').to.not.match(/Analyze the structure of this text/);
    });
});
