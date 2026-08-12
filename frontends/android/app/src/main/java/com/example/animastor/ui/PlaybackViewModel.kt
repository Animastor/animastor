package com.example.animastor.ui

import android.app.Application
import android.graphics.Bitmap
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.CreationExtras
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.Repository
import com.example.animastor.repository.SceneRef
import com.example.animastor.repository.sceneRefs
import com.example.animastor.util.MediaDecoder
import com.example.animastor.util.SimpleDiskCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File

/**
 * ViewModel for the media player subsystem.
 * Handles ONLY playback logic: scene queue management, preloading, IU cycling,
 * position tracking, and UI state for the player.
 *
 * Designed to be independent of content generation — receives prepared data
 * via [preparePlayback] and [setCoverImage] methods called by the activity
 * coordinator after generation/loading completes.
 */
class PlaybackViewModel(
    application: Application,
    private val _repository: Repository
) : AndroidViewModel(application) {

    val repository: Repository get() = _repository

    companion object {
        private const val TAG = "PlaybackVM"
        private const val PRELOAD_AHEAD = 3
        private const val POLL_TIMEOUT_MS = 300_000L
        private const val IMAGE_POLL_TIMEOUT_MS = 1_800_000L
        private const val POLL_INTERVAL_MS = 300L
        private const val MAX_BACKOFF_MS = 5_000L

        val factory: ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T {
                val app = checkNotNull(extras[ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY])
                val diskCache = SimpleDiskCache(
                    cacheDir = java.io.File(app.cacheDir, "media-cache"),
                    maxSizeBytes = 256 * 1024 * 1024
                )
                val repo = Repository(RetrofitClient.api, diskCache)
                return PlaybackViewModel(application = app, _repository = repo) as T
            }
        }
    }

    // ── Public state ──────────────────────────────────────────────

    private val _uiState = MutableStateFlow(PlaybackUiState())
    val uiState: StateFlow<PlaybackUiState> = _uiState.asStateFlow()

    // Signals to the fragment that a new preload has been completed
    val preloadCompleted: MutableSharedFlow<String> = MutableSharedFlow(extraBufferCapacity = 16)

    // ── Book / scene metadata (set externally via preparePlayback) ─

    var bookId: String = ""
        private set
    var buildId: String = ""
        private set

    /**
     * Scene queue: each entry is a "chapterId:sceneId" key.
     * The player iterates scenes from book JSON — not TTS chunks.
     * TTS pipeline manages its own data internally; the player
     * just tries to fetch audio/video for each scene and uses
     * placeholder if not ready.
     */
    private var sceneQueue = mutableListOf<String>()
    private var currentIndex = 0

    val currentChapterId: String?
        get() = sceneQueue.getOrNull(currentIndex)?.substringBefore(':')
    val currentSceneId: String?
        get() = sceneQueue.getOrNull(currentIndex)?.substringAfter(':')
    var currentUnitIndex: Int = 0
        set(value) {
            if (value >= 0) {
                field = value
            }
        }

    // ── Scene data buffers ────────────────────────────────────────

    var currentIuSequence: List<IuImageItem>? = null
    var pendingSceneAudio: ByteArray? = null
    var pendingSceneVideo: ByteArray? = null
    var pendingSceneIuSequence: List<IuImageItem>? = null
    var lastProcessedSceneSequence: Long = 0
    private var sceneSeqCounter = 0L

    // ── Rotation / navigation state ───────────────────────────────

    var savedPlaybackPositionMs: Long = 0
    var persistedImage: Bitmap? = null
    var pendingSeekPositionMs: Long = -1
    var needsRotationResume = false
    var pendingExternalSeek: ActivePosition? = null
    private var isExecutingExternalSeek = false

    // ── Soft content refresh (regeneration completes while player is active) ─

    /**
     * Set by [refreshContent] when regeneration finishes while the player is
     * in PAUSED or PLAYING state. The next call to [resumePlayback] will
     * re-fetch the current scene's content instead of blindly resuming the
     * stale MediaPlayer.
     */
    var needsContentRefresh = false
        private set

    // ── Layer toggles ────────────────────────────────────────────

    var imageEnabled: Boolean = true
        private set
    var videoEnabled: Boolean = true
        private set

    // ── Preload ──────────────────────────────────────────────────

    private val preloadCache = mutableMapOf<String, PreloadedScene>()
    private val preloadJobs = mutableMapOf<String, Job>()
    private var preloadJob: Job? = null

    // ── Cleanup tracking ─────────────────────────────────────────

    var hasUnsavedChanges = false
        private set

    // ═══════════════════════════════════════════════════════════════
    //  PUBLIC API — called by activity coordinator
    // ═══════════════════════════════════════════════════════════════

    fun setVideoEnabled(enabled: Boolean) {
        videoEnabled = enabled
    }

    /**
     * Start playback from the beginning, or refresh content for the same book.
     *
     * Accepts scenes from book JSON order — the player iterates scenes, not TTS chunks.
     * TTS pipeline is decoupled: player tries to fetch audio/video per scene,
     * uses placeholder if not ready.
     *
     * When called for content refresh (same [bookId]), the current scene position
     * ([currentIndex]) is preserved.
     */
    fun preparePlayback(
        bookId: String,
        buildId: String,
        scenes: List<SceneRef>
    ) {
        val sceneKeys = scenes.map { "${it.chapterId}:${it.sceneId}" }
        Log.i(TAG, "preparePlayback: book=$bookId build=$buildId scenes=${scenes.size}")
        val prevBookId = this.bookId
        val prevBuildId = this.buildId
        val savedIndex = if (currentIndex in sceneKeys.indices) currentIndex else 0

        preloadCache.clear()
        this.bookId = bookId
        this.buildId = buildId
        sceneQueue.clear()
        sceneQueue.addAll(sceneKeys)

        // Preserve position during content refresh
        if (prevBookId == bookId && savedIndex in sceneKeys.indices) {
            currentIndex = savedIndex
            Log.i(TAG, "preparePlayback: preserved position at index $currentIndex")
        } else {
            currentIndex = 0
            Log.i(TAG, "preparePlayback: reset position to 0 (new book or different scenes)")
        }

        if (prevBuildId != buildId || prevBookId != bookId) {
            Log.i(TAG, "preparePlayback: generation changed (${prevBuildId}→$buildId), clearing cache")
            _repository.clearCache()
        } else {
            Log.i(TAG, "preparePlayback: same generation, keeping cache")
        }
        if (sceneKeys.isNotEmpty()) {
            Log.i(TAG, "preparePlayback → SCENE_READY (${sceneKeys.size} scenes, index=$currentIndex)")
            _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
        } else {
            Log.w(TAG, "preparePlayback → IDLE (no scenes)")
            _uiState.update { it.copy(phase = PlayerPhase.IDLE) }
        }
    }

    /**
     * Soft-refresh content after regeneration completes while the player is active.
     *
     * Unlike [preparePlayback], this preserves the current playback phase and
     * position when the player is PAUSED or PLAYING — it only updates the backing
     * data (scene keys, positions) and sets [needsContentRefresh] so the next
     * [resumePlayback] call will re-fetch the current scene's audio/image instead
     * of resuming the stale [MediaPlayer].
     *
     * For IDLE / SCENE_READY phases, it falls through to the same behavior as
     * [preparePlayback] (full reset to SCENE_READY).
     */
    fun refreshContent(
        bookId: String,
        buildId: String,
        scenes: List<SceneRef>
    ) {
        val sceneKeys = scenes.map { "${it.chapterId}:${it.sceneId}" }
        Log.i(TAG, "refreshContent: book=$bookId build=$buildId scenes=${scenes.size}")

        val prevBuildId = this.buildId

        // Preserve position relative to scene keys (not index), because the queue
        // is rebuilt and a scene may have been added/removed during regeneration.
        val currentSceneKey = sceneQueue.getOrNull(currentIndex)
        val newIndex = if (currentSceneKey != null) sceneKeys.indexOf(currentSceneKey) else -1

        preloadCache.clear()
        preloadJobs.clear()
        this.bookId = bookId
        this.buildId = buildId
        sceneQueue.clear()
        sceneQueue.addAll(sceneKeys)
        if (newIndex >= 0) {
            currentIndex = newIndex
        } else {
            currentIndex = 0
        }

        val currentPhase = _uiState.value.phase
        Log.i(TAG, "refreshContent: phase=$currentPhase index=$currentIndex (mapped $currentSceneKey → $newIndex)")

        // After regeneration the buildId typically does NOT change (the backend
        // updates content in-place). Always clear the repository cache so that
        // getSceneAudio / getSceneStoryboard hit the network and return newly
        // generated content instead of stale placeholder files from the old generation.
        Log.i(TAG, "refreshContent: clearing cache (build=$buildId, prevBuild=$prevBuildId)")
        _repository.clearCache()

        if (currentPhase == PlayerPhase.PLAYING) {
            // Player is actively playing — proactively reload the current scene
            // so the user hears fresh audio immediately without pressing Play again.
            // The MediaPlayer will be released by the fragment's onTrackEnd or
            // switchToNextPlayer when the stale track ends.
            needsContentRefresh = true
            pendingSceneAudio = null
            pendingSceneVideo = null
            pendingSceneIuSequence = null
            Log.i(TAG, "refreshContent: player PLAYING — proactively reloading current scene (index=$currentIndex)")
            // Trigger immediate reload: the next fragment tick will see
            // the state change to SCENE_READY (via stale player detection),
            // then resumePlayback with needsContentRefresh=true re-fetches.
            _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
            return
        }
        if (currentPhase == PlayerPhase.PAUSED) {
            // Player was paused — mark content as stale; the next resume will
            // re-fetch the current scene instead of resuming the old MediaPlayer.
            needsContentRefresh = true
            // Clear stale pending data so the fragment doesn't try to use it
            pendingSceneAudio = null
            pendingSceneVideo = null
            pendingSceneIuSequence = null
            Log.i(TAG, "refreshContent: player PAUSED — marked needsContentRefresh")
            return
        }
        if (sceneKeys.isNotEmpty()) {
            _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
        } else {
            _uiState.update { it.copy(phase = PlayerPhase.IDLE) }
        }
    }

    /**
     * Set the cover image (book/cover art shown before playback starts).
     */
    fun setCoverImage(bitmap: Bitmap) {
        _uiState.update { it.copy(coverImage = bitmap) }
    }

    /**
     * Set preview image (generated scene preview).
     */
    fun setPreviewImage(bitmap: Bitmap?) {
        _uiState.update { it.copy(previewImage = bitmap) }
    }

    /**
     * Update layer config (called when user toggles layers).
     */
    fun setImageEnabled(enabled: Boolean) {
        imageEnabled = enabled
    }

    /**
     * Pause playback. Updates the canonical phase to [PlayerPhase.PAUSED]
     * so the UI button driven by [PlaybackUiState.phase] reflects the
     * actual player state — the single source of truth.
     */
    fun pausePlayback() {
        _uiState.update { it.copy(phase = PlayerPhase.PAUSED) }
    }

    /**
     * Resume playback. Restores the phase to [PlayerPhase.PLAYING], or — if
     * [needsContentRefresh] is set (content was regenerated while paused) —
     * re-fetches the current scene from scratch so the user hears fresh audio.
     */
    fun resumePlayback() {
        if (needsContentRefresh) {
            needsContentRefresh = false
            Log.i(TAG, "resumePlayback: content changed, re-fetching current scene (index=$currentIndex)")
            // Re-fetch current scene — will set phase to DOWNLOADING → PLAYING
            viewModelScope.launch {
                _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING) }
                playNext()
            }
            return
        }
        _uiState.update { it.copy(phase = PlayerPhase.PLAYING) }
    }

    /**
     * Handle a media error that made the current [MediaPlayer] unusable.
     * Transitions the phase to [PlayerPhase.SCENE_READY] and records the
     * error so the UI can show the Play button and an error message.
     * The caller (PlayFragment) is responsible for releasing the broken
     * player.
     */
    fun handlePlaybackError(errorMsg: String) {
        Log.w(TAG, "handlePlaybackError: $errorMsg")
        _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY, errorMessage = errorMsg) }
    }

    /**
     * Handle a null player returned by createPlayer.
     * The scene already emitted PLAYING but no player exists — reset to
     * SCENE_READY so the button shows Play and the user can retry.
     */
    fun handleNullPlayer(sceneKey: String) {
        Log.w(TAG, "handleNullPlayer: no player for $sceneKey — resetting to SCENE_READY")
        _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY, errorMessage = "Audio playback failed: file corrupted") }
    }

    // ═══════════════════════════════════════════════════════════════
    //  PLAYBACK CONTROL
    // ═══════════════════════════════════════════════════════════════

    fun playSceneQueue() {
        if (sceneQueue.isEmpty()) {
            Log.w(TAG, "playSceneQueue: empty queue")
            return
        }
        Log.i(TAG, "playSceneQueue: ${sceneQueue.size} scenes")
        // Reset error state and IU sequence before starting
        _uiState.update { it.copy(errorMessage = null, missingIuPosition = null) }
        currentIuSequence = null
        currentUnitIndex = 0
        lastProcessedSceneSequence = 0
        currentIndex = 0
        preloadJobs.clear()
        preloadAhead(includeCurrent = true)
        playNext()
    }

    fun resumeFromCurrentScene() {
        needsRotationResume = false
        if (sceneQueue.isEmpty()) {
            Log.w(TAG, "resumeFromCurrentScene: empty queue")
            return
        }

        // Если контент был перегенерирован (needsContentRefresh=true),
        // сбрасываем savedPlaybackPositionMs — новый контент может иметь
        // другую длительность, и seek по старой позиции приведёт к ошибке.
        if (needsContentRefresh) {
            Log.i(TAG, "resumeFromCurrentScene: content was refreshed — discarding old seek position")
            pendingSeekPositionMs = -1L
            savedPlaybackPositionMs = 0L
            needsContentRefresh = false
            // Принудительно очищаем кеш репозитория, чтобы скачать свежий контент
            _repository.clearCache()
        } else {
            pendingSeekPositionMs = savedPlaybackPositionMs
        }

        preloadCache.clear()
        preloadJobs.clear()
        preloadAhead(includeCurrent = true)
        playNext()
    }

    fun rotationRecovery() {
        needsRotationResume = true
        _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
    }

    fun onAudioCompleted() {
        Log.i(TAG, "onAudioCompleted: index=$currentIndex")
        currentIndex++
        playNext()
    }

    fun getCurrentSceneKey(): String? {
        return sceneQueue.getOrNull(currentIndex)
    }

    val currentSceneIndex: Int get() = currentIndex
    val sceneQueueSize: Int get() = sceneQueue.size

    fun getPreloadedScene(index: Int): PreloadedScene? {
        if (index < 0 || index >= sceneQueue.size) return null
        val key = "${buildId}_${sceneQueue[index]}"
        return preloadCache[key]
    }

    fun tryPreloadNextScene(): PreloadedScene? {
        return getPreloadedScene(currentIndex + 1)
    }

    // ── External navigation (from Navigate/Edit fragments) ───────

    fun seekToPosition(chapterId: String, sceneId: String, unitIndex: Int, unitId: String? = null) {
        val sceneKey = "${chapterId}:${sceneId}"
        val idx = sceneQueue.indexOf(sceneKey)
        if (idx < 0) {
            Log.w(TAG, "seekToPosition: scene $sceneKey not found — trying refresh from backend")
            if (bookId.isBlank()) {
                val pos = ActivePosition(chapterId, sceneId, unitId, null, unitIndex)
                _uiState.update { it.copy(missingIuPosition = pos) }
                pendingExternalSeek = null
                return
            }
            // Refresh scene queue from book JSON
            viewModelScope.launch {
                val bookData = runCatching { _repository.getBook(bookId) }.getOrNull()
                if (bookData != null) {
                    // Thin-client: server-computed flat scene list (with legacy fallback)
                    val allScenes = bookData.sceneRefs()
                    val allKeys = allScenes.map { "${it.chapterId}:${it.sceneId}" }
                    val newIdx = allKeys.indexOf(sceneKey)
                    if (newIdx >= 0) {
                        // Update queue with all scenes
                        sceneQueue.clear()
                        sceneQueue.addAll(allKeys)
                        currentIndex = newIdx
                        _uiState.update { it.copy(missingIuPosition = null) }
                        pendingExternalSeek = ActivePosition(chapterId, sceneId, unitId, null, unitIndex)
                        Log.i(TAG, "seekToPosition: found $sceneKey at index $newIdx after refresh")
                    } else {
                        Log.w(TAG, "seekToPosition: still not found after refresh")
                        _uiState.update { it.copy(missingIuPosition = ActivePosition(chapterId, sceneId, unitId, null, unitIndex)) }
                        pendingExternalSeek = null
                    }
                } else {
                    _uiState.update { it.copy(missingIuPosition = ActivePosition(chapterId, sceneId, unitId, null, unitIndex)) }
                    pendingExternalSeek = null
                }
            }
            return
        }
        Log.i(TAG, "seekToPosition: $chapterId/$sceneId unit=$unitIndex index=$idx")
        _uiState.update { it.copy(missingIuPosition = null) }
        pendingExternalSeek = ActivePosition(chapterId, sceneId, unitId, null, unitIndex)
        currentIndex = idx
    }

    fun clearMissingIu() {
        _uiState.update { it.copy(missingIuPosition = null) }
    }

    /**
     * Ensure the player is initialized with chunk data for [targetBookId].
     * Fetches chunks from the backend and calls [preparePlayback] if [bookId] is blank.
     * Safe to call multiple times — no-op if already initialized.
     */
    fun ensureInitialized(targetBookId: String, targetBuildId: String) {
        if (bookId.isNotBlank() && bookId == targetBookId) {
            Log.i(TAG, "ensureInitialized: already initialized for $targetBookId (${sceneQueue.size} scenes)")
            return
        }
        Log.i(TAG, "ensureInitialized: need init for $targetBookId build=$targetBuildId")
        viewModelScope.launch {
            val scenes = mutableListOf<SceneRef>()
            var coverScene: SceneRef? = null

            // Thin-client: server-computed flat scene list (with legacy fallback)
            val bookData = runCatching { _repository.getBook(targetBookId) }.getOrNull()
            if (bookData != null) {
                scenes.addAll(bookData.sceneRefs())
                coverScene = scenes.firstOrNull { it.sceneType == "cover" }
            }

            Log.i(TAG, "ensureInitialized: built ${scenes.size} scenes from book JSON")
            preparePlayback(targetBookId, targetBuildId, scenes)

            // Load cover from first scene
            val firstScene = coverScene ?: scenes.firstOrNull()
            if (firstScene != null) {
                loadCoverIntoState(firstScene.chapterId, firstScene.sceneId)
            }
        }
    }

    private suspend fun loadCoverIntoState(chapterId: String?, sceneId: String?) {
        val chId = chapterId ?: return
        val scId = sceneId ?: return
        val bitmap = runCatching {
            val sb = _repository.getSceneStoryboard(bookId, chId, scId, buildId)
            if (sb.ius.isNotEmpty()) {
                val iu = sb.ius.first()
                val imgBytes = _repository.getIuImage(
                    bookId,
                    chId,
                    scId,
                    iu.unit_id,
                    sb.build_id.ifBlank { buildId }
                )
                MediaDecoder.decodeBitmap(imgBytes)
            } else null
        }.getOrElse {
            Log.w(TAG, "loadCoverIntoState: failed to load cover for $chapterId/$sceneId")
            null
        }
        if (bitmap != null) {
            setCoverImage(bitmap)
        }
    }

    fun executePendingSeek() {
        val seek = pendingExternalSeek ?: return
        pendingExternalSeek = null

        if (currentIndex >= sceneQueue.size) {
            Log.w(TAG, "executePendingSeek: currentIndex out of bounds, falling back")
            playSceneQueue()
            return
        }

        _uiState.update { it.copy(missingIuPosition = null) }
        isExecutingExternalSeek = true
        currentUnitIndex = seek.unitIndex
        SharedPositionManager.navigateTo(seek)
        _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING) }
        needsContentRefresh = false

        preloadCache.clear()
        preloadJobs.clear()
        preloadAhead(includeCurrent = true)
        playNext()
    }

    // ── State reset ──────────────────────────────────────────────

    fun clearPlaybackState() {
        preloadCache.clear()
        preloadJobs.clear()
        sceneQueue.clear()
        currentIndex = 0
        currentUnitIndex = 0
        currentIuSequence = null
        pendingSceneAudio = null
        pendingSceneVideo = null
        pendingSceneIuSequence = null
        lastProcessedSceneSequence = 0
        needsRotationResume = false
        pendingExternalSeek = null
        _uiState.update {
            PlaybackUiState()
        }
    }

    fun closeBook() {
        clearPlaybackState()
        bookId = ""
        buildId = ""
        persistedImage = null
        SharedPositionManager.navigateTo(chapterId = null, sceneId = null)
        _uiState.update {
            PlaybackUiState()
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  INTERNAL — playback logic
    // ═══════════════════════════════════════════════════════════════

    private fun playNext() {
        Log.d(TAG, "playNext: index=$currentIndex queueSize=${sceneQueue.size}")
        if (currentIndex >= sceneQueue.size) {
            Log.i(TAG, "playNext: end of queue → SCENE_READY (resetting index to 0 for replay)")
            currentIndex = 0
            _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
            return
        }

        val sceneKey = sceneQueue[currentIndex]
        val chId = sceneKey.substringBefore(':')
        val scId = sceneKey.substringAfter(':')
        Log.i(TAG, "playNext: loading scene[$currentIndex]=$sceneKey")

        if (!isExecutingExternalSeek) {
            currentUnitIndex = 0
            SharedPositionManager.navigateTo(
                chapterId = chId,
                sceneId = scId,
                unitId = null,
                chunkId = sceneKey,
                unitIndex = 0
            )
        }
        isExecutingExternalSeek = false

        val cached = preloadCache.remove("${buildId}_$sceneKey")
        if (cached != null) {
            Log.i(TAG, "playNext: using preloaded data for $sceneKey")
            emitScene(cached.audioBytes, cached.videoBytes, cached.iuSequence)
            preloadAhead()
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING) }

            preloadJobs[sceneKey]?.join()

            val cachedAfter = preloadCache.remove("${buildId}_$sceneKey")
            if (cachedAfter != null) {
                Log.i(TAG, "playNext: preload completed for $sceneKey")
                emitScene(cachedAfter.audioBytes, cachedAfter.videoBytes, cachedAfter.iuSequence)
                preloadAhead()
                return@launch
            }

            val sceneData = runCatching {
                retryWithBackoff(maxRetries = 3, initialDelayMs = 1000, maxDelayMs = 5000) {
                    fetchSceneData(sceneKey)
                }
            }.getOrElse { err ->
                val msg = "Scene $sceneKey: ${err.message} (${err::class.simpleName})"
                Log.e(TAG, "playNext: failed to load $sceneKey after retries — $msg", err)
                Log.w(TAG, "playNext: → SCENE_READY (error)")
                _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY, errorMessage = msg) }
                return@launch
            }

            Log.i(TAG, "delivering scene $sceneKey")
            _uiState.update { it.copy(previewImage = null) }
            emitScene(sceneData.audioBytes, sceneData.videoBytes, sceneData.iuSequence)
            preloadAhead()
        }
    }

    private fun emitScene(audio: ByteArray, video: ByteArray?, iuSequence: List<IuImageItem>?) {
        val seq = ++sceneSeqCounter
        Log.i(TAG, "emitScene #$seq: audio=${audio.size}B ius=${iuSequence?.size ?: 0} → PLAYING")
        pendingSceneAudio = audio
        pendingSceneVideo = video
        pendingSceneIuSequence = iuSequence
        _uiState.update { it.copy(phase = PlayerPhase.PLAYING, chunkSequence = seq) }
    }

    private fun preloadAhead(includeCurrent: Boolean = false) {
        val start = if (includeCurrent) 0 else 1
        val currentBldId = buildId
        if (currentBldId.isBlank()) {
            Log.w(TAG, "preloadAhead: buildId is blank, skipping")
            return
        }

        preloadJob?.cancel()

        val job = viewModelScope.launch {
            // Collect all scenes to preload (by scene key)
            val scenesToPreload = (start..PRELOAD_AHEAD).mapNotNull { offset ->
                val idx = currentIndex + offset
                if (idx < sceneQueue.size) sceneQueue[idx] else null
            }.filter { !preloadCache.containsKey("${currentBldId}_$it") }

            if (scenesToPreload.isEmpty()) return@launch

            Log.i(TAG, "preloading ${scenesToPreload.size} scenes ahead: ${scenesToPreload.joinToString(",")}")

            // Launch all fetchSceneData calls in parallel
            coroutineScope {
                scenesToPreload.map { sceneKey ->
                    async {
                        sceneKey to runCatching { fetchSceneData(sceneKey) }.getOrNull()
                    }
                }.forEach { deferred ->
                    val (sceneKey, data) = deferred.await()
                    if (data != null) {
                        preloadCache["${currentBldId}_$sceneKey"] = data
                        preloadCompleted.tryEmit(sceneKey)
                        Log.i(TAG, "preloaded scene: $sceneKey — ${data.iuSequence.size} IUs (build=$currentBldId)")
                    } else {
                        Log.w(TAG, "preload failed for scene: $sceneKey — will load on demand")
                    }
                }
            }
        }

        preloadJob = job

        preloadJobs.clear()
        val firstSceneKey = sceneQueue.getOrNull(currentIndex + start)
        if (firstSceneKey != null && !preloadCache.containsKey("${currentBldId}_$firstSceneKey")) {
            preloadJobs[firstSceneKey] = job
        }
    }

    private suspend fun fetchSceneData(sceneKey: String): PreloadedScene = coroutineScope {
        val chId = sceneKey.substringBefore(':')
        val scId = sceneKey.substringAfter(':')
        Log.d(TAG, "fetchSceneData: $sceneKey")

        // Check scene status from backend — scene-based endpoint, no chunk dependency
        val status = runCatching {
            _repository.getSceneStatus(bookId, chId, scId, buildId)
        }.getOrNull()

        // If audio isn't ready yet, throw so retryWithBackoff retries
        if (status == null || !status.audio_ready) {
            // Don't throw immediately on first attempt — the scene might be legitimately
            // not ready (still generating). The retry loop handles backoff.
            if (status == null) {
                Log.w(TAG, "fetchSceneData: status check failed for $sceneKey — will retry")
            } else {
                Log.w(TAG, "fetchSceneData: audio not ready for $sceneKey (ready=${status.audio_ready}) — will retry")
            }
            throw Exception("Audio not ready for $sceneKey")
        }

        val audioDeferred = async {
            runCatching {
                _repository.getSceneAudio(bookId, chId, scId, buildId).also {
                    Log.i(TAG, "audio fetched for $sceneKey: ${it.size} bytes")
                }
            }.getOrElse { e ->
                Log.w(TAG, "audio not ready yet for $sceneKey: ${e.message}")
                byteArrayOf()
            }
        }
        val videoDeferred = async {
            if (status.video_ready) {
                runCatching { _repository.getSceneVideo(bookId, chId, scId, buildId) }.getOrNull().also {
                    Log.d(TAG, if (it != null) "video fetched: ${it.size} bytes" else "video null")
                }
            } else null
        }
        val iuDeferred = async { fetchIuSequence(chId, scId) }

        val audio = audioDeferred.await()
        val videoBytes = videoDeferred.await()
        val iuSequence = iuDeferred.await()

        PreloadedScene(audio, videoBytes, iuSequence)
    }

    private suspend fun fetchIuSequence(chapterId: String, sceneId: String): List<IuImageItem> {
        return runCatching {
            val storyboard = _repository.getSceneStoryboard(bookId, chapterId, sceneId, buildId)
            Log.i(TAG, "[UNITS] scene $chapterId/$sceneId storyboard: ${storyboard.ius.size} IUs")
            if (storyboard.ius.isNotEmpty()) {
                coroutineScope {
                    storyboard.ius.map { iu ->
                        async {
                            // N1: duration_ms is server-computed (interval → estimate → default);
                            // the client no longer re-derives it. If the server ever omits it
                            // (contract violation), log and use a minimal floor rather than a
                            // silent magic default that hides the missing field.
                            val durationMs = iu.duration_ms ?: run {
                                Log.w(TAG, "IU ${iu.unit_id} missing server duration_ms — using floor")
                                200L
                            }
                            val iuText = iu.text
                            runCatching {
                                Log.d(TAG, "fetching IU image: ${iu.unit_id} (dur=$durationMs ms)")
                                val imgBytes = _repository.getIuImage(bookId, chapterId, sceneId, iu.unit_id, buildId)
                                val bmp = withContext(Dispatchers.Default) { MediaDecoder.decodeBitmap(imgBytes) }
                                IuImageItem(bmp, durationMs, iu.unit_id, iuText, IuStatus.READY)
                            }.getOrNull() ?: run {
                                Log.w(TAG, "IU image NOT GENERATED: ${iu.unit_id} — using placeholder")
                                IuImageItem(null, durationMs, iu.unit_id, iuText, IuStatus.NOT_GENERATED)
                            }
                        }
                    }.awaitAll()
                }
            } else {
                Log.w(TAG, "storyboard empty: chapterId=$chapterId sceneId=$sceneId")
                emptyList()
            }
        }.getOrDefault(emptyList()).also {
            val missing = it.count { item -> item.status == IuStatus.NOT_GENERATED }
            Log.i(TAG, "IU sequence loaded: ${it.size} images ($missing not generated)")
        }
    }

    /** Retry a suspend block with exponential backoff on failure. */
    /** Retry a suspend block with exponential backoff on failure. */
    private suspend fun <T> retryWithBackoff(
        maxRetries: Int = 3,
        initialDelayMs: Long = 1000,
        maxDelayMs: Long = 10000,
        block: suspend () -> T
    ): T {
        var delayMs = initialDelayMs
        // First maxRetries-1 attempts with retry; last attempt throws on failure
        repeat(maxRetries - 1) { attempt ->
            runCatching { return block() }.getOrElse { e ->
                Log.w(TAG, "retry ${attempt + 1}/$maxRetries failed: ${e.message}")
                delay(delayMs)
                delayMs = (delayMs * 2).coerceAtMost(maxDelayMs)
            }
        }
        // Last attempt — let it throw
        return block()
    }

}

// ── Player UI State ──────────────────────────────────────────────

data class PlaybackUiState(
    val phase: PlayerPhase = PlayerPhase.IDLE,
    val coverImage: Bitmap? = null,
    val previewImage: Bitmap? = null,
    val errorMessage: String? = null,
    val chunkSequence: Long = 0,
    val missingIuPosition: ActivePosition? = null
)
