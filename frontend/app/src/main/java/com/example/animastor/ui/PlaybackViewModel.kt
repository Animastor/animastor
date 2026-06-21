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
 * Handles ONLY playback logic: chunk queue management, preloading, IU cycling,
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

    // Signals to the fragment that a new chunk has been emitted
    val preloadCompleted: MutableSharedFlow<String> = MutableSharedFlow(extraBufferCapacity = 16)

    // ── Book / chunk metadata (set externally via preparePlayback) ─

    var bookId: String = ""
        private set
    var buildId: String = ""
        private set

    private var chunkQueue = mutableListOf<String>()
    private var currentIndex = 0
    private val chunkPositions = mutableMapOf<String, Pair<String?, String?>>()

    var currentChapterId: String? = null
        private set
    var currentSceneId: String? = null
        private set
    var currentUnitIndex: Int = 0
        set(value) {
            if (value >= 0) {
                field = value
            }
        }

    // ── Chunk data buffers ────────────────────────────────────────

    var currentIuSequence: List<IuImageItem>? = null
    var pendingChunkAudio: ByteArray? = null
    var pendingChunkVideo: ByteArray? = null
    var pendingChunkIuSequence: List<IuImageItem>? = null
    var lastProcessedChunkSequence: Long = 0
    private var chunkSeqCounter = 0L

    // ── Rotation / navigation state ───────────────────────────────

    var savedPlaybackPositionMs: Long = 0
    var persistedImage: Bitmap? = null
    var pendingSeekPositionMs: Long = -1
    var needsRotationResume = false
    var pendingExternalSeek: ActivePosition? = null
    private var isExecutingExternalSeek = false

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
     * Start playback from the beginning.
     */
    fun preparePlayback(
        bookId: String,
        buildId: String,
        chunkIds: List<String>,
        chunkPositions: Map<String, Pair<String?, String?>>
    ) {
        Log.i(TAG, "preparePlayback: book=$bookId build=$buildId chunks=${chunkIds.size}")
        // Only clear repository cache if generation changed (different buildId or different book)
        val prevBookId = this.bookId
        val prevBuildId = this.buildId
        preloadCache.clear()
        this.bookId = bookId
        this.buildId = buildId
        chunkQueue.clear()
        chunkQueue.addAll(chunkIds)
        this.chunkPositions.clear()
        this.chunkPositions.putAll(chunkPositions)
        if (prevBuildId != buildId || prevBookId != bookId) {
            Log.i(TAG, "preparePlayback: generation changed (${prevBuildId}→$buildId), clearing cache")
            _repository.clearCache()
        } else {
            Log.i(TAG, "preparePlayback: same generation, keeping cache")
        }
        if (chunkIds.isNotEmpty()) {
            Log.i(TAG, "preparePlayback → SCENE_READY (${chunkIds.size} chunks)")
            _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
        } else {
            Log.w(TAG, "preparePlayback → IDLE (no chunks)")
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
     * Resume playback. Restores the phase to [PlayerPhase.PLAYING].
     */
    fun resumePlayback() {
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
     * The chunk already emitted PLAYING but no player exists — reset to
     * SCENE_READY so the button shows Play and the user can retry.
     */
    fun handleNullPlayer(chunkId: String) {
        Log.w(TAG, "handleNullPlayer: no player for $chunkId — resetting to SCENE_READY")
        _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY, errorMessage = "Audio playback failed: file corrupted") }
    }

    // ═══════════════════════════════════════════════════════════════
    //  PLAYBACK CONTROL
    // ═══════════════════════════════════════════════════════════════

    fun playSceneQueue() {
        if (chunkQueue.isEmpty()) {
            Log.w(TAG, "playSceneQueue: empty queue")
            return
        }
        Log.i(TAG, "playSceneQueue: ${chunkQueue.size} chunks")
        // Reset error state and IU sequence before starting
        _uiState.update { it.copy(errorMessage = null, missingIuPosition = null) }
        currentIuSequence = null
        currentUnitIndex = 0
        lastProcessedChunkSequence = 0
        currentIndex = 0
        preloadJobs.clear()
        preloadAhead(includeCurrent = true)
        playNext()
    }

    fun resumeFromCurrentScene() {
        needsRotationResume = false
        if (chunkQueue.isEmpty()) {
            Log.w(TAG, "resumeFromCurrentScene: empty queue")
            return
        }
        pendingSeekPositionMs = savedPlaybackPositionMs
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

    fun getCurrentChunkId(): String? {
        return chunkQueue.getOrNull(currentIndex)
    }

    val currentChunkIndex: Int get() = currentIndex
    val chunkQueueSize: Int get() = chunkQueue.size

    fun getPreloadedScene(index: Int): PreloadedScene? {
        if (index < 0 || index >= chunkQueue.size) return null
        val key = "${buildId}_${chunkQueue[index]}"
        return preloadCache[key]
    }

    fun tryPreloadNextScene(): PreloadedScene? {
        return getPreloadedScene(currentIndex + 1)
    }

    // ── External navigation (from Navigate/Edit fragments) ───────

    fun seekToPosition(chapterId: String, sceneId: String, unitIndex: Int, unitId: String? = null) {
        val chunkId = chunkPositions.entries.firstOrNull {
            it.value.first == chapterId && it.value.second == sceneId
        }?.key
        if (chunkId == null || !chunkQueue.contains(chunkId)) {
            Log.w(TAG, "seekToPosition: chunk not found for $chapterId/$sceneId — trying refresh from backend")
            // Try to refresh chunk list from backend before showing missing overlay
            if (bookId.isBlank()) {
                Log.w(TAG, "seekToPosition: bookId is blank — can't refresh, showing overlay")
                val pos = ActivePosition(
                    chapterId = chapterId,
                    sceneId = sceneId,
                    unitId = unitId,
                    chunkId = null,
                    unitIndex = unitIndex
                )
                _uiState.update { it.copy(missingIuPosition = pos) }
                pendingExternalSeek = null
                return
            }
            viewModelScope.launch {
                val fresh = runCatching { _repository.getAllChunks(bookId) }.getOrNull()
                if (fresh != null) {
                    var found = false
                    for (cid in fresh.chunk_ids) {
                        if (!chunkQueue.contains(cid)) {
                            chunkQueue.add(cid)
                            // Also try to get position for this new chunk
                            runCatching {
                                val sb = _repository.getChunkStoryboard(cid)
                                chunkPositions[cid] = Pair(sb.chapter_id, sb.scene_id)
                            }
                        }
                        // Check if the target chunk is now available
                        if (!found) {
                            val refreshChunkId = chunkPositions.entries.firstOrNull {
                                it.value.first == chapterId && it.value.second == sceneId
                            }?.key
                            if (refreshChunkId != null && chunkQueue.contains(refreshChunkId)) {
                                found = true
                                Log.i(TAG, "seekToPosition: found after refresh — $refreshChunkId")
                                _uiState.update { it.copy(missingIuPosition = null) }
                                pendingExternalSeek = ActivePosition(chapterId, sceneId, unitId, refreshChunkId, unitIndex)
                                // If PlayFragment is visible, execute immediately
                                // pendingExternalSeek will be picked up by the fragment
                            }
                        }
                    }
                    if (!found) {
                        Log.w(TAG, "seekToPosition: still not found after refresh — showing missing overlay")
                        val pos = ActivePosition(
                            chapterId = chapterId,
                            sceneId = sceneId,
                            unitId = unitId,
                            chunkId = chunkId,
                            unitIndex = unitIndex
                        )
                        _uiState.update { it.copy(missingIuPosition = pos) }
                        pendingExternalSeek = null
                    }
                } else {
                    Log.w(TAG, "seekToPosition: refresh failed — showing missing overlay")
                    val pos = ActivePosition(
                        chapterId = chapterId,
                        sceneId = sceneId,
                        unitId = unitId,
                        chunkId = chunkId,
                        unitIndex = unitIndex
                    )
                    _uiState.update { it.copy(missingIuPosition = pos) }
                    pendingExternalSeek = null
                }
            }
            return
        }
        Log.i(TAG, "seekToPosition: $chapterId/$sceneId unit=$unitIndex chunk=$chunkId")
        _uiState.update { it.copy(missingIuPosition = null) }
        pendingExternalSeek = ActivePosition(chapterId, sceneId, unitId, chunkId, unitIndex)
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
            Log.i(TAG, "ensureInitialized: already initialized for $targetBookId (${chunkQueue.size} chunks)")
            return
        }
        Log.i(TAG, "ensureInitialized: need init for $targetBookId build=$targetBuildId (current bookId='$bookId')")
        viewModelScope.launch {
            val allChunks = runCatching { _repository.getAllChunks(targetBookId) }.getOrNull()
            val chunkIds = allChunks?.chunk_ids?.toList() ?: emptyList()
            val positions = mutableMapOf<String, Pair<String?, String?>>()
            var coverChunkId: String? = null
            for (cid in chunkIds) {
                runCatching {
                    _repository.getChunkStoryboard(cid).let { sb ->
                        positions[cid] = Pair(sb.chapter_id, sb.scene_id)
                        if (sb.scene_type == "cover") {
                            coverChunkId = cid
                        }
                    }
                }
            }
            Log.i(TAG, "ensureInitialized: fetched ${chunkIds.size} chunks, ${positions.size} positions")
            preparePlayback(targetBookId, targetBuildId, chunkIds, positions)
            val coverId = coverChunkId ?: chunkIds.firstOrNull()
            if (coverId != null) {
                loadCoverIntoState(coverId)
            }
        }
    }

    private suspend fun loadCoverIntoState(coverId: String) {
        val bitmap = runCatching {
            val sb = _repository.getChunkStoryboard(coverId)
            if (sb.ius.isNotEmpty()) {
                val iu = sb.ius.first()
                val imgBytes = _repository.getIuImage(
                    sb.book_id ?: bookId,
                    sb.chapter_id ?: "",
                    sb.scene_id ?: "",
                    iu.unit_id,
                    sb.build_id
                )
                MediaDecoder.decodeBitmap(imgBytes)
            } else null
        }.getOrElse {
            runCatching {
                val imgBytes = _repository.getChunkImage(coverId, buildId)
                withContext(Dispatchers.Default) { MediaDecoder.decodeBitmap(imgBytes) }
            }.getOrNull()
        }
        if (bitmap != null) {
            setCoverImage(bitmap)
        }
    }

    fun executePendingSeek() {
        val seek = pendingExternalSeek ?: return
        pendingExternalSeek = null

        val idx = chunkQueue.indexOf(seek.chunkId)
        if (idx < 0) {
            Log.w(TAG, "executePendingSeek: chunk ${seek.chunkId} not found, falling back")
            playSceneQueue()
            return
        }

        _uiState.update { it.copy(missingIuPosition = null) }
        isExecutingExternalSeek = true
        currentIndex = idx
        currentUnitIndex = seek.unitIndex
        SharedPositionManager.navigateTo(seek)
        _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING) }

        preloadCache.clear()
        preloadJobs.clear()
        preloadAhead(includeCurrent = true)
        playNext()
    }

    // ── State reset ──────────────────────────────────────────────

    fun clearPlaybackState() {
        chunkPositions.clear()
        preloadCache.clear()
        preloadJobs.clear()
        chunkQueue.clear()
        currentIndex = 0
        currentChapterId = null
        currentSceneId = null
        currentUnitIndex = 0
        currentIuSequence = null
        pendingChunkAudio = null
        pendingChunkVideo = null
        pendingChunkIuSequence = null
        lastProcessedChunkSequence = 0
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
        Log.d(TAG, "playNext: index=$currentIndex queueSize=${chunkQueue.size}")
        if (currentIndex >= chunkQueue.size) {
            Log.i(TAG, "playNext: end of queue → SCENE_READY")
            _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
            return
        }

        val id = chunkQueue[currentIndex]
        Log.i(TAG, "playNext: loading chunk[$currentIndex]=$id")

        val pos = chunkPositions[id]
        currentChapterId = pos?.first
        currentSceneId = pos?.second

        if (!isExecutingExternalSeek) {
            currentUnitIndex = 0
            SharedPositionManager.navigateTo(
                chapterId = pos?.first,
                sceneId = pos?.second,
                unitId = null,
                chunkId = id,
                unitIndex = 0
            )
        }
        isExecutingExternalSeek = false

        val cached = preloadCache.remove("${buildId}_$id")
        if (cached != null) {
            Log.i(TAG, "playNext: using preloaded data for $id")
            val chunkPos = chunkPositions[id]
            currentChapterId = chunkPos?.first
            currentSceneId = chunkPos?.second
            emitChunk(cached.audioBytes, cached.videoBytes, cached.iuSequence)
            preloadAhead()
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING) }

            preloadJobs[id]?.join()

            val cachedAfter = preloadCache.remove("${buildId}_$id")
            if (cachedAfter != null) {
                // Verify freshness: check if audio_ready changed since preload
                val freshChunk = runCatching { _repository.getChunk(id, buildId) }.getOrNull()
                if (freshChunk != null && freshChunk.audio_ready && cachedAfter.audioBytes.isEmpty()) {
                    Log.i(TAG, "playNext: audio appeared since preload for $id — refetching")
                    val freshAudio = runCatching { _repository.getChunkAudio(id, buildId) }.getOrElse { byteArrayOf() }
                    Log.i(TAG, "playNext: preload completed for $id (refreshed audio)")
                    val preloadPos = chunkPositions[id]
                    currentChapterId = preloadPos?.first
                    currentSceneId = preloadPos?.second
                    emitChunk(freshAudio, cachedAfter.videoBytes, cachedAfter.iuSequence)
                } else {
                    Log.i(TAG, "playNext: preload completed for $id")
                    val preloadPos = chunkPositions[id]
                    currentChapterId = preloadPos?.first
                    currentSceneId = preloadPos?.second
                    emitChunk(cachedAfter.audioBytes, cachedAfter.videoBytes, cachedAfter.iuSequence)
                }
                preloadAhead()
                return@launch
            }

            val sceneData = runCatching {
                retryWithBackoff(maxRetries = 3, initialDelayMs = 1000, maxDelayMs = 5000) {
                    fetchSceneData(id)
                }
            }.getOrElse { err ->
                val msg = "Scene $id: ${err.message} (${err::class.simpleName})"
                Log.e(TAG, "playNext: failed to load $id after retries — $msg", err)
                Log.w(TAG, "playNext: → SCENE_READY (error)")
                _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY, errorMessage = msg) }
                return@launch
            }

            Log.i(TAG, "delivering chunk for $id")
            _uiState.update { it.copy(previewImage = null) }
            currentChapterId = pos?.first
            currentSceneId = pos?.second
            emitChunk(sceneData.audioBytes, sceneData.videoBytes, sceneData.iuSequence)
            preloadAhead()
        }
    }

    private fun emitChunk(audio: ByteArray, video: ByteArray?, iuSequence: List<IuImageItem>?) {
        val seq = ++chunkSeqCounter
        Log.i(TAG, "emitChunk #$seq: audio=${audio.size}B ius=${iuSequence?.size ?: 0} → PLAYING")
        pendingChunkAudio = audio
        pendingChunkVideo = video
        pendingChunkIuSequence = iuSequence
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
            // Collect all scenes to preload
            val scenesToPreload = (start..PRELOAD_AHEAD).mapNotNull { offset ->
                val idx = currentIndex + offset
                if (idx < chunkQueue.size) chunkQueue[idx] else null
            }.filter { !preloadCache.containsKey("${currentBldId}_$it") }

            if (scenesToPreload.isEmpty()) return@launch

            Log.i(TAG, "preloading ${scenesToPreload.size} scenes ahead: ${scenesToPreload.joinToString(",")}")

            // Launch all fetchSceneData calls in parallel
            coroutineScope {
                scenesToPreload.map { id ->
                    async {
                        id to runCatching { fetchSceneData(id) }.getOrNull()
                    }
                }.forEach { deferred ->
                    val (id, data) = deferred.await()
                    if (data != null) {
                        preloadCache["${currentBldId}_$id"] = data
                        preloadCompleted.tryEmit(id)
                        Log.i(TAG, "preloaded scene: $id — ${data.iuSequence.size} IUs (build=$currentBldId)")
                    } else {
                        Log.w(TAG, "preload failed for scene: $id — will load on demand")
                    }
                }
            }
        }

        preloadJob = job

        preloadJobs.clear()
        val firstId = chunkQueue.getOrNull(currentIndex + start)
        if (firstId != null && !preloadCache.containsKey("${currentBldId}_$firstId")) {
            preloadJobs[firstId] = job
        }
    }

    private suspend fun fetchSceneData(id: String): PreloadedScene = coroutineScope {
        Log.d(TAG, "fetchSceneData: $id")

        val chunk =runCatching { _repository.getChunk(id, buildId) }.getOrElse { err ->
            Log.w(TAG, "fetchSceneData: chunk $id not found in Redis: ${err.message}"
            )
            null
        }
        Log.i(TAG, "fetchSceneData: chunk $id audio_ready=${chunk?.audio_ready} image_ready=${chunk?.image_ready} video_ready=${chunk?.video_ready}")

        val audioDeferred = async {
            if (chunk?.audio_ready == true) {
                runCatching {
                    _repository.getChunkAudio(id, buildId).also {
                        Log.i(TAG, "audio fetched for $id: ${it.size} bytes")
                    }
                }.getOrElse { e ->
                    Log.w(TAG, "audio_ready=true but fetch failed for $id: ${e.message}")
                    byteArrayOf()
                }
            } else {
                Log.i(TAG, "audio not ready for $id, skipping fetch")
                byteArrayOf()
            }
        }
        val videoDeferred = async {
            if (chunk?.video_ready == true) {
                runCatching { _repository.getChunkVideo(id, buildId) }.getOrNull().also {
                    Log.d(TAG, if (it != null) "video fetched: ${it.size} bytes" else "video null")
                }
            } else null
        }
        val iuDeferred = async { fetchIuSequence(id) }

        val audio = audioDeferred.await()
        val videoBytes = videoDeferred.await()
        val iuSequence = iuDeferred.await()

        PreloadedScene(audio, videoBytes, iuSequence)
    }

    private suspend fun fetchIuSequence(id: String): List<IuImageItem> {
        return runCatching {
            val storyboard = _repository.getChunkStoryboard(id)
            chunkPositions[id] = Pair(storyboard.chapter_id, storyboard.scene_id)
            Log.i(TAG, "[UNITS] chunk=$id storyboard: ${storyboard.ius.size} IUs, build_id=${storyboard.build_id}")
            val chId = (storyboard.chapter_id?.takeIf { it.isNotBlank() } ?: currentChapterId) ?: ""
            val scId = (storyboard.scene_id?.takeIf { it.isNotBlank() } ?: currentSceneId) ?: ""
            val bkId = storyboard.book_id?.takeIf { it.isNotBlank() } ?: bookId
            val bldId = storyboard.build_id.ifBlank { buildId }
            if (storyboard.ius.isNotEmpty() && bldId.isNotBlank() && chId.isNotBlank()) {
                Log.i(TAG, "fetching ${storyboard.ius.size} IU images in parallel for chunk $id")
                coroutineScope {
                    storyboard.ius.map { iu ->
                        async {
                            val durationMs = when {
                                iu.start_ms != null && iu.end_ms != null -> {
                                    val real = iu.end_ms - iu.start_ms
                                    if (real > 0) real else fallbackDurationMs(iu.estimated_duration_sec)
                                }
                                else -> fallbackDurationMs(iu.estimated_duration_sec)
                            }
                            val iuText = iu.text
                            runCatching {
                                Log.d(TAG, "fetching IU image: ${iu.unit_id} (dur=$durationMs ms) bldId=$bldId")
                                val imgBytes = _repository.getIuImage(bkId, chId, scId, iu.unit_id, bldId)
                                val bmp = withContext(Dispatchers.Default) { MediaDecoder.decodeBitmap(imgBytes) }
                                IuImageItem(bmp, durationMs, iu.unit_id, iuText, IuStatus.READY)
                            }.getOrNull() ?: run {
                                Log.w(TAG, "IU image NOT GENERATED: ${iu.unit_id} — using placeholder")
                                IuImageItem(
                                    bitmap = null,
                                    durationMs = durationMs,
                                    unitId = iu.unit_id,
                                    text = iuText,
                                    status = IuStatus.NOT_GENERATED
                                )
                            }
                        }
                    }.awaitAll()
                }
            } else {
                Log.w(TAG, "storyboard empty or missing IDs: ius=${storyboard.ius.size} bldId=$bldId chId=$chId")
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

    /** Fallback duration when backend provides 0 / null. */
    private fun fallbackDurationMs(estimatedSec: Double?): Long {
        if (estimatedSec != null && estimatedSec > 0) {
            return (estimatedSec * 1000).toLong()
        }
        return 2000L
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
