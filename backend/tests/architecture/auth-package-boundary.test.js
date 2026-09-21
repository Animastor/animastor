// ======================================================
// AUTH PACKAGE BOUNDARY GUARDS — @animastor/auth
// ======================================================
// POST-EXTRACTION guards (physical move LANDED). The auth domain lives in
// packages/animastor-auth with a real package boundary:
//
// APB-G1  package exists at packages/animastor-auth; backend/src/auth domain
//         files are gone (no compatibility copy)
// APB-G2  zero runtime npm dependencies (package manifest)
// APB-G3  package source uses ONLY node:crypto + intra-package requires
//         (no Express, no pg, no storage, no host anything)
// APB-G4  no package file requires into backend/** (no reverse dependency)
// APB-G5  no process.env / __dirname / require.cache inside the package
//         (hidden host access forbidden)
// APB-G6  zero backend internal-path imports into the package source
// APB-G7  public API surface is frozen (src/index.cjs exports)
// APB-G8  host wiring consumes the @animastor/auth specifier (public API
//         only, no package-internals deep-import)
// APB-G9  package manifest identity (name/version/engines/main/exports)
// APB-G10 host port adapters stay host-side: registration-tx + workspace-
//         ownership + repos must NOT have moved into the package
// APB-G11 contract tests live in the package (in-memory ports)
//
// Docs: docs/architecture/auth-extraction-readiness-audit.md §16

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
const AUTH_PKG_DIR = path.join(REPO_ROOT, 'packages', 'animastor-auth');
const AUTH_SRC = path.join(AUTH_PKG_DIR, 'src');
const AUTH_PKG_JSON = path.join(AUTH_PKG_DIR, 'package.json');

// ── Node builtins allowed in the package ────────────────────────────────────
const NODE_BUILTINS = new Set(['crypto', 'util']);

describe('auth package boundary guards (@animastor/auth)', () => {

    it('APB-G1: physical extraction landed — package exists, backend domain files are gone', () => {
        expect(fs.existsSync(path.join(AUTH_SRC, 'core.js')), 'packages/animastor-auth/src/core.js must exist').to.equal(true);
        for (const gone of ['core.js', 'book-access.js', 'cookies.js', 'auth-config.js', 'auth-errors.js', 'password.js', 'ports.js']) {
            expect(fs.existsSync(path.join(BACKEND_SRC, 'auth', gone)),
                `backend/src/auth/${gone} must NOT exist (moved to the package)`).to.equal(false);
        }
    });

    it('APB-G2: zero runtime npm dependencies (package manifest)', () => {
        const pkg = JSON.parse(fs.readFileSync(AUTH_PKG_JSON, 'utf8'));
        expect(pkg.dependencies, 'auth package must have zero runtime npm dependencies').to.be.undefined;
    });

    it('APB-G3: package source uses ONLY node:crypto + intra-package requires', () => {
        const offenders = [];
        for (const file of listSourceFiles(AUTH_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('./') || spec.startsWith('../')) continue;
                if (NODE_BUILTINS.has(spec)) continue;
                offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'auth package must use only node builtins and intra-package requires')
            .to.deep.equal([]);
    });

    it('APB-G4: no package file requires into backend/** (no reverse dependency)', () => {
        const offenders = [];
        for (const file of listSourceFiles(AUTH_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveSpecifier(file, spec);
                if (target && target.startsWith(BACKEND_SRC)) {
                    offenders.push(`${rel(file)} -> ${rel(target)}`);
                }
            }
        }
        expect(offenders, 'auth package must not require into backend/ (no reverse dependency)')
            .to.deep.equal([]);
    });

    it('APB-G5: no hidden host access (process.env / __dirname / require.cache) in the package', () => {
        const offenders = [];
        for (const file of listSourceFiles(AUTH_SRC)) {
            // Strip full-line comments (the modules DOCUMENT the no-env rule
            // in their headers — those mentions are not host access).
            const code = readSource(file).split('\n')
                .filter((line) => !/^\s*\/\//.test(line))
                .join('\n');
            if (code.includes('process.env') || code.includes('__dirname') || code.includes('require.cache')) {
                offenders.push(rel(file));
            }
        }
        expect(offenders, 'hidden host access (process.env/__dirname/require.cache) in the auth package')
            .to.deep.equal([]);
    });

    it('APB-G6: zero backend internal-path imports into the package source', () => {
        const found = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            if (file.startsWith(AUTH_SRC)) continue;
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveSpecifier(file, spec);
                if (target && target.startsWith(AUTH_SRC)) {
                    found.push({ file: rel(file), spec });
                }
            }
        }
        expect(found, 'post-extraction: zero internal-path imports into the auth package')
            .to.deep.equal([]);
    });

    it('APB-G7: public API surface is frozen (src/index.cjs exports)', () => {
        const src = readSource(path.join(AUTH_SRC, 'index.cjs'));
        const expectedExports = [
            'createAuthService', 'decideBookAccess', 'authorizedWorkspace',
            'ANONYMOUS_WORKSPACE', 'AuthError', 'WorkspaceExpiredError',
            'DEFAULT_AUTH_CONFIG', 'normalizeAuthConfig', 'normalizeCookieDomain',
            'cookies', 'password', 'assertAuthPorts',
        ];
        for (const name of expectedExports) {
            expect(src, `index.cjs must export '${name}'`).to.include(name);
        }
    });

    it('APB-G8: host wiring consumes the @animastor/auth specifier (public API only)', () => {
        const wiringFile = path.join(BACKEND_SRC, 'auth', 'index.cjs');
        const src = readSource(wiringFile);
        expect(src, 'host wiring must require @animastor/auth').to.include("require('@animastor/auth')");
        expect(src, 'host wiring must NOT deep-import package internals')
            .to.not.match(/require\(['"]@animastor\/auth\/(?!package\.json)[^'"]*['"]\)/);
    });

    it('APB-G9: package manifest identity pins', () => {
        const pkg = JSON.parse(fs.readFileSync(AUTH_PKG_JSON, 'utf8'));
        expect(pkg.name, 'package name must be @animastor/auth').to.equal('@animastor/auth');
        expect(pkg.version, 'package version must be 0.1.0').to.equal('0.1.0');
        expect(pkg.main).to.equal('src/index.cjs');
        expect(pkg.exports && pkg.exports['.']).to.equal('./src/index.cjs');
        expect(pkg.engines && pkg.engines.node, 'engines.node must be >=20').to.match(/>=20/);
        expect(pkg.license).to.equal('MIT');
    });

    it('APB-G10: host port adapters stay host-side', () => {
        for (const hostAdapter of [
            'src/storage/postgres/repositories/registration-tx.js',
            'src/middleware/workspace-ownership.js',
            'src/storage/postgres/repositories/session-repo.js',
            'src/storage/postgres/repositories/guest-repo.js',
        ]) {
            expect(fs.existsSync(path.join(REPO_ROOT, 'backend', hostAdapter)),
                `backend/${hostAdapter} must stay host-side (PG adapter)`).to.equal(true);
        }
        const wiring = readSource(path.join(BACKEND_SRC, 'auth', 'index.cjs'));
        expect(wiring, 'host wiring binds the registrationTx + bookOwnership adapters')
            .to.include('registration-tx');
        expect(wiring, 'host wiring binds workspace-ownership (bookOwnership port)')
            .to.include('workspace-ownership');
    });

    it('APB-G11: contract tests live in the package (in-memory ports)', () => {
        const contractTest = path.join(AUTH_PKG_DIR, 'test', 'auth-contract.test.js');
        expect(fs.existsSync(contractTest), 'packages/animastor-auth/test/auth-contract.test.js must exist').to.equal(true);
        const src = readSource(contractTest);
        expect(src, 'contract tests use in-memory ports (no PG)').to.not.include('storage/postgres');
        expect(src, 'contract tests use in-memory ports (no Express)').to.not.match(/require\(['"]express['"]\)/);
        // The backend HTTP integration suites stay host-side.
        for (const hostSuite of ['auth-mvp.test.js', 'guest-workspace.test.js']) {
            expect(fs.existsSync(path.join(REPO_ROOT, 'backend', 'tests', hostSuite)),
                `backend/tests/${hostSuite} must stay host-side (HTTP/PG integration)`).to.equal(true);
        }
    });

});
