// ======================================================
// PHASE 10A — GPU Hub contract freeze guards
// ======================================================
// Freezes the ALREADY-CONFIRMED GPU Hub contract boundaries ahead of the
// Phase 10B+ extraction (verdict B — READY AFTER PREPARATION; see
// docs/architecture/PHASE_10_GPU_HUB_EXTRACTION_READINESS_AUDIT.md and
// docs/architecture/GPU_HUB_CONTRACT.md).
//
// What this suite pins (nothing here defines new behavior):
//   G1  GPU Hub never imports backend/worker/frontend code
//       (directional isolation, mirrors R2/P7-T3 with an allowlist; the
//       SINGLE sanctioned package import is @animastor/contracts — the
//       canonical Job Protocol v2 source, wired by the Phase 10B seam).
//   G2  Job Protocol version does not drift: the hub's PROTOCOL_VERSION is
//       IMPORTED from the canonical @animastor/contracts (runtime equality,
//       Phase 10B) and the hub carries NO local protocol literal.
//   G3  The HTTP route surface is EXACTLY the frozen 14-route set
//       (set equality — removals AND additions both fail).
//   G4  Redis ownership does not change: the hub-owned family set the hub
//       writes is frozen; the backend-owned worker-auth mirror is READ-ONLY
//       for the hub (no write ops on it anywhere in gpu-hub/).
//   G5  Worker token grammar parity: the hub's parseWorkerToken and the
//       canonical backend worker-repo.parseToken produce IDENTICAL outcomes
//       on a fixture matrix (behavioral guard on the hand-synced copy).
//
// Docs: docs/architecture/GPU_HUB_CONTRACT.md (frozen contract, Phase 10A).

const { expect } = require('chai');
const path = require('path');
const { listSourceFiles, readSource, rel, REPO_ROOT } = require('./helpers');

const HUB_DIR = path.join(REPO_ROOT, 'gpu-hub');
const CONTRACTS_IMPL = path.join(REPO_ROOT, 'contracts', 'src', 'job-protocol-v2.js');
const WORKER_REPO = path.join(REPO_ROOT, 'backend', 'src', 'storage', 'postgres', 'repositories', 'worker-repo.js');

// ── G1 — GPU Hub does not import backend/worker/frontend ────────────────

describe('phase10a: GPU Hub import isolation', () => {
    it('hub never requires backend/worker/frontend/monorepo code (contract consumers stay HTTP+Redis only)', () => {
        const banned = /require\(\s*['"][^'"]*(backend\/src|backend\/ai|worker\/worker|frontends|\.\.\/)+/;
        const offenders = [];
        for (const file of listSourceFiles(HUB_DIR)) {
            const src = readSource(file);
            if (banned.test(src)) offenders.push(rel(file));
        }
        expect(offenders,
            'gpu-hub must not require monorepo code — the seam is HTTP + shared Redis only (GPU_HUB_CONTRACT.md §2).').to.deep.equal([]);
    });

    it('hub stays on its frozen npm dependency set (express, cors, ioredis + builtins + the canonical contracts package)', () => {
        // Phase 10B: @animastor/contracts is the ONE sanctioned package
        // import — the canonical Job Protocol v2 source, resolved via the
        // docker-compose read-only mount (./contracts →
        // /app/node_modules/@animastor/contracts, same seam as backend).
        // Any OTHER new bare specifier is still an unreviewed seam decision.
        const allowed = new Set(['express', 'cors', 'crypto', 'fs', 'path', 'ioredis', 'zlib', 'http', 'https', 'url', '@animastor/contracts']);
        const offenders = [];
        for (const file of listSourceFiles(HUB_DIR)) {
            const src = readSource(file);
            for (const m of src.matchAll(/require\(\s*['"]([a-z@][^'"]*)['"]\s*\)/g)) {
                if (!allowed.has(m[1])) offenders.push(`${rel(file)}: ${m[1]}`);
            }
        }
        expect(offenders,
            'a new bare-specifier require in gpu-hub is an unreviewed cross-package seam decision — wire it via a documented migration seam, not ad hoc.').to.deep.equal([]);
    });

    it('hub imports Job Protocol from @animastor/contracts — no local protocol implementation/literal allowed', () => {
        // Phase 10B gate: the hub's protocol source MUST be the canonical
        // package; a hand-synced local copy (inline literal or re-derived
        // implementation) is exactly the Phase 9C residue class this phase
        // removes.
        const hub = require(path.join(HUB_DIR, 'gpu-hub.js'));
        const src = readSource(path.join(HUB_DIR, 'gpu-hub.js'));
        // the import seam itself
        expect(src, 'gpu-hub.js must consume the canonical package').to.include("require('@animastor/contracts')");
        // and carry NO local protocol literal (the 10A single-literal pin
        // becomes a zero-literal pin after the migration)
        const literals = [...src.matchAll(/PROTOCOL_VERSION\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(literals, 'gpu-hub.js must define NO protocol version literal (Phase 9C residue removed in 10B)').to.deep.equal([]);
        // runtime value still equals the canonical one (sanity — same package)
        expect(hub.PROTOCOL_VERSION).to.equal(require(CONTRACTS_IMPL).PROTOCOL_VERSION);
    });
});

// ── G2 — Job Protocol version does not drift ────────────────────────────

describe('phase10a: Job Protocol version freeze', () => {
    const hubPath = path.join(HUB_DIR, 'gpu-hub.js');

    it('hub PROTOCOL_VERSION equals the canonical @animastor/contracts value (runtime equality)', () => {
        const hub = require(hubPath);
        const canonical = require(CONTRACTS_IMPL);
        expect(hub.PROTOCOL_VERSION, 'gpu-hub protocol source must equal contracts canonical').to.equal(canonical.PROTOCOL_VERSION);
    });

    it('hub carries NO local PROTOCOL_VERSION literal (canonical package is the only source)', () => {
        const src = readSource(hubPath);
        const literals = [...src.matchAll(/PROTOCOL_VERSION\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(literals, 'gpu-hub.js must not define a protocol version literal — it consumes @animastor/contracts').to.deep.equal([]);
    });

    it('worker generated copy and hub stay equal to the canonical value (no 3-way drift)', () => {
        const canonical = require(CONTRACTS_IMPL).PROTOCOL_VERSION;
        const workerProto = require(path.join(REPO_ROOT, 'worker', 'worker', 'job-protocol-v2.cjs'));
        const hub = require(hubPath);
        expect(workerProto.PROTOCOL_VERSION).to.equal(canonical);
        expect(hub.PROTOCOL_VERSION).to.equal(canonical);
    });
});

// ── G3 — HTTP route surface is exactly the frozen set ───────────────────

describe('phase10a: GPU Hub route surface freeze', () => {
    // Frozen set — GPU_HUB_CONTRACT.md §3 (13 routes, /worker-source removed Phase 10T).
    const FROZEN_ROUTES = [
        ['POST', '/beacon'],
        ['POST', '/task'],
        ['GET', '/task/next'],
        ['POST', '/task/result'],
        ['POST', '/task/error'],
        ['GET', '/worker-bundle'],
        ['GET', '/worker-bundle/sha256'],
        ['GET', '/workflow/:id'],
        ['GET', '/installer'],
        ['GET', '/installer/bundle'],
        ['GET', '/installer/sha256'],
        ['GET', '/health'],
        ['DELETE', '/queue/clear'],
    ].map(([m, p]) => `${m} ${p}`).sort();

    it('route surface is EXACTLY the frozen 13-route set (additions and removals both fail)', () => {
        const src = readSource(path.join(HUB_DIR, 'gpu-hub.js'));
        const found = [...src.matchAll(/app\.(post|get|delete|put)\(\s*"([^"]+)"/g)]
            .map((m) => `${m[1].toUpperCase()} ${m[2]}`)
            .sort();
        expect(found, 'route surface changed — GPU_HUB_CONTRACT.md §3 is FROZEN; update the contract doc + this guard in the same commit').to.deep.equal(FROZEN_ROUTES);
    });
});

// ── G4 — Redis ownership does not change ────────────────────────────────

describe('phase10a: Redis ownership freeze (hub side)', () => {
    // The hub-owned key constants (values frozen — GPU_HUB_CONTRACT.md §8.1).
    const HUB_KEY_CONSTANTS = [
        'animastor:gpu-hub:workers',
        'animastor:processing-claimed',
        'animastor:dead-letter',
    ];
    // Backend-owned family the hub must only ever READ.
    const MIRROR_KEY = 'animastor:worker-auth';

    it('hub-owned key constants keep their frozen values', () => {
        const src = readSource(path.join(HUB_DIR, 'gpu-hub.js'));
        for (const key of HUB_KEY_CONSTANTS) {
            expect(src).to.include(`'${key}'`);
        }
    });

    it('hub NEVER writes the backend-owned animastor:worker-auth mirror (read-only seam)', () => {
        // Write ops on the mirror key would flip ownership — banned by
        // GPU_HUB_CONTRACT.md §8.2. The hub must hget it, nothing more.
        const writeOps = /\.(hset|hdel|del|set|expire|hsetnx)\s*\(/;
        const offenders = [];
        for (const file of listSourceFiles(HUB_DIR)) {
            const lines = readSource(file).split('\n');
            lines.forEach((line, i) => {
                if (writeOps.test(line) && line.includes(MIRROR_KEY)) {
                    offenders.push(`${rel(file)}:${i + 1}`);
                }
            });
        }
        expect(offenders,
            'animastor:worker-auth is backend-owned (services/worker-auth.js is the only writer); the hub reads it only.').to.deep.equal([]);
    });

    it('hub still reads the mirror and its SYNC anchors are intact', () => {
        const src = readSource(path.join(HUB_DIR, 'gpu-hub.js'));
        expect(src).to.include('WORKER_AUTH_MIRROR_KEY');
        expect(src).to.include('hget(WORKER_AUTH_MIRROR_KEY');
        expect(src).to.include('SYNC: backend/src/services/worker-auth.js');
        // Phase 10B: the protocol SYNC anchor on the backend facade is
        // replaced by direct canonical consumption — the hub requires
        // @animastor/contracts itself (the facade re-exports the same
        // implementation).
        expect(src).to.include("require('@animastor/contracts')");
    });
});

// ── G5 — Worker token grammar parity ────────────────────────────────────

describe('phase10a: worker token grammar parity (hub copy vs canonical)', () => {
    // The hub's parseWorkerToken is a hand-synced copy of the canonical
    // backend worker-repo.parseToken (GPU_HUB_CONTRACT.md §5). This
    // behavioral guard freezes the sync: both implementations must agree on
    // every fixture outcome. The wire format itself is NORMATIVE-FROZEN
    // (`wrk.<worker_id_b64url>.<secret_b64url>`); these are NON-secret
    // fixtures (16-byte secret is enough for parity — hash matching, not
    // issuance).
    const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sha256 = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');

    const UUID = '11111111-2222-3333-4444-555555555555';
    const SECRET = Buffer.from('phase10a-parity-secret');

    const FIXTURES = [
        { name: 'valid token', token: `wrk.${b64url(Buffer.from(UUID))}.${b64url(SECRET)}` },
        { name: 'uppercase UUID', token: `wrk.${b64url(Buffer.from(UUID.toUpperCase()))}.${b64url(SECRET)}` },
        { name: 'empty secret', token: `wrk.${b64url(Buffer.from(UUID))}.` },
        { name: 'wrong prefix', token: `sid.${b64url(Buffer.from(UUID))}.${b64url(SECRET)}` },
        { name: 'two segments', token: `wrk.${b64url(Buffer.from(UUID))}` },
        { name: 'four segments', token: `wrk.a.b.c` },
        { name: 'non-UUID self-locator', token: `wrk.${b64url(Buffer.from('not-a-uuid'))}.${b64url(SECRET)}` },
        { name: 'empty string', token: '' },
        { name: 'null', token: null },
        { name: 'undefined', token: undefined },
        { name: 'non-string', token: 12345 },
    ];

    let hubOut;
    let canonicalOut;

    before(() => {
        const hub = require(path.join(HUB_DIR, 'gpu-hub.js'));
        const repo = require(WORKER_REPO);
        hubOut = FIXTURES.map((f) => ({ name: f.name, parsed: hub.parseWorkerToken(f.token) }));
        canonicalOut = FIXTURES.map((f) => ({ name: f.name, parsed: repo.parseToken(f.token) }));
    });

    it('accept/reject decisions match on every fixture', () => {
        for (let i = 0; i < FIXTURES.length; i++) {
            expect(hubOut[i].parsed === null, `hub decision for "${FIXTURES[i].name}"`).to.equal(canonicalOut[i].parsed === null);
        }
    });

    it('workerId and secretHash match exactly on every accepted fixture', () => {
        for (let i = 0; i < FIXTURES.length; i++) {
            if (canonicalOut[i].parsed === null) continue;
            expect(hubOut[i].parsed.workerId, `workerId for "${FIXTURES[i].name}"`)
                .to.equal(canonicalOut[i].parsed.workerId);
            expect(hubOut[i].parsed.secretHash, `secretHash for "${FIXTURES[i].name}"`)
                .to.equal(canonicalOut[i].parsed.secretHash);
        }
    });

    it('canonical grammar contract holds (shape sanity on the wire format)', () => {
        const good = canonicalOut[0].parsed;
        expect(good.workerId).to.equal(UUID);
        expect(good.secretHash).to.equal(sha256(SECRET));
    });
});
