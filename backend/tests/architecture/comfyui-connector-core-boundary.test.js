// ======================================================
// ComfyUI Workflow Connector core — extraction boundary guard
// ======================================================
// Freezes the boundary of the extracted
// animastor-comfyui-workflow-connector package
// (docs/architecture/COMFYUI_WORKFLOW_CONNECTOR_EXTRACTION_READINESS.md):
//
//   CB-T1 — package purity: packages/animastor-comfyui-workflow-connector/
//           src/{workflow-loader,connector-loader,entity-schema,index}.js
//           depend only on node builtins and each other (no host imports),
//           and the package is consumed ONLY through its documented import
//           set (the frozen consumer baseline = extraction migration list).
//   CB-T2 — the public API surface hides ComfyUI internals: the package
//           index must not re-export raw node-id lookups.

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { REPO_ROOT, BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers, resolveSpecifier } = require('./helpers');

const PKG_DIR = path.join(REPO_ROOT, 'packages', 'animastor-comfyui-workflow-connector');
const PKG_SRC = path.join(PKG_DIR, 'src');
const PKG_NAME = 'animastor-comfyui-workflow-connector';
// video-workflows.js is business-side multi-image assembly (host concern);
// it stays OUT of the package and out of this guard.
const CORE_FILES = [
    'workflow-loader.js',
    'connector-loader.js',
    'entity-schema.js',
    'index.js',
];

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ── CB-T1 — package purity ───────────────────────────────────────────────
describe('CB-T1: connector core depends only on node builtins + itself', () => {
    it('package source files require nothing outside the core', () => {
        const allowed = new Set([
            './workflow-loader', './connector-loader', './entity-schema', './index', './connector-api',
            'fs', 'path', 'crypto',
        ]);
        const offenders = [];
        for (const f of CORE_FILES) {
            const src = readSource(path.join(PKG_SRC, f));
            for (const spec of requireSpecifiers(src)) {
                if (!allowed.has(spec)) offenders.push(`${rel(path.join(PKG_SRC, f))}: ${spec}`);
            }
        }
        expect(offenders, 'the extracted package must not reach into the host (backend business layer, Redis, GPU dispatch)').to.deep.equal([]);
    });

    it('no backend source file requires the old backend/src/workflows core or unregistered package consumers', () => {
        // Baseline = the frozen extraction migration list (§6.2): each of
        // these files consumes the package; new consumers must be
        // registered consciously here.
        //
        // S-3 (provider seam migration) narrowed the consumer set: the
        // media executors and orchestration no longer import the package —
        // workflow/connector access rides generation/comfyui-provider.js:
        //   removed: audio/connector-utils.js, audio/generation.js,
        //            image/connector-utils.js (file deleted),
        //            image/iu-processor.js, orchestration/scene-orchestrator.js,
        //            workflows/video/video-workflows.js
        const CONSUMER_BASELINE = [
            'backend/src/generation/comfyui-provider.js',
            'backend/src/services/profile-override.js',
            'backend/src/services/workflow-manager.js',
            'backend/src/backend.cjs',
        ];

        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const r = rel(file);
            for (const spec of requireSpecifiers(readSource(file))) {
                // Old core location must be gone from production imports.
                const target = resolveSpecifier(file, spec);
                if (target) {
                    const t = rel(target);
                    if (t.startsWith('backend/src/workflows/') &&
                        CORE_FILES.some((f) => t.endsWith('/' + f))) {
                        offenders.push(`${r}: ${spec} (stale backend/src/workflows import)`);
                        continue;
                    }
                }
                // Package specifier consumers must be registered.
                if (spec === PKG_NAME) {
                    if (!CONSUMER_BASELINE.includes(r)) offenders.push(`${r}: ${spec}`);
                }
            }
        }
        expect(offenders, 'a stale workflows import or a new unregistered package consumer was found — register the consumer consciously (extraction migration list)').to.deep.equal([]);
    });
});

// ── CB-T2 — API surface hides ComfyUI internals ─────────────────────────
describe('CB-T2: the public API surface hides ComfyUI internals', () => {
    it('the package index does not re-export raw node-id / field lookups', () => {
        const src = stripComments(readSource(path.join(PKG_SRC, 'index.js')));
        expect(src).to.not.match(/getNodeId|getGuideBindings/);
        expect(src).to.not.match(/module\.exports[^\n]*applyBinding/);
    });

    it('the package index exposes the minimal public API (factory + typed errors)', () => {
        const src = readSource(path.join(PKG_SRC, 'index.js'));
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
