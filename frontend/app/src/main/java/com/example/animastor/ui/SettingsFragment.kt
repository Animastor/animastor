package com.example.animastor.ui

import android.content.Context
import androidx.appcompat.app.AlertDialog
import android.view.LayoutInflater
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.lifecycleScope
import com.example.animastor.BuildConfig
import com.example.animastor.R
import com.example.animastor.databinding.DialogDeleteVbookBinding
import com.example.animastor.databinding.FragmentSettingsBinding
import com.example.animastor.network.RetrofitClient
import kotlinx.coroutines.launch

class SettingsFragment : Fragment(R.layout.fragment_settings) {

    private var binding: FragmentSettingsBinding? = null
    private val viewModel: GenerateViewModel by activityViewModels {
        GenerateViewModel.factory
    }
    private val playbackViewModel: PlaybackViewModel by activityViewModels {
        PlaybackViewModel.factory
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentSettingsBinding.bind(view)
        val b = binding ?: return

        val prefs = requireContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val currentTheme = prefs.getString(PREFS_THEME, THEME_AUTO)
        val currentLang = prefs.getString(PREFS_LANG, LANG_AUTO)

        val themeItems = arrayOf(
            getString(R.string.settings_theme_auto),
            getString(R.string.settings_theme_light),
            getString(R.string.settings_theme_dark)
        )
        val themeValues = arrayOf(THEME_AUTO, THEME_LIGHT, THEME_DARK)
        val themeAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, themeItems)
        themeAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        b.themeSpinner.adapter = themeAdapter
        b.themeSpinner.setSelection(themeValues.indexOf(currentTheme))

        val langItems = arrayOf(
            getString(R.string.settings_language_auto),
            getString(R.string.settings_language_en),
            getString(R.string.settings_language_ru)
        )
        val langValues = arrayOf(LANG_AUTO, LANG_EN, LANG_RU)
        val langAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, langItems)
        langAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        b.languageSpinner.adapter = langAdapter
        b.languageSpinner.setSelection(langValues.indexOf(currentLang))

        b.serverUrlInput.setText(BuildConfig.BASE_URL)
        b.debugInfo.text = "App: ${BuildConfig.VERSION_NAME}\nServer: ${BuildConfig.BASE_URL}"

        // ── Load Prompt Profiles ──
        lifecycleScope.launch {
            try {
                val resp = RetrofitClient.api.getConnectorProfiles()

                // Audio spinner
                val audioOpts = resp.options.audio.ifEmpty { listOf(resp.profiles.audio ?: "qwen-tts") }
                val audioAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, audioOpts)
                audioAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.audioProfileSpinner.adapter = audioAdapter
                val audioIdx = audioOpts.indexOf(resp.profiles.audio).coerceAtLeast(0)
                b.audioProfileSpinner.setSelection(audioIdx)

                // Image spinner
                val imageOpts = resp.options.image.ifEmpty { listOf(resp.profiles.image ?: "qwen-image") }
                val imageAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, imageOpts)
                imageAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.imageProfileSpinner.adapter = imageAdapter
                val imageIdx = imageOpts.indexOf(resp.profiles.image).coerceAtLeast(0)
                b.imageProfileSpinner.setSelection(imageIdx)

                // Video spinner
                val videoOpts = resp.options.video.ifEmpty { listOf(resp.profiles.video ?: "ltx-2.3") }
                val videoAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, videoOpts)
                videoAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.videoProfileSpinner.adapter = videoAdapter
                val videoIdx = videoOpts.indexOf(resp.profiles.video).coerceAtLeast(0)
                b.videoProfileSpinner.setSelection(videoIdx)
            } catch (e: Exception) {
                // Fallback: single-option spinners with defaults
                val fallbackAudio = listOf("qwen-tts")
                val fallbackImage = listOf("qwen-image")
                val fallbackVideo = listOf("ltx-2.3")
                val fAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, fallbackAudio)
                fAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.audioProfileSpinner.adapter = fAdapter
                val fImgAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, fallbackImage)
                fImgAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.imageProfileSpinner.adapter = fImgAdapter
                val fVidAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, fallbackVideo)
                fVidAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.videoProfileSpinner.adapter = fVidAdapter
            }
        }

        b.clearCacheButton.setOnClickListener {
            if (viewModel.bookId.isBlank()) {
                // No book open — just clear local cache
                viewModel.repository.clearCache()
                val cacheDir = requireContext().cacheDir
                var cleared = 0
                cacheDir.listFiles()?.forEach { file ->
                    if (file.name.startsWith("chunk-") || file.name.startsWith("video-") || file.name.startsWith("scene_audio-")) {
                        file.delete()
                        cleared++
                    }
                }
                Toast.makeText(requireContext(), "Cleared $cleared cached files", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            val cacheInflate = LayoutInflater.from(requireContext())
            val cacheBinding = DialogDeleteVbookBinding.inflate(cacheInflate)
            cacheBinding.dialogMessage.text = getString(R.string.settings_cache_clear_confirm)

            AlertDialog.Builder(requireContext())
                .setTitle(R.string.settings_cache_clear)
                .setView(cacheBinding.root)
                .setPositiveButton(android.R.string.ok) { _, _ ->
                    val bookId = viewModel.bookId
                    lifecycleScope.launch {
                        runCatching {
                            // Clear only generated assets (chunks, images, audio, video)
                            // while preserving the book structure (chapters, scenes, source).
                            // This keeps the vBook intact — only the generated
                            // storyboard content is removed.
                            viewModel.repository.clearBookCache(bookId)
                            viewModel.repository.clearCache()
                            // Delete local temp cache files (chunk MP3, video, scene audio)
                            val cacheDir = requireContext().cacheDir
                            cacheDir.listFiles()?.forEach { file ->
                                if (file.name.startsWith("chunk-") || file.name.startsWith("video-") || file.name.startsWith("scene_audio-")) {
                                    file.delete()
                                }
                            }
                            // Clear playback state so the player shows empty state.
                            // Do NOT close the book — the vBook structure is still
                            // intact and the Navigator should keep displaying it.
                            playbackViewModel.closeBook()
                            // Reset any in-progress generation tracking
                            viewModel.resetWorkerState()
                        }.onSuccess {
                            Toast.makeText(requireContext(), R.string.settings_cache_cleared, Toast.LENGTH_SHORT).show()
                        }.onFailure { e ->
                            Toast.makeText(requireContext(), "Error: ${e.message}", Toast.LENGTH_LONG).show()
                        }
                    }
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }

        b.deleteVbookButton.setOnClickListener {
            if (viewModel.bookId.isBlank()) {
                Toast.makeText(requireContext(), "No book open", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            val inflater = LayoutInflater.from(requireContext())
            val dialogBinding = DialogDeleteVbookBinding.inflate(inflater)
            dialogBinding.dialogMessage.text = getString(R.string.settings_delete_vbook_confirm)

            AlertDialog.Builder(requireContext())
                .setTitle(R.string.settings_delete_vbook)
                .setView(dialogBinding.root)
                .setPositiveButton(android.R.string.ok) { _, _ ->
                    val bookId = viewModel.bookId
                    lifecycleScope.launch {
                        runCatching {
                            viewModel.repository.deleteBook(bookId)
                            viewModel.repository.clearCache()
                            // Delete local temp cache files (chunk MP3, video, scene audio)
                            val cacheDir = requireContext().cacheDir
                            cacheDir.listFiles()?.forEach { file ->
                                if (file.name.startsWith("chunk-") || file.name.startsWith("video-") || file.name.startsWith("scene_audio-")) {
                                    file.delete()
                                }
                            }
                            // Clear both ViewModels to prevent stale state from
                            // lingering after book deletion (preloadCache,
                            // chunkQueue, chunkPositions, UI state, etc.)
                            viewModel.closeBook()
                            playbackViewModel.closeBook()
                        }.onSuccess {
                            Toast.makeText(requireContext(), R.string.settings_delete_vbook_done, Toast.LENGTH_SHORT).show()
                        }.onFailure { e ->
                            Toast.makeText(requireContext(), "Error: ${e.message}", Toast.LENGTH_LONG).show()
                        }
                    }
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }

        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        // Open Workflow Manager
        b.workflowManagerButton.setOnClickListener {
            parentFragmentManager.beginTransaction()
                .add(R.id.nav_host_container, WorkflowManagerFragment(), "WorkflowManagerFragment")
                .addToBackStack(null)
                .commit()
        }

        b.acceptButton.setOnClickListener {
            val selectedTheme = themeValues[b.themeSpinner.selectedItemPosition]
            val selectedLang = langValues[b.languageSpinner.selectedItemPosition]
            val changed = selectedTheme != currentTheme || selectedLang != currentLang
            if (changed) {
                prefs.edit()
                    .putString(PREFS_THEME, selectedTheme)
                    .putString(PREFS_LANG, selectedLang)
                    .apply()
                requireActivity().recreate()
            } else {
                parentFragmentManager.popBackStack()
            }
        }
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
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
