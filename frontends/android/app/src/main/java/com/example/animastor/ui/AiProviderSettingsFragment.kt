package com.example.animastor.ui

import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.example.animastor.R
import com.example.animastor.databinding.FragmentAiProviderSettingsBinding
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.AiProviderMeta
import kotlinx.coroutines.launch
import org.json.JSONObject
import retrofit2.HttpException

/**
 * AI Provider settings (Experimental Beta — Phase 4). Web parity:
 * frontends/app /settings/ai (AIProviderSection in SettingsPage.tsx).
 *
 * Workspace-scoped LLM provider: provider_type + endpoint + api_key + model.
 * The workspace id is ALWAYS server-resolved from the session cookie.
 *
 * SECURITY INVARIANT (spec §5): the plaintext api_key is a ONE-TIME entry.
 * It is sent via PUT /settings/ai/provider and IMMEDIATELY cleared from the
 * input — never written to SharedPreferences, files, URLs or logs. After
 * save, all UI is driven only by the meta response (configured flag +
 * api_key_masked hint + status/last_tested_at pill).
 */
class AiProviderSettingsFragment : Fragment(R.layout.fragment_ai_provider_settings) {

    private var binding: FragmentAiProviderSettingsBinding? = null

    /** The saved provider meta (null = none configured → global fallback). */
    private var saved: AiProviderMeta? = null
    private var busy = false
    private var testing = false

    /** Flips only after the load settles — suppresses the synthetic
     *  onItemSelected fired by the load's setSelection. */
    private var typeInitialized = false

    companion object {
        private const val DEFAULT_TYPE = "openai-compatible"
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentAiProviderSettingsBinding.bind(view)
        val b = binding ?: return

        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        // ── Provider type spinner (openrouter | openai-compatible | custom) ──
        val typeOptions = BetaSettingsHelpers.VALID_PROVIDER_TYPES
        val typeLabels = typeOptions.map { typeLabel(it) }
        val typeAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, typeLabels)
        typeAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        b.providerTypeSpinner.adapter = typeAdapter

        // Changing provider_type autofills the OpenRouter default endpoint
        // (web parity) ONLY when the endpoint field is empty or still holds a
        // placeholder. The flag suppresses the synthetic onItemSelected fired
        // by the load's setSelection; it flips only AFTER the load settles so
        // opening the screen never rewrites the just-loaded endpoint.
        b.providerTypeSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, v: View?, position: Int, id: Long) {
                if (!typeInitialized) return
                val next = typeOptions.getOrElse(position) { DEFAULT_TYPE }
                val current = (b.endpointInput.text ?: "").toString()
                if (next == "openrouter" &&
                    (current.isEmpty() || current == BetaSettingsHelpers.GENERIC_ENDPOINT_PLACEHOLDER)
                ) {
                    b.endpointInput.setText(BetaSettingsHelpers.OPENROUTER_DEFAULT_ENDPOINT)
                } else if (next != "openrouter" && current == BetaSettingsHelpers.OPENROUTER_DEFAULT_ENDPOINT) {
                    b.endpointInput.setText("")
                }
                b.endpointInput.hint = BetaSettingsHelpers.endpointPlaceholderFor(next)
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }

        b.saveButton.setOnClickListener { onSave() }
        b.testButton.setOnClickListener { onTest() }
        b.deleteButton.setOnClickListener { onDelete() }

        load()
    }

    private fun typeLabel(type: String): String = when (type) {
        "openrouter" -> getString(R.string.ai_provider_type_openrouter)
        "openai-compatible" -> getString(R.string.ai_provider_type_openai_compatible)
        "custom" -> getString(R.string.ai_provider_type_custom)
        else -> type
    }

    private fun selectedType(): String {
        val b = binding ?: return DEFAULT_TYPE
        val idx = b.providerTypeSpinner.selectedItemPosition
        return BetaSettingsHelpers.VALID_PROVIDER_TYPES.getOrElse(idx) { DEFAULT_TYPE }
    }

    private fun load() {
        val b = binding ?: return
        lifecycleScope.launch {
            try {
                val res = RetrofitClient.api.getAiProvider()
                val meta = res.provider
                saved = meta
                if (meta != null) {
                    val typeIdx = BetaSettingsHelpers.VALID_PROVIDER_TYPES
                        .indexOf(meta.provider_type ?: meta.provider ?: DEFAULT_TYPE)
                        .coerceAtLeast(0)
                    b.providerTypeSpinner.setSelection(typeIdx)
                    b.endpointInput.setText(meta.endpoint ?: "")
                    b.modelInput.setText(meta.model ?: "")
                }
                renderSavedState()
            } catch (e: Throwable) {
                showError(friendlyError(e))
            } finally {
                typeInitialized = true // load settled — type changes now apply
            }
        }
    }

    private fun renderSavedState() {
        val b = binding ?: return
        val meta = saved
        if (meta == null) {
            b.savedStateLabel.text = getString(R.string.ai_provider_none)
            b.statusLabel.visibility = View.GONE
            b.configuredHint.visibility = View.GONE
            b.deleteButton.visibility = View.GONE
            b.apiKeyInput.hint = "sk-..."
            return
        }

        val modelPart = meta.model?.let { " \u00B7 $it" } ?: ""
        val maskedPart = meta.api_key_masked?.takeIf { it.isNotEmpty() }?.let { " \u00B7 $it" } ?: ""
        b.savedStateLabel.text = "${meta.endpoint ?: ""}$modelPart$maskedPart"

        // Status pill: last tested + OK/Failed/Untested.
        val statusText = when (meta.status) {
            "ok" -> getString(R.string.ai_provider_status_ok)
            "failed" -> getString(R.string.ai_provider_status_failed)
            else -> getString(R.string.ai_provider_status_untested)
        }
        b.statusLabel.text = "${getString(R.string.ai_provider_last_tested)}: " +
            "${BetaSettingsHelpers.formatLastTested(meta.last_tested_at)} \u00B7 $statusText"
        b.statusLabel.visibility = View.VISIBLE

        b.configuredHint.visibility = if (meta.configured || meta.has_api_key) View.VISIBLE else View.GONE
        b.deleteButton.visibility = View.VISIBLE
        b.apiKeyInput.hint = getString(R.string.ai_provider_key_hint)
    }

    private fun onSave() {
        val b = binding ?: return
        if (busy) return

        val endpoint = (b.endpointInput.text ?: "").toString()
        val apiKey = (b.apiKeyInput.text ?: "").toString()
        val model = (b.modelInput.text ?: "").toString()

        val v = BetaSettingsHelpers.validateProviderInput(
            providerType = selectedType(),
            endpoint = endpoint,
            apiKey = apiKey,
            model = model,
            isExisting = saved != null
        )
        if (!v.ok) {
            showError(getString(stringResFor(v.errorKey)))
            return
        }

        busy = true
        setBusy(true)
        clearMessages()
        lifecycleScope.launch {
            try {
                val body = mutableMapOf<String, Any?>(
                    "provider_type" to v.providerType,
                    "endpoint" to v.endpoint,
                    "model" to v.model
                )
                if (v.apiKey != null) body["api_key"] = v.apiKey
                val res = RetrofitClient.api.putAiProvider(body)
                saved = res.provider
                // SECURITY INVARIANT: immediately drop the API key from the
                // input — the saved meta only carries the masked hint.
                b.apiKeyInput.setText("")
                renderSavedState()
                showNotice(getString(R.string.ai_provider_key_saved))
            } catch (e: Throwable) {
                showError(friendlyError(e))
            } finally {
                busy = false
                setBusy(false)
            }
        }
    }

    private fun onTest() {
        val b = binding ?: return
        if (testing || busy) return
        // Ghost-provider guard: if there is no saved provider AND the form has
        // no endpoint/key filled in, there is nothing meaningful to test.
        // The backend would reject this too, but a client-side check gives an
        // immediate, clear message instead of a network round-trip.
        val endpoint = (b.endpointInput.text ?: "").toString().trim()
        val apiKey = (b.apiKeyInput.text ?: "").toString().trim()
        val model = (b.modelInput.text ?: "").toString().trim()
        if (saved == null && endpoint.isEmpty() && apiKey.isEmpty()) {
            showError(getString(R.string.ai_provider_test_no_provider))
            return
        }
        testing = true
        setTesting(true)
        clearMessages()
        lifecycleScope.launch {
            try {
                val body = mutableMapOf<String, Any?>()
                if (endpoint.isNotEmpty()) body["endpoint"] = endpoint
                if (apiKey.isNotEmpty()) body["api_key"] = apiKey
                if (model.isNotEmpty()) body["model"] = model

                val res = RetrofitClient.api.testAiProvider(body)
                if (res.ok) {
                    val modelPart = res.model?.let { " \u00B7 $it" } ?: ""
                    showSuccess(getString(R.string.ai_provider_test_ok) + modelPart)
                } else {
                    showError(getString(R.string.ai_provider_test_fail, res.error ?: "unknown error"))
                }
                // Re-read meta so the status pill reflects what the backend
                // persisted on Test Connection (web parity).
                runCatching {
                    val meta = RetrofitClient.api.getAiProvider().provider
                    if (meta != null) {
                        saved = meta
                        renderSavedState()
                    }
                }
            } catch (e: Throwable) {
                // Ghost-provider guard safety net: the backend returns 400 with an
                // English error when no provider is configured and the body is empty.
                // Map it to the localized string resource so the user never sees
                // mixed languages.
                if (e is HttpException && e.code() == 400 &&
                    friendlyError(e).contains("no provider", ignoreCase = true)
                ) {
                    showError(getString(R.string.ai_provider_test_no_provider))
                } else {
                    showError(getString(R.string.ai_provider_test_fail, friendlyError(e)))
                }
            } finally {
                testing = false
                setTesting(false)
            }
        }
    }

    private fun onDelete() {
        if (busy) return
        busy = true
        setBusy(true)
        clearMessages()
        lifecycleScope.launch {
            try {
                RetrofitClient.api.deleteAiProvider()
                saved = null
                val b = binding
                b?.endpointInput?.setText("")
                b?.apiKeyInput?.setText("")
                b?.modelInput?.setText("")
                b?.providerTypeSpinner?.setSelection(
                    BetaSettingsHelpers.VALID_PROVIDER_TYPES.indexOf(DEFAULT_TYPE).coerceAtLeast(0)
                )
                renderSavedState()
            } catch (e: Throwable) {
                showError(friendlyError(e))
            } finally {
                busy = false
                setBusy(false)
            }
        }
    }

    private fun setBusy(v: Boolean) {
        val b = binding ?: return
        b.saveButton.isEnabled = !v
        b.testButton.isEnabled = !v && !testing
        b.deleteButton.isEnabled = !v
        b.providerTypeSpinner.isEnabled = !v
        b.endpointInput.isEnabled = !v
        b.apiKeyInput.isEnabled = !v
        b.modelInput.isEnabled = !v
    }

    private fun setTesting(v: Boolean) {
        val b = binding ?: return
        b.testButton.isEnabled = !v && !busy
        b.testButton.text = getString(if (v) R.string.play_loading else R.string.ai_provider_test)
    }

    private fun clearMessages() {
        val b = binding ?: return
        b.successLabel.visibility = View.GONE
        b.noticeLabel.visibility = View.GONE
        b.errorLabel.visibility = View.GONE
    }

    private fun showSuccess(msg: String) {
        val b = binding ?: return
        b.successLabel.text = msg
        b.successLabel.visibility = View.VISIBLE
        b.noticeLabel.visibility = View.GONE
        b.errorLabel.visibility = View.GONE
    }

    private fun showNotice(msg: String) {
        val b = binding ?: return
        b.successLabel.visibility = View.GONE
        b.noticeLabel.text = msg
        b.noticeLabel.visibility = View.VISIBLE
        b.errorLabel.visibility = View.GONE
    }

    private fun showError(msg: String) {
        val b = binding ?: return
        b.successLabel.visibility = View.GONE
        b.errorLabel.text = msg
        b.errorLabel.visibility = View.VISIBLE
        b.noticeLabel.visibility = View.GONE
    }

    /** Map a web i18n error key to the matching Android string resource. */
    private fun stringResFor(key: String?): Int = when (key) {
        "ai_provider_invalid_type" -> R.string.ai_provider_invalid_type
        "ai_provider_endpoint_required" -> R.string.ai_provider_endpoint_required
        "ai_provider_endpoint_http" -> R.string.ai_provider_endpoint_http
        "ai_provider_api_key_required" -> R.string.ai_provider_api_key_required
        else -> R.string.auth_error
    }

    /** Backend returns { error: "..." } on failures. */
    private fun friendlyError(e: Throwable): String {
        if (e is HttpException) {
            val body = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            if (body != null) {
                val msg = runCatching { JSONObject(body).optString("error").ifEmpty { null } }.getOrNull()
                if (msg != null) return msg
            }
        }
        return e.message ?: getString(R.string.auth_error)
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }
}
