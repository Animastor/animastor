// ======================================================
// Generation Provider Seam — regression tests (S-3)
// ======================================================
// Behavior regression coverage for the S-3 seam migration: all media
// executors dispatch through generation/comfyui-provider.generate —
// these tests pin the contract the executors rely on:
//
//   T1  provider dispatch          — generate() → sendUnified payload 1:1
//   T2  job payload preservation   — extra fields (assets, workflow_name,
//                                  unit_ids, timeout_ms) pass through
//                                  verbatim (video jobSpec path)
//   T3  error propagation          — {sent:false,error} returned as-is;
//                                  transport throws propagate to the caller
//   T4  unknown/invalid response   — malformed specs hit the frozen
//                                  sendUnified validation (Job Protocol v2)
//   T5  cancellation               — cancellation does NOT pass through the
//                                  provider: it is owned by the dispatch
//                                  engine (marker lifecycle + Hub queue
//                                  clear). Guarded by a surface assertion.
//   T6  semantic binding API       — applyValue / assembleMergedDialogue
//                                  produce byte-identical node inputs to
//                                  the pre-S-3 executor logic
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md (§S-3)

const { expect } = require('chai');
const path = require('path');

const provider = require('@animastor/generation').comfyuiProvider;
const gpuDispatcher = require('../src/runtime/gpu-dispatcher');
const wfLoader = require('animastor-comfyui-workflow-connector').workflowLoader;

// Load the real workflows/connectors (host-injected dirs, like backend.cjs)
before(() => {
    wfLoader.configure({
        workflowsDir: path.join(__dirname, '../ai/workflows'),
        connectorsDir: path.join(__dirname, '../ai/connectors'),
    });
    wfLoader.loadWorkflows();
});

// ======================================================
// T1/T2/T3 — dispatch contract (captured transport)
// ======================================================
// The sendUnified capture stub is scoped INSIDE this describe block — a
// top-level hook would leak the stub into other test files.
describe('generation provider seam (captured transport)', () => {
    let captured;
    let originalSendUnified;

    beforeEach(() => {
        captured = [];
        originalSendUnified = gpuDispatcher.sendUnified;
        gpuDispatcher.sendUnified = async (spec) => {
            captured.push(spec);
            return { sent: true, jobId: spec.job_id, dispatchId: spec.dispatch_id };
        };
    });

    afterEach(() => {
        gpuDispatcher.sendUnified = originalSendUnified;
    });

    // ── T1 — provider dispatch ──
    it('maps the camelCase request to the v2 task spec exactly (no stray keys)', async () => {
        const result = await provider.generate({
            jobId: 'book_ch1_sc1_0001:audio',
            workflow: { '108': { inputs: {} } },
            jobType: 'audio',
            buildId: 'build-1',
            dispatchId: 'dispatch-1',
        });
        expect(result).to.deep.equal({ sent: true, jobId: 'book_ch1_sc1_0001:audio', dispatchId: 'dispatch-1' });
        expect(captured).to.have.length(1);
        expect(captured[0]).to.deep.equal({
            job_id: 'book_ch1_sc1_0001:audio',
            params: { '108': { inputs: {} } },
            job_type: 'audio',
            build_id: 'build-1',
            dispatch_id: 'dispatch-1',
        });
    });

    it('dispatches the iu_image job kind through the same seam', async () => {
        await provider.generate({
            jobId: provider.buildJobId('book_ch1_sc1_iu-1', 'iu_image'),
            workflow: {},
            jobType: 'image',
            buildId: 'b',
            dispatchId: 'd',
        });
        expect(captured[0].job_type).to.equal('image');
        expect(captured[0].job_id.endsWith(':iu_image')).to.equal(true);
    });

    // ── T2 — job payload preservation (video jobSpec passthrough) ──
    it('forwards assets, workflow_name, unit_ids and timeout_ms verbatim', async () => {
        const jobSpec = {
            job_id: 'book_ch1_sc1_g1:video',
            params: { '1': { class_type: 'LTXV' } },
            job_type: 'video',
            assets: { images: { 'iu-1': 'aGVsbG8=' } },
            build_id: 'build-1',
            dispatch_id: 'dispatch-1',
            workflow_name: 'video-ltx-2p',
            unit_ids: ['iu-1', 'iu-2'],
            timeout_ms: 123456,
        };
        await provider.generate(jobSpec);
        expect(captured[0]).to.deep.equal(jobSpec);
    });

    it('camelCase timeoutMs maps to timeout_ms without touching an explicit timeout_ms', async () => {
        await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b', dispatchId: 'd', timeoutMs: 42 });
        expect(captured[0].timeout_ms).to.equal(42);

        await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b', dispatchId: 'd', timeout_ms: 99, timeoutMs: 42 });
        expect(captured[1].timeout_ms).to.equal(99);
    });

    it('camelCase sugar keys never reach the wire payload', async () => {
        await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b', dispatchId: 'd' });
        expect(captured[0]).to.not.have.any.keys(['jobId', 'workflow', 'jobType', 'buildId', 'dispatchId', 'timeoutMs']);
    });

    // ── T3 — error propagation ──
    it('{sent:false, error} from the transport is returned unchanged', async () => {
        gpuDispatcher.sendUnified = async () => ({ sent: false, error: 'hub_down' });
        const result = await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b', dispatchId: 'd' });
        expect(result).to.deep.equal({ sent: false, error: 'hub_down' });
    });

    it('transport throws propagate to the caller (marker cleanup semantics preserved)', async () => {
        gpuDispatcher.sendUnified = async () => { throw new Error('hub_unreachable'); };
        let err;
        try {
            await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b', dispatchId: 'd' });
        } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.equal('hub_unreachable');
    });
});

// ======================================================
// T4 — unknown/invalid request handling
// ======================================================
// NOTE: these cases exercise the provider passthrough; the dispatcher
// validation runs against the REAL gpu-dispatcher (no stub) since it is
// part of the frozen Job Protocol surface the provider rides.
describe('provider invalid request handling (frozen dispatcher validation)', () => {
    it('missing dispatch_id hits the sendUnified validation (dispatch_id is required)', async () => {
        let err;
        try {
            await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b' });
        } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.include('dispatch_id is required');
    });

    it('unknown job_type hits the frozen dispatcher validation (Invalid job type)', async () => {
        let err;
        try {
            await provider.generate({ jobId: 'b_c_s_x:audio', workflow: {}, jobType: 'unknown_media', buildId: 'b', dispatchId: 'd' });
        } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.include('Invalid job type');
    });
});

// ======================================================
// T5 — cancellation surface
// ======================================================
describe('cancellation does not pass through the provider (S-3 decision)', () => {
    it('the provider exposes no cancel surface — cancellation is owned by the dispatch engine', () => {
        // Job cancellation flows: dispatch-engine markers/leases + Hub queue
        // clear (runtime HTTP) — deliberately OUTSIDE the provider seam.
        expect(provider).to.not.have.property('cancel');
    });
});

// ======================================================
// T6 — semantic binding API (byte-identical node inputs)
// ======================================================
describe('semantic binding API (connector-driven workflow assembly)', () => {
    it('applyValue patches the bound node field via the connector', () => {
        const wf = provider.loadWorkflow(provider.WORKFLOW_NAMES.narration);
        expect(provider.applyValue(wf, provider.WORKFLOW_NAMES.narration, 'narrationText', 'строка')).to.equal(true);
        expect(wf['108'].inputs.text).to.equal('строка');
    });

    it('applyValue returns false without a connector (hard invariant, not a recoverable state)', () => {
        expect(provider.applyValue({}, 'workflow-without-connector', 'anyKey', 1)).to.equal(false);
    });

    it('assembleMergedDialogueWorkflow reproduces the pre-S-3 node wiring (1 speaker)', () => {
        const wf = provider.assembleMergedDialogueWorkflow({
            script: 'berlioz: Привет.',
            defaultInstruct: 'instruct',
            speakers: [{ name: 'berlioz', voice: 'голос' }],
        });
        expect(wf['108'].inputs).to.deep.equal({ script: 'berlioz: Привет.', default_instruct: 'instruct' });
        expect(wf['71'].inputs.voice_instruction).to.equal('голос');
        // untouched slots keep their template values
        expect(wf['80'].inputs.voice_instruction).to.not.equal('голос');
        expect(wf['74'].inputs.role_name_1).to.equal('berlioz');
        expect(wf['74'].inputs.prompt_1).to.deep.equal(['73', 0]);
        expect(wf['74'].inputs.role_name_2).to.equal('Speaker2');
        expect(wf['74'].inputs.prompt_2).to.deep.equal(['81', 0]);
    });

    it('assembleMergedDialogueWorkflow wires all three slots (3 speakers, narrator fallback)', () => {
        const wf = provider.assembleMergedDialogueWorkflow({
            script: 'a: x\nb: y\nc: z',
            defaultInstruct: '',
            speakers: [
                { name: 'a', voice: 'va' },
                { name: 'b', voice: '' },   // empty voice → template default stays
                { name: 'c', voice: 'vc' },
            ],
        });
        expect(wf['71'].inputs.voice_instruction).to.equal('va');
        expect(wf['80'].inputs.voice_instruction).to.not.equal('');
        expect(wf['82'].inputs.voice_instruction).to.equal('vc');
        expect(wf['74'].inputs.role_name_1).to.equal('a');
        expect(wf['74'].inputs.role_name_2).to.equal('b');
        expect(wf['74'].inputs.role_name_3).to.equal('c');
        expect(wf['74'].inputs.prompt_3).to.deep.equal(['83', 0]);
    });

    it('profileNameFromConnector reads the per-type profile field', () => {
        expect(provider.profileNameFromConnector({ profile: { audioProfile: 'qwen-tts' } }, 'audio')).to.equal('qwen-tts');
        expect(provider.profileNameFromConnector({}, 'video')).to.equal(null);
    });
});
