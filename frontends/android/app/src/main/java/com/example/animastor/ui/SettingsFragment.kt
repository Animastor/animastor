package com.example.animastor.ui

import android.content.Context
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

        // Instant apply (web parity): the selection IS the confirmation. Theme and
        // language persist + recreate immediately, so there is no Apply button.
        // The flag suppresses the synthetic onItemSelected fired by setSelection.
        var initialized = false
        view.post { initialized = true }
        b.themeSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, v: View?, position: Int, id: Long) {
                if (!initialized) return
                val selected = themeValues[position]
                if (selected != currentTheme) {
                    prefs.edit().putString(PREFS_THEME, selected).apply()
                    // Post: recreate after the dropdown window finishes tearing down
                    view.post { requireActivity().recreate() }
                }
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }
        b.languageSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, v: View?, position: Int, id: Long) {
                if (!initialized) return
                val selected = langValues[position]
                if (selected != currentLang) {
                    prefs.edit().putString(PREFS_LANG, selected).apply()
                    // Post: recreate after the dropdown window finishes tearing down
                    view.post { requireActivity().recreate() }
                }
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }

        b.serverUrlInput.setText(BuildConfig.BASE_URL)
        b.debugInfo.text = "App: ${BuildConfig.VERSION_NAME}\nServer: ${BuildConfig.BASE_URL}"

        // ── Generation settings nav rows (web parity) — the same settings as
        // the Generator gear icons, but here the user picks the section. The
        // VBook row opens the VBook screen; the Worker row opens the unified
        // content screen with the Audio section first (the private gears on
        // Generator pre-select their own section instead). ──
        b.vbookSettingsButton.setOnClickListener {
            val fragment = VBookSettingsFragment()
            parentFragmentManager.beginTransaction()
                .add(R.id.nav_host_container, fragment, "VBookSettingsFragment")
                .addToBackStack(null)
                .commit()
        }
        b.workerSettingsButton.setOnClickListener {
            val fragment = WorkerSettingsFragment.newInstance("audio")
            parentFragmentManager.beginTransaction()
                .add(R.id.nav_host_container, fragment, "WorkerSettingsFragment")
                .addToBackStack(null)
                .commit()
        }
        // Experimental Beta (web parity: /settings/private-workers and
        // /settings/ai nav rows) — private worker management and the
        // workspace AI provider configuration.
        b.privateWorkersButton.setOnClickListener {
            val fragment = PrivateWorkersFragment()
            parentFragmentManager.beginTransaction()
                .add(R.id.nav_host_container, fragment, "PrivateWorkersFragment")
                .addToBackStack(null)
                .commit()
        }
        b.aiProviderButton.setOnClickListener {
            val fragment = AiProviderSettingsFragment()
            parentFragmentManager.beginTransaction()
                .add(R.id.nav_host_container, fragment, "AiProviderSettingsFragment")
                .addToBackStack(null)
                .commit()
        }
        // Local AI Connector V1 (web parity: /settings/local-ai) — local LLM
        // runtime binding via the outbound connector.
        b.localAiButton.setOnClickListener {
            val fragment = LocalAiSettingsFragment()
            parentFragmentManager.beginTransaction()
                .add(R.id.nav_host_container, fragment, "LocalAiSettingsFragment")
                .addToBackStack(null)
                .commit()
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

            AppDialogs.action(
                ctx = requireContext(),
                title = getString(R.string.settings_cache_clear),
                content = cacheBinding.root,
                cancelText = getString(R.string.dialog_cancel),
                actionText = getString(android.R.string.ok),
            ) { dlg ->
                dlg.dismiss()
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
                        viewModel.resetProgressState()
                    }.onSuccess {
                        Toast.makeText(requireContext(), R.string.settings_cache_cleared, Toast.LENGTH_SHORT).show()
                    }.onFailure { e ->
                        Toast.makeText(requireContext(), "Error: ${e.message}", Toast.LENGTH_LONG).show()
                    }
                }
            }.show()
        }

        b.deleteVbookButton.setOnClickListener {
            if (viewModel.bookId.isBlank()) {
                Toast.makeText(requireContext(), "No book open", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            val inflater = LayoutInflater.from(requireContext())
            val dialogBinding = DialogDeleteVbookBinding.inflate(inflater)
            dialogBinding.dialogMessage.text = getString(R.string.settings_delete_vbook_confirm)

            AppDialogs.action(
                ctx = requireContext(),
                title = getString(R.string.settings_delete_vbook),
                content = dialogBinding.root,
                cancelText = getString(R.string.dialog_cancel),
                actionText = getString(android.R.string.ok),
            ) { dlg ->
                dlg.dismiss()
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
            }.show()
        }

        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
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
