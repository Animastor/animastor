package com.example.animastor.ui

import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.example.animastor.R
import com.example.animastor.databinding.FragmentFileBinding
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class FileFragment : Fragment(R.layout.fragment_file) {

    private var binding: FragmentFileBinding? = null
    private val viewModel: GenerateViewModel by activityViewModels {
        GenerateViewModel.factory
    }
    // ...
    private var hasSwitchedToPlay = false
    private var hasSwitchedToAi = false
    private var pendingExportBuildId: String? = null
    private var pendingExportBookId: String? = null
    private var pendingExportType = "video"

    private val saveDocumentLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("video/mp4")
    ) { uri ->
        if (uri != null) {
            val bid = pendingExportBuildId ?: return@registerForActivityResult
            val bookId = pendingExportBookId ?: return@registerForActivityResult
            lifecycleScope.launch { doExport(bookId, bid, uri, type = pendingExportType) }
        }
    }

    private val saveBookLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/vnd.animastor.vbook+zip")
    ) { uri ->
        if (uri != null) {
            val bookId = pendingExportBookId ?: return@registerForActivityResult
            lifecycleScope.launch { doExport(bookId, "", uri, type = "book") }
        }
    }

    private val saveStoryboardLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/zip")
    ) { uri ->
        if (uri != null) {
            val bid = pendingExportBuildId ?: return@registerForActivityResult
            val bookId = pendingExportBookId ?: return@registerForActivityResult
            lifecycleScope.launch { doExport(bookId, bid, uri, type = "storyboard") }
        }
    }

    private val saveAudioLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("audio/mpeg")
    ) { uri ->
        if (uri != null) {
            val bid = pendingExportBuildId ?: return@registerForActivityResult
            val bookId = pendingExportBookId ?: return@registerForActivityResult
            lifecycleScope.launch { doExport(bookId, bid, uri, type = "audio") }
        }
    }

    private val openDocumentLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        runCatching {
            val tempFile = File(
                requireContext().cacheDir,
                "import-${System.currentTimeMillis()}"
            )
            requireContext().contentResolver.openInputStream(uri)?.use { input ->
                tempFile.outputStream().use { output -> input.copyTo(output) }
            }

            hasSwitchedToPlay = false
            hasSwitchedToAi = false
            viewModel.importBookFromFile(tempFile)
        }.onFailure {
            Toast.makeText(requireContext(), "${getString(R.string.upload_failed)}: ${it.message}", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        hasSwitchedToPlay = savedInstanceState?.getBoolean("hasSwitchedToPlay", false) ?: false
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding = FragmentFileBinding.bind(view)

        binding?.importCard?.setOnClickListener {
            openDocumentLauncher.launch(arrayOf("*/*"))
        }

        binding?.createCard?.setOnClickListener {
            viewModel.closeBook()
            (requireActivity() as MainActivity).switchToAiTab(createMode = true)
        }

        binding?.libraryCard?.setOnClickListener {
            parentFragmentManager.beginTransaction()
                .hide(this)
                .add(R.id.nav_host_container, LibraryFragment(), "LibraryFragment")
                .addToBackStack(null)
                .commit()
        }

        binding?.downloadBookButton?.setOnClickListener {
            val bookId = viewModel.bookId
            if (bookId.isBlank()) return@setOnClickListener
            pendingExportBookId = bookId
            saveBookLauncher.launch("${bookId}.vbook")
        }

        binding?.downloadStoryboardButton?.setOnClickListener {
            val bookId = viewModel.bookId
            val buildId = viewModel.buildId
            if (bookId.isBlank() || buildId.isBlank()) return@setOnClickListener
            pendingExportBookId = bookId
            pendingExportBuildId = buildId
            pendingExportType = "storyboard"
            saveStoryboardLauncher.launch("${bookId}_storyboard.zip")
        }

        binding?.downloadAudioButton?.setOnClickListener {
            val bookId = viewModel.bookId
            val buildId = viewModel.buildId
            if (bookId.isBlank() || buildId.isBlank()) return@setOnClickListener
            pendingExportBookId = bookId
            pendingExportBuildId = buildId
            pendingExportType = "audio"
            saveAudioLauncher.launch("${bookId}.mp3")
        }

        binding?.downloadVideoButton?.setOnClickListener {
            val bookId = viewModel.bookId
            val buildId = viewModel.buildId
            if (bookId.isBlank() || buildId.isBlank()) return@setOnClickListener
            pendingExportBookId = bookId
            pendingExportBuildId = buildId
            pendingExportType = "video"
            saveDocumentLauncher.launch("${bookId}_final.mp4")
        }

        observeState()
    }

    private fun setMerging(text: String) {
        val b = binding ?: return
        b.statusText.visibility = View.VISIBLE
        b.statusText.text = text
        b.progressBar.visibility = View.VISIBLE
        b.progressBar.isIndeterminate = true
    }

    private fun setProgress(progress: Float) {
        val b = binding ?: return
        b.progressBar.visibility = View.VISIBLE
        b.progressBar.isIndeterminate = false
        b.progressBar.setProgressCompat((progress * 100).toInt(), true)
        b.statusText.text = getString(R.string.export_progress, (progress * 100).toInt())
    }

    private fun setSaved() {
        val b = binding ?: return
        b.statusText.visibility = View.VISIBLE
        b.progressBar.visibility = View.GONE
        b.statusText.text = getString(R.string.export_saved)
    }

    private fun clearStatus() {
        val b = binding ?: return
        b.statusText.visibility = View.GONE
        b.progressBar.visibility = View.GONE
        b.progressBar.isIndeterminate = false
        b.progressBar.progress = 0
    }

    private suspend fun doExport(bookId: String, buildId: String, destUri: Uri, type: String) {
        viewModel.setExporting(true)
        try {
            val tempName = when (type) {
                "video" -> "${bookId}_final.mp4"
                "storyboard" -> "${bookId}_storyboard.zip"
                "audio" -> "${bookId}.mp3"
                else -> "${bookId}.vbook"
            }
            val temp = withContext(Dispatchers.IO) {
                File(requireContext().cacheDir, tempName)
            }
            val statusMsg = when (type) {
                "storyboard" -> getString(R.string.export_preparing_storyboard)
                "audio" -> getString(R.string.export_merging_audio)
                "video" -> getString(R.string.export_merging_video)
                else -> getString(R.string.export_preparing)
            }
            setMerging(statusMsg)

            withContext(Dispatchers.IO) {
                when (type) {
                    "video" -> viewModel.repository.exportBookStream(bookId, buildId, temp) { p ->
                        viewModel.setExportProgress(p)
                    }
                    "storyboard" -> viewModel.repository.downloadStoryboardStream(bookId, buildId, temp) { p ->
                        viewModel.setExportProgress(p)
                    }
                    "audio" -> viewModel.repository.downloadAudioStream(bookId, buildId, temp) { p ->
                        viewModel.setExportProgress(p)
                    }
                    else -> viewModel.repository.downloadBookStream(bookId, temp) { p ->
                        viewModel.setExportProgress(p)
                    }
                }
                val outStream = requireContext().contentResolver.openOutputStream(destUri)
                    ?: throw IOException("Cannot open output file")
                outStream.use { out ->
                    temp.inputStream().use { inp -> inp.copyTo(out) }
                }
            }

            setSaved()
            delay(3000)
            clearStatus()
        } catch (e: Exception) {
            clearStatus()
            Toast.makeText(requireContext(), "${getString(R.string.download_failed)}: ${e.message}", Toast.LENGTH_LONG).show()
        } finally {
            viewModel.setExporting(false)
        }
    }

    private fun observeState() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    viewModel.uiState.collect { state ->
                        val exporting = viewModel.isExporting.value
                        val bookOk = viewModel.bookId.isNotBlank() && viewModel.buildId.isNotBlank()
                        val sceneReady = state.phase == PlayerPhase.SCENE_READY || state.phase == PlayerPhase.PLAYING
                        val enabled = !exporting && bookOk && sceneReady
                        binding?.downloadStoryboardButton?.isEnabled = enabled
                        binding?.downloadAudioButton?.isEnabled = enabled
                        binding?.downloadVideoButton?.isEnabled = enabled
                    }
                }
                launch {
                    viewModel.isExporting.collect { exporting ->
                        binding?.downloadBookButton?.isEnabled = !exporting
                            && viewModel.bookId.isNotBlank()
                        if (exporting) {
                            binding?.downloadStoryboardButton?.isEnabled = false
                            binding?.downloadAudioButton?.isEnabled = false
                            binding?.downloadVideoButton?.isEnabled = false
                            binding?.downloadBookButton?.isEnabled = false
                        }
                    }
                }
                launch {
                    viewModel.exportProgress.collect { progress ->
                        if (viewModel.isExporting.value && progress > 0f) {
                            setProgress(progress)
                        }
                    }
                }
                viewModel.uiState.collect { state ->
                    val b = binding ?: return@collect

                    // After TXT import completes, open Generate screen
                    if (!hasSwitchedToAi && !hasSwitchedToPlay && state.phase == PlayerPhase.SCENE_READY && state.importStage == ImportStage.DONE) {
                        hasSwitchedToPlay = true
                        hasSwitchedToAi = true
                        (requireActivity() as MainActivity).switchToGenerateTab()
                    }

                    // Only auto-switch to Play for non-TXT imports (vbook)
                    if (!hasSwitchedToPlay && !hasSwitchedToAi && viewModel.bookId.isNotBlank() && (state.phase == PlayerPhase.IDLE || state.phase == PlayerPhase.SCENE_READY || state.phase == PlayerPhase.IMPORTING_TXT) && state.errorMessage == null) {
                        hasSwitchedToPlay = true
                        (requireActivity() as MainActivity).switchToPlayTab()
                    }

                    val loading = state.phase == PlayerPhase.LOADING_BOOK
                        || state.phase == PlayerPhase.GENERATING
                        || state.phase == PlayerPhase.DOWNLOADING

                    val importing = state.phase == PlayerPhase.IMPORTING_TXT
                    val hasError = state.errorMessage != null

                    if (hasError) {
                        b.progressBar.visibility = View.GONE
                        b.progressBar.isIndeterminate = false
                        b.progressBar.progress = 0
                        b.statusText.visibility = View.VISIBLE
                        b.statusText.text = state.errorMessage
                    } else if (importing && !viewModel.isExporting.value) {
                        // Show only technical steps (first 4 messages) on File screen
                        val techSteps = state.importProgressMessages.take(4)
                        if (techSteps.isNotEmpty()) {
                            b.progressBar.visibility = View.GONE
                            b.progressBar.isIndeterminate = false
                            b.statusText.visibility = View.VISIBLE
                            b.statusText.text = techSteps.last()
                        } else {
                            b.progressBar.visibility = View.VISIBLE
                            b.progressBar.isIndeterminate = true
                            b.statusText.visibility = View.VISIBLE
                            b.statusText.text = getString(R.string.file_status_opening)
                        }
                    } else if (loading && !viewModel.isExporting.value) {
                        b.progressBar.visibility = View.VISIBLE
                        b.progressBar.isIndeterminate = true
                        b.statusText.visibility = View.VISIBLE
                        b.statusText.text = when (state.phase) {
                            PlayerPhase.LOADING_BOOK -> getString(R.string.file_status_opening)
                            PlayerPhase.GENERATING -> getString(R.string.file_status_generating)
                            PlayerPhase.DOWNLOADING -> getString(R.string.file_status_checking)
                            else -> ""
                        }
                    } else if (!loading && !viewModel.isExporting.value) {
                        b.progressBar.visibility = View.GONE
                        b.progressBar.isIndeterminate = false
                        b.progressBar.progress = 0
                        b.statusText.visibility = View.GONE
                    }
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean("hasSwitchedToPlay", hasSwitchedToPlay)
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }

    private fun getFileName(uri: Uri): String? {
        val cursor = requireContext().contentResolver.query(uri, null, null, null, null)
        return cursor?.use {
            if (it.moveToFirst()) {
                val idx = it.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) it.getString(idx) else null
            } else null
        }
    }
}
