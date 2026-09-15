// ======================================================
// INSTALLER PACKAGE BOUNDARY GUARDS — @animastor/installer
// ======================================================
// POST-EXTRACTION guards (physical move LANDED). The installer lives in
// packages/animastor-installer with a real package boundary:
//
// IB-G1  installer has zero npm dependencies
// IB-G2  installer uses ONLY Node builtins + intra-package requires
// IB-G3  no installer file requires into backend/** (no host coupling)
// IB-G4  zero backend internal-path imports into installer src (moved to @animastor/installer)
// IB-G5  public API surface is frozen (index.js exports)
// IB-G6  backend consumer uses the @animastor/installer specifier
// IB-G7  package.json declares Node >= 20
// IB-G8  MANIFEST_ROOT contract preserved (baked-in + package-relative, no env override)
// IB-G9  package manifest identity (name @animastor/installer, zero deps)
// IB-G10 setup-contract export surface frozen (public setupContract API)
// IB-G11 CLI surface frozen (6 subcommands)
// IB-G12 hub installer tarball contract frozen (four entry prefixes)
// IB-G13 backend/ai/workflows is a shared host asset — must NOT move into the installer package
// IB-G14 installer resolves workflows via repository_path candidates, not package-local ai/
// IB-G15 package identity pins (version 0.1.0, main, bin, private)
//
// Docs: docs/architecture/installer-extraction-audit.md

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const {
    REPO_ROOT,
    BACKEND_SRC,
    listSourceFiles,
    readSource,
    rel,
    requireSpecifiers,
    resolveSpecifier,
} = require('./helpers');

// ── Post-extraction physical location (single home) ─────────────────────────
const INSTALLER_PKG_DIR = path.join(REPO_ROOT, 'packages', 'animastor-installer');
const IS_EXTRACTED = fs.existsSync(path.join(INSTALLER_PKG_DIR, 'src', 'installer'));
const INSTALLER_SRC = path.join(INSTALLER_PKG_DIR, 'src', 'installer');
const INSTALLER_PKG_JSON = path.join(INSTALLER_PKG_DIR, 'package.json');

// ── Node builtins allowed in the installer ──────────────────────────────────
const NODE_BUILTINS = new Set([
    'fs', 'path', 'os', 'crypto', 'child_process', 'readline',
    'util', 'stream', 'events', 'http', 'https', 'url', 'zlib',
    'net', 'tty', 'assert', 'buffer', 'string_decoder',
]);

describe('installer package boundary guards (@animastor/installer)', () => {

    it('IB-G0: physical extraction landed — package exists, backend/src/installer is gone', () => {
        expect(IS_EXTRACTED, 'packages/animastor-installer/src/installer must exist').to.equal(true);
        expect(fs.existsSync(path.join(BACKEND_SRC, 'installer')),
            'backend/src/installer must NOT exist (no compatibility copy/symlink)').to.equal(false);
    });

    it('IB-G1: installer has zero npm dependencies (package manifest)', () => {
        const pkg = JSON.parse(fs.readFileSync(INSTALLER_PKG_JSON, 'utf8'));
        expect(pkg.dependencies, 'installer must have zero runtime npm dependencies')
            .to.be.undefined;
    });

    it('IB-G2: installer source uses ONLY Node builtins + intra-package requires', () => {
        const offenders = [];
        for (const file of listSourceFiles(INSTALLER_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('./') || spec.startsWith('../')) continue;
                if (NODE_BUILTINS.has(spec)) continue;
                offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders,
            'installer must use only Node builtins and intra-package requires')
            .to.deep.equal([]);
    });

    it('IB-G3: no installer file requires into backend/** (no host coupling)', () => {
        const offenders = [];
        for (const file of listSourceFiles(INSTALLER_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveSpecifier(file, spec);
                if (target && target.startsWith(BACKEND_SRC)
                    && !target.startsWith(INSTALLER_SRC)) {
                    offenders.push(`${rel(file)} -> ${rel(target)}`);
                }
            }
        }
        expect(offenders,
            'installer must not require into backend/ (no host coupling)')
            .to.deep.equal([]);
    });

    it('IB-G4: zero backend internal-path imports into installer source', () => {
        const found = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            if (file.startsWith(INSTALLER_SRC)) continue;
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveSpecifier(file, spec);
                if (target && target.startsWith(INSTALLER_SRC)) {
                    found.push({ file: rel(file), spec });
                }
            }
        }
        expect(found, 'post-extraction: zero internal-path imports into installer')
            .to.deep.equal([]);
    });

    it('IB-G5: public API surface is frozen (index.js exports)', () => {
        const indexFile = path.join(INSTALLER_SRC, 'index.js');
        const src = readSource(indexFile);
        const expectedExports = [
            'manifest', 'resolver', 'workflows', 'downloads',
            'plan', 'safety', 'verification', 'engine', 'uninstaller',
            'setupContract',
        ];
        for (const name of expectedExports) {
            expect(src, `index.js must export '${name}'`).to.include(`${name},`);
        }
    });

    it('IB-G6: backend consumer uses @animastor/installer specifier (public API only)', () => {
        const routesFile = path.join(BACKEND_SRC, 'routes', 'worker-setup-routes.cjs');
        const src = readSource(routesFile);
        expect(src, 'worker-setup-routes must require @animastor/installer')
            .to.include("require('@animastor/installer')");
        expect(src, 'worker-setup-routes must NOT require installer internals')
            .to.not.match(/require\(['"][^'"]*installer\//);
        expect(src, 'worker-setup-routes must NOT reference backend/src/installer paths')
            .to.not.match(/backend\/src\/installer|\.\/installer|\.\.\/installer/);
    });

    it('IB-G7: package.json declares Node >= 20', () => {
        const pkg = JSON.parse(fs.readFileSync(INSTALLER_PKG_JSON, 'utf8'));
        expect(pkg.engines && pkg.engines.node, 'engines.node must be declared').to.exist;
        expect(pkg.engines.node, 'engines.node must be >=20').to.match(/>=20/);
    });

    it('IB-G8: MANIFEST_ROOT contract preserved (baked-in + package-relative, no env override)', () => {
        const manifestFile = path.join(INSTALLER_SRC, 'install-manifest.js');
        const src = readSource(manifestFile);
        expect(src, 'MANIFEST_ROOT must check baked-in path')
            .to.include("path.join('/app', 'artifacts', 'install-manifests')");
        expect(src, 'MANIFEST_ROOT must have package-relative fallback')
            .to.include("path.join(__dirname, '..', '..', 'ai', 'install-manifests')");
        expect(src, 'MANIFEST_ROOT must NOT use env var override')
            .to.not.include('ANIMASTOR_MANIFEST_ROOT');
    });

    it('IB-G9: package manifest has zero external npm dependencies and declares identity', () => {
        const pkg = JSON.parse(fs.readFileSync(INSTALLER_PKG_JSON, 'utf8'));
        expect(pkg.name, 'package name must be @animastor/installer')
            .to.equal('@animastor/installer');
        expect(pkg.version, 'package version must be 0.1.0').to.equal('0.1.0');
        expect(pkg.dependencies, 'no runtime npm dependencies')
            .to.be.undefined;
    });

    it('IB-G10: setup-contract export surface frozen (public setupContract API)', () => {
        // The backend consumer (worker-setup-routes.cjs) consumes ONLY this
        // projection — it is the public host seam of the package. Freeze its
        // export surface so extraction cannot silently drop a consumed export.
        const src = readSource(path.join(INSTALLER_SRC, 'setup-contract.js'));
        const expected = [
            'PLATFORMS', 'OS_PLATFORMS', 'DEPLOYMENTS', 'AVAILABILITY_LEVELS',
            'INSTALL_MODES', 'SETUP_WORKER_STATUSES', 'SHARING_VERDICT_MAP',
            'getInstallerVersion', 'getWorkerBundleVersion',
            'createManifestRegistry', 'getManifestRegistry', 'isHiddenManifest',
            'listSetupProfiles', 'getInstallationMethods', 'getPlatformArtifacts',
            'probeHubArtifacts', 'listWorkflowArtifacts', 'buildInstructions',
            'adaptSetupStatus', 'normalizeCapabilities', 'buildSetupPlan',
            'deploymentCapabilities', 'resolveDeploymentTarget',
        ];
        const moduleExportsMatch = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
        expect(moduleExportsMatch, 'setup-contract must have a module.exports block').to.exist;
        for (const name of expected) {
            expect(moduleExportsMatch[1], `setup-contract must export '${name}'`)
                .to.include(name);
        }
    });

    it('IB-G11: CLI surface frozen (6 subcommands)', () => {
        const src = readSource(path.join(INSTALLER_SRC, 'cli.js'));
        for (const cmd of ['detect', 'plan', 'install', 'verify', 'resume', 'uninstall']) {
            expect(src, `CLI must dispatch '${cmd}'`).to.include(`'${cmd}'`);
        }
    });

    it('IB-G12: hub installer tarball contract frozen (four entry prefixes)', () => {
        // TWO-SIDED wire format: the hub tar prefixes must stay in lockstep
        // with the installer's own resolvers (engine/workflows.js candidates,
        // worker-bundle-source.js REPO_BUNDLE_DIRS, install-manifest.js
        // fallback). Extraction must not change any entry prefix.
        const hubSrc = readSource(path.join(REPO_ROOT, 'packages', 'animastor-gpu-hub', 'gpu-hub.js'));
        const frozenPrefixes = [
            'animastor-installer/src/installer/${f}',
            'animastor-installer/ai/install-manifests/${f}',
            'animastor-installer/backend/ai/workflows/${f}',
            'animastor-installer/packages/animastor-worker/worker/${f}',
        ];
        for (const prefix of frozenPrefixes) {
            expect(hubSrc, `tar entry prefix '${prefix}' must stay frozen`).to.include(prefix);
        }
    });

    it('IB-G13: backend/ai/workflows is a shared host asset — must NOT move into the installer package', () => {
        // BLOCKER (seam audit): backend/ai/workflows is loaded by the backend
        // runtime at startup (backend.cjs workflowLoader.configure) and the
        // generation package resolves the same workflow ids. Moving it into
        // packages/animastor-installer/ai/workflows would create a reverse
        // dependency (backend → installer package filesystem) and break the
        // engine's repository_path candidates. Workflows STAY host-side.
        expect(fs.existsSync(path.join(REPO_ROOT, 'backend', 'ai', 'workflows')),
            'backend/ai/workflows must exist host-side').to.equal(true);
        const backendSrc = readSource(path.join(BACKEND_SRC, 'backend.cjs'));
        expect(backendSrc, 'backend runtime loads workflows from backend/ai/workflows')
            .to.include("path.join(__dirname, '../ai/workflows')");
    });

    it('IB-G14: installer resolves workflows via repository_path candidates, not package-local ai/', () => {
        // The engine's canonical-workflow resolution must keep resolving
        // repository_path against the REPO ROOT (dev candidate) and the
        // animastor-installer tar prefix (tarball candidate) — it must not
        // gain a package-local ai/workflows default.
        const src = readSource(path.join(INSTALLER_SRC, 'engine', 'workflows.js'));
        expect(src, 'dev candidate: repoRoot + repository_path')
            .to.include('path.join(repoRoot, wf.source.repository_path)');
        expect(src, 'tarball candidate: animastor-installer prefix + repository_path')
            .to.include("path.join(repoRoot, 'animastor-installer', wf.source.repository_path)");
    });

    it('IB-G15: package.json pins (main, bin, private)', () => {
        const pkg = JSON.parse(fs.readFileSync(INSTALLER_PKG_JSON, 'utf8'));
        expect(pkg.main, 'main must be src/installer/index.js').to.equal('src/installer/index.js');
        expect(pkg.bin, 'bin.animastor-installer must be declared').to.deep.equal({
            'animastor-installer': 'src/installer/cli.js',
        });
        expect(pkg.private, 'package stays private (no publish yet)').to.equal(true);
    });

    it('IB-G16: manifests are physically inside the package', () => {
        const root = path.join(INSTALLER_PKG_DIR, 'ai', 'install-manifests');
        expect(fs.existsSync(root), 'packages/animastor-installer/ai/install-manifests must exist').to.equal(true);
        for (const f of ['audio/qwen-tts.json', 'image/qwen-image.json', 'video/ltx-2.3.json']) {
            expect(fs.existsSync(path.join(root, ...f.split('/'))), `${f} must exist in-package`).to.equal(true);
        }
        expect(fs.existsSync(path.join(REPO_ROOT, 'backend', 'ai', 'install-manifests')),
            'backend/ai/install-manifests must be gone').to.equal(false);
    });

    it('IB-G17: installer tests live in the package', () => {
        const testsDir = path.join(INSTALLER_PKG_DIR, 'tests');
        const moved = fs.readdirSync(testsDir).filter((f) => /^installer-.*\.test\.js$/.test(f));
        expect(moved.length, 'installer-*.test.js files must live in the package').to.be.at.least(16);
        const leftovers = fs.existsSync(path.join(REPO_ROOT, 'backend', 'tests'))
            ? fs.readdirSync(path.join(REPO_ROOT, 'backend', 'tests'))
                .filter((f) => /^installer-.*\.test\.js$/.test(f))
            : [];
        expect(leftovers, 'no installer test files may remain in backend/tests').to.deep.equal([]);
    });

});
