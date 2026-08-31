package com.example.animastor.ui

import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.lifecycleScope
import com.example.animastor.R
import com.example.animastor.databinding.FragmentVbookSettingsBinding
import com.example.animastor.repository.LayerConfigUpdate
import kotlinx.coroutines.launch

/**
 * VBook generation settings: chunk size (scenes per pass) + AI Analysis Mode
 * (sequential vs parallel) + Max Parallel Tasks (web parity f661a922 —
 * SettingsPage VBookSection).
 *
 * Accepts no arguments — reads chunk_size / analysis_mode /
 * analysis_parallelism from layer-config (single round-trip, no new endpoint).
 * Opened from GenerateFragment's VBook gear icon button.
 *
 * Instant apply (web parity): the selection IS the save, no Apply button.
 * The partial PUT contract means existing fields are preserved — each
 * change sends only the field the user touched.
 */
class VBookSettingsFragment : Fragment(R.layout.fragment_vbook_settings) {

    private var binding: FragmentVbookSettingsBinding? = null
    private val viewModel: GenerateViewModel by activityViewModels {
        GenerateViewModel.factory
    }

    companion object {
        /** Default chunk size (scenes per pass). */
        const val DEFAULT_CHUNK_SIZE = 3

        /** Default AI analysis mode (legacy behaviour until opted in). */
        const val DEFAULT_ANALYSIS_MODE = "sequential"

        /** Default max parallel tasks (concurrency limit, not agent count). */
        const val DEFAULT_ANALYSIS_PARALLELISM = 3
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentVbookSettingsBinding.bind(view)
        val b = binding ?: return

        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        // ── Instant apply (web parity): the selection IS the save, no Apply
        // button. The flag suppresses the synthetic onItemSelected fired by the
        // load's setSelection; it flips only AFTER the load settles so opening
        // the screen never writes the just-loaded value back to the server.
        var initialized = false
        b.chunkSizeSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, v: View?, position: Int, id: Long) {
                if (!initialized) return
                val selectedValue = (b.chunkSizeSpinner.selectedItem as? Int) ?: DEFAULT_CHUNK_SIZE
                lifecycleScope.launch {
                    try {
                        val bookId = viewModel.bookId
                        if (bookId.isBlank()) return@launch
                        viewModel.repository.putLayerConfig(bookId, LayerConfigUpdate(chunk_size = selectedValue))
                    } catch (e: Exception) {
                        // Stay on screen so the user sees the selection; retry on next change
                    }
                }
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }

        // ── Max parallel tasks (1..8) — instant apply, parallel mode only ──
        b.analysisParallelismSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, v: View?, position: Int, id: Long) {
                if (!initialized) return
                val selectedValue = (b.analysisParallelismSpinner.selectedItem as? Int)
                    ?: DEFAULT_ANALYSIS_PARALLELISM
                viewModel.setAnalysisParallelism(selectedValue.coerceIn(1, 8))
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }

        // ── AI Analysis Mode — segmented control (project .seg__btn pattern) ──
        val selectMode: (String) -> Unit = { mode ->
            b.analysisModeSequentialButton.isSelected = mode == "sequential"
            b.analysisModeParallelButton.isSelected = mode == "parallel"
            // Max Parallel Tasks row is soft-disabled unless parallel is selected
            // (web .card__row--disabled parity: opacity 0.55).
            b.analysisParallelismRow.alpha = if (mode == "parallel") 1f else 0.55f
            b.analysisParallelismSpinner.isEnabled = mode == "parallel"
            b.analysisParallelismDefaultButton.isEnabled = mode == "parallel"
        }
        b.analysisModeSequentialButton.setOnClickListener {
            selectMode("sequential")
            viewModel.setAnalysisMode("sequential")
        }
        b.analysisModeParallelButton.setOnClickListener {
            selectMode("parallel")
            viewModel.setAnalysisMode("parallel")
        }

        // ── Default buttons ──
        b.chunkSizeDefaultButton.setOnClickListener {
            b.chunkSizeSpinner.setSelection(DEFAULT_CHUNK_SIZE - 1)
        }
        b.analysisParallelismDefaultButton.setOnClickListener {
            b.analysisParallelismSpinner.setSelection(DEFAULT_ANALYSIS_PARALLELISM - 1)
        }

        // ── Load current config from layer-config (single round-trip) ──
        lifecycleScope.launch {
            try {
                val bookId = viewModel.bookId
                if (bookId.isBlank()) return@launch

                val cfg = viewModel.repository.getLayerConfig(bookId)
                val currentChunk = cfg.chunk_size.coerceIn(1, 5)
                // analysis_mode defaults to sequential — backend authoritative.
                // Any other value (undefined / future mode) maps to sequential,
                // matching the backend _clampAnalysisMode behaviour.
                val currentMode = analysisModeFromWire(cfg.analysis_mode)
                val currentParallelism = (cfg.analysis_parallelism ?: DEFAULT_ANALYSIS_PARALLELISM)
                    .coerceIn(1, 8)

                // Setup scenes-per-pass dropdown (1..5)
                val chunkOptions = (1..5).toList()
                val chunkAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, chunkOptions)
                chunkAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.chunkSizeSpinner.adapter = chunkAdapter
                b.chunkSizeSpinner.setSelection((currentChunk - 1).coerceIn(0, 4))

                // Setup max-parallel-tasks dropdown (1..8)
                val parOptions = (1..8).toList()
                val parAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, parOptions)
                parAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.analysisParallelismSpinner.adapter = parAdapter
                b.analysisParallelismSpinner.setSelection((currentParallelism - 1).coerceIn(0, 7))

                selectMode(currentMode)
            } catch (e: Exception) {
                // On error, default to 3 / sequential
                val chunkAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, (1..5).toList())
                chunkAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.chunkSizeSpinner.adapter = chunkAdapter
                b.chunkSizeSpinner.setSelection(DEFAULT_CHUNK_SIZE - 1)

                val parAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, (1..8).toList())
                parAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.analysisParallelismSpinner.adapter = parAdapter
                b.analysisParallelismSpinner.setSelection(DEFAULT_ANALYSIS_PARALLELISM - 1)

                selectMode(DEFAULT_ANALYSIS_MODE)
            } finally {
                initialized = true // load settled — user changes now persist
            }
        }
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }
}
