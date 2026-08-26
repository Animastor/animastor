'use strict';

/**
 * Canonical Install Manifest — loader & validator.
 *
 * Phase 1 of the Private Worker Installer architecture. This module is
 * read-only tooling: it is NOT loaded by the backend runtime, does not
 * touch workflows/connectors/GPU Hub/worker runtime, and performs no
 * installation.
 *
 * Manifest location: backend/ai/install-manifests/{type}/{profile}.json
 * (architecture draft §9; kept in a separate tree from prompt-assembly
 * profiles on purpose).
 *
 * Evidence taxonomy (per-entry `basis` field):
 *   required              — required by production workflows (workflow-derived)
 *   known_working         — verified present & working on a known working instance
 *   minimum_supported     — minimal admissible configuration, already justifiable
 *   optional              — not required; utility / "for growth"
 *   environment_reference — provider/image-specific reference info, never canonical
 *   unknown               — insufficient data; explicit TODO / separate check needed
 *
 * Key principle: runtime audits are reference/verification material only —
 * they are NEVER the source of truth. Production workflows are the single
 * source of `required`.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_SCHEMA_VERSION = '1.0.0';
const MANIFEST_ROOT = path.join(__dirname, '..', '..', 'ai', 'install-manifests');

const BASIS_VALUES = Object.freeze([
    'required',
    'known_working',
    'minimum_supported',
    'optional',
    'environment_reference',
    'unknown',
]);

const REQUIREMENT_VALUES = Object.freeze(['required', 'optional', 'unknown']);

const DEPENDENCY_KINDS = Object.freeze([
    'custom_node',
    'model',
    'model_repo',
    'python_package',
]);

const VERIFICATION_VALUES = Object.freeze(['confirmed', 'needs_verification', 'unknown']);

const RUNTIME_COMPONENTS = Object.freeze([
    'comfyui',
    'python',
    'torch',
    'nodejs',
    'nvidia_driver',
]);

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
}

/**
 * Validate a manifest object. Returns { valid, errors[], warnings[] }.
 * Errors block loading; warnings record honesty gaps (unknown sources,
 * TODOs) without blocking — a draft manifest is allowed to have them.
 */
function validateManifest(manifest) {
    const errors = [];
    const warnings = [];

    if (!isPlainObject(manifest)) {
        return { valid: false, errors: ['manifest must be an object'], warnings };
    }

    if (manifest.manifest_version !== MANIFEST_SCHEMA_VERSION) {
        errors.push(`manifest_version must be "${MANIFEST_SCHEMA_VERSION}" (got ${JSON.stringify(manifest.manifest_version)})`);
    }
    if (!isNonEmptyString(manifest.revision)) {
        errors.push('revision is required (non-empty string)');
    }

    const profile = manifest.profile;
    if (!isPlainObject(profile) || !isNonEmptyString(profile.id) || !isNonEmptyString(profile.type) || !isNonEmptyString(profile.name)) {
        errors.push('profile.{id,type,name} are required');
    } else if (profile.id !== `${profile.type}/${profile.name}`) {
        errors.push(`profile.id must equal "{type}/{name}" (got "${profile.id}")`);
    }

    const prov = manifest.provenance;
    if (!isPlainObject(prov) || !Array.isArray(prov.workflows) || prov.workflows.length === 0) {
        errors.push('provenance.workflows must be a non-empty array (workflows are the single source of "required")');
    }

    const rt = manifest.runtime_requirements;
    if (!isPlainObject(rt)) {
        errors.push('runtime_requirements is required');
    } else {
        for (const component of RUNTIME_COMPONENTS) {
            const spec = rt[component];
            if (!isPlainObject(spec)) {
                errors.push(`runtime_requirements.${component} is required`);
                continue;
            }
            if (!BASIS_VALUES.includes(spec.basis)) {
                errors.push(`runtime_requirements.${component}.basis must be one of ${BASIS_VALUES.join('|')}`);
            }
            if (component === 'comfyui' && !isNonEmptyString(spec.policy)) {
                errors.push('runtime_requirements.comfyui.policy is required');
            }
            if (component === 'comfyui' && spec.pin !== null && spec.pin !== undefined) {
                if (!isPlainObject(spec.pin) || !isNonEmptyString(spec.pin.repository)) {
                    errors.push('runtime_requirements.comfyui.pin must be null or {repository, tag|commit}');
                }
            }
            if (spec.basis === 'unknown' && !isNonEmptyString(spec.todo) && !(Array.isArray(spec.notes) && spec.notes.length > 0)) {
                warnings.push(`runtime_requirements.${component} has basis=unknown but no todo/notes explaining what must be checked`);
            }
        }
    }

    const deps = manifest.dependencies;
    if (!Array.isArray(deps)) {
        errors.push('dependencies must be an array');
    } else {
        const seenIds = new Set();
        deps.forEach((dep, i) => {
            const where = `dependencies[${i}]`;
            if (!isPlainObject(dep)) {
                errors.push(`${where} must be an object`);
                return;
            }
            if (!isNonEmptyString(dep.id)) errors.push(`${where}.id is required`);
            else if (seenIds.has(dep.id)) errors.push(`${where}.id "${dep.id}" is duplicated`);
            else seenIds.add(dep.id);

            if (!DEPENDENCY_KINDS.includes(dep.kind)) {
                errors.push(`${where}.kind must be one of ${DEPENDENCY_KINDS.join('|')}`);
            }
            if (!REQUIREMENT_VALUES.includes(dep.requirement)) {
                errors.push(`${where}.requirement must be one of ${REQUIREMENT_VALUES.join('|')}`);
            }
            if (!BASIS_VALUES.includes(dep.basis)) {
                errors.push(`${where}.basis must be one of ${BASIS_VALUES.join('|')}`);
            }

            if (dep.requirement === 'required' && !isPlainObject(dep.provenance)) {
                errors.push(`${where}.provenance is required for requirement=required`);
            } else if (dep.requirement === 'required' && isPlainObject(dep.provenance)
                && (!Array.isArray(dep.provenance.workflows) || dep.provenance.workflows.length === 0)) {
                errors.push(`${where}.provenance.workflows must be non-empty for requirement=required (workflows are the source of "required")`);
            }

            if (dep.kind === 'model' && !isNonEmptyString(dep.filename)) {
                errors.push(`${where}.filename is required for kind=model`);
            }
            if ((dep.kind === 'model' || dep.kind === 'model_repo') && !isNonEmptyString(dep.target_dir)) {
                errors.push(`${where}.target_dir is required for kind=${dep.kind}`);
            }
            if (dep.kind === 'custom_node' && isPlainObject(dep.install) && isPlainObject(dep.install.source)) {
                const src = dep.install.source;
                if (src.verification && !VERIFICATION_VALUES.includes(src.verification)) {
                    errors.push(`${where}.install.source.verification must be one of ${VERIFICATION_VALUES.join('|')}`);
                }
                if (src.verification !== 'confirmed') {
                    warnings.push(`${where} (${dep.id}): source verification is "${src.verification || 'unset'}" — needs research before the manifest can become stable`);
                }
            }
            if (dep.kind === 'model' && isPlainObject(dep.source) && dep.source.verification !== 'confirmed') {
                warnings.push(`${where} (${dep.id}): download source is "${dep.source.verification || 'unset'}" — D5 research required`);
            }
        });
    }

    if (!isPlainObject(manifest.worker_bundle)) {
        errors.push('worker_bundle is required');
    } else {
        const wb = manifest.worker_bundle;
        if (!isNonEmptyString(wb.min_version)) errors.push('worker_bundle.min_version is required');
        if (!Array.isArray(wb.files) || wb.files.length === 0) errors.push('worker_bundle.files must be a non-empty array');
        if (!isPlainObject(wb.env) || !Array.isArray(wb.env.required) || wb.env.required.length === 0) {
            errors.push('worker_bundle.env.required must be a non-empty array');
        }
    }

    if (!isPlainObject(manifest.verification)) {
        errors.push('verification section is required');
    }

    if (manifest.environment_reference !== undefined) {
        if (!Array.isArray(manifest.environment_reference)) {
            errors.push('environment_reference must be an array');
        } else {
            manifest.environment_reference.forEach((ref, i) => {
                if (!isPlainObject(ref) || !isNonEmptyString(ref.provider) || !isNonEmptyString(ref.audit)) {
                    errors.push(`environment_reference[${i}] must contain provider and audit reference`);
                } else if (!isNonEmptyString(ref.disclaimer)) {
                    warnings.push(`environment_reference[${i}] has no disclaimer — reference environments must be explicitly marked as non-canonical`);
                }
            });
        }
    }

    return { valid: errors.length === 0, errors, warnings };
}

function manifestPath(profileId) {
    return path.join(MANIFEST_ROOT, `${profileId}.json`);
}

/**
 * Load + validate a manifest by profile id (e.g. "audio/qwen-tts").
 * Throws on missing file or validation errors. Warnings are attached to the
 * returned object as `manifest._validation`.
 */
function loadManifest(profileId, opts = {}) {
    const file = manifestPath(profileId);
    if (!fs.existsSync(file)) {
        throw new Error(`Install manifest not found for profile "${profileId}" (${file})`);
    }
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`Install manifest for "${profileId}" is not valid JSON: ${err.message}`);
    }
    const validation = validateManifest(manifest);
    if (!validation.valid && !opts.skipValidation) {
        throw new Error(`Install manifest for "${profileId}" failed validation:\n  - ${validation.errors.join('\n  - ')}`);
    }
    Object.defineProperty(manifest, '_validation', { value: validation, enumerable: false });
    return manifest;
}

/**
 * Load all manifests under MANIFEST_ROOT. Returns a map keyed by profile id.
 */
function loadAllManifests(opts = {}) {
    const result = {};
    if (!fs.existsSync(MANIFEST_ROOT)) return result;
    for (const type of fs.readdirSync(MANIFEST_ROOT).sort()) {
        const typeDir = path.join(MANIFEST_ROOT, type);
        if (!fs.statSync(typeDir).isDirectory()) continue;
        for (const file of fs.readdirSync(typeDir).sort()) {
            if (!file.endsWith('.json')) continue;
            const profileId = `${type}/${path.basename(file, '.json')}`;
            result[profileId] = loadManifest(profileId, opts);
        }
    }
    return result;
}

module.exports = {
    MANIFEST_SCHEMA_VERSION,
    MANIFEST_ROOT,
    BASIS_VALUES,
    REQUIREMENT_VALUES,
    DEPENDENCY_KINDS,
    VERIFICATION_VALUES,
    RUNTIME_COMPONENTS,
    validateManifest,
    manifestPath,
    loadManifest,
    loadAllManifests,
};
