// ======================================================
// animastor-worker — package-owned test runner
// ======================================================
// Zero-dependency test driver (mirrors contracts/tests/run-all.cjs).
// Run: node tests/run-all.cjs   (from worker/)
// ======================================================

const path = require('path');
const { runRegistered } = require('./harness.cjs');

const SUITES = [
    './worker-env.test.cjs',
    './worker-cleanup.test.cjs',
    './worker-cleanup-journal.test.cjs',
    './job-protocol.test.cjs',
    './package.test.cjs',
    './standalone.test.cjs',
];

(async () => {
    for (const suite of SUITES) {
        require(path.join(__dirname, suite));
    }
    process.exitCode = await runRegistered();
})();
