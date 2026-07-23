@file:Suppress("UNUSED_PARAMETER")

package com.example.animastor.ui

import android.animation.ObjectAnimator
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.lifecycleScope
import com.example.animastor.R
import com.example.animastor.databinding.FragmentGenerateBinding
import com.example.animastor.databinding.ItemWorkerProgressBinding
import com.example.animastor.network.RetrofitClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val TAG = "GenerateFragment"

class GenerateFragment : Fragment(R.layout.fragment_generate) {

    private var binding: FragmentGenerateBinding? = null
    private val viewModel: GenerateViewModel by activityViewModels {
        GenerateViewModel.factory
    }

    // Pulse animation trackers per section
    private val pulseAnimators = mutableMapOf<Int, ObjectAnimator>() // viewId -> animator

    // VBook window tracking: becomes true after first window completes
    private var _vbookWindowGenerated = false

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentGenerateBinding.bind(view)
        val b = binding ?: return

        // ── Position bar ──
        setupPositionBar()

        // ── Switch toggles ──
        // VBook switch is informational — always enabled; no listener needed
        b.audioSwitch.setOnCheckedChangeListener { _, checked ->
            viewModel.setAudioEnabled(checked)
        }
        b.imageSwitch.setOnCheckedChangeListener { _, _ ->
            viewModel.toggleImageForProfile()
        }
        b.videoSwitch.setOnCheckedChangeListener { _, checked ->
            viewModel.setVideoEnabled(checked)
        }

        // ── Header rows (tap to toggle) ──
        // VBook header is informational — no toggle action
        b.audioHeaderRow.setOnClickListener { b.audioSwitch.performClick() }
        b.imageHeaderRow.setOnClickListener { b.imageSwitch.performClick() }
        b.videoHeaderRow.setOnClickListener { b.videoSwitch.performClick() }

        // ── Generate buttons ──
        b.generateAllButton.setOnClickListener { onGenerateAllClicked() }
        b.stopAllButton.setOnClickListener { onStopAllClicked() }

        b.generateVBookButton.setOnClickListener { onGenerateVBookClicked() }
        b.stopVBookButton.setOnClickListener { onStopClicked("vbook") }

        b.generateAudioButton.setOnClickListener { onGenerateAudioClicked() }
        b.stopAudioButton.setOnClickListener { onStopClicked("audio") }

        b.generateImageButton.setOnClickListener { onGenerateImageClicked() }
        b.stopImageButton.setOnClickListener { onStopClicked("image") }

        b.generateVideoButton.setOnClickListener { onGenerateVideoClicked() }
        b.stopVideoButton.setOnClickListener { onStopClicked("video") }

        // ── Observe layer config (switch states) ──
        lifecycleScope.launch {
            viewModel.layerConfigLoadedFlow.collect { loaded ->
                if (loaded) {
                    b.vbookSwitch.isChecked = true // VBook is always on
                    b.audioSwitch.isChecked = viewModel.audioEnabled()
                    b.imageSwitch.isChecked = viewModel.imageEnabled
                    b.videoSwitch.isChecked = viewModel.videoEnabled()
                }
            }
        }

        // ── Observe worker counts ──
        lifecycleScope.launch {
            val normalColor = requireContext().getColor(R.color.cinema_text_disabled)
            val activeColor = requireContext().getColor(R.color.cinema_accent)
            val errorColor = requireContext().getColor(R.color.cinema_error)

            while (true) {
                try {
                    val counts = RetrofitClient.api.getWorkerCounts()
                    val uiState = viewModel.uiState.value
                    val phase = uiState.phase
                    val mode = uiState.mode
                    val isGenerating = phase == PlayerPhase.GENERATING || phase == PlayerPhase.LOADING_BOOK || viewModel.isRegenerating.value

                    updateSectionHeader(
                        icon = b.vbookIcon,
                        label = b.vbookLabel,
                        iconActiveRes = R.drawable.ic_library,
                        iconInactiveRes = R.drawable.ic_library,
                        total = counts.audio,
                        active = counts.active_audio,
                        sectionId = R.id.vbookIcon,
                        labelFormat = R.string.generate_section_vbook,
                        isGenerating = isGenerating,
                        isNeeded = true,
                        normalColor = normalColor,
                        activeColor = activeColor,
                        errorColor = errorColor
                    )

                    updateSectionHeader(
                        icon = b.audioIcon,
                        label = b.audioLabel,
                        iconActiveRes = R.drawable.ic_volume_up,
                        iconInactiveRes = R.drawable.ic_volume_off,
                        total = counts.audio,
                        active = counts.active_audio,
                        sectionId = R.id.audioIcon,
                        labelFormat = R.string.generate_section_audio,
                        isGenerating = isGenerating,
                        isNeeded = mode == "storyboard" || mode == "full" || mode == "image_only",
                        normalColor = normalColor,
                        activeColor = activeColor,
                        errorColor = errorColor
                    )

                    updateSectionHeader(
                        icon = b.imageIcon,
                        label = b.imageLabel,
                        iconActiveRes = R.drawable.ic_image,
                        iconInactiveRes = R.drawable.ic_image_off,
                        total = counts.image,
                        active = counts.active_image,
                        sectionId = R.id.imageIcon,
                        labelFormat = R.string.generate_section_image,
                        isGenerating = isGenerating,
                        isNeeded = mode == "storyboard" || mode == "full" || mode == "image_only",
                        normalColor = normalColor,
                        activeColor = activeColor,
                        errorColor = errorColor
                    )

                    updateSectionHeader(
                        icon = b.videoIcon,
                        label = b.videoLabel,
                        iconActiveRes = R.drawable.ic_videocam,
                        iconInactiveRes = R.drawable.ic_videocam_off,
                        total = counts.video,
                        active = counts.active_video,
                        sectionId = R.id.videoIcon,
                        labelFormat = R.string.generate_section_video,
                        isGenerating = isGenerating,
                        isNeeded = mode == "full",
                        normalColor = normalColor,
                        activeColor = activeColor,
                        errorColor = errorColor
                    )

                } catch (_: Exception) {
                    // Connection error — keep previous state
                }
                delay(5_000)
            }
        }

        // ── Observe progress ──
        lifecycleScope.launch {
            while (true) {
                refreshProgressUi()

                delay(1_500)
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  SECTION HEADER UPDATE
    // ═══════════════════════════════════════════════════════════════

    private fun updateSectionHeader(
        icon: ImageView,
        label: TextView,
        iconActiveRes: Int,
        iconInactiveRes: Int,
        total: Int,
        active: Int,
        sectionId: Int,
        labelFormat: Int,
        isGenerating: Boolean,
        isNeeded: Boolean,
        normalColor: Int,
        activeColor: Int,
        errorColor: Int
    ) {
        label.text = getString(labelFormat, total)

        pulseAnimators[sectionId]?.cancel()
        pulseAnimators.remove(sectionId)

        val tint: Int
        if (isGenerating && active == 0 && isNeeded && total == 0) {
            tint = errorColor
            icon.alpha = 1f
            icon.setImageResource(iconInactiveRes)
        } else if (active > 0) {
            tint = activeColor
            icon.alpha = 1f
            icon.setImageResource(iconActiveRes)
            val pulse = ObjectAnimator.ofFloat(icon, "alpha", 1f, 0.4f, 1f)
            pulse.duration = 1600
            pulse.repeatCount = ObjectAnimator.INFINITE
            pulse.start()
            pulseAnimators[sectionId] = pulse
        } else {
            tint = normalColor
            icon.alpha = 1f
            icon.setImageResource(iconInactiveRes)
        }
        icon.imageTintList = android.content.res.ColorStateList.valueOf(tint)
        label.setTextColor(tint)
    }

    // ═══════════════════════════════════════════════════════════════
    //  PROGRESS RENDERING
    // ═══════════════════════════════════════════════════════════════

    private suspend fun refreshProgressUi() {
        if (binding == null) return
        val labels = WorkerLabels(
            cover = getString(R.string.progress_cover_generating),
            audio = getString(R.string.progress_label_audio),
            image = getString(R.string.progress_label_image),
            video = getString(R.string.progress_label_video),
            generationDone = getString(R.string.generation_done),
            vbookLabel = "VBook, scenes",
            vbookAnalyzing = getString(R.string.progress_vbook_analyzing),
            vbookScenesFormat = { ready, total -> getString(R.string.progress_vbook_scenes, ready, total) }
        )

        val activeGen = viewModel.activeGeneration.value
        val uiState = viewModel.uiState.value
        val vbookProg = uiState.vbookProgress
        val hasVBook = vbookProg != null && vbookProg.stage != VBookStage.IDLE

        if (activeGen != null) {
            val panel = runCatching {
                viewModel.repository.getProgressPanel(
                    bookId = viewModel.bookId,
                    scope = activeGen.scope,
                    chapterId = activeGen.chapterId,
                    sceneId = activeGen.sceneId
                )
            }.getOrNull()

            val panelState = viewModel.computeWorkers(panel, if (hasVBook) vbookProg else null, labels)

            if (panelState is ProgressPanelState.Workers) {
                renderWorkersToSections(panelState.workers)
            } else if (panelState is ProgressPanelState.Hidden) {
                clearAllProgressLists()
            }
        } else if (hasVBook) {
            val updated = viewModel.checkVBookAgentStatus()
            val vbookToShow = if (updated.stage != VBookStage.IDLE) updated else vbookProg
            val panelState = viewModel.computeWorkers(null, vbookToShow, labels)
            if (panelState is ProgressPanelState.Workers) {
                renderWorkersToSections(panelState.workers)
            }
        } else {
            clearAllProgressLists()
        }
    }

    private fun renderWorkersToSections(workers: List<WorkerUi>) {
        val b = binding ?: return
        val vbookContainer = b.vbookProgressList
        val audioContainer = b.audioProgressList
        val imageContainer = b.imageProgressList
        val videoContainer = b.videoProgressList

        vbookContainer.removeAllViews()
        audioContainer.removeAllViews()
        imageContainer.removeAllViews()
        videoContainer.removeAllViews()

        val greenColor = requireContext().getColor(R.color.cinema_success)
        val accentColor = requireContext().getColor(R.color.cinema_accent)
        val textColor = requireContext().getColor(R.color.cinema_text_secondary)
        val mutedColor = requireContext().getColor(R.color.cinema_text_disabled)
        val errorColor = requireContext().getColor(R.color.cinema_error)

        for (worker in workers) {
            val container = when (worker.type) {
                "vbook" -> vbookContainer
                "audio" -> audioContainer
                "image" -> imageContainer
                "video" -> imageContainer
                else -> null
            } ?: continue

            val rowBinding = ItemWorkerProgressBinding.inflate(layoutInflater, container, false)
            val row = rowBinding.root

            if (worker.cancelled) {
                rowBinding.workerName.text = getString(R.string.generation_done) + " — " + worker.label
                rowBinding.workerName.setTextColor(errorColor)
                rowBinding.workerCount.visibility = View.GONE
                rowBinding.workerPercent.visibility = View.GONE
                rowBinding.workerTimer.visibility = View.GONE
                rowBinding.workerProgressBar.visibility = View.GONE
                rowBinding.workerStopButton.visibility = View.GONE
            } else if (worker.indeterminate) {
                rowBinding.workerName.text = worker.label
                rowBinding.workerName.setTextColor(textColor)
                rowBinding.workerCount.visibility = View.GONE
                rowBinding.workerPercent.visibility = View.GONE
                rowBinding.workerTimer.text = formatTimerText()
                rowBinding.workerTimer.visibility = View.VISIBLE
                rowBinding.workerProgressBar.visibility = View.VISIBLE
                rowBinding.workerProgressBar.isIndeterminate = true
                rowBinding.workerProgressBar.setIndicatorColor(accentColor)
                rowBinding.workerStopButton.visibility = View.VISIBLE
                setupWorkerStopButton(rowBinding.workerStopButton, row, worker)
            } else if (worker.done) {
                rowBinding.workerName.text = getString(R.string.generation_done) + " — " + worker.label
                rowBinding.workerName.setTextColor(greenColor)
                rowBinding.workerCount.text = worker.countText ?: "${worker.ready}/${worker.total}"
                rowBinding.workerCount.setTextColor(greenColor)
                rowBinding.workerCount.visibility = View.VISIBLE
                rowBinding.workerPercent.text = "100%"
                rowBinding.workerPercent.setTextColor(greenColor)
                rowBinding.workerPercent.visibility = View.VISIBLE
                rowBinding.workerTimer.text = formatTimerText()
                rowBinding.workerTimer.visibility = View.VISIBLE
                rowBinding.workerProgressBar.visibility = View.VISIBLE
                rowBinding.workerProgressBar.isIndeterminate = false
                rowBinding.workerProgressBar.setProgressCompat(100, true)
                rowBinding.workerProgressBar.setIndicatorColor(greenColor)
                rowBinding.workerStopButton.visibility = View.GONE
            } else {
                rowBinding.workerName.text = worker.label
                rowBinding.workerName.setTextColor(textColor)
                rowBinding.workerCount.text = worker.countText ?: "${worker.ready}/${worker.total}"
                rowBinding.workerCount.setTextColor(mutedColor)
                rowBinding.workerCount.visibility = View.VISIBLE
                rowBinding.workerPercent.text = "${worker.percent}%"
                rowBinding.workerPercent.setTextColor(accentColor)
                rowBinding.workerPercent.visibility = View.VISIBLE
                rowBinding.workerTimer.text = formatTimerText()
                rowBinding.workerTimer.visibility = View.VISIBLE
                rowBinding.workerProgressBar.visibility = View.VISIBLE
                rowBinding.workerProgressBar.isIndeterminate = false
                rowBinding.workerProgressBar.setProgressCompat(worker.percent, true)
                rowBinding.workerProgressBar.setIndicatorColor(accentColor)
                rowBinding.workerStopButton.visibility = View.VISIBLE
                setupWorkerStopButton(rowBinding.workerStopButton, row, worker)
            }

            container.addView(row)
        }
    }

    private fun clearAllProgressLists() {
        val b = binding ?: return
        b.vbookProgressList.removeAllViews()
        b.audioProgressList.removeAllViews()
        b.imageProgressList.removeAllViews()
        b.videoProgressList.removeAllViews()
    }

    private var _highlightColor: Int = 0
    private var _highlightedRow: View? = null

    private fun setupWorkerStopButton(
        stopButton: ImageButton,
        row: View,
        worker: WorkerUi
    ) {
        stopButton.setOnClickListener { view ->
            if (_highlightColor == 0) {
                val errColor = requireContext().getColor(R.color.cinema_error)
                _highlightColor = (errColor and 0x00FFFFFF) or (0x1F shl 24)
            }
            _highlightedRow?.setBackgroundColor(android.graphics.Color.TRANSPARENT)
            _highlightedRow = row
            row.setBackgroundColor(_highlightColor)

            val popup = PopupMenu(requireContext(), view, android.view.Gravity.END)
            popup.menu.add(0, 1, 0, getString(R.string.worker_stop_menu_cancel))
            popup.setOnDismissListener {
                _highlightedRow?.setBackgroundColor(android.graphics.Color.TRANSPARENT)
                _highlightedRow = null
            }
            popup.setOnMenuItemClickListener { _ ->
                _highlightedRow?.setBackgroundColor(android.graphics.Color.TRANSPARENT)
                _highlightedRow = null
                viewModel.cancelWorker(worker.type)
                Log.i(TAG, "Worker cancelled via popup: type=${worker.type}")
                true
            }
            popup.show()
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  ACTIONS
    // ═══════════════════════════════════════════════════════════════

    private fun onGenerateAllClicked() {
        val bookId = viewModel.bookId
        if (bookId.isBlank()) {
            Toast.makeText(requireContext(), R.string.file_status_opening, Toast.LENGTH_SHORT).show()
            return
        }
        onGenerateVBookClicked()
        Toast.makeText(requireContext(), "Generate All: starting VBook → Audio → Image → Video", Toast.LENGTH_SHORT).show()
    }

    private fun onStopAllClicked() {
        Log.i(TAG, "Stop All clicked — stopping all generation")
        viewModel.cancelGeneration()
    }

    private fun onGenerateVBookClicked() {
        val bookId = viewModel.bookId
        if (bookId.isBlank()) {
            Toast.makeText(requireContext(), R.string.file_status_opening, Toast.LENGTH_SHORT).show()
            return
        }
        viewModel.startVBookGeneration()
        _vbookWindowGenerated = true
        updateVBookButtonText()
        Toast.makeText(requireContext(), "VBook generation started", Toast.LENGTH_SHORT).show()
    }

    private fun updateVBookButtonText() {
        val b = binding ?: return
        if (_vbookWindowGenerated && viewModel.activeGeneration.value == null) {
            b.generateVBookButton.text = getString(R.string.generate_vbook_next)
        } else {
            b.generateVBookButton.text = getString(R.string.generate_vbook)
        }
    }

    private fun onGenerateAudioClicked() {
        val bookId = viewModel.bookId
        if (bookId.isBlank()) {
            Toast.makeText(requireContext(), R.string.file_status_opening, Toast.LENGTH_SHORT).show()
            return
        }
        viewModel.startGeneration(
            GenerateViewModel.GenerationRequest(profile = "audio_only", scope = "whole_book", chapterId = null, sceneId = null)
        ) { result ->
            when (result) {
                is GenerateViewModel.GenerationResult.Started -> Toast.makeText(requireContext(), "Audio generation started", Toast.LENGTH_SHORT).show()
                is GenerateViewModel.GenerationResult.Failed -> Toast.makeText(requireContext(), "Failed: ${result.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun onGenerateImageClicked() {
        val bookId = viewModel.bookId
        if (bookId.isBlank()) {
            Toast.makeText(requireContext(), R.string.file_status_opening, Toast.LENGTH_SHORT).show()
            return
        }
        viewModel.startGeneration(
            GenerateViewModel.GenerationRequest(profile = "image_only", scope = "whole_book", chapterId = null, sceneId = null)
        ) { result ->
            when (result) {
                is GenerateViewModel.GenerationResult.Started -> Toast.makeText(requireContext(), "Image generation started", Toast.LENGTH_SHORT).show()
                is GenerateViewModel.GenerationResult.Failed -> Toast.makeText(requireContext(), "Failed: ${result.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun onGenerateVideoClicked() {
        val bookId = viewModel.bookId
        if (bookId.isBlank()) {
            Toast.makeText(requireContext(), R.string.file_status_opening, Toast.LENGTH_SHORT).show()
            return
        }
        viewModel.startGeneration(
            GenerateViewModel.GenerationRequest(profile = "full", scope = "whole_book", chapterId = null, sceneId = null)
        ) { result ->
            when (result) {
                is GenerateViewModel.GenerationResult.Started -> Toast.makeText(requireContext(), "Video generation started", Toast.LENGTH_SHORT).show()
                is GenerateViewModel.GenerationResult.Failed -> Toast.makeText(requireContext(), "Failed: ${result.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun onStopClicked(type: String) {
        Log.i(TAG, "Stop clicked for type=$type")
        viewModel.cancelWorker(type)
    }

    // ═══════════════════════════════════════════════════════════════
    //  POSITION BAR
    // ═══════════════════════════════════════════════════════════════

    private fun setupPositionBar() {
        val b = binding ?: return
        val label = b.positionBar.positionLabel
        val unitCount = b.positionBar.unitCount

        lifecycleScope.launch {
            while (true) {
                val pos = SharedPositionManager.current.value
                val chId = pos.chapterId
                val scId = pos.sceneId

                if (!chId.isNullOrBlank() && !scId.isNullOrBlank()) {
                    val chNum = chId.substringAfter("ch").substringBefore("_").takeIf { it.isNotBlank() } ?: chId
                    val scNum = scId.substringAfter("sc").substringBefore("_").takeIf { it.isNotBlank() } ?: scId
                    label.text = getString(R.string.navigate_chapter) + " $chNum  /  " + getString(R.string.navigate_scene) + " $scNum"
                    unitCount.visibility = View.GONE
                } else {
                    label.text = getString(R.string.navigate_no_position)
                    unitCount.visibility = View.GONE
                }

                b.positionBar.root.setOnClickListener {
                    val activity = requireActivity() as? MainActivity
                    activity?.switchToNavigateTab()
                }

                delay(3_000)
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════════

    private fun formatTimerText(): String {
        val sec = when {
            viewModel.timerStartedAt > 0L -> (System.currentTimeMillis() - viewModel.timerStartedAt) / 1000L
            viewModel.timerStartedAt == -1L -> viewModel.finalElapsedSeconds
            else -> 0L
        }
        val hh = (sec / 3600).toInt()
        val mm = ((sec % 3600) / 60).toInt()
        val ss = (sec % 60).toInt()
        return String.format("%02d:%02d:%02d", hh, mm, ss)
    }

    override fun onDestroyView() {
        pulseAnimators.values.forEach { it.cancel() }
        pulseAnimators.clear()
        binding = null
        super.onDestroyView()
    }
}
