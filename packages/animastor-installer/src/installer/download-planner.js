'use strict';

/**
 * Download Planner — Private Worker Installer Phase 3.2.
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
 *   - modelscope  — repo-style download (ModelScope snapshot); the
 *     installer preloads the repo (D2 closed: deterministic/offline).
 *
 * Auth logic:
 *   - public HF model → download without token;
 *   - gated/private HF model → use system HF_TOKEN;
 *   - system token unavailable → clear BLOCKED error (user is NOT asked to
 *     create their own HF account).
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
 * @param {object} [opts] planner options
 * @param {boolean} [opts.hasHfToken] whether the system HF token is available
 * @returns {{
 *   id, kind, ready, url, target_path, part_path, resume, idempotent_skip,
 *   checksum, size_bytes_approx, requires_auth, blockers, notes
 * }}
 */
function planModelDownload(dep, opts = {}) {
    const src = dep.source || {};
    const blockers = [];
    const notes = [];
    const hasHfToken = opts.hasHfToken || false;

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
        requires_auth: !!src.gated,
        blockers,
        notes,
    };

    if (!SUPPORTED_SOURCE_KINDS.includes(src.kind)) {
        blockers.push(`source kind "${src.kind || 'unknown'}" is not supported yet (supported: ${SUPPORTED_SOURCE_KINDS.join(', ')})`);
        return spec;
    }

    if (src.verification === 'unknown' || !src.repository) {
        blockers.push('download source is not researched yet: repository/revision/sha256 must be confirmed by a human before the installer may download — URLs are never invented');
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

        if (src.gated) {
            spec.requires_auth = true;
            if (!hasHfToken) {
                blockers.push('Required Hugging Face access is unavailable: set HF_TOKEN or HUGGINGFACE_HUB_TOKEN environment variable (gated model)');
                return spec;
            }
            notes.push('gated repository — system HF token will be used for authentication');
        }

        spec.ready = true;
        return spec;
    }

    // modelscope
    if (dep.delivery && dep.delivery.mechanism === 'installer_preload') {
        spec.resume = 'snapshot-restart';
        const repoPath = normPath(src.repository);
        spec.url = `https://modelscope.cn/models/${repoPath}`;
        spec.repository = src.repository;
        spec.revision = src.revision || 'master';
        spec.ready = true;
        notes.push('ModelScope repo pre-downloaded by installer (D2 closed: deterministic/offline)');
        return spec;
    }

    if (dep.delivery && dep.delivery.mechanism === 'node_auto_download') {
        spec.resume = 'node-managed';
        notes.push('this repo can be auto-downloaded by the custom node on first run');
        // ready stays false — the engine must decide
        blockers.push('delivery mechanism is node_auto_download — installer preload not configured for this entry');
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
 *
 * @param {object} manifest install manifest
 * @param {string[]} missingIds dependency IDs that need downloading
 * @param {object} [opts] planner options
 * @param {boolean} [opts.hasHfToken] whether the system HF token is available
 */
function planModelDownloads(manifest, missingIds, opts = {}) {
    const deps = (manifest.dependencies || []).filter(
        (d) => (d.kind === 'model' || d.kind === 'model_repo') && missingIds.includes(d.id)
    );
    return deps.map((dep) => planModelDownload(dep, opts));
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
