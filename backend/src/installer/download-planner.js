'use strict';

/**
 * Download Planner — Private Worker Installer Phase 1.5.
 *
 * Pure planning layer for model downloads. Given a manifest dependency
 * (kind=model | model_repo), it produces a declarative download spec the
 * future installer engine will execute. NO network access and NO invented
 * URLs: if the manifest source is not researched yet (repository=null),
 * the spec is marked `ready: false` with explicit blockers — the installer
 * must refuse to guess.
 *
 * Supported source kinds (architecturally):
 *   - huggingface — single file from an HF repo (resolve endpoint, HTTP
 *     range resume);
 *   - modelscope  — repo-style download (ModelScope snapshot); note that
 *     some TTS repos are alternatively delivered by node auto_download
 *     (decision D2), which the spec surfaces instead of hiding.
 *
 * Idempotency/resume contract for the engine:
 *   - download into `<target>.part`, rename on completion;
 *   - resume via HTTP Range when the source supports it;
 *   - skip entirely when the final file already verifies (checksum > size);
 *   - checksum mismatch ⇒ fail the step, never continue with a corrupt model.
 */

const SUPPORTED_SOURCE_KINDS = Object.freeze(['huggingface', 'modelscope']);

function normPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Build a download spec for one model/model_repo dependency.
 *
 * @param {object} dep manifest dependency entry
 * @returns {{
 *   id, kind, ready, url, target_path, part_path, resume, idempotent_skip,
 *   checksum, size_bytes_approx, blockers, notes
 * }}
 */
function planModelDownload(dep) {
    const src = dep.source || {};
    const blockers = [];
    const notes = [];

    const targetPath = dep.kind === 'model_repo'
        ? normPath(dep.target_dir)
        : `${normPath(dep.target_dir)}/${dep.filename}`;

    const spec = {
        id: dep.id,
        kind: src.kind || 'unknown',
        ready: false,
        url: null,
        target_path: targetPath,
        part_path: dep.kind === 'model_repo' ? null : `${targetPath}.part`,
        resume: null,
        idempotent_skip: true,
        checksum: dep.checksum || null,
        size_bytes_approx: dep.size_bytes_approx || null,
        blockers,
        notes,
    };

    if (!SUPPORTED_SOURCE_KINDS.includes(src.kind)) {
        blockers.push(`source kind "${src.kind || 'unknown'}" is not supported yet (supported: ${SUPPORTED_SOURCE_KINDS.join(', ')})`);
        return spec;
    }

    if (src.verification === 'unknown' || !src.repository) {
        blockers.push('download source is not researched yet (D5): repository/revision/sha256 must be confirmed by a human before the installer may download — URLs are never invented');
        if (src.todo) notes.push(src.todo);
        return spec;
    }

    if (src.kind === 'huggingface') {
        if (!src.file_path && dep.kind === 'model') {
            blockers.push('huggingface source needs file_path within the repository');
            return spec;
        }
        const revision = src.revision || 'main';
        spec.url = `https://huggingface.co/${src.repository}/resolve/${revision}/${src.file_path || dep.filename}`;
        spec.resume = 'http-range';
        spec.ready = true;
        if (src.gated) {
            notes.push('gated repository — HF_TOKEN must be provided interactively (hidden input, never logged)');
        }
        return spec;
    }

    // modelscope
    if (dep.delivery && dep.delivery.mechanism === 'node_auto_download') {
        spec.resume = 'node-managed';
        notes.push('this repo can be auto-downloaded by the custom node on first run (decision D2: installer preinstall vs node auto_download is OPEN — the engine must ask the user, never decide silently');
        // ready stays false until D2 is decided for this entry
        blockers.push('D2 pending: choose installer preinstall (deterministic) vs node auto_download for this ModelScope repo');
        return spec;
    }
    spec.url = `https://modelscope.cn/models/${src.repository}`;
    spec.resume = 'snapshot-restart';
    spec.ready = true;
    notes.push('ModelScope snapshot download; resumability depends on the client used by the engine');
    return spec;
}

/**
 * Plan downloads for all required model dependencies of a manifest that the
 * resolver reported as missing. `missingIds` comes from the resolution
 * report (entries with status=missing, action=install).
 */
function planModelDownloads(manifest, missingIds) {
    const deps = (manifest.dependencies || []).filter(
        (d) => (d.kind === 'model' || d.kind === 'model_repo') && missingIds.includes(d.id)
    );
    return deps.map(planModelDownload);
}

/**
 * Disk preflight summary: total bytes the missing models will need.
 * Returns { total_bytes, unknown_count } — unknown sizes are counted
 * separately, never silently assumed zero.
 */
function estimateMissingBytes(specs) {
    let total = 0;
    let unknown = 0;
    for (const s of specs) {
        if (typeof s.size_bytes_approx === 'number') total += s.size_bytes_approx;
        else unknown += 1;
    }
    return { total_bytes: total, unknown_count: unknown };
}

module.exports = {
    SUPPORTED_SOURCE_KINDS,
    planModelDownload,
    planModelDownloads,
    estimateMissingBytes,
};
