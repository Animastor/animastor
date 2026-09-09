// ======================================================
// CHARACTER ANALYZER EXTRACTION — C20 architecture guard
// ======================================================
// Freezes the physical boundary created by
// docs/architecture/character-analyzer-extraction-c20.md:
//
//   1. The Character Analyzer module does not call the Book Writer.
//   2. The Character Analyzer module does not import the Importer.
//   3. The Character Analyzer module does not reach ai-service directly
//      (the LLM seam is the injected callAI port → ai-caller).
//   4. The Character Analyzer module contains no direct fetch.
//   5. The Character Analyzer module does not depend on the sibling
//      analyzers (Structure / Location / Scene) or the pipeline files —
//      NO Character → Location/Scene reverse dependency, no hidden import
//      of the old mega-pipeline.
//   6. The Character Analyzer module performs no persistence (no PG/Redis/
//      fs) — host capabilities enter only through the port object
//      (fail-closed on missing ports; adapter wiring pinned).
//   7. The shared identity/merge implementation is NOT duplicated: the
//      module never re-implements mergeCharacterLists; the runner keeps
//      consuming @animastor/vbook-runtime/character-identity.
//   8. No import cycles involving the module (C18 DAG guard covers the
//      contour; here we pin that the module's only requires are ./voices
//      and the shared vbook-runtime identity predicate).
//   9. The module exports the frozen C20 contract (extractCharacters +
//      generateVoices); host adapters route through the module seam.
//
// Pure static source scans — no runtime imports of the scanned code.

const { expect } = require('chai');
const path = require('path');
const { REPO_ROOT, readSource, rel, requireSpecifiers } = require('./helpers');

// ── C20 Character Analyzer module file set ──────────────────────────────────
const ANALYZER_FILES = [
    'packages/animastor-ai-analysis/src/tasks/character-analyzer/index.js',
    'packages/animastor-ai-analysis/src/tasks/character-analyzer/voices.js',
].map(f => path.join(REPO_ROOT, f));

const STEPS = path.join(REPO_ROOT, 'backend/src/services/agent/pipeline-steps.js');
const RUNNER = path.join(REPO_ROOT, 'backend/src/services/agent/pipeline-runner.js');

const src = (f) => readSource(f);

const forAllAnalyzers = (it, name, fn) => {
    for (const f of ANALYZER_FILES) it(`${rel(f)} ${name}`, fn(f));
};

// ── Guard 1: no Book Writer ──────────────────────────────────────────────────
describe('C20 Character Analyzer boundary: Book Writer', () => {
    const WRITER_OPS = [/createFromAnalysis/, /appendToBook/, /createDraftBook/, /updateBookState/, /writeFileSync/, /lazyBook/];
    forAllAnalyzers(it, 'never calls the Book Writer', (f) => () => {
        const s = src(f);
        const hits = WRITER_OPS.filter((re) => re.test(s)).map(String);
        expect(hits, 'Book Writer calls are host-only (agent/bootstrap.js)').to.deep.equal([]);
    });
});

// ── Guard 2: no Importer ─────────────────────────────────────────────────────
describe('C20 Character Analyzer boundary: Importer', () => {
    forAllAnalyzers(it, 'never requires the Importer (txt-importer / agent-service)', (f) => () => {
        const specs = requireSpecifiers(src(f));
        const offenders = specs.filter((spec) => /txt-importer|agent-service/.test(spec));
        expect(offenders, 'the Importer calls the analyzer, never the reverse').to.deep.equal([]);
    });
});

// ── Guard 3: no direct ai-service / SDK ──────────────────────────────────────
describe('C20 Character Analyzer boundary: LLM seam', () => {
    forAllAnalyzers(it, 'never imports ai-service or an AI SDK (LLM access is the injected callAI port)', (f) => () => {
        const specs = requireSpecifiers(src(f));
        const offenders = specs.filter((spec) => /ai-service|openai|anthropic/.test(spec));
        expect(offenders, 'direct ai-service/SDK import bypasses the port').to.deep.equal([]);
    });

    forAllAnalyzers(it, 'contains no direct fetch()', (f) => () => {
        expect(src(f), 'HTTP transport stays behind the callAI port').to.not.match(/\bfetch\s*\(/);
    });
});

// ── Guard 4: no sibling-analyzer / mega-pipeline reverse dependency ──────────
describe('C20 Character Analyzer boundary: sibling analyzers', () => {
    forAllAnalyzers(it, 'never imports pipeline-steps / runner / orchestrator / Structure / Location / Scene analyzer code', (f) => () => {
        const specs = requireSpecifiers(src(f));
        const offenders = specs.filter((spec) => /pipeline-steps|pipeline-runner|parallel-analysis-orchestrator|unit-splitter|image-utils|text-utils|structure-analyzer|structure-detector|agent\/bootstrap/.test(spec));
        expect(offenders, 'replacing Character Analysis must not require sibling analyzer or pipeline code').to.deep.equal([]);
    });

    it('the analyzer module never writes sibling output fields (image/video/passport/scene)', () => {
        for (const f of ANALYZER_FILES) {
            const s = src(f);
            for (const genWrite of ['.image', '.video =', 'image:', 'location:', 'participants =']) {
                expect(s, `${rel(f)} must not produce ${genWrite} (sibling analyzer output)`).to.not.include(genWrite);
            }
        }
    });
});

// ── Guard 5: host capabilities enter only through ports ──────────────────────
describe('C20 Character Analyzer boundary: host ports', () => {
    forAllAnalyzers(it, 'never imports PG/Redis/SSE/fs/prompt/profile infrastructure', (f) => () => {
        const specs = requireSpecifiers(src(f));
        const offenders = specs.filter((spec) => /storage\/postgres|agent-session|layer-config|redis|workspace-ai-provider|runtime-config|ai-loader|agent-prompts|prompt-profile-loader|runtime-config|fs['"]|lazy-book/.test(spec));
        expect(offenders, 'session/log/prompt/skill capabilities must be host-injected ports').to.deep.equal([]);
    });

    it('extractCharacters requires the port object (fail-closed when ports are missing)', () => {
        const s = src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src/tasks/character-analyzer/index.js'));
        // C21.3: port validation is delegated to the shared execute() lifecycle
        // (the task's requiredPorts list is the fail-closed contract)
        expect(s).to.match(/requiredPorts/);
        expect(s).to.match(/'callAI', 'logConversation'/);
        expect(s).to.match(/execute\(charactersTask/);
    });

    it('generateVoices requires the port object too (skill injection is a port)', () => {
        const s = src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src/tasks/character-analyzer/voices.js'));
        expect(s).to.match(/missing host port/);
        expect(s).to.match(/buildSkill/);
    });

    it('pipeline-steps.js passes the host ports explicitly (composition adapter)', () => {
        const s = src(STEPS);
        for (const port of ['callAI: aiCaller.callAI', 'logConversation: aiCaller.logConversation', 'updateSession', 'createStep', 'completeStep', 'failStep', 'prompt:', 'fillLang', 'buildSkill: promptProfileLoader.buildSkillSection']) {
            expect(s, `host adapter must inject the ${port} port`).to.include(port);
        }
    });
});

// ── Guard 6: no persistence / registry writes inside the analyzer ────────────
describe('C20 Character Analyzer boundary: persistence ownership', () => {
    // Strip block+line comments so doc headers mentioning "PG/Redis/fs" don't false-positive.
    const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    forAllAnalyzers(it, 'performs no PG/Redis/fs access of its own', (f) => () => {
        const s = codeOnly(src(f));
        for (const op of [/\bpg\b/, /\.query\(/, /\bredis\b/i, /writeFileSync/, /readFileSync/, /appendFileSync/]) {
            expect(s, `${rel(f)} must not touch persistence directly`).to.not.match(op);
        }
    });

    it('the analyzer never writes registries — persistence stays host-side (window_data + Book Writer)', () => {
        const bootstrap = src(path.join(REPO_ROOT, 'backend/src/services/agent/bootstrap.js'));
        expect(bootstrap, 'bootstrap persists all_characters/all_mentions via window_data').to.match(/all_characters/);
        expect(bootstrap, 'bootstrap persists characters via the Book Writer').to.match(/createFromAnalysis/);
    });
});

// ── Guard 7: shared identity/merge implementation is not duplicated ──────────
describe('C20 Character Analyzer boundary: shared merge contract', () => {
    it('the analyzer never re-implements the merge (mergeCharacterLists stays in vbook-runtime)', () => {
        for (const f of ANALYZER_FILES) {
            const s = src(f);
            for (const fn of ['mergeCharacterLists', 'findCanonicalCharacter', 'mergeCharacterData', 'isPlaceholderCharacter']) {
                expect(s, `${fn} must not be re-implemented in ${rel(f)} — shared impl lives in @animastor/vbook-runtime/character-identity`).to.not.match(new RegExp(`function ${fn}\\b`));
            }
        }
    });

    it('the runner keeps applying the shared merge to the analyzer output (merge contract host-owned)', () => {
        const s = src(RUNNER);
        expect(s).to.match(/mergeCharacterLists/);
        expect(s).to.match(/require\('\.\.\/\.\.\/utils\/character-identity'\)/);
    });

    it('the host shim utils/character-identity stays a one-line re-export of the package', () => {
        const s = src(path.join(REPO_ROOT, 'backend/src/utils/character-identity.js'));
        expect(requireSpecifiers(s)).to.deep.equal(['@animastor/vbook-runtime/character-identity']);
    });
});

// ── Guard 8: module dependency surface (no hidden deps, no cycles) ───────────
describe('C20 Character Analyzer boundary: dependency surface', () => {
    it('index.js has no hidden dependencies beyond ./voices + the agent core', () => {
        const specs = requireSpecifiers(src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src/tasks/character-analyzer/index.js')));
        // C21.3: @animastor/ai-agent (execute lifecycle) is the allowed core
        const external = specs.filter((s) => s !== './voices' && s !== '@animastor/ai-agent');
        expect(external, 'index.js must require nothing but ./voices + @animastor/ai-agent').to.deep.equal([]);
    });

    it('voices.js depends only on the shared identity predicate package export', () => {
        const specs = requireSpecifiers(src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src/tasks/character-analyzer/voices.js')));
        expect(specs, 'voices.js must consume character-identity through the package export').to.deep.equal(['@animastor/vbook-runtime/character-identity']);
    });

    it('no import cycle: character-analyzer ↔ pipeline files (module never requires the host back)', () => {
        for (const f of ANALYZER_FILES) {
            const specs = requireSpecifiers(src(f));
            const back = specs.filter((s) => s.startsWith('..'));
            expect(back, `${rel(f)} must not reach back into host agent/services code (cycle)`).to.deep.equal([]);
        }
    });
});

// ── Guard 9: frozen contract exports + host routing ──────────────────────────
describe('C20 Character Analyzer boundary: contract exports', () => {
    it('the module exports the frozen C20 contract (extractCharacters + generateVoices)', () => {
        const s = src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src/tasks/character-analyzer/index.js'));
        for (const name of ['extractCharacters', 'generateVoices']) {
            expect(s, `character-analyzer must export ${name}`).to.match(new RegExp(`\\b${name}\\b`));
        }
    });

    it('voices.js physically owns the F7 voice authoring implementation', () => {
        const s = src(path.join(REPO_ROOT, 'packages/animastor-ai-analysis/src/tasks/character-analyzer/voices.js'));
        expect(s).to.match(/async function generateVoices/);
    });

    it('pipeline-steps.js routes characters + voices through the module seam (no inline AI logic)', () => {
        const s = src(STEPS);
        // C21: the adapters route through the shared ai-agent contour seam,
        // which re-exports the C20 module — the seam, not the module path, is
        // now the host-facing contract.
        expect(s).to.match(/ai-agent/);
        expect(s).to.match(/extractCharacters\(/);
        expect(s).to.match(/generateVoices\(/);
        expect(s, 'no inline characters prompt assembly left in the host adapter').to.not.match(/Extract all characters from this text/);
        expect(s, 'no inline voice prompt assembly left in the host adapter').to.not.match(/generate voice descriptions for characters who have DIALOGUE LINES/);
    });

    it('the analyzer uses the frozen step types (PG CHECK constraint stays satisfied)', () => {
        for (const f of ANALYZER_FILES) {
            const s = src(f);
            const types = [...s.matchAll(/createStep\(\s*input\.sessionId,\s*'([a-z_]+)'/g)].map(m => m[1]);
            expect(types.filter(t => !['analyze_characters', 'generate_voices'].includes(t)), `${rel(f)} must only use the frozen step types`).to.deep.equal([]);
        }
    });
});
