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
import com.example.animastor.repository.BookData
import com.example.animastor.repository.DiffSummary
import com.example.animastor.repository.DirtyScene
import com.example.animastor.repository.ImportTxtResponse
import com.example.animastor.repository.LayerConfigUpdate
import com.example.animastor.repository.ReorderChapter
import com.example.animastor.repository.Repository
import com.example.animastor.repository.SceneUnit
import com.example.animastor.repository.ChunkListResponse
import com.example.animastor.repository.ChunkResponse
import com.example.animastor.util.MediaDecoder
import com.example.animastor.util.SimpleDiskCache
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

class GenerateViewModel(
    application: Application,
    private val _repository: Repository
) : AndroidViewModel(application) {

    val repository: Repository get() = _repository

    private val _videosReady = MutableStateFlow(false)
    val videosReady: StateFlow<Boolean> = _videosReady.asStateFlow()

    private var videoCheckJob: Job? = null

    fun startVideoCheck() {
        videoCheckJob?.cancel()
        videoCheckJob = viewModelScope.launch {
            while (true) {
                val ids = chunkQueue.toList()
                if (ids.isEmpty() || bookId.isBlank()) {
                    _videosReady.value = false
                    delay(5000)
                    continue
                }
                var allReady = true
                var anyExists = false
                for (id in ids) {
                    val chunk = runCatching { _repository.getChunk(id) }.getOrNull()
                    if (chunk != null) {
                        if (chunk.video_ready) anyExists = true
                        else allReady = false
                    } else {
                        allReady = false
                    }
                }
                _videosReady.value = allReady && anyExists
                delay(5000)
            }
        }
    }

    companion object {
        private const val TAG = "VM"
        private const val POLL_TIMEOUT_MS = 300_000L
        private const val IMAGE_POLL_TIMEOUT_MS = 1_800_000L
        private const val POLL_INTERVAL_MS = 300L
        private const val PRELOAD_AHEAD = 3
        private const val WINDOW_SIZE = 3
        private const val LAZY_WINDOW_DEFAULT = 3
        private const val INITIAL_WAIT_COUNT = 3
        private const val WINDOW_RETRY_COUNT = 60
        private const val MAX_BACKOFF_MS = 5_000L

        val factory: ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T {
                val app = checkNotNull(extras[ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY])
                val diskCache = SimpleDiskCache(
                    cacheDir = java.io.File(app.cacheDir, "media-cache"),
                    maxSizeBytes = 256 * 1024 * 1024
                )
                val repo = Repository(RetrofitClient.api, diskCache)
                @Suppress("UNCHECKED_CAST")
                return GenerateViewModel(application = app, _repository = repo) as T
            }
        }
    }

    val positionManager = PositionManager()

    private val _uiState = MutableStateFlow(UiState())
    val uiState: StateFlow<UiState> = _uiState.asStateFlow()

    private val chunkQueue = mutableListOf<String>()
    private var currentIndex = 0
    var bookId: String = ""
        private set
    var buildId: String = ""
        private set

    init {
        val prefs = getApplication<Application>().getSharedPreferences("animastor", 0)
        bookId = prefs.getString("bookId", "") ?: ""
        buildId = prefs.getString("buildId", "") ?: ""
    }

    private fun persistBookId(id: String) {
        bookId = id
        val prefs = getApplication<Application>().getSharedPreferences("animastor", 0)
        prefs.edit().putString("bookId", id).apply()
    }

    private fun persistBuildId(id: String) {
        buildId = id
        val prefs = getApplication<Application>().getSharedPreferences("animastor", 0)
        prefs.edit().putString("buildId", id).apply()
    }

    private val chunkPositions = mutableMapOf<String, Pair<String?, String?>>()

    var currentChapterId: String? = null
        private set
    var currentSceneId: String? = null
        private set
    var currentUnitIndex: Int = 0
        set(value) { if (value >= 0) field = value }

    private val preloadCache = mutableMapOf<String, PreloadedScene>()

    var currentIuSequence: List<IuImageItem>? = null

    private val preloadJobs = mutableMapOf<String, Job>()
    private var backgroundWindowJob: Job? = null
    private var backgroundWindowStart = -1
    private var backgroundGenPollJob: Job? = null
    private var coverRefreshJob: Job? = null

    var pendingChunkAudio: ByteArray? = null
    var pendingChunkVideo: ByteArray? = null
    var pendingChunkIuSequence: List<IuImageItem>? = null
    var lastProcessedChunkSequence: Long = 0
    private var chunkSeqCounter = 0L
    private var generationJob: Job? = null

    var savedPlaybackPositionMs: Long = 0
    var persistedImage: Bitmap? = null
    var pendingSeekPositionMs: Long = -1
    var needsRotationResume = false
    var pendingExternalSeek: ActivePosition? = null
    private var isExecutingExternalSeek = false

    var imageEnabled: Boolean = true
        private set

    private val _audioEnabled = MutableStateFlow(true)
    val audioEnabledFlow: StateFlow<Boolean> = _audioEnabled.asStateFlow()

    private val _videoEnabled = MutableStateFlow(true)
    val videoEnabledFlow: StateFlow<Boolean> = _videoEnabled.asStateFlow()

    private val _layerProfile = MutableStateFlow("full")
    val layerProfileFlow: StateFlow<String> = _layerProfile.asStateFlow()

    private val _hasAssets = MutableStateFlow(false)
    val hasAssetsFlow: StateFlow<Boolean> = _hasAssets.asStateFlow()

    private val _layerConfigLoaded = MutableStateFlow(false)
    val layerConfigLoadedFlow: StateFlow<Boolean> = _layerConfigLoaded.asStateFlow()

    fun setImageEnabled(enabled: Boolean) { imageEnabled = enabled }

    fun audioEnabled(): Boolean = _audioEnabled.value
    fun videoEnabled(): Boolean = _videoEnabled.value
    fun currentProfile(): String = computeProfile(imageEnabled, _videoEnabled.value)
    fun hasAssets(): Boolean = _hasAssets.value

    fun setAudioEnabled(enabled: Boolean) {
        _audioEnabled.value = enabled
        imageEnabled = imageEnabled
        viewModelScope.launch { persistLayerConfig() }
    }

    fun setVideoEnabled(enabled: Boolean) {
        val nextVideo = enabled
        val nextImage = if (enabled) true else imageEnabled
        _videoEnabled.value = nextVideo
        imageEnabled = nextImage
        viewModelScope.launch { persistLayerConfig() }
    }

    fun toggleImageForProfile() {
        val next = !imageEnabled
        imageEnabled = next
        if (!next && _videoEnabled.value) _videoEnabled.value = false
        viewModelScope.launch { persistLayerConfig() }
    }

    fun toggleVideoForProfile() {
        val next = !_videoEnabled.value
        if (next && !imageEnabled) imageEnabled = true
        _videoEnabled.value = next
        viewModelScope.launch { persistLayerConfig() }
    }

    private fun computeProfile(image: Boolean, video: Boolean): String {
        if (video) return "full"
        if (image) return "storyboard"
        return "audio_only"
    }

    suspend fun loadLayerConfig() {
        val currentBookId = bookId
        if (currentBookId.isBlank()) {
            _layerConfigLoaded.value = true
            return
        }
        runCatching { _repository.getLayerConfig(currentBookId) }
            .onSuccess { cfg ->
                _audioEnabled.value = cfg.audio_enabled
                imageEnabled = cfg.image_enabled
                _videoEnabled.value = cfg.video_enabled
                _layerProfile.value = cfg.profile ?: computeProfile(imageEnabled, _videoEnabled.value)
                _layerConfigLoaded.value = true
                Log.i(TAG, "loadLayerConfig: ${cfg.profile} (a=${cfg.audio_enabled} i=${cfg.image_enabled} v=${cfg.video_enabled})")
            }
            .onFailure { e ->
                Log.w(TAG, "loadLayerConfig failed: ${e.message}")
                _layerConfigLoaded.value = true
            }
    }

    suspend fun refreshAssetsState() {
        val currentBookId = bookId
        if (currentBookId.isBlank()) {
            _hasAssets.value = false
            return
        }
        runCatching { _repository.getAssetsState(currentBookId) }
            .onSuccess { state ->
                _hasAssets.value = state.has_assets
                Log.d(TAG, "refreshAssetsState: has_assets=${state.has_assets} (audio=${state.audio_ready}/${state.total_chunks})")
            }
            .onFailure { e ->
                Log.w(TAG, "refreshAssetsState failed: ${e.message}")
            }
    }

    private suspend fun persistLayerConfig() {
        val currentBookId = bookId
        if (currentBookId.isBlank()) return
        runCatching {
            val cfg = _repository.putLayerConfig(currentBookId, LayerConfigUpdate(
                audio_enabled = _audioEnabled.value,
                image_enabled = imageEnabled,
                video_enabled = _videoEnabled.value
            ))
            _layerProfile.value = cfg.profile ?: computeProfile(imageEnabled, _videoEnabled.value)
            Log.i(TAG, "persistLayerConfig: ${cfg.profile}")
        }.onFailure { e ->
            Log.w(TAG, "persistLayerConfig failed: ${e.message}")
        }
    }

    data class GenerationRequest(
        val profile: String,
        val scope: String,
        val chapterId: String?,
        val sceneId: String?
    )

    sealed class GenerationResult {
        data class Started(val dirty: Int, val scope: String) : GenerationResult()
        data class Failed(val message: String) : GenerationResult()
    }

    fun startGeneration(req: GenerationRequest, onResult: (GenerationResult) -> Unit) {
        if (bookId.isBlank() || _isRegenerating.value) {
            onResult(GenerationResult.Failed("No book or already running"))
            return
        }
        _isRegenerating.value = true
        _activeGeneration.value = ActiveGeneration(
            scope = req.scope,
            chapterId = req.chapterId,
            sceneId = req.sceneId
        )
        generationJob?.cancel()
        generationJob = viewModelScope.launch {
            _uiState.value = UiState(phase = PlayerPhase.GENERATING)
            runCatching {
                val res = _repository.regenerateBookScoped(
                    bookId = bookId,
                    newBook = null,
                    rebuildAll = true,
                    profile = req.profile,
                    scope = req.scope,
                    chapterId = req.chapterId,
                    sceneId = req.sceneId
                )
                _dirtySummary.value = res.summary
                _dirtyScenes.value = res.dirty_scenes ?: emptyList()
                hasUnsavedChanges = false
                res
            }.onSuccess { res ->
                _repository.clearCache()
                preloadCache.clear()
                preloadJobs.clear()
                _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
                val dirtyCount = res.dirty_scenes?.size ?: 0
                onResult(GenerationResult.Started(dirtyCount, res.scope ?: req.scope))
                viewModelScope.launch { refreshAssetsState() }
            }.onFailure { e ->
                if (e is CancellationException) {
                    Log.i(TAG, "startGeneration cancelled")
                    _uiState.update { it.copy(phase = PlayerPhase.IDLE, errorMessage = null) }
                    _activeGeneration.value = null
                    onResult(GenerationResult.Failed("cancelled"))
                } else {
                    Log.e(TAG, "startGeneration failed: ${e.message}", e)
                    _uiState.update {
                        it.copy(phase = PlayerPhase.SCENE_READY, errorMessage = "Generation failed: ${e.message}")
                    }
                    onResult(GenerationResult.Failed(e.message ?: "unknown"))
                }
            }
            if (_isRegenerating.value) {
                _isRegenerating.value = false
            }
        }
    }

    fun cancelGeneration() {
        Log.i(TAG, "cancelGeneration: $bookId")
        if (bookId.isBlank()) return
        viewModelScope.launch {
            runCatching {
                _repository.cancelGeneration(bookId)
            }.onSuccess {
                Log.i(TAG, "cancelGeneration: backend cancelled successfully")
            }.onFailure { e ->
                Log.w(TAG, "cancelGeneration: backend call failed: ${e.message}")
            }
            // Always reset local state regardless of backend result
            generationJob?.cancel()
            generationJob = null
            _isRegenerating.value = false
            _activeGeneration.value = null
            _uiState.update { it.copy(phase = PlayerPhase.IDLE, errorMessage = null) }
        }
    }

    val currentChunkIndex: Int get() = currentIndex
    val chunkQueueSize: Int get() = chunkQueue.size

    private val _preloadCompleted = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val preloadCompleted: SharedFlow<String> = _preloadCompleted

    fun getPreloadedScene(index: Int): PreloadedScene? {
        if (index < 0 || index >= chunkQueue.size) return null
        return preloadCache[chunkQueue[index]]
    }

    fun tryPreloadNextScene(): PreloadedScene? {
        return getPreloadedScene(currentIndex + 1)
    }

    private fun emitChunk(audio: ByteArray, video: ByteArray?, iuSequence: List<IuImageItem>?) {
        val seq = ++chunkSeqCounter
        Log.i(TAG, "emitChunk #$seq: audio=${audio.size}B")
        pendingChunkAudio = audio
        pendingChunkVideo = video
        pendingChunkIuSequence = iuSequence
        _uiState.update { it.copy(phase = PlayerPhase.PLAYING, chunkSequence = seq) }
    }

    fun rotationRecovery() {
        needsRotationResume = true
        _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
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

    fun seekToPosition(chapterId: String, sceneId: String, unitIndex: Int, unitId: String? = null) {
        val chunkId = chunkPositions.entries.firstOrNull {
            it.value.first == chapterId && it.value.second == sceneId
        }?.key
        if (chunkId == null || !chunkQueue.contains(chunkId)) {
            Log.w(TAG, "seekToPosition: chunk not found for $chapterId/$sceneId — showing missing-IU overlay")
            val pos = ActivePosition(
                chapterId = chapterId,
                sceneId = sceneId,
                unitId = unitId,
                chunkId = chunkId,
                unitIndex = unitIndex
            )
            _uiState.update { it.copy(missingIuPosition = pos) }
            pendingExternalSeek = null
            return
        }
        Log.i(TAG, "seekToPosition: $chapterId/$sceneId unit=$unitIndex chunk=$chunkId")
        _uiState.update { it.copy(missingIuPosition = null) }
        pendingExternalSeek = ActivePosition(chapterId, sceneId, unitId, chunkId, unitIndex)
    }

    fun clearMissingIu() {
        _uiState.update { it.copy(missingIuPosition = null) }
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
        positionManager.navigateTo(seek)
        _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING) }

        preloadCache.clear()
        preloadJobs.clear()
        preloadAhead(includeCurrent = true)
        playNext()
    }

    fun generateFromFile(file: File) {
        Log.i(TAG, "generateFromFile: ${file.name}")
        clearPlaybackState()
        generationJob?.cancel()
        generationJob = viewModelScope.launch {
            _uiState.value = UiState(phase = PlayerPhase.LOADING_BOOK)

            runCatching {
                _repository.generate(file, imageEnabled)
            }.onSuccess { res ->
                Log.i(TAG, "generate OK: bookId=${res.book_id} buildId=${res.build_id} #chunks=${res.chunk_ids.size}")
                persistBookId(res.book_id)
                persistBuildId(res.build_id ?: "")
                // Save snapshot of initial book state
                runCatching { _repository.snapshotBook(bookId) }
                chunkQueue.clear()
                chunkQueue.addAll(res.chunk_ids)
                startVideoCheck()
                // Populate chunk→(chapter,scene) synchronously before any UI
                for (cid in chunkQueue) {
                    runCatching {
                        _repository.getChunkStoryboard(cid).let { sb ->
                            chunkPositions[cid] = Pair(sb.chapter_id, sb.scene_id)
                        }
                    }.onFailure { e ->
                        Log.w(TAG, "failed to get storyboard for $cid: ${e.message}")
                    }
                }
                Log.i(TAG, "chunkPositions populated: ${chunkPositions.size} entries")

                var workersRunning = true
                runCatching {
                    val counts = _repository.getWorkerCounts()
                    if (counts.audio == 0 && counts.image == 0 && counts.video == 0) {
                        workersRunning = false
                        Log.w(TAG, "no workers detected on GPU server — will poll until they appear")
                    }
                }.onFailure { e ->
                    Log.w(TAG, "worker count fetch failed: ${e.message}")
                }

                val firstPos = res.chunk_ids.firstOrNull()?.let { chunkPositions[it] }
                if (firstPos != null) {
                    positionManager.navigateTo(chapterId = firstPos.first, sceneId = firstPos.second, unitIndex = 0)
                    currentChapterId = firstPos.first
                    currentSceneId = firstPos.second
                } else {
                    positionManager.navigateTo(chapterId = null, sceneId = null)
                }
                preloadCache.clear()

                val firstId = res.chunk_ids.firstOrNull()
                if (firstId != null) {
                    val isCached = runCatching {
                        val c = _repository.getChunk(firstId)
                        c.audio_ready
                    }.getOrDefault(false)

                    if (!workersRunning && !isCached) {
                        _uiState.update { it.copy(phase = PlayerPhase.IDLE, errorMessage = "Start workers on GPU server", chunkIds = res.chunk_ids, mode = res.mode ?: "full") }
                        Log.i(TAG, "waiting for workers to come online...")
                        waitForWorkers(res.chunk_ids)
                        return@launch
                    }

                    _uiState.update { it.copy(phase = if (isCached) PlayerPhase.DOWNLOADING else PlayerPhase.GENERATING, chunkIds = res.chunk_ids, mode = res.mode ?: "full") }
                    startCoverRefresh(firstId)
                    Log.i(TAG, "waiting for preview + audio: $firstId")

                    if (imageEnabled) {
                        runCatching {
                            val storyboard = _repository.getChunkStoryboard(firstId)
                            if (storyboard.ius.isNotEmpty()) {
                                val iu = storyboard.ius.first()
                                val imgBytes = _repository.getIuImage(
                                    storyboard.book_id ?: bookId,
                                    storyboard.chapter_id ?: "",
                                    storyboard.scene_id ?: "",
                                    iu.unit_id,
                                    storyboard.build_id
                                )
                                val bmp = MediaDecoder.decodeBitmap(imgBytes)
                                _uiState.update { it.copy(coverImage = bmp) }
                                Log.i(TAG, "cover image loaded from first IU")
                            }
                        }.onFailure { e ->
                            Log.w(TAG, "cover image from IU failed: ${e.message}, trying scene image")
                            runCatching {
                                val imgBytes = _repository.getChunkImage(firstId)
                                val bmp = MediaDecoder.decodeBitmap(imgBytes)
                                _uiState.update { it.copy(coverImage = bmp) }
                            }.onFailure { e2 ->
                                Log.w(TAG, "cover image from scene also failed: ${e2.message}")
                            }
                        }
                    } else {
                        Log.i(TAG, "image disabled, skipping cover fetch")
                    }

                    Log.i(TAG, "waiting for first window ready: initial ${INITIAL_WAIT_COUNT} chunks")
                    val waitCount = minOf(INITIAL_WAIT_COUNT, res.chunk_ids.size)
                    runCatching {
                        waitWindowReady(res.chunk_ids.take(waitCount))
                    }.onFailure { e ->
                        Log.w(TAG, "waitInitialWindow failed: ${e.message}")
                        _uiState.update { it.copy(errorMessage = "Window timeout: ${e.message}") }
                        return@launch
                    }
                    if (imageEnabled) {
                        runCatching { waitPreview(firstId) }.onFailure { e ->
                            Log.w(TAG, "waitPreview failed: ${e.message}")
                        }
                    } else {
                        Log.i(TAG, "image disabled, skipping preview wait")
                    }
                    Log.i(TAG, "initial $waitCount chunks ready → preloading first chunk")
                    if (chunkQueue.isNotEmpty()) {
                        runCatching {
                            val firstData = fetchSceneData(chunkQueue[0])
                            preloadCache[chunkQueue[0]] = firstData
                            Log.i(TAG, "first chunk preloaded: ${chunkQueue[0]}")
                        }.onFailure { e ->
                            Log.w(TAG, "first chunk preload failed: ${e.message}")
                        }
                    }
                    Log.i(TAG, "first window ready → SCENE_READY")
                    _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
                } else {
                    Log.w(TAG, "generate returned empty chunk_ids")
                }
            }.onFailure { e ->
                Log.e(TAG, "generate failed: ${e.message}", e)
                val msg = if (e is java.io.IOException && e.message != null) e.message!! else "Generate failed: ${e.message}"
                _uiState.update { it.copy(phase = PlayerPhase.IDLE, errorMessage = msg) }
            }
        }
    }

    /**
     * Open a vbook file: load + parse the bundle on the backend (saving the
     * book to disk if new, or keeping the existing edited version) and
     * populate the in-memory bookId/buildId/book structure — WITHOUT
     * auto-starting the generation pipeline. The user must explicitly press
     * the toolbar "Создать" button to trigger /regenerate.
     *
     * After this returns, the player sits in IDLE state, the toolbar's
     * "Создать" button is enabled, and the Navigate/Edit tabs can show
     * the book structure.
     */
    /**
     * Import a .txt file using the lazy import pipeline.
     * Two-step flow with visible progress:
     *   1. POST /import-txt → RAW_IMPORTED
     *   2. POST /{bookId}/bootstrap → BOOTSTRAPPED (chars, locs, first 3 scenes)
     */
    fun importTxtFromFile(file: File) {
        Log.i(TAG, "importTxtFromFile: ${file.name}")
        clearPlaybackState()
        generationJob?.cancel()
        hasUnsavedChanges = false
        _videosReady.value = false
        _activeGeneration.value = null
        _dirtySummary.value = null
        _dirtyScenes.value = emptyList()
        _isRegenerating.value = false

        generationJob = viewModelScope.launch {
            try {
                // Phase 1 — Technical (shown on File screen)
                val msgs = mutableListOf<String>()
                _uiState.update { it.copy(
                    phase = PlayerPhase.IMPORTING_TXT,
                    importStage = ImportStage.VALIDATING,
                    importProgress = 0.1f,
                    errorMessage = null,
                    importProgressMessages = emptyList()
                )}

                val importRes = _repository.importTxt(file)
                val bookId = importRes.book_id
                persistBookId(bookId)
                persistBuildId("")
                Log.i(TAG, "importTxtFromFile: draft created $bookId")

                // Technical statuses — quick, shown on File screen before AI switch
                msgs.add("✓ File selected")
                msgs.add("✓ TXT read")
                msgs.add("✓ Encoding detected")
                msgs.add("✓ Book created")
                _uiState.update { it.copy(
                    importProgress = 0.2f,
                    importProgressMessages = msgs.toList()
                )}
                // FileFragment detects non-empty messages → switches to AI tab

                // Phase 2 — AI agent pipeline with real-time polling
                _uiState.update { it.copy(
                    importStage = ImportStage.ANALYZING,
                    importProgress = 0.3f,
                )}

                // Launch polling coroutine that runs in parallel with bootstrap
                var pollingDone = false
                val pollingJob = viewModelScope.launch {
                    var lastProgressMsg = ""

                    while (!pollingDone) {
                        delay(2000)
                        try {
                            val status = _repository.getAgentStatus(bookId)
                            if (status.active && status.progress_msg != null) {
                                val currentMsg = status.progress_msg

                                // If we got a new progress message, add it to the list
                                if (currentMsg != lastProgressMsg) {
                                    // Mark previous message as done if it started with ⟳
                                    if (lastProgressMsg.isNotEmpty() && msgs.isNotEmpty() && msgs.last().startsWith("⟳")) {
                                        msgs[msgs.size - 1] = msgs.last().replace("⟳", "✓")
                                    }

                                    // Add new progress message (it already has proper emoji from backend)
                                    msgs.add(currentMsg)
                                    lastProgressMsg = currentMsg

                                    // Add window progress info if available
                                    if (status.window_index != null && status.created_scenes != null) {
                                        val windowInfo = "📦 Окно ${status.window_index + 1}: ${status.created_scenes} сцен" +
                                            if (status.total_scenes != null) " (всего найдено: ${status.total_scenes})" else ""
                                        // Only add if not already in last messages
                                        if (msgs.none { it.startsWith("📦") && it.contains("Окно ${status.window_index + 1}:") }) {
                                            // Replace existing window info or add new
                                            val existingWindowIdx = msgs.indexOfLast { it.startsWith("📦") }
                                            if (existingWindowIdx >= 0) {
                                                msgs[existingWindowIdx] = windowInfo
                                            } else {
                                                msgs.add(windowInfo)
                                            }
                                        }
                                    }

                                    _uiState.update { it.copy(importProgressMessages = msgs.toList()) }
                                }
                            }
                        } catch (_: Exception) { }
                    }
                    // Mark last message as done if it starts with ⟳
                    if (msgs.isNotEmpty() && msgs.last().startsWith("⟳")) {
                        msgs[msgs.size - 1] = msgs.last().replace("⟳", "✓")
                        _uiState.update { it.copy(importProgressMessages = msgs.toList()) }
                    }
                }

                val bootstrapRes = try {
                    _repository.bootstrapBook(bookId)
                } finally {
                    pollingDone = true
                    pollingJob.cancel()
                }
                Log.i(TAG, "importTxtFromFile: bootstrap done — ${bootstrapRes.characters} chars, ${bootstrapRes.locations} locs, ${bootstrapRes.scenes} scenes")

                msgs.add("\u2713 Импорт завершён: ${bootstrapRes.characters} персонажей, ${bootstrapRes.locations} локаций, ${bootstrapRes.scenes} сцен")
                msgs.add("\uD83D\uDCAC Можете задать вопросы или запустить генерацию через кнопку на панели инструментов.")
                _uiState.update { it.copy(
                    importProgressMessages = msgs.toList()
                )}

                // Step 7: populate chunk queue from bootstrap result
                chunkQueue.clear()
                for (ch in (bootstrapRes.chapters ?: emptyList())) {
                    ch.chapter?.let { chunkQueue.add(it) }
                }

                val firstId = chunkQueue.firstOrNull()
                if (firstId != null) {
                    positionManager.navigateTo(chapterId = firstId, sceneId = null, unitIndex = 0)
                    currentChapterId = firstId
                } else {
                    positionManager.navigateTo(chapterId = null, sceneId = null)
                }

                // Done
                _uiState.update { it.copy(
                    importStage = ImportStage.DONE,
                    importProgress = 1f,
                    phase = PlayerPhase.SCENE_READY,
                    chunkIds = chunkQueue.toList(),
                )}

                Log.i(TAG, "importTxtFromFile: ready with ${chunkQueue.size} chapters, ${bootstrapRes.scenes} scenes")

            } catch (e: Exception) {
                Log.e(TAG, "importTxtFromFile failed: ${e.message}", e)
                val msg = if (e is java.io.IOException && e.message != null) e.message!! else "Import TXT failed: ${e.message}"
                _uiState.update { it.copy(
                    phase = PlayerPhase.IDLE,
                    errorMessage = msg,
                    importStage = null,
                    importProgress = 0f,
                    importProgressMessages = emptyList()
                )}
            }
        }
    }

    /**
     * Import text via AI (same lazy import pipeline as TXT file).
     */
    fun importText(text: String, title: String? = null, onResult: ((ImportTxtResponse) -> Unit)? = null) {
        Log.i(TAG, "importText: text=${text.length} chars title=$title")
        clearPlaybackState()
        generationJob?.cancel()
        hasUnsavedChanges = false
        _videosReady.value = false
        _activeGeneration.value = null
        _dirtySummary.value = null
        _dirtyScenes.value = emptyList()
        _isRegenerating.value = false

        generationJob = viewModelScope.launch {
            try {
                _uiState.update { it.copy(
                    phase = PlayerPhase.IMPORTING_TXT,
                    importStage = ImportStage.LOADING,
                    importProgress = 0.1f,
                    errorMessage = null
                )}

                val importRes = _repository.importText(text, title)
                val bookId = importRes.book_id
                persistBookId(bookId)
                persistBuildId("")

                _uiState.update { it.copy(
                    importStage = ImportStage.ANALYZING,
                    importProgress = 0.3f
                )}
                delay(200)

                _uiState.update { it.copy(
                    importStage = ImportStage.EXTRACTING_CHARACTERS,
                    importProgress = 0.45f
                )}
                delay(200)

                _uiState.update { it.copy(
                    importStage = ImportStage.EXTRACTING_LOCATIONS,
                    importProgress = 0.55f
                )}
                delay(200)

                _uiState.update { it.copy(
                    importStage = ImportStage.CREATING_STRUCTURE,
                    importProgress = 0.65f
                )}
                delay(200)

                _uiState.update { it.copy(
                    importStage = ImportStage.CREATING_SCENES,
                    importProgress = 0.8f
                )}
                delay(200)

                val bootstrapRes = _repository.bootstrapBook(bookId)

                chunkQueue.clear()
                for (ch in (bootstrapRes.chapters ?: emptyList())) {
                    ch.chapter?.let { chunkQueue.add(it) }
                }

                val firstId = chunkQueue.firstOrNull()
                if (firstId != null) {
                    positionManager.navigateTo(chapterId = firstId, sceneId = null, unitIndex = 0)
                    currentChapterId = firstId
                } else {
                    positionManager.navigateTo(chapterId = null, sceneId = null)
                }

                _uiState.update { it.copy(
                    importStage = ImportStage.DONE,
                    importProgress = 1f,
                    phase = PlayerPhase.SCENE_READY,
                    chunkIds = chunkQueue.toList(),
                )}

                onResult?.invoke(importRes)
            } catch (e: Exception) {
                Log.e(TAG, "importText failed: ${e.message}", e)
                val msg = if (e is java.io.IOException && e.message != null) e.message!! else "Import text failed: ${e.message}"
                _uiState.update { it.copy(
                    phase = PlayerPhase.IDLE,
                    errorMessage = msg,
                    importStage = null,
                    importProgress = 0f
                )}
            }
        }
    }

    fun loadBookFromFile(file: File) {
        Log.i(TAG, "loadBookFromFile: ${file.name}")
        clearPlaybackState()
        generationJob?.cancel()
        hasUnsavedChanges = false
        _videosReady.value = false
        _activeGeneration.value = null
        _dirtySummary.value = null
        _dirtyScenes.value = emptyList()
        _isRegenerating.value = false
        _uiState.value = UiState(phase = PlayerPhase.LOADING_BOOK)

        generationJob = viewModelScope.launch {
            runCatching {
                _repository.loadVbook(file)
            }.onSuccess { res ->
                Log.i(TAG, "loadBookFromFile OK: bookId=${res.book_id} buildId=${res.build_id} chapters=${res.chapter_count} scenes=${res.scene_count} existing=${res.was_existing}")
                persistBookId(res.book_id)
                persistBuildId(res.build_id ?: "")

                // Save snapshot of initial book state (mirrors generateFromFile)
                runCatching { _repository.snapshotBook(bookId) }

                chunkQueue.clear()

                // Populate chunk queue and positions for cached/recovered books
                val allChunks = runCatching { _repository.getAllChunks(bookId) }.getOrElse { ChunkListResponse(emptyList()) }
                chunkQueue.addAll(allChunks.chunk_ids)
                for (cid in chunkQueue) {
                    runCatching {
                        _repository.getChunkStoryboard(cid).let { sb ->
                            chunkPositions[cid] = Pair(sb.chapter_id, sb.scene_id)
                        }
                    }.onFailure { e ->
                        Log.w(TAG, "loadBookFromFile: failed to get storyboard for $cid: ${e.message}")
                    }
                }
                Log.i(TAG, "loadBookFromFile: chunkQueue=${chunkQueue.size} chunkPositions=${chunkPositions.size}")

                val firstId = chunkQueue.firstOrNull()
                val firstPos = firstId?.let { chunkPositions[it] }
                if (firstPos != null) {
                    positionManager.navigateTo(chapterId = firstPos.first, sceneId = firstPos.second, unitIndex = 0)
                    currentChapterId = firstPos.first
                    currentSceneId = firstPos.second
                } else {
                    runCatching {
                        val bookData = _repository.getBook(bookId)
                        val firstChapter = bookData.chapters?.firstOrNull()
                        val firstScene = firstChapter?.scenes?.firstOrNull()
                        val chId = firstChapter?.chapter
                        val scId = firstScene?.scene_id
                        positionManager.navigateTo(chapterId = chId, sceneId = scId, unitIndex = 0)
                        currentChapterId = chId
                        currentSceneId = scId
                        Log.i(TAG, "loadBookFromFile: no chunks yet, positioned to first chapter/scene from book data: $chId / $scId")
                    }.onFailure { e ->
                        Log.w(TAG, "loadBookFromFile: failed to get book data for position fallback: ${e.message}")
                        positionManager.navigateTo(chapterId = null, sceneId = null)
                    }
                }

                preloadCache.clear()

                _uiState.update {
                    it.copy(
                        phase = PlayerPhase.DOWNLOADING,
                        chunkIds = emptyList(),
                        previewImage = null,
                        currentImage = null,
                        coverImage = null,
                        errorMessage = null
                    )
                }

                if (firstId != null) {
                    startCoverRefresh(firstId)
                    if (imageEnabled) {
                        runCatching {
                            val sb = _repository.getChunkStoryboard(firstId)
                            if (sb.ius.isNotEmpty()) {
                                val iu = sb.ius.first()
                                val imgBytes = _repository.getIuImage(
                                    sb.book_id ?: bookId,
                                    sb.chapter_id ?: "",
                                    sb.scene_id ?: "",
                                    iu.unit_id,
                                    sb.build_id
                                )
                                val bmp = MediaDecoder.decodeBitmap(imgBytes)
                                _uiState.update { it.copy(coverImage = bmp) }
                                Log.i(TAG, "loadBookFromFile: cover image loaded from first IU")
                            }
                        }.onFailure { e ->
                            Log.w(TAG, "loadBookFromFile: cover from IU failed: ${e.message}, trying scene image")
                            runCatching {
                                val imgBytes = _repository.getChunkImage(firstId)
                                val bmp = MediaDecoder.decodeBitmap(imgBytes)
                                _uiState.update { it.copy(coverImage = bmp) }
                            }.onFailure { e2 ->
                                Log.w(TAG, "loadBookFromFile: cover from scene also failed: ${e2.message}")
                            }
                        }
                    }
                }

                _uiState.update { it.copy(phase = if (chunkQueue.isNotEmpty()) PlayerPhase.SCENE_READY else PlayerPhase.IDLE) }
            }.onFailure { e ->
                Log.e(TAG, "loadBookFromFile failed: ${e.message}", e)
                val msg = if (e is java.io.IOException && e.message != null) e.message!! else "Load failed: ${e.message}"
                _uiState.update { it.copy(phase = PlayerPhase.IDLE, errorMessage = msg) }
            }
        }
    }

    private val _isExporting = MutableStateFlow(false)
    val isExporting: StateFlow<Boolean> = _isExporting.asStateFlow()

    private val _exportProgress = MutableStateFlow(0f)
    val exportProgress: StateFlow<Float> = _exportProgress.asStateFlow()

    fun setExporting(exporting: Boolean) {
        _isExporting.value = exporting
        if (!exporting) _exportProgress.value = 0f
    }

    fun setExportProgress(progress: Float) {
        _exportProgress.value = progress
    }

    var hasUnsavedChanges = false
        private set

    private val _dirtySummary = MutableStateFlow<DiffSummary?>(null)
    val dirtySummary: StateFlow<DiffSummary?> = _dirtySummary.asStateFlow()

    private val _dirtyScenes = MutableStateFlow<List<DirtyScene>>(emptyList())
    val dirtyScenes: StateFlow<List<DirtyScene>> = _dirtyScenes.asStateFlow()

    private val _isRegenerating = MutableStateFlow(false)
    val isRegenerating: StateFlow<Boolean> = _isRegenerating.asStateFlow()

    data class ActiveGeneration(
        val scope: String,
        val chapterId: String?,
        val sceneId: String?
    )

    private val _activeGeneration = MutableStateFlow<ActiveGeneration?>(null)
    val activeGeneration: StateFlow<ActiveGeneration?> = _activeGeneration.asStateFlow()

    fun markUnsavedChanges() {
        hasUnsavedChanges = true
    }

    /**
     * Triggers regeneration using snapshot stored on backend (no new_book sent).
     * For use from toolbar GENERATE button after AI edits.
     * Now uses scoped regenerate with current layer profile.
     */
    fun regenerateFromSnapshot() {
        startGeneration(
            req = GenerationRequest(
                profile = currentProfile(),
                scope = "whole_book",
                chapterId = null,
                sceneId = null
            ),
            onResult = { /* no-op; UI state handled in VM */ }
        )
    }

    /**
     * Save snapshot of current book state to backend (captures "old" state).
     */
    fun snapshotCurrentBook() {
        if (bookId.isNotBlank()) {
            viewModelScope.launch {
                runCatching { _repository.snapshotBook(bookId) }
            }
        }
    }

    fun reorderChapters(chapters: List<ReorderChapter>) {
        if (bookId.isNotBlank()) {
            viewModelScope.launch {
                runCatching { _repository.reorderBook(bookId, chapters) }
                    .onSuccess { Log.i(TAG, "reorderChapters OK: ${it.chapter_count} chapters") }
                    .onFailure { Log.e(TAG, "reorderChapters FAILED: ${it.message}") }
            }
        }
    }

    fun clearBookCache() {
        if (bookId.isBlank()) return
        viewModelScope.launch {
            runCatching {
                _repository.clearBookCache(bookId)
                _repository.clearCache()
                persistBookId("")
                persistBuildId("")
                bookId = ""
                buildId = ""
                chunkQueue.clear()
                _uiState.update { it.copy(
                    phase = PlayerPhase.IDLE,
                    chunkIds = emptyList(),
                    previewImage = null,
                    currentImage = null,
                    coverImage = null,
                    errorMessage = null
                )}
                Log.i(TAG, "Clear cache OK for $bookId")
            }.onFailure { e ->
                Log.e(TAG, "Clear cache failed: ${e.message}")
            }
        }
    }

    fun getCurrentChunkId(): String? {
        return chunkQueue.getOrNull(currentIndex)
    }

    fun closeBook() {
        videoCheckJob?.cancel()
        generationJob?.cancel()
        backgroundWindowJob?.cancel()
        coverRefreshJob?.cancel()
        clearPlaybackState()
        persistBookId("")
        persistBuildId("")
        hasUnsavedChanges = false
        _videosReady.value = false
        persistedImage = null
        positionManager.navigateTo(chapterId = null, sceneId = null)
        _activeGeneration.value = null
        _uiState.update { it.copy(
            coverImage = null,
            previewImage = null,
            currentImage = null,
            phase = PlayerPhase.IDLE
        )}
    }

    fun playSceneQueue() {
        Log.i(TAG, "playSceneQueue: ${chunkQueue.size} chunks")
        currentIndex = 0
        preloadJobs.clear()
        preloadAhead(includeCurrent = true)
        playNext()
    }

    fun onAudioCompleted() {
        Log.i(TAG, "onAudioCompleted: index=$currentIndex")
        currentIndex++
        playNext()
    }

    private fun playNext() {
        Log.d(TAG, "playNext: index=$currentIndex queueSize=${chunkQueue.size}")
        if (currentIndex >= chunkQueue.size) {
            viewModelScope.launch {
                if (waitForNextWindow()) {
                    playNext()
                } else {
                    _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
                }
            }
            return
        }

        val id = chunkQueue[currentIndex]
        Log.i(TAG, "playNext: loading chunk[$currentIndex]=$id")
        maybeStartNextWindowInBackground()

        val pos = chunkPositions[id]
        currentChapterId = pos?.first
        currentSceneId = pos?.second

        if (!isExecutingExternalSeek) {
            currentUnitIndex = 0
            positionManager.navigateTo(
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
                Log.e(TAG, "playNext: failed to load scene $id: ${err.message}")
                _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY, errorMessage = "Scene load failed: ${err.message}") }
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

    private suspend fun fetchSceneData(id: String): PreloadedScene = coroutineScope {
        Log.d(TAG, "fetchSceneData: $id")
        val chunk = waitChunkReady(id)
        Log.i(TAG, "chunk: audio=${chunk.audio_ready} image=${chunk.image_ready} video=${chunk.video_ready}")

        val audioDeferred = async {
            val a = _repository.getChunkAudio(id)
            Log.i(TAG, "audio fetched: ${a.size} bytes")
            a
        }
        val videoDeferred = async {
            if (chunk.video_ready) {
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

    private fun startCoverRefresh(firstChunkId: String) {
        if (!imageEnabled || _uiState.value.coverImage != null) return
        coverRefreshJob?.cancel()
        coverRefreshJob = viewModelScope.launch {
            Log.i(TAG, "coverRefresh: polling first generated cover for $firstChunkId")
            val bitmap = runCatching { waitGeneratedCover(firstChunkId) }.getOrNull()
            if (bitmap != null) {
                _uiState.update { it.copy(coverImage = bitmap, previewImage = it.previewImage ?: bitmap) }
                Log.i(TAG, "coverRefresh: cover loaded")
            } else {
                Log.w(TAG, "coverRefresh: cover not available before timeout")
            }
        }
    }

    private suspend fun waitGeneratedCover(firstChunkId: String): Bitmap? {
        var result: Bitmap? = null
        pollWithBackoff(timeoutMs = IMAGE_POLL_TIMEOUT_MS) {
            if (_uiState.value.coverImage != null) return@pollWithBackoff true
            val storyboard = _repository.getChunkStoryboard(firstChunkId)
            val iu = storyboard.ius.firstOrNull() ?: return@pollWithBackoff false
            val chId = storyboard.chapter_id?.takeIf { it.isNotBlank() } ?: return@pollWithBackoff false
            val scId = storyboard.scene_id?.takeIf { it.isNotBlank() } ?: return@pollWithBackoff false
            val bkId = storyboard.book_id?.takeIf { it.isNotBlank() } ?: bookId
            val bldId = storyboard.build_id.ifBlank { buildId }
            if (bldId.isBlank()) return@pollWithBackoff false

            val imgBytes = _repository.getIuImage(bkId, chId, scId, iu.unit_id, bldId)
            result = MediaDecoder.decodeBitmap(imgBytes)
            true
        }
        return result ?: _uiState.value.coverImage
    }

    /**
     * Check if the user has reached the last unit of the last scene in the current window.
     * If so, trigger background generation of the next window.
     * Called from all fragments after user-initiated position changes.
     *
     * @param sceneUnitCount total number of units in the current scene
     */
    fun checkEndOfWindowAndTrigger(
        chapterId: String?,
        sceneId: String?,
        unitId: String?,
        unitIndex: Int,
        sceneUnitCount: Int
    ) {
        if (bookId.isBlank()) return
        if (sceneUnitCount <= 0) return
        if (unitIndex < sceneUnitCount - 1) return  // not the last unit
        if (currentIndex < chunkQueue.size - 1) return  // not the last scene

        Log.i(TAG, "checkEndOfWindowAndTrigger: end of window reached at $chapterId/$sceneId unit=$unitIndex/$sceneUnitCount")
        triggerNextWindow(chapterId, sceneId, unitId)
    }

    /**
     * Trigger background generation of the next window via the backend API.
     * Called when the user activates the last unit of the last scene of the current window.
     * The backend creates a PG session and runs generation in background.
     * We poll for completion and silently add new scenes to chunkQueue.
     */
    private fun triggerNextWindow(chapterId: String? = null, sceneId: String? = null, unitId: String? = null) {
        if (bookId.isBlank()) return
        Log.i(TAG, "triggerNextWindow: $bookId ch=$chapterId sc=$sceneId")

        // Cancel any existing polling
        backgroundGenPollJob?.cancel()

        backgroundGenPollJob = viewModelScope.launch {
            // 1. Call the trigger API
            val response = runCatching {
                _repository.triggerNextWindow(bookId, chapterId, sceneId, unitId)
            }.getOrNull()

            if (response == null) {
                Log.w(TAG, "triggerNextWindow: API call failed")
                return@launch
            }

            if (response.all_done) {
                Log.i(TAG, "triggerNextWindow: all text processed")
                return@launch
            }

            if (!response.triggered && !response.queued) {
                Log.w(TAG, "triggerNextWindow: not triggered: ${response.error}")
                return@launch
            }

            val sessionId = response.session_id
            Log.i(TAG, "triggerNextWindow: session=$sessionId, window=${response.window_index}")

            // 2. Poll for generation completion silently
            var pollCount = 0
            val maxPolls = 120 // 120 * 5s = 10 min timeout
            while (pollCount < maxPolls) {
                delay(5000)
                pollCount++

                val state = runCatching {
                    _repository.getGenerationState(bookId)
                }.getOrNull() ?: continue

                if (state.status == "completed" || state.status == "failed") {
                    if (state.status == "failed") {
                        Log.w(TAG, "triggerNextWindow: generation failed: ${state.error}")
                    } else {
                        Log.i(TAG, "triggerNextWindow: window ${state.last_window_index} completed")
                    }

                    // 3. Refresh book data to get new scenes
                    runCatching {
                        val bookData = _repository.getBook(bookId)
                        var addedCount = 0
                        for (ch in (bookData.chapters ?: emptyList())) {
                            ch.chapter?.let { cid ->
                                if (!chunkQueue.contains(cid)) {
                                    chunkQueue.add(cid)
                                    addedCount++
                                }
                            }
                        }
                        if (addedCount > 0) {
                            Log.i(TAG, "triggerNextWindow: added $addedCount new chapters to queue")
                        }
                    }
                    return@launch
                }

                // Check if active session changed (new window started)
                if (state.last_window_index > 0 && pollCount % 6 == 0) {
                    Log.d(TAG, "triggerNextWindow: still generating... window ${state.last_window_index}")
                }
            }

            Log.w(TAG, "triggerNextWindow: polling timed out")
        }
    }

    private fun maybeStartNextWindowInBackground() {
        // Trigger lazy parse for next window if the current window is nearly consumed.
        // This prepares the next batch of scenes in the background.
        if (bookId.isBlank()) return

        val remaining = chunkQueue.size - currentIndex - 1
        if (remaining <= 2) {
            // User is approaching the end of prepared scenes -> background parse next window
            backgroundWindowJob?.cancel()
            backgroundWindowJob = viewModelScope.launch {
                runCatching {
                    val status = _repository.getLazyBookStatus(bookId)
                    if (status.state == "INDEXED" && status.parsedChapters < status.totalChapters) {
                        val res = _repository.lazyParse(bookId, LAZY_WINDOW_DEFAULT)
                        Log.i(TAG, "maybeStartNextWindowInBackground: lazy parsed ${res.parsed} chapters")
                        // Add newly parsed chapters to chunk queue
                        for (ch in res.chapters) {
                            ch.chapter?.let { cid ->
                                if (!chunkQueue.contains(cid)) {
                                    chunkQueue.add(cid)
                                }
                            }
                        }
                    }
                }.onFailure { e ->
                    Log.w(TAG, "maybeStartNextWindowInBackground: ${e.message}")
                }
            }
        }
    }

    /**
     * Safe fallback for IU duration when backend provides 0 or null values.
     * Uses estimated_duration_sec if positive, otherwise returns a safe default of 2000ms.
     */
    private fun fallbackDurationMs(estimatedSec: Double?): Long {
        if (estimatedSec != null && estimatedSec > 0) {
            return (estimatedSec * 1000).toLong()
        }
        return 2000L
    }

    private suspend fun fetchIuSequence(id: String): List<IuImageItem> {
        return runCatching {
            val storyboard = _repository.getChunkStoryboard(id)
            chunkPositions[id] = Pair(storyboard.chapter_id, storyboard.scene_id)
            Log.i(TAG, "storyboard: ${storyboard.ius.size} IUs, build_id=${storyboard.build_id}")
            val chId = (storyboard.chapter_id?.takeIf { it.isNotBlank() } ?: currentChapterId) ?: ""
            val scId = (storyboard.scene_id?.takeIf { it.isNotBlank() } ?: currentSceneId) ?: ""
            val bkId = storyboard.book_id?.takeIf { it.isNotBlank() } ?: bookId
            val bldId = storyboard.build_id.ifBlank { buildId }
            if (storyboard.ius.isNotEmpty() && bldId.isNotBlank() && chId.isNotBlank()) {
                storyboard.ius.map { iu ->
                    val durationMs = when {
                        iu.start_ms != null && iu.end_ms != null -> {
                            // Guard: real duration must be positive, fall back to estimated if not
                            val real = iu.end_ms - iu.start_ms
                            if (real > 0) real else fallbackDurationMs(iu.estimated_duration_sec)
                        }
                        else -> fallbackDurationMs(iu.estimated_duration_sec)
                    }
                    val iuText = iu.text
                val result = runCatching {
                        Log.d(TAG, "fetching IU image: ${iu.unit_id} (dur=$durationMs ms) bldId=$bldId")
                        val imgBytes = _repository.getIuImage(bkId, chId, scId, iu.unit_id, bldId)
                        val bmp = MediaDecoder.decodeBitmap(imgBytes)
                        IuImageItem(bmp, durationMs, iu.unit_id, iuText, IuStatus.READY)
                    }
                    result.getOrNull() ?: run {
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
            } else {
                Log.w(TAG, "storyboard empty or missing IDs: ius=${storyboard.ius.size} bldId=$bldId chId=$chId")
                emptyList()
            }
        }.getOrDefault(emptyList()).also {
            val missing = it.count { item -> item.status == IuStatus.NOT_GENERATED }
            Log.i(TAG, "IU sequence loaded: ${it.size} images ($missing not generated)")
        }
    }

    private fun preloadAhead(includeCurrent: Boolean = false) {
        val start = if (includeCurrent) 0 else 1
        for (offset in start..PRELOAD_AHEAD) {
            val idx = currentIndex + offset
            if (idx >= chunkQueue.size) break
            val id = chunkQueue[idx]
            if (preloadCache.containsKey(id) || preloadJobs.containsKey(id)) continue
            Log.i(TAG, "preloading scene $offset ahead: $id")
            val job = viewModelScope.launch {
                val data = runCatching { fetchSceneData(id) }.getOrNull()
                if (data != null) {
                    preloadCache[id] = data
                    _preloadCompleted.tryEmit(id)
                    Log.i(TAG, "preloaded scene: $id")
                } else {
                    Log.w(TAG, "preload failed for scene: $id")
                }
                preloadJobs.remove(id)
            }
            preloadJobs[id] = job
        }
    }

    private suspend fun waitForNextWindow(): Boolean {
        val currentBookId = bookId
        if (currentBookId.isBlank()) {
            Log.w(TAG, "waitForNextWindow: empty bookId")
            return false
        }

        // Check if book is a lazy book (INDEXED state) — trigger lazy parse
        val status = runCatching { _repository.getLazyBookStatus(currentBookId) }.getOrNull()
        if (status != null && (status.state == "INDEXED" || status.state == "RAW")) {
            _uiState.update { it.copy(phase = PlayerPhase.GENERATING) }
            return runCatching {
                val res = _repository.lazyParse(currentBookId, LAZY_WINDOW_DEFAULT)
                for (ch in res.chapters) {
                    ch.chapter?.let { cid ->
                        if (!chunkQueue.contains(cid)) {
                            chunkQueue.add(cid)
                        }
                    }
                }
                Log.i(TAG, "waitForNextWindow: lazy parsed ${res.parsed} chapters complete=${res.complete}")
                if (res.complete || currentIndex < chunkQueue.size) {
                    _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING) }
                    true
                } else {
                    false
                }
            }.getOrElse { e ->
                Log.w(TAG, "waitForNextWindow: lazy parse failed: ${e.message}")
                false
            }
        }

        _uiState.update { it.copy(phase = PlayerPhase.GENERATING) }
        repeat(WINDOW_RETRY_COUNT) { attempt ->
            // Backend now auto-slides the window; we just poll for new chunks.
            val chunks = runCatching { _repository.getAllChunks(currentBookId) }.getOrElse { e ->
                Log.w(TAG, "waitForNextWindow: chunks failed: ${e.message}")
                null
            }

            if (chunks != null) {
                var added = 0
                for (id in chunks.chunk_ids) {
                    if (!chunkQueue.contains(id)) {
                        chunkQueue.add(id)
                        added++
                    }
                }
                Log.i(TAG, "waitForNextWindow: added=$added queue=${chunkQueue.size} totalScenes=${chunks.total_scenes} started=${chunks.started_scenes} ready=${chunks.ready_scenes}")

                if (currentIndex < chunkQueue.size) {
                    val nextWindow = chunkQueue.drop(currentIndex).take(WINDOW_SIZE)
                    return runCatching {
                        waitWindowReady(nextWindow)
                        true
                    }.getOrElse { e ->
                        Log.w(TAG, "waitForNextWindow: next window not ready: ${e.message}")
                        false
                    }.also { ready ->
                        if (ready) Log.i(TAG, "waitForNextWindow: next window ready")
                    }
                }

                val statusSaysDone = chunks.total_scenes > 0 &&
                    chunks.started_scenes >= chunks.total_scenes
                val legacyStatusSaysDone = chunks.total > 0 &&
                    chunks.chunk_ids.size >= chunks.total
                val noMoreScenes = added == 0 &&
                    currentIndex >= chunkQueue.size &&
                    (statusSaysDone || legacyStatusSaysDone)
                if (noMoreScenes) {
                    Log.i(TAG, "waitForNextWindow: end of book")
                    return false
                }
            }

            if (attempt < WINDOW_RETRY_COUNT - 1) delay(3_000L)
        }

        _uiState.update { it.copy(errorMessage = "Timed out waiting for next scene window") }
        Log.w(TAG, "waitForNextWindow: timeout")
        return false
    }

    private suspend fun pollWithBackoff(timeoutMs: Long = POLL_TIMEOUT_MS, pollAction: suspend () -> Boolean) {
        var polls = 0
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val ok = runCatching { pollAction() }.getOrDefault(false)
            if (ok) return
            polls++
            val delayMs = minOf(POLL_INTERVAL_MS * (1L shl minOf(polls / 10, 4)), MAX_BACKOFF_MS)
            if (polls % 20 == 0) {
                Log.d(TAG, "poll #$polls, delay=${delayMs}ms")
                if (polls == 20) {
                    Log.w(TAG, "poll still waiting after 20 attempts")
                }
            }
            delay(delayMs)
        }
    }

    private suspend fun waitForWorkers(chunkIds: List<String>) {
        Log.i(TAG, "waitForWorkers: polling until workers appear")
        var polls = 0
        while (true) {
            polls++
            delay(3_000L)
            val counts = runCatching { _repository.getWorkerCounts() }.getOrNull() ?: continue
            if (counts.audio > 0 || counts.image > 0 || counts.video > 0) {
                Log.i(TAG, "waitForWorkers: workers detected after ${polls * 3}s (aw=${counts.audio} iw=${counts.image} vw=${counts.video})")
                _uiState.update { it.copy(phase = PlayerPhase.GENERATING, errorMessage = null) }
                resumeAfterWorkers(chunkIds)
                return
            }
            if (polls == 100) {
                _uiState.update { it.copy(errorMessage = "Still waiting for workers...") }
            }
            if (polls % 100 == 0 && polls > 100) {
                Log.w(TAG, "waitForWorkers: still waiting (${polls * 3}s ≈ ${polls / 20}min)")
            }
            // Throttle polling after 10 minutes to reduce load
            if (polls > 200) {
                delay(27_000L) // extra 27s = 30s total interval
            }
        }
    }

    private suspend fun resumeAfterWorkers(chunkIds: List<String>) {
        Log.i(TAG, "resumeAfterWorkers: starting generation flow")
        startVideoCheck()
        if (chunkIds.isEmpty()) return
        startCoverRefresh(chunkIds.first())
        val waitCount = minOf(INITIAL_WAIT_COUNT, chunkIds.size)
        runCatching {
            waitWindowReady(chunkIds.take(waitCount))
        }.onFailure { e ->
            Log.w(TAG, "waitInitialWindow failed: ${e.message}")
            _uiState.update { it.copy(errorMessage = "Window timeout: ${e.message}") }
            return
        }
        if (chunkQueue.isNotEmpty()) {
            runCatching {
                val firstData = fetchSceneData(chunkQueue[0])
                preloadCache[chunkQueue[0]] = firstData
            }.onFailure { e ->
                Log.w(TAG, "first chunk preload failed: ${e.message}")
            }
        }
        _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
    }

    private suspend fun waitChunkReady(id: String): ChunkResponse {
        // Fast path: single check — if the chunk is already ready, return immediately
        Log.d(TAG, "waitChunkReady: $id")
        var last = runCatching { _repository.getChunk(id) }.getOrNull()
        if (last != null && last.audio_ready && (!imageEnabled || last.image_ready)) {
            Log.d(TAG, "waitChunkReady: $id already ready")
            if (imageEnabled) waitStoryboardReady(id)
            return last
        }

        // Slow path: poll until the chunk is ready, with exponential backoff
        pollWithBackoff(timeoutMs = IMAGE_POLL_TIMEOUT_MS) {
            val chunk = _repository.getChunk(id)
            last = chunk
            chunk.audio_ready
        }

        if (last == null || !last!!.audio_ready) {
            Log.w(TAG, "waitChunkReady: $id TIMEOUT after ${IMAGE_POLL_TIMEOUT_MS}ms — returning fallback")
            return ChunkResponse(
                status = "unknown", audio_ready = false,
                image_ready = false, video_ready = false, video_status = "pending"
            )
        }

        if (imageEnabled) waitStoryboardReady(id)
        return last!!
    }

    private suspend fun waitWindowReady(ids: List<String>) {
        for (id in ids) {
            Log.i(TAG, "waitWindowReady: $id")
            waitChunkReady(id)
        }
    }

    private suspend fun waitStoryboardReady(id: String, timeoutMs: Long = IMAGE_POLL_TIMEOUT_MS) {
        var hasStoryboard = false
        pollWithBackoff(timeoutMs = timeoutMs) {
            val storyboard = _repository.getChunkStoryboard(id)
            chunkPositions[id] = Pair(storyboard.chapter_id, storyboard.scene_id)
            hasStoryboard = storyboard.ius.isNotEmpty()
            hasStoryboard
        }
        if (!hasStoryboard) {
            Log.w(TAG, "waitStoryboardReady: $id storyboard not ready after ${timeoutMs}ms, continuing anyway")
        }
    }

    private suspend fun waitFirstAudio(id: String) {
        Log.d(TAG, "waitFirstAudio: $id")
        val ready = runCatching {
            var result = false
            pollWithBackoff {
                val chunk = _repository.getChunk(id)
                result = chunk.audio_ready
                result
            }
            result
        }.getOrDefault(false)
        if (!ready) {
            Log.w(TAG, "waitFirstAudio: $id TIMEOUT or FAILED")
        } else {
            Log.i(TAG, "waitFirstAudio: $id done")
        }
    }

    private suspend fun waitPreview(id: String) {
        Log.d(TAG, "waitPreview: $id")
        pollWithBackoff {
            val chunk = _repository.getChunk(id)
            if (chunk.image_ready) {
                runCatching {
                        val imageBytes = _repository.getChunkImage(id)
                        val bitmap = MediaDecoder.decodeBitmap(imageBytes)
                        _uiState.update { it.copy(previewImage = bitmap, coverImage = bitmap) }
                }.onFailure { e ->
                    Log.e(TAG, "waitPreview: failed to load image: ${e.message}")
                }
                return@pollWithBackoff true
            }
            false
        }
        Log.i(TAG, "waitPreview: $id done")
    }

    fun clearPlaybackState() {
        chunkPositions.clear()
        preloadCache.clear()
        preloadJobs.clear()
        backgroundWindowJob?.cancel()
        backgroundWindowJob = null
        backgroundWindowStart = -1
        backgroundGenPollJob?.cancel()
        backgroundGenPollJob = null
        coverRefreshJob?.cancel()
        coverRefreshJob = null
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
        _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
    }

}

data class UiState(
    val phase: PlayerPhase = PlayerPhase.IDLE,
    val chunkIds: List<String> = emptyList(),
    val previewImage: Bitmap? = null,
    val currentImage: Bitmap? = null,
    val coverImage: Bitmap? = null,
    val errorMessage: String? = null,
    val chunkSequence: Long = 0,
    val mode: String = "full",  // "audio" | "storyboard" | "full"
    val missingIuPosition: ActivePosition? = null,
    val importStage: ImportStage? = null,
    val importProgress: Float = 0f,
    val importProgressMessages: List<String> = emptyList()
)

enum class PlayerPhase {
    IDLE,
    LOADING_BOOK,
    GENERATING,
    DOWNLOADING,
    SCENE_READY,
    PLAYING,
    PAUSED,
    IMPORTING_TXT
}

enum class ImportStage(val label: String) {
    VALIDATING("Validating file..."),
    LOADING("Loading file..."),
    ANALYZING("Analyzing text..."),
    EXTRACTING_CHARACTERS("Extracting characters..."),
    EXTRACTING_LOCATIONS("Extracting locations..."),
    CREATING_STRUCTURE("Creating book structure..."),
    CREATING_SCENES("Creating first scenes..."),
    COMPLETING("Finalizing..."),
    DONE("Import completed");

    companion object {
        fun fromString(s: String): ImportStage {
            return entries.find { it.name.lowercase() == s.lowercase() } ?: COMPLETING
        }
    }
}

data class IuImageItem(
    val bitmap: Bitmap?,
    val durationMs: Long,
    val unitId: String? = null,
    val text: String? = null,
    val status: IuStatus = IuStatus.READY
)

enum class IuStatus {
    READY,
    NOT_GENERATED,
    FAILED
}

class PreloadedScene(
    val audioBytes: ByteArray,
    val videoBytes: ByteArray?,
    val iuSequence: List<IuImageItem>
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PreloadedScene) return false
        return audioBytes.contentEquals(other.audioBytes) &&
               videoBytes.contentEquals(other.videoBytes) &&
               iuSequence == other.iuSequence
    }
    override fun hashCode(): Int {
        var result = audioBytes.contentHashCode()
        result = 31 * result + (videoBytes?.contentHashCode() ?: 0)
        result = 31 * result + iuSequence.hashCode()
        return result
    }
}

data class ActivePosition(
    val chapterId: String? = null,
    val sceneId: String? = null,
    val unitId: String? = null,
    val chunkId: String? = null,
    val unitIndex: Int = 0
) {
    fun formatUnitLabel(): String = unitId ?: String.format("iu%04d", unitIndex)
}

class PositionManager {

    private val _current = MutableStateFlow(ActivePosition())
    val current: StateFlow<ActivePosition> = _current.asStateFlow()

    fun navigateTo(position: ActivePosition) {
        _current.value = position
    }

    fun navigateTo(
        chapterId: String?,
        sceneId: String?,
        unitId: String? = null,
        chunkId: String? = null,
        unitIndex: Int = 0
    ) {
        _current.value = ActivePosition(
            chapterId = chapterId,
            sceneId = sceneId,
            unitId = unitId,
            chunkId = chunkId,
            unitIndex = unitIndex
        )
    }

    fun previousUnit(sceneUnits: List<SceneUnit>) {
        val pos = _current.value
        val idx = pos.unitIndex
        if (idx > 0) {
            val newIdx = idx - 1
            _current.value = pos.copy(
                unitId = sceneUnits.getOrNull(newIdx)?.id,
                unitIndex = newIdx
            )
        }
    }

    fun nextUnit(sceneUnits: List<SceneUnit>) {
        val pos = _current.value
        val idx = pos.unitIndex
        if (idx < sceneUnits.size - 1) {
            val newIdx = idx + 1
            _current.value = pos.copy(
                unitId = sceneUnits.getOrNull(newIdx)?.id,
                unitIndex = newIdx
            )
        }
    }
}
