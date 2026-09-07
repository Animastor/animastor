// ======================================================
// ComfyUI Workflow Connector core — extraction boundary guard
// ======================================================
// Freezes the boundary of the future animastor-comfyui-workflow-connector
// module (docs/architecture/COMFYUI_WORKFLOW_CONNECTOR_EXTRACTION_READINESS.md):
//
//   CB-T1 — core purity: src/workflows/{workflow-loader,connector-loader,
//           entity-schema,connector-api}.js depend only on node builtins
//           and each other (no host imports).
//   CB-T2 — the connector core is consumed ONLY through its documented
//           import set; new consumers must be registered consciously
//           (baseline = extraction migration list).
//   CB-T3 — the public API surface hides ComfyUI internals: connector-api.js
//           must not re-export raw node-id lookups.

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { REPO_ROOT, BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers, resolveSpecifier } = require('./helpers');

const CORE_DIR = path.join(BACKEND_SRC, 'workflows');
// video-workflows.js is business-side multi-image assembly (host concern);
// it stays OUT of the extraction and out of this guard.
const CORE_FILES = [
    'workflow-loader.js',
    'connector-loader.js',
    'entity-schema.js',
    'connector-api.js',
];

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ── CB-T1 — core purity ──────────────────────────────────────────────────
describe('CB-T1: connector core depends only on node builtins + itself', () => {
    it('core files require nothing outside the core', () => {
        const allowed = new Set([
            './workflow-loader', './connector-loader', './entity-schema', './connector-api',
            'fs', 'path', 'crypto',
        ]);
        const offenders = [];
        for (const f of CORE_FILES) {
            const src = readSource(path.join(CORE_DIR, f));
            for (const spec of requireSpecifiers(src)) {
                if (!allowed.has(spec)) offenders.push(`${rel(path.join(CORE_DIR, f))}: ${spec}`);
            }
        }
        expect(offenders, 'the extraction core must not reach into the host (backend business layer, Redis, GPU dispatch)').to.deep.equal([]);
    });

    it('no backend source file requires INTO the core except the registered consumer set', () => {
        // Baseline = the exact migration list for physical extraction: when
        // the module is extracted, each of these files switches to the
        // package import and its entry is consciously updated here.
        const CONSUMER_BASELINE = [
            'backend/src/audio/connector-utils.js',
            'backend/src/audio/generation.js',
            'backend/src/generation/comfyui-provider.js',
            'backend/src/image/connector-utils.js',
            'backend/src/image/iu-processor.js',
            'backend/src/orchestration/scene-orchestrator.js',
            'backend/src/services/profile-override.js',
            'backend/src/services/workflow-manager.js',
            'backend/src/backend.cjs',
        ];

        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const r = rel(file);
            if (r.startsWith('backend/src/workflows/')) continue; // core itself
            for (const spec of requireSpecifiers(readSource(file))) {
                const target = resolveSpecifier(file, spec);
                if (!target) continue;
                const t = rel(target);
                const isCore =
                    (t.startsWith('backend/src/workflows/') &&
                        CORE_FILES.some((f) => t.endsWith('/' + f))) ||
                    /workflow-loader|connector-loader|entity-schema/.test(spec);
                if (!isCore) continue;
                if (!CONSUMER_BASELINE.includes(r)) offenders.push(`${r}: ${spec}`);
            }
        }
        expect(offenders, 'a new module reached into the connector core — register the consumer consciously (extraction migration list)').to.deep.equal([]);
    });
});

// ── CB-T2 — API surface hides ComfyUI internals ─────────────────────────
describe('CB-T2: the public API surface hides ComfyUI internals', () => {
    it('connector-api.js does not re-export raw node-id / field lookups', () => {
        const src = stripComments(readSource(path.join(CORE_DIR, 'connector-api.js')));
        expect(src).to.not.match(/getNodeId|getGuideBindings/);
        expect(src).to.not.match(/module\.exports[^\n]*applyBinding/);
    });

    it('connector-api.js exposes the minimal public API (factory + typed errors)', () => {
        const src = readSource(path.join(CORE_DIR, 'connector-api.js'));
        expect(src).to.include('createWorkflowConnector');
        expect(src).to.include('listWorkflows');
        expect(src).to.include('getWorkflow');
        expect(src).to.include('getConnector');
        expect(src).to.include('validate');
        expect(src).to.include('build');
        for (const errType of ['WorkflowNotFoundError', 'ConnectorMissingError', 'IncompatibleWorkflowError', 'BuildError']) {
            expect(src, `typed error missing: ${errType}`).to.include(errType);
        }
    });
});
