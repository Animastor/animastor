'use strict';

/**
 * Installer tooling index — Private Worker Installer Phase 1 / Phase 1.5.
 *
 * Read-only architecture foundation: canonical install manifests,
 * compatibility resolver, workflow artifacts, download planner, interactive
 * install plan, safety rules, and verification reporting.
 *
 * No installation is performed here; see
 * docs/04-planning/private-worker-installer-phase15.md
 *
 * PUBLIC API of @animastor/installer — this is the ONLY supported entry
 * point for host consumers (e.g. backend routes). Internal paths
 * (src/installer/<module>) are not part of the package contract.
 */

const manifest = require('./install-manifest');
const resolver = require('./compatibility-resolver');
const workflows = require('./workflow-artifacts');
const downloads = require('./download-planner');
const plan = require('./install-plan');
const safety = require('./safety-rules');
const verification = require('./verification-report');
const engine = require('./engine/engine');
const uninstaller = require('./uninstaller');
const setupContract = require('./setup-contract');

module.exports = {
    manifest,
    resolver,
    workflows,
    downloads,
    plan,
    safety,
    verification,
    engine,
    uninstaller,
    setupContract,
};
