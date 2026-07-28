package com.example.animastor.ui

import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.lifecycleScope
import com.example.animastor.R
import com.example.animastor.databinding.FragmentWorkerSettingsBinding
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.LayerConfigUpdate
import kotlinx.coroutines.launch

/**
 * Per-worker settings fragment. Shows profile selector, timeout configuration,
 * and workflow management for a specific worker type (audio/image/video).
 *
 * Accepts [ARG_WORKER_TYPE] and [ARG_WORKER_LABEL] as fragment arguments.
 * Opened from GenerateFragment's gear icon buttons.
 */
class WorkerSettingsFragment : Fragment(R.layout.fragment_worker_settings) {

    private var binding: FragmentWorkerSettingsBinding? = null
    private val viewModel: GenerateViewModel by activityViewModels {
        GenerateViewModel.factory
    }

    companion object {
        private const val ARG_WORKER_TYPE = "worker_type"
        private const val ARG_WORKER_LABEL = "worker_label"

        /**
         * Timeout options (minutes) shown in the timeout spinner.
         * Audio/Image: 5, 10, 15, 20, 30, 45, 60, 90, 120
         * Video: adds 150, 180
         */
        val TIMEOUT_OPTIONS_MINUTES = intArrayOf(5, 10, 15, 20, 30, 45, 60, 90, 120)
        val TIMEOUT_OPTIONS_VIDEO_MINUTES = intArrayOf(10, 15, 20, 30, 45, 60, 90, 120, 150, 180)

        fun newInstance(workerType: String, label: String): WorkerSettingsFragment {
            val args = Bundle().apply {
                putString(ARG_WORKER_TYPE, workerType)
                putString(ARG_WORKER_LABEL, label)
            }
            val fragment = WorkerSettingsFragment()
            fragment.arguments = args
            return fragment
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentWorkerSettingsBinding.bind(view)
        val b = binding ?: return

        val workerType = arguments?.getString(ARG_WORKER_TYPE) ?: "audio"
        val workerLabel = arguments?.getString(ARG_WORKER_LABEL) ?: workerType

        // ── Toolbar — workerLabel now carries the full localized title from GenerateFragment ──
        b.toolbar.title = workerLabel
        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        // ── Profile label ──
        b.profileLabel.text = when (workerType) {
            "audio" -> getString(R.string.settings_audio_profile)
            "image" -> getString(R.string.settings_image_profile)
            "video" -> getString(R.string.settings_video_profile)
            else -> workerType
        }

        // ── Timeout setup ──
        val timeoutOptions = when (workerType) {
            "video" -> TIMEOUT_OPTIONS_VIDEO_MINUTES.toTypedArray()
            else -> TIMEOUT_OPTIONS_MINUTES.toTypedArray()
        }
        val timeoutField = when (workerType) {
            "audio" -> "audio_timeout_minutes"
            "image" -> "image_timeout_minutes"
            "video" -> "video_timeout_minutes"
            else -> null
        }

        b.timeoutLabel.text = getString(R.string.worker_settings_timeout_label, workerLabel)

        // ── Guard: ignore onItemSelected until loading completes ──
        var timeoutLoading = true

        val timeoutAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, timeoutOptions.map { "$it ${getString(R.string.worker_settings_timeout_unit)}" })
        timeoutAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        b.timeoutSpinner.adapter = timeoutAdapter

        // Load current timeout value from layer-config
        lifecycleScope.launch {
            try {
                val bookId = viewModel.bookId
                if (bookId.isNotBlank()) {
                    val cfg = viewModel.repository.getLayerConfig(bookId)
                    val currentMinutes = when (workerType) {
                        "audio" -> cfg.audio_timeout_minutes ?: 30
                        "image" -> cfg.image_timeout_minutes ?: 30
                        "video" -> cfg.video_timeout_minutes ?: 60
                        else -> 30
                    }
                    val idx = timeoutOptions.indexOfFirst { it >= currentMinutes }.coerceAtLeast(0)
                    b.timeoutSpinner.setSelection(idx)
                }
            } catch (_: Exception) {
                // Keep default selection
            } finally {
                timeoutLoading = false
            }
        }

        // ── Save timeout on selection change ──
        b.timeoutSpinner.setOnItemSelectedListener(object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                // Ignore the initial selection event that fires immediately when the adapter is set.
                // This prevents saving the wrong default (index 0) before the actual value loads.
                if (timeoutLoading) return

                val selectedMinutes = timeoutOptions.getOrElse(position) { 30 }
                lifecycleScope.launch {
                    try {
                        val bookId = viewModel.bookId
                        if (bookId.isNotBlank() && timeoutField != null) {
                            val update = when (timeoutField) {
                                "audio_timeout_minutes" -> LayerConfigUpdate(audio_timeout_minutes = selectedMinutes)
                                "image_timeout_minutes" -> LayerConfigUpdate(image_timeout_minutes = selectedMinutes)
                                "video_timeout_minutes" -> LayerConfigUpdate(video_timeout_minutes = selectedMinutes)
                                else -> return@launch
                            }
                            viewModel.repository.putLayerConfig(bookId, update)
                        }
                    } catch (_: Exception) { /* best-effort */ }
                }
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        })

        // ── Load profiles ──
        lifecycleScope.launch {
            try {
                val resp = RetrofitClient.api.getConnectorProfiles()

                val options = when (workerType) {
                    "audio" -> resp.options.audio.ifEmpty { listOf(resp.profiles.audio ?: "qwen-tts") }
                    "image" -> resp.options.image.ifEmpty { listOf(resp.profiles.image ?: "qwen-image") }
                    "video" -> resp.options.video.ifEmpty { listOf(resp.profiles.video ?: "ltx-2.3") }
                    else -> emptyList()
                }
                val currentProfile = when (workerType) {
                    "audio" -> resp.profiles.audio
                    "image" -> resp.profiles.image
                    "video" -> resp.profiles.video
                    else -> null
                }

                val adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, options)
                adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.profileSpinner.adapter = adapter
                val idx = options.indexOf(currentProfile).coerceAtLeast(0)
                b.profileSpinner.setSelection(idx)
            } catch (e: Exception) {
                val fallback = listOf(
                    when (workerType) {
                        "audio" -> "qwen-tts"
                        "image" -> "qwen-image"
                        "video" -> "ltx-2.3"
                        else -> "default"
                    }
                )
                val adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, fallback)
                adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.profileSpinner.adapter = adapter
            }
        }

        // ── Workflow ──
        b.workflowLabel.text = getString(R.string.workflow_manager_no_workflows)

        lifecycleScope.launch {
            try {
                val grouped = RetrofitClient.api.getConnectorsGrouped()
                val connectors = when (workerType) {
                    "audio" -> grouped.audio
                    "image" -> grouped.image
                    "video" -> grouped.video
                    else -> emptyList()
                }
                val active = connectors.filter { it.enabled }
                if (active.isNotEmpty()) {
                    b.workflowLabel.text = active.joinToString("\n") { c ->
                        "${c.label} (${c.workflow})"
                    }
                } else if (connectors.isNotEmpty()) {
                    b.workflowLabel.text = getString(R.string.workflow_manager_no_workflows)
                }
            } catch (_: Exception) {
                // keep "No workflows configured" default
            }
        }

        // ── Workflow manage button ──
        b.workflowButton.setOnClickListener {
            val typeTitle = when (workerType) {
                "audio" -> getString(R.string.workflow_manager_audio)
                "image" -> getString(R.string.workflow_manager_image)
                "video" -> getString(R.string.workflow_manager_video)
                else -> workerType
            }
            val fragment = WorkflowTypeListFragment.newInstance(workerType, typeTitle)
            parentFragmentManager.beginTransaction()
                .add(R.id.nav_host_container, fragment, "WorkflowTypeListFragment")
                .addToBackStack(null)
                .commit()
        }
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }
}
