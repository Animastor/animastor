'use strict';

/**
 * Repo-checkout location of the Animastor Worker bundle source.
 *
 * Canonical location: packages/animastor-worker/worker — the worker package
 * boundary is being relocated there (see
 * docs/architecture/WORKER_PACKAGE_RELOCATION_AUDIT.md and
 * docs/architecture/WORKER_PACKAGE_RELOCATION_CHECKLIST.md). The legacy repo
 * path `worker/worker` is kept as an existsSync/isDirectory-guarded fallback
 * so repo checkouts from BEFORE the physical relocation commit keep
 * installing; the fallback becomes inert (never matches) once the physical
 * `git mv worker/worker packages/animastor-worker` lands and may be pruned
 * in a later cleanup.
 *
 * Two-sided contract: the GPU Hub installer-package tar entries
 * (`animastor-installer/packages/animastor-worker/worker/*` in
 * packages/animastor-gpu-hub/gpu-hub.js) mirror the canonical layout, so the
 * engine inside an extracted installer package resolves its bundled copy
 * through the same canonical branch. Both sides ship from the same repo
 * build — never change one without the other.
 *
 * The resolver takes an injectable fs (io.fs adapter or node fs) so tests
 * can emulate repo layouts with mock filesystems.
 */

const path = require('path');

/** Repo-relative bundle dir segments — canonical first, legacy fallback. */
const REPO_BUNDLE_DIRS = [
    ['packages', 'animastor-worker', 'worker'],
    ['worker', 'worker'],
];

/** Tolerate both io.fs adapters (isDirectory helper) and node fs. */
function isDir(fsLike, dir) {
    try {
        if (typeof fsLike.isDirectory === 'function') return fsLike.isDirectory(dir);
        return fsLike.statSync(dir).isDirectory();
    } catch (_) {
        return false;
    }
}

/**
 * First existing repo-checkout bundle dir (canonical first), or null when
 * the checkout carries neither layout. Never returns a non-existent path.
 * @param {object} fsLike - io.fs adapter or node fs (statSync/isDirectory)
 * @param {string|null} repoRoot
 * @returns {string|null}
 */
function resolveRepoBundleDir(fsLike, repoRoot) {
    if (!repoRoot || !fsLike) return null;
    for (const segments of REPO_BUNDLE_DIRS) {
        const dir = path.join(repoRoot, ...segments);
        if (isDir(fsLike, dir)) return dir;
    }
    return null;
}

module.exports = {
    REPO_BUNDLE_DIRS,
    resolveRepoBundleDir,
};
