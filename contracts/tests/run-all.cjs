// ======================================================
// @animastor/contracts — package-owned test runner
// ======================================================
// Zero-dependency test driver (mirrors ai-connector/test/run-all.cjs).
// Run: npm test   (from contracts/)
// ======================================================

const path = require('path');
const { runRegistered } = require('./harness.cjs');

const SUITES = [
    './job-protocol-v2.test.cjs',
];

(async () => {
    for (const suite of SUITES) {
        require(path.join(__dirname, suite));
    }
    process.exitCode = await runRegistered();
})();
