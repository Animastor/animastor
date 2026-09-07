// ======================================================
// animastor-ai-connector — package-owned test runner
// ======================================================
// Zero-dependency test driver so the package test contour runs
// autonomously relative to the backend monorepo: no chai, no mocha, no
// PG, no Redis — only this package's own modules and node builtins from
// the LAC dependency allowlist. The runner lives in harness.cjs.
//
// Run: npm test   (from ai-connector/)
// ======================================================

const path = require('path');
const { runRegistered } = require('./harness.cjs');

const SUITES = [
    './config.test.cjs',
    './chat.test.cjs',
    './adapter.test.cjs',
    './connector-session.test.cjs',
    './connector-chat.test.cjs',
    './streaming.test.cjs',
    './contract.test.cjs',
];

(async () => {
    for (const suite of SUITES) {
        require(path.join(__dirname, suite));
    }
    process.exitCode = await runRegistered();
})();
