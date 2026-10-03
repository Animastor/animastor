#!/usr/bin/env node
// ============================================================================
// G2 — deep-subpath ↔ package `exports` guard  (prep plan §10 / §1.2, B4)
// ============================================================================
// Scans source files for specifiers of the shape
//     '@animastor/<pkg>/<sub/path>'
// and requires the subpath to be covered by that package's `exports` map.
//
// Rules (exactly what B4 fixed as an invariant):
//   * a package WITHOUT an `exports` map resolves any subpath (Node default)
//     → allowed, counted as "no-exports";
//   * a package WITH `exports` only allows the declared keys (`*` wildcards
//     supported, as in @animastor/vbook-runtime "./lazy-book/*");
//   * a subpath that is deliberately NOT exported and is asserted to throw
//     (negative control: `expect(() => require('…')).to.throw()`) is counted
//     as an expected denial — it must not become reachable;
//   * anything else is a violation.
//
// The scan covers the consumer surfaces that exist in this checkout:
//     backend/src, backend/tests, frontends/app/src,
//     packages/<pkg>/{src,test,tests}
// Paths that do not exist are skipped, so the same file works before and
// after the physical split.
//
// Usage:  node scripts/split-guards/g2-exports-scan.cjs
// Exit 0 = G2 green, exit 1 = violation(s).
// ============================================================================

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "build", "coverage", "new", "image"]);
const SPEC_RE = /['"](@animastor\/[a-z0-9][a-z0-9-]*)(\/[^'"\s)]+)?['"]/g;

// ── package registry: name → { dir, exports } ──────────────────────────────
const packages = new Map();
const packagesDir = path.join(ROOT, "packages");
if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir)) {
        const pkgJson = path.join(packagesDir, entry, "package.json");
        if (!fs.existsSync(pkgJson)) continue;
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
        } catch (_) {
            continue;
        }
        if (!manifest.name) continue;
        packages.set(manifest.name, {
            dir: path.join(packagesDir, entry),
            exports: Object.prototype.hasOwnProperty.call(manifest, "exports")
                ? manifest.exports
                : undefined,
        });
    }
}

// ── exports key matching ───────────────────────────────────────────────────
function exportKeys(exportsField) {
    const keys = [];
    const walk = (node) => {
        if (node == null) return;
        if (typeof node === "string") { keys.push("."); return; }
        if (typeof node !== "object") return;
        for (const [k, v] of Object.entries(node)) {
            if (k.startsWith("./")) keys.push(k);
            else walk(v); // conditional exports ("import"/"require"/…)
        }
    };
    walk(exportsField);
    return [...new Set(keys)];
}

function keyMatches(key, subpath) {
    if (key === subpath) return true;
    if (!key.includes("*")) return false;
    const re = new RegExp(
        "^" + key.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
    );
    return re.test(subpath);
}

function covered(pkgExports, subpath) {
    // subpath is normalised to the exports-key form ("./…"; "./" = root)
    if (pkgExports === undefined) return true;          // no exports map → any subpath resolves
    if (typeof pkgExports === "string") return subpath === "./";
    return exportKeys(pkgExports).some((k) => keyMatches(k, subpath));
}

// ── file walking ───────────────────────────────────────────────────────────
function walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            walk(path.join(dir, e.name), out);
        } else if (e.isFile() && /\.(c?js|mjs|cts|ts|tsx|jsx)$/.test(e.name)) {
            out.push(path.join(dir, e.name));
        }
    }
}

function scanRoots() {
    const roots = ["backend/src", "backend/tests", "frontends/app/src"];
    if (fs.existsSync(packagesDir)) {
        for (const entry of fs.readdirSync(packagesDir)) {
            for (const sub of ["src", "test", "tests"]) {
                const p = path.join(packagesDir, entry, sub);
                if (fs.existsSync(p)) roots.push(path.relative(ROOT, p));
            }
        }
    }
    return roots.map((r) => path.join(ROOT, r)).filter((p) => fs.existsSync(p));
}

// ── scan ───────────────────────────────────────────────────────────────────
const files = [];
for (const root of scanRoots()) walk(root, files);

const violations = [];
const expectedDenials = [];
const noExports = new Set();
let deepHits = 0;

for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
        const trimmed = line.trim();
        // skip commentary — specifiers in comments/docs are not imports
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        SPEC_RE.lastIndex = 0;
        let m;
        while ((m = SPEC_RE.exec(line)) !== null) {
            const [, name, sub] = m;
            if (!sub) continue; // root specifier — always fine
            deepHits += 1;
            const pkg = packages.get(name);
            if (!pkg) continue; // not a monorepo package (external scope collision)
            if (pkg.exports === undefined) { noExports.add(name); continue; }
            const bare = sub.replace(/^\/+/, "");
            const subpath = "./" + bare;
            if (covered(pkg.exports, subpath)) continue;
            if (/\bto\.throw\s*\(|\bthrows?\s*\(/.test(line)) {
                // negative control: the deep import MUST keep failing
                expectedDenials.push(`${path.relative(ROOT, file)}:${i + 1}  ${name}/${bare}`);
                continue;
            }
            violations.push(`${path.relative(ROOT, file)}:${i + 1}  ${name}/${bare}`);
        }
    });
}

console.log("== G2: deep subpath ↔ exports ==");
console.log(`  scanned files: ${files.length}`);
console.log(`  deep specifiers found: ${deepHits}`);
if (noExports.size) console.log(`  packages without an exports map (deep paths resolvable by Node): ${[...noExports].sort().join(", ")}`);
if (expectedDenials.length) {
    console.log(`  negative controls (must keep throwing): ${expectedDenials.length}`);
    for (const d of expectedDenials) console.log(`    - ${d}`);
}

if (violations.length) {
    console.error("G2 FAILED — deep import(s) not covered by the package exports map:");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
}
console.log("G2: PASSED");
process.exit(0);
