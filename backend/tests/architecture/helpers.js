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

// ── Orchestration package relocation (§32.30 — physical move LANDED) ─────
// The runtime/orchestration contour now lives in
// packages/animastor-orchestration (host-stays gpu-dispatcher/runtime-loop/
// orchestration-seams/job-schema remain in backend/src/runtime). Guards that
// scan "the two tiers" must scan the PACKAGE dirs; rel()-style allowlist
// strings use the ORCH_PKG_REL prefix. Resolve the CURRENT physical
// location — canonical package path once landed, legacy backend paths
// before — so suites stay green through both states.
const ORCH_PKG_DIR = fs.existsSync(path.join(REPO_ROOT, 'packages', 'animastor-orchestration'))
    ? path.join(REPO_ROOT, 'packages', 'animastor-orchestration')
    : null;
const ORCH_PKG_SRC = ORCH_PKG_DIR
    ? path.join(ORCH_PKG_DIR, 'src')
    : path.join(BACKEND_SRC, 'orchestration');
const ORCH_PKG_RUNTIME_DIR = path.join(ORCH_PKG_SRC, 'runtime');
const ORCH_PKG_ORCH_DIR = path.join(ORCH_PKG_SRC, 'orchestration');
const ORCH_PKG_REL = ORCH_PKG_DIR ? 'packages/animastor-orchestration/src' : 'backend/src/orchestration';
const ORCH_PKG_RUNTIME_REL = ORCH_PKG_DIR ? 'packages/animastor-orchestration/src/runtime' : 'backend/src/runtime';

/** The two tier dirs at their CURRENT physical location (package first). */
function tierDirs() {
    if (ORCH_PKG_DIR) return [ORCH_PKG_RUNTIME_DIR, ORCH_PKG_ORCH_DIR];
    return [path.join(BACKEND_SRC, 'runtime'), path.join(BACKEND_SRC, 'orchestration')];
}

/** All tier source files (the moved contour, wherever it physically lives). */
function tierFiles() {
    return tierDirs().flatMap((d) => listSourceFiles(d));
}

// ── Worker package relocation (preparation) ──────────────────────────────
// The worker bundle physically lives in packages/animastor-worker/ (canonical)
// until the physical split. B7 (2026-10): the legacy `worker/` fallback is
// REMOVED (§9 #15) — after filter-repo of the worker repo these paths do not
// exist in the backend checkout, and suites that read worker sources must
// SKIP (their assertions move to the worker repo / hub CI), not misfire on a
// stale directory. Every consumer must null-check WORKER_* constants.
const WORKER_PKG_DIR = fs.existsSync(path.join(REPO_ROOT, 'packages', 'animastor-worker'))
    ? path.join(REPO_ROOT, 'packages', 'animastor-worker')
    : null;
const WORKER_BUNDLE_DIR = WORKER_PKG_DIR ? path.join(WORKER_PKG_DIR, 'worker') : null;
const WORKER_TESTS_DIR = WORKER_PKG_DIR ? path.join(WORKER_PKG_DIR, 'tests') : null;
const SYNC_TOOL_PATH = WORKER_PKG_DIR ? path.join(WORKER_PKG_DIR, 'tools', 'sync-protocol.cjs') : null;

// ── B7 standalone-safe package resolution ─────────────────────────────────
// Architecture suites read extracted-package SOURCES directly. Pre-split the
// authoring checkout lives at packages/<dir>; post-split the backend repo
// keeps its own 15 packages there (§11 composition), while cross-repo trees
// (worker, gpu-hub, web-*) are gone and must be consumed through the npm
// install instead. PKG_SRC resolves the monorepo checkout first and falls
// back to the npm-installed copy of the same package (every published
// @animastor/* backend package ships src/ — verified byte-identical).
function npmPkgDir(spec, fromDir) {
    try {
        const entry = require.resolve(spec, { paths: [fromDir] });
        let dir = path.dirname(entry);
        while (dir !== path.dirname(dir)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
                if (pkg.name === spec) return dir;
            } catch (_) { /* not the package root — keep walking up */ }
            dir = path.dirname(dir);
        }
    } catch (_) { /* package not installed */ }
    return null;
}

function PKG_SRC(dirName, ...relPath) {
    const monorepo = path.join(REPO_ROOT, 'packages', dirName);
    if (fs.existsSync(monorepo)) return relPath.length ? path.join(monorepo, ...relPath) : monorepo;
    // npm fallback: monorepo dir name `animastor-<name>` ↔ npm scope entries
    // are `@animastor/<name>`, EXCEPT the two unscoped packages (ai-connector,
    // comfyui-workflow-connector) whose npm names carry the full animastor-
    // prefix.
    const spec = ['animastor-ai-connector', 'animastor-comfyui-workflow-connector'].includes(dirName)
        ? dirName
        : `@animastor/${dirName.replace(/^animastor-/, '')}`;
    const npmDir = npmPkgDir(spec, path.join(REPO_ROOT, 'backend'));
    if (npmDir) return relPath.length ? path.join(npmDir, ...relPath) : npmDir;
    return null;
}

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
    ORCH_PKG_DIR,
    ORCH_PKG_SRC,
    ORCH_PKG_RUNTIME_DIR,
    ORCH_PKG_ORCH_DIR,
    ORCH_PKG_REL,
    ORCH_PKG_RUNTIME_REL,
    tierDirs,
    tierFiles,
    WORKER_PKG_DIR,
    WORKER_BUNDLE_DIR,
    WORKER_TESTS_DIR,
    SYNC_TOOL_PATH,
    npmPkgDir,
    PKG_SRC,
    listSourceFiles,
    readSource,
    rel,
    requireSpecifiers,
    resolveSpecifier,
};
