// ======================================================
// PHASE 10D — GPU Hub package boundary guards
// ======================================================
// Phase 10D physically prepared gpu-hub/ as a standalone npm package
// (@animastor/gpu-hub) WITHOUT changing production behavior: the monorepo
// deployment (docker-compose, compose mounts, nginx /gpu/, worker-auth debt)
// stays exactly as it was. These guards freeze the NEW package boundary:
//
//   PB1  Package identity: @animastor/gpu-hub@0.1.0, MIT, main=server.js.
//   PB2  Manifest dependency set is frozen: express/cors/ioredis runtime +
//        @animastor/contracts (file:../contracts, optional until registry
//        publish — GATE recorded in the 10D audit). No devDependencies.
//   PB3  Package-lock.json is in sync with the manifest and contains the
//        @animastor/contracts file: link entry (no hidden monorepo-root
//        dependency — hub resolves contracts from its own node_modules).
//   PB4  npm pack contents are EXACTLY the frozen allowlist (9 files):
//        runtime modules + package files only — no node_modules, backend,
//        worker, frontend, workflows, install manifests, secrets, tests,
//        generated artifacts.
//   PB5  Runtime file set is frozen (gpu-hub.js, server.js, tarball.js,
//        bootstrap.js) — a new runtime file is a boundary decision and
//        must update this guard.
//   PB6  Docker deployment contract intact: Dockerfile present, standalone
//        build (npm install of this package), EXPOSE 5000, CMD server.js;
//        .dockerignore excludes node_modules/tests.
//   PB7  Contracts resolution: require('@animastor/contracts') from the hub
//        tree resolves into the canonical <repo>/contracts implementation —
//        never a copy (no second Job Protocol implementation).
//
// Docs: docs/architecture/PHASE_10D_GPU_HUB_PACKAGE_EXTRACTION_AUDIT.md

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { REPO_ROOT } = require('./helpers');

const HUB_DIR = path.join(REPO_ROOT, 'gpu-hub');
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

    it('manifest declares exactly the frozen dependency set (express/cors/ioredis + canonical contracts)', () => {
        expect(Object.keys(pkg.dependencies).sort()).to.deep.equal(['cors', 'express', 'ioredis']);
        expect(pkg.optionalDependencies).to.deep.equal({ '@animastor/contracts': 'file:../contracts' });
        // The canonical Job Protocol v2 source must never be vendored/copied:
        // file: is the pre-registry seam (monorepo sibling); registry publish
        // is the recorded 10D+ gate.
        expect(pkg.optionalDependencies['@animastor/contracts']).to.equal('file:../contracts');
    });

    it('package stays runtime-only (no devDependencies, tests excluded from pack surface)', () => {
        expect(pkg.devDependencies, 'devDependencies would widen the boundary').to.be.undefined;
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

    it('lockfile records the @animastor/contracts file: dependency (no hidden monorepo-root resolution)', () => {
        expect(lock.packages['']).to.exist;
        expect(lock.packages[''].optionalDependencies).to.deep.equal({ '@animastor/contracts': 'file:../contracts' });
        expect(lock.packages['node_modules/@animastor/contracts']).to.exist;
        expect(lock.packages['node_modules/@animastor/contracts'].resolved).to.equal('../contracts');
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
        expect(src).to.include('COPY package.json');
        expect(src).to.include('npm install');
        expect(src).to.include('EXPOSE 5000');
        expect(src).to.include('CMD ["node", "server.js"]');
        // Boundary hygiene: the image must never bake monorepo paths.
        expect(src).to.not.match(/\.\.\/|backend|worker\/worker|frontends/);
    });

    it('.dockerignore keeps node_modules/tests out of the build context', () => {
        const src = fs.readFileSync(path.join(HUB_DIR, '.dockerignore'), 'utf8');
        expect(src).to.include('node_modules');
        expect(src).to.include('tests');
    });

    it('Dockerfile expects contracts at runtime via the compose mount seam (unchanged production behavior)', () => {
        // The compose service mounts ./contracts →
        // /app/node_modules/@animastor/contracts:ro (Phase 10B seam, kept in
        // 10D for deployment compatibility). The Dockerfile itself must not
        // vendor a protocol copy.
        const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
        expect(compose).to.include('./contracts:/app/node_modules/@animastor/contracts:ro');
    });
});

// ── PB7 — canonical contracts resolution ────────────────────────────────

describe('phase10d: canonical contracts resolution', () => {
    it('require.resolve(@animastor/contracts) from the hub tree lands in the canonical implementation', () => {
        const resolved = require.resolve('@animastor/contracts', { paths: [HUB_DIR] });
        const canonical = path.join(REPO_ROOT, 'contracts', 'src', 'index.js');
        expect(fs.realpathSync(resolved)).to.equal(fs.realpathSync(canonical));
    });

    it('resolved package identity is @animastor/contracts@0.1.0 (no copy, no fork)', () => {
        const resolved = require.resolve('@animastor/contracts', { paths: [HUB_DIR] });
        const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(resolved), '..', 'package.json'), 'utf8'));
        expect(pkg.name).to.equal('@animastor/contracts');
        expect(pkg.version).to.equal('0.1.0');
    });
});
