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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.example.animastor.R
import com.example.animastor.databinding.DialogGenerateScopeBinding
import com.example.animastor.databinding.FragmentGenerateBinding
import com.example.animastor.databinding.ItemWorkerProgressBinding
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.BookData
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

    private var bookData: BookData? = null

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentGenerateBinding.bind(view)
        val b = binding ?: return

        // ── Position bar ──
        observePosition()
        loadBook()

        // ── Switch toggles ──
        // VBook switch is informational — always enabled; no listener needed
        b.audioSwitch.setOnCheckedChangeListener { _, checked ->
            viewModel.setAudioEnabled(checked)
        }
        b.imageSwitch.setOnCheckedChangeListener { _, checked ->
            viewModel.setImageEnabled(checked)
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

        // ── Auto-detect active generation tasks from previous sessions ──
        // При входе на экран Generator проверяем WorkerCounts: если есть
        // активные воркеры (восстановленные backend'ом после restart'а),
        // восстанавливаем UI-состояние: прогресс-бары, таймер, пульсацию.
        lifecycleScope.launch {
            // Небольшая задержка, чтобы backend успел завершить startup recovery
            delay(2_500)
            viewModel.checkAndRestoreGenerationState()
        }

        // ── Init labels with zero counts immediately (avoid flicker) ──
        // Labels start empty in XML; set initial "Audio (0)" values now,
        // before the first API poll completes, to prevent sudden "pop-in"
        // when data arrives.
        b.vbookLabel.text = getString(R.string.generate_section_vbook, 0)
        b.audioLabel.text = getString(R.string.generate_section_audio, 0)
        b.imageLabel.text = getString(R.string.generate_section_image, 0)
        b.videoLabel.text = getString(R.string.generate_section_video, 0)

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
                        total = counts.vbook,
                        active = counts.active_vbook,
                        sectionId = R.id.vbookIcon,
                        labelFormat = R.string.generate_section_vbook,
                        isGenerating = isGenerating,
                        isNeeded = true,
                        isEnabled = true,
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
                        isEnabled = viewModel.audioEnabled(),
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
                        isEnabled = viewModel.imageEnabled,
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
                        isEnabled = viewModel.videoEnabled(),
                        normalColor = normalColor,
                        activeColor = activeColor,
                        errorColor = errorColor
                    )

                } catch (_: Exception) {
                    // Connection error — stop any stale pulse and leave chips as-is
                    pulseAnimators.values.forEach { it.cancel() }
                    pulseAnimators.clear()
                }
                delay(5_000)
            }
        }

        // ── Reload book data when generation completes (new scenes) ──
        lifecycleScope.launch {
            viewModel.playbackPrepared.collect {
                loadBook()
            }
        }

        // ── Observe progress (poll /progress-panel every 1.5s) ──
        lifecycleScope.launch {
            while (true) {
                refreshProgressUi()
                delay(1_500)
            }
        }

        // ── Timer refresh loop (500ms) — updates elapsed time smoothly ──
        lifecycleScope.launch {
            while (true) {
                refreshTimerDisplay()
                delay(500)
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
        isEnabled: Boolean = true,
        normalColor: Int,
        activeColor: Int,
        errorColor: Int
    ) {
        label.text = getString(labelFormat, total)

        pulseAnimators[sectionId]?.cancel()
        pulseAnimators.remove(sectionId)

        val tint: Int
        // Error state: generating, needed, but no workers at all
        if (isGenerating && active == 0 && isNeeded && total == 0) {
            tint = errorColor
            icon.alpha = 1f
            icon.setImageResource(iconInactiveRes)
        } else if (active > 0) {
            // Active workers — show normal icon + golden pulsing
            tint = activeColor
            icon.alpha = 1f
            icon.setImageResource(iconActiveRes)
            val pulse = ObjectAnimator.ofFloat(icon, "alpha", 1f, 0.4f, 1f)
            pulse.duration = 1600
            pulse.repeatCount = ObjectAnimator.INFINITE
            pulse.start()
            pulseAnimators[sectionId] = pulse
        } else if (total > 0 && isEnabled) {
            // Worker exists and is enabled — show normal (non-crossed-out) icon, no pulse
            tint = normalColor
            icon.alpha = 1f
            icon.setImageResource(iconActiveRes)
        } else {
            // Worker absent (0) or disabled — show crossed-out icon
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
        val labels = TaskLabels(
            cover = getString(R.string.progress_cover_generating),
            audio = getString(R.string.progress_label_audio),
            image = getString(R.string.progress_label_image),
            video = getString(R.string.progress_label_video),
            generationDone = getString(R.string.generation_done),
            vbookLabel = "VBook, scenes",
            vbookAnalyzing = getString(R.string.progress_vbook_analyzing),
            vbookScenesFormat = { ready, total -> getString(R.string.progress_vbook_scenes, ready, total) }
        )

        val uiState = viewModel.uiState.value
        val vbookProg = uiState.vbookProgress
        val hasVBook = vbookProg != null && vbookProg.stage != VBookStage.IDLE

        val panel = runCatching {
            viewModel.repository.getProgressPanel(bookId = viewModel.bookId)
        }.getOrNull() ?: return
        val vbookToShow = if (hasVBook) {
            val updated = viewModel.checkVBookAgentStatus()
            if (updated.stage != VBookStage.IDLE) updated else vbookProg
        } else null
        val panelState = viewModel.computeProgressRows(panel, vbookToShow, labels)

        when (panelState) {
            is ProgressPanelState.Rows -> renderTaskRowsToSections(panelState.rows)
            is ProgressPanelState.DoneRow -> showSingleDoneRow(getString(R.string.generation_done))
            is ProgressPanelState.Hidden -> clearAllProgressLists()
        }
    }

    /**
     * Show a single "Done" row across all section containers.
     * Clears all previous rows and shows one green done message.
     */
    private fun showSingleDoneRow(label: String) {
        val b = binding ?: return
        val containers = listOf(b.vbookProgressList, b.audioProgressList, b.imageProgressList, b.videoProgressList)
        val greenColor = requireContext().getColor(R.color.cinema_success)
        val globalSec = when {
            viewModel.timerStartedAt > 0L -> (System.currentTimeMillis() - viewModel.timerStartedAt) / 1000L
            viewModel.timerStartedAt == -1L -> viewModel.finalElapsedSeconds
            else -> 0L
        }

        for (container in containers) {
            container.removeAllViews()
            val doneRow = ItemWorkerProgressBinding.inflate(layoutInflater, container, false)
            doneRow.workerName.text = label
            doneRow.workerName.setTextColor(greenColor)
            doneRow.workerCount.visibility = View.GONE
            doneRow.workerPercent.text = "100%"
            doneRow.workerPercent.setTextColor(greenColor)
            doneRow.workerPercent.visibility = View.VISIBLE
            doneRow.workerTimer.text = formatTimerText(globalSec)
            doneRow.workerTimer.visibility = View.VISIBLE
            doneRow.workerProgressBar.isIndeterminate = false
            doneRow.workerProgressBar.setProgressCompat(100, true)
            doneRow.workerProgressBar.setIndicatorColor(greenColor)
            doneRow.workerProgressBar.visibility = View.VISIBLE
            doneRow.workerStopButton.visibility = View.GONE
            container.addView(doneRow.root)
        }
    }

    /**
     * Refresh timer display on all currently visible worker rows.
     * Called every 500ms from a dedicated coroutine.
     *
     * Each row is tagged with its elapsed seconds:
     *   - tag >= 0 → frozen (done worker). Show the frozen value directly.
     *   - tag < 0  → live (active worker). Compute from viewModel.timerStartedAt.
     */
    private fun refreshTimerDisplay() {
        val b = binding ?: return
        val containers = listOf(b.vbookProgressList, b.audioProgressList, b.imageProgressList, b.videoProgressList)
        for (container in containers) {
            for (i in 0 until container.childCount) {
                val row = container.getChildAt(i)
                val tv = row.findViewById<TextView>(R.id.workerTimer)
                if (tv != null) {
                    val tag = row.tag
                    val sec = if (tag is Long && tag >= 0L) {
                        tag  // frozen — use stored value
                    } else if (viewModel.timerStartedAt > 0L) {
                        (System.currentTimeMillis() - viewModel.timerStartedAt) / 1000L
                    } else {
                        viewModel.finalElapsedSeconds
                    }
                    tv.text = formatTimerText(sec)
                }
            }
        }
    }

    private fun renderTaskRowsToSections(rows: List<TaskRow>) {
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

        for (taskRow in rows) {
            val container = when (taskRow.type) {
                "vbook" -> vbookContainer
                "audio" -> audioContainer
                "cover" -> imageContainer
                "image" -> imageContainer
                "video" -> videoContainer
                else -> null
            } ?: continue

            val rowBinding = ItemWorkerProgressBinding.inflate(layoutInflater, container, false)
            val row = rowBinding.root

            if (taskRow.cancelled) {
                rowBinding.workerName.text = getString(R.string.generation_done) + " — " + scopedTaskLabel(taskRow)
                rowBinding.workerName.setTextColor(errorColor)
                rowBinding.workerCount.visibility = View.GONE
                rowBinding.workerPercent.visibility = View.GONE
                rowBinding.workerTimer.visibility = View.GONE
                rowBinding.workerProgressBar.visibility = View.GONE
                rowBinding.workerStopButton.visibility = View.GONE
            } else if (taskRow.indeterminate) {
                rowBinding.workerName.text = scopedTaskLabel(taskRow)
                rowBinding.workerName.setTextColor(textColor)
                rowBinding.workerCount.visibility = View.GONE
                rowBinding.workerPercent.visibility = View.GONE
                rowBinding.workerTimer.text = formatTimerText(taskRow.elapsedSeconds)
                rowBinding.workerTimer.visibility = View.VISIBLE
                rowBinding.workerProgressBar.visibility = View.VISIBLE
                rowBinding.workerProgressBar.isIndeterminate = true
                rowBinding.workerProgressBar.setIndicatorColor(accentColor)
                rowBinding.workerStopButton.visibility = View.VISIBLE
                setupTaskStopButton(rowBinding.workerStopButton, row, taskRow)
                // Tag for refreshTimerDisplay: -1L = live, compute from timerStartedAt
                row.tag = -1L
            } else if (taskRow.done) {
                rowBinding.workerName.text = getString(R.string.generation_done) + " — " + scopedTaskLabel(taskRow)
                rowBinding.workerName.setTextColor(greenColor)
                rowBinding.workerCount.text = taskRow.countText ?: "${taskRow.ready}/${taskRow.total}"
                rowBinding.workerCount.setTextColor(greenColor)
                rowBinding.workerCount.visibility = View.VISIBLE
                rowBinding.workerPercent.text = "100%"
                rowBinding.workerPercent.setTextColor(greenColor)
                rowBinding.workerPercent.visibility = View.VISIBLE
                rowBinding.workerTimer.text = formatTimerText(taskRow.elapsedSeconds)
                rowBinding.workerTimer.visibility = View.VISIBLE
                rowBinding.workerProgressBar.visibility = View.VISIBLE
                rowBinding.workerProgressBar.isIndeterminate = false
                rowBinding.workerProgressBar.setProgressCompat(100, true)
                rowBinding.workerProgressBar.setIndicatorColor(greenColor)
                rowBinding.workerStopButton.visibility = View.GONE
                // Tag for refreshTimerDisplay: frozen elapsed (>= 0)
                row.tag = taskRow.elapsedSeconds
            } else {
                rowBinding.workerName.text = scopedTaskLabel(taskRow)
                rowBinding.workerName.setTextColor(textColor)
                rowBinding.workerCount.text = taskRow.countText ?: "${taskRow.ready}/${taskRow.total}"
                rowBinding.workerCount.setTextColor(mutedColor)
                rowBinding.workerCount.visibility = View.VISIBLE
                rowBinding.workerPercent.text = "${taskRow.percent}%"
                rowBinding.workerPercent.setTextColor(accentColor)
                rowBinding.workerPercent.visibility = View.VISIBLE
                rowBinding.workerTimer.text = formatTimerText(taskRow.elapsedSeconds)
                rowBinding.workerTimer.visibility = View.VISIBLE
                rowBinding.workerProgressBar.visibility = View.VISIBLE
                rowBinding.workerProgressBar.isIndeterminate = false
                rowBinding.workerProgressBar.setProgressCompat(taskRow.percent, true)
                rowBinding.workerProgressBar.setIndicatorColor(accentColor)
                rowBinding.workerStopButton.visibility = View.VISIBLE
                setupTaskStopButton(rowBinding.workerStopButton, row, taskRow)
                // Tag for refreshTimerDisplay: -1L = live, compute from timerStartedAt
                row.tag = -1L
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

    private fun setupTaskStopButton(
        stopButton: ImageButton,
        row: View,
        rowData: TaskRow
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
                viewModel.cancelTask(rowData.type, rowData.taskId)
                Log.i(TAG, "Task cancelled via popup: type=${rowData.type} task=${rowData.taskId}")
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
        // Build list of actually enabled layers based on toggle switches
        val enabledLayers = buildList {
            add("VBook")
            if (viewModel.audioEnabled()) add("Audio")
            if (viewModel.imageEnabled) add("Image")
            if (viewModel.videoEnabled()) add("Video")
        }
        val layersText = enabledLayers.joinToString(" → ")

        // Show scope dialog — applies to the GPU stages after VBook completes
        showScopeDialog { scope, _, _ ->
            onGenerateVBookClicked()
            val scopeLabel = when (scope) {
                "current_scene" -> getString(R.string.scope_current_scene)
                "current_chapter" -> getString(R.string.scope_current_chapter)
                "from_current_scene" -> getString(R.string.scope_from_current_scene)
                else -> getString(R.string.scope_whole_book)
            }
            Toast.makeText(requireContext(), "Generate All: $layersText ($scopeLabel)", Toast.LENGTH_SHORT).show()
        }
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
        updateVBookButtonText()
        Toast.makeText(requireContext(), "VBook generation started", Toast.LENGTH_SHORT).show()
    }

    private fun updateVBookButtonText() {
        val b = binding ?: return
        // Show "Next" if the book already has scenes/content, regardless of local click flag
        val hasExistingContent = bookData?.chapters?.orEmpty()?.any { ch ->
            ch.scenes?.orEmpty()?.isNotEmpty() == true
        } == true
        if (hasExistingContent && !viewModel.isRegenerating.value) {
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
        if (!viewModel.audioEnabled()) {
            Toast.makeText(requireContext(), R.string.generate_audio_disabled, Toast.LENGTH_SHORT).show()
            return
        }
        showScopeDialog { scope, chId, scId ->
            viewModel.startGeneration(
                GenerateViewModel.GenerationRequest(workerTypes = listOf("audio"), scope = scope, chapterId = chId, sceneId = scId)
            ) { result ->
                when (result) {
                    is GenerateViewModel.GenerationResult.Started -> Toast.makeText(requireContext(), "Audio generation started", Toast.LENGTH_SHORT).show()
                    is GenerateViewModel.GenerationResult.Failed -> Toast.makeText(requireContext(), "Failed: ${result.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun onGenerateImageClicked() {
        val bookId = viewModel.bookId
        if (bookId.isBlank()) {
            Toast.makeText(requireContext(), R.string.file_status_opening, Toast.LENGTH_SHORT).show()
            return
        }
        if (!viewModel.imageEnabled) {
            Toast.makeText(requireContext(), R.string.generate_image_disabled, Toast.LENGTH_SHORT).show()
            return
        }
        showScopeDialog { scope, chId, scId ->
            viewModel.startGeneration(
                GenerateViewModel.GenerationRequest(workerTypes = listOf("image"), scope = scope, chapterId = chId, sceneId = scId)
            ) { result ->
                when (result) {
                    is GenerateViewModel.GenerationResult.Started -> Toast.makeText(requireContext(), "Image generation started", Toast.LENGTH_SHORT).show()
                    is GenerateViewModel.GenerationResult.Failed -> Toast.makeText(requireContext(), "Failed: ${result.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun onGenerateVideoClicked() {
        val bookId = viewModel.bookId
        if (bookId.isBlank()) {
            Toast.makeText(requireContext(), R.string.file_status_opening, Toast.LENGTH_SHORT).show()
            return
        }
        if (!viewModel.videoEnabled()) {
            Toast.makeText(requireContext(), R.string.generate_video_disabled, Toast.LENGTH_SHORT).show()
            return
        }
        showScopeDialog { scope, chId, scId ->
            viewModel.startGeneration(
                GenerateViewModel.GenerationRequest(workerTypes = listOf("video"), scope = scope, chapterId = chId, sceneId = scId)
            ) { result ->
                when (result) {
                    is GenerateViewModel.GenerationResult.Started -> Toast.makeText(requireContext(), "Video generation started", Toast.LENGTH_SHORT).show()
                    is GenerateViewModel.GenerationResult.Failed -> Toast.makeText(requireContext(), "Failed: ${result.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun onStopClicked(type: String) {
        Log.i(TAG, "Stop clicked for type=$type")
        viewModel.cancelTask(type)
    }

    private fun scopedTaskLabel(taskRow: TaskRow): String {
        val target = when (row.scope) {
            "current_scene" -> row.sceneId
            "current_chapter" -> row.chapterId
            "from_current_scene" -> row.sceneId?.let { "$it+" }
            else -> null
        }
        return if (target.isNullOrBlank()) row.label else "${row.label} · $target"
    }

    // ═══════════════════════════════════════════════════════════════
    //  SCOPE DIALOG
    // ═══════════════════════════════════════════════════════════════

    /**
     * Show the scope selection dialog before starting generation.
     * Calls [onStart] with (scope, chapterId, sceneId) when the user confirms.
     */
    private fun showScopeDialog(onStart: (scope: String, chapterId: String?, sceneId: String?) -> Unit) {
        val binding = DialogGenerateScopeBinding.inflate(layoutInflater)

        val pos = SharedPositionManager.current.value
        val hasPosition = pos.chapterId != null

        // Disable scope options that require a position if no position is set
        if (!hasPosition) {
            binding.scopeCurrentScene.isEnabled = false
            binding.scopeCurrentScene.alpha = 0.4f
            binding.scopeCurrentChapter.isEnabled = false
            binding.scopeCurrentChapter.alpha = 0.4f
            binding.scopeFromCurrentScene.isEnabled = false
            binding.scopeFromCurrentScene.alpha = 0.4f
        }

        // Default selection: whole_book
        binding.scopeWholeBook.isChecked = true

        androidx.appcompat.app.AlertDialog.Builder(requireContext())
            .setTitle(R.string.generate_dialog_title)
            .setView(binding.root)
            .setNegativeButton(R.string.dialog_cancel, null)
            .setPositiveButton(R.string.dialog_start) { _, _ ->
                val scope = when (binding.scopeGroup.checkedRadioButtonId) {
                    R.id.scopeCurrentScene -> "current_scene"
                    R.id.scopeCurrentChapter -> "current_chapter"
                    R.id.scopeFromCurrentScene -> "from_current_scene"
                    else -> "whole_book"
                }
                val chId: String? = if (scope != "whole_book") pos.chapterId else null
                val scId: String? = if (scope == "current_scene" || scope == "from_current_scene") pos.sceneId else null
                onStart(scope, chId, scId)
            }
            .show()
    }

    // ═══════════════════════════════════════════════════════════════
    //  POSITION BAR (reactive, matches NavigateFragment/EditFragment)
    // ═══════════════════════════════════════════════════════════════

    private fun observePosition() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                SharedPositionManager.current.collect { pos ->
                    updatePositionBar(pos)
                }
            }
        }
    }

    private fun loadBook() {
        val bookId = viewModel.bookId.takeIf { it.isNotBlank() } ?: return
        lifecycleScope.launch {
            try {
                bookData = viewModel.repository.getBook(bookId)
                updatePositionBar(SharedPositionManager.current.value)
                updateVBookButtonText()
            } catch (_: Exception) {
                // Keep stale bookData on error
            }
        }
    }

    private fun updatePositionBar(pos: ActivePosition) {
        val b = binding ?: return
        val label = b.positionBar.positionLabel
        val unitCount = b.positionBar.unitCount

        if (pos.chapterId != null) {
            val bd = bookData
            val ch = bd?.chapters?.firstOrNull { it.chapter == pos.chapterId }
            val sc = ch?.scenes?.firstOrNull { it.scene_id == pos.sceneId }

            val isSpecial = ch?.is_special == true
            val scIdx = sc?.display_index ?: 0
            val allUnits = sc?.units ?: emptyList()
            val uIdx = if (allUnits.isNotEmpty()) pos.unitIndex.coerceIn(0, allUnits.size - 1) else 0

            val chTitle = ch?.chapter_title?.takeIf { it.isNotBlank() }
            val scTitle = sc?.scene_title?.takeIf { it.isNotBlank() }

            val chLabel = when {
                isSpecial -> chTitle ?: (ch?.type?.replaceFirstChar { it.uppercase() } ?: "")
                chTitle != null -> chTitle
                ch?.display_number != null -> "${getString(R.string.navigate_chapter)} ${ch.display_number}"
                else -> getString(R.string.navigate_no_position)
            }
            val scLabel = if (scIdx > 0) "${getString(R.string.navigate_scene)} $scIdx" else ""
            val unitLabel = if (uIdx >= 0 && allUnits.isNotEmpty()) "${getString(R.string.navigate_unit)} ${uIdx + 1}" else ""

            val fullLabel = when {
                chLabel.isEmpty() -> getString(R.string.navigate_no_position)
                isSpecial && scTitle != null -> "$chLabel / $scLabel — $scTitle / $unitLabel"
                isSpecial -> "$chLabel / $scLabel / $unitLabel"
                chTitle != null && scTitle != null -> "$chLabel / $scLabel — $scTitle / $unitLabel"
                scTitle != null -> "$chLabel / $scLabel — $scTitle / $unitLabel"
                else -> "$chLabel / $scLabel / $unitLabel"
            }
            label.text = fullLabel

            unitCount.text = getString(R.string.navigate_units_count, allUnits.size)
            unitCount.visibility = if (allUnits.isNotEmpty()) View.VISIBLE else View.GONE
        } else {
            label.text = getString(R.string.navigate_no_position)
            unitCount.visibility = View.GONE
        }

        b.positionBar.root.setOnClickListener {
            (requireActivity() as? MainActivity)?.switchToNavigateTab()
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Format elapsed seconds into HH:MM:SS display string.
     * @param elapsedSeconds Number of seconds elapsed (frozen for done workers,
     *                       live for active workers). Can be -1 if timer hasn't
     *                       started (falls back to 0).
     */
    private fun formatTimerText(elapsedSeconds: Long): String {
        val sec = elapsedSeconds.coerceAtLeast(0L)
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
