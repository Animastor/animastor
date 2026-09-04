// ======================================================
// GUARDRAIL 2 — Redis keyspace ownership (Phase 1)
// ======================================================
// 1. The registry (redis-registry.js) is the documented owner map.
// 2. Cross-module writes are frozen: the current debt baseline is pinned
//    below; NEW cross-owner writes from backend into gpu-hub-owned
//    families (and vice versa) fail this test.
// 3. New key families must be registered — an unregistered animastor:*
//    family in backend src / gpu-hub is a failure.
// Docs: docs/architecture/PHASE_1_GUARDRAILS.md §Redis ownership.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { listSourceFiles, readSource, rel, REPO_ROOT } = require('./helpers');
const { REDIS_OWNERSHIP } = require('./redis-registry');

// ── Frozen debt baseline: cross-owner Redis writes that exist today ──
// Phase 1 documents them; Phase 5 (hub API) removes them. Do NOT add here.
const CROSS_OWNER_WRITE_BASELINE = [
    {
        file: 'backend/src/routes/worker-routes.cjs',
        family: 'animastor:gpu-hub:workers',
        op: 'hdel',
        note: 'purge route deletes from the hub-owned workers registry',
    },
    {
        file: 'backend/src/routes/worker-routes.cjs',
        family: 'animastor:queue:*:policy:*',
        op: 'rpoplpush/lrem/lpush',
        note: 'drainPolicyLane() mutates hub policy lanes and strips task bodies',
    },
    {
        file: 'backend/src/routes/worker-routes.cjs',
        family: 'animastor:worker:heartbeat:*',
        op: 'del',
        note: 'purge route deletes a hub-authored heartbeat key (TTL makes it benign)',
    },
    {
        file: 'backend/src/runtime/worker-health.js',
        family: 'animastor:worker:heartbeat:*',
        op: 'set',
        note: 'reportHeartbeat() legacy write (kept for completeness; hub is the production author)',
    },
    // Deliberate hub-dedup clears before re-dispatch (documented contract of
    // animastor:job:*): the backend must be able to free its own jobs from the
    // hub enqueue-dedup so a re-dispatch is not rejected as duplicate.
    { file: 'backend/src/image/iu-processor.js', family: 'animastor:job:*', op: 'del', note: 'clear hub dedup before IU re-send' },
    { file: 'backend/src/orchestration/scene-restoration.js', family: 'animastor:job:*', op: 'del', note: 'clear hub dedup before restore re-send' },
    { file: 'backend/src/services/audio-orchestrator.js', family: 'animastor:job:*', op: 'del', note: 'clear hub dedup before audio re-dispatch' },
    { file: 'backend/src/services/video-orchestrator.js', family: 'animastor:job:*', op: 'del (via scan+del)', note: 'clear hub dedup before video re-dispatch' },
    { file: 'backend/src/services/entity-cleanup.cjs', family: 'animastor:job:*', op: 'del', note: 'purge removes dedup remnants' },
    { file: 'backend/src/routes/book/generation-routes.cjs', family: 'animastor:job:*', op: 'del', note: 'cancel path clears stale job dedup' },
    { file: 'backend/src/routes/debug-routes.cjs', family: 'animastor:job:*', op: 'del', note: 'debug re-dispatch tooling clears dedup' },
];

// Registry invariants -------------------------------------------------------

function patternMatchesFamily(pattern, key) {
    // glob-style: each pattern segment matches key segments, '*' matches
    // exactly one segment, a TRAILING '*' also matches any remaining tail.
    const ps = pattern.split(':');
    const ks = key.split(':');
    for (let i = 0; i < ps.length; i++) {
        const isLast = i === ps.length - 1;
        if (ps[i] === '*' && isLast) return i <= ks.length - 1 || ks.length === i;
        if (i >= ks.length) return false;
        if (ps[i] === '*') continue;
        if (ps[i] !== ks[i]) return false;
    }
    return ks.length <= ps.length;
}

function familyFor(key) {
    const matches = REDIS_OWNERSHIP.filter((f) => patternMatchesFamily(f.pattern, key));
    if (matches.length === 0) return null;
    // most specific (longest non-wildcard) pattern wins
    return matches.sort((a, b) => specificity(b) - specificity(a))[0];
}

function specificity(f) {
    return f.pattern.split(':').filter((s) => s !== '*').length;
}

describe('architecture: Redis ownership', () => {
    it('registry has no duplicate patterns and valid components', () => {
        const seen = new Set();
        const valid = ['backend', 'gpu-hub', 'worker', 'local-ai-connector'];
        for (const f of REDIS_OWNERSHIP) {
            expect(seen.has(f.pattern), `duplicate family pattern ${f.pattern}`).to.equal(false);
            seen.add(f.pattern);
            expect(valid, `owner of ${f.pattern}`).to.include(f.owner);
            for (const r of f.readers) expect(valid).to.include(r);
            for (const w of f.writers) expect(valid).to.include(w);
            expect(f.note, `note for ${f.pattern}`).to.be.a('string').with.length.greaterThan(10);
        }
    });

    it('every animastor:* key literal in backend src and gpu-hub belongs to a registered family', () => {
        const dirs = [
            path.join(REPO_ROOT, 'backend', 'src'),
            path.join(REPO_ROOT, 'gpu-hub'),
        ];
        const keyRe = /['"`]animastor:[a-zA-Z0-9:_\-${}.]+['"`]/g;
        const unresolved = [];
        for (const dir of dirs) {
            for (const file of listSourceFiles(dir)) {
                const src = readSource(file);
                let m;
                while ((m = keyRe.exec(src)) !== null) {
                    const raw = m[0].slice(1, -1);
                    const templated = raw.replace(/\$\{[^}]*\}/g, '*');
                    const family = familyFor(templated);
                    if (!family) unresolved.push(`${rel(file)}: ${raw}`);
                }
            }
        }
        expect(unresolved, 'Unregistered animastor:* Redis key families — add them to tests/architecture/redis-registry.js with owner/readers/writers.').to.deep.equal([]);
    });

    it('audit families from the final review are all present in the registry', () => {
        const required = [
            'animastor:worker-auth',
            'animastor:worker:heartbeat:*',
            'animastor:gpu-hub:workers',
            'animastor:queue:*',
            'animastor:queue:*:policy:*',
            'animastor:runtime:active',
            'animastor:runtime:*',
        ];
        const patterns = new Set(REDIS_OWNERSHIP.map((f) => f.pattern));
        for (const r of required) {
            expect(patterns.has(r), `family ${r} must be documented in redis-registry.js`).to.equal(true);
        }
    });

    it('known cross-owner writes are frozen (no new ones outside the baseline)', () => {
        // Scans backend src for WRITE ops against gpu-hub-owned families.
        const hubOwnedFamilies = REDIS_OWNERSHIP.filter((f) => f.owner === 'gpu-hub');
        const writeOps = /\.(hdel|hset|del|lpush|rpush|rpoplpush|lrem|sadd|srem|set|expire)\s*\(/;
        const offenders = [];
        for (const file of listSourceFiles(path.join(REPO_ROOT, 'backend', 'src'))) {
            const src = readSource(file);
            const lines = src.split('\n');
            lines.forEach((line, i) => {
                if (!writeOps.test(line)) return;
                // collect animastor keys on this line (template-safe)
                const keyMatches = [...line.matchAll(/animastor:[a-zA-Z0-9:_\-${}.]+/g)].map((m) => m[0].replace(/\$\{[^}]*\}/g, '*'));
                for (const key of keyMatches) {
                    const fam = familyFor(key);
                    if (!fam) continue; // unregistered keys are caught by the other test
                    const owner = fam.owner;
                    if (owner === 'backend') continue; // backend writing its own family is fine
                    const f = rel(file);
                    const inBaseline = CROSS_OWNER_WRITE_BASELINE.some(
                        (b) => b.file === f && patternMatchesFamily(b.family, key)
                    );
                    if (!inBaseline) offenders.push(`${f}:${i + 1} writes ${key} (owner: ${owner})`);
                }
            });
        }
        expect(offenders, 'Cross-owner Redis write detected. GPU-hub-owned families must only be written by the hub (see docs/architecture/PHASE_1_GUARDRAILS.md §Redis ownership). If this is a conscious exception, document it in CROSS_OWNER_WRITE_BASELINE.').to.deep.equal([]);
    });

    it('backend does not write worker-auth outside the owning service (worker-auth.js)', () => {
        // animastor:worker-auth is backend-owned, but the ONLY writer must stay
        // services/worker-auth.js — the auth boundary.
        const key = 'animastor:worker-auth';
        const writeOps = /\.(hdel|hset|del|set|expire)\s*\(/;
        const offenders = [];
        for (const file of listSourceFiles(path.join(REPO_ROOT, 'backend', 'src'))) {
            if (rel(file) === 'backend/src/services/worker-auth.js') continue;
            const lines = readSource(file).split('\n');
            lines.forEach((line, i) => {
                if (writeOps.test(line) && line.includes(key)) {
                    offenders.push(`${rel(file)}:${i + 1}`);
                }
            });
        }
        expect(offenders, 'animastor:worker-auth may only be written by services/worker-auth.js (the auth boundary).').to.deep.equal([]);
    });

    it('worker bundle never touches Redis directly', () => {
        const workerDir = path.join(REPO_ROOT, 'worker', 'worker');
        for (const file of listSourceFiles(workerDir)) {
            expect(readSource(file), `${rel(file)} must not talk to Redis — the worker talks HTTP to the hub only`).to.not.match(/ioredis|redis/i.test('') ? /$^/ : /ioredis|createClient|new\s+Redis/);
        }
    });
});
