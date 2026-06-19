package com.example.animastor.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.BindingDef
import com.example.animastor.repository.CompatibilityStatus
import com.example.animastor.repository.ConnectorDetail
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
        val kind: String = ""
    )

    private val _tabData = MutableStateFlow(TabData())
    val tabData: StateFlow<TabData> = _tabData

    // ─── Load ──────────────────────────────────────────

    fun loadConnector(name: String) {
        viewModelScope.launch {
            _loading.value = true
            _error.value = null
            try {
                val detail = api.getConnectorDetail(name)
                _connectorDetail.value = detail
                _tabData.value = buildTabData(detail)

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
                    defaultValue = null, // TODO: extract from connector metadata
                    kind = binding.kind ?: "parameter"
                )
            }
        )
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
