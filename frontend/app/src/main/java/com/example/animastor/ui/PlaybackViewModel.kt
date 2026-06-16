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
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import kotlin.math.min

/**
 * ViewModel for the media player subsystem.
 * Handles ONLY playback logic: chunk queue management, sliding window preload,
 * IU cycling, position tracking, and UI state for the player.
 *
 * Designed to be independent of content generation — receives prepared data
 * via [preparePlayback] and [setCoverImage] methods called by the activity
 * coordinator after generation/loading completes.
 *
 * Playback model:
 * 1. User clicks Play → sequential window fill (chunk 0 → 1 → 2)
 * 2. As soon as chunk 0 is fully ready → start playback
 * 3. Window slides: preload chunk 3 while chunk 0 plays
 * 4. Chunk is only emitted when content for active layers is confirmed downloaded
 */
class PlaybackViewModel(
    application: Application,
    private val _repository: Repository
) : AndroidViewModel(application) {

    val repository: Repository get() = _repository

    companion object {
        private const val TAG = "PlaybackVM"
        private const val WINDOW_SIZE = 3

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

    // Signals to the fragment that a new chunk has been cached in the window
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

    // ── Sliding Window Preload ────────────────────────────────────
    //
    //   fill order: chunk[0] → chunk[1] → chunk[2]
    //               └─ as soon as chunk[0] ready → playNext() + continue filling
    //   slide: after playNext, fill chunk[currentIndex + WINDOW_SIZE]

    private val preloadWindow = mutableMapOf<String, PreloadedScene>()
    private var windowFillJob: Job? = null
    private var windowFillVersion = 0L  // incremented each fill cycle, for log tracing

    // ── Cleanup tracking ─────────────────────────────────────────

    var hasUnsavedChanges = false
        private set

    // ═══════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════
    //  PUBLIC API — called by activity coordinator
    // ═══════════════════════════════════════════════════════════════

    /**
     * Prepare the player for playback with ready chunk data.
     * Called by [MainActivity] after [GenerateViewModel] finishes
     * loading / generating content.
     */
    fun preparePlayback(
        bookId: String,
        buildId: String,
        chunkIds: List<String>,
        chunkPositions: Map<String, Pair<String?, String?>>
    ) {
        Log.i(TAG, "preparePlayback: book=$bookId chunks=${chunkIds.size}")
        preloadWindow.clear()
        this.bookId = bookId
        this.buildId = buildId
        chunkQueue.clear()
        chunkQueue.addAll(chunkIds)
        this.chunkPositions.clear()
        this.chunkPositions.putAll(chunkPositions)
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

    fun setVideoEnabled(enabled: Boolean) {
        videoEnabled = enabled
    }

    // ═══════════════════════════════════════════════════════════════
    //  PLAYBACK CONTROL
    // ═══════════════════════════════════════════════════════════════

    /**
     * Start playback from the beginning.
     * Fills the sliding window sequentially, then starts playing
     * as soon as chunk 0 is fully ready.
     */
    fun playSceneQueue() {
        if (chunkQueue.isEmpty()) {
            Log.w(TAG, "playSceneQueue: EMPTY QUEUE — abort")
            return
        }
        Log.i(TAG, "▶ playSceneQueue: ${chunkQueue.size} chunks, window=$WINDOW_SIZE")
        currentIndex = 0
        windowFillJob?.cancel()
        preloadWindow.clear()
        windowFillVersion++
        _uiState.update { it.copy(windowProgress = null) }

        windowFillJob = viewModelScope.launch {
            fillWindowSequential(0)
        }
        Log.i(TAG, "playSceneQueue: coroutine launched (v$windowFillVersion)")
    }

    /**
     * Resume playback after rotation or error.
     * Refills the window starting from the current (or saved) position.
     */
    fun resumeFromCurrentScene() {
        needsRotationResume = false
        if (chunkQueue.isEmpty()) {
            Log.w(TAG, "resumeFromCurrentScene: empty queue")
            return
        }
        pendingSeekPositionMs = savedPlaybackPositionMs
        windowFillJob?.cancel()
        preloadWindow.clear()
        _uiState.update { it.copy(windowProgress = null) }

        windowFillJob = viewModelScope.launch {
            fillWindowSequential(currentIndex)
        }
    }

    fun rotationRecovery() {
        needsRotationResume = true
        _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
    }

    /**
     * Called by [PlayFragment] when audio track ends naturally.
     * Advances to the next chunk — it should already be in the preload window.
     */
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

    /**
     * Get preloaded scene data for a given index from the sliding window.
     */
    fun getPreloadedScene(index: Int): PreloadedScene? {
        if (index < 0 || index >= chunkQueue.size) return null
        val id = chunkQueue[index]
        return preloadWindow[id]
    }

    /**
     * Get preloaded data for the next scene (used by fragment for audio chaining).
     */
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
                            runCatching {
                                val sb = _repository.getChunkStoryboard(cid)
                                chunkPositions[cid] = Pair(sb.chapter_id, sb.scene_id)
                            }
                        }
                        if (!found) {
                            val refreshChunkId = chunkPositions.entries.firstOrNull {
                                it.value.first == chapterId && it.value.second == sceneId
                            }?.key
                            if (refreshChunkId != null && chunkQueue.contains(refreshChunkId)) {
                                found = true
                                Log.i(TAG, "seekToPosition: found after refresh — $refreshChunkId")
                                _uiState.update { it.copy(missingIuPosition = null) }
                                pendingExternalSeek = ActivePosition(chapterId, sceneId, unitId, refreshChunkId, unitIndex)
                            }
                        }
                    }
                    if (!found) {
                        Log.w(TAG, "seekToPosition: still not found after refresh — showing missing overlay")
                        val pos = ActivePosition(
                            chapterId = chapterId, sceneId = sceneId,
                            unitId = unitId, chunkId = chunkId, unitIndex = unitIndex
                        )
                        _uiState.update { it.copy(missingIuPosition = pos) }
                        pendingExternalSeek = null
                    }
                } else {
                    Log.w(TAG, "seekToPosition: refresh failed — showing missing overlay")
                    val pos = ActivePosition(
                        chapterId = chapterId, sceneId = sceneId,
                        unitId = unitId, chunkId = chunkId, unitIndex = unitIndex
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
                val imgBytes = _repository.getChunkImage(coverId)
                MediaDecoder.decodeBitmap(imgBytes)
            }.getOrNull()
        }
        if (bitmap != null) {
            setCoverImage(bitmap)
        }
    }

    /**
     * Execute a pending seek to a specific chunk.
     * Resets the window and starts filling from the target position.
     */
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

        windowFillJob?.cancel()
        preloadWindow.clear()

        windowFillJob = viewModelScope.launch {
            fillWindowSequential(currentIndex)
        }
    }

    // ── State reset ──────────────────────────────────────────────

    fun clearPlaybackState() {
        chunkPositions.clear()
        preloadWindow.clear()
        windowFillJob?.cancel()
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
    //  INTERNAL — sliding window & playback logic
    // ═══════════════════════════════════════════════════════════════

    /**
     * Sequentially fill the preload window starting from [startIndex].
     * Loads up to WINDOW_SIZE chunks one by one.
     * As soon as chunk [startIndex] (offset 0) is ready, starts playback
     * while the rest of the window continues filling in the background.
     */
    private suspend fun fillWindowSequential(startIndex: Int) {
        val total = min(WINDOW_SIZE, chunkQueue.size - startIndex)
        val v = windowFillVersion
        _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING, windowProgress = "0/$total") }
        Log.i(TAG, "=== [WINDOW/$v] fill start: startIndex=$startIndex total=$total ===")

        var loadedCount = 0

        // Phase 1: fill the ENTIRE window sequentially (no concurrent playNext)
        for (offset in 0 until WINDOW_SIZE) {
            val idx = startIndex + offset
            if (idx >= chunkQueue.size) {
                Log.i(TAG, "[WINDOW/$v] done — queue end at offset=$offset")
                break
            }
            val id = chunkQueue[idx]
            if (preloadWindow.containsKey(id)) {
                Log.i(TAG, "[WINDOW/$v] skip $id — already in window")
                continue
            }

            Log.i(TAG, "▶ [WINDOW/$v] fetch offset=$offset chunk[$idx]=$id")
            val data = runCatching { fetchSceneData(id) }.getOrNull()
            if (data != null) {
                preloadWindow[id] = data
                loadedCount++
                Log.i(TAG, "✓ [WINDOW/$v] loaded $id: " +
                        "audio=${data.audioBytes.size}B " +
                        "video=${data.videoBytes?.size ?: "null"}B " +
                        "ius=${data.iuSequence.size} " +
                        "hasVideo=${data.hasVideo}")
            } else {
                Log.w(TAG, "✗ [WINDOW/$v] FAILED $id — fetchSceneData returned null")
            }

            _uiState.update { it.copy(windowProgress = "$loadedCount/$total") }
            Log.d(TAG, "[WINDOW/$v] progress: $loadedCount/$total (window has ${preloadWindow.size})")
        }

        Log.i(TAG, "=== [WINDOW/$v] fill complete: $loadedCount/$total loaded ===")

        // Phase 2: NOW start playback — window is full, chunks 0..WINDOW_SIZE-1 ready
        val firstId = chunkQueue.getOrNull(startIndex)
        if (firstId != null && preloadWindow.containsKey(firstId)) {
            Log.i(TAG, "▶ [WINDOW/$v] window full — starting playback from $firstId")
            playNext()
        } else {
            Log.w(TAG, "✗ [WINDOW/$v] window fill complete but first chunk $firstId not in window — can't start")
        }
    }

    /**
     * Play the current chunk from the preload window.
     * Falls back to on-demand loading only if the chunk is unexpectedly missing.
     */
    private fun playNext() {
        Log.d(TAG, "▶ playNext: index=$currentIndex queueSize=${chunkQueue.size} window.size=${preloadWindow.size}")

        if (currentIndex >= chunkQueue.size) {
            Log.i(TAG, "playNext: END OF QUEUE → SCENE_READY")
            _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY, windowProgress = null) }
            return
        }

        val id = chunkQueue[currentIndex]
        Log.i(TAG, "▶ playNext: chunk[$currentIndex]=$id (window has ${preloadWindow.size} items)")

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

        // Take from window (expected path)
        val sceneData = preloadWindow.remove(id)
        if (sceneData != null) {
            Log.i(TAG, "✓ playNext: from window for $id (window now has ${preloadWindow.size} items)")
            _uiState.update { it.copy(previewImage = null, windowProgress = null) }
            emitChunkWithReadinessCheck(id, sceneData)
            slideWindow()
            return
        }

        // Fallback: load on demand
        Log.w(TAG, "⚠ playNext: $id NOT in window! window keys=${preloadWindow.keys} — loading on demand...")
        viewModelScope.launch {
            _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING, windowProgress = null) }

            runCatching { fetchSceneData(id) }.getOrElse { err ->
                val msg = "Scene $id: ${err.message} (${err::class.simpleName})"
                Log.e(TAG, "playNext: on-demand FAILED $id — $msg", err)
                _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY, errorMessage = msg) }
                return@launch
            }.let { data ->
                Log.i(TAG, "✓ playNext: on-demand loaded $id")
                _uiState.update { it.copy(previewImage = null) }
                currentChapterId = pos?.first
                currentSceneId = pos?.second
                emitChunkWithReadinessCheck(id, data)
                slideWindow()
            }
        }
    }

    /**
     * Slide the window forward: preload the next unseen chunk
     * (currentIndex + WINDOW_SIZE) into the window.
     */
    private fun slideWindow() {
        val nextFillIndex = currentIndex + WINDOW_SIZE
        if (nextFillIndex >= chunkQueue.size) {
            Log.i(TAG, "[SLIDE] skip — queue end (nextFillIndex=$nextFillIndex >= ${chunkQueue.size})")
            return
        }

        val id = chunkQueue[nextFillIndex]
        if (preloadWindow.containsKey(id)) {
            Log.i(TAG, "[SLIDE] skip $id — already in window")
            return
        }

        Log.i(TAG, "▶ [SLIDE] filling chunk[$nextFillIndex]=$id")
        viewModelScope.launch {
            val data = runCatching { fetchSceneData(id) }.getOrNull()
            if (data != null) {
                preloadWindow[id] = data
                preloadCompleted.tryEmit(id)
                Log.i(TAG, "✓ [SLIDE] loaded $id: audio=${data.audioBytes.size}B ius=${data.iuSequence.size}")
            } else {
                Log.w(TAG, "✗ [SLIDE] FAILED $id")
            }
        }
    }

    /**
     * Emit chunk data only after verifying content readiness for active layers.
     * This prevents audio starting before its images/video are downloaded.
     *
     * Checks:
     * - Image ON → all IU images must be READY
     * - Video ON + backend said video_ready=true → video bytes must be present
     * - If content is truly not generated (backend said not ready), accept and continue
     *
     * Note: this is a diagnostic check — `fetchSceneData` already waited for all
     * downloads. If bytes are still missing, it means the backend confirmed readiness
     * but the download failed (or timed out).
     */
    private fun emitChunkWithReadinessCheck(id: String, data: PreloadedScene) {
        // Image readiness check
        val allImagesReady = if (imageEnabled) {
            data.iuSequence.all { it.status == IuStatus.READY }
        } else true

        // Video readiness check: if video layer ON and backend confirmed video exists
        val videoReady = if (videoEnabled && data.hasVideo) {
            data.videoBytes != null
        } else true

        if (!allImagesReady) {
            val ready = data.iuSequence.count { it.status == IuStatus.READY }
            val total = data.iuSequence.size
            Log.w(TAG, "emitChunk $id: $ready/$total IU images READY")
        }

        if (!videoReady) {
            Log.w(TAG, "emitChunk $id: video expected (backend video_ready=true) but bytes not downloaded")
        }

        emitChunk(data.audioBytes, data.videoBytes, data.iuSequence)
    }

    private fun emitChunk(audio: ByteArray, video: ByteArray?, iuSequence: List<IuImageItem>?) {
        val seq = ++chunkSeqCounter
        Log.i(TAG, "▶ emitChunk #$seq: audio=${audio.size}B video=${video?.size ?: 0}B ius=${iuSequence?.size ?: 0} → PLAYING")
        pendingChunkAudio = audio
        pendingChunkVideo = video
        pendingChunkIuSequence = iuSequence
        _uiState.update { it.copy(phase = PlayerPhase.PLAYING, chunkSequence = seq) }
    }

    private suspend fun fetchSceneData(id: String): PreloadedScene = coroutineScope {
        Log.i(TAG, "▶ fetchSceneData: $id — start")

        val chunk = runCatching { _repository.getChunk(id) }.getOrElse { err ->
            Log.w(TAG, "fetchSceneData: chunk $id — getChunk FAILED: ${err.message}")
            null
        }
        val videoReadyOnBackend = chunk?.video_ready == true
        Log.i(TAG, "fetchSceneData: $id — audio_ready=${chunk?.audio_ready} image_ready=${chunk?.image_ready} video_ready=$videoReadyOnBackend")

        val audioDeferred = async {
            if (chunk?.audio_ready == true) {
                runCatching {
                    _repository.getChunkAudio(id).also {
                        Log.i(TAG, "fetchSceneData: $id — audio downloaded: ${it.size} bytes")
                    }
                }.getOrElse { e ->
                    Log.w(TAG, "fetchSceneData: $id — audio download FAILED: ${e.message}")
                    byteArrayOf()
                }
            } else {
                Log.i(TAG, "fetchSceneData: $id — audio not ready, skip")
                byteArrayOf()
            }
        }
        val videoDeferred = async {
            if (videoReadyOnBackend) {
                runCatching { _repository.getChunkVideo(id) }.getOrNull().also { bytes ->
                    if (bytes != null) Log.i(TAG, "fetchSceneData: $id — video downloaded: ${bytes.size} bytes")
                    else Log.w(TAG, "fetchSceneData: $id — video_ready=true but download returned null")
                }
            } else {
                Log.i(TAG, "fetchSceneData: $id — video not ready, skip")
                null
            }
        }
        val iuDeferred = async { fetchIuSequence(id) }

        val audio = audioDeferred.await()
        val videoBytes = videoDeferred.await()
        val iuSequence = iuDeferred.await()

        Log.i(TAG, "✓ fetchSceneData: $id — complete: audio=${audio.size}B video=${videoBytes?.size ?: 0}B ius=${iuSequence.size}")
        PreloadedScene(audio, videoBytes, iuSequence, hasVideo = videoReadyOnBackend)
    }

    /**
     * Fetch all IU images for a scene, with retry on failure for slow connections.
     * First IU gets extra retries to avoid starting audio without a visible image.
     */
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
                storyboard.ius.mapIndexed { index, iu ->
                    val durationMs = when {
                        iu.start_ms != null && iu.end_ms != null -> {
                            val real = iu.end_ms - iu.start_ms
                            if (real > 0) real else fallbackDurationMs(iu.estimated_duration_sec)
                        }
                        else -> fallbackDurationMs(iu.estimated_duration_sec)
                    }
                    val iuText = iu.text
                    // First IU gets 3 attempts, others get 2
                    val maxAttempts = if (index == 0) 3 else 2
                    var lastBitmap: Bitmap? = null
                    for (attempt in 1..maxAttempts) {
                        val result = runCatching {
                            Log.d(TAG, "fetching IU image: ${iu.unit_id} (attempt $attempt/$maxAttempts) bldId=$bldId")
                            val imgBytes = _repository.getIuImage(bkId, chId, scId, iu.unit_id, bldId)
                            MediaDecoder.decodeBitmap(imgBytes)
                        }
                        val bmp = result.getOrNull()
                        if (bmp != null) {
                            lastBitmap = bmp
                            break
                        }
                        // Delay before retry — prevents tight retry loops on slow connections
                        if (attempt < maxAttempts) {
                            val delayMs = if (index == 0) 500L else 200L
                            kotlinx.coroutines.delay(delayMs)
                        }
                    }
                    if (lastBitmap != null) {
                        IuImageItem(lastBitmap, durationMs, iu.unit_id, iuText, IuStatus.READY)
                    } else {
                        Log.w(TAG, "IU image NOT GENERATED: ${iu.unit_id} — using placeholder")
                        // Try preview as fallback
                        val previewBmp = runCatching {
                            val prevBytes = _repository.getIuPreview(bkId, chId, scId, iu.unit_id, bldId)
                            prevBytes?.let { MediaDecoder.decodeBitmap(it) }
                        }.getOrNull()
                        IuImageItem(
                            bitmap = previewBmp,
                            durationMs = durationMs,
                            unitId = iu.unit_id,
                            text = iuText,
                            status = if (previewBmp != null) IuStatus.READY else IuStatus.NOT_GENERATED
                        )
                    }
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
    val missingIuPosition: ActivePosition? = null,
    /** Progress text shown during window fill, e.g. "1/3" */
    val windowProgress: String? = null
)
