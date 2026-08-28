#!/usr/bin/env node
'use strict';

/**
 * Animastor GPU Worker Installer CLI — Phase 2.
 *
 * Usage:
 *   animastor-installer detect     [--root PATH] [--worker-dir PATH]
 *   animastor-installer plan       --profile P[,P2] [--mode managed|existing|shared] [--root PATH]
 *   animastor-installer install    --profile P[,P2] [--mode ...] [--root PATH] [--yes] [--dry-run] [--worker-dir PATH] [--hub-url URL]
 *   animastor-installer verify     [--profile P[,P2]] [--root PATH] [--worker-dir PATH] [--hub-url URL]
 *   animastor-installer resume
 *   animastor-installer uninstall  [--all] [--yes] [--dry-run] [--state PATH] [--home PATH]
 *
 * Flags:
 *   --profile P        Generation profile id (repeatable or comma-separated)
 *   --mode MODE        managed | existing | shared (default: infer from detection)
 *   --root PATH        ComfyUI root directory (default: ~/ComfyUI)
 *   --worker-dir PATH  Worker bundle directory (default: ~/animastor/worker)
 *   --hub-url URL      GPU Hub base URL (default: https://animastor.in/gpu)
 *   --repo-root PATH   Animastor repo root (default: derived from cli.js location)
 *   --state PATH       Install state file path
 *   --yes              Auto-confirm all prompts
 *   --dry-run          Show plan only; never perform real changes
 *   --all              uninstall: full uninstall (everything recorded in the manifest)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { createRealIo, createDryRunIo } = require('./engine/io');
const { createLogger } = require('./engine/logger');
const { probeEnvironment, renderDetection } = require('./engine/probe');
const { runInstallation, loadResumableState, renderResumeSummary } = require('./engine/engine');
const resolver = require('./compatibility-resolver');
const { buildInstallPlan, renderPlanText } = require('./install-plan');
const manifest = require('./install-manifest');
const uninstaller = require('./uninstaller');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CLI_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_ROOT = path.join(process.env.HOME || '/root', 'ComfyUI');
const DEFAULT_WORKER_DIR = path.join(process.env.HOME || '/root', 'animastor', 'worker');
const DEFAULT_HUB_URL = 'https://animastor.in/gpu';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = argv.slice(2);
    const parsed = { command: null, profiles: [], flags: {} };
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            if (['yes', 'dry-run', 'resume', 'start-comfy', 'all', 'accept-reference-runtime', 'accept-runtime-change'].includes(key)) {
                parsed.flags[key] = true;
            } else {
                const val = args[++i];
                parsed.flags[key] = val || '';
            }
        } else {
            positional.push(a);
        }
    }
    parsed.command = positional[0] || null;
    const profileFlag = parsed.flags.profile || '';
    if (profileFlag) {
        parsed.profiles = profileFlag.split(',').map((s) => s.trim()).filter(Boolean);
    }
    // Normalize: every cmd* receives `flags` and reads flags.profiles
    parsed.flags.profiles = parsed.profiles;
    return parsed;
}

function resolveRoot(flags) {
    return flags.root || DEFAULT_ROOT;
}

function resolveWorkerDir(flags) {
    return flags['worker-dir'] || DEFAULT_WORKER_DIR;
}

function resolveHubUrl(flags) {
    return flags['hub-url'] || DEFAULT_HUB_URL;
}

function resolveRepoRoot(flags) {
    return flags['repo-root'] || REPO_ROOT;
}

function resolveStatePath(flags) {
    return flags.state || path.join(resolveRoot(flags), '.animastor-installer', 'install-state.json');
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

function createPrompt() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return {
        async confirm(question) {
            return new Promise((resolve) => {
                rl.question(`${question} [Yes/No] `, (answer) => {
                    resolve(/^(y|yes)$/i.test(answer.trim()));
                });
            });
        },
        async select(question, options) {
            return new Promise((resolve) => {
                const text = `${question}\n${options.map((o, i) => `  [${i + 1}] ${o}`).join('\n')}\n> `;
                rl.question(text, (answer) => {
                    const n = parseInt(answer, 10);
                    resolve(options[(n - 1) || 0] || options[0]);
                });
            });
        },
        async secret(question) {
            // TTY: hidden raw-mode input (no echo). Non-TTY (piped input /
            // automation): plain line input. In BOTH cases the value is never
            // echoed to the output stream, never logged, never stored in
            // state, never passed via argv.
            if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
                return new Promise((resolve) => {
                    process.stdout.write(`${question}: `);
                    let value = '';
                    process.stdin.setRawMode(true);
                    process.stdin.resume();
                    const onData = (ch) => {
                        const c = ch.toString();
                        if (c === '\n' || c === '\r') {
                            process.stdin.setRawMode(false);
                            process.stdin.pause();
                            process.stdin.removeListener('data', onData);
                            process.stdout.write('\n');
                            resolve(value || null);
                        } else if (c === '\u0003') { // Ctrl+C
                            process.stdin.setRawMode(false);
                            process.stdin.pause();
                            process.stdin.removeListener('data', onData);
                            resolve(null);
                        } else if (c === '\u007F' || c === '\b') {
                            if (value.length > 0) value = value.slice(0, -1);
                        } else {
                            value += c;
                        }
                    };
                    process.stdin.on('data', onData);
                });
            }
            return new Promise((resolve) => {
                rl.question(`${question}: `, (answer) => resolve(answer ? String(answer) : null));
            });
        },
        close() { rl.close(); },
    };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Resolve the environment against the manifests and build the install plan —
 * the ONLY call shape that produces a plan in the CLI. The plan is ALWAYS
 * built from a freshly resolved report passed under the `report` key, so
 * buildInstallPlan can never be invoked with a missing/undefined report.
 * The plan is re-derived after the interactive prompts because decisions
 * change it; the report is re-resolved at the same time (single source).
 */
function resolveAndPlan({ manifests, env, mode, decisions }) {
    const report = resolver.resolveInstallation({ manifests, environment: env, mode });
    const plan = buildInstallPlan({ report, manifests, decisions });
    return { report, plan };
}

/** Secret values collected interactively — memory-only, never persisted. */
function makeSecretProvider(secrets) {
    if (!secrets || Object.keys(secrets).length === 0) return null;
    return async (name) => (Object.prototype.hasOwnProperty.call(secrets, name) ? secrets[name] : null);
}

async function cmdDetect(flags) {
    const root = resolveRoot(flags);
    const workerDir = resolveWorkerDir(flags);
    const io = createRealIo();
    const env = probeEnvironment(io, { root, workerDir, crypto: require('crypto') });
    console.log(renderDetection(env));
}

async function cmdPlan(flags) {
    if (flags.profiles.length === 0) {
        console.error('error: --profile is required');
        process.exit(1);
    }
    const root = resolveRoot(flags);
    const workerDir = resolveWorkerDir(flags);
    const hubUrl = resolveHubUrl(flags);
    const repoRoot = resolveRepoRoot(flags);
    const io = createRealIo();
    const crypto = require('crypto');
    const env = probeEnvironment(io, { root, workerDir, crypto, workerType: null });

    const loadedManifests = flags.profiles.map((p) => manifest.loadManifest(p));
    const mode = flags.mode || (env.comfyui && env.comfyui.present ? 'existing' : 'managed');
    const { plan } = resolveAndPlan({ manifests: loadedManifests, env, mode, decisions: {} });
    console.log(plan.plan_text);
}

async function cmdInstall(flags) {
    if (flags.profiles.length === 0) {
        console.error('error: --profile is required');
        process.exit(1);
    }
    const root = resolveRoot(flags);
    const workerDir = resolveWorkerDir(flags);
    const hubUrl = resolveHubUrl(flags);
    const repoRoot = resolveRepoRoot(flags);
    const statePath = resolveStatePath(flags);
    const dryRun = flags['dry-run'] || false;
    const yes = flags.yes || false;
    const crypto = require('crypto');

    // Probing is read-only and always runs against the REAL io. In dry-run
    // mode the guarded io is used ONLY inside the engine, where every
    // mutating operation would throw a "dry-run violation".
    const realIo = createRealIo();
    const logger = createLogger({ io: realIo });
    const loadedManifests = flags.profiles.map((p) => manifest.loadManifest(p));
    const mode = flags.mode || 'managed';

    const env = probeEnvironment(realIo, {
        root, workerDir, crypto,
        workerType: loadedManifests.length === 1 ? (loadedManifests[0].worker_bundle || {}).worker_type : null,
    });
    // The dry-run guard wraps everything handed to the engine so any
    // accidental mutation throws "dry-run violation" instead of executing.
    const io = dryRun ? createDryRunIo(realIo) : realIo;

    const { plan } = resolveAndPlan({ manifests: loadedManifests, env, mode, decisions: {} });

    console.log(plan.plan_text);

    // CPU-only mode is always announced explicitly and confirmed before any
    // change: the user must see that performance will be significantly lower.
    const device = env.device || (env.gpu ? 'cuda' : 'cpu');
    if (device === 'cpu' && !dryRun) {
        console.log('\n=========================================================================');
        console.log('  CPU-ONLY MODE: no supported GPU was detected.');
        console.log('  A CPU build of PyTorch will be installed and ComfyUI will run');
        console.log('  with --cpu. Performance will be SIGNIFICANTLY lower.');
        console.log('  This mode is intended for the TTS/audio profile test scenario.');
        console.log('=========================================================================');
        if (!yes) {
            const prompt = createPrompt();
            const proceed = await prompt.confirm('Continue with the CPU-only installation?');
            prompt.close();
            if (!proceed) {
                console.log('Aborted — nothing was changed.');
                process.exit(0);
            }
        }
    }

    if (dryRun) {
        console.log('\n[dry-run] zero mutations performed');
        return;
    }

    if (plan.blocked.length > 0) {
        console.error('\nInstallation blocked — see above for details');
        process.exit(1);
    }

    if (plan.awaiting_decisions.length > 0 && !yes) {
        const prompt = createPrompt();
        const decisions = {};
        // Explicit consent flags apply to interactive runs exactly as they do
        // to --yes runs (parity): without them a reference-grade ComfyUI
        // source (manifest basis=unknown, D1) can never be accepted here.
        if (flags['accept-reference-runtime']) decisions.accept_reference_runtime = true;
        if (flags['accept-runtime-change']) decisions.accept_runtime_change = true;
        // Secret VALUES live only in this closure — never in decisions, logs,
        // state, or argv. The engine receives them via secretProvider.
        const secrets = {};
        for (const stepId of plan.awaiting_decisions) {
            const step = plan.steps.find((s) => s.id === stepId);
            if (!step || !step.prompt) continue;
            if (stepId === 'worker-key' && decisions.worker_setup === false) {
                // worker setup was declined — the key prompt is skipped too
                decisions.worker_key_provided = false;
                continue;
            }
            if (step.kind === 'secret-prompt') {
                // Worker Key step: real hidden input (never a Yes/No confirm —
                // a typed token must not be misread as an answer). Only the
                // boolean fact "provided" enters the decisions; the value
                // itself is handed to the engine through secretProvider.
                let provided = false;
                for (const key of step.secret_keys || []) {
                    const value = await prompt.secret(`Enter ${key} (hidden input)`);
                    if (value) {
                        secrets[key] = value;
                        logger.registerSecret(value); // redact from ALL further output
                        provided = true;
                    }
                }
                decisions.worker_key_provided = provided;
                continue;
            }
            const answer = await prompt.confirm(step.prompt.question);
            if (stepId === 'comfyui-update') decisions.comfyui_update = answer ? 'yes' : 'no';
            else if (stepId === 'custom-nodes') decisions.install_custom_nodes = answer;
            else if (stepId === 'models') decisions.install_models = answer;
            else if (stepId === 'workflows') decisions.workflows = answer ? 'all' : 'none';
            else if (stepId === 'worker-setup') decisions.worker_setup = answer;
            else if (stepId === 'worker-key') decisions.worker_key_provided = answer;
        }
        prompt.close();

        // Re-resolve and rebuild the plan with the recorded decisions — one
        // call shape, so the rebuilt plan always has a resolution report.
        const { plan: plan2 } = resolveAndPlan({ manifests: loadedManifests, env, mode, decisions });

        if (plan2.awaiting_decisions.length > 0) {
            console.error('\nStill awaiting decisions after prompts — cannot proceed');
            process.exit(1);
        }
        if (plan2.blocked.length > 0) {
            console.error('\nInstallation blocked after decisions — see above');
            process.exit(1);
        }

        const result = await runInstallation({
            manifests: loadedManifests, mode, io,
            roots: { comfyuiRoot: root, workerDir, statePath, repoRoot, hubUrl },
            decisions, secretProvider: makeSecretProvider(secrets),
            logger, crypto, env, dryRun, options: installOptions(flags),
        });
        printResult(result);
    } else {
        // All decisions pre-set or no decisions needed
        const decisions = {};
        if (yes) {
            decisions.comfyui_update = 'yes';
            decisions.install_custom_nodes = true;
            decisions.install_models = true;
            decisions.workflows = 'all';
            decisions.worker_setup = true;
            decisions.worker_key_provided = true;
            if (flags['accept-reference-runtime']) decisions.accept_reference_runtime = true;
            if (flags['accept-runtime-change']) decisions.accept_runtime_change = true;
        }
        const result = await runInstallation({
            manifests: loadedManifests, mode, io,
            roots: { comfyuiRoot: root, workerDir, statePath, repoRoot, hubUrl },
            decisions, logger, crypto, env, dryRun, options: installOptions(flags),
        });
        printResult(result);
    }
}

function installOptions(flags) {
    return {
        // Verification uses an already-running ComfyUI if present. Pass
        // --start-comfy to let the installer start one for the live check.
        startComfyui: flags['start-comfy'] === true,
        comfyPort: flags['comfy-port'] ? Number(flags['comfy-port']) : undefined,
        verifyTimeoutMs: flags['verify-timeout-ms'] ? Number(flags['verify-timeout-ms']) : undefined,
    };
}

/**
 * resume — continue an interrupted installation from install-state.json.
 *
 * The state file is the source of "what has been attempted"; disk truth is
 * re-verified for every artifact. If there is NO state file, resume does NOT
 * silently start a new installation.
 */
async function cmdResume(flags) {
    const root = resolveRoot(flags);
    const workerDir = resolveWorkerDir(flags);
    const hubUrl = resolveHubUrl(flags);
    const repoRoot = resolveRepoRoot(flags);
    const statePath = resolveStatePath(flags);
    const crypto = require('crypto');

    const io = createRealIo();
    const check = loadResumableState(io, statePath);
    if (!check.ok) {
        console.log('No resumable installation state found.');
        if (check.reason === 'state-has-no-profiles') {
            console.log(`(state file at ${statePath} exists but records no profiles — cannot resume)`);
        }
        process.exit(1);
    }

    const st = check.state;
    console.log(`Resuming installation of ${st.profiles.join(' + ')}`);
    for (const line of renderResumeSummary(st)) console.log(line);

    let loadedManifests;
    try {
        loadedManifests = st.profiles.map((p) => manifest.loadManifest(p));
    } catch (err) {
        console.error(`fatal: cannot load profile manifests recorded in state: ${err.message}`);
        process.exit(1);
    }

    const mode = st.mode || flags.mode || 'managed';
    const logger = createLogger({ io });
    const env = probeEnvironment(io, {
        root, workerDir, crypto,
        workerType: loadedManifests.length === 1 ? (loadedManifests[0].worker_bundle || {}).worker_type : null,
    });

    // restored non-secret decisions from state; CLI --yes can still widen them.
    // Explicit consent flags keep their parity with `install` on resume too —
    // a blocked runtime/reference decision must be resolvable via resume.
    const decisions = { ...(st.decisions || {}), ...(flags.yes ? yesDecisions() : {}) };
    if (flags['accept-reference-runtime']) decisions.accept_reference_runtime = true;
    if (flags['accept-runtime-change']) decisions.accept_runtime_change = true;

    const result = await runInstallation({
        manifests: loadedManifests, mode, io,
        roots: { comfyuiRoot: root, workerDir, statePath, repoRoot, hubUrl },
        decisions,
        secretProvider: null, // secrets are never persisted; enter them via a fresh `install` if truly required
        logger, crypto, env, initialState: st,
        options: installOptions(flags),
    });
    printResult(result);
}

function yesDecisions() {
    return {
        comfyui_update: 'yes',
        install_custom_nodes: true,
        install_models: true,
        workflows: 'all',
        worker_setup: true,
        worker_key_provided: true,
    };
}

/**
 * uninstall — remove what the Animastor installer installed, guided by the
 * installation state/manifest. Components that existed before the installer
 * ran are recorded as not-owned and are never removed.
 *
 * Interactive: full-uninstall or per-group Да/Нет questions, with a summary
 * of the exact deletion list shown before anything is removed.
 */
async function cmdUninstall(flags) {
    const io = createRealIo();
    const statePath = resolveStatePath(flags);
    const home = flags.home || process.env.HOME || null;
    const dryRun = flags['dry-run'] || false;
    const yes = flags.yes || false;
    const full = flags.all || false;

    const record = uninstaller.loadInstallRecord(io, statePath);
    if (!record) {
        console.log(`No Animastor installation state found at ${statePath}.`);
        console.log('Without the install manifest the uninstaller cannot determine');
        console.log('what was installed by Animastor — and will not guess or delete');
        console.log('anything by name. Remove leftover directories manually if needed.');
        process.exit(1);
    }
    if (record.corrupt) {
        console.error(`Install state at ${statePath} is unreadable (${record.error}).`);
        console.error('Refusing to uninstall without a valid manifest — nothing was removed.');
        process.exit(1);
    }

    const plan = uninstaller.buildUninstallPlan(io, { state: record, statePath, home });
    console.log(uninstaller.renderUninstallPlan(plan, { state: record }));
    console.log('');

    if (plan.removable_count === 0) {
        console.log('Nothing recorded as installed by Animastor was found on disk — nothing to remove.');
        process.exit(0);
    }

    const answers = {};
    const prompt = createPrompt();
    if (full || yes) {
        for (const g of uninstaller.GROUPS) answers[g.key] = true;
        console.log(full ? 'Mode: FULL uninstall — every removable component listed above will be deleted.' : 'Mode: auto-confirmed (--yes) — every removable component will be deleted.');
    } else {
        const mode = await prompt.select(
            'Choose uninstall mode:',
            [
                'Full uninstall — remove EVERYTHING installed by Animastor',
                'Selective — decide per component',
            ],
        );
        if (mode.startsWith('Full')) {
            for (const g of uninstaller.GROUPS) answers[g.key] = true;
        } else {
            for (const g of uninstaller.GROUPS) {
                // only ask about groups that actually have removable items
                const group = plan.groups.find((x) => x.key === g.key);
                if (!group || !group.items.some((i) => i.removable)) continue;
                answers[g.key] = await prompt.confirm(`Remove ${g.title}?`);
            }
        }
    }

    // Final confirmation: show exactly what will be removed
    const willRemove = [];
    for (const g of plan.groups) {
        if (answers[g.key] !== true) continue;
        for (const it of g.items) {
            if (it.removable) willRemove.push(it.path);
        }
    }
    if (willRemove.length === 0) {
        console.log('\nNothing selected for removal — exiting.');
        prompt.close();
        process.exit(0);
    }
    console.log('\nThe following paths will be REMOVED:');
    for (const p of willRemove) console.log(`  - ${p}`);
    if (!yes) {
        const proceed = await prompt.confirm('\nExecute the uninstall now?');
        if (!proceed) {
            console.log('Aborted — nothing was removed.');
            prompt.close();
            process.exit(0);
        }
    }
    prompt.close();

    const outcome = uninstaller.runUninstallation(io, {
        plan, answers, statePath, dryRun,
        log: createLogger({ io }),
    });
    console.log('');
    console.log(uninstaller.renderUninstallResult(outcome));
    process.exit(outcome.failed > 0 ? 1 : 0);
}

async function cmdVerify(flags) {
    const root = resolveRoot(flags);
    const workerDir = resolveWorkerDir(flags);
    const hubUrl = resolveHubUrl(flags);
    const crypto = require('crypto');
    const io = createRealIo();

    const loadedManifests = flags.profiles.length > 0
        ? flags.profiles.map((p) => manifest.loadManifest(p))
        : [manifest.loadManifest('image/qwen-image')]; // default

    const env = probeEnvironment(io, { root, workerDir, crypto, workerType: loadedManifests[0].worker_bundle.worker_type });
    const report = resolver.resolveInstallation({ manifests: loadedManifests, environment: env, mode: 'existing' });
    const { buildVerificationReport } = require('./verification-report');
    const ver = buildVerificationReport({ report, live: {} });
    console.log(ver.text);
}

function printResult(result) {
    if (result.verification) {
        console.log(`\nRESULT: ${result.verification.status}`);
    } else {
        console.log(`\nRESULT: ${result.status.toUpperCase()}`);
    }
    if (result.warnings.length > 0) {
        console.log('\nWarnings:');
        for (const w of result.warnings) console.log(`  ! ${w}`);
    }
}

/**
 * validate-manifests — check all manifests for completeness and readiness.
 *
 * Validates:
 *   - JSON schema compliance
 *   - All required dependencies have confirmed sources
 *   - Download planner reports READY for all required models
 *   - Auth requirements are documented
 *   - Checksums are present where possible
 */
async function cmdValidateManifests(flags) {
    const loadedManifests = manifest.loadAllManifests();
    const profiles = Object.keys(loadedManifests);
    let allReady = true;
    const hasHfToken = !!(process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN);

    console.log('Installer Manifest Validation');
    console.log(`Profiles found: ${profiles.length}`);
    console.log(`System HF token: ${hasHfToken ? 'available' : 'not set'}`);
    console.log('');

    for (const profileId of profiles) {
        const m = loadedManifests[profileId];
        const validation = m._validation;
        console.log(`${m.profile.id}`);
        console.log(`  Status: ${m.status}`);
        console.log(`  Revision: ${m.revision}`);

        // Show validation errors/warnings
        if (validation && validation.errors.length > 0) {
            console.log(`  ERRORS: ${validation.errors.length}`);
            for (const e of validation.errors) console.log(`    - ${e}`);
        }
        if (validation && validation.warnings.length > 0) {
            console.log(`  Warnings: ${validation.warnings.length}`);
            for (const w of validation.warnings) console.log(`    - ${w}`);
        }

        // Check dependencies
        const deps = m.dependencies || [];
        const requiredModels = deps.filter((d) => (d.kind === 'model' || d.kind === 'model_repo') && d.requirement === 'required');
        const requiredNodes = deps.filter((d) => d.kind === 'custom_node' && d.requirement === 'required');

        console.log(`  Required models: ${requiredModels.length}`);
        console.log(`  Required nodes: ${requiredNodes.length}`);

        // Check each model source
        let profileReady = true;
        for (const dep of requiredModels) {
            const src = dep.source || {};
            const hasRepo = !!src.repository;
            const hasFilePath = !!src.file_path || dep.kind === 'model_repo';
            const verified = src.verification === 'confirmed';
            const hasChecksum = !!(dep.checksum && dep.checksum.value);
            const gated = !!src.gated;

            let status = 'READY';
            if (!hasRepo || !verified) {
                status = 'BLOCKED — source not verified';
                profileReady = false;
            } else if (gated && !hasHfToken) {
                status = 'BLOCKED — gated model, no HF token';
                profileReady = false;
            }

            const check = hasRepo ? '\u2713' : '\u2717';
            const gatedMark = gated ? ' (gated)' : '';
            const checksumMark = hasChecksum ? '' : ' [no sha256]';
            console.log(`    ${check} ${dep.id}${gatedMark}: ${status}${checksumMark}`);
        }

        // Check custom nodes
        for (const dep of requiredNodes) {
            const src = (dep.install || {}).source || {};
            const hasRepo = !!src.repository;
            const hasCommit = !!src.commit;
            const verified = src.verification === 'confirmed';
            let status = 'READY';
            if (!hasRepo || !hasCommit || !verified) {
                status = 'BLOCKED — commit not pinned';
                profileReady = false;
            }
            const check = (hasRepo && hasCommit) ? '\u2713' : '\u2717';
            console.log(`    ${check} ${dep.id}: ${status}`);
        }

        // Check workflows
        const workflows = (m.workflows || {}).artifacts || [];
        console.log(`  Workflows: ${workflows.length}`);
        for (const wf of workflows) {
            const check = wf.baseline_sha256 ? '\u2713' : '\u2717';
            console.log(`    ${check} ${wf.id}${wf.baseline_sha256 ? '' : ' [no sha256]'}`);
        }

        if (!profileReady) allReady = false;
        console.log('');
    }

    console.log(`\nOVERALL: ${allReady ? 'READY' : 'BLOCKED'}`);
    if (!allReady) {
        console.log('Some profiles have unresolved dependencies. See above for details.');
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv);
    switch (args.command) {
        case 'detect':
            await cmdDetect(args.flags);
            break;
        case 'plan':
            await cmdPlan(args.flags);
            break;
        case 'install':
            await cmdInstall(args.flags);
            break;
        case 'verify':
            await cmdVerify(args.flags);
            break;
        case 'validate':
            await cmdValidateManifests(args.flags);
            break;
        case 'resume':
            await cmdResume(args.flags);
            break;
        case 'uninstall':
            await cmdUninstall(args.flags);
            break;
        default:
            console.error('Usage: animastor-installer <detect|plan|install|verify|validate|resume|uninstall> [options]');
            console.error('  --profile P[,P2]   Generation profile id');
            console.error('  --mode MODE        managed | existing | shared');
            console.error('  --root PATH        ComfyUI root (default: ~/ComfyUI)');
            console.error('  --worker-dir PATH  Worker bundle dir');
            console.error('  --hub-url URL      GPU Hub URL');
            console.error('  --yes              Auto-confirm all prompts');
            console.error('  --dry-run          Show plan only; zero mutations');
            console.error('  uninstall flags:');
            console.error('    --all            Full uninstall (remove everything recorded as installed by Animastor)');
            console.error('    --state PATH     Install state file path');
            process.exit(1);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`fatal: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { parseArgs, cmdDetect, cmdPlan, cmdInstall, cmdVerify, cmdValidateManifests, cmdResume, cmdUninstall, resolveAndPlan, makeSecretProvider };
