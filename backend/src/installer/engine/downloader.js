'use strict';

/**
 * Downloader — Private Worker Installer Phase 2.
 *
 * Real model/file downloading on top of download-planner specs:
 *   - canonical source from the manifest ONLY (URLs are never invented);
 *   - idempotent: a verified final file is never re-downloaded;
 *   - resumable: .part file + HTTP Range where the source supports it;
 *   - a partially downloaded file is NEVER treated as a ready model;
 *   - atomic rename .part → final only after full verification;
 *   - size check + SHA-256 when the manifest provides them;
 *   - retry with backoff on transient failures;
 *   - clear errors; BLOCKED when the source is not researched.
 *
 * Platform abstraction: huggingface and modelscope adapters translate a
 * manifest source into a download strategy without tying the engine to one
 * platform. Tokens (HF_TOKEN, MODELSCOPE_API_TOKEN) are read from the
 * environment, passed as headers only, and NEVER logged.
 */

const SIZE_TOLERANCE = 0.05;

function normPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Verify an already-present file against the manifest expectations.
 * @returns {ok: boolean, grade: string, reason?: string}
 */
async function verifyFile(io, absPath, { checksum = null, sizeBytesApprox = null }) {
    if (!io.fs.existsSync(absPath)) return { ok: false, grade: 'absent' };
    const st = io.fs.statSync(absPath);
    if (checksum && checksum.value) {
        const actual = await io.hashFile(absPath, checksum.algo || 'sha256');
        if (actual.toLowerCase() === String(checksum.value).toLowerCase()) {
            return { ok: true, grade: 'checksum-verified' };
        }
        return { ok: false, grade: 'corrupt', reason: `sha256 mismatch (got ${actual.slice(0, 12)}…)` };
    }
    if (checksum && checksum.value_prefix) {
        const actual = await io.hashFile(absPath, checksum.algo || 'sha256');
        if (actual.toLowerCase().startsWith(String(checksum.value_prefix).toLowerCase())) {
            return { ok: true, grade: 'checksum-prefix-verified' };
        }
        return { ok: false, grade: 'corrupt', reason: `sha256 prefix mismatch (got ${actual.slice(0, 12)}…)` };
    }
    if (typeof sizeBytesApprox === 'number' && sizeBytesApprox > 0) {
        const rel = Math.abs(st.size - sizeBytesApprox) / sizeBytesApprox;
        if (rel <= SIZE_TOLERANCE) return { ok: true, grade: 'size-verified', size: st.size };
        return { ok: false, grade: 'size-mismatch', reason: `size ${st.size} differs from expected ~${sizeBytesApprox} by ${(rel * 100).toFixed(1)}%` };
    }
    return { ok: true, grade: 'presence' };
}

/**
 * Download one file per a download-planner spec.
 *
 * @param {object} io io adapter (http.download, fs, hashFile)
 * @param {object} spec download-planner spec
 * @param {object} opts { root, getHeader, retries, retryDelayMs, onProgress, log }
 * @returns {{ status: 'verified'|'downloaded'|'resumed'|'skipped'|'blocked'|'failed',
 *             grade?, reason?, target_path, attempts }}
 */
async function downloadArtifact(io, spec, opts = {}) {
    const {
        root = '',
        getHeader = () => ({}),
        retries = 3,
        retryDelayMs = 500,
        onProgress = null,
        log = null,
    } = opts;

    const targetRel = normPath(spec.target_path);
    const absTarget = root ? `${root}/${targetRel}` : targetRel;
    const absPart = `${absTarget}.part`;

    if (!spec.ready) {
        return {
            status: 'blocked',
            reason: spec.blockers && spec.blockers.length > 0
                ? spec.blockers.join('; ')
                : 'download source is not researched/configured in the manifest — URLs are never invented',
            target_path: targetRel,
            attempts: 0,
        };
    }

    // Idempotency: a verified final file is never re-downloaded.
    const existing = await verifyFile(io, absTarget, { checksum: spec.checksum, sizeBytesApprox: spec.size_bytes_approx });
    if (existing.ok) {
        return { status: 'skipped', grade: existing.grade, target_path: targetRel, attempts: 0 };
    }
    if (existing.grade === 'corrupt' || existing.grade === 'size-mismatch') {
        // never continue with a possibly corrupt model — remove and re-download
        try { io.fs.unlinkSync(absTarget); } catch (_) { /* already gone */ }
        if (log) log.warn(`${spec.id}: existing file failed verification (${existing.reason}) — re-downloading`);
    }

    const dir = absTarget.replace(/\/[^/]+$/, '');
    if (dir && !io.fs.existsSync(dir)) io.fs.mkdirSync(dir, { recursive: true });

    const headers = getHeader(spec);
    let attempt = 0;
    let lastError = null;

    for (attempt = 1; attempt <= retries; attempt += 1) {
        try {
            let appendFrom = 0;
            if (io.fs.existsSync(absPart)) {
                try { appendFrom = io.fs.statSync(absPart).size; } catch (_) { appendFrom = 0; }
            }

            const res = await io.http.download({
                url: spec.url,
                dest: absPart,
                appendFrom,
                headers,
                onProgress,
            });

            if (res.status === 416 && appendFrom > 0) {
                // Range not satisfiable — the part may already be complete or
                // the server disagrees; verify below, else restart once.
            } else if (res.status !== 200 && res.status !== 206) {
                const authHint = res.status === 401 || res.status === 403
                    ? ' — authentication error: check the access token (gated/private model?). The token value is never logged.'
                    : '';
                throw new Error(`HTTP ${res.status} from source${authHint}${res.error ? ` (${String(res.error).slice(0, 200)})` : ''}`);
            }

            const verification = await verifyFile(io, absPart, { checksum: spec.checksum, sizeBytesApprox: spec.size_bytes_approx });
            if (!verification.ok) {
                try { io.fs.unlinkSync(absPart); } catch (_) { /* ignore */ }
                return {
                    status: 'failed',
                    grade: verification.grade,
                    reason: verification.reason,
                    target_path: targetRel,
                    attempts: attempt,
                };
            }

            // atomic publish — only a fully verified file becomes the model
            io.fs.renameSync(absPart, absTarget);
            return {
                status: res.resumed ? 'resumed' : 'downloaded',
                grade: verification.grade,
                target_path: targetRel,
                attempts: attempt,
            };
        } catch (err) {
            lastError = err;
            if (log) log.warn(`${spec.id}: download attempt ${attempt}/${retries} failed: ${err.message}`);
            if (attempt < retries && retryDelayMs > 0) {
                await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
            }
        }
    }

    return {
        status: 'failed',
        reason: lastError ? lastError.message : 'download failed',
        target_path: targetRel,
        attempts: attempt - 1,
    };
}

// ---------------------------------------------------------------------------
// Platform adapters — manifest source → request headers
// ---------------------------------------------------------------------------

/**
 * Build the auth header provider for a spec. Tokens come from environment
 * variables; they are used in request headers ONLY and never logged.
 * @param {object} envVars usually process.env (injectable for tests)
 */
function makeHeaderProvider(envVars = {}) {
    return (spec) => {
        const headers = {};
        if (spec.kind === 'huggingface') {
            const token = envVars.HF_TOKEN || envVars.HUGGINGFACE_HUB_TOKEN;
            if (token) headers.Authorization = `Bearer ${token}`;
        }
        if (spec.kind === 'modelscope') {
            const token = envVars.MODELSCOPE_API_TOKEN;
            if (token) headers.Authorization = `Bearer ${token}`;
        }
        return headers;
    };
}

/**
 * ModelScope strategy note: repo-style snapshots are either delivered by the
 * custom node itself (delivery.mechanism = node_auto_download) or need the
 * modelscope CLI. Until decision D2 is made, the engine does not invent a
 * download path — it reports the situation.
 */
function modelscopeStrategy(dep) {
    if (dep.delivery && dep.delivery.mechanism === 'node_auto_download') {
        return {
            mechanism: 'node_auto_download',
            note: 'the custom node downloads this ModelScope repo on first run; the installer verifies presence afterwards (decision D2 open)',
        };
    }
    return {
        mechanism: 'blocked',
        note: 'ModelScope snapshot download is not configured for this entry — no URL is invented',
    };
}

module.exports = {
    SIZE_TOLERANCE,
    verifyFile,
    downloadArtifact,
    makeHeaderProvider,
    modelscopeStrategy,
};
