const { expect } = require('chai');
const manifestLoader = require('../src/installer/install-manifest');
const resolver = require('../src/installer/compatibility-resolver');

const AUDIO = () => manifestLoader.loadManifest('audio/qwen-tts');
const IMAGE = () => manifestLoader.loadManifest('image/qwen-image');
const VIDEO = () => manifestLoader.loadManifest('video/ltx-2.3');

function entry(report, id) {
    return report.entries.find((e) => e.id === id);
}

function assertNeverDestructive(report) {
    expect(report.destructive_operations).to.be.an('array').that.is.empty;
    for (const e of report.entries) {
        expect(resolver.ACTIONS).to.include(e.action);
        expect(['remove', 'delete', 'downgrade', 'uninstall', 'replace']).to.not.include(e.action);
    }
}

function workerProbe(workerType) {
    return {
        worker_type: workerType,
        bundle: {
            present: true,
            dir: `/home/test/animastor/worker-${workerType}`,
            files: ['worker.cjs', 'worker-cleanup.cjs', 'worker-cleanup-journal.cjs', 'package.json', 'package-lock.json', '.env.example'],
        },
        env: { present: true, set_keys: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'] },
    };
}

const WORKFLOW_HASHES = {
    'tts-qwen-narrator': '87180aee01288be6e23240b2d873ce2d451f63cf404dec331a3b221bb9f8b8c1',
    'tts-qwen-dialogue': '7dcdc6997d36aaeb1a54e1578c69f0c534be29698c7a7b48813f637c740e69db',
    'img-qwen-image': 'fb4c25e52bbb2f75270367d2696b4b7469617d6557cd0bcc634a6a6fc03a5816',
    'video-ltx-1p': '6ab036e1c7b4f9e3e9df11b31b08d7495a4c7a761d8f8159951bf06768df3cc1',
    'video-ltx-2p': '1be44f6fd00e2684a6db138e1a20e8445653bfc65bbb3caa62dfe00b31067617',
    'video-ltx-3p': 'ec15a01259afcc6b3d76df5d5eec75a080b6aa54bd6b064b79538bd30dcf90f4',
    'video-ltx-4p': 'acef76b38f25b41f133b92bb71e2ab3ac8f75808209c29624319c9d08822d80d',
};

function baselineWorkflow(type, name) {
    return { path: `user/default/workflows/animastor/${type}/${name}.json`, sha256: WORKFLOW_HASHES[name] };
}

function imageCompatibleEnv() {
    return {
        root: '/home/test/ComfyUI',
        comfyui: {
            present: true,
            repository: 'https://github.com/rajsingh1-dev/ComfyUI.git',
            commit: 'c4cfee7ad16cfeb082e12f43cf4751b4a67a4e11',
        },
        python: { version: '3.10.12' },
        torch: { version: '2.10.0+cu128' },
        nodejs: { version: '20.11.1' },
        gpu: { name: 'NVIDIA L40S', vram_mib: 46068, driver_version: '550.127.08' },
        custom_nodes: [{ directory: 'ComfyUI-GGUF', commit: '6ea2651' }],
        models: [
            { path: 'models/unet/qwen-image-2512-Q4_K_M.gguf', size_bytes: 13249974108 },
            { path: 'models/clip/Qwen2.5-VL-7B-Instruct-Q8_0.gguf', size_bytes: 8096013353 },
            { path: 'models/vae/qwen_image_vae.safetensors', size_bytes: 253807821, sha256: `a70580f0213e${'0'.repeat(52)}` },
            { path: 'models/loras/Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0.safetensors', size_bytes: 1181116006 },
        ],
        python_packages: [],
        workflows: [baselineWorkflow('image', 'img-qwen-image')],
        worker: workerProbe('image'),
    };
}

function audioModelFiles() {
    return [
        { path: 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/model.safetensors', size_bytes: 3833258312 },
        { path: 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/speech_tokenizer/model.safetensors', size_bytes: 682297917 },
        { path: 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-Base/model.safetensors', size_bytes: 3854733148 },
        { path: 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-Base/speech_tokenizer/model.safetensors', size_bytes: 682297917 },
    ];
}

function videoCompatibleEnv() {
    return {
        root: '/home/video/ComfyUI',
        comfyui: {
            present: true,
            repository: 'https://github.com/comfyanonymous/ComfyUI.git',
            tag: 'v0.27.0',
            version: '0.27.0',
            commit: 'bb131be9e83d2f773c90f1d6f1e4b248a498c8c5',
        },
        python: { version: '3.10.12' },
        torch: { version: '2.6.0+cu124' },
        nodejs: { version: '20.11.1' },
        gpu: { name: 'NVIDIA L40S', vram_mib: 46068, driver_version: '550.127.08' },
        custom_nodes: [
            { directory: 'ComfyUI-GGUF', is_git: false },
            { directory: 'comfyui-kjnodes', is_git: false },
        ],
        models: [
            { path: 'models/unet/LTX-2.3-distilled-Q4_K_M.gguf', size_bytes: 17759689769 },
            { path: 'models/text_encoders/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf', size_bytes: 7430293422 },
            { path: 'models/text_encoders/ltx-2.3_text_projection_bf16.safetensors', size_bytes: 2308544922 },
            { path: 'models/loras/ltx-2-19b-ic-lora-detailer.safetensors', size_bytes: 2619930051 },
            { path: 'models/vae/ltx-2.3-22b-dev_video_vae.safetensors', size_bytes: 1449551462 },
            { path: 'models/vae/ltx-2.3-22b-dev_audio_vae.safetensors', size_bytes: 364852019 },
            { path: 'models/vae/taeltx2_3.safetensors', size_bytes: 23530045 },
        ],
        python_packages: [{ name: 'gguf', version: '0.14.0' }],
        workflows: [
            baselineWorkflow('video', 'video-ltx-1p'),
            baselineWorkflow('video', 'video-ltx-2p'),
            baselineWorkflow('video', 'video-ltx-3p'),
            baselineWorkflow('video', 'video-ltx-4p'),
        ],
        worker: workerProbe('video'),
    };
}

function syntheticManifest(profileId, { torch = '2.6.0+cu124', comfyCommit = 'bb131be9e83d2f773c90f1d6f1e4b248a498c8c5' } = {}) {
    const [type, name] = profileId.split('/');
    return {
        manifest_version: manifestLoader.MANIFEST_SCHEMA_VERSION,
        revision: 'test-1',
        profile: { id: profileId, type, name },
        provenance: { workflows: ['wf-test'] },
        runtime_requirements: {
            comfyui: {
                policy: 'exact-pin-preferred',
                pin: { repository: 'https://github.com/comfyanonymous/ComfyUI.git', tag: 'v0.27.0', commit: comfyCommit },
                min_version: 'v0.27.0',
                max_tested_version: 'v0.27.0',
                basis: 'known_working',
            },
            python: { policy: 'minimum', minimum: '3.10', basis: 'minimum_supported' },
            torch: { policy: 'exact', pin: torch, basis: 'known_working' },
            nodejs: { policy: 'minimum', minimum: '20', basis: 'minimum_supported' },
            nvidia_driver: { policy: 'reference-only', basis: 'environment_reference' },
        },
        dependencies: [],
        worker_bundle: { min_version: '2.0.0', files: ['worker.cjs'], env: { required: ['HUB_URL'], optional: [] } },
        verification: { method: 'resolver-diff', pass: 'p', warn: 'w', fail: 'f' },
    };
}

describe('Compatibility Resolver', () => {
    describe('version helpers', () => {
        it('compares dotted versions', () => {
            expect(resolver.compareVersions('v0.27.0', '0.27.0')).to.equal(0);
            expect(resolver.compareVersions('0.26.9', 'v0.27.0')).to.equal(-1);
            expect(resolver.compareVersions('0.28.0', 'v0.27.0')).to.equal(1);
            expect(resolver.compareVersions('3.9.5', '3.10')).to.equal(-1);
            expect(resolver.compareVersions('2.6.0+cu124', '2.6.0')).to.equal(0);
            expect(resolver.compareVersions('garbage', '1.0')).to.be.null;
        });

        it('matches short/full shas and knows renamed upstreams', () => {
            expect(resolver.shaMatch('bb131be9e83d2f773c90f1d6f1e4b248a498c8c5', 'bb131be9')).to.be.true;
            expect(resolver.shaMatch('bb131be9', 'c4cfee7a')).to.be.false;
            expect(resolver.shaMatch(null, 'bb131be9')).to.be.false;
            expect(resolver.reposEqual('https://github.com/comfyanonymous/ComfyUI.git', 'https://github.com/Comfy-Org/ComfyUI.git')).to.be.true;
            expect(resolver.reposEqual('https://github.com/rajsingh1-dev/ComfyUI.git', 'https://github.com/Comfy-Org/ComfyUI.git')).to.be.false;
        });
    });

    // ── Scenarios 1–3: clean managed machine ──────────────────────────────

    describe('scenario 1: clean managed machine + audio/qwen-tts', () => {
        it('plans installation of everything required, nothing destructive', () => {
            const r = resolver.resolveInstallation({ manifests: [AUDIO()], environment: resolver.createEmptyEnvironment(), mode: 'managed' });
            expect(r.mode).to.equal('managed');
            expect(r.summary.missing_required).to.equal(10); // comfyui, torch, python, nodejs + 1 node + 2 model repos + 2 workflows + worker
            expect(r.summary.by_status.incompatible).to.equal(0);
            expect(r.summary.by_status.missing).to.equal(11); // + optional manager (action none)
            for (const id of ['runtime:comfyui', 'runtime:torch', 'custom-node:comfyui-qwen3-tts',
                'model-repo:qwen3-tts-12hz-1.7b-voicedesign', 'model-repo:qwen3-tts-12hz-1.7b-base',
                'workflow:tts-qwen-narrator', 'workflow:tts-qwen-dialogue', 'worker:audio/qwen-tts']) {
                expect(entry(r, id).status).to.equal('missing');
                expect(entry(r, id).action).to.equal('install');
            }
            expect(r.summary.install_plan).to.not.include('custom-node:comfyui-manager');
            expect(r.safe_to_proceed).to.be.true;
            assertNeverDestructive(r);
        });
    });

    describe('scenario 2: clean managed machine + image/qwen-image', () => {
        it('plans installation of ComfyUI runtime, GGUF node, 4 models, baseline workflow and worker', () => {
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: resolver.createEmptyEnvironment(), mode: 'managed' });
            expect(r.summary.missing_required).to.equal(11); // 4 runtime + 1 node + 4 models + 1 workflow + worker
            for (const id of ['custom-node:comfyui-gguf', 'model:image.unet.qwen-image-2512-q4-k-m',
                'model:image.clip.qwen2.5-vl-7b-instruct-q8-0', 'model:image.vae.qwen-image-vae',
                'model:image.loras.wuli-qwen-image-2512-turbo-4steps',
                'workflow:img-qwen-image', 'worker:image/qwen-image']) {
                expect(entry(r, id).status).to.equal('missing');
                expect(entry(r, id).action).to.equal('install');
            }
            assertNeverDestructive(r);
        });
    });

    describe('scenario 3: clean managed machine + video/ltx-2.3', () => {
        it('plans 19 required installs; unresolved VHS is review, not auto-install', () => {
            const r = resolver.resolveInstallation({ manifests: [VIDEO()], environment: resolver.createEmptyEnvironment(), mode: 'managed' });
            expect(r.summary.missing_required).to.equal(19); // 4 runtime + GGUF + gguf + kjnodes + 7 models + 4 workflows + worker
            const vhs = entry(r, 'custom-node:comfyui-videohelpersuite');
            expect(vhs.status).to.equal('missing');
            expect(vhs.requirement).to.equal('unknown');
            expect(vhs.action).to.equal('review'); // fail-safe: unknown requirement is never auto-installed
            expect(r.summary.install_plan).to.not.include(vhs.id);
            expect(entry(r, 'custom-node:comfyui-kjnodes').action).to.equal('install');
            for (const id of ['workflow:video-ltx-1p', 'workflow:video-ltx-2p', 'workflow:video-ltx-3p', 'workflow:video-ltx-4p']) {
                expect(entry(r, id).status).to.equal('missing');
                expect(entry(r, id).action).to.equal('install');
            }
            assertNeverDestructive(r);
        });
    });

    // ── Scenarios 4–7: existing environment ───────────────────────────────

    describe('scenario 4: existing compatible ComfyUI', () => {
        it('reports everything installed against the known-working reference', () => {
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: imageCompatibleEnv(), mode: 'existing' });
            expect(r.summary.missing_required).to.equal(0);
            expect(r.summary.by_status.incompatible).to.equal(0);
            expect(r.summary.by_status.installed).to.equal(11); // 4 runtime + node + 4 models + workflow + worker
            const comfy = entry(r, 'runtime:comfyui');
            expect(comfy.status).to.equal('installed');
            expect(comfy.grade).to.equal('reference'); // fork c4cfee7 = known-working reference, canonical pin still unknown
            expect(entry(r, 'runtime:torch').grade).to.equal('reference');
            expect(entry(r, 'custom-node:comfyui-gguf').status).to.equal('installed');
            expect(entry(r, 'model:image.vae.qwen-image-vae').grade).to.equal('checksum-prefix-verified');
            const wf = entry(r, 'workflow:img-qwen-image');
            expect(wf.status).to.equal('installed');
            expect(wf.grade).to.equal('canonical-baseline');
            const worker = entry(r, 'worker:image/qwen-image');
            expect(worker.status).to.equal('installed');
            expect(worker.grade).to.equal('configured');
            expect(worker.action).to.equal('skip');
            expect(r.safe_to_proceed).to.be.true;
            assertNeverDestructive(r);
        });

        it('accepts the canonical video stack (v0.27.0 + cu124) as fully installed', () => {
            const r = resolver.resolveInstallation({ manifests: [VIDEO()], environment: videoCompatibleEnv(), mode: 'existing' });
            expect(r.summary.missing_required).to.equal(0);
            expect(entry(r, 'runtime:comfyui').grade).to.equal('canonical');
            expect(entry(r, 'runtime:torch').grade).to.equal('canonical');
            expect(entry(r, 'custom-node:comfyui-gguf').status).to.equal('installed');
            expect(entry(r, 'custom-node:comfyui-gguf').grade).to.equal('presence'); // plain dir, no git metadata
            expect(entry(r, 'custom-node:comfyui-kjnodes').notes.join(' ')).to.match(/patch/);
            expect(entry(r, 'python-package:gguf').status).to.equal('installed');
            assertNeverDestructive(r);
        });
    });

    describe('scenario 5: existing ComfyUI with missing model', () => {
        it('flags exactly the missing model and suggests installing only it', () => {
            const env = imageCompatibleEnv();
            env.models = env.models.filter((m) => !m.path.includes('Wuli-Qwen-Image'));
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            expect(r.summary.missing_required).to.equal(1);
            const missing = r.entries.filter((e) => e.status === 'missing' && e.requirement === 'required');
            expect(missing).to.have.length(1);
            expect(missing[0].id).to.equal('model:image.loras.wuli-qwen-image-2512-turbo-4steps');
            expect(r.summary.install_plan).to.deep.equal([missing[0].id]);
            assertNeverDestructive(r);
        });
    });

    describe('scenario 6: existing ComfyUI with missing custom node', () => {
        it('flags the missing ComfyUI-GGUF node', () => {
            const env = imageCompatibleEnv();
            env.custom_nodes = [];
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            const node = entry(r, 'custom-node:comfyui-gguf');
            expect(node.status).to.equal('missing');
            expect(node.action).to.equal('install');
            expect(r.summary.missing_required).to.equal(1);
            assertNeverDestructive(r);
        });
    });

    describe('scenario 7: existing incompatible runtime', () => {
        it('reports torch mismatch + python below minimum as incompatible (review, never auto-replace)', () => {
            const env = videoCompatibleEnv();
            env.torch = { version: '2.5.1+cu124' };
            env.python = { version: '3.9.5' };
            const r = resolver.resolveInstallation({ manifests: [VIDEO()], environment: env, mode: 'existing' });
            const torch = entry(r, 'runtime:torch');
            expect(torch.status).to.equal('incompatible');
            expect(torch.reason).to.equal('version_mismatch');
            expect(torch.action).to.equal('review');
            expect(torch.notes.join(' ')).to.match(/NEVER auto-replaced/);
            const python = entry(r, 'runtime:python');
            expect(python.status).to.equal('incompatible');
            expect(python.reason).to.equal('below_minimum');
            expect(r.safe_to_proceed).to.be.false;
            expect(r.summary.install_plan).to.not.include('runtime:torch');
            assertNeverDestructive(r);
        });

        it('never auto-downgrades a ComfyUI newer than max_tested', () => {
            const env = videoCompatibleEnv();
            env.comfyui = { present: true, repository: 'https://github.com/comfyanonymous/ComfyUI.git', tag: 'v0.28.0', version: '0.28.0', commit: 'deadbeef00000000' };
            const r = resolver.resolveInstallation({ manifests: [VIDEO()], environment: env, mode: 'existing' });
            const comfy = entry(r, 'runtime:comfyui');
            expect(comfy.status).to.equal('incompatible');
            expect(comfy.reason).to.equal('above_max_tested');
            expect(comfy.action).to.equal('review');
            expect(comfy.notes.join(' ')).to.match(/NEVER auto-downgrade/);
            assertNeverDestructive(r);
        });

        it('does not claim compatibility for an unknown ComfyUI when the canonical pin is unknown (audio)', () => {
            const env = imageCompatibleEnv();
            env.comfyui = { present: true, repository: 'https://github.com/Comfy-Org/ComfyUI.git', tag: 'v0.27.0', version: '0.27.0', commit: 'bb131be9e83d2f773c90f1d6f1e4b248a498c8c5' };
            const r = resolver.resolveInstallation({ manifests: [AUDIO()], environment: env, mode: 'existing' });
            const comfy = entry(r, 'runtime:comfyui');
            expect(comfy.status).to.equal('unknown'); // matches neither canonical (none) nor the fork reference
            expect(comfy.action).to.equal('review');
            expect(comfy.notes.join(' ')).to.match(/NO automatic replacement/);
            assertNeverDestructive(r);
        });
    });

    // ── Scenarios 8–10: multi-profile sharing ─────────────────────────────

    describe('scenario 8: two compatible profiles sharing one ComfyUI', () => {
        it('audio + image are shared-compatible at reference evidence grade', () => {
            const s = resolver.resolveSharedRuntime([AUDIO(), IMAGE()]);
            expect(s.verdict).to.equal('shared-compatible');
            expect(s.can_share).to.be.true;
            expect(s.evidence_grade).to.equal('reference'); // both known-working on the same E2E fork/cu128 config
            expect(s.conflicts).to.deep.equal([]);
            expect(s.union.shared_by_multiple_profiles.map((x) => x.id)).to.include('custom-node:comfyui-manager');
        });

        it('resolves a shared environment with union dependencies installed', () => {
            const env = imageCompatibleEnv();
            env.custom_nodes.push({ directory: 'qwen3-tts', commit: '2ee1131' });
            env.models.push(...audioModelFiles());
            env.workflows.push(
                baselineWorkflow('audio', 'tts-qwen-narrator'),
                baselineWorkflow('audio', 'tts-qwen-dialogue')
            );
            env.worker = [env.worker, workerProbe('audio')];
            const r = resolver.resolveInstallation({ manifests: [AUDIO(), IMAGE()], environment: env, mode: 'shared' });
            expect(r.sharing.verdict).to.equal('shared-compatible');
            expect(r.summary.missing_required).to.equal(0);
            expect(r.safe_to_proceed).to.be.true;
            expect(entry(r, 'custom-node:comfyui-qwen3-tts').status).to.equal('installed');
            expect(entry(r, 'custom-node:comfyui-gguf').status).to.equal('installed');
            expect(entry(r, 'workflow:tts-qwen-narrator').status).to.equal('installed');
            expect(entry(r, 'worker:audio/qwen-tts').status).to.equal('installed');
            expect(entry(r, 'worker:image/qwen-image').status).to.equal('installed');
            assertNeverDestructive(r);
        });
    });

    describe('scenario 9: two profiles with conflicting runtime requirements', () => {
        it('same ComfyUI but different torch pins → shared-conflict with an explicit message', () => {
            const a = syntheticManifest('image/a', { torch: '2.6.0+cu124' });
            const b = syntheticManifest('image/b', { torch: '2.10.0+cu128' });
            const s = resolver.resolveSharedRuntime([a, b]);
            expect(s.verdict).to.equal('shared-conflict');
            expect(s.can_share).to.be.false;
            expect(s.message).to.match(/cannot safely share one ComfyUI runtime/);
            expect(s.conflicts.map((c) => c.component)).to.deep.equal(['torch']);
        });
    });

    describe('scenario 10: three profiles requiring isolation', () => {
        it('audio + image + video → requires-isolation (fork vs official ComfyUI, cu128 vs cu124)', () => {
            const s = resolver.resolveSharedRuntime([AUDIO(), IMAGE(), VIDEO()]);
            expect(s.verdict).to.equal('requires-isolation');
            expect(s.can_share).to.be.false;
            expect(s.message).to.match(/cannot safely share one ComfyUI runtime/);
            const components = s.conflicts.map((c) => c.component);
            expect(components).to.include('comfyui');
            expect(components).to.include('torch');
        });

        it('isolated plan: each profile gets its own root, resolved independently', () => {
            const plan = resolver.planIsolatedEnvironments([
                { manifests: [AUDIO()], environment: { ...resolver.createEmptyEnvironment('/home/gpu/comfy-audio'), root: '/home/gpu/comfy-audio' }, label: 'audio' },
                { manifests: [IMAGE()], environment: { ...resolver.createEmptyEnvironment('/home/gpu/comfy-image'), root: '/home/gpu/comfy-image' }, label: 'image' },
                { manifests: [VIDEO()], environment: { ...resolver.createEmptyEnvironment('/home/gpu/comfy-video'), root: '/home/gpu/comfy-video' }, label: 'video' },
            ]);
            expect(plan.ok).to.be.true;
            expect(plan.environments).to.have.length(3);
            expect(plan.environments.every((e) => e.mode === 'isolated')).to.be.true;
        });

        it('isolated plan rejects duplicate roots', () => {
            const plan = resolver.planIsolatedEnvironments([
                { manifests: [AUDIO()], environment: { root: '/home/gpu/comfy' } },
                { manifests: [IMAGE()], environment: { root: '/home/gpu/comfy' } },
            ]);
            expect(plan.ok).to.be.false;
            expect(plan.issues.join(' ')).to.match(/must not share a root/);
        });
    });

    // ── Scenarios 11–12: unknown / unused pre-existing components ─────────

    describe('scenario 11: unknown pre-existing dependency', () => {
        it('reports unknown node/model as unknown with action=none (never removed)', () => {
            const env = imageCompatibleEnv();
            env.custom_nodes.push({ directory: 'mystery-node', is_git: false });
            env.models.push({ path: 'models/checkpoints/random-thing.safetensors', size_bytes: 123 });
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            const node = entry(r, 'extra:custom-node:mystery-node');
            expect(node.status).to.equal('unknown');
            expect(node.action).to.equal('none');
            const model = entry(r, 'extra:model:models/checkpoints/random-thing.safetensors');
            expect(model.status).to.equal('unknown');
            expect(model.action).to.equal('none');
            assertNeverDestructive(r);
        });
    });

    describe('scenario 12: unused dependency', () => {
        it('optional manifest dependency present on machine → unused, kept as-is', () => {
            const env = imageCompatibleEnv();
            env.custom_nodes.push({ directory: 'comfyui-manager', commit: 'df1eaff8' });
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            const manager = entry(r, 'custom-node:comfyui-manager');
            expect(manager.status).to.equal('unused');
            expect(manager.action).to.equal('none');
            // and it is NOT double-reported as an extra
            expect(entry(r, 'extra:custom-node:comfyui-manager')).to.be.undefined;
            assertNeverDestructive(r);
        });

        it('reference-known extras (upscaler model, rgthree) → unused, not unknown', () => {
            const env = videoCompatibleEnv();
            env.custom_nodes.push({ directory: 'rgthree-comfy', commit: '683836c' });
            env.models.push({ path: 'models/latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.0.safetensors', size_bytes: 995747430 });
            const r = resolver.resolveInstallation({ manifests: [VIDEO()], environment: env, mode: 'existing' });
            const upscaler = entry(r, 'model:video.latent-upscale.ltx-2.3-spatial-upscaler-x2');
            expect(upscaler.status).to.equal('unused'); // optional manifest entry present
            expect(upscaler.action).to.equal('none');
            const rgthree = entry(r, 'extra:custom-node:rgthree-comfy');
            expect(rgthree.status).to.equal('unused'); // known from environment_reference.known_extras
            expect(rgthree.action).to.equal('none');
            assertNeverDestructive(r);
        });
    });

    // ── Guard rails ────────────────────────────────────────────────────────

    describe('guard rails', () => {
        it('unprobed environment sections yield status=required, not missing', () => {
            const env = { root: '/x', comfyui: imageCompatibleEnv().comfyui, torch: { version: '2.10.0+cu128' } };
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            for (const e of r.entries.filter((x) => x.kind !== 'runtime' && (x.kind === 'model' || x.kind === 'custom_node'))) {
                if (e.requirement === 'required') expect(e.status).to.equal('required');
            }
            expect(entry(r, 'runtime:python').status).to.equal('required');
            assertNeverDestructive(r);
        });

        it('managed mode with a pre-existing ComfyUI warns and stays non-destructive', () => {
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: imageCompatibleEnv(), mode: 'managed' });
            expect(r.warnings.join(' ')).to.match(/existing ComfyUI was detected/);
            assertNeverDestructive(r);
        });

        it('rejects unknown modes and shared mode with a single manifest', () => {
            expect(() => resolver.resolveInstallation({ manifests: [IMAGE()], mode: 'yolo' })).to.throw(/unknown runtime mode/);
            expect(() => resolver.resolveInstallation({ manifests: [IMAGE()], mode: 'shared' })).to.throw(/at least two manifests/);
        });

        it('checksum mismatch is incompatible, size mismatch beyond tolerance is incompatible', () => {
            const env = imageCompatibleEnv();
            env.models = env.models.map((m) => (m.path.includes('qwen_image_vae') ? { ...m, sha256: `ffffffffffff${'0'.repeat(52)}` } : m));
            let r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            expect(entry(r, 'model:image.vae.qwen-image-vae').status).to.equal('incompatible');
            expect(entry(r, 'model:image.vae.qwen-image-vae').reason).to.equal('checksum_mismatch');

            const env2 = imageCompatibleEnv();
            env2.models = env2.models.map((m) => (m.path.includes('qwen-image-2512') ? { ...m, size_bytes: 1000 } : m));
            r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env2, mode: 'existing' });
            expect(entry(r, 'model:image.unet.qwen-image-2512-q4-k-m').status).to.equal('incompatible');
            expect(entry(r, 'model:image.unet.qwen-image-2512-q4-k-m').reason).to.equal('size_mismatch');
        });

        it('custom node at a different pinned commit is incompatible (review, git-safe checkout suggested)', () => {
            const env = imageCompatibleEnv();
            env.custom_nodes = [{ directory: 'ComfyUI-GGUF', commit: 'abcdef1234567890' }];
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            const node = entry(r, 'custom-node:comfyui-gguf');
            expect(node.status).to.equal('incompatible');
            expect(node.reason).to.equal('version_mismatch');
            expect(node.action).to.equal('review');
            assertNeverDestructive(r);
        });
    });
});
