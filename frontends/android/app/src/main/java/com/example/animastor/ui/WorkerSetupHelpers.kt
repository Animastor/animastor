package com.example.animastor.ui

import com.example.animastor.repository.DeploymentCapability
import com.example.animastor.repository.SetupArtifactInfo
import com.example.animastor.repository.SetupInstructions
import com.example.animastor.repository.SetupMethod
import com.example.animastor.repository.SetupProfile

// ─────────────────────────────────────────────────────────────────────────
// Private Worker Setup Center (Phase 3.1) — pure Setup Contract helpers.
// Web parity: frontends/app features/workers/workerSetup.ts (same rules,
// same states, same gating). No Android framework calls — unit tested on
// the JVM (WorkerSetupHelpersTest).
//
// SECURITY INVARIANTS (Phase 3.1 §14/§21): the Worker Key is a ONE-TIME
// disclosure from POST /workers. Nothing in this module persists it, puts
// it into a URL, or logs it — the Setup Contract itself never carries it.
// ─────────────────────────────────────────────────────────────────────────

object WorkerSetupHelpers {

    const val PLATFORM_LINUX = "linux"
    const val PLATFORM_WINDOWS = "windows"
    const val PLATFORM_DOCKER = "docker"

    const val DEPLOYMENT_NATIVE = "native"
    const val DEPLOYMENT_DOCKER = "docker"

    const val MODE_MANAGED = "managed"
    const val MODE_EXISTING = "existing"

    // ── Artifact URLs ────────────────────────────────────────────────────

    /** Origin-relative artifact URL ('/gpu/installer') → absolute download
     *  URL against [baseUrl] (Android: BuildConfig.BASE_URL — web parity:
     *  location.origin). Null/empty input ⇒ null (unavailable artifact ⇒
     *  no fake link). Absolute URLs pass through. */
    fun resolveArtifactUrl(downloadUrl: String?, baseUrl: String): String? {
        if (downloadUrl.isNullOrBlank()) return null
        if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(downloadUrl)) return downloadUrl
        val origin = baseUrl.trimEnd('/')
        if (origin.isEmpty()) return downloadUrl
        val sep = if (downloadUrl.startsWith("/")) "" else "/"
        return "$origin$sep$downloadUrl"
    }

    // ── Profiles ─────────────────────────────────────────────────────────

    data class ProfileGroup(
        val workerType: String,
        val recommended: SetupProfile,
        val alternatives: List<SetupProfile>
    )

    /** Group profiles for the Setup Center cards: one card per worker type,
     *  first profile of the type is the recommended one (manifest order). */
    fun groupProfilesByType(profiles: List<SetupProfile>): List<ProfileGroup> {
        val order = listOf("image", "video", "audio")
        return order.mapNotNull { wt ->
            val of = profiles.filter { it.worker_type == wt }
            if (of.isEmpty()) null
            else ProfileGroup(wt, of.first(), of.drop(1))
        }
    }

    /** Human-friendly disk budget (bytes → GB, one decimal). */
    fun formatDiskBudget(bytes: Long?): String? {
        if (bytes == null || bytes <= 0) return null
        val gb = bytes.toDouble() / (1024.0 * 1024.0 * 1024.0)
        if (!gb.isFinite()) return null
        val rounded = if (gb >= 10) Math.round(gb).toDouble() else Math.round(gb * 10) / 10.0
        val text = if (rounded == Math.floor(rounded)) "${rounded.toLong()}" else "$rounded"
        return "$text GB"
    }

    // ── Installation methods / platforms ─────────────────────────────────

    fun pickMethod(methods: List<SetupMethod>, platform: String): SetupMethod? =
        methods.find { it.platform == platform }

    /** Can this method serve the given install mode? Managed needs the
     *  installer; Existing ComfyUI needs the installer OR the worker runtime
     *  bundle — one missing artifact must never block the whole platform
     *  (Phase 3.1 §3). */
    fun platformSelectable(method: SetupMethod?, mode: String?): Boolean {
        if (method == null || method.status == "planned") return false
        if (method.installer.available) return true
        return mode == MODE_EXISTING && method.worker_bundle.available
    }

    /** i18n state key for a platform option (mapped to R.string by the UI):
     *  installer available / existing-only / coming soon / installer down /
     *  temporarily unavailable. */
    data class PlatformOption(
        val platform: String,
        /** True only when the platform can actually serve the selected mode. */
        val selectable: Boolean,
        val stateKey: String,
        val installerVersion: String?
    )

    /** Map installation methods to UI platform options for the SELECTED mode.
     *  Unavailable platforms are NEVER presented as actionable (Phase 3.1 §11). */
    fun platformOptions(methods: List<SetupMethod>, mode: String? = null): List<PlatformOption> {
        val order = listOf(PLATFORM_LINUX, PLATFORM_WINDOWS, PLATFORM_DOCKER)
        return order.map { platform ->
            val m = methods.find { it.platform == platform }
            if (m == null || m.status == "planned") {
                PlatformOption(platform, false, "worker_setup_platform_soon", null)
            } else if (m.installer.available) {
                PlatformOption(platform, true, "worker_setup_platform_ready", m.installer.version)
            } else if (m.worker_bundle.available) {
                if (mode == MODE_EXISTING) {
                    PlatformOption(platform, true, "worker_setup_platform_existing_only", null)
                } else {
                    PlatformOption(platform, false, "worker_setup_platform_no_installer", null)
                }
            } else {
                PlatformOption(platform, false, "worker_setup_platform_unavailable", m.installer.version)
            }
        }
    }

    data class ModeAvailability(val managed: Boolean, val existing: Boolean)

    /** Per-mode availability on the real (linux) platform — used to gate the
     *  mode step so the wizard never offers a mode that cannot continue. */
    fun linuxModeAvailability(methods: List<SetupMethod>): ModeAvailability {
        val linux = methods.find { it.platform == PLATFORM_LINUX }
        if (linux == null || linux.status == "planned") return ModeAvailability(false, false)
        return ModeAvailability(
            managed = linux.installer.available,
            existing = linux.installer.available || linux.worker_bundle.available
        )
    }

    // ── Deployment options (the capability model, rendered) ──────────────

    /** One selectable "Platform · Deployment" choice in the wizard
     *  (web parity: DeploymentOption in workerSetup.ts). */
    data class DeploymentOption(
        val key: String,
        /** linux | windows */
        val platform: String,
        /** native | docker */
        val deployment: String,
        /** Platform × Deployment label, e.g. "Linux · Native". */
        val label: String,
        /** stable | preview | experimental */
        val availability: String,
        /** i18n key for the availability badge. */
        val availabilityKey: String,
        /** True only when the combination can serve the selected mode. */
        val selectable: Boolean,
        val stateKey: String,
        val installerVersion: String?,
        /** Backend notice for non-stable levels — informational. */
        val notice: String?
    )

    /** Artifact availability of one OS platform for the given mode
     *  (same rules as [platformSelectable]). */
    private fun osSelectable(methods: List<SetupMethod>, platform: String, mode: String?): Boolean {
        val m = methods.find { it.platform == platform } ?: return false
        if (m.status == "planned") return false
        if (m.installer.available) return true
        return mode == MODE_EXISTING && m.worker_bundle.available
    }

    private fun artifactStateKey(
        methods: List<SetupMethod>, platform: String, mode: String?
    ): Pair<String, String?> {
        val m = methods.find { it.platform == platform }
        if (m == null || m.status == "planned") return "worker_setup_platform_soon" to null
        if (m.installer.available) return "worker_setup_platform_ready" to m.installer.version
        if (m.worker_bundle.available) {
            return if (mode == MODE_EXISTING) "worker_setup_platform_existing_only" to null
            else "worker_setup_platform_no_installer" to null
        }
        return "worker_setup_platform_unavailable" to m.installer.version
    }

    /**
     * Map the backend capability model to wizard choices. The docker
     * deployment deploys linux (its artifacts ARE the linux artifacts); it
     * stays a managed-mode path. Unallowed combinations (windows+docker) are
     * never rendered. If the backend response carries no capabilities, the
     * honest fallback mirrors the legacy platform options — never a locally
     * invented availability table.
     */
    fun deploymentOptions(
        methods: List<SetupMethod>,
        capabilities: List<DeploymentCapability>?,
        mode: String? = null
    ): List<DeploymentOption> {
        val caps = if (!capabilities.isNullOrEmpty()) capabilities else listOf(
            DeploymentCapability(PLATFORM_LINUX, DEPLOYMENT_NATIVE, "stable", true, null, null),
            DeploymentCapability(PLATFORM_WINDOWS, DEPLOYMENT_NATIVE, "preview", true, null, null),
            DeploymentCapability(PLATFORM_LINUX, DEPLOYMENT_DOCKER, "experimental", true, null, null)
        )
        val order = listOf("linux-native", "windows-native", "linux-docker")
        return order.mapNotNull { key ->
            val parts = key.split("-")
            val platform = parts[0]
            val deployment = parts[1]
            val cap = caps.find { it.platform == platform && it.deployment == deployment }
            if (cap == null || !cap.allowed || cap.availability == null) return@mapNotNull null
            val artifactPlatform = PLATFORM_LINUX // docker deploys linux
            val selectable = if (deployment == DEPLOYMENT_DOCKER) {
                mode == MODE_MANAGED && osSelectable(methods, artifactPlatform, MODE_MANAGED)
            } else {
                osSelectable(methods, platform, mode)
            }
            val (stateKey, installerVersion) = artifactStateKey(
                methods,
                if (deployment == DEPLOYMENT_DOCKER) PLATFORM_LINUX else platform,
                mode
            )
            DeploymentOption(
                key = key,
                platform = platform,
                deployment = deployment,
                label = when (key) {
                    "linux-native" -> "Linux · Native"
                    "windows-native" -> "Windows · Native"
                    else -> "Linux · Docker"
                },
                availability = cap.availability,
                availabilityKey = when (cap.availability) {
                    "stable" -> "worker_setup_availability_stable"
                    "preview" -> "worker_setup_availability_preview"
                    else -> "worker_setup_availability_experimental"
                },
                selectable = selectable,
                stateKey = stateKey,
                installerVersion = installerVersion,
                notice = cap.notice
            )
        }
    }

    // ── Extended worker status model ─────────────────────────────────────

    /** Extended status model → i18n key (legacy statuses keep their keys;
     *  unknown statuses degrade to offline — never invented). */
    fun setupStatusKey(status: String?): String = when (status) {
        "ONLINE" -> "worker_status_online"
        "REVOKED" -> "worker_status_revoked"
        "CONNECTING" -> "worker_status_connecting"
        "ERROR" -> "worker_status_error"
        "INSTALLING" -> "worker_status_installing"
        "NOT_CONFIGURED" -> "worker_status_not_configured"
        else -> "worker_status_offline"
    }

    /** Status pill tone: online / revoked / muted (offline & everything else). */
    fun setupStatusTone(status: String?): String = when (status) {
        "ONLINE" -> "online"
        "REVOKED" -> "revoked"
        else -> "offline"
    }

    // ── Wizard state machine (pure) ──────────────────────────────────────

    enum class WizardStep { PROFILE, MODE, PLATFORM, CREATE, INSTALL }

    /** Wizard selections only — NO credential field. The one-time Worker Key
     *  lives exclusively in transient UI state while the disclosure is open. */
    data class WizardState(
        val step: WizardStep = WizardStep.PROFILE,
        val profileId: String? = null,
        /** managed | existing */
        val mode: String? = null,
        /** linux | windows */
        val platform: String? = null,
        /** native | docker (chosen together with the platform — one capability) */
        val deployment: String? = null
    )

    fun initialWizardState(): WizardState = WizardState()

    fun canGoNext(state: WizardState, platformSelectable: Boolean, nameValid: Boolean): Boolean =
        when (state.step) {
            WizardStep.PROFILE -> state.profileId != null
            WizardStep.MODE -> state.mode != null
            WizardStep.PLATFORM -> state.platform != null && state.deployment != null && platformSelectable
            WizardStep.CREATE -> nameValid
            WizardStep.INSTALL -> false
        }

    fun nextStep(state: WizardState): WizardStep? {
        val i = WizardStep.entries.indexOf(state.step)
        return if (i in 0 until WizardStep.entries.size - 1) WizardStep.entries[i + 1] else null
    }

    fun prevStep(state: WizardState): WizardStep? {
        val i = WizardStep.entries.indexOf(state.step)
        return if (i > 0) WizardStep.entries[i - 1] else null
    }

    // ── Instruction step localization mapping ────────────────────────────

    /** Instruction step id → localized title i18n key. Unknown ids ⇒ null
     *  (the UI falls back to the API-provided text — future-proof).
     *  Commands/checksums are ALWAYS rendered verbatim from the API.
     *  The worker is ALWAYS created before instructions are shown (wizard
     *  CREATE step) — there is no 'create-worker' instruction step. */
    fun stepTitleKey(id: String?): String? = when (id) {
        "prerequisites" -> "worker_setup_step_prereq_title"
        "download-bootstrap" -> "worker_setup_step_download_bootstrap_title"
        "run-bootstrap" -> "worker_setup_step_run_bootstrap_title"
        "download-bundle" -> "worker_setup_step_download_bundle_title"
        "unpack-bundle" -> "worker_setup_step_unpack_bundle_title"
        "configure-worker" -> "worker_setup_step_configure_worker_title"
        "start-worker" -> "worker_setup_step_start_worker_title"
        "verify" -> "worker_setup_step_verify_title"
        "installer-unavailable" -> "worker_setup_step_installer_unavailable_title"
        "platform-planned" -> "worker_setup_step_planned_title"
        "isolated-unavailable" -> "worker_setup_step_isolated_unavailable_title"
        "docker-prerequisites" -> "worker_setup_step_docker_prereq_title"
        "docker-build" -> "worker_setup_step_docker_build_title"
        "docker-install" -> "worker_setup_step_docker_install_title"
        "docker-runtime" -> "worker_setup_step_docker_runtime_title"
        else -> null
    }

    /** Instruction step id → localized body i18n key (see [stepTitleKey]). */
    fun stepBodyKey(id: String?): String? = when (id) {
        "prerequisites" -> "worker_setup_step_prereq_body"
        "download-bootstrap" -> "worker_setup_step_download_bootstrap_body"
        "run-bootstrap" -> "worker_setup_step_run_bootstrap_body"
        "download-bundle" -> "worker_setup_step_download_bundle_body"
        "unpack-bundle" -> "worker_setup_step_unpack_bundle_body"
        "configure-worker" -> "worker_setup_step_configure_worker_body"
        "start-worker" -> "worker_setup_step_start_worker_body"
        "verify" -> "worker_setup_step_verify_body"
        "installer-unavailable" -> "worker_setup_step_installer_unavailable_body"
        "platform-planned" -> "worker_setup_step_planned_body"
        "isolated-unavailable" -> "worker_setup_step_isolated_unavailable_body"
        "docker-prerequisites" -> "worker_setup_step_docker_prereq_body"
        "docker-build" -> "worker_setup_step_docker_build_body"
        "docker-install" -> "worker_setup_step_docker_install_body"
        "docker-runtime" -> "worker_setup_step_docker_runtime_body"
        else -> null
    }

    // ── Install step artifact selection (web parity: InstallStep) ────────

    /** Existing ComfyUI without the installer: the runtime bundle is THE
     *  primary artifact (Phase 3.1 completion — bundle-based flow). */
    fun bundleIsPrimaryArtifact(mode: String?, installer: SetupArtifactInfo?, bundle: SetupArtifactInfo?): Boolean =
        mode == MODE_EXISTING && bundle?.available == true && installer?.available != true

    /** Primary installer download for the install step. The Setup Contract
     *  instructions carry the profile-embedded bootstrap script URL — it
     *  always wins over the generic method artifact, which is only a
     *  fallback for the loading state. */
    fun installerDownloadUrl(instructions: SetupInstructions?, method: SetupMethod?): String? =
        instructions?.installer?.download_url ?: method?.installer?.download_url

    /** Installer version shown prominently in the install step. */
    fun installerVersion(instructions: SetupInstructions?, method: SetupMethod?): String? =
        instructions?.installer?.version ?: method?.installer?.version

    /** Installer SHA-256 — rendered in a collapsed block, shown once. */
    fun installerSha256(instructions: SetupInstructions?, method: SetupMethod?): String? =
        instructions?.installer?.sha256 ?: method?.installer?.sha256
}
