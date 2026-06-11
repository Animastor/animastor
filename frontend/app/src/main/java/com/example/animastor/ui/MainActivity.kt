package com.example.animastor.ui

import android.app.AlertDialog
import android.content.Context
import android.os.Bundle
import android.animation.ObjectAnimator
import android.util.Log
import android.view.View
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.chip.Chip
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
        val sysLang = android.content.res.Configuration(newBase.resources.configuration).locale.language
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

    // --- REMOVE: This was duplicated ---
    // private fun applyTheme() { ... }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= TRIM_MEMORY_MODERATE) {
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
            chip.alpha = if (isFromDisk) 0.45f else 1f
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
        val hasChapter = !viewModel.currentChapterId.isNullOrBlank()
        val hasScene = !viewModel.currentSceneId.isNullOrBlank()

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
                        chId = viewModel.currentChapterId
                        scId = viewModel.currentSceneId
                    }
                    R.id.scopeCurrentChapter -> {
                        scope = "current_chapter"
                        chId = viewModel.currentChapterId
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
            val activeGen = viewModel.activeGeneration.value
            val bookId = viewModel.bookId
            if (activeGen == null || bookId.isBlank()) {
                binding.generationProgressContainer.visibility = View.GONE
                delay(1_500)
                continue
            }
            try {
                val assets = viewModel.repository.getAssetsState(
                    bookId = bookId,
                    scope = activeGen.scope,
                    chapterId = activeGen.chapterId,
                    sceneId = activeGen.sceneId
                )
                refreshGenerationProgressBar(assets)
            } catch (e: Exception) {
                Log.w("Gen", "progress poll failed: ${e.message}")
            }
            delay(1_500)
        }
    }

    private fun refreshGenerationProgressBar(
        assets: com.example.animastor.repository.AssetsStateResponse
    ) {
        val total = assets.scope_total
        if (total <= 0) {
            binding.generationProgressContainer.visibility = View.GONE
            return
        }
        binding.generationProgressContainer.visibility = View.VISIBLE

        val profileKey = viewModel.currentProfile()
        val (label, ready) = when (profileKey) {
            "audio_only" -> R.string.progress_label_audio to assets.scope_audio_ready
            "storyboard" -> R.string.progress_label_image to assets.scope_image_ready
            else -> R.string.progress_label_video to assets.scope_video_ready
        }
        val progress = if (total > 0) ((ready.toFloat() / total.toFloat()) * 100).toInt().coerceIn(0, 100) else 0
        binding.generationProgressBar.setProgressCompat(progress, true)
        binding.generationProgressLabel.text = getString(R.string.progress_format, getString(label), ready, total)
        binding.generationProgressPercent.text = "${progress}%"

        if (ready >= total) {
            binding.generationProgressContainer.visibility = View.GONE
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
