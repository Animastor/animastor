'use strict';

/**
 * Install Plan — Private Worker Installer Phase 1.5.
 *
 * Turns a resolver report into a sequential INTERACTIVE installation flow:
 *
 *   1  detect-gpu           7  custom-nodes (prompt)
 *   2  detect-comfyui       8  models (prompt)
 *   3  detect-runtime       9  workflows (selection prompt)
 *   4  select-profiles     10  worker-setup
 *   5  resolve-dependencies 11  worker-key (secret prompt, never logged)
 *   6  comfyui-update       12  verify
 *
 * The module is PURE: it builds the plan data structure and renders the
 * human-readable plan text. It performs no I/O and no mutation. Steps that
 * could disrupt the user's environment are gated:
 *   - the plan shows the user what will happen BEFORE anything changes;
 *   - prompts without a recorded decision leave the plan `awaiting_decision`;
 *   - destructive operations (ComfyUI update/downgrade, node checkout) are
 *     only admitted through safety-rules.confirmationGate with an explicit
 *     confirmation, and are never auto-executed;
 *   - the Worker Key is referenced by NAME only — its value never enters
 *     the plan, the rendered text, logs, or argv.
 */

const { confirmationGate } = require('./safety-rules');
const { planWorkflowDownloads, summarizeWorkflowState } = require('./workflow-artifacts');
const { planModelDownloads, estimateMissingBytes } = require('./download-planner');

/** Canonical interactive flow step ids, in execution order. */
const FLOW_STEPS = Object.freeze([
    'detect-gpu',
    'detect-comfyui',
    'detect-runtime',
    'select-profiles',
    'resolve-dependencies',
    'comfyui-update',
    'custom-nodes',
    'models',
    'workflows',
    'worker-setup',
    'worker-key',
    'verify',
]);

const RUNTIME_LABELS = Object.freeze({
    comfyui: 'ComfyUI',
    torch: 'Torch',
    python: 'Python',
    nodejs: 'Node.js',
});

function entryById(report, id) {
    return report.entries.find((e) => e.id === id) || null;
}

function entryLabel(e) {
    if (!e) return '?';
    switch (e.kind) {
        case 'runtime': return RUNTIME_LABELS[e.component] || e.component;
        case 'workflow': return `${e.name || e.id} (baseline workflow)`;
        case 'worker': return `Animastor worker (${e.worker_type || 'unknown type'})`;
        default: return e.name || e.id;
    }
}

function actionLine(e) {
    switch (e.kind) {
        case 'custom_node': return `Install custom node ${e.name || e.id}`;
        case 'model':
        case 'model_repo': return `Download model ${e.name || e.id}`;
        case 'workflow': return `Download baseline workflow ${e.name || e.id}`;
        case 'worker': return `Install Animastor worker bundle (${e.worker_type})`;
        case 'runtime': return `Install ${RUNTIME_LABELS[e.component] || e.component}`;
        default: return `Install ${e.id}`;
    }
}

function foundLabel(e) {
    if (!e || !e.found) return null;
    if (e.kind === 'runtime' && e.component === 'comfyui') {
        const f = e.found;
        if (typeof f === 'string') return f;
        return f.version || f.commit || 'present';
    }
    if (e.kind === 'runtime') {
        return e.found.version || null;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Step builders
// ---------------------------------------------------------------------------

function buildComfyuiStep(report, decisions) {
    const comfy = entryById(report, 'runtime:comfyui');
    const step = {
        id: 'comfyui-update',
        title: 'ComfyUI version policy',
        kind: 'prompt',
        entry: comfy ? comfy.id : null,
    };
    if (!comfy) {
        step.kind = 'noop';
        step.result = 'no ComfyUI entry in report';
        return step;
    }

    if (comfy.status === 'installed') {
        step.kind = 'noop';
        step.result = `skip — ComfyUI ${foundLabel(comfy) || ''} accepted (${comfy.grade || 'canonical'})`.trim();
        return step;
    }

    if (comfy.status === 'missing') {
        step.kind = 'action';
        step.action = { op: 'install_comfyui', destructive: false, requires_confirmation: false };
        step.result = 'ComfyUI absent — installer will clone the manifest version (managed environment)';
        return step;
    }

    const found = foundLabel(comfy) || 'unknown version';
    const expected = Array.isArray(comfy.expected) ? comfy.expected.join(' or ') : String(comfy.expected || 'the pinned version');

    if (comfy.status === 'incompatible' && comfy.reason === 'below_minimum') {
        step.prompt = {
            question: `ComfyUI ${found} detected.\nRecommended version: ${expected}.\n\nUpdate?`,
            options: ['Yes', 'No'],
        };
        if (decisions.comfyui_update === 'yes') {
            const gate = confirmationGate('update_comfyui', { confirmed: true, op: 'update_comfyui', via: 'interactive-prompt' });
            step.decision = 'yes';
            step.action = { op: 'update_comfyui', destructive: true, requires_confirmation: true, allowed: gate.allowed };
            step.result = 'user approved the ComfyUI update — checkpoint state before executing';
        } else if (decisions.comfyui_update === 'no') {
            step.decision = 'no';
            step.abort = true;
            step.abort_reason = 'user declined the required ComfyUI update — installation aborted; nothing was changed';
            step.result = 'keep existing ComfyUI; abort (the profile cannot run on a below-minimum version)';
        } else {
            step.awaiting_decision = true;
        }
        return step;
    }

    if (comfy.status === 'incompatible' && comfy.reason === 'above_max_tested') {
        step.prompt = {
            question: `ComfyUI ${found} detected — newer than the tested maximum (${expected}).\nNEVER auto-downgraded. Keep it (continue at own risk) or downgrade to the pinned version?`,
            options: ['Keep', 'Downgrade'],
        };
        if (decisions.comfyui_update === 'keep' || decisions.comfyui_update === 'no') {
            step.decision = 'keep';
            step.continue_at_own_risk = true;
            step.result = 'user keeps the newer ComfyUI — recorded as continue-at-own-risk; nothing changed';
        } else if (decisions.comfyui_update === 'downgrade' || decisions.comfyui_update === 'yes') {
            const gate = confirmationGate('downgrade_comfyui', { confirmed: true, op: 'downgrade_comfyui', via: 'interactive-prompt' });
            step.decision = 'downgrade';
            step.action = { op: 'downgrade_comfyui', destructive: true, requires_confirmation: true, allowed: gate.allowed };
            step.result = 'user approved the downgrade — checkpoint state before executing';
        } else {
            step.awaiting_decision = true;
        }
        return step;
    }

    // unknown / other incompatible — user must review, never automatic
    step.prompt = {
        question: `ComfyUI compatibility cannot be determined automatically (${comfy.reason || comfy.status}).\nReview and decide how to proceed.`,
        options: ['Review'],
    };
    if (decisions.comfyui_update) {
        step.decision = String(decisions.comfyui_update);
        step.result = 'user decision recorded; manual review step';
    } else {
        step.awaiting_decision = true;
    }
    return step;
}

function buildArtifactStep({ id, title, report, kinds, decisionKey, decisions, manifests, stepExtra }) {
    const missing = report.entries.filter((e) => kinds.includes(e.kind) && e.status === 'missing' && e.action === 'install');
    const review = report.entries.filter((e) => kinds.includes(e.kind) && (e.status === 'incompatible' || (e.status === 'missing' && e.action === 'review')));
    const step = {
        id,
        title,
        kind: 'prompt',
        missing: missing.map((e) => ({ id: e.id, label: entryLabel(e) })),
        review: review.map((e) => ({ id: e.id, label: entryLabel(e), reason: e.reason || e.status, notes: e.notes || [] })),
        ...(stepExtra || {}),
    };
    if (missing.length === 0) {
        step.kind = 'noop';
        step.result = review.length === 0 ? 'nothing to install' : 'nothing to install (review items listed)';
        return step;
    }

    step.prompt = {
        question: `${missing.length} component(s) missing. Install?\n${missing.map((e) => `  - ${entryLabel(e)}`).join('\n')}`,
        options: ['Yes', 'No'],
    };
    const decision = decisions[decisionKey];
    if (decision === true || decision === 'yes') {
        step.decision = 'yes';
        step.action = { op: `install_${id}`, items: missing.map((e) => e.id), destructive: false, requires_confirmation: true };
        step.result = `user approved installing ${missing.length} component(s)`;
    } else if (decision === false || decision === 'no') {
        step.decision = 'no';
        step.skipped_by_user = true;
        step.result = 'user declined — components stay missing; worker may fail verification later';
    } else {
        step.awaiting_decision = true;
    }
    return step;
}

function buildWorkflowsStep({ report, manifests, decisions }) {
    const missing = report.entries.filter((e) => e.kind === 'workflow' && e.status === 'missing' && e.action === 'install');
    const customized = report.entries.filter((e) => e.kind === 'workflow' && e.grade === 'customized');
    const installed = report.entries.filter((e) => e.kind === 'workflow' && e.status === 'installed' && e.grade !== 'customized');

    const step = {
        id: 'workflows',
        title: 'Baseline workflows (editable starting points)',
        kind: 'prompt',
        available: report.entries.filter((e) => e.kind === 'workflow').map((e) => ({ id: e.id, name: e.name })),
        installed: installed.map((e) => e.id),
        customized: customized.map((e) => ({ id: e.id, note: 'customized by user — kept as-is, NEVER overwritten' })),
        missing: missing.map((e) => ({ id: e.id, name: e.name, path: e.expected ? e.expected.path : null })),
    };

    if (missing.length === 0) {
        step.kind = 'noop';
        step.result = customized.length > 0
            ? 'all baselines present; user-customized copies are kept untouched'
            : 'all baseline workflows present';
        return step;
    }

    step.prompt = {
        question: `Which baseline workflows to download?\n${missing.map((e) => `  - ${e.name} [${e.id}]`).join('\n')}\n(A baseline is an editable starting point — you can customize it locally afterwards)`,
        options: ['All', 'Select', 'None'],
    };

    const selection = decisions.workflows;
    if (selection === 'none' || selection === false) {
        step.decision = 'none';
        step.skipped_by_user = true;
        step.result = 'user declined baseline workflows — nothing downloaded';
        return step;
    }
    if (selection === 'all' || Array.isArray(selection)) {
        step.decision = Array.isArray(selection) ? 'select' : 'all';
        const downloads = [];
        for (const m of manifests) {
            downloads.push(...planWorkflowDownloads(m, { workflows: collectFoundWorkflows(report) }, selection, { restoreBaseline: decisions.restore_baseline === true }));
        }
        // only keep downloads for workflows the resolver actually reported missing
        const missingIds = new Set(missing.map((e) => e.id));
        const freshCopies = downloads.filter((d) => d.fresh_copy);
        const selected = downloads.filter((d) => missingIds.has(d.id) || d.fresh_copy);
        step.action = {
            op: 'download_workflows',
            items: selected.map((d) => ({ id: d.id, target_path: d.target_path, fresh_copy: d.fresh_copy })),
            destructive: false,
            requires_confirmation: true,
            never_overwrites: true,
        };
        step.result = `user selected ${selected.length - freshCopies.length} baseline workflow(s)${freshCopies.length ? ` + ${freshCopies.length} fresh copy(ies) of customized baselines (distinct paths)` : ''}`;
        return step;
    }
    step.awaiting_decision = true;
    return step;
}

function collectFoundWorkflows(report) {
    // reconstruct the probed workflow files from report entries (found paths)
    const workflows = [];
    for (const e of report.entries) {
        if (e.kind === 'workflow' && e.found && e.found.path) {
            workflows.push({ path: e.found.path, sha256: e.found.sha256 || null });
        }
    }
    return workflows;
}

function buildWorkerSteps({ report, manifests, decisions }) {
    const workers = report.entries.filter((e) => e.kind === 'worker');
    const setup = {
        id: 'worker-setup',
        title: 'Animastor Worker bundle',
        kind: 'prompt',
        workers: workers.map((e) => ({
            id: e.id,
            worker_type: e.worker_type,
            status: e.status,
            grade: e.grade || null,
            env_missing: e.env ? e.env.missing_required : null,
        })),
    };

    const toInstall = workers.filter((e) => e.status === 'missing' || (e.status === 'incompatible' && e.reason === 'incomplete_bundle'));
    const toConfigure = workers.filter((e) => e.action === 'configure');

    if (toInstall.length === 0 && toConfigure.length === 0) {
        setup.kind = 'noop';
        setup.result = workers.length > 0 ? 'worker bundle(s) installed and configured' : 'no worker entries';
        return { setup, key: null };
    }

    const actions = [];
    if (toInstall.length > 0) actions.push(`install worker bundle: ${toInstall.map((e) => e.worker_type).join(', ')}`);
    if (toConfigure.length > 0) actions.push(`create/update .env (merge semantics, chmod 600): ${toConfigure.map((e) => e.worker_type).join(', ')}`);
    setup.prompt = { question: `Worker setup:\n${actions.map((a) => `  - ${a}`).join('\n')}\nContinue?`, options: ['Yes', 'No'] };

    if (decisions.worker_setup === true || decisions.worker_setup === 'yes') {
        setup.decision = 'yes';
        setup.action = { op: 'worker_setup', items: workers.map((e) => e.id), destructive: false, requires_confirmation: true };
        setup.result = 'user approved worker setup';
    } else if (decisions.worker_setup === false || decisions.worker_setup === 'no') {
        setup.decision = 'no';
        setup.skipped_by_user = true;
        setup.result = 'user skipped worker setup';
    } else {
        setup.awaiting_decision = true;
    }

    // Worker Key step — secret handling by NAME only.
    // Needed whenever any worker still requires setup (fresh install implies
    // a fresh .env) or explicit configuration.
    const secretMissing = [];
    const needsSetup = workers.filter((e) => e.status === 'missing' || e.action === 'configure'
        || (e.status === 'incompatible' && e.reason === 'incomplete_bundle'));
    for (const e of needsSetup) {
        const manifest = manifests.find((m) => `worker:${m.profile.id}` === e.id);
        const wbEnv = (manifest && manifest.worker_bundle && manifest.worker_bundle.env) || {};
        const secrets = wbEnv.secrets || ['ANIMASTOR_WORKER_TOKEN'];
        // for a missing bundle the whole .env is absent → every secret is missing
        const missingHere = e.action === 'configure' && e.env ? e.env.missing_required : (wbEnv.required || secrets);
        for (const k of missingHere) {
            if (secrets.includes(k) && !secretMissing.includes(k)) secretMissing.push(k);
        }
    }

    let key = null;
    if (secretMissing.length > 0 || toConfigure.length > 0) {
        key = {
            id: 'worker-key',
            title: 'Enter Worker Key securely',
            kind: 'secret-prompt',
            secret_keys: secretMissing,
            prompt: {
                question: `Enter ${secretMissing.join(', ') || 'Worker Key'} (hidden input)`,
                options: ['Enter'],
            },
            rules: Object.freeze([
                'hidden interactive input only',
                'the VALUE is never printed to logs',
                'the VALUE is never passed via command-line arguments',
                'the VALUE is never stored in reports, plan objects, or state files',
                'an existing valid token is never overwritten (merge semantics)',
            ]),
        };
        if (decisions.worker_key_provided === true) {
            key.provided = true; // boolean flag ONLY — the value itself is never recorded
            key.result = 'Worker Key entered interactively (value not recorded anywhere)';
        } else {
            key.provided = false;
            key.awaiting_decision = true;
        }
    }
    return { setup, key };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build the interactive installation plan from a resolution report.
 *
 * @param {object} args
 * @param {object} args.report - resolver report (resolveInstallation output)
 * @param {object[]} [args.manifests] - manifests used for the report
 *   (needed for workflow/model download planning and worker secret names)
 * @param {object} [args.decisions] - recorded user decisions:
 *   comfyui_update: 'yes'|'no'|'keep'|'downgrade'|...
 *   install_custom_nodes: true|false
 *   install_models: true|false
 *   workflows: 'all'|'none'|[ids]
 *   restore_baseline: true — additionally download fresh copies of customized baselines
 *   worker_setup: true|false
 *   worker_key_provided: true|false (flag only; the key value is NEVER passed here)
 * @returns plan object with steps, rendered text, gates
 */
function buildInstallPlan({ report, manifests = [], decisions = {} }) {
    if (!report || !Array.isArray(report.entries)) {
        throw new Error('buildInstallPlan requires a resolution report');
    }

    const steps = [];
    const blocked = [];

    // 1–3: detection
    steps.push({
        id: 'detect-gpu',
        title: 'Detect GPU',
        kind: 'detect',
        automatic: true,
        result: {
            gpu: report.hardware ? report.hardware.gpu : null,
            sufficient_vram: report.hardware ? report.hardware.sufficient_vram : null,
            notes: report.hardware ? report.hardware.notes : [],
        },
    });

    const comfy = entryById(report, 'runtime:comfyui');
    steps.push({
        id: 'detect-comfyui',
        title: 'Detect existing ComfyUI',
        kind: 'detect',
        automatic: true,
        result: comfy ? { status: comfy.status, grade: comfy.grade || null, found: comfy.found, expected: comfy.expected } : null,
    });

    steps.push({
        id: 'detect-runtime',
        title: 'Detect runtime (Python/Torch/CUDA/Node.js)',
        kind: 'detect',
        automatic: true,
        result: ['python', 'torch', 'nodejs'].map((c) => {
            const e = entryById(report, `runtime:${c}`);
            return e ? { component: c, status: e.status, grade: e.grade || null, found: e.found } : null;
        }).filter(Boolean),
    });

    // 4: profiles + sharing verdict
    const selectStep = {
        id: 'select-profiles',
        title: 'Select profile(s)',
        kind: 'select',
        profiles: report.profiles,
    };
    if (report.sharing) {
        selectStep.sharing = { verdict: report.sharing.verdict, message: report.sharing.message };
        if (!report.sharing.can_share) {
            blocked.push({
                step: 'select-profiles',
                reason: 'Profiles cannot safely share this ComfyUI runtime. Isolation recommended.',
                detail: report.sharing.message,
            });
        }
    }
    steps.push(selectStep);

    // 5: resolution summary
    steps.push({
        id: 'resolve-dependencies',
        title: 'Resolve dependencies',
        kind: 'resolve',
        automatic: true,
        result: report.summary,
    });

    // 6: ComfyUI update policy
    const comfyStep = buildComfyuiStep(report, decisions);
    steps.push(comfyStep);
    if (comfyStep.abort) {
        blocked.push({ step: 'comfyui-update', reason: comfyStep.abort_reason });
    }

    // 7: custom nodes
    steps.push(buildArtifactStep({
        id: 'custom-nodes',
        title: 'Custom nodes',
        report,
        kinds: ['custom_node'],
        decisionKey: 'install_custom_nodes',
        decisions,
        manifests,
    }));

    // 8: models (+ download specs with honesty blockers)
    const missingModelIds = report.entries
        .filter((e) => (e.kind === 'model' || e.kind === 'model_repo') && e.status === 'missing' && e.action === 'install')
        .map((e) => e.id);
    const downloadSpecs = manifests.flatMap((m) => planModelDownloads(m, missingModelIds));
    const notReady = downloadSpecs.filter((s) => !s.ready);
    const modelsStep = buildArtifactStep({
        id: 'models',
        title: 'Models',
        report,
        kinds: ['model', 'model_repo'],
        decisionKey: 'install_models',
        decisions,
        manifests,
        stepExtra: {
            download_specs: downloadSpecs.map((s) => ({ id: s.id, ready: s.ready, resume: s.resume, blockers: s.blockers })),
            estimated_bytes: estimateMissingBytes(downloadSpecs),
        },
    });
    if (notReady.length > 0) {
        modelsStep.blocked_downloads = notReady.map((s) => ({ id: s.id, blockers: s.blockers }));
        modelsStep.notes = (modelsStep.notes || []).concat([
            `${notReady.length} model download(s) are NOT ready: sources must be researched (D5) before the installer may download — URLs are never invented`,
        ]);
    }
    steps.push(modelsStep);

    // 9: baseline workflows
    steps.push(buildWorkflowsStep({ report, manifests, decisions }));

    // 10–11: worker + worker key
    const { setup, key } = buildWorkerSteps({ report, manifests, decisions });
    steps.push(setup);
    if (key) steps.push(key);

    // 12: verify
    steps.push({
        id: 'verify',
        title: 'Verify installation',
        kind: 'verify',
        checks: ['GPU', 'ComfyUI', 'Runtime', 'Custom Nodes', 'Models', 'Workflows', 'Worker', 'GPU Hub registration'],
    });

    const awaiting = steps.filter((s) => s.awaiting_decision).map((s) => s.id);
    const confirmedOperations = steps
        .filter((s) => s.action && s.action.destructive && s.action.allowed)
        .map((s) => ({ op: s.action.op, step: s.id, requires_confirmation: true }));

    const plan = {
        mode: report.mode,
        profiles: report.profiles,
        steps,
        blocked,
        awaiting_decisions: awaiting,
        complete: awaiting.length === 0 && blocked.length === 0,
        confirmed_operations: confirmedOperations,
        destructive_operations: Object.freeze([]), // invariant: nothing destructive without explicit consent
        safe_to_proceed: report.safe_to_proceed && blocked.length === 0,
    };
    plan.plan_text = renderPlanText(plan, report);
    return plan;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPlanText(plan, report) {
    const lines = [];
    lines.push(`Profile: ${plan.profiles.join(' + ')}`);
    lines.push(`Mode: ${plan.mode}`);
    lines.push('');

    const detected = [];
    const hw = report.hardware || {};
    if (hw.gpu && hw.gpu.name) {
        detected.push(`\u2713 ${hw.gpu.name}${typeof hw.gpu.vram_mib === 'number' ? ` (${Math.round(hw.gpu.vram_mib / 1024)} GB VRAM)` : ''}`);
    }
    for (const e of report.entries) {
        if (e.status !== 'installed') continue;
        if (e.kind === 'runtime') {
            const v = foundLabel(e);
            detected.push(`\u2713 ${entryLabel(e)}${v ? ` (${v})` : ''}`);
        } else if (e.kind === 'custom_node' || e.kind === 'workflow') {
            detected.push(`\u2713 ${entryLabel(e)}${e.grade === 'customized' ? ' [customized by user — kept]' : ''}`);
        } else if (e.kind === 'worker') {
            detected.push(`\u2713 ${entryLabel(e)}`);
        } else if (e.kind === 'model' || e.kind === 'model_repo') {
            detected.push(`\u2713 ${entryLabel(e)}`);
        }
    }
    if (detected.length > 0) {
        lines.push('Detected:');
        lines.push(...detected);
        lines.push('');
    }

    const missing = report.entries.filter((e) => e.status === 'missing');
    if (missing.length > 0) {
        lines.push('Missing:');
        for (const e of missing) lines.push(`\u2717 ${entryLabel(e)}`);
        lines.push('');
    }

    const incompatible = report.entries.filter((e) => e.status === 'incompatible');
    if (incompatible.length > 0) {
        lines.push('Needs review:');
        for (const e of incompatible) lines.push(`! ${entryLabel(e)} (${e.reason || 'incompatible'})`);
        lines.push('');
    }

    const actions = report.entries.filter((e) => e.action === 'install').map(actionLine);
    for (const e of report.entries) {
        if (e.action === 'configure') actions.push(`Configure ${entryLabel(e)} (.env)`);
    }
    if (actions.length > 0) {
        lines.push('Actions:');
        for (const a of actions) lines.push(`- ${a}`);
        lines.push('');
    }

    if (plan.blocked.length > 0) {
        lines.push('Blocked:');
        for (const b of plan.blocked) lines.push(`- ${b.reason}`);
        lines.push('');
    }

    const prompts = plan.steps.filter((s) => s.prompt && s.awaiting_decision);
    if (prompts.length > 0) {
        for (const p of prompts) {
            lines.push(p.prompt.question);
            lines.push(`[${p.prompt.options.join('] [')}]`);
            lines.push('');
        }
    } else if (plan.blocked.length === 0) {
        lines.push('Continue?');
        lines.push('[Yes] [No]');
    }

    return lines.join('\n').trim();
}

module.exports = {
    FLOW_STEPS,
    buildInstallPlan,
    renderPlanText,
    entryLabel,
};
