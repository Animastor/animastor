// ======================================================
// Connector core — package-owned test suite (extraction readiness)
// ======================================================
// Proves the workflow/connector core works standalone: loading, entity
// schema, validation, hashing, compatibility, binding application, build —
// with ZERO DB / Redis / GPU Hub / business dependencies. Directories and
// logger are dependency-injected; assets are local fixtures.
//
// This suite is the seed of the future
// animastor-comfyui-workflow-connector package test suite: after physical
// extraction it must pass UNCHANGED (only import paths + fixture dir move).
const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const FIXTURES = path.join(__dirname, 'fixtures');
const WF_DIR = path.join(FIXTURES, 'workflows');
const CONN_DIR = path.join(FIXTURES, 'connectors');
const HOST_WF_DIR = path.resolve(__dirname, '../../ai/workflows');
const HOST_CONN_DIR = path.resolve(__dirname, '../../ai/connectors');
const workflowLoader = require('../../src/workflows/workflow-loader');
const connectorLoader = require('../../src/workflows/connector-loader');
const entitySchema = require('../../src/workflows/entity-schema');
const connectorApi = require('../../src/workflows/connector-api');
const noopLogger = { log() {}, warn() {}, error() {} };
/**
 * The mapping core is a process-wide singleton registry. Fixture-based
 * tests use INJECTED dirs; a root-level after() restores the real asset
 * dirs + registry so the host-owned suites (audio-profile,
 * profile-override, …) keep passing when the whole backend suite runs.
 */
function useFixtures() {
    workflowLoader.configure({ workflowsDir: WF_DIR, logger: noopLogger });
    connectorLoader.configure({ connectorsDir: CONN_DIR, logger: noopLogger });
}
after(function restoreHostState() {
    workflowLoader.configure({ workflowsDir: HOST_WF_DIR, logger: console });
    connectorLoader.configure({ connectorsDir: HOST_CONN_DIR, logger: console });
    try { workflowLoader.loadWorkflows(); } catch (err) { /* host state is host suites' concern */ }
});

/** Strip comments so textual assertions judge code, not prose. */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
// ─── T1 — workflow loading ──────────────────────────
describe('connector core: workflow loading (injected dirs)', () => {
    before(useFixtures);
    it('loads workflows from the injected directory (ignores old_* files)', () => {
        const loaded = workflowLoader.loadWorkflows();
        expect(Object.keys(loaded)).to.include('minimal-wf', 'multi-wf');
        expect(Object.keys(loaded).filter((n) => n.startsWith('old_'))).to.deep.equal([]);
    });
    it('getWorkflow returns a deep clone (callers cannot mutate the registry)', () => {
        const a = workflowLoader.getWorkflow('minimal-wf');
        a['1'].inputs.text = 'MUTATED';
        const b = workflowLoader.getWorkflow('minimal-wf');
        expect(b['1'].inputs.text).to.not.equal('MUTATED');
    });
    it('getWorkflow throws for a missing workflow', () => {
        expect(() => workflowLoader.getWorkflow('no-such-workflow')).to.throw(/Workflow not found/);
    });
});
// ─── T2 — connector loading + registration ──────────
describe('connector core: connector loading (injected dirs)', () => {
    before(useFixtures);
    it('registers connectors keyed by workflow name', () => {
        connectorLoader.loadConnectors();
        const byWorkflow = connectorLoader.getConnector('minimal-wf');
        expect(byWorkflow).to.exist;
        expect(byWorkflow.type).to.equal('image');
        expect(connectorLoader.getConnectorByName('conn-minimal-wf')).to.exist;
    });
    it('collects validation errors for a malformed connector (missing nodeId, unknown entityType)', () => {
        connectorLoader.loadConnectors();
        const malformed = connectorLoader.getConnectorByName('conn-malformed');
        expect(malformed).to.exist; // loaded, but flagged
        const errors = connectorLoader.validateConnector(malformed, 'conn-malformed');
        expect(errors.some((e) => e.includes('missing nodeId'))).to.be.true;
        expect(errors.some((e) => e.includes('unknown entityType'))).to.be.true;
    });
    it('getConnector returns null for a workflow without a connector', () => {
        connectorLoader.loadConnectors();
        expect(connectorLoader.getConnector('orphan-wf')).to.be.null;
    });
});
// ─── T3 — entity schema ─────────────────────────────
describe('connector core: entity schema', () => {
    it('resolves canonical entity keys', () => {
        expect(entitySchema.getEntity('positivePrompt')).to.exist;
        expect(entitySchema.getEntity('positivePrompt').type).to.equal('string');
        expect(entitySchema.getEntity('sourceImages').type).to.equal('image[]');
    });
    it('returns undefined for unknown entity keys', () => {
        expect(entitySchema.getEntity('notAnEntity')).to.be.undefined;
    });
    it('exposes inputs, outputs and parameters as separate kinds', () => {
        const kinds = ['input', 'output', 'parameter'].map((k) => entitySchema.getEntitiesByKind(k).length);
        expect(kinds.every((n) => n > 0)).to.be.true;
    });
});
// ─── T4 — workflow hash ─────────────────────────────
describe('connector core: workflow hash', () => {
    const { computeWorkflowHash } = connectorLoader;
    it('is deterministic regardless of key order', () => {
        const a = { x: 1, y: { b: 2, a: 1 } };
        const b = { y: { a: 1, b: 2 }, x: 1 };
        expect(computeWorkflowHash(a)).to.equal(computeWorkflowHash(b));
    });
    it('is content-sensitive at EVERY nesting level (node contents matter)', () => {
        const a = { '1': { class_type: 'KSampler', inputs: { seed: 1 } } };
        const b = { '1': { class_type: 'KSampler', inputs: { seed: 2 } } };
        expect(computeWorkflowHash(a)).to.not.equal(computeWorkflowHash(b));
    });
    it('changes when a node is added or removed', () => {
        const a = { '1': { class_type: 'A' } };
        const b = { '1': { class_type: 'A' }, '2': { class_type: 'B' } };
        expect(computeWorkflowHash(a)).to.not.equal(computeWorkflowHash(b));
    });
    it('matches the hash computed at workflow load time', () => {
        const loaded = workflowLoader.getWorkflow('minimal-wf');
        expect(workflowLoader.getWorkflowHash('minimal-wf')).to.equal(computeWorkflowHash(loaded));
    });
});
// ─── T5 — compatibility check ───────────────────────
describe('connector core: compatibility check', () => {
    before(useFixtures);
    it('passes for a matching workflow/connector pair', () => {
        const wf = workflowLoader.getWorkflow('minimal-wf');
        const connector = connectorLoader.getConnector('minimal-wf');
        const result = connectorLoader.checkCompatibility(connector, wf);
        expect(result.compatible).to.be.true;
        expect(result.warnings).to.deep.equal([]);
    });
    it('fails when a bound node is missing from the workflow', () => {
        const wf = workflowLoader.getWorkflow('minimal-wf');
        delete wf['1'];
        const connector = connectorLoader.getConnector('minimal-wf');
        const result = connectorLoader.checkCompatibility(connector, wf);
        expect(result.compatible).to.be.false;
        expect(result.warnings.join(' ')).to.match(/not found in workflow/);
    });
    it('fails when a node class drifts (workflow structure change)', () => {
        const wf = workflowLoader.getWorkflow('minimal-wf');
        wf['1'].class_type = 'SomeOtherNode';
        const connector = connectorLoader.getConnector('minimal-wf');
        const result = connectorLoader.checkCompatibility(connector, wf);
        expect(result.compatible).to.be.false;
        expect(result.warnings.join(' ')).to.match(/class mismatch|expects/);
    });
});
// ─── T6 — binding / value application ───────────────
describe('connector core: binding application', () => {
    it('setValue writes the value at the mapped node/field path', () => {
        const wf = workflowLoader.getWorkflow('minimal-wf');
        const connector = connectorLoader.getConnector('minimal-wf');
        const ok = connectorLoader.setValue(wf, connector, 'positivePrompt', 'hello world');
        expect(ok).to.be.true;
        expect(wf['1'].inputs.text).to.equal('hello world');
    });
    it('setValue supports dotted field paths', () => {
        const wf = workflowLoader.getWorkflow('minimal-wf');
        const connector = connectorLoader.getConnector('minimal-wf');
        connectorLoader.setValue(wf, connector, 'seed', 7);
        expect(wf['2'].inputs.seed).to.equal(7);
    });
    it('setValue returns false for an unknown entity key', () => {
        const wf = workflowLoader.getWorkflow('minimal-wf');
        const connector = connectorLoader.getConnector('minimal-wf');
        expect(connectorLoader.setValue(wf, connector, 'notMapped', 'x')).to.be.false;
    });
    it('multi-bindings fan an array value out across sub-bindings', () => {
        const wf = workflowLoader.getWorkflow('multi-wf');
        const connector = connectorLoader.getConnector('multi-wf');
        const ok = connectorLoader.setValue(wf, connector, 'sourceImages', ['img-a.png', 'img-b.png']);
        expect(ok).to.be.true;
        expect(wf['11'].inputs.image_1).to.equal('img-a.png');
        expect(wf['12'].inputs.image_2).to.equal('img-b.png');
    });
});
// ─── T7 — public API (the future module surface) ────
describe('connector core: public API (createWorkflowConnector)', () => {
    let api;
    before(useFixtures);
    before(() => { api = connectorApi.createWorkflowConnector({ logger: noopLogger }); });
    it('listWorkflows() reports entity-level metadata without node ids', () => {
        const list = api.listWorkflows();
        const entry = list.find((w) => w.name === 'minimal-wf');
        expect(entry).to.exist;
        expect(entry.hasConnector).to.be.true;
        expect(entry.compatible).to.be.true;
        expect(entry.hash).to.be.a('string').with.lengthOf(64);
        expect(JSON.stringify(list)).to.not.match(/"nodeId"/);
    });
    it('getWorkflow() returns a deep clone', () => {
        const wf = api.getWorkflow('minimal-wf');
        expect(wf['1'].class_type).to.equal('TestInputNode');
        wf['1'].inputs.text = 'mutated';
        expect(api.getWorkflow('minimal-wf')['1'].inputs.text).to.not.equal('mutated');
    });
    it('getWorkflow() throws the typed error for unknown workflows', () => {
        expect(() => api.getWorkflow('nope')).to.throw(connectorApi.WorkflowNotFoundError);
        try {
            api.getWorkflow('nope');
        } catch (err) {
            expect(err.code).to.equal('WORKFLOW_NOT_FOUND');
        }
    });
    it('getConnector() returns an entity-level VIEW without ComfyUI internals', () => {
        const view = api.getConnector('minimal-wf');
        expect(view.type).to.equal('image');
        expect(Object.keys(view.inputs)).to.deep.equal(['positivePrompt']);
        expect(Object.keys(view.parameters)).to.include('seed', 'steps');
        const raw = JSON.stringify(view);
        expect(raw).to.not.match(/"nodeId"|"field"|class_type|TestInputNode/);
    });
    it('getConnector() throws ConnectorMissingError when no connector exists', () => {
        expect(() => api.getConnector('orphan-wf')).to.throw(connectorApi.ConnectorMissingError);
    });
    it('validate() returns { compatible, warnings } for a good pair', () => {
        const result = api.validate('minimal-wf');
        expect(result.compatible).to.be.true;
        expect(result.warnings).to.deep.equal([]);
    });
    it('build() applies inputs + parameter defaults and hides node ids', () => {
        const { workflowJson, workflowHash } = api.build({
            workflow: 'minimal-wf',
            inputs: { positivePrompt: 'A castle at dawn' },
            parameters: { steps: 30 },
        });
        expect(workflowJson['1'].inputs.text).to.equal('A castle at dawn');
        expect(workflowJson['2'].inputs.frames).to.equal(30); // explicit
        expect(workflowJson['2'].inputs.seed).to.equal(42);   // connector default
        expect(workflowHash).to.equal(api.getWorkflowHash('minimal-wf'));
    });
    it('build() is deterministic: same inputs → same workflow JSON', () => {
        const r1 = api.build({ workflow: 'minimal-wf', inputs: { positivePrompt: 'x' } });
        const r2 = api.build({ workflow: 'minimal-wf', inputs: { positivePrompt: 'x' } });
        expect(r1.workflowJson).to.deep.equal(r2.workflowJson);
        expect(r1.workflowHash).to.equal(r2.workflowHash);
    });
    it('build() rejects unknown input/parameter keys (node ids must not leak in)', () => {
        expect(() => api.build({ workflow: 'minimal-wf', inputs: { '1': 'sneaky node id' } }))
            .to.throw(connectorApi.BuildError);
        expect(() => api.build({ workflow: 'minimal-wf', parameters: { node_9: 'x' } }))
            .to.throw(connectorApi.BuildError);
    });
    it('build() throws WorkflowNotFoundError for a missing workflow', () => {
        expect(() => api.build({ workflow: 'nope' })).to.throw(connectorApi.WorkflowNotFoundError);
    });
    it('build() throws ConnectorMissingError for a workflow without a connector', () => {
        workflowLoader.loadWorkflows();
        const wfMap = workflowLoader.workflows;
        wfMap['orphan-wf'] = { '1': { class_type: 'X', inputs: {} } };
        try {
            expect(() => api.build({ workflow: 'orphan-wf' })).to.throw(connectorApi.ConnectorMissingError);
        } finally {
            delete wfMap['orphan-wf'];
        }
    });
});
// ─── T8 — fail-closed: missing connector for a loaded workflow ──
describe('connector core: fail-closed loading semantics', () => {
    const orphanDir = path.join(FIXTURES, 'orphan-workflows');
    const orphanConn = path.join(FIXTURES, 'orphan-connectors');
    before(() => {
        fs.mkdirSync(orphanDir, { recursive: true });
        fs.mkdirSync(orphanConn, { recursive: true });
        fs.writeFileSync(path.join(orphanDir, 'orphan-wf.json'),
            JSON.stringify({ '1': { class_type: 'X', inputs: {} } }));
        // no conn-orphan-wf.json on purpose
        workflowLoader.configure({ workflowsDir: orphanDir, logger: noopLogger });
        connectorLoader.configure({ connectorsDir: orphanConn, logger: noopLogger });
    });
    after(() => {
        fs.rmSync(orphanDir, { recursive: true, force: true });
        fs.rmSync(orphanConn, { recursive: true, force: true });
        workflowLoader.configure({ workflowsDir: HOST_WF_DIR, logger: console });
        connectorLoader.configure({ connectorsDir: HOST_CONN_DIR, logger: console });
        try { workflowLoader.loadWorkflows(); } catch (err) { /* root after() restores too */ }
    });
    it('loadWorkflows() throws when a workflow has no connector (host startup contract)', () => {
        expect(() => workflowLoader.loadWorkflows()).to.throw(/Missing connectors for workflows: orphan-wf/);
    });
});
// ─── T9 — core purity: no host dependencies ─────────
describe('connector core: standalone purity', () => {
    it('the mapping trio + API require only node builtins and each other', () => {
        const coreDir = path.resolve(__dirname, '../../src/workflows');
        const coreFiles = ['workflow-loader.js', 'connector-loader.js', 'entity-schema.js', 'connector-api.js'];
        const allowed = new Set([
            './workflow-loader', './connector-loader', './entity-schema', './connector-api',
            'fs', 'path', 'crypto',
        ]);
        const offenders = [];
        for (const f of coreFiles) {
            const src = fs.readFileSync(path.join(coreDir, f), 'utf8');
            const re = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
            let m;
            while ((m = re.exec(src)) !== null) {
                if (!allowed.has(m[2])) offenders.push(`${f}: ${m[2]}`);
            }
        }
        expect(offenders, 'the connector core must not reach into the host').to.deep.equal([]);
    });
    it('the core loads and runs with no DB, Redis or GPU Hub modules touched', () => {
        // If any host module were required by the core, this would have
        // blown up long before this assertion — the fixture-based suite
        // above IS the proof. This assertion pins the contract textually.
        const apiSrc = stripComments(
            fs.readFileSync(path.resolve(__dirname, '../../src/workflows/connector-api.js'), 'utf8')
        );
        expect(apiSrc).to.not.match(/redis|gpu-dispatcher|postgres|require\(['"]pg|job-schema|sendUnified|dispatch/i);
    });
});
