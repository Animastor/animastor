// ======================================================
// @animastor/contracts — package-owned test harness
// ======================================================
// Same discipline as ai-connector/test/harness.cjs: a zero-dependency
// micro-runner so the package contour runs autonomously (no chai, no
// mocha, no backend monorepo). Only node builtins.
// Run: npm test   (from contracts/)
// ======================================================

const summary = { pass: 0, fail: 0 };
let currentGroup = null;

/** Register one test case. */
function it(name, fn) {
    const label = currentGroup ? `${currentGroup} — ${name}` : name;
    const stack = global.__CONTRACTS_TESTS || (global.__CONTRACTS_TESTS = []);
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

function fail(msg) {
    throw new Error(msg);
}

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

const expect = {
    equal: (a, b, msg) => { if (!Object.is(a, b)) fail(msg || `expected ${inspect(a)} to equal ${inspect(b)}`); },
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
    throws: (fn, re, msg) => {
        try { fn(); } catch (err) {
            if (re && !re.test(String(err && err.message))) fail(msg || `error message ${inspect(err && err.message)} does not match ${re}`);
            return;
        }
        fail(msg || `expected function to throw`);
    },
};

/** Run every registered test sequentially; print a summary line. */
async function runRegistered() {
    const tests = global.__CONTRACTS_TESTS || [];
    for (const t of tests) {
        try {
            await t.fn();
            summary.pass += 1;
        } catch (err) {
            summary.fail += 1;
            console.error(`\nFAIL: ${t.label}\n  ${err.message}`);
        }
    }
    console.log(`contracts package tests: ${summary.pass} pass / ${summary.fail} fail (${tests.length} total)`);
    return summary.fail === 0 ? 0 : 1;
}

module.exports = { it, describe, expect, summary, runRegistered };
