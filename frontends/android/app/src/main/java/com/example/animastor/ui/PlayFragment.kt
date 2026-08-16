package com.example.animastor.ui

import android.graphics.Bitmap
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.ExoPlayer
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
    private var videoPlayer: ExoPlayer? = null
    private var isPaused = false
    // Buffer gate: video is a network stream while audio is a local file; on a
    // slow connection the video underruns and would freeze while the audio
    // keeps playing (desync). While true, the whole player is paused into
    // "Загрузка…" (BUFFERING) and resumes with a resync on BUFFERING_END.
    private var videoBuffering = false
    // Whether the whole-scene video has rendered its first frame and may cover
    // the storyboard. While false, the storyboard stays on TOP and the surface
    // (which would otherwise show black until the first frame decodes) is kept
    // alive but behind it — no more "video starts from black" on unit seek /
    // layer toggle. Set true only after the video actually pushed a frame.
    private var videoReadyToShow = false
    // Bumped every time the persistent player is re-targeted (setMediaItem /
    // new scene). The Player.Listener ignores errors that arrive after a newer
    // target was set — a stale item's error must not run the storyboard
    // fallback against the current item. With a single long-lived ExoPlayer
    // this is the only "generation" guard needed (no create/destroy race).
    private var videoPlayerGeneration = 0L
    // Generation of the item the listener is currently servicing (set together
    // with videoPlayerGeneration in playVideoFromUrl).
    private var videoCurrentGen = 0L
    // Per-item ExoPlayer state (all reset in playVideoFromUrl):
    // - explicitItem: the item was targeted at a unit boundary (seek) rather
    //   than a live join;
    // - hasBeenReadyForItem: STATE_READY reached for the current item — only
    //   then does STATE_BUFFERING mean a real underrun (buffer gate), not the
    //   initial load;
    // - joinHandled: the one-time "join the live audio position" re-position
    //   was done for a join-mode item;
    // - pendingVideoPlay: the user pressed Play while the video was still
    //   preparing — honored (audio + video start together from the unit) once
    //   STATE_READY arrives. The play intent lives here instead of being
    //   thrown away by a start() on a not-yet-ready player.
    private var explicitItem = false
    private var hasBeenReadyForItem = false
    private var joinHandled = false
    private var pendingVideoPlay = false
    // Whether the video SurfaceView ever attached a surface. Hiding a live
    // surface destroys it, so once a video has played we keep the surface
    // alive (behind the storyboard) across the async video-delivery gap in
    // handleChunk — the upcoming seek's player then attaches to a live surface
    // instead of a dead one (black / server-died errors).
    private var videoSurfaceAlive = false
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
    private var videoSpeedSyncJob: Job? = null

    private fun checkPendingExternalSeek() {
        if (playbackViewModel.pendingExternalSeek != null) {
            if (isHidden) return
            Log.i(TAG, "checkPendingExternalSeek: executing seek to ${playbackViewModel.pendingExternalSeek}")
            pendingLoad = true
            stopAll(keepSurface = true)
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
                        pendingLoad = true
                        stopAll(keepSurface = true)
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

    /** On-demand whole-scene video: attach + seek when the bytes arrive for the
     *  CURRENT scene with the video layer on (stale / layer-off deliveries drop).
     *  The video is fetched by ensureSceneVideo — never as part of the scene
     *  bundle — so preloaded scenes and off-layer scenes cost zero video traffic. */
    private fun observeVideoDelivery() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                playbackViewModel.videoDelivery.collect { delivery ->
                    if (!isAdded) return@collect
                    if (delivery.sceneKey != playbackViewModel.getCurrentSceneKey()) return@collect
                    if (binding?.layerVideo?.isChecked == false) return@collect
                    playVideoOverlay(delivery.url, delivery.seekMs, delivery.explicitSeek)
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

        // ONE video player for the whole Player-screen life (Media3 ExoPlayer):
        // created once, re-targeted per scene via setMediaItem — never
        // create/destroy per action (that cycle was the source of the
        // readiness/race bugs). Released in onDestroyView. Guarded: a fragment
        // view can be recreated (onDestroyView nulls the player first).
        if (videoPlayer == null) {
            videoPlayer = createVideoPlayer()
        }

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
                phase == PlayerPhase.BUFFERING -> {
                    // Tap during "Загрузка…" aborts the buffer wait — plain pause.
                    pausePlayback()
                }
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
            videoPlayer?.volume = currentVolume
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
            if (isChecked) {
                // Layer re-enabled: only rebuild when the player is actually
                // GONE (stream error / scene change / never requested). A live
                // player is merely covered by the storyboard and comes back
                // INSTANTLY via updateLayers — rebuilding it here would drop the
                // buffered video and restart from black (the "layer toggle kills
                // the video" bug).
                if (videoPlayer == null || !videoReadyToShow) {
                    val cur = (currentPlayer?.currentPosition ?: 0).toLong()
                    playbackViewModel.getCurrentSceneKey()?.let { sceneKey ->
                        playbackViewModel.ensureSceneVideo(sceneKey, cur, explicitSeek = false)
                    }
                }
            }
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
        observeVideoDelivery()
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
                        val buttonEnabled = state.phase == PlayerPhase.SCENE_READY || state.phase == PlayerPhase.PLAYING || state.phase == PlayerPhase.BUFFERING || hasChunks
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

                        val loading = state.phase == PlayerPhase.LOADING_BOOK || state.phase == PlayerPhase.DOWNLOADING || state.phase == PlayerPhase.BUFFERING
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
                            PlayerPhase.BUFFERING -> b.statusText.text = getString(R.string.play_loading)
                            PlayerPhase.IDLE -> b.statusText.text = when {
                                playbackViewModel.bookId.isBlank() && generateViewModel.bookId.isBlank() -> getString(R.string.empty_state)
                                playbackViewModel.bookId.isBlank() -> getString(R.string.play_placeholder_no_generation)
                                else -> getString(R.string.empty_state_book_loaded)
                            }
                            PlayerPhase.PAUSED -> b.statusText.text = getString(R.string.play_paused)
                            PlayerPhase.IMPORTING_TXT -> b.statusText.text = getString(R.string.play_loading)
                        }

                        // Single source of truth: button matches state.phase.
                        // PLAYING/BUFFERING = Pause button, everything else = Play.
                        val showPause = state.phase == PlayerPhase.PLAYING || state.phase == PlayerPhase.BUFFERING
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
        // The video only covers the storyboard once it has actually rendered a
        // frame (videoReadyToShow). Until then the surface would be black, so
        // the storyboard stays on top — the user sees the unit's image while
        // the stream prepares instead of a black hole.
        val showVideo = b.layerVideo.isChecked && videoPlayer != null && videoReadyToShow
        if (showVideo) {
            if (b.videoSurface.visibility != View.VISIBLE) {
                b.videoSurface.visibility = View.VISIBLE
            }
            // Video on top of the storyboard. IMPORTANT: the SurfaceView is
            // never hidden once a player exists — hiding a SurfaceView destroys
            // its surface and kills the MediaPlayer (the root cause of every
            // "video doesn't come back / desyncs" layer bug). Web parity: the
            // video element keeps playing under display:none, so here the video
            // player keeps playing behind the storyboard and re-shows already
            // synced to the audio.
            b.videoSurface.bringToFront()
        } else if (videoPlayer != null) {
            // Layer off (or video still preparing): keep the surface ALIVE and
            // put an opaque view on top of its hole instead of hiding it.
            if (b.videoSurface.visibility != View.VISIBLE) {
                b.videoSurface.visibility = View.VISIBLE
            }
            if (imageOn) {
                b.resultImage.bringToFront()
            } else if (b.coverImage.drawable != null) {
                b.coverImage.visibility = View.VISIBLE
                b.coverImage.bringToFront()
            } else {
                b.curtainsImage.bringToFront()
            }
        } else {
            // No player yet — the async video-delivery gap during scene change /
            // unit seek (handleChunk runs before the delivery arrives). If this
            // surface ever rendered video, KEEP it alive (hiding it destroys the
            // surface and the upcoming seek's player would attach to a dead
            // surface: black + server-died errors), but keep the storyboard on
            // top so the user never sees black.
            if (videoSurfaceAlive) {
                b.videoSurface.visibility = View.VISIBLE
            } else {
                b.videoSurface.visibility = View.INVISIBLE
            }
            if (imageOn) {
                b.resultImage.bringToFront()
            } else if (b.coverImage.drawable != null) {
                b.coverImage.visibility = View.VISIBLE
                b.coverImage.bringToFront()
            } else {
                b.curtainsImage.bringToFront()
            }
        }
        // Keep UI overlays above the flipped media layers.
        b.previewOverlay.bringToFront()
        b.subtitleText.bringToFront()
        b.fullscreenButton.bringToFront()
        anchorFullscreenToImage()
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
        }

        // An external unit tap (or rotation resume) is an EXPLICIT video target
        // — including 0 for unit 1 — so the video is seeked to it directly
        // instead of the audio-sync fallback (web parity).
        val explicitVideoSeek = playbackViewModel.explicitVideoSeekPending || pendingRotMs > 0
        playbackViewModel.explicitVideoSeekPending = false
        // Whole-scene video is fetched ON DEMAND (ensureSceneVideo) — never as
        // part of the scene bundle. Request it when the video layer is on; the
        // bytes arrive via observeVideoDelivery and are attached + seeked there.
        if (binding?.layerVideo?.isChecked != false) {
            playbackViewModel.getCurrentSceneKey()?.let { sceneKey ->
                playbackViewModel.ensureSceneVideo(sceneKey, seekMs, explicitVideoSeek)
            }
        }

        if (!iuSequence.isNullOrEmpty()) {
            currentIuSequence = iuSequence
            playbackViewModel.currentIuSequence = iuSequence
            currentIuIndex = seekToUnit
            // The whole-scene video now arrives asynchronously (ensureSceneVideo
            // → observeVideoDelivery): show the storyboard immediately; the video
            // frame replaces it when the video is fetched and prepared.
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
        videoPlayerGeneration++
        videoReadyToShow = false
        runCatching { videoPlayer?.pause() }

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

    private fun playVideoOverlay(url: String, startSeekMs: Long = 0L, explicitSeek: Boolean = false) {
        try {
            playVideoFromUrl(url, startSeekMs, explicitSeek)
        } catch (e: Exception) {
            Log.e(TAG, "Video exception: ${e.message}", e)
        }
    }

    /**
     * Target the persistent video player at [url] from [startSeekMs] (Media3
     * ExoPlayer progressive streaming of the faststart MP4 — Range/206 seeks,
     * no whole-file download, no local file). Explicit unit navigation sets the
     * start position in setMediaItem (or does an instant same-item seek for
     * unit navigation within the current scene); normal playback joins at the
     * audio position. playWhenReady carries the user's play intent, so an early
     * Play press is remembered and honored the moment the item becomes ready —
     * readiness is the player's own STATE_READY, never a UI guess.
     */
    private fun playVideoFromUrl(url: String, startSeekMs: Long = 0L, explicitSeek: Boolean = false) {
        try {
            videoSpeedSyncJob?.cancel()
            pendingVideoTargetMs = if (explicitSeek) startSeekMs else -1L
            videoBuffering = false
            // The storyboard stays on top until STATE_READY renders the first
            // frame (no black during prepare/seek).
            videoReadyToShow = false
            // Bump the item generation BEFORE re-targeting: stale errors from
            // the previous item are then ignored by the listener.
            videoPlayerGeneration++
            videoCurrentGen = videoPlayerGeneration
            val startedAt = SystemClock.elapsedRealtime()
            Log.i(TAG, "video stream start: url=$url seekMs=$startSeekMs explicit=$explicitSeek gen=$videoCurrentGen")
            val b = binding ?: return
            b.videoSurface.visibility = View.VISIBLE
            videoSurfaceAlive = true
            val player = videoPlayer ?: createVideoPlayer().also { videoPlayer = it }
            // Start position: explicit unit target, else the current audio
            // position (the video joins mid-scene already in sync).
            val startPos = if (explicitSeek) startSeekMs else (currentPlayer?.currentPosition ?: 0).toLong()
            val sameItem = player.currentMediaItem?.localConfiguration?.uri == Uri.parse(url)
            explicitItem = explicitSeek
            hasBeenReadyForItem = false
            joinHandled = false
            if (sameItem && player.playbackState != Player.STATE_IDLE) {
                // Same scene re-target (unit navigation within the scene):
                // instant seek — no re-prepare, no re-download.
                if (startPos > 0) player.seekTo(startPos)
                player.playWhenReady = !isPaused
                if (player.playbackState == Player.STATE_READY) {
                    // Already ready: the seeked frame renders shortly — reveal
                    // the video (a ~100ms render delay is invisible behind the
                    // storyboard). Without this, videoReadyToShow stays false
                    // after stopAll and the video never comes back on top.
                    viewLifecycleOwner.lifecycleScope.launch {
                        delay(120)
                        videoReadyToShow = true
                        updateLayers()
                    }
                }
                Log.i(TAG, "video same-item seek: ${startPos}ms")
            } else {
                player.setMediaItem(MediaItem.fromUri(url), startPos)
                player.prepare()
                // The play intent is resolved at STATE_READY — never start
                // before the item is positioned (that was the lost-seek race).
                player.playWhenReady = false
                Log.i(TAG, "video target set (prepare) in ${SystemClock.elapsedRealtime() - startedAt}ms")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Video exception: ${e.message}", e)
        }
    }

    /** Media3 ExoPlayer driving the whole-scene video. ONE instance for the
     *  Player screen's whole life; scenes/positions are switched via
     *  setMediaItem(url, startPos) + prepare(). playWhenReady carries the user's
     *  play intent across prepare — an early Play press is never lost — and
     *  STATE_READY is the honest "video ready, first frame on the surface"
     *  signal (the storyboard stays on top until then). */
    private val videoPlayerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            val vp = videoPlayer ?: return
            when (playbackState) {
                Player.STATE_READY -> {
                    hasBeenReadyForItem = true
                    Log.i(TAG, "VID-LC ready: pos=${runCatching { vp.currentPosition }.getOrNull()}ms " +
                        "dur=${runCatching { vp.duration }.getOrNull()}ms gen=$videoCurrentGen")
                    when {
                        pendingVideoPlay -> {
                            // Early Play (unit navigation): the video is now
                            // ready at the selected unit — start the deferred
                            // audio and the video TOGETHER from the unit
                            // position. The play request was never lost and the
                            // seek was never dropped.
                            pendingVideoPlay = false
                            pendingVideoTargetMs = -1L
                            runCatching { currentPlayer?.start() }
                            runCatching { vp.play() }
                            playbackViewModel.exitBuffering()
                            Log.i(TAG, "VID-LC pending play honored — unit plays from its start")
                        }
                        videoBuffering -> resumeFromBuffering()
                        !explicitItem && !joinHandled -> {
                            // Normal scene start: the video finished loading
                            // while the audio was already playing — join the
                            // live audio position (one-time re-position).
                            joinHandled = true
                            val ap = (currentPlayer?.currentPosition ?: 0).toLong()
                            val vpos = runCatching { vp.currentPosition }.getOrNull() ?: 0L
                            if (ap > 0 && kotlin.math.abs(ap - vpos) > 800) {
                                Log.i(TAG, "VID-LC join: video ${vpos}ms → audio ${ap}ms")
                                runCatching { vp.seekTo(ap) }
                            }
                            if (!isPaused) runCatching { vp.play() }
                        }
                        else -> if (!isPaused) runCatching { vp.play() }
                    }
                    // ExoPlayer rendered the frame at the start position — the
                    // storyboard can now give way to the video.
                    videoReadyToShow = true
                    updateLayers()
                    startVideoSpeedSync()
                }
                Player.STATE_BUFFERING -> {
                    Log.i(TAG, "VID-LC buffering gen=$videoCurrentGen")
                    // The initial load is NOT gated (the video joins / honors
                    // the pending play intent at READY) — only real mid-playback
                    // underruns pause the whole player into "Загрузка…".
                    if (hasBeenReadyForItem) enterVideoBuffering()
                }
                Player.STATE_ENDED -> {
                    videoReadyToShow = false
                    if (!videoSurfaceAlive) {
                        binding?.videoSurface?.visibility = View.INVISIBLE
                    }
                }
                else -> {}
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            Log.i(TAG, "VID-LC isPlaying=$isPlaying gen=$videoCurrentGen")
        }

        override fun onVideoSizeChanged(videoSize: VideoSize) {
            val b = binding ?: return
            if (videoSize.width > 0 && videoSize.height > 0) {
                fitSurfaceToContainer(b, videoSize.width, videoSize.height)
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            Log.e(TAG, "VID-LC error: ${error.errorCodeName} ${error.message} gen=$videoCurrentGen")
            if (videoCurrentGen != videoPlayerGeneration) return // stale (previous item)
            // Stream failed (404 / network) — fall back to the storyboard layer
            // and unblock the player if we were buffering or deferring a play.
            videoBuffering = false
            pendingVideoPlay = false
            videoReadyToShow = false
            runCatching { videoPlayer?.stop() }
            if (playbackViewModel.uiState.value.phase == PlayerPhase.BUFFERING) {
                playbackViewModel.exitBuffering()
                runCatching { currentPlayer?.start() }
            }
            updateLayers()
        }
    }

    private fun createVideoPlayer(): ExoPlayer {
        return ExoPlayer.Builder(requireContext()).build().also { player ->
            player.setVideoSurfaceView(binding?.videoSurface)
            player.volume = currentVolume
            player.addListener(videoPlayerListener)
        }
    }

    private fun refitVideoSurface() {
        val b = binding ?: return
        val vp = videoPlayer ?: return
        if (b.videoSurface.visibility != View.VISIBLE) return
        try {
            val size = vp.videoSize
            if (size.width > 0 && size.height > 0) {
                fitSurfaceToContainer(b, size.width, size.height)
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
            // ExoPlayer renders the seeked frame even while paused — no
            // start()+pause() dance needed.
            vp.seekTo(pos)
        } catch (e: IllegalStateException) {
            Log.w(TAG, "syncVideoFrame failed: ${e.message}")
        }
    }

    /**
     * Adaptive video/audio SPEED lock. The audio (MediaPlayer) and video
     * (ExoPlayer) are independent players whose clocks drift apart (~0.7% on
     * some devices) — over a scene the video can end up ~0.5s ahead of the
     * audio. Instead of force-seeking (visible jumps), the VIDEO PLAYBACK
     * SPEED is gently corrected via setPlaybackSpeed so both positions advance
     * at the same rate. The video track has no audio, so speed changes are
     * inaudible. Measured every ~8s while playing; correction is clamped and
     * damped (re-converges to the audio rate, then stays).
     */
    private fun startVideoSpeedSync() {
        videoSpeedSyncJob?.cancel()
        val vp = videoPlayer ?: return
        val ap = currentPlayer ?: return
        videoSpeedSyncJob = viewLifecycleOwner.lifecycleScope.launch {
            while (isActive) {
                delay(4000)
                if (isPaused || pendingLoad) continue
                val v1 = runCatching { vp.currentPosition }.getOrNull() ?: -1
                val a1 = runCatching { ap.currentPosition }.getOrNull() ?: -1
                if (v1 < 0 || a1 < 0) continue
                delay(4000)
                if (isPaused || pendingLoad) continue
                val v2 = runCatching { vp.currentPosition }.getOrNull() ?: -1
                val a2 = runCatching { ap.currentPosition }.getOrNull() ?: -1
                if (v2 < 0 || a2 < 0) continue
                val dv = v2 - v1
                val da = a2 - a1
                // Not enough movement (buffering / paused mid-interval) — skip.
                if (dv < 1500 || da < 1500) continue
                val curSpeed = runCatching { vp.playbackParameters.speed }.getOrNull() ?: 1.0f
                // Speed that makes the video advance at exactly the audio's rate.
                val target = (curSpeed * da.toFloat() / dv.toFloat()).coerceIn(0.9f, 1.1f)
                if (kotlin.math.abs(target - curSpeed) > 0.002f) {
                    Log.i(TAG, "speed sync: video +${dv}ms audio +${da}ms → speed %.4f".format(target))
                    runCatching { vp.setPlaybackSpeed(target) }
                        .onFailure { Log.w(TAG, "setPlaybackSpeed failed: ${it.message}") }
                }
            }
        }
    }

    /** Buffer gate — the scene AUDIO is a local file (never stalls) while the
     *  VIDEO streams over the network; on a slow connection the video runs out
     *  of data and freezes while the audio keeps playing (the desync symptom).
     *  ExoPlayer signals STATE_BUFFERING / STATE_READY — pause the WHOLE player
     *  into "Загрузка…" and resume with a resync once the video can continue.
     *  Mirrors the web buffer gate (playbackStore.ts). */
    private fun enterVideoBuffering() {
        val layerOn = binding?.layerVideo?.isChecked ?: false
        if (videoBuffering || isPaused || !layerOn || playbackViewModel.uiState.value.phase != PlayerPhase.PLAYING) return
        videoBuffering = true
        Log.i(TAG, "video buffering — pausing audio to keep sync")
        currentPlayer?.pause()
        playbackViewModel.enterBuffering()
    }

    private fun resumeFromBuffering() {
        if (!videoBuffering) return
        videoBuffering = false
        if (playbackViewModel.uiState.value.phase != PlayerPhase.BUFFERING) return
        // Re-align the video to the audio timeline (a sub-second drift may have
        // accumulated while the audio ran ahead before the gate caught it).
        try {
            val ap = (currentPlayer?.currentPosition ?: 0).toLong()
            val vp = (videoPlayer?.currentPosition ?: 0).toLong()
            if (ap > 0 && kotlin.math.abs(ap - vp) > 500) {
                Log.i(TAG, "video buffering done — resync video ${vp}ms → ${ap}ms")
                videoPlayer?.seekTo(ap)
            }
        } catch (e: Exception) {
            Log.w(TAG, "buffering resync failed: ${e.message}")
        }
        runCatching { currentPlayer?.start() }
        playbackViewModel.exitBuffering()
        Log.i(TAG, "video buffering done — resuming")
    }

    private fun pausePlayback() {
        Log.i(TAG, "pausePlayback")
        videoSpeedSyncJob?.cancel()
        videoBuffering = false
        pendingVideoPlay = false
        runCatching { currentPlayer?.pause() }
        Log.i(TAG, "pausePlayback")
        runCatching { currentPlayer?.pause() }
        // ExoPlayer pause() (playWhenReady=false) is safe in every state.
        runCatching { videoPlayer?.pause() }
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
            // The video player is persistent — just pause it; the refreshed
            // scene's delivery re-targets it via setMediaItem.
            runCatching { videoPlayer?.pause() }
            videoReadyToShow = false
            isPaused = false
            playbackViewModel.resumePlayback()
            return
        }

        showCurrentIu()
        val vp = videoPlayer
        val videoPending = vp != null && vp.playbackState != Player.STATE_READY && pendingVideoTargetMs >= 0
        if (videoPending) {
            // Early Play while the video is still preparing (unit navigation):
            // defer the WHOLE start until STATE_READY — the video then starts
            // from the selected unit and the (still-paused, unit-positioned)
            // audio joins it there. Nothing is lost, the seek is preserved,
            // and the UI honestly shows "Загрузка…" while the video loads
            // (the "UI says ready, Play does nothing" state is gone).
            pendingVideoPlay = true
            playbackViewModel.enterBuffering()
            Log.i(TAG, "VID-LC playRequest deferred until video ready (gen=$videoCurrentGen)")
            return
        }
        runCatching { currentPlayer?.start() }
        if (vp != null) {
            // Apply an unconsumed unit-navigation target if present.
            try {
                if (pendingVideoTargetMs >= 0) {
                    vp.seekTo(pendingVideoTargetMs)
                    pendingVideoTargetMs = -1L
                }
            } catch (e: IllegalStateException) {
                Log.w(TAG, "videoPlayer pending-seek failed (state issue): ${e.message}")
            }
            runCatching { vp.play() }
            Log.i(TAG, "VID-LC play() gen=$videoCurrentGen")
        }
        updateLayers()
        isPaused = false
        // Update ViewModel state — restore PLAYING phase
        playbackViewModel.resumePlayback()
        startIuCycling()
        startVideoSpeedSync()
    }

    private fun togglePlay() {
        if (isPaused) {
            resumePlayback()
        } else {
            pausePlayback()
        }
    }

    fun stopAll(keepSurface: Boolean = false) {
        Log.i(TAG, "stopAll keepSurface=$keepSurface")
        videoSpeedSyncJob?.cancel()
        pendingVideoSyncJob?.cancel()
        pendingVideoTargetMs = -1L
        iuCyclingJob?.cancel()
        iuCyclingJob = null
        currentIuSequence = null
        playbackViewModel.currentIuSequence = null
        currentIuIndex = 0
        sceneTransitionPending = false
        nextChainReady = false
        currentPlayer?.release()
        nextPlayer?.release()
        // Snapshot BEFORE release: only a surface that actually rendered video
        // can keep showing a frame through the seek transition.
        val hadVideo = videoSurfaceAlive
        // The video player is persistent (one ExoPlayer for the screen's life)
        // — never release per action: just pause it; the next videoDelivery
        // re-targets the same instance via setMediaItem.
        videoPlayerGeneration++
        videoReadyToShow = false
        runCatching { videoPlayer?.pause() }
        if (currentFile?.name?.startsWith("chunk-") == true) currentFile?.delete()
        if (nextFile?.name?.startsWith("chunk-") == true) nextFile?.delete()
        currentPlayer = null
        nextPlayer = null
        currentFile = null
        nextFile = null
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
            if (keepSurface && hadVideo) {
                // External unit-seek / scene load: keep the surface ALIVE so it
                // holds the last rendered frame while the next video prepares —
                // the new video frame then swaps in directly, with NO cover or
                // black flash in between (hiding the surface destroys it and
                // forces a blank/cover gap until the new frame renders).
                videoSurfaceAlive = true
                b.videoSurface.visibility = View.VISIBLE
            } else {
                videoSurfaceAlive = false
                b.videoSurface.visibility = View.INVISIBLE
                if (b.coverImage.drawable != null) {
                    b.coverImage.visibility = View.VISIBLE
                } else {
                    // No cover available — show curtains as fallback to avoid blank screen
                    showCurtains()
                }
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
                stopAll(keepSurface = true)
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
        videoSpeedSyncJob?.cancel()
        currentPlayer?.release()
        currentPlayer = null
        nextPlayer?.release()
        nextPlayer = null
        videoPlayerGeneration++
        videoReadyToShow = false
        videoSurfaceAlive = false
        videoPlayer?.removeListener(videoPlayerListener)
        videoPlayer?.release()
        videoPlayer = null
        if (currentFile?.name?.startsWith("chunk-") == true) currentFile?.delete()
        if (nextFile?.name?.startsWith("chunk-") == true) nextFile?.delete()
        currentFile = null
        nextFile = null
        iuCyclingJob?.cancel()
        iuCyclingJob = null
        binding = null
        super.onDestroyView()
    }
}
