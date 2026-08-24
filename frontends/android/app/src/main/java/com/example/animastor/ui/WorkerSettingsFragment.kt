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
import com.example.animastor.repository.WorkerCounts
import kotlinx.coroutines.launch

/**
 * Unified per-worker settings screen (web parity: /settings/worker segmented
 * control). Shows the Workers availability panel plus the profile selector,
 * timeout configuration and workflow management for one worker type
 * (audio/image/video) at a time; the three sections are switched through the
 * [R.id.workerSeg] segmented buttons.
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

        private fun workerTitle(context: android.content.Context, type: String): String = when (type) {
            "audio" -> context.getString(R.string.worker_settings_title_audio)
            "image" -> context.getString(R.string.worker_settings_title_image)
            "video" -> context.getString(R.string.worker_settings_title_video)
            else -> type
        }
    }

    /** Highlights the given worker type's segmented button (bordeaux fill). */
    private fun selectSection(type: String) {
        val b = binding ?: return
        b.segAudioButton.isSelected = type == "audio"
        b.segImageButton.isSelected = type == "image"
        b.segVideoButton.isSelected = type == "video"
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentWorkerSettingsBinding.bind(view)
        val b = binding ?: return

        val initialType = arguments?.getString(ARG_WORKER_TYPE) ?: "audio"

        // Unified toolbar title (web parity: worker_settings_title); the section
        // is shown by the segmented control below it.
        b.toolbar.title = getString(R.string.worker_settings_title)
        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        // Rebuild the section content every time the selected section changes.
        b.segAudioButton.setOnClickListener { selectSection("audio"); rebuildContent("audio") }
        b.segImageButton.setOnClickListener { selectSection("image"); rebuildContent("image") }
        b.segVideoButton.setOnClickListener { selectSection("video"); rebuildContent("video") }

        selectSection(initialType)
        rebuildContent(initialType)
        loadWorkerCounts()
    }

    /**
     * Loads the worker availability counts (total/active per type) into the
     * Workers panel. One fetch for the whole screen — counts are global, not
     * per-section. On failure each row falls back to a dash (web parity).
     */
    private fun loadWorkerCounts() {
        val b = binding ?: return
        lifecycleScope.launch {
            try {
                val counts = RetrofitClient.api.getWorkerCounts()
                b.workerAudioCount.text = getString(R.string.worker_counts_fmt, counts.audio, counts.active_audio)
                b.workerImageCount.text = getString(R.string.worker_counts_fmt, counts.image, counts.active_image)
                b.workerVideoCount.text = getString(R.string.worker_counts_fmt, counts.video, counts.active_video)
                b.workerVbookCount.text = getString(R.string.worker_counts_fmt, counts.vbook, counts.active_vbook)
                appendPrivateCountRows(b, counts)
            } catch (_: Exception) {
                b.workerAudioCount.text = "\u2014"
                b.workerImageCount.text = "\u2014"
                b.workerVideoCount.text = "\u2014"
                b.workerVbookCount.text = "\u2014"
            }
        }
    }

    /**
     * Appends the caller's OWN private worker rows (private_* fields) to the
     * Workers panel — kept separate from the system/shared rows above them
     * (visibility isolation: a private worker never inflates the global
     * numbers). Hidden entirely when the caller has no private workers.
     */
    private fun appendPrivateCountRows(b: FragmentWorkerSettingsBinding, counts: WorkerCounts) {
        val rows = listOf(
            Triple(R.string.layer_audio, counts.private_audio, counts.private_active_audio),
            Triple(R.string.layer_image, counts.private_image, counts.private_active_image),
            Triple(R.string.layer_video, counts.private_video, counts.private_active_video),
        ).filter { it.second > 0 }
        if (rows.isEmpty()) return

        val ctx = b.workerCountsContainer.context
        val dp = { v: Int -> (v * ctx.resources.displayMetrics.density).toInt() }
        for ((labelRes, total, active) in rows) {
            val row = android.widget.LinearLayout(ctx).apply {
                orientation = android.widget.LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                layoutParams = android.widget.LinearLayout.LayoutParams(
                    android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                    android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(12) }
            }
            val label = android.widget.TextView(ctx).apply {
                layoutParams = android.widget.LinearLayout.LayoutParams(
                    0, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, 1f
                )
                text = getString(R.string.worker_counts_my_private) + " \u00b7 " + getString(labelRes)
                textSize = 14f
            }
            val value = android.widget.TextView(ctx).apply {
                layoutParams = android.widget.LinearLayout.LayoutParams(
                    android.widget.LinearLayout.LayoutParams.WRAP_CONTENT,
                    android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { marginStart = dp(12) }
                text = getString(R.string.worker_counts_fmt, total, active)
                textSize = 14f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            }
            row.addView(label)
            row.addView(value)
            b.workerCountsContainer.addView(row)
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
