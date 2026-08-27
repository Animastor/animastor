#!/usr/bin/env node
'use strict';

/**
 * Animastor GPU Worker Installer CLI — Phase 2.
 *
 * Usage:
 *   animastor-installer detect   [--root PATH] [--worker-dir PATH]
 *   animastor-installer plan     --profile P[,P2] [--mode managed|existing|shared] [--root PATH]
 *   animastor-installer install  --profile P[,P2] [--mode ...] [--root PATH] [--yes] [--dry-run] [--worker-dir PATH] [--hub-url URL]
 *   animastor-installer verify   [--profile P[,P2]] [--root PATH] [--worker-dir PATH] [--hub-url URL]
 *   animastor-installer resume
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
            if (['yes', 'dry-run', 'resume', 'start-comfy'].includes(key)) {
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
            return new Promise((resolve) => {
                process.stdout.write(`${question}: `);
                const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
                // suppress echo by reading raw
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
                        resolve(value);
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
        },
        close() { rl.close(); },
    };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

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
    const report = resolver.resolveInstallation({ manifests: loadedManifests, environment: env, mode });
    const plan = buildInstallPlan({ report, manifests: loadedManifests, decisions: {} });
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

    const report = resolver.resolveInstallation({ manifests: loadedManifests, environment: env, mode });
    const plan = buildInstallPlan({ report, manifests: loadedManifests, decisions: {} });

    console.log(plan.plan_text);

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
        for (const stepId of plan.awaiting_decisions) {
            const step = plan.steps.find((s) => s.id === stepId);
            if (!step || !step.prompt) continue;
            const answer = await prompt.confirm(step.prompt.question);
            if (stepId === 'comfyui-update') decisions.comfyui_update = answer ? 'yes' : 'no';
            else if (stepId === 'custom-nodes') decisions.install_custom_nodes = answer;
            else if (stepId === 'models') decisions.install_models = answer;
            else if (stepId === 'workflows') decisions.workflows = answer ? 'all' : 'none';
            else if (stepId === 'worker-setup') decisions.worker_setup = answer;
            else if (stepId === 'worker-key') decisions.worker_key_provided = answer;
        }
        prompt.close();

        // Re-run with decisions
        const report2 = resolver.resolveInstallation({ manifests: loadedManifests, environment: env, mode });
        const plan2 = buildInstallPlan({ report2, manifests: loadedManifests, decisions });

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
            decisions, logger, crypto, env, dryRun, options: installOptions(flags),
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

    const result = await runInstallation({
        manifests: loadedManifests, mode, io,
        roots: { comfyuiRoot: root, workerDir, statePath, repoRoot, hubUrl },
        // restored non-secret decisions from state; CLI --yes can still widen them
        decisions: { ...(st.decisions || {}), ...(flags.yes ? yesDecisions() : {}) },
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
        case 'resume':
            await cmdResume(args.flags);
            break;
        default:
            console.error('Usage: animastor-installer <detect|plan|install|verify|resume> [options]');
            console.error('  --profile P[,P2]   Generation profile id');
            console.error('  --mode MODE        managed | existing | shared');
            console.error('  --root PATH        ComfyUI root (default: ~/ComfyUI)');
            console.error('  --worker-dir PATH  Worker bundle dir');
            console.error('  --hub-url URL      GPU Hub URL');
            console.error('  --yes              Auto-confirm all prompts');
            console.error('  --dry-run          Show plan only; zero mutations');
            process.exit(1);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`fatal: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { parseArgs, cmdDetect, cmdPlan, cmdInstall, cmdVerify, cmdResume };
