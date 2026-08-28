'use strict';

/**
 * Custom node installation — Private Worker Installer Phase 2.
 *
 * Per required node:
 *   1. check presence (the resolver already did; the engine re-checks);
 *   2. if missing — git clone from the canonical manifest source;
 *   3. pin the manifest revision when one is declared;
 *   4. install the node's Python dependencies (requirements.txt) if present;
 *   5. re-check presence.
 *
 * Already-installed compatible nodes are KEPT — never reinstalled without
 * need. Incompatible nodes stop their step pending a user decision; no
 * destructive replacement happens automatically.
 */

const path = require('path');

function findManifestDep(manifests, depId) {
    for (const m of manifests) {
        const dep = (m.dependencies || []).find((d) => d.id === depId);
        if (dep) return dep;
    }
    return null;
}

/**
 * Install one missing custom node.
 * `origin` distinguishes what the installer actually created ('installed')
 * from what was already on disk ('pre-existing') — the uninstaller removes
 * only 'installed' directories.
 * @returns {{ status: 'installed'|'blocked'|'failed', origin?, reason?, directory? }}
 */
function installCustomNode(io, { root, dep, python = null, log = null }) {
    const src = (dep.install && dep.install.source) || {};
    const dirName = (dep.install && dep.install.directory) || dep.name;
    const target = path.join(root, 'custom_nodes', dirName);

    if (!src.repository) {
        return {
            status: 'blocked',
            reason: `no canonical repository for ${dep.id} in the manifest — the installer never invents sources (D4 research pending)`,
        };
    }

    if (io.fs.existsSync(target)) {
        // present — the resolver decides compatibility; the engine does not
        // replace an existing node automatically.
        return { status: 'installed', origin: 'pre-existing', directory: dirName, reason: 'already present — kept as-is' };
    }

    let r = io.exec('git', ['clone', src.repository, target]);
    if (r.code !== 0) {
        return { status: 'failed', reason: `git clone ${src.repository} failed: ${String(r.stderr || r.error).slice(-300)}` };
    }

    if (src.commit) {
        r = io.exec('git', ['-C', target, 'checkout', src.commit]);
        if (r.code !== 0) {
            return { status: 'failed', reason: `git checkout ${src.commit} failed: ${String(r.stderr).slice(-300)}` };
        }
    }

    const req = path.join(target, 'requirements.txt');
    if (io.fs.existsSync(req) && python) {
        r = io.exec(python, ['-m', 'pip', 'install', '-r', req], { timeout: 30 * 60 * 1000 });
        if (r.code !== 0) {
            if (log) log.warn(`${dep.id}: pip install requirements failed (node cloned, deps incomplete): ${String(r.stderr).slice(-300)}`);
            return { status: 'installed', origin: 'installed', directory: dirName, reason: 'cloned; python dependencies incomplete — see warnings' };
        }
    }

    if (!io.fs.existsSync(target)) {
        return { status: 'failed', reason: 'clone reported success but the directory is missing' };
    }
    if (log) log.info(`custom node installed: ${dirName}${src.commit ? ` @ ${src.commit}` : ''}`);
    return { status: 'installed', origin: 'installed', directory: dirName };
}

/**
 * Install all missing required custom nodes listed in the plan step.
 * Incompatible existing nodes are surfaced as review items — the step stops
 * for them until the user decides (git-safe checkout is a consent-gated op).
 */
function installCustomNodes(io, { root, manifests, planStep, python = null, log = null }) {
    const results = [];
    for (const item of planStep.missing || []) {
        const dep = findManifestDep(manifests, item.id);
        if (!dep) {
            results.push({ id: item.id, status: 'blocked', reason: 'not found in any manifest' });
            continue;
        }
        results.push({ id: item.id, ...installCustomNode(io, { root, dep, python, log }) });
    }
    for (const item of planStep.review || []) {
        results.push({
            id: item.id,
            status: 'needs-user-decision',
            reason: `${item.reason || 'incompatible'} — not changed automatically; a git-safe checkout to the pinned revision is available with explicit consent`,
        });
    }
    return results;
}

module.exports = {
    installCustomNode,
    installCustomNodes,
};
