// ======================================================
// animastor-worker — package contour tests (standalone readiness)
// ======================================================
// Phase 9D: the worker is a standalone artifact. These tests pin the
// package contour: zero runtime npm dependencies, the exact shipped file
// set (installer manifests + hub bundle source), and the deployment wiring
// that every install channel must agree on.
// Repo-level architecture guards live in
//   backend/tests/architecture/phase9d-worker-package.test.js

const fs = require('fs');
const path = require('path');
const { describe, it, expect } = require('./harness.cjs');

const BUNDLE_DIR = path.join(__dirname, '..', 'worker');

// Runtime files the installer must deploy (install manifests) — the same
// set npm pack ships and the hub bundle publishes. The generated Job
// Protocol v2 copy is part of the runtime since Phase 9D.
const RUNTIME_FILES = [
    'worker.cjs',
    'worker-env.cjs',
    'worker-cleanup.cjs',
    'worker-cleanup-journal.cjs',
    'job-protocol-v2.cjs',
    'package.json',
    'package-lock.json',
    '.env.example',
];

describe('worker package — manifest (standalone package)', () => {
    it('declares zero runtime npm dependencies (Phase 9B freeze preserved)', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, 'package.json'), 'utf8'));
        expect.equal(pkg.name, 'animastor-worker');
        expect.match(String(pkg.version), /^\d+\.\d+\.\d+$/);
        expect.notOk(pkg.dependencies, 'no runtime dependencies');
        expect.notOk(pkg.optionalDependencies, 'no optional dependencies');
        expect.ok(pkg.private !== true, 'the package must be publishable to an npm registry');
        expect.ok(pkg.engines && pkg.engines.node, 'engines.node must document the required Node version');
        expect.include(pkg.description, 'canonical worker bundle version');
    });

    it('npm files allowlist ships exactly the runtime set', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, 'package.json'), 'utf8'));
        const files = [...(pkg.files || [])].sort();
        const expected = RUNTIME_FILES.filter((f) => f !== 'package.json' && f !== 'package-lock.json').sort();
        expect.deepEqual(files, expected, 'package.json files must list the runtime bundle (npm adds package.json itself)');
    });

    it('every runtime file exists in the bundle directory', () => {
        for (const f of RUNTIME_FILES) {
            expect.ok(fs.existsSync(path.join(BUNDLE_DIR, f)), `missing bundle file: ${f}`);
        }
    });

    it('bundle directory carries no stray production files beyond the runtime set', () => {
        // The hub bundle tar includes EVERYTHING in this directory (except
        // .env*), so the shipped surface must stay intentional. Dev-only
        // artifacts (tests/, node_modules) must never appear.
        const entries = fs.readdirSync(BUNDLE_DIR)
            .filter((f) => f !== 'tests' && f !== 'node_modules')
            .sort();
        expect.deepEqual(entries, [...RUNTIME_FILES].sort());
        expect.notOk(fs.existsSync(path.join(BUNDLE_DIR, 'node_modules')), 'node_modules must not be committed into the bundle');
    });

    it('.env.example documents the full env contract (no secrets)', () => {
        const envExample = fs.readFileSync(path.join(BUNDLE_DIR, '.env.example'), 'utf8');
        for (const key of ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID']) {
            expect.match(envExample, new RegExp(`^#?\\s*${key}=`, 'm'), `missing env var documentation: ${key}`);
        }
        expect.notMatch(envExample, /^ANIMASTOR_WORKER_TOKEN=wrk\./m, 'no real credential material in the template');
    });
});

describe('worker package — install manifests ship the runtime set (dev-time)', () => {
    // Monorepo manifests live at <repo>/backend/ai/install-manifests — try
    // both repo-root depths so the check survives the package relocation
    // (worker/ → packages/animastor-worker/) instead of silently skipping.
    const manifestRootCandidates = [
        path.join(__dirname, '..', '..', 'backend', 'ai', 'install-manifests'),
        path.join(__dirname, '..', '..', '..', 'backend', 'ai', 'install-manifests'),
    ];
    const MANIFEST_ROOT = manifestRootCandidates.find((p) => fs.existsSync(p));

    it('every install manifest lists the exact runtime file set', () => {
        if (!fs.existsSync(MANIFEST_ROOT)) {
            console.log('  (manifest check skipped — standalone checkout without monorepo)');
            return;
        }
        for (const type of fs.readdirSync(MANIFEST_ROOT).sort()) {
            const typeDir = path.join(MANIFEST_ROOT, type);
            if (!fs.statSync(typeDir).isDirectory()) continue;
            for (const file of fs.readdirSync(typeDir).sort()) {
                if (!file.endsWith('.json')) continue;
                const m = JSON.parse(fs.readFileSync(path.join(typeDir, file), 'utf8'));
                const files = [...(m.worker_bundle.files || [])].sort();
                expect.deepEqual(
                    files,
                    [...RUNTIME_FILES].sort(),
                    `${type}/${file} worker_bundle.files must ship the exact runtime set`,
                );
            }
        }
    });
});
