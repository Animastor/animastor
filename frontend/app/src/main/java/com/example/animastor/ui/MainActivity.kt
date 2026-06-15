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
        setupGenerationProgressClick()
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

    private fun setupGenerationProgressClick() {
        // Tap on progress area switches to the next active worker immediately
        binding.generationProgressContainer.setOnClickListener {
            if (activeWorkerList.size > 1) {
                workerRotationIndex = (workerRotationIndex + 1) % activeWorkerList.size
                lastWorkerRotationAt = System.currentTimeMillis()
            }
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
                try {
                    val assets = viewModel.repository.getAssetsState(
                        bookId = bookId,
                        scope = activeGen.scope,
                        chapterId = activeGen.chapterId,
                        sceneId = activeGen.sceneId
                    )
                    showGpuProgress(assets)

                    // Detect stuck progress: if ready count hasn't changed for >15s
                    // AND no worker leases are active, auto-complete.
                    val profileKey = viewModel.currentProfile()
                    val currentReady = when (profileKey) {
                        "audio_only" -> assets.scope_audio_ready
                        else -> assets.scope_image_ready
                    }
                    if (currentReady != lastReadyCount) {
                        lastReadyCount = currentReady
                        lastReadyChangeAt = System.currentTimeMillis()
                    } else if (currentReady < assets.scope_total && System.currentTimeMillis() - lastReadyChangeAt > 15_000) {
                        // Check if any workers are active
                        val idle = runCatching {
                            val counts = RetrofitClient.api.getWorkerCounts()
                            counts.active_audio + counts.active_image + counts.active_video == 0
                        }.getOrDefault(true)
                        if (idle) {
                            Log.i("MainActivity", "Progress stuck at $currentReady/${assets.scope_total} with idle workers — auto-completing")
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
                lastReadyCount = -1
            }
            delay(1_500)
        }
    }

    private var gpuProgressDoneAt = 0L
    private var lastReadyCount = -1
    private var lastReadyChangeAt = 0L

    // ── Worker rotation state ─────────────────────────────────

    private data class WorkerInfo(
        val type: String,          // "audio", "image", "video"
        val labelResId: Int,
        val ready: Int,
        val total: Int,
        val percent: Int,
        val useIu: Boolean = false  // use IU counts (more granular) for image
    )

    private var workerRotationIndex = 0
    private var lastWorkerRotationAt = 0L
    private var activeWorkerList: List<WorkerInfo> = emptyList()
    private val WORKER_ROTATION_INTERVAL = 5_000L

    /**
     * Compute which workers are still active (have pending work) for the current profile.
     * Completed workers (ready >= total) are excluded from rotation.
     */
    private fun getActiveWorkers(assets: com.example.animastor.repository.AssetsStateResponse): List<WorkerInfo> {
        val profile = viewModel.currentProfile()
        val workers = mutableListOf<WorkerInfo>()
        val total = assets.scope_total

        // Cover: active if cover IU images are still generating.
        // Cover runs first and in parallel with scene generation, so it gets
        // a slot in rotation to avoid hiding the other workers while cover is busy.
        val coverTotal = assets.cover_iu_total
        if (coverTotal > 0) {
            val coverReady = assets.cover_iu_ready
            if (coverReady < coverTotal) {
                workers.add(WorkerInfo(
                    type = "cover",
                    labelResId = R.string.progress_cover_generating,
                    ready = coverReady,
                    total = coverTotal,
                    percent = (coverReady * 100 / coverTotal).coerceIn(0, 99),
                    useIu = true  // cover counts are image units, not scenes
                ))
            }
        }

        if (total <= 0) return workers

        // Audio: active if needed by profile AND has pending scenes
        val audioNeeded = profile == "audio_only" || profile == "storyboard" || profile == "full"
        if (audioNeeded && assets.scope_audio_ready < total) {
            workers.add(WorkerInfo(
                type = "audio",
                labelResId = R.string.progress_label_audio,
                ready = assets.scope_audio_ready,
                total = total,
                percent = (assets.scope_audio_ready * 100 / total).coerceIn(0, 99)
            ))
        }

        // Image: active if needed by profile AND has pending scenes
        val imageNeeded = profile == "image_only" || profile == "storyboard" || profile == "full"
        if (imageNeeded && assets.scope_image_ready < total) {
            // Use IU counts when available (more granular)
            val useIu = assets.scope_iu_total > 0
            val imgReady = if (useIu) assets.scope_iu_ready else assets.scope_image_ready
            val imgTotal = if (useIu) assets.scope_iu_total else total
            workers.add(WorkerInfo(
                type = "image",
                labelResId = R.string.progress_label_image,
                ready = imgReady,
                total = imgTotal,
                percent = (imgReady * 100 / imgTotal).coerceIn(0, 99),
                useIu = useIu
            ))
        }

        // Video: active only in "full" profile AND has pending scenes
        if (profile == "full" && assets.scope_video_ready < total) {
            workers.add(WorkerInfo(
                type = "video",
                labelResId = R.string.progress_label_video,
                ready = assets.scope_video_ready,
                total = total,
                percent = (assets.scope_video_ready * 100 / total).coerceIn(0, 99)
            ))
        }

        return workers
    }

    private fun showGpuProgress(assets: com.example.animastor.repository.AssetsStateResponse) {
        val total = assets.scope_total

        if (total <= 0) {
            binding.generationProgressContainer.visibility = View.GONE
            gpuProgressDoneAt = 0L
            return
        }

        // Compute active workers (ones that still have pending work)
        activeWorkerList = getActiveWorkers(assets)

        if (activeWorkerList.isEmpty()) {
            // All workers are done — show "Done" for 5 seconds
            if (gpuProgressDoneAt == 0L) {
                gpuProgressDoneAt = System.currentTimeMillis()
            }
            val elapsed = System.currentTimeMillis() - gpuProgressDoneAt
            if (elapsed < 10000) {
                binding.generationProgressContainer.visibility = View.VISIBLE
                binding.generationProgressBar.isIndeterminate = false
                binding.generationProgressBar.setProgressCompat(100, true)
                val greenColor = getColor(R.color.cinema_success)
                binding.generationProgressLabel.setTextColor(greenColor)
                binding.generationProgressLabel.text = getString(R.string.generation_done)
                binding.generationProgressPercent.setTextColor(greenColor)
                binding.generationProgressPercent.text = "100%"
            } else {
                binding.generationProgressContainer.visibility = View.GONE
                viewModel.onGenerationComplete()
                refreshGenerateButton()
            }
            return
        }

        // Auto-rotation: advance index every WORKER_ROTATION_INTERVAL
        val now = System.currentTimeMillis()
        if (now - lastWorkerRotationAt > WORKER_ROTATION_INTERVAL) {
            workerRotationIndex = (workerRotationIndex + 1) % activeWorkerList.size
            lastWorkerRotationAt = now
        }

        // Ensure index is in bounds (list may have shrunk since last rotation)
        val idx = workerRotationIndex.coerceIn(0, activeWorkerList.size - 1)
        val worker = activeWorkerList[idx]

        // Still in progress — reset done timer and show rotating worker
        gpuProgressDoneAt = 0L
        // Reset text color back to normal (it may have been set to green in "Done" state)
        binding.generationProgressLabel.setTextColor(getColor(R.color.cinema_text_secondary))
        binding.generationProgressPercent.setTextColor(getColor(R.color.cinema_text_secondary))
        binding.generationProgressContainer.visibility = View.VISIBLE
        binding.generationProgressBar.isIndeterminate = false
        binding.generationProgressBar.setProgressCompat(worker.percent, true)

        val formatRes = if (worker.useIu) R.string.progress_format_iu else R.string.progress_format
        binding.generationProgressLabel.text = getString(
            formatRes,
            getString(worker.labelResId),
            worker.ready,
            worker.total
        )
        binding.generationProgressPercent.text = "${worker.percent}%"
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
