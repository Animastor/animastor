'use strict';

/**
 * Installer tooling index — Private Worker Installer Phase 1.
 *
 * Read-only architecture foundation: canonical install manifests +
 * compatibility resolver. No installation is performed here; see
 * docs/04-planning/private-worker-installer-manifest-resolver.md
 */

const manifest = require('./install-manifest');
const resolver = require('./compatibility-resolver');

module.exports = {
    manifest,
    resolver,
};
