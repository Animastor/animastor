'use strict';

/**
 * Installation Engine — Private Worker Installer Phase 2.
 *
 * Execution layer. It receives the already-computed install plan (from the
 * Phase 1.5 plan builder) and executes ONLY the operations the plan allows:
 *
 *   Environment detection → Manifest → Compatibility Resolver → Install Plan
 *       → USER CONFIRMATION → Installation Engine → Verification
 *
 * The engine never invents dependencies, URLs, or versions — everything comes
 * from the canonical manifests via resolver/plan. It is idempotent (re-run or
 * `resume` continues where it stopped) and never destroys a user's working
 * configuration on failure.
 *
 * Secrets: the Worker Key enters through `secretProvider` (interactive hidden
 * input in the CLI), is registered for log redaction immediately, and is used
 * only to write .env and to call the hub verify endpoint. It never appears in
 * the plan, state, results, or logs.
 */

const path = require('path');

const resolver = require('../compatibility-resolver');
const { buildInstallPlan } = require('../install-plan');
const { confirmationGate } = require('../safety-rules');
const { planModelDownloads } = require('../download-planner');
const state = require('./state');
const probe = require('./probe');
const comfyui = require('./comfyui');
const nodes = require('./nodes');
const workflowsInstall = require('./workflows');
const downloader = require('./downloader');
const worker = require('./worker');
const { buildVerificationReport } = require('../verification-report');

function stepById(plan, id) {
    return plan.steps.find((s) => s.id === id) || null;
}

function pickTorchSpec(manifests, decisions, warnings) {
    for (const m of manifests) {
        const spec = (m.runtime_requirements || {}).torch || {};
        if (spec.pin) return { spec, grade: 'canonical' };
    }
    for (const m of manifests) {
        const spec = (m.runtime_requirements || {}).torch || {};
        if (spec.known_working_reference && spec.known_working_reference.version) {
            if (decisions.accept_reference_runtime === true) {
                const ref = spec.known_working_reference;
                return {
                    spec: { pin: ref.version, index_url: ref.index_url || null },
                    grade: 'reference',
                };
            }
            warnings.push(`canonical torch pin is unknown (D1); known-working reference is ${spec.known_working_reference.version} — pass accept_reference_runtime to install it`);
            return null;
        }
    }
    return null;
}

/** Non-secret decision keys persisted to install-state.json for `resume`. */
const PERSISTED_DECISION_KEYS = Object.freeze([
    'comfyui_update', 'install_custom_nodes', 'install_models',
    'workflows', 'restore_baseline', 'worker_setup', 'worker_key_provided',
    'accept_reference_runtime', 'accept_runtime_change',
]);

function sanitizeDecisions(decisions) {
    const out = {};
    for (const k of PERSISTED_DECISION_KEYS) {
        if (decisions[k] !== undefined) out[k] = decisions[k];
    }
    return out;
}

/**
 * Load resumable install state or produce a resumable-not-possible verdict.
 * @returns {{ ok: true, state } | { ok: false, reason }}
 */
function loadResumableState(io, statePath) {
    const st = state.loadState(io, statePath);
    if (!st) return { ok: false, reason: 'no-state-file' };
    if (!st.profiles || !Array.isArray(st.profiles) || st.profiles.length === 0) {
        return { ok: false, reason: 'state-has-no-profiles' };
    }
    return { ok: true, state: st };
}

/** Render prior-progress summary lines from a saved state. */
function renderResumeSummary(st) {
    const ids = Object.keys(st.artifacts || {});
    if (ids.length === 0) return ['Prior progress: nothing recorded yet'];
    const marks = { verified: '✓', installed: '✓', failed: '✗', partial: '~', missing: '·' };
    const lines = ['Prior progress (from install-state.json):'];
    for (const id of ids.sort()) {
        const a = st.artifacts[id];
        lines.push(`  ${marks[a.status] || '·'} ${id}: ${a.status}${a.attempts ? ` (${a.attempts} failed attempt(s))` : ''}`);
    }
    return lines;
}

/**
 * Run the installation.
 *
 * @param {object} args
 * @param {object[]} args.manifests - loaded canonical manifests
 * @param {string} args.mode - managed | existing | shared
 * @param {object} args.io - io adapter (real, mock, or dry-run guarded)
 * @param {object} args.roots - { comfyuiRoot, workerDir, statePath, repoRoot, hubUrl }
 * @param {object} [args.decisions] - recorded user decisions (never secret values)
 * @param {Function} [args.secretProvider] - async (name) => value (hidden input)
 * @param {object} [args.logger]
 * @param {object} [args.crypto] - crypto module (hashing)
 * @param {object} [args.env] - pre-probed environment (else probed here)
 * @param {boolean} [args.dryRun]
 * @param {object} [args.initialState] - pre-loaded install state (`resume`); when
 *   given, it is used as-is and never reset
 * @param {object} [args.options] - { startComfyui, comfyPort, verifyTimeoutMs }
 */
async function runInstallation(args) {
    const {
        manifests, mode, io, roots,
        decisions = {}, secretProvider = null,
        logger = null, crypto = null, env: preEnv = null,
        dryRun = false, initialState = null, options = {},
    } = args;

    const log = logger || { info: () => {}, warn: () => {}, error: () => {}, output: () => {}, step: async (n, fn) => ({ ok: true, value: await fn() }), registerSecret: () => {} };
    const {
        comfyuiRoot, workerDir, statePath,
        repoRoot = null, hubUrl = null,
    } = roots;

    const result = {
        status: 'incomplete',
        mode,
        plan: null,
        report: null,
        results: {
            comfyui: null, runtime: null, custom_nodes: [], models: [],
            workflows: [], worker: [], registration: null,
        },
        blocked: [],
        warnings: [],
        verification: null,
    };

    // ── 1. detect ─────────────────────────────────────────────────────────
    // In dry-run mode, skip probing (io.exec is guarded) — use provided env or minimal.
    const env = preEnv || (dryRun
        ? { gpu: null, comfyui: null, python: null, torch: null, nodejs: null, custom_nodes: [], models: [], workflows: [], worker: null }
        : probe.probeEnvironment(io, {
            root: comfyuiRoot, workerDir, crypto,
            workerType: manifests.length === 1 ? (manifests[0].worker_bundle || {}).worker_type : null,
        })
    );

    // ── 2. resolve ────────────────────────────────────────────────────────
    const report = resolver.resolveInstallation({
        manifests,
        environment: env,
        mode: mode === 'shared' ? 'shared' : mode,
    });
    result.report = report;

    // ── 3. plan ───────────────────────────────────────────────────────────
    const plan = buildInstallPlan({ report, manifests, decisions });
    result.plan = plan;

    if (plan.blocked.length > 0) {
        result.status = 'blocked';
        result.blocked = plan.blocked;
        log.warn(`installation blocked: ${plan.blocked.map((b) => b.reason).join('; ')}`);
        return result;
    }
    if (dryRun) {
        result.status = 'dry_run';
        return result;
    }
    if (plan.awaiting_decisions.length > 0) {
        result.status = 'awaiting_decisions';
        return result;
    }

    // ── 4. execute ────────────────────────────────────────────────────────
    // State is an OPTIMIZATION; disk truth is always re-checked before doing.
    const st = initialState
        || state.loadState(io, statePath)
        || state.emptyState({ mode, profiles: report.profiles, root: comfyuiRoot });
    st.profiles = report.profiles;
    if (!dryRun) {
        // persist the (non-secret) decisions so `resume` does not re-prompt
        st.decisions = { ...(st.decisions || {}), ...sanitizeDecisions(decisions) };
    }
    const save = () => state.saveState(io, statePath, st, io.now);
    if (initialState) {
        for (const line of renderResumeSummary(st)) log.info(line);
    }
    save();

    // 4.1 ComfyUI -----------------------------------------------------------
    const comfyStep = stepById(plan, 'comfyui-update');
    if (comfyStep && comfyStep.abort) {
        result.status = 'aborted';
        result.blocked.push({ step: 'comfyui-update', reason: comfyStep.abort_reason });
        return result;
    }
    if (comfyStep && comfyStep.action) {
        const op = comfyStep.action.op;
        if (op === 'install_comfyui') {
            const src = comfyui.pickInstallSource(manifests[0]);
            if (!src) {
                result.blocked.push({ step: 'comfyui-update', reason: 'no canonical ComfyUI pin and no known-working reference in the manifest — nothing to install (D1 research pending)' });
            } else if (src.needs_consent && decisions.accept_reference_runtime !== true) {
                result.blocked.push({
                    step: 'comfyui-update',
                    reason: `canonical ComfyUI pin is unknown (D1); the known-working reference is ${src.source.repository} @ ${src.source.commit || src.source.tag} — confirm accept_reference_runtime to install it`,
                });
            } else {
                const r = await log.step('install ComfyUI', async () => comfyui.installComfyUI(io, { root: comfyuiRoot, source: src.source, log }));
                result.results.comfyui = r.ok ? { op, grade: src.grade, ...r.value } : { op, failed: String(r.error && r.error.message) };
                if (!r.ok) result.warnings.push(`ComfyUI install failed: ${r.error && r.error.message}`);
                state.setArtifact(st, 'comfyui', r.ok ? 'installed' : 'failed', { ref: src.source.commit || src.source.tag });
                save();
            }
        } else if (op === 'update_comfyui' || op === 'downgrade_comfyui') {
            const gate = confirmationGate(op, { confirmed: true, op, via: 'install-plan' });
            if (!gate.allowed) {
                result.blocked.push({ step: 'comfyui-update', reason: gate.reason });
            } else {
                const target = pickUpdateTarget(manifests[0]);
                const r = await log.step(`${op} ComfyUI`, async () => comfyui.updateComfyUI(io, { root: comfyuiRoot, target, state: st, log }));
                result.results.comfyui = r.ok ? { op, ...r.value } : { op, failed: String(r.error && r.error.message) };
                if (r.ok) save();
            }
        }
    }
    if (comfyStep && comfyStep.continue_at_own_risk) {
        result.warnings.push('continuing with a ComfyUI newer than the tested maximum — at the user\'s own risk (recorded)');
    }

    // 4.2 Python runtime / torch (managed, or when missing) ------------------
    // Never touch an EXISTING working Python/Torch/CUDA setup without an
    // explicit user decision: `accept_runtime_change`.
    const torchEntry = report.entries.find((e) => e.id === 'runtime:torch');
    const pythonEntry = report.entries.find((e) => e.id === 'runtime:python');
    const needRuntime = [torchEntry, pythonEntry].some((e) => e && (e.status === 'missing' || e.status === 'incompatible'));
    if (needRuntime && io.fs.existsSync(comfyuiRoot)) {
        const presentRuntime = [torchEntry, pythonEntry].some((e) => e && e.status === 'incompatible');
        if (presentRuntime && decisions.accept_runtime_change !== true) {
            result.blocked.push({
                step: 'runtime',
                reason: 'existing Python/Torch runtime does not match the profile requirements. The installer will NOT replace it without an explicit accept_runtime_change decision.',
            });
            state.setArtifact(st, 'runtime', 'failed', { reason: 'runtime change not accepted' });
            save();
        } else {
            const torchSpec = pickTorchSpec(manifests, decisions, result.warnings);
            if (torchEntry && torchEntry.status === 'missing' && !torchSpec) {
                result.blocked.push({ step: 'runtime', reason: 'torch requirement cannot be satisfied: no canonical pin and reference not accepted' });
            } else {
                const r = await log.step('prepare Python runtime', async () => comfyui.preparePythonRuntime(io, {
                    root: comfyuiRoot,
                    torchSpec: torchSpec ? torchSpec.spec : null,
                    log,
                }));
                result.results.runtime = r.ok ? { grade: torchSpec ? torchSpec.grade : null, ...r.value } : { failed: String(r.error && r.error.message) };
                state.setArtifact(st, 'runtime', r.ok ? 'installed' : 'failed', {});
                if (!r.ok) result.warnings.push(`python runtime preparation failed: ${r.error && r.error.message}`);
                save();
            }
        }
    }

    // 4.3 Custom nodes --------------------------------------------------------
    const nodesStep = stepById(plan, 'custom-nodes');
    if (nodesStep && nodesStep.action && nodesStep.decision === 'yes') {
        const python = path.join(comfyuiRoot, 'venv', 'bin', 'python');
        const r = await log.step('install custom nodes', async () => nodes.installCustomNodes(io, {
            root: comfyuiRoot, manifests, planStep: nodesStep,
            python: io.fs.existsSync(python) ? python : null, log,
        }));
        result.results.custom_nodes = r.ok ? r.value : [{ status: 'failed', reason: String(r.error && r.error.message) }];
        for (const item of result.results.custom_nodes) {
            state.setArtifact(st, item.id, item.status === 'installed' ? 'installed' : item.status === 'failed' ? 'failed' : 'missing', { reason: item.reason });
        }
        save();
    }

    // 4.4 Models ---------------------------------------------------------------
    const modelsStep = stepById(plan, 'models');
    if (modelsStep && modelsStep.action && modelsStep.decision === 'yes') {
        const getHeader = downloader.makeHeaderProvider(process.env);
        const missingIds = (modelsStep.missing || []).map((x) => x.id);
        const specs = manifests.flatMap((m) => planModelDownloads(m, missingIds));
        for (const spec of specs) {
            const dep = findModelDep(manifests, spec.id);
            if (dep && dep.kind === 'model_repo' && dep.source && dep.source.kind === 'modelscope') {
                const strategy = downloader.modelscopeStrategy(dep);
                result.results.models.push({ id: spec.id, status: strategy.mechanism === 'node_auto_download' ? 'deferred-to-node' : 'blocked', reason: strategy.note });
                state.setArtifact(st, spec.id, strategy.mechanism === 'node_auto_download' ? 'missing' : 'missing', { note: strategy.note });
                continue;
            }
            const r = await log.step(`download model ${spec.id}`, async () => downloader.downloadArtifact(io, spec, {
                root: comfyuiRoot,
                getHeader,
                retries: options.downloadRetries || 3,
                retryDelayMs: options.retryDelayMs || 500,
                log,
            }));
            const res = r.ok ? r.value : { status: 'failed', reason: String(r.error && r.error.message) };
            result.results.models.push({ id: spec.id, ...res });
            state.setArtifact(st, spec.id, res.status === 'failed' ? 'failed'
                : res.status === 'blocked' ? 'missing'
                    : res.status === 'skipped' ? 'verified'
                        : 'installed', { grade: res.grade, reason: res.reason });
            save();
        }
    }

    // 4.5 Baseline workflows ------------------------------------------------------
    const wfStep = stepById(plan, 'workflows');
    if (wfStep && wfStep.action && wfStep.action.items && wfStep.action.items.length > 0) {
        const hubFetchText = hubUrl ? (url) => {
            // hub GET /workflow/<id> is not yet implemented (open item);
            // return null for now — the installer uses repo path as primary source.
            return null;
        } : null;
        const r = await log.step('install baseline workflows', async () => workflowsInstall.installWorkflows(io, {
            root: comfyuiRoot, manifests, planStep: wfStep,
            repoRoot, hubUrl, crypto, log,
            httpFetchText: hubFetchText,
        }));
        result.results.workflows = r.ok ? r.value : [{ status: 'failed', reason: String(r.error && r.error.message) }];
        for (const item of result.results.workflows) {
            state.setArtifact(st, item.id, item.status === 'installed' || item.status === 'fresh-copy-installed' ? 'verified' : item.status === 'kept' ? 'verified' : 'missing', { path: item.target_path, reason: item.reason });
        }
        save();
    }

    // 4.6 Worker bundle + .env --------------------------------------------------
    const workerStep = stepById(plan, 'worker-setup');
    if (workerStep && workerStep.action && workerStep.decision === 'yes') {
        for (const w of workerStep.workers || []) {
            const manifest = manifests.find((m) => `worker:${m.profile.id}` === w.id) || manifests[0];
            const bundleRes = await log.step(`install worker bundle (${w.worker_type})`, async () => worker.installWorkerBundle(io, {
                workerDir, manifest, repoRoot, hubUrl, log,
                httpFetchText: null,
            }));
            result.results.worker.push({ id: w.id, bundle: bundleRes.ok ? bundleRes.value : { status: 'failed', reason: String(bundleRes.error && bundleRes.message) } });
            state.setArtifact(st, w.id, bundleRes.ok && bundleRes.value.status === 'installed' ? 'installed' : 'failed');
            save();
        }
    }

    // 4.7 Worker Key + .env configuration ----------------------------------------
    const keyStep = stepById(plan, 'worker-key');
    let tokenValue = null; // held in memory only; never stored on result/state
    if (keyStep && (keyStep.provided || decisions.worker_setup === true || decisions.worker_setup === 'yes')) {
        const manifest = manifests[0];
        const required = ((manifest.worker_bundle || {}).env || {}).required || [];
        const values = {};
        for (const key of keyStep.secret_keys || []) {
            if (secretProvider) {
                const value = await secretProvider(key);
                if (value) {
                    log.registerSecret(value); // redact from ALL further output
                    values[key] = value;
                    if (key === 'ANIMASTOR_WORKER_TOKEN') tokenValue = value;
                }
            }
        }
        for (const key of required) {
            if (values[key] === undefined && !key.includes('TOKEN')) {
                values[key] = defaultEnvValue(key, { hubUrl, manifests });
            }
        }
        const cfg = await log.step('configure worker .env', async () => worker.configureEnv(io, { workerDir, manifest, values, log }));
        result.results.worker.push({ id: 'env', config: cfg.ok ? cfg.value : { status: 'failed', reason: String(cfg.error && cfg.error.message) } });
        state.setArtifact(st, 'env', cfg.ok && cfg.value.status === 'configured' ? 'installed' : 'partial', {});
        save();
    }

    // 4.8 Verification --------------------------------------------------------------
    const ver = await runVerification({
        io, manifests, roots: { comfyuiRoot, workerDir, hubUrl },
        options, log, crypto,
        tokenValue,
        onEvent: (kind, value) => { result.results[kind] = value; },
    });
    result.verification = ver;

    const blockedCount = result.blocked.length + result.results.models.filter((m) => m.status === 'blocked').length;
    if (result.blocked.length > 0 || blockedCount > 0) result.status = 'blocked';
    else if (ver.status === 'FAIL') result.status = 'failed';
    else if (ver.status === 'WARN') result.status = 'warn';
    else result.status = 'ready';

    save();
    return result;
}

function pickUpdateTarget(manifest) {
    const spec = (manifest.runtime_requirements || {}).comfyui || {};
    if (spec.pin && (spec.pin.commit || spec.pin.tag)) return spec.pin;
    if (spec.known_working_reference) return spec.known_working_reference;
    throw new Error('no update target in manifest');
}

function findModelDep(manifests, id) {
    for (const m of manifests) {
        const dep = (m.dependencies || []).find((d) => d.id === id);
        if (dep) return dep;
    }
    return null;
}

function defaultEnvValue(key, { hubUrl, manifests }) {
    if (key === 'HUB_URL') return hubUrl || 'https://animastor.in/gpu';
    if (key === 'WORKER_TYPE') return (manifests[0].worker_bundle || {}).worker_type || 'image';
    if (key === 'WORKER_ID') return `gpu-${Date.now().toString(36)}`;
    return '';
}

// ---------------------------------------------------------------------------
// Verification (live checks where possible)
// ---------------------------------------------------------------------------

async function runVerification({ io, manifests, roots, options, log, crypto, tokenValue = null, onEvent = null }) {
    const emit = (kind, value) => { if (onEvent) onEvent(kind, value); };
    const { comfyuiRoot, workerDir, hubUrl } = roots;
    const live = {};

    // ComfyUI live check: use an already-running instance, or start one in
    // managed mode (files on disk are NOT sufficient verification).
    const port = options.comfyPort || 8188;
    const baseUrl = `http://127.0.0.1:${port}`;
    let stats = await comfyui.systemStats(io, baseUrl);
    if (!stats && options.startComfyui && io.fs.existsSync(comfyuiRoot)) {
        const started = await log.step('start ComfyUI', async () => {
            const { pid } = comfyui.startComfyUI(io, { root: comfyuiRoot, port });
            const up = await comfyui.waitForApi(io, baseUrl, { timeoutMs: options.verifyTimeoutMs || 120000, intervalMs: options.pollIntervalMs || 2000 });
            return { pid, up };
        });
        if (started.ok && started.value.up.ok) {
            stats = started.value.up.system_stats;
            emit('comfyui_started', { pid: started.value.pid, port });
        } else {
            live.comfyui = { running: false, api_reachable: false };
        }
    }
    if (stats) {
        live.comfyui = { running: true, api_reachable: true };
        const classes = await comfyui.objectInfoClasses(io, baseUrl);
        if (classes) {
            const manifestClasses = new Set();
            for (const m of manifests) {
                for (const dep of m.dependencies || []) {
                    for (const cls of dep.provides_classes || []) manifestClasses.add(cls);
                }
            }
            const missingClasses = Array.from(manifestClasses).filter((c) => !classes.has(c));
            if (missingClasses.length > 0) live.comfyui.missing_node_classes = missingClasses;
        }
        // workflow static validation (no generation)
        if (crypto) {
            const wfProblems = [];
            for (const m of manifests) {
                for (const wf of (m.workflows && m.workflows.artifacts) || []) {
                    const abs = path.join(comfyuiRoot, `${wf.target_dir}/${wf.filename}`);
                    if (!io.fs.existsSync(abs)) continue;
                    try {
                        const problems = comfyui.validateWorkflowStatic(io.fs.readFileSync(abs, 'utf8'), { availableClasses: null });
                        if (problems.parse_error) wfProblems.push(`${wf.filename}: ${problems.parse_error}`);
                    } catch (_) { /* unreadable */ }
                }
            }
            live.workflow = { accepted: wfProblems.length === 0, problems: wfProblems };
        }
    } else if (!live.comfyui) {
        live.comfyui = { running: false, api_reachable: false };
    }

    // Worker registration check
    const manifest = manifests[0];
    const expectedType = (manifest.worker_bundle || {}).worker_type || null;
    let token = tokenValue;
    if (!token && workerDir && io.fs.existsSync(path.join(workerDir, '.env'))) {
        token = readEnvValueLocal(io, workerDir, 'ANIMASTOR_WORKER_TOKEN');
        if (token && log.registerSecret) log.registerSecret(token);
    }
    if (hubUrl && token) {
        const reg = await worker.verifyRegistration(io, { hubUrl, token, expectedType });
        emit('registration', { registered: reg.registered, worker_id: reg.worker_id || null, worker_type: reg.worker_type || null, reason: reg.reason || null });
        live.worker = { process_alive: null, registered: reg.registered === true };
        live.hub = { connection: reg.reason ? reg.reason.indexOf('unreachable') === -1 : true, registration: reg.registered === true };
        if (!reg.registered) {
            log.warn('Installation completed locally, but Worker registration failed. The installed environment is intact — fix the credential/network and re-run `verify`.');
        }
    } else {
        const canStart = workerDir ? worker.checkWorkerCanStart(io, { workerDir }) : { ok: false, reason: 'worker dir missing' };
        live.worker = { process_alive: null, registered: null, can_start: canStart.ok };
    }

    // Re-probe disk state for the final report
    const envAfter = probe.probeEnvironment(io, { root: comfyuiRoot, workerDir, crypto, workerType: expectedType });
    const reportAfter = require('../compatibility-resolver').resolveInstallation({
        manifests, environment: envAfter, mode: manifests.length > 1 ? 'shared' : 'existing',
    });
    const ver = buildVerificationReport({ report: reportAfter, live });
    log.output(ver.text);
    return ver;
}

/** Read one KEY value from the local .env (verification only; redacted). */
function readEnvValueLocal(io, workerDir, key) {
    try {
        const text = io.fs.readFileSync(path.join(workerDir, '.env'), 'utf8');
        for (const line of text.split('\n')) {
            const m = new RegExp(`^${key}\\s*=\\s*(.*)$`).exec(line.trim());
            if (m) return m[1].trim() || null;
        }
    } catch (_) { /* no .env */ }
    return null;
}

module.exports = {
    runInstallation,
    runVerification,
    readEnvValueLocal,
    loadResumableState,
    renderResumeSummary,
    sanitizeDecisions,
};
