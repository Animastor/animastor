package com.example.animastor.ui

import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import com.example.animastor.BuildConfig
import com.example.animastor.R
import com.example.animastor.databinding.FragmentSettingsBinding

class SettingsFragment : Fragment(R.layout.fragment_settings) {

    private var binding: FragmentSettingsBinding? = null
    private val viewModel: GenerateViewModel by activityViewModels {
        GenerateViewModel.factory
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

            AlertDialog.Builder(requireContext())
                .setTitle(R.string.settings_cache_clear)
                .setMessage(R.string.settings_cache_clear_confirm)
                .setPositiveButton(android.R.string.ok) { _, _ ->
                    viewModel.clearBookCache()
                    Toast.makeText(requireContext(), R.string.settings_cache_cleared, Toast.LENGTH_SHORT).show()
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }

        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
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
