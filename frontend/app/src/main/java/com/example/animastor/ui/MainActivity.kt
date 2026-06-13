package com.example.animastor.ui

import android.content.ComponentCallbacks2
import android.content.res.Configuration
import android.content.Context
import android.os.Bundle
import android.animation.ObjectAnimator
import android.util.Log
import android.view.View
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.chip.Chip
import com.google.android.material.dialog.MaterialAlertDialogBuilder
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
                    val isGenerating = phase == PlayerPhase.GENERATING || phase == PlayerPhase.LOADING_BOOK
                    val isFromDisk = phase == PlayerPhase.DOWNLOADING || phase == PlayerPhase.SCENE_READY || phase == PlayerPhase.PLAYING

                    val audioNeeded = mode == "need_audio_worker" || mode == "storyboard" || mode == "full"
                    val imageNeeded = mode == "need_image_worker" || mode == "storyboard" || mode == "full"
                    val videoNeeded = mode == "full"

                    updateWorkerPanel(
                        chip = binding.workerAudioLayout,
                        count = binding.workerAudioCount,
                        total = counts.audio,
                        active = counts.active_audio,
                        isGenerating = isGenerating,
                        isNeeded = audioNeeded,
                        isFromDisk = isFromDisk,
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
                        isFromDisk = isFromDisk,
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
                        isFromDisk = isFromDisk,
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

        // Observe window generation status updates
        lifecycleScope.launch {
            playbackViewModel.windowGenStatus.collect { status ->
                Log.d("MainActivity", "windowGenStatus: active=${status.active} msg=\"${status.progressMsg}\" window=${status.windowIndex}")
            }
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
     */
    private fun setupPlaybackCoordination() {
        lifecycleScope.launch {
            viewModel.playbackPrepared.collect { prep ->
                Log.i("MainActivity", "playbackPrepared: book=${prep.bookId} chunks=${prep.chunkIds.size}")
                playbackViewModel.preparePlayback(
                    bookId = prep.bookId,
                    buildId = prep.buildId,
                    chunkIds = prep.chunkIds,
                    chunkPositions = prep.chunkPositions
                )
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
        isFromDisk: Boolean,
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
            tint = activeColor
            chip.alpha = 1f
            val pulse = ObjectAnimator.ofFloat(chip, "alpha", 1f, 0.4f, 1f)
            pulse.duration = 1600
            pulse.repeatCount = ObjectAnimator.INFINITE
            pulse.start()
            pulseAnimators[chip] = pulse
        } else {
            tint = normalColor
            chip.alpha = if (isFromDisk) 0.45f else 1f
        }
        chip.setChipIconTint(android.content.res.ColorStateList.valueOf(tint))
    }

    // -------------------------------------------------------------------
    // Phase C — Worker toggles as profile selector
    // -------------------------------------------------------------------

    private fun setupWorkerToggles() {
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
        val isImageOn = viewModel.imageEnabled
        val isVideoOn = viewModel.videoEnabled()

        // Audio: always ON (base layer, non-clickable in XML)
        binding.workerAudioLayout.isChecked = true
        binding.workerAudioLayout.setChipIconResource(R.drawable.ic_volume_up)

        // Image: ON = storyboard profile, OFF = audio-only
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
            // During generation: show Cancel button
            genBtn.text = getString(R.string.toolbar_generate_cancel)
            genBtn.isEnabled = true
            genBtn.alpha = 1f
        } else {
            genBtn.text = getString(R.string.toolbar_generate_idle)
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

        val dialogTheme = if ((resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES)
            R.style.ThemeOverlay_Animastor_Dialog_Alert
        else
            R.style.ThemeOverlay_Animastor_Dialog_Alert_Light
        MaterialAlertDialogBuilder(this, dialogTheme)
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
        "storyboard" -> R.string.profile_storyboard
        else -> R.string.profile_video
    }

    private suspend fun startGenerationProgressPoller() {
        while (true) {
            val bookId = viewModel.bookId
            if (bookId.isBlank()) {
                binding.generationProgressContainer.visibility = View.GONE
                delay(1_500)
                continue
            }

            val now = System.currentTimeMillis()
            val activeGen = viewModel.activeGeneration.value
            val windowGenStatus = playbackViewModel.windowGenStatus.value

            // 1. GPU generation progress has priority (only when user clicked Generate)
            var showedGpu = false
            if (activeGen != null) {
                try {
                    val assets = viewModel.repository.getAssetsState(
                        bookId = bookId,
                        scope = activeGen.scope,
                        chapterId = activeGen.chapterId,
                        sceneId = activeGen.sceneId
                    )
                    showGpuProgress(assets)
                    showedGpu = true
                } catch (e: Exception) {
                    Log.w("MainActivity", "GPU progress poll failed: ${e.message}")
                }
            }

            if (showedGpu) {
                delay(1_500)
                continue
            }

            // 2. Window (text analysis) generation — active, in progress, or lingering after completion
            val windowGenActive = windowGenStatus.active || windowGenStatus.inProgress
            val windowGenLingering = windowGenStatus.completedLingerMs > 0 && now < windowGenStatus.completedLingerMs

            if (windowGenActive || windowGenLingering) {
                showWindowGenProgress(windowGenStatus)
                if (windowGenLingering) {
                    val lingerRemaining = (windowGenStatus.completedLingerMs - now) / 1000
                    Log.d("MainActivity", "[WINDOW-GEN] lingering for ${lingerRemaining}s: \"${windowGenStatus.progressMsg}\"")
                }
            } else if (windowGenStatus.completedLingerMs > 0 && now >= windowGenStatus.completedLingerMs) {
                // Linger expired — clear the status and hide the bar
                Log.i("MainActivity", "[WINDOW-GEN] linger expired — hiding")
                playbackViewModel.clearWindowGenStatus()
                binding.generationProgressContainer.visibility = View.GONE
            } else {
                if (binding.generationProgressContainer.visibility != View.GONE) {
                    Log.d("MainActivity", "[WINDOW-GEN] no window gen activity — hiding")
                }
                binding.generationProgressContainer.visibility = View.GONE
            }
            delay(1_500)
        }
    }

    private var gpuProgressDoneAt = 0L

    private fun showGpuProgress(assets: com.example.animastor.repository.AssetsStateResponse) {
        val total = assets.scope_total
        if (total <= 0) {
            binding.generationProgressContainer.visibility = View.GONE
            gpuProgressDoneAt = 0L
            return
        }

        val profileKey = viewModel.currentProfile()
        // For "full" profile, show the most advanced layer (audio → image → video)
        val (label, ready) = if (profileKey == "full") {
            when {
                assets.scope_video_ready > 0 -> R.string.progress_label_video to assets.scope_video_ready
                assets.scope_image_ready > 0 -> R.string.progress_label_image to assets.scope_image_ready
                else -> R.string.progress_label_audio to assets.scope_audio_ready
            }
        } else when (profileKey) {
            "audio_only" -> R.string.progress_label_audio to assets.scope_audio_ready
            "storyboard" -> R.string.progress_label_image to assets.scope_image_ready
            else -> R.string.progress_label_video to assets.scope_video_ready
        }

        if (ready >= total) {
            // First time hitting 100% — save the timestamp
            if (gpuProgressDoneAt == 0L) {
                gpuProgressDoneAt = System.currentTimeMillis()
            }
            val elapsed = System.currentTimeMillis() - gpuProgressDoneAt
            if (elapsed < 5000) {
                // Stay visible for 5 seconds showing 100%
                binding.generationProgressContainer.visibility = View.VISIBLE
                binding.generationProgressBar.isIndeterminate = false
                binding.generationProgressBar.setProgressCompat(100, true)
                binding.generationProgressLabel.text = getString(R.string.generation_done)
                binding.generationProgressPercent.text = "100%"
            } else {
                // 5 seconds passed — hide the bar
                binding.generationProgressContainer.visibility = View.GONE
            }
        } else {
            // Still in progress — reset done timer and show normal progress
            gpuProgressDoneAt = 0L
            binding.generationProgressContainer.visibility = View.VISIBLE
            binding.generationProgressBar.isIndeterminate = false
            val progress = if (total > 0) ((ready.toFloat() / total.toFloat()) * 100).toInt().coerceIn(0, 100) else 0
            binding.generationProgressBar.setProgressCompat(progress, true)
            binding.generationProgressLabel.text = getString(R.string.progress_format, getString(label), ready, total)
            binding.generationProgressPercent.text = "${progress}%"
        }
    }

    private fun showWindowGenProgress(status: PlaybackViewModel.WindowGenStatus) {
        binding.generationProgressContainer.visibility = View.VISIBLE

        val msg = status.progressMsg.ifBlank { "⏳ Обработка..." }
        val windowLabel = if (status.windowIndex >= 0) "Окно ${status.windowIndex + 1}" else ""
        val windowInfo = if (windowLabel.isNotEmpty()) " [$windowLabel]" else ""

        val percent = status.progressPercent
        if (percent >= 0) {
            // Determinate: show percentage and scene counts
            binding.generationProgressBar.isIndeterminate = false
            binding.generationProgressBar.setProgressCompat(percent, true)
            val sceneLabel = if (status.totalScenes > 0) {
                "${status.createdScenes}/${status.totalScenes} сцен"
            } else {
                "${status.createdScenes} сцен"
            }
            binding.generationProgressLabel.text = msg
            binding.generationProgressPercent.text = "${percent}% $sceneLabel"
        } else {
            // Indeterminate: show agent messages as they arrive
            binding.generationProgressBar.isIndeterminate = true
            binding.generationProgressLabel.text = "$msg$windowInfo"
            binding.generationProgressPercent.text = if (status.createdScenes > 0) {
                "${status.createdScenes} сцен"
            } else if (windowLabel.isNotEmpty()) {
                windowLabel
            } else {
                ""
            }
        }

        Log.i("MainActivity", "[WINDOW-GEN] $msg (active=${status.active} pct=${percent}%)")
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
