// ======================================================
// PHASE 10J — GPU Hub external cutover preparation guards
// ======================================================
// Phase 10I (audit) established that the standalone repo
// Animastor/animastor-gpu-hub is the future source of truth for the GPU
// Hub, while the monorepo keeps a transitional copy at gpu-hub/ so the
// reference deployment and the monorepo test suites keep working until
// cutover (Phase 10K+). This suite freezes the transitional contract:
//
//   TF1  Transitional fixture status: gpu-hub/ still exists, still builds
//        the deployed image (default compose), and its package identity is
//        @animastor/gpu-hub@0.1.0 (byte-parity with the standalone repo is
//        asserted by extraction audits, not here).
//   TF2  NO runtime code dependency: backend/src must never require into
//        gpu-hub/ — neither by relative path nor via the bare package
//        specifier @animastor/gpu-hub. Backend ↔ Hub coupling stays at the
//        wire contract (HTTP HUB_URL + shared Redis + GPU_HUB_API_KEY).
//   TF3  Deployment parameterization: the compose gpu-hub service carries
//        the image override seam (GPU_HUB_IMAGE) while KEEPING the local
//        build as the default. A future cutover is a config change, not a
//        compose rewrite. No moving tags (:latest).
//   TF4  The five artifact mounts stay frozen (targets and sources) while
//        the fixture exists — re-architecture is a separate decision.
//
// Docs: docs/architecture/PHASE_10I_EXTERNAL_GPU_HUB_INTEGRATION_READINESS_AUDIT.md,
//       docs/architecture/PHASE_10J_GPU_HUB_CUTOVER_PREPARATION_AUDIT.md

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT, BACKEND_SRC, listSourceFiles, readSource, rel, requireSpecifiers } = require('./helpers');

const HUB_DIR = path.join(REPO_ROOT, 'packages', 'animastor-gpu-hub');
const COMPOSE_PATH = path.join(REPO_ROOT, 'docker-compose.yml');

// Bare specifiers that would smuggle hub code into the backend runtime.
const HUB_BARE_SPECIFIERS = [/^@animastor\/gpu-hub/, /^gpu-hub(\/|$)/];

describe('phase10j: transitional fixture status (gpu-hub/)', () => {
    it('gpu-hub/ still exists as the transitional fixture (removal is a Phase 10K decision)', () => {
        expect(fs.existsSync(HUB_DIR), 'gpu-hub/ fixture must exist until the cutover phase').to.be.true;
        const pkg = JSON.parse(fs.readFileSync(path.join(HUB_DIR, 'package.json'), 'utf8'));
        expect(pkg.name).to.equal('@animastor/gpu-hub');
        expect(pkg.version).to.equal('0.1.0');
    });

    it('gpu-hub/ carries no production npm dependencies of the backend (fixture stays isolated)', () => {
        const backendPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'backend', 'package.json'), 'utf8'));
        const deps = { ...(backendPkg.dependencies || {}), ...(backendPkg.devDependencies || {}) };
        expect(Object.keys(deps).filter((k) => k.includes('gpu-hub')),
            'backend must not declare @animastor/gpu-hub as a dependency while the fixture exists').to.deep.equal([]);
    });
});

describe('phase10j: no runtime imports from backend/src into gpu-hub (TF2)', () => {
    it('no backend/src file requires into gpu-hub/ by relative path', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const base = path.resolve(path.dirname(file), spec);
                const normalized = path.relative(REPO_ROOT, base).split(path.sep).join('/');
                if (normalized === 'packages/animastor-gpu-hub' || normalized.startsWith('packages/animastor-gpu-hub/')) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'backend↔hub coupling stays at the wire contract (HTTP + Redis + API key)').to.deep.equal([]);
    });

    it('no backend/src file imports the hub package by bare specifier (incl. build/test-harness runtime code)', () => {
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (HUB_BARE_SPECIFIERS.some((re) => re.test(spec))) {
                    offenders.push(`${rel(file)}: ${spec}`);
                }
            }
        }
        expect(offenders, 'the hub is consumed via HUB_URL HTTP only — never via npm/package code').to.deep.equal([]);
    });

    it('docker/e2e tooling may touch the hub only via docker exec/HTTP (no source requires)', () => {
        const e2eDir = path.join(REPO_ROOT, 'docker', 'e2e');
        if (!fs.existsSync(e2eDir)) return;
        const offenders = [];
        for (const file of listSourceFiles(e2eDir)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (HUB_BARE_SPECIFIERS.some((re) => re.test(spec))) offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders).to.deep.equal([]);
    });
});

describe('phase10j: compose GPU Hub image parameterization (TF3)', () => {
    let hubSection;

    before(() => {
        const compose = fs.readFileSync(COMPOSE_PATH, 'utf8');
        const start = compose.indexOf('  gpu-hub:');
        const end = compose.indexOf('  nginx:');
        expect(start, 'compose must keep the gpu-hub service').to.be.at.least(0);
        hubSection = compose.slice(start, end);
    });

    it('default build stays the local fixture (production NOT yet switched)', () => {
        // Phase 10T.1: build context is now repo root (context: .) for multi-stage
        // artifact bake-in. The Dockerfile path moved to packages/animastor-gpu-hub/.
        expect(hubSection, 'transitional default: build must reference packages/animastor-gpu-hub/Dockerfile').to.include('dockerfile: packages/animastor-gpu-hub/Dockerfile');
    });

    it('image reference is parameterized with a local default (no :latest anywhere)', () => {
        expect(hubSection).to.include('image: ${GPU_HUB_IMAGE:-animastor-gpu-hub:local}');
        expect(hubSection, 'moving tags are forbidden').to.not.match(/:latest/);
    });

    it('GPU_HUB_IMAGE is documented as an opt-in cutover variable in .env.example', () => {
        const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
        expect(envExample).to.include('GPU_HUB_IMAGE=');
        expect(envExample).to.include('NOT active yet');
    });

    it('standalone cutover overlay exists and requires a pinned image (no moving tags)', () => {
        const overlayPath = path.join(REPO_ROOT, 'docker', 'compose', 'overlay-gpu-hub-standalone.yml');
        const overlay = fs.readFileSync(overlayPath, 'utf8');
        expect(overlay).to.include('build: !reset null');
        expect(overlay).to.include('${GPU_HUB_IMAGE:?');
        expect(overlay).to.not.match(/:latest/);
    });
});

describe('phase10j: artifact mounts stay frozen (TF4)', () => {
    it('compose gpu-hub section keeps artifact mount targets', () => {
        const localOverlay = fs.readFileSync(path.join(REPO_ROOT, 'docker/compose/overlay-gpu-hub-local.yml'), 'utf8');
        const frozenTargets = [
            '/app/worker-bundle',
            '/app/workflows',
            '/app/installer-src',
            '/app/install-manifests',
        ];
        for (const t of frozenTargets) {
            expect(localOverlay, `frozen artifact mount target missing: ${t}`).to.include(t);
        }
    });
});
