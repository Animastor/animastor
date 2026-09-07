// ======================================================
// GENERATED FILE — DO NOT EDIT BY HAND
// ======================================================
// Generated copy of the canonical Job Protocol v2 implementation:
//   package:   @animastor/contracts
//   source:    packages/animastor-contracts/src/job-protocol-v2.js
//   sha256:    b005fafc01614e643e325b3433f657c6bd197ee6f76dca4d36eb1bf7de2b5a84
//   generated: 0.1.0 snapshot
// Generator:  packages/animastor-worker/tools/sync-protocol.cjs (Phase 9D — blocker B2, option B)
//
// The worker bundle ships with zero runtime npm dependencies (Phase 9B
// freeze) and is delivered to GPU machines without an npm registry, so it
// cannot require @animastor/contracts at runtime. This file is a byte-exact
// copy of the canonical source below the marker line — it is NOT a second
// implementation. Any edit here diverges the wire contract and will be
// caught by the parity guards:
//   worker/tests/job-protocol.test.cjs
//   backend/tests/architecture/phase9d-worker-package.test.js
//
// Regenerate after any change to the canonical source:
//   node packages/animastor-worker/tools/sync-protocol.cjs

// ===8<=== canonical source (verbatim, do not edit) ====================
// ======================================================
// @animastor/contracts — Job Protocol v2 (canonical implementation)
// ======================================================
// CANONICAL SOURCE OF TRUTH for the frozen Job Protocol v2 wire contract
// (docs/architecture/JOB_PROTOCOL_V2.md — NORMATIVE, FROZEN, Phase 9A).
//
// Extracted verbatim from backend/src/runtime/job-schema.js (Phase 9C).
// Consumers: backend (via the job-schema.js facade), gpu-hub, worker.
//
// NO business logic lives here: only protocol constants, job_id grammar,
// stage mapping and envelope/error contract helpers — exactly the surface
// the protocol defines, no more.
//
// Versioning: PROTOCOL_VERSION changes only via the versioning policy
// (JOB_PROTOCOL_V2.md §4) — coordinated bump in backend + gpu-hub + worker
// after old workers stop receiving tasks. Mixed-version rollout is NOT
// supported. ======================================================

// Job Protocol version backend ↔ gpu-hub ↔ worker. Sent in the task and
// callback payloads. All three components reject a mismatching version:
// mixed-version rollout is allowed only after old workers stop receiving
// tasks. [NORMATIVE — FROZEN: value 2 for the entire Phase 9]
const PROTOCOL_VERSION = 2; // T4: dispatch_id added

// Asset-type family carried by the job_id suffix (`${assetId}:${type}`).
// `iu_image` is an asset type only: on the transport it travels as
// job_type = 'image', stage = 'image' (JOB_PROTOCOL_V2.md §3.4).
const JOB_TYPES = ['audio', 'image', 'iu_image', 'video'];

// Transport-type family of the hub scan queues / queue keys
// (`queue:{type}...`). `iu_image` never appears here as a type: it is
// routed with job_type 'image'. Mirrors gpu-hub SYSTEM_JOB_TYPES.
const SYSTEM_JOB_TYPES = ['audio', 'image', 'video'];

// kind (parse result) → stage (envelope / result-key segment).
const STAGE_BY_KIND = {
    audio_chunk: 'audio',
    iu_image: 'image',
    scene_image: 'image',
    scene_video: 'video',
};

// job_id grammar regexes [NORMATIVE — FROZEN]:
//   audio chunk:     {bookId}_{chapterId}_{sceneId}_{NNNN}:audio   (NNNN = pad(4))
//   IU image:        {bookId}_{chapterId}_{sceneId}_{iuId}:iu_image
//   scene image:     {bookId}_{chapterId}_{sceneId}:image          (legacy; assetId
//                    containing '_iu' = old-format IU image)
//   video:           {bookId}_{chapterId}_{sceneId}[_gN]:video     (_gN = group)
// bookId may contain '_'; chapterId/sceneId/chunkIndex/iuId may not, so
// parsing always goes from the end.
const CHUNK_INDEX_RE = /^\d{4}$/;
const GROUP_SUFFIX_RE = /^(.+?)(_g\d+)$/;
// Worker-side input-file naming split family (worker.cjs inline literals).
const JOB_ID_SPLIT_RE = /:(iu_image|image|audio|video)$/;

const JOB_TYPES_SET = new Set(JOB_TYPES);

function buildJobId(assetId, type) {
    if (!assetId || typeof assetId !== 'string') {
        throw new Error(`buildJobId: invalid assetId: ${assetId}`);
    }
    if (!JOB_TYPES.includes(type)) {
        throw new Error(`buildJobId: unknown job type: ${type}`);
    }
    return `${assetId}:${type}`;
}

// Strips the type suffix. Returns { assetId, type } or null.
function splitJobId(jobId) {
    if (!jobId || typeof jobId !== 'string') return null;
    const idx = jobId.lastIndexOf(':');
    if (idx === -1) return null;
    const type = jobId.slice(idx + 1);
    if (!JOB_TYPES_SET.has(type)) return null;
    return { assetId: jobId.slice(0, idx), type };
}

// Full parse. Returns null for unrecognizable ids (never throws).
// kind: 'audio_chunk' | 'iu_image' | 'scene_image' | 'scene_video'
function parseJobId(jobId) {
    const split = splitJobId(jobId);
    if (!split) return null;
    const { assetId, type } = split;

    if (type === 'audio') {
        const parts = assetId.split('_');
        if (parts.length < 4) return null;
        const chunkIndex = parts.pop();
        if (!CHUNK_INDEX_RE.test(chunkIndex)) return null;
        const sceneId = parts.pop();
        const chapterId = parts.pop();
        return {
            kind: 'audio_chunk', type, assetId,
            bookId: parts.join('_'), chapterId, sceneId, chunkIndex,
        };
    }

    if (type === 'iu_image' || (type === 'image' && assetId.includes('_iu'))) {
        const parts = assetId.split('_');
        if (parts.length < 4) return null;
        const iuId = parts.pop();
        const sceneId = parts.pop();
        const chapterId = parts.pop();
        return {
            kind: 'iu_image', type, assetId,
            bookId: parts.join('_'), chapterId, sceneId, iuId,
        };
    }

    if (type === 'image') {
        const parts = assetId.split('_');
        if (parts.length < 3) return null;
        const sceneId = parts.pop();
        const chapterId = parts.pop();
        return {
            kind: 'scene_image', type, assetId,
            bookId: parts.join('_'), chapterId, sceneId,
        };
    }

    if (type === 'video') {
        let base = assetId;
        let groupSuffix = '';
        const groupMatch = base.match(GROUP_SUFFIX_RE);
        if (groupMatch) {
            base = groupMatch[1];
            groupSuffix = groupMatch[2];
        }
        const parts = base.split('_');
        if (parts.length < 3) return null;
        const sceneId = parts.pop();
        const chapterId = parts.pop();
        return {
            kind: 'scene_video', type, assetId,
            bookId: parts.join('_'), chapterId, sceneId, groupSuffix,
        };
    }

    return null;
}

function getStageForJobId(jobId) {
    const parsed = parseJobId(jobId);
    if (!parsed) return null;
    return STAGE_BY_KIND[parsed.kind] || null;
}

// ------------------------------------------------------
// Envelope contract helpers (JOB_PROTOCOL_V2.md §3.2, §3.10, §3.11, §3.12)
// ------------------------------------------------------
// Field-sets copied from the frozen envelope tables. They document the
// contract and let consumers cross-check their payloads without importing
// business logic. The hub's runtime validation order/behavior is NOT
// reproduced here — helpers are advisory (unknown fields must be ignored,
// JOB_PROTOCOL_V2.md §3.20).

// Task envelope (backend → hub → worker). Identity fields below are the
// hub's formal required set; the hub does not validate job_id/job_type/
// params (completeness is guaranteed by the backend dispatcher).
const TASK_ENVELOPE_REQUIRED_FIELDS = [
    'dispatch_id', 'build_id', 'book_id', 'chapter_id', 'scene_id',
    'stage', 'protocol_version',
];
const TASK_ENVELOPE_FIELDS = [
    'job_id', 'params', 'job_type', 'assets', 'build_id',
    'protocol_version', 'book_id', 'chapter_id', 'scene_id', 'stage',
    'dispatch_id', 'workspace_id', 'policy_id', 'timeout_ms',
];

// Result envelope (worker → hub → backend), required field set.
const RESULT_ENVELOPE_REQUIRED_FIELDS = [
    'job_id', 'build_id', 'dispatch_id', 'protocol_version', 'result_base64',
];

// Error envelope (worker → hub → backend), required field set.
const ERROR_ENVELOPE_REQUIRED_FIELDS = [
    'job_id', 'build_id', 'dispatch_id', 'protocol_version',
];

// Beacon envelope (worker → hub), required field set.
const BEACON_ENVELOPE_REQUIRED_FIELDS = ['protocol_version'];

// Canonical error tokens of the wire contract (JOB_PROTOCOL_V2.md §3.13).
const ERROR_TOKENS = {
    PROTOCOL_VERSION_MISMATCH: 'protocol_version_mismatch',
    INCOMPLETE_DISPATCH_IDENTITY: 'incomplete_dispatch_identity',
    INVALID_WORKSPACE_ID: 'invalid_workspace_id',
    INVALID_POLICY_ID: 'invalid_policy_id',
    INVALID_POLICY_ROUTING: 'invalid_policy_routing',
    INVALID: 'invalid',
    NOT_TASK_CLAIMER: 'not_task_claimer',
    STALE_OR_UNKNOWN_DISPATCH: 'stale_or_unknown_dispatch',
    WORKER_PROTOCOL_MISMATCH: 'worker_protocol_mismatch',
    WORKER_TYPE_MISMATCH: 'worker_type_mismatch',
    WORKER_IDENTITY_REQUIRED: 'worker_identity_required',
    HUB_API_KEY_NOT_CONFIGURED: 'hub_api_key_not_configured',
};

/**
 * Validates the identity block of a task envelope. Advisory helper that
 * mirrors the hub's required-set check (gpu-hub.js /task):
 * dispatch_id, build_id, book_id, chapter_id, scene_id, stage must be
 * truthy and protocol_version must equal PROTOCOL_VERSION. Returns an
 * error-token string or null. job_id / job_type / params are NOT checked
 * here (hub does not validate them — JOB_PROTOCOL_V2.md §3.2).
 */
function validateTaskEnvelopeIdentity(task) {
    if (!task || typeof task !== 'object') {
        return ERROR_TOKENS.INCOMPLETE_DISPATCH_IDENTITY;
    }
    if (task.protocol_version !== PROTOCOL_VERSION) {
        return ERROR_TOKENS.PROTOCOL_VERSION_MISMATCH;
    }
    for (const field of ['dispatch_id', 'build_id', 'book_id', 'chapter_id', 'scene_id', 'stage']) {
        if (!task[field]) {
            return ERROR_TOKENS.INCOMPLETE_DISPATCH_IDENTITY;
        }
    }
    return null;
}

/**
 * Validates the identity block of a result/error envelope (worker → hub):
 * job_id, build_id, dispatch_id present (for results also result_base64)
 * and protocol_version === PROTOCOL_VERSION. Mirrors the hub's
 * /task/result and /task/error guard. Returns an error token or null.
 */
function validateResultEnvelopeIdentity(payload, { requireResultBase64 = false } = {}) {
    if (!payload || typeof payload !== 'object') {
        return ERROR_TOKENS.INVALID;
    }
    if (payload.protocol_version !== PROTOCOL_VERSION) {
        return ERROR_TOKENS.INVALID;
    }
    const required = ['job_id', 'build_id', 'dispatch_id'];
    if (requireResultBase64) required.push('result_base64');
    for (const field of required) {
        if (!payload[field]) {
            return ERROR_TOKENS.INVALID;
        }
    }
    return null;
}

module.exports = {
    // protocol constants
    PROTOCOL_VERSION,
    JOB_TYPES,
    SYSTEM_JOB_TYPES,
    STAGE_BY_KIND,
    // job_id grammar
    CHUNK_INDEX_RE,
    GROUP_SUFFIX_RE,
    JOB_ID_SPLIT_RE,
    buildJobId,
    splitJobId,
    parseJobId,
    getStageForJobId,
    // envelope contract
    TASK_ENVELOPE_REQUIRED_FIELDS,
    TASK_ENVELOPE_FIELDS,
    RESULT_ENVELOPE_REQUIRED_FIELDS,
    ERROR_ENVELOPE_REQUIRED_FIELDS,
    BEACON_ENVELOPE_REQUIRED_FIELDS,
    ERROR_TOKENS,
    validateTaskEnvelopeIdentity,
    validateResultEnvelopeIdentity,
};
