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
 * VBook generation settings: chunk size (scenes per pass).
 *
 * Accepts no arguments — reads chunk_size from layer-config.
 * Opened from GenerateFragment's VBook gear icon button.
 */
class VBookSettingsFragment : Fragment(R.layout.fragment_vbook_settings) {

    private var binding: FragmentVbookSettingsBinding? = null
    private val viewModel: GenerateViewModel by activityViewModels {
        GenerateViewModel.factory
    }

    companion object {
        /** Default chunk size (scenes per pass). */
        const val DEFAULT_CHUNK_SIZE = 3
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentVbookSettingsBinding.bind(view)
        val b = binding ?: return

        b.toolbar.setNavigationOnClickListener {
            parentFragmentManager.popBackStack()
        }

        // ── Load current chunk_size from layer-config ──
        lifecycleScope.launch {
            try {
                val bookId = viewModel.bookId
                if (bookId.isBlank()) return@launch

                val cfg = viewModel.repository.getLayerConfig(bookId)
                val currentChunk = cfg.chunk_size.coerceIn(1, 5)

                // Setup scenes-per-pass dropdown (1..5)
                val options = (1..5).toList()
                val adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, options)
                adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.chunkSizeSpinner.adapter = adapter
                b.chunkSizeSpinner.setSelection((currentChunk - 1).coerceIn(0, 4))
            } catch (e: Exception) {
                // On error, default to 3
                val options = (1..5).toList()
                val adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, options)
                adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                b.chunkSizeSpinner.adapter = adapter
                b.chunkSizeSpinner.setSelection(DEFAULT_CHUNK_SIZE - 1)
            }
        }

        // ── Default button: reset chunk size to 3 ──
        b.chunkSizeDefaultButton.setOnClickListener {
            b.chunkSizeSpinner.setSelection(DEFAULT_CHUNK_SIZE - 1)
        }

        // ── Apply button: save and close ──
        b.applyButton.setOnClickListener {
            lifecycleScope.launch {
                try {
                    val bookId = viewModel.bookId
                    if (bookId.isBlank()) return@launch

                    val selectedValue = (b.chunkSizeSpinner.selectedItem as? Int) ?: DEFAULT_CHUNK_SIZE
                    viewModel.repository.putLayerConfig(bookId, LayerConfigUpdate(
                        chunk_size = selectedValue
                    ))
                    parentFragmentManager.popBackStack()
                } catch (e: Exception) {
                    // Keep fragment open on error so user can retry
                }
            }
        }
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }
}
