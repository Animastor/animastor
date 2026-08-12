package com.example.animastor.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.ConnectorDetail
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class DeveloperViewViewModel : ViewModel() {

    private val api = RetrofitClient.api

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading

    private val _rawJson = MutableStateFlow<String?>(null)
    val rawJson: StateFlow<String?> = _rawJson

    private val _connectorDetail = MutableStateFlow<ConnectorDetail?>(null)
    val connectorDetail: StateFlow<ConnectorDetail?> = _connectorDetail

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    /**
     * Data class representing a single binding row in the developer table.
     */
    data class BindingTableRow(
        val section: String,       // "inputs", "outputs", "parameters"
        val entityKey: String,     // e.g. "positivePrompt"
        val label: String,
        val nodeId: String,
        val field: String,
        val expectedClass: String?,
        val nodeClass: String?,
        val required: Boolean,
        val defaultValue: Any? = null,
        val min: Any? = null,
        val max: Any? = null
    )

    private val _bindingRows = MutableStateFlow<List<BindingTableRow>>(emptyList())
    val bindingRows: StateFlow<List<BindingTableRow>> = _bindingRows

    fun loadConnector(name: String) {
        viewModelScope.launch {
            _loading.value = true
            _error.value = null
            try {
                // Load raw connector JSON
                val raw = try {
                    api.getConnectorRaw(name)
                } catch (_: Exception) {
                    null
                }
                _rawJson.value = if (raw != null) {
                    // Pretty-print JSON
                    com.google.gson.GsonBuilder()
                        .setPrettyPrinting()
                        .create()
                        .toJson(raw)
                } else {
                    "// Raw connector data not available\n// API returned null"
                }

                // Load clean detail for bindings table
                val detail = api.getConnectorDetail(name)
                _connectorDetail.value = detail

                // Build binding table rows
                val rows = mutableListOf<BindingTableRow>()

                // Inputs
                for ((key, binding) in detail.inputs) {
                    if (binding.type == "multi" && !binding.bindings.isNullOrEmpty()) {
                        for (sub in binding.bindings) {
                            rows.add(
                                BindingTableRow(
                                    section = "inputs",
                                    entityKey = "${key}[${sub.arrayPosition ?: 0}]",
                                    label = sub.label ?: key,
                                    nodeId = sub.nodeId ?: "",
                                    field = "",
                                    expectedClass = sub.expectedClass,
                                    nodeClass = sub.nodeClass,
                                    required = sub.required
                                )
                            )
                        }
                    } else {
                        rows.add(
                            BindingTableRow(
                                section = "inputs",
                                entityKey = key,
                                label = binding.label,
                                nodeId = binding.nodeId ?: "",
                                field = binding.field ?: "",
                                expectedClass = binding.expectedClass,
                                nodeClass = binding.nodeClass,
                                required = binding.required
                            )
                        )
                    }
                }

                // Outputs
                for ((key, binding) in detail.outputs) {
                    rows.add(
                        BindingTableRow(
                            section = "outputs",
                            entityKey = key,
                            label = binding.label,
                            nodeId = binding.nodeId ?: "",
                            field = binding.field ?: "",
                            expectedClass = binding.expectedClass,
                            nodeClass = binding.nodeClass,
                            required = false,
                            defaultValue = null
                        )
                    )
                }

                // Parameters
                for ((key, binding) in detail.parameters) {
                    rows.add(
                        BindingTableRow(
                            section = "parameters",
                            entityKey = key,
                            label = binding.label,
                            nodeId = binding.nodeId ?: "",
                            field = binding.field ?: "",
                            expectedClass = binding.expectedClass,
                            nodeClass = binding.nodeClass,
                            required = false,
                            defaultValue = binding.defaultValue,
                            min = binding.min,
                            max = binding.max
                        )
                    )
                }

                _bindingRows.value = rows

            } catch (e: Exception) {
                _error.value = e.message ?: "Failed to load connector data"
            } finally {
                _loading.value = false
            }
        }
    }

    companion object {
        val factory: ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return DeveloperViewViewModel() as T
            }
        }
    }
}
