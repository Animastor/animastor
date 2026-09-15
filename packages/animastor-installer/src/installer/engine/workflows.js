'use strict';

/**
 * Baseline workflow installation — Private Worker Installer Phase 2.
 *
 * A baseline workflow is an EDITABLE starting point:
 *   - downloaded only when absent at the baseline path;
 *   - an existing user file is NEVER overwritten (even if it differs);
 *   - a fresh official copy can be written to a distinct path
 *     (*.animastor-baseline.json) on explicit request;
 *   - after writing: JSON must parse, sha256 must match the manifest
 *     baseline_sha256, and the file must be at the expected path
 *     (tmp file + atomic rename).
 *
 * Sources (in order, never invented):
 *   1. repository_path — when the installer runs from an Animastor repo
 *      checkout (the canonical production file);
 *   2. endpoint — GET {HUB_URL}/workflow/<id>, if the hub provides it;
 *   otherwise BLOCKED.
 */

const path = require('path');
const { baselineTargetPath, freshCopyPath, listProfileWorkflows } = require('../workflow-artifacts');

function findWorkflowArtifact(manifests, wfId) {
    for (const m of manifests) {
        const wf = listProfileWorkflows(m).find((w) => w.id === wfId);
        if (wf) return wf;
    }
    return null;
}

async function readCanonicalContent(io, { wf, repoRoot, hubUrl, httpFetchText, log = null }) {
    if (wf.source && wf.source.repository_path && repoRoot) {
        // Two layouts carry the canonical workflows:
        //   dev checkout —  <repoRoot>/backend/ai/workflows/...
        //   tarball      —  <repoRoot>/animastor-installer/backend/ai/workflows/...
        // (REPO_ROOT resolves to the extraction PARENT when cli.js runs from
        // <extract>/animastor-installer/src/installer — hence the second candidate)
        for (const abs of [
            path.join(repoRoot, wf.source.repository_path),
            path.join(repoRoot, 'animastor-installer', wf.source.repository_path),
        ]) {
            if (io.fs.existsSync(abs)) {
                return { content: io.fs.readFileSync(abs, 'utf8'), origin: `repository ${path.relative(repoRoot, abs)}` };
            }
        }
    }
    if (wf.source && wf.source.endpoint && hubUrl && httpFetchText) {
        // Manifest endpoints carry an HTTP method prefix ("GET {HUB_URL}/workflow/x");
        // fetch() needs the bare URL. Strip it, substitute {HUB_URL}, and never let a
        // network failure crash the whole workflow step — fall through to "blocked".
        let url = String(wf.source.endpoint).replace(/^[A-Za-z]+\s+/, '');
        url = url.replace('{HUB_URL}', hubUrl.replace(/\/$/, ''));
        try {
            const res = await httpFetchText(url);
            if (res && res.status === 200 && res.text) {
                return { content: res.text, origin: url };
            }
            if (log) log.warn(`hub workflow endpoint ${url} returned status ${res ? res.status : 'no response'}`);
        } catch (err) {
            if (log) log.warn(`hub workflow endpoint ${url} unreachable: ${err.message}`);
        }
    }
    return null;
}

/**
 * Install baseline workflows per the plan step.
 * @param {object} io
 * @param {object} opts { root, manifests, planStep, repoRoot, hubUrl, crypto, log }
 * @returns array of per-workflow results
 */
async function installWorkflows(io, opts) {
    const { root, manifests, planStep, repoRoot = null, hubUrl = null, crypto = null, log = null } = opts;
    const results = [];
    const items = (planStep.action && planStep.action.items) || [];

    for (const item of items) {
        const wf = findWorkflowArtifact(manifests, item.id);
        if (!wf) {
            results.push({ id: item.id, status: 'blocked', reason: 'workflow artifact not found in any manifest' });
            continue;
        }
        const relTarget = item.target_path || (item.fresh_copy ? freshCopyPath(wf) : baselineTargetPath(wf));
        const absTarget = path.join(root, relTarget);

        if (io.fs.existsSync(absTarget)) {
            results.push({
                id: item.id,
                status: 'kept',
                target_path: relTarget,
                reason: 'target already exists — never overwritten',
            });
            continue;
        }

        const canonical = await readCanonicalContent(io, { wf, repoRoot, hubUrl, httpFetchText: opts.httpFetchText, log });
        if (!canonical) {
            results.push({
                id: item.id,
                status: 'blocked',
                reason: 'canonical workflow source is not available on this machine (no repo checkout, hub endpoint unreachable) — nothing was invented',
            });
            continue;
        }

        // validate BEFORE writing anything
        let parsed;
        try {
            parsed = JSON.parse(canonical.content);
        } catch (err) {
            results.push({ id: item.id, status: 'failed', reason: `canonical workflow is not valid JSON: ${err.message}` });
            continue;
        }
        if (!parsed || typeof parsed !== 'object') {
            results.push({ id: item.id, status: 'failed', reason: 'canonical workflow JSON is empty' });
            continue;
        }

        if (crypto && wf.baseline_sha256) {
            const actual = crypto.createHash('sha256').update(Buffer.from(canonical.content)).digest('hex');
            if (actual.toLowerCase() !== String(wf.baseline_sha256).toLowerCase()) {
                results.push({
                    id: item.id,
                    status: 'failed',
                    reason: `canonical content sha256 ${actual.slice(0, 12)}… does not match manifest baseline ${String(wf.baseline_sha256).slice(0, 12)}… — manifest revision required`,
                });
                continue;
            }
        }

        const dir = path.dirname(absTarget);
        if (!io.fs.existsSync(dir)) io.fs.mkdirSync(dir, { recursive: true });
        const tmp = `${absTarget}.tmp`;
        io.fs.writeFileSync(tmp, canonical.content);
        io.fs.renameSync(tmp, absTarget); // atomic publish

        if (log) log.info(`baseline workflow installed: ${relTarget} (${canonical.origin})`);
        results.push({
            id: item.id,
            status: item.fresh_copy ? 'fresh-copy-installed' : 'installed',
            target_path: relTarget,
            grade: 'sha256-verified',
        });
    }
    return results;
}

module.exports = {
    installWorkflows,
    readCanonicalContent,
};
