// ======================================================
// ARCHITECTURE GUARDRAILS — shared scan helpers (Phase 1)
// ======================================================
// Static source scanning used by tests/architecture/*.test.js.
// Pure filesystem + regex, zero runtime imports of the scanned code:
// fast, CI-safe, no side effects. See docs/architecture/PHASE_1_GUARDRAILS.md.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BACKEND_SRC = path.join(REPO_ROOT, 'backend', 'src');

// ── Worker package relocation (preparation) ──────────────────────────────
// The package boundary is being relocated: worker/ → packages/animastor-
// worker/ (see docs/architecture/WORKER_PACKAGE_RELOCATION_CHECKLIST.md).
// Resolve the CURRENT physical location — the canonical path once the move
// lands, the legacy path until then — so guards keep passing through both
// states and the `git mv` commit needs no test edits.
const WORKER_PKG_DIR = fs.existsSync(path.join(REPO_ROOT, 'packages', 'animastor-worker'))
    ? path.join(REPO_ROOT, 'packages', 'animastor-worker')
    : path.join(REPO_ROOT, 'worker');
const WORKER_BUNDLE_DIR = path.join(WORKER_PKG_DIR, 'worker');
const WORKER_TESTS_DIR = path.join(WORKER_PKG_DIR, 'tests');
const SYNC_TOOL_PATH = path.join(WORKER_PKG_DIR, 'tools', 'sync-protocol.cjs');

function listSourceFiles(rootDir, extensions = ['.js', '.cjs']) {
    const out = [];
    if (!fs.existsSync(rootDir)) return out;
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (extensions.includes(path.extname(entry.name))) out.push(full);
        }
    })(rootDir);
    return out;
}

function readSource(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

/** Repo-relative posix path (stable across OS, nice diffs in failures). */
function rel(filePath) {
    return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

/**
 * All require()/import specifiers used by a file.
 * Matches: require('x'), require("x"), import x from 'x'.
 */
const REQUIRE_RE = /require\(\s*(['"])([^'"]+)\1\s*\)|from\s+(['"])([^'"]+)\3/g;

function requireSpecifiers(source) {
    const specs = [];
    let m;
    while ((m = REQUIRE_RE.exec(source)) !== null) {
        specs.push(m[2] || m[4]);
    }
    return specs;
}

/**
 * Resolve a relative specifier to the file it points at inside the repo
 * (best-effort resolution: exact / .js / .cjs / /index.js / /index.cjs).
 * Returns null for bare specifiers (node_modules) and unresolvable paths.
 */
function resolveSpecifier(fromFile, spec) {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [
        base,
        base + '.js',
        base + '.cjs',
        path.join(base, 'index.js'),
        path.join(base, 'index.cjs'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
}

module.exports = {
    REPO_ROOT,
    BACKEND_SRC,
    WORKER_PKG_DIR,
    WORKER_BUNDLE_DIR,
    WORKER_TESTS_DIR,
    SYNC_TOOL_PATH,
    listSourceFiles,
    readSource,
    rel,
    requireSpecifiers,
    resolveSpecifier,
};
