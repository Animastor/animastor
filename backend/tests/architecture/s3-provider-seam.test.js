// ======================================================
// S-3 — Generation Provider Seam guards (architecture)
// ======================================================
// S-3 closed the internal boundary Generation → GPU/ComfyUI before the
// physical @animastor/generation extraction. The single seam is
// backend/src/generation/comfyui-provider.js:
//
//   Generation media executor (audio / image / video / orchestrator)
//       ↓
//   generation/comfyui-provider  (semantic contract: workflow names,
//                                 entity keys, v2 job spec)
//       ↓
//   animastor-comfyui-workflow-connector + runtime/gpu-dispatcher.sendUnified
//       ↓
//   GPU Hub / Worker (external packages)
//
// Guards:
//   S3-A  Media executors do not import GPU Hub/Worker implementation
//   S3-B  Media executors do not import the ComfyUI connector package
//   S3-C  ComfyUI knowledge (workflow/connector access) lives only in the
//         provider layer (+ registered non-executor consumers)
//   S3-D  Numeric ComfyUI node IDs are absent from Audio/Image/Video
//         orchestration/runtime layers
//   S3-E  No second/duplicate provider seam (image/connector-utils removed,
//         audio/connector-utils carries no ComfyUI knowledge)
//   S3-F  Generation → GPU transport goes through exactly one seam (the
//         gpu-dispatcher require set is frozen)
//   S3-G  GPU Hub/Worker packages are not reached from generation sources
//   S3-H  Job Protocol semantics ride the frozen facade (job-schema), the
//         provider adds no private protocol fields
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md (§S-3)

const { expect } = require('chai');
const path = require('path');
const { readSource, REPO_ROOT, listSourceFiles, requireSpecifiers, resolveSpecifier } = require('./helpers');

const BACKEND_SRC = path.join(REPO_ROOT, 'backend', 'src');
const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/');

// ── the generation media-executor + orchestration contour ───────────────
// Files that BUILD/SEND generation jobs. All ComfyUI/GPU knowledge is
// forbidden here (S3-A/S3-B/S3-D).
const MEDIA_EXECUTORS = [
    'backend/src/audio/generation.js',
    'backend/src/audio/audio-service.js',
    'backend/src/image/iu-processor.js',
    'backend/src/image/image-service.js',
    'backend/src/video/video-service.js',
    'backend/src/workflows/video/video-workflows.js',
    'backend/src/orchestration/scene-orchestrator.js',
];

// S-7: the provider seam is package-owned (packages/animastor-generation).
const PROVIDER_SEAM = 'packages/animastor-generation/src/providers/comfyui-provider.js';

const GENERATION_PKG_SRC = path.join(REPO_ROOT, 'packages', 'animastor-generation', 'src');

function readSrc(relPath) {
    return readSource(path.join(REPO_ROOT, relPath));
}

// ======================================================
// S3-A / S3-B / S3-D — executor-level bans
// ======================================================
describe('architecture: S-3 provider seam (executor bans)', () => {
    it('S3-A: media executors never import GPU Hub/Worker/transport implementation', () => {
        for (const file of MEDIA_EXECUTORS) {
            const src = readSrc(file);
            expect(src, `${file}: no gpu-dispatcher import (provider seam owns transport)`)
                .to.not.match(/require\(\s*['"][^'"]*gpu-dispatcher['"]\s*\)/);
            expect(src, `${file}: no GPU Hub package import`)
                .to.not.match(/require\(\s*['"][^'"]*animastor-gpu-hub['"]\s*\)/);
            expect(src, `${file}: no Worker package import`)
                .to.not.match(/require\(\s*['"][^'"]*animastor-worker['"]\s*\)/);
            expect(src, `${file}: no direct Hub HTTP dispatch`)
                .to.not.match(/HUB_URL/);
        }
    });

    it('S3-B: media executors never import the ComfyUI connector package', () => {
        for (const file of MEDIA_EXECUTORS) {
            const src = readSrc(file);
            expect(src, `${file}: no workflow-connector import`)
                .to.not.match(/require\(\s*['"]animastor-comfyui-workflow-connector['"]\s*\)/);
            expect(src, `${file}: no connector-loader import`)
                .to.not.match(/require\(\s*['"][^'"]*connector-loader['"]\s*\)/);
        }
    });

    it('S3-B/S3-E: the deleted image/connector-utils.js is not resurrected', () => {
        const fs = require('fs');
        const dead = path.join(REPO_ROOT, 'backend', 'src', 'image', 'connector-utils.js');
        expect(fs.existsSync(dead), 'image/connector-utils.js was folded into the provider seam in S-3').to.equal(false);
    });

    it('S3-C: executors depend on the provider seam explicitly', () => {
        // The executors that patch workflow values/dispatch must reference
        // the provider module (the seam is the dependency, not a hidden one).
        for (const file of [
            'backend/src/audio/generation.js',
            'backend/src/image/iu-processor.js',
            'backend/src/orchestration/scene-orchestrator.js',
        ]) {
            // S-7: executors consume the provider through the package root
            expect(readSrc(file), `${file} must require the provider seam`)
                .to.match(/require\(\s*['"]@animastor\/generation['"]\s*\)\.comfyuiProvider/);
        }
    });

    it('S3-D: no numeric ComfyUI node-id literals in the media/orchestration/runtime layers', () => {
        // The known S-3 node-id set (audio merged dialogue + legacy video):
        // 108/71/73/74/80/81/82/83 and 202/203. Scan the executor files plus
        // the runtime/orchestration layers for raw id patch patterns and
        // bare literal usage in workflow patching context.
        const scanTargets = [
            ...MEDIA_EXECUTORS,
            'backend/src/orchestration/orchestrator.js',
            'backend/src/orchestration/scene-callbacks.js',
            'backend/src/runtime/runtime-scheduler.js',
            'backend/src/runtime/dispatch-engine.js',
            'backend/src/runtime/gpu-dispatcher.js',
        ];
        const NODE_ID_RE = /\[\s*['"](108|71|73|74|80|81|82|83|202|203)['"]\s*\]/;
        for (const file of scanTargets) {
            expect(readSrc(file), `${file}: numeric ComfyUI node-id literal`).to.not.match(NODE_ID_RE);
        }
    });

    it('S3-D: no raw workflow-input patching patterns in executors', () => {
        // wfAudio["NN"].inputs / wf["NN"].inputs-style raw patching must not
        // reappear in executors (values flow through provider.applyValue).
        for (const file of MEDIA_EXECUTORS) {
            const src = readSrc(file);
            expect(src, `${file}: raw workflow node patching`).to.not.match(/\w+\[\s*['"]\d+['"]\s*\]\s*\.\s*inputs/);
        }
    });
});

// ======================================================
// S3-C / S3-E — knowledge centralization
// ======================================================
describe('architecture: S-3 provider seam (knowledge centralization)', () => {
    it('S3-C: the connector package is imported ONLY by the provider and registered non-executor consumers', () => {
        const ALLOWED = new Set([
            PROVIDER_SEAM,                              // the seam (workflow JSON + connectors + node ids)
            'backend/src/services/workflow-manager.js', // API/observability surface (outside media contour)
            'backend/src/services/profile-override.js', // user profile-overrides service (outside media contour, S2-E)
            'backend/src/backend.cjs',                  // composition root: startup configure + load
        ]);
        const offenders = [];
        // S-7: scan the host tree AND the package tree (the provider lives
        // in packages/animastor-generation — connector knowledge may appear
        // only there, inside providers/).
        for (const root of [BACKEND_SRC, GENERATION_PKG_SRC]) {
            for (const file of listSourceFiles(root)) {
                const r = rel(file);
                if (ALLOWED.has(r)) continue;
                for (const spec of requireSpecifiers(readSource(file))) {
                    if (spec === 'animastor-comfyui-workflow-connector' || spec.includes('connector-loader')) {
                        offenders.push(`${r}: ${spec}`);
                    }
                }
            }
        }
        expect(offenders, 'ComfyUI connector knowledge leaked outside the provider seam').to.deep.equal([]);
    });

    it('S3-C: the provider seam is the documented single home of the merged-dialogue node knowledge', () => {
        const seam = readSrc(PROVIDER_SEAM);
        // merged-dialogue topology knowledge lives here…
        expect(seam).to.include('MERGED_DIALOGUE_NODE_IDS');
        expect(seam).to.include('assembleMergedDialogueWorkflow');
        // …and exposes a semantic binding API to executors
        expect(seam).to.include('applyValue');
        expect(seam).to.include('profileNameFromConnector');
    });

    it('S3-E: audio/connector-utils.js carries no ComfyUI/provider knowledge', () => {
        const src = readSrc('backend/src/audio/connector-utils.js');
        expect(src).to.not.match(/require\(\s*['"]animastor-comfyui-workflow-connector['"]\s*\)/);
        expect(src).to.not.match(/require\(\s*['"][^'"]*gpu-dispatcher['"]\s*\)/);
        expect(src).to.not.match(/connectorLoader|wfLoader|workflowLoader/);
        // general media utility that legitimately stays local
        expect(src).to.include('isFFmpegAvailable');
    });
});

// ======================================================
// S3-F — single transport seam
// ======================================================
describe('architecture: S-3 provider seam (single dispatch path)', () => {
    // The frozen set of files allowed to require runtime/gpu-dispatcher.
    // S-6 UPDATE: comfyui-provider left the set — the provider consumes the
    // Generation-owned DispatchTransport port (generation/ports/
    // dispatch-transport.js) and the composition root wires the adapter
    // (backend.cjs). Remaining entries are NON-dispatch consumers:
    //   - backend.cjs — composition root (wires the transport adapter)
    //   - services/provider-gateway.js — Phase 3 facade delegation
    //   - runtime/scene-window.js + helpers/redis-helpers.cjs — routing/
    //     availability reads (resolveWorkspaceForBook), not job dispatch —
    //     documented residual (routing policy stays host-side, §24.6)
    const DISPATCH_SEAM_BASELINE = [
        'backend/src/backend.cjs',
        'backend/src/services/provider-gateway.js',
        'backend/src/runtime/scene-window.js',
        'backend/src/helpers/redis-helpers.cjs',
    ];

    it('S3-F: gpu-dispatcher requires match the frozen single-seam baseline', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            const r = rel(file);
            if (DISPATCH_SEAM_BASELINE.includes(r)) continue;
            for (const spec of requireSpecifiers(readSource(file))) {
                const target = resolveSpecifier(file, spec);
                if (target && rel(target) === 'backend/src/runtime/gpu-dispatcher.js') {
                    offenders.push(`${r}: ${spec}`);
                }
            }
        }
        expect(offenders, 'a module bypasses the provider dispatch seam').to.deep.equal([]);
    });

    it('S3-F: the routing/availability consumers never dispatch jobs', () => {
        for (const file of ['backend/src/runtime/scene-window.js', 'backend/src/helpers/redis-helpers.cjs']) {
            const src = readSrc(file);
            expect(src, `${file}: availability reads only, no send/sendUnified calls`)
                .to.not.match(/\.send\(|sendUnified\(/);
            expect(src, `${file}: uses workspace resolution only`)
                .to.match(/resolveWorkspaceForBook/);
        }
    });
});

// ======================================================
// S3-G / S3-H — external boundaries stay untouched
// ======================================================
describe('architecture: S-3 provider seam (external boundaries)', () => {
    it('S3-G: no generation source imports the GPU Hub/Worker packages', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.includes('animastor-gpu-hub') || spec.includes('animastor-worker')) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'GPU Hub/Worker implementation leaked into backend src').to.deep.equal([]);
    });

    it('S3-H: the provider rides the frozen Job Protocol facade (no private protocol fields)', () => {
        const seam = readSrc(PROVIDER_SEAM);
        // S-6 UPDATE: dispatch goes through the DispatchTransport port (the
        // host adapter IS gpu-dispatcher.sendUnified) — no private HTTP
        // calls, no re-stamped protocol version, no private Redis keys
        expect(seam).to.include("require('../ports/dispatch-transport')");
        // S-7: the Job Protocol comes from the frozen contracts package
        // (the backend job-schema facade is its zero-logic re-export)
        expect(seam).to.include("require('@animastor/contracts')");
        expect(seam).to.match(/dispatch\(taskSpec\)/);
        expect(seam).to.not.match(/fetch\(|HUB_URL|protocol_version|animastor:queue|animastor:job/);
        // job-id building rides the frozen @animastor/contracts facade
        expect(seam).to.include('jobSchema.buildJobId');
    });
});
