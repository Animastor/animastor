// ======================================================
// Private Worker Setup Contract — projection unit tests (Phase 3)
// ======================================================
// Pure-logic coverage for backend/src/installer/setup-contract.js:
//
//   Profiles      — real manifests projected; hidden/internal not exposed
//   Methods       — Linux available (installer draft), Windows/Docker planned
//   Artifacts     — per-platform artifact model; unsupported platform → null
//   Workflows     — editable baselines, sha256, no secret leakage
//   Instructions  — dynamic per platform/mode; token placeholder only
//   Status        — adapter over ONLINE/OFFLINE/REVOKED (legacy unbroken)
//   Capabilities  — normalized passthrough, never invented
//   Plan          — Image/Video/Audio, managed/existing/shared/isolated,
//                   SHARED_COMPATIBLE / REQUIRES_ISOLATION, honest blocks
//   Checksums     — hub-resolved sha256; hub outage degrades to null

const { expect } = require('chai');
const path = require('path');

const sc = require('../src/installer/setup-contract');

const REAL_PROFILE_IDS = ['audio/qwen-tts', 'image/qwen-image', 'video/ltx-2.3'];

/** Synthetic manifest factory for registry-injection tests. */
function syntheticManifest(overrides = {}) {
    return {
        manifest_version: '1.0.0',
        revision: '2026.08.27-test',
        status: 'draft',
        profile: { id: 'image/test-profile', type: 'image', name: 'test-profile' },
        hardware: { gpu_min_vram_gb: 12, reference_gpu: 'NVIDIA TEST (12288 MiB)' },
        runtime_requirements: {
            comfyui: { policy: 'exact-pin-preferred', pin: null, basis: 'unknown' },
            python: { policy: 'minimum', minimum: '3.10', basis: 'minimum_supported' },
            torch: { policy: 'exact', pin: null, basis: 'unknown' },
            nodejs: { policy: 'minimum', minimum: '20', basis: 'minimum_supported' },
            nvidia_driver: { policy: 'reference-only', basis: 'environment_reference' },
        },
        dependencies: [
            {
                id: 'custom-node:test-node', kind: 'custom_node', name: 'Test-Node',
                requirement: 'required', basis: 'known_working',
                install: { directory: 'Test-Node', source: { kind: 'github', repository: 'https://github.com/test/node', commit: 'abc1234', verification: 'confirmed' } },
                provenance: { workflows: ['test-wf'] },
            },
            {
                id: 'model:test.model', kind: 'model', name: 'test-model.safetensors',
                filename: 'test-model.safetensors', target_dir: 'models/checkpoints',
                requirement: 'required', basis: 'known_working', size_bytes_approx: 1000,
                checksum: { algo: 'sha256', value: null },
                source: { kind: 'huggingface', repository: 'test/model', revision: 'main', file_path: 'test-model.safetensors', verification: 'confirmed' },
                provenance: { workflows: ['test-wf'] },
            },
        ],
        workflows: {
            policy: 'editable-baseline',
            baseline_dir: 'user/default/workflows/animastor',
            artifacts: [{
                id: 'workflow:test-wf', name: 'Test WF', filename: 'test-wf.json',
                requirement: 'required', basis: 'required', editable: true,
                target_dir: 'user/default/workflows/animastor/image',
                baseline_sha256: 'a'.repeat(64),
                source: { kind: 'animastor', repository_path: 'backend/ai/workflows/test-wf.json' },
                provenance: { workflows: ['test-wf'] },
            }],
        },
        worker_bundle: {
            basis: 'minimum_supported', worker_type: 'image', min_version: '2.0.0',
            files: ['worker.cjs', 'worker-cleanup.cjs', 'worker-cleanup-journal.cjs', 'package.json', 'package-lock.json', '.env.example'],
            env: {
                required: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'],
                secrets: ['ANIMASTOR_WORKER_TOKEN'],
            },
        },
        verification: { method: 'resolver-diff' },
        disk_budget: { models_bytes_approx: 1000 },
        ...overrides,
    };
}

function registryOf(manifests) {
    const map = {};
    for (const m of manifests) map[m.profile.id] = m;
    return {
        all: () => map,
        get: (id) => (Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null),
        invalidate: () => {},
    };
}

describe('Setup contract — projections (unit)', () => {
    // ══════════════════════════════════════════════════════════════════
    // Profiles
    // ══════════════════════════════════════════════════════════════════

    describe('profiles', () => {
        it('returns the supported profiles from canonical installer metadata', () => {
            const profiles = sc.listSetupProfiles();
            expect(profiles.map((p) => p.id).sort()).to.deep.equal(REAL_PROFILE_IDS);
            const image = profiles.find((p) => p.id === 'image/qwen-image');
            expect(image.name).to.equal('Qwen Image');
            expect(image.worker_type).to.equal('image');
            expect(image.status).to.equal('draft');
            expect(image.supported_install_modes).to.include.members(['managed', 'existing', 'shared', 'isolated']);
            expect(image.gpu.min_vram_gb).to.equal(null); // unknown — not invented
            expect(image.gpu.reference_gpu).to.be.a('string');
            expect(image.disk_budget_bytes_approx).to.be.a('number');
            expect(image.workflows).to.deep.equal(['img-qwen-image']);
            expect(image.dependencies_summary.models).to.equal(4);
            expect(image.dependencies_summary.custom_nodes).to.equal(1);
        });

        it('filters by worker type', () => {
            const audio = sc.listSetupProfiles({ type: 'audio' });
            expect(audio.map((p) => p.id)).to.deep.equal(['audio/qwen-tts']);
        });

        it('hidden/internal profiles are not exposed', () => {
            const registry = registryOf([
                syntheticManifest(),
                syntheticManifest({
                    status: 'internal',
                    profile: { id: 'image/secret-profile', type: 'image', name: 'secret-profile' },
                }),
            ]);
            const profiles = sc.listSetupProfiles({ registry });
            expect(profiles.map((p) => p.id)).to.deep.equal(['image/test-profile']);
            const workflows = sc.listWorkflowArtifacts({ registry });
            expect(workflows.map((w) => w.profile_id)).to.not.contain('image/secret-profile');
        });

        it('projection never leaks internal manifest details', () => {
            const json = JSON.stringify(sc.listSetupProfiles());
            expect(json).to.not.contain('provenance');
            expect(json).to.not.contain('repository_path');
            expect(json).to.not.contain('huggingface');
            expect(json).to.not.contain('todo');
            expect(json).to.not.contain('token');
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Installation methods & artifacts
    // ══════════════════════════════════════════════════════════════════

    describe('installation methods', () => {
        it('Linux: installer available (draft), uninstaller planned, bundle available', () => {
            const { methods } = sc.getInstallationMethods();
            const linux = methods.find((m) => m.platform === 'linux');
            expect(linux.installer.available).to.equal(true);
            expect(linux.installer.status).to.equal('draft');
            expect(linux.installer.version).to.equal(sc.INSTALLER_VERSION);
            expect(linux.installer.download_url).to.equal('/gpu/installer');
            expect(linux.installer.signature).to.equal(null);
            expect(linux.uninstaller.available).to.equal(false);
            expect(linux.uninstaller.status).to.equal('planned');
            expect(linux.worker_bundle.available).to.equal(true);
            expect(linux.worker_bundle.download_url).to.equal('/gpu/worker-bundle');
            expect(linux.worker_bundle.files).to.include('worker.cjs');
            expect(linux.supported_profiles.sort()).to.deep.equal(REAL_PROFILE_IDS);
            expect(linux.minimum_requirements.node).to.equal('20');
            expect(linux.minimum_requirements.python).to.equal('3.10');
        });

        it('Windows and Docker are schema-ready with status planned', () => {
            const { methods } = sc.getInstallationMethods();
            for (const platform of ['windows', 'docker']) {
                const m = methods.find((x) => x.platform === platform);
                expect(m.status).to.equal('planned');
                expect(m.installer.available).to.equal(false);
                expect(m.installer.status).to.equal('planned');
                expect(m.uninstaller.available).to.equal(false);
                expect(m.uninstaller.status).to.equal('planned');
                expect(m.worker_bundle.available).to.equal(false);
            }
        });

        it('no shell/file-format details leak into methods metadata', () => {
            const json = JSON.stringify(sc.getInstallationMethods());
            for (const needle of ['.sh', '.bat', '.exe', 'PowerShell', 'curl ', 'bash']) {
                expect(json).to.not.contain(needle);
            }
        });

        it('hub-resolved checksums are reflected when available', () => {
            const checksums = {
                worker_bundle: { sha256: 'b'.repeat(64), version: '2.0.0' },
                installer: { sha256: 'c'.repeat(64), version: sc.INSTALLER_VERSION },
            };
            const { methods } = sc.getInstallationMethods({ checksums });
            const linux = methods.find((m) => m.platform === 'linux');
            expect(linux.installer.sha256).to.equal('c'.repeat(64));
            expect(linux.worker_bundle.sha256).to.equal('b'.repeat(64));
        });
    });

    describe('platform artifacts', () => {
        it('returns the artifact model for linux', () => {
            const a = sc.getPlatformArtifacts({ platform: 'linux' });
            expect(a.platform).to.equal('linux');
            expect(a.architecture).to.equal('x86_64');
            expect(a.installer).to.have.property('sha256');
            expect(a.uninstaller).to.have.property('sha256');
            expect(a.worker_bundle).to.have.property('download_url');
        });

        it('unsupported platform → null (route answers 404)', () => {
            expect(sc.getPlatformArtifacts({ platform: 'amiga' })).to.equal(null);
        });
    });

    describe('resolveArtifactChecksums', () => {
        it('fetches sha256 from the hub sha256 endpoints', async () => {
            const seen = [];
            const fetchImpl = async (url) => {
                seen.push(url);
                return {
                    ok: true,
                    json: async () => ({ sha256: 'd'.repeat(64), version: '9.9.9', bytes: 42 }),
                };
            };
            const sums = await sc.resolveArtifactChecksums({ hubUrl: 'http://hub.test:5000', fetchImpl });
            expect(sums.worker_bundle.sha256).to.equal('d'.repeat(64));
            expect(sums.installer.sha256).to.equal('d'.repeat(64));
            expect(seen).to.include('http://hub.test:5000/worker-bundle/sha256');
            expect(seen).to.include('http://hub.test:5000/installer/sha256');
        });

        it('hub outage degrades to null (metadata endpoint never breaks)', async () => {
            const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
            const sums = await sc.resolveArtifactChecksums({ hubUrl: 'http://hub.test:5000', fetchImpl });
            expect(sums).to.deep.equal({ worker_bundle: null, installer: null });
            const noHub = await sc.resolveArtifactChecksums({ hubUrl: null });
            expect(noHub).to.deep.equal({ worker_bundle: null, installer: null });
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Workflows
    // ══════════════════════════════════════════════════════════════════

    describe('workflows', () => {
        it('baseline workflows are downloadable and editable', () => {
            const workflows = sc.listWorkflowArtifacts();
            expect(workflows.length).to.be.greaterThan(0);
            for (const wf of workflows) {
                expect(wf.baseline_available).to.equal(true);
                expect(wf.editable).to.equal(true); // never immutable
                expect(wf.download_url).to.match(/^\/gpu\/workflow\/[a-z0-9._-]+$/);
                expect(wf.profile_id).to.be.oneOf(REAL_PROFILE_IDS);
            }
            const image = workflows.find((w) => w.id === 'img-qwen-image');
            expect(image.sha256).to.match(/^[0-9a-f]{64}$/);
        });

        it('filters by profile and rejects no secrets', () => {
            const workflows = sc.listWorkflowArtifacts({ profileId: 'audio/qwen-tts' });
            expect(workflows.map((w) => w.id).sort()).to.deep.equal(['tts-qwen-dialogue', 'tts-qwen-narrator']);
            const json = JSON.stringify(workflows);
            expect(json).to.not.contain('token');
            expect(json).to.not.contain('repository_path');
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Instructions
    // ══════════════════════════════════════════════════════════════════

    describe('instructions', () => {
        it('linux/managed returns the full dynamic setup flow', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image'], platform: 'linux', mode: 'managed',
                origin: 'https://app.animastor.in',
            });
            expect(i.steps.map((s) => s.id)).to.deep.equal([
                'create-worker', 'download-installer', 'run-installer', 'verify',
            ]);
            const download = i.steps.find((s) => s.id === 'download-installer');
            expect(download.code).to.contain('https://app.animastor.in/gpu/installer');
            const run = i.steps.find((s) => s.id === 'run-installer');
            expect(run.code).to.contain('--profile image/qwen-image --mode managed');
        });

        it('linux/existing adds detection prerequisites and --mode existing', () => {
            const i = sc.buildInstructions({
                profileIds: ['audio/qwen-tts'], platform: 'linux', mode: 'existing',
            });
            expect(i.steps.map((s) => s.id)).to.contain('prerequisites');
            const prereq = i.steps.find((s) => s.id === 'prerequisites');
            expect(prereq.requirements.comfyui).to.be.a('string');
            expect(prereq.requirements.python).to.contain('3.10');
            expect(prereq.requirements.torch).to.contain('CUDA');
            const run = i.steps.find((s) => s.id === 'run-installer');
            expect(run.code).to.contain('--mode existing');
        });

        it('windows returns the planned flow without commands', () => {
            const i = sc.buildInstructions({ profileIds: ['image/qwen-image'], platform: 'windows', mode: 'managed' });
            expect(i.steps.map((s) => s.id)).to.deep.equal(['create-worker', 'platform-planned']);
            expect(JSON.stringify(i)).to.not.contain('curl');
        });

        it('multi-profile instructions use comma-separated profile ids; shared passes --mode shared', () => {
            const i = sc.buildInstructions({
                profileIds: ['audio/qwen-tts', 'image/qwen-image'], platform: 'linux', mode: 'shared',
            });
            const run = i.steps.find((s) => s.id === 'run-installer');
            expect(run.code).to.contain('--profile audio/qwen-tts,image/qwen-image');
            expect(run.code).to.contain('--mode shared');
        });

        it('isolated mode instructs one installer run per profile into distinct roots', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image', 'video/ltx-2.3'], platform: 'linux', mode: 'isolated',
            });
            const run = i.steps.find((s) => s.id === 'run-installer');
            expect(run.code).to.contain('--profile image/qwen-image');
            expect(run.code).to.contain('--profile video/ltx-2.3');
            expect(run.code).to.contain('isolated/qwen-image');
            expect(run.code).to.contain('isolated/ltx-2.3');
        });

        it('the Worker Key appears only as a placeholder — never a value', () => {
            const i = sc.buildInstructions({ profileIds: ['image/qwen-image'], platform: 'linux', mode: 'managed' });
            expect(i.env.template_block).to.contain('ANIMASTOR_WORKER_TOKEN=<your-worker-key>');
            expect(i.env.template_block).to.not.match(/wrk\.[A-Za-z0-9_-]{8,}/);
            expect(i.worker_key_policy.disclosed_once).to.equal(true);
            expect(i.worker_key_policy.disclosed_by).to.contain('POST /api/v1/workers');
        });

        it('invalid profile / platform / mode throw coded errors', () => {
            expect(() => sc.buildInstructions({ profileIds: ['nope/x'] })).to.throw(/unknown profile/);
            expect(() => sc.buildInstructions({ profileIds: [] })).to.throw(/profile_ids/);
            expect(() => sc.buildInstructions({ profileIds: ['image/qwen-image'], platform: 'solaris' })).to.throw(/unsupported platform/);
            expect(() => sc.buildInstructions({ profileIds: ['image/qwen-image'], mode: 'yolo' })).to.throw(/unsupported mode/);
            try { sc.buildInstructions({ profileIds: ['nope/x'] }); } catch (e) { expect(e.code).to.equal('invalid_profile'); }
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Worker status adapter & capabilities
    // ══════════════════════════════════════════════════════════════════

    describe('worker status adapter', () => {
        it('maps legacy states without breaking them', () => {
            expect(sc.adaptSetupStatus({ status: 'ONLINE' })).to.equal('ONLINE');
            expect(sc.adaptSetupStatus({ status: 'REVOKED' })).to.equal('REVOKED');
            expect(sc.adaptSetupStatus({ status: 'OFFLINE', last_seen: 1756000000000 })).to.equal('OFFLINE');
        });

        it('created but never seen → CONNECTING', () => {
            expect(sc.adaptSetupStatus({ status: 'OFFLINE', last_seen: null })).to.equal('CONNECTING');
        });

        it('status model is the documented superset', () => {
            expect(sc.SETUP_WORKER_STATUSES).to.deep.equal([
                'NOT_CONFIGURED', 'INSTALLING', 'CONNECTING', 'ONLINE', 'OFFLINE', 'ERROR', 'REVOKED',
            ]);
        });
    });

    describe('capabilities normalization', () => {
        it('normalizes real data (vram_mib → vram_gb)', () => {
            const caps = sc.normalizeCapabilities({
                profiles: ['image/qwen-image'],
                workflows: ['img-qwen-image'],
                gpu: { name: 'NVIDIA L40S', vram_mib: 46068 },
            });
            expect(caps.profiles).to.deep.equal(['image/qwen-image']);
            expect(caps.workflows).to.deep.equal(['img-qwen-image']);
            expect(caps.gpu).to.deep.equal({ name: 'NVIDIA L40S', vram_gb: 45 });
        });

        it('never invents data — empty/unknown input → null', () => {
            expect(sc.normalizeCapabilities(null)).to.equal(null);
            expect(sc.normalizeCapabilities({})).to.equal(null);
            expect(sc.normalizeCapabilities('junk')).to.equal(null);
            expect(sc.normalizeCapabilities({ unrelated: 1 })).to.equal(null);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // Installation plan
    // ══════════════════════════════════════════════════════════════════

    describe('installation plan', () => {
        it('image (managed): full action list, honest BLOCKED on unresearched model sources', () => {
            const plan = sc.buildSetupPlan({ profileIds: ['image/qwen-image'], mode: 'managed', platform: 'linux' });
            expect(plan.result).to.equal('BLOCKED');
            expect(plan.profiles).to.deep.equal(['image/qwen-image']);
            const types = plan.actions.map((a) => `${a.type}:${a.component}`);
            expect(types).to.include('INSTALL:runtime');
            expect(types).to.include('INSTALL:custom-node');
            expect(types).to.include('DOWNLOAD:model');
            expect(types).to.include('DOWNLOAD:workflow');
            expect(types).to.include('INSTALL:worker-bundle');
            expect(types).to.include('CONFIGURE:worker-env');
            expect(types).to.include('VERIFY:verification');
            expect(plan.blocks.length).to.be.greaterThan(0);
            for (const b of plan.blocks) expect(b.code).to.equal('MODEL_SOURCE_NOT_PUBLISHED');
            expect(plan.disk_budget_bytes_approx).to.be.a('number');
            expect(plan.sharing).to.equal(null);
        });

        it('video and audio plans compute too (draft manifests ⇒ blocked on sources)', () => {
            for (const id of ['video/ltx-2.3', 'audio/qwen-tts']) {
                const plan = sc.buildSetupPlan({ profileIds: [id], mode: 'managed', platform: 'linux' });
                expect(plan.result).to.be.oneOf(['READY', 'READY_WITH_WARNINGS', 'BLOCKED']);
                expect(plan.actions.length).to.be.greaterThan(0);
                expect(plan.profiles).to.deep.equal([id]);
            }
        });

        it('existing mode: actions are conditional (installer detects on the machine)', () => {
            const plan = sc.buildSetupPlan({ profileIds: ['image/qwen-image'], mode: 'existing', platform: 'linux' });
            const installActions = plan.actions.filter((a) => a.type === 'INSTALL' || a.type === 'DOWNLOAD');
            expect(installActions.length).to.be.greaterThan(0);
            for (const a of installActions) expect(a.conditional).to.equal(true);
            expect(plan.warnings.join(' ')).to.contain('detects');
        });

        it('shared-compatible profiles → SHARED_COMPATIBLE', () => {
            const plan = sc.buildSetupPlan({ profileIds: ['audio/qwen-tts', 'image/qwen-image'], mode: 'shared', platform: 'linux' });
            expect(plan.sharing).to.exist;
            expect(plan.sharing.verdict).to.equal('SHARED_COMPATIBLE');
            expect(plan.sharing.can_share).to.equal(true);
        });

        it('conflicting profiles → REQUIRES_ISOLATION', () => {
            const plan = sc.buildSetupPlan({ profileIds: ['image/qwen-image', 'video/ltx-2.3'], mode: 'shared', platform: 'linux' });
            expect(plan.sharing.verdict).to.equal('REQUIRES_ISOLATION');
            expect(plan.sharing.can_share).to.equal(false);
        });

        it('all three profiles → REQUIRES_ISOLATION (video conflicts)', () => {
            const plan = sc.buildSetupPlan({ profileIds: REAL_PROFILE_IDS, mode: 'shared', platform: 'linux' });
            expect(plan.sharing.verdict).to.equal('REQUIRES_ISOLATION');
        });

        it('isolated mode plans each profile in its own environment', () => {
            const plan = sc.buildSetupPlan({ profileIds: ['image/qwen-image', 'video/ltx-2.3'], mode: 'isolated', platform: 'linux' });
            expect(plan.mode).to.equal('isolated');
            expect(plan.sharing.verdict).to.equal('REQUIRES_ISOLATION');
            const imageActions = plan.actions.filter((a) => a.profiles.includes('image/qwen-image'));
            const videoActions = plan.actions.filter((a) => a.profiles.includes('video/ltx-2.3'));
            expect(imageActions.length).to.be.greaterThan(0);
            expect(videoActions.length).to.be.greaterThan(0);
        });

        it('shared mode with a single profile is rejected', () => {
            try {
                sc.buildSetupPlan({ profileIds: ['image/qwen-image'], mode: 'shared' });
                expect.fail('should throw');
            } catch (e) { expect(e.code).to.equal('invalid_mode'); }
        });

        it('windows platform → BLOCKED with PLATFORM_NOT_SUPPORTED', () => {
            const plan = sc.buildSetupPlan({ profileIds: ['image/qwen-image'], mode: 'managed', platform: 'windows' });
            expect(plan.result).to.equal('BLOCKED');
            expect(plan.blocks[0].code).to.equal('PLATFORM_NOT_SUPPORTED');
            expect(plan.actions).to.deep.equal([]);
        });

        it('unknown profile / invalid mode / invalid platform throw coded errors', () => {
            try { sc.buildSetupPlan({ profileIds: ['nope/x'], mode: 'managed' }); expect.fail('should throw'); }
            catch (e) { expect(e.code).to.equal('invalid_profile'); }
            try { sc.buildSetupPlan({ profileIds: ['image/qwen-image'], mode: 'bogus' }); expect.fail('should throw'); }
            catch (e) { expect(e.code).to.equal('invalid_mode'); }
            try { sc.buildSetupPlan({ profileIds: ['image/qwen-image'], mode: 'managed', platform: 'solaris' }); expect.fail('should throw'); }
            catch (e) { expect(e.code).to.equal('unsupported_platform'); }
        });

        it('synthetic profile with researched sources → READY_WITH_WARNINGS, no blocks', () => {
            const registry = registryOf([syntheticManifest()]);
            const plan = sc.buildSetupPlan({ profileIds: ['image/test-profile'], mode: 'managed', platform: 'linux', registry });
            expect(plan.blocks).to.deep.equal([]);
            expect(plan.result).to.equal('READY_WITH_WARNINGS'); // draft status + unknown torch/comfyui
            const download = plan.actions.find((a) => a.type === 'DOWNLOAD' && a.component === 'model');
            expect(download.blocked).to.equal(false);
        });

        it('plan never leaks secrets or internal resolver details', () => {
            const plan = sc.buildSetupPlan({ profileIds: REAL_PROFILE_IDS, mode: 'shared', platform: 'linux' });
            const json = JSON.stringify(plan);
            expect(json).to.not.match(/wrk\./);
            expect(json).to.not.contain('token_hash');
            expect(json).to.not.contain('ANIMASTOR_WORKER_TOKEN=wrk');
            expect(json).to.not.contain('huggingface.co'); // unresearched URLs never invented/exposed
        });
    });
});
