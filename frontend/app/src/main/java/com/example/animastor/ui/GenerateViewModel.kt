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
import com.example.animastor.repository.DiffSummary
import com.example.animastor.repository.DirtyScene
import com.example.animastor.repository.ImportTxtResponse
import com.example.animastor.repository.LayerConfigUpdate
import com.example.animastor.repository.ReorderChapter
import com.example.animastor.repository.Repository
import com.example.animastor.repository.ChunkListResponse
import com.example.animastor.util.MediaDecoder
import com.example.animastor.util.SimpleDiskCache
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

/**
 * ViewModel for content generation, book loading, and import pipeline.
 *
 * Does NOT manage playback state — that is handled by [PlaybackViewModel].
 * Communicates new chunk availability via [playbackPrepared] so the activity
 * coordinator can inform the player.
 */
class GenerateViewModel(
    application: Application,
    private val _repository: Repository
) : AndroidViewModel(application) {

    val repository: Repository get() = _repository

    companion object {
        private const val TAG = "GenVM"
        private const val IMAGE_POLL_TIMEOUT_MS = 1_800_000L
        private const val INITIAL_WAIT_COUNT = 3
        private const val WINDOW_RETRY_COUNT = 60
        private const val POLL_TIMEOUT_MS = 300_000L
        private const val LAZY_WINDOW_DEFAULT = 3
        private const val MAX_BACKOFF_MS = 5_000L
        private const val POLL_INTERVAL_MS = 300L

        val factory: ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T {
                val app = checkNotNull(extras[ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY])
                val diskCache = SimpleDiskCache(
                    cacheDir = java.io.File(app.cacheDir, "media-cache"),
                    maxSizeBytes = 256 * 1024 * 1024
                )
                val repo = Repository(RetrofitClient.api, diskCache)
                return GenerateViewModel(application = app, _repository = repo) as T
            }
        }
    }

    // ── Shared playback data — consumed by MainActivity → PlaybackViewModel ─

    /**
     * Emitted when new chunks are ready for playback.
     * The activity coordinator observes this and calls [PlaybackViewModel.preparePlayback].
     */
    data class PlaybackPreparation(
        val bookId: String,
        val buildId: String,
        val chunkIds: List<String>,
        val coverImage: Bitmap? = null,
        val chunkPositions: Map<String, Pair<String?, String?>> = emptyMap(),
        val softRefresh: Boolean = false
    )

    private val _playbackPrepared = MutableSharedFlow<PlaybackPreparation>(replay = 1, extraBufferCapacity = 4)
    val playbackPrepared: SharedFlow<PlaybackPreparation> = _playbackPrepared.asSharedFlow()


    // ── UI State (generation/import related only) ─────────────────

    private val _uiState = MutableStateFlow(GenUiState())
    val uiState: StateFlow<GenUiState> = _uiState.asStateFlow()

    var bookId: String = ""
        private set
    var buildId: String = ""
        private set

    // ── Global window trigger (observes SharedPositionManager) ───
    val windowTriggerManager: WindowTriggerManager = WindowTriggerManager(_repository, viewModelScope)

    init {
        val prefs = getApplication<Application>().getSharedPreferences("animastor", 0)
        bookId = prefs.getString("bookId", "") ?: ""
        buildId = prefs.getString("buildId", "") ?: ""
        // Start global window trigger if a book is already loaded from prefs
        if (bookId.isNotBlank()) {
            windowTriggerManager.start(bookId)
        }
    }

    private fun persistBookId(id: String) {
        val oldId = bookId
        bookId = id
        val prefs = getApplication<Application>().getSharedPreferences("animastor", 0)
        prefs.edit().putString("bookId", id).apply()
        // Restart window trigger for the new book
        if (oldId != id) {
            if (id.isNotBlank()) {
                windowTriggerManager.start(id)
            } else {
                windowTriggerManager.stop()
            }
        }
    }

    private fun persistBuildId(id: String) {
        buildId = id
        val prefs = getApplication<Application>().getSharedPreferences("animastor", 0)
        prefs.edit().putString("buildId", id).apply()
    }

    private var generationJob: Job? = null

    // ── Layer config & profile toggles ────────────────────────────

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

    fun audioEnabled(): Boolean = _audioEnabled.value
    fun videoEnabled(): Boolean = _videoEnabled.value
    fun currentProfile(): String = computeProfile(imageEnabled, _videoEnabled.value)
    fun hasAssets(): Boolean = _hasAssets.value

    fun setAudioEnabled(enabled: Boolean) {
        _audioEnabled.value = enabled
        viewModelScope.launch { persistLayerConfig() }
    }

    fun setVideoEnabled(enabled: Boolean) {
        _videoEnabled.value = enabled
        viewModelScope.launch { persistLayerConfig() }
    }

    /**
     * Toggle audio independently. Does NOT affect image or video.
     */
    fun toggleAudioForProfile() {
        _audioEnabled.value = !_audioEnabled.value
        viewModelScope.launch { persistLayerConfig() }
    }

    /**
     * Toggle image independently. Does NOT affect audio or video.
     */
    fun toggleImageForProfile() {
        imageEnabled = !imageEnabled
        viewModelScope.launch { persistLayerConfig() }
    }

    /**
     * Toggle video independently. Does NOT affect audio or image.
     */
    fun toggleVideoForProfile() {
        _videoEnabled.value = !_videoEnabled.value
        viewModelScope.launch { persistLayerConfig() }
    }

    /**
     * Compute profile string from independent worker states.
     * All 8 combinations of (audio, image, video) are valid.
     */
    private fun computeProfile(audio: Boolean, image: Boolean, video: Boolean): String {
        if (audio && image && video) return "full"
        if (!audio && image && video) return "image_only"
        if (audio && !image && video) return "audio_only"
        if (!audio && !image && video) return "video_only"  // video without audio/image → just video
        if (audio && image && !video) return "storyboard"
        if (!audio && image && !video) return "image_only"
        if (audio && !image && !video) return "audio_only"
        return "audio_only"  // all disabled — default to audio_only
    }

    private fun computeProfile(image: Boolean, video: Boolean): String {
        return computeProfile(_audioEnabled.value, image, video)
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
                _layerProfile.value = cfg.profile ?: computeProfile(_audioEnabled.value, imageEnabled, _videoEnabled.value)
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
            _layerProfile.value = cfg.profile ?: computeProfile(_audioEnabled.value, imageEnabled, _videoEnabled.value)
            Log.i(TAG, "persistLayerConfig: ${cfg.profile}")
        }.onFailure { e ->
            Log.w(TAG, "persistLayerConfig failed: ${e.message}")
        }
    }

    // ── Generation ───────────────────────────────────────────────

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
            _uiState.value = GenUiState(phase = PlayerPhase.GENERATING)
            runCatching {
                // Pass profile to backend so /regenerate applies it BEFORE
                // checking cover/images. This eliminates a race condition where
                // persistLayerConfig() (called asynchronously by toggle chips)
                // might not have completed by the time /regenerate reads from Redis.
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
                // Update buildId — after regeneration the backend returns a new
                // build_id so that client-side cache keys change and stale
                // placeholder data is naturally invalidated (cache miss → fresh
                // network fetch) without requiring an explicit clearCache().
                if (res.build_id != null) {
                    val oldBuildId = buildId
                    persistBuildId(res.build_id)
                    Log.i(TAG, "startGeneration: updated buildId from '$oldBuildId' to '${res.build_id}'")
                } else {
                    Log.w(TAG, "startGeneration: build_id is null in regenerate response")
                }
                _repository.clearCache()
                _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
                val dirtyCount = res.dirty_scenes?.size ?: 0
                onResult(GenerationResult.Started(dirtyCount, res.scope ?: req.scope))
                viewModelScope.launch { refreshAssetsState() }
                // Keep _activeGeneration alive: the progress bar polls getAssetsState
                // to show actual completion. Only clear when cancelled or on a new
                // generation that replaces this one. The poller hides the bar when
                // ready >= total.
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
                    _activeGeneration.value = null
                }
            }
        }
    }

    /**
     * Called by the progress poller when assets-state reports all scenes ready.
     * Cleans up the regeneration flag so the UI can reflect completion, and
     * emits [playbackPrepared] with fresh chunk data so the player can resume
     * with the newly generated content.
     */
    fun onGenerationComplete() {
        if (_isRegenerating.value) {
            _isRegenerating.value = false
        }
        _activeGeneration.value = null

        // Refresh playback data — generation is now truly complete, so chunk
        // metadata (audio_ready, image_ready, etc.) reflects the fresh state.
        viewModelScope.launch {
            val allChunks = runCatching { _repository.getAllChunks(bookId) }.getOrNull()
            val chunkIds = allChunks?.chunk_ids?.toList() ?: return@launch
            if (chunkIds.isEmpty()) return@launch

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
            var cover: Bitmap? = null
            val coverId = coverChunkId ?: chunkIds.firstOrNull()
            if (coverId != null && imageEnabled) {
                cover = loadCoverBitmap(coverId)
                // Retry with exponential backoff — the backend may have just
                // finished generation and the image file might not be readable
                // immediately. Without retry, cover stays null → setCoverImage
                // is never called → curtains remain visible as fallback.
                if (cover == null) {
                    for (retry in 1..5) {
                        delay((1000L shl minOf(retry, 3)).coerceAtMost(5000))
                        Log.i(TAG, "onGenerationComplete: retry $retry loading cover (coverId=$coverId)")
                        cover = loadCoverBitmap(coverId)
                        if (cover != null) break
                    }
                }
            }
            Log.i(TAG, "onGenerationComplete: emitting playbackPrepared (softRefresh) with ${chunkIds.size} chunks cover=${cover != null}")
            _playbackPrepared.tryEmit(PlaybackPreparation(
                bookId = bookId,
                buildId = buildId,
                chunkIds = chunkIds,
                coverImage = cover,
                chunkPositions = positions,
                softRefresh = true
            ))
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
            generationJob?.cancel()
            generationJob = null
            _isRegenerating.value = false
            _activeGeneration.value = null
            _uiState.update { it.copy(phase = PlayerPhase.IDLE, errorMessage = null) }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  GENERATE FROM FILE (full pipeline)
    // ═══════════════════════════════════════════════════════════════

    fun generateFromFile(file: File) {
        Log.i(TAG, "generateFromFile: ${file.name}")
        generationJob?.cancel()
        generationJob = viewModelScope.launch {
            _uiState.value = GenUiState(phase = PlayerPhase.LOADING_BOOK)

            runCatching {
                _repository.generate(file, imageEnabled)
            }.onSuccess { res ->
                Log.i(TAG, "generate OK: bookId=${res.book_id} buildId=${res.build_id} #chunks=${res.chunk_ids.size}")
                persistBookId(res.book_id)
                persistBuildId(res.build_id ?: "")

                runCatching { _repository.snapshotBook(bookId) }

                val chunkIds = res.chunk_ids.toList()
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
                    }.onFailure { e ->
                        Log.w(TAG, "failed to get storyboard for $cid: ${e.message}")
                    }
                }

                val firstPos = chunkIds.firstOrNull()?.let { positions[it] }
                if (firstPos != null) {
                    SharedPositionManager.navigateTo(chapterId = firstPos.first, sceneId = firstPos.second, unitIndex = 0)
                } else {
                    SharedPositionManager.navigateTo(chapterId = null, sceneId = null)
                }

                val coverId = coverChunkId ?: chunkIds.firstOrNull()
                var cover: Bitmap? = null
                if (coverId != null) {
                    val isCached = runCatching {
                        _repository.getChunk(coverId, buildId).audio_ready
                    }.getOrDefault(false)

                    if (!isCached) {
                        _uiState.update { it.copy(phase = PlayerPhase.GENERATING, chunkIds = chunkIds, mode = res.mode ?: "full") }
                        waitWindowReady(chunkIds.take(minOf(INITIAL_WAIT_COUNT, chunkIds.size)))
                    }

                    // Use explicit scene_type=cover marker to find cover chunk
                    if (imageEnabled) {
                        cover = loadCoverBitmap(coverId)
                    }
                }

                // Signal to PlaybackViewModel via activity coordinator
                _playbackPrepared.tryEmit(PlaybackPreparation(
                    bookId = bookId,
                    buildId = buildId,
                    chunkIds = chunkIds,
                    coverImage = cover,
                    chunkPositions = positions
                ))

                _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY, chunkIds = chunkIds) }

            }.onFailure { e ->
                Log.e(TAG, "generate failed: ${e.message}", e)
                val msg = if (e is java.io.IOException && e.message != null) e.message!! else "Generate failed: ${e.message}"
                _uiState.update { it.copy(phase = PlayerPhase.IDLE, errorMessage = msg) }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  LOAD VBOOK
    // ═══════════════════════════════════════════════════════════════

    fun loadBookFromFile(file: File) {
        Log.i(TAG, "loadBookFromFile: ${file.name}")
        generationJob?.cancel()
        hasUnsavedChanges = false
        _activeGeneration.value = null
        _dirtySummary.value = null
        _dirtyScenes.value = emptyList()
        _isRegenerating.value = false
        _uiState.value = GenUiState(phase = PlayerPhase.LOADING_BOOK)

        generationJob = viewModelScope.launch {
            runCatching {
                _repository.loadVbook(file)
            }.onSuccess { res ->
                Log.i(TAG, "loadBookFromFile OK: bookId=${res.book_id} buildId=${res.build_id} chapters=${res.chapter_count} scenes=${res.scene_count}")
                persistBookId(res.book_id)
                persistBuildId(res.build_id ?: "")
                runCatching { _repository.snapshotBook(bookId) }

                val allChunks = runCatching { _repository.getAllChunks(bookId) }.getOrElse { ChunkListResponse(emptyList()) }
                val chunkIds = allChunks.chunk_ids.toList()
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
                Log.i(TAG, "loadBookFromFile: chunks=${chunkIds.size} positions=${positions.size}")

                val firstPos = chunkIds.firstOrNull()?.let { positions[it] }
                if (firstPos != null) {
                    SharedPositionManager.navigateTo(chapterId = firstPos.first, sceneId = firstPos.second, unitIndex = 0)
                } else {
                    runCatching {
                        val bookData = _repository.getBook(bookId)
                        val firstChapter = bookData.chapters?.firstOrNull()
                        val firstScene = firstChapter?.scenes?.firstOrNull()
                        SharedPositionManager.navigateTo(chapterId = firstChapter?.chapter, sceneId = firstScene?.scene_id, unitIndex = 0)
                    }.onFailure { e ->
                        Log.w(TAG, "position fallback failed: ${e.message}")
                        SharedPositionManager.navigateTo(chapterId = null, sceneId = null)
                    }
                }

                _uiState.update {
                    it.copy(
                        phase = PlayerPhase.DOWNLOADING,
                        chunkIds = emptyList(),
                        previewImage = null,
                        coverImage = null,
                        errorMessage = null
                    )
                }

                val coverId = coverChunkId ?: chunkIds.firstOrNull()
                val cover = if (coverId != null && imageEnabled) loadCoverBitmap(coverId) else null

                // Signal to PlaybackViewModel
                _playbackPrepared.tryEmit(PlaybackPreparation(
                    bookId = bookId,
                    buildId = buildId,
                    chunkIds = chunkIds,
                    coverImage = cover,
                    chunkPositions = positions
                ))

                _uiState.update { it.copy(phase = if (chunkIds.isNotEmpty()) PlayerPhase.SCENE_READY else PlayerPhase.IDLE) }
            }.onFailure { e ->
                Log.e(TAG, "loadBookFromFile failed: ${e.message}", e)
                val msg = if (e is java.io.IOException && e.message != null) e.message!! else "Load failed: ${e.message}"
                _uiState.update { it.copy(phase = PlayerPhase.IDLE, errorMessage = msg) }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  TXT IMPORT
    // ═══════════════════════════════════════════════════════════════

    fun importTxtFromFile(file: File) {
        Log.i(TAG, "importTxtFromFile: ${file.name}")
        generationJob?.cancel()
        hasUnsavedChanges = false
        _activeGeneration.value = null
        _dirtySummary.value = null
        _dirtyScenes.value = emptyList()
        _isRegenerating.value = false

        generationJob = viewModelScope.launch {
            val msgs = mutableListOf<String>()
            try {
                _uiState.update { it.copy(
                    phase = PlayerPhase.IMPORTING_TXT,
                    importStage = ImportStage.VALIDATING,
                    importProgress = 0.1f,
                    errorMessage = null,
                    importProgressMessages = emptyList()
                )}

                val importRes = _repository.importTxt(file)
                val bId = importRes.book_id
                persistBookId(bId)
                persistBuildId("default")
                Log.i(TAG, "importTxtFromFile: draft created $bId (dedup=${importRes.dedup})")

                // ── Handle dedup: check book state, resume if incomplete ──
                if (importRes.dedup) {
                    msgs.add("✓ Книга уже существует — проверяем состояние...")
                    _uiState.update { it.copy(importProgressMessages = msgs.toList()) }

                    // Check book state
                    val bookStatus = runCatching { _repository.getLazyBookStatus(bId) }.getOrNull()
                    // Book is complete if: exists, has a non-null state, is BOOTSTRAPPED/ACTIVE with parsed chapters
                    val isComplete = bookStatus?.let { bs ->
                        bs.state != null &&
                        (bs.state == "BOOTSTRAPPED" || bs.state == "ACTIVE") &&
                        bs.parsedChapters > 0
                    } ?: false
                    val isIncomplete = !isComplete

                    if (isIncomplete) {
                        msgs.add("⟳ Книга недостроена — возобновляем импорт...")
                        _uiState.update { it.copy(importProgressMessages = msgs.toList()) }
                        Log.i(TAG, "importTxtFromFile: incomplete book $bId (state=${bookStatus?.state}) — resuming bootstrap")

                        // Resume bootstrap — this creates a new agent session
                        val resumeRes = _repository.resumeBootstrap(bId)
                        Log.i(TAG, "importTxtFromFile: resumeBootstrap returned state=${resumeRes.state} session=${resumeRes.session_id}")

                        // Only poll if book was NOT already complete (i.e., resume actually started a session)
                        if (resumeRes.state != "BOOTSTRAPPED" && resumeRes.state != "ACTIVE") {
                            pollAgentProgress(bId, msgs)
                        } else {
                            msgs.add("✓ Книга уже была полностью обработана")
                        }

                        msgs.add("💬 Импорт восстановлен. Можете задать вопросы или запустить генерацию.")
                        _uiState.update { it.copy(importProgressMessages = msgs.toList()) }
                    } else {
                        // Book is complete (BOOTSTRAPPED/ACTIVE with chapters)
                        val bs = bookStatus!!
                        msgs.add("✓ Книга уже готова (${bs.parsedChapters} глав, ${bs.parsedScenes} сцен)")
                        _uiState.update { it.copy(importProgressMessages = msgs.toList()) }
                    }

                    // Load all chunks and prepare playback
                    val allChunks = runCatching { _repository.getAllChunks(bId) }.getOrNull()
                    val chunkIds = allChunks?.chunk_ids?.toList() ?: emptyList()
                    val positions = mutableMapOf<String, Pair<String?, String?>>()
                    for (cid in chunkIds) {
                        runCatching {
                            _repository.getChunkStoryboard(cid).let { sb ->
                                positions[cid] = Pair(sb.chapter_id, sb.scene_id)
                            }
                        }
                    }
                    val firstPos = chunkIds.firstOrNull()?.let { positions[it] }
                    if (firstPos != null) {
                        SharedPositionManager.navigateTo(chapterId = firstPos.first, sceneId = firstPos.second, unitIndex = 0)
                    }
                    Log.i(TAG, "importTxtFromFile: dedup — loaded ${chunkIds.size} chunks")

                    _playbackPrepared.tryEmit(PlaybackPreparation(
                        bookId = bId,
                        buildId = buildId,
                        chunkIds = chunkIds,
                        chunkPositions = positions
                    ))

                    msgs.add("✓ Загружено ${chunkIds.size} сцен")
                    _uiState.update { it.copy(
                        importProgressMessages = msgs.toList(),
                        importStage = ImportStage.DONE,
                        importProgress = 1f,
                        phase = if (chunkIds.isNotEmpty()) PlayerPhase.SCENE_READY else PlayerPhase.IDLE,
                        chunkIds = chunkIds,
                    )}
                    return@launch
                }

                // ── New import — bootstrap and poll ──
                msgs.add("✓ File selected")
                msgs.add("✓ TXT read")
                msgs.add("✓ Encoding detected")
                msgs.add("✓ Book created")
                _uiState.update { it.copy(importProgress = 0.2f, importProgressMessages = msgs.toList()) }

                _uiState.update { it.copy(importStage = ImportStage.ANALYZING, importProgress = 0.3f) }

                // Start Bootstrap (creates AI session for first window)
                val bootstrapRes = _repository.bootstrapBook(bId)
                msgs.add("✓ Импорт завершён: ${bootstrapRes.characters} персонажей, ${bootstrapRes.locations} локаций, ${bootstrapRes.scenes} сцен")
                _uiState.update { it.copy(importProgressMessages = msgs.toList()) }

                // Continue polling for subsequent windows
                pollAgentProgress(bId, msgs);
                msgs.add("💬 Можете задать вопросы или запустить генерацию через кнопку на панели инструментов.")
                _uiState.update { it.copy(importProgressMessages = msgs.toList()) }

                // Load all chunks
                val allChunks = runCatching { _repository.getAllChunks(bId) }.getOrNull()
                val chunkIds = allChunks?.chunk_ids?.toList() ?: emptyList()
                val positions = mutableMapOf<String, Pair<String?, String?>>()
                for (cid in chunkIds) {
                    runCatching {
                        _repository.getChunkStoryboard(cid).let { sb ->
                            positions[cid] = Pair(sb.chapter_id, sb.scene_id)
                        }
                    }
                }
                val firstPos = chunkIds.firstOrNull()?.let { positions[it] }
                if (firstPos != null) {
                    SharedPositionManager.navigateTo(chapterId = firstPos.first, sceneId = firstPos.second, unitIndex = 0)
                } else {
                    SharedPositionManager.navigateTo(chapterId = null, sceneId = null)
                }

                _playbackPrepared.tryEmit(PlaybackPreparation(
                    bookId = bId,
                    buildId = buildId,
                    chunkIds = chunkIds,
                    chunkPositions = positions
                ))

                _uiState.update { it.copy(
                    importStage = ImportStage.DONE,
                    importProgress = 1f,
                    phase = PlayerPhase.SCENE_READY,
                    chunkIds = chunkIds,
                )}
                Log.i(TAG, "importTxtFromFile: ready with ${chunkIds.size} chunks")

            } catch (e: Exception) {
                Log.e(TAG, "importTxtFromFile failed: ${e.message}", e)
                val msg = if (e is java.io.IOException && e.message != null) e.message!! else "Import TXT failed: ${e.message}"
                msgs.add("✗ Ошибка: $msg")
                _uiState.update { it.copy(
                    phase = PlayerPhase.IDLE,
                    errorMessage = msg,
                    importStage = null,
                    importProgress = 0f,
                    importProgressMessages = msgs.toList()
                )}
            }
        }
    }

    /**
     * Poll /agent-status until the agent session becomes inactive (completed/failed).
     * Updates [msgs] with progress messages from the agent.
     * Also updates [vbookProgress] in [GenUiState] with structured data for the GPU-style panel.
     * @return true if the session was still active, false if no session was found
     */
    private suspend fun pollAgentProgress(bId: String, msgs: MutableList<String>): Boolean {
        var lastProgressMsg = ""
        var consecutiveInactive = 0
        val maxInactive = 3
        val maxPollTimeMs = 10 * 60 * 1000L // 10 min safety timeout
        val startTime = System.currentTimeMillis()

        while (consecutiveInactive < maxInactive) {
            if (System.currentTimeMillis() - startTime > maxPollTimeMs) {
                Log.w(TAG, "[POLL] safety timeout reached (${maxPollTimeMs}ms), exiting poll loop")
                break
            }
            if (consecutiveInactive > 0 || lastProgressMsg.isNotEmpty()) {
                delay(2000)
            }
            try {
                val status = _repository.getAgentStatus(bId)
                if (status.active && status.progress_msg != null) {
                    consecutiveInactive = 0
                    val currentMsg = status.progress_msg
                    if (currentMsg != lastProgressMsg) {
                        if (lastProgressMsg.isNotEmpty() && msgs.isNotEmpty() && msgs.last().startsWith("⟳")) {
                            msgs[msgs.size - 1] = msgs.last().replace("⟳", "✓")
                        }
                        msgs.add(currentMsg)
                        lastProgressMsg = currentMsg

                        if (status.window_index != null && status.created_scenes != null) {
                            val windowInfo = "📦 Окно ${status.window_index + 1}: ${status.created_scenes} сцен" +
                                if (status.total_scenes != null) " (всего найдено: ${status.total_scenes})" else ""
                            val existingWindowIdx = msgs.indexOfLast { it.startsWith("📦") }
                            if (existingWindowIdx >= 0) msgs[existingWindowIdx] = windowInfo
                            else msgs.add(windowInfo)
                        }
                        _uiState.update { it.copy(importProgressMessages = msgs.toList()) }
                    }

                    // ── Update structured VBook progress for the GPU-style panel ──
                    updateVBookProgress(status)

                } else {
                    consecutiveInactive++
                    Log.d(TAG, "[POLL] agent inactive (x$consecutiveInactive)")

                    if (status.progress_msg != null && status.progress_msg != lastProgressMsg) {
                        val finalMsg = status.progress_msg
                        Log.i(TAG, "[POLL] showing final progress msg: \"$finalMsg\"")
                        msgs.add(finalMsg)
                        lastProgressMsg = finalMsg
                        _uiState.update { it.copy(importProgressMessages = msgs.toList()) }
                    }

                    if (consecutiveInactive >= maxInactive) {
                        if (msgs.isNotEmpty() && msgs.last().startsWith("⟳")) {
                            msgs[msgs.size - 1] = msgs.last().replace("⟳", "✓")
                            _uiState.update { it.copy(importProgressMessages = msgs.toList()) }
                        }
                        // Mark VBook as completed
                        _uiState.update { it.copy(
                            vbookProgress = VBookProgress(stage = VBookStage.COMPLETED)
                        )}
                    }
                }
            } catch (e: Exception) {
                consecutiveInactive++
                Log.w(TAG, "[POLL] agent-status failed: ${e.message} (x$consecutiveInactive)")
                delay(3000)
            }
        }

        Log.i(TAG, "[POLL] agent polling finished (consecutiveInactive=$consecutiveInactive)")
        return consecutiveInactive < maxInactive
    }

    /**
     * Reset vbook progress to IDLE.
     * Called by MainActivity after the COMPLETED display cycle finishes.
     */
    fun clearVBookProgress() {
        _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.IDLE)) }
    }

    /**
     * Poll /agent-status and update [vbookProgress] in [GenUiState].
     * Designed to be called periodically from the MainActivity progress poller
     * so that subsequent windows triggered by WindowTriggerManager show progress.
     * @return the current [VBookProgress] after the poll (may be IDLE if inactive).
     */
    suspend fun checkVBookAgentStatus(): VBookProgress {
        val bid = bookId.takeIf { it.isNotBlank() } ?: return VBookProgress(stage = VBookStage.IDLE)
        return try {
            val status = _repository.getAgentStatus(bid)
            if (status.active && status.progress_msg != null) {
                updateVBookProgress(status)
            } else {
                val current = _uiState.value.vbookProgress
                // Don't reset COMPLETED — it's handled by MainActivity display cycle
                if (current != null && current.stage != VBookStage.IDLE && current.stage != VBookStage.COMPLETED) {
                    _uiState.update { it.copy(
                        vbookProgress = VBookProgress(stage = VBookStage.IDLE)
                    )}
                }
            }
            _uiState.value.vbookProgress ?: VBookProgress(stage = VBookStage.IDLE)
        } catch (_: Exception) {
            _uiState.value.vbookProgress ?: VBookProgress(stage = VBookStage.IDLE)
        }
    }

    /**
     * Parse [AgentStatusResponse] into structured [VBookProgress] and store in [GenUiState].
     * Extracts stage (ANALYZING / CREATING_SCENES), scene-within-window number,
     * and total scenes from the progress message and response fields.
     */
    private fun updateVBookProgress(status: com.example.animastor.repository.AgentStatusResponse) {
        val msg = status.progress_msg?.lowercase() ?: ""

        // Determine stage from message content
        val stage = when {
            msg.contains("анализ") ||
            msg.contains("analyzing") ||
            msg.contains("extracting") ||
            msg.contains("character") ||
            msg.contains("location") ||
            msg.contains("structure") ||
            msg.contains("персонаж") ||
            msg.contains("локац") -> VBookStage.ANALYZING

            msg.contains("сцен") ||
            msg.contains("создаю юниты") ||
            msg.contains("окно") ||
            msg.contains("scene") ||
            msg.contains("unit") ||
            msg.contains("visual") ||
            msg.contains("юнит") ||
            msg.contains("визуал") -> VBookStage.CREATING_SCENES

            else -> VBookStage.ANALYZING
        }

        // Extract global scene number from "Создаю юниты для сцены 5..."
        val sceneMatch = Regex("""сцены[\s]*?(\d+)""", RegexOption.IGNORE_CASE).find(status.progress_msg ?: "")
        val globalScene = sceneMatch?.groupValues?.get(1)?.toIntOrNull() ?: 0

        // Window-local scene index: (global - 1) % WINDOW_SIZE + 1 → 0-based
        val windowSize = 3
        val sceneInWindow = if (globalScene > 0) ((globalScene - 1) % windowSize) else 0
        val totalInWindow = if (globalScene > 0) windowSize else 0

        _uiState.update { it.copy(
            vbookProgress = VBookProgress(
                stage = stage,
                sceneIndex = sceneInWindow,
                scenesInWindow = totalInWindow,
                totalScenes = status.total_scenes ?: status.created_scenes,
                windowIndex = status.window_index ?: 0
            )
        )}
    }

    fun importText(text: String, title: String? = null, onResult: ((ImportTxtResponse) -> Unit)? = null) {
        Log.i(TAG, "importText: text=${text.length} chars title=$title")
        generationJob?.cancel()
        hasUnsavedChanges = false
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
                val bId = importRes.book_id
                persistBookId(bId)
                persistBuildId("default")

                _uiState.update { it.copy(importStage = ImportStage.ANALYZING, importProgress = 0.3f) }
                delay(200)
                _uiState.update { it.copy(importStage = ImportStage.EXTRACTING_CHARACTERS, importProgress = 0.45f) }
                delay(200)
                _uiState.update { it.copy(importStage = ImportStage.EXTRACTING_LOCATIONS, importProgress = 0.55f) }
                delay(200)
                _uiState.update { it.copy(importStage = ImportStage.CREATING_STRUCTURE, importProgress = 0.65f) }
                delay(200)
                _uiState.update { it.copy(importStage = ImportStage.CREATING_SCENES, importProgress = 0.8f) }
                delay(200)

                _repository.bootstrapBook(bId)
                val allChunks = runCatching { _repository.getAllChunks(bId) }.getOrNull()
                val chunkIds = allChunks?.chunk_ids?.toList() ?: emptyList()
                val positions = mutableMapOf<String, Pair<String?, String?>>()
                for (cid in chunkIds) {
                    runCatching {
                        _repository.getChunkStoryboard(cid).let { sb ->
                            positions[cid] = Pair(sb.chapter_id, sb.scene_id)
                        }
                    }
                }
                val firstPos = chunkIds.firstOrNull()?.let { positions[it] }
                if (firstPos != null) {
                    SharedPositionManager.navigateTo(chapterId = firstPos.first, sceneId = firstPos.second, unitIndex = 0)
                } else {
                    SharedPositionManager.navigateTo(chapterId = null, sceneId = null)
                }

                _playbackPrepared.tryEmit(PlaybackPreparation(
                    bookId = bId,
                    buildId = buildId,
                    chunkIds = chunkIds,
                    chunkPositions = positions
                ))

                _uiState.update { it.copy(
                    importStage = ImportStage.DONE,
                    importProgress = 1f,
                    phase = PlayerPhase.SCENE_READY,
                    chunkIds = chunkIds,
                )}

                onResult?.invoke(importRes)
            } catch (e: Exception) {
                Log.e(TAG, "importText failed: ${e.message}", e)
                val msg = if (e is java.io.IOException && e.message != null) e.message!! else "Import text failed: ${e.message}"
                _uiState.update { it.copy(phase = PlayerPhase.IDLE, errorMessage = msg, importStage = null, importProgress = 0f) }
            }
        }
    }


    // ═══════════════════════════════════════════════════════════════
    //  BOOK MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

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

    fun markUnsavedChanges() { hasUnsavedChanges = true }

    fun regenerateFromSnapshot() {
        startGeneration(
            req = GenerationRequest(
                profile = currentProfile(),
                scope = "whole_book",
                chapterId = null,
                sceneId = null
            ),
            onResult = {}
        )
    }

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
                _uiState.update { it.copy(
                    phase = PlayerPhase.IDLE,
                    chunkIds = emptyList(),
                    previewImage = null,
                    coverImage = null,
                    errorMessage = null
                )}
                Log.i(TAG, "Clear cache OK for $bookId")
            }.onFailure { e ->
                Log.e(TAG, "Clear cache failed: ${e.message}")
            }
        }
    }

    fun closeBook() {
        generationJob?.cancel()
        windowTriggerManager.stop()
        persistBookId("")
        persistBuildId("")
        hasUnsavedChanges = false
        _activeGeneration.value = null
        SharedPositionManager.navigateTo(chapterId = null, sceneId = null)
        _uiState.update { GenUiState() }
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

    // ── Window polling helpers (for generateFromFile) ─────────────

    private suspend fun waitWindowReady(ids: List<String>) {
        for (id in ids) {
            runCatching {
                pollWithBackoff(timeoutMs = IMAGE_POLL_TIMEOUT_MS) {
                    val chunk = _repository.getChunk(id, buildId)
                    chunk.audio_ready
                }
            }
        }
    }

    private suspend fun loadCoverBitmap(coverId: String): Bitmap? {
        return runCatching {
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
    }

    private suspend fun pollWithBackoff(timeoutMs: Long = POLL_TIMEOUT_MS, pollAction: suspend () -> Boolean) {
        var polls = 0
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val ok = runCatching { pollAction() }.getOrDefault(false)
            if (ok) return
            polls++
            val delayMs = minOf(POLL_INTERVAL_MS * (1L shl minOf(polls / 10, 4)), MAX_BACKOFF_MS)
            delay(delayMs)
        }
    }
}

// ── UI State (generation only) ───────────────────────────────────

data class GenUiState(
    val phase: PlayerPhase = PlayerPhase.IDLE,
    val chunkIds: List<String> = emptyList(),
    val previewImage: Bitmap? = null,
    val coverImage: Bitmap? = null,
    val errorMessage: String? = null,
    val mode: String = "full",
    val importStage: ImportStage? = null,
    val importProgress: Float = 0f,
    val importProgressMessages: List<String> = emptyList(),
    /** Structured VBook agent progress for the GPU-style panel */
    val vbookProgress: VBookProgress? = null
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

/**
 * Structured progress for the VBook/AI agent pipeline.
 * Displayed as a row in the GPU progress panel (alongside audio/image/video workers).
 */
data class VBookProgress(
    val stage: VBookStage = VBookStage.IDLE,
    /** 0-based scene index within the current window (e.g. 0, 1, 2) */
    val sceneIndex: Int = 0,
    /** Total scenes in the current window (typically 3) */
    val scenesInWindow: Int = 0,
    /** Total scenes found so far across all windows (can grow) */
    val totalScenes: Int? = null,
    /** Current window index (0-based) */
    val windowIndex: Int = 0
)

enum class VBookStage {
    /** No import in progress */
    IDLE,
    /** AI is analyzing text, extracting characters/locations */
    ANALYZING,
    /** AI is creating scenes and writing units */
    CREATING_SCENES,
    /** All windows processed */
    COMPLETED
}

// ── Shared data types ────────────────────────────────────────────

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
    val iuSequence: List<IuImageItem>,
    val hasVideo: Boolean = false
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PreloadedScene) return false
        return audioBytes.contentEquals(other.audioBytes) &&
               videoBytes.contentEquals(other.videoBytes) &&
               iuSequence == other.iuSequence &&
               hasVideo == other.hasVideo
    }
    override fun hashCode(): Int {
        var result = audioBytes.contentHashCode()
        result = 31 * result + (videoBytes?.contentHashCode() ?: 0)
        result = 31 * result + iuSequence.hashCode()
        result = 31 * result + if (hasVideo) 1 else 0
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
