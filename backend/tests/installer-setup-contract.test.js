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
            expect(image.status).to.equal('ready');
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
        const PROBE_OK = {
            installer: { available: true, status: 'available', version: null, sha256: 'c'.repeat(64) },
            worker_bundle: { available: true, status: 'available', version: null, sha256: 'b'.repeat(64) },
        };

        it('Linux: installer available (draft) only when the hub actually serves it', () => {
            const { methods } = sc.getInstallationMethods({ probe: PROBE_OK });
            const linux = methods.find((m) => m.platform === 'linux');
            expect(linux.installer.available).to.equal(true);
            expect(linux.installer.status).to.equal('draft');
            expect(linux.installer.download_url).to.equal('/gpu/installer');
            expect(linux.installer.sha256).to.equal('c'.repeat(64));
            expect(linux.installer.signature).to.equal(null);
            expect(linux.worker_bundle.available).to.equal(true);
            expect(linux.worker_bundle.download_url).to.equal('/gpu/worker-bundle');
            expect(linux.worker_bundle.sha256).to.equal('b'.repeat(64));
            expect(linux.worker_bundle.files).to.include('worker.cjs');
            expect(linux.uninstaller.available).to.equal(false);
            expect(linux.uninstaller.status).to.equal('planned');
            expect(linux.uninstaller.download_url).to.equal(null);
            expect(linux.supported_profiles.sort()).to.deep.equal(REAL_PROFILE_IDS);
            expect(linux.minimum_requirements.node).to.equal('20');
            expect(linux.minimum_requirements.python).to.equal('3.10');
        });

        it('hub not serving the artifacts → available=false, NO fake download URLs', () => {
            const { methods } = sc.getInstallationMethods(); // no probe
            const linux = methods.find((m) => m.platform === 'linux');
            expect(linux.status).to.equal('unavailable');
            expect(linux.installer.available).to.equal(false);
            expect(linux.installer.status).to.equal('unavailable');
            expect(linux.installer.download_url).to.equal(null);
            expect(linux.installer.sha256).to.equal(null);
            expect(linux.worker_bundle.available).to.equal(false);
            expect(linux.worker_bundle.download_url).to.equal(null);
            // the canonical version is still real metadata (repo source)
            expect(linux.installer.version).to.equal(sc.getInstallerVersion());
        });

        it('capability independence: installer down + bundle served → linux stays available', () => {
            const { methods } = sc.getInstallationMethods({
                probe: {
                    installer: { available: false, status: 'unavailable', version: null, sha256: null },
                    worker_bundle: { available: true, status: 'available', version: '2.0.0', sha256: 'b'.repeat(64) },
                },
            });
            const linux = methods.find((m) => m.platform === 'linux');
            // one missing artifact must NOT block the whole platform
            expect(linux.status).to.equal('available');
            expect(linux.installer.available).to.equal(false);
            expect(linux.installer.status).to.equal('unavailable');
            expect(linux.installer.download_url).to.equal(null); // no fake URL
            expect(linux.worker_bundle.available).to.equal(true);
            expect(linux.worker_bundle.status).to.equal('available');
            expect(linux.worker_bundle.download_url).to.equal('/gpu/worker-bundle');
            expect(linux.worker_bundle.sha256).to.equal('b'.repeat(64));
        });

        it('capability independence: installer served + bundle down → linux available, bundle honest', () => {
            const { methods } = sc.getInstallationMethods({
                probe: {
                    installer: { available: true, status: 'available', version: '1.0.0', sha256: 'c'.repeat(64) },
                    worker_bundle: { available: false, status: 'unavailable', version: null, sha256: null },
                },
            });
            const linux = methods.find((m) => m.platform === 'linux');
            expect(linux.status).to.equal('available');
            expect(linux.installer.available).to.equal(true);
            expect(linux.worker_bundle.available).to.equal(false);
            expect(linux.worker_bundle.download_url).to.equal(null);
        });

        it('Windows and Docker mirror the hub artifact availability (capability levels live in deploymentCapabilities)', () => {
            const { methods } = sc.getInstallationMethods({ probe: PROBE_OK });
            for (const platform of ['windows', 'docker']) {
                const m = methods.find((x) => x.platform === platform);
                expect(m.status).to.equal('available');
                expect(m.installer.available).to.equal(true);
                expect(m.installer.status).to.equal('draft');
                expect(m.installer.version).to.equal(sc.getInstallerVersion());
                expect(m.uninstaller.available).to.equal(false);
                expect(m.uninstaller.status).to.equal('planned');
                expect(m.worker_bundle.available).to.equal(true);
            }
            expect(methods.find((x) => x.platform === 'docker').deployment_of).to.equal('linux');
            // hub down → everything degrades honestly, no fake availability
            const down = sc.getInstallationMethods({ probe: null }).methods;
            for (const platform of ['linux', 'windows', 'docker']) {
                const m = down.find((x) => x.platform === platform);
                expect(m.status).to.equal('unavailable');
                expect(m.installer.available).to.equal(false);
            }
        });

        it('deployment capabilities: the full Platform × Deployment matrix with honest availability', () => {
            const caps = sc.deploymentCapabilities();
            expect(caps.map((c) => `${c.platform}:${c.deployment}`)).to.deep.equal([
                'linux:native', 'linux:docker', 'windows:native', 'windows:docker',
            ]);
            const byKey = Object.fromEntries(caps.map((c) => [`${c.platform}:${c.deployment}`, c]));
            expect(byKey['linux:native']).to.include({ allowed: true, availability: 'stable', notice: null });
            expect(byKey['windows:native']).to.include({ allowed: true, availability: 'preview' });
            expect(byKey['windows:native'].notice).to.contain('Preview');
            expect(byKey['linux:docker']).to.include({ allowed: true, availability: 'experimental' });
            expect(byKey['linux:docker'].notice).to.contain('Experimental');
            expect(byKey['windows:docker']).to.include({ allowed: false, availability: null, reason: 'unsupported_combination' });
            for (const c of caps) if (c.allowed) expect(sc.AVAILABILITY_LEVELS).to.include(c.availability);
        });

        it('capability levels are derived from the real installer adapter flags (single source of truth)', () => {
            const linux = require('../src/installer/platform/linux');
            const windows = require('../src/installer/platform/windows');
            const native = require('../src/installer/platform/deployment/native');
            const docker = require('../src/installer/platform/deployment/docker');
            expect(linux.productionReady && native.productionReady).to.equal(true);
            expect(windows.productionReady).to.equal(false);   // → preview
            expect(docker.productionReady).to.equal(false);    // → experimental
            expect(docker.experimental).to.equal(true);
            // flipping an adapter flag must move the capability level — the
            // contract and the installer can never disagree
            expect(sc.deploymentCapabilities().find((c) => c.platform === 'windows' && c.deployment === 'native').availability)
                .to.equal(windows.productionReady ? 'stable' : 'preview');
        });

        it('resolveDeploymentTarget: legacy docker platform, coded rejections', () => {
            const legacy = sc.resolveDeploymentTarget({ platform: 'docker' });
            expect(legacy).to.include({ platform: 'linux', deployment: 'docker' });
            expect(legacy.capability.availability).to.equal('experimental');
            try { sc.resolveDeploymentTarget({ platform: 'windows', deployment: 'docker' }); expect.fail('should throw'); }
            catch (e) { expect(e.code).to.equal('unsupported_combination'); }
            try { sc.resolveDeploymentTarget({ platform: 'linux', deployment: 'k8s' }); expect.fail('should throw'); }
            catch (e) { expect(e.code).to.equal('invalid_deployment'); }
            try { sc.resolveDeploymentTarget({ platform: 'solaris' }); expect.fail('should throw'); }
            catch (e) { expect(e.code).to.equal('unsupported_platform'); }
        });

        it('no shell/file-format details leak into methods metadata', () => {
            const json = JSON.stringify(sc.getInstallationMethods({ probe: PROBE_OK }));
            for (const needle of ['.sh', '.bat', '.exe', 'PowerShell', 'curl ', 'bash']) {
                expect(json).to.not.contain(needle);
            }
        });
    });

    describe('versions — single source of truth', () => {
        it('installer version is read from the canonical installer package.json', () => {
            const canonical = require('../src/installer/package.json');
            expect(sc.getInstallerVersion()).to.equal(canonical.version);
            expect(sc.getInstallerVersion()).to.match(/^\d+\.\d+\.\d+$/);
        });

        it('worker bundle version is read from the canonical worker package.json', () => {
            const canonical = require('../../worker/worker/package.json');
            expect(sc.getWorkerBundleVersion()).to.equal(canonical.version);
        });

        it('probe-provided versions take precedence (the hub is the artifact authority)', () => {
            const { methods } = sc.getInstallationMethods({
                probe: {
                    installer: { available: true, status: 'available', version: '9.9.9', sha256: 'c'.repeat(64) },
                    worker_bundle: { available: true, status: 'available', version: '8.8.8', sha256: 'b'.repeat(64) },
                },
            });
            const linux = methods.find((m) => m.platform === 'linux');
            expect(linux.installer.version).to.equal('9.9.9');
            expect(linux.worker_bundle.version).to.equal('8.8.8');
        });

        it('setup-contract.js contains no manually duplicated version literals', () => {
            const src = require('fs').readFileSync(
                require('path').join(__dirname, '..', 'src', 'installer', 'setup-contract.js'), 'utf8'
            );
            // The old hardcoded constants must stay gone.
            expect(src).to.not.contain("INSTALLER_VERSION = '");
            expect(src).to.not.contain("WORKER_BUNDLE_VERSION = '");
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

    // Phase 3.1 §6 — every public response shape is validated field-by-field
    // and must not leak internals (tokens, hashes, resolver internals,
    // server filesystem paths).
    describe('public contract schema validation', () => {
        const PROBE_OK = {
            installer: { available: true, status: 'available', version: '1.0.0', sha256: 'c'.repeat(64) },
            worker_bundle: { available: true, status: 'available', version: '2.0.0', sha256: 'b'.repeat(64) },
        };
        const ARTIFACT_KEYS = ['available', 'status', 'version', 'download_url', 'sha256'];

        function assertArtifactShape(a) {
            for (const k of ARTIFACT_KEYS) expect(a, `artifact key ${k}`).to.have.property(k);
            expect(a.available).to.be.a('boolean');
            expect(a.status).to.be.a('string');
            if (a.available) {
                expect(a.download_url).to.match(/^\/gpu\//);
            } else {
                expect(a.download_url).to.equal(null); // no fake URLs
            }
        }

        it('profiles schema', () => {
            const profiles = sc.listSetupProfiles();
            expect(profiles).to.be.an('array').and.not.empty;
            for (const p of profiles) {
                expect(p.id).to.match(/^(audio|image|video)\/[a-z0-9._-]+$/);
                expect(p.name).to.be.a('string').and.not.empty;
                expect(p.worker_type).to.be.oneOf(['audio', 'image', 'video']);
                expect(p.status).to.be.oneOf(['draft', 'stable', 'planned', 'ready']);
                expect(p.description).to.be.a('string');
                expect(p.supported_install_modes).to.be.an('array').and.not.empty;
                expect(p.gpu.min_vram_gb === null || typeof p.gpu.min_vram_gb === 'number').to.equal(true);
                expect(p.disk_budget_bytes_approx).to.be.a('number');
                expect(p.workflows).to.be.an('array');
                expect(p.dependencies_summary).to.be.an('object');
            }
        });

        it('installation methods schema', () => {
            const { methods } = sc.getInstallationMethods({ probe: PROBE_OK });
            expect(methods.map((m) => m.platform)).to.deep.equal(['linux', 'windows', 'docker']);
            for (const m of methods) {
                expect(m.status).to.be.oneOf(['available', 'unavailable', 'planned']);
                assertArtifactShape(m.installer);
                assertArtifactShape(m.uninstaller);
                assertArtifactShape(m.worker_bundle);
                expect(m.supported_profiles).to.be.an('array');
            }
        });

        it('platform artifacts schema', () => {
            const a = sc.getPlatformArtifacts({ platform: 'linux', probe: PROBE_OK });
            expect(a.platform).to.equal('linux');
            assertArtifactShape(a.installer);
            assertArtifactShape(a.uninstaller);
            assertArtifactShape(a.worker_bundle);
        });

        it('workflows schema', () => {
            for (const wf of sc.listWorkflowArtifacts()) {
                expect(wf.id).to.match(/^[a-z0-9._-]+$/);
                expect(wf.name).to.be.a('string').and.not.empty;
                expect(wf.profile_id).to.be.a('string');
                expect(wf.baseline_available).to.be.a('boolean');
                expect(wf.editable).to.equal(true);
                if (wf.baseline_available) expect(wf.download_url).to.match(/^\/gpu\/workflow\//);
                else expect(wf.download_url).to.equal(null);
            }
        });

        it('instructions schema', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image'], platform: 'linux', mode: 'managed', probe: PROBE_OK,
            });
            expect(i.platform).to.equal('linux');
            expect(i.mode).to.equal('managed');
            expect(i.profile_ids).to.deep.equal(['image/qwen-image']);
            expect(i.steps).to.be.an('array').and.not.empty;
            for (const s of i.steps) {
                expect(s.id).to.be.a('string');
                expect(s.title).to.be.a('string');
                expect(s.body).to.be.a('string');
            }
            expect(i.env.required).to.include('ANIMASTOR_WORKER_TOKEN');
            expect(i.env.template_block).to.contain('<your-worker-key>');
            expect(i.worker_key_policy.disclosed_once).to.equal(true);
        });

        it('worker status adapter + capabilities schema', () => {
            // adaptSetupStatus maps the legacy derived status to the extended
            // UI-safe status string (route wraps it into the response object).
            expect(sc.adaptSetupStatus({ status: 'ONLINE', last_seen: 123 })).to.equal('ONLINE');
            expect(sc.adaptSetupStatus({ status: 'OFFLINE', last_seen: 123 })).to.equal('OFFLINE');
            expect(sc.adaptSetupStatus({ status: 'OFFLINE', last_seen: null })).to.equal('CONNECTING');
            expect(sc.adaptSetupStatus({ status: 'REVOKED', last_seen: null })).to.equal('REVOKED');
            for (const s of ['ONLINE', 'OFFLINE', 'CONNECTING', 'REVOKED']) {
                expect(sc.SETUP_WORKER_STATUSES).to.include(s);
            }
            const caps = sc.normalizeCapabilities({
                profiles: ['image/qwen-image'],
                gpu: { name: 'RTX 3090', vram_mib: 24576 },
            });
            expect(caps.profiles).to.deep.equal(['image/qwen-image']);
            expect(caps.gpu).to.deep.equal({ name: 'RTX 3090', vram_gb: 24 });
            expect(sc.normalizeCapabilities(null)).to.equal(null);
            expect(sc.normalizeCapabilities({})).to.equal(null); // never invents data
        });

        it('installation plan schema', () => {
            const plan = sc.buildSetupPlan({
                profileIds: ['image/qwen-image', 'video/ltx-2.3'], mode: 'isolated', platform: 'linux',
            });
            expect(plan.mode).to.equal('isolated');
            expect(plan.platform).to.equal('linux');
            expect(plan.result).to.be.oneOf(['READY', 'READY_WITH_WARNINGS', 'BLOCKED']);
            expect(plan.profiles).to.be.an('array').with.length(2);
            expect(plan.actions).to.be.an('array').and.not.empty;
            for (const a of plan.actions) {
                expect(a.type).to.be.oneOf(['INSTALL', 'DOWNLOAD', 'KEEP', 'REVIEW', 'CONFIGURE', 'VERIFY']);
                expect(a.name).to.be.a('string');
                expect(a.component).to.be.a('string');
            }
            expect(plan.sharing.verdict).to.be.oneOf(Object.values(sc.SHARING_VERDICT_MAP));
            expect(plan.blocks).to.be.an('array');
            for (const b of plan.blocks) expect(b.code).to.be.a('string');
        });

        it('NO internals leak in any projection (tokens/hashes/fs paths/resolver internals)', () => {
            const payloads = [
                sc.listSetupProfiles(),
                sc.getInstallationMethods({ probe: PROBE_OK }),
                sc.getPlatformArtifacts({ platform: 'linux', probe: PROBE_OK }),
                sc.listWorkflowArtifacts(),
                sc.buildInstructions({ profileIds: REAL_PROFILE_IDS, platform: 'linux', mode: 'isolated', probe: PROBE_OK }),
                sc.buildSetupPlan({ profileIds: REAL_PROFILE_IDS, mode: 'shared', platform: 'linux' }),
                sc.adaptSetupStatus({ status: 'ONLINE', last_seen: 1 }),
                sc.normalizeCapabilities({ profiles: ['image/qwen-image'] }),
            ];
            const json = JSON.stringify(payloads);
            // secrets / credentials
            expect(json).to.not.match(/token_hash/i);
            expect(json).to.not.match(/wrk\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
            expect(json).to.not.match(/credential/i);
            // server filesystem paths (repo or container layout)
            expect(json).to.not.contain('/app/');
            expect(json).to.not.contain('/home/');
            expect(json).to.not.contain('backend/ai');
            expect(json).to.not.contain('backend/src');
            expect(json).to.not.contain('worker/worker');
            expect(json).to.not.contain('repository_path');
            // resolver internals
            expect(json).to.not.contain('expected');
            expect(json).to.not.contain('found');
            expect(json).to.not.contain('evidence');
        });
    });

    describe('probeHubArtifacts', () => {
        it('marks artifacts available when the hub sha256 endpoints answer', async () => {
            const seen = [];
            const fetchImpl = async (url) => {
                seen.push(url);
                return {
                    ok: true,
                    json: async () => ({ sha256: 'd'.repeat(64), version: '9.9.9', bytes: 42 }),
                };
            };
            const probe = await sc.probeHubArtifacts({ hubUrl: 'http://hub.test:5000', fetchImpl });
            expect(probe.worker_bundle.available).to.equal(true);
            expect(probe.worker_bundle.sha256).to.equal('d'.repeat(64));
            expect(probe.worker_bundle.version).to.equal('9.9.9');
            expect(probe.installer.available).to.equal(true);
            expect(seen).to.include('http://hub.test:5000/worker-bundle/sha256');
            expect(seen).to.include('http://hub.test:5000/installer/sha256');
        });

        it('hub outage / 404 → available=false (metadata endpoint never breaks, no fake URLs)', async () => {
            const failing = async () => { throw new Error('ECONNREFUSED'); };
            const probe = await sc.probeHubArtifacts({ hubUrl: 'http://hub.test:5000', fetchImpl: failing });
            expect(probe.worker_bundle.available).to.equal(false);
            expect(probe.worker_bundle.status).to.equal('unavailable');
            expect(probe.installer.available).to.equal(false);
            const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) });
            const probe404 = await sc.probeHubArtifacts({ hubUrl: 'http://hub.test:5000', fetchImpl: notFound });
            expect(probe404.installer.available).to.equal(false);
            const noHub = await sc.probeHubArtifacts({ hubUrl: null });
            expect(noHub.worker_bundle.available).to.equal(false);
            expect(noHub.installer.available).to.equal(false);
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
                expect(wf.baseline_available).to.equal(true); // real files exist
                expect(wf.editable).to.equal(true); // never immutable
                expect(wf.download_url).to.match(/^\/gpu\/workflow\/[a-z0-9._-]+$/);
                expect(wf.profile_id).to.be.oneOf(REAL_PROFILE_IDS);
                expect(wf.revision).to.match(/^\d{4}\.\d{2}\.\d{2}-r\d+$/); // manifest revision = artifact version
            }
            const image = workflows.find((w) => w.id === 'img-qwen-image');
            expect(image.sha256).to.match(/^[0-9a-f]{64}$/);
        });

        it('missing canonical file → baseline_available=false, no fake download URL', () => {
            const workflows = sc.listWorkflowArtifacts({
                profileId: 'image/qwen-image',
                workflowsRoot: '/nonexistent/workflows',
            });
            expect(workflows).to.have.length(1);
            expect(workflows[0].baseline_available).to.equal(false);
            expect(workflows[0].download_url).to.equal(null);
            expect(workflows[0].sha256).to.equal(null);
            expect(workflows[0].editable).to.equal(true);
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
        // Instructions reflect REAL availability: a full flow only when the
        // hub probe says the installer artifact exists.
        const PROBE_OK = {
            installer: { available: true, status: 'available', version: sc.getInstallerVersion(), sha256: 'c'.repeat(64) },
            worker_bundle: { available: true, status: 'available', version: sc.getWorkerBundleVersion(), sha256: 'b'.repeat(64) },
        };

        it('linux/managed returns the bootstrap flow (the worker is ALREADY created — no create step)', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image'], platform: 'linux', mode: 'managed',
                origin: 'https://app.animastor.in', probe: PROBE_OK,
            });
            expect(i.steps.map((s) => s.id)).to.deep.equal([
                'download-bootstrap', 'run-bootstrap', 'verify',
            ]);
            const download = i.steps.find((s) => s.id === 'download-bootstrap');
            // profile/mode are embedded in the download URL — nothing to type
            expect(download.code).to.contain('https://app.animastor.in/gpu/installer?profile=image%2Fqwen-image&mode=managed');
            const run = i.steps.find((s) => s.id === 'run-bootstrap');
            expect(run.code).to.equal('bash animastor-installer.sh');
            // the run body points at the interactive Worker Key prompt
            expect(run.body).to.match(/Worker Key/i);
            // verify is a simple last step: page heartbeat, CLI is optional
            const verify = i.steps.find((s) => s.id === 'verify');
            expect(verify.code).to.equal(undefined);
            expect(i.verify_command).to.contain('status.sh');
            // installer metadata for the UI (version primary, sha secondary)
            expect(i.installer.version).to.equal(sc.getInstallerVersion());
            expect(i.installer.sha256).to.equal('c'.repeat(64));
            expect(i.installer.download_url).to.contain('/gpu/installer?profile=');
        });

        it('linux/existing adds detection prerequisites and embeds mode=existing', () => {
            const i = sc.buildInstructions({
                profileIds: ['audio/qwen-tts'], platform: 'linux', mode: 'existing', probe: PROBE_OK,
            });
            expect(i.steps.map((s) => s.id)).to.contain('prerequisites');
            const prereq = i.steps.find((s) => s.id === 'prerequisites');
            expect(prereq.requirements.comfyui).to.be.a('string');
            expect(prereq.requirements.python).to.contain('3.10');
            expect(prereq.requirements.torch).to.contain('CUDA');
            const download = i.steps.find((s) => s.id === 'download-bootstrap');
            expect(download.code).to.contain('mode=existing');
        });

        it('windows native (Preview) → PowerShell bootstrap, never Linux commands', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image'], platform: 'windows', mode: 'managed',
                origin: 'https://app.animastor.in', probe: PROBE_OK,
            });
            expect(i.platform).to.equal('windows');
            expect(i.deployment).to.equal('native');
            expect(i.availability).to.equal('preview');
            expect(i.notice).to.contain('Preview');
            expect(i.steps.map((s) => s.id)).to.deep.equal(['download-bootstrap', 'run-bootstrap', 'verify']);
            const download = i.steps.find((s) => s.id === 'download-bootstrap');
            expect(download.code).to.contain('Invoke-WebRequest');
            expect(download.code).to.contain('platform=windows');
            expect(download.code).to.contain('https://app.animastor.in/gpu/installer?profile=image%2Fqwen-image&mode=managed');
            const run = i.steps.find((s) => s.id === 'run-bootstrap');
            expect(run.code).to.contain('powershell -ExecutionPolicy Bypass -File');
            const json = JSON.stringify(i);
            expect(json).to.not.contain('curl ');
            expect(json).to.not.contain('bash ');
            // Worker Key never in the bootstrap URL or any command
            expect(json).to.not.match(/wrk\./);
            expect(json).to.not.contain('ANIMASTOR_WORKER_TOKEN=wrk');
        });

        it('linux native keeps the stable flow unchanged (curl + bash, explicit platform param)', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image'], platform: 'linux', deployment: 'native', mode: 'managed',
                origin: 'https://app.animastor.in', probe: PROBE_OK,
            });
            expect(i.platform).to.equal('linux');
            expect(i.deployment).to.equal('native');
            expect(i.availability).to.equal('stable');
            expect(i.notice).to.equal(null);
            const download = i.steps.find((s) => s.id === 'download-bootstrap');
            expect(download.code).to.contain('curl -fsSL -o animastor-installer.sh');
            expect(download.code).to.contain('platform=linux');
            expect(i.steps.find((s) => s.id === 'run-bootstrap').code).to.equal('bash animastor-installer.sh');
            expect(i.verify_command).to.contain('status.sh');
        });

        it('docker deployment (Experimental) → container flow; profile/mode separate; key never in commands', () => {
            const i = sc.buildInstructions({
                profileIds: ['audio/qwen-tts'], platform: 'linux', deployment: 'docker', mode: 'managed',
                origin: 'https://app.animastor.in', probe: PROBE_OK,
            });
            expect(i.platform).to.equal('linux');
            expect(i.deployment).to.equal('docker');
            expect(i.availability).to.equal('experimental');
            expect(i.notice).to.contain('Experimental');
            expect(i.steps.map((s) => s.id)).to.deep.equal([
                'docker-prerequisites', 'docker-build', 'docker-install', 'docker-runtime', 'verify',
            ]);
            const prereq = i.steps.find((s) => s.id === 'docker-prerequisites');
            expect(prereq.requirements.docker).to.contain('Docker must be available on the host');
            expect(prereq.requirements.gpu).to.contain('NVIDIA Container Toolkit');
            expect(prereq.requirements.gpu).to.contain('host');
            const install = i.steps.find((s) => s.id === 'docker-install');
            expect(install.code).to.contain('-e ANIMASTOR_PROFILE=audio/qwen-tts');
            expect(install.code).to.contain('-e ANIMASTOR_MODE=managed');
            expect(install.code).to.contain('animastor-worker install');
            expect(install.body).to.match(/Worker Key/i);
            const runtime = i.steps.find((s) => s.id === 'docker-runtime');
            expect(runtime.code).to.contain('--restart unless-stopped');
            expect(runtime.code).to.contain('--gpus all');
            const json = JSON.stringify(i);
            // GPU drivers belong to the host — never "install the driver in the container"
            expect(prereq.requirements.gpu).to.contain('never install them inside the container');
            expect(json).to.not.match(/wrk\./);
            // the container fetches the bundle itself; no bash bootstrap here
            expect(json).to.not.contain('bash animastor-installer.sh');
            expect(i.installer.download_url).to.equal('https://app.animastor.in/gpu/installer/bundle');
            expect(i.verify_command).to.equal(null);
        });

        it('legacy UI platform docker maps to linux + docker deployment', () => {
            const i = sc.buildInstructions({
                profileIds: ['audio/qwen-tts'], platform: 'docker', mode: 'managed',
                origin: 'https://app.animastor.in', probe: PROBE_OK,
            });
            expect(i.platform).to.equal('linux');
            expect(i.deployment).to.equal('docker');
            expect(i.availability).to.equal('experimental');
        });

        it('windows + docker is rejected (backend authority, not frontend)', () => {
            try {
                sc.buildInstructions({
                    profileIds: ['image/qwen-image'], platform: 'windows', deployment: 'docker',
                    mode: 'managed', probe: PROBE_OK,
                });
                expect.fail('should throw');
            } catch (e) { expect(e.code).to.equal('unsupported_combination'); }
        });

        it('windows + isolated → honest notice, no invented Windows commands', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image'], platform: 'windows', mode: 'isolated', probe: PROBE_OK,
            });
            expect(i.steps.map((s) => s.id)).to.deep.equal(['isolated-unavailable']);
            expect(JSON.stringify(i)).to.not.contain('tar -xzf');
        });

        it('docker deployment without the hub installer → degraded honest flow', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image'], platform: 'linux', deployment: 'docker', mode: 'managed',
            });
            expect(i.steps.map((s) => s.id)).to.deep.equal(['installer-unavailable']);
            expect(JSON.stringify(i)).to.not.contain('docker run');
        });

        it('installer artifact unavailable → degraded flow (no fake commands)', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image'], platform: 'linux', mode: 'managed',
            }); // no probe → hub not serving the installer
            expect(i.steps.map((s) => s.id)).to.deep.equal(['platform-planned']);
        });

        it('existing mode, installer down but bundle served → bundle-based flow (no dead end)', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image'], platform: 'linux', mode: 'existing',
                origin: 'https://app.animastor.in',
                probe: {
                    installer: { available: false, status: 'unavailable', version: null, sha256: null },
                    worker_bundle: { available: true, status: 'available', version: sc.getWorkerBundleVersion(), sha256: 'b'.repeat(64) },
                },
            });
            expect(i.steps.map((s) => s.id)).to.deep.equal([
                'prerequisites', 'download-bundle', 'unpack-bundle',
                'configure-worker', 'start-worker', 'verify',
            ]);
            const dl = i.steps.find((s) => s.id === 'download-bundle');
            expect(dl.code).to.contain('https://app.animastor.in/gpu/worker-bundle');
            expect(dl.code).to.not.contain('/gpu/installer');
            expect(dl.checksum.value).to.equal('b'.repeat(64));
            const cfg = i.steps.find((s) => s.id === 'configure-worker');
            expect(cfg.code).to.contain('cp .env.example .env');
            expect(cfg.code).to.contain('ANIMASTOR_WORKER_TOKEN=<your-worker-key>');
            expect(cfg.code).to.contain('HUB_URL=https://app.animastor.in/gpu');
            expect(cfg.code).to.contain('WORKER_TYPE=image'); // real type, not a placeholder
            const start = i.steps.find((s) => s.id === 'start-worker');
            expect(start.code).to.contain('node worker.cjs');
            // the bundle is one archive — never manual per-file downloads
            expect(JSON.stringify(i)).to.not.contain('worker-source');
            expect(JSON.stringify(i)).to.not.match(/wrk\.[A-Za-z0-9_-]{8,}/);
        });

        it('managed mode, installer down but bundle served → points at Existing ComfyUI', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image'], platform: 'linux', mode: 'managed',
                probe: {
                    installer: { available: false, status: 'unavailable', version: null, sha256: null },
                    worker_bundle: { available: true, status: 'available', version: '2.0.0', sha256: 'b'.repeat(64) },
                },
            });
            expect(i.steps.map((s) => s.id)).to.deep.equal(['installer-unavailable']);
            expect(i.steps[0].body).to.contain('Existing ComfyUI');
            expect(JSON.stringify(i)).to.not.contain('curl');
        });

        it('env template fills real public values, keeps the key a placeholder', () => {
            const i = sc.buildInstructions({
                profileIds: ['audio/qwen-tts'], platform: 'linux', mode: 'managed',
                origin: 'https://app.animastor.in', probe: PROBE_OK,
            });
            expect(i.env.template_block).to.contain('HUB_URL=https://app.animastor.in/gpu');
            expect(i.env.template_block).to.contain('WORKER_TYPE=audio');
            expect(i.env.template_block).to.contain('ANIMASTOR_WORKER_TOKEN=<your-worker-key>');
            expect(i.env.template_block).to.contain('WORKER_ID=<worker-id>');
        });

        it('multi-profile instructions embed the comma-separated profile list (URL-encoded)', () => {
            const i = sc.buildInstructions({
                profileIds: ['audio/qwen-tts', 'image/qwen-image'], platform: 'linux', mode: 'shared', probe: PROBE_OK,
            });
            const download = i.steps.find((s) => s.id === 'download-bootstrap');
            expect(download.code).to.contain('profile=audio%2Fqwen-tts%2Cimage%2Fqwen-image');
            expect(download.code).to.contain('mode=shared');
        });

        it('isolated mode keeps the explicit bundle flow (one run per profile, distinct roots)', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image', 'video/ltx-2.3'], platform: 'linux', mode: 'isolated', probe: PROBE_OK,
            });
            const run = i.steps.find((s) => s.id === 'run-bootstrap');
            expect(run.code).to.contain('--profile image/qwen-image');
            expect(run.code).to.contain('--profile video/ltx-2.3');
            expect(run.code).to.contain('isolated/qwen-image');
            expect(run.code).to.contain('isolated/ltx-2.3');
            // the raw bundle is downloaded from the bundle endpoint
            const download = i.steps.find((s) => s.id === 'download-bootstrap');
            expect(download.code).to.contain('/gpu/installer/bundle');
        });

        it('the Worker Key appears only as a placeholder — never a value or a command line flag', () => {
            const i = sc.buildInstructions({
                profileIds: ['image/qwen-image'], platform: 'linux', mode: 'managed', probe: PROBE_OK,
            });
            expect(i.env.template_block).to.contain('ANIMASTOR_WORKER_TOKEN=<your-worker-key>');
            expect(i.env.template_block).to.not.match(/wrk\.[A-Za-z0-9_-]{8,}/);
            // no credential in the download/run commands either
            const blob = JSON.stringify(i.steps);
            expect(blob).to.not.match(/wrk\.[A-Za-z0-9_-]{8,}/);
            expect(blob.toLowerCase()).to.not.contain('worker-key=');
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
        it('image (managed): full action list with verified model sources', () => {
            const plan = sc.buildSetupPlan({ profileIds: ['image/qwen-image'], mode: 'managed', platform: 'linux' });
            expect(plan.result).to.be.oneOf(['READY', 'READY_WITH_WARNINGS']);
            expect(plan.profiles).to.deep.equal(['image/qwen-image']);
            const types = plan.actions.map((a) => `${a.type}:${a.component}`);
            expect(types).to.include('INSTALL:runtime');
            expect(types).to.include('INSTALL:custom-node');
            expect(types).to.include('DOWNLOAD:model');
            expect(types).to.include('DOWNLOAD:workflow');
            expect(types).to.include('INSTALL:worker-bundle');
            expect(types).to.include('CONFIGURE:worker-env');
            expect(types).to.include('VERIFY:verification');
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

        it('windows native → allowed with Preview warning; docker → Experimental warning', () => {
            const win = sc.buildSetupPlan({ profileIds: ['image/qwen-image'], mode: 'managed', platform: 'windows' });
            expect(win.result).to.equal('READY_WITH_WARNINGS');
            expect(win.platform).to.equal('windows');
            expect(win.deployment).to.equal('native');
            expect(win.availability).to.equal('preview');
            expect(win.blocks).to.deep.equal([]);
            expect(win.warnings.join(' ')).to.contain('Preview');

            const dock = sc.buildSetupPlan({ profileIds: ['image/qwen-image'], mode: 'managed', platform: 'linux', deployment: 'docker' });
            expect(dock.result).to.equal('READY_WITH_WARNINGS');
            expect(dock.availability).to.equal('experimental');
            expect(dock.blocks).to.deep.equal([]);
            expect(dock.warnings.join(' ')).to.contain('Experimental');
        });

        it('windows + docker → BLOCKED with UNSUPPORTED_COMBINATION', () => {
            const plan = sc.buildSetupPlan({ profileIds: ['image/qwen-image'], mode: 'managed', platform: 'windows', deployment: 'docker' });
            expect(plan.result).to.equal('BLOCKED');
            expect(plan.blocks[0].code).to.equal('UNSUPPORTED_COMBINATION');
            expect(plan.actions).to.deep.equal([]);
        });

        it('legacy platform docker in plan → linux + docker experimental', () => {
            const plan = sc.buildSetupPlan({ profileIds: ['image/qwen-image'], mode: 'managed', platform: 'docker' });
            expect(plan.platform).to.equal('linux');
            expect(plan.deployment).to.equal('docker');
            expect(plan.availability).to.equal('experimental');
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
