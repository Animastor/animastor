package com.example.animastor.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.example.animastor.BuildConfig
import com.example.animastor.R
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.PrivateWorker
import com.example.animastor.repository.SetupInstructions
import com.example.animastor.repository.SetupMethod
import com.example.animastor.repository.SetupProfile
import com.example.animastor.repository.SetupWorkflow
import com.example.animastor.ui.WorkerSetupHelpers.MODE_EXISTING
import com.example.animastor.ui.WorkerSetupHelpers.MODE_MANAGED
import com.example.animastor.ui.WorkerSetupHelpers.WizardState
import com.example.animastor.ui.WorkerSetupHelpers.WizardStep
import com.google.android.material.button.MaterialButton
import com.google.android.material.color.MaterialColors
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import kotlinx.coroutines.launch
import org.json.JSONObject
import retrofit2.HttpException

/**
 * Private Worker Setup Center (Phase 3.1) — canonical onboarding wizard.
 * Web parity: frontends/app PrivateWorkersSection.tsx <SetupWizard> +
 * features/workers/workerSetup.ts. Native Android UX (full-screen step
 * wizard), equivalent behavior/states/constraints:
 *
 *   profile → installation mode → platform → create worker (one-time key)
 *   → installer/workflows/instructions (ALL metadata from the Setup
 *   Contract API — versions/URLs/checksums are never hardcoded).
 *
 * Unavailable modes/platforms are never presented as actionable; the legacy
 * single-file instructions remain ONLY as a compatibility fallback when the
 * Setup Contract instructions endpoint fails (web parity: LegacyInstructions).
 *
 * SECURITY: the Worker Key is a ONE-TIME disclosure held in transient
 * fragment state ([createdToken]) while the install step is open. It is
 * never persisted (SharedPreferences/files), never put into a URL, never
 * logged. Leaving the wizard drops it.
 */
class WorkerSetupWizardFragment : Fragment() {

    private companion object {
        const val KEY_STEP = "wizard_step"
        const val KEY_PROFILE = "wizard_profile"
        const val KEY_MODE = "wizard_mode"
        const val KEY_PLATFORM = "wizard_platform"
        const val KEY_NAME = "wizard_name"
    }

    private var root: LinearLayout? = null
    private var contentContainer: LinearLayout? = null
    private var errorView: TextView? = null
    private var backBtn: MaterialButton? = null
    private var nextBtn: MaterialButton? = null
    private var createBtn: MaterialButton? = null
    private var doneBtn: MaterialButton? = null

    private var state: WizardState = WorkerSetupHelpers.initialWizardState()
    private var profiles: List<SetupProfile>? = null
    private var methods: List<SetupMethod>? = null
    private var busy = false

    // Worker creation result — the ONE-TIME key lives here only while the
    // wizard is open; onDestroyView drops it (web parity: SetupWizard state).
    private var createdToken: String? = null
    private var createdWorker: PrivateWorker? = null
    private var nameInput: TextInputEditText? = null
    private var workerName: String = ""

    // Install-step data (fetched once the worker exists).
    private var workflows: List<SetupWorkflow>? = null
    private var instructions: SetupInstructions? = null
    private var instructionsFailed = false

    /** Refresh the worker list when the wizard closes after a creation. */
    var onWizardDone: (() -> Unit)? = null

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val ctx = requireContext()
        fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()

        val rootLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSurfaceDim))
        }

        // Toolbar (same composition as the other settings screens)
        val toolbar = androidx.appcompat.widget.Toolbar(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                resources.getDimensionPixelSize(androidx.appcompat.R.dimen.abc_action_bar_default_height_material)
            )
            setBackgroundColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSurface))
            title = getString(R.string.worker_setup_center_title)
            setTitleTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
            val navIcon = TypedValue()
            if (ctx.theme.resolveAttribute(androidx.appcompat.R.attr.homeAsUpIndicator, navIcon, true)) {
                setNavigationIcon(navIcon.resourceId)
            }
            setNavigationOnClickListener { closeWizard() }
        }
        rootLayout.addView(toolbar)

        errorView = TextView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(dp(16), dp(12), dp(16), 0) }
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            visibility = View.GONE
        }
        rootLayout.addView(errorView)

        contentContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        val scroll = ScrollView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
            )
            addView(contentContainer)
        }
        rootLayout.addView(scroll)

        // Footer: Back / Next / Create / Done (visibility per step — web parity)
        val footer = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(16), dp(8), dp(16), dp(16))
        }
        backBtn = MaterialButton(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(44), 1f).apply { marginEnd = dp(8) }
            text = getString(R.string.worker_setup_back)
            setOnClickListener { onBack() }
        }
        nextBtn = MaterialButton(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(44), 1f)
            text = getString(R.string.worker_setup_next)
            setOnClickListener { onNext() }
        }
        createBtn = MaterialButton(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(44), 1f)
            text = getString(R.string.worker_create)
            setOnClickListener { onCreateWorker() }
        }
        doneBtn = MaterialButton(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(44), 1f)
            text = getString(R.string.worker_done)
            setOnClickListener { closeWizard() }
        }
        footer.addView(backBtn)
        footer.addView(nextBtn)
        footer.addView(createBtn)
        footer.addView(doneBtn)
        rootLayout.addView(footer)

        root = rootLayout
        return rootLayout
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        // Restore wizard selections across configuration changes. The ONE-TIME
        // key is NEVER saved (security invariant): if rotation kills the install
        // step, the wizard degrades to the first step — same as a page reload
        // on the web (the worker exists server-side; the key can be rotated).
        savedInstanceState?.let { s ->
            val stepName = s.getString(KEY_STEP)
            val restored = WizardStep.entries.find { it.name == stepName }
            if (restored != null && restored != WizardStep.INSTALL) {
                state = WizardState(
                    step = restored,
                    profileId = s.getString(KEY_PROFILE),
                    mode = s.getString(KEY_MODE),
                    platform = s.getString(KEY_PLATFORM)
                )
                workerName = s.getString(KEY_NAME) ?: ""
            }
        }
        loadContract()
        render()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(KEY_STEP, state.step.name)
        outState.putString(KEY_PROFILE, state.profileId)
        outState.putString(KEY_MODE, state.mode)
        outState.putString(KEY_PLATFORM, state.platform)
        outState.putString(KEY_NAME, workerName)
    }

    private fun loadContract() {
        lifecycleScope.launch {
            try {
                val p = RetrofitClient.api.setupProfiles()
                val m = RetrofitClient.api.setupMethods()
                if (!isAdded) return@launch
                profiles = p.profiles
                methods = m.methods
                render()
            } catch (e: Throwable) {
                if (isAdded) showError(humanError(e))
            }
        }
    }

    // ── Wizard navigation (pure rules: WorkerSetupHelpers) ──────────────

    private val selectedProfile: SetupProfile?
        get() = profiles?.find { it.id == state.profileId }

    private val selectedMethod: SetupMethod?
        get() = methods?.let { ms -> state.platform?.let { WorkerSetupHelpers.pickMethod(ms, it) } }

    private fun nameValid(): Boolean {
        val wt = selectedProfile?.worker_type ?: "image"
        return BetaSettingsHelpers.validateCreateInput(workerName, wt).ok
    }

    private fun onNext() {
        val n = WorkerSetupHelpers.nextStep(state) ?: return
        state = state.copy(step = n)
        render()
    }

    private fun onBack() {
        val p = WorkerSetupHelpers.prevStep(state) ?: return
        state = state.copy(step = p)
        render()
    }

    private fun closeWizard() {
        if (busy) return
        parentFragmentManager.popBackStack()
    }

    // ── Step rendering ───────────────────────────────────────────────────

    private fun render() {
        val b = contentContainer ?: return
        b.removeAllViews()
        updateFooter()
        when (state.step) {
            WizardStep.PROFILE -> renderProfileStep(b)
            WizardStep.MODE -> renderModeStep(b)
            WizardStep.PLATFORM -> renderPlatformStep(b)
            WizardStep.CREATE -> renderCreateStep(b)
            WizardStep.INSTALL -> renderInstallStep(b)
        }
    }

    private fun updateFooter() {
        val platformOk = WorkerSetupHelpers.platformSelectable(selectedMethod, state.mode)
        val canNext = WorkerSetupHelpers.canGoNext(state, platformOk, nameValid())
        backBtn?.visibility =
            if (state.step != WizardStep.PROFILE && state.step != WizardStep.INSTALL) View.VISIBLE else View.GONE
        nextBtn?.visibility =
            if (state.step != WizardStep.INSTALL && state.step != WizardStep.CREATE) View.VISIBLE else View.GONE
        nextBtn?.isEnabled = canNext && !busy
        createBtn?.visibility = if (state.step == WizardStep.CREATE) View.VISIBLE else View.GONE
        createBtn?.isEnabled = nameValid() && !busy
        doneBtn?.visibility = if (state.step == WizardStep.INSTALL) View.VISIBLE else View.GONE
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()

    private fun stepLabel(parent: LinearLayout, text: String): TextView = TextView(requireContext()).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setTypeface(Typeface.DEFAULT_BOLD)
        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
        setPadding(0, dp(8), 0, dp(8))
        parent.addView(this)
    }

    private fun hintView(parent: LinearLayout, text: String): TextView = TextView(requireContext()).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
        setLineSpacing(0f, 1.3f)
        parent.addView(this)
    }

    private fun codeBlock(parent: LinearLayout, text: String): TextView = TextView(requireContext()).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTypeface(Typeface.MONOSPACE)
        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
        background = ContextCompat.getDrawable(requireContext(), R.drawable.bg_dialog_notice)
        setPadding(dp(10), dp(8), dp(10), dp(8))
        setTextIsSelectable(true)
        parent.addView(this)
    }

    // ── Step 1: profile (one card per worker type, recommended profile) ──

    private fun renderProfileStep(b: LinearLayout) {
        val ps = profiles
        if (ps == null) {
            hintView(b, getString(R.string.play_loading))
            return
        }
        stepLabel(b, getString(R.string.worker_setup_choose_profile))
        for (group in WorkerSetupHelpers.groupProfilesByType(ps)) {
            val rec = group.recommended
            val card = com.google.android.material.card.MaterialCardView(requireContext()).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(10) }
                radius = dp(16).toFloat()
                cardElevation = dp(1).toFloat()
            }
            val inner = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), dp(14), dp(16), dp(14))
            }
            val typeText = when (group.workerType) {
                "audio" -> getString(R.string.layer_audio)
                "image" -> getString(R.string.layer_image)
                else -> getString(R.string.layer_video)
            }
            TextView(requireContext()).apply {
                text = typeText
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                inner.addView(this)
            }
            TextView(requireContext()).apply {
                text = rec.name ?: rec.id ?: ""
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                setTypeface(Typeface.DEFAULT_BOLD)
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
                inner.addView(this)
            }
            TextView(requireContext()).apply {
                text = getString(R.string.worker_setup_recommended)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorPrimary))
                inner.addView(this)
            }
            WorkerSetupHelpers.formatDiskBudget(rec.disk_budget_bytes_approx)?.let { budget ->
                TextView(requireContext()).apply {
                    text = getString(R.string.worker_setup_disk_budget, budget)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                    setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                    inner.addView(this)
                }
            }
            if (rec.status == "draft") {
                TextView(requireContext()).apply {
                    text = getString(R.string.worker_setup_draft_badge)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                    setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                    inner.addView(this)
                }
            }
            MaterialButton(requireContext()).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(42)
                ).apply { topMargin = dp(10) }
                text = getString(R.string.worker_setup_set_up)
                setOnClickListener {
                    state = state.copy(profileId = rec.id, step = WizardStep.MODE)
                    render()
                }
                inner.addView(this)
            }
            card.addView(inner)
            b.addView(card)
        }
    }

    // ── Step 2: installation mode (gated by real artifact capabilities) ──

    private fun renderModeStep(b: LinearLayout) {
        val ms = methods ?: return
        val avail = WorkerSetupHelpers.linuxModeAvailability(ms)
        stepLabel(b, getString(R.string.worker_setup_mode_title))
        b.addView(modeChoiceRow(
            checked = state.mode == MODE_MANAGED,
            enabled = avail.managed,
            title = getString(R.string.worker_setup_mode_managed),
            desc = if (avail.managed) getString(R.string.worker_setup_mode_managed_desc)
                   else getString(R.string.worker_setup_mode_managed_unavailable),
            onPick = { state = state.copy(mode = MODE_MANAGED); render() }
        ))
        b.addView(modeChoiceRow(
            checked = state.mode == MODE_EXISTING,
            enabled = avail.existing,
            title = getString(R.string.worker_setup_mode_existing),
            desc = if (avail.existing) getString(R.string.worker_setup_mode_existing_desc)
                   else getString(R.string.worker_setup_mode_existing_unavailable),
            onPick = { state = state.copy(mode = MODE_EXISTING); render() }
        ))
        if (state.mode == MODE_EXISTING) {
            TextView(requireContext()).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(8) }
                text = getString(R.string.worker_setup_existing_warning)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                background = ContextCompat.getDrawable(requireContext(), R.drawable.bg_dialog_notice)
                setPadding(dp(12), dp(10), dp(12), dp(10))
                setLineSpacing(0f, 1.3f)
                b.addView(this)
            }
        }
    }

    private fun modeChoiceRow(checked: Boolean, enabled: Boolean, title: String, desc: String, onPick: () -> Unit): View {
        val ctx = requireContext()
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
            alpha = if (enabled) 1f else 0.5f
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_dialog_notice)
            isClickable = enabled
            isFocusable = enabled
        }
        val radio = RadioButton(ctx).apply {
            isChecked = checked
            isEnabled = enabled
            isClickable = false
        }
        row.addView(radio)
        val textCol = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        TextView(ctx).apply {
            text = title
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTypeface(Typeface.DEFAULT_BOLD)
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
            textCol.addView(this)
        }
        TextView(ctx).apply {
            text = desc
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            setLineSpacing(0f, 1.3f)
            textCol.addView(this)
        }
        row.addView(textCol)
        if (enabled) row.setOnClickListener { onPick() }
        val wrapper = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(8) }
            addView(row)
        }
        return wrapper
    }

    // ── Step 3: platform (unavailable ones never actionable) ─────────────

    private fun renderPlatformStep(b: LinearLayout) {
        val ms = methods ?: return
        stepLabel(b, getString(R.string.worker_setup_platform_title))
        for (opt in WorkerSetupHelpers.platformOptions(ms, state.mode)) {
            val platformName = when (opt.platform) {
                "linux" -> "Linux"
                "windows" -> "Windows"
                else -> "Docker"
            }
            val stateText = getString(stringResForPlatformState(opt.stateKey)) +
                if (opt.selectable && opt.installerVersion != null) " · v${opt.installerVersion}" else ""
            b.addView(modeChoiceRow(
                checked = state.platform == opt.platform,
                enabled = opt.selectable,
                title = platformName,
                desc = stateText,
                onPick = { state = state.copy(platform = opt.platform); render() }
            ))
        }
    }

    private fun stringResForPlatformState(key: String): Int = when (key) {
        "worker_setup_platform_ready" -> R.string.worker_setup_platform_ready
        "worker_setup_platform_existing_only" -> R.string.worker_setup_platform_existing_only
        "worker_setup_platform_no_installer" -> R.string.worker_setup_platform_no_installer
        "worker_setup_platform_soon" -> R.string.worker_setup_platform_soon
        else -> R.string.worker_setup_platform_unavailable
    }

    // ── Step 4: create worker (name; type comes from the profile) ────────

    private fun renderCreateStep(b: LinearLayout) {
        val profile = selectedProfile ?: return
        stepLabel(b, getString(R.string.worker_setup_create_title))
        hintView(b, getString(R.string.worker_setup_create_body))

        val nameLayout = TextInputLayout(
            requireContext(), null, com.google.android.material.R.attr.textInputOutlinedStyle
        ).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(12) }
            hint = getString(R.string.worker_name)
            addView(TextInputEditText(requireContext()).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
                )
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                inputType = InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                hint = getString(R.string.worker_name_hint)
                setText(workerName)
                setSelection(workerName.length)
                addTextChangedListener(object : android.text.TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, st: Int, c: Int, a: Int) {}
                    override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) {
                        workerName = s?.toString() ?: ""
                        updateFooter()
                    }
                    override fun afterTextChanged(s: android.text.Editable?) {}
                })
            })
        }
        nameInput = nameLayout.editText as TextInputEditText
        b.addView(nameLayout)
        hintView(b, "${getString(R.string.worker_type_label)}: ${
            when (profile.worker_type) {
                "audio" -> getString(R.string.layer_audio)
                "image" -> getString(R.string.layer_image)
                else -> getString(R.string.layer_video)
            }
        }").apply { setPadding(0, dp(8), 0, 0) }
    }

    private fun onCreateWorker() {
        val profile = selectedProfile ?: return
        if (busy) return
        val v = BetaSettingsHelpers.validateCreateInput(workerName, profile.worker_type ?: "image")
        if (!v.ok) {
            showError(getString(stringResForWorkerError(v.errorKey)))
            return
        }
        busy = true
        updateFooter()
        hideError()
        lifecycleScope.launch {
            try {
                val res = RetrofitClient.api.createWorker(
                    com.example.animastor.repository.CreateWorkerRequest(v.name, v.workerType)
                )
                if (!isAdded) return@launch
                createdToken = res.token
                createdWorker = res.worker
                state = state.copy(step = WizardStep.INSTALL)
                render()
                loadInstallData(profile.id ?: "", state.platform ?: "linux", state.mode ?: MODE_MANAGED)
            } catch (e: Throwable) {
                if (isAdded) showError(humanError(e))
            } finally {
                busy = false
                if (isAdded) updateFooter()
            }
        }
    }

    private fun loadInstallData(profileId: String, platform: String, mode: String) {
        lifecycleScope.launch {
            try {
                val wf = RetrofitClient.api.setupWorkflows(profileId)
                if (isAdded) { workflows = wf.workflows; render() }
            } catch (_: Throwable) { /* workflows stay null → "—" */ }
            try {
                val ins = RetrofitClient.api.setupInstructions(profileId, platform, mode)
                if (!isAdded) return@launch
                instructions = ins
                render()
            } catch (_: Throwable) {
                // Compatibility path — legacy single-file contract (web parity).
                if (isAdded) { instructionsFailed = true; render() }
            }
        }
    }

    // ── Step 5: install (one-time key + artifacts + workflows + steps) ───

    private fun renderInstallStep(b: LinearLayout) {
        val ctx = requireContext()
        val token = createdToken
        val worker = createdWorker
        if (token == null || worker == null) return
        val method = selectedMethod
        val mode = state.mode ?: MODE_MANAGED

        // One-time Worker Key (existing secure lifecycle — Phase 3.1 §14)
        TextView(ctx).apply {
            text = getString(R.string.worker_credential_warning)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_dialog_notice)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setLineSpacing(0f, 1.3f)
            b.addView(this)
        }
        stepLabel(b, getString(R.string.worker_setup_key_title))
        codeBlock(b, token)
        MaterialButton(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40)).apply { topMargin = dp(6) }
            text = getString(R.string.worker_copy)
            setOnClickListener {
                copyToClipboard("animastor-worker-token", token)
                text = getString(R.string.worker_copied)
                postDelayed({ text = getString(R.string.worker_copy) }, 1800)
            }
            b.addView(this)
        }
        hintView(b, getString(R.string.worker_setup_key_installer_note)).apply { setPadding(0, dp(6), 0, 0) }

        // Installer artifact — the instructions contract carries the
        // profile-embedded bootstrap script URL (it always wins over the
        // generic method artifact, a fallback for the loading state).
        // Version prominent; SHA-256 in a collapsed block (shown once).
        val instructionsVal = instructions
        val installerUrl = WorkerSetupHelpers.resolveArtifactUrl(
            WorkerSetupHelpers.installerDownloadUrl(instructionsVal, method), BuildConfig.BASE_URL)
        val installerVersionStr = WorkerSetupHelpers.installerVersion(instructionsVal, method)
        val installerSha = WorkerSetupHelpers.installerSha256(instructionsVal, method)
        stepLabel(b, getString(R.string.worker_setup_installer_title))
        if (installerUrl != null) {
            hintView(b, if (installerVersionStr != null)
                getString(R.string.worker_setup_installer_version_line, installerVersionStr)
            else getString(R.string.worker_setup_version_fmt, "\u2014"))
            MaterialButton(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(42)).apply { topMargin = dp(6) }
                text = getString(R.string.worker_setup_download_installer)
                setOnClickListener { openDownload(installerUrl) }
                b.addView(this)
            }
            if (installerSha != null) {
                collapsibleBlock(b, getString(R.string.worker_setup_checksum)) { inner ->
                    TextView(ctx).apply {
                        text = installerSha
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                        setTypeface(Typeface.MONOSPACE)
                        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                        setPadding(0, dp(4), 0, 0)
                        inner.addView(this)
                    }
                }
            }
        } else {
            val bundle = method?.worker_bundle
            hintView(b, if (bundle?.available == true)
                getString(R.string.worker_setup_installer_down_existing_hint)
            else
                getString(R.string.worker_setup_installer_unavailable))
        }

        // Worker runtime bundle — primary artifact for the bundle-based
        // Existing ComfyUI flow; otherwise a note (installer provisions it).
        val bundle = method?.worker_bundle
        val bundleUrl = WorkerSetupHelpers.resolveArtifactUrl(bundle?.download_url, BuildConfig.BASE_URL)
        val bundlePrimary = WorkerSetupHelpers.bundleIsPrimaryArtifact(mode, method?.installer, bundle)
        if (bundle != null && bundle.available && bundleUrl != null && bundlePrimary) {
            stepLabel(b, getString(R.string.worker_setup_bundle_title))
            val meta = buildString {
                append(getString(R.string.worker_setup_version_fmt, bundle.version ?: "\u2014"))
                if (bundle.sha256 != null) append(" \u00B7 SHA-256: ${bundle.sha256.take(12)}\u2026")
            }
            hintView(b, meta)
            MaterialButton(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(42)).apply { topMargin = dp(6) }
                text = getString(R.string.worker_setup_download_bundle)
                setOnClickListener { openDownload(bundleUrl) }
                b.addView(this)
            }
        } else if (bundle != null && bundle.available && bundle.version != null) {
            hintView(b, getString(R.string.worker_setup_bundle_note, bundle.version)).apply { setPadding(0, dp(8), 0, 0) }
        }

        // Baseline workflows — OPTIONAL artifacts (never a runtime dependency):
        // the installer fetches the profile's workflows itself; these downloads
        // exist only for manual experiments in the ComfyUI editor.
        stepLabel(b, getString(R.string.worker_setup_workflows_title))
        val wfs = workflows
        if (wfs == null) {
            hintView(b, getString(R.string.play_loading))
        } else if (wfs.isEmpty()) {
            hintView(b, getString(R.string.worker_setup_workflow_none))
        } else {
            for (wf in wfs) {
                val url = WorkerSetupHelpers.resolveArtifactUrl(wf.download_url, BuildConfig.BASE_URL)
                val row = LinearLayout(ctx).apply {
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(6) }
                    orientation = LinearLayout.HORIZONTAL
                    gravity = android.view.Gravity.CENTER_VERTICAL
                }
                TextView(ctx).apply {
                    text = wf.name ?: wf.id ?: ""
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                    setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    row.addView(this)
                }
                if (wf.baseline_available && url != null) {
                    MaterialButton(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(38))
                        text = getString(R.string.worker_setup_workflow_download)
                        setOnClickListener { openDownload(url) }
                        row.addView(this)
                    }
                } else {
                    TextView(ctx).apply {
                        text = getString(R.string.worker_setup_workflow_unavailable)
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                        row.addView(this)
                    }
                }
                b.addView(row)
            }
            hintView(b, getString(R.string.worker_setup_workflow_optional))
        }

        // Instructions — generated from API metadata (Phase 3.1 §15).
        stepLabel(b, getString(R.string.worker_setup_instructions_title))
        if (instructionsVal != null) {
            instructionsVal.steps.forEachIndexed { i, s ->
                val title = WorkerSetupHelpers.stepTitleKey(s.id)?.let { stringResForStepKey(it) }?.let { getString(it) }
                    ?: s.title ?: ""
                val body = WorkerSetupHelpers.stepBodyKey(s.id)?.let { stringResForStepKey(it) }?.let { getString(it) }
                    ?: s.body ?: ""
                TextView(ctx).apply {
                    text = "${i + 1}. $title"
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                    setTypeface(Typeface.DEFAULT_BOLD)
                    setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface))
                    setPadding(0, dp(8), 0, dp(2))
                    b.addView(this)
                }
                hintView(b, body)
                s.code?.let { code ->
                    codeBlock(b, code).apply {
                        (layoutParams as? LinearLayout.LayoutParams)?.topMargin = dp(6)
                    }
                }
                // Checksum — collapsed by default (web parity: <details>).
                val cs = s.checksum
                val csValue = cs?.value
                if (csValue != null) {
                    collapsibleBlock(b, "${getString(R.string.worker_setup_checksum)}: ${csValue.take(12)}\u2026") { inner ->
                        TextView(ctx).apply {
                            text = csValue
                            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                            setTypeface(Typeface.MONOSPACE)
                            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
                            setPadding(0, dp(4), 0, 0)
                            inner.addView(this)
                        }
                        cs.verify_code?.let { verify ->
                            codeBlock(inner, verify)
                        }
                    }
                }
            }
            // Optional terminal diagnostics — never a required step: the page
            // itself shows the worker status (ONLINE after the first heartbeat).
            instructionsVal.verify_command?.let { cmd ->
                collapsibleBlock(b, getString(R.string.worker_setup_verify_command_label)) { inner ->
                    codeBlock(inner, cmd)
                }
            }
        } else if (instructionsFailed) {
            // Compatibility path — legacy single-file contract (kept, not canonical).
            renderLegacyInstructions(b, token, worker)
        } else {
            hintView(b, getString(R.string.play_loading))
        }

        hintView(b, getString(R.string.worker_setup_verify_hint)).apply { setPadding(0, dp(12), 0, 0) }
    }

    /** Collapsed "summary ▸" row + expandable content (web parity: <details>).
     *  Tapping the summary toggles the content visibility; starts collapsed. */
    private fun collapsibleBlock(b: LinearLayout, summary: String, content: (LinearLayout) -> Unit) {
        val ctx = requireContext()
        val contentBox = LinearLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(6) }
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        content(contentBox)
        val toggle = TextView(ctx).apply {
            text = "▸ $summary"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant))
            setPadding(0, dp(6), 0, 0)
            isClickable = true
            isFocusable = true
            setOnClickListener {
                val open = contentBox.visibility == View.GONE
                contentBox.visibility = if (open) View.VISIBLE else View.GONE
                text = "${if (open) "▾" else "▸"} $summary"
            }
            b.addView(this)
        }
        b.addView(contentBox)
        // keep a reference so lint does not complain about the unused binding
        toggle.isActivated = false
    }

    private fun renderLegacyInstructions(b: LinearLayout, token: String, worker: PrivateWorker) {
        val contract = BetaSettingsHelpers.buildSetupContract(
            baseUrl = BuildConfig.BASE_URL,
            token = token,
            workerType = worker.worker_type ?: "audio",
            workerName = worker.name ?: ""
        )
        val steps = listOf(
            getString(R.string.worker_setup_step_1) + "\n" + contract.downloadCommand,
            getString(R.string.worker_setup_step_2),
            getString(R.string.worker_setup_step_3),
            getString(R.string.worker_setup_step_4) + "\n" + contract.runCommand,
            getString(R.string.worker_setup_step_5)
        )
        hintView(b, steps.mapIndexed { i, s -> "${i + 1}. $s" }.joinToString("\n"))
        codeBlock(b, BetaSettingsHelpers.renderEnvBlock(contract)).apply {
            (layoutParams as? LinearLayout.LayoutParams)?.topMargin = dp(6)
        }
    }

    private fun stringResForStepKey(key: String): Int = when (key) {
        "worker_setup_step_prereq_title" -> R.string.worker_setup_step_prereq_title
        "worker_setup_step_prereq_body" -> R.string.worker_setup_step_prereq_body
        "worker_setup_step_download_bootstrap_title" -> R.string.worker_setup_step_download_bootstrap_title
        "worker_setup_step_download_bootstrap_body" -> R.string.worker_setup_step_download_bootstrap_body
        "worker_setup_step_run_bootstrap_title" -> R.string.worker_setup_step_run_bootstrap_title
        "worker_setup_step_run_bootstrap_body" -> R.string.worker_setup_step_run_bootstrap_body
        "worker_setup_step_download_bundle_title" -> R.string.worker_setup_step_download_bundle_title
        "worker_setup_step_download_bundle_body" -> R.string.worker_setup_step_download_bundle_body
        "worker_setup_step_unpack_bundle_title" -> R.string.worker_setup_step_unpack_bundle_title
        "worker_setup_step_unpack_bundle_body" -> R.string.worker_setup_step_unpack_bundle_body
        "worker_setup_step_configure_worker_title" -> R.string.worker_setup_step_configure_worker_title
        "worker_setup_step_configure_worker_body" -> R.string.worker_setup_step_configure_worker_body
        "worker_setup_step_start_worker_title" -> R.string.worker_setup_step_start_worker_title
        "worker_setup_step_start_worker_body" -> R.string.worker_setup_step_start_worker_body
        "worker_setup_step_verify_title" -> R.string.worker_setup_step_verify_title
        "worker_setup_step_verify_body" -> R.string.worker_setup_step_verify_body
        "worker_setup_step_installer_unavailable_title" -> R.string.worker_setup_step_installer_unavailable_title
        "worker_setup_step_installer_unavailable_body" -> R.string.worker_setup_step_installer_unavailable_body
        "worker_setup_step_planned_title" -> R.string.worker_setup_step_planned_title
        else -> R.string.worker_setup_step_planned_body
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private fun openDownload(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: Exception) {
            Toast.makeText(requireContext(), R.string.worker_copy_failed, Toast.LENGTH_SHORT).show()
        }
    }

    private fun copyToClipboard(label: String, text: String) {
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, text))
    }

    private fun showError(msg: String) {
        errorView?.text = msg
        errorView?.visibility = View.VISIBLE
    }

    private fun hideError() {
        errorView?.visibility = View.GONE
    }

    private fun stringResForWorkerError(key: String?): Int = when (key) {
        "worker_name_required" -> R.string.worker_name_required
        "worker_name_too_long" -> R.string.worker_name_too_long
        "worker_type_invalid" -> R.string.worker_type_invalid
        else -> R.string.auth_error
    }

    /** Map an API error to a user-facing localized message (web parity:
     *  humanError — hide DB/Redis internals). */
    private fun humanError(e: Throwable): String {
        if (e is HttpException) {
            return when (e.code()) {
                401 -> getString(R.string.worker_err_auth_required)
                403 -> getString(R.string.worker_err_forbidden)
                404 -> getString(R.string.worker_err_not_found)
                in 500..599 -> getString(R.string.worker_err_unavailable)
                else -> {
                    val body = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
                    val msg = body?.let {
                        runCatching { JSONObject(it).optString("error").ifEmpty { null } }.getOrNull()
                    }
                    msg ?: getString(R.string.worker_err_unavailable)
                }
            }
        }
        return e.message ?: getString(R.string.worker_err_unavailable)
    }

    override fun onDestroyView() {
        // Closing the wizard (any exit path) refreshes the list when a worker
        // was created (web parity: onClose → load), and drops the one-time key
        // reference — it is never persisted.
        if (createdWorker != null) onWizardDone?.invoke()
        createdToken = null
        createdWorker = null
        nameInput = null
        root = null
        contentContainer = null
        errorView = null
        backBtn = null
        nextBtn = null
        createBtn = null
        doneBtn = null
        super.onDestroyView()
    }
}
