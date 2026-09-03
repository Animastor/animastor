// ─────────────────────────────────────────────────────────────────────────
// Local AI Connector settings (Local AI Connector V1 — Phase 6)
// ─────────────────────────────────────────────────────────────────────────
// Web parity: frontends/app /settings/local-ai (LocalAISection). Minimal
// equivalent UX over the SAME backend API and concepts:
//   Connector → Status → Runtime → Models → Test → Revoke/Rotate → binding.
//
// The fragment talks to RetrofitClient.api directly in lifecycleScope (the
// AiProviderSettingsFragment pattern); logic lives in LocalAiHelpers for
// JVM tests. No separate Android architecture.
//
// SECURITY: the one-time llmcreg.*/llmc.* credential is shown in a transient
// MaterialAlertDialog; dismissing the dialog is the ONLY exit and the token
// reference dies with this scope — never persisted, never re-displayable.
// No URL input anywhere (AD-5): the runtime URL is local connector config.
package com.example.animastor.ui

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.example.animastor.R
import com.example.animastor.databinding.FragmentLocalAiSettingsBinding
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.AiConnectorModelsRow
import com.example.animastor.repository.AiConnectorStatusRow
import com.example.animastor.repository.CreateAiConnectorRequest
import com.google.android.material.button.MaterialButton
import com.google.android.material.color.MaterialColors
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch
import org.json.JSONObject
import retrofit2.HttpException

class LocalAiSettingsFragment : Fragment(R.layout.fragment_local_ai_settings) {

    private var binding: FragmentLocalAiSettingsBinding? = null

    // Transient UI state (never persisted)
    private var connectors: List<AiConnectorStatusRow> = emptyList()
    private var modelsBy: Map<String, List<String>> = emptyMap()
    private var boundConnectorId: String? = null
    private var boundModel: String? = null
    private var loaded = false
    private var busy = false
    // Per-connector model selection (transient; empty = backend default)
    private val selectedModel = mutableMapOf<String, String>()
    private var typeInitialized = false

    companion object {
        private val RUNTIME_LABELS = mapOf(
            "ollama" to R.string.local_ai_runtime_ollama,
            "vllm" to R.string.local_ai_runtime_vllm,
            "llamacpp" to R.string.local_ai_runtime_llamacpp,
            "lmstudio" to R.string.local_ai_runtime_lmstudio,
            "openai-compatible" to R.string.local_ai_runtime_openai_compatible,
        )
    }

    // ── lifecycle ─────────────────────────────────────────────────────────

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val b = binding ?: return
        b.toolbar.setNavigationOnClickListener { parentFragmentManager.popBackStack() }

        val labels = LocalAiHelpers.RUNTIME_TYPES.map { getString(RUNTIME_LABELS[it] ?: R.string.local_ai_runtime_openai_compatible) }
        b.runtimeTypeSpinner.adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_dropdown_item, labels)
        b.runtimeTypeSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) { typeInitialized = true }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }

        b.createButton.setOnClickListener { onCreate() }
        b.unbindButton.setOnClickListener { onUnbind() }
        load()
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val v = super.onCreateView(inflater, container, savedInstanceState)!!
        binding = FragmentLocalAiSettingsBinding.bind(v)
        return v
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }

    // ── data ──────────────────────────────────────────────────────────────

    private fun load() {
        if (busy) return
        lifecycleScope.launch {
            try {
                val status = RetrofitClient.api.getAiConnectorStatus()
                val models = RetrofitClient.api.getAiConnectorModels()
                val provider = RetrofitClient.api.getAiProvider()
                connectors = status.connectors
                modelsBy = models.connectors.associate { it.connectorId to it.models }
                if (provider.provider?.provider_type == "local-ai") {
                    boundConnectorId = provider.provider.connector_id
                    boundModel = provider.provider.model
                } else {
                    boundConnectorId = null
                    boundModel = null
                }
                loaded = true
                render()
            } catch (e: Exception) {
                showError(friendlyError(e))
            }
        }
    }

    // ── render ────────────────────────────────────────────────────────────

    private fun render() {
        val b = binding ?: return
        val pt = boundConnectorId
        if (pt != null) {
            val connName = connectors.find { it.connectorId == pt }?.name ?: "—"
            b.bindingLabel.text = getString(
                R.string.local_ai_binding_active_fmt,
                connName,
                boundModel ?: getString(R.string.local_ai_model_auto),
            )
            b.unbindButton.visibility = View.VISIBLE
        } else {
            b.bindingLabel.text = getString(R.string.local_ai_binding_none)
            b.unbindButton.visibility = View.GONE
        }

        val container = b.connectorsContainer
        container.removeAllViews()
        if (!loaded) {
            b.listHintLabel.visibility = View.VISIBLE
            b.listHintLabel.setText(R.string.play_loading)
            return
        }
        if (connectors.isEmpty()) {
            b.listHintLabel.visibility = View.VISIBLE
            b.listHintLabel.setText(R.string.local_ai_empty)
            return
        }
        b.listHintLabel.visibility = View.GONE
        for (c in connectors) container.addView(buildRow(c))
    }

    /** One connector row — status pill (worker pattern), runtime facts,
     *  discovered models (never claimed loaded), model picker, actions. */
    private fun buildRow(c: AiConnectorStatusRow): View {
        val ctx = requireContext()
        val dp = { v: Int -> (v * resources.displayMetrics.density).toInt() }
        val root = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val params = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        params.setMargins(0, dp(12), 0, dp(4))
        root.layoutParams = params

        // Name + status pill
        val header = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL }
        header.addView(TextView(ctx).apply {
            text = c.name
            textSize = 14f
            setTextColor(colorAttr(androidx.appcompat.R.attr.colorPrimary))
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        if (boundConnectorId == c.connectorId) {
            header.addView(pill(ctx, dp, getString(R.string.local_ai_bound_badge), success = true))
        }
        val isOnline = c.live || c.status == "online"
        header.addView(pill(
            ctx, dp,
            getString(stringResForStatus(LocalAiHelpers.statusKey(c.status, c.live))),
            success = LocalAiHelpers.statusKey(c.status, c.live) == "local_ai_status_online",
        ))
        root.addView(header)

        // Facts: runtime label · runtime reachable (§7 — distinct) · last seen · version
        val runtimeLabel = getString(RUNTIME_LABELS[c.runtimeType] ?: R.string.local_ai_runtime_openai_compatible)
        val reachable = if (LocalAiHelpers.runtimeReachable(c.runtimeMeta?.runtimeOk)) {
            getString(R.string.local_ai_runtime_ok)
        } else {
            getString(R.string.local_ai_runtime_unknown)
        }
        val facts = mutableListOf(runtimeLabel, reachable, "${getString(R.string.worker_last_seen)} ${BetaSettingsHelpers.formatLastSeen(c.lastSeen)}")
        c.runtimeMeta?.runtime?.version?.takeIf { it.isNotBlank() }?.let { facts.add(it.take(64)) }
        root.addView(TextView(ctx).apply {
            text = facts.joinToString(" · ")
            textSize = 12f
            setTextColor(colorAttr(com.google.android.material.R.attr.colorOnSurfaceVariant))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) }
        })

        // Models: count + discovered ids (explicitly NOT "loaded")
        val models = modelsBy[c.connectorId] ?: emptyList()
        val modelsText = getString(R.string.local_ai_models_count, c.modelsCount) +
            if (models.isNotEmpty()) " · " + models.take(3).joinToString(", ") + (if (models.size > 3) "…" else "") else ""
        root.addView(TextView(ctx).apply {
            text = modelsText
            textSize = 12f
            setTextColor(colorAttr(com.google.android.material.R.attr.colorOnSurfaceVariant))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2) }
        })
        root.addView(TextView(ctx).apply {
            setText(R.string.local_ai_models_disclaimer)
            textSize = 11f
            setTextColor(colorAttr(com.google.android.material.R.attr.colorOnSurfaceVariant))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2) }
        })

        // Model picker for the binding (Spinner over discovered ids)
        root.addView(TextView(ctx).apply {
            setText(R.string.ai_provider_model)
            textSize = 13f
            setTextColor(colorAttr(com.google.android.material.R.attr.colorOnSurfaceVariant))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) }
        })
        val spinner = Spinner(ctx).apply {
            adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, models.ifEmpty { listOf(getString(R.string.local_ai_model_auto)) })
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40)).apply { topMargin = dp(4) }
        }
        // Preselect: bound model, else explicit selection, else default entry
        val preselect = selectedModel[c.connectorId] ?: boundModel?.takeIf { boundConnectorId == c.connectorId }
        val idx = models.indexOf(preselect).let { if (it >= 0) it else if (models.isEmpty()) 0 else -1 }
        if (idx >= 0) spinner.setSelection(idx)
        spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                selectedModel[c.connectorId] = if (models.isEmpty()) "" else models.getOrNull(pos) ?: ""
            }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        root.addView(spinner)

        // Pending hint
        if (c.status == "pending") {
            root.addView(TextView(ctx).apply {
                setText(R.string.local_ai_pending_hint)
                textSize = 12f
                setTextColor(colorAttr(com.google.android.material.R.attr.colorOnSurfaceVariant))
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) }
            })
        }

        // Actions
        val actions = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        fun actionBtn(labelRes: Int, error: Boolean = false, outlined: Boolean = true, enabled: Boolean = true, onClick: (MaterialButton) -> Unit): MaterialButton {
            val defAttr = if (error) com.google.android.material.R.attr.materialButtonOutlinedStyle
                          else (if (outlined) com.google.android.material.R.attr.materialButtonOutlinedStyle else com.google.android.material.R.attr.materialButtonStyle)
            return MaterialButton(ctx, null, defAttr).apply {
                setText(labelRes)
                if (error) setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
                this.isEnabled = enabled && !busy
                layoutParams = LinearLayout.LayoutParams(0, dp(42), 1f).apply { marginStart = dp(4); marginEnd = dp(4) }
                setOnClickListener { onClick(this) }
            }
        }
        if (c.status == "pending") {
            actions.addView(actionBtn(R.string.local_ai_reissue_token) { onReissueToken(c) })
        }
        actions.addView(actionBtn(R.string.local_ai_refresh_models) { onRefreshModels(c) })
        actions.addView(actionBtn(R.string.ai_provider_test, enabled = c.status != "pending") { onTest(c) })
        actions.addView(actionBtn(R.string.local_ai_bind, outlined = false) { onBind(c) })
        if (c.status != "pending") {
            actions.addView(actionBtn(R.string.worker_rotate_short) { onRotate(c) })
        }
        actions.addView(actionBtn(R.string.worker_revoke, error = true) { confirmRevoke(c) })
        actions.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) }
        root.addView(actions)

        return root
    }

    /** Status pill — worker-row pattern: green online, muted pending. */
    private fun pill(ctx: android.content.Context, dp: (Int) -> Int, label: String, success: Boolean): TextView {
        return TextView(ctx).apply {
            text = label
            textSize = 11f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            val fg = if (success) ctx.getColor(R.color.cinema_success)
                     else com.google.android.material.color.MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant)
            setTextColor(fg)
            background = GradientDrawable().apply {
                cornerRadius = dp(8).toFloat()
                setStroke(dp(1), fg)
            }
            setPadding(dp(8), dp(2), dp(8), dp(2))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(6) }
        }
    }

    private fun colorAttr(attrRes: Int): Int {
        val typedValue = android.util.TypedValue()
        requireContext().theme.resolveAttribute(attrRes, typedValue, true)
        return typedValue.data
    }

    private fun getColorWithAlpha(color: Int, alpha: Float): Int {
        return Color.argb((alpha * 255).toInt(), Color.red(color), Color.green(color), Color.blue(color))
    }

    private fun stringResForStatus(key: String): Int = when (key) {
        "local_ai_status_pending" -> R.string.local_ai_status_pending
        "local_ai_status_online" -> R.string.local_ai_status_online
        else -> R.string.local_ai_status_offline
    }

    // ── actions ───────────────────────────────────────────────────────────

    private fun onCreate() {
        val b = binding ?: return
        if (busy) return
        val name = b.nameInput.text?.toString() ?: ""
        val runtimeType = LocalAiHelpers.RUNTIME_TYPES.getOrNull(b.runtimeTypeSpinner.selectedItemPosition) ?: "ollama"
        val v = LocalAiHelpers.validateCreateInput(name, runtimeType)
        if (!v.ok) { showError(getString(stringResFor(v.errorKey))); return }
        setBusy(true)
        lifecycleScope.launch {
            try {
                val res = RetrofitClient.api.createAiConnector(CreateAiConnectorRequest(v.name!!, v.runtimeType!!))
                b.nameInput.text?.clear()
                load()
                if (LocalAiHelpers.looksLikeRegToken(res.regToken)) {
                    showCredentialDisclosure(
                        token = res.regToken,
                        title = getString(R.string.local_ai_reg_title),
                        regExpiresAt = res.regExpiresAt,
                        wsUrl = res.wsUrl,
                    )
                }
            } catch (e: Exception) {
                showError(friendlyError(e))
            } finally {
                setBusy(false)
            }
        }
    }

    private fun onReissueToken(c: AiConnectorStatusRow) {
        if (busy) return
        setBusy(true)
        lifecycleScope.launch {
            try {
                val res = RetrofitClient.api.reissueAiConnectorToken(c.connectorId)
                if (LocalAiHelpers.looksLikeRegToken(res.regToken)) {
                    showCredentialDisclosure(
                        token = res.regToken,
                        title = getString(R.string.local_ai_reg_title),
                        regExpiresAt = res.regExpiresAt,
                        wsUrl = res.wsUrl,
                    )
                }
            } catch (e: Exception) {
                showError(friendlyError(e))
            } finally {
                setBusy(false)
            }
        }
    }

    private fun onRefreshModels(c: AiConnectorStatusRow) {
        if (busy) return
        setBusy(true)
        lifecycleScope.launch {
            try {
                val res = RetrofitClient.api.refreshAiConnectorModels(c.connectorId)
                if (res.ok) {
                    modelsBy = modelsBy.toMutableMap().apply { put(c.connectorId, res.models ?: emptyList()) }
                    showNotice(getString(R.string.local_ai_models_refreshed, (res.models ?: emptyList()).size))
                    render()
                } else {
                    showError(getString(stringResForErr(LocalAiHelpers.errorKey(res.code))))
                }
            } catch (e: Exception) {
                showError(friendlyError(e))
            } finally {
                setBusy(false)
            }
        }
    }

    private fun onBind(c: AiConnectorStatusRow) {
        if (busy) return
        val model = selectedModel[c.connectorId] ?: ""
        val models = modelsBy[c.connectorId] ?: emptyList()
        if (model.isBlank() && models.isEmpty()) {
            showError(getString(R.string.local_ai_err_no_models))
            return
        }
        setBusy(true)
        lifecycleScope.launch {
            try {
                RetrofitClient.api.putAiProvider(LocalAiHelpers.buildBindingBody(c.connectorId, model))
                showNotice(getString(R.string.local_ai_bound, c.name))
                load()
            } catch (e: Exception) {
                showError(friendlyError(e))
            } finally {
                setBusy(false)
            }
        }
    }

    private fun onUnbind() {
        if (busy) return
        setBusy(true)
        lifecycleScope.launch {
            try {
                RetrofitClient.api.deleteAiProvider()
                showNotice(getString(R.string.local_ai_unbound))
                load()
            } catch (e: Exception) {
                showError(friendlyError(e))
            } finally {
                setBusy(false)
            }
        }
    }

    private fun onTest(c: AiConnectorStatusRow) {
        if (busy) return
        setBusy(true)
        lifecycleScope.launch {
            try {
                val model = selectedModel[c.connectorId] ?: ""
                val body = mutableMapOf<String, Any?>(
                    "provider_type" to "local-ai",
                    "connector_id" to c.connectorId,
                )
                if (model.isNotBlank()) body["model"] = model
                val res = RetrofitClient.api.testAiProvider(body)
                if (res.ok) {
                    showSuccess(getString(R.string.ai_provider_test_ok) + (res.model?.let { " · $it" } ?: ""))
                } else {
                    showError(getString(R.string.local_ai_test_fail, getString(stringResForErr(LocalAiHelpers.errorKey(res.code)))))
                }
                load() // status pill reflects the persisted test outcome
            } catch (e: Exception) {
                showError(getString(R.string.local_ai_test_fail, friendlyError(e)))
            } finally {
                setBusy(false)
            }
        }
    }

    private fun onRotate(c: AiConnectorStatusRow) {
        if (busy) return
        setBusy(true)
        lifecycleScope.launch {
            try {
                val res = RetrofitClient.api.rotateAiConnector(c.connectorId)
                if (LocalAiHelpers.looksLikeConnectorCredential(res.token)) {
                    showCredentialDisclosure(
                        token = res.token,
                        title = getString(R.string.worker_rotate) + " — " + c.name,
                        regExpiresAt = null,
                        wsUrl = null,
                    )
                }
            } catch (e: Exception) {
                showError(friendlyError(e))
            } finally {
                setBusy(false)
            }
        }
    }

    private fun confirmRevoke(c: AiConnectorStatusRow) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.worker_revoke)
            .setMessage(getString(R.string.local_ai_revoke_confirm, c.name) + "\n\n" + getString(R.string.local_ai_revoke_hint))
            .setNegativeButton(R.string.dialog_cancel, null)
            .setPositiveButton(R.string.worker_revoke) { _, _ -> onRevoke(c) }
            .show()
    }

    private fun onRevoke(c: AiConnectorStatusRow) {
        if (busy) return
        setBusy(true)
        lifecycleScope.launch {
            try {
                RetrofitClient.api.revokeAiConnector(c.connectorId)
                showNotice(getString(R.string.local_ai_revoked, c.name))
                load()
            } catch (e: Exception) {
                showError(friendlyError(e))
            } finally {
                setBusy(false)
            }
        }
    }

    // ── one-time credential disclosure ───────────────────────────────────

    /**
     * The ONE-TIME token disclosure dialog (worker showCredentialDisclosure
     * pattern). Dismissing is the ONLY exit — the token reference dies with
     * this scope and is never persisted or shown again.
     */
    private fun showCredentialDisclosure(token: String, title: String, regExpiresAt: Long?, wsUrl: String?) {
        val ctx = requireContext()
        val dp = { v: Int -> (v * resources.displayMetrics.density).toInt() }
        val container = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), dp(4))
        }

        container.addView(TextView(ctx).apply {
            setText(R.string.local_ai_credential_warning)
            textSize = 12f
            setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })

        if (regExpiresAt != null && LocalAiHelpers.regTokenExpired(regExpiresAt)) {
            container.addView(TextView(ctx).apply {
                setText(R.string.local_ai_reg_expired)
                textSize = 12f
                setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorError))
                setPadding(0, dp(8), 0, 0)
            })
        }

        if (wsUrl != null) {
            container.addView(TextView(ctx).apply {
                setText(R.string.local_ai_setup_title)
                textSize = 13f
                setTextColor(colorAttr(com.google.android.material.R.attr.colorOnSurface))
                setPadding(0, dp(12), 0, 0)
            })
            container.addView(TextView(ctx).apply {
                setText(R.string.local_ai_setup_intro)
                textSize = 12f
                setTextColor(colorAttr(com.google.android.material.R.attr.colorOnSurfaceVariant))
                setPadding(0, dp(4), 0, 0)
            })
            val steps = listOf(
                R.string.local_ai_setup_step_1, R.string.local_ai_setup_step_2,
                R.string.local_ai_setup_step_3, R.string.local_ai_setup_step_4,
            )
            for (s in steps) {
                container.addView(TextView(ctx).apply {
                    text = "• " + getString(s)
                    textSize = 12f
                    setTextColor(colorAttr(com.google.android.material.R.attr.colorOnSurfaceVariant))
                    setPadding(0, dp(2), 0, 0)
                })
            }
            val origin = RetrofitClient.baseUrl.removeSuffix("/")
            val cmd = LocalAiHelpers.buildRunCommand(token, wsUrl, origin)
            container.addView(TextView(ctx).apply {
                setText(R.string.local_ai_run_command_label)
                textSize = 13f
                setTextColor(colorAttr(com.google.android.material.R.attr.colorOnSurface))
                setPadding(0, dp(12), 0, 0)
            })
            container.addView(TextView(ctx).apply {
                text = cmd
                textSize = 11f
                typeface = android.graphics.Typeface.MONOSPACE
                setTextColor(colorAttr(com.google.android.material.R.attr.colorOnSurface))
                movementMethod = ScrollingMovementMethod()
                setPadding(dp(8), dp(8), dp(8), dp(8))
                background = GradientDrawable().apply {
                    setColor(getColorWithAlpha(colorAttr(com.google.android.material.R.attr.colorOnSurfaceVariant), 0.08f))
                    cornerRadius = dp(8).toFloat()
                }
            })
        }

        // Monospace token block + warning
        container.addView(TextView(ctx).apply {
            text = token
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextColor(colorAttr(com.google.android.material.R.attr.colorOnSurface))
            setPadding(dp(8), dp(12), dp(8), dp(8))
            background = GradientDrawable().apply {
                setColor(getColorWithAlpha(colorAttr(com.google.android.material.R.attr.colorOnSurfaceVariant), 0.08f))
                cornerRadius = dp(8).toFloat()
            }
        })

        val dialog = MaterialAlertDialogBuilder(ctx)
            .setTitle(title)
            .setView(ScrollView(ctx).apply { addView(container) })
            .setPositiveButton(R.string.worker_copy) { _, _ -> }
            .setNegativeButton(R.string.worker_done) { d, _ -> d.dismiss() }
            .setOnDismissListener { /* token reference dies with this scope */ }
            .show()

        // Copy button that does NOT dismiss (dismiss = the only exit that
        // drops the token; copy keeps the dialog open for re-reading).
        dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.let { btn ->
            btn.setOnClickListener {
                val cm = ctx.getSystemService(android.content.ClipboardManager::class.java)
                cm?.setPrimaryClip(android.content.ClipData.newPlainText("animastor-ai-connector-token", token))
                btn.isEnabled = false
                btn.text = getString(R.string.worker_copied)
            }
        }
    }

    // ── feedback helpers (AiProviderSettingsFragment pattern) ──────────────

    private fun setBusy(v: Boolean) {
        busy = v
        val b = binding ?: return
        b.createButton.isEnabled = !v
        b.unbindButton.isEnabled = !v
        render()
    }

    private fun showError(msg: String) {
        val b = binding ?: return
        b.successLabel.visibility = View.GONE
        b.noticeLabel.visibility = View.GONE
        b.errorLabel.text = msg
        b.errorLabel.visibility = View.VISIBLE
    }

    private fun showNotice(msg: String) {
        val b = binding ?: return
        b.successLabel.visibility = View.GONE
        b.errorLabel.visibility = View.GONE
        b.noticeLabel.text = msg
        b.noticeLabel.visibility = View.VISIBLE
    }

    private fun showSuccess(msg: String) {
        val b = binding ?: return
        b.noticeLabel.visibility = View.GONE
        b.errorLabel.visibility = View.GONE
        b.successLabel.text = msg
        b.successLabel.visibility = View.VISIBLE
    }

    private fun stringResFor(key: String?): Int = when (key) {
        "local_ai_name_required" -> R.string.local_ai_name_required
        "local_ai_name_too_long" -> R.string.local_ai_name_too_long
        "local_ai_runtime_invalid" -> R.string.local_ai_runtime_invalid
        else -> R.string.auth_error
    }

    private fun stringResForErr(key: String): Int = when (key) {
        "local_ai_err_offline" -> R.string.local_ai_err_offline
        "local_ai_err_timeout" -> R.string.local_ai_err_timeout
        "local_ai_err_runtime_unreachable" -> R.string.local_ai_err_runtime_unreachable
        "local_ai_err_model_not_found" -> R.string.local_ai_err_model_not_found
        "local_ai_err_busy" -> R.string.local_ai_err_busy
        "local_ai_err_context_length" -> R.string.local_ai_err_context_length
        "local_ai_err_bad_response" -> R.string.local_ai_err_bad_response
        "local_ai_err_runtime_error" -> R.string.local_ai_err_runtime_error
        "local_ai_err_response_too_large" -> R.string.local_ai_err_response_too_large
        "local_ai_err_request_too_large" -> R.string.local_ai_err_request_too_large
        "local_ai_err_invalid_request" -> R.string.local_ai_err_invalid_request
        "local_ai_err_no_models" -> R.string.local_ai_err_no_models
        "local_ai_err_discovery_failed" -> R.string.local_ai_err_discovery_failed
        "local_ai_err_registration_expired" -> R.string.local_ai_err_registration_expired
        "local_ai_err_registration_used" -> R.string.local_ai_err_registration_used
        else -> R.string.local_ai_err_generic
    }

    /** Backend returns { error: "..." } on failures; 404 → not found. */
    private fun friendlyError(e: Throwable): String {
        if (e is HttpException) {
            if (e.code() == 404) return getString(R.string.local_ai_err_not_found)
            if (e.code() == 401) return getString(R.string.local_ai_err_auth)
            if (e.code() == 403) return getString(R.string.local_ai_err_forbidden)
            if (e.code() == 429) return getString(R.string.local_ai_err_rate_limited)
            val body = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            if (body != null) {
                val msg = runCatching { JSONObject(body).optString("error").ifEmpty { null } }.getOrNull()
                if (msg != null) return msg
            }
        }
        return e.message ?: getString(R.string.auth_error)
    }
}
