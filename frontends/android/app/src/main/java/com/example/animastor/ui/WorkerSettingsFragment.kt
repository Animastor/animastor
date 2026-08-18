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
import com.example.animastor.repository.UpdateProfileRequest
import com.google.android.material.tabs.TabLayout
import kotlinx.coroutines.launch

/**
 * Unified per-worker settings screen (web parity: /settings/worker segmented
 * control). Shows profile selector, timeout configuration and workflow
 * management for one worker type (audio/image/video) at a time; the three
 * sections are switched through the [R.id.workerTabs] tab strip.
 *
 * Accepts [ARG_WORKER_TYPE] — the section to open initially. The Generator's
 * private gear icons pass the corresponding worker type (same settings, just a
 * different entry point), while the global settings open it with the default
 * section (audio).
 *
 * Both the profile and the timeout are saved INSTANTLY on selection
 * (web parity) — there is no Apply button.
 */
class WorkerSettingsFragment : Fragment(R.layout.fragment_worker_settings) {

    private var binding: FragmentWorkerSettingsBinding? = null
    private val viewModel: GenerateViewModel by activityViewModels {
        GenerateViewModel.factory
    }

    /** Incremented on every section switch so stale async loads are ignored. */
    private var loadSession = 0

    companion object {
        private const val ARG_WORKER_TYPE = "worker_type"

        /** Default timeout in minutes per worker type. */
        private const val DEFAULT_TIMEOUT_AUDIO_IMAGE = 30
        private const val DEFAULT_TIMEOUT_VIDEO = 60

        /**
         * Timeout options (minutes) shown in the timeout spinner.
         * Audio/Image: 5, 10, 15, 20, 30, 45, 60, 90, 120
         * Video: 10, 15, 20, 30, 45, 60, 90, 120, 150, 180
         */
        val TIMEOUT_OPTIONS_MINUTES = intArrayOf(5, 10, 15, 20, 30, 45, 60, 90, 120)
        val TIMEOUT_OPTIONS_VIDEO_MINUTES = intArrayOf(10, 15, 20, 30, 45, 60, 90, 120, 150, 180)

        fun newInstance(workerType: String): WorkerSettingsFragment {
            val args = Bundle().apply {
                putString(ARG_WORKER_TYPE, workerType)
            }
            val fragment = WorkerSettingsFragment()
            fragment.arguments = args
            return fragment
        }

        private fun tabForWorkerType(type: String): Int = when (type) {
            "image" -> 1
            "video" -> 2
            else -> 0
        }

        private fun workerTypeForTab(position: Int): String = when (position) {
            1 -> "image"
            2 -> "video"
            else -> "audio"
        }

        private fun workerTitle(context: android.content.Context, type: String): String = when (type) {
            "audio" -> context.getString(R.string.worker_settings_title_audio)
            "image" -> context.getString(R.string.worker_settings_title_image)
            "video" -> context.getString(R.string.worker_settings_title_video)
            else -> type
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentWorkerSettingsBinding.bind(view)
        val b = binding ?: return

        val initialType = arguments?.getString(ARG_WORKER_TYPE) ?: "audio"

        // Unified toolbar title (web parity: worker_settings_title); the section
        // is shown by the tab strip below it.
        b.toolbar.title = getString(R.string.worker_settings_title)
        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        // Rebuild the section content every time the selected section changes.
        // The flag guards the initial select(): TabLayout may already have the
        // initial tab selected on view-state restore, in which case select() is
        // a no-op and the listener never fires — build explicitly then.
        var rebuilt = false
        b.workerTabs.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) {
                rebuilt = true
                rebuildContent(workerTypeForTab(tab.position))
            }
            override fun onTabUnselected(tab: TabLayout.Tab) {}
            override fun onTabReselected(tab: TabLayout.Tab) {
                rebuilt = true
                rebuildContent(workerTypeForTab(tab.position))
            }
        })

        b.workerTabs.getTabAt(tabForWorkerType(initialType))?.select()
        if (!rebuilt) {
            rebuildContent(initialType)
        }
    }

    /** Builds the profile/timeout/workflow sections for the given worker type.
     *  Each switch starts a fresh load session; async results from a previous
     *  section are dropped so a slow load can never clobber the new section. */
    private fun rebuildContent(workerType: String) {
        val b = binding ?: return
        val session = ++loadSession

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
        val defaultTimeout = when (workerType) {
            "video" -> DEFAULT_TIMEOUT_VIDEO
            else -> DEFAULT_TIMEOUT_AUDIO_IMAGE
        }

        b.timeoutLabel.text = getString(R.string.worker_settings_timeout_label, workerTitle(requireContext(), workerType))

        val timeoutAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item,
            timeoutOptions.map { "$it ${getString(R.string.worker_settings_timeout_unit)}" })
        timeoutAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        b.timeoutSpinner.adapter = timeoutAdapter

        // ── Instant apply (web parity): the timeout selection IS the save, no
        // Apply button. The flag suppresses the synthetic onItemSelected fired
        // by the load's setSelection; it flips only AFTER the load settles so
        // opening the screen never writes the just-loaded value back.
        var timeoutInitialized = false
        b.timeoutSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, v: View?, position: Int, id: Long) {
                if (!timeoutInitialized || timeoutField == null) return
                val selectedMinutes = timeoutOptions.getOrElse(position) { defaultTimeout }
                lifecycleScope.launch {
                    try {
                        val bookId = viewModel.bookId
                        if (bookId.isBlank()) return@launch
                        val update = when (timeoutField) {
                            "audio_timeout_minutes" -> LayerConfigUpdate(audio_timeout_minutes = selectedMinutes)
                            "image_timeout_minutes" -> LayerConfigUpdate(image_timeout_minutes = selectedMinutes)
                            "video_timeout_minutes" -> LayerConfigUpdate(video_timeout_minutes = selectedMinutes)
                            else -> return@launch
                        }
                        viewModel.repository.putLayerConfig(bookId, update)
                    } catch (_: Exception) {
                        // Stay on screen; retry on next change
                    }
                }
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }

        // Load current timeout value from layer-config
        lifecycleScope.launch {
            try {
                val bookId = viewModel.bookId
                if (bookId.isNotBlank()) {
                    val cfg = viewModel.repository.getLayerConfig(bookId)
                    if (session != loadSession) return@launch
                    val loaded = when (workerType) {
                        "audio" -> cfg.audio_timeout_minutes ?: defaultTimeout
                        "image" -> cfg.image_timeout_minutes ?: defaultTimeout
                        "video" -> cfg.video_timeout_minutes ?: defaultTimeout
                        else -> defaultTimeout
                    }
                    val idx = timeoutOptions.indexOfFirst { it >= loaded }.coerceAtLeast(0)
                    b.timeoutSpinner.setSelection(idx)
                }
            } catch (_: Exception) {
                // Keep default selection
            } finally {
                timeoutInitialized = true // load settled — user changes now persist
            }
        }

        // ── Default button: reset timeout to factory default (saved instantly) ──
        b.timeoutDefaultButton.setOnClickListener {
            val idx = timeoutOptions.indexOfFirst { it >= defaultTimeout }.coerceAtLeast(0)
            b.timeoutSpinner.setSelection(idx)
        }

        // ── Profile — instant apply (web parity): the selection IS the save via
        // PUT /api/v1/connectors/profiles (global override). The flag suppresses
        // the synthetic onItemSelected fired by the load's setSelection; it
        // flips only AFTER the load settles so opening the screen never writes
        // the just-loaded value back.
        var profileInitialized = false
        b.profileSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, v: View?, position: Int, id: Long) {
                if (!profileInitialized) return
                val selected = parent?.getItemAtPosition(position)?.toString() ?: return
                lifecycleScope.launch {
                    try {
                        RetrofitClient.api.putConnectorProfile(
                            UpdateProfileRequest(workerType, selected)
                        )
                    } catch (_: Exception) {
                        // Stay on screen; retry on next change
                    }
                }
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }

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
                if (session != loadSession) return@launch

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
                        else -> "" // unreachable — workerType is always audio/image/video
                    }
                )
                if (session != loadSession) return@launch
                val adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, fallback)
                adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.profileSpinner.adapter = adapter
            } finally {
                profileInitialized = true // load settled — user changes now persist
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
                if (session != loadSession) return@launch
                val active = connectors.filter { it.enabled }
                if (active.isNotEmpty()) {
                    b.workflowLabel.text = active.joinToString("\n") { c ->
                        "${c.label} (${c.workflow})"
                    }
                } else if (connectors.isNotEmpty()) {
                    b.workflowLabel.text = getString(R.string.workflow_manager_no_workflows)
                }
            } catch (_: Exception) {
                // keep \"No workflows configured\" default
            }
        }

        // ── Workflow manage button ──
        b.workflowButton.setOnClickListener {
            val typeTitle = workerTitle(requireContext(), workerType)
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
