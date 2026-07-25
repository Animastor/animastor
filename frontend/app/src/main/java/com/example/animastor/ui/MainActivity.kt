package com.example.animastor.ui

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.animation.ObjectAnimator
import android.content.res.ColorStateList
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import com.example.animastor.R
import com.example.animastor.databinding.ActivityMainBinding
import com.example.animastor.ui.GenerationStatus
import com.example.animastor.ui.VBookStage

import java.io.File
import java.util.Calendar
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var isBottomNavHidden = false
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

    fun switchToGenerateTab() {
        binding.bottomNavigation.selectedItemId = R.id.generateFragment
    }

    fun switchToAiTab(createMode: Boolean = false) {
        if (createMode) {
            supportFragmentManager.findFragmentByTag("AiAssistantFragment")?.let {
                supportFragmentManager.beginTransaction().remove(it).commitNow()
            }
        }
        // Open as standalone fragment (toolbar button, not bottom nav)
        val current = supportFragmentManager.findFragmentByTag("AiAssistantFragment")
        if (current != null && current.isVisible) return
        supportFragmentManager.beginTransaction()
            .add(R.id.nav_host_container, AiAssistantFragment.newInstance(createMode = createMode), "AiAssistantFragment")
            .addToBackStack(null)
            .commit()
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

        // Handle incoming intent from .vbook file association
        handleVBookIntent(intent)

        binding.settingsButton.setOnClickListener {
            supportFragmentManager.beginTransaction()
                .add(R.id.nav_host_container, SettingsFragment(), "SettingsFragment")
                .addToBackStack(null)
                .commit()
        }

        setupPlaybackCoordination()

        // Periodically refresh assets state + load layer config on book change
        lifecycleScope.launch {
            var prevBookId = ""
            while (true) {
                val bId = viewModel.bookId
                if (bId != prevBookId) {
                    prevBookId = bId
                    if (bId.isNotBlank()) {
                        viewModel.loadLayerConfig()
                    }
                }
                if (bId.isNotBlank()) {
                    viewModel.refreshAssetsState()
                }
                delay(5_000)
            }
        }

        binding.toolbarAiButton.setOnClickListener {
            switchToAiTab()
        }

        // ── Observe generation status (bottom nav icon indicator) ──
        lifecycleScope.launch {
            viewModel.generationStatus.collectLatest { status ->
                updateNavIconStatus(status)
            }
        }
        findGenerateIconView()

        binding.bottomNavigation.setOnItemSelectedListener { item ->
            val tag = when (item.itemId) {
                R.id.fileFragment -> "FileFragment"
                R.id.editFragment -> "EditFragment"
                R.id.playFragment -> "PlayFragment"
                R.id.navigateFragment -> "NavigateFragment"
                R.id.generateFragment -> "GenerateFragment"
                else -> return@setOnItemSelectedListener true
            }

            // Reset generation status → IDLE only when ALL generation processes
            // have completed. Check both GPU generation (activeGeneration) and
            // VBook agent (vbookProgress stage). If anything is still running,
            // the nav icon keeps pulsing — even if one process errored.
            if (item.itemId == R.id.generateFragment) {
                val hasActiveWork = viewModel.activeGeneration.value != null ||
                    viewModel.uiState.value.vbookProgress?.stage?.let {
                        it != VBookStage.IDLE && it != VBookStage.COMPLETED
                    } == true
                if (!hasActiveWork) {
                    viewModel.resetGenerationStatus()
                }
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
                    R.id.generateFragment -> GenerateFragment()
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

    // ═══════════════════════════════════════════════════════════════
    //  GENERATION STATUS → BOTTOM NAV INDICATOR
    // ═══════════════════════════════════════════════════════════════

    private var generateIconView: ImageView? = null
    private var navPulseAnimator: ObjectAnimator? = null
    private var autoResetJob: kotlinx.coroutines.Job? = null

    /**
     * Find the generate item's ImageView inside the BottomNavigationView.
     * Recursively searches the item view hierarchy because Material Components
     * nests the ImageView inside a FrameLayout container (not a direct child).
     * Called once after the bottom nav is laid out.
     */
    private fun findGenerateIconView() {
        binding.bottomNavigation.post {
            val menuView = binding.bottomNavigation.getChildAt(0) as? ViewGroup ?: return@post
            var generateIdx = -1
            for (i in 0 until binding.bottomNavigation.menu.size()) {
                if (binding.bottomNavigation.menu.getItem(i).itemId == R.id.generateFragment) {
                    generateIdx = i; break
                }
            }
            if (generateIdx < 0 || generateIdx >= menuView.childCount) return@post
            val itemView = menuView.getChildAt(generateIdx) as? ViewGroup ?: return@post
            // Recursively search for ImageView (it's nested in icon container)
            generateIconView = findImageViewDeep(itemView)
            if (generateIconView != null) {
                // Reapply current status after layout
                val currentStatus = viewModel.generationStatus.value
                updateNavIconStatus(currentStatus)
                // Listen for layout changes to reapply tint AND pulse
                // (Material Components re-layouts items on tab switch, which
                //  would otherwise lose our custom tint and pulse animator.)
                generateIconView!!.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
                    val status = viewModel.generationStatus.value
                    if (status != GenerationStatus.IDLE) {
                        // Re-run full status update so both tint AND pulse are restored
                        generateIconView = v as ImageView
                        updateNavIconStatus(status)
                    }
                }
            }
        }
    }

    /**
     * Recursively search a [ViewGroup] for the first [ImageView] descendant.
     * Material Components BottomNavigationView nests the icon ImageView inside
     * container FrameLayouts, so a single-level child scan misses it.
     */
    private fun findImageViewDeep(viewGroup: ViewGroup): ImageView? {
        for (i in 0 until viewGroup.childCount) {
            val child = viewGroup.getChildAt(i)
            if (child is ImageView) return child
            if (child is ViewGroup) {
                val found = findImageViewDeep(child)
                if (found != null) return found
            }
        }
        return null
    }

    private fun updateNavIconStatus(status: GenerationStatus) {
        navPulseAnimator?.cancel()
        navPulseAnimator = null
        autoResetJob?.cancel()
        autoResetJob = null

        // Restore normal alpha on the icon view
        generateIconView?.alpha = 1f

        // Keep itemIconTint at its normal state list — the generate icon
        // gets its custom tint directly via imageTintList on the ImageView.
        binding.bottomNavigation.itemIconTintList = ContextCompat.getColorStateList(this, R.color.bottom_nav_tint)
        binding.bottomNavigation.itemTextColor = ContextCompat.getColorStateList(this, R.color.bottom_nav_tint)

        if (status == GenerationStatus.IDLE) {
            // Restore normal bottom nav tint (selected = gold, unselected = gray).
            // Setting null would show the raw black drawable color.
            generateIconView?.imageTintList = ContextCompat.getColorStateList(this, R.color.bottom_nav_tint)
            return
        }

        val color = when (status) {
            GenerationStatus.RUNNING -> getColor(R.color.cinema_accent)
            GenerationStatus.ERROR -> getColor(R.color.cinema_error)
            GenerationStatus.SUCCESS -> getColor(R.color.cinema_success)
            else -> return
        }

        generateIconView?.imageTintList = ColorStateList.valueOf(color)

        val iconView = generateIconView ?: return
        when (status) {
            GenerationStatus.RUNNING -> {
                navPulseAnimator = ObjectAnimator.ofFloat(iconView, "alpha", 1f, 0.35f, 1f).apply {
                    duration = 1600
                    repeatCount = ObjectAnimator.INFINITE
                    start()
                }
            }
            GenerationStatus.ERROR -> {
                navPulseAnimator = ObjectAnimator.ofFloat(iconView, "alpha", 1f, 0.4f, 1f).apply {
                    duration = 1200
                    repeatCount = ObjectAnimator.INFINITE
                    start()
                }
            }
            GenerationStatus.SUCCESS -> {
                // Pulse green for ~12s, then 10s solid green, then auto-IDLE
                navPulseAnimator = ObjectAnimator.ofFloat(iconView, "alpha", 1f, 0.45f, 1f).apply {
                    duration = 1500
                    repeatCount = 7 // 8 cycles × 1.5s = 12s
                    start()
                }
                // Auto-reset: wait for pulse to finish (12s) + 10s hold → IDLE
                autoResetJob = lifecycleScope.launch {
                    delay(1500L * 8 + 10_000L)
                    viewModel.resetGenerationStatus()
                }
            }
            else -> {}
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
