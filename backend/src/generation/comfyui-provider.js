// ======================================================
// ComfyUIProvider — generation provider seam (S-3)
// ======================================================
// The SINGLE Generation → ComfyUI/GPU seam (S-3): media executors
// (audio/generation.js, image/iu-processor.js, video/video-service.js,
// orchestration/scene-orchestrator.js) depend on THIS semantic contract —
// they never touch the workflow-connector package or the GPU dispatcher
// directly.
//
//   Generation media executor
//       ↓
//   this provider contract (semantic: workflow names, entity keys, job spec)
//       ↓
//   animastor-comfyui-workflow-connector (workflow JSON + connectors)
//   generation/ports/dispatch-transport → runtime/gpu-dispatcher.sendUnified
//                                         (Job Protocol v2 → GPU Hub POST /task)
//       ↓
//   GPU Hub / Worker (external packages)
//
// ALL ComfyUI-specific knowledge of the generation domain is centralized
// here (S3-C/S3-D): workflow names, connector resolution, entity-key →
// node-id/field binding, workflow JSON assembly (merged dialogue RoleBank),
// and the dispatch transport call. Nothing in this module touches the LLM
// transports (agent callAI / chat SSE / connector WS / shared-pool).
//
// Cancellation deliberately does NOT pass through this seam: job
// cancellation is owned by the dispatch engine (marker/lease lifecycle +
// Hub queue clear) — documented residual seam (reconnaissance §9).
//
// Jobs built/dispatched here follow Job Protocol v2 (runtime/job-schema.js)
// — the payload semantics (job_id, params, job_type, build_id, dispatch_id,
// assets, timeout_ms, extra pass-through fields) are preserved 1:1 with the
// former direct gpu.send / gpu.sendUnified call sites.

const wfLoader = require('animastor-comfyui-workflow-connector').workflowLoader;
const connectorLoader = require('animastor-comfyui-workflow-connector').connectorLoader;
// Job Protocol v2 rides the frozen runtime/job-schema facade (Phase 9C: the
// facade is the single choke point into @animastor/contracts — a zero-logic
// re-export of the package, not a host implementation).
const jobSchema = require('../runtime/job-schema');
// S-6: dispatch goes through the Generation-owned DispatchTransport port —
// Core must not know the concrete gpu-dispatcher (the host adapter wires
// runtime/gpu-dispatcher.sendUnified behind the port at the composition
// root; routing policy stays host-side, reconnaissance §24.6).
const { dispatch } = require('./ports/dispatch-transport');

// ── provider identity ───────────────────────────────────────────────────
const PROVIDER_NAME = 'comfyui';

// Workflow names currently exercised by the generation domain (the same
// ids the workflow loader resolves from backend/ai/workflows/*.json).
// Media executors may SELECT a workflow by name (semantic knowledge) but
// must load/patch it only through this provider (S3-C).
const WORKFLOW_NAMES = {
    narration: 'tts-qwen-narrator',
    dialogue: 'tts-qwen-dialogue',
    image: 'img-qwen-image',
    videoFamily: 'video-ltx',
};

// ── workflow / connector knowledge ──────────────────────────────────────

/**
 * Load a fresh deep copy of a ComfyUI workflow by name.
 * Returns the workflow JSON (mutable clone — callers patch node inputs,
 * exactly as the workflow connector package's getWorkflow does today).
 * @param {string} name - workflow name (see WORKFLOW_NAMES)
 * @returns {object} workflow JSON clone
 * @throws when the workflow is not loaded
 */
function loadWorkflow(name) {
    return wfLoader.getWorkflow(name);
}

/** Resolve the ComfyUI connector (node-id/field mapping) for a workflow. */
function getConnector(name) {
    return wfLoader.getConnector(name);
}

/** Computed sha256 of the loaded workflow (installer/hub traceability). */
function getWorkflowHash(name) {
    return wfLoader.getWorkflowHash(name);
}

/** All loaded workflows (name → JSON). Callers must NOT patch these
 *  objects directly — take a mutable copy via loadWorkflow(name). */
function listWorkflows() {
    return wfLoader.workflows;
}

/**
 * Apply one entity value to a workflow via its connector binding
 * (entityKey → nodeId/field resolution — the ONLY node-id knowledge home).
 * Returns false when the connector is absent (connectors are mandatory at
 * startup — backend exits fatally without them — so this is a hard
 * invariant, not a recoverable state).
 * @param {object} workflow - mutable workflow clone (from loadWorkflow)
 * @param {string} workflowName - workflow name the connector is resolved for
 * @param {string} entityKey - semantic connector entity key (e.g. 'dialogueScript')
 * @param {*} value
 * @returns {boolean} applied
 */
function applyValue(workflow, workflowName, entityKey, value) {
    const connector = wfLoader.getConnector(workflowName);
    if (!connector) return false;
    return connectorLoader.setValue(workflow, connector, entityKey, value);
}

/** Resolve the node id bound to a connector entity key (video guide slots). */
function getNodeId(workflowName, entityKey) {
    const connector = wfLoader.getConnector(workflowName);
    if (!connector) return null;
    return connectorLoader.getNodeId(connector, entityKey);
}

/** Resolve the raw connector binding for an entity key (video guideStrength). */
function getBinding(workflowName, entityKey) {
    const connector = wfLoader.getConnector(workflowName);
    if (!connector) return null;
    return connectorLoader.getBinding(connector, entityKey);
}

/**
 * Extract the assembly-profile name for a media type from a connector
 * object (profile.{type}Profile). Pure helper; returns null when absent —
 * callers fall back to the built-in assembly (there is no 'default' profile).
 * @param {object|null} connector
 * @param {('audio'|'image'|'video')} type
 * @returns {string|null}
 */
function profileNameFromConnector(connector, type) {
    return connector?.profile?.[`${type}Profile`] || null;
}

// ── audio workflow assembly (merged dialogue) ───────────────────────────
// MOVED from audio/generation.js in S-3. This is the ONLY home of the
// merged-dialogue node knowledge: script processor node, per-speaker
// VoiceDesign nodes, RoleBank role_name_N / prompt_N wiring, and the
// VoiceClonePrompt node ids. Media executors pass SEMANTIC values only.

// Static topology of the tts-qwen-dialogue workflow (kept 1:1 with the
// pre-S-3 executor logic):
//   script node        108 (Qwen3TTSScriptProcessor)  — script + default_instruct
//   speaker slot 0/1/2  71/80/82 (Qwen3TTSVoiceDesign) — voice_instruction
//   RoleBank node       74 (Qwen3TTSRoleBank)          — role_name_N + prompt_N
//   clone prompt nodes  73/81/83 (Qwen3TTSVoiceClonePrompt) — prompt_N links [id, 0]
const MERGED_DIALOGUE_NODE_IDS = {
    script: '108',
    voiceDesign: ['71', '80', '82'],
    roleBank: '74',
    clonePrompt: [73, 81, 83],
};

/**
 * Assemble the merged dialogue workflow: N speakers (≤3) wired into the
 * dialogue RoleBank. Domain data (script, default instruct, speaker names
 * + voice instructions) arrives pre-resolved from the media executor.
 * @param {{script:string, defaultInstruct:string,
 *          speakers: Array<{name:string, voice:string}>}} spec
 * @returns {object|null} patched workflow clone, or null when the base
 *          workflow/connector is unavailable (connectors are mandatory at
 *          startup, so null is a hard-failure signal for the executor to
 *          fall back to per-segment dispatch)
 */
function assembleMergedDialogueWorkflow({ script, defaultInstruct, speakers }) {
    const wfAudio = loadWorkflow(WORKFLOW_NAMES.dialogue);
    if (!wfAudio) return null;
    if (!getConnector(WORKFLOW_NAMES.dialogue)) return null;

    // Script node: script + programmatic default instruct (from the active
    // audio assembly profile). Node 108 carries exactly these two inputs.
    wfAudio[MERGED_DIALOGUE_NODE_IDS.script].inputs = {
        script,
        default_instruct: defaultInstruct || ""
    };

    // Per-speaker wiring: voice instruction on the slot's VoiceDesign node;
    // role name + clone-prompt link on the RoleBank node.
    const { voiceDesign, roleBank, clonePrompt } = MERGED_DIALOGUE_NODE_IDS;
    for (let i = 0; i < speakers.length; i++) {
        const idx = i + 1;
        const speaker = speakers[i];
        // ComfyUI rejects an empty voice instruction — leave the template
        // default when no voice was resolved (executor logs the gap).
        if (speaker.voice) {
            wfAudio[voiceDesign[i]].inputs.voice_instruction = speaker.voice;
        }
        wfAudio[roleBank].inputs[`role_name_${idx}`] = speaker.name;
        wfAudio[roleBank].inputs[`prompt_${idx}`] = [String(clonePrompt[i]), 0];
    }
    return wfAudio;
}

// ── dispatch transport (the single Generation → GPU transport seam) ─────

/**
 * Dispatch a built ComfyUI workflow as a GPU Hub job (Job Protocol v2).
 * Accepts the semantic request shape:
 *   { jobId, workflow, jobType, buildId, dispatchId }          (camelCase)
 * and/or the v2 task-spec fields verbatim (job_id, params, job_type,
 * build_id, dispatch_id) plus pass-through fields (assets, timeout_ms,
 * workflow_name, unit_ids, …). Every extra field is forwarded unchanged —
 * payload semantics are 1:1 with the former direct gpu.send/sendUnified
 * call sites (S-3 payload preservation).
 * @returns {Promise<{sent:boolean, jobId?:string, dispatchId?:string, error?:string}>}
 */
async function generate(request) {
    const {
        // camelCase semantic sugar (stripped — never reaches the wire)
        jobId, workflow, jobType, buildId, dispatchId, timeoutMs,
        // everything else passes through verbatim (payload preservation)
        ...extras
    } = request || {};

    const taskSpec = {
        ...extras,
        job_id: jobId ?? extras.job_id,
        params: workflow ?? extras.params,
        job_type: jobType ?? extras.job_type,
        build_id: buildId ?? extras.build_id,
        dispatch_id: dispatchId ?? extras.dispatch_id,
    };
    if (timeoutMs !== undefined && taskSpec.timeout_ms === undefined) {
        taskSpec.timeout_ms = timeoutMs;
    }

    // S-6: the v2 task spec flows through the DispatchTransport port —
    // payload/result/error semantics are 1:1 with the former direct
    // gpuDispatcher.sendUnified call (the host adapter IS sendUnified).
    return dispatch(taskSpec);
}

/**
 * Convenience helper used by generation call sites: build the v2 job id.
 */
function buildJobId(imageIUId, kind) {
    return jobSchema.buildJobId(imageIUId, kind);
}

module.exports = {
    PROVIDER_NAME,
    WORKFLOW_NAMES,

    // workflow / connector knowledge
    loadWorkflow,
    getConnector,
    getWorkflowHash,
    listWorkflows,
    applyValue,
    getNodeId,
    getBinding,
    profileNameFromConnector,
    assembleMergedDialogueWorkflow,

    // dispatch
    generate,
    buildJobId,
};
