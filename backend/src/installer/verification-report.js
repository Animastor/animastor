'use strict';

/**
 * Verification Report — Private Worker Installer Phase 1.5.
 *
 * Renders the final post-install verification result from a resolution
 * report plus optional live checks (ComfyUI API, worker health, GPU Hub
 * registration). Output is the user-facing verdict:
 *
 *   INSTALLATION COMPLETE
 *   ✓ GPU
 *   ✓ ComfyUI
 *   ...
 *
 * or precise FAIL/WARN lines. Live checks that were not performed are
 * reported as WARN "not checked" — never silently assumed passed.
 *
 * Secret safety: this module only ever receives key NAMES and boolean
 * flags; a Worker Key value must never be passed in or rendered.
 */

const OK = '\u2713';
const FAIL = '\u2717';
const WARN = '!';

function line(ok, label, detail) {
    const mark = ok === true ? OK : ok === false ? FAIL : WARN;
    return detail ? `${mark} ${label} — ${detail}` : `${mark} ${label}`;
}

/** tri-state normalizer: true | false | null(unknown) */
function tri(v) {
    if (v === true) return true;
    if (v === false) return false;
    return null;
}

function verdictOf(entries) {
    if (entries.some((e) => e.status === 'missing' && e.requirement === 'required')) return false;
    if (entries.some((e) => e.status === 'incompatible')) return false;
    if (entries.some((e) => e.status === 'required' || e.status === 'unknown')) return null;
    return true;
}

function detailOf(entries) {
    const problems = entries
        .filter((e) => e.status === 'missing' || e.status === 'incompatible')
        .map((e) => `${e.name || e.id}: ${e.status}${e.reason ? ` (${e.reason})` : ''}`);
    return problems.length > 0 ? problems.join('; ') : null;
}

function summarizeRuntime(entries) {
    return entries
        .filter((e) => e.status === 'installed')
        .map((e) => `${e.component}${e.found && e.found.version ? ` ${e.found.version}` : ''}`)
        .join(', ') || null;
}

/**
 * @param {object} args
 * @param {object} args.report - resolver report
 * @param {object} [args.live] - optional live check results:
 *   {
 *     comfyui: { running, api_reachable, version, missing_node_classes[] },
 *     workflow: { accepted, missing_node_classes[] },
 *     worker: { process_alive, registered, health },
 *     hub: { connection, registration },
 *   }
 *   Each sub-object/field may be omitted (= not checked → WARN).
 */
function buildVerificationReport({ report, live = {} }) {
    if (!report || !Array.isArray(report.entries)) {
        throw new Error('buildVerificationReport requires a resolution report');
    }
    const lines = [];
    let fails = 0;
    let warns = 0;

    const push = (verdict, label, detail) => {
        lines.push(line(verdict, label, detail));
        if (verdict === false) fails += 1;
        else if (verdict === null) warns += 1;
    };

    const byKind = (kind) => report.entries.filter((e) => e.kind === kind);

    // --- Machine -----------------------------------------------------------
    const hw = report.hardware || {};
    if (hw.device === 'cpu') {
        push(null, 'GPU', 'not detected — CPU-only mode (ComfyUI runs with --cpu; performance significantly lower; intended for the TTS/audio profile)');
    } else if (hw.gpu && hw.gpu.name) {
        push(true, 'GPU', `${hw.gpu.name}${typeof hw.gpu.vram_mib === 'number' ? `, ${Math.round(hw.gpu.vram_mib / 1024)} GB VRAM` : ''}`);
    } else {
        push(false, 'GPU', 'no GPU detected');
    }
    if (hw.device !== 'cpu' && hw.sufficient_vram === false) {
        push(false, 'VRAM', (hw.notes || []).join('; ') || 'below manifest minimum');
    } else if (hw.device !== 'cpu' && hw.sufficient_vram === null) {
        push(null, 'VRAM', 'minimum unknown — not verified');
    }

    const runtimeEntries = byKind('runtime');
    push(verdictOf(runtimeEntries), 'Runtime', detailOf(runtimeEntries) || summarizeRuntime(runtimeEntries));

    // --- ComfyUI -----------------------------------------------------------
    const comfy = report.entries.find((e) => e.id === 'runtime:comfyui');
    const comfyVerdict = comfy
        ? (comfy.status === 'installed' ? true : (comfy.status === 'missing' || comfy.status === 'incompatible') ? false : null)
        : null;
    push(comfyVerdict, 'ComfyUI', comfy && comfy.found && comfy.found.version ? `version ${comfy.found.version}` : detailOf(comfy ? [comfy] : []));

    if (live.comfyui) {
        const c = live.comfyui;
        push(tri(c.running), 'ComfyUI running');
        push(tri(c.api_reachable), 'ComfyUI API');
        if (Array.isArray(c.missing_node_classes) && c.missing_node_classes.length > 0) {
            // When the providing custom node files ARE on disk (resolver says
            // installed) but the live registry lacks the classes, the running
            // instance is stale or the node import failed — say so precisely
            // instead of implying the node is absent.
            const nodeEntriesAll = byKind('custom_node');
            const presentButUnregistered = nodeEntriesAll.length > 0
                && nodeEntriesAll.every((e) => e.status === 'installed');
            push(false, 'ComfyUI node classes', `missing: ${c.missing_node_classes.join(', ')}${presentButUnregistered
                ? ' — the node files are present, but the running ComfyUI did not register them (import failed — see <ComfyUI>/comfyui-installer.log — or the instance predates the install); restart ComfyUI and re-run verify'
                : ''}`);
        }
    } else {
        push(null, 'ComfyUI API', 'not checked (start ComfyUI and re-run verification)');
    }

    // --- Custom nodes ------------------------------------------------------
    const nodeEntries = byKind('custom_node').filter((e) => e.requirement === 'required' || e.status === 'incompatible');
    push(verdictOf(nodeEntries), 'Custom Nodes', detailOf(nodeEntries));

    // --- Models ------------------------------------------------------------
    const modelEntries = byKind('model').concat(byKind('model_repo')).filter((e) => e.requirement === 'required' || e.status === 'incompatible');
    push(verdictOf(modelEntries), 'Models', detailOf(modelEntries));

    // --- Workflows -----------------------------------------------------------
    const wfEntries = byKind('workflow');
    const wfMissing = wfEntries.filter((e) => e.status === 'missing');
    const customized = wfEntries.filter((e) => e.grade === 'customized');
    push(wfMissing.length === 0, 'Workflows', wfMissing.length > 0
        ? `missing baselines: ${wfMissing.map((e) => e.name || e.id).join(', ')}`
        : customized.length > 0 ? `${customized.length} customized by user (allowed)` : null);

    if (live.workflow) {
        const w = live.workflow;
        push(tri(w.accepted), 'Workflow accepted by ComfyUI');
        if (Array.isArray(w.missing_node_classes) && w.missing_node_classes.length > 0) {
            push(false, 'Workflow node classes', `the workflow needs node classes that are not available: ${w.missing_node_classes.join(', ')} — install the providing custom node(s)`);
        }
    } else {
        push(null, 'Workflow accepted by ComfyUI', 'not checked');
    }

    // --- Worker --------------------------------------------------------------
    const workerEntries = byKind('worker');
    push(verdictOf(workerEntries), 'Worker', detailOf(workerEntries));

    const unconfigured = workerEntries.filter((e) => e.action === 'configure');
    if (unconfigured.length > 0) {
        const missingKeys = unconfigured
            .map((e) => ((e.env && e.env.missing_required) || []).join(', '))
            .filter(Boolean)
            .join('; ');
        push(false, 'Worker .env / Worker Key', missingKeys ? `configuration incomplete: ${missingKeys}` : 'interactive setup required');
    }

    if (live.worker) {
        const wk = live.worker;
        push(tri(wk.process_alive), 'Worker process');
        push(tri(wk.registered), 'Worker registration');
        if (wk.health !== undefined) push(tri(wk.health), 'Worker health');
    } else {
        push(null, 'Worker process / registration', 'not checked');
    }

    if (live.hub) {
        push(tri(live.hub.connection), 'GPU Hub connection');
        push(tri(live.hub.registration), 'GPU Hub registration');
    } else {
        push(null, 'GPU Hub registration', 'not checked');
    }

    const status = fails > 0 ? 'FAIL' : warns > 0 ? 'WARN' : 'PASS';
    const header = status === 'PASS'
        ? 'INSTALLATION COMPLETE'
        : status === 'WARN'
            ? 'INSTALLATION COMPLETE WITH WARNINGS'
            : 'INSTALLATION INCOMPLETE';

    const text = [header, '', ...lines].join('\n');
    return { status, fails, warns, lines, text };
}

module.exports = {
    buildVerificationReport,
};
