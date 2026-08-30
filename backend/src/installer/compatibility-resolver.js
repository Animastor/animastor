'use strict';

/**
 * Compatibility Resolver — Private Worker Installer Phase 1 / Phase 1.5.
 *
 * Pure, read-only resolution logic. It accepts:
 *   - profiles/manifests (canonical install manifests),
 *   - environment probe (= installed state: ComfyUI, python/torch, nodes,
 *     models, workflows, worker),
 *   - runtime mode,
 * and produces a structured resolution report. It performs NO installation,
 * NO deletion and NO mutation of any environment. The report is the input
 * for a future installer; the installer must not decide "what is needed"
 * on its own.
 *
 * Runtime modes (see docs/04-planning/private-worker-installer-phase15.md):
 *   managed  — installer fully owns the environment (V1 target);
 *   existing — detect → compare → report → optionally install missing;
 *              never replace/downgrade the user's environment automatically;
 *   isolated — one GPU machine, several independent ComfyUI environments
 *              (data model + interface only; full implementation later);
 *   shared   — one ComfyUI serving several profiles; resolver computes the
 *              union of dependencies and detects runtime conflicts.
 *
 * Entry kinds (Phase 1.5): runtime | custom_node | model | model_repo |
 * python_package | workflow | worker.
 *
 * Entry statuses: required | installed | missing | incompatible | unused | unknown
 *   required     — declared required by manifest; environment was not probed
 *                  for this kind, so no installed/missing judgement is possible
 *   installed    — required and found compatible (for workflow: present —
 *                  possibly customized by the user, which is ALLOWED)
 *   missing      — required and absent
 *   incompatible — found, but version/config conflicts with the manifest
 *   unused       — present on the machine, not required by selected profiles
 *                  (informational; NEVER auto-removed)
 *   unknown      — present but cannot be matched/verified, or compatibility
 *                  cannot be determined from available evidence
 *
 * Actions: install | skip | review | none | configure.
 *   configure — interactive worker/.env setup (Worker Key entered hidden;
 *               never logged, never passed via argv).
 *
 * Workflow semantics (Phase 1.5): a baseline workflow is an EDITABLE starting
 * point. A copy whose hash differs from the manifest baseline_sha256 is
 * "installed/customized" — NOT an error, never overwritten. A fresh official
 * copy can be downloaded separately under a distinct name on request.
 *
 * Multi-profile (shared) verdicts:
 *   shared-compatible | shared-conflict | requires-isolation | unknown
 */

const RUNTIME_MODES = Object.freeze(['managed', 'existing', 'isolated', 'shared']);

const ENTRY_STATUSES = Object.freeze([
    'required', 'installed', 'missing', 'incompatible', 'unused', 'unknown',
]);

const ACTIONS = Object.freeze(['install', 'skip', 'review', 'none', 'configure']);

const SHARING_VERDICTS = Object.freeze([
    'shared-compatible', 'shared-conflict', 'requires-isolation', 'unknown',
]);

// Upstream renames that must not be treated as different repositories.
const REPO_ALIASES = Object.freeze({
    'comfyanonymous/comfyui': 'comfy-org/comfyui',
});

const SIZE_TOLERANCE = 0.05; // 5% — audit sizes are human-rounded (e.g. "16.54 GiB")

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

function parseVersion(v) {
    if (typeof v !== 'string') return null;
    const base = v.trim().replace(/^v/i, '').split('+')[0];
    const parts = base.split('.').map((p) => {
        const m = /^(\d+)/.exec(p);
        return m ? parseInt(m[1], 10) : NaN;
    });
    if (parts.length === 0 || parts.some(Number.isNaN)) return null;
    return parts;
}

/** -1 if a<b, 0 if equal, 1 if a>b, null if either is unparseable. */
function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return null;
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/** Short/full sha match: case-insensitive prefix in either direction (min 7 chars). */
function shaMatch(a, b) {
    if (!a || !b) return false;
    const x = String(a).toLowerCase();
    const y = String(b).toLowerCase();
    if (x === y) return true;
    const n = Math.min(x.length, y.length);
    if (n < 7) return false;
    return x.startsWith(y) || y.startsWith(x);
}

function repoKey(url) {
    if (!url) return null;
    let key = String(url).trim().toLowerCase().replace(/\.git$/, '');
    key = key.replace(/^https?:\/\/github\.com\//, '').replace(/^github:/, '');
    return REPO_ALIASES[key] || key;
}

function reposEqual(a, b) {
    const ka = repoKey(a);
    const kb = repoKey(b);
    if (!ka || !kb) return true; // cannot compare — not a mismatch by itself
    return ka === kb;
}

function normPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Environment model
// ---------------------------------------------------------------------------

/**
 * Environment probe result (= installed state).
 * `null` means "probed, absent"; `undefined` means "not probed" — the
 * resolver must distinguish the two (missing vs required/undetermined).
 */
function createEmptyEnvironment(root = null) {
    return {
        root,
        comfyui: null,
        python: null,
        torch: null,
        nodejs: null,
        gpu: null,
        custom_nodes: [],
        models: [],
        python_packages: [],
        workflows: [],
        worker: null,
    };
}

// ---------------------------------------------------------------------------
// Manifest union (multi-profile)
// ---------------------------------------------------------------------------

function unionDependencies(manifests) {
    const byId = new Map();
    const conflicts = [];

    for (const manifest of manifests) {
        const profileId = manifest.profile ? manifest.profile.id : '<unknown>';
        for (const dep of manifest.dependencies || []) {
            if (!byId.has(dep.id)) {
                byId.set(dep.id, { dep: JSON.parse(JSON.stringify(dep)), profiles: [profileId] });
                continue;
            }
            const slot = byId.get(dep.id);
            if (!slot.profiles.includes(profileId)) slot.profiles.push(profileId);

            const have = slot.dep.install && slot.dep.install.source ? slot.dep.install.source.commit : null;
            const other = dep.install && dep.install.source ? dep.install.source.commit : null;
            if (have && other && !shaMatch(have, other)) {
                conflicts.push({
                    component: 'dependency',
                    id: dep.id,
                    profiles: { [slot.profiles[0]]: have, [profileId]: other },
                    reason: 'same dependency id is pinned to different commits by different profiles',
                });
            } else if (!have && other) {
                // adopt the only known pin, keep provenance of both profiles
                slot.dep.install = JSON.parse(JSON.stringify(dep.install));
                slot.dep.notes = (slot.dep.notes || []).concat(
                    [`commit pin adopted from ${profileId} manifest; the other profile has no pin (unverified)`]
                );
            }
        }
    }
    return { byId, conflicts };
}

// ---------------------------------------------------------------------------
// Runtime checks (single-manifest verdicts)
// ---------------------------------------------------------------------------

function checkComfyuiAgainst(spec, comfyEnv) {
    if (comfyEnv === undefined) {
        return { status: 'required', action: 'review', notes: ['environment not probed for ComfyUI'] };
    }
    if (!comfyEnv || comfyEnv.present === false) {
        return { status: 'missing', action: 'install', notes: [] };
    }

    const pin = spec.pin;
    if (pin) {
        const commitOk = shaMatch(pin.commit, comfyEnv.commit);
        const tagOk = pin.tag && (comfyEnv.tag === pin.tag || comfyEnv.version === pin.tag);
        if (commitOk || tagOk) {
            const notes = [];
            if (pin.repository && comfyEnv.repository && !reposEqual(pin.repository, comfyEnv.repository)) {
                notes.push(`git remote differs from manifest pin (${comfyEnv.repository} vs ${pin.repository}) — commit/tag matched, treat with care`);
            }
            return { status: 'installed', grade: 'canonical', action: 'skip', notes };
        }
        const v = comfyEnv.version || comfyEnv.tag;
        if (v) {
            if (spec.min_version && compareVersions(v, spec.min_version) === -1) {
                return {
                    status: 'incompatible',
                    reason: 'below_minimum',
                    action: 'review',
                    notes: [`found ${v} < min ${spec.min_version}; suggest upgrade to the pinned version; abort if the user declines; never forced`],
                };
            }
            if (spec.max_tested_version && compareVersions(v, spec.max_tested_version) === 1) {
                return {
                    status: 'incompatible',
                    reason: 'above_max_tested',
                    action: 'review',
                    notes: [`found ${v} > max tested ${spec.max_tested_version}; NEVER auto-downgrade; user decides: downgrade to pin or continue at own risk (recorded in install state)`],
                };
            }
            return {
                status: 'installed',
                grade: 'range',
                action: 'skip',
                notes: [`version ${v} is within [${spec.min_version}, ${spec.max_tested_version}] but is not the exact pin (range-if-approved)`],
            };
        }
        return {
            status: 'unknown',
            action: 'review',
            notes: ['ComfyUI present but version/commit cannot be determined (not a git repository?) — scenario D, ask the user'],
        };
    }

    const ref = spec.known_working_reference;
    if (ref) {
        const commitOk = shaMatch(ref.commit, comfyEnv.commit);
        const repoOk = reposEqual(ref.repository, comfyEnv.repository);
        if (commitOk && repoOk) {
            return {
                status: 'installed',
                grade: 'reference',
                action: 'skip',
                notes: ['matches the known-working reference environment; canonical pin is still unknown (manifest basis=unknown) — no automatic changes to it'],
            };
        }
        return {
            status: 'unknown',
            action: 'review',
            notes: ['canonical ComfyUI requirement is unknown for this profile; the installed version matches neither a canonical pin nor the known-working reference — compatibility cannot be determined (golden run required); NO automatic replacement/downgrade'],
        };
    }
    return { status: 'unknown', action: 'review', notes: ['manifest has neither a canonical pin nor a known-working reference'] };
}

/** Base version without the local build tag: "2.10.0+cu128" → "2.10.0". */
function torchBaseVersion(v) {
    return String(v || '').trim().split('+')[0].toLowerCase();
}

/** Local build tag: "2.10.0+cpu" → "cpu"; "2.10.0" → "". */
function torchLocalTag(v) {
    const parts = String(v || '').trim().split('+');
    return parts.length > 1 ? parts[1].toLowerCase() : '';
}

function checkTorchAgainst(spec, torchEnv, device = null) {
    if (torchEnv === undefined) {
        return { status: 'required', action: 'review', notes: ['environment not probed for torch'] };
    }
    if (!torchEnv || !torchEnv.version) {
        return { status: 'missing', action: 'install', notes: [] };
    }
    // CPU-only machine: the manifest may declare a dedicated CPU build (pin +
    // CPU wheel index). "+cpu" local tags and the untagged pin are equivalent.
    if (device === 'cpu' && spec.cpu && spec.cpu.pin) {
        const found = String(torchEnv.version);
        if (torchBaseVersion(found) === torchBaseVersion(spec.cpu.pin)
            && ['', 'cpu'].includes(torchLocalTag(found))) {
            return { status: 'installed', grade: 'cpu-canonical', action: 'skip', notes: [`CPU build ${found} matches the manifest CPU pin ${spec.cpu.pin}`] };
        }
        return {
            status: 'incompatible',
            reason: 'version_mismatch',
            action: 'review',
            notes: [`found ${torchEnv.version}, manifest pins CPU torch ${spec.cpu.pin}; CPU torch is NEVER auto-replaced — user decision required`],
        };
    }
    const found = String(torchEnv.version).toLowerCase();
    if (spec.pin) {
        if (found === String(spec.pin).toLowerCase()) {
            return { status: 'installed', grade: 'canonical', action: 'skip', notes: [] };
        }
        return {
            status: 'incompatible',
            reason: 'version_mismatch',
            action: 'review',
            notes: [`found ${torchEnv.version}, manifest pins ${spec.pin}; in 'existing' mode torch is NEVER auto-replaced — user decision required`],
        };
    }
    const ref = spec.known_working_reference;
    if (ref && ref.version) {
        if (found === String(ref.version).toLowerCase()) {
            return {
                status: 'installed',
                grade: 'reference',
                action: 'skip',
                notes: ['matches the known-working reference; canonical torch pin is still unknown (manifest basis=unknown)'],
            };
        }
        return {
            status: 'unknown',
            action: 'review',
            notes: [`found ${torchEnv.version}; canonical pin unknown and the version matches neither the pin nor the known-working reference (${ref.version}) — compatibility cannot be determined; NO automatic replacement`],
        };
    }
    return { status: 'unknown', action: 'review', notes: ['manifest has neither a canonical torch pin nor a reference'] };
}

function checkMinimumAgainst(component, spec, envValue) {
    if (envValue === undefined) {
        return { status: 'required', action: 'review', notes: [`environment not probed for ${component}`] };
    }
    if (!envValue || !envValue.version) {
        return { status: 'missing', action: 'install', notes: [] };
    }
    const cmp = compareVersions(envValue.version, spec.minimum);
    if (cmp === null) {
        return { status: 'unknown', action: 'review', notes: [`cannot parse ${component} version "${envValue.version}"`] };
    }
    if (cmp === -1) {
        return {
            status: 'incompatible',
            reason: 'below_minimum',
            action: 'review',
            notes: [`found ${envValue.version} < minimum ${spec.minimum}`],
        };
    }
    return { status: 'installed', grade: 'minimum-satisfied', action: 'skip', notes: [] };
}

const RUNTIME_ORDER = ['comfyui', 'torch', 'python', 'nodejs'];

function combineRuntimeVerdicts(perManifest) {
    // perManifest: [{ verdict, profile }]
    const statuses = perManifest.map((p) => p.verdict.status);
    if (statuses.every((s) => s === 'installed')) {
        const grades = perManifest.map((p) => p.verdict.grade || 'canonical');
        const grade = grades.includes('reference') ? 'reference' : grades.find((g) => g !== 'canonical') || 'canonical';
        return {
            status: 'installed',
            grade,
            action: 'skip',
            notes: perManifest.flatMap((p) => p.verdict.notes || []),
        };
    }
    if (statuses.every((s) => s === 'missing')) {
        return { status: 'missing', action: 'install', notes: [] };
    }
    const incompatible = perManifest.filter((p) => p.verdict.status === 'incompatible');
    if (incompatible.length > 0) {
        return {
            status: 'incompatible',
            reason: incompatible[0].verdict.reason || 'profiles_disagree',
            action: 'review',
            notes: perManifest.flatMap((p) => (p.verdict.notes || []).map((n) => `[${p.profile}] ${n}`)),
        };
    }
    if (statuses.includes('installed') && statuses.includes('missing')) {
        return {
            status: 'incompatible',
            reason: 'profiles_disagree',
            action: 'review',
            notes: ['installed state satisfies some profiles but not others — profiles cannot share this runtime as-is'],
        };
    }
    return {
        status: 'unknown',
        action: 'review',
        notes: perManifest.flatMap((p) => (p.verdict.notes || []).map((n) => `[${p.profile}] ${n}`)),
    };
}

// ---------------------------------------------------------------------------
// Dependency checks
// ---------------------------------------------------------------------------

function missingAction(dep) {
    if (dep.requirement === 'required') return 'install';
    if (dep.requirement === 'unknown') return 'review';
    return 'none';
}

/**
 * 'installed' is reserved for REQUIRED dependencies found compatible.
 * An optional dependency that is present is 'unused' (kept, never removed);
 * a dependency whose requirement is still unresolved is 'unknown'.
 */
function remapByRequirement(entry, dep) {
    if (entry.status !== 'installed') return entry;
    if (dep.requirement === 'optional') {
        return {
            ...entry,
            status: 'unused',
            action: 'none',
            notes: (entry.notes || []).concat(['optional dependency — present but not required; kept as-is, never auto-removed']),
        };
    }
    if (dep.requirement === 'unknown') {
        return {
            ...entry,
            status: 'unknown',
            action: 'review',
            notes: (entry.notes || []).concat(['requirement is unresolved in the manifest (needs verification) — presence noted, no automatic action']),
        };
    }
    return entry;
}

function findInstalledNode(env, dep) {
    if (!Array.isArray(env.custom_nodes)) return undefined;
    const dir = dep.install && dep.install.directory ? String(dep.install.directory).toLowerCase() : null;
    const name = dep.name ? String(dep.name).toLowerCase() : null;
    const src = dep.install && dep.install.source ? dep.install.source : null;
    return env.custom_nodes.find((n) => {
        const nd = String(n.directory || '').toLowerCase();
        if (dir && nd === dir) return true;
        if (name && nd === name) return true;
        if (src && src.repository && n.repository && reposEqual(src.repository, n.repository) && shaMatch(src.commit, n.commit)) return true;
        return false;
    });
}

function checkCustomNode(dep, env, profiles) {
    const base = { id: dep.id, kind: 'custom_node', name: dep.name, requirement: dep.requirement, basis: dep.basis, profiles };
    if (env.custom_nodes === undefined) {
        return { ...base, status: 'required', action: 'review', notes: ['environment not probed for custom nodes'] };
    }
    const found = findInstalledNode(env, dep);
    if (!found) {
        return { ...base, status: 'missing', action: missingAction(dep), expected: describeNodeExpectation(dep), notes: [] };
    }
    const wantCommit = dep.install && dep.install.source ? dep.install.source.commit : null;
    const haveCommit = found.commit || null;
    const notes = [];
    if (dep.patches && dep.patches.length > 0) {
        notes.push(`requires patch(es): ${dep.patches.map((p) => p.id).join(', ')} — patch state is not detectable by the resolver yet (documented, not declarative)`);
    }
    if (wantCommit && haveCommit) {
        if (shaMatch(wantCommit, haveCommit)) {
            return { ...base, status: 'installed', grade: 'canonical-version', action: 'skip', found: describeNodeFound(found), notes };
        }
        notes.push(`installed commit ${haveCommit} differs from manifest pin ${wantCommit}; in 'existing' mode a git-safe checkout is SUGGESTED, never applied automatically`);
        return { ...base, status: 'incompatible', reason: 'version_mismatch', action: 'review', expected: wantCommit, found: describeNodeFound(found), notes };
    }
    if (wantCommit && !haveCommit) {
        notes.push('present as a plain directory without git metadata — pinned version cannot be verified');
    } else if (!wantCommit) {
        notes.push('manifest has no pinned commit for this node yet (TODO) — presence verified only');
    }
    return { ...base, status: 'installed', grade: 'presence', action: 'skip', found: describeNodeFound(found), notes };
}

function describeNodeExpectation(dep) {
    const src = (dep.install && dep.install.source) || {};
    return { directory: dep.install && dep.install.directory, repository: src.repository || null, commit: src.commit || null };
}

function describeNodeFound(found) {
    return { directory: found.directory, repository: found.repository || null, commit: found.commit || null, is_git: found.is_git !== false && Boolean(found.commit) };
}

function checkModel(dep, env, profiles) {
    const base = { id: dep.id, kind: 'model', name: dep.name, requirement: dep.requirement, basis: dep.basis, profiles };
    if (env.models === undefined) {
        return { ...base, status: 'required', action: 'review', notes: ['environment not probed for models'] };
    }
    const expectedPath = `${normPath(dep.target_dir)}/${dep.filename}`;
    const found = (env.models || []).find((m) => normPath(m.path) === expectedPath);
    if (!found) {
        return { ...base, status: 'missing', action: missingAction(dep), expected: { path: expectedPath }, notes: [] };
    }
    const checksum = dep.checksum || {};
    if (checksum.value && found.sha256) {
        if (String(found.sha256).toLowerCase() === String(checksum.value).toLowerCase()) {
            return { ...base, status: 'installed', grade: 'checksum-verified', action: 'skip', found: { path: found.path }, notes: [] };
        }
        return {
            ...base,
            status: 'incompatible',
            reason: 'checksum_mismatch',
            action: 'review',
            found: { path: found.path, sha256: found.sha256 },
            notes: ['checksum mismatch — never continue with a possibly corrupted model; re-download after user confirmation'],
        };
    }
    if (checksum.value_prefix && found.sha256) {
        const ok = String(found.sha256).toLowerCase().startsWith(String(checksum.value_prefix).toLowerCase());
        if (!ok) {
            return {
                ...base,
                status: 'incompatible',
                reason: 'checksum_mismatch',
                action: 'review',
                found: { path: found.path, sha256: found.sha256 },
                notes: [`sha256 prefix does not match audit-captured prefix ${checksum.value_prefix}`],
            };
        }
        return { ...base, status: 'installed', grade: 'checksum-prefix-verified', action: 'skip', found: { path: found.path }, notes: [] };
    }
    if (dep.size_bytes_approx && found.size_bytes) {
        const rel = Math.abs(found.size_bytes - dep.size_bytes_approx) / dep.size_bytes_approx;
        if (rel > SIZE_TOLERANCE) {
            return {
                ...base,
                status: 'incompatible',
                reason: 'size_mismatch',
                action: 'review',
                expected: { size_bytes_approx: dep.size_bytes_approx },
                found: { path: found.path, size_bytes: found.size_bytes },
                notes: ['size differs from the reference audit size by more than 5% — possibly a different file/quant; user review required'],
            };
        }
        return { ...base, status: 'installed', grade: 'size-verified', action: 'skip', found: { path: found.path, size_bytes: found.size_bytes }, notes: [] };
    }
    return { ...base, status: 'installed', grade: 'presence', action: 'skip', found: { path: found.path }, notes: ['presence only — no checksum/size evidence available'] };
}

function checkModelRepo(dep, env, profiles) {
    const base = { id: dep.id, kind: 'model_repo', name: dep.name, requirement: dep.requirement, basis: dep.basis, profiles };
    if (env.models === undefined) {
        return { ...base, status: 'required', action: 'review', notes: ['environment not probed for models'] };
    }
    const prefix = normPath(dep.target_dir);
    const matches = (env.models || []).filter((m) => normPath(m.path).startsWith(`${prefix}/`));
    if (matches.length === 0) {
        return {
            ...base,
            status: 'missing',
            action: missingAction(dep),
            expected: { target_dir: prefix, repo: dep.repo },
            notes: dep.delivery && dep.delivery.mechanism === 'node_auto_download'
                ? ['the custom node can auto-download this repo on first run (decision D2: preinstall vs auto_download)']
                : [],
        };
    }
    if (Array.isArray(dep.expected_files) && dep.expected_files.length > 0) {
        const have = new Set(matches.map((m) => normPath(m.path)));
        const missingFiles = dep.expected_files.filter((f) => !have.has(`${prefix}/${normPath(f)}`));
        if (missingFiles.length > 0) {
            // Partially present: status stays 'missing' (with reason
            // 'incomplete') so plan/engine treat it as installable — the
            // downloader is idempotent and resumes .part files, it never
            // re-downloads a verified file. 'incompatible' would park it as a
            // review item and an interrupted download could never resume.
            return {
                ...base,
                status: 'missing',
                reason: 'incomplete',
                action: 'install',
                found: { files: Array.from(have) },
                notes: [`present but incomplete; missing: ${missingFiles.join(', ')}`],
            };
        }
        return { ...base, status: 'installed', grade: 'files-verified', action: 'skip', found: { files: dep.expected_files }, notes: [] };
    }
    return { ...base, status: 'installed', grade: 'presence', action: 'skip', found: { files: matches.map((m) => normPath(m.path)) }, notes: [] };
}

function checkPythonPackage(dep, env, profiles) {
    const base = { id: dep.id, kind: 'python_package', name: dep.name, requirement: dep.requirement, basis: dep.basis, profiles };
    if (env.python_packages === undefined) {
        return { ...base, status: 'required', action: 'review', notes: ['environment not probed for python packages'] };
    }
    const found = (env.python_packages || []).find((p) => String(p.name).toLowerCase() === String(dep.name).toLowerCase());
    if (!found) {
        return { ...base, status: 'missing', action: missingAction(dep), notes: [] };
    }
    if (dep.version && found.version && String(dep.version) !== String(found.version)) {
        return {
            ...base,
            status: 'incompatible',
            reason: 'version_mismatch',
            action: 'review',
            expected: dep.version,
            found: { version: found.version },
            notes: [],
        };
    }
    const notes = dep.version ? [] : ['manifest does not pin a version yet (TODO) — presence verified only'];
    return { ...base, status: 'installed', grade: 'presence', action: 'skip', found: { version: found.version || null }, notes };
}

function checkDependency(slot, env) {
    const { dep, profiles } = slot;
    let entry;
    switch (dep.kind) {
        case 'custom_node': entry = checkCustomNode(dep, env, profiles); break;
        case 'model': entry = checkModel(dep, env, profiles); break;
        case 'model_repo': entry = checkModelRepo(dep, env, profiles); break;
        case 'python_package': entry = checkPythonPackage(dep, env, profiles); break;
        default:
            entry = { id: dep.id, kind: dep.kind, requirement: dep.requirement, basis: dep.basis, profiles, status: 'unknown', action: 'review', notes: [`unknown dependency kind: ${dep.kind}`] };
    }
    return remapByRequirement(entry, dep);
}

// ---------------------------------------------------------------------------
// Workflow checks (Phase 1.5 — first-class artifacts, editable baselines)
// ---------------------------------------------------------------------------

/**
 * A baseline workflow is an OPTIONAL demo/test artifact and an EDITABLE
 * starting point — never a runtime requirement: Animastor sends workflow JSON
 * with each task via the API/GPU Hub, so a profile is fully usable for
 * API-based generation without any locally installed copies. Local copies
 * exist only to test ComfyUI in its Web UI or as a starting point for the
 * user's own workflows. Consequences:
 *   - absent at the baseline path            → missing (OFFERED for download,
 *     but optional: it is never counted as a missing required component and
 *     never blocks or fails the installation);
 *   - present, hash matches baseline_sha256  → installed / canonical-baseline;
 *   - present, hash differs                  → installed / customized —
 *     this is ALLOWED, never an error, and NEVER overwritten;
 *   - present, no baseline hash recorded     → installed / presence.
 * The installer may later download a FRESH official copy under a distinct
 * name on explicit request; it never touches the user's copy.
 */
function checkWorkflow(wf, env, profiles) {
    const base = {
        id: wf.id,
        kind: 'workflow',
        name: wf.name,
        // Workflows are ALWAYS optional regardless of what a manifest says:
        // no locally installed workflow file is ever a runtime dependency.
        requirement: 'optional',
        basis: wf.basis || 'optional',
        profiles,
    };
    if (env.workflows === undefined) {
        return { ...base, status: 'unknown', action: 'none', notes: ['environment not probed for workflows (optional artifacts)'] };
    }
    const expectedPath = `${normPath(wf.target_dir)}/${wf.filename}`;
    const found = (env.workflows || []).find((w) => normPath(w.path) === expectedPath);
    if (!found) {
        return {
            ...base,
            status: 'missing',
            // 'install' is an OFFER for the interactive plan (the user may
            // download a copy), not a required install: requirement stays
            // 'optional', so missing workflows never reach missing_required
            // or blocking and never fail verification.
            action: 'install',
            expected: { path: expectedPath },
            notes: ['optional demo workflow — download writes a NEW file only; it never touches existing user workflows'],
        };
    }
    if (wf.baseline_sha256 && found.sha256) {
        if (String(found.sha256).toLowerCase() === String(wf.baseline_sha256).toLowerCase()) {
            return { ...base, status: 'installed', grade: 'canonical-baseline', action: 'skip', found: { path: found.path }, notes: [] };
        }
        return {
            ...base,
            status: 'installed',
            grade: 'customized',
            action: 'skip',
            found: { path: found.path, sha256: found.sha256 },
            notes: ['user has customized this baseline workflow — ALLOWED (editable baseline); NEVER overwritten; a fresh official copy can be downloaded separately under a distinct name on request'],
        };
    }
    return {
        ...base,
        status: 'installed',
        grade: 'presence',
        action: 'skip',
        found: { path: found.path },
        notes: ['presence only — no baseline sha256 and/or file hash available'],
    };
}

// ---------------------------------------------------------------------------
// Worker checks (Phase 1.5 — Animastor worker bundle + .env, secrets-safe)
// ---------------------------------------------------------------------------

/**
 * Worker probe shape (env.worker): a single probe object or an array of
 * probes (shared mode — one per worker_type):
 *   { worker_type, bundle: { present, dir, files[] }, env: { present, set_keys[] } }
 * SECURITY: probes record which env KEYS are set — never their VALUES.
 * The resolver therefore can never leak a Worker Key into a report/log.
 */
function checkWorker(manifest, env) {
    const wb = manifest.worker_bundle || {};
    const profileId = manifest.profile ? manifest.profile.id : '<unknown>';
    const workerType = wb.worker_type || (manifest.profile ? manifest.profile.type : null);
    const base = {
        id: `worker:${profileId}`,
        kind: 'worker',
        worker_type: workerType,
        requirement: 'required',
        basis: wb.basis || 'minimum_supported',
        profiles: [profileId],
    };
    if (env.worker === undefined) {
        return { ...base, status: 'required', action: 'review', notes: ['environment not probed for the Animastor worker'] };
    }
    const probes = Array.isArray(env.worker) ? env.worker : [env.worker];
    const probe = probes.find((p) => p && (p.worker_type === workerType || workerType === null));
    if (!probe || !probe.bundle || probe.bundle.present === false) {
        return { ...base, status: 'missing', action: 'install', expected: { files: wb.files || [] }, notes: [] };
    }
    const haveFiles = probe.bundle.files || [];
    const filesMissing = (wb.files || []).filter((f) => !haveFiles.includes(f));
    if (filesMissing.length > 0) {
        return {
            ...base,
            status: 'incompatible',
            reason: 'incomplete_bundle',
            action: 'install',
            expected: { files: wb.files },
            found: { files: haveFiles },
            notes: [`bundle incomplete; missing files: ${filesMissing.join(', ')}`],
        };
    }
    const requiredEnv = (wb.env && wb.env.required) || [];
    const secretKeys = (wb.env && wb.env.secrets) || [];
    if (!probe.env || probe.env.present === false) {
        return {
            ...base,
            status: 'installed',
            grade: 'bundle-only',
            action: 'configure',
            found: { files: haveFiles },
            env: { present: false, missing_required: requiredEnv.slice() },
            notes: ['.env not created yet — interactive configuration required (merge semantics; never overwrite an existing valid token)'],
        };
    }
    const setKeys = probe.env.set_keys || [];
    const envMissing = requiredEnv.filter((k) => !setKeys.includes(k));
    if (envMissing.length > 0) {
        const secretMissing = envMissing.filter((k) => secretKeys.includes(k));
        return {
            ...base,
            status: 'installed',
            grade: 'bundle-only',
            action: 'configure',
            found: { files: haveFiles },
            env: { present: true, missing_required: envMissing },
            notes: secretMissing.length > 0
                ? [`missing secret key(s): ${secretMissing.join(', ')} — prompt interactively (hidden input); the VALUE is never logged, never stored in reports/state, never passed via argv`]
                : [`missing env keys: ${envMissing.join(', ')}`],
        };
    }
    return {
        ...base,
        status: 'installed',
        grade: 'configured',
        action: 'skip',
        found: { files: haveFiles },
        env: { present: true, missing_required: [] },
        notes: [],
    };
}

// ---------------------------------------------------------------------------
// Extras: unused / unknown detection (never destructive)
// ---------------------------------------------------------------------------

function collectKnownExtraNames(manifests) {
    const names = new Set();
    for (const m of manifests) {
        for (const dep of m.dependencies || []) {
            if (dep.requirement !== 'required') {
                if (dep.install && dep.install.directory) names.add(String(dep.install.directory).toLowerCase());
                if (dep.name) names.add(String(dep.name).toLowerCase());
                if (dep.filename) names.add(String(dep.filename).toLowerCase());
            }
        }
        for (const ref of m.environment_reference || []) {
            for (const extra of ref.known_extras || []) {
                if (extra.name) names.add(String(extra.name).toLowerCase());
            }
        }
    }
    return names;
}

function classifyExtras(manifests, env, matchedNodeDirs, matchedModelPaths, matchedWorkflowPaths) {
    const entries = [];
    const known = collectKnownExtraNames(manifests);

    if (Array.isArray(env.custom_nodes)) {
        for (const node of env.custom_nodes) {
            const dir = String(node.directory || '');
            if (matchedNodeDirs.has(dir.toLowerCase())) continue;
            const isKnown = known.has(dir.toLowerCase());
            entries.push({
                id: `extra:custom-node:${dir}`,
                kind: 'custom_node',
                requirement: isKnown ? 'optional' : 'unknown',
                basis: isKnown ? 'environment_reference' : 'unknown',
                status: isKnown ? 'unused' : 'unknown',
                action: 'none',
                found: describeNodeFound(node),
                notes: isKnown
                    ? ['known component, not required by the selected profiles — kept as-is, NEVER auto-removed']
                    : ['cannot be matched to any manifest record (no git remote / plain dir / unrecognized) — left untouched, reported for the user'],
            });
        }
    }

    if (Array.isArray(env.models)) {
        for (const model of env.models) {
            const p = normPath(model.path);
            if (matchedModelPaths.has(p)) continue;
            const basename = p.split('/').pop().toLowerCase();
            const isKnown = known.has(basename) || Array.from(known).some((name) => name.includes('/') && p.toLowerCase().includes(name));
            entries.push({
                id: `extra:model:${p}`,
                kind: 'model',
                requirement: isKnown ? 'optional' : 'unknown',
                basis: isKnown ? 'environment_reference' : 'unknown',
                status: isKnown ? 'unused' : 'unknown',
                action: 'none',
                found: { path: p, size_bytes: model.size_bytes || null },
                notes: isKnown
                    ? ['known component, not referenced by the selected profiles\' production workflows — kept as-is, NEVER auto-removed']
                    : ['cannot be matched to any manifest record — left untouched, reported for the user'],
            });
        }
    }

    // Phase 1.5: any workflow file that is not a required baseline artifact is
    // a USER workflow (editable by design) — reported, never touched.
    if (Array.isArray(env.workflows)) {
        for (const wf of env.workflows) {
            const p = normPath(wf.path);
            if (matchedWorkflowPaths.has(p)) continue;
            const isUserArea = p.toLowerCase().startsWith('user/');
            entries.push({
                id: `extra:workflow:${p}`,
                kind: 'workflow',
                requirement: isUserArea ? 'optional' : 'unknown',
                basis: isUserArea ? 'environment_reference' : 'unknown',
                status: isUserArea ? 'unused' : 'unknown',
                action: 'none',
                found: { path: p, sha256: wf.sha256 || null },
                notes: isUserArea
                    ? ['user workflow — editable by design; NEVER modified, replaced or removed by the installer']
                    : ['workflow file outside the user area — left untouched, reported for the user'],
            });
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Shared-runtime resolution (multi-profile, manifest-level)
// ---------------------------------------------------------------------------

function effectiveRuntimeConstraint(manifest, component) {
    const spec = (manifest.runtime_requirements || {})[component] || {};
    if (component === 'comfyui') {
        if (spec.pin && (spec.pin.commit || spec.pin.tag)) {
            return { value: `${repoKey(spec.pin.repository) || '?'}@${spec.pin.commit || spec.pin.tag}`, grade: 'canonical', raw: spec.pin };
        }
        const ref = spec.known_working_reference;
        if (ref && (ref.commit || ref.tag)) {
            return { value: `${repoKey(ref.repository) || '?'}@${ref.commit || ref.tag}`, grade: 'reference', raw: ref };
        }
        return { value: null, grade: 'unknown' };
    }
    if (spec.pin) return { value: String(spec.pin).toLowerCase(), grade: 'canonical' };
    if (spec.known_working_reference && spec.known_working_reference.version) {
        return { value: String(spec.known_working_reference.version).toLowerCase(), grade: 'reference' };
    }
    return { value: null, grade: 'unknown' };
}

function pairwiseConflicts(items, component, kind) {
    const conflicts = [];
    for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
            const a = items[i];
            const b = items[j];
            if (a.c.value && b.c.value && a.c.value !== b.c.value) {
                conflicts.push({
                    component,
                    kind,
                    profiles: [a.profile, b.profile],
                    detail: `${a.profile}: ${a.c.value}  vs  ${b.profile}: ${b.c.value}`,
                });
            }
        }
    }
    return conflicts;
}

/**
 * Determine whether several profiles can share ONE ComfyUI runtime.
 * Returns an explicit verdict — never silently merges incompatible versions.
 */
function resolveSharedRuntime(manifests) {
    if (!Array.isArray(manifests) || manifests.length === 0) {
        throw new Error('resolveSharedRuntime requires a non-empty array of manifests');
    }
    const profiles = manifests.map((m) => (m.profile ? m.profile.id : '<unknown>'));
    const conflicts = [];
    const unknowns = [];

    const comfy = manifests.map((m) => ({ profile: m.profile.id, c: effectiveRuntimeConstraint(m, 'comfyui') }));
    const torch = manifests.map((m) => ({ profile: m.profile.id, c: effectiveRuntimeConstraint(m, 'torch') }));

    conflicts.push(...pairwiseConflicts(comfy, 'comfyui', 'requires-isolation'));
    conflicts.push(...pairwiseConflicts(torch, 'torch', 'shared-conflict'));

    if (manifests.length > 1 && comfy.every((x) => x.c.value === null)) {
        unknowns.push('comfyui: no canonical or known-working constraint in any manifest');
    }
    if (manifests.length > 1 && torch.every((x) => x.c.value === null)) {
        unknowns.push('torch: no canonical or known-working constraint in any manifest');
    }

    const union = unionDependencies(manifests);
    for (const c of union.conflicts) {
        conflicts.push({ ...c, kind: 'shared-conflict' });
    }

    // combined minimums (minimum policies never conflict — take the strictest)
    const combinedMinimums = {};
    for (const component of ['python', 'nodejs']) {
        let max = null;
        for (const m of manifests) {
            const spec = (m.runtime_requirements || {})[component] || {};
            if (spec.minimum && (max === null || compareVersions(spec.minimum, max) === 1)) max = spec.minimum;
        }
        combinedMinimums[component] = max;
    }

    const hasIsolationConflict = conflicts.some((c) => c.component === 'comfyui');
    const hasSharedConflict = conflicts.some((c) => c.component !== 'comfyui');

    let verdict;
    if (hasIsolationConflict) verdict = 'requires-isolation';
    else if (hasSharedConflict) verdict = 'shared-conflict';
    else if (unknowns.length > 0) verdict = 'unknown';
    else verdict = 'shared-compatible';

    const grades = [...comfy, ...torch].filter((x) => x.c.value !== null).map((x) => x.c.grade);
    const evidenceGrade = grades.length === 0 ? 'unknown' : (grades.includes('reference') ? 'reference' : 'canonical');

    const canShare = verdict === 'shared-compatible';
    const message = canShare
        ? `profiles can share one ComfyUI runtime (evidence grade: ${evidenceGrade}${evidenceGrade === 'reference' ? ' — established from known-working reference environments, canonical policy pending' : ''})`
        : verdict === 'unknown'
            ? 'cannot determine whether profiles can share one ComfyUI runtime — insufficient evidence'
            : 'profiles cannot safely share one ComfyUI runtime — use isolated environments (separate ComfyUI + venv per profile)';

    const unionSummary = {
        dependencies_total: union.byId.size,
        custom_nodes: Array.from(union.byId.values()).filter((s) => s.dep.kind === 'custom_node').map((s) => s.dep.id),
        models: Array.from(union.byId.values()).filter((s) => s.dep.kind === 'model' || s.dep.kind === 'model_repo').map((s) => s.dep.id),
        shared_by_multiple_profiles: Array.from(union.byId.values())
            .filter((s) => s.profiles.length > 1)
            .map((s) => ({ id: s.dep.id, profiles: s.profiles })),
    };

    return {
        verdict,
        can_share: canShare,
        evidence_grade: evidenceGrade,
        profiles,
        conflicts,
        unknowns,
        combined_minimums: combinedMinimums,
        union: unionSummary,
        message,
    };
}

// ---------------------------------------------------------------------------
// Main resolution entry point
// ---------------------------------------------------------------------------

const CPU_ONLY_NOTE = 'CPU-only mode: no supported GPU runtime detected — CPU PyTorch will be installed and ComfyUI will run with --cpu. Performance will be SIGNIFICANTLY lower; this mode is intended for the TTS/audio profile, not for image/video generation.';
const AMD_FALLBACK_NOTE = 'AMD GPU detected, but the installer provides no ROCm/accelerated runtime branch yet — falling back to CPU-only mode (explicit fallback, not a silent degradation).';

function summarizeHardware(env, manifests) {
    // env.device comes from the probe; the fallback covers legacy/synthetic
    // environments (a detected GPU without vendor info is treated as CUDA).
    const device = env.device || (env.gpu ? 'cuda' : 'cpu');
    const info = {
        gpu: env.gpu || null,
        device,
        notes: [],
    };
    if (device === 'cpu') {
        if (env.gpu && env.gpu.vendor === 'amd') info.notes.push(AMD_FALLBACK_NOTE);
        info.notes.push(CPU_ONLY_NOTE);
        info.sufficient_vram = null; // VRAM is irrelevant in CPU-only mode
        return info;
    }
    const mins = manifests.map((m) => (m.hardware || {}).gpu_min_vram_gb).filter((v) => typeof v === 'number');
    if (mins.length > 0 && env.gpu && typeof env.gpu.vram_mib === 'number') {
        const need = Math.max(...mins);
        const haveGb = env.gpu.vram_mib / 1024;
        if (haveGb < need) {
            info.notes.push(`VRAM ${haveGb.toFixed(1)} GB is below the manifest minimum ${need} GB`);
            info.sufficient_vram = false;
        } else {
            info.sufficient_vram = true;
        }
    } else {
        info.sufficient_vram = null;
        info.notes.push('minimum VRAM is unknown for the selected profiles (manifest hardware.gpu_min_vram_gb=null) — preflight must measure, no automatic judgement');
    }
    return info;
}

/**
 * Resolve installation state for one or more profiles against one environment.
 *
 * @param {object} args
 * @param {object|object[]} args.manifests - canonical manifest(s)
 * @param {object} [args.environment] - environment probe (installed state);
 *   omitted/null = clean machine (empty environment)
 * @param {string} [args.mode='existing'] - one of RUNTIME_MODES
 * @param {string} [args.label] - optional environment label (isolation root, etc.)
 * @returns structured resolution report (see module header)
 */
function resolveInstallation({ manifests, environment = null, mode = 'existing', label = null }) {
    if (!RUNTIME_MODES.includes(mode)) {
        throw new Error(`unknown runtime mode "${mode}" (expected one of ${RUNTIME_MODES.join(', ')})`);
    }
    const list = Array.isArray(manifests) ? manifests : [manifests];
    if (list.length === 0 || list.some((m) => !m || !m.profile)) {
        throw new Error('resolveInstallation requires at least one valid manifest');
    }
    if (mode === 'shared' && list.length < 2) {
        throw new Error("mode 'shared' requires at least two manifests");
    }

    const env = environment || createEmptyEnvironment();
    const warnings = [];
    const entries = [];

    if (mode === 'managed' && env.comfyui && env.comfyui.present !== false) {
        warnings.push('managed mode requested, but an existing ComfyUI was detected — fail-safe: it will be compared and reported, never automatically replaced or removed');
    }

    const sharing = list.length > 1 ? resolveSharedRuntime(list) : null;
    if (sharing && !sharing.can_share) {
        warnings.push(`shared runtime: ${sharing.message}`);
    }

    // --- runtime entries -------------------------------------------------
    for (const component of RUNTIME_ORDER) {
        const perManifest = list.map((m) => {
            const spec = (m.runtime_requirements || {})[component] || {};
        let verdict;
        if (component === 'comfyui') verdict = checkComfyuiAgainst(spec, env.comfyui);
        else if (component === 'torch') verdict = checkTorchAgainst(spec, env.torch, env.device || null);
        else verdict = checkMinimumAgainst(component, spec, env[component]);
            return { profile: m.profile.id, verdict, basis: spec.basis };
        });
        const combined = list.length === 1 ? perManifest[0].verdict : combineRuntimeVerdicts(perManifest);
        const basis = perManifest.find((p) => p.basis === 'known_working')
            ? 'known_working'
            : (perManifest.find((p) => p.basis === 'minimum_supported') ? 'minimum_supported' : (perManifest[0].basis || 'unknown'));
        entries.push({
            id: `runtime:${component}`,
            kind: 'runtime',
            component,
            requirement: 'required',
            basis,
            profiles: list.map((m) => m.profile.id),
            expected: expectedRuntime(component, list),
            found: foundRuntime(component, env),
            ...combined,
        });
    }

    // --- dependency entries ----------------------------------------------
    const union = unionDependencies(list);
    const matchedNodeDirs = new Set();
    const matchedModelPaths = new Set();

    for (const slot of union.byId.values()) {
        const entry = checkDependency(slot, env);
        entries.push(entry);
        // Mark as matched whenever the probe actually found the dependency in
        // the environment (regardless of installed/incompatible/unused/unknown),
        // so classifyExtras does not report it a second time.
        if (entry.found) {
            if (slot.dep.kind === 'custom_node') {
                const dir = slot.dep.install && slot.dep.install.directory;
                if (dir) matchedNodeDirs.add(String(dir).toLowerCase());
                if (slot.dep.name) matchedNodeDirs.add(String(slot.dep.name).toLowerCase());
                // also mark whatever directory the probe actually matched on
                if (entry.found && entry.found.directory) matchedNodeDirs.add(String(entry.found.directory).toLowerCase());
            } else if (slot.dep.kind === 'model') {
                matchedModelPaths.add(`${normPath(slot.dep.target_dir)}/${slot.dep.filename}`);
            } else if (slot.dep.kind === 'model_repo') {
                const prefix = normPath(slot.dep.target_dir);
                for (const m of env.models || []) {
                    if (normPath(m.path).startsWith(`${prefix}/`)) matchedModelPaths.add(normPath(m.path));
                }
            }
        }
    }

    // --- workflow entries (Phase 1.5: first-class artifacts) --------------
    const matchedWorkflowPaths = new Set();
    for (const m of list) {
        const wfSection = m.workflows;
        const artifacts = wfSection && Array.isArray(wfSection.artifacts) ? wfSection.artifacts : [];
        for (const wf of artifacts) {
            const entry = checkWorkflow(wf, env, [m.profile.id]);
            entries.push(entry);
            if (entry.found && entry.found.path) matchedWorkflowPaths.add(normPath(entry.found.path));
        }
    }

    // --- worker entries (Phase 1.5: one per profile/worker_type) ----------
    for (const m of list) {
        entries.push(checkWorker(m, env));
    }

    // --- extras: unused / unknown (never removed) -------------------------
    entries.push(...classifyExtras(list, env, matchedNodeDirs, matchedModelPaths, matchedWorkflowPaths));

    // --- summary -----------------------------------------------------------
    const byStatus = {};
    for (const s of ENTRY_STATUSES) byStatus[s] = 0;
    for (const e of entries) byStatus[e.status] = (byStatus[e.status] || 0) + 1;

    const byKind = {};
    for (const e of entries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;

    const missingRequired = entries.filter((e) => e.status === 'missing' && e.requirement === 'required').length;
    const incompatible = entries.filter((e) => e.status === 'incompatible').length;
    const installPlan = entries.filter((e) => e.action === 'install').map((e) => e.id);
    const configurePlan = entries.filter((e) => e.action === 'configure').map((e) => e.id);
    const customizedWorkflows = entries.filter((e) => e.kind === 'workflow' && e.grade === 'customized').map((e) => e.id);

    // Hard invariant of Phase 1: resolver never plans destructive operations.
    for (const e of entries) {
        if (!ACTIONS.includes(e.action)) {
            throw new Error(`internal error: resolver produced a forbidden action "${e.action}"`);
        }
    }

    return {
        mode,
        label,
        profiles: list.map((m) => m.profile.id),
        environment_root: env.root || null,
        entries,
        sharing,
        hardware: summarizeHardware(env, list),
        summary: {
            by_status: byStatus,
            by_kind: byKind,
            missing_required: missingRequired,
            incompatible,
            blocking: missingRequired + incompatible,
            install_plan: installPlan,
            configure_plan: configurePlan,
            customized_workflows: customizedWorkflows,
        },
        warnings,
        safe_to_proceed: incompatible === 0 && (sharing ? sharing.can_share : true),
        destructive_operations: Object.freeze([]),
    };
}

function expectedRuntime(component, manifests) {
    if (component === 'comfyui') {
        const pins = manifests.map((m) => effectiveRuntimeConstraint(m, 'comfyui')).filter((c) => c.value);
        return pins.length > 0 ? Array.from(new Set(pins.map((p) => p.value))) : ['unknown (manifest basis=unknown)'];
    }
    if (component === 'torch') {
        const pins = manifests.map((m) => effectiveRuntimeConstraint(m, 'torch')).filter((c) => c.value);
        return pins.length > 0 ? Array.from(new Set(pins.map((p) => p.value))) : ['unknown (manifest basis=unknown)'];
    }
    const mins = manifests
        .map((m) => ((m.runtime_requirements || {})[component] || {}).minimum)
        .filter(Boolean);
    return mins.length > 0 ? [`>= ${mins.join(', >= ')}`] : ['unknown'];
}

function foundRuntime(component, env) {
    const probe = env[component];
    if (probe === undefined) return 'not probed';
    if (!probe) return 'absent';
    if (component === 'comfyui') {
        return { version: probe.version || probe.tag || null, commit: probe.commit || null, repository: probe.repository || null };
    }
    return { version: probe.version || null };
}

// ---------------------------------------------------------------------------
// Isolated mode (data model + interface; full implementation is later)
// ---------------------------------------------------------------------------

/**
 * Plan several isolated environments on one GPU machine.
 * Each assignment = one worker's own ComfyUI+venv root with its profile(s).
 * Phase 1: validates distinct roots and resolves each environment
 * independently; no cross-environment mutation is possible by design.
 *
 * @param {Array<{manifests: object|object[], environment: object, label?: string}>} assignments
 */
function planIsolatedEnvironments(assignments) {
    if (!Array.isArray(assignments) || assignments.length === 0) {
        throw new Error('planIsolatedEnvironments requires a non-empty assignments array');
    }
    const issues = [];
    const roots = new Set();
    assignments.forEach((a, i) => {
        const root = a.environment && a.environment.root;
        if (!root) {
            issues.push(`assignment[${i}] has no environment.root — isolated environments must have distinct roots`);
            return;
        }
        const key = normPath(root).toLowerCase();
        if (roots.has(key)) {
            issues.push(`assignment[${i}] reuses root "${root}" — isolated environments must not share a root`);
        }
        roots.add(key);
    });

    const environments = assignments.map((a) => resolveInstallation({
        manifests: a.manifests,
        environment: a.environment,
        mode: 'isolated',
        label: a.label || (a.environment && a.environment.root) || null,
    }));

    return {
        ok: issues.length === 0,
        issues,
        environments,
        machine_summary: {
            environments_total: environments.length,
            blocking_total: environments.reduce((s, r) => s + r.summary.blocking, 0),
        },
    };
}

module.exports = {
    RUNTIME_MODES,
    ENTRY_STATUSES,
    ACTIONS,
    SHARING_VERDICTS,
    SIZE_TOLERANCE,
    parseVersion,
    compareVersions,
    shaMatch,
    reposEqual,
    createEmptyEnvironment,
    unionDependencies,
    effectiveRuntimeConstraint,
    resolveSharedRuntime,
    resolveInstallation,
    planIsolatedEnvironments,
    checkWorkflow,
    checkWorker,
    checkTorchAgainst,
    summarizeHardware,
    CPU_ONLY_NOTE,
};
