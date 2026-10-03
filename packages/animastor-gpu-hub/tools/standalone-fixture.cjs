#!/usr/bin/env node
// ============================================================================
// G4/G5 fixture — POST-SPLIT standalone proof helper (prep plan §2.2/§2.5)
// ============================================================================
// Pre-split there are no published Release assets yet, so this tool builds a
// LOCAL, byte-faithful stand-in for the future release flow:
//
//   make <dir>    materialises, from the committed GROUPS (single source of
//                 truth = tools/update-artifacts-lock.cjs):
//                   <dir>/assets/<asset_filename>   — 4 release zips whose
//                     entries are exactly the staged group layouts;
//                   <dir>/artifacts.lock.json       — the committed lock with
//                     sha256_asset filled in for THESE zips (the committed
//                     lock keeps null until the first real release, §2.5);
//                   <dir>/repo/                     — simulated standalone
//                     animastor-gpu-hub repo (§8.5 whitelist subset): hub
//                     package + root scripts/check-artifacts.sh only, with
//                     NO backend/, NO packages/animastor-worker, NO
//                     packages/animastor-installer.
//
//   serve <dir>   static HTTP server on 127.0.0.1 (port 0 → printed as
//                 "PORT=<n>" on stdout, runs until killed). Files are served
//                 by basename, so the stager URL
//                 <base>/<repo>/releases/download/<tag>/<asset> resolves to
//                 <dir>/<asset> — same path shape as github.com.
//
// The fixture is test scaffolding ONLY: it lets G4/G5 exercise the real
// stager-release path (fetch → sha256_asset verify → sha256_tree gate →
// COPY --from=stager) without publishing anything.
//
// Exit 0 = ok. Requires python3 (zip writer) for `make`.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HUB_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(HUB_DIR, '..', '..');
const LOCK_PATH = path.join(HUB_DIR, 'artifacts.lock.json');
const DOCKERFILE = path.join(HUB_DIR, 'Dockerfile');

const { GROUPS, groupFileList } = require('./update-artifacts-lock.cjs');

const PY_ZIP = `
import json, sys, zipfile
for s in json.loads(sys.argv[1]):
    with zipfile.ZipFile(s["zip"], "w", zipfile.ZIP_DEFLATED) as z:
        for e in s["entries"]:
            z.write(e["abs"], e["arc"])
`;

function die(msg) {
    console.error(`standalone-fixture: ${msg}`);
    process.exit(1);
}

function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ── make ────────────────────────────────────────────────────────────────────

function make(dir) {
    if (!fs.existsSync(LOCK_PATH)) die(`lock not found: ${LOCK_PATH}`);

    // 1. release zips — exact staged layouts from the shared GROUPS walk
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    const specs = GROUPS.map((g) => ({
        zip: path.join(assets, g.asset_filename),
        entries: groupFileList(g).map((e) => ({ abs: e.abs, arc: e.rel })),
    }));
    const res = spawnSync('python3', ['-c', PY_ZIP, JSON.stringify(specs)], {
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    if (res.error) die(`python3 unavailable (${res.error.message}) — zip writer needs python3`);
    if (res.status !== 0) die(`zip creation failed (python3 exit ${res.status})`);

    // 2. test-pinned lock: committed lock + sha256_asset of THESE zips
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    for (const g of GROUPS) {
        const z = path.join(assets, g.asset_filename);
        if (!fs.existsSync(z)) die(`zip missing after generation: ${z}`);
        lock.artifacts[g.name].sha256_asset = sha256File(z);
    }
    const pinnedLock = JSON.stringify(lock, null, 2) + '\n';
    fs.writeFileSync(path.join(dir, 'artifacts.lock.json'), pinnedLock);

    // 3. simulated standalone repo — §8.5 whitelist subset, hub paths only
    const repo = path.join(dir, 'repo');
    const pkg = path.join(repo, 'packages', 'animastor-gpu-hub');
    fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    for (const f of ['Dockerfile', 'package.json', 'gpu-hub.js', 'server.js',
        'tarball.js', 'bootstrap.js', 'README.md', 'LICENSE']) {
        fs.copyFileSync(path.join(HUB_DIR, f), path.join(pkg, f));
    }
    for (const f of ['verify-staged-artifacts.sh', 'fetch-pinned-assets.sh']) {
        fs.copyFileSync(path.join(HUB_DIR, 'scripts', f), path.join(pkg, 'scripts', f));
    }
    fs.copyFileSync(path.join(HUB_DIR, 'scripts', '..', '..', '..', 'scripts', 'check-artifacts.sh'),
        path.join(repo, 'scripts', 'check-artifacts.sh'));
    fs.writeFileSync(path.join(pkg, 'artifacts.lock.json'), pinnedLock);

    // 4. forbidden monorepo paths must be physically absent from the fixture
    const banned = [/animastor-worker/, /animastor-installer/, /(^|\/)backend\//];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            const rel = path.relative(repo, full).split(path.sep).join('/');
            if (banned.some((re) => re.test(rel))) {
                die(`simulated standalone repo contains a monorepo path: ${rel}`);
            }
            if (e.isDirectory()) walk(full);
        }
    };
    walk(repo);

    console.log(`fixture ready: ${specs.length} zips + pinned lock + standalone repo → ${dir}`);
}

// ── serve ───────────────────────────────────────────────────────────────────

function serve(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die(`asset dir not found: ${dir}`);
    const server = http.createServer((req, res) => {
        let name;
        try {
            name = path.basename(new URL(req.url, 'http://localhost').pathname);
        } catch (_) {
            res.statusCode = 400; res.end('bad request'); return;
        }
        const file = path.join(dir, name);
        if (!name || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.statusCode = 404; res.end('not found'); return;
        }
        res.setHeader('Content-Type', 'application/zip');
        res.end(fs.readFileSync(file));
    });
    server.on('error', (err) => die(`serve failed: ${err.message}`));
    server.listen(0, '127.0.0.1', () => {
        // Machine-readable line consumed by g4/g5 (port = ephemeral, always fresh
        // → the stager fetch RUN layer is cache-busted on every guard run).
        console.log(`PORT=${server.address().port}`);
    });
}

// ── cli ─────────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
if (cmd === 'make') {
    const dir = process.argv[3];
    if (!dir) die('usage: standalone-fixture.cjs make <dir>');
    make(path.resolve(dir));
} else if (cmd === 'serve') {
    const dir = process.argv[3];
    if (!dir) die('usage: standalone-fixture.cjs serve <asset-dir>');
    serve(path.resolve(dir));
} else {
    die('usage: standalone-fixture.cjs make <dir> | serve <asset-dir>');
}
