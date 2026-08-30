package com.example.animastor.repository

// ======================================================
// Private Worker Setup Contract models (Phase 3 / 3.1)
// ======================================================
// 1:1 with the backend DTOs projected by backend/src/installer/setup-contract.js
// (web parity: frontends/app features/workers/workerSetup.ts). Served by
// /api/v1/private-worker/setup/* — the unified contract consumed by BOTH Web
// and Android. The contract NEVER carries token/token_hash or any secret:
// at most token_prefix (already public in the worker list).

/** Lifecycle artifact metadata (installer / uninstaller / worker bundle). */
data class SetupArtifactInfo(
    val available: Boolean = false,
    /** available | draft | planned | unavailable */
    val status: String? = null,
    val version: String? = null,
    /** Origin-relative ("/gpu/…") or absolute; null when unavailable. */
    val download_url: String? = null,
    val sha256: String? = null,
    val files: List<String>? = null,
    val signature: String? = null,
    val signature_algorithm: String? = null
)

/** Install profile projected from the canonical installer manifests. */
data class SetupProfile(
    val id: String? = null,
    val name: String? = null,
    val description: String? = null,
    /** audio | image | video */
    val worker_type: String? = null,
    /** draft | stable (hidden/internal manifests are never served) */
    val status: String? = null,
    val supported_install_modes: List<String> = emptyList(),
    val gpu: SetupProfileGpu? = null,
    val disk_budget_bytes_approx: Long = 0,
    val workflows: List<String> = emptyList(),
    val dependencies_summary: SetupDependenciesSummary? = null
)

data class SetupProfileGpu(
    /** Unknown VRAM is honestly null — never invented. */
    val min_vram_gb: Double? = null,
    val reference_gpu: String? = null
)

data class SetupDependenciesSummary(
    val custom_nodes: Int = 0,
    val models: Int = 0,
    val approx_bytes: Long = 0
)

/** Installation method: platform × lifecycle artifacts. */
data class SetupMethod(
    /** linux | windows | docker */
    val platform: String? = null,
    val architectures: List<String> = emptyList(),
    /** available | unavailable | planned */
    val status: String? = null,
    val installer: SetupArtifactInfo = SetupArtifactInfo(),
    val uninstaller: SetupArtifactInfo = SetupArtifactInfo(),
    val worker_bundle: SetupArtifactInfo = SetupArtifactInfo(),
    val supported_profiles: List<String> = emptyList(),
    val minimum_requirements: SetupMinimumRequirements? = null
)

data class SetupMinimumRequirements(
    val node: String? = null,
    val python: String? = null,
    val gpu: String? = null
)

/** Platform artifacts (GET /artifacts?platform=…). */
data class SetupPlatformArtifacts(
    val platform: String? = null,
    val architecture: String? = null,
    val status: String? = null,
    val installer: SetupArtifactInfo = SetupArtifactInfo(),
    val uninstaller: SetupArtifactInfo = SetupArtifactInfo(),
    val worker_bundle: SetupArtifactInfo = SetupArtifactInfo(),
    val supported_profiles: List<String> = emptyList()
)

/** Baseline workflow metadata (editable starting points). */
data class SetupWorkflow(
    val id: String? = null,
    val name: String? = null,
    val profile_id: String? = null,
    val revision: String? = null,
    val baseline_available: Boolean = false,
    val download_url: String? = null,
    val sha256: String? = null,
    val editable: Boolean = true
)

/** One server-assembled instruction step. Commands/checksums are ALWAYS
 *  rendered verbatim from the API — never hardcoded in the client. */
data class SetupInstructionStep(
    val id: String? = null,
    val title: String? = null,
    val body: String? = null,
    val code: String? = null,
    val checksum: SetupInstructionChecksum? = null,
    val requirements: Map<String, String>? = null
)

data class SetupInstructionChecksum(
    val algorithm: String? = null,
    val value: String? = null,
    val verify_code: String? = null
)

data class SetupInstructionsEnv(
    val required: List<String> = emptyList(),
    val secrets: List<String> = emptyList(),
    val template_block: String? = null
)

/** Installer artifact metadata for the install step UI (bootstrap flow):
 *  version is the primary UX line; the sha256 belongs in a collapsed block
 *  (shown once). download_url is the profile-embedded bootstrap script
 *  (managed/existing) or the installer bundle (isolated). */
data class SetupInstructionsInstaller(
    val version: String? = null,
    val sha256: String? = null,
    val status: String? = null,
    val download_url: String? = null
)

data class SetupWorkerKeyPolicy(
    val disclosed_once: Boolean = true,
    val disclosed_by: String? = null,
    val entered_on: String? = null,
    val never: List<String> = emptyList()
)

/** GET /instructions response. */
data class SetupInstructions(
    val platform: String? = null,
    val mode: String? = null,
    val profile_ids: List<String> = emptyList(),
    val steps: List<SetupInstructionStep> = emptyList(),
    val env: SetupInstructionsEnv? = null,
    val worker_key_policy: SetupWorkerKeyPolicy? = null,
    /** Bootstrap installer metadata — null when the installer is unavailable. */
    val installer: SetupInstructionsInstaller? = null,
    /** Optional terminal diagnostics (e.g. $HOME/animastor/tools/status.sh).
     *  Never a required step: the page itself shows the worker status. */
    val verify_command: String? = null
)

/** Extended worker status model (adapter over ONLINE/OFFLINE/REVOKED). */
object SetupWorkerStatus {
    const val NOT_CONFIGURED = "NOT_CONFIGURED"
    const val INSTALLING = "INSTALLING"
    const val CONNECTING = "CONNECTING"
    const val ONLINE = "ONLINE"
    const val OFFLINE = "OFFLINE"
    const val ERROR = "ERROR"
    const val REVOKED = "REVOKED"
}

data class SetupWorkerGpu(
    val name: String? = null,
    val vram_gb: Double? = null
)

data class SetupWorkerCapabilities(
    val profiles: List<String>? = null,
    val workflows: List<String>? = null,
    val gpu: SetupWorkerGpu? = null
)

/** GET /workers/:id response worker (UI-safe extended model). */
data class SetupWorkerDetail(
    val worker_id: String? = null,
    val workspace_id: String? = null,
    val name: String? = null,
    val worker_type: String? = null,
    val mode: String? = null,
    /** Extended contract status (NOT_CONFIGURED…REVOKED). */
    val status: String? = null,
    /** Existing derivation, unchanged: ONLINE | OFFLINE | REVOKED. */
    val base_status: String? = null,
    val status_model: List<String> = emptyList(),
    val token_prefix: String? = null,
    val last_seen: Long? = null,
    val revoked_at: Long? = null,
    val created_at: Long? = null,
    /** Normalized real data; null until the worker reports anything. */
    val capabilities: SetupWorkerCapabilities? = null,
    /** Online details from the hub heartbeat — future extension, null meanwhile. */
    val details: Any? = null
)

/** POST /plan request — preview only, the backend NEVER executes it. */
data class SetupPlanRequest(
    val profile_ids: List<String>,
    val mode: String,
    val platform: String = "linux"
)

data class SetupPlanAction(
    val type: String? = null,
    val component: String? = null,
    val name: String? = null,
    val conditional: Boolean = false,
    val blocked: Boolean = false,
    val editable: Boolean = false,
    val size_bytes_approx: Long? = null,
    val profiles: List<String>? = null
)

data class SetupPlanIssue(
    val code: String? = null,
    val message: String? = null
)

data class SetupPlanSharing(
    val verdict: String? = null,
    val can_share: Boolean? = null,
    val message: String? = null
)

data class SetupPlanResponse(
    /** READY | READY_WITH_WARNINGS | BLOCKED */
    val result: String? = null,
    val platform: String? = null,
    val mode: String? = null,
    val profiles: List<String> = emptyList(),
    val actions: List<SetupPlanAction> = emptyList(),
    val warnings: List<String> = emptyList(),
    val blocks: List<SetupPlanIssue> = emptyList(),
    val sharing: SetupPlanSharing? = null,
    val disk_budget_bytes_approx: Long? = null
)

// ── Response envelopes ──────────────────────────────────────────────────

data class SetupProfilesResponse(val profiles: List<SetupProfile> = emptyList())
data class SetupMethodsResponse(val methods: List<SetupMethod> = emptyList())
data class SetupWorkflowsResponse(val workflows: List<SetupWorkflow> = emptyList())
data class SetupWorkerDetailResponse(val worker: SetupWorkerDetail? = null)

/** DELETE /workers/:id/purge — hard delete of an already revoked worker. */
data class PurgeWorkerResponse(val deleted: Boolean = false)
