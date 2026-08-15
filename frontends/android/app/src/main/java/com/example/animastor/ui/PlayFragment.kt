package com.example.animastor.ui

import android.graphics.Bitmap
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.SurfaceHolder
import android.view.View
import android.widget.Toast
import java.io.ByteArrayOutputStream
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
    private var currentVolume = 1.0f
    private var isFullscreen = false
    private var pendingLoad = false
    private var pendingVideoSyncJob: Job? = null
    // Explicit position the whole-scene video must land on (ms) once prepared.
    // Set when the video is started for a unit navigation / rotation resume;
    // guards syncVideoFrame() from clobbering it with the audio player's not-yet
    // seeked currentPosition (the audio seekTo is asynchronous). -1 = no target.
    private var pendingVideoTargetMs: Long = -1L
    // ── TEMPORARY unit-seek diagnostics ────────────────────────────────────
    // One SEEK_REQUEST/SEEK_RESULT pair per Navigator/Edit unit tap is posted
    // to POST /api/v1/debug/video-seek (backend appends to a JSONL file while
    // VIDEO_SEEK_DEBUG=1). Remove together with the backend endpoint.
    private var pendingDebugRecord: MutableMap<String, Any?>? = null
    // Captured BEFORE stopAll() releases the old video player, so "video_before"
    // is the real position at the moment of the unit tap.
    private var debugVideoBeforeMs: Long = -1L
    private var debugVideoFileBefore: String? = null
    private var debugSeq = 0L
    // TEMPORARY: high-frequency (50ms) video+audio position trace collected for
    // ~1.5s after onPrepared — shows the exact moment the correct seeked
    // position is replaced by a wrong one / when playback starts early.
    private var debugTraceSamples: MutableList<Map<String, Any?>>? = null

    private fun checkPendingExternalSeek() {
        if (playbackViewModel.pendingExternalSeek != null) {
            if (isHidden) return
            Log.i(TAG, "checkPendingExternalSeek: executing seek to ${playbackViewModel.pendingExternalSeek}")
            captureDebugVideoBefore()
            pendingLoad = true
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
                        captureDebugVideoBefore()
                        pendingLoad = true
                        stopAll()
                        playbackViewModel.executePendingSeek()
                    }
                }
            }
        }
    }

    /** TEMPORARY: snapshot the old video player's position before stopAll()
     *  releases it — this is "video_before" in the seek-debug record. */
    private fun captureDebugVideoBefore() {
        debugVideoBeforeMs = runCatching { videoPlayer?.currentPosition?.toLong() }.getOrNull() ?: -1L
        debugVideoFileBefore = currentVideoFile?.name
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
        // Once a cover has ever been displayed, curtains are permanently disabled
        // — the cover becomes the definitive fallback background.
        if (hasDisplayedCover) return
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

    private fun stopPulse() {
        // Pulse animation removed — no-op kept for safety cleanup calls
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

        if (playbackViewModel.sceneQueueSize > 0) {
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
                phase == PlayerPhase.PAUSED -> {
                    Log.i(TAG, "playButton: PAUSED — resuming playback")
                    resumePlayback()
                }
                phase == PlayerPhase.SCENE_READY && playbackViewModel.needsRotationResume -> {
                    Log.i(TAG, "playButton: rotation resume from index ${playbackViewModel.currentSceneIndex}")
                    playbackViewModel.resumeFromCurrentScene()
                }
                phase == PlayerPhase.SCENE_READY -> {
                    // If queue has ended (index out of bounds), restart from beginning.
                    // Otherwise, if there's an existing position (content refresh after
                    // generation), resume from current scene instead of resetting.
                    if (playbackViewModel.currentSceneIndex >= playbackViewModel.sceneQueueSize) {
                        Log.i(TAG, "playButton: SCENE_READY — queue exhausted, restarting from beginning")
                        playbackViewModel.playSceneQueue()
                    } else if (playbackViewModel.currentSceneIndex > 0) {
                        Log.i(TAG, "playButton: SCENE_READY — resuming from index ${playbackViewModel.currentSceneIndex}")
                        playbackViewModel.resumeFromCurrentScene()
                    } else {
                        playbackViewModel.playSceneQueue()
                    }
                }
                phase == PlayerPhase.IDLE && playbackViewModel.sceneQueueSize > 0 -> {
                    Log.i(TAG, "playButton: IDLE with ${playbackViewModel.sceneQueueSize} chunks — starting playback")
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
            playbackViewModel.setVideoEnabled(isChecked)
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
                        val hasChunks = playbackViewModel.sceneQueueSize > 0
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
                            && state.chunkSequence <= playbackViewModel.lastProcessedSceneSequence) {
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
                            // Do NOT reset hasDisplayedCover — once a cover was ever shown,
                            // it remains the definitive fallback background even if this
                            // particular state emission has coverImage=null momentarily.
                            if (!hasDisplayedCover) {
                                showCurtains()
                            } else {
                                // Cover was previously loaded — keep it visible as fallback
                                b.curtainsImage.visibility = View.GONE
                                if (b.coverImage.drawable != null) {
                                    b.coverImage.visibility = View.VISIBLE
                                }
                                stopPulse()
                            }
                        }

                        if ((state.phase == PlayerPhase.SCENE_READY || state.phase == PlayerPhase.GENERATING)
                            && prevPhase == PlayerPhase.PLAYING) {
                            stopAll()
                        }
                        prevPhase = state.phase

                        if (state.phase == PlayerPhase.IDLE && playbackViewModel.bookId.isBlank() && generateViewModel.bookId.isBlank()) {
                            hasDisplayedCover = false
                            isInCurtainsState = false
                            stopAll()
                            b.coverImage.setImageBitmap(null)
                            b.coverImage.visibility = View.GONE
                            b.fullscreenButton.visibility = View.GONE
                            // Show theatre curtains as fallback background.
                            // stopAll() hides curtains (to avoid bleed-through behind
                            // transparent cover margins), so re-show them explicitly.
                            showCurtains()
                            stopPulse()  // IDLE — static curtains, no pulse
                        }

                        if (state.phase == PlayerPhase.PLAYING && state.chunkSequence > playbackViewModel.lastProcessedSceneSequence) {
                            playbackViewModel.lastProcessedSceneSequence = state.chunkSequence
                            val audio = playbackViewModel.pendingSceneAudio
                            val ius = playbackViewModel.pendingSceneIuSequence
                            if (audio != null && audio.isNotEmpty()) {
                                handleChunk(audio, playbackViewModel.pendingSceneVideo, playbackViewModel.pendingSceneIuSequence)
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
                            if (playbackViewModel.bookId.isBlank() && generateViewModel.bookId.isBlank()) {
                                // No book opened in either ViewModel
                                b.placeholderText.text = getString(R.string.play_placeholder)
                                b.placeholderText.visibility = View.VISIBLE
                            } else if (playbackViewModel.bookId.isBlank()) {
                                // Book opened in GenVM but Player not yet initialized
                                b.placeholderText.text = getString(R.string.play_placeholder_no_generation)
                                b.placeholderText.visibility = View.VISIBLE
                            } else {
                                // Player initialized, show generate hint
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
                            PlayerPhase.GENERATING, PlayerPhase.DOWNLOADING -> b.statusText.text = getString(R.string.play_loading)
                            PlayerPhase.SCENE_READY -> b.statusText.text = getString(R.string.play_ready)
                            PlayerPhase.PLAYING -> b.statusText.text = getString(R.string.play_playing)
                            PlayerPhase.IDLE -> b.statusText.text = when {
                                playbackViewModel.bookId.isBlank() && generateViewModel.bookId.isBlank() -> getString(R.string.empty_state)
                                playbackViewModel.bookId.isBlank() -> getString(R.string.play_placeholder_no_generation)
                                else -> getString(R.string.empty_state_book_loaded)
                            }
                            PlayerPhase.PAUSED -> b.statusText.text = getString(R.string.play_paused)
                            PlayerPhase.IMPORTING_TXT -> b.statusText.text = getString(R.string.play_loading)
                        }

                        // Single source of truth: button matches state.phase.
                        // PLAYING = Pause button, everything else = Play button.
                        val showPause = state.phase == PlayerPhase.PLAYING
                        b.playButton.text = if (showPause) getString(R.string.play_pause) else getString(R.string.play_play)
                        if (showPause) b.playButton.setIconResource(R.drawable.ic_pause) else b.playButton.setIconResource(R.drawable.ic_play)
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

        playbackViewModel.persistedImage = null

        // Compute the target position on the CANONICAL timeline (audio/start_ms)
        // BEFORE touching any player. The whole-scene video is aligned to the
        // audio timeline at merge time (group clips are trimmed to their exact
        // audio frame counts), so BOTH the audio and the video seek to the same
        // position — the final muxed product has a single timeline. Priority:
        // externally selected unit → rotation-resume position.
        val targetUnit = SharedPositionManager.current.value.unitIndex
        val seekToUnit = if (targetUnit > 0 && !iuSequence.isNullOrEmpty() && targetUnit < iuSequence.size) targetUnit else 0
        val pendingRotMs = playbackViewModel.pendingSeekPositionMs
        val seekMs = when {
            seekToUnit > 0 && !iuSequence.isNullOrEmpty() -> unitStartMs(iuSequence, seekToUnit)
            pendingRotMs > 0 -> pendingRotMs
            else -> 0L
        }
        if (seekMs > 0) playbackViewModel.pendingSeekPositionMs = -1

        if (seekToUnit > 0 && !iuSequence.isNullOrEmpty()) {
            val target = iuSequence[seekToUnit]
            Log.i(TAG, "UNIT-SEEK unit=${target.unitId} index=$seekToUnit startMs=${target.startMs} seekMs=$seekMs")
            setPlayerDebug("seek→unit ${seekToUnit + 1} target ${seekMs}ms")
        }

        // TEMPORARY diagnostics: one SEEK_REQUEST per Navigator/Edit unit tap.
        if (playbackViewModel.debugSeekPending && !iuSequence.isNullOrEmpty()) {
            emitSeekRequest(seekToUnit, seekMs, iuSequence)
        }

        // An external unit tap (or rotation resume) is an EXPLICIT video target
        // — including 0 for unit 1 — so the video is seeked to it directly
        // instead of the audio-sync fallback (web parity).
        val explicitVideoSeek = playbackViewModel.explicitVideoSeekPending || pendingRotMs > 0
        playbackViewModel.explicitVideoSeekPending = false
        if (video != null) playVideoOverlay(video, seekMs, explicitVideoSeek)

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
            if (currentPlayer == null) {
                // Player creation failed (corrupted or empty file).
                // Reset the phase so the UI shows a Play button and the user can retry.
                Log.w(TAG, "handleChunk: createPlayer returned null — resetting to SCENE_READY")
                playbackViewModel.handleNullPlayer(playbackViewModel.getCurrentSceneKey() ?: "unknown")
                return
            }
            currentPlayer?.setOnCompletionListener { onTrackEnd() }
            if (pendingLoad) {
                pendingLoad = false
                isPaused = true
                playbackViewModel.pausePlayback()
                Log.i(TAG, "pending load — player stays Prepared")
            } else {
                currentPlayer?.start()
            }
            if (seekMs > 0) {
                Log.i(TAG, "audio seek to unit ${seekToUnit} at ${seekMs}ms")
                currentPlayer?.seekTo(seekMs.toInt())
                // TEMPORARY diagnostics: verify the AUDIO actually landed on the
                // target (the video-side logs were always exact; audio was the
                // only unmeasured component).
                viewLifecycleOwner.lifecycleScope.launch {
                    delay(300)
                    val aPos = runCatching { currentPlayer?.currentPosition?.toLong() }.getOrNull() ?: -1L
                    Log.i(TAG, "audio pos after seek: ${aPos}ms (target ${seekMs}ms)")
                    setPlayerDebug("audio→${aPos}ms (tgt ${seekMs}ms)")
                    repository.postVideoSeekDebug(mapOf(
                        "event" to "AUDIO_SEEK_RESULT",
                        "unit_index" to seekToUnit,
                        "seek_target" to seekMs,
                        "audio_after" to aPos,
                        "client_ts" to System.currentTimeMillis(),
                    ))
                }
            }
            Log.i(TAG, "first MediaPlayer started at unit ${seekToUnit}")
            if (currentPlayer != null) {
                startIuCycling()
            } else if (!iuSequence.isNullOrEmpty()) {
                Log.i(TAG, "no audio available — timer-based IU cycling")
                startSilentIuCycling()
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

    /** TEMPORARY diagnostics: SEEK_REQUEST — what the player was asked to do
     *  for this unit tap (source identity, unit timing, computed seek target,
     *  video position/file right before the seek). Posted to the backend
     *  debug log; the SEEK_RESULT is emitted from onPrepared. */
    private fun emitSeekRequest(unitIndex: Int, seekMs: Long, iuSequence: List<IuImageItem>) {
        playbackViewModel.debugSeekPending = false
        val pos = SharedPositionManager.current.value
        val target = iuSequence.getOrNull(unitIndex)
        val next = iuSequence.getOrNull(unitIndex + 1)
        val unitStart = target?.startMs
        val unitEnd = next?.startMs ?: unitStart?.let { it + target.durationMs.coerceAtLeast(0L) }
        val record = linkedMapOf<String, Any?>(
            "event" to "SEEK_REQUEST",
            "seek_id" to "${System.currentTimeMillis()}-${debugSeq++}",
            "client_ts" to System.currentTimeMillis(),
            "book_id" to playbackViewModel.bookId,
            "build_id" to playbackViewModel.buildId,
            "chapter_id" to pos.chapterId,
            "scene_id" to pos.sceneId,
            "unit_id" to (target?.unitId ?: pos.unitId),
            "unit_index" to unitIndex,
            "unit_start" to (unitStart ?: -1L),
            "unit_end" to (unitEnd ?: -1L),
            "seek_target" to seekMs,
            "video_before" to debugVideoBeforeMs,
            "video_file_before" to (debugVideoFileBefore ?: "none"),
        )
        debugVideoBeforeMs = -1L
        debugVideoFileBefore = null
        pendingDebugRecord = record
        Log.i(TAG, "SEEK_REQUEST $record")
        viewLifecycleOwner.lifecycleScope.launch { repository.postVideoSeekDebug(record) }
    }

    /** TEMPORARY diagnostics: grab the ACTUAL frame displayed on the video
     *  surface (PixelCopy) after a unit seek and post it to the backend
     *  (event=FRAME_CAPTURE). The server compares it against the expected
     *  clip frame at the seek target — directly answers whether the screen
     *  shows the right content. API 26+ only (guard below). */
    private fun captureVideoFrame(seekId: String?, unitIndex: Int?, seekTargetMs: Long?) {
        if (Build.VERSION.SDK_INT < 26) return
        val b = binding ?: return
        if (b.videoSurface.visibility != View.VISIBLE) return
        val sv = b.videoSurface
        if (sv.width <= 0 || sv.height <= 0) return
        val bitmap = Bitmap.createBitmap(sv.width, sv.height, Bitmap.Config.ARGB_8888)
        try {
            PixelCopy.request(sv, bitmap, { result ->
                if (result == PixelCopy.SUCCESS) {
                    val baos = ByteArrayOutputStream()
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 80, baos)
                    val b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
                    Log.i(TAG, "FRAME_CAPTURE seek_id=$seekId unit=$unitIndex target=${seekTargetMs}ms bytes=${baos.size()}")
                    viewLifecycleOwner.lifecycleScope.launch {
                        repository.postVideoSeekDebug(mapOf(
                            "event" to "FRAME_CAPTURE",
                            "seek_id" to (seekId ?: "frame"),
                            "unit_index" to (unitIndex ?: -1),
                            "seek_target" to (seekTargetMs ?: -1L),
                            "w" to sv.width,
                            "h" to sv.height,
                            "frame_b64" to b64,
                            "client_ts" to System.currentTimeMillis(),
                        ))
                    }
                } else {
                    Log.w(TAG, "PixelCopy failed: $result")
                }
                if (!bitmap.isRecycled) bitmap.recycle()
            }, Handler(Looper.getMainLooper()))
        } catch (e: Exception) {
            Log.w(TAG, "captureVideoFrame failed: ${e.message}")
        }
    }

    /** TEMPORARY diagnostics: video vs audio position lock check. If both
     *  move together (video ≈ audio ≈ target + elapsed) after a unit seek,
     *  the player/seek is provably fine and any visual mismatch is a
     *  rendering (surface/buffer) issue, not a position issue. */
    private fun logLockPositions(tag: String, seekId: String? = null, unitIndex: Int? = null, seekTargetMs: Long? = null) {
        val vp = videoPlayer
        val ap = currentPlayer
        val vPos = runCatching { vp?.currentPosition?.toLong() }.getOrNull() ?: -1L
        val aPos = runCatching { ap?.currentPosition?.toLong() }.getOrNull() ?: -1L
        val delta = if (vPos >= 0 && aPos >= 0) (vPos - aPos) else Long.MIN_VALUE
        Log.i(TAG, "LOCK-CHECK $tag: video=${vPos}ms audio=${aPos}ms delta=${if (delta == Long.MIN_VALUE) "n/a" else delta}ms")
        setPlayerDebug("LOCK $tag: v ${vPos}ms a ${aPos}ms Δ${if (delta == Long.MIN_VALUE) "?" else delta}ms")
        // Also POST to the backend debug log so the audio↔video lock can be
        // checked without logcat.
        viewLifecycleOwner.lifecycleScope.launch {
            repository.postVideoSeekDebug(mapOf(
                "event" to "LOCK_CHECK",
                "seek_id" to (seekId ?: "none"),
                "unit_index" to (unitIndex ?: -1),
                "seek_target" to (seekTargetMs ?: -1L),
                "tag" to tag,
                "video_pos" to vPos,
                "audio_pos" to aPos,
                "delta_ms" to (if (delta == Long.MIN_VALUE) null else delta),
                "client_ts" to System.currentTimeMillis(),
            ))
        }
    }

    /** TEMPORARY diagnostics: append a (t, video, audio, playing) snapshot to
     *  the active seek trace (no-op unless a trace is being collected). */
    private fun traceSnap(tag: String) {
        val samples = debugTraceSamples ?: return
        val vp = videoPlayer
        val ap = currentPlayer
        val v = runCatching { vp?.currentPosition?.toLong() }.getOrNull() ?: -1L
        val a = runCatching { ap?.currentPosition?.toLong() }.getOrNull() ?: -1L
        val p = runCatching { vp?.isPlaying }.getOrNull() ?: false
        samples.add(mapOf("t" to System.currentTimeMillis(), "tag" to tag, "v" to v, "a" to a, "playing" to p))
        Log.i(TAG, "TRACE $tag v=${v}ms a=${a}ms playing=$p")
    }

    /** TEMPORARY diagnostics: SEEK_RESULT — where the video actually landed
     *  once the async seek settled (probed ~300ms after onPrepared). */
    private fun emitSeekResult(videoAfterMs: Long, videoDurationMs: Long, videoFile: String?) {
        val req = pendingDebugRecord ?: return
        pendingDebugRecord = null
        val record = linkedMapOf<String, Any?>(
            "event" to "SEEK_RESULT",
            "seek_id" to req["seek_id"],
            "client_ts" to System.currentTimeMillis(),
            "book_id" to req["book_id"],
            "build_id" to req["build_id"],
            "chapter_id" to req["chapter_id"],
            "scene_id" to req["scene_id"],
            "unit_id" to req["unit_id"],
            "unit_index" to req["unit_index"],
            "unit_start" to req["unit_start"],
            "seek_target" to req["seek_target"],
            "video_before" to req["video_before"],
            "video_after" to videoAfterMs,
            "video_duration" to videoDurationMs,
            "video_file" to (videoFile ?: "none"),
        )
        Log.i(TAG, "SEEK_RESULT $record")
        viewLifecycleOwner.lifecycleScope.launch { repository.postVideoSeekDebug(record) }
    }

    /** Start offset (ms) of a unit inside the whole-scene timeline (audio =
     *  start_ms, the canonical position — the video is aligned to the same
     *  timeline at merge time). Falls back to the cumulative durationMs sum for
     *  legacy storyboards without timestamps. */
    private fun unitStartMs(ius: List<IuImageItem>, unitIndex: Int): Long {
        val startMs = ius.getOrNull(unitIndex)?.startMs
        if (startMs != null && startMs > 0) return startMs
        var seekMs = 0L
        for (i in 0 until unitIndex) seekMs += ius[i].durationMs
        return seekMs
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
                    chunkId = playbackViewModel.getCurrentSceneKey(),
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
            b.resultImage.setImageBitmap(null)
            b.resultImage.visibility = View.INVISIBLE
            b.placeholderText.visibility = View.INVISIBLE
            // Show cover as background fallback + "Не сгенерировано" overlay on top
            val cover = playbackViewModel.uiState.value.coverImage
            if (cover != null) {
                b.coverImage.setImageBitmap(cover)
                b.coverImage.visibility = View.VISIBLE
            }
            b.iuMissingOverlay.visibility = View.VISIBLE
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
            // Show cover as background fallback + overlay on top
            val cover = playbackViewModel.uiState.value.coverImage
            if (cover != null) {
                b.coverImage.setImageBitmap(cover)
                b.coverImage.visibility = View.VISIBLE
            }
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

                // Map audio position → unit index on the same timeline the seek
                // uses: server start_ms boundaries when present (handles gaps the
                // user created in Edit), else cumulative durationMs (legacy).
                var idx = 0
                if (ius.firstOrNull()?.startMs != null) {
                    idx = ius.indexOfLast { (it.startMs ?: 0L) <= pos }
                    if (idx < 0) idx = 0
                    if (idx >= ius.size) idx = ius.size - 1
                } else {
                    var cumulative = 0L
                    for ((i, iu) in ius.withIndex()) {
                        cumulative += iu.durationMs
                        if (pos < cumulative) {
                            idx = i
                            break
                        }
                    }
                    if (idx >= ius.size) idx = ius.size - 1
                }

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
                        chunkId = playbackViewModel.getCurrentSceneKey(),
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
            } else {
                // No cover available — fall back to theater curtains
                showCurtains()
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
                setOnErrorListener { _, what, extra ->
                    Log.e(TAG, "MediaPlayer (next) error: what=$what extra=$extra")
                    isPaused = false
                    playbackViewModel.handlePlaybackError("Audio preload error (what=$what, extra=$extra)")
                    true
                }
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
                setOnErrorListener { _, what, extra ->
                    Log.e(TAG, "MediaPlayer error: what=$what extra=$extra")
                    isPaused = false
                    playbackViewModel.handlePlaybackError("Audio playback error (what=$what, extra=$extra)")
                    true // return true = error handled, no callback
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "createPlayer failed: ${e.message}")
            null
        }
    }

    private fun writeTemp(bytes: ByteArray): File {
        val chunkId = playbackViewModel.getCurrentSceneKey()
        if (chunkId != null) {
            val cached = repository.cacheAudioFile(chunkId, bytes)
            if (cached != null) return cached
        }
        val file = File(requireContext().cacheDir, "chunk-${System.currentTimeMillis()}.mp3")
        file.writeBytes(bytes)
        return file
    }

    private fun playVideoOverlay(bytes: ByteArray, startSeekMs: Long = 0L, explicitSeek: Boolean = false) {
        try {
            pendingVideoTargetMs = if (explicitSeek) startSeekMs else -1L
            videoPlayer?.release()
            videoPlayer = null
            currentVideoFile?.delete()
            val chunkId = playbackViewModel.getCurrentSceneKey()
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
                    setOnSeekCompleteListener {
                        traceSnap("seek_complete pos=${runCatching { currentPosition }.getOrNull()}ms")
                    }
                    setOnPreparedListener {
                        updateLayers()
                        var seekLandTarget = 0L
                        if (explicitSeek) {
                            // External navigation / rotation resume: seek to the unit's
                            // start on the VIDEO timeline explicitly — including 0 for
                            // unit 1 / scene start. Reading currentPlayer.currentPosition
                            // here is racy — the audio player may not exist yet or its
                            // own seekTo may not have landed — which left the video at 0
                            // or mid-scene.
                            val durMs = try { duration.toLong() } catch (e: Exception) { -1L }
                            val target = if (durMs > 0) startSeekMs.coerceAtMost((durMs - 100).coerceAtLeast(0)) else startSeekMs
                            seekLandTarget = target
                            // TEMPORARY diagnostics: begin the high-frequency trace
                            // (video+audio position every 50ms for ~1.5s) and post it
                            // as one SEEK_TRACE record at the end.
                            val dbgReqT = pendingDebugRecord
                            val traceSeekId = dbgReqT?.get("seek_id") as? String
                            val traceUnitIndex = dbgReqT?.get("unit_index") as? Int
                            val traceTarget = dbgReqT?.get("seek_target") as? Long
                            debugTraceSamples = mutableListOf()
                            traceSnap("onPrepared target=${target}ms")
                            viewLifecycleOwner.lifecycleScope.launch {
                                val t0 = System.currentTimeMillis()
                                while (System.currentTimeMillis() - t0 < 1500) {
                                    delay(50)
                                    traceSnap("sample")
                                }
                                val samples = debugTraceSamples
                                debugTraceSamples = null
                                if (samples != null) {
                                    repository.postVideoSeekDebug(mapOf(
                                        "event" to "SEEK_TRACE",
                                        "seek_id" to (traceSeekId ?: "none"),
                                        "unit_index" to (traceUnitIndex ?: -1),
                                        "seek_target" to (traceTarget ?: -1L),
                                        "samples" to samples,
                                        "client_ts" to System.currentTimeMillis(),
                                    ))
                                }
                            }
                            if (target > 0) {
                                traceSnap("seekTo(${target})")
                                seekTo(target.toInt())
                            }
                            Log.i(TAG, "video seek applied: target=${target}ms (video dur=${durMs}ms)")
                            // Delayed probes: report the position the player actually
                            // landed on after the async seek settles — SEEK_RESULT at
                            // +300ms, then video-vs-audio lock checks at +1.5s and +4s
                            // to detect any later position override / desync.
                            // Snapshot the seek context BEFORE emitSeekResult consumes
                            // pendingDebugRecord, so the frame capture can be matched
                            // to this seek (unit, target position).
                            val dbgReq = pendingDebugRecord
                            val capSeekId = dbgReq?.get("seek_id") as? String
                            val capUnitIndex = dbgReq?.get("unit_index") as? Int
                            val capSeekTarget = dbgReq?.get("seek_target") as? Long
                            viewLifecycleOwner.lifecycleScope.launch {
                                delay(300)
                                try {
                                    val actual = currentPosition.toLong()
                                    Log.i(TAG, "video pos after seek: ${actual}ms")
                                    emitSeekResult(actual, durMs, file.name)
                                    setPlayerDebug("video→${actual}ms (tgt ${startSeekMs}ms)")
                                } catch (e: IllegalStateException) {
                                    Log.w(TAG, "video pos probe failed: ${e.message}")
                                }
                                delay(1200)
                                logLockPositions("after seek +1.5s", capSeekId, capUnitIndex, capSeekTarget)
                                captureVideoFrame(capSeekId, capUnitIndex, capSeekTarget)
                                delay(2500)
                                logLockPositions("after seek +4s", capSeekId, capUnitIndex, capSeekTarget)
                                // Second capture: verify the surface eventually
                                // shows the seeked frame (rendering delay check).
                                delay(2000)
                                captureVideoFrame(capSeekId, capUnitIndex, capSeekTarget)
                            }
                        } else {
                            // Normal playback: the video usually finishes preparing after
                            // the audio is already playing — sync to the audio position.
                            // seekTo is ASYNC and must not race start() (a start()
                            // before the seek lands drops the seek and the video plays
                            // from 0). Confirm the seek landed, then start.
                            val ap = currentPlayer?.currentPosition ?: 0
                            if (ap > 0) {
                                seekTo(ap)
                                viewLifecycleOwner.lifecycleScope.launch {
                                    var waited = 0
                                    while (waited < 1500) {
                                        delay(50)
                                        waited += 50
                                        val cur = runCatching { currentPosition.toLong() }.getOrNull() ?: -1L
                                        if (cur >= ap) break
                                    }
                                    try { if (!isPlaying) start() } catch (e: IllegalStateException) {
                                        Log.w(TAG, "video sync start failed: ${e.message}")
                                    }
                                }
                            } else {
                                start()
                            }
                        }
                        pendingVideoTargetMs = -1L
                        if (pendingLoad || isPaused) {
                            Log.i(TAG, "video prepared — pending load, staying paused")
                            // ROOT-CAUSE FIX (unit seek): force the seeked frame to
                            // render onto the surface WITHOUT racing the async seek.
                            // A paused MediaPlayer does NOT push a new frame, so the
                            // surface keeps showing the PREVIOUS player's stale frame
                            // (previous unit's stop-frame) — the "one-unit shift" the
                            // user sees even though currentPosition is exact. But the
                            // OLD code called start() immediately after seekTo(): on
                            // many devices the start() raced the in-flight seek, DROPPED
                            // it, and the video played from 0 / the stale frame until
                            // the lock loop re-seeked — the "wrong position first, then
                            // polling corrects" symptom. Now: poll while PAUSED until
                            // currentPosition confirms the seek landed (re-issuing the
                            // seek if it was dropped), then briefly start()+pause() to
                            // push exactly the seeked frame.
                            if (explicitSeek) {
                                try {
                                    val targetPos = seekLandTarget
                                    viewLifecycleOwner.lifecycleScope.launch {
                                        var waited = 0
                                        while (waited < 2000) {
                                            delay(50)
                                            waited += 50
                                            val cur = runCatching { currentPosition.toLong() }.getOrNull() ?: -1L
                                            if (cur >= 0 && (targetPos <= 0 || cur >= targetPos)) break
                                            if (targetPos > 0 && waited % 400 == 0) {
                                                // Seek hasn't landed yet — re-issue it
                                                // while still paused (safe; no start()
                                                // racing it).
                                                try { seekTo(targetPos.toInt()) } catch (_: IllegalStateException) {}
                                            }
                                        }
                                        delay(100) // let one full frame render
                                        // Seek confirmed landed (or target 0) — now
                                        // start() renders the seeked frame, then pause.
                                        traceSnap("peek_start target=${targetPos}")
                                        try { if (!isPlaying) start() } catch (e: IllegalStateException) {
                                            Log.w(TAG, "peek-render start failed: ${e.message}")
                                        }
                                        delay(120)
                                        traceSnap("peek_pause")
                                        try {
                                            if (isPaused) pause()
                                        } catch (e: IllegalStateException) {
                                            Log.w(TAG, "peek-render pause failed: ${e.message}")
                                        }
                                        Log.i(TAG, "peek-render done at ${runCatching { currentPosition.toLong() }.getOrNull()}ms (target ${targetPos}ms)")
                                    }
                                } catch (e: IllegalStateException) {
                                    Log.w(TAG, "peek-render failed: ${e.message}")
                                }
                            }
                        } else {
                            start()
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
        // While a unit-navigation seek is in flight the audio currentPosition may
        // still report 0 (seekTo is asynchronous) — use the explicit target so the
        // video is not dragged back to the scene start.
        val pos: Long = if (pendingVideoTargetMs >= 0) pendingVideoTargetMs else (currentPlayer?.currentPosition ?: 0).toLong()
        val vp = videoPlayer ?: return
        if (pos < 0) return
        try {
            traceSnap("syncVideoFrame seek=${pos}ms")
            vp.seekTo(pos.toInt())
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

    /** TEMPORARY diagnostics: show a one-line status in the player UI (the
     *  user has no logcat) — mirrors the seek/lock messages. */
    private fun setPlayerDebug(msg: String) {
        val b = binding ?: return
        b.debugText.text = msg
        b.debugText.visibility = View.VISIBLE
        Log.i(TAG, "DBG $msg")
    }    private fun pausePlayback() {
        Log.i(TAG, "pausePlayback")
        currentPlayer?.pause()
        try {
            videoPlayer?.pause()
        } catch (e: IllegalStateException) {
            Log.w(TAG, "videoPlayer pause failed (state issue): ${e.message}")
        }
        isPaused = true
        // Update ViewModel state — this drives the button/status via state.phase
        playbackViewModel.pausePlayback()
    }

    private fun resumePlayback() {
        Log.i(TAG, "resumePlayback")
        pendingVideoSyncJob?.cancel()

        // If content was regenerated while paused, the old MediaPlayer has stale
        // audio. Release it so the ViewModel's resumePlayback → playNext →
        // fetchSceneData path creates a brand-new player with fresh content.
        if (playbackViewModel.needsContentRefresh) {
            Log.i(TAG, "resumePlayback: content changed, releasing stale player")
            currentPlayer?.runCatching { stop() }
            currentPlayer?.release()
            currentPlayer = null
            currentFile?.delete()
            currentFile = null
            nextPlayer?.release()
            nextPlayer = null
            nextFile?.delete()
            nextFile = null
            videoPlayer?.release()
            videoPlayer = null
            currentVideoFile?.delete()
            currentVideoFile = null
            isPaused = false
            playbackViewModel.resumePlayback()
            return
        }

        showCurrentIu()
        currentPlayer?.start()
        traceSnap("resumePlayback video-start")
        // If the video is still carrying an unconsumed unit-navigation target,
        // apply it before starting — otherwise it would resume from a stale
        // (possibly scene-start) position.
        try {
            if (videoPlayer != null && pendingVideoTargetMs >= 0) {
                videoPlayer?.seekTo(pendingVideoTargetMs.toInt())
                pendingVideoTargetMs = -1L
            }
        } catch (e: IllegalStateException) {
            Log.w(TAG, "videoPlayer pending-seek failed (state issue): ${e.message}")
        }
        try {
            if (videoPlayer != null && !videoPlayer!!.isPlaying) {
                videoPlayer?.start()
            }
        } catch (e: IllegalStateException) {
            Log.w(TAG, "videoPlayer resume failed (state issue): ${e.message}")
        }
        updateLayers()
        isPaused = false
        // Update ViewModel state — restore PLAYING phase
        playbackViewModel.resumePlayback()
        startIuCycling()
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
        pendingVideoTargetMs = -1L
        pendingDebugRecord = null
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
            // Always hide curtains when stopping — they should never be visible
            // behind the cover image (coverImage uses centerInside which may have
            // transparent margins, revealing curtains underneath).
            b.curtainsImage.visibility = View.GONE
            isInCurtainsState = false
            stopPulse()
            b.videoSurface.visibility = View.INVISIBLE
            if (b.coverImage.drawable != null) {
                b.coverImage.visibility = View.VISIBLE
            } else {
                // No cover available — show curtains as fallback to avoid blank screen
                showCurtains()
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
