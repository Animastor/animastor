package com.example.animastor.ui

import android.animation.ObjectAnimator
import android.graphics.Bitmap
import android.media.MediaPlayer
import android.os.Bundle
import android.util.Log
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.View
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.example.animastor.R
import com.example.animastor.databinding.FragmentPlayBinding
import java.io.File
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Media player fragment.
 *
 * Depends ONLY on [PlaybackViewModel] — completely independent of
 * content generation ([GenerateViewModel]).
 *
 * Requirements:
 * - MP3 audio bytes (or empty/silent placeholders)
 * - IU sequence (images + subtitles per unit)
 * - Network access to download content
 * - A [Repository] instance for caching and fetching
 */
class PlayFragment : Fragment(R.layout.fragment_play) {

    companion object {
        private const val TAG = "PlayFragment"
    }

    private var binding: FragmentPlayBinding? = null
    private val playbackViewModel: PlaybackViewModel by activityViewModels {
        PlaybackViewModel.factory
    }
    private val generateViewModel: GenerateViewModel by activityViewModels {
        GenerateViewModel.factory
    }
    private val repository get() = playbackViewModel.repository

    private var currentPlayer: MediaPlayer? = null
    private var nextPlayer: MediaPlayer? = null
    private var currentFile: File? = null
    private var nextFile: File? = null
    private var currentVideoFile: File? = null
    private var videoPlayer: MediaPlayer? = null
    private var isPaused = false
    private var iuCyclingJob: Job? = null
    private var currentIuSequence: List<IuImageItem>? = null
    private var currentIuIndex = 0
    private var sceneTransitionPending = false
    private var nextChainReady = false
    private var hasDisplayedCover = false
    private var isInCurtainsState = false
    private var pulseAnim: ObjectAnimator? = null
    private var currentVolume = 1.0f
    private var isFullscreen = false
    private var pendingLoad = false
    private var pendingVideoSyncJob: Job? = null

    private fun checkPendingExternalSeek() {
        if (playbackViewModel.pendingExternalSeek != null) {
            if (isHidden) return
            Log.i(TAG, "checkPendingExternalSeek: executing seek to ${playbackViewModel.pendingExternalSeek}")
            stopAll()
            playbackViewModel.executePendingSeek()
        }
    }

    private fun observeExternalNavigation() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                playbackViewModel.uiState.collect { _ ->
                    if (playbackViewModel.pendingExternalSeek != null) {
                        if (isHidden) return@collect
                        Log.i(TAG, "external seek via state")
                        stopAll()
                        playbackViewModel.executePendingSeek()
                    }
                }
            }
        }
    }

    private fun observeManualUnitChange() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                SharedPositionManager.current.collect { pos ->
                    val ius = currentIuSequence
                    val idx = pos.unitIndex
                    if (!ius.isNullOrEmpty() && idx in ius.indices && idx != currentIuIndex) {
                        currentIuIndex = idx
                        showIuImage(ius[idx].bitmap)
                    }
                }
            }
        }
    }

    private fun observePreloadCompletion() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                playbackViewModel.preloadCompleted.collect {
                    if (currentPlayer != null && !nextChainReady && nextPlayer == null) {
                        preloadAheadAudio()
                    }
                }
            }
        }
    }

    private fun showCurtains() {
        if (!isAdded || isInCurtainsState) return
        Log.i(TAG, "showCurtains")
        val b = binding ?: return
        try {
            b.curtainsImage.setImageResource(R.drawable.theater_curtains)
        } catch (e: Exception) {
            Log.e(TAG, "curtains drawable load failed: ${e.message}", e)
        }
        try {
            b.curtainsImage.visibility = View.VISIBLE
            b.curtainsImage.alpha = 1f
            b.coverImage.visibility = View.GONE
            b.resultImage.setImageBitmap(null)
            b.resultImage.visibility = View.GONE
            b.subtitleText.visibility = View.GONE
            isInCurtainsState = true
        } catch (e: Exception) {
            Log.e(TAG, "showCurtains failed: ${e.message}", e)
        }
    }

    private fun startPulse(b: FragmentPlayBinding) {
        stopPulse()
        pulseAnim = ObjectAnimator.ofFloat(b.curtainsImage, "alpha", 1.0f, 0.8f).apply {
            duration = 900
            repeatMode = ObjectAnimator.REVERSE
            repeatCount = ObjectAnimator.INFINITE
            start()
        }
    }

    private fun stopPulse() {
        pulseAnim?.cancel()
        pulseAnim = null
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        try {
            hasDisplayedCover = playbackViewModel.uiState.value.coverImage != null
        } catch (e: Exception) {
            Log.e(TAG, "cover check failed: ${e.message}", e)
            Toast.makeText(requireContext(), "ERR: ${e.message}", Toast.LENGTH_LONG).show()
        }
        Log.i(TAG, "onViewCreated")
        try {
            binding = FragmentPlayBinding.bind(view)
        } catch (e: Exception) {
            Log.e(TAG, "bind failed: ${e.message}", e)
            Toast.makeText(requireContext(), "BIND ERR: ${e.message}", Toast.LENGTH_LONG).show()
            return
        }
        binding?.progressBar?.isIndeterminate = true

        playbackViewModel.clearMissingIu()

        if (playbackViewModel.chunkQueueSize > 0) {
            binding?.playButton?.isEnabled = true
            binding?.playButton?.alpha = 1.0f
        }

        // Auto-initialize if PlaybackViewModel is blank but GenerateViewModel has a book
        if (playbackViewModel.bookId.isBlank() && generateViewModel.bookId.isNotBlank()) {
            Log.i(TAG, "onViewCreated: bookId blank — auto-initializing from GenVM")
            playbackViewModel.ensureInitialized(generateViewModel.bookId, generateViewModel.buildId)
        }

        binding?.playButton?.setOnClickListener {
            val phase = playbackViewModel.uiState.value.phase
            Log.i(TAG, "playButton clicked, phase=$phase isPaused=$isPaused player=$currentPlayer rotate=${playbackViewModel.needsRotationResume}")
            when {
                phase == PlayerPhase.PLAYING && currentPlayer == null -> {
                    Log.i(TAG, "playButton: player was released, restarting")
                    playbackViewModel.resumeFromCurrentScene()
                }
                phase == PlayerPhase.PLAYING && !isPaused -> pausePlayback()
                phase == PlayerPhase.PLAYING && isPaused -> resumePlayback()
                phase == PlayerPhase.SCENE_READY && playbackViewModel.needsRotationResume -> {
                    Log.i(TAG, "playButton: rotation resume from index ${playbackViewModel.currentChunkIndex}")
                    playbackViewModel.resumeFromCurrentScene()
                }
                phase == PlayerPhase.SCENE_READY -> {
                    playbackViewModel.playSceneQueue()
                }
                phase == PlayerPhase.IDLE && playbackViewModel.chunkQueueSize > 0 -> {
                    Log.i(TAG, "playButton: IDLE with ${playbackViewModel.chunkQueueSize} chunks — starting playback")
                    playbackViewModel.playSceneQueue()
                }
                else -> Log.w(TAG, "playButton: no matching action for phase=$phase")
            }
        }

        binding?.layerAudio?.setOnCheckedChangeListener { _, isChecked ->
            currentVolume = if (isChecked) 1.0f else 0.0f
            currentPlayer?.setVolume(currentVolume, currentVolume)
            nextPlayer?.setVolume(currentVolume, currentVolume)
            videoPlayer?.setVolume(currentVolume, currentVolume)
            binding?.layerAudio?.chipIcon = if (isChecked)
                resources.getDrawable(R.drawable.ic_volume_up, null)
            else
                resources.getDrawable(R.drawable.ic_volume_off, null)
        }
        binding?.layerImage?.setOnCheckedChangeListener { _, isChecked ->
            playbackViewModel.setImageEnabled(isChecked)
            binding?.layerImage?.chipIcon = if (isChecked)
                resources.getDrawable(R.drawable.ic_image, null)
            else
                resources.getDrawable(R.drawable.ic_image_off, null)
            updateLayers()
            if (isChecked) {
                val ius = currentIuSequence
                if (!ius.isNullOrEmpty() && currentIuIndex < ius.size) {
                    showIuImage(ius[currentIuIndex].bitmap)
                }
            }
        }
        binding?.layerVideo?.setOnCheckedChangeListener { _, isChecked ->
            binding?.layerVideo?.chipIcon = if (isChecked)
                resources.getDrawable(R.drawable.ic_videocam, null)
            else
                resources.getDrawable(R.drawable.ic_videocam_off, null)
            updateLayers()
        }
        binding?.layerSubtitles?.setOnCheckedChangeListener { _, isChecked ->
            binding?.layerSubtitles?.chipIcon = if (isChecked)
                resources.getDrawable(R.drawable.ic_subtitles, null)
            else
                resources.getDrawable(R.drawable.ic_subtitles_off, null)
            updateSubtitleVisibility()
        }

        binding?.fullscreenButton?.setOnClickListener { toggleFullscreen() }

        binding?.mediaContainer?.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_DOWN && isFullscreen) {
                togglePlay()
            }
            false
        }

        observeState()
        observeExternalNavigation()
        observeManualUnitChange()
        observePreloadCompletion()
        checkPendingExternalSeek()

        if (currentIuSequence == null && currentPlayer != null) {
            currentIuSequence = playbackViewModel.currentIuSequence
        }
        if (currentIuSequence != null && currentPlayer != null) {
            showCurrentIu()
        }
    }

    private fun showCurrentIu() {
        if (!isAdded) return
        val ius = currentIuSequence ?: return
        if (ius.isEmpty()) return
        val idx = playbackViewModel.currentUnitIndex.coerceIn(0, ius.size - 1)
        showIuImage(ius[idx].bitmap)
    }

    private fun updateSubtitleIfEnabled(text: String?) {
        if (!isAdded) return
        val b = binding ?: return
        if (b.layerSubtitles.isChecked && text != null) {
            b.subtitleText.text = text
            b.subtitleText.visibility = View.VISIBLE
        } else {
            b.subtitleText.visibility = View.GONE
        }
        anchorFullscreenToImage()
    }

    private fun updateSubtitleVisibility() {
        if (!isAdded) return
        val b = binding ?: return
        if (b.layerSubtitles.isChecked && currentIuSequence != null && currentIuIndex < currentIuSequence!!.size) {
            val text = currentIuSequence!![currentIuIndex].text
            if (text != null) {
                b.subtitleText.text = text
                b.subtitleText.visibility = View.VISIBLE
            } else {
                b.subtitleText.visibility = View.GONE
            }
        } else {
            b.subtitleText.visibility = View.GONE
        }
        anchorFullscreenToImage()
    }

    private fun toggleFullscreen() {
        isFullscreen = !isFullscreen
        val b = binding ?: return
        val activity = activity as? MainActivity ?: return

        if (isFullscreen) {
            b.fullscreenButton.setImageResource(R.drawable.ic_fullscreen_exit)
            val params = b.mediaContainer.layoutParams as androidx.constraintlayout.widget.ConstraintLayout.LayoutParams
            params.bottomToTop = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.UNSET
            params.bottomToBottom = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.PARENT_ID
            params.topToTop = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.PARENT_ID
            params.startToStart = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.PARENT_ID
            params.endToEnd = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.PARENT_ID
            params.width = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.MATCH_PARENT
            params.height = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.MATCH_PARENT
            b.mediaContainer.layoutParams = params
            b.layerBar.visibility = View.INVISIBLE
            b.playButton.visibility = View.INVISIBLE
            b.progressBar.visibility = View.INVISIBLE
            b.statusText.visibility = View.INVISIBLE
            activity.toggleBottomNavigationVisible(false)
        } else {
            b.fullscreenButton.setImageResource(R.drawable.ic_fullscreen)
            val params = b.mediaContainer.layoutParams as androidx.constraintlayout.widget.ConstraintLayout.LayoutParams
            params.bottomToTop = b.layerBar.id
            params.bottomToBottom = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.UNSET
            params.topToTop = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.PARENT_ID
            params.startToStart = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.PARENT_ID
            params.endToEnd = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.PARENT_ID
            params.width = 0
            params.height = 0
            b.mediaContainer.layoutParams = params
            b.layerBar.visibility = View.VISIBLE
            b.playButton.visibility = View.VISIBLE
            b.statusText.visibility = View.VISIBLE
            activity.toggleBottomNavigationVisible(true)
        }
        b.mediaContainer.post {
            anchorFullscreenToImage()
            refitVideoSurface()
        }
    }

    private fun observeState() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                var prevPhase: PlayerPhase? = null
                playbackViewModel.uiState.collect { state ->
                    try {
                        val b = binding ?: return@collect
                        Log.d(TAG, "state: phase=${state.phase} img=${state.previewImage != null} cover=${state.coverImage != null} player=$currentPlayer")

                        // Update play button state BEFORE any early returns
                        val hasChunks = playbackViewModel.chunkQueueSize > 0
                        val buttonEnabled = state.phase == PlayerPhase.SCENE_READY || state.phase == PlayerPhase.PLAYING || hasChunks
                        b.playButton.isEnabled = buttonEnabled
                        b.playButton.alpha = if (buttonEnabled) 1.0f else 0.4f

                        val missingPos = state.missingIuPosition
                        if (missingPos != null) {
                            showMissingChunkOverlay(missingPos)
                            return@collect
                        } else {
                            hideIuMissingPlaceholder()
                        }

                        // Skip rotation recovery when no MediaPlayer available (e.g. silent scenes)
                        if (state.phase == PlayerPhase.PLAYING && currentPlayer == null
                            && state.chunkSequence <= playbackViewModel.lastProcessedChunkSequence) {
                            Log.w(TAG, "rotation recovery: PLAYING with no player (chunk already processed) -> SCENE_READY")
                            playbackViewModel.rotationRecovery()
                            return@collect
                        }

                        val displayImage = state.previewImage

                        if (state.coverImage != null) {
                            if (isInCurtainsState) {
                                stopPulse()
                                isInCurtainsState = false
                            }
                            b.curtainsImage.visibility = View.GONE
                            b.coverImage.setImageBitmap(state.coverImage)
                            b.coverImage.visibility = View.VISIBLE
                            hasDisplayedCover = true
                        } else {
                            hasDisplayedCover = false
                            showCurtains()
                            val loading = state.phase == PlayerPhase.LOADING_BOOK || state.phase == PlayerPhase.DOWNLOADING
                            if (loading) startPulse(b) else stopPulse()
                        }

                        if ((state.phase == PlayerPhase.SCENE_READY || state.phase == PlayerPhase.GENERATING)
                            && prevPhase == PlayerPhase.PLAYING) {
                            stopAll()
                        }
                        prevPhase = state.phase

                        if (state.phase == PlayerPhase.IDLE && playbackViewModel.bookId.isBlank()) {
                            stopAll()
                            b.coverImage.setImageBitmap(null)
                            b.coverImage.visibility = View.GONE
                            b.fullscreenButton.visibility = View.GONE
                        }

                        if (state.phase == PlayerPhase.PLAYING && state.chunkSequence > playbackViewModel.lastProcessedChunkSequence) {
                            playbackViewModel.lastProcessedChunkSequence = state.chunkSequence
                            val audio = playbackViewModel.pendingChunkAudio
                            val ius = playbackViewModel.pendingChunkIuSequence
                            if (audio != null && audio.isNotEmpty()) {
                                handleChunk(audio, playbackViewModel.pendingChunkVideo, playbackViewModel.pendingChunkIuSequence)
                            } else if (ius != null && ius.isNotEmpty()) {
                                Log.i(TAG, "no audio — starting timer-based IU cycling")
                                handleSilentChunk(ius)
                            }
                        }

                        if (state.phase == PlayerPhase.SCENE_READY) {
                            val showResult = displayImage != null
                            b.resultImage.visibility = if (showResult) View.VISIBLE else View.INVISIBLE
                            if (showResult) {
                                b.resultImage.setImageBitmap(displayImage)
                                b.mediaContainer.post { anchorFullscreenToImage() }
                            }
                        }

                        if (playbackViewModel.persistedImage != null && b.resultImage.visibility != View.VISIBLE) {
                            b.resultImage.setImageBitmap(playbackViewModel.persistedImage)
                            b.resultImage.visibility = View.VISIBLE
                            b.coverImage.visibility = View.GONE
                            b.mediaContainer.post { anchorFullscreenToImage() }
                        }

                        if (state.phase == PlayerPhase.IDLE) {
                            if (playbackViewModel.bookId.isBlank()) {
                                b.placeholderText.text = getString(R.string.play_placeholder)
                                b.placeholderText.visibility = View.VISIBLE
                            } else {
                                b.placeholderText.text = getString(R.string.play_generate_hint)
                                b.placeholderText.visibility = View.VISIBLE
                            }
                        } else {
                            b.placeholderText.visibility = View.INVISIBLE
                        }

                        val loading = state.phase == PlayerPhase.LOADING_BOOK || state.phase == PlayerPhase.DOWNLOADING
                        b.previewOverlay.visibility = if (loading && state.coverImage != null) View.VISIBLE else View.GONE
                        b.progressBar.visibility = if (loading) View.VISIBLE else View.GONE

                        val errorMsg = state.errorMessage
                        if (errorMsg != null) {
                            b.statusText.text = "Error: $errorMsg"
                            b.placeholderText.text = errorMsg
                            Log.w(TAG, "error in state: $errorMsg")
                        } else when (state.phase) {
                            PlayerPhase.LOADING_BOOK -> b.statusText.text = getString(R.string.play_loading)
                            PlayerPhase.GENERATING, PlayerPhase.DOWNLOADING -> {
                                val wp = state.windowProgress
                                if (wp != null) {
                                    b.statusText.text = "Loading $wp…"
                                } else {
                                    b.statusText.text = getString(R.string.play_loading)
                                }
                            }
                            PlayerPhase.SCENE_READY -> b.statusText.text = getString(R.string.play_ready)
                            PlayerPhase.PLAYING -> if (isPaused) b.statusText.text = getString(R.string.play_paused)
                                else b.statusText.text = getString(R.string.play_playing)
                            PlayerPhase.IDLE -> b.statusText.text = if (playbackViewModel.bookId.isBlank()) getString(R.string.empty_state) else getString(R.string.empty_state_book_loaded)
                            PlayerPhase.PAUSED -> b.statusText.text = getString(R.string.play_paused)
                            PlayerPhase.IMPORTING_TXT -> b.statusText.text = getString(R.string.play_loading)
                        }

                        val isPlaying = state.phase == PlayerPhase.PLAYING && !isPaused
                        b.playButton.text = if (isPlaying) getString(R.string.play_pause) else getString(R.string.play_play)
                        if (isPlaying) b.playButton.setIconResource(R.drawable.ic_pause) else b.playButton.setIconResource(R.drawable.ic_play)
                    } catch (e: Exception) {
                        Log.e(TAG, "===== CRASH IN STATE COLLECTOR =====", e)
                        try {
                            Toast.makeText(requireContext(), "CRASH: ${e.message}", Toast.LENGTH_LONG).show()
                        } catch (_: Exception) {}
                    }
                }
            }
        }
    }

    private fun updateLayers() {
        val b = binding ?: return
        val imageOn = b.layerImage.isChecked
        b.resultImage.visibility = if (imageOn) View.VISIBLE else View.INVISIBLE
        if (!imageOn) {
            b.coverImage.visibility = View.VISIBLE
        }
        val showVideo = b.layerVideo.isChecked && videoPlayer != null
        if (showVideo && b.videoSurface.visibility != View.VISIBLE) {
            b.videoSurface.visibility = View.VISIBLE
            attachVideoSurface()
        } else if (!showVideo) {
            b.videoSurface.visibility = View.INVISIBLE
        }
        anchorFullscreenToImage()
    }

    private fun attachVideoSurface() {
        val b = binding ?: return
        if (b.videoSurface.holder.surface.isValid) {
            try { videoPlayer?.setDisplay(b.videoSurface.holder) } catch (_: Exception) {}
        } else {
            val cb = object : SurfaceHolder.Callback {
                override fun surfaceCreated(holder: SurfaceHolder) {
                    b.videoSurface.holder.removeCallback(this)
                    try { videoPlayer?.setDisplay(holder) } catch (_: Exception) {}
                }
                override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
                override fun surfaceDestroyed(holder: SurfaceHolder) {}
            }
            b.videoSurface.holder.addCallback(cb)
        }
    }

    private fun handleChunk(audio: ByteArray, video: ByteArray?, iuSequence: List<IuImageItem>?) {
        if (!isAdded) return
        Log.i(TAG, "handleChunk: audio=${audio.size}B video=${video?.size}B ius=${iuSequence?.size ?: 0}")

        if (video != null) playVideoOverlay(video)

        playbackViewModel.persistedImage = null

        // Calculate seek offset from unitIndex if navigating externally
        val targetUnit = SharedPositionManager.current.value.unitIndex
        val seekToUnit = if (targetUnit > 0 && !iuSequence.isNullOrEmpty() && targetUnit < iuSequence.size) targetUnit else 0
        var seekMs = 0L
        if (seekToUnit > 0 && !iuSequence.isNullOrEmpty()) {
            for (i in 0 until seekToUnit) {
                seekMs += iuSequence[i].durationMs
            }
        }

        if (!iuSequence.isNullOrEmpty()) {
            currentIuSequence = iuSequence
            playbackViewModel.currentIuSequence = iuSequence
            currentIuIndex = seekToUnit
            showIuImage(iuSequence[seekToUnit])
            updateSubtitleIfEnabled(iuSequence[seekToUnit].text)
        } else {
            currentIuSequence = iuSequence
            playbackViewModel.currentIuSequence = iuSequence
            showIuMissingPlaceholder()
            updateSubtitleIfEnabled(null)
        }

        if (nextChainReady && currentPlayer != null) {
            nextChainReady = false
            Log.d(TAG, "handleChunk: chain already set up, preloading next-next audio")
            preloadAheadAudio()
            sceneTransitionPending = true
            return
        }

        if (currentPlayer == null) {
            Log.i(TAG, "creating first MediaPlayer")
            val file = writeTemp(audio)
            currentFile = file
            currentPlayer = createPlayer(file)
            currentPlayer?.setOnCompletionListener { onTrackEnd() }
            if (pendingLoad) {
                pendingLoad = false
                isPaused = true
                Log.i(TAG, "pending load — player stays Prepared")
            } else {
                currentPlayer?.start()
            }
            if (seekMs > 0) {
                Log.i(TAG, "seeking to unit ${seekToUnit} at ${seekMs}ms")
                currentPlayer?.seekTo(seekMs.toInt())
            } else if (playbackViewModel.pendingSeekPositionMs > 0) {
                val sMs = playbackViewModel.pendingSeekPositionMs.toInt()
                Log.i(TAG, "seek to ${sMs}ms after rotation resume")
                currentPlayer?.seekTo(sMs)
                playbackViewModel.pendingSeekPositionMs = -1
            }
            Log.i(TAG, "first MediaPlayer started at unit ${seekToUnit}")
            if (!isPaused) {
                if (currentPlayer != null) {
                    startIuCycling()
                } else if (!iuSequence.isNullOrEmpty()) {
                    Log.i(TAG, "no audio available — timer-based IU cycling")
                    startSilentIuCycling()
                }
            }
            preloadAheadAudio()
        } else {
            Log.d(TAG, "preloading next audio and chaining")
            preloadNext(audio)
            currentPlayer?.setNextMediaPlayer(nextPlayer)
            nextPlayer?.setOnCompletionListener { onTrackEnd() }
            sceneTransitionPending = true
            iuCyclingJob?.cancel()
            startIuCycling()
        }
        updateLayers()
    }

    /** Handle chunk with no audio — show IU images with timer-based cycling (e.g. Cover). */
    private fun handleSilentChunk(iuSequence: List<IuImageItem>) {
        if (!isAdded) return
        Log.i(TAG, "handleSilentChunk: ius=${iuSequence.size}")

        // Stop any existing playback
        currentPlayer?.release()
        currentPlayer = null
        nextPlayer?.release()
        nextPlayer = null
        currentFile?.delete()
        currentFile = null
        nextFile?.delete()
        nextFile = null
        currentVideoFile?.delete()
        currentVideoFile = null
        videoPlayer?.release()
        videoPlayer = null

        currentIuSequence = iuSequence
        playbackViewModel.currentIuSequence = iuSequence
        currentIuIndex = 0
        playbackViewModel.currentUnitIndex = 0

        if (iuSequence.isNotEmpty()) {
            showIuImage(iuSequence[0])
            updateSubtitleIfEnabled(iuSequence[0].text)
        }

        isPaused = false
        startSilentIuCycling()
        updateLayers()
    }

    /** Timer-based IU cycling for silent scenes (no MediaPlayer needed). */
    private fun startSilentIuCycling() {
        iuCyclingJob?.cancel()
        iuCyclingJob = viewLifecycleOwner.lifecycleScope.launch {
            while (isActive) {
                if (!isAdded) { delay(500); continue }
                val ius = currentIuSequence
                if (ius.isNullOrEmpty()) { delay(500); continue }
                if (currentIuIndex >= ius.size) { delay(500); continue }

                // Don't cycle if no images are available
                if (ius.all { it.status != IuStatus.READY && it.bitmap == null }) {
                    delay(5000)
                    continue
                }

                if (isPaused) {
                    delay(500)
                    continue
                }

                val dur = ius[currentIuIndex].durationMs
                delay(dur)

                if (!isAdded || isPaused || ius != currentIuSequence) continue

                val nextIdx = (currentIuIndex + 1) % ius.size
                currentIuIndex = nextIdx
                playbackViewModel.currentUnitIndex = nextIdx
                showIuImage(ius[nextIdx])
                updateSubtitleIfEnabled(ius[nextIdx].text)
                SharedPositionManager.navigateTo(
                    chapterId = playbackViewModel.currentChapterId,
                    sceneId = playbackViewModel.currentSceneId,
                    unitId = ius[nextIdx].unitId,
                    chunkId = playbackViewModel.getCurrentChunkId(),
                    unitIndex = nextIdx
                )
                if (isAdded) anchorFullscreenToImage()
            }
        }
    }

    private fun preloadAheadAudio() {
        val nextScene = playbackViewModel.tryPreloadNextScene() ?: return
        preloadNext(nextScene.audioBytes)
        currentPlayer?.setNextMediaPlayer(nextPlayer)
        nextPlayer?.setOnCompletionListener { onTrackEnd() }
        nextChainReady = true
    }

    private fun showIuImage(bitmap: Bitmap?) {
        if (!isAdded) return
        val b = binding ?: return
        try {
            if (bitmap != null) {
                b.resultImage.setImageBitmap(bitmap)
                if (b.layerImage.isChecked) {
                    b.resultImage.visibility = View.VISIBLE
                }
                b.placeholderText.visibility = View.INVISIBLE
                b.iuMissingOverlay.visibility = View.GONE
                anchorFullscreenToImage()
            } else {
                showIuMissingPlaceholder()
            }
        } catch (e: Exception) {
            Log.w(TAG, "showIuImage failed: ${e.message}")
        }
    }

    private fun showIuImage(item: IuImageItem) {
        if (item.bitmap != null && item.status == IuStatus.READY) {
            showIuImage(item.bitmap)
        } else {
            showIuMissingPlaceholder()
        }
    }

    private fun showIuMissingPlaceholder() {
        val b = binding ?: return
        try {
            // Show Cover as fallback when no scene image is available
            val cover = playbackViewModel.uiState.value.coverImage
            if (cover != null) {
                b.resultImage.setImageBitmap(null)
                b.resultImage.visibility = View.INVISIBLE
                b.coverImage.setImageBitmap(cover)
                b.coverImage.visibility = View.VISIBLE
                b.iuMissingOverlay.visibility = View.GONE
            } else {
                b.resultImage.setImageBitmap(null)
                b.resultImage.visibility = View.INVISIBLE
                b.placeholderText.visibility = View.INVISIBLE
                b.iuMissingOverlay.visibility = View.VISIBLE
            }
            anchorFullscreenToImage()
        } catch (e: Exception) {
            Log.w(TAG, "showIuMissingPlaceholder failed: ${e.message}")
        }
    }

    private fun hideIuMissingPlaceholder() {
        val b = binding ?: return
        b.iuMissingOverlay.visibility = View.GONE
    }

    private fun showMissingChunkOverlay(position: ActivePosition) {
        if (!isAdded) return
        val b = binding ?: return
        Log.w(TAG, "showMissingChunkOverlay: ${position.chapterId}/${position.sceneId}/${position.unitId}")
        try {
            currentIuSequence = emptyList()
            playbackViewModel.currentIuSequence = emptyList()
            currentPlayer?.runCatching { stop() }
            currentPlayer?.release()
            currentPlayer = null
            isPaused = false
            b.resultImage.setImageBitmap(null)
            b.resultImage.visibility = View.INVISIBLE
            b.placeholderText.visibility = View.INVISIBLE
            b.iuMissingOverlay.visibility = View.VISIBLE
            anchorFullscreenToImage()
            b.statusText.text = getString(R.string.iu_not_generated)
            viewLifecycleOwner.lifecycleScope.launch {
                SharedPositionManager.navigateTo(position)
            }
        } catch (e: Exception) {
            Log.w(TAG, "showMissingChunkOverlay failed: ${e.message}")
        }
    }

    private fun anchorFullscreenToImage() {
        val b = binding ?: return
        var drawable = b.resultImage.drawable
        if (drawable == null || b.resultImage.visibility != View.VISIBLE) {
            drawable = b.coverImage.drawable
        }

        b.fullscreenButton.visibility = View.VISIBLE

        val container = b.mediaContainer
        var targetTranslationX = 0f
        var targetTranslationY = 0f

        if (drawable != null && container.width > 0 && container.height > 0) {
            val dWidth = drawable.intrinsicWidth
            val dHeight = drawable.intrinsicHeight
            if (dWidth > 0 && dHeight > 0) {
                val viewW = container.width - container.paddingLeft - container.paddingRight
                val viewH = container.height - container.paddingTop - container.paddingBottom
                if (viewW > 0 && viewH > 0) {
                    val scale = minOf(viewW / dWidth.toFloat(), viewH / dHeight.toFloat())
                    val displayW = dWidth * scale
                    val displayH = dHeight * scale
                    val gapX = (viewW - displayW) / 2f
                    val gapY = (viewH - displayH) / 2f
                    targetTranslationX = -gapX
                    targetTranslationY = -gapY
                }
            }
        }

        if (b.subtitleText.visibility == View.VISIBLE) {
            val density = resources.displayMetrics.density
            val gapPx = (6f * density).toInt()
            val marginBottomPx = (14f * density).toInt()
            val btnDefaultBottom = container.height - marginBottomPx
            val subtitleTop = b.subtitleText.top
            val targetBottom = subtitleTop - gapPx
            val subtitleTranslationY = (targetBottom - btnDefaultBottom).toFloat()
            targetTranslationY = minOf(targetTranslationY, subtitleTranslationY)
        }

        b.fullscreenButton.translationX = targetTranslationX
        b.fullscreenButton.translationY = targetTranslationY
    }

    private fun startIuCycling() {
        iuCyclingJob?.cancel()
        iuCyclingJob = viewLifecycleOwner.lifecycleScope.launch {
            while (isActive) {
                if (!isAdded) {
                    delay(500)
                    continue
                }
                val ius = currentIuSequence
                val player = currentPlayer
                if (ius.isNullOrEmpty() || player == null) {
                    delay(500)
                    continue
                }

                if (isPaused) {
                    delay(500)
                    continue
                }

                val pos = try { player.currentPosition.toLong() } catch (e: Exception) { -1L }
                val dur = try { player.duration.toLong() } catch (e: Exception) { -1L }
                if (pos < 0 || dur <= 0) {
                    delay(500)
                    continue
                }

                if (pos >= dur - 200 && sceneTransitionPending) {
                    sceneTransitionPending = false
                    switchToNextPlayer()
                    continue
                }

                var cumulative = 0L
                var idx = 0
                for ((i, iu) in ius.withIndex()) {
                    cumulative += iu.durationMs
                    if (pos < cumulative) {
                        idx = i
                        break
                    }
                }
                if (idx >= ius.size) idx = ius.size - 1

                if (idx == 0 && currentIuIndex != 0) {
                    delay(500)
                    continue
                }
                if (idx != currentIuIndex) {
                    currentIuIndex = idx
                    if (isPaused) continue
                    playbackViewModel.currentUnitIndex = idx
                    showIuImage(ius[idx])
                    updateSubtitleIfEnabled(ius[idx].text)
                    SharedPositionManager.navigateTo(
                        chapterId = playbackViewModel.currentChapterId,
                        sceneId = playbackViewModel.currentSceneId,
                        unitId = ius[idx].unitId,
                        chunkId = playbackViewModel.getCurrentChunkId(),
                        unitIndex = idx
                    )
                }

                if (isAdded) anchorFullscreenToImage()

                delay(50L)
            }
        }
    }

    private fun switchToNextPlayer() {
        Log.i(TAG, "switchToNextPlayer: hasNext=${nextPlayer != null} isPaused=$isPaused")
        currentIuIndex = 0
        updateSubtitleIfEnabled(null)
        currentPlayer?.stop()
        currentPlayer = nextPlayer
        currentFile = nextFile
        nextPlayer = null
        nextFile = null
        if (currentPlayer != null) {
            if (isPaused) {
                currentPlayer?.pause()
            } else {
                currentPlayer?.start()
            }
            startIuCycling()
        } else {
            Log.w(TAG, "switchToNextPlayer: no next player")
        }
        playbackViewModel.onAudioCompleted()
    }

    private fun onTrackEnd() {
        Log.i(TAG, "onTrackEnd: isPaused=$isPaused")
        try {
            viewLifecycleOwner.lifecycleScope.launch {
                iuCyclingJob?.cancel()
                currentFile?.delete()
                currentPlayer?.stop()
                currentPlayer = nextPlayer
                currentFile = nextFile
                nextPlayer = null
                nextFile = null
                if (currentPlayer != null) {
                    currentIuIndex = 0
                    updateSubtitleIfEnabled(null)
                    if (isPaused) {
                        currentPlayer?.pause()
                    } else {
                        currentPlayer?.start()
                    }
                    startIuCycling()
                } else {
                    if (isAdded) showCoverOnly()
                }
                playbackViewModel.onAudioCompleted()
            }
        } catch (e: Exception) {
            Log.e(TAG, "onTrackEnd error: ${e.message}")
        }
    }

    private fun showCoverOnly() {
        if (!isAdded) return
        val b = binding ?: return
        try {
            b.resultImage.visibility = View.INVISIBLE
            b.resultImage.setImageBitmap(null)
            b.subtitleText.visibility = View.GONE
            if (b.coverImage.drawable != null) {
                b.coverImage.visibility = View.VISIBLE
            }
            anchorFullscreenToImage()
        } catch (e: Exception) {
            Log.w(TAG, "showCoverOnly error: ${e.message}")
        }
    }

    private fun preloadNext(audio: ByteArray) {
        nextFile?.delete()
        nextPlayer?.release()
        if (audio.isEmpty()) {
            Log.w(TAG, "preloadNext: empty audio, skipping")
            nextPlayer = null
            nextFile = null
            return
        }
        val file = writeTemp(audio)
        nextFile = file
        nextPlayer = try {
            MediaPlayer().apply {
                setDataSource(file.absolutePath)
                prepare()
                setVolume(currentVolume, currentVolume)
            }
        } catch (e: Exception) {
            Log.w(TAG, "preloadNext failed: ${e.message}")
            nextFile = null
            null
        }
    }

    private fun createPlayer(file: File): MediaPlayer? {
        if (file.length() == 0L) {
            Log.w(TAG, "createPlayer: empty audio file")
            return null
        }
        return try {
            MediaPlayer().apply {
                setDataSource(file.absolutePath)
                prepare()
                setVolume(currentVolume, currentVolume)
            }
        } catch (e: Exception) {
            Log.w(TAG, "createPlayer failed: ${e.message}")
            null
        }
    }

    private fun writeTemp(bytes: ByteArray): File {
        val chunkId = playbackViewModel.getCurrentChunkId()
        if (chunkId != null) {
            val cached = repository.cacheAudioFile(chunkId, bytes)
            if (cached != null) return cached
        }
        val file = File(requireContext().cacheDir, "chunk-${System.currentTimeMillis()}.mp3")
        file.writeBytes(bytes)
        return file
    }

    private fun playVideoOverlay(bytes: ByteArray) {
        try {
            videoPlayer?.release()
            videoPlayer = null
            currentVideoFile?.delete()
            val chunkId = playbackViewModel.getCurrentChunkId()
            val file = if (chunkId != null) {
                repository.cacheVideoFile(chunkId, bytes)
                    ?: File(requireContext().cacheDir, "video-${System.currentTimeMillis()}.mp4").also { it.writeBytes(bytes) }
            } else {
                File(requireContext().cacheDir, "video-${System.currentTimeMillis()}.mp4").also { it.writeBytes(bytes) }
            }
            currentVideoFile = file
            val b = binding ?: return
            b.videoSurface.visibility = View.VISIBLE

            fun startVideo() {
                videoPlayer = MediaPlayer().apply {
                    setDataSource(file.absolutePath)
                    setDisplay(b.videoSurface.holder)
                    setVolume(currentVolume, currentVolume)
                    setOnVideoSizeChangedListener { _, width, height ->
                        fitSurfaceToContainer(b, width, height)
                    }
                    setOnPreparedListener {
                        updateLayers()
                        val ap = currentPlayer?.currentPosition ?: 0
                        if (ap > 0) seekTo(ap)
                        start()
                        if (pendingLoad || isPaused) {
                            val vp = this
                            pendingVideoSyncJob?.cancel()
                            pendingVideoSyncJob = viewLifecycleOwner.lifecycleScope.launch {
                                delay(50)
                                try { vp.pause() } catch (_: IllegalStateException) {}
                            }
                        }
                    }
                    setOnCompletionListener {
                        b.videoSurface.visibility = View.INVISIBLE
                        currentVideoFile?.delete()
                        currentVideoFile = null
                    }
                    prepareAsync()
                }
            }

            if (b.videoSurface.holder.surface.isValid) {
                startVideo()
            } else {
                b.videoSurface.holder.addCallback(object : SurfaceHolder.Callback {
                    override fun surfaceCreated(holder: SurfaceHolder) {
                        b.videoSurface.holder.removeCallback(this)
                        startVideo()
                    }
                    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
                    override fun surfaceDestroyed(holder: SurfaceHolder) {}
                })
            }
        } catch (e: Exception) {
            Log.e(TAG, "Video exception: ${e.message}", e)
        }
    }

    private fun refitVideoSurface() {
        val b = binding ?: return
        val vp = videoPlayer ?: return
        if (b.videoSurface.visibility != View.VISIBLE) return
        try {
            val w = vp.videoWidth
            val h = vp.videoHeight
            if (w > 0 && h > 0) {
                fitSurfaceToContainer(b, w, h)
            }
        } catch (e: Exception) {
            Log.w(TAG, "refitVideoSurface failed: ${e.message}")
        }
    }

    private fun fitSurfaceToContainer(b: FragmentPlayBinding, videoW: Int, videoH: Int) {
        if (videoW <= 0 || videoH <= 0) return
        val container = b.mediaContainer
        val viewW = container.width - container.paddingLeft - container.paddingRight
        val viewH = container.height - container.paddingTop - container.paddingBottom
        if (viewW <= 0 || viewH <= 0) return

        val scale = minOf(viewW / videoW.toFloat(), viewH / videoH.toFloat())
        val dispW = (videoW * scale).toInt()
        val dispH = (videoH * scale).toInt()

        val lp = b.videoSurface.layoutParams as android.widget.FrameLayout.LayoutParams
        lp.width = dispW
        lp.height = dispH
        lp.gravity = android.view.Gravity.CENTER
        b.videoSurface.layoutParams = lp
    }

    private fun syncVideoFrame() {
        pendingVideoSyncJob?.cancel()
        val pos = currentPlayer?.currentPosition ?: 0
        val vp = videoPlayer ?: return
        if (pos < 0) return
        try {
            vp.seekTo(pos)
            if (!vp.isPlaying) {
                vp.start()
            }
            pendingVideoSyncJob = viewLifecycleOwner.lifecycleScope.launch {
                delay(50)
                try {
                    vp.pause()
                } catch (e: IllegalStateException) {
                    Log.w(TAG, "syncVideoFrame delayed pause: ${e.message}")
                }
            }
        } catch (e: IllegalStateException) {
            Log.w(TAG, "syncVideoFrame failed: ${e.message}")
        }
    }

    private fun pausePlayback() {
        Log.i(TAG, "pausePlayback")
        currentPlayer?.pause()
        try {
            videoPlayer?.pause()
        } catch (e: IllegalStateException) {
            Log.w(TAG, "videoPlayer pause failed (state issue): ${e.message}")
        }
        isPaused = true
        binding?.playButton?.text = getString(R.string.play_play)
        binding?.playButton?.setIconResource(R.drawable.ic_play)
        binding?.statusText?.text = getString(R.string.play_paused)
    }

    private fun resumePlayback() {
        Log.i(TAG, "resumePlayback")
        pendingVideoSyncJob?.cancel()
        showCurrentIu()
        currentPlayer?.start()
        try {
            if (videoPlayer != null && !videoPlayer!!.isPlaying) {
                videoPlayer?.start()
            }
        } catch (e: IllegalStateException) {
            Log.w(TAG, "videoPlayer resume failed (state issue): ${e.message}")
        }
        updateLayers()
        isPaused = false
        startIuCycling()
        binding?.playButton?.text = getString(R.string.play_pause)
        binding?.playButton?.setIconResource(R.drawable.ic_pause)
        binding?.statusText?.text = getString(R.string.play_playing)
    }

    private fun togglePlay() {
        if (isPaused) {
            resumePlayback()
        } else {
            pausePlayback()
        }
    }

    fun stopAll() {
        Log.i(TAG, "stopAll")
        pendingVideoSyncJob?.cancel()
        iuCyclingJob?.cancel()
        iuCyclingJob = null
        currentIuSequence = null
        playbackViewModel.currentIuSequence = null
        currentIuIndex = 0
        sceneTransitionPending = false
        nextChainReady = false
        currentPlayer?.release()
        nextPlayer?.release()
        videoPlayer?.release()
        videoPlayer = null
        if (currentFile?.name?.startsWith("chunk-") == true) currentFile?.delete()
        if (nextFile?.name?.startsWith("chunk-") == true) nextFile?.delete()
        if (currentVideoFile?.name?.startsWith("video-") == true) currentVideoFile?.delete()
        currentPlayer = null
        nextPlayer = null
        currentFile = null
        nextFile = null
        currentVideoFile = null
        isPaused = false
        val b = binding
        if (b != null) {
            b.resultImage.visibility = View.INVISIBLE
            b.subtitleText.visibility = View.GONE
            if (b.coverImage.drawable != null) {
                b.coverImage.visibility = View.VISIBLE
                b.videoSurface.visibility = View.INVISIBLE
            }
        }
        anchorFullscreenToImage()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (hidden) {
            stopPulse()
            val phase = playbackViewModel.uiState.value.phase
            if (phase == PlayerPhase.PLAYING && !isPaused) {
                if (currentPlayer == null && currentIuSequence != null) {
                    // Silent scene (no MediaPlayer) — just stop cycling
                    iuCyclingJob?.cancel()
                    isPaused = true
                } else {
                    pausePlayback()
                }
            }
        } else {
            if (isInCurtainsState) {
                val b = binding
                if (b != null) startPulse(b)
            }
            if (isPaused) {
                syncVideoFrame()
                showCurrentIu()
            }
            // Auto-initialize when tab becomes visible
            if (playbackViewModel.bookId.isBlank() && generateViewModel.bookId.isNotBlank()) {
                Log.i(TAG, "onHiddenChanged: bookId blank — auto-initializing from GenVM")
                playbackViewModel.ensureInitialized(generateViewModel.bookId, generateViewModel.buildId)
            }
            if (playbackViewModel.pendingExternalSeek != null) {
                Log.i(TAG, "onHiddenChanged: external seek pending, executing")
                pendingLoad = true
                stopAll()
                playbackViewModel.executePendingSeek()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        checkPendingExternalSeek()
    }

    override fun onPause() {
        super.onPause()
        if (activity?.isChangingConfigurations == true) {
            if (currentPlayer != null) {
                val pos = currentPlayer?.currentPosition?.toLong() ?: 0
                if (pos > 0) playbackViewModel.savedPlaybackPositionMs = pos
            }
            val b = binding
            if (b != null && b.resultImage.visibility == View.VISIBLE && b.resultImage.drawable != null) {
                val bmp = (b.resultImage.drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap
                if (bmp != null) playbackViewModel.persistedImage = bmp
            }
        }
        if (playbackViewModel.uiState.value.phase == PlayerPhase.PLAYING && !isPaused) {
            pausePlayback()
        }
    }

    override fun onDestroyView() {
        stopPulse()
        currentPlayer?.release()
        currentPlayer = null
        nextPlayer?.release()
        nextPlayer = null
        videoPlayer?.release()
        videoPlayer = null
        if (currentFile?.name?.startsWith("chunk-") == true) currentFile?.delete()
        if (nextFile?.name?.startsWith("chunk-") == true) nextFile?.delete()
        if (currentVideoFile?.name?.startsWith("video-") == true) currentVideoFile?.delete()
        currentFile = null
        nextFile = null
        currentVideoFile = null
        iuCyclingJob?.cancel()
        iuCyclingJob = null
        binding = null
        super.onDestroyView()
    }
}
