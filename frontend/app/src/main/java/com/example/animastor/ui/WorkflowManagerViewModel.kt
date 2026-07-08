package com.example.animastor.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.ConnectorSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for the Workflow Manager screens.
 * Loads connectors grouped by type and manages their state.
 */
class WorkflowManagerViewModel : ViewModel() {

    private val api = RetrofitClient.api

    // ─── State ─────────────────────────────────────────

    private val _audioWorkflows = MutableStateFlow<List<ConnectorSummary>>(emptyList())
    val audioWorkflows: StateFlow<List<ConnectorSummary>> = _audioWorkflows

    private val _imageWorkflows = MutableStateFlow<List<ConnectorSummary>>(emptyList())
    val imageWorkflows: StateFlow<List<ConnectorSummary>> = _imageWorkflows

    private val _videoWorkflows = MutableStateFlow<List<ConnectorSummary>>(emptyList())
    val videoWorkflows: StateFlow<List<ConnectorSummary>> = _videoWorkflows

    // F12: server-computed active counts — no client-side re-counting
    private val _audioActiveCount = MutableStateFlow(0)
    val audioActiveCount: StateFlow<Int> = _audioActiveCount
    private val _imageActiveCount = MutableStateFlow(0)
    val imageActiveCount: StateFlow<Int> = _imageActiveCount
    private val _videoActiveCount = MutableStateFlow(0)
    val videoActiveCount: StateFlow<Int> = _videoActiveCount

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    // All connectors flat list (for details screen)
    private val _allConnectors = MutableStateFlow<List<ConnectorSummary>>(emptyList())
    val allConnectors: StateFlow<List<ConnectorSummary>> = _allConnectors

    // ─── Initialization ────────────────────────────────

    init {
        loadConnectors()
    }

    fun loadConnectors() {
        viewModelScope.launch {
            _loading.value = true
            _error.value = null
            try {
                // F12: grouped endpoint is primary — no flat fallback needed
                val grouped = api.getConnectorsGrouped()
                _audioWorkflows.value = grouped.audio
                _imageWorkflows.value = grouped.image
                _videoWorkflows.value = grouped.video
                _audioActiveCount.value = grouped.audio_active_count
                _imageActiveCount.value = grouped.image_active_count
                _videoActiveCount.value = grouped.video_active_count

                // Also load flat list for details lookup
                val response = api.getConnectors()
                _allConnectors.value = response.connectors
            } catch (e: Exception) {
                _error.value = e.message ?: "Failed to load connectors"
            } finally {
                _loading.value = false
            }
        }
    }

    fun reloadConnectors() {
        viewModelScope.launch {
            _loading.value = true
            try {
                api.reloadConnectors()
                loadConnectors()
            } catch (e: Exception) {
                _error.value = e.message
                _loading.value = false
            }
        }
    }

    companion object {
        val factory: ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return WorkflowManagerViewModel() as T
            }
        }
    }
}
