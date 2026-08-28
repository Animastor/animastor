// ======================================================
// LEASE MANAGER - RENEWABLE LEASES
// ======================================================
// Manages refreshable leases for long-running dispatches.
// Implements:
// - Renewable leases with periodic TTL extension
// - Lease heartbeat timer management
// - Safe Lua-based release operations
// - Ownership validation

const logPrefix = '[LEASE]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

// ======================================================
// CONFIGURATION
// ======================================================

const RENEWAL_INTERVAL_MS = 30000; // 30 seconds
const RESTART_DELAY_MS = 5000;     // 5 seconds before first renewal
const LEASE_RENEWAL_TTL_ADD = 180; // Add 3 minutes to TTL on renewal

// Lease TTL extensions (total TTL after first acquire)
// ЕДИНЫЙ источник — LEASE_TTL_S в config/runtime-config.js (тот же реестр,
// что dispatch-engine использует при первоначальном acquire). Renewal
// переставляет lease на LEASE_TOTAL_TTLS[stage] + LEASE_RENEWAL_TTL_ADD.
const runtimeConfig = require('../config/runtime-config');
const LEASE_TOTAL_TTLS = {
    audio: runtimeConfig.LEASE_TTL_S.AUDIO,
    image: runtimeConfig.LEASE_TTL_S.IMAGE,
    video: runtimeConfig.LEASE_TTL_S.VIDEO
};

// ======================================================
// STALE-LEASE SEMANTICS (audit c8b79f6, incident 2026-08-28)
// ======================================================
// Canonical liveness signal of a dispatch is the REMAINING TTL of its lease
// key, NOT metadata.started_at. renewLeaseIfOwner re-pins the TTL to
// getRenewalTargetTtlS(stage) every RENEWAL_INTERVAL_MS while the owner is
// alive; started_at is written once at acquire and never refreshed, so any
// age check based on it eventually flags a healthy renewed dispatch as stale
// (video incident: 0.9×TTL threshold = 27 min < real 60-min job → ~86
// duplicate dispatches in 14 h).
//
// A lease is stale only when its remaining TTL has dropped more than
// STALE_LEASE_GRACE_S below the renewal target — i.e. NO renewal succeeded
// for the whole grace window (20 intervals at the 30 s cadence). A live
// owner cannot let that happen; a dead owner (crash/restart) is detected
// within the grace window, and the lease auto-expires by its target TTL
// regardless — no eternal lease after restart.

const STALE_LEASE_GRACE_S = 10 * 60; // 10 min without a successful renewal

/**
 * TTL that renewal keeps the lease pinned to (seconds).
 */
function getRenewalTargetTtlS(stage) {
    return LEASE_TOTAL_TTLS[stage] + LEASE_RENEWAL_TTL_ADD;
}

/**
 * Decide whether a lease with the given remaining TTL is stale.
 * @param {number|null} ttl — redis TTL() result: -2 key gone, -1 no expiry, else seconds
 * @param {string} stage — 'audio'|'image'|'video'
 */
function isLeaseStale(ttl, stage) {
    if (ttl === null || ttl === undefined) return false;
    if (ttl <= -2) return false; // key gone → no lease to be stale
    if (ttl === -1) return true; // lease without expiry — broken, recover it
    return ttl < getRenewalTargetTtlS(stage) - STALE_LEASE_GRACE_S;
}

// Lease keys
const LEASE_PREFIX = 'animastor:dispatch-lease';
const LEASE_HB_PREFIX = 'animastor:lease-heartbeat';
const RENEWAL_TIMERS_KEY = 'animastor:runtime:renewal-timers';

// ======================================================
// KEY GENERATORS
// ======================================================

/**
 * Get lease key for scene:stage.
 */
function getLeaseKey(bookId, chapterId, sceneId, stage) {
    return `${LEASE_PREFIX}:${bookId}:${chapterId}:${sceneId}:${stage}`;
}

/**
 * Get lease heartbeat key.
 */
function getLeaseHeartbeatKey(bookId, chapterId, sceneId, stage) {
    return `${LEASE_HB_PREFIX}:${bookId}:${chapterId}:${sceneId}`;
}

/**
 * Get active renewal timers key.
 */
function getRenewalTimersKey() {
    return RENEWAL_TIMERS_KEY;
}

// ======================================================
// ACTIVE TIMER TRACKING
// ======================================================

const activeLeaseRenewals = new Map();

/**
 * Start lease renewal timer for dispatch.
 * @param {Object} redis — Redis client for lease renewal operations
 */
function startLeaseRenewal(redis, bookId, chapterId, sceneId, stage, leaseKey, token) {
    const timerKey = `${bookId}:${chapterId}:${sceneId}:${stage}`;
    
    // Clear existing timer if any
    if (activeLeaseRenewals.has(timerKey)) {
        const existing = activeLeaseRenewals.get(timerKey);
        if (existing.timerId) clearTimeout(existing.timerId);
        if (existing.intervalId) clearInterval(existing.intervalId);
        log(`RENEWAL_RESTART: ${timerKey}`);
    }

    const timerId = setTimeout(async () => {
        try {
            await renewLeaseIfOwner(redis, leaseKey, token);
        } catch (err) {
            warn(`Renewal error for ${timerKey}: ${err.message}`);
        }
    }, RESTART_DELAY_MS);

    const intervalId = setInterval(async () => {
        try {
            await renewLeaseIfOwner(redis, leaseKey, token);
        } catch (err) {
            warn(`Renewal error for ${timerKey}: ${err.message}`);
        }
    }, RENEWAL_INTERVAL_MS);

    activeLeaseRenewals.set(timerKey, {
        timerId,
        intervalId,
        leaseKey,
        token,
        stage,
        lastRenewal: Date.now(),
        bookId,
        chapterId,
        sceneId
    });

    log(`RENEWAL_STARTED: ${timerKey} (first in ${RESTART_DELAY_MS}ms, then every ${RENEWAL_INTERVAL_MS}ms)`);

    return { timerKey, timerId, intervalId };
}

/**
 * Stop lease renewal timer.
 */
function stopLeaseRenewal(bookId, chapterId, sceneId, stage) {
    const timerKey = `${bookId}:${chapterId}:${sceneId}:${stage}`;
    const entry = activeLeaseRenewals.get(timerKey);

    if (!entry) {
        return { stopped: false, reason: 'not_found' };
    }

    const { timerId, intervalId } = entry;

    if (timerId) {
        clearTimeout(timerId);
    }

    if (intervalId) {
        clearInterval(intervalId);
    }

    activeLeaseRenewals.delete(timerKey);

    log(`RENEWAL_STOPPED: ${timerKey}`);

    return { stopped: true, reason: 'success', stage };
}

/**
 * Renew lease if we are still the owner.
 * Uses Lua script for atomic compare-and-renew operation.
 * @param {Object} redis — Redis client (must be provided by caller)
 */
async function renewLeaseIfOwner(redis, leaseKey, expectedToken) {
    if (!redis) {
        warn(`No Redis context for renewal: ${leaseKey}`);
        return { renewed: false, reason: 'no_redis' };
    }

    const metadataKey = leaseKey.replace(
        'animastor:dispatch-lease:',
        'animastor:dispatch-meta:'
    );
    const luaScript = `
        local key = KEYS[1]
        local expected = ARGV[1]
        local ttl_add = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])

        local current = redis.call('GET', key)

        if not current then
            return {tostring(false), 'no_lease'}
        end

        if current ~= expected then
            return {tostring(false), 'token_mismatch', current}
        end

        -- Renew the lease and matching dispatch metadata together.
        redis.call('EXPIRE', key, ttl_add)
        if redis.call('EXISTS', KEYS[2]) == 1 then
            redis.call('EXPIRE', KEYS[2], ttl_add)
        end

        return {tostring(true), 'renewed', tostring(now)}
    `;

    try {

        const result = await redis.eval(
            luaScript,
            2,
            leaseKey,
            metadataKey,
            expectedToken,
            LEASE_TOTAL_TTLS[getStageFromKey(leaseKey)] + LEASE_RENEWAL_TTL_ADD,
            Date.now()
        );

        if (result[0] === 'true') {
            log(`RENEWED: ${leaseKey} (ttl extended by ${LEASE_RENEWAL_TTL_ADD}s)`);
            return { renewed: true, reason: 'success' };
        }

        if (result[1] === 'token_mismatch') {
            warn(`OWNERSHIP_LOST: ${leaseKey} (current=${result[2]?.slice(0, 20)}...)`);
            return { renewed: false, reason: 'ownership_lost' };
        }

        if (result[1] === 'no_lease') {
            log(`LEASE_EXPIRED: ${leaseKey}`);
            return { renewed: false, reason: 'lease_expired' };
        }

        return { renewed: false, reason: result[1] || 'unknown' };

    } catch (err) {
        error(`Renewal failed: ${leaseKey}: ${err.message}`);
        return { renewed: false, reason: 'error', error: err.message };
    }
}

/**
 * Extract stage from lease key.
 */
function getStageFromKey(leaseKey) {
    const parts = leaseKey.split(':');
    return parts[parts.length - 1];
}

/**
 * Get count of active renewals.
 */
function getActiveRenewalCount() {
    return activeLeaseRenewals.size;
}

/**
 * Get list of active renewal entries.
 */
function getActiveRenewals() {
    const renewals = [];
    for (const [key, entry] of activeLeaseRenewals) {
        renewals.push({
            key,
            stage: entry.stage,
            lastRenewal: entry.lastRenewal,
            leaseKey: entry.leaseKey,
            token: entry.token ? entry.token.slice(0, 16) + '...' : null,
            bookId: entry.bookId,
            chapterId: entry.chapterId,
            sceneId: entry.sceneId
        });
    }
    return renewals;
}

// ======================================================
// SAFE RELEASE WITH LUA
// ======================================================

/**
 * Acquire lease atomically (with Lua for safety).
 */
async function acquireLeaseSafe(redis, bookId, chapterId, sceneId, stage) {
    const leaseKey = getLeaseKey(bookId, chapterId, sceneId, stage);
    const token = generateDispatchToken();
    const ttl = LEASE_TOTAL_TTLS[stage];

    const luaScript = `
        local key = KEYS[1]
        local token = ARGV[1]
        local ttl = tonumber(ARGV[2])

        local current = redis.call('GET', key)

        if current then
            return {tostring(false), 'already_exists', current}
        end

        redis.call('SET', key, token, 'EX', ttl)

        return {tostring(true), 'acquired', token}
    `;

    const result = await redis.eval(luaScript, 1, leaseKey, token, ttl);

    if (result[0] === 'true') {
        log(`LEASE_ACQUIRED: ${leaseKey} (token=${token.slice(0, 16)}...)`);
        return { acquired: true, token, leaseKey };
    }

    if (result[1] === 'already_exists') {
        warn(`LEASE_EXISTS: ${leaseKey} (current=${result[2]?.slice(0, 16)}...)`);
        return { acquired: false, reason: 'exists', currentToken: result[2] };
    }

    return { acquired: false, reason: result[1] || 'unknown' };
}

/**
 * Release lease atomically if still owner (using Lua compare-and-delete).
 */
async function releaseLeaseSafe(redis, leaseKey, expectedToken) {
    const luaScript = `
        local key = KEYS[1]
        local expected = ARGV[1]

        local current = redis.call('GET', key)

        if not current then
            return {tostring(true), 'already_expired'}
        end

        if current ~= expected then
            return {tostring(false), 'token_mismatch', current}
        end

        redis.call('DEL', key)

        return {tostring(true), 'released'}
    `;

    const result = await redis.eval(luaScript, 1, leaseKey, expectedToken);

    if (result[0] === 'true') {
        if (result[1] === 'released') {
            log(`LEASE_RELEASED: ${leaseKey}`);
        } else {
            log(`LEASE_EXPIRED: ${leaseKey} (auto-expired)`);
        }
        return { released: true, leaseKey };
    }

    if (result[1] === 'token_mismatch') {
        warn(`RELEASE_FAILED: ${leaseKey} (token mismatch, current=${result[2]?.slice(0, 16)}...)`);
        return { released: false, leaseKey, reason: 'token_mismatch' };
    }

    return { released: false, leaseKey, reason: result[1] || 'unknown' };
}

/**
 * Release lease with token validation.
 * Uses Lua script for atomic compare-and-delete.
 */
async function releaseLeaseWithToken(redis, leaseKey, token) {
    // Check if Redis is available
    if (!redis) {
        warn(`Release failed: No Redis: ${leaseKey}`);
        return { released: false, reason: 'no_redis' };
    }

    // Use Lua script for atomicity
    const luaScript = `
        local key = KEYS[1]
        local expected = ARGV[1]

        local current = redis.call('GET', key)

        if not current then
            return {tostring(true), 'not_found'}
        end

        if current ~= expected then
            return {tostring(false), 'token_mismatch'}
        end

        redis.call('DEL', key)

        return {tostring(true), 'released'}
    `;

    try {
        const result = await redis.eval(luaScript, 1, leaseKey, token);

        if (result[0] === 'true') {
            if (result[1] === 'released') {
                log(`LEASE_RELEASED: ${leaseKey} (owner)`);
                return { released: true, leaseKey, reason: 'success' };
            }
            if (result[1] === 'not_found') {
                log(`LEASE_EXPIRED: ${leaseKey} (auto-expired)`);
                return { released: true, leaseKey, reason: 'expired' };
            }
        }

        warn(`LEASE_RELEASE_FAILED: ${leaseKey} (reason: ${result[1]})`);
        return { released: false, leaseKey, reason: result[1] || 'unknown' };

    } catch (err) {
        error(`Release error: ${leaseKey}: ${err.message}`);
        return { released: false, leaseKey, reason: 'error', error: err.message };
    }
}

// ======================================================
// HELPER FUNCTIONS
// ======================================================

/**
 * Generate unique dispatch token.
 * (Uses same logic as dispatch-engine)
 */
function generateDispatchToken() {
    return `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Get current lease TTL (server-side).
 */
async function getLeaseTTL(redis, leaseKey) {
    const ttl = await redis.ttl(leaseKey);
    return ttl > 0 ? ttl : 0;
}

/**
 * Check if lease is still valid.
 */
async function isLeaseValid(redis, leaseKey, expectedToken) {
    const current = await redis.get(leaseKey);
    return current === expectedToken;
}

/**
 * Get lease data.
 */
async function getLeaseData(redis, leaseKey) {
    const token = await redis.get(leaseKey);
    const ttl = await redis.ttl(leaseKey);
    return { token, ttl };
}

/**
 * Get active lease count by stage.
 */
async function getActiveCountByStage(redis, stage) {
    const pattern = `${LEASE_PREFIX}:*:${stage}`;
    let cursor = 0;
    let count = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = parseInt(result[0], 10);
        count += result[1].length;
    } while (cursor !== 0 && count < 1000);

    return count;
}

/**
 * Get count of renewals in flight.
 */
function getRenewalCount() {
    return activeLeaseRenewals.size;
}

/**
 * Get metrics for all active renewals.
 */
function getRenewalMetrics() {
    const renewals = getActiveRenewals();
    const now = Date.now();

    return {
        total: renewals.length,
        byStage: {},
        avgAge: 0,
        oldest: null,
        renewals
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Configuration
    RENEWAL_INTERVAL_MS,
    RESTART_DELAY_MS,
    LEASE_TOTAL_TTLS,
    LEASE_RENEWAL_TTL_ADD,
    STALE_LEASE_GRACE_S,

    // Stale-lease semantics (audit c8b79f6)
    getRenewalTargetTtlS,
    isLeaseStale,

    // Key generation
    getLeaseKey,
    getLeaseHeartbeatKey,
    getRenewalTimersKey,

    // Active renewal tracking
    activeLeaseRenewals,
    startLeaseRenewal,
    stopLeaseRenewal,
    renewLeaseIfOwner,
    getActiveRenewalCount,
    getActiveRenewals,
    getRenewalCount,
    getRenewalMetrics,

    // Safe lease operations (with Lua)
    acquireLeaseSafe,
    releaseLeaseWithToken,
    releaseLeaseSafe,

    // Lease validation
    getLeaseTTL,
    isLeaseValid,
    getLeaseData,

    // Helpers
    getActiveCountByStage,
    generateDispatchToken,

    // Utility
    getStageFromKey
};
