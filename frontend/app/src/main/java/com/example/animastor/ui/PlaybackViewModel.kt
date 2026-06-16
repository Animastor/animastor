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
        _repository.clearCache()
        preloadCache.clear()
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

    // ═══════════════════════════════════════════════════════════════
    //  PLAYBACK CONTROL
    // ═══════════════════════════════════════════════════════════════

    fun playSceneQueue() {
        if (chunkQueue.isEmpty()) {
            Log.w(TAG, "playSceneQueue: empty queue")
            return
        }
        Log.i(TAG, "playSceneQueue: ${chunkQueue.size} chunks")
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
        return preloadCache[chunkQueue[index]]
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
                val imgBytes = _repository.getChunkImage(coverId)
                MediaDecoder.decodeBitmap(imgBytes)
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

        val cached = preloadCache.remove(id)
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

            val cachedAfter = preloadCache.remove(id)
            if (cachedAfter != null) {
                Log.i(TAG, "playNext: preload completed for $id")
                val preloadPos = chunkPositions[id]
                currentChapterId = preloadPos?.first
                currentSceneId = preloadPos?.second
                emitChunk(cachedAfter.audioBytes, cachedAfter.videoBytes, cachedAfter.iuSequence)
                preloadAhead()
                return@launch
            }

            val sceneData = runCatching { fetchSceneData(id) }.getOrElse { err ->
                val msg = "Scene $id: ${err.message} (${err::class.simpleName})"
                Log.e(TAG, "playNext: failed to load $id — $msg", err)
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

        // Launch PRELOAD_AHEAD independent jobs — don't cancel previous ones
        // so that already-started preloads (especially IU images) can complete.
        for (offset in start..PRELOAD_AHEAD) {
            val idx = currentIndex + offset
            if (idx >= chunkQueue.size) break
            val id = chunkQueue[idx]
            if (preloadCache.containsKey(id)) continue

            // Skip if a preload job is already running for this chunk
            if (preloadJobs.containsKey(id)) continue

            Log.i(TAG, "preloading scene $offset ahead: $id")
            val job = viewModelScope.launch {
                val data = runCatching { fetchSceneData(id) }.getOrNull()
                if (data != null) {
                    preloadCache[id] = data
                    preloadCompleted.tryEmit(id)
                    Log.i(TAG, "preloaded scene: $id — ${data.iuSequence.size} IUs")
                } else {
                    Log.w(TAG, "preload failed for scene: $id — will load on demand")
                }
            }
            preloadJobs[id] = job
        }
    }

    private suspend fun fetchSceneData(id: String): PreloadedScene = coroutineScope {
        Log.d(TAG, "fetchSceneData: $id")

        val chunk = runCatching { _repository.getChunk(id) }.getOrElse { err ->
            Log.w(TAG, "fetchSceneData: chunk $id not found in Redis: ${err.message}")
            null
        }
        Log.i(TAG, "fetchSceneData: chunk $id audio_ready=${chunk?.audio_ready} image_ready=${chunk?.image_ready} video_ready=${chunk?.video_ready}")

        val audioDeferred = async {
            if (chunk?.audio_ready == true) {
                runCatching {
                    _repository.getChunkAudio(id).also {
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
                runCatching { _repository.getChunkVideo(id) }.getOrNull().also {
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
    val missingIuPosition: ActivePosition? = null
)
