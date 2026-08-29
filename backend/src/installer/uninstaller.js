'use strict';

/**
 * Uninstaller — safe, manifest-driven removal of Animastor installer artifacts.
 *
 * The ONLY source of truth for "what belongs to Animastor" is the
 * installation state/manifest written by the installer
 * (<root>/.animastor-installer/install-state.json → `components` registry).
 * The uninstaller never guesses by file names and never removes anything
 * that is not registered there:
 *
 *   - a ComfyUI directory that existed before the installer ran is recorded
 *     as owned:false and is NEVER removed wholesale (the installer-owned
 *     venv inside it is removed precisely);
 *   - custom nodes / models / workflows that were already present are not
 *     registered as owned and are not touched;
 *   - a worker directory created by the installer may be removed entirely;
 *     a pre-existing worker directory only has the files the installer
 *     actually copied removed;
 *   - the worker .env is removed only when the installer created it (merge
 *     semantics: a pre-existing .env is left in place).
 *
 * Every deletion goes through assertDeletablePath(): absolute, normalized,
 * deep enough, never a system directory, never $HOME, never an ancestor of
 * the state file or the home directory.
 */

const path = require('path');

/**
 * System directory prefixes: nothing inside these may ever be deleted.
 * (Install roots normally live under $HOME or a user-chosen data dir such as
 * /opt/<name> or /data/<name>, which stay allowed.)
 */
const SYSTEM_PREFIXES = Object.freeze([
    '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32',
    '/proc', '/run', '/sbin', '/sys', '/usr', '/var',
]);

/** Directories that may only be deleted as whole paths, never exactly. */
const PROTECTED_DIRS = Object.freeze([
    '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64',
    '/libx32', '/media', '/mnt', '/opt', '/proc', '/root', '/run', '/sbin',
    '/srv', '/sys', '/tmp', '/usr', '/var',
]);

/** Interactive question groups, in the order they are asked. */
const GROUPS = Object.freeze([
    { key: 'comfyui', title: 'Animastor ComfyUI (incl. the installer-created venv)' },
    { key: 'models', title: 'Models installed by Animastor' },
    { key: 'custom_nodes', title: 'Custom Nodes installed by Animastor' },
    { key: 'worker', title: 'Animastor Worker (bundle files the installer deployed + .env it created)' },
    { key: 'services', title: 'Cleaner / related service artifacts (cleanup journal, registered services)' },
    { key: 'config', title: 'Remaining Animastor configuration/state files (install-state.json)' },
]);

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/** Escape a single-quoted shell word. */
function shQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Guard every deletion target.
 * @returns {string} the resolved absolute path (safe to delete)
 * @throws when the path is not safely deletable
 */
function assertDeletablePath(p, { home = null } = {}) {
    if (typeof p !== 'string' || p.length === 0) {
        throw new Error(`refusing to delete: invalid path ${JSON.stringify(p)}`);
    }
    if (!path.isAbsolute(p)) {
        throw new Error(`refusing to delete relative path: ${p}`);
    }
    const resolved = path.resolve(p);
    if (resolved !== p && path.resolve(resolved) !== path.resolve(p)) {
        throw new Error(`refusing to delete non-normalized path: ${p}`);
    }
    if (resolved === '/' || path.dirname(resolved) === resolved) {
        throw new Error(`refusing to delete filesystem root: ${resolved}`);
    }
    if (PROTECTED_DIRS.includes(resolved)) {
        throw new Error(`refusing to delete protected system directory: ${resolved}`);
    }
    for (const prefix of SYSTEM_PREFIXES) {
        if (resolved === prefix || resolved.startsWith(prefix + '/')) {
            throw new Error(`refusing to delete a path inside the system directory ${prefix}: ${resolved}`);
        }
    }
    const homeResolved = home ? path.resolve(home) : null;
    if (homeResolved) {
        if (resolved === homeResolved) {
            throw new Error(`refusing to delete the home directory: ${resolved}`);
        }
        if (homeResolved.startsWith(resolved + path.sep)) {
            throw new Error(`refusing to delete a parent of the home directory: ${resolved}`);
        }
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// Plan construction (read-only)
// ---------------------------------------------------------------------------

function loadInstallRecord(io, statePath) {
    if (!io.fs.existsSync(statePath)) return null;
    let parsed;
    try {
        parsed = JSON.parse(io.fs.readFileSync(statePath, 'utf8'));
    } catch (err) {
        return { corrupt: true, error: err.message };
    }
    if (!parsed || parsed.state_version !== 1) return { corrupt: true, error: 'unsupported or missing state_version' };
    const { normalizeState } = require('./engine/state');
    return normalizeState(parsed);
}

function entryKind(io, absPath) {
    try {
        const st = io.fs.statSync(absPath);
        return st.isDirectory ? 'dir' : 'file';
    } catch (_) {
        return 'missing';
    }
}

function item({ label, path: p, type = 'dir', owned = true, removable = true, created = null, note = null, files = null }) {
    return { label, path: p, type, owned, removable, created, note, files };
}

/**
 * Build the full uninstall plan from the installation state.
 * Pure/read-only: it inspects the state and disk presence but deletes nothing.
 *
 * @param {object} io
 * @param {object} args { state, statePath, home }
 * @returns {{ groups: object[], removable_count, skipped_count, has_any }}
 */
function buildUninstallPlan(io, { state, statePath, home = null }) {
    const comps = state.components || {};
    const groups = [];
    let removableCount = 0;
    let skippedCount = 0;

    const guard = (p) => {
        try {
            return { ok: true, path: assertDeletablePath(p, { home }) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    };

    const addGroup = (key, items, skipped = []) => {
        const removableItems = items.filter((i) => i.removable && i.path);
        removableCount += removableItems.length;
        skippedCount += skipped.length;
        groups.push({ key, items, skipped });
    };

    // --- ComfyUI + venv -----------------------------------------------------
    const comfyItems = [];
    const comfySkipped = [];
    if (comps.comfyui && comps.comfyui.path) {
        const c = comps.comfyui;
        if (c.owned === true) {
            const g = guard(c.path);
            const containsState = statePath && path.resolve(statePath).startsWith(path.resolve(c.path) + path.sep);
            comfyItems.push(item({
                label: `ComfyUI directory (created by the installer)${c.ref ? ` @ ${c.ref}` : ''}`,
                path: g.ok ? g.path : c.path,
                removable: g.ok,
                note: g.ok
                    ? (containsState ? 'removing this directory also removes the install state/manifest inside it' : null)
                    : g.error,
                owned: true,
            }));
        } else {
            comfySkipped.push({
                label: `ComfyUI at ${c.path}`,
                reason: 'pre-existing (not created by the Animastor installer) — never removed by the uninstaller',
            });
        }
    }
    if (comps.venv && comps.venv.path && comps.venv.owned) {
        const g = guard(comps.venv.path);
        comfyItems.push(item({
            label: `Python venv (created by the installer)${comps.venv.created === false ? ' — pre-existing venv inside the root' : ''}`,
            path: g.ok ? g.path : comps.venv.path,
            removable: g.ok,
            created: comps.venv.created === true ? true : null,
            note: g.ok ? null : g.error,
        }));
    }
    addGroup('comfyui', comfyItems, comfySkipped);

    // --- Models ---------------------------------------------------------------
    const modelItems = [];
    for (const e of comps.models || []) {
        const kind = entryKind(io, e.path);
        if (kind === 'missing') continue;
        if (e.created === false && Array.isArray(e.files) && e.files.length > 0) {
            // a directory that existed before the install — only registered
            // downloaded files are ours
            for (const f of e.files) {
                const fp = path.join(e.path, f);
                const g = guard(fp);
                modelItems.push(item({
                    label: `model file ${f} (${e.id || 'model'})`,
                    path: g.ok ? g.path : fp,
                    type: 'file',
                    removable: g.ok,
                    created: false,
                    note: g.ok ? null : g.error,
                }));
            }
        } else {
            const g = guard(e.path);
            modelItems.push(item({
                label: `${e.id || 'model'} → ${e.path}`,
                path: g.ok ? g.path : e.path,
                type: kind === 'dir' ? 'dir' : 'file',
                removable: g.ok,
                created: e.created === true ? true : null,
                note: g.ok ? null : g.error,
            }));
        }
    }
    addGroup('models', modelItems);

    // --- Custom nodes ----------------------------------------------------------
    const nodeItems = [];
    for (const e of comps.custom_nodes || []) {
        if (entryKind(io, e.path) === 'missing') continue;
        const g = guard(e.path);
        nodeItems.push(item({
            label: `${e.id || 'custom node'} → ${e.path}`,
            path: g.ok ? g.path : e.path,
            removable: g.ok,
            note: g.ok ? null : g.error,
        }));
    }
    addGroup('custom_nodes', nodeItems);

    // --- Worker ------------------------------------------------------------------
    const workerItems = [];
    const workerSkipped = [];
    if (comps.worker && comps.worker.dir) {
        const w = comps.worker;
        if (w.owned === true) {
            const g = guard(w.dir);
            workerItems.push(item({
                label: `Worker directory (created by the installer) → ${w.dir}`,
                path: g.ok ? g.path : w.dir,
                removable: g.ok,
                note: g.ok ? null : g.error,
            }));
        } else {
            workerSkipped.push({
                label: `Worker directory ${w.dir}`,
                reason: 'pre-existing — only files deployed by the installer are removable',
            });
            for (const f of w.files_installed || []) {
                const fp = path.join(w.dir, f);
                const g = guard(fp);
                workerItems.push(item({
                    label: `worker file deployed by the installer → ${f}`,
                    path: g.ok ? g.path : fp,
                    type: 'file',
                    removable: g.ok,
                    note: g.ok ? null : g.error,
                }));
            }
            if ((w.files_installed || []).includes('package.json')) {
                const nm = path.join(w.dir, 'node_modules');
                if (io.fs.existsSync(nm)) {
                    const g = guard(nm);
                    workerItems.push(item({
                        label: 'worker node_modules (installed for the deployed package.json)',
                        path: g.ok ? g.path : nm,
                        removable: g.ok,
                        note: g.ok ? null : g.error,
                    }));
                }
            }
        }
        if (w.env_created === true) {
            const envPath = path.join(w.dir, '.env');
            if (io.fs.existsSync(envPath)) {
                const g = guard(envPath);
                workerItems.push(item({
                    label: 'worker .env (created by the installer; contains the Worker Key)',
                    path: g.ok ? g.path : envPath,
                    type: 'file',
                    removable: g.ok,
                    note: g.ok ? null : g.error,
                }));
            }
        } else if (w.env_created === false) {
            workerSkipped.push({
                label: `worker .env at ${path.join(w.dir, '.env')}`,
                reason: 'pre-existing (the installer only merged keys into it) — left in place; remove Animastor keys manually if desired',
            });
        }
    }
    addGroup('worker', workerItems, workerSkipped);

    // --- Services / cleaner artifacts ---------------------------------------------
    const serviceItems = [];
    if (comps.worker && comps.worker.dir && comps.worker.owned !== true) {
        const journal = path.join(comps.worker.dir, 'cleanup-journal');
        if (io.fs.existsSync(journal)) {
            const g = guard(journal);
            serviceItems.push(item({
                label: `worker cleanup journal → ${journal}`,
                path: g.ok ? g.path : journal,
                removable: g.ok,
                note: g.ok ? null : g.error,
            }));
        }
        const envVal = readEnvValue(io, path.join(comps.worker.dir, '.env'), 'WORKER_JOURNAL_DIR');
        if (envVal && io.fs.existsSync(envVal) && envVal !== journal) {
            const g = guard(envVal);
            serviceItems.push(item({
                label: `worker cleanup journal (WORKER_JOURNAL_DIR) → ${envVal}`,
                path: g.ok ? g.path : envVal,
                removable: g.ok,
                note: g.ok ? null : g.error,
            }));
        }
    }
    for (const e of comps.services || []) {
        if (entryKind(io, e.path) === 'missing') continue;
        const g = guard(e.path);
        serviceItems.push(item({
            label: `${e.id || 'service artifact'} → ${e.path}`,
            path: g.ok ? g.path : e.path,
            type: e.type || 'dir',
            removable: g.ok,
            note: g.ok ? null : g.error,
        }));
    }
    addGroup('services', serviceItems);

    // --- Config / state --------------------------------------------------------------
    const configItems = [];
    if (io.fs.existsSync(statePath)) {
        configItems.push(item({
            label: `installation state/manifest → ${statePath}`,
            path: statePath,
            type: 'file',
            removable: true,
            note: 'removed last; also removes the containing directory when empty',
        }));
    }
    addGroup('config', configItems);

    return {
        groups,
        removable_count: removableCount,
        skipped_count: skippedCount,
        has_any: removableCount > 0 || skippedCount > 0,
    };
}

/** Read a single value from a .env file. The value is never logged. */
function readEnvValue(io, envPath, key) {
    try {
        const text = io.fs.readFileSync(envPath, 'utf8');
        for (const line of text.split('\n')) {
            const m = new RegExp(`^${key}\\s*=\\s*(.*)$`).exec(line.trim());
            if (m && m[1]) {
                return m[1].trim().replace(/^["']|["']$/g, '');
            }
        }
    } catch (_) { /* no .env */ }
    return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderUninstallPlan(plan, { state = null } = {}) {
    const lines = [];
    lines.push('Animastor Worker Uninstaller');
    if (state) {
        const when = state.updated || state.created || 'unknown time';
        lines.push(`Recorded installation: profiles ${(state.profiles || []).join(' + ') || '—'}, device ${state.device || 'unknown'}, updated ${when}`);
    }
    lines.push('');
    for (const group of plan.groups) {
        if (group.items.length === 0 && group.skipped.length === 0) continue;
        const groupDef = GROUPS.find((g) => g.key === group.key);
        lines.push(`[${groupDef ? groupDef.title : group.key}]`);
        for (const it of group.items) {
            const size = it.removable ? '' : ' (NOT removable — see note)';
            lines.push(`  - ${it.label}${size}`);
            if (it.note) lines.push(`      note: ${it.note}`);
        }
        for (const s of group.skipped) {
            lines.push(`  - ${s.label} — KEPT: ${s.reason}`);
        }
        lines.push('');
    }
    lines.push(`Removable components: ${plan.removable_count}; pre-existing (kept): ${plan.skipped_count}`);
    return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Find live processes whose working directory is under any of the paths
 * (ComfyUI server, worker). Read-only /proc scan.
 * @returns {number[]} pids
 */
function findProcessesUsingPaths(io, paths) {
    if (!paths || paths.length === 0) return [];
    const script = 'for p in /proc/[0-9]*; do '
        + 'cwd=$(readlink "$p/cwd" 2>/dev/null) || continue; '
        + `case "$cwd" in ${paths.map((p) => `${shQuote(p)}*`).join('| ')}) echo "\${p#/proc/}";; esac; done`;
    const r = io.exec('sh', ['-c', script]);
    if (r.code !== 0) return [];
    return r.stdout.split('\n').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Execute the uninstall plan.
 * @param {object} args { io, plan, answers: {comfyui,models,custom_nodes,worker,services,config},
 *                        statePath, log, dryRun }
 * @returns {{ results: object[], removed: number, kept: number, failed: number }}
 */
function runUninstallation(io, { plan, answers, statePath, log = null, dryRun = false }) {
    const results = [];
    let removed = 0;
    let kept = 0;
    let failed = 0;

    const say = (msg) => { if (log && log.info) log.info(msg); };

    // 0. stop live processes for the paths that are about to be removed
    const targetPaths = [];
    for (const group of plan.groups) {
        if (answers[group.key] !== true) continue;
        for (const it of group.items) {
            if (it.removable) targetPaths.push(it.path);
        }
    }
    const pids = findProcessesUsingPaths(io, targetPaths);
    for (const pid of pids) {
        if (dryRun) {
            results.push({ path: `pid ${pid}`, status: 'would-stop-process' });
        } else {
            const r = io.exec('kill', ['-TERM', String(pid)]);
            results.push({ path: `pid ${pid}`, status: r.code === 0 ? 'stopped-process' : 'stop-failed' });
            if (r.code !== 0) failed += 1;
            else say(`stopped process ${pid} (SIGTERM)`);
        }
    }

    // 1. component deletions (state file group handled last)
    for (const group of plan.groups) {
        if (group.key === 'config') continue;
        if (answers[group.key] !== true) {
            for (const it of group.items) {
                results.push({ path: it.path, status: 'kept-by-user' });
                kept += 1;
            }
            continue;
        }
        for (const it of group.items) {
            if (!it.removable) {
                results.push({ path: it.path, status: 'skipped-pre-existing', note: it.note });
                kept += 1;
                continue;
            }
            if (dryRun) {
                results.push({ path: it.path, status: `would-remove-${it.type}` });
                removed += 1;
                continue;
            }
            let abs;
            try {
                abs = assertDeletablePath(it.path, {});
            } catch (err) {
                results.push({ path: it.path, status: 'failed', error: err.message });
                failed += 1;
                continue;
            }
            if (!io.fs.existsSync(abs)) {
                results.push({ path: abs, status: 'missing' });
                continue;
            }
            try {
                if (it.type === 'file') {
                    io.fs.unlinkSync(abs);
                } else {
                    io.fs.rmSync(abs, { recursive: true, force: true });
                }
                results.push({ path: abs, status: 'removed' });
                removed += 1;
                say(`removed: ${abs}`);
            } catch (err) {
                results.push({ path: abs, status: 'failed', error: err.message });
                failed += 1;
            }
        }
    }

    // 2. config/state last — so a failed run keeps its record
    if (answers.config === true) {
        const configGroup = plan.groups.find((g) => g.key === 'config');
        for (const it of configGroup ? configGroup.items : []) {
            if (dryRun) {
                results.push({ path: it.path, status: 'would-remove-file' });
                removed += 1;
                continue;
            }
            try {
                const abs = assertDeletablePath(it.path, {});
                if (io.fs.existsSync(abs)) {
                    io.fs.unlinkSync(abs);
                    results.push({ path: abs, status: 'removed' });
                    removed += 1;
                    say(`removed: ${abs}`);
                } else {
                    results.push({ path: abs, status: 'missing' });
                }
                // drop the state dir when empty (best effort)
                const dir = path.dirname(abs);
                try { io.fs.rmdirSync(dir); } catch (_) { /* not empty or absent */ }
            } catch (err) {
                results.push({ path: it.path, status: 'failed', error: err.message });
                failed += 1;
            }
        }
    } else {
        const configGroup = plan.groups.find((g) => g.key === 'config');
        for (const it of configGroup ? configGroup.items : []) {
            results.push({ path: it.path, status: 'kept-by-user' });
            kept += 1;
        }
    }

    return { results, removed, kept, failed };
}

function renderUninstallResult(outcome) {
    const lines = [];
    lines.push('Uninstall results:');
    for (const r of outcome.results) {
        lines.push(`  - ${r.status}: ${r.path}${r.error ? ` (${r.error})` : ''}${r.note ? ` [${r.note}]` : ''}`);
    }
    lines.push('');
    lines.push(`Removed: ${outcome.removed}, kept: ${outcome.kept}, failed: ${outcome.failed}`);
    if (outcome.failed > 0) {
        lines.push('Some components could not be removed — they are listed above. Nothing unregistered was touched.');
    }
    return lines.join('\n').trim();
}

module.exports = {
    PROTECTED_DIRS,
    SYSTEM_PREFIXES,
    GROUPS,
    assertDeletablePath,
    loadInstallRecord,
    buildUninstallPlan,
    renderUninstallPlan,
    findProcessesUsingPaths,
    runUninstallation,
    renderUninstallResult,
    readEnvValue,
};
