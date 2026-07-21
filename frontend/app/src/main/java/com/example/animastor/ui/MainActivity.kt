package com.example.animastor.ui

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.os.Bundle
import android.animation.ObjectAnimator
import android.util.Log
import android.view.View
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.chip.Chip
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import com.example.animastor.R
import com.example.animastor.databinding.ActivityMainBinding
import com.example.animastor.databinding.DialogLibraryBinding
import com.example.animastor.databinding.DialogGenerateScopeBinding
import com.example.animastor.model.BookItem
import com.example.animastor.network.RetrofitClient
import com.example.animastor.ui.adapter.BookAdapter
import java.io.File
import java.util.Calendar
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var selectedBook: BookItem? = null
    private var isBottomNavHidden = false
    private var pendingAiCreateMode = false

    private val viewModel: GenerateViewModel by lazy {
        ViewModelProvider(this, GenerateViewModel.factory).get(GenerateViewModel::class.java)
    }

    private val playbackViewModel: PlaybackViewModel by lazy {
        ViewModelProvider(this, PlaybackViewModel.factory).get(PlaybackViewModel::class.java)
    }

    fun switchToPlayTab() {
        binding.bottomNavigation.selectedItemId = R.id.playFragment
    }

    fun switchToNavigateTab() {
        binding.bottomNavigation.selectedItemId = R.id.navigateFragment
    }

    fun switchToAiTab(createMode: Boolean = false) {
        if (createMode) {
            supportFragmentManager.findFragmentByTag("AiAssistantFragment")?.let {
                supportFragmentManager.beginTransaction().remove(it).commitNow()
            }
        }
        pendingAiCreateMode = createMode
        binding.bottomNavigation.selectedItemId = R.id.aiFragment
    }

    fun toggleBottomNavigationVisible(show: Boolean) {
        if (show) {
            binding.bottomNavigation.visibility = View.VISIBLE
            binding.toolbar.visibility = View.VISIBLE
        } else {
            binding.bottomNavigation.visibility = View.INVISIBLE
            binding.toolbar.visibility = View.INVISIBLE
        }
        isBottomNavHidden = !show
    }

    override fun attachBaseContext(newBase: Context) {
        val prefs = newBase.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val lang = prefs.getString(PREFS_LANG, LANG_AUTO)
        val sysLang = newBase.resources.configuration.locales.get(0)?.language ?: "en"
        val locale = when {
            lang == LANG_RU -> Locale("ru")
            lang == LANG_AUTO -> if (sysLang == "ru") Locale("ru") else Locale.ENGLISH
            else -> Locale.ENGLISH
        }
        Locale.setDefault(locale)
        val config = android.content.res.Configuration(newBase.resources.configuration)
        config.setLocale(locale)
        super.attachBaseContext(newBase.createConfigurationContext(config))
    }

    private fun applyTheme() {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val theme = prefs.getString(PREFS_THEME, THEME_AUTO)
        
        // Логика выбора стиля
        val resolved = if (theme == THEME_AUTO) {
            val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
            if (hour in 6..19) THEME_LIGHT else THEME_DARK
        } else {
            theme
        }
        
        // Устанавливаем стиль перед super.onCreate/setContentView в идеале, 
        // но так как recreate() здесь вызывает onCreate снова, попробуем явно применить тему
        val themeRes = when (resolved) {
            THEME_LIGHT -> R.style.Theme_Animastor_CinemaLight
            else -> R.style.Theme_Animastor_CinemaDark
        }
        setTheme(themeRes)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        applyTheme()
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        if (savedInstanceState == null) {
            // Cold start: drop any persisted session so Navigate/Edit start empty.
            // (On config change savedInstanceState != null and we keep the session.)
            viewModel.closeBook()
            playbackViewModel.closeBook()
        }

        if (savedInstanceState == null) {
            supportFragmentManager.beginTransaction()
                .add(R.id.nav_host_container, FileFragment(), "FileFragment")
                .commit()
        }

        // ── Timer loop — читает viewModel.timerStartedAt напрямую ──
        lifecycleScope.launch {
            while (true) {
                val elapsed = viewModel.timerStartedAt.let { start ->
                    if (start > 0L) (System.currentTimeMillis() - start) / 1000L else 0L
                }
                val timerText = formatTimerText(elapsed)
                binding.generationTimer.text = timerText
                // Update timer in each visible worker row
                val container = binding.workerProgressList
                for (i in 0 until container.childCount) {
                    val row = container.getChildAt(i)
                    if (row.visibility == View.VISIBLE) {
                        row.findViewById<TextView>(R.id.workerTimer)?.text = timerText
                    }
                }
                delay(500L)
            }
        }

        // Handle incoming intent from .vbook file association
        handleVBookIntent(intent)

        binding.settingsButton.setOnClickListener {
            supportFragmentManager.beginTransaction()
                .add(R.id.nav_host_container, SettingsFragment(), "SettingsFragment")
                .addToBackStack(null)
                .commit()
        }

        setupWorkerToggles()
        loadInitialLayerConfig()
        setupPlaybackCoordination()

        lifecycleScope.launch {
            binding.workerPanel.visibility = View.VISIBLE
            val normalColor = getColor(R.color.cinema_text_disabled)
            val activeColor = getColor(R.color.cinema_accent)
            val errorColor = getColor(R.color.cinema_error)
            while (true) {
                try {
                    val counts = RetrofitClient.api.getWorkerCounts()
                    val state = viewModel.uiState.value
                    val phase = state.phase
                    val mode = state.mode
                    val isGenerating = phase == PlayerPhase.GENERATING || phase == PlayerPhase.LOADING_BOOK || viewModel.isRegenerating.value
                    val audioNeeded = mode == "storyboard" || mode == "full" || mode == "image_only"
                    val imageNeeded = mode == "storyboard" || mode == "full" || mode == "image_only"
                    val videoNeeded = mode == "full"

                    updateWorkerPanel(
                        chip = binding.workerAudioLayout,
                        count = binding.workerAudioCount,
                        total = counts.audio,
                        active = counts.active_audio,
                        isGenerating = isGenerating,
                        isNeeded = audioNeeded,
                        normalColor = normalColor,
                        activeColor = activeColor,
                        errorColor = errorColor
                    )
                    updateWorkerPanel(
                        chip = binding.workerImageLayout,
                        count = binding.workerImageCount,
                        total = counts.image,
                        active = counts.active_image,
                        isGenerating = isGenerating,
                        isNeeded = imageNeeded,
                        normalColor = normalColor,
                        activeColor = activeColor,
                        errorColor = errorColor
                    )
                    updateWorkerPanel(
                        chip = binding.workerVideoLayout,
                        count = binding.workerVideoCount,
                        total = counts.video,
                        active = counts.active_video,
                        isGenerating = isGenerating,
                        isNeeded = videoNeeded,
                        normalColor = normalColor,
                        activeColor = activeColor,
                        errorColor = errorColor
                    )
                } catch (_: Exception) {
                    binding.workerAudioCount.text = "?"
                    binding.workerImageCount.text = "?"
                    binding.workerVideoCount.text = "?"
                }
                delay(5_000)
            }
        }

        binding.toolbarGenerateButton.setOnClickListener {
            if (viewModel.isRegenerating.value) {
                viewModel.cancelGeneration()
            } else {
                onGenerateClicked()
            }
        }

        lifecycleScope.launch {
            var prevBookId = ""
            while (true) {
                val bookId = viewModel.bookId
                if (bookId != prevBookId) {
                    prevBookId = bookId
                    if (bookId.isNotBlank()) {
                        viewModel.loadLayerConfig()
                    }
                }
                refreshGenerateButton()
                if (bookId.isNotBlank()) {
                    viewModel.refreshAssetsState()
                }
                refreshWorkerToggleUi()
                delay(1_500)
            }
        }

        lifecycleScope.launch {
            startGenerationProgressPoller()
        }

        binding.bottomNavigation.setOnItemSelectedListener { item ->
            val tag = when (item.itemId) {
                R.id.fileFragment -> "FileFragment"
                R.id.editFragment -> "EditFragment"
                R.id.playFragment -> "PlayFragment"
                R.id.navigateFragment -> "NavigateFragment"
                R.id.aiFragment -> "AiAssistantFragment"
                else -> return@setOnItemSelectedListener true
            }

            val existing = supportFragmentManager.findFragmentByTag(tag)
            if (existing != null) {
                supportFragmentManager.beginTransaction()
                    .apply {
                        supportFragmentManager.fragments.forEach { hide(it) }
                    }
                    .show(existing)
                    .commit()
            } else {
                val fragment: Fragment = when (item.itemId) {
                    R.id.editFragment -> EditFragment()
                    R.id.playFragment -> PlayFragment()
                    R.id.navigateFragment -> NavigateFragment()
                    R.id.aiFragment -> {
                        val createMode = pendingAiCreateMode
                        pendingAiCreateMode = false
                        AiAssistantFragment.newInstance(createMode = createMode)
                    }
                    else -> FileFragment()
                }
                supportFragmentManager.beginTransaction()
                    .apply {
                        supportFragmentManager.fragments.forEach { hide(it) }
                    }
                    .add(R.id.nav_host_container, fragment, tag)
                    .commit()
            }
            true
        }
    }

    /**
     * Coordinate between [GenerateViewModel] (generation) and
     * [PlaybackViewModel] (player) by observing chunk-ready signals
     * from the generation pipeline and forwarding them to the player.
     *
     * Cover image is included directly in [PlaybackPreparation.coverImage]
     * and applied via [PlaybackViewModel.setCoverImage] for both initial
     * load and soft refresh — no separate cover channel needed.
     */
    private fun setupPlaybackCoordination() {
        lifecycleScope.launch {
            viewModel.playbackPrepared.collect { prep ->
                Log.i("MainActivity", "playbackPrepared: book=${prep.bookId} scenes=${prep.scenes.size} cover=${prep.coverImage != null} soft=${prep.softRefresh}")
                if (prep.softRefresh) {
                    playbackViewModel.refreshContent(
                        bookId = prep.bookId,
                        buildId = prep.buildId,
                        scenes = prep.scenes
                    )
                } else {
                    playbackViewModel.preparePlayback(
                        bookId = prep.bookId,
                        buildId = prep.buildId,
                        scenes = prep.scenes
                    )
                }
                if (prep.coverImage != null) {
                    playbackViewModel.setCoverImage(prep.coverImage)
                }
            }
        }
    }

    @Suppress("DEPRECATION")
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE) {
            val fragment = supportFragmentManager.findFragmentByTag("PlayFragment") as? PlayFragment
            fragment?.stopAll()
        }
    }

    private val pulseAnimators = mutableMapOf<View, ObjectAnimator>()

    private fun updateWorkerPanel(
        chip: Chip,
        count: TextView,
        total: Int,
        active: Int,
        isGenerating: Boolean,
        isNeeded: Boolean,
        normalColor: Int,
        activeColor: Int,
        errorColor: Int
    ) {
        count.text = total.toString()

        pulseAnimators[chip]?.cancel()
        pulseAnimators.remove(chip)

        val tint: Int
        if (isGenerating && active == 0 && isNeeded && total == 0) {
            tint = errorColor
            chip.alpha = 1f
        } else if (active > 0) {
            // Pulse only when real worker leases are active on the backend
            tint = activeColor
            chip.alpha = 1f
            val pulse = ObjectAnimator.ofFloat(chip, "alpha", 1f, 0.4f, 1f)
            pulse.duration = 1600
            pulse.repeatCount = ObjectAnimator.INFINITE
            pulse.start()
            pulseAnimators[chip] = pulse
        } else {
            tint = normalColor
            chip.alpha = 1f
        }
        chip.setChipIconTint(android.content.res.ColorStateList.valueOf(tint))
    }

    // -------------------------------------------------------------------
    // Phase C — Worker toggles as profile selector
    // -------------------------------------------------------------------

    private fun setupWorkerToggles() {
        binding.workerAudioLayout.setOnClickListener {
            viewModel.toggleAudioForProfile()
        }
        binding.workerImageLayout.setOnClickListener {
            viewModel.toggleImageForProfile()
        }
        binding.workerVideoLayout.setOnClickListener {
            viewModel.toggleVideoForProfile()
        }
    }

    private fun loadInitialLayerConfig() {
        lifecycleScope.launch {
            viewModel.loadLayerConfig()
            viewModel.refreshAssetsState()
            refreshGenerateButton()
            refreshWorkerToggleUi()
        }
    }

    private fun refreshWorkerToggleUi() {
        val isAudioOn = viewModel.audioEnabled()
        val isImageOn = viewModel.imageEnabled
        val isVideoOn = viewModel.videoEnabled()

        // Audio: now toggleable
        binding.workerAudioLayout.isChecked = isAudioOn
        binding.workerAudioLayout.setChipIconResource(
            if (isAudioOn) R.drawable.ic_volume_up else R.drawable.ic_volume_off
        )

        // Image: ON = storyboard/image_only profile, OFF = audio-only
        binding.workerImageLayout.isChecked = isImageOn
        binding.workerImageLayout.setChipIconResource(
            if (isImageOn) R.drawable.ic_image else R.drawable.ic_image_off
        )

        // Video: ON = full profile (requires image), OFF = storyboard or less
        binding.workerVideoLayout.isChecked = isVideoOn
        binding.workerVideoLayout.setChipIconResource(
            if (isVideoOn) R.drawable.ic_videocam else R.drawable.ic_videocam_off
        )
    }

    private fun refreshGenerateButton() {
        val bookId = viewModel.bookId
        val isRegenerating = viewModel.isRegenerating.value
        val genBtn = binding.toolbarGenerateButton

        genBtn.visibility = View.VISIBLE

        if (isRegenerating) {
            genBtn.text = getString(R.string.toolbar_generate_cancel)
            genBtn.backgroundTintList = ColorStateList.valueOf(getColor(R.color.cinema_primary))
            genBtn.isEnabled = true
            genBtn.alpha = 1f
        } else {
            genBtn.text = getString(R.string.toolbar_generate_idle)
            genBtn.backgroundTintList = ColorStateList.valueOf(getColor(R.color.cinema_accent))
            val canGenerate = bookId.isNotBlank()
            genBtn.isEnabled = canGenerate
            genBtn.alpha = if (bookId.isBlank()) 0.3f else 1f
        }
    }

    private fun onGenerateClicked() {
        val bookId = viewModel.bookId
        if (bookId.isBlank()) {
            Toast.makeText(this, R.string.file_status_opening, Toast.LENGTH_SHORT).show()
            return
        }

        val profile = viewModel.currentProfile()
        val currentPos = SharedPositionManager.current.value
        val hasChapter = !currentPos.chapterId.isNullOrBlank()
        val hasScene = !currentPos.sceneId.isNullOrBlank()

        val dialogBinding = DialogGenerateScopeBinding.inflate(layoutInflater)
        dialogBinding.dialogSubtitle.text = getString(
            R.string.generate_dialog_subtitle,
            getString(profileLabel(profile))
        )
        dialogBinding.scopeCurrentScene.isEnabled = hasScene
        dialogBinding.scopeCurrentChapter.isEnabled = hasChapter
        dialogBinding.scopeWholeBook.isChecked = true

        AlertDialog.Builder(this)
            .setTitle(R.string.generate_dialog_title)
            .setView(dialogBinding.root)
            .setNegativeButton(R.string.dialog_cancel, null)
            .setPositiveButton(R.string.dialog_start) { _, _ ->
                val scope: String
                val chId: String?
                val scId: String?
                when (dialogBinding.scopeGroup.checkedRadioButtonId) {
                    R.id.scopeCurrentScene -> {
                        scope = "current_scene"
                        chId = SharedPositionManager.current.value.chapterId
                        scId = SharedPositionManager.current.value.sceneId
                    }
                    R.id.scopeCurrentChapter -> {
                        scope = "current_chapter"
                        chId = SharedPositionManager.current.value.chapterId
                        scId = null
                    }
                    else -> {
                        scope = "whole_book"
                        chId = null
                        scId = null
                    }
                }
                startGenerationWithProfile(profile, scope, chId, scId)
            }
            .show()
    }

    private fun startGenerationWithProfile(
        profile: String,
        scope: String,
        chapterId: String?,
        sceneId: String?
    ) {
        viewModel.startGeneration(
            GenerateViewModel.GenerationRequest(
                profile = profile,
                scope = scope,
                chapterId = chapterId,
                sceneId = sceneId
            )
        ) { result ->
            when (result) {
                is GenerateViewModel.GenerationResult.Started -> {
                    refreshGenerateButton()
                }
                is GenerateViewModel.GenerationResult.Failed -> {
                    val msg = getString(R.string.generate_start_failed, result.message)
                    Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
                    refreshGenerateButton()
                }
            }
        }
    }

    private fun profileLabel(profile: String): Int = when (profile) {
        "audio_only" -> R.string.profile_audio
        "image_only" -> R.string.profile_storyboard
        "storyboard" -> R.string.profile_storyboard
        else -> R.string.profile_video
    }

    private suspend fun startGenerationProgressPoller() {
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

        while (true) {
            val bookId = viewModel.bookId
            if (bookId.isBlank()) {
                binding.generationProgressContainer.visibility = View.GONE
                lastReadyCount = -1
                delay(1_500)
                continue
            }

            val activeGen = viewModel.activeGeneration.value
            val uiState = viewModel.uiState.value
            val vbookProg = uiState.vbookProgress
            val hasVBook = vbookProg != null && vbookProg.stage != VBookStage.IDLE
            val hasActiveWork = activeGen != null || hasVBook

            if (!hasActiveWork) {
                val panelState = viewModel.computeWorkers(null, vbookProg, labels)
                if (panelState is ProgressPanelState.DoneRow || panelState is ProgressPanelState.Workers) {
                    applyPanelState(panelState)
                    delay(1_500)
                    continue
                }
                if (panelState is ProgressPanelState.Hidden && binding.generationProgressContainer.visibility != View.GONE) {
                    binding.generationProgressContainer.visibility = View.GONE
                }
                val agentProg = viewModel.checkVBookAgentStatus()
                if (agentProg.stage != VBookStage.IDLE) {
                    if (!_lastHasVBook) {
                        viewModel.resetWorkerState()
                        viewModel.startProgressStream(bookId)
                        _lastHasVBook = true
                    }
                    val ps = viewModel.computeWorkers(null, agentProg, labels)
                    applyPanelState(ps)
                    delay(1_500)
                    continue
                }
                if (binding.generationProgressContainer.visibility != View.GONE) {
                    binding.generationProgressContainer.visibility = View.GONE
                }
                _lastActiveGeneration = null
                _lastHasVBook = false
                lastReadyCount = -1
                delay(1_500)
                continue
            }

            // ── Detect new work start ─────────────────────────
            if ((activeGen != null && (_lastActiveGeneration == null || _lastActiveGeneration != activeGen)) ||
                (hasVBook && !_lastHasVBook)) {
                Log.i("MainActivity", "New work detected (gen=${activeGen != null} vbook=$hasVBook) — resetting")
                viewModel.resetWorkerState()
                lastReadyCount = -1
                if (activeGen != null || hasVBook) {
                    viewModel.startProgressStream(bookId)
                }
            }
            _lastActiveGeneration = activeGen
            _lastHasVBook = hasVBook

            // ── Poll progress panel (if GPU gen active) or just show VBook ──
            if (activeGen != null) {
                try {
                    val panel = viewModel.repository.getProgressPanel(
                        bookId = bookId,
                        scope = activeGen.scope,
                        chapterId = activeGen.chapterId,
                        sceneId = activeGen.sceneId
                    )
                    val panelState = viewModel.computeWorkers(panel, if (hasVBook) vbookProg else null, labels)
                    applyPanelState(panelState)

                    // Detect stuck progress (only when panel shows workers).
                    // Primary completion signal comes from the server-pushed
                    // generation_complete SSE event. This is a short emergency
                    // fallback (30s) for rare cases where the SSE event is lost
                    // due to connection drop.
                    if (panelState is ProgressPanelState.Workers) {
                        val progressTotal = panel.overall_percent
                        val anyLayerIncomplete = panel.any_incomplete
                        if (progressTotal != lastReadyCount) {
                            lastReadyCount = progressTotal
                            lastReadyChangeAt = System.currentTimeMillis()
                        } else if (!lastPollFailed && anyLayerIncomplete && System.currentTimeMillis() - lastReadyChangeAt > STUCK_FALLBACK_MS) {
                            val backendActive = runCatching {
                                val counts = RetrofitClient.api.getWorkerCounts()
                                counts.active_scenes > 0
                            }.getOrDefault(false)
                            if (!backendActive) {
                                Log.i("MainActivity", "Fallback stuck detection — auto-completing")
                                viewModel.stopProgressStream()
                                viewModel.applyGenerationResults()
                                refreshGenerateButton()
                                binding.generationProgressContainer.visibility = View.GONE
                                lastReadyCount = -1
                            }
                        }
                    }

                    lastPollFailed = false
                    pollerBackoffMs = 1_500L
                } catch (e: Exception) {
                    Log.w("MainActivity", "GPU progress poll failed: ${e.message}")
                    lastPollFailed = true
                    pollerBackoffMs = (pollerBackoffMs * 2).coerceAtMost(6_000L)
                    if (hasVBook) {
                        val ps = viewModel.computeWorkers(null, vbookProg, labels)
                        applyPanelState(ps)
                    }
                }
            } else if (hasVBook) {
                val updated = viewModel.checkVBookAgentStatus()
                val vbookToShow = if (updated.stage != VBookStage.IDLE) updated else vbookProg
                val ps = viewModel.computeWorkers(null, vbookToShow, labels)
                applyPanelState(ps)
            }

            delay(pollerBackoffMs)
        }
    }

    private var lastReadyCount = -1
    private var lastReadyChangeAt = 0L

    /** Set to true when getAssetsState throws, to suppress stuck-detection */
    private var lastPollFailed = false

    /** Exponential backoff for poller errors (1.5s → 3s → 6s cap), reset on success */
    private var pollerBackoffMs = 1_500L

    /** Emergency fallback: if server-pushed generation_complete is lost (30s). */
    private val STUCK_FALLBACK_MS = 30_000L

    // Detect new-generation transitions so we can clear completion tracking.
    private var _lastActiveGeneration: GenerateViewModel.ActiveGeneration? = null

    // Track VBook presence transitions
    private var _lastHasVBook = false

    /**
     * Apply the panel state computed by [GenerateViewModel.computeWorkers].
     * Handles rendering workers, showing the done row, or hiding the panel.
     */
    private fun applyPanelState(state: ProgressPanelState) {
        when (state) {
            is ProgressPanelState.Workers -> {
                binding.generationProgressContainer.visibility = View.VISIBLE
                binding.generationDoneRow.visibility = View.GONE
                binding.generationTimerRow.visibility = View.GONE  // timer показан в каждой строке worker
                binding.workerProgressList.visibility = View.VISIBLE
                renderWorkers(state.workers)
            }
            is ProgressPanelState.DoneRow -> {
                binding.generationProgressContainer.visibility = View.VISIBLE
                binding.generationTimerRow.visibility = View.VISIBLE  // показываем финальное время
                binding.workerProgressList.visibility = View.GONE
                binding.generationDoneRow.visibility = View.VISIBLE
            }
            is ProgressPanelState.Hidden -> {
                binding.generationProgressContainer.visibility = View.GONE
                binding.generationTimerRow.visibility = View.GONE
            }
        }
    }

    /**
     * Render worker rows into the progress panel.
     * Pure rendering — data already computed by [GenerateViewModel].
     */
    private fun renderWorkers(workers: List<WorkerUi>) {
        val container = binding.workerProgressList
        val greenColor = getColor(R.color.cinema_success)
        val accentColor = getColor(R.color.cinema_accent)
        val textColor = getColor(R.color.cinema_text_secondary)
        val mutedColor = getColor(R.color.cinema_text_disabled)

        val childCount = container.childCount
        val maxIdx = childCount.coerceAtLeast(workers.size)

        for (i in 0 until maxIdx) {
            if (i >= workers.size) {
                container.getChildAt(i).visibility = View.GONE
                continue
            }

            val worker = workers[i]
            val row: View = if (i < childCount) {
                container.getChildAt(i)
            } else {
                layoutInflater.inflate(R.layout.item_worker_progress, container, false).also {
                    container.addView(it)
                }
            }
            row.visibility = View.VISIBLE

            val nameView = row.findViewById<TextView>(R.id.workerName)
            val countView = row.findViewById<TextView>(R.id.workerCount)
            val pctView = row.findViewById<TextView>(R.id.workerPercent)
            val barView = row.findViewById<com.google.android.material.progressindicator.LinearProgressIndicator>(R.id.workerProgressBar)

            val timerView = row.findViewById<TextView>(R.id.workerTimer)
            val currentSec = viewModel.timerStartedAt.let { start ->
                if (start > 0L) (System.currentTimeMillis() - start) / 1000L else 0L
            }
            val timerText = formatTimerText(currentSec)

            if (worker.indeterminate) {
                // Cyclic/indeterminate progress — no count, no percentage
                nameView.text = worker.label
                nameView.setTextColor(textColor)
                countView.text = ""
                countView.visibility = View.GONE
                pctView.text = ""
                pctView.visibility = View.GONE
                timerView?.text = timerText
                timerView?.visibility = View.VISIBLE
                barView.isIndeterminate = true
                barView.setIndicatorColor(accentColor)
            } else if (worker.done) {
                nameView.text = getString(R.string.generation_done) + " — " + worker.label
                nameView.setTextColor(greenColor)
                countView.text = worker.countText ?: "${worker.ready}/${worker.total}"
                countView.setTextColor(greenColor)
                countView.visibility = View.VISIBLE
                pctView.text = "100%"
                pctView.setTextColor(greenColor)
                pctView.visibility = View.VISIBLE
                timerView?.text = timerText
                timerView?.visibility = View.VISIBLE
                barView.isIndeterminate = false
                barView.setProgressCompat(100, true)
                barView.setIndicatorColor(greenColor)
            } else {
                nameView.text = worker.label
                nameView.setTextColor(textColor)
                countView.text = worker.countText ?: "${worker.ready}/${worker.total}"
                countView.setTextColor(mutedColor)
                countView.visibility = View.VISIBLE
                pctView.text = "${worker.percent}%"
                pctView.setTextColor(accentColor)
                pctView.visibility = View.VISIBLE
                timerView?.text = timerText
                timerView?.visibility = View.VISIBLE
                barView.isIndeterminate = false
                barView.setProgressCompat(worker.percent, true)
                barView.setIndicatorColor(accentColor)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleVBookIntent(intent)
    }

    /**
     * Handles incoming VIEW intents from .vbook file associations.
     * Copies the file from the content URI, validates it, and loads it
     * into the ViewModel.
     */
    private fun handleVBookIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW || intent.data == null) return

        val uri = intent.data!!
        val displayName = getFileName(uri)
        val mimeType = intent.type ?: contentResolver.getType(uri)
        Log.i("MainActivity", "VIEW intent: uri=$uri type=$mimeType name=$displayName categories=${intent.categories}")

        lifecycleScope.launch {
            try {
                val tempFile = File(cacheDir, "opened-${System.currentTimeMillis()}")

                contentResolver.openInputStream(uri)?.use { input ->
                    tempFile.outputStream().use { output ->
                        input.copyTo(output)
                    }
                } ?: run {
                    Toast.makeText(this@MainActivity, R.string.upload_failed, Toast.LENGTH_SHORT).show()
                    return@launch
                }

                viewModel.importBookFromFile(tempFile)
                switchToPlayTab()
            } catch (e: Exception) {
                Log.w("MainActivity", "Failed to open .vbook from intent: ${e.message}")
                Toast.makeText(this@MainActivity, "${getString(R.string.upload_failed)}: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun getFileName(uri: android.net.Uri): String? {
        val cursor = contentResolver.query(uri, null, null, null, null)
        return cursor?.use {
            if (it.moveToFirst()) {
                val idx = it.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) it.getString(idx) else null
            } else {
                null
            }
        }
    }

    private fun formatTimerText(sec: Long): String {
        val hh = (sec / 3600).toInt()
        val mm = ((sec % 3600) / 60).toInt()
        val ss = (sec % 60).toInt()
        return String.format("%02d:%02d:%02d", hh, mm, ss)
    }

    companion object {
        private const val PREFS_NAME = "animastor_settings"
        private const val PREFS_THEME = "theme"
        private const val PREFS_LANG = "language"
        private const val LANG_AUTO = "auto"
        private const val LANG_EN = "en"
        private const val LANG_RU = "ru"
        private const val THEME_AUTO = "auto"
        private const val THEME_DARK = "dark"
        private const val THEME_LIGHT = "light"
    }
}
