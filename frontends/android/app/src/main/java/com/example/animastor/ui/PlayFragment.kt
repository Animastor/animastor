package com.example.animastor.ui

import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.MergingMediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.example.animastor.R
import com.example.animastor.databinding.FragmentPlayBinding
import com.example.animastor.util.MediaDecoder
import com.example.animastor.util.VideoCache
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

    // ONE player for the whole Player-screen life: Media3 ExoPlayer playing a
    // MergingMediaSource — the LOCAL scene audio file + the NETWORK whole-scene
    // video URL — in a SINGLE media clock. This is the researched-correct
    // architecture (ExoPlayer docs: "two tracks synchronized using the same
    // internal clock"); the old two-player setup (audio MediaPlayer + video
    // ExoPlayer) had two independent clocks, so the video could stutter and
    // drift away from the audio, and a manual buffer gate could never work
    // reliably. With one player: STATE_BUFFERING pauses BOTH tracks together
    // (audio physically cannot run ahead), seek seeks both, and buffering is
    // native — the UI only reflects STATE_BUFFERING/STATE_READY.
    private var videoPlayer: ExoPlayer? = null
    // Local temp file holding the CURRENT scene's audio (merged into the
    // player's source; deleted on scene change / stop / destroy).
    private var currentAudioFile: File? = null
    // Scene key + video-inclusion of the item currently loaded in the player —
    // used for the same-scene fast path (unit navigation = instant seekTo, no
    // source rebuild / no re-download).
    private var currentPlayerSceneKey: String? = null
    private var currentPlayerHasVideo = false
    // Guards the scene-advance (ENDED → playNext) against double-firing: the
    // transition can be triggered by STATE_ENDED and by the iuCycling watchdog;
    // reset when the next scene is targeted.
    private var advancePending = false
    private var isPaused = false
    // Whether the whole-scene video has rendered its first frame and may cover
    // the storyboard. While false, the storyboard stays on TOP and the surface
    // (which would otherwise show black until the first frame decodes) is kept
    // alive but behind it — no more "video starts from black" on unit seek /
    // layer toggle. Set true only after the video actually pushed a frame.
    private var videoReadyToShow = false
    // Set by revealVideoAfterReturn() to the video generation captured at
    // return; onRenderedFirstFrame() (a NEW frame rendered on the recreated
    // surface) reveals the video at the exact render moment instead of a blind
    // fixed delay. Reset by targetScene (new item) and by the 150 ms fallback.
    private var pendingRevealGen = -1L
    // Bumped every time the persistent player is re-targeted (new scene /
    // layer change). The Player.Listener ignores errors that arrive after a
    // newer target was set — a stale item's error must not run the storyboard
    // fallback against the current item.
    private var videoPlayerGeneration = 0L
    // Generation of the item the listener is currently servicing.
    private var videoCurrentGen = 0L
    // Whether the video SurfaceView ever attached a surface. Hiding a live
    // surface destroys it, so once a video has played we keep the surface
    // alive (behind the storyboard) across scene/unit transitions.
    private var videoSurfaceAlive = false
    private var iuCyclingJob: Job? = null
    private var currentIuSequence: List<IuImageItem>? = null
    private var currentIuIndex = 0
    private var hasDisplayedCover = false
    private var isInCurtainsState = false
    private var currentVolume = 1.0f
    private var isFullscreen = false
    private var pendingLoad = false
    // Monotonic guard for the "show the selected unit's image immediately"
    // overlay fetch: bumped on every new unit selection and every scene
    // delivery, so a stale image fetch can never overwrite what is on screen.
    private var selectedUnitImageGen = 0L

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
                    // Only react to positions INSIDE the scene currently loaded
                    // in the player. The unit index alone is not enough: foreign
                    // navigateTo calls (the boot session-restore / generation
                    // warmup pointing at the FIRST scene, unit 0) would otherwise
                    // flash the wrong unit's image over the playing scene — the
                    // reported "первый юнит промигивает" right after an external
                    // unit seek. Same-scene manual changes still pass through.
                    val chId = playbackViewModel.currentChapterId
                    val scId = playbackViewModel.currentSceneId
                    if (chId == null || scId == null || pos.chapterId != chId || pos.sceneId != scId) {
                        return@collect
                    }
                    val ius = currentIuSequence
                    // Resolve by unitId when the position carries one (Navigator
                    // index is over scene.units, which can be offset from the
                    // storyboard list); index is the fallback (e.g. warmup).
                    val idx = if (pos.unitId != null && !ius.isNullOrEmpty()) {
                        ius.indexOfFirst { it.unitId == pos.unitId }
                    } else {
                        pos.unitIndex
                    }
                    if (!ius.isNullOrEmpty() && idx in ius.indices && idx != currentIuIndex) {
                        currentIuIndex = idx
                        showIuImage(ius[idx].bitmap)
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
            Log.i(TAG, "playButton clicked, phase=$phase isPaused=$isPaused player=${videoPlayer != null} rotate=${playbackViewModel.needsRotationResume}")
            when {
                phase == PlayerPhase.PLAYING && videoPlayer == null -> {
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
                phase == PlayerPhase.SCENE_READY && playbackViewModel.pendingExternalSeek != null -> {
                    // A deferred cold-start seek is still waiting (the queue was
                    // just populated, or the user pressed Start before it
                    // drained): Start must play the SELECTED unit, never scene 0
                    // — playSceneQueue here was the lost-intent race (the first
                    // unit flashed and played instead of the tapped one).
                    Log.i(TAG, "playButton: SCENE_READY with pending external seek — executing it")
                    pendingLoad = true
                    stopAll(keepSurface = true)
                    playbackViewModel.executePendingSeek()
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
                // Layer re-enabled: if the current source is AUDIO-ONLY (the
                // layer was off when the scene loaded) — or no player target
                // exists yet — rebuild the merged source WITH the video at the
                // current position. A source that already includes the video is
                // kept as-is (instant re-show via updateLayers, no re-download).
                val af = currentAudioFile
                if (af != null && playbackViewModel.pendingSceneHasVideo && (!currentPlayerHasVideo || videoPlayer == null)) {
                    val cur = (videoPlayer?.currentPosition ?: 0).toLong()
                    targetScene(af, cur, includeVideo = true, playIntent = !isPaused)
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
        checkPendingExternalSeek()

        if (currentIuSequence == null && videoPlayer != null) {
            currentIuSequence = playbackViewModel.currentIuSequence
        }
        if (currentIuSequence != null && videoPlayer != null) {
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
                        Log.d(TAG, "state: phase=${state.phase} img=${state.previewImage != null} cover=${state.coverImage != null} player=${videoPlayer != null}")

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

                        // Rotation recovery: the view was recreated (the player
                        // is fresh and not targeted at the current scene) but the
                        // chunk was already processed before rotation — handleChunk
                        // won't re-run, so reset to SCENE_READY for a clean resume.
                        val playerTargeted = videoPlayer != null &&
                            currentPlayerSceneKey == playbackViewModel.getCurrentSceneKey()
                        if (state.phase == PlayerPhase.PLAYING && !playerTargeted
                            && state.chunkSequence <= playbackViewModel.lastProcessedSceneSequence) {
                            Log.w(TAG, "rotation recovery: PLAYING with no targeted player (chunk already processed) -> SCENE_READY")
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
                            if (!showResult) debugLog("SCENE_READY hide resultImage (no preview)")
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
        // frame (videoReadyToShow) AND the current source has a video track
        // (currentPlayerHasVideo). An AUDIO-ONLY source (scene without video)
        // has no frames: the surface must be hidden entirely, or the LAST FRAME
        // of the previous video scene lingers on screen, covering the
        // storyboard (the reported bug — also visible as black via Navigator).
        val hasVideoTrack = videoPlayer != null && currentPlayerHasVideo
        val showVideo = b.layerVideo.isChecked && hasVideoTrack && videoReadyToShow
        if (showVideo) {
            if (b.videoSurface.visibility != View.VISIBLE) {
                b.videoSurface.visibility = View.VISIBLE
            }
            // Video on top of the storyboard. IMPORTANT: the SurfaceView is
            // never hidden once a video track is loaded — hiding it destroys
            // the surface and the player must re-attach (safe for ExoPlayer,
            // but a fresh surface briefly shows black while re-rendering). Web
            // parity: the video element keeps playing under display:none, so
            // here the video player keeps playing behind the storyboard and
            // re-shows already synced to the audio.
            b.videoSurface.bringToFront()
        } else if (hasVideoTrack) {
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
            // No video track (audio-only scene) — hide the surface ENTIRELY:
            // the previous scene's last frame must not linger over the
            // storyboard. Safe: an audio-only source needs no surface; the next
            // video scene re-creates it via targetScene (ExoPlayer re-attaches
            // natively on surfaceCreated).
            b.videoSurface.visibility = View.INVISIBLE
            videoSurfaceAlive = false
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
        // The scene is delivered — invalidate any in-flight selected-unit
        // image overlay fetch (its image is about to be shown here anyway).
        selectedUnitImageGen++
        Log.i(TAG, "handleChunk: audio=${audio.size}B video=${video?.size}B ius=${iuSequence?.size ?: 0}")

        playbackViewModel.persistedImage = null

        // Compute the target position on the CANONICAL timeline (audio/start_ms)
        // BEFORE touching any player. The whole-scene video is aligned to the
        // audio timeline at merge time (group clips are trimmed to their exact
        // audio frame counts), so BOTH the audio and the video seek to the same
        // position — the final muxed product has a single timeline. Priority:
        // externally selected unit → rotation-resume position.
        // Authoritative unit index for the CURRENT scene (set by
        // executePendingSeek / playNext), NOT the global shared position: the
        // boot session-restore / generation warmup navigates to the FIRST
        // scene (unit 0), and if that lands while the scene is downloading, the
        // seek target would be clobbered to 0 — the video would start from the
        // beginning instead of the selected unit. Web parity: the web reads its
        // module-level currentUnitIndex here, never the position store.
        // Authoritative target: resolved by the seek's unitId against the
        // storyboard sequence (the Navigator's unitIndex is over scene.units,
        // which can be offset from the storyboard list — an index-only mapping
        // landed on the previous unit). Falls back to the index when no id.
        val targetUnit = playbackViewModel.resolveUnitIndexForSequence(iuSequence)
        if (targetUnit != playbackViewModel.currentUnitIndex) {
            playbackViewModel.currentUnitIndex = targetUnit
        }
        val seekToUnit = if (targetUnit > 0 && !iuSequence.isNullOrEmpty() && targetUnit < iuSequence.size) targetUnit else 0
        Log.i(TAG, "chunk resolve: extId=${playbackViewModel.pendingExternalUnitId} byId=$targetUnit cur=${playbackViewModel.currentUnitIndex} seekTo=$seekToUnit")
        val pendingRotMs = playbackViewModel.pendingSeekPositionMs
        val seekMs = when {
            seekToUnit > 0 && !iuSequence.isNullOrEmpty() -> unitStartMs(iuSequence, seekToUnit)
            pendingRotMs > 0 -> pendingRotMs
            else -> 0L
        }
        if (seekMs > 0) playbackViewModel.pendingSeekPositionMs = -1
        debugLog("chunk extId=${playbackViewModel.pendingExternalUnitId ?: "-"} ius=[${iuSequence?.take(6)?.joinToString(",") { it.unitId ?: "?" }}] cur=${playbackViewModel.currentUnitIndex} -> seekTo=$seekToUnit ms=$seekMs")

        if (seekToUnit > 0 && !iuSequence.isNullOrEmpty()) {
            val target = iuSequence[seekToUnit]
            Log.i(TAG, "UNIT-SEEK unit=${target.unitId} index=$seekToUnit startMs=${target.startMs} seekMs=$seekMs")
        }

        // An external unit tap (or rotation resume) targets an explicit
        // position — including 0 for unit 1. With the merged single player the
        // seekMs position is applied to BOTH tracks at once (targetScene).
        playbackViewModel.explicitVideoSeekPending = false

        if (!iuSequence.isNullOrEmpty()) {
            currentIuSequence = iuSequence
            playbackViewModel.currentIuSequence = iuSequence
            currentIuIndex = seekToUnit
            // Storyboard first; the video frame replaces it once the merged
            // source renders (videoReadyToShow).
            showIuImage(iuSequence[seekToUnit])
            updateSubtitleIfEnabled(iuSequence[seekToUnit].text)
        } else {
            currentIuSequence = iuSequence
            playbackViewModel.currentIuSequence = iuSequence
            showIuMissingPlaceholder()
            updateSubtitleIfEnabled(null)
        }

        // ONE player: the local scene audio file + the (layer-on) whole-scene
        // video URL merged into a single ExoPlayer source — both tracks share
        // one clock (MergingMediaSource), so they can never drift, and
        // STATE_BUFFERING pauses BOTH tracks (native "Загрузка…"; the audio can
        // physically not run ahead of the video). The video is included only
        // when the video layer is on — audio-only source otherwise (zero video
        // traffic, web parity).
        if (audio.isEmpty()) {
            handleSilentChunk(iuSequence ?: emptyList())
            return
        }
        currentAudioFile?.delete()
        val file = writeTemp(audio)
        currentAudioFile = file
        // ExoPlayer plays AUDIO natively (no video track needed): include the
        // network video only when the layer is on AND the scene actually has a
        // whole-scene video file (backend video_ready) — otherwise an audio-only
        // source is built from the start (no merge with a dead video URL, no 404
        // round-trip, the scene just plays).
        val sceneHasVideo = playbackViewModel.pendingSceneHasVideo
        val includeVideo = binding?.layerVideo?.isChecked == true && sceneHasVideo
        if (pendingLoad) {
            // External unit seek / rotation resume: the scene loads POSITIONED
            // but paused — the user presses Play to start (matches the old
            // "player stays Prepared" behavior).
            pendingLoad = false
            isPaused = true
            playbackViewModel.pausePlayback()
            Log.i(TAG, "pending load — player stays positioned & paused")
        }
        targetScene(file, seekMs, includeVideo, playIntent = !isPaused)
        startIuCycling()
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
        selectedUnitImageGen++
        Log.i(TAG, "handleSilentChunk: ius=${iuSequence.size}")

        // Stop any existing playback (silent scene = no merged audio source)
        currentAudioFile?.delete()
        currentAudioFile = null
        currentPlayerSceneKey = null
        currentPlayerHasVideo = false
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

                if (currentIuIndex >= ius.size - 1) {
                    // Last unit shown — the silent scene is done: advance to the
                    // next scene (playNext delivers the next scene: audio one →
                    // re-targets the player; silent one → cycles it in turn).
                    Log.i(TAG, "silent scene done — advancing to next scene")
                    playbackViewModel.onAudioCompleted()
                    return@launch
                }

                val nextIdx = currentIuIndex + 1
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
            currentAudioFile?.delete()
            currentAudioFile = null
            currentPlayerSceneKey = null
            currentPlayerHasVideo = false
            runCatching { videoPlayer?.pause() }
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
                val player = videoPlayer
                if (ius.isNullOrEmpty() || player == null) {
                    delay(500)
                    continue
                }
                // Watchdog for the scene transition: if the player reached the
                // end but STATE_ENDED didn't fire (merged-source duration
                // quirks), advance anyway. onTrackEnd is idempotent.
                if (player.playbackState == Player.STATE_ENDED) {
                    onTrackEnd()
                    return@launch
                }
                if (player.playbackState != Player.STATE_READY) {
                    delay(500)
                    continue
                }

                if (isPaused) {
                    delay(500)
                    continue
                }

                val pos = runCatching { player.currentPosition }.getOrNull() ?: -1L
                if (pos < 0) {
                    delay(500)
                    continue
                }

                // Map position → unit index on the same timeline the seek
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
                    debugLog("cycle pos=$pos -> idx=$idx -> ${ius[idx].unitId}")
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

    /** Whole-scene media ended → advance to the next scene. The next scene's
     *  bytes are usually already preloaded by the ViewModel, so the re-target
     *  (handleChunk → targetScene) is fast; the single-player model prefers
     *  this tiny boundary gap over the old two-player gapless chain (which
     *  traded it for clock drift and desync). Idempotent: may be triggered by
     *  STATE_ENDED and by the iuCycling watchdog; [advancePending] collapses
     *  double-fires. */
    private fun onTrackEnd() {
        if (advancePending) return
        advancePending = true
        Log.i(TAG, "onTrackEnd: isPaused=$isPaused")
        try {
            viewLifecycleOwner.lifecycleScope.launch {
                iuCyclingJob?.cancel()
                currentAudioFile?.delete()
                currentAudioFile = null
                currentPlayerSceneKey = null
                currentPlayerHasVideo = false
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

    /**
     * Target the single ExoPlayer at the CURRENT scene: a MergingMediaSource of
     * the LOCAL scene-audio file + (layer-on) the NETWORK whole-scene video URL
     * — both tracks in ONE media clock (ExoPlayer's MergingMediaSource: "two
     * tracks synchronized using the same internal clock"), starting at
     * [startPosMs]. Same-scene re-targets (unit navigation) do an instant
     * seekTo with NO source rebuild (no re-download, no re-prepare); a new
     * scene (or a layer change) rebuilds the merged source. playWhenReady
     * carries the play intent across prepare — an early Play press is never
     * lost, and readiness is the player's own STATE_READY, never a UI guess.
     */
    private fun targetScene(audioFile: File, startPosMs: Long, includeVideo: Boolean, playIntent: Boolean) {
        try {
            videoReadyToShow = false
            pendingRevealGen = -1L // a new item cancels any pending return-reveal
            videoPlayerGeneration++
            videoCurrentGen = videoPlayerGeneration
            val startedAt = SystemClock.elapsedRealtime()
            val b = binding ?: return
            // Only a source WITH a video track needs the surface alive. An
            // audio-only source must NOT resurrect the surface here — its
            // last-frame buffer would linger over the storyboard.
            if (includeVideo) {
                b.videoSurface.visibility = View.VISIBLE
                videoSurfaceAlive = true
            }
            val player = videoPlayer ?: createVideoPlayer().also { videoPlayer = it }
            val sceneKey = playbackViewModel.getCurrentSceneKey()
            val sameScene = sceneKey != null && sceneKey == currentPlayerSceneKey && includeVideo == currentPlayerHasVideo
            Log.i(TAG, "scene target: scene=$sceneKey pos=${startPosMs}ms video=$includeVideo play=$playIntent same=$sameScene gen=$videoCurrentGen")
            debugLog("target same=$sameScene pos=${startPosMs}ms v=$includeVideo play=$playIntent")
            if (sameScene && player.playbackState != Player.STATE_IDLE) {
                // Same scene re-target (unit navigation within the scene):
                // instant seek — both tracks seek together, no re-download.
                // NOTE: 0 (the first unit, incl. last→first) IS a valid seek
                // target — it must not be skipped.
                player.seekTo(startPosMs)
                player.playWhenReady = playIntent
                if (player.playbackState == Player.STATE_READY) {
                    // The seeked frame renders shortly — reveal the video (a
                    // ~100ms render delay is invisible behind the storyboard).
                    viewLifecycleOwner.lifecycleScope.launch {
                        delay(120)
                        videoReadyToShow = true
                        updateLayers()
                    }
                }
                Log.i(TAG, "scene same-item seek: ${startPosMs}ms")
            } else {
                currentPlayerSceneKey = sceneKey
                currentPlayerHasVideo = includeVideo
                // Audio stays on the plain local-file factory; ONLY the network
                // video URL goes through the persistent disk cache (Media3
                // SimpleCache + CacheDataSource): already-fetched ranges are read
                // from disk on repeat seeks, missing ranges are fetched via HTTP
                // Range and then cached. Nothing is pre-downloaded.
                val localFactory = DefaultDataSource.Factory(requireContext())
                val audioSource = ProgressiveMediaSource.Factory(localFactory)
                    .createMediaSource(MediaItem.fromUri(Uri.fromFile(audioFile)))
                val source = if (includeVideo) {
                    val chId = sceneKey?.substringBefore(':')
                    val scId = sceneKey?.substringAfter(':')
                    if (chId == null || scId == null) {
                        audioSource
                    } else {
                        val videoUrl = playbackViewModel.buildSceneVideoUrl(chId, scId)
                        val videoFactory = VideoCache.dataSourceFactory(requireContext(), localFactory)
                        val videoSource = ProgressiveMediaSource.Factory(videoFactory)
                            .createMediaSource(MediaItem.fromUri(Uri.parse(videoUrl)))
                        MergingMediaSource(audioSource, videoSource)
                    }
                } else {
                    audioSource
                }
                player.setMediaSources(listOf(source), 0, startPosMs)
                player.prepare()
                player.playWhenReady = playIntent
                advancePending = false
                Log.i(TAG, "scene set (prepare) in ${SystemClock.elapsedRealtime() - startedAt}ms")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Scene target exception: ${e.message}", e)
        }
    }

    /** Single-player state → UI. STATE_BUFFERING means the player is waiting
     *  for DATA (the network video); because the LOCAL audio is part of the
     *  SAME player it pauses TOGETHER with the video — "Загрузка…" is native
     *  now and the audio physically cannot run ahead of the video. */
    private val videoPlayerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            val vp = videoPlayer ?: return
            when (playbackState) {
                Player.STATE_READY -> {
                    debugLog("READY pos=${runCatching { vp.currentPosition }.getOrNull()}ms dur=${runCatching { vp.duration }.getOrNull()}ms")
                    Log.i(TAG, "VID-LC ready: pos=${runCatching { vp.currentPosition }.getOrNull()}ms " +
                        "dur=${runCatching { vp.duration }.getOrNull()}ms gen=$videoCurrentGen")
                    // The screen left view while the item was preparing — it can
                    // still become READY in the background. Buffer it, but never
                    // start on a hidden screen.
                    if (isHidden || !isAdded) {
                        runCatching { vp.pause() }
                        if (currentPlayerHasVideo) videoReadyToShow = true
                        Log.i(TAG, "VID-LC ready while hidden — staying paused")
                        return
                    }
                    // First frame rendered — the storyboard can give way. Only
                    // for sources WITH a video track: an audio-only source
                    // (scene without video) has no frames, and videoReadyToShow
                    // must stay false so the lingering surface stays hidden.
                    if (currentPlayerHasVideo) videoReadyToShow = true
                    updateLayers()
                    startIuCycling()
                    // Phase follows the play intent: READY + playWhenReady →
                    // PLAYING; READY + paused → PAUSED (never "ready but the
                    // button lies").
                    if (playbackViewModel.uiState.value.phase == PlayerPhase.BUFFERING) {
                        if (vp.playWhenReady) {
                            isPaused = false
                            playbackViewModel.exitBuffering()
                        } else {
                            isPaused = true
                            playbackViewModel.pausePlayback()
                        }
                    }
                }
                Player.STATE_BUFFERING -> {
                    Log.i(TAG, "VID-LC buffering gen=$videoCurrentGen")
                    // The player pauses BOTH tracks itself while it fills the
                    // buffer — the UI only reflects it ("Загрузка…").
                    if (vp.playWhenReady && playbackViewModel.uiState.value.phase != PlayerPhase.BUFFERING) {
                        isPaused = true
                        playbackViewModel.enterBuffering()
                    }
                }
                Player.STATE_ENDED -> {
                    videoReadyToShow = false
                    Log.i(TAG, "VID-LC ended — advancing to next scene")
                    onTrackEnd()
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

        override fun onRenderedFirstFrame() {
            // The return path (surface recreated) waits for this: a frame is
            // actually ON the new surface, so showing the video cannot flash
            // black. Gen-guarded: only reveals the item that was pending.
            val gen = pendingRevealGen
            if (gen >= 0 && videoCurrentGen == gen && binding != null && isAdded) {
                pendingRevealGen = -1L
                videoReadyToShow = true
                updateLayers()
                Log.i(TAG, "VID-LC return: video revealed on first rendered frame (gen=$gen)")
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            val cause = error.cause
            Log.e(
                TAG,
                "VID-LC error: ${error.errorCodeName} ${error.message}" +
                    (cause?.let { " | ${it::class.java.simpleName}: ${it.message}" } ?: ""),
                error
            )
            if (videoCurrentGen != videoPlayerGeneration) return // stale (previous item)
            // The VIDEO child of the merged source failed (missing video file /
            // 404 / network) while the LOCAL audio is fine — fall back to an
            // AUDIO-ONLY source so the scene still plays (web parity: scenes
            // without video are audio-only). A missing video must not kill the
            // whole scene (that also silently broke scene transitions when the
            // NEXT scene had no video).
            if (currentPlayerHasVideo && currentAudioFile != null) {
                val af = currentAudioFile!!
                val pos = runCatching { videoPlayer?.currentPosition }.getOrNull() ?: 0L
                Log.w(TAG, "VID-LC video stream failed — falling back to audio-only (pos=$pos)")
                currentPlayerSceneKey = null
                targetScene(af, pos, includeVideo = false, playIntent = !isPaused)
                return
            }
            // Real (audio-side) failure — fall back to the storyboard layer
            // and unblock the player if it was showing "Загрузка…".
            videoReadyToShow = false
            currentPlayerSceneKey = null
            currentPlayerHasVideo = false
            runCatching { videoPlayer?.stop() }
            if (playbackViewModel.uiState.value.phase == PlayerPhase.BUFFERING) {
                playbackViewModel.exitBuffering()
                runCatching { videoPlayer?.pause() }
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

    /**
     * The player screen's SurfaceView is destroyed whenever the screen leaves
     * view (tab switch via hide(), activity backgrounded) and recreated on
     * return — ExoPlayer then re-renders the frame on the new surface
     * ASYNCHRONOUSLY, while videoReadyToShow is still true from before. Showing
     * the surface at that moment would flash black / hide the video behind a
     * dead surface. Keep the storyboard on top until the re-render settles
     * (150 ms), then reveal the video. Generation-guarded: a new video item
     * (scene change / seek) cancels the scheduled reveal, so it can never
     * resurrect the video over a freshly loading item.
     */
    private fun revealVideoAfterReturn() {
        val gen = videoCurrentGen
        videoReadyToShow = false
        pendingRevealGen = gen
        updateLayers()
        Log.i(TAG, "VID-LC return: holding storyboard until surface re-render (gen=$gen)")
        // Primary signal: the first frame actually rendered on the recreated
        // surface (onRenderedFirstFrame) reveals the video at the exact render
        // moment. The fixed delay is only a safety net for sources where the
        // callback never fires (audio-only / edge cases) — and it still honors
        // the gen guard, so it can never resurrect the video over a fresh item.
        viewLifecycleOwner.lifecycleScope.launch {
            delay(150)
            if (pendingRevealGen == gen && binding != null && isAdded && videoCurrentGen == gen && videoPlayer != null) {
                pendingRevealGen = -1L
                videoReadyToShow = true
                updateLayers()
                Log.i(TAG, "VID-LC return: video revealed (timeout fallback, gen=$gen)")
            }
        }
    }

    /** Auto-pause whenever the Player screen leaves view (switch to another
     *  bottom-nav tab, activity backgrounded). With ONE player this pauses the
     *  whole scene (audio + video together) in any active phase — including
     *  BUFFERING: nothing may keep playing (or keep buffering into playback)
     *  on a hidden screen, and the pause is recorded so the button is
     *  consistent on return (one tap resumes). */
    private fun autoPauseForBackground() {
        val phase = playbackViewModel.uiState.value.phase
        if (phase == PlayerPhase.PLAYING || phase == PlayerPhase.BUFFERING) {
            pausePlayback()
        } else {
            // No active phase — a stale player may still be running (e.g.
            // after stopAll/onTrimMemory). Nothing may play on a hidden screen.
            runCatching { videoPlayer?.pause() }
        }
    }

    private fun pausePlayback() {
        Log.i(TAG, "pausePlayback")
        // ExoPlayer pause() (playWhenReady=false) is safe in every state.
        runCatching { videoPlayer?.pause() }
        isPaused = true
        // Update ViewModel state — this drives the button/status via state.phase
        playbackViewModel.pausePlayback()
    }

    private fun resumePlayback() {
        Log.i(TAG, "resumePlayback")

        // If content was regenerated while paused, the old source has stale
        // audio. Clear it so the ViewModel's resumePlayback → playNext →
        // fetchSceneData path re-targets the same player with fresh content.
        if (playbackViewModel.needsContentRefresh) {
            Log.i(TAG, "resumePlayback: content changed, releasing stale source")
            currentAudioFile?.delete()
            currentAudioFile = null
            currentPlayerSceneKey = null
            currentPlayerHasVideo = false
            runCatching { videoPlayer?.pause() }
            videoReadyToShow = false
            isPaused = false
            playbackViewModel.resumePlayback()
            return
        }

        // The player must be targeted at the CURRENT scene to resume — after a
        // rotation (fresh view), a stream error, or stopAll there is no media
        // loaded; reload the scene (positioned at the saved position) instead
        // of silently flipping the button to PLAYING with nothing to play.
        val vp = videoPlayer
        if (vp == null || currentPlayerSceneKey != playbackViewModel.getCurrentSceneKey() || vp.playbackState == Player.STATE_IDLE) {
            Log.i(TAG, "resumePlayback: no targeted scene — reloading current scene")
            isPaused = false
            playbackViewModel.resumeFromCurrentScene()
            return
        }

        showCurrentIu()
        // playWhenReady carries the intent — an early Play while the source is
        // still preparing is honored by ExoPlayer itself at STATE_READY (the
        // "UI says ready, Play does nothing / lost start" states are gone).
        runCatching { videoPlayer?.play() }
        Log.i(TAG, "VID-LC play() gen=$videoCurrentGen")
        updateLayers()
        isPaused = false
        // Update ViewModel state — restore PLAYING phase (STATE_BUFFERING will
        // flip it to "Загрузка…" if the player actually has to wait).
        playbackViewModel.resumePlayback()
        if (currentAudioFile != null) startIuCycling()
        else if (!currentIuSequence.isNullOrEmpty()) startSilentIuCycling()
    }

    private fun togglePlay() {
        if (isPaused) {
            resumePlayback()
        } else {
            pausePlayback()
        }
    }

    fun stopAll(keepSurface: Boolean = false) {
        debugLog("stopAll keep=$keepSurface seek=${playbackViewModel.pendingExternalSeek?.let { "${it.unitId}/i${it.unitIndex}" } ?: "-"}")
        Log.i(TAG, "stopAll keepSurface=$keepSurface")
        iuCyclingJob?.cancel()
        iuCyclingJob = null
        // Snapshot BEFORE clearing: the same-scene fast path of
        // showSelectedUnitImageNow (called below for keepSurface seeks) needs
        // the already-loaded IU sequence to overlay the selected unit's image
        // instantly — by the time the overlay runs, the field is already null.
        val savedIuSequence = currentIuSequence
        currentIuSequence = null
        playbackViewModel.currentIuSequence = null
        currentIuIndex = 0
        currentPlayerSceneKey = null
        currentPlayerHasVideo = false
        currentAudioFile?.delete()
        currentAudioFile = null
        // Snapshot BEFORE pausing: only a surface that actually rendered video
        // can keep showing a frame through the seek transition.
        val hadVideo = videoSurfaceAlive
        // The player is persistent (one ExoPlayer for the screen's life) —
        // never release per action: just pause it; the next scene re-targets
        // the same instance via targetScene.
        videoPlayerGeneration++
        videoReadyToShow = false
        runCatching { videoPlayer?.pause() }
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
                // External unit-seek / scene load: keep the surface ALIVE (so
                // the next video re-target never has to re-attach a fresh
                // surface — that would flash black until the first frame
                // renders) but cover it right away with a NEUTRAL placeholder.
                // The previous unit's video frame / storyboard must never be
                // visible during the switch; the SELECTED unit's storyboard is
                // overlaid as soon as it is available (showSelectedUnitImageNow
                // below — same-scene image instantly, other scenes via a fast
                // single-image fetch), then handleChunk delivers the full scene
                // and the video reveals on its first rendered frame.
                videoSurfaceAlive = true
                b.videoSurface.visibility = View.VISIBLE
                if (b.coverImage.drawable != null) {
                    b.coverImage.visibility = View.VISIBLE
                    b.coverImage.bringToFront()
                } else {
                    b.curtainsImage.visibility = View.VISIBLE
                    b.curtainsImage.bringToFront()
                }
                b.previewOverlay.bringToFront()
                b.subtitleText.bringToFront()
                b.fullscreenButton.bringToFront()
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
            // Cover with the SELECTED unit's storyboard image as soon as it can
            // be shown (the seek is still pending here — executePendingSeek
            // clears it right after stopAll). The visual sequence becomes:
            // old unit's video → selected unit's storyboard → selected unit's
            // video — no stale frame of the previous unit, no black surface.
            if (keepSurface) {
                val pendingSeek = playbackViewModel.pendingExternalSeek
                if (pendingSeek != null) showSelectedUnitImageNow(pendingSeek, savedIuSequence)
            }
        }
        anchorFullscreenToImage()
    }

    // ── TEMP DEBUG: on-screen unit-switch timeline (remove after verification) ──
    private val debugLines = ArrayDeque<String>()
    private fun debugLog(msg: String) {
        val line = "${System.currentTimeMillis() % 100000}: $msg"
        if (Looper.myLooper() != Looper.getMainLooper()) {
            view?.post { debugLog(msg) }
            return
        }
        val b = binding ?: return
        debugLines.addLast(line)
        while (debugLines.size > 14) debugLines.removeFirst()
        b.debugStatusText.text = debugLines.joinToString("\n")
        b.debugStatusText.visibility = View.VISIBLE
    }

    /** When an external unit seek starts, cover the live surface with the
     *  SELECTED unit's storyboard image as soon as possible — the previous
     *  unit's video frame / storyboard must never be visible during the switch
     *  (reported "old unit shows first"). Same-scene selections use the image
     *  already loaded in [currentIuSequence]; a different scene fetches just
     *  the one IU image (fast; disk-cached for preloaded scenes). The result is
     *  overlaid over the surface; handleChunk replaces it with the same image
     *  from the scene bundle (and bumps the gen guard so stale fetches are
     *  dropped). */
    private fun showSelectedUnitImageNow(seek: ActivePosition, savedIuSequence: List<IuImageItem>?) {
        val chId = seek.chapterId
        val scId = seek.sceneId
        val unitId = seek.unitId
        val gen = ++selectedUnitImageGen
        if (chId == null || scId == null) return
        // Same scene → the unit's image is already in the loaded sequence.
        // Resolve BY ID (the Navigator's unitIndex is over scene.units, which
        // can be offset from the storyboard list — index-only landed on the
        // previous unit); index remains the fallback for legacy seeks.
        if (chId == playbackViewModel.currentChapterId && scId == playbackViewModel.currentSceneId) {
            val ius = savedIuSequence
            val uid = seek.unitId
            val idx = if (!ius.isNullOrEmpty() && uid != null) {
                ius.indexOfFirst { it.unitId == uid }
            } else {
                seek.unitIndex
            }
            if (!ius.isNullOrEmpty() && idx in ius.indices && ius[idx].bitmap != null) {
                currentIuIndex = idx
                overlaySelectedUnitImage(ius[idx].bitmap!!)
                return
            }
        }
        // Different scene (or image not loaded) → fetch just this unit's image.
        if (unitId == null || playbackViewModel.bookId.isBlank()) return
        viewLifecycleOwner.lifecycleScope.launch {
            val bmp = runCatching {
                val bytes = repository.getIuImage(playbackViewModel.bookId, chId, scId, unitId, playbackViewModel.buildId)
                MediaDecoder.decodeBitmap(bytes)
            }.getOrNull()
            if (bmp != null && gen == selectedUnitImageGen && isAdded && binding != null) {
                overlaySelectedUnitImage(bmp)
            }
        }
    }

    /** Show [bmp] (the selected unit's storyboard) over the live surface and
     *  re-raise the UI overlays (mirrors the re-raises at the end of
     *  updateLayers). */
    private fun overlaySelectedUnitImage(bmp: Bitmap) {
        val b = binding ?: return
        if (!b.layerImage.isChecked) return  // image layer off → cover stays
        b.resultImage.setImageBitmap(bmp)
        b.resultImage.visibility = View.VISIBLE
        b.resultImage.bringToFront()
        b.previewOverlay.bringToFront()
        b.subtitleText.bringToFront()
        b.fullscreenButton.bringToFront()
        anchorFullscreenToImage()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (hidden) {
            stopPulse()
            autoPauseForBackground()
        } else {
            // Single player holds ONE position for both tracks — no re-sync
            // needed on return, only the visual reveal.
            if (isPaused) {
                showCurrentIu()
            }
            // The SurfaceView died while the tab was hidden and ExoPlayer
            // re-renders on the recreated one asynchronously — hold the
            // storyboard until that render lands (never black on return).
            val vp = videoPlayer
            if (vp != null && videoReadyToShow && vp.playbackState == Player.STATE_READY) {
                revealVideoAfterReturn()
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
        // Same surface-recreate re-gate as onHiddenChanged(false): the surface
        // died with the activity window while backgrounded. (No-op after config
        // change — the view was recreated and videoPlayer is null then.)
        val vp = videoPlayer
        if (vp != null && videoReadyToShow && vp.playbackState == Player.STATE_READY) {
            revealVideoAfterReturn()
        }
    }

    override fun onPause() {
        super.onPause()
        if (activity?.isChangingConfigurations == true) {
            val pos = (videoPlayer?.currentPosition ?: 0).toLong()
            if (pos > 0) playbackViewModel.savedPlaybackPositionMs = pos
            val b = binding
            if (b != null && b.resultImage.visibility == View.VISIBLE && b.resultImage.drawable != null) {
                val bmp = (b.resultImage.drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap
                if (bmp != null) playbackViewModel.persistedImage = bmp
            }
        }
        autoPauseForBackground()
    }

    override fun onDestroyView() {
        stopPulse()
        iuCyclingJob?.cancel()
        iuCyclingJob = null
        videoPlayerGeneration++
        videoReadyToShow = false
        videoSurfaceAlive = false
        videoPlayer?.removeListener(videoPlayerListener)
        videoPlayer?.release()
        videoPlayer = null
        currentAudioFile?.delete()
        currentAudioFile = null
        currentPlayerSceneKey = null
        binding = null
        super.onDestroyView()
    }
}
