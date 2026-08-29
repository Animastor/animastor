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
 * ModelScope strategy: D2 closed — installer pre-downloads ModelScope repos
 * for deterministic/offline operation. The custom node's auto_download is
 * NOT relied upon.
 */
function modelscopeStrategy(dep) {
    if (dep.delivery && dep.delivery.mechanism === 'installer_preload') {
        return {
            mechanism: 'installer_preload',
            note: 'installer pre-downloads this ModelScope repo (D2 closed: deterministic/offline)',
        };
    }
    if (dep.delivery && dep.delivery.mechanism === 'node_auto_download') {
        return {
            mechanism: 'node_auto_download',
            note: 'the custom node downloads this ModelScope repo on first run; the installer verifies presence afterwards',
        };
    }
    return {
        mechanism: 'blocked',
        note: 'ModelScope snapshot download is not configured for this entry — no URL is invented',
    };
}

// ---------------------------------------------------------------------------
// ModelScope snapshot download (D2 closed: deterministic/offline)
// ---------------------------------------------------------------------------

/**
 * ModelScope REST API base for file operations.
 * Listing:  /api/v1/models/{owner}/{name}/repo/files?Revision={rev}[&Root={dir}]
 *           → { Code, Data: { Files: [{ Name, Path, Type: 'tree'|'blob', Size, Sha256 }] } }
 *           ('tree' entries are subdirectories — list them via Root=Path)
 * Download: /api/v1/models/{owner}/{name}/repo?Revision={rev}&FilePath={path}
 */
const MODELSCOPE_API_BASE = 'https://modelscope.cn/api/v1/models';

/**
 * Build a ModelScope file download URL.
 * @param {string} repository e.g. "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
 * @param {string} filePath relative path within the repo
 * @param {string} [revision] git revision (default: master)
 * @returns {string} full download URL
 */
function modelscopeFileUrl(repository, filePath, revision = 'master') {
    const encoded = encodeURIComponent(filePath);
    return `${MODELSCOPE_API_BASE}/${repository}/repo?Revision=${encodeURIComponent(revision)}&FilePath=${encoded}`;
}

/**
 * List ALL files in a ModelScope repository via the REST API.
 *
 * The files endpoint lists ONE directory level at a time; subdirectories
 * (Type='tree') are recursed via the Root parameter, so nested files like
 * `speech_tokenizer/model.safetensors` are included with their full path.
 *
 * @param {object} io io adapter (io.http.fetchJson)
 * @param {string} repository e.g. "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
 * @param {string} [revision] git revision (default: master)
 * @param {string} [token] MODELSCOPE_API_TOKEN (optional, public repos work without)
 * @returns {{ ok: boolean, files?: Array<{Path, Size, Sha256}>, error?: string }}
 */
async function listModelScopeFiles(io, repository, revision = 'master', token = null) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const listDir = async (rootPath) => {
        let url = `${MODELSCOPE_API_BASE}/${repository}/repo/files?Revision=${encodeURIComponent(revision)}`;
        if (rootPath) url += `&Root=${encodeURIComponent(rootPath)}`;
        const { status, json } = await io.http.fetchJson(url, { headers });
        if (status === 401 || status === 403) {
            throw new Error(`HTTP ${status} — authentication required (private/gated ModelScope repo?)`);
        }
        if (status !== 200 || !json) {
            throw new Error(`HTTP ${status} listing ModelScope repo ${repository}${rootPath ? ` (at ${rootPath})` : ''}`);
        }
        // Real API shape: { Data: { Files: [...] } }; keep tolerant fallbacks
        // for legacy/flat shapes.
        if (json.Data && Array.isArray(json.Data.Files)) return json.Data.Files;
        if (json.Data && Array.isArray(json.Data.Items)) return json.Data.Items;
        if (Array.isArray(json)) return json;
        return [];
    };

    try {
        const files = [];
        const seenFiles = new Set();
        const seenDirs = new Set();
        const queue = [''];
        while (queue.length > 0) {
            const dir = queue.shift();
            if (seenDirs.has(dir)) continue;
            seenDirs.add(dir);
            const items = await listDir(dir);
            for (const item of items) {
                const p = normPath(item.Path || item.path || item.Name || item.name || '');
                if (!p) continue;
                const isDir = item.Type === 'tree' || item.type === 'tree' || item.Mode === '16384' || p.endsWith('/');
                if (isDir) {
                    queue.push(p.replace(/\/+$/, ''));
                    continue;
                }
                if (seenFiles.has(p)) continue; // never double-list a file
                seenFiles.add(p);
                files.push({
                    Path: p,
                    Size: typeof item.Size === 'number' ? item.Size : (typeof item.size === 'number' ? item.size : 0),
                    Sha256: item.Sha256 || item.sha256 || null,
                });
            }
        }
        return { ok: true, files };
    } catch (err) {
        return { ok: false, error: err.message.startsWith('HTTP') || err.message.includes('listing ModelScope')
            ? err.message
            : `failed to list ModelScope repo ${repository}: ${err.message}` };
    }
}

/**
 * Download all files from a ModelScope repo into a target directory.
 *
 * This is the `installer_preload` implementation: the engine calls this
 * instead of downloadArtifact when the dependency source kind is modelscope
 * and the delivery mechanism is installer_preload.
 *
 * Behavior:
 *   - Lists files via ModelScope REST API
 *   - Downloads each file individually with the same retry/resume/verify
 *     logic as downloadArtifact
 *   - Idempotent: verified files are skipped
 *   - Checksum mismatch: file is deleted and re-downloaded
 *   - Creates subdirectories as needed (e.g. speech_tokenizer/)
 *
 * @param {object} io io adapter
 * @param {object} spec download-planner spec (from planModelDownload)
 * @param {object} opts { root, getHeader, retries, retryDelayMs, log, expectedFiles, checksums }
 * @returns {{ status, files?, reason?, attempts }}
 */
async function downloadModelScopeRepo(io, spec, opts = {}) {
    const {
        root = '',
        getHeader = () => ({}),
        retries = 3,
        retryDelayMs = 500,
        log = null,
        expectedFiles = null,
        checksums = null,
        progress = null,
    } = opts;

    const repository = spec.repository || (spec.url && spec.url.replace(/.*\/models\//, '').replace(/\/repo.*/, ''));
    const revision = spec.revision || 'master';
    const targetDir = normPath(spec.target_path);
    const absTargetDir = root ? `${root}/${targetDir}` : targetDir;

    if (!repository) {
        return { status: 'blocked', reason: 'ModelScope repository is not specified in the manifest' };
    }

    // Step 1: list files
    const token = (typeof process !== 'undefined' && process.env)
        ? (process.env.MODELSCOPE_API_TOKEN || null)
        : null;
    const listing = await listModelScopeFiles(io, repository, revision, token);
    if (!listing.ok) {
        return { status: 'failed', reason: `ModelScope file listing failed: ${listing.error}` };
    }

    if (listing.files.length === 0) {
        return { status: 'failed', reason: `ModelScope repo ${repository} has no downloadable files` };
    }

    // Step 2: determine which files to download
    // Use expectedFiles from manifest if provided, otherwise download all
    let filesToDownload = listing.files;
    if (expectedFiles && expectedFiles.length > 0) {
        const expectedSet = new Set(expectedFiles.map(normPath));
        filesToDownload = listing.files.filter((f) => expectedSet.has(normPath(f.Path)));
        if (filesToDownload.length === 0) {
            return { status: 'failed', reason: `none of the expected files (${expectedFiles.join(', ')}) were found in ModelScope repo ${repository}` };
        }
    }

    // Step 3: download each file
    const results = [];
    let totalAttempts = 0;
    let anyFailed = false;

    // Aggregate progress across the whole repo (bytes + file counters).
    if (progress && progress.beginRepo) {
        const bytesTotal = filesToDownload.reduce((acc, f) => acc + (typeof f.Size === 'number' && f.Size > 0 ? f.Size : 0), 0);
        progress.beginRepo({ repository, filesTotal: filesToDownload.length, bytesTotal: bytesTotal || null });
    }

    for (const file of filesToDownload) {
        const filePath = normPath(file.Path);
        const absFile = `${absTargetDir}/${filePath}`;
        const absPart = `${absFile}.part`;

        // Checksum for this specific file: manifest-provided first; otherwise
        // the registry's own sha256 from the listing (real API data, never
        // invented) — empty registry sha256 falls back to size verification.
        const fileChecksum = (checksums && checksums[filePath])
            || (file.Sha256 ? { algo: 'sha256', value: file.Sha256 } : null);

        // Idempotency: verify existing file
        const existing = await verifyFile(io, absFile, { checksum: fileChecksum || null, sizeBytesApprox: file.Size || null });
        if (existing.ok) {
            results.push({ path: filePath, status: 'skipped', grade: existing.grade });
            if (progress && progress.fileSkipped) progress.fileSkipped(filePath, file.Size);
            continue;
        }
        if (existing.grade === 'corrupt' || existing.grade === 'size-mismatch') {
            try { io.fs.unlinkSync(absFile); } catch (_) { /* already gone */ }
            if (log) log.warn(`${spec.id}: file ${filePath} failed verification (${existing.reason}) — re-downloading`);
        }

        // Ensure directory exists
        const dir = absFile.replace(/\/[^/]+$/, '');
        if (dir && !io.fs.existsSync(dir)) io.fs.mkdirSync(dir, { recursive: true });

        // Download with retry
        const url = modelscopeFileUrl(repository, filePath, revision);
        const headers = getHeader({ kind: 'modelscope' });
        let fileAttempts = 0;
        let lastError = null;

        if (progress && progress.beginFile) progress.beginFile(`${repository}/${filePath}`, file.Size || null);

        for (let attempt = 1; attempt <= retries; attempt += 1) {
            fileAttempts = attempt;
            try {
                let appendFrom = 0;
                if (io.fs.existsSync(absPart)) {
                    try { appendFrom = io.fs.statSync(absPart).size; } catch (_) { appendFrom = 0; }
                }

                const res = await io.http.download({
                    url,
                    dest: absPart,
                    appendFrom,
                    headers,
                    onProgress: progress && progress.onChunk ? (e) => progress.onChunk(e) : undefined,
                });

                if (res.status === 416 && appendFrom > 0) {
                    // Range not satisfiable — verify below
                } else if (res.status !== 200 && res.status !== 206) {
                    const authHint = res.status === 401 || res.status === 403
                        ? ' — authentication error: check the MODELSCOPE_API_TOKEN' : '';
                    throw new Error(`HTTP ${res.status} from ModelScope${authHint}`);
                }

                // Verify downloaded file
                const verification = await verifyFile(io, absPart, {
                    checksum: fileChecksum || null,
                    sizeBytesApprox: file.Size || null,
                });
                if (!verification.ok) {
                    try { io.fs.unlinkSync(absPart); } catch (_) { /* ignore */ }
                    results.push({ path: filePath, status: 'failed', grade: verification.grade, reason: verification.reason });
                    if (progress && progress.endFile) progress.endFile({ status: 'failed', bytes: appendFrom });
                    anyFailed = true;
                    break;
                }

                // Atomic publish
                io.fs.renameSync(absPart, absFile);
                results.push({ path: filePath, status: res.resumed ? 'resumed' : 'downloaded', grade: verification.grade });
                if (progress && progress.endFile) progress.endFile({ status: res.resumed ? 'resumed' : 'downloaded', bytes: file.Size });
                lastError = null;
                break;
            } catch (err) {
                lastError = err;
                if (log) log.warn(`${spec.id}: file ${filePath} attempt ${attempt}/${retries} failed: ${err.message}`);
                if (attempt < retries && retryDelayMs > 0) {
                    await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
                }
            }
        }

        if (lastError) {
            results.push({ path: filePath, status: 'failed', reason: lastError.message });
            if (progress && progress.endFile) progress.endFile({ status: 'failed', bytes: 0 });
            anyFailed = true;
        }
        totalAttempts += fileAttempts;
    }

    if (progress && progress.endRepo) progress.endRepo({ status: anyFailed ? 'failed' : 'downloaded' });

    if (anyFailed) {
        const failed = results.filter((r) => r.status === 'failed');
        return {
            status: 'failed',
            reason: `${failed.length} file(s) failed to download from ModelScope repo ${repository}`,
            files: results,
            attempts: totalAttempts,
        };
    }

    return {
        status: 'downloaded',
        files: results,
        attempts: totalAttempts,
    };
}

module.exports = {
    SIZE_TOLERANCE,
    verifyFile,
    downloadArtifact,
    makeHeaderProvider,
    modelscopeStrategy,
    listModelScopeFiles,
    downloadModelScopeRepo,
    modelscopeFileUrl,
    MODELSCOPE_API_BASE,
};
