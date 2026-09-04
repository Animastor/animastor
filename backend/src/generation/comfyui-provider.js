// ======================================================
// ComfyUIProvider — generation provider seam (Phase 3)
// ======================================================
// The provider-specific seam for ComfyUI generation. Phase 3 is a BOUNDARY
// phase, not a refactor: the ComfyUI workflows themselves are NOT rewritten
// and generation code (audio/generation.js, image/iu-processor.js,
// video/video-service.js) keeps running as-is. This seam exists so that:
//
//   1. workflow names / raw ComfyUI node ids / provider-specific payloads
//      have a documented HOME inside the generation domain — they are NOT
//      part of the Agent or Chat provider contracts and must never become
//      one (architecture test: phase3-provider-gateway.test.js);
//   2. future extraction can migrate the direct workflow-loader /
//      gpu-dispatcher call sites behind this seam one by one without
//      changing callers' imports again.
//
// Jobs built here follow Job Protocol v2 (runtime/job-schema.js) and are
// dispatched via runtime/gpu-dispatcher.sendUnified (backend → GPU Hub
// POST /task). Nothing in this module touches the LLM transports (agent
// callAI / chat SSE / connector WS / shared-pool).

const wfLoader = require('../workflows/workflow-loader');
const jobSchema = require('../runtime/job-schema');
const gpuDispatcher = require('../runtime/gpu-dispatcher');

// ── provider identity ───────────────────────────────────────────────────
const PROVIDER_NAME = 'comfyui';

// Workflow names currently exercised by the generation domain (the same
// ids the workflow loader resolves from backend/ai/workflows/*.json).
// Audio/image/video consumers reference these names; the mapping name →
// workflow JSON + connector stays inside this domain.
const WORKFLOW_NAMES = {
    narration: 'tts-qwen-narrator',
    dialogue: 'tts-qwen-dialogue',
    image: 'img-qwen-image',
    videoFamily: 'video-ltx',
};

/**
 * Load a fresh deep copy of a ComfyUI workflow by name.
 * Returns the workflow JSON (mutable clone — callers patch node inputs,
 * exactly as workflows/workflow-loader.getWorkflow does today).
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

/**
 * Dispatch a built ComfyUI workflow as a GPU Hub job (Job Protocol v2).
 * Thin, explicit wrapper over gpu-dispatcher.sendUnified for generation
 * call sites — the seam future refactors plug into.
 * @param {{jobId:string, workflow:object, jobType:('audio'|'image'|'video'),
 *          buildId:string, dispatchId:string}} request
 * @returns {Promise<{sent:boolean, jobId?:string, error?:string}>}
 */
async function generate(request) {
    return gpuDispatcher.sendUnified({
        job_id: request.jobId,
        params: request.workflow,
        job_type: request.jobType,
        build_id: request.buildId,
        dispatch_id: request.dispatchId,
    });
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
    loadWorkflow,
    getConnector,
    getWorkflowHash,
    generate,
    buildJobId,
};
