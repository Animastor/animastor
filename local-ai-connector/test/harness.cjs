// ======================================================
// Package-owned test harness — zero non-builtin deps
// ======================================================
// A tiny assertion+suite layer so the migrated backend LAC unit tests keep
// their expressiveness without any dev dependency. Uses ONLY node builtins
// from the LAC dependency allowlist (ws, crypto, fs, path, http, https,
// url, util, events, stream) — notably node:test/assert/child_process are
// NOT on the allowlist, so the runner implements its own micro-runner.
// ======================================================

const assert = require('util');

const summary = { pass: 0, fail: 0 };
let currentGroup = null;

/** Register one test case. */
function it(name, fn) {
    const label = currentGroup ? `${currentGroup} — ${name}` : name;
    const stack = global.__LAC_TESTS || (global.__LAC_TESTS = []);
    stack.push({ label, fn });
}

/** Group label. */
function describe(name, fn) {
    currentGroup = name;
    try {
        fn();
    } finally {
        currentGroup = null;
    }
}

function fail(msg, extra) {
    const err = new assert.types ? new Error(msg) : new Error(msg);
    if (extra) {
        err.actual = extra.actual;
        err.expected = extra.expected;
    }
    throw err;
}

const expect = {
    equal: (a, b, msg) => { if (!Object.is(a, b)) fail(msg || `expected ${inspect(a)} to equal ${inspect(b)}`, { actual: a, expected: b }); },
    deepEqual: (a, b, msg) => { if (!deepEqual(a, b)) fail(msg || `expected ${inspect(a)} to deep-equal ${inspect(b)}`); },
    ok: (a, msg) => { if (!a) fail(msg || `expected truthy, got ${inspect(a)}`); },
    notOk: (a, msg) => { if (a) fail(msg || `expected falsy, got ${inspect(a)}`); },
    include: (a, b, msg) => { if (!String(a).includes(b)) fail(msg || `expected ${inspect(a)} to include ${inspect(b)}`); },
    notInclude: (a, b, msg) => { if (String(a).includes(b)) fail(msg || `expected ${inspect(a)} NOT to include ${inspect(b)}`); },
    match: (a, re, msg) => { if (!re.test(String(a))) fail(msg || `expected ${inspect(a)} to match ${re}`); },
    notMatch: (a, re, msg) => { if (re.test(String(a))) fail(msg || `expected ${inspect(a)} NOT to match ${re}`); },
    lengthOf: (a, n, msg) => { if (a.length !== n) fail(msg || `expected length ${n}, got ${a.length}`); },
    exist: (a, msg) => { if (a == null) fail(msg || `expected value to exist`); },
    notExist: (a, msg) => { if (a != null) fail(msg || `expected value not to exist`); },
    above: (a, b, msg) => { if (!(a > b)) fail(msg || `expected ${a} > ${b}`); },
    below: (a, b, msg) => { if (!(a < b)) fail(msg || `expected ${a} < ${b}`); },
    atLeast: (a, b, msg) => { if (!(a >= b)) fail(msg || `expected ${a} >= ${b}`); },
    atMost: (a, b, msg) => { if (!(a <= b)) fail(msg || `expected ${a} <= ${b}`); },
    true: (a, msg) => { if (a !== true) fail(msg || `expected true, got ${inspect(a)}`); },
    false: (a, msg) => { if (a !== false) fail(msg || `expected false, got ${inspect(a)}`); },
};

function inspect(v) {
    try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
    }
    return true;
}

/** Run every registered test sequentially; print a summary line. */
async function runRegistered() {
    const tests = global.__LAC_TESTS || [];
    for (const t of tests) {
        try {
            await t.fn();
            summary.pass += 1;
        } catch (err) {
            summary.fail += 1;
            console.error(`\nFAIL: ${t.label}\n  ${err.message}`);
        }
    }
    console.log(`LAC package tests: ${summary.pass} pass / ${summary.fail} fail (${tests.length} total)`);
    return summary.fail === 0 ? 0 : 1;
}

module.exports = { it, describe, expect, summary, runRegistered };
