#!/usr/bin/env node
'use strict';

/**
 * GPU Hub package test runner — standalone, ZERO external dependencies.
 *
 * Runs entirely inside the package boundary (no mocha, no backend helpers),
 * so `npm test` works in a fresh `npm ci` tree. Monorepo-side hub suites
 * (backend/tests/gpu-hub-*.test.js + tests/architecture/*) keep running
 * against the same sources — this runner ADDS package-boundary checks, it
 * does not replace the canonical suites.
 *
 * Check groups (Phase 10T.1):
 *   1. package smoke       — package identity + runtime modules load
 *   2. dependency isolation— no monorepo imports; frozen npm specifier set
 *   3. canonical contracts — protocol consumed from @animastor/contracts,
 *                            no local literal
 *   4. protocol parity     — hub vs worker vs contracts PROTOCOL_VERSION
 *   5. route freeze        — EXACT frozen 13-route HTTP surface
 *   6. Redis ownership     — hub-owned constants frozen; backend-owned
 *                            animastor:worker-auth never written by the hub
 *   7. artifact bake-in    — 4 artifact groups present; runtime resolution
 *                            uses /app/artifacts; no monorepo mount leaks
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PKG_ROOT = path.resolve(__dirname, '..');
const RUNTIME_FILES = ['gpu-hub.js', 'server.js', 'tarball.js', 'bootstrap.js'];

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL - ${name}`);
    console.log(`         ${String(err && err.message ? err.message : err).split('\n')[0]}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function readPkg() {
  return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
}

function listSourceFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(js|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function readSource(p) {
  return fs.readFileSync(p, 'utf8');
}

// ── 1. package smoke ─────────────────────────────────────────────────────

console.log('\n[1/7] package smoke');

check('package identity is @animastor/gpu-hub@0.1.0', () => {
  const pkg = readPkg();
  assert(pkg.name === '@animastor/gpu-hub', `name=${pkg.name}`);
  assert(pkg.version === '0.1.0', `version=${pkg.version}`);
});

check('package declares MIT license + node >= 18 engines', () => {
  const pkg = readPkg();
  assert(pkg.license === 'MIT', `license=${pkg.license}`);
  assert(pkg.engines && /18|20|>=/.test(String(pkg.engines.node)), 'engines.node missing');
});

check('LICENSE file present inside package boundary', () => {
  const src = readSource(path.join(PKG_ROOT, 'LICENSE'));
  assert(src.includes('MIT License'), 'LICENSE is not MIT');
  assert(src.includes('Animastor'), 'LICENSE copyright holder missing');
});

check('README.md present and covers required sections', () => {
  const src = readSource(path.join(PKG_ROOT, 'README.md'));
  for (const section of ['Standalone run', 'Required env', 'Exposed port', 'HTTP contract', 'Redis dependency', 'Backend callback', 'Job Protocol v2', 'Security warning']) {
    assert(src.includes(section), `README missing section: ${section}`);
  }
});

check('runtime modules load and expose the hub factory', () => {
  const hub = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  assert(typeof hub.buildHubApp === 'function', 'buildHubApp missing');
  assert(typeof hub.parseWorkerToken === 'function', 'parseWorkerToken missing');
  assert(typeof hub.PROTOCOL_VERSION === 'number', 'PROTOCOL_VERSION missing');
});

check('buildHubApp factory constructs with a stub Redis (no eager connections)', () => {
  const { buildHubApp } = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  const noop = () => {};
  const stub = { get: noop, set: noop, del: noop, hget: noop, hset: noop, llen: noop, keys: noop, expire: noop, hdel: noop, lpush: noop, rpush: noop, lrem: noop, lrange: noop, hgetall: noop, smembers: noop, sadd: noop, srem: noop, incr: noop, ttl: noop, pexpire: noop, multi: () => ({ exec: noop, llen: noop, lpush: noop, hset: noop, expire: noop }) };
  const app = buildHubApp({ redis: stub, config: {} });
  assert(typeof app === 'function', 'buildHubApp must return an express app');
  assert(app.__hub && typeof app.__hub.stopIntervals === 'function', 'hub internals (stopIntervals) not exposed');
});

// ── 2. dependency isolation ──────────────────────────────────────────────

console.log('\n[2/7] dependency isolation');

check('runtime files never require monorepo code (backend/worker/frontend/parent escapes)', () => {
  const banned = /require\(\s*['"][^'"]*(backend\/src|backend\/ai|worker\/worker|frontends|\.\.\/)+/;
  const offenders = [];
  for (const file of RUNTIME_FILES) {
    const src = readSource(path.join(PKG_ROOT, file));
    if (banned.test(src)) offenders.push(file);
  }
  assert(offenders.length === 0, `monorepo requires in: ${offenders.join(', ')}`);
});

check('bare requires stay on the frozen npm specifier set + @animastor/contracts', () => {
  const allowed = new Set(['express', 'cors', 'crypto', 'fs', 'path', 'ioredis', 'zlib', 'http', 'https', 'url', '@animastor/contracts']);
  const offenders = [];
  for (const file of RUNTIME_FILES) {
    const src = readSource(path.join(PKG_ROOT, file));
    for (const m of src.matchAll(/require\(\s*['"]([a-z@][^'"]*)['"]\s*\)/g)) {
      if (!allowed.has(m[1])) offenders.push(`${file}: ${m[1]}`);
    }
  }
  assert(offenders.length === 0, `new bare requires: ${offenders.join(', ')}`);
});

check('package.json declares exactly the frozen dependency set', () => {
  const pkg = readPkg();
  assert(JSON.stringify(Object.keys(pkg.dependencies || {}).sort()) === JSON.stringify(['@animastor/contracts', 'cors', 'express', 'ioredis']), 'unexpected dependencies');
  assert(!pkg.optionalDependencies, 'optionalDependencies removed — contracts is now a regular dependency');
  assert(!pkg.devDependencies, 'devDependencies appeared — keep the package runtime-only');
});

check('hub sources stay pg/postgres-free', () => {
  const offenders = [];
  for (const file of RUNTIME_FILES) {
    const src = readSource(path.join(PKG_ROOT, file));
    if (/\brequire\(['"]pg['"]\)|from ['"]pg['"]/.test(src)) offenders.push(file);
  }
  assert(offenders.length === 0, `pg requires in: ${offenders.join(', ')}`);
});

// ── 3. canonical contracts import ────────────────────────────────────────

console.log('\n[3/7] canonical contracts import');

check('gpu-hub.js consumes @animastor/contracts (the single protocol source)', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  assert(src.includes("require('@animastor/contracts')"), 'canonical import seam missing');
});

check('hub carries NO local PROTOCOL_VERSION literal', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  const literals = [...src.matchAll(/PROTOCOL_VERSION\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  assert(literals.length === 0, `local protocol literal(s) found: ${literals.join(', ')}`);
});

check('@animastor/contracts resolves inside the package tree (registry or provided node_modules)', () => {
  const resolved = require.resolve('@animastor/contracts', { paths: [PKG_ROOT] });
  assert(resolved.includes('@animastor/contracts'), `unexpected resolution: ${resolved}`);
});

// ── 4. protocol parity ───────────────────────────────────────────────────

console.log('\n[4/7] protocol parity');

check('hub PROTOCOL_VERSION equals the canonical @animastor/contracts value', () => {
  const hub = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  const canonicalPkg = require(require.resolve('@animastor/contracts', { paths: [PKG_ROOT] }));
  const canonical = canonicalPkg.jobProtocolV2 || canonicalPkg;
  assert(hub.PROTOCOL_VERSION === canonical.PROTOCOL_VERSION, `hub=${hub.PROTOCOL_VERSION} canonical=${canonical.PROTOCOL_VERSION}`);
});

// ── 5. route freeze ──────────────────────────────────────────────────────

console.log('\n[5/7] route freeze');

check('route surface is EXACTLY the frozen 13-route set (additions and removals both fail)', () => {
  const FROZEN_ROUTES = [
    'POST /beacon', 'POST /task', 'GET /task/next', 'POST /task/result',
    'POST /task/error', 'GET /worker-bundle',
    'GET /worker-bundle/sha256', 'GET /workflow/:id', 'GET /installer',
    'GET /installer/bundle', 'GET /installer/sha256', 'GET /health',
    'DELETE /queue/clear',
  ].sort();
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  const found = [...src.matchAll(/app\.(post|get|delete|put)\(\s*"([^"]+)"/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`)
    .sort();
  assert(JSON.stringify(found) === JSON.stringify(FROZEN_ROUTES),
    `route surface drifted.\nfound:    ${JSON.stringify(found)}\nfrozen:   ${JSON.stringify(FROZEN_ROUTES)}`);
});

// ── 6. Redis ownership ───────────────────────────────────────────────────

console.log('\n[6/7] Redis ownership');

check('hub-owned key constants keep their frozen values', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  for (const key of ['animastor:gpu-hub:workers', 'animastor:processing-claimed', 'animastor:dead-letter']) {
    assert(src.includes(`'${key}'`), `frozen key constant missing: ${key}`);
  }
});

check('hub NEVER writes the backend-owned animastor:worker-auth mirror', () => {
  const MIRROR_KEY = 'animastor:worker-auth';
  const writeOps = /\.(hset|hdel|del|set|expire|hsetnx)\s*\(/;
  const offenders = [];
  for (const file of RUNTIME_FILES) {
    const lines = readSource(path.join(PKG_ROOT, file)).split('\n');
    lines.forEach((line, i) => {
      if (writeOps.test(line) && line.includes(MIRROR_KEY)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert(offenders.length === 0, `mirror write ops: ${offenders.join(', ')}`);
});

check('hub still reads the mirror + SYNC anchors intact (frozen worker-auth debt)', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  for (const anchor of ['WORKER_AUTH_MIRROR_KEY', 'hget(WORKER_AUTH_MIRROR_KEY', 'SYNC: backend/src/services/worker-auth.js']) {
    assert(src.includes(anchor), `SYNC anchor missing: ${anchor}`);
  }
});

// ── 7. artifact bake-in ────────────────────────────────────────────────────

console.log('\n[7/7] artifact bake-in');

check('resolveArtifactDir() checks baked-in artifacts/ first, then mount fallback', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  // Must define ARTIFACT_BASE as path.join(__dirname, 'artifacts')
  assert(src.includes("path.join(__dirname, 'artifacts')") || src.includes('path.join(__dirname, "artifacts")'),
    'ARTIFACT_BASE must resolve to __dirname/artifacts');
  // Must call fs.existsSync on the baked-in path
  assert(src.includes('fs.existsSync(bakedPath)'), 'resolveArtifactDir must check fs.existsSync(bakedPath)');
  // Must have all 5 resolveArtifactDir calls
  const calls = [...src.matchAll(/resolveArtifactDir\(/g)];
  assert(calls.length >= 5, `expected >=5 resolveArtifactDir calls, found ${calls.length}`);
});

check('frozen mount fallback paths match docker/compose/overlay-gpu-hub-local.yml targets', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  const frozenFallbacks = [
    '/app/worker-bundle',
    '/app/workflows',
    '/app/installer-src',
    '/app/install-manifests',
  ];
  for (const fb of frozenFallbacks) {
    assert(src.includes(`'${fb}'`) || src.includes(`"${fb}"`),
      `mount fallback ${fb} missing from resolveArtifactDir calls`);
  }
});

check('no /worker-source references in runtime code', () => {
  const offenders = [];
  for (const file of RUNTIME_FILES) {
    const src = readSource(path.join(PKG_ROOT, file));
    if (src.includes('/worker-source')) offenders.push(file);
  }
  assert(offenders.length === 0, `/worker-source still referenced in: ${offenders.join(', ')}`);
});

check('Dockerfile contains multi-stage artifact bake-in', () => {
  const dockerfile = readSource(path.join(PKG_ROOT, 'Dockerfile'));
  assert(dockerfile.includes('AS stager'), 'Dockerfile missing stager stage');
  assert(dockerfile.includes('COPY --from=stager'), 'Dockerfile missing COPY --from=stager');
  assert(dockerfile.includes('/app/artifacts/'), 'Dockerfile missing /app/artifacts/ target');
  // Must verify all 4 groups at build time
  for (const d of ['worker-bundle', 'workflows', 'installer-src', 'install-manifests']) {
    assert(dockerfile.includes(d), `Dockerfile missing artifact group: ${d}`);
  }
});

// ── summary ──────────────────────────────────────────────────────────────

console.log(`\n========================================`);
console.log(` gpu-hub package tests: ${passed} passed, ${failed} failed`);
console.log(`========================================`);

if (failed > 0) {
  for (const f of failures) {
    console.error(`\nFAIL: ${f.name}`);
    console.error(f.err && f.err.stack ? f.err.stack : String(f.err));
  }
  process.exit(1);
}
