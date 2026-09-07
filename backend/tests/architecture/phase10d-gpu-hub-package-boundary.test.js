// ======================================================
// PHASE 10D — GPU Hub package boundary guards
// (anchors updated by Phase 10J to the post-10G registry architecture)
// ======================================================
// Phase 10D physically prepared gpu-hub/ as a standalone npm package
// (@animastor/gpu-hub) WITHOUT changing production behavior. Phase 10G then
// migrated the package from the pre-publish `file:../contracts` seam to the
// published registry dependency, and Phase 10H published the repo as
// Animastor/animastor-gpu-hub. These guards freeze the CURRENT boundary:
//
//   PB1  Package identity: @animastor/gpu-hub@0.1.0, MIT, main=server.js.
//   PB2  Manifest dependency set is frozen: express/cors/ioredis runtime +
//        @animastor/contracts ^0.1.0 as a REQUIRED registry dependency
//        (Phase 10G; the file: seam is retired — reintroducing it fails).
//        No devDependencies, no optionalDependencies.
//   PB3  Package-lock.json is in sync with the manifest and resolves
//        @animastor/contracts from the npm registry (integrity pinned,
//        no file: link, no hidden monorepo-root fallback).
//   PB4  npm pack contents are EXACTLY the frozen allowlist (9 files):
//        runtime modules + package files only — no node_modules, backend,
//        worker, frontend, workflows, install manifests, secrets, tests,
//        generated artifacts.
//   PB5  Runtime file set is frozen (gpu-hub.js, server.js, tarball.js,
//        bootstrap.js) — a new runtime file is a boundary decision and
//        must update this guard.
//   PB6  Docker deployment contract intact: Dockerfile present, standalone
//        build (npm install of this package resolves contracts from the
//        registry), EXPOSE 5000, CMD server.js; .dockerignore excludes
//        node_modules/tests. The compose gpu-hub service carries NO
//        contracts mount (a mount would shadow the registry copy —
//        Phase 10B seam retired in 10G).
//   PB7  Contracts resolution: require('@animastor/contracts') from the hub
//        tree resolves to a registry-installed @animastor/contracts@0.1.0
//        copy inside the hub's own node_modules (self-contained install —
//        never the monorepo-root tree). No-fork is enforced by protocol
//        parity (PROTOCOL_VERSION === monorepo canonical === 2), not by
//        realpath.
//
// Docs: docs/architecture/PHASE_10D_GPU_HUB_PACKAGE_EXTRACTION_AUDIT.md,
//       docs/architecture/PHASE_10G_GPU_HUB_REGISTRY_MIGRATION.md

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { REPO_ROOT } = require('./helpers');

const HUB_DIR = path.join(REPO_ROOT, 'packages', 'animastor-gpu-hub');
const PKG_JSON = path.join(HUB_DIR, 'package.json');
const PKG_LOCK = path.join(HUB_DIR, 'package-lock.json');

// Frozen npm-pack allowlist (Phase 10D).
const FROZEN_PACK_FILES = [
    '.dockerignore',
    'Dockerfile',
    'LICENSE',
    'README.md',
    'bootstrap.js',
    'gpu-hub.js',
    'package.json',
    'server.js',
    'tarball.js',
].sort();

// Frozen runtime surface (Phase 10D PB5).
const FROZEN_RUNTIME_FILES = ['gpu-hub.js', 'server.js', 'tarball.js', 'bootstrap.js'].sort();

// ── PB1/PB2 — manifest identity + frozen dependency set ─────────────────

describe('phase10d: GPU Hub package identity', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));

    it('package is @animastor/gpu-hub@0.1.0 with MIT license', () => {
        expect(pkg.name, 'package name (Phase 10D identity)').to.equal('@animastor/gpu-hub');
        expect(pkg.version).to.equal('0.1.0');
        expect(pkg.license).to.equal('MIT');
        expect(pkg.main).to.equal('server.js');
    });

    it('manifest declares exactly the frozen dependency set (express/cors/ioredis + REQUIRED canonical contracts)', () => {
        // Phase 10G: contracts is a REQUIRED registry dependency — the
        // pre-publish file:/optional seam is retired. Reintroducing a file:
        // or optional form must fail (it would reintroduce a monorepo
        // coupling into a published package).
        expect(Object.keys(pkg.dependencies).sort()).to.deep.equal(
            ['@animastor/contracts', 'cors', 'express', 'ioredis'],
        );
        expect(pkg.dependencies['@animastor/contracts'], 'contracts stays the canonical registry dependency').to.equal('^0.1.0');
        expect(pkg.optionalDependencies, 'the file: seam must NOT return').to.be.undefined;
        expect(pkg.devDependencies, 'devDependencies would widen the boundary').to.be.undefined;
    });

    it('package stays runtime-only (tests excluded from pack surface)', () => {
        expect(pkg.files).to.include.members(['gpu-hub.js', 'server.js', 'tarball.js', 'bootstrap.js']);
        expect(pkg.files).to.not.include('tests');
    });
});

// ── PB3 — lockfile sync + contracts link ────────────────────────────────

describe('phase10d: GPU Hub lockfile + contracts dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
    const lock = JSON.parse(fs.readFileSync(PKG_LOCK, 'utf8'));

    it('package-lock.json is in sync with the manifest identity', () => {
        expect(lock.name).to.equal(pkg.name);
        expect(lock.version).to.equal(pkg.version);
        expect(lock.lockfileVersion).to.equal(3);
    });

    it('lockfile resolves @animastor/contracts from the npm registry (integrity-pinned, no file: seam, no monorepo-root fallback)', () => {
        expect(lock.packages['']).to.exist;
        expect(lock.packages[''].dependencies).to.include({ '@animastor/contracts': '^0.1.0' });
        const entry = lock.packages['node_modules/@animastor/contracts'];
        expect(entry, 'contracts must be a resolved lockfile entry').to.exist;
        expect(entry.resolved, 'registry resolution (Phase 10G)').to.equal('https://registry.npmjs.org/@animastor/contracts/-/contracts-0.1.0.tgz');
        expect(entry.integrity, 'integrity hash must be pinned').to.be.a('string').and.include('sha512-');
    });

    it('hub-local node_modules link to contracts exists (installed tree resolves without monorepo root)', () => {
        const link = path.join(HUB_DIR, 'node_modules', '@animastor', 'contracts');
        // Only enforced when the tree is installed (npm ci); guards run in
        // repos where the hub install has been performed.
        if (fs.existsSync(path.join(HUB_DIR, 'node_modules'))) {
            expect(fs.existsSync(link), 'run `npm ci` in gpu-hub/ — @animastor/contracts link missing').to.be.true;
        }
    });
});

// ── PB4 — npm pack surface ──────────────────────────────────────────────

describe('phase10d: npm pack surface', function () {
    // npm spawn is slow on cold caches — give it room, but stay bounded.
    this.timeout(120000);

    let packed;

    before(() => {
        const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
            cwd: HUB_DIR,
            encoding: 'utf8',
            timeout: 110000,
        });
        expect(res.status, `npm pack --dry-run failed: ${res.stderr}`).to.equal(0);
        const parsed = JSON.parse(res.stdout);
        packed = Array.isArray(parsed) ? parsed[0] : parsed;
    });

    it('tarball contains EXACTLY the frozen 9-file allowlist (additions and removals both fail)', () => {
        const files = packed.files.map((f) => f.path).sort();
        expect(files, 'package surface changed — update gpu-hub/package.json "files" AND this guard in the same commit').to.deep.equal(FROZEN_PACK_FILES);
    });

    it('tarball carries no junk (node_modules, tests, backend/worker artifacts, secrets)', () => {
        const files = packed.files.map((f) => f.path);
        const banned = [/node_modules/, /^tests\//, /backend/, /worker(?!-bundle)/, /frontends?/, /workflows/, /install-manifests/, /\.env/, /secret/i, /package-lock/, /\.tgz$/];
        const offenders = files.filter((f) => banned.some((re) => re.test(f)));
        expect(offenders).to.deep.equal([]);
    });

    it('tarball identity matches the frozen package identity', () => {
        expect(packed.name).to.equal('@animastor/gpu-hub');
        expect(packed.version).to.equal('0.1.0');
    });
});

// ── PB5 — runtime file set freeze ───────────────────────────────────────

describe('phase10d: package runtime surface', () => {
    it('package root contains EXACTLY the frozen runtime .js files (new runtime file = boundary decision)', () => {
        const rootJs = fs.readdirSync(HUB_DIR)
            .filter((f) => /\.js$/.test(f))
            .sort();
        expect(rootJs).to.deep.equal(FROZEN_RUNTIME_FILES);
    });

    it('package boundary carries no generated artifacts or secrets', () => {
        const banned = [/\.tgz$/, /package-lock\.bak/, /\.env/, /secret/i];
        const offenders = fs.readdirSync(HUB_DIR).filter((f) => banned.some((re) => re.test(f)));
        expect(offenders).to.deep.equal([]);
    });
});

// ── PB6 — Docker deployment contract ────────────────────────────────────

describe('phase10d: Docker deployment contract', () => {
    it('Dockerfile stays standalone-buildable (npm install of THIS package, EXPOSE 5000, CMD server.js)', () => {
        const src = fs.readFileSync(path.join(HUB_DIR, 'Dockerfile'), 'utf8');
        // Phase 10T.1: multi-stage build — COPY may reference gpu-hub/ prefix
        expect(src).to.include('COPY');
        expect(src).to.include('package.json');
        expect(src).to.include('npm install');
        expect(src).to.include('EXPOSE 5000');
        expect(src).to.include('CMD ["node", "server.js"]');
    });

    it('runtime stage does not leak monorepo paths into production image', () => {
        const src = fs.readFileSync(path.join(HUB_DIR, 'Dockerfile'), 'utf8');
        // Split at the runtime stage boundary — only check the production stage
        const runtimeIdx = src.indexOf('FROM node:');
        const runtimeStage = runtimeIdx >= 0 ? src.slice(runtimeIdx) : src;
        // The runtime stage must never reference backend/, worker/worker/, or frontends/
        expect(runtimeStage).to.not.match(/\bbackend\b/);
        expect(runtimeStage).to.not.match(/worker\/worker/);
        expect(runtimeStage).to.not.match(/\bfrontends\b/);
    });

    it('.dockerignore keeps node_modules/tests out of the build context', () => {
        const src = fs.readFileSync(path.join(HUB_DIR, '.dockerignore'), 'utf8');
        expect(src).to.include('node_modules');
        expect(src).to.include('tests');
    });

    it('compose gpu-hub service carries NO contracts mount (Phase 10G: registry copy must not be shadowed)', () => {
        // Phase 10B mounted ./contracts → /app/node_modules/@animastor/contracts:ro.
        // Phase 10G switched the hub to the published registry package; a
        // surviving mount would silently shadow the registry copy inside the
        // container and reintroduce the monorepo coupling. It must stay gone.
        const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
        const hubSection = compose.slice(compose.indexOf('  gpu-hub:'), compose.indexOf('  nginx:'));
        expect(hubSection, 'contracts mount must NOT return in the gpu-hub service').to.not.include('@animastor/contracts');
    });
});

// ── PB7 — canonical contracts resolution ────────────────────────────────

describe('phase10d: canonical contracts resolution', () => {
    // Phase 10G/10H: the hub installs its OWN copy from the npm registry
    // (self-contained package). Resolution must land inside the hub tree —
    // NOT in the monorepo root (that would be the old root-fallback seam).
    // Correctness of the copy (no fork) is guarded by protocol parity:
    // hub PROTOCOL_VERSION === monorepo canonical contracts value (asserted
    // here), plus the route/ownership freeze in the standalone suite.
    const contractsCanonical = path.join(REPO_ROOT, 'packages', 'animastor-contracts', 'src', 'index.js');

    it('require.resolve(@animastor/contracts) from the hub tree lands inside the hub tree (registry install, not root fallback)', () => {
        const resolved = fs.realpathSync(require.resolve('@animastor/contracts', { paths: [HUB_DIR] }));
        expect(resolved.startsWith(fs.realpathSync(HUB_DIR) + path.sep),
            `contracts must resolve inside ${HUB_DIR}, got ${resolved}`).to.be.true;
    });

    it('resolved package identity is @animastor/contracts@0.1.0 (no copy, no fork)', () => {
        const resolved = require.resolve('@animastor/contracts', { paths: [HUB_DIR] });
        const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(resolved), '..', 'package.json'), 'utf8'));
        expect(pkg.name).to.equal('@animastor/contracts');
        expect(pkg.version).to.equal('0.1.0');
    });

    it('protocol parity: hub copy PROTOCOL_VERSION === monorepo canonical contracts value', () => {
        // require() has no `paths` option — resolve the hub-local file first,
        // then load exactly that module (never the root symlink).
        const hubEntry = require.resolve('@animastor/contracts', { paths: [HUB_DIR] });
        const hubResolved = require(hubEntry);
        const canonical = require(contractsCanonical);
        expect(hubResolved.jobProtocolV2.PROTOCOL_VERSION,
            'a hub-local contracts copy that diverges from canonical is a fork').to.equal(canonical.jobProtocolV2.PROTOCOL_VERSION);
    });
});
