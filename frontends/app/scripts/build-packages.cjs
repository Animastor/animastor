// ============================================================
// B8 — canonical Web build aggregator
// ============================================================
// Single entrypoint behind `npm run build:packages` that works
// BOTH pre-split (this app lives in the monorepo, sibling packages
// are checked out at ../../packages/animastor-web-*) AND post-split
// (animastor-web standalone repo: the 13 @animastor/web-* packages
// arrive through `npm ci` from the npm registry).
//
// Resolution per package, fail-fast (exit 1 on the first failure):
//   1. Sibling monorepo checkout  ../../packages/animastor-web-*
//      (contains src/ — the authoring layout).
//   2. npm install copy           node_modules/@animastor/<pkg>/
//      (published tarballs ship dist/ + src/; dist/ is prebuilt —
//      `npm run build` inside it is skipped, nothing to rebuild).
//
// The helper NEVER references `../../packages` for anything else and
// never creates symlinks or file: dependencies — G1-invariant holds.
// After the physical split of animastor-web the first branch simply
// never matches and step 2 covers everything, unchanged.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_DIR = __dirname; // frontends/app/scripts
const PACKAGES_DIR = path.resolve(APP_DIR, '..', '..', '..', 'packages');
const NODE_MODULES = path.resolve(APP_DIR, '..', 'node_modules', '@animastor');

const WEB_PACKAGES = [
    'web-ai-chat',
    'web-book-session',
    'web-editor',
    'web-file',
    'web-generator',
    'web-generator-config',
    'web-generator-sse',
    'web-generator-vbook',
    'web-local-ai',
    'web-navigator',
    'web-player',
    'web-settings',
    'web-workers',
];

function findPackageDir(name) {
    // 1) Monorepo sibling checkout (pre-split layout).
    const sibling = path.join(PACKAGES_DIR, `animastor-${name}`);
    if (fs.existsSync(path.join(sibling, 'package.json'))) return sibling;

    // 2) npm registry copy installed by `npm ci` (post-split layout;
    //    also the fallback when siblings are absent pre-split).
    const installed = path.join(NODE_MODULES, name);
    if (fs.existsSync(path.join(installed, 'package.json'))) return installed;

    return null;
}

let failures = 0;

for (const name of WEB_PACKAGES) {
    const dir = findPackageDir(name);

    if (!dir) {
        console.error(`[build:packages] FATAL: @animastor/${name} not found ` +
            `neither as a sibling checkout (${PACKAGES_DIR}/animastor-${name}) ` +
            `nor in node_modules (${NODE_MODULES}/${name}). ` +
            `Run \`npm ci\` first.`);
        failures++;
        break; // fail-fast
    }

    const distEntry = path.join(dir, 'dist', 'index.js');
    const isNpmCopy = dir.startsWith(NODE_MODULES + path.sep);

    if (isNpmCopy && fs.existsSync(distEntry)) {
        // Published tarball already carries dist/ — skip the rebuild.
        console.log(`[build:packages] @animastor/${name}: npm copy has dist/ — skip`);
        continue;
    }

    console.log(`[build:packages] @animastor/${name}: npm run build (${path.relative(process.cwd(), dir)})`);
    const res = spawnSync('npm', ['run', 'build'], {
        cwd: dir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });

    if (res.status !== 0) {
        console.error(`[build:packages] FATAL: build failed for @animastor/${name} (exit ${res.status})`);
        failures++;
        break; // fail-fast — same contract as the previous shell one-liner
    }
}

if (failures > 0) process.exit(1);
console.log('[build:packages] all 13 @animastor/web-* packages resolved and built');
