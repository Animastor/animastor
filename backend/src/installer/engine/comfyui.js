'use strict';

/**
 * ComfyUI operations — Private Worker Installer Phase 2.
 *
 * install / update / start / health for ComfyUI, driven by the manifest
 * runtime_requirements. Safety invariants:
 *   - update/downgrade only with an explicit user confirmation (the plan
 *     carries it via safety-rules.confirmationGate);
 *   - a checkpoint (previous commit) is recorded before any version change;
 *   - custom_nodes/, models/ and user/ are untracked by git and survive a
 *     checkout — the engine never deletes them;
 *   - ComfyUI listens on 127.0.0.1 only.
 */

const path = require('path');

/**
 * Choose the install source for a clean install.
 * Canonical pin wins; otherwise the known-working reference may be used,
 * but ONLY with explicit consent (it is evidence, not a universal rule).
 */
function pickInstallSource(manifest) {
    const spec = (manifest.runtime_requirements || {}).comfyui || {};
    if (spec.pin && (spec.pin.commit || spec.pin.tag)) {
        return { source: spec.pin, grade: 'canonical', needs_consent: false };
    }
    const ref = spec.known_working_reference;
    if (ref && (ref.commit || ref.tag)) {
        return { source: ref, grade: 'reference', needs_consent: true };
    }
    return null;
}

function installComfyUI(io, { root, source, log }) {
    const repo = source.repository;
    const ref = source.commit || source.tag;
    if (!repo) throw new Error('ComfyUI install source has no repository');
    if (io.fs.existsSync(root)) {
        // The engine writes its install state into <root>/.animastor-installer/
        // BEFORE cloning (resume support). That directory is installer-owned
        // metadata, not user content — it does not make the target "occupied".
        const entries = io.fs.readdirSync(root).filter((n) => n !== '.animastor-installer');
        if (entries.length > 0) {
            throw new Error(`target root ${root} is not empty — refusing to touch it`);
        }
    }
    let r = io.exec('git', ['clone', repo, root]);
    if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr || r.error}`);
    if (ref) {
        r = io.exec('git', ['-C', root, 'checkout', ref]);
        if (r.code !== 0) throw new Error(`git checkout ${ref} failed: ${r.stderr || r.error}`);
    }
    if (log) log.info(`ComfyUI installed at ${root} (${ref || 'HEAD'})`);
    return { root, ref };
}

/**
 * Update an existing ComfyUI to the target ref. The caller must have passed
 * the confirmation gate already; this function records the checkpoint.
 * @returns {{ previous_commit, target }}
 */
function updateComfyUI(io, { root, target, state = null, log }) {
    const git = io.exec('git', ['-C', root, 'rev-parse', 'HEAD']);
    const previousCommit = git.code === 0 ? git.stdout.trim() : null;

    let r = io.exec('git', ['-C', root, 'fetch', '--tags', 'origin']);
    if (r.code !== 0) throw new Error(`git fetch failed: ${r.stderr || r.error}`);
    const ref = target.commit || target.tag;
    r = io.exec('git', ['-C', root, 'checkout', ref]);
    if (r.code !== 0) throw new Error(`git checkout ${ref} failed: ${r.stderr || r.error}`);

    if (state) {
        const { addCheckpoint } = require('./state');
        addCheckpoint(state, { kind: 'comfyui-version-change', root, previous_commit: previousCommit, target: ref });
    }
    if (log) log.info(`ComfyUI updated: ${previousCommit || '?'} → ${ref}`);
    return { previous_commit: previousCommit, target: ref };
}

/** Install ComfyUI python requirements + torch pin into a venv. */
function preparePythonRuntime(io, { root, torchSpec, pythonMinimum, log }) {
    const venvDir = path.join(root, 'venv');
    const py = path.join(venvDir, 'bin', 'python');

    let venvCreated = false;
    if (!io.fs.existsSync(py)) {
        let r = io.exec('python3', ['-m', 'venv', venvDir]);
        if (r.code !== 0) throw new Error(`python3 -m venv failed (code ${r.code}): ${String(r.stderr || r.stdout || r.error || 'no output').slice(-500)}`);
        if (log) log.info(`venv created at ${venvDir}`);
        venvCreated = true;
    }

    // Torch is installed BEFORE requirements.txt: pip then sees the pinned
    // (CUDA- or CPU-flavored) build as satisfied instead of pulling the
    // default PyPI wheel first (a multi-GB CUDA download on CPU-only hosts).
    if (torchSpec && torchSpec.pin) {
        const pin = String(torchSpec.pin);
        const version = pin.split('+')[0];
        const args = ['-m', 'pip', 'install', `torch==${version}`];
        if (torchSpec.index_url) args.push('--index-url', torchSpec.index_url);
        const r = io.exec(py, args, { timeout: 60 * 60 * 1000 });
        if (r.code !== 0) throw new Error(`pip install torch==${version} failed: ${String(r.stderr).slice(-500)}`);
        if (log) log.info(`torch ${pin} installed${torchSpec.index_url ? ` (from ${torchSpec.index_url})` : ''}`);
    }

    const req = path.join(root, 'requirements.txt');
    if (io.fs.existsSync(req)) {
        const r = io.exec(py, ['-m', 'pip', 'install', '-r', req], { timeout: 30 * 60 * 1000 });
        if (r.code !== 0) throw new Error(`pip install -r requirements.txt failed: ${String(r.stderr).slice(-500)}`);
        if (log) log.info('ComfyUI requirements installed');
    }

    return { venv: venvDir, python: py, venv_created: venvCreated };
}

/**
 * Start ComfyUI. In CPU-only mode the `--cpu` flag forces the CPU execution
 * path (ComfyUI's own device selector) — required on hosts without a GPU.
 */
function startComfyUI(io, { root, port = 8188, logFile = null, device = null }) {
    const py = path.join(root, 'venv', 'bin', 'python');
    const python = io.fs.existsSync(py) ? py : 'python3';
    const args = ['main.py', '--listen', '127.0.0.1', '--port', String(port)];
    if (device === 'cpu') args.push('--cpu');
    const pid = io.spawnDaemon(python, args, {
        cwd: root,
        logFile: logFile || path.join(root, 'comfyui-installer.log'),
    });
    return { pid, port, args };
}

async function waitForApi(io, baseUrl, { timeoutMs = 120000, intervalMs = 2000 } = {}) {
    const deadline = io.now() + timeoutMs;
    for (;;) {
        try {
            const { status, json } = await io.http.fetchJson(`${baseUrl}/system_stats`);
            if (status === 200 && json) return { ok: true, system_stats: json };
        } catch (_) { /* not up yet */ }
        if (io.now() > deadline) return { ok: false, reason: `ComfyUI API not reachable at ${baseUrl} after ${timeoutMs} ms` };
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

async function systemStats(io, baseUrl) {
    try {
        const { status, json } = await io.http.fetchJson(`${baseUrl}/system_stats`);
        if (status === 200 && json) return json;
    } catch (_) { /* unreachable */ }
    return null;
}

/** Set of available node class_type names (for workflow validation). */
async function objectInfoClasses(io, baseUrl) {
    try {
        const { status, json } = await io.http.fetchJson(`${baseUrl}/object_info`);
        if (status === 200 && json) return new Set(Object.keys(json));
    } catch (_) { /* unreachable */ }
    return null;
}

/**
 * Validate a workflow JSON against a running ComfyUI WITHOUT running
 * generation: parse → node classes exist → model file refs present on disk.
 */
function validateWorkflowStatic(workflowJson, { availableClasses = null, modelPaths = null } = {}) {
    const problems = { missing_classes: [], missing_models: [], parse_error: null };
    let wf = workflowJson;
    if (typeof wf === 'string') {
        try { wf = JSON.parse(wf); } catch (err) {
            problems.parse_error = err.message;
            return problems;
        }
    }
    if (!wf || typeof wf !== 'object') {
        problems.parse_error = 'workflow is not a JSON object';
        return problems;
    }
    const nodes = wf.nodes && Array.isArray(wf.nodes) ? wf.nodes : null;
    const apiStyle = !nodes; // API format: { "<id>": { class_type, inputs } }
    const items = apiStyle ? Object.values(wf) : nodes;

    for (const node of items) {
        if (!node || typeof node !== 'object') continue;
        const cls = node.class_type || (node.type);
        if (cls && availableClasses && !availableClasses.has(cls)) {
            if (!problems.missing_classes.includes(cls)) problems.missing_classes.push(cls);
        }
        const inputs = node.inputs || (apiStyle ? node.inputs : null) || {};
        for (const v of Object.values(inputs)) {
            if (typeof v === 'string' && /\.(gguf|safetensors|ckpt|pt|bin|onnx)$/i.test(v)) {
                if (modelPaths && !modelPaths.has(v)) {
                    if (!problems.missing_models.includes(v)) problems.missing_models.push(v);
                }
            }
        }
    }
    return problems;
}

module.exports = {
    pickInstallSource,
    installComfyUI,
    updateComfyUI,
    preparePythonRuntime,
    startComfyUI,
    waitForApi,
    systemStats,
    objectInfoClasses,
    validateWorkflowStatic,
};
