package com.example.animastor.ui

import android.content.ComponentCallbacks2
import android.content.Context
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
     * Cover image updates are handled via a separate [GenerateViewModel.coverUpdated]
     * flow to avoid [PlaybackViewModel.preparePlayback] being called multiple times
     * (which would reset the player phase and disrupt playback).
     */
    private fun setupPlaybackCoordination() {
        // Primary channel: playback preparation (chunks, positions, initial cover)
        lifecycleScope.launch {
            viewModel.playbackPrepared.collect { prep ->
                Log.i("MainActivity", "playbackPrepared: book=${prep.bookId} chunks=${prep.chunkIds.size} cover=${prep.coverImage != null} soft=${prep.softRefresh}")
                if (prep.softRefresh) {
                    // Regeneration completed while player may be active — use
                    // soft refresh that preserves the current phase/position.
                    playbackViewModel.refreshContent(
                        bookId = prep.bookId,
                        buildId = prep.buildId,
                        chunkIds = prep.chunkIds,
                        chunkPositions = prep.chunkPositions
                    )
                } else {
                    // Initial load or new book — full reset to SCENE_READY.
                    playbackViewModel.preparePlayback(
                        bookId = prep.bookId,
                        buildId = prep.buildId,
                        chunkIds = prep.chunkIds,
                        chunkPositions = prep.chunkPositions
                    )
                }
                if (prep.coverImage != null) {
                    playbackViewModel.setCoverImage(prep.coverImage)
                }
            }
        }
        // Separate channel: cover image becomes available after generation completes.
        // Updates only the cover — does NOT call preparePlayback, so the player phase
        // (e.g. SCENE_READY or PLAYING) is preserved.
        lifecycleScope.launch {
            viewModel.coverUpdated.collect { bitmap ->
                Log.i("MainActivity", "coverUpdated: cover image now available (size=${bitmap.width}x${bitmap.height})")
                playbackViewModel.setCoverImage(bitmap)
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
        while (true) {
            val bookId = viewModel.bookId
            if (bookId.isBlank()) {
                binding.generationProgressContainer.visibility = View.GONE
                lastReadyCount = -1
                delay(1_500)
                continue
            }

            val activeGen = viewModel.activeGeneration.value

            if (activeGen != null) {
                // ── Detect new generation start ─────────────────────────
                // Clear completion-tracking maps so a fresh generation shows
                // real progress instead of being immediately hidden by stale
                // "permanently done" entries.
                if (_lastActiveGeneration == null || _lastActiveGeneration != activeGen) {
                    Log.i("MainActivity", "New generation detected (scope=${activeGen.scope}) — resetting completion tracking")
                    workerCompletedAt.clear()
                    _workerPermanentlyDone.clear()
                    _coverEverIncomplete = false
                    gpuProgressDoneAt = 0L
                    lastReadyCount = -1
                }
                _lastActiveGeneration = activeGen

                try {
                    val assets = viewModel.repository.getAssetsState(
                        bookId = bookId,
                        scope = activeGen.scope,
                        chapterId = activeGen.chapterId,
                        sceneId = activeGen.sceneId
                    )
                    showGpuProgress(assets)

                    // Detect stuck progress: if no ready count has changed for >120s
                    // AND the backend reports no active scenes, auto-complete.
                    // Using active_scenes (backend's source of truth) instead of
                    // worker idle states to avoid false triggers between job transitions.
                    val progressTotal = when (viewModel.currentProfile()) {
                        "audio_only" -> assets.scope_audio_ready
                        "image_only" -> assets.scope_image_ready
                        "video_only" -> assets.scope_video_ready
                        else -> minOf(assets.scope_audio_ready, assets.scope_image_ready, assets.scope_video_ready)
                    }
                    val anyLayerIncomplete =
                        assets.scope_audio_ready < assets.scope_total ||
                        assets.scope_image_ready < assets.scope_total ||
                        assets.scope_video_ready < assets.scope_total
                    if (progressTotal != lastReadyCount) {
                        lastReadyCount = progressTotal
                        lastReadyChangeAt = System.currentTimeMillis()
                    } else if (anyLayerIncomplete && System.currentTimeMillis() - lastReadyChangeAt > 120_000) {
                        val backendActive = runCatching {
                            val counts = RetrofitClient.api.getWorkerCounts()
                            counts.active_scenes > 0
                        }.getOrDefault(true)
                        if (!backendActive) {
                            Log.i("MainActivity", "Progress stuck at a=$assets.scope_audio_ready i=$assets.scope_image_ready v=$assets.scope_video_ready / total=$assets.scope_total with no active scenes — auto-completing")
                            viewModel.onGenerationComplete()
                            refreshGenerateButton()
                            binding.generationProgressContainer.visibility = View.GONE
                            lastReadyCount = -1
                        }
                    }
                } catch (e: Exception) {
                    Log.w("MainActivity", "GPU progress poll failed: ${e.message}")
                }
            } else {
                if (binding.generationProgressContainer.visibility != View.GONE) {
                    binding.generationProgressContainer.visibility = View.GONE
                }
                _lastActiveGeneration = null
                lastReadyCount = -1
            }
            delay(1_500)
        }
    }

    private var gpuProgressDoneAt = 0L
    private var lastReadyCount = -1
    private var lastReadyChangeAt = 0L

    // ── Progress state ───────────────────────────────────────

    private val COMPLETED_WORKER_DISPLAY_MS = 10_000L

    // Track when each worker type completed (to show green "Done" for 10s)
    private val workerCompletedAt = mutableMapOf<String, Long>()

    /**
     * Tracks workers that have already been shown as "Done" for the full 10s
     * and then hidden. Once a worker enters this set, [showGpuProgress] will
     * never re-add it — even if the backend still reports ready == total.
     *
     * Cleared together with [workerCompletedAt] when a new generation starts.
     */
    private val _workerPermanentlyDone = mutableSetOf<String>()

    // Detect new-generation transitions so we can clear completion tracking.
    private var _lastActiveGeneration: GenerateViewModel.ActiveGeneration? = null

    // Tracks whether cover was ever incomplete (actively being generated)
    // during the current generation session. If cover was already ready from
    // the start, we skip the row entirely — no fake "Done" display.
    private var _coverEverIncomplete = false

    /**
     * Render progress of all active workers simultaneously — no rotation.
     * Each worker gets its own row (name + count + percent + progress bar).
     * Completed workers auto-hide after 10s.
     */
    private fun showGpuProgress(assets: com.example.animastor.repository.AssetsStateResponse) {
        val total = assets.scope_total
        val profile = viewModel.currentProfile()
        val now = System.currentTimeMillis()

        if (total <= 0 && assets.cover_iu_total <= 0) {
            binding.generationProgressContainer.visibility = View.GONE
            gpuProgressDoneAt = 0L
            return
        }

        // ── Build worker list ──
        data class Wrk(
            val type: String,
            val label: String,
            val ready: Int,
            val total: Int,
            val percent: Int,
            val done: Boolean
        )

        val workers = mutableListOf<Wrk>()

        fun add(type: String, label: String, ready: Int, total: Int) {
            if (total <= 0) return
            // Once a worker has been shown as Done for the full 10s and hidden,
            // never re-add it — even if the backend still reports ready == total.
            if (type in _workerPermanentlyDone) return
            val done = ready >= total && ready > 0
            if (done) {
                // Record completion time once
                if (!workerCompletedAt.containsKey(type)) {
                    workerCompletedAt[type] = now
                }
                // Auto-hide after COMPLETED_WORKER_DISPLAY_MS (10s)
                val completedAt = workerCompletedAt[type] ?: now
                if (now - completedAt >= COMPLETED_WORKER_DISPLAY_MS) {
                    // Timeout expired — permanently hide this worker so it
                    // never re-appears on subsequent polls.
                    _workerPermanentlyDone.add(type)
                    workerCompletedAt.remove(type)
                    return
                }
            }
            val pct = if (done) 100 else (ready * 100 / total).coerceIn(0, 99)
            workers.add(Wrk(type, label, ready, total, pct, done))
        }

        // Cover (uses IU counts) — only show when cover is actually being generated
        // or just completed during this session. If cover was already ready from the
        // start, skip entirely — no fake "Done" row for work that never happened.
        if (assets.cover_iu_total > 0) {
            if (assets.cover_iu_ready < assets.cover_iu_total) {
                _coverEverIncomplete = true
                add("cover", getString(R.string.progress_cover_generating), assets.cover_iu_ready, assets.cover_iu_total)
            } else if (_coverEverIncomplete) {
                // Cover just completed — show "Done" for standard duration
                add("cover", getString(R.string.progress_cover_generating), assets.cover_iu_ready, assets.cover_iu_total)
            }
            // If cover was already ready and never incomplete this session: skip entirely
        }

        if (total > 0) {
            val audioNeeded = profile == "audio_only" || profile == "storyboard" || profile == "full"
            if (audioNeeded) {
                add("audio", getString(R.string.progress_label_audio), assets.scope_audio_ready, total)
            }

            val imageNeeded = profile == "image_only" || profile == "storyboard" || profile == "full"
            if (imageNeeded) {
                val useIu = assets.scope_iu_total > 0
                add("image", getString(R.string.progress_label_image),
                    if (useIu) assets.scope_iu_ready else assets.scope_image_ready,
                    if (useIu) assets.scope_iu_total else total)
            }

            if (profile == "full" || profile == "video_only") {
                add("video", getString(R.string.progress_label_video), assets.scope_video_ready, total)
            }
        }

        // ── Recently completed workers that aren't re-added by add() ──
        // (This handles the case where the asset state no longer reports
        // this worker (e.g. scope changed), but we still want to show
        // green "Done" for 10s.)
        val activeTypes = workers.map { it.type }.toSet()
        val staleTypes = mutableListOf<String>()
        for ((type, completedAt) in workerCompletedAt) {
            if (type in _workerPermanentlyDone) continue
            if (now - completedAt >= COMPLETED_WORKER_DISPLAY_MS) {
                // Move to permanent-done set so it never re-appears.
                staleTypes.add(type)
                _workerPermanentlyDone.add(type)
                continue
            }
            if (type in activeTypes) continue // already added by add() above
            val label = when (type) {
                "cover" -> getString(R.string.progress_cover_generating)
                "audio" -> getString(R.string.progress_label_audio)
                "image" -> getString(R.string.progress_label_image)
                "video" -> getString(R.string.progress_label_video)
                else -> getString(R.string.generation_done)
            }
            workers.add(Wrk(type, label, 100, 100, 100, done = true))
        }
        staleTypes.forEach { workerCompletedAt.remove(it) }

        // ── Render ──
        val container = binding.workerProgressList
        val doneRow = binding.generationDoneRow

        if (workers.isEmpty()) {
            // All done — show single green row for 10s
            if (gpuProgressDoneAt == 0L) gpuProgressDoneAt = now
            val elapsed = now - gpuProgressDoneAt
            if (elapsed < COMPLETED_WORKER_DISPLAY_MS) {
                binding.generationProgressContainer.visibility = View.VISIBLE
                container.visibility = View.GONE
                doneRow.visibility = View.VISIBLE
            } else {
                binding.generationProgressContainer.visibility = View.GONE
                // Full completion — clear tracking so next generation starts fresh
                workerCompletedAt.clear()
                _workerPermanentlyDone.clear()
                viewModel.onGenerationComplete()
                refreshGenerateButton()
                gpuProgressDoneAt = 0L
            }
            return
        }

        gpuProgressDoneAt = 0L
        binding.generationProgressContainer.visibility = View.VISIBLE
        doneRow.visibility = View.GONE
        container.visibility = View.VISIBLE

        val greenColor = getColor(R.color.cinema_success)
        val accentColor = getColor(R.color.cinema_accent)
        val textColor = getColor(R.color.cinema_text_secondary)
        val mutedColor = getColor(R.color.cinema_text_disabled)

        // Recycle existing rows, create new ones as needed, hide extras
        val childCount = container.childCount
        val maxIdx = childCount.coerceAtLeast(workers.size)

        for (i in 0 until maxIdx) {
            if (i >= workers.size) {
                // Hide surplus rows
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

            if (worker.done) {
                nameView.text = getString(R.string.generation_done) + " — " + worker.label
                nameView.setTextColor(greenColor)
                countView.text = "${worker.ready}/${worker.total}"
                countView.setTextColor(greenColor)
                pctView.text = "100%"
                pctView.setTextColor(greenColor)
                barView.setProgressCompat(100, true)
                barView.setIndicatorColor(greenColor)
            } else {
                nameView.text = worker.label
                nameView.setTextColor(textColor)
                countView.text = "${worker.ready}/${worker.total}"
                countView.setTextColor(mutedColor)
                pctView.text = "${worker.percent}%"
                pctView.setTextColor(accentColor)
                barView.setProgressCompat(worker.percent, true)
                barView.setIndicatorColor(accentColor)
            }
        }
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
