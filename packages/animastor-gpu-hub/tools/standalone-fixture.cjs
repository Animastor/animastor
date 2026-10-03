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
//   assets-from-release <dir> <base> [lock]
//                 materialises the 4 groups PURELY from a release URL —
//                 the POST-SPLIT acquisition path (no monorepo source tree is
//                 read): downloads
//                   <base>/<source_repository>/releases/download/<tag>/<asset>
//                 for every entry of <lock> (default: the committed pin file),
//                 verifies each body against sha256_asset, and writes
//                   <dir>/assets/<asset_filename>  (the downloaded zips)
//                   <dir>/artifacts.lock.json      (the pin file, verbatim)
//                   <dir>/repo/                    (same simulated standalone
//                                                   repo as `make`)
//                 Pre-split the committed pin is still null (§2.5), so G5
//                 passes the fixture's test-pinned lock and a local base
//                 (the stand-in release); post-split it passes the committed
//                 pin and the real GitHub base. Same code, same checks.
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
// Exit 0 = ok. `make` requires python3 (zip writer).
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

// ── shared: simulated standalone repo (§8.5 whitelist subset) ──────────────

function synthesizeRepo(dir, lockText) {
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
    fs.writeFileSync(path.join(pkg, 'artifacts.lock.json'), lockText);

    // forbidden monorepo paths must be physically absent from the fixture
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
    return repo;
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

    // 3. simulated standalone repo
    synthesizeRepo(dir, pinnedLock);

    console.log(`fixture ready: ${specs.length} zips + pinned lock + standalone repo → ${dir}`);
}

// ── assets-from-release (POST-SPLIT acquisition path) ──────────────────────
// Reads the pin file ONLY — never a monorepo source tree.

function download(url, dest, redirectsLeft) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https:') ? require('https') : http;
        const req = mod.get(url, { headers: { 'user-agent': 'animastor-gpu-hub-assets' } }, (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error(`too many redirects for ${url}`));
                return resolve(download(new URL(res.headers.location, url).toString(), dest, redirectsLeft - 1));
            }
            if (status !== 200) { res.resume(); return reject(new Error(`HTTP ${status} for ${url}`)); }
            const out = fs.createWriteStream(dest);
            out.on('error', reject);
            out.on('close', resolve);
            res.pipe(out);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error(`timeout for ${url}`)));
    });
}

async function assetsFromRelease(dir, base, lockPath) {
    const src = lockPath || LOCK_PATH;
    if (!fs.existsSync(src)) die(`lock not found: ${src}`);
    const lockText = fs.readFileSync(src, 'utf8');
    const lock = JSON.parse(lockText);
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(assets, { recursive: true });

    for (const g of GROUPS) {
        const entry = lock.artifacts && lock.artifacts[g.name];
        if (!entry) die(`'${g.name}' missing from ${src}`);
        const sha = entry.sha256_asset;
        if (!sha || sha === 'null') {
            die(`'${g.name}' has no sha256_asset pin in ${src} — pin the released zip (POST-SPLIT, prep plan §2.5)`);
        }
        if (!/^[0-9a-f]{64}$/.test(sha)) die(`'${g.name}'.sha256_asset is not a 64-char hex digest`);
        const url = `${String(base).replace(/\/+$/, '')}/${entry.source_repository}` +
            `/releases/download/${entry.release_tag}/${entry.asset_filename}`;
        const dest = path.join(assets, entry.asset_filename);
        process.stdout.write(`  fetch: ${g.name} <- ${entry.asset_filename}\n`);
        await download(url, dest, 5);
        const actual = sha256File(dest);
        if (actual !== sha) die(`asset sha256 mismatch for '${g.name}': downloaded=${actual} pinned=${sha}`);
    }

    fs.writeFileSync(path.join(dir, 'artifacts.lock.json'), lockText);
    synthesizeRepo(dir, lockText);
    console.log(`release assets materialised (sha256_asset verified): ${GROUPS.length}/4 → ${dir}`);
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
        // Machine-readable line consumed by g4/g5. The port is ephemeral
        // (always fresh) and g4/g5 additionally append a per-run id to
        // RELEASE_URL_BASE → the stager fetch RUN layer is cache-busted on
        // every guard run, so a tampered asset can never be served from cache.
        console.log(`PORT=${server.address().port}`);
    });
}

// ── cli ─────────────────────────────────────────────────────────────────────

const USAGE = 'usage: standalone-fixture.cjs make <dir> | assets-from-release <dir> <base> [lock] | serve <asset-dir>';

function main() {
    const cmd = process.argv[2];
    if (cmd === 'make') {
        const dir = process.argv[3];
        if (!dir) die(USAGE);
        make(path.resolve(dir));
    } else if (cmd === 'assets-from-release') {
        const dir = process.argv[3];
        const base = process.argv[4];
        if (!dir || !base) die(USAGE);
        const lock = process.argv[5] ? path.resolve(process.argv[5]) : undefined;
        return assetsFromRelease(path.resolve(dir), base, lock);
    } else if (cmd === 'serve') {
        const dir = process.argv[3];
        if (!dir) die(USAGE);
        serve(path.resolve(dir));
    } else {
        die(USAGE);
    }
    return undefined;
}

Promise.resolve(main()).catch((err) => die(err.message || String(err)));
