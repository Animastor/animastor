// ======================================================
// URL-SAFETY PACKAGE BOUNDARY GUARDS — @animastor/url-safety
// ======================================================
// The SSRF guard was physically extracted from
// backend/src/services/url-safety.js into packages/animastor-url-safety.
// These guards freeze the physical result:
//
// USB-G1  physical extraction landed — package exists, the host module is
//         GONE (no compatibility copy)
// USB-G2  zero runtime npm dependencies (package manifest)
// USB-G3  package source uses ONLY node builtins (net + call-time dns) +
//         intra-package requires — no Express, no pg, no host anything
// USB-G4  no package file requires into backend/** (no reverse dependency)
// USB-G5  no hidden host access (process.env / __dirname / require.cache /
//         global fetch direct reach) inside the package — the two host
//         mechanisms arrive ONLY through the injected dnsResolver/fetchImpl
//         ports (runtime defaults resolved lazily at call time)
// USB-G6  zero backend internal-path imports into the package source
// USB-G7  public API surface is frozen (src/index.cjs exports)
// USB-G8  host consumers use the @animastor/url-safety specifier (public
//         API only, no package-internals deep-import)
// USB-G9  package manifest identity (name/version/engines/main/exports)
// USB-G10 the security contract suite lives in the package (injected
//         ports — no real DNS, no real network)
// USB-G11 the operator exemption is a parameter, never an env read
//
// Docs: docs/architecture/backend-decomposition-reconnaissance.md §4.4

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
const URLSAFETY_PKG_DIR = path.join(REPO_ROOT, 'packages', 'animastor-url-safety');
const URLSAFETY_SRC = path.join(URLSAFETY_PKG_DIR, 'src');
const URLSAFETY_PKG_JSON = path.join(URLSAFETY_PKG_DIR, 'package.json');

// ── Node builtins allowed in the package ────────────────────────────────────
// net is required statically (isIPv4/isIPv6 classifiers); dns must stay a
// CALL-TIME require (runtime default resolved lazily so hosts/test harnesses
// can stub dns.promises.lookup) — pinned by USB-G5.
const NODE_BUILTINS = new Set(['net', 'dns']);

describe('url-safety package boundary guards (@animastor/url-safety)', () => {

    it('USB-G1: physical extraction landed — package exists, the host module is gone', () => {
        expect(fs.existsSync(path.join(URLSAFETY_SRC, 'index.cjs')),
            'packages/animastor-url-safety/src/index.cjs must exist').to.equal(true);
        expect(fs.existsSync(path.join(BACKEND_SRC, 'services', 'url-safety.js')),
            'backend/src/services/url-safety.js must NOT exist (moved to the package)').to.equal(false);
    });

    it('USB-G2: zero runtime npm dependencies (package manifest)', () => {
        const pkg = JSON.parse(fs.readFileSync(URLSAFETY_PKG_JSON, 'utf8'));
        expect(pkg.dependencies, 'url-safety package must have zero runtime npm dependencies').to.be.undefined;
    });

    it('USB-G3: package source uses ONLY node builtins + intra-package requires', () => {
        const offenders = [];
        for (const file of listSourceFiles(URLSAFETY_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.startsWith('./') || spec.startsWith('../')) continue;
                if (NODE_BUILTINS.has(spec)) continue;
                offenders.push(`${rel(file)}: ${spec}`);
            }
        }
        expect(offenders, 'url-safety package must use only node builtins and intra-package requires')
            .to.deep.equal([]);
    });

    it('USB-G4: no package file requires into backend/** (no reverse dependency)', () => {
        const offenders = [];
        for (const file of listSourceFiles(URLSAFETY_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveSpecifier(file, spec);
                if (target && target.startsWith(path.join(REPO_ROOT, 'backend'))) {
                    offenders.push(`${rel(file)} -> ${rel(target)}`);
                }
            }
        }
        expect(offenders, 'url-safety package must not require into backend/ (no reverse dependency)')
            .to.deep.equal([]);
    });

    it('USB-G5: no hidden host access — env/config/Express/fs/express-free, dns+fetch via ports only', () => {
        const offenders = [];
        for (const file of listSourceFiles(URLSAFETY_SRC)) {
            // Strip full-line comments (the modules DOCUMENT the boundary
            // rules in their headers — those mentions are not host access).
            const code = readSource(file).split('\n')
                .filter((line) => !/^\s*\/\//.test(line))
                .join('\n');
            const violations = [];
            if (code.includes('process.env')) violations.push('process.env');
            if (code.includes('__dirname')) violations.push('__dirname');
            if (code.includes('require.cache')) violations.push('require.cache');
            if (/require\(['"]express['"]\)/.test(code)) violations.push('express');
            if (/require\(['"](fs|node:fs|path|node:path|os|node:os)['"]\)/.test(code)) violations.push('fs/path/os');
            if (/require\(['"](https?|node:https?)['"]\)/.test(code)) violations.push('http client');
            if (/fetch\s*\(/.test(code) && !/global\.fetch|fetchImpl|doFetch|safeFetch|function fetch/.test(code)) {
                violations.push('direct fetch reach');
            }
            if (violations.length) offenders.push(`${rel(file)}: ${violations.join(', ')}`);
        }
        expect(offenders, 'hidden host access inside the url-safety package').to.deep.equal([]);
        // the seam exists and is the ONLY way dns/fetch are reached
        const entry = readSource(path.join(URLSAFETY_SRC, 'index.cjs'));
        expect(entry, 'setUrlSafetyPorts seam must exist').to.include('function setUrlSafetyPorts');
        expect(entry, 'dns default must be call-time (lazy) resolution').to.include("require('dns')");
        expect(entry, 'fetch default must be call-time global.fetch').to.include('global.fetch');
        // dns is required lazily INSIDE a function, never at module top level
        const topLevel = entry.split('\n').filter((line) => !/^\s*(\/\/|async function|function|\s{4}|\s{2})/.test(line) && line.trim()).join('\n');
        expect(topLevel.includes("require('dns')"), 'dns must not be required at module top level').to.equal(false);
    });

    it('USB-G6: zero backend internal-path imports into the package source', () => {
        const found = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            if (file.startsWith(URLSAFETY_SRC)) continue;
            for (const spec of requireSpecifiers(readSource(file))) {
                if (!spec.startsWith('.')) continue;
                const target = resolveSpecifier(file, spec);
                if (target && target.startsWith(URLSAFETY_SRC)) {
                    found.push({ file: rel(file), spec });
                }
            }
        }
        expect(found, 'post-extraction: zero internal-path imports into the url-safety package')
            .to.deep.equal([]);
    });

    it('USB-G7: public API surface is frozen (src/index.cjs exports)', () => {
        // The FULL actual public API, pinned exactly (no more, no less).
        const urlSafety = require('@animastor/url-safety');
        expect(Object.keys(urlSafety).sort()).to.deep.equal([
            'MAX_REDIRECTS',
            'assertPublicEndpoint',
            'isPrivateAddress',
            'isPrivateIPv4',
            'isPrivateIPv6',
            'parseNumericHost',
            'safeFetch',
            'setUrlSafetyPorts',
        ].sort());
        for (const fn of ['assertPublicEndpoint', 'safeFetch', 'isPrivateIPv4', 'isPrivateIPv6', 'isPrivateAddress', 'parseNumericHost', 'setUrlSafetyPorts']) {
            expect(urlSafety[fn], `exports.${fn}`).to.be.a('function');
        }
        expect(urlSafety.MAX_REDIRECTS).to.equal(3);
    });

    it('USB-G8: host consumers use the @animastor/url-safety specifier (public API only)', () => {
        // every production consumer requires the package root — and nothing
        // requires the deleted host path anymore
        const expectedConsumers = [
            'backend/src/services/ai-service.js',
            'backend/src/services/workspace-ai-provider.js',
            'backend/src/routes/admin-routes.cjs',
            'backend/src/routes/settings-ai-routes.cjs',
            'backend/src/backend.cjs',
        ];
        const consumers = [];
        const offenders = [];
        for (const file of listSourceFiles(BACKEND_SRC)) {
            for (const spec of requireSpecifiers(readSource(file))) {
                if (spec.includes('url-safety') && spec !== '@animastor/url-safety') {
                    offenders.push(`${rel(file)}: '${spec}'`);
                }
            }
            if (requireSpecifiers(readSource(file)).includes('@animastor/url-safety')) consumers.push(rel(file));
        }
        expect(offenders, 'no host-path/deep url-safety specifiers may remain').to.deep.equal([]);
        for (const expected of expectedConsumers) {
            expect(consumers, `live consumer missing: ${expected}`).to.include(expected);
        }
    });

    it('USB-G9: package manifest identity pins', () => {
        const pkg = JSON.parse(fs.readFileSync(URLSAFETY_PKG_JSON, 'utf8'));
        expect(pkg.name, 'package name must be @animastor/url-safety').to.equal('@animastor/url-safety');
        expect(pkg.version, 'package version must be 0.1.0').to.equal('0.1.0');
        expect(pkg.main).to.equal('src/index.cjs');
        expect(pkg.exports && pkg.exports['.']).to.equal('./src/index.cjs');
        expect(pkg.engines && pkg.engines.node, 'engines.node must be >=18').to.match(/>=18/);
        expect(pkg.license).to.equal('MIT');
        expect(fs.existsSync(path.join(URLSAFETY_PKG_DIR, 'README.md'))).to.equal(true);
        expect(fs.existsSync(path.join(URLSAFETY_PKG_DIR, 'LICENSE'))).to.equal(true);
    });

    it('USB-G10: the security contract suite lives in the package (injected ports, no real network)', () => {
        const suite = path.join(URLSAFETY_PKG_DIR, 'test', 'url-safety-security.test.js');
        expect(fs.existsSync(suite), 'packages/animastor-url-safety/test/url-safety-security.test.js must exist').to.equal(true);
        const src = readSource(suite);
        expect(src, 'the suite wires the injected ports').to.include('setUrlSafetyPorts');
        expect(src, 'the suite must not hit real DNS via the host tree').to.not.include('backend/src');
        expect(src, 'the suite must not require Express').to.not.match(/require\(['"]express['"]\)/);
        // the backend HTTP integration suites stay host-side
        expect(fs.existsSync(path.join(REPO_ROOT, 'backend', 'tests', 'workspace-ai-security.test.js')),
            'backend/tests/workspace-ai-security.test.js must stay host-side (HTTP/PG integration)').to.equal(true);
    });

    it('USB-G11: the operator exemption is a parameter, never an env read', () => {
        const entry = readSource(path.join(URLSAFETY_SRC, 'index.cjs'));
        expect(entry, 'validatePublic must default to true in safeFetch').to.include('validatePublic = true');
        expect(entry, 'validatePublic must be destructured from call opts').to.match(/validatePublic[^=]*=\s*true,\s*\.\.\./);
    });

});
