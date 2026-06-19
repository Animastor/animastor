package com.example.animastor.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.BindingDef
import com.example.animastor.repository.CompatibilityStatus
import com.example.animastor.repository.ConnectorDetail
import com.example.animastor.repository.UpdateParameterRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for Workflow Details screen with tabs.
 */
class WorkflowDetailsViewModel : ViewModel() {

    private val api = RetrofitClient.api

    // ─── State ─────────────────────────────────────────

    private val _connectorDetail = MutableStateFlow<ConnectorDetail?>(null)
    val connectorDetail: StateFlow<ConnectorDetail?> = _connectorDetail

    private val _compatibility = MutableStateFlow<CompatibilityStatus?>(null)
    val compatibility: StateFlow<CompatibilityStatus?> = _compatibility

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    // ─── Data ──────────────────────────────────────────

    data class TabData(
        val inputs: List<BindingDisplayItem> = emptyList(),
        val outputs: List<BindingDisplayItem> = emptyList(),
        val parameters: List<BindingDisplayItem> = emptyList()
    )

    data class BindingDisplayItem(
        val key: String,
        val label: String,
        val nodeId: String = "",
        val field: String = "",
        val required: Boolean = false,
        val dataType: String = "",
        val defaultValue: Any? = null,
        val min: Any? = null,
        val max: Any? = null,
        val kind: String = ""
    )

    private val _tabData = MutableStateFlow(TabData())
    val tabData: StateFlow<TabData> = _tabData

    // ─── Parameter State (Stage 3) ─────────────────────

    /** Current live values of connector parameters, keyed by paramKey */
    private val _currentParamValues = MutableStateFlow<Map<String, Any?>>(emptyMap())
    val currentParamValues: StateFlow<Map<String, Any?>> = _currentParamValues

    /** Save operation state per parameter key */
    private val _savingParams = MutableStateFlow<Set<String>>(emptySet())
    val savingParams: StateFlow<Set<String>> = _savingParams

    private val _saveError = MutableStateFlow<String?>(null)
    val saveError: StateFlow<String?> = _saveError

    // ─── Load ──────────────────────────────────────────

    fun loadConnector(name: String) {
        viewModelScope.launch {
            _loading.value = true
            _error.value = null
            try {
            val detail = api.getConnectorDetail(name)
            // ⚠️ IMPORTANT: Set tabData BEFORE connectorDetail!
            // setupTabs() is triggered by connectorDetail.collectLatest.
            // It launches a coroutine that collects tabData immediately
            // (Dispatchers.Main.immediate). If tabData hasn't been set yet,
            // the adapter gets created with EMPTY data and never updates.
            _tabData.value = buildTabData(detail)
            _connectorDetail.value = detail

                // Load parameter values
                try {
                    val paramValues = api.getConnectorParameterValues(name)
                    _currentParamValues.value = paramValues.values
                } catch (_: Exception) {
                    // Build from defaults if API not available
                    val defaults = mutableMapOf<String, Any?>()
                    detail.parameters.forEach { (key, binding) ->
                        defaults[key] = binding.defaultValue
                    }
                    _currentParamValues.value = defaults
                }

                // Load compatibility
                try {
                    _compatibility.value = api.getConnectorCompatibility(name)
                } catch (_: Exception) {
                    // compatibility is optional
                }
            } catch (e: Exception) {
                _error.value = e.message ?: "Failed to load connector details"
            } finally {
                _loading.value = false
            }
        }
    }

    private fun buildTabData(detail: ConnectorDetail): TabData {
        return TabData(
            inputs = detail.inputs.map { (key, binding) ->
                BindingDisplayItem(
                    key = key,
                    label = binding.label,
                    nodeId = binding.nodeId ?: "",
                    field = binding.field ?: "",
                    required = binding.required,
                    dataType = binding.dataType ?: "",
                    kind = binding.kind ?: "input"
                )
            },
            outputs = detail.outputs.map { (key, binding) ->
                BindingDisplayItem(
                    key = key,
                    label = binding.label,
                    nodeId = binding.nodeId ?: "",
                    field = binding.field ?: "",
                    dataType = binding.dataType ?: "",
                    kind = binding.kind ?: "output"
                )
            },
            parameters = detail.parameters.map { (key, binding) ->
                BindingDisplayItem(
                    key = key,
                    label = binding.label,
                    nodeId = binding.nodeId ?: "",
                    field = binding.field ?: "",
                    dataType = binding.dataType ?: "",
                    defaultValue = binding.defaultValue,
                    min = binding.min,
                    max = binding.max,
                    kind = binding.kind ?: "parameter"
                )
            }
        )
    }

    // ─── Parameter Save (Stage 3) ──────────────────────

    /**
     * Save a single parameter value to the backend.
     * Updates local state on success.
     */
    fun saveParameter(connectorName: String, paramKey: String, value: Any?) {
        viewModelScope.launch {
            _savingParams.value = _savingParams.value + paramKey
            _saveError.value = null
            try {
                val response = api.putConnectorParameter(
                    name = connectorName,
                    body = UpdateParameterRequest(
                        paramKey = paramKey,
                        value = value
                    )
                )
                if (response.ok) {
                    // Update local state with the server-confirmed value
                    val updated = _currentParamValues.value.toMutableMap()
                    updated[paramKey] = response.currentValue ?: value
                    _currentParamValues.value = updated
                } else {
                    _saveError.value = response.error ?: "Failed to save parameter"
                }
            } catch (e: Exception) {
                _saveError.value = e.message ?: "Network error saving parameter"
            } finally {
                _savingParams.value = _savingParams.value - paramKey
            }
        }
    }

    /**
     * Reset local parameter value to the default from connector metadata.
     */
    fun resetParameterToDefault(paramKey: String) {
        val detail = _connectorDetail.value ?: return
        val binding = detail.parameters[paramKey] ?: return
        val updated = _currentParamValues.value.toMutableMap()
        updated[paramKey] = binding.defaultValue
        _currentParamValues.value = updated
    }

    companion object {
        val factory: ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return WorkflowDetailsViewModel() as T
            }
        }
    }
}
