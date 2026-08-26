'use strict';

/**
 * Safety Rules — Private Worker Installer Phase 1.5.
 *
 * Declarative, pure safety model for the (future) interactive installer.
 * The installer's write engine must consult these rules BEFORE any mutation;
 * anything listed in NEVER_AUTOMATIC is forbidden without an explicit,
 * recorded user confirmation — and some operations are forbidden outright.
 *
 * Companion invariant: the compatibility resolver never emits destructive
 * actions (see compatibility-resolver.js ACTIONS). These rules extend that
 * invariant to the execution layer.
 */

/**
 * Operations the installer must NEVER perform automatically.
 * Each requires an explicit interactive user confirmation; operations marked
 * `forbidden: true` must not be performed by the installer at all in v1.
 */
const NEVER_AUTOMATIC = Object.freeze([
    { op: 'delete_model', forbidden: true, description: 'delete user models' },
    { op: 'delete_custom_node', forbidden: true, description: 'delete user custom nodes' },
    { op: 'delete_workflow', forbidden: true, description: 'delete user workflows' },
    { op: 'replace_user_workflow', forbidden: true, description: 'overwrite/replace a user workflow (a fresh baseline copy goes to a DISTINCT path)' },
    { op: 'downgrade_comfyui', forbidden: false, description: 'downgrade ComfyUI (only with explicit consent, checkpoint before)' },
    { op: 'downgrade_torch', forbidden: true, description: "downgrade/replace the user's torch in existing mode" },
    { op: 'change_cuda', forbidden: true, description: 'install/change CUDA or the NVIDIA driver' },
    { op: 'destroy_python_environment', forbidden: true, description: "recreate/destroy the user's existing Python environment" },
    { op: 'overwrite_env_token', forbidden: true, description: 'overwrite an existing valid Worker Key in .env (merge semantics only)' },
    { op: 'update_comfyui', forbidden: false, description: 'update an existing ComfyUI to the recommended version (only with explicit consent)' },
    { op: 'checkout_custom_node', forbidden: false, description: 'git-safe checkout of an existing custom node to the pinned commit (only with explicit consent)' },
]);

const NEVER_AUTOMATIC_OPS = Object.freeze(NEVER_AUTOMATIC.map((r) => r.op));

/**
 * Secret environment variable names (mirrors scripts/animastor-runtime-audit.sh
 * SECRET_NAMES). Values of these keys must never appear in logs, reports,
 * plan renderings, argv, or state files.
 */
const SECRET_NAMES = Object.freeze([
    'ANIMASTOR_WORKER_TOKEN',
    'POSTGRES_PASSWORD',
    'HF_TOKEN',
    'HUGGINGFACE_HUB_TOKEN',
    'WORKSPACE_SECRET_KEY',
    'GPU_HUB_API_KEY',
    'OPENROUTER_API_KEY',
]);

const SECRET_NAME_PATTERN = /(^|_)(TOKEN|SECRET|PASSWORD|API_KEY)$/i;

function isSecretName(name) {
    const n = String(name || '').toUpperCase();
    return SECRET_NAMES.includes(n) || SECRET_NAME_PATTERN.test(n);
}

/**
 * Redact secret values from arbitrary text (defense in depth for logging).
 * `secrets` is a list of concrete values to scrub; additionally any
 * KEY=value style assignment of a secret-looking name is masked.
 */
function redactSecrets(text, secrets = []) {
    let out = String(text);
    for (const s of secrets) {
        if (s) out = out.split(s).join('<REDACTED>');
    }
    out = out.replace(/^([ \t]*[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*)(?!<REDACTED>).*$/gim, '$1<REDACTED>');
    return out;
}

/**
 * Classify a resolver entry into execution safety attributes.
 * Returns { destructive, requires_confirmation, forbidden }.
 *
 * - install of a NEW file (missing entry) is non-destructive but is still
 *   part of the plan the user confirms before anything runs;
 * - review entries always require a user decision;
 * - configure requires interactive input (Worker Key: hidden, never logged);
 * - nothing produced by the resolver is ever destructive — that invariant is
 *   asserted by assertSafeReport.
 */
function classifyEntry(entry) {
    const base = { destructive: false, forbidden: false, requires_confirmation: false };
    switch (entry.action) {
        case 'install':
            return { ...base, requires_confirmation: entry.requirement === 'required' ? true : entry.requirement === 'unknown' };
        case 'configure':
            return { ...base, requires_confirmation: true, interactive_secret: entry.kind === 'worker' };
        case 'review':
            return { ...base, requires_confirmation: true };
        case 'skip':
        case 'none':
            return base;
        default:
            return { ...base, requires_confirmation: true };
    }
}

/**
 * Hard invariant: a resolver report must never plan destructive operations.
 * Throws on violation. Safe to run on every report (tests do).
 */
function assertSafeReport(report) {
    if (!report || !Array.isArray(report.entries)) {
        throw new Error('assertSafeReport: not a resolution report');
    }
    if (!Array.isArray(report.destructive_operations) || report.destructive_operations.length !== 0) {
        throw new Error('assertSafeReport: report contains destructive operations');
    }
    const forbidden = ['remove', 'delete', 'downgrade', 'uninstall', 'replace', 'destroy'];
    for (const e of report.entries) {
        if (forbidden.includes(e.action)) {
            throw new Error(`assertSafeReport: entry ${e.id} has forbidden action "${e.action}"`);
        }
        // secret values must never be embedded in entries (keys are fine)
        if (e.env && e.env.values) {
            throw new Error(`assertSafeReport: entry ${e.id} embeds env values — only key names are allowed`);
        }
    }
    return true;
}

/**
 * Gate for potentially disruptive operations executed by the (future)
 * installer engine. Returns { allowed, reason }.
 * An operation is allowed only if:
 *   - it is not in the forbidden subset of NEVER_AUTOMATIC, AND
 *   - an explicit user confirmation object is provided
 *     ({ confirmed: true, op, via: 'interactive-prompt' }).
 */
function confirmationGate(op, confirmation = null) {
    const rule = NEVER_AUTOMATIC.find((r) => r.op === op);
    if (!rule) {
        return { allowed: false, reason: `unknown operation "${op}" — not in the safety model` };
    }
    if (rule.forbidden) {
        return { allowed: false, reason: `operation "${op}" (${rule.description}) is forbidden for the installer in v1` };
    }
    if (!confirmation || confirmation.confirmed !== true || confirmation.op !== op) {
        return { allowed: false, reason: `operation "${op}" requires explicit user confirmation before execution` };
    }
    return { allowed: true, reason: null };
}

module.exports = {
    NEVER_AUTOMATIC,
    NEVER_AUTOMATIC_OPS,
    SECRET_NAMES,
    isSecretName,
    redactSecrets,
    classifyEntry,
    assertSafeReport,
    confirmationGate,
};
