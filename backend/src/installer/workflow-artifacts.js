'use strict';

/**
 * Workflow Artifacts — Private Worker Installer Phase 1.5.
 *
 * Baseline workflows are FIRST-CLASS install artifacts. A Generation Profile
 * defines its production (baseline) workflows; the installer can list them,
 * download selected ones into a user-visible location, and leave them alone
 * afterwards.
 *
 * Core principle: "a baseline workflow is an editable starting point, not an
 * immutable configuration". Consequences:
 *   - the installer writes a baseline file once and never modifies it;
 *   - a user copy that differs from the baseline is NOT an error;
 *   - the installer never overwrites or deletes a user's workflow;
 *   - restoring the official baseline = downloading a FRESH copy under a
 *     distinct name (freshCopyPath), so "Animastor baseline" and
 *     "My customized workflow" coexist without conflict.
 *
 * This module is pure (no fs/network) — it only computes paths and download
 * intents. The future installer engine executes them.
 */

function normPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** All baseline workflow artifacts declared by a manifest. */
function listProfileWorkflows(manifest) {
    const section = manifest && manifest.workflows;
    if (!section || !Array.isArray(section.artifacts)) return [];
    return section.artifacts.slice();
}

/** Baseline target path (relative to the ComfyUI root). */
function baselineTargetPath(wf) {
    return `${normPath(wf.target_dir)}/${wf.filename}`;
}

/**
 * Path for a FRESH official copy when the baseline path already holds a
 * user-customized file: same directory, suffixed name, e.g.
 *   img-qwen-image.json  →  img-qwen-image.animastor-baseline.json
 * Guarantees the user's customized copy is never touched.
 */
function freshCopyPath(wf) {
    const dir = normPath(wf.target_dir);
    const file = wf.filename;
    const dot = file.lastIndexOf('.');
    const renamed = dot > 0 ? `${file.slice(0, dot)}.animastor-baseline${file.slice(dot)}` : `${file}.animastor-baseline`;
    return `${dir}/${renamed}`;
}

/**
 * Plan baseline workflow downloads for one manifest against an environment
 * probe. Pure function; returns an array of download intents:
 *   { id, name, target_path, reason, overwrite: false, fresh_copy }
 *
 * Selection semantics:
 *   selection = 'all' | 'none' | array of workflow ids.
 *   - missing baselines are proposed for download (only if selected);
 *   - present baselines are skipped (never re-downloaded silently);
 *   - customized baselines are skipped; a fresh copy is proposed ONLY when
 *     the caller explicitly passes { restoreBaseline: true }.
 *
 * `overwrite` is always false — a hard invariant of Phase 1.5.
 */
function planWorkflowDownloads(manifest, env, selection = 'all', opts = {}) {
    const artifacts = listProfileWorkflows(manifest);
    const selected = (id) => selection === 'all' || (Array.isArray(selection) && selection.includes(id));
    const plans = [];

    for (const wf of artifacts) {
        if (!selected(wf.id)) continue;
        const target = baselineTargetPath(wf);
        const found = env && Array.isArray(env.workflows)
            ? env.workflows.find((w) => normPath(w.path) === target)
            : null;

        if (!found) {
            plans.push({
                id: wf.id,
                name: wf.name,
                target_path: target,
                source: wf.source,
                reason: 'missing',
                overwrite: false,
                fresh_copy: false,
            });
            continue;
        }

        const customized = wf.baseline_sha256 && found.sha256
            && String(found.sha256).toLowerCase() !== String(wf.baseline_sha256).toLowerCase();

        if (customized && opts.restoreBaseline === true) {
            plans.push({
                id: wf.id,
                name: wf.name,
                target_path: freshCopyPath(wf),
                source: wf.source,
                reason: 'restore-fresh-copy',
                overwrite: false,
                fresh_copy: true,
                note: 'user copy differs from the Animastor baseline; fresh copy goes to a distinct path, the user copy is untouched',
            });
        }
        // present (canonical or customized) → no download; never overwritten
    }
    return plans;
}

/**
 * Summarize workflow state for plan rendering:
 *   { baselines_total, installed, missing, customized, user_extras }
 */
function summarizeWorkflowState(manifest, env) {
    const artifacts = listProfileWorkflows(manifest);
    const summary = { baselines_total: artifacts.length, installed: 0, missing: 0, customized: 0, user_extras: 0 };
    const baselinePaths = new Set();

    for (const wf of artifacts) {
        const target = baselineTargetPath(wf);
        baselinePaths.add(target);
        const found = env && Array.isArray(env.workflows)
            ? env.workflows.find((w) => normPath(w.path) === target)
            : null;
        if (!found) {
            summary.missing += 1;
        } else if (wf.baseline_sha256 && found.sha256
            && String(found.sha256).toLowerCase() !== String(wf.baseline_sha256).toLowerCase()) {
            summary.customized += 1;
        } else {
            summary.installed += 1;
        }
    }

    if (env && Array.isArray(env.workflows)) {
        for (const w of env.workflows) {
            if (!baselinePaths.has(normPath(w.path))) summary.user_extras += 1;
        }
    }
    return summary;
}

module.exports = {
    listProfileWorkflows,
    baselineTargetPath,
    freshCopyPath,
    planWorkflowDownloads,
    summarizeWorkflowState,
};
