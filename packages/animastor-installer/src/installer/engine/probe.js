'use strict';

/**
 * Environment probe — Private Worker Installer Phase 2.
 *
 * Detects the real installed state of a machine and produces the
 * environment object consumed by the compatibility resolver:
 *
 *   GPU / ComfyUI / Python / Torch / Node.js / custom nodes / models /
 *   workflows / worker bundle+.env
 *
 * Read-only: probing never mutates anything.
 *
 * .env handling is keys-only: the probe records WHICH keys are set, never
 * their values (Worker Key safety).
 */

const path = require('path');
const platforms = require('../platform');

const MODEL_DIRS = [
    'models/unet', 'models/clip', 'models/vae', 'models/loras',
    'models/text_encoders', 'models/checkpoints', 'models/upscale_models',
    'models/latent_upscale_models', 'models/TTS',
];

const WORKFLOW_SCAN_ROOT = 'user/default/workflows';

/**
 * Device kinds for env.device:
 *   cuda — NVIDIA GPU verified through the driver runtime (nvidia-smi query);
 *   cpu  — no supported GPU: CPU-only mode (ComfyUI --cpu, CPU PyTorch).
 * An AMD GPU is detected and reported, but the installer provides no ROCm
 * runtime branch yet — such machines fall back to cpu with an explicit note
 * (never a silent degradation).
 */
const DEVICE_KINDS = Object.freeze(['cuda', 'cpu']);

function firstLine(s) {
    return String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
}

/**
 * NVIDIA GPU detection — runtime check, not just command presence:
 * nvidia-smi must succeed AND report at least one GPU row.
 */
function probeNvidiaGpu(io) {
    const r = io.exec('nvidia-smi', [
        '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits',
    ]);
    if (r.code !== 0) return null;
    const line = firstLine(r.stdout);
    if (!line || /^\[?n?a$/i.test(line)) return null;
    const [name, mib, driver] = line.split(',').map((x) => x.trim());
    if (!name) return null;
    return {
        vendor: 'nvidia',
        name,
        vram_mib: mib ? Number(mib) : null,
        driver_version: driver || null,
    };
}

/**
 * AMD GPU detection with positive evidence only. The detection mechanism is
 * a platform concern (Linux: rocm-smi/drm sysfs/lspci; Windows: wmic) —
 * delegated to the platform adapter. Empty/unknown output is treated as
 * "not detected" — never guessed.
 */
function probeAmdGpu(io, platformAdapter = null) {
    return (platformAdapter || platforms.getPlatformAdapter()).probeAmdGpu(io);
}

function probeGpu(io) {
    const nvidia = probeNvidiaGpu(io);
    if (nvidia) return nvidia;
    const amd = probeAmdGpu(io);
    if (amd) return amd;
    return null;
}

function probeCuda(io) {
    const r = io.exec('nvidia-smi', []);
    if (r.code !== 0) return null;
    const m = /CUDA Version:\s*([0-9.]+)/.exec(r.stdout);
    return m ? m[1] : null;
}

function gitInfo(io, dir) {
    if (!io.fs.isDirectory(path.join(dir, '.git'))) return null;
    const remote = io.exec('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    const head = io.exec('git', ['-C', dir, 'rev-parse', 'HEAD']);
    const tag = io.exec('git', ['-C', dir, 'describe', '--tags', '--exact-match']);
    return {
        repository: remote.code === 0 ? firstLine(remote.stdout) : null,
        commit: head.code === 0 ? firstLine(head.stdout) : null,
        tag: tag.code === 0 ? firstLine(tag.stdout) : null,
    };
}

function probeComfyui(io, root) {
    if (!root || !io.fs.isDirectory(root)) return null;
    const mainPy = io.fs.existsSync(path.join(root, 'main.py'));
    if (!mainPy) return null;
    const git = gitInfo(io, root);
    return {
        present: true,
        repository: git ? git.repository : null,
        commit: git ? git.commit : null,
        tag: git ? git.tag : null,
        version: git && git.tag ? git.tag.replace(/^v/, '') : null,
    };
}

function pythonBin(io, root, platformAdapter = null) {
    // prefer a venv next to ComfyUI, then python3 (venv layout is a
    // platform concern: bin/python on Linux, Scripts/python.exe on Windows)
    if (root) {
        const venvPy = (platformAdapter || platforms.getPlatformAdapter()).venvPythonBin(path.join(root, 'venv'));
        if (io.fs.existsSync(venvPy)) return venvPy;
    }
    return 'python3';
}

function probePython(io, root) {
    const py = pythonBin(io, root);
    const r = io.exec(py, ['--version']);
    if (r.code !== 0) return null;
    const m = /Python\s+([0-9][0-9.]*)/.exec(r.stdout + r.stderr);
    return m ? { version: m[1], binary: py } : null;
}

function probeTorch(io, root) {
    const py = pythonBin(io, root);
    const r = io.exec(py, ['-c', 'import torch; print(torch.__version__)']);
    if (r.code !== 0) return null;
    const v = firstLine(r.stdout);
    return v ? { version: v } : null;
}

function probeNodejs(io) {
    const r = io.exec('node', ['--version']);
    if (r.code !== 0) return null;
    const v = firstLine(r.stdout).replace(/^v/, '');
    return v ? { version: v } : null;
}

function probeCustomNodes(io, root) {
    const dir = path.join(root, 'custom_nodes');
    if (!io.fs.isDirectory(dir)) return [];
    const out = [];
    for (const name of io.fs.readdirSync(dir)) {
        if (!io.fs.isDirectory(path.join(dir, name))) continue;
        const git = gitInfo(io, path.join(dir, name));
        out.push({
            directory: name,
            repository: git ? git.repository : null,
            commit: git ? git.commit : null,
            is_git: git !== null,
        });
    }
    return out;
}

function walkModels(io, root, relDir, out, depth = 0) {
    const abs = path.join(root, relDir);
    if (!io.fs.isDirectory(abs)) return;
    for (const name of io.fs.readdirSync(abs)) {
        const rel = `${relDir}/${name}`;
        const st = io.fs.statSync(path.join(abs, name));
        if (st.isDirectory) {
            if (depth < 3) walkModels(io, root, rel, out, depth + 1);
        } else if (st.isFile) {
            out.push({ path: rel, size_bytes: st.size });
        }
    }
}

function probeModels(io, root) {
    const out = [];
    for (const dir of MODEL_DIRS) walkModels(io, root, dir, out);
    return out;
}

function sha256OfFile(io, crypto, absPath) {
    const data = io.fs.readFileSync(absPath); // workflows are small; fine
    return crypto.createHash('sha256').update(Buffer.from(data)).digest('hex');
}

function walkWorkflows(io, crypto, root, relDir, out) {
    const abs = path.join(root, relDir);
    if (!io.fs.isDirectory(abs)) return;
    for (const name of io.fs.readdirSync(abs)) {
        const rel = `${relDir}/${name}`;
        const st = io.fs.statSync(path.join(abs, name));
        if (st.isDirectory) {
            walkWorkflows(io, crypto, root, rel, out);
        } else if (name.endsWith('.json')) {
            let hash = null;
            try { hash = sha256OfFile(io, crypto, path.join(abs, name)); } catch (_) { /* unreadable */ }
            out.push({ path: rel, sha256: hash });
        }
    }
}

function probeWorkflows(io, crypto, root) {
    const out = [];
    walkWorkflows(io, crypto, root, WORKFLOW_SCAN_ROOT, out);
    return out;
}

/** Parse KEY=value lines; record key NAMES only — never values. */
function parseEnvKeys(text) {
    const keys = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (m) keys.push(m[1]);
    }
    return keys;
}

function probeWorker(io, workerDir) {
    if (!workerDir || !io.fs.isDirectory(workerDir)) return null;
    // '.env' is excluded on purpose (secret values are never probed); other
    // dotfiles (e.g. '.env.example' from the bundle manifest) are visible.
    let files = [];
    try { files = io.fs.readdirSync(workerDir).filter((f) => f !== '.env'); } catch (_) { files = []; }
    const envPath = path.join(workerDir, '.env');
    let env = null;
    if (io.fs.existsSync(envPath)) {
        env = { present: true, set_keys: parseEnvKeys(io.fs.readFileSync(envPath, 'utf8')) };
    }
    return {
        worker_type: null, // resolved by the engine against the manifest worker_type
        bundle: { present: files.includes('worker.cjs'), dir: workerDir, files },
        env,
    };
}

/**
 * Probe the full environment.
 * @param {object} io
 * @param {object} opts { root: ComfyUI root, workerDir, crypto }
 * @returns resolver-compatible environment object
 */
function probeEnvironment(io, { root = null, workerDir = null, crypto = null, workerType = null } = {}) {
    const env = {
        root,
        comfyui: undefined,
        python: undefined,
        torch: undefined,
        nodejs: undefined,
        gpu: undefined,
        device: undefined,
        custom_nodes: undefined,
        models: undefined,
        python_packages: undefined,
        workflows: undefined,
        worker: undefined,
    };

    env.gpu = probeGpu(io);
    env.cuda = probeCuda(io);
    env.device = env.gpu && env.gpu.vendor === 'nvidia' ? 'cuda' : 'cpu';
    env.nodejs = probeNodejs(io);
    env.comfyui = probeComfyui(io, root);
    env.python = probePython(io, root);
    env.torch = probeTorch(io, root);

    if (env.comfyui) {
        env.custom_nodes = probeCustomNodes(io, root);
        env.models = probeModels(io, root);
        env.python_packages = [];
        if (crypto) env.workflows = probeWorkflows(io, crypto, root);
    } else {
        env.custom_nodes = [];
        env.models = [];
        env.python_packages = [];
        env.workflows = [];
    }

    const worker = probeWorker(io, workerDir);
    if (worker) {
        worker.worker_type = workerType;
        env.worker = worker;
    } else {
        env.worker = null;
    }

    return env;
}

/** Human-readable detection summary (for `detect` / existing-mode display). */
function renderDetection(env) {
    const lines = [];
    if (env.gpu && env.gpu.name) {
        lines.push(`GPU: ${env.gpu.name}${env.gpu.vram_mib ? ` (${Math.round(env.gpu.vram_mib / 1024)} GB VRAM)` : ''} [${env.gpu.vendor}]`);
    } else {
        lines.push('GPU: not detected');
    }
    if (env.device === 'cpu') {
        lines.push('Device: CPU-only mode');
        if (env.gpu && env.gpu.vendor === 'amd') {
            lines.push('  Note: an AMD GPU was detected, but the installer provides no ROCm/accelerated runtime branch yet — CPU mode will be used.');
        }
        lines.push('  Warning: performance will be SIGNIFICANTLY lower than GPU. Suitable for the TTS/audio profile test, not for image/video generation.');
    } else {
        lines.push('Device: CUDA (NVIDIA GPU acceleration)');
    }
    if (env.cuda) lines.push(`CUDA: ${env.cuda}`);
    if (env.comfyui && env.comfyui.present) {
        lines.push(`ComfyUI: detected at ${env.root}`);
        lines.push(`  Version: ${env.comfyui.version || env.comfyui.tag || env.comfyui.commit || 'unknown'}`);
    } else {
        lines.push('ComfyUI: not detected');
    }
    lines.push(`Python: ${env.python ? env.python.version : 'not detected'}`);
    lines.push(`Torch: ${env.torch ? env.torch.version : 'not detected'}`);
    lines.push(`Node.js: ${env.nodejs ? env.nodejs.version : 'not detected'}`);
    if (env.custom_nodes && env.custom_nodes.length > 0) {
        lines.push(`Custom nodes: ${env.custom_nodes.length} found`);
    }
    if (env.models && env.models.length > 0) {
        lines.push(`Models: ${env.models.length} files found`);
    }
    if (env.workflows && env.workflows.length > 0) {
        lines.push(`Workflows: ${env.workflows.length} user workflow files found`);
    }
    if (env.worker && env.worker.bundle && env.worker.bundle.present) {
        lines.push(`Worker: bundle present at ${env.worker.bundle.dir}`);
    }
    return lines.join('\n');
}

module.exports = {
    MODEL_DIRS,
    DEVICE_KINDS,
    probeEnvironment,
    probeGpu,
    probeNvidiaGpu,
    probeAmdGpu,
    probeComfyui,
    probeWorker,
    parseEnvKeys,
    renderDetection,
    pythonBin,
};
