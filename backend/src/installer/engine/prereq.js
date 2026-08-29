'use strict';

/**
 * Host prerequisite checks — run BEFORE any heavy installer mutation
 * (venv creation, ComfyUI clone, multi-GB model downloads).
 *
 * Detects the Debian/Ubuntu failure mode where `python3 -m venv` fails
 * because `ensurepip` is unavailable (python3.X-venv not installed) and
 * produces a precise remediation command for the detected Python version.
 *
 * Detection strategy: the RELIABLE check on Debian/Ubuntu is creating a
 * throwaway venv — `python3 -m ensurepip` is deliberately disabled for the
 * system python there, so a cheap module check would produce false failures
 * on healthy hosts. The probe venv is created under a fixed temp root and
 * always cleaned up.
 *
 * "Inconclusive" semantics: when the venv command reports success but the
 * probe directory did not materialize (mocked io in tests), the check
 * passes without a deep verdict — the runtime step itself re-validates the
 * real venv afterwards.
 */

const path = require('path');

/**
 * Structured prerequisite failure. Carries the host package and the exact
 * remediation command so CLI/engine can print a short, actionable message.
 */
class PrerequisiteError extends Error {
    /**
     * @param {object} args { code, message, summary, hostPackage, remediationCommand }
     */
    constructor({ code, message, summary, hostPackage = null, remediationCommand = null }) {
        super(message);
        this.name = 'PrerequisiteError';
        this.code = code;
        this.summary = summary || message;
        this.hostPackage = hostPackage;
        this.remediationCommand = remediationCommand;
    }

    /** Render the short user-facing remediation block (requirement: 4 lines). */
    remediationLines() {
        return renderRemediation(this);
    }
}

/** Debian/Ubuntu venv package name for a Python version, e.g. "3.10.12" → "python3.10-venv". */
function debianVenvPackage(pythonVersion) {
    const m = /(\d+)\.(\d+)/.exec(String(pythonVersion || ''));
    return m ? `python${m[1]}.${m[2]}-venv` : 'python3-venv';
}

function aptCommand(pkg) {
    return `sudo apt install ${pkg}`;
}

/**
 * Classify a failed `python3 -m venv` run.
 * @returns {{ code, summary, hostPackage, remediationCommand }}
 */
function classifyVenvCreateFailure(output, pythonVersion = null) {
    const text = String(output || '');
    if (/ensurepip is not available|python3(\.\d+)?-venv|ensurepip/i.test(text)) {
        const pkg = debianVenvPackage(pythonVersion);
        return {
            code: 'MISSING_VENV_PACKAGE',
            summary: 'the Python venv prerequisite is missing',
            hostPackage: pkg,
            remediationCommand: aptCommand(pkg),
        };
    }
    const pkg = debianVenvPackage(pythonVersion);
    return {
        code: 'VENV_CREATE_FAILED',
        summary: 'the Python venv could not be created on this host',
        hostPackage: pkg,
        remediationCommand: aptCommand(pkg),
    };
}

/** Build the remediation payload stored on the engine result. */
function remediationPayload(failure) {
    return {
        code: failure.code,
        summary: failure.summary,
        package: (failure.remediation && failure.remediation.package) || failure.hostPackage || null,
        command: (failure.remediation && failure.remediation.command) || failure.remediationCommand || null,
    };
}

/** Render the short user-facing remediation block for a failure object. */
function renderRemediation(failure) {
    const lines = [];
    lines.push(`Installation stopped because ${failure.summary || 'a host prerequisite is missing'}.`);
    const pkg = (failure.remediation && failure.remediation.package) || failure.hostPackage;
    const cmd = (failure.remediation && failure.remediation.command) || failure.remediationCommand;
    if (pkg) lines.push(`Required host package: ${pkg}`);
    if (cmd) lines.push(`Install it with: ${cmd}`);
    lines.push('Then re-run the installer.');
    return lines;
}

/**
 * Classify an existing venv directory WITHOUT mutating it.
 * @returns {{ state: 'missing'|'incomplete'|'has-python', reason?: string }}
 */
function classifyVenvDir(io, venvDir) {
    if (!io.fs.existsSync(venvDir)) return { state: 'missing' };
    const py = path.join(venvDir, 'bin', 'python');
    if (!io.fs.existsSync(py)) {
        return { state: 'incomplete', reason: `directory exists but ${py} is missing (broken/incomplete venv)` };
    }
    return { state: 'has-python' };
}

/**
 * Probe python3 and (deep) the actual ability to create a working venv with
 * a functioning pip — BEFORE any real mutation.
 *
 * @param {object} io io adapter
 * @param {object} opts { python = 'python3', tmpRoot = null, deep = true,
 *                        existingVenvDir = null }
 *   existingVenvDir: when a working venv already exists at the install
 *   target, nothing will need to CREATE a venv — its working pip satisfies
 *   the prerequisite without probing host venv creation.
 * @returns {{ ok: true, python_version, deep_checked, existing_venv_usable? } |
 *           { ok: false, failure: { code, summary, message, remediation: { package, command } } }}
 */
function checkPythonPrerequisites(io, opts = {}) {
    const { python = 'python3', tmpRoot = null, deep = true, existingVenvDir = null } = opts;
    const os = require('os');

    const versionRes = io.exec(python, ['--version']);
    if (versionRes.code !== 0) {
        return {
            ok: false,
            failure: {
                code: 'NO_PYTHON',
                summary: 'Python 3 is not available on this host',
                message: `${python} is not usable (code ${versionRes.code})`,
                remediation: { package: 'python3', command: aptCommand('python3') },
            },
        };
    }
    const versionMatch = /Python\s+([0-9][0-9.]*)/.exec(String(versionRes.stdout) + String(versionRes.stderr));
    const pythonVersion = versionMatch ? versionMatch[1] : null;

    // A working existing venv at the target makes venv-creation capability
    // irrelevant (the installer reuses it as-is).
    if (existingVenvDir) {
        const cls = classifyVenvDir(io, existingVenvDir);
        if (cls.state === 'has-python') {
            const existingPy = path.join(existingVenvDir, 'bin', 'python');
            const pipCheck = io.exec(existingPy, ['-m', 'pip', '--version']);
            if (pipCheck.code === 0) {
                return { ok: true, python_version: pythonVersion, deep_checked: false, existing_venv_usable: true };
            }
        }
    }

    if (!deep) {
        return { ok: true, python_version: pythonVersion, deep_checked: false };
    }

    const root = tmpRoot || path.join(os.tmpdir(), 'animastor-installer-prereq');
    const probeVenv = path.join(root, 'venv');

    const cleanup = () => {
        try { if (io.fs.existsSync(root)) io.fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    };
    cleanup();

    const created = io.exec(python, ['-m', 'venv', probeVenv]);
    if (created.code !== 0) {
        cleanup();
        const f = classifyVenvCreateFailure(String(created.stderr || created.stdout || created.error || ''), pythonVersion);
        return {
            ok: false,
            failure: {
                code: f.code,
                summary: f.summary,
                message: `python3 -m venv probe failed (code ${created.code}): ${String(created.stderr || created.stdout || '').slice(-400)}`,
                remediation: { package: f.hostPackage, command: f.remediationCommand },
            },
        };
    }

    if (!io.fs.existsSync(probeVenv)) {
        // Success reported but nothing materialized (mocked io) — inconclusive.
        return { ok: true, python_version: pythonVersion, deep_checked: false };
    }

    const probePy = path.join(probeVenv, 'bin', 'python');
    if (!io.fs.existsSync(probePy)) {
        cleanup();
        const pkg = debianVenvPackage(pythonVersion);
        return {
            ok: false,
            failure: {
                code: 'VENV_INCOMPLETE',
                summary: 'the Python venv prerequisite is missing (venv was created without a usable python)',
                message: `venv probe produced no interpreter at ${probePy}`,
                remediation: { package: pkg, command: aptCommand(pkg) },
            },
        };
    }

    const pipCheck = io.exec(probePy, ['-m', 'pip', '--version']);
    if (pipCheck.code !== 0) {
        const boot = io.exec(probePy, ['-m', 'ensurepip', '--upgrade']);
        cleanup();
        if (boot.code !== 0) {
            const pkg = debianVenvPackage(pythonVersion);
            return {
                ok: false,
                failure: {
                    code: 'MISSING_ENSUREPIP',
                    summary: 'the Python venv prerequisite is missing (venv has neither pip nor ensurepip)',
                    message: `probe venv has no pip and ensurepip failed (code ${boot.code}): ${String(boot.stderr || boot.stdout || '').slice(-400)}`,
                    remediation: { package: pkg, command: aptCommand(pkg) },
                },
            };
        }
    }

    cleanup();
    return { ok: true, python_version: pythonVersion, deep_checked: true };
}

// ---------------------------------------------------------------------------
// Ownership guard — sudo vs. normal user mixing
// ---------------------------------------------------------------------------

/** Current uid (null when unavailable, e.g. Windows). */
function currentUid() {
    try {
        return typeof process !== 'undefined' && typeof process.getuid === 'function' ? process.getuid() : null;
    } catch (_) {
        return null;
    }
}

/** Current user's home directory. */
function currentHome() {
    try {
        return (process.env && process.env.HOME) || require('os').homedir();
    } catch (_) {
        return null;
    }
}

function statUid(io, p) {
    try {
        const st = io.fs.statSync(p);
        return typeof st.uid === 'number' ? st.uid : null;
    } catch (_) {
        return undefined; // absent
    }
}

function pathInsideHome(p, home) {
    if (!home) return false;
    const h = path.resolve(home);
    const r = path.resolve(p);
    return r === h || r.startsWith(h + path.sep);
}

/**
 * Detect ownership mixing that would lock a normal user out of their own
 * home directory (the "ran it once, then re-ran with sudo" scenario).
 *
 * Violations:
 *   - root (uid 0) operating on paths (or their nearest existing ancestor)
 *     owned by a non-root user → would create root-owned files inside the
 *     user's home;
 *   - a non-root user operating on paths owned by a DIFFERENT uid;
 *   - the install state was created by another uid (resume after UID change).
 *
 * When uid information is unavailable (mocked/memory fs), the check passes —
 * the runtime step re-validates the real venv afterwards.
 *
 * @returns {{ ok: boolean, violations: Array<{ path, kind, owner_uid?, message }> }}
 */
function checkOwnership(io, { paths = [], home = null, currentUid: uidInput = null, stateUid = null } = {}) {
    const uid = uidInput !== null && uidInput !== undefined ? uidInput : currentUid();
    const violations = [];

    if (uid === null || uid === undefined) return { ok: true, violations };

    const describeOwner = (ownerUid) => (ownerUid === 0 ? 'root' : `uid ${ownerUid}`);

    const checkPath = (p) => {
        if (!p) return;
        let abs = null;
        try { abs = path.resolve(p); } catch (_) { return; }

        const owner = statUid(io, abs);
        if (owner === null) return; // uid info unavailable — cannot judge
        if (owner !== undefined) {
            if (uid === 0 && owner !== 0) {
                violations.push({
                    path: abs,
                    kind: 'root-over-user-files',
                    owner_uid: owner,
                    message: `${abs} is owned by ${describeOwner(owner)} but the installer is running as root (sudo). `
                        + 'Continuing would create root-owned files inside the user\'s home and lock the normal user out of their installation. '
                        + 'Re-run as the owning user (e.g. `sudo -u $(stat -c %U ' + abs + ') ...`) or fix ownership first.',
                });
            } else if (uid !== 0 && owner !== uid) {
                violations.push({
                    path: abs,
                    kind: 'foreign-user-files',
                    owner_uid: owner,
                    message: `${abs} is owned by ${describeOwner(owner)} but you are running as ${describeOwner(uid)} — the installer will not mix ownership in one installation.`,
                });
            }
            return;
        }
        // path absent — check the nearest existing ancestor
        let parent = path.dirname(abs);
        while (parent && parent !== path.dirname(parent)) {
            const parentOwner = statUid(io, parent);
            if (parentOwner === null) return; // no uid info anywhere — pass
            if (parentOwner !== undefined) {
                if (uid === 0 && parentOwner !== 0) {
                    const where = pathInsideHome(abs, home) ? " (inside the user's home directory)" : '';
                    violations.push({
                        path: abs,
                        kind: 'root-into-user-home',
                        owner_uid: parentOwner,
                        message: `Running as root would create root-owned files under ${abs}, which lives inside ${describeOwner(parentOwner)}-owned ${parent}${where}. `
                            + 'Re-run the installer as the owning user instead of sudo.',
                    });
                }
                return;
            }
            parent = path.dirname(parent);
        }
    };

    for (const p of paths) checkPath(p);

    if (stateUid !== null && stateUid !== undefined && stateUid !== uid) {
        violations.push({
            path: null,
            kind: 'state-owned-by-other-uid',
            owner_uid: stateUid,
            message: `The installation state was created by ${describeOwner(stateUid)} but the current process runs as ${describeOwner(uid)} — `
                + 'resuming under a different uid would mix ownership. Run the installer as the original user (or clean up and reinstall).',
        });
    }

    return { ok: violations.length === 0, violations };
}

module.exports = {
    PrerequisiteError,
    debianVenvPackage,
    classifyVenvCreateFailure,
    classifyVenvDir,
    remediationPayload,
    renderRemediation,
    checkPythonPrerequisites,
    checkOwnership,
    currentUid,
    currentHome,
};
