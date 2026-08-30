package com.example.animastor.ui

import com.example.animastor.repository.SetupArtifactInfo
import com.example.animastor.repository.SetupInstructions
import com.example.animastor.repository.SetupInstructionsInstaller
import com.example.animastor.repository.SetupMethod
import com.example.animastor.repository.SetupProfile
import com.example.animastor.ui.WorkerSetupHelpers.WizardStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Private Worker Setup Center (Phase 3.1) — pure JVM tests. Web parity:
// frontends/app features/workers/workerSetup.test.ts (same fixtures, same
// assertions). WorkerSetupHelpers.kt has no Android framework calls.
class WorkerSetupHelpersTest {

    // ── fixtures (shaped like real backend responses) ───────────────────

    private val profiles = listOf(
        SetupProfile(
            id = "image/qwen-image", name = "Qwen Image", description = "d",
            worker_type = "image", status = "draft",
            supported_install_modes = listOf("managed", "existing", "shared", "isolated"),
            disk_budget_bytes_approx = 12L * 1024 * 1024 * 1024,
            workflows = listOf("img-qwen-image")
        ),
        SetupProfile(
            id = "video/ltx-2.3", name = "LTX Video 2.3", description = "d",
            worker_type = "video", status = "draft",
            supported_install_modes = listOf("managed", "existing", "shared", "isolated"),
            disk_budget_bytes_approx = 30L * 1024 * 1024 * 1024,
            workflows = listOf("vid-ltx-2.3-t2v")
        ),
        SetupProfile(
            id = "audio/qwen-tts", name = "Qwen TTS", description = "d",
            worker_type = "audio", status = "draft",
            supported_install_modes = listOf("managed", "existing", "shared", "isolated"),
            disk_budget_bytes_approx = 9L * 1024 * 1024 * 1024,
            workflows = listOf("tts-qwen-narrator")
        )
    )

    private fun artifact(available: Boolean, v: String?, url: String?): SetupArtifactInfo =
        SetupArtifactInfo(
            available = available,
            status = if (available) "draft" else "planned",
            version = v,
            download_url = url,
            sha256 = if (available) "a".repeat(64) else null
        )

    private fun method(
        platform: String,
        installerAvailable: Boolean,
        version: String?,
        bundleAvailable: Boolean? = null
    ): SetupMethod {
        val bundleUp = bundleAvailable ?: installerAvailable
        val linuxUp = installerAvailable || bundleUp
        return SetupMethod(
            platform = platform,
            architectures = if (platform == "docker") emptyList() else listOf("x86_64"),
            status = if (platform == "linux") (if (linuxUp) "available" else "unavailable") else "planned",
            installer = artifact(installerAvailable, version, if (installerAvailable) "/gpu/installer" else null),
            uninstaller = artifact(false, null, null),
            worker_bundle = artifact(bundleUp, "2.0.0", if (bundleUp) "/gpu/worker-bundle" else null),
            supported_profiles = profiles.mapNotNull { it.id }
        )
    }

    private val methods = listOf(
        method("linux", true, "1.0.0"),
        method("windows", false, null),
        method("docker", false, null)
    )

    // ── Profiles ─────────────────────────────────────────────────────────

    @Test
    fun profiles_groupedByTypeWithRecommended() {
        val cards = WorkerSetupHelpers.groupProfilesByType(profiles)
        assertEquals(listOf("image", "video", "audio"), cards.map { it.workerType })
        assertEquals("image/qwen-image", cards[0].recommended.id)
        assertTrue(cards[0].alternatives.isEmpty())
    }

    @Test
    fun profiles_unavailableMeansNoCards() {
        assertTrue(WorkerSetupHelpers.groupProfilesByType(emptyList()).isEmpty())
        val onlyAudio = WorkerSetupHelpers.groupProfilesByType(profiles.filter { it.worker_type == "audio" })
        assertEquals(listOf("audio"), onlyAudio.map { it.workerType })
    }

    // ── Installation ─────────────────────────────────────────────────────

    @Test
    fun platform_linuxInstallerAvailableSelectableWithApiVersion() {
        val opts = WorkerSetupHelpers.platformOptions(methods)
        val linux = opts.find { it.platform == "linux" }!!
        assertTrue(linux.selectable)
        assertEquals("worker_setup_platform_ready", linux.stateKey)
        assertEquals("1.0.0", linux.installerVersion) // whatever the API says
    }

    @Test
    fun platform_plannedNeverActionable() {
        val opts = WorkerSetupHelpers.platformOptions(methods)
        for (p in listOf("windows", "docker")) {
            val o = opts.find { it.platform == p }!!
            assertFalse(o.selectable)
            assertEquals("worker_setup_platform_soon", o.stateKey)
        }
    }

    @Test
    fun platform_installerDownUnavailableNotSelectable() {
        val opts = WorkerSetupHelpers.platformOptions(
            listOf(method("linux", false, "1.0.0", false)) + methods.drop(1)
        )
        val linux = opts.find { it.platform == "linux" }!!
        assertFalse(linux.selectable)
        assertEquals("worker_setup_platform_unavailable", linux.stateKey)
    }

    @Test
    fun platform_independenceInstallerDownBundleServed() {
        val bundleOnly = listOf(method("linux", false, "1.0.0", true)) + methods.drop(1)
        // managed needs the installer → blocked with a reason, not a silent dead end
        val managed = WorkerSetupHelpers.platformOptions(bundleOnly, "managed").find { it.platform == "linux" }!!
        assertFalse(managed.selectable)
        assertEquals("worker_setup_platform_no_installer", managed.stateKey)
        // existing needs only the bundle → still actionable
        val existing = WorkerSetupHelpers.platformOptions(bundleOnly, "existing").find { it.platform == "linux" }!!
        assertTrue(existing.selectable)
        assertEquals("worker_setup_platform_existing_only", existing.stateKey)
        // platform-level availability is independent of the installer artifact
        assertEquals("available", WorkerSetupHelpers.pickMethod(bundleOnly, "linux")!!.status)
        assertTrue(WorkerSetupHelpers.platformSelectable(WorkerSetupHelpers.pickMethod(bundleOnly, "linux"), "existing"))
        assertFalse(WorkerSetupHelpers.platformSelectable(WorkerSetupHelpers.pickMethod(bundleOnly, "linux"), "managed"))
    }

    @Test
    fun modeGating_linuxModeAvailabilityReflectsArtifacts() {
        val full = WorkerSetupHelpers.linuxModeAvailability(methods)
        assertTrue(full.managed); assertTrue(full.existing)
        val bundleOnly = WorkerSetupHelpers.linuxModeAvailability(
            listOf(method("linux", false, "1.0.0", true)) + methods.drop(1)
        )
        assertFalse(bundleOnly.managed); assertTrue(bundleOnly.existing)
        val allDown = WorkerSetupHelpers.linuxModeAvailability(
            listOf(method("linux", false, "1.0.0", false)) + methods.drop(1)
        )
        assertFalse(allDown.managed); assertFalse(allDown.existing)
    }

    @Test
    fun artifactUrls_noHardcodedVersion() {
        val m = method("linux", true, "9.8.7")
        assertEquals("9.8.7", m.installer.version)
        assertEquals("9.8.7", WorkerSetupHelpers.platformOptions(listOf(m)).find { it.platform == "linux" }!!.installerVersion)
        assertEquals("/gpu/installer", m.installer.download_url)
        assertEquals("/gpu/worker-bundle", m.worker_bundle.download_url)
    }

    @Test
    fun uninstaller_staysPlannedWithoutFakeUrl() {
        val linux = WorkerSetupHelpers.pickMethod(methods, "linux")!!
        assertFalse(linux.uninstaller.available)
        assertNull(linux.uninstaller.download_url)
        assertNull(WorkerSetupHelpers.resolveArtifactUrl(linux.uninstaller.download_url, "https://app.example"))
    }

    // ── Artifact URLs ────────────────────────────────────────────────────

    @Test
    fun resolveArtifactUrl_originRelativeBecomesAbsolute() {
        assertEquals(
            "https://app.example/gpu/installer",
            WorkerSetupHelpers.resolveArtifactUrl("/gpu/installer", "https://app.example")
        )
        assertEquals(
            "https://app.example/gpu/workflow/img-qwen-image",
            WorkerSetupHelpers.resolveArtifactUrl("/gpu/workflow/img-qwen-image", "https://app.example/")
        )
    }

    @Test
    fun resolveArtifactUrl_unavailableMeansNoFakeLink() {
        assertNull(WorkerSetupHelpers.resolveArtifactUrl(null, "https://app.example"))
        assertNull(WorkerSetupHelpers.resolveArtifactUrl("", "https://app.example"))
        assertNull(WorkerSetupHelpers.resolveArtifactUrl("   ", "https://app.example"))
    }

    @Test
    fun resolveArtifactUrl_absolutePassesThrough() {
        assertEquals(
            "https://hub.example/gpu/installer",
            WorkerSetupHelpers.resolveArtifactUrl("https://hub.example/gpu/installer", "https://app.example")
        )
    }

    // ── Worker / wizard ──────────────────────────────────────────────────

    @Test
    fun wizard_createOnlyWithValidName() {
        val base = WorkerSetupHelpers.WizardState(
            step = WizardStep.CREATE, profileId = "image/qwen-image",
            mode = "managed", platform = "linux"
        )
        assertFalse(WorkerSetupHelpers.canGoNext(base, platformSelectable = true, nameValid = false))
        assertTrue(WorkerSetupHelpers.canGoNext(base, platformSelectable = true, nameValid = true))
    }

    @Test
    fun wizard_stateNeverCarriesCredential() {
        // The wizard state machine holds only selections — no credential field.
        val s = WorkerSetupHelpers.initialWizardState()
        val fields = s.javaClass.declaredFields.map { it.name }
        assertEquals(listOf("step", "profileId", "mode", "platform"), fields)
    }

    @Test
    fun wizard_navigationOrder() {
        var s = WorkerSetupHelpers.initialWizardState()
        assertEquals(WizardStep.PROFILE, s.step)
        assertEquals(WizardStep.MODE, WorkerSetupHelpers.nextStep(s))
        s = s.copy(step = WizardStep.MODE, profileId = "image/qwen-image")
        assertEquals(WizardStep.PLATFORM, WorkerSetupHelpers.nextStep(s))
        assertEquals(WizardStep.PROFILE, WorkerSetupHelpers.prevStep(s))
        s = s.copy(step = WizardStep.PLATFORM, mode = "managed")
        assertEquals(WizardStep.CREATE, WorkerSetupHelpers.nextStep(s))
        s = s.copy(step = WizardStep.CREATE, platform = "linux")
        assertEquals(WizardStep.INSTALL, WorkerSetupHelpers.nextStep(s))
        s = s.copy(step = WizardStep.INSTALL)
        assertNull(WorkerSetupHelpers.nextStep(s))
        // platform step blocked unless the platform is actually selectable
        val atPlatform = WorkerSetupHelpers.WizardState(step = WizardStep.PLATFORM, platform = "linux")
        assertFalse(WorkerSetupHelpers.canGoNext(atPlatform, platformSelectable = false, nameValid = false))
        assertTrue(WorkerSetupHelpers.canGoNext(atPlatform, platformSelectable = true, nameValid = false))
    }

    @Test
    fun status_extendedModelMapsEveryStatus() {
        assertEquals("worker_status_online", WorkerSetupHelpers.setupStatusKey("ONLINE"))
        assertEquals("worker_status_offline", WorkerSetupHelpers.setupStatusKey("OFFLINE"))
        assertEquals("worker_status_connecting", WorkerSetupHelpers.setupStatusKey("CONNECTING"))
        assertEquals("worker_status_error", WorkerSetupHelpers.setupStatusKey("ERROR"))
        assertEquals("worker_status_installing", WorkerSetupHelpers.setupStatusKey("INSTALLING"))
        assertEquals("worker_status_not_configured", WorkerSetupHelpers.setupStatusKey("NOT_CONFIGURED"))
        assertEquals("worker_status_revoked", WorkerSetupHelpers.setupStatusKey("REVOKED"))
        assertEquals("online", WorkerSetupHelpers.setupStatusTone("ONLINE"))
        assertEquals("revoked", WorkerSetupHelpers.setupStatusTone("REVOKED"))
        assertEquals("offline", WorkerSetupHelpers.setupStatusTone("CONNECTING"))
    }

    @Test
    fun status_unknownDegradesToOfflineNeverInvented() {
        assertEquals("worker_status_offline", WorkerSetupHelpers.setupStatusKey("SOMETHING_NEW"))
        assertEquals("offline", WorkerSetupHelpers.setupStatusTone("SOMETHING_NEW"))
        assertEquals("worker_status_offline", WorkerSetupHelpers.setupStatusKey(null))
    }

    // ── Install step artifact selection ──────────────────────────────────

    @Test
    fun bundlePrimary_onlyForExistingWithoutInstaller() {
        val installerUp = artifact(true, "1.0.0", "/gpu/installer")
        val bundleUp = artifact(true, "2.0.0", "/gpu/worker-bundle")
        val installerDown = artifact(false, null, null)
        // existing + installer down + bundle up → the bundle is THE artifact
        assertTrue(WorkerSetupHelpers.bundleIsPrimaryArtifact("existing", installerDown, bundleUp))
        // existing + installer up → installer primary, bundle is a note
        assertFalse(WorkerSetupHelpers.bundleIsPrimaryArtifact("existing", installerUp, bundleUp))
        // managed → installer provisions the bundle
        assertFalse(WorkerSetupHelpers.bundleIsPrimaryArtifact("managed", installerDown, bundleUp))
        // no bundle → nothing primary
        assertFalse(WorkerSetupHelpers.bundleIsPrimaryArtifact("existing", installerDown, artifact(false, null, null)))
    }

    // ── Instruction step mapping ─────────────────────────────────────────

    @Test
    fun instructionSteps_bootstrapIdsMapToI18nKeysUnknownFallBack() {
        assertEquals("worker_setup_step_download_bootstrap_title", WorkerSetupHelpers.stepTitleKey("download-bootstrap"))
        assertEquals("worker_setup_step_run_bootstrap_body", WorkerSetupHelpers.stepBodyKey("run-bootstrap"))
        assertNull(WorkerSetupHelpers.stepTitleKey("some-future-step"))
        assertNull(WorkerSetupHelpers.stepBodyKey("some-future-step"))
    }

    @Test
    fun instructionSteps_noCreateWorkerStep_workerCreatedBeforeInstructions() {
        assertNull(WorkerSetupHelpers.stepTitleKey("create-worker"))
        assertNull(WorkerSetupHelpers.stepBodyKey("create-worker"))
        // legacy tarball step ids are gone (superseded by the bootstrap flow)
        assertNull(WorkerSetupHelpers.stepTitleKey("download-installer"))
        assertNull(WorkerSetupHelpers.stepBodyKey("run-installer"))
    }

    @Test
    fun installerMetadata_instructionsContractWinsOverMethodArtifact() {
        val m = method("linux", true, "0.9.0")
        val bootstrap = SetupInstructions(
            platform = "linux", mode = "managed",
            installer = SetupInstructionsInstaller(
                version = "1.2.3", sha256 = "b".repeat(64), status = "available",
                download_url = "https://animastor.in/gpu/installer?profile=image%2Fqwen-image&mode=managed"
            ),
            verify_command = "\$HOME/animastor/tools/status.sh"
        )
        // instructions.installer wins (profile-embedded bootstrap)
        assertEquals("https://animastor.in/gpu/installer?profile=image%2Fqwen-image&mode=managed",
            WorkerSetupHelpers.installerDownloadUrl(bootstrap, m))
        assertEquals("1.2.3", WorkerSetupHelpers.installerVersion(bootstrap, m))
        assertEquals("b".repeat(64), WorkerSetupHelpers.installerSha256(bootstrap, m))
        // fallback while instructions are loading
        assertEquals("/gpu/installer", WorkerSetupHelpers.installerDownloadUrl(null, m))
        assertEquals("0.9.0", WorkerSetupHelpers.installerVersion(null, m))
        // degraded contract + unavailable method → no fake link
        val degraded = bootstrap.copy(installer = null, verify_command = null)
        val down = method("linux", false, null)
        assertNull(WorkerSetupHelpers.installerDownloadUrl(degraded, down))
        assertNull(WorkerSetupHelpers.installerVersion(degraded, down))
        assertNull(WorkerSetupHelpers.installerSha256(degraded, down))
        assertNull(WorkerSetupHelpers.resolveArtifactUrl(
            WorkerSetupHelpers.installerDownloadUrl(degraded, down), "https://app.example"))
    }

    @Test
    fun installerMetadata_profileAndModeEmbedded_userTypesNothing() {
        val url = WorkerSetupHelpers.installerDownloadUrl(
            SetupInstructions(installer = SetupInstructionsInstaller(
                version = "1.0.0", sha256 = null, status = "available",
                download_url = "https://x/gpu/installer?profile=image%2Fqwen-image&mode=managed")),
            null)!!
        assertTrue(url.contains("profile=image%2Fqwen-image"))
        assertTrue(url.contains("mode=managed"))
    }

    @Test
    fun instructionSteps_bundleFlowAndDegradedStatesMapped() {
        for (id in listOf("download-bundle", "unpack-bundle", "configure-worker", "start-worker", "installer-unavailable", "platform-planned")) {
            assertTrue(id, WorkerSetupHelpers.stepTitleKey(id) != null)
            assertTrue(id, WorkerSetupHelpers.stepBodyKey(id) != null)
        }
        assertEquals("worker_setup_step_download_bundle_title", WorkerSetupHelpers.stepTitleKey("download-bundle"))
        assertEquals("worker_setup_step_start_worker_body", WorkerSetupHelpers.stepBodyKey("start-worker"))
        assertEquals("worker_setup_step_installer_unavailable_title", WorkerSetupHelpers.stepTitleKey("installer-unavailable"))
    }

    // ── Misc ─────────────────────────────────────────────────────────────

    @Test
    fun formatDiskBudget_bytesToHumanGb() {
        assertEquals("12 GB", WorkerSetupHelpers.formatDiskBudget(12L * 1024 * 1024 * 1024))
        // 9.5 GB — one decimal below 10
        assertEquals("9.5 GB", WorkerSetupHelpers.formatDiskBudget((9.5 * 1024.0 * 1024.0 * 1024.0).toLong()))
        assertNull(WorkerSetupHelpers.formatDiskBudget(null))
        assertNull(WorkerSetupHelpers.formatDiskBudget(0))
        assertNull(WorkerSetupHelpers.formatDiskBudget(-1))
    }

    // ── Legacy compatibility path stays intact ───────────────────────────

    @Test
    fun legacy_singleFileFlowStillWorksAsFallback() {
        val c = BetaSettingsHelpers.buildSetupContract("https://app.example/", "wrk.id.secret", "image", "Home RTX")
        assertEquals("node worker.cjs", c.runCommand)
        assertEquals("https://app.example/gpu/worker-source", c.sourceUrl)
        val block = BetaSettingsHelpers.renderEnvBlock(c)
        assertTrue(block.contains("WORKER_TYPE=image"))
        assertTrue(block.contains("ANIMASTOR_WORKER_TOKEN=wrk.id.secret"))
        // the key never lands in HUB_URL (first env line)
        assertFalse(block.split("\n")[0].contains("wrk.id.secret"))
        assertTrue(BetaSettingsHelpers.looksLikeWorkerToken("wrk.abc.def123"))
        assertFalse(BetaSettingsHelpers.looksLikeWorkerToken("not-a-token"))
    }
}
