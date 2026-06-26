// ======================================================
// Happy-Path Network Safety Tests
// ======================================================
// Captures current observed behavior of the dispatch engine,
// state layer, and scene lifecycle.
//
// These tests establish a baseline ("safety net") before
// we refactor quota release (C1), callback idempotency (C4),
// and PG status updates (C2).
//
// IMPORTANT: These tests describe what the system DOES today,
// including known bugs. When a bug is fixed, the test should
// be updated to reflect the correct behavior.

const { expect } = require('chai');

// ======================================================
// Н.1: Idempotency test for /gpu/task/result dedup
// ======================================================

describe('Happy Path: GPU Task Result Idempotency (Н.1)', () => {
    let redis;

    beforeEach(() => {
        redis = new FakeRedis();
    });

    // Simulates the dedup logic from generation-routes.cjs:/gpu/task/result
    async function handleGpuTaskResult(job_id, result_base64, build_id) {
        const dedupKey = `animastor:result-processed:${job_id}:${build_id || 'nobuild'}`;
        const alreadyProcessed = await redis.set(dedupKey, '1', 'NX', 'EX', 3600);
        if (!alreadyProcessed) {
            return { ok: true, deduped: true };
        }
        // Simulating handleTaskResult
        await redis.set(`processed:${job_id}`, result_base64);
        return { ok: true };
    }

    it('first call processes the result', async () => {
        const result = await handleGpuTaskResult('job-1', 'base64data', 'build-1');
        expect(result.ok).to.be.true;
        expect(result.deduped).to.be.undefined;

        // Verify result was stored
        const stored = await redis.get('processed:job-1');
        expect(stored).to.equal('base64data');
    });

    it('second call with same (job_id, build_id) returns deduped', async () => {
        const first = await handleGpuTaskResult('job-1', 'base64data-v1', 'build-1');
        expect(first.ok).to.be.true;
        expect(first.deduped).to.be.undefined;

        const second = await handleGpuTaskResult('job-1', 'base64data-v2', 'build-1');
        expect(second.ok).to.be.true;
        expect(second.deduped).to.be.true;

        // Result should still be the FIRST one (not overwritten)
        const stored = await redis.get('processed:job-1');
        expect(stored).to.equal('base64data-v1');
    });

    it('different build_id bypasses dedup (force-regen)', async () => {
        const first = await handleGpuTaskResult('job-1', 'base64data-v1', 'build-1');
        expect(first.ok).to.be.true;

        // Force-regen with new build_id — should process again
        const second = await handleGpuTaskResult('job-1', 'base64data-v2', 'build-2');
        expect(second.ok).to.be.true;
        expect(second.deduped).to.be.undefined;

        const stored = await redis.get('processed:job-1');
        expect(stored).to.equal('base64data-v2');
    });

    it('different job_id both process independently', async () => {
        const a = await handleGpuTaskResult('job-a', 'data-a', 'build-1');
        expect(a.ok).to.be.true;

        const b = await handleGpuTaskResult('job-b', 'data-b', 'build-1');
        expect(b.ok).to.be.true;

        const storedA = await redis.get('processed:job-a');
        expect(storedA).to.equal('data-a');
        const storedB = await redis.get('processed:job-b');
        expect(storedB).to.equal('data-b');
    });

    it('dedup key respects NX — second call with same key is skipped', async () => {
        await handleGpuTaskResult('job-1', 'data', 'build-1');

        const dup = await handleGpuTaskResult('job-1', 'data', 'build-1');
        expect(dup.deduped).to.be.true;
    });
});

// ======================================================
// FakeRedis — in-memory mock for testing
// ======================================================

class FakeRedis {
    constructor() {
        this.store = new Map();
    }

    async get(k) {
        const v = this.store.get(k);
        if (v === undefined || v === null) return null;
        // If it's a stored raw value (string), return as-is
        // If it has TTL info, check expiry
        if (typeof v === 'object' && v !== null && 'value' in v && 'expiresAt' in v) {
            if (v.expiresAt && Date.now() > v.expiresAt) {
                this.store.delete(k);
                return null;
            }
            return v.value;
        }
        return v;
    }

    async set(k, v, ...args) {
        // Handle NX EX TTL pattern: set(key, value, 'NX', 'EX', ttl)
        let nx = false;
        let ttl = null;
        let value = v;

        for (let i = 0; i < args.length; i++) {
            if (args[i] === 'NX') nx = true;
            else if (args[i] === 'EX') {
                ttl = args[++i];
            }
        }

        if (nx) {
            // NX: only set if key doesn't exist
            const existing = this.store.get(k);
            if (existing) {
                // Check if expired
                if (typeof existing === 'object' && existing.expiresAt && Date.now() > existing.expiresAt) {
                    this.store.delete(k);
                } else {
                    return null; // NX fails — key exists
                }
            }
        }

        if (ttl) {
            this.store.set(k, {
                value,
                expiresAt: Date.now() + (ttl * 1000)
            });
        } else {
            this.store.set(k, value);
        }
        return 'OK';
    }

    async del(k) {
        const existed = this.store.has(k);
        this.store.delete(k);
        return existed ? 1 : 0;
    }

    async incr(k) {
        const raw = this.store.get(k);
        let val = 0;
        if (raw !== undefined && raw !== null) {
            if (typeof raw === 'object' && raw.value !== undefined) {
                val = parseInt(raw.value, 10) || 0;
            } else {
                val = parseInt(raw, 10) || 0;
            }
        }
        val += 1;
        this.store.set(k, String(val));
        return val;
    }

    async decr(k) {
        const raw = this.store.get(k);
        let val = 0;
        if (raw !== undefined && raw !== null) {
            if (typeof raw === 'object' && raw.value !== undefined) {
                val = parseInt(raw.value, 10) || 0;
            } else {
                val = parseInt(raw, 10) || 0;
            }
        }
        val -= 1;
        this.store.set(k, String(val));
        return val;
    }

    async exists(k) {
        const raw = this.store.get(k);
        if (raw === undefined || raw === null) return 0;
        if (typeof raw === 'object' && raw.expiresAt && Date.now() > raw.expiresAt) {
            this.store.delete(k);
            return 0;
        }
        return 1;
    }

    async expire(k, ttl) {
        const raw = this.store.get(k);
        if (raw === undefined || raw === null) return 0;
        if (typeof raw === 'object' && raw !== null && 'value' in raw) {
            raw.expiresAt = Date.now() + (ttl * 1000);
        } else {
            this.store.set(k, { value: raw, expiresAt: Date.now() + (ttl * 1000) });
        }
        return 1;
    }

    async hset(k, field, value) {
        if (arguments.length === 2 && typeof field === 'object') {
            // hset(key, { field1: val1, field2: val2 })
            const obj = field;
            const raw = this.store.get(k);
            let hash = raw;
            if (!hash || typeof hash !== 'object' || Array.isArray(hash) || hash.value) {
                hash = {};
            }
            for (const [f, v] of Object.entries(obj)) {
                hash[f] = v;
            }
            this.store.set(k, hash);
            return Object.keys(obj).length;
        }
        // hset(key, field, value)
        const raw = this.store.get(k);
        let hash = raw;
        if (!hash || typeof hash !== 'object' || Array.isArray(hash) || hash.value) {
            hash = {};
        }
        hash[field] = value;
        this.store.set(k, hash);
        return 1;
    }

    async hget(k, field) {
        const raw = this.store.get(k);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.value) return null;
        return raw[field] || null;
    }

    async hgetall(k) {
        const raw = this.store.get(k);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.value) return null;
        return raw;
    }

    async scan(cursor, ...args) {
        let pattern = null;
        for (let i = 0; i < args.length; i++) {
            if (args[i] === 'MATCH') pattern = args[i + 1];
        }
        if (!pattern) return ['0', []];
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        const matched = [...this.store.keys()].filter(k => regex.test(k));
        return ['0', matched];
    }

    async rpush(k, ...items) {
        const raw = this.store.get(k);
        let list = raw;
        if (!list || !Array.isArray(list)) {
            list = [];
            this.store.set(k, list);
        }
        for (const item of items) {
            list.push(item);
        }
        return list.length;
    }

    async smembers(k) {
        const raw = this.store.get(k);
        if (!raw || !Array.isArray(raw)) return [];
        return raw;
    }

    async sadd(k, ...members) {
        const raw = this.store.get(k);
        let set = raw;
        if (!set || !Array.isArray(set)) {
            set = [];
            this.store.set(k, set);
        }
        let added = 0;
        for (const m of members) {
            if (!set.includes(m)) {
                set.push(m);
                added++;
            }
        }
        return added;
    }

    async srem(k, member) {
        const raw = this.store.get(k);
        if (!raw || !Array.isArray(raw)) return 0;
        const idx = raw.indexOf(member);
        if (idx >= 0) {
            raw.splice(idx, 1);
            return 1;
        }
        return 0;
    }

    async keys(pattern) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return [...this.store.keys()].filter(k => regex.test(k));
    }

    async eval(script, numKeys, ...args) {
        const keys = args.slice(0, numKeys);
        const scriptArgs = args.slice(numKeys);

        // Atomic acquire quota: GET key, check < max, INCR
        // Returns 0 if exceeded, new count if acquired
        if (script.includes('tonumber')) {
            const key = keys[0];
            const max = parseInt(scriptArgs[0], 10);
            const raw = this.store.get(key);
            let current = 0;
            if (raw !== undefined && raw !== null) {
                if (typeof raw === 'object' && raw.value !== undefined) {
                    current = parseInt(raw.value, 10) || 0;
                } else {
                    current = parseInt(raw, 10) || 0;
                }
            }
            if (current >= max) return 0;
            return await this.incr(key);
        }

        throw new Error(`FakeRedis.eval: unsupported script`);
    }

    // Helpers for testing
    _getRaw(key) {
        const v = this.store.get(key);
        if (typeof v === 'object' && v !== null && 'value' in v) return v.value;
        return v;
    }
}

// ======================================================
// IMPORTS (real modules, tested directly with FakeRedis)
// ======================================================

const dispatchEngine = require('../src/runtime/dispatch-engine');
const sceneState = require('../src/state/scene-state');

// ======================================================
// HELPERS
// ======================================================

const BOOK_ID = 'test-book-happy';
const CHAPTER_ID = 'ch-1';
const SCENE_ID = 's-1';
const BUILD_ID = 'build-1';

function makeSceneRef() {
    return { book_id: BOOK_ID, chapter_id: CHAPTER_ID, scene_id: SCENE_ID };
}

// ======================================================
// SECTION 1: DISPATCH ENGINE — LEASE OPERATIONS
// ======================================================

describe('Happy Path: Dispatch Engine — Leases', () => {
    let redis;

    beforeEach(() => {
        redis = new FakeRedis();
    });

    it('acquireStageLease succeeds for a new scene stage', async () => {
        const result = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );

        expect(result.acquired).to.be.true;
        expect(result.token).to.be.a('string');
        expect(result.leaseKey).to.include('animastor:dispatch-lease');
        expect(result.leaseKey).to.include(BOOK_ID);
        expect(result.leaseKey).to.include(CHAPTER_ID);
        expect(result.leaseKey).to.include(SCENE_ID);
        expect(result.leaseKey).to.include('audio');
    });

    it('acquireStageLease returns duplicate for existing lease', async () => {
        // First acquire succeeds
        const first = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );
        expect(first.acquired).to.be.true;

        // Second acquire for same scene+stage returns duplicate
        const second = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );
        expect(second.acquired).to.be.false;
        expect(second.reason).to.equal('lease_active');
    });

    it('acquireStageLease allows parallel stages (audio+image)', async () => {
        const audioLease = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );
        expect(audioLease.acquired).to.be.true;

        // Image can be acquired in parallel (independent lease)
        const imageLease = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'image'
        );
        expect(imageLease.acquired).to.be.true;
        expect(imageLease.leaseKey).to.include('image');
    });

    it('releaseStageLease releases the lease', async () => {
        const { leaseKey, token } = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );

        const release = await dispatchEngine.releaseStageLease(redis, leaseKey, token);
        expect(release.released).to.be.true;
        expect(release.reason).to.equal('success');

        // After release, acquire should succeed again
        const retry = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );
        expect(retry.acquired).to.be.true;
    });

    it('releaseStageLease with wrong token returns token_mismatch', async () => {
        const { leaseKey } = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );

        const release = await dispatchEngine.releaseStageLease(redis, leaseKey, 'wrong-token');
        expect(release.released).to.be.false;
        expect(release.reason).to.equal('token_mismatch');
    });

    it('releaseStageLease for expired lease returns already_expired', async () => {
        const { leaseKey, token } = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );

        // Delete the lease manually to simulate expiration
        await redis.del(leaseKey);

        const release = await dispatchEngine.releaseStageLease(redis, leaseKey, token);
        expect(release.released).to.be.true;
        expect(release.reason).to.equal('already_expired');
    });

    it('isLeaseValid returns true for active lease', async () => {
        const { leaseKey, token } = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );

        const valid = await dispatchEngine.isLeaseValid(redis, leaseKey, token);
        expect(valid).to.be.true;
    });

    it('isLeaseValid returns false for released lease', async () => {
        const { leaseKey, token } = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );

        await dispatchEngine.releaseStageLease(redis, leaseKey, token);

        const valid = await dispatchEngine.isLeaseValid(redis, leaseKey, token);
        expect(valid).to.be.false;
    });

    it('getLeaseData returns token for active lease', async () => {
        const { token } = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );

        const data = await dispatchEngine.getLeaseData(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );
        expect(data.token).to.equal(token);
        expect(data.leaseKey).to.include('audio');
    });

    it('markDispatchCompleted releases lease and cleans up', async () => {
        // Acquire lease
        const { leaseKey } = await dispatchEngine.acquireStageLease(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio'
        );

        // Mark as completed
        await dispatchEngine.markDispatchCompleted(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio');

        // Lease should be gone
        const leaseToken = await redis.get(leaseKey);
        expect(leaseToken).to.be.null;

        // Metadata should be gone
        const metaKey = dispatchEngine.getDispatchMetaKey(BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio');
        const meta = await redis.get(metaKey);
        expect(meta).to.be.null;
    });
});

// ======================================================
// SECTION 2: DISPATCH ENGINE — QUOTA OPERATIONS
// ======================================================

describe('Happy Path: Dispatch Engine — Quotas', () => {
    let redis;

    beforeEach(() => {
        redis = new FakeRedis();
    });

    it('acquireQuota succeeds when within limits', async () => {
        const result = await dispatchEngine.acquireQuota(redis, 'audio');
        expect(result.acquired).to.be.true;
        expect(result.current).to.equal(1);
    });

    it('acquireQuota returns exceeded when over limit', async () => {
        // Acquire all audio slots (max 3)
        for (let i = 0; i < 3; i++) {
            const r = await dispatchEngine.acquireQuota(redis, 'audio');
            expect(r.acquired).to.be.true;
        }

        // Fourth should fail
        const result = await dispatchEngine.acquireQuota(redis, 'audio');
        expect(result.acquired).to.be.false;
        expect(result.reason).to.equal('quota_exceeded');
    });

    it('acquireQuota respects different limits per stage', async () => {
        // Image max is 2
        const r1 = await dispatchEngine.acquireQuota(redis, 'image');
        expect(r1.acquired).to.be.true;
        const r2 = await dispatchEngine.acquireQuota(redis, 'image');
        expect(r2.acquired).to.be.true;
        const r3 = await dispatchEngine.acquireQuota(redis, 'image');
        expect(r3.acquired).to.be.false;

        // Video max is 1
        const v1 = await dispatchEngine.acquireQuota(redis, 'video');
        expect(v1.acquired).to.be.true;
        const v2 = await dispatchEngine.acquireQuota(redis, 'video');
        expect(v2.acquired).to.be.false;
    });

    it('releaseQuota decrements counter', async () => {
        const acquire = await dispatchEngine.acquireQuota(redis, 'audio');
        expect(acquire.current).to.equal(1);

        const release = await dispatchEngine.releaseQuota(redis, 'audio');
        expect(release.released).to.be.true;
        expect(release.current).to.equal(0);
    });

    it('quotas return to zero after acquire-release cycle', async () => {
        await dispatchEngine.acquireQuota(redis, 'audio');
        await dispatchEngine.acquireQuota(redis, 'image');
        await dispatchEngine.acquireQuota(redis, 'video');

        // Verify all are active
        const before = await dispatchEngine.getMetrics(redis);
        expect(before.active.audio).to.equal(1);
        expect(before.active.image).to.equal(1);
        expect(before.active.video).to.equal(1);

        // Release all
        await dispatchEngine.releaseQuota(redis, 'audio');
        await dispatchEngine.releaseQuota(redis, 'image');
        await dispatchEngine.releaseQuota(redis, 'video');

        // Verify all returned to 0
        const after = await dispatchEngine.getMetrics(redis);
        expect(after.active.audio).to.equal(0);
        expect(after.active.image).to.equal(0);
        expect(after.active.video).to.equal(0);
    });

    it('checkQuota reports correct status', async () => {
        // Initially 0/3 for audio
        const check = await dispatchEngine.checkQuota(redis, 'audio');
        expect(check.exceeded).to.be.false;
        expect(check.current).to.equal(0);
        expect(check.max).to.equal(3);
    });

    it('getQuotaStatus returns per-stage breakdown', async () => {
        await dispatchEngine.acquireQuota(redis, 'audio');
        await dispatchEngine.acquireQuota(redis, 'audio');

        const status = await dispatchEngine.getQuotaStatus(redis);
        expect(status.audio.current).to.equal(2);
        expect(status.audio.max).to.equal(3);
        expect(status.audio.available).to.equal(1);
        expect(status.image.current).to.equal(0);
        expect(status.video.current).to.equal(0);
    });

    // FIXED C1 (Н.2): Single quota release in markDispatchCompleted.
    // releaseQuota was removed from scene-callbacks.js — markDispatchCompleted
    // is now the sole owner. One acquire → one release.
    it('FIXED C1 (Н.2): markDispatchCompleted is the sole owner of quota release', async () => {
        await dispatchEngine.acquireQuota(redis, 'audio');
        expect(await dispatchEngine.getActiveCounter(redis, 'audio')).to.equal(1);

        await dispatchEngine.markDispatchCompleted(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio');

        // markDispatchCompleted does releaseQuota, so counter goes from 1→0
        const after = await dispatchEngine.getActiveCounter(redis, 'audio');
        expect(after).to.equal(0);
    });
});

// ======================================================
// SECTION 3: STATE — PER-ASSET OPERATIONS
// ======================================================

describe('Happy Path: State — Per-Asset Operations', () => {
    let redis;

    beforeEach(() => {
        redis = new FakeRedis();
    });

    it('setAssetState stores and retrieves correctly', async () => {
        await sceneState.setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'ready');

        const states = await sceneState.getAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(states.audio).to.equal('ready');
        expect(states.image).to.equal('new');
        expect(states.video).to.equal('new');
    });

    it('setAssetState overwrites existing state', async () => {
        await sceneState.setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'generating');
        await sceneState.setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'ready');

        const states = await sceneState.getAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(states.audio).to.equal('ready');
    });

    it('getAssetStates returns defaults for new scene', async () => {
        // No state has been set — should fall back to linear state defaults
        const states = await sceneState.getAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(states).to.have.keys('audio', 'image', 'video');
        // All should be 'new' when no state exists
        expect(states.audio).to.equal('new');
        expect(states.image).to.equal('new');
        expect(states.video).to.equal('new');
    });

    it('setAssetStates sets multiple assets at once', async () => {
        await sceneState.setAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, {
            audio: 'ready',
            image: 'generating'
        });

        const states = await sceneState.getAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(states.audio).to.equal('ready');
        expect(states.image).to.equal('generating');
        expect(states.video).to.equal('new');
    });

    it('per-asset states are independent for audio and image', async () => {
        // Simulate parallel dispatch: both audio and image can be generating
        await sceneState.setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'generating');
        await sceneState.setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'image', 'generating');

        const states = await sceneState.getAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(states.audio).to.equal('generating');
        expect(states.image).to.equal('generating');
        expect(states.video).to.equal('new');
    });

    // FIXED M2 (Н.3): acquireQuota is now atomic via Lua EVAL.
    // Uses a single EVAL call that atomically GETs the counter, checks the limit,
    // and INCRs — eliminating the race between checkQuota and incrementActiveCounter.
    it('FIXED M2 (Н.3): acquireQuota is atomic — respects limits with Lua eval', async () => {
        // Acquire all audio slots (max 3)
        for (let i = 0; i < 3; i++) {
            const r = await dispatchEngine.acquireQuota(redis, 'audio');
            expect(r.acquired).to.be.true;
            expect(r.current).to.equal(i + 1);
        }

        // Fourth should fail (atomic — no race possible)
        const result = await dispatchEngine.acquireQuota(redis, 'audio');
        expect(result.acquired).to.be.false;
        expect(result.reason).to.equal('quota_exceeded');
        expect(result.current).to.equal(3);

        // Verify counter is exactly 3 (not overshot)
        const counter = await dispatchEngine.getActiveCounter(redis, 'audio');
        expect(counter).to.equal(3);
    });

    it('FIXED M2 (Н.3): acquireQuota handles first-time key (nil → INCR)', async () => {
        // Key doesn't exist yet — Lua script should GET nil, then INCR to 1
        const result = await dispatchEngine.acquireQuota(redis, 'video');
        expect(result.acquired).to.be.true;
        expect(result.current).to.equal(1);
    });

    it('FIXED M2 (Н.3): acquireQuota respects different limits per stage atomically', async () => {
        // Image max is 2
        const r1 = await dispatchEngine.acquireQuota(redis, 'image');
        expect(r1.acquired).to.be.true;
        const r2 = await dispatchEngine.acquireQuota(redis, 'image');
        expect(r2.acquired).to.be.true;
        // Third should fail atomically
        const r3 = await dispatchEngine.acquireQuota(redis, 'image');
        expect(r3.acquired).to.be.false;

        // Video max is 1
        const v1 = await dispatchEngine.acquireQuota(redis, 'video');
        expect(v1.acquired).to.be.true;
        const v2 = await dispatchEngine.acquireQuota(redis, 'video');
        expect(v2.acquired).to.be.false;
    });

    // KNOWN BUG — M1: Non-atomic RMW on per-asset state
    // setAssetState does GET → merge → SET without atomicity.
    // This test captures the current behavior but does NOT test the race condition
    // (that requires concurrent async operations on the same FakeRedis).
    // This is a SEPARATE issue from M2 (quota) — will be fixed in a future step.
    it('KNOWN BUG M1: setAssetState uses non-atomic read-modify-write', async () => {
        // Set initial state
        await sceneState.setAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, {
            audio: 'generating',
            image: 'generating'
        });

        // Set audio to ready (this is RMW: GET → merge → SET)
        await sceneState.setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'ready');

        const states = await sceneState.getAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(states.audio).to.equal('ready');
        expect(states.image).to.equal('generating');
    });

    // KNOWN BUG — §5.1: GENERATING not set in per-asset during dispatch
    // When executeAudioDispatch runs, it only sets linear state (transitionSceneState)
    // but does NOT call setAssetState(..., 'generating').
    // This test documents that.
    it('KNOWN BUG §5.1: GENERATING is NOT set in per-asset during dispatch', async () => {
        // Simulate what executeAudioDispatch does:
        // It calls transitionSceneState (linear) but NOT setAssetState
        
        // Set per-asset to pending (as bootstrap does)
        await sceneState.setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'pending');

        // Now simulate dispatch: only linear state is updated
        await sceneState.transitionSceneState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio_generating');

        // Per-asset state should still be 'pending' (NOT 'generating')
        const states = await sceneState.getAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(states.audio).to.equal('pending');
    });
});

// ======================================================
// SECTION 4: SCENE CALLBACKS — COMPLETION LIFECYCLE
// ======================================================
// Note: scene-callbacks.js has many dependencies (audio, image, video,
// storage, runtimeScheduler, dispatchEngine, book, placeholderAudio).
// We mock the external dependencies and test only the callback logic.

describe('Happy Path: Scene Callbacks (with mocks)', () => {
    let redis;
    let callbacks;
    let mockAudio;
    let mockImage;
    let mockVideo;
    let mockStorage;
    let mockScheduler;
    let mockPlaceholder;
    let origRequire;

    beforeEach(() => {
        redis = new FakeRedis();

        // Stub module dependencies by manipulating require.cache
        const cwd = process.cwd();

        // Mock audio service
        mockAudio = {
            isSceneAudioReady: async () => true,
        };
        const audioPath = require.resolve('../src/audio');
        require.cache[audioPath] = { exports: mockAudio, loaded: true };

        // Mock image service
        mockImage = {
            resolveCanonicalSceneImage: () => `/data/output/${BUILD_ID}/${BOOK_ID}_${CHAPTER_ID}_${SCENE_ID}.png`,
            getImageMetadata: async () => ({ width: 1024, height: 768 }),
        };
        const imagePath = require.resolve('../src/image');
        require.cache[imagePath] = { exports: mockImage, loaded: true };

        // Mock video service
        mockVideo = {
            validateVideoFile: () => ({ valid: true, duration: 30, metadata: { width: 1920, height: 1080 } }),
            updateSceneVideoStatus: async () => {},
        };
        const videoPath = require.resolve('../src/video');
        require.cache[videoPath] = { exports: mockVideo, loaded: true };

        // Mock storage
        mockStorage = {
            filesystem: {
                getSceneAudioPath: () => `/data/output/${BUILD_ID}/${BOOK_ID}_${CHAPTER_ID}_${SCENE_ID}.mp3`,
            },
            registry: {
                registerSceneAudio: async () => ({ success: true }),
                registerSceneImage: async () => ({ success: true }),
                registerSceneVideo: async () => ({ success: true }),
            },
            manifest: {
                recordAsset: () => {},
            },
        };
        const storagePath = require.resolve('../src/storage');
        require.cache[storagePath] = { exports: mockStorage, loaded: true };

        // Mock runtime scheduler
        mockScheduler = {
            removeSceneFromActiveIndex: async () => {},
            addSceneToActiveIndex: async () => {},
        };
        const schedulerPath = require.resolve('../src/runtime/runtime-scheduler');
        require.cache[schedulerPath] = { exports: mockScheduler, loaded: true };

        // Mock placeholder audio
        mockPlaceholder = {
            replacePlaceholderWithRealAudio: async () => {},
            hasRealAudio: async () => true,
        };
        const placeholderPath = require.resolve('../src/services/placeholder-audio');
        require.cache[placeholderPath] = { exports: mockPlaceholder, loaded: true };

        // Mock music-metadata
        const mmPath = require.resolve('music-metadata');
        require.cache[mmPath] = {
            exports: {
                parseFile: async () => ({ format: { duration: 30 } }),
            },
            loaded: true,
        };

        // Mock book
        const bookPath = require.resolve('../src/book');
        require.cache[bookPath] = {
            exports: {
                loadBook: () => ({ chapters: [], manifest: { build_id: BUILD_ID } }),
                findSceneRuntimeData: () => null,
            },
            loaded: true,
        };

        // Mock scene-utils
        const utilsPath = require.resolve('../src/orchestration/scene-utils');
        require.cache[utilsPath] = {
            exports: {
                log: () => {},
                warn: () => {},
                error: () => {},
                logEvent: async () => {},
            },
            loaded: true,
        };

        // Mock scene-window (required inline in handleVideoCompleted)
        const sceneWindowPath = require.resolve('../src/runtime/scene-window');
        require.cache[sceneWindowPath] = {
            exports: {
                trySlideWindowOnComplete: async () => ({ started: 0, remaining: 0 }),
            },
            loaded: true,
        };

        // Mock postgres scene-assets-repo (required inline)
        this.repoCalls = []; // track markReady calls
        const repoPath = require.resolve('../src/storage/postgres/repositories/scene-assets-repo');
        require.cache[repoPath] = {
            exports: {
                markReady: async (bookId, chapterId, sceneId, assetType, path, extras) => {
                    this.repoCalls.push({ method: 'markReady', bookId, chapterId, sceneId, assetType, path, extras });
                },
                clearDirtyFlag: async () => {},
                getDirtyUnitIds: async () => [],
                clearDirtyUnitIds: async () => {},
                setDirtyUnitIds: async () => {},
            },
            loaded: true,
        };

        // Now load the callbacks module fresh
        delete require.cache[require.resolve('../src/orchestration/scene-callbacks')];
        callbacks = require('../src/orchestration/scene-callbacks');
    });

    afterEach(() => {
        // Clean up all stubbed caches
        const paths = [
            '../src/audio',
            '../src/image',
            '../src/video',
            '../src/storage',
            '../src/runtime/runtime-scheduler',
            '../src/services/placeholder-audio',
            '../src/book',
            '../src/orchestration/scene-utils',
            '../src/runtime/scene-window',
            '../src/storage/postgres/repositories/scene-assets-repo',
            '../src/orchestration/scene-callbacks',
        ];
        for (const p of paths) {
            delete require.cache[require.resolve(p)];
        }
        // Also clear music-metadata if cached
        try {
            delete require.cache[require.resolve('music-metadata')];
        } catch {}
    });

    it('handleAudioCompleted sets audio to READY', async () => {
        // Set up initial state: audio is pending
        await sceneState.setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'pending');

        // Acquire quota (as dispatch would have done)
        await dispatchEngine.acquireQuota(redis, 'audio');

        const result = await callbacks.handleAudioCompleted(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID
        );

        expect(result.handled).to.be.true;
        expect(result.nextStage).to.equal('image');

        // Verify per-asset state is READY
        const states = await sceneState.getAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(states.audio).to.equal('ready');
    });

    // FIXED C2 (Н.5): handleAudioCompleted writes PG status='ready' via markReady.
    // scene-assets-repo.markReady() is now called with correct book/chapter/scene/asset_type.
    it('FIXED C2 (Н.5): handleAudioCompleted writes PG status=ready via markReady', async () => {
        await sceneState.setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'pending');
        await dispatchEngine.acquireQuota(redis, 'audio');

        const result = await callbacks.handleAudioCompleted(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID);
        expect(result.handled).to.be.true;

        // Verify markReady was called with correct params
        const markReadyCalls = this.repoCalls.filter(c => c.method === 'markReady' && c.assetType === 'audio');
        expect(markReadyCalls.length).to.equal(1);
        expect(markReadyCalls[0].bookId).to.equal(BOOK_ID);
        expect(markReadyCalls[0].chapterId).to.equal(CHAPTER_ID);
        expect(markReadyCalls[0].sceneId).to.equal(SCENE_ID);
        expect(markReadyCalls[0].assetType).to.equal('audio');
        expect(markReadyCalls[0].path).to.include(SCENE_ID);
        expect(markReadyCalls[0].path).to.include('.mp3');
    });

    it('FIXED C2 (Н.5): handleImageCompleted writes PG status=ready via markReady', async () => {
        await sceneState.setAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, {
            audio: 'ready',
            image: 'pending',
        });
        await dispatchEngine.acquireQuota(redis, 'image');

        const result = await callbacks.handleImageCompleted(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID);
        expect(result.handled).to.be.true;

        const markReadyCalls = this.repoCalls.filter(c => c.method === 'markReady' && c.assetType === 'image');
        expect(markReadyCalls.length).to.equal(1);
        expect(markReadyCalls[0].bookId).to.equal(BOOK_ID);
        expect(markReadyCalls[0].chapterId).to.equal(CHAPTER_ID);
        expect(markReadyCalls[0].sceneId).to.equal(SCENE_ID);
        expect(markReadyCalls[0].assetType).to.equal('image');
        expect(markReadyCalls[0].path).to.include(SCENE_ID);
        expect(markReadyCalls[0].path).to.include('.png');
        // extras should include dimensions
        expect(markReadyCalls[0].extras).to.have.property('width', 1024);
        expect(markReadyCalls[0].extras).to.have.property('height', 768);
    });

    it('FIXED C2 (Н.5): handleVideoCompleted writes PG status=ready via markReady', async () => {
        await sceneState.setAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, {
            audio: 'ready',
            image: 'ready',
            video: 'pending',
        });
        await dispatchEngine.acquireQuota(redis, 'video');

        const result = await callbacks.handleVideoCompleted(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID);
        expect(result.handled).to.be.true;
        expect(result.completed).to.be.true;

        const markReadyCalls = this.repoCalls.filter(c => c.method === 'markReady' && c.assetType === 'video');
        expect(markReadyCalls.length).to.equal(1);
        expect(markReadyCalls[0].bookId).to.equal(BOOK_ID);
        expect(markReadyCalls[0].chapterId).to.equal(CHAPTER_ID);
        expect(markReadyCalls[0].sceneId).to.equal(SCENE_ID);
        expect(markReadyCalls[0].assetType).to.equal('video');
        expect(markReadyCalls[0].path).to.include(SCENE_ID);
        expect(markReadyCalls[0].path).to.include('.mp4');
        // extras should include metadata
        expect(markReadyCalls[0].extras).to.have.property('duration', 30);
        expect(markReadyCalls[0].extras).to.have.property('width', 1920);
        expect(markReadyCalls[0].extras).to.have.property('height', 1080);
    });

    it('handleImageCompleted sets image to READY', async () => {
        // Set initial per-asset state
        await sceneState.setAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, {
            audio: 'ready',
            image: 'pending',
        });

        // Acquire quota
        await dispatchEngine.acquireQuota(redis, 'image');

        const result = await callbacks.handleImageCompleted(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID
        );

        expect(result.handled).to.be.true;
        expect(result.nextStage).to.equal('video');

        const states = await sceneState.getAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(states.image).to.equal('ready');
    });

    it('handleVideoCompleted sets video to READY and completes scene', async () => {
        // Set initial per-asset state
        await sceneState.setAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, {
            audio: 'ready',
            image: 'ready',
            video: 'pending',
        });

        await dispatchEngine.acquireQuota(redis, 'video');

        const result = await callbacks.handleVideoCompleted(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID
        );

        expect(result.handled).to.be.true;
        expect(result.completed).to.be.true;

        const states = await sceneState.getAssetStates(redis, BOOK_ID, CHAPTER_ID, SCENE_ID);
        expect(states.video).to.equal('ready');
    });

    // FIXED C1 (Н.2): Callback no longer releases quota — markDispatchCompleted is the sole owner.
    // The callback completes successfully but the quota is still held until markDispatchCompleted.
    it('FIXED C1 (Н.2): handleAudioCompleted does NOT release quota — deferred to markDispatchCompleted', async () => {
        await sceneState.setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'pending');
        await dispatchEngine.acquireQuota(redis, 'audio');

        // Before: counter = 1
        expect(await dispatchEngine.getActiveCounter(redis, 'audio')).to.equal(1);

        const result = await callbacks.handleAudioCompleted(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID);
        expect(result.handled).to.be.true;

        // After callback: counter still 1 (callback no longer releases quota)
        const afterCallback = await dispatchEngine.getActiveCounter(redis, 'audio');
        expect(afterCallback).to.equal(1);

        // After markDispatchCompleted: counter goes to 0 (single release)
        await dispatchEngine.markDispatchCompleted(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio');
        const afterRelease = await dispatchEngine.getActiveCounter(redis, 'audio');
        expect(afterRelease).to.equal(0);
    });

    it('handleAudioCompleted accepts callback in states: GENERATING, PENDING, DIRTY', async () => {
        // Test all allowed states
        for (const state of ['generating', 'pending', 'dirty']) {
            const r = new FakeRedis();
            await sceneState.setAssetState(r, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', state);
            await dispatchEngine.acquireQuota(r, 'audio');

            const result = await callbacks.handleAudioCompleted(r, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID);
            expect(result.handled, `should handle ${state}`).to.be.true;
        }
    });

    it('handleAudioCompleted rejects callback for invalid state (ready)', async () => {
        await sceneState.setAssetState(redis, BOOK_ID, CHAPTER_ID, SCENE_ID, 'audio', 'ready');

        const result = await callbacks.handleAudioCompleted(
            redis, BOOK_ID, CHAPTER_ID, SCENE_ID, BUILD_ID
        );

        expect(result.handled).to.be.false;
        expect(result.reason).to.equal('invalid_asset_state');
    });

    // NOTE: Individual callback tests above cover audio→image→video lifecycle.
    // A full three-callback chain test would need integration mocks for the
    // inline require('../storage/postgres/repositories/scene-assets-repo')
    // inside handleImageCompleted — saved for integration test suite.
});

// ======================================================
// SECTION 5: SCHEDULER TICK LOCK
// ======================================================

describe('Happy Path: Scheduler Tick Lock', () => {
    let redis;

    beforeEach(() => {
        redis = new FakeRedis();
    });

    it('acquireSchedulerTickLock succeeds when not held', async () => {
        const result = await dispatchEngine.acquireSchedulerTickLock(redis);
        // ioredis SET NX returns 'OK' (truthy) on success, null on failure
        expect(result.acquired).to.be.ok;
        expect(result.token).to.be.a('string');
    });

    it('acquireSchedulerTickLock fails when already held', async () => {
        const first = await dispatchEngine.acquireSchedulerTickLock(redis);
        expect(first.acquired).to.be.ok;

        const second = await dispatchEngine.acquireSchedulerTickLock(redis);
        expect(second.acquired).to.not.be.ok;
    });

    it('releaseSchedulerTickLock releases the lock', async () => {
        const { token } = await dispatchEngine.acquireSchedulerTickLock(redis);

        const release = await dispatchEngine.releaseSchedulerTickLock(redis, token);
        expect(release.released).to.be.true;

        // Should be acquirable again
        const retry = await dispatchEngine.acquireSchedulerTickLock(redis);
        expect(retry.acquired).to.be.ok;
    });

    it('isSchedulerTickRunning returns correct status', async () => {
        expect(await dispatchEngine.isSchedulerTickRunning(redis)).to.equal(0);

        await dispatchEngine.acquireSchedulerTickLock(redis);
        expect(await dispatchEngine.isSchedulerTickRunning(redis)).to.equal(1);
    });
});
