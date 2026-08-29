'use strict';

/**
 * Phase 1.5 tests — Existing ComfyUI, Workflows, flexible profile mode.
 *
 * Covers the 15 required scenarios:
 *   1.  Clean machine + Image
 *   2.  Clean machine + Video
 *   3.  Clean machine + Audio
 *   4.  Existing compatible ComfyUI
 *   5.  Existing older ComfyUI → user chooses Update
 *   6.  Existing older ComfyUI → user chooses Keep
 *   7.  Missing custom node
 *   8.  Missing model
 *   9.  Missing workflow
 *   10. Existing customized workflow
 *   11. Two profiles with compatible shared runtime
 *   12. Two profiles with conflicting runtime
 *   13. Existing unknown dependency
 *   14. Worker setup
 *   15. Worker secret never appears in logs
 *
 * All tests are pure in-memory: NO real downloads happen (no tens of GiB).
 */

const { expect } = require('chai');
const manifestLoader = require('../src/installer/install-manifest');
const resolver = require('../src/installer/compatibility-resolver');
const workflows = require('../src/installer/workflow-artifacts');
const downloads = require('../src/installer/download-planner');
const planBuilder = require('../src/installer/install-plan');
const safety = require('../src/installer/safety-rules');
const verification = require('../src/installer/verification-report');

const AUDIO = () => manifestLoader.loadManifest('audio/qwen-tts');
const IMAGE = () => manifestLoader.loadManifest('image/qwen-image');
const VIDEO = () => manifestLoader.loadManifest('video/ltx-2.3');

const IMAGE_WF_HASH = 'fb4c25e52bbb2f75270367d2696b4b7469617d6557cd0bcc634a6a6fc03a5816';

function entry(report, id) {
    return report.entries.find((e) => e.id === id);
}

function assertNeverDestructive(report) {
    safety.assertSafeReport(report);
    expect(report.destructive_operations).to.be.an('array').that.is.empty;
    for (const e of report.entries) {
        expect(resolver.ACTIONS).to.include(e.action);
        expect(['remove', 'delete', 'downgrade', 'uninstall', 'replace']).to.not.include(e.action);
    }
}

function workerProbe(workerType, { withEnv = true, setKeys = ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'] } = {}) {
    return {
        worker_type: workerType,
        bundle: {
            present: true,
            dir: `/home/test/animastor/worker-${workerType}`,
            files: ['worker.cjs', 'worker-env.cjs', 'worker-cleanup.cjs', 'worker-cleanup-journal.cjs', 'package.json', 'package-lock.json', '.env.example'],
        },
        env: withEnv ? { present: true, set_keys: setKeys } : null,
    };
}

/** Fully working image environment (known-working reference config). */
function imageExistingEnv() {
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
        custom_nodes: [{ directory: 'ComfyUI-GGUF', commit: '6ea2651e7df66d7585f6ffee804b20e92fb38b8a' }],
        models: [
            { path: 'models/unet/qwen-image-2512-Q4_K_M.gguf', size_bytes: 13244758560 },
            { path: 'models/clip/Qwen2.5-VL-7B-Instruct-Q8_0.gguf', size_bytes: 8098523680 },
            { path: 'models/vae/qwen_image_vae.safetensors', size_bytes: 253806246, sha256: 'a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f' },
            { path: 'models/loras/Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0-bf16.safetensors', size_bytes: 1179883224 },
        ],
        python_packages: [],
        workflows: [{ path: 'user/default/workflows/animastor/image/img-qwen-image.json', sha256: IMAGE_WF_HASH }],
        worker: workerProbe('image'),
    };
}

/** Video env with an OLDER ComfyUI than the manifest minimum (v0.27.0). */
function videoOldComfyEnv() {
    return {
        root: '/home/video/ComfyUI',
        comfyui: {
            present: true,
            repository: 'https://github.com/comfyanonymous/ComfyUI.git',
            tag: 'v0.26.0',
            version: '0.26.0',
            commit: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
        },
        python: { version: '3.10.12' },
        torch: { version: '2.6.0+cu124' },
        nodejs: { version: '20.11.1' },
        gpu: { name: 'NVIDIA L40S', vram_mib: 46068 },
        custom_nodes: [
            { directory: 'ComfyUI-GGUF', is_git: false },
            { directory: 'comfyui-kjnodes', is_git: false },
        ],
        models: [
            { path: 'models/unet/LTX-2.3-22B-distilled-1.1-Q4_K_M.gguf', size_bytes: 17763015328 },
            { path: 'models/text_encoders/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf', size_bytes: 7432229248 },
            { path: 'models/text_encoders/ltx-2.3_text_projection_bf16.safetensors', size_bytes: 2312149072 },
            { path: 'models/loras/ltx-2-19b-ic-lora-detailer.safetensors', size_bytes: 2617401920 },
            { path: 'models/vae/ltx-2.3-22b-dev_video_vae.safetensors', size_bytes: 1452258578 },
            { path: 'models/vae/ltx-2.3-22b-dev_audio_vae.safetensors', size_bytes: 364855188 },
            { path: 'models/vae/taeltx2_3.safetensors', size_bytes: 23531296 },
        ],
        python_packages: [{ name: 'gguf', version: '0.14.0' }],
        workflows: [],
        worker: null,
    };
}

describe('Phase 1.5 — installer scenarios', () => {
    // ── 1–3: clean machine per profile ────────────────────────────────────

    describe('scenario 1: clean machine + Image', () => {
        it('plans runtime, node, models, baseline workflow and worker installs', () => {
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: resolver.createEmptyEnvironment(), mode: 'managed' });
            expect(r.summary.missing_required).to.equal(11);
            expect(entry(r, 'workflow:img-qwen-image').status).to.equal('missing');
            expect(entry(r, 'workflow:img-qwen-image').expected.path)
                .to.equal('user/default/workflows/animastor/image/img-qwen-image.json');
            expect(entry(r, 'worker:image/qwen-image').status).to.equal('missing');
            const plan = planBuilder.buildInstallPlan({ report: r, manifests: [IMAGE()] });
            expect(plan.plan_text).to.match(/Missing:/);
            expect(plan.plan_text).to.match(/Qwen Image \(baseline workflow\)/);
            expect(plan.plan_text).to.match(/Continue\?/);
            assertNeverDestructive(r);
        });
    });

    describe('scenario 2: clean machine + Video', () => {
        it('plans all four LTX baseline workflows among required installs', () => {
            const r = resolver.resolveInstallation({ manifests: [VIDEO()], environment: resolver.createEmptyEnvironment(), mode: 'managed' });
            expect(r.summary.missing_required).to.equal(19);
            const wfIds = r.entries.filter((e) => e.kind === 'workflow').map((e) => e.id).sort();
            expect(wfIds).to.deep.equal(['workflow:video-ltx-1p', 'workflow:video-ltx-2p', 'workflow:video-ltx-3p', 'workflow:video-ltx-4p']);
            expect(r.summary.by_kind.worker).to.equal(1);
            assertNeverDestructive(r);
        });
    });

    describe('scenario 3: clean machine + Audio', () => {
        it('plans narrator + dialogue baseline workflows and the audio worker', () => {
            const r = resolver.resolveInstallation({ manifests: [AUDIO()], environment: resolver.createEmptyEnvironment(), mode: 'managed' });
            expect(r.summary.missing_required).to.equal(10);
            expect(entry(r, 'workflow:tts-qwen-narrator').action).to.equal('install');
            expect(entry(r, 'workflow:tts-qwen-dialogue').action).to.equal('install');
            expect(entry(r, 'worker:audio/qwen-tts').status).to.equal('missing');
            assertNeverDestructive(r);
        });
    });

    // ── 4: existing compatible ComfyUI ────────────────────────────────────

    describe('scenario 4: existing compatible ComfyUI', () => {
        it('detects, compares and accepts the user environment without changes', () => {
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: imageExistingEnv(), mode: 'existing' });
            expect(r.mode).to.equal('existing');
            expect(r.summary.missing_required).to.equal(0);
            expect(r.summary.by_status.incompatible).to.equal(0);
            expect(entry(r, 'runtime:comfyui').grade).to.equal('reference');
            expect(entry(r, 'workflow:img-qwen-image').grade).to.equal('canonical-baseline');
            expect(entry(r, 'worker:image/qwen-image').grade).to.equal('configured');
            expect(r.summary.install_plan).to.deep.equal([]);
            expect(r.summary.configure_plan).to.deep.equal([]);
            assertNeverDestructive(r);
        });
    });

    // ── 5–6: existing OLDER ComfyUI — user decides ────────────────────────

    describe('scenario 5: existing older ComfyUI → user chooses Update', () => {
        it('offers the update; with consent it becomes a confirmed destructive op', () => {
            const r = resolver.resolveInstallation({ manifests: [VIDEO()], environment: videoOldComfyEnv(), mode: 'existing' });
            const comfy = entry(r, 'runtime:comfyui');
            expect(comfy.status).to.equal('incompatible');
            expect(comfy.reason).to.equal('below_minimum');
            expect(comfy.action).to.equal('review'); // never automatic

            const plan = planBuilder.buildInstallPlan({ report: r, manifests: [VIDEO()], decisions: { comfyui_update: 'yes' } });
            const step = plan.steps.find((s) => s.id === 'comfyui-update');
            expect(step.prompt.question).to.match(/ComfyUI 0\.26\.0 detected/);
            expect(step.prompt.question).to.match(/Recommended version/);
            expect(step.prompt.options).to.deep.equal(['Yes', 'No']);
            expect(step.decision).to.equal('yes');
            expect(step.action.op).to.equal('update_comfyui');
            expect(step.action.destructive).to.be.true;
            expect(step.action.allowed).to.be.true;
            expect(plan.confirmed_operations.map((o) => o.op)).to.include('update_comfyui');
            // still nothing destructive is PLANNED automatically
            expect(plan.destructive_operations).to.be.an('array').that.is.empty;
            assertNeverDestructive(r);
        });
    });

    describe('scenario 6: existing older ComfyUI → user chooses Keep', () => {
        it('declining the required update aborts the plan; nothing is changed', () => {
            const r = resolver.resolveInstallation({ manifests: [VIDEO()], environment: videoOldComfyEnv(), mode: 'existing' });
            const plan = planBuilder.buildInstallPlan({ report: r, manifests: [VIDEO()], decisions: { comfyui_update: 'no' } });
            const step = plan.steps.find((s) => s.id === 'comfyui-update');
            expect(step.decision).to.equal('no');
            expect(step.abort).to.be.true;
            expect(step.abort_reason).to.match(/declined/);
            expect(plan.blocked.map((b) => b.step)).to.include('comfyui-update');
            expect(plan.complete).to.be.false;
            expect(plan.safe_to_proceed).to.be.false;
            expect(plan.confirmed_operations).to.deep.equal([]);
            assertNeverDestructive(r);
        });
    });

    // ── 7–9: missing components ───────────────────────────────────────────

    describe('scenario 7: missing custom node', () => {
        it('flags only the missing node and plans exactly its install', () => {
            const env = imageExistingEnv();
            env.custom_nodes = [];
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            const node = entry(r, 'custom-node:comfyui-gguf');
            expect(node.status).to.equal('missing');
            expect(node.action).to.equal('install');
            expect(r.summary.missing_required).to.equal(1);
            expect(r.summary.install_plan).to.deep.equal(['custom-node:comfyui-gguf']);
            assertNeverDestructive(r);
        });
    });

    describe('scenario 8: missing model', () => {
        it('flags the missing model; download plan refuses to invent a URL (D5 open)', () => {
            const env = imageExistingEnv();
            env.models = env.models.filter((m) => !m.path.includes('Wuli-Qwen-Image'));
            const m = IMAGE();
            const r = resolver.resolveInstallation({ manifests: [m], environment: env, mode: 'existing' });
            const id = 'model:image.loras.wuli-qwen-image-2512-turbo-4steps';
            expect(entry(r, id).status).to.equal('missing');
            expect(r.summary.install_plan).to.deep.equal([id]);

            const specs = downloads.planModelDownloads(m, [id]);
            expect(specs).to.have.length(1);
            expect(specs[0].ready).to.be.true; // source researched — URL available
            expect(specs[0].url).to.be.a('string').that.includes('huggingface.co');
            assertNeverDestructive(r);
        });
    });

    describe('scenario 9: missing workflow', () => {
        it('flags the missing baseline workflow and offers to download it', () => {
            const env = imageExistingEnv();
            env.workflows = [];
            const m = IMAGE();
            const r = resolver.resolveInstallation({ manifests: [m], environment: env, mode: 'existing' });
            const wf = entry(r, 'workflow:img-qwen-image');
            expect(wf.status).to.equal('missing');
            expect(wf.action).to.equal('install');
            expect(wf.notes.join(' ')).to.match(/never touches existing user workflows/);
            expect(r.summary.missing_required).to.equal(1);

            const plans = workflows.planWorkflowDownloads(m, env, 'all');
            expect(plans).to.have.length(1);
            expect(plans[0].target_path).to.equal('user/default/workflows/animastor/image/img-qwen-image.json');
            expect(plans[0].overwrite).to.be.false;

            const plan = planBuilder.buildInstallPlan({ report: r, manifests: [m], decisions: { workflows: 'all' } });
            const step = plan.steps.find((s) => s.id === 'workflows');
            expect(step.decision).to.equal('all');
            expect(step.action.op).to.equal('download_workflows');
            expect(step.action.never_overwrites).to.be.true;
            assertNeverDestructive(r);
        });

        it('user may select which baselines to download (video 1P+3P only)', () => {
            const m = VIDEO();
            const env = resolver.createEmptyEnvironment();
            const r = resolver.resolveInstallation({ manifests: [m], environment: env, mode: 'managed' });
            const plan = planBuilder.buildInstallPlan({
                report: r,
                manifests: [m],
                decisions: { workflows: ['workflow:video-ltx-1p', 'workflow:video-ltx-3p'] },
            });
            const step = plan.steps.find((s) => s.id === 'workflows');
            const ids = step.action.items.map((i) => i.id).sort();
            expect(ids).to.deep.equal(['workflow:video-ltx-1p', 'workflow:video-ltx-3p']);
        });
    });

    // ── 10: existing customized workflow ──────────────────────────────────

    describe('scenario 10: existing customized workflow', () => {
        it('a customized baseline is ALLOWED — installed/customized, never overwritten', () => {
            const env = imageExistingEnv();
            env.workflows = [{ path: 'user/default/workflows/animastor/image/img-qwen-image.json', sha256: `deadbeef${'0'.repeat(56)}` }];
            const m = IMAGE();
            const r = resolver.resolveInstallation({ manifests: [m], environment: env, mode: 'existing' });
            const wf = entry(r, 'workflow:img-qwen-image');
            expect(wf.status).to.equal('installed'); // NOT an error
            expect(wf.grade).to.equal('customized');
            expect(wf.action).to.equal('skip');
            expect(wf.notes.join(' ')).to.match(/NEVER overwritten/);
            expect(r.summary.missing_required).to.equal(0);
            expect(r.summary.customized_workflows).to.deep.equal(['workflow:img-qwen-image']);

            // no download is planned for the customized file…
            const plans = workflows.planWorkflowDownloads(m, env, 'all');
            expect(plans).to.deep.equal([]);

            // …unless the user explicitly asks for a fresh official copy —
            // which goes to a DISTINCT path, leaving the user copy untouched
            const restore = workflows.planWorkflowDownloads(m, env, 'all', { restoreBaseline: true });
            expect(restore).to.have.length(1);
            expect(restore[0].fresh_copy).to.be.true;
            expect(restore[0].target_path).to.equal('user/default/workflows/animastor/image/img-qwen-image.animastor-baseline.json');
            expect(restore[0].overwrite).to.be.false;

            // plan rendering marks it as kept, not missing
            const plan = planBuilder.buildInstallPlan({ report: r, manifests: [m] });
            expect(plan.plan_text).to.match(/customized by user — kept/);
            assertNeverDestructive(r);
        });

        it('user workflows outside the baseline paths are reported, never touched', () => {
            const env = imageExistingEnv();
            env.workflows.push({ path: 'user/default/workflows/my-own-experiment.json' });
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            const extra = entry(r, 'extra:workflow:user/default/workflows/my-own-experiment.json');
            expect(extra.status).to.equal('unused');
            expect(extra.action).to.equal('none');
            expect(extra.notes.join(' ')).to.match(/NEVER modified/);
            assertNeverDestructive(r);
        });
    });

    // ── 11–12: shared runtime ─────────────────────────────────────────────

    describe('scenario 11: two profiles with compatible shared runtime', () => {
        it('audio + image share one ComfyUI; dependency union is resolved', () => {
            const s = resolver.resolveSharedRuntime([AUDIO(), IMAGE()]);
            expect(s.verdict).to.equal('shared-compatible');
            expect(s.can_share).to.be.true;
            expect(s.union.custom_nodes).to.include('custom-node:comfyui-qwen3-tts');
            expect(s.union.custom_nodes).to.include('custom-node:comfyui-gguf');

            const env = imageExistingEnv();
            env.custom_nodes.push({ directory: 'qwen3-tts', commit: '2ee1131' });
            env.models.push(
                { path: 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/model.safetensors', size_bytes: 3833258312 },
                { path: 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/speech_tokenizer/model.safetensors', size_bytes: 682297917 },
                { path: 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-Base/model.safetensors', size_bytes: 3854733148 },
                { path: 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-Base/speech_tokenizer/model.safetensors', size_bytes: 682297917 }
            );
            env.workflows.push(
                { path: 'user/default/workflows/animastor/audio/tts-qwen-narrator.json', sha256: '87180aee01288be6e23240b2d873ce2d451f63cf404dec331a3b221bb9f8b8c1' },
                { path: 'user/default/workflows/animastor/audio/tts-qwen-dialogue.json', sha256: '7dcdc6997d36aaeb1a54e1578c69f0c534be29698c7a7b48813f637c740e69db' }
            );
            env.worker = [env.worker, workerProbe('audio')];
            const r = resolver.resolveInstallation({ manifests: [AUDIO(), IMAGE()], environment: env, mode: 'shared' });
            expect(r.sharing.can_share).to.be.true;
            expect(r.summary.missing_required).to.equal(0);
            assertNeverDestructive(r);
        });
    });

    describe('scenario 12: two profiles with conflicting runtime', () => {
        it('torch pin conflict → shared-conflict; the plan blocks with an isolation recommendation', () => {
            const s = resolver.resolveSharedRuntime([AUDIO(), VIDEO()]);
            expect(s.verdict).to.equal('requires-isolation');
            expect(s.can_share).to.be.false;
            expect(s.message).to.match(/cannot safely share/);

            const r = resolver.resolveInstallation({
                manifests: [AUDIO(), VIDEO()],
                environment: resolver.createEmptyEnvironment(),
                mode: 'shared',
            });
            const plan = planBuilder.buildInstallPlan({ report: r, manifests: [AUDIO(), VIDEO()] });
            expect(plan.blocked.map((b) => b.reason)).to.include('Profiles cannot safely share this ComfyUI runtime. Isolation recommended.');
            expect(plan.safe_to_proceed).to.be.false;
            // no automatic split in this phase — only the recommendation
            expect(plan.plan_text).to.match(/Isolation recommended/);
            assertNeverDestructive(r);
        });
    });

    // ── 13: existing unknown dependency ───────────────────────────────────

    describe('scenario 13: existing unknown dependency', () => {
        it('unknown node/model/workflow are reported and left untouched', () => {
            const env = imageExistingEnv();
            env.custom_nodes.push({ directory: 'mystery-node', is_git: false });
            env.models.push({ path: 'models/checkpoints/random-thing.safetensors', size_bytes: 123 });
            env.workflows.push({ path: 'somewhere/else/odd-workflow.json' });
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            expect(entry(r, 'extra:custom-node:mystery-node').status).to.equal('unknown');
            expect(entry(r, 'extra:custom-node:mystery-node').action).to.equal('none');
            expect(entry(r, 'extra:model:models/checkpoints/random-thing.safetensors').status).to.equal('unknown');
            expect(entry(r, 'extra:workflow:somewhere/else/odd-workflow.json').status).to.equal('unknown');
            expect(entry(r, 'extra:workflow:somewhere/else/odd-workflow.json').action).to.equal('none');
            assertNeverDestructive(r);
        });
    });

    // ── 14: worker setup ──────────────────────────────────────────────────

    describe('scenario 14: worker setup', () => {
        it('missing bundle → install; bundle without .env → configure; complete → skip', () => {
            // (a) nothing installed
            let env = imageExistingEnv();
            env.worker = null;
            let r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            let w = entry(r, 'worker:image/qwen-image');
            expect(w.status).to.equal('missing');
            expect(w.action).to.equal('install');

            // (b) bundle present, no .env
            env = imageExistingEnv();
            env.worker = workerProbe('image', { withEnv: false });
            r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            w = entry(r, 'worker:image/qwen-image');
            expect(w.status).to.equal('installed');
            expect(w.action).to.equal('configure');
            expect(w.env.missing_required).to.include('ANIMASTOR_WORKER_TOKEN');
            expect(r.summary.configure_plan).to.deep.equal(['worker:image/qwen-image']);

            // (c) .env exists but the key is missing → configure names the missing KEY only
            env = imageExistingEnv();
            env.worker = workerProbe('image', { setKeys: ['HUB_URL', 'WORKER_TYPE', 'WORKER_ID'] });
            r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            w = entry(r, 'worker:image/qwen-image');
            expect(w.action).to.equal('configure');
            expect(w.env.missing_required).to.deep.equal(['ANIMASTOR_WORKER_TOKEN']);
            expect(w.notes.join(' ')).to.match(/hidden input/);

            // (d) incomplete bundle file set → incompatible/incomplete
            env = imageExistingEnv();
            env.worker = workerProbe('image');
            env.worker.bundle.files = ['worker.cjs'];
            r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            w = entry(r, 'worker:image/qwen-image');
            expect(w.status).to.equal('incompatible');
            expect(w.reason).to.equal('incomplete_bundle');

            // (e) fully configured → skip
            r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: imageExistingEnv(), mode: 'existing' });
            w = entry(r, 'worker:image/qwen-image');
            expect(w.status).to.equal('installed');
            expect(w.grade).to.equal('configured');
            expect(w.action).to.equal('skip');

            assertNeverDestructive(r);
        });

        it('plan includes worker-setup and worker-key steps; key step records only a boolean flag', () => {
            const env = imageExistingEnv();
            env.worker = workerProbe('image', { setKeys: ['HUB_URL', 'WORKER_TYPE', 'WORKER_ID'] });
            const m = IMAGE();
            const r = resolver.resolveInstallation({ manifests: [m], environment: env, mode: 'existing' });
            let plan = planBuilder.buildInstallPlan({ report: r, manifests: [m] });
            const keyStep = plan.steps.find((s) => s.id === 'worker-key');
            expect(keyStep).to.be.an('object');
            expect(keyStep.kind).to.equal('secret-prompt');
            expect(keyStep.secret_keys).to.deep.equal(['ANIMASTOR_WORKER_TOKEN']);
            expect(keyStep.awaiting_decision).to.be.true;
            expect(keyStep.rules.join(' ')).to.match(/never printed to logs/);
            expect(keyStep.rules.join(' ')).to.match(/never passed via command-line/);

            plan = planBuilder.buildInstallPlan({ report: r, manifests: [m], decisions: { worker_setup: true, worker_key_provided: true } });
            const done = plan.steps.find((s) => s.id === 'worker-key');
            expect(done.provided).to.be.true; // boolean flag ONLY
            expect(JSON.stringify(plan)).to.not.include('wrk.');
            // canonical 12-step flow order is preserved
            const ids = plan.steps.map((s) => s.id);
            expect(ids.indexOf('worker-setup')).to.be.below(ids.indexOf('worker-key'));
            expect(ids.indexOf('worker-key')).to.be.below(ids.indexOf('verify'));
        });
    });

    // ── 15: worker secret never appears in logs ───────────────────────────

    describe('scenario 15: worker secret never appears in logs', () => {
        const SECRET_VALUE = 'wrk.1234.super-secret-value-xyz';

        it('report, plan and verification text contain no secret value', () => {
            const env = imageExistingEnv();
            // the probe models what a real prober may know: key NAMES + a flag.
            // Even if the caller somehow embeds the value in its own memory,
            // nothing below accepts values — only set_keys.
            env.worker.env.set_keys = ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'];
            const m = IMAGE();
            const r = resolver.resolveInstallation({ manifests: [m], environment: env, mode: 'existing' });
            const plan = planBuilder.buildInstallPlan({
                report: r,
                manifests: [m],
                decisions: { worker_setup: true, worker_key_provided: true },
            });
            const ver = verification.buildVerificationReport({ report: r });

            for (const artifact of [JSON.stringify(r), JSON.stringify(plan), plan.plan_text, ver.text, JSON.stringify(ver)]) {
                expect(artifact).to.not.include(SECRET_VALUE);
                expect(artifact).to.not.include('super-secret-value');
            }
            // worker entries carry key names only — no values structure at all
            const w = entry(r, 'worker:image/qwen-image');
            expect(w.env.values).to.be.undefined;
            safety.assertSafeReport(r);
        });

        it('redactSecrets masks secret values and KEY=value lines (defense in depth)', () => {
            const out = safety.redactSecrets(
                `connecting with ${SECRET_VALUE} now\nANIMASTOR_WORKER_TOKEN=${SECRET_VALUE}\nHF_TOKEN=hf-abc123\nnormal line`,
                [SECRET_VALUE]
            );
            expect(out).to.not.include(SECRET_VALUE);
            expect(out).to.not.include('hf-abc123');
            expect(out).to.include('ANIMASTOR_WORKER_TOKEN=<REDACTED>');
            expect(out).to.include('normal line');
        });

        it('safety model: destructive ops are never automatic; some are forbidden outright', () => {
            for (const op of ['delete_model', 'delete_custom_node', 'delete_workflow', 'replace_user_workflow',
                'downgrade_torch', 'change_cuda', 'destroy_python_environment', 'overwrite_env_token']) {
                const gate = safety.confirmationGate(op, { confirmed: true, op });
                expect(gate.allowed, op).to.be.false;
                expect(gate.reason).to.match(/forbidden/);
            }
            // consent-gated ops require an explicit matching confirmation
            expect(safety.confirmationGate('update_comfyui').allowed).to.be.false;
            expect(safety.confirmationGate('update_comfyui', { confirmed: true, op: 'update_comfyui' }).allowed).to.be.true;
            expect(safety.confirmationGate('downgrade_comfyui', { confirmed: true, op: 'downgrade_comfyui' }).allowed).to.be.true;
            expect(safety.confirmationGate('unknown_op', { confirmed: true, op: 'unknown_op' }).allowed).to.be.false;
        });
    });

    // ── Supporting Phase 1.5 mechanics ────────────────────────────────────

    describe('download planner (no real downloads)', () => {
        it('fully-researched huggingface models produce resumable download specs', () => {
            const m = IMAGE();
            const missing = m.dependencies.filter((d) => d.kind === 'model').map((d) => d.id);
            const specs = downloads.planModelDownloads(m, missing);
            expect(specs).to.have.length(4);
            for (const s of specs) {
                expect(s.ready).to.be.true; // sources researched
                expect(s.url).to.be.a('string').that.includes('huggingface.co');
                expect(s.idempotent_skip).to.be.true;
            }
            const est = downloads.estimateMissingBytes(specs);
            expect(est.total_bytes).to.be.greaterThan(20 * 1024 * 1024 * 1024); // ≈21 GiB from verified sizes
        });

        it('modelscope repos with installer_preload produce resumable download specs', () => {
            const m = AUDIO();
            const specs = downloads.planModelDownloads(m, ['model-repo:qwen3-tts-12hz-1.7b-voicedesign']);
            expect(specs).to.have.length(1);
            expect(specs[0].kind).to.equal('modelscope');
            expect(specs[0].ready).to.be.true; // D2 closed: installer preloads
            expect(specs[0].url).to.include('modelscope.cn');
        });

        it('a fully-researched huggingface source produces a resumable spec', () => {
            const spec = downloads.planModelDownload({
                id: 'model:test',
                kind: 'model',
                filename: 'test.safetensors',
                target_dir: 'models/unet',
                size_bytes_approx: 1000,
                checksum: { algo: 'sha256', value: 'ab'.repeat(32) },
                source: { kind: 'huggingface', repository: 'org/repo', revision: 'v1', file_path: 'test.safetensors', verification: 'confirmed' },
            });
            expect(spec.ready).to.be.true;
            expect(spec.url).to.equal('https://huggingface.co/org/repo/resolve/v1/test.safetensors');
            expect(spec.resume).to.equal('http-range');
            expect(spec.part_path).to.equal('models/unet/test.safetensors.part');
        });
    });

    describe('verification report', () => {
        it('fully verified environment with live checks → INSTALLATION COMPLETE (WARN only for the unknown VRAM minimum)', () => {
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: imageExistingEnv(), mode: 'existing' });
            const ver = verification.buildVerificationReport({
                report: r,
                live: {
                    comfyui: { running: true, api_reachable: true },
                    workflow: { accepted: true },
                    worker: { process_alive: true, registered: true, health: true },
                    hub: { connection: true, registration: true },
                },
            });
            // minimum VRAM is an open question (manifest hardware.gpu_min_vram_gb=null)
            // → honest WARN, never a silent PASS and never a FAIL
            expect(ver.status).to.equal('WARN');
            expect(ver.fails).to.equal(0);
            expect(ver.text).to.match(/INSTALLATION COMPLETE WITH WARNINGS/);
            expect(ver.text).to.match(/! VRAM — minimum unknown/);
            for (const label of ['GPU', 'ComfyUI', 'Runtime', 'Custom Nodes', 'Models', 'Workflows', 'Worker', 'GPU Hub registration']) {
                expect(ver.text).to.match(new RegExp(`\u2713 ${label}`));
            }
        });

        it('missing model and unconfigured worker → precise FAIL lines', () => {
            const env = imageExistingEnv();
            env.models = env.models.filter((m) => !m.path.includes('qwen_image_vae'));
            env.worker = workerProbe('image', { setKeys: ['HUB_URL', 'WORKER_TYPE', 'WORKER_ID'] });
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            const ver = verification.buildVerificationReport({ report: r });
            expect(ver.status).to.equal('FAIL');
            expect(ver.text).to.match(/INSTALLATION INCOMPLETE/);
            expect(ver.text).to.match(/\u2717 Models — qwen_image_vae\.safetensors: missing/);
            expect(ver.text).to.match(/\u2717 Worker \.env \/ Worker Key — configuration incomplete: ANIMASTOR_WORKER_TOKEN/);
        });

        it('customized workflow is not a failure', () => {
            const env = imageExistingEnv();
            env.workflows = [{ path: 'user/default/workflows/animastor/image/img-qwen-image.json', sha256: `beef${'0'.repeat(60)}` }];
            const r = resolver.resolveInstallation({ manifests: [IMAGE()], environment: env, mode: 'existing' });
            const ver = verification.buildVerificationReport({
                report: r,
                live: {
                    comfyui: { running: true, api_reachable: true },
                    workflow: { accepted: true },
                    worker: { process_alive: true, registered: true },
                    hub: { connection: true, registration: true },
                },
            });
            expect(ver.fails).to.equal(0); // customized baseline is allowed — not a failure
            expect(ver.text).to.match(/INSTALLATION COMPLETE/);
            expect(ver.text).to.match(/1 customized by user \(allowed\)/);
        });
    });

    describe('interactive plan shape', () => {
        it('follows the canonical 12-step flow and renders Detected/Missing/Actions', () => {
            const m = IMAGE();
            const env = resolver.createEmptyEnvironment();
            env.gpu = { name: 'NVIDIA L40S', vram_mib: 46068 };
            const r = resolver.resolveInstallation({ manifests: [m], environment: env, mode: 'managed' });
            const plan = planBuilder.buildInstallPlan({ report: r, manifests: [m] });
            const ids = plan.steps.map((s) => s.id);
            expect(ids).to.deep.equal(planBuilder.FLOW_STEPS.slice()); // all 12 steps, canonical order
            expect(plan.plan_text).to.match(/Detected:/);
            expect(plan.plan_text).to.match(/Missing:/);
            expect(plan.plan_text).to.match(/Actions:/);
            expect(plan.awaiting_decisions).to.include.members(['custom-nodes', 'models', 'workflows', 'worker-setup', 'worker-key']);
            expect(plan.complete).to.be.false;
        });

        it('with all decisions recorded the plan completes and stays non-destructive', () => {
            const m = IMAGE();
            const r = resolver.resolveInstallation({ manifests: [m], environment: resolver.createEmptyEnvironment(), mode: 'managed' });
            const plan = planBuilder.buildInstallPlan({
                report: r,
                manifests: [m],
                decisions: {
                    accept_reference_runtime: true,
                    install_custom_nodes: true,
                    install_models: true,
                    workflows: 'all',
                    worker_setup: true,
                    worker_key_provided: true,
                },
            });
            expect(plan.awaiting_decisions).to.deep.equal([]);
            expect(plan.complete).to.be.true;
            expect(plan.destructive_operations).to.be.an('array').that.is.empty;
        });
    });
});
