package com.example.animastor.ui

import android.app.Application
import android.graphics.Bitmap
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.CreationExtras
import com.example.animastor.network.ProgressStream
import com.example.animastor.network.RetrofitClient
import com.example.animastor.repository.AssetsStateResponse
import com.example.animastor.repository.DiffSummary
import java.util.concurrent.ConcurrentHashMap
import com.example.animastor.repository.DirtyScene
import com.example.animastor.repository.ImportTxtResponse
import com.example.animastor.repository.LayerConfigUpdate
import com.example.animastor.repository.ReorderChapter
import com.example.animastor.repository.Repository
import com.example.animastor.repository.SceneRef
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
     * Emitted when new scenes are ready for playback (from book JSON order).
     * The activity coordinator observes this and calls [PlaybackViewModel.preparePlayback].
     */
    data class PlaybackPreparation(
        val bookId: String,
        val buildId: String,
        val scenes: List<SceneRef>,
        val coverImage: Bitmap? = null,
        val softRefresh: Boolean = false
    )

    private val _playbackPrepared = MutableSharedFlow<PlaybackPreparation>(replay = 1, extraBufferCapacity = 4)
    val playbackPrepared: SharedFlow<PlaybackPreparation> = _playbackPrepared.asSharedFlow()


    // ── Elapsed timer (client-side) ──────────────────────────────

    /**
     * Wall-clock start timestamp (ms). 0 = not running.
     * MainActivity timer loop reads this directly — no coroutine/StateFlow.
     * When stopped (timerStartedAt == -1L), check [finalElapsedSeconds].
     */
    @Volatile
    var timerStartedAt: Long = 0L
        private set

    /** Final elapsed seconds when timer was stopped (0L if never stopped). */
    @Volatile
    var finalElapsedSeconds: Long = 0L
        private set

    /** Start the timer — records wall-clock timestamp. */
    private fun startTimer() {
        timerStartedAt = System.currentTimeMillis()
        finalElapsedSeconds = 0L
    }

    /** Stop the timer — preserves final elapsed value, sets state to stopped (-1). */
    private fun stopTimer() {
        if (timerStartedAt > 0L) {
            finalElapsedSeconds = (System.currentTimeMillis() - timerStartedAt) / 1000L
        }
        timerStartedAt = -1L  // -1 = stopped, finalElapsedSeconds holds the final value
    }

    // ═══════════════════════════════════════════════════════════════
    //  GENERATION STATUS (bottom nav icon indicator)
    // ═══════════════════════════════════════════════════════════════

    private val _generationStatus = MutableStateFlow(GenerationStatus.IDLE)
    val generationStatus: StateFlow<GenerationStatus> = _generationStatus.asStateFlow()

    /**
     * Reset generation status to IDLE (called when user opens Generate screen).
     */
    fun resetGenerationStatus() {
        _generationStatus.value = GenerationStatus.IDLE
    }

    // ── UI State (generation/import related only) ─────────────────

    private val _uiState = MutableStateFlow(GenUiState())
    val uiState: StateFlow<GenUiState> = _uiState.asStateFlow()

    var bookId: String = ""
        private set
    var buildId: String = ""
        private set

    @Volatile private var _firstWindowDone = false

    /** Set true when SSE import_complete event arrives (F10). */
    @Volatile private var _importCompleteReceived = false

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
    fun vbookEnabled(): Boolean = true // VBook is always enabled
    // Profile is computed server-side (resolveProfile) and cached in _layerProfile.
    // The client never re-derives it from the toggles.
    fun currentProfile(): String = _layerProfile.value
    fun hasAssets(): Boolean = _hasAssets.value

    fun setAudioEnabled(enabled: Boolean) {
        _audioEnabled.value = enabled
        viewModelScope.launch { persistLayerConfig() }
    }

    fun setVideoEnabled(enabled: Boolean) {
        _videoEnabled.value = enabled
        viewModelScope.launch { persistLayerConfig() }
    }

    /** VBook is always enabled — kept for interface consistency. */
    fun setVBookEnabled(@Suppress("UNUSED_PARAMETER") enabled: Boolean) {
        // VBook agent is always active; this is a no-op for consistency
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
                // Profile is authoritative from the server; keep prior value if absent.
                cfg.profile?.let { _layerProfile.value = it }
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
            cfg.profile?.let { _layerProfile.value = it }
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
        if (bookId.isBlank()) {
            onResult(GenerationResult.Failed("No book"))
            return
        }
        _generationStatus.value = GenerationStatus.RUNNING
        // Allow starting new generation even if one is already running.
        // The previous generation job will be cancelled, and the new one
        // replaces it. Per-worker stop buttons on the backend handle granular cancellation.
        _isRegenerating.value = true
        _activeGeneration.value = ActiveGeneration(
            scope = req.scope,
            chapterId = req.chapterId,
            sceneId = req.sceneId
        )
        startTimer()  // 🕐 таймер стартует сразу, до API-вызова
        generationJob?.cancel()
        generationJob = viewModelScope.launch {
            // Preserve VBook progress and import messages when GPU generation starts
            // while VBook (AI agent) is still processing text windows.
            val prevVBook = _uiState.value.vbookProgress
            val prevImportMsgs = _uiState.value.importProgressMessages
            _uiState.update { it.copy(
                phase = PlayerPhase.GENERATING,
                vbookProgress = prevVBook,
                importProgressMessages = prevImportMsgs
            )}
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
                // таймер уже запущен при входе в startGeneration
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
                    _generationStatus.value = GenerationStatus.ERROR
                    _uiState.update {
                        it.copy(phase = PlayerPhase.SCENE_READY, errorMessage = "Generation failed: ${e.message}")
                    }
                    onResult(GenerationResult.Failed(e.message ?: "unknown"))
                    _activeGeneration.value = null
                }
                stopTimer()  // 🕐 ошибка — останавливаем таймер
            }
        }
    }

    /**
     * Apply whatever generation results are available — refreshes the player
     * with the latest scenes so the user hears newly generated content.
     *
     * Builds scene list from book JSON (the canonical source of truth),
     * not from chunk metadata. TTS pipeline is decoupled from playback.
     *
     * Called when:
     *   - All workers complete successfully (DoneRow cycle expires)
     *   - Generation is cancelled but some content was generated
     *   - Progress is stuck and deemed complete (backend idle, no progress)
     */
    fun applyGenerationResults() {
        if (_isRegenerating.value) {
            _isRegenerating.value = false
        }
        _activeGeneration.value = null
        stopTimer()  // 🕐 генерация завершена — останавливаем таймер

        viewModelScope.launch {
            // Build scene list from book JSON
            val scenes = mutableListOf<SceneRef>()
            var coverChapterId: String? = null
            var coverSceneId: String? = null
            val bookData = runCatching { _repository.getBook(bookId) }.getOrNull()
            if (bookData != null) {
                for (ch in bookData.chapters.orEmpty()) {
                    for (sc in ch.scenes.orEmpty()) {
                        val sr = SceneRef(ch.chapter, sc.scene_id, sc.type)
                        if (sc.type == "cover") {
                            coverChapterId = ch.chapter
                            coverSceneId = sc.scene_id
                        }
                        scenes.add(sr)
                    }
                }
            }
            if (scenes.isEmpty()) {
                Log.w(TAG, "applyGenerationResults: book has 0 scenes — skipping playback refresh")
                return@launch
            }

            // Load cover image for first scene
            var cover: Bitmap? = null
            val coverRef = if (coverChapterId != null) {
                SceneRef(coverChapterId, coverSceneId!!, "cover")
            } else scenes.first()
            if (imageEnabled) {
                cover = loadCoverBitmap(coverRef.chapterId, coverRef.sceneId)
                if (cover == null) {
                    for (retry in 1..5) {
                        delay((1000L shl minOf(retry, 3)).coerceAtMost(5000))
                        Log.i(TAG, "applyGenerationResults: retry $retry loading cover")
                        cover = loadCoverBitmap(coverRef.chapterId, coverRef.sceneId)
                        if (cover != null) break
                    }
                }
            }

            Log.i(TAG, "applyGenerationResults: emitting playbackPrepared (softRefresh) with ${scenes.size} scenes cover=${cover != null}")
            _playbackPrepared.tryEmit(PlaybackPreparation(
                bookId = bookId,
                buildId = buildId,
                scenes = scenes,
                coverImage = cover,
                softRefresh = true
            ))
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  VBOOK GENERATION (AI agent bootstrap, not GPU)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Start VBook AI agent generation. Calls bootstrap or resume on the
     * backend and shows real-time progress via SSE + polling.
     * This is NOT GPU generation — it creates/updates the book structure.
     */
    fun startVBookGeneration() {
        val bid = bookId.takeIf { it.isNotBlank() } ?: return
        Log.i(TAG, "startVBookGeneration: $bid")
        _generationStatus.value = GenerationStatus.RUNNING

        _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.ANALYZING)) }
        startTimer()
        startProgressStream(bid)
        _importCompleteReceived = false

        generationJob?.cancel()
        generationJob = viewModelScope.launch {
            runCatching {
                val status = runCatching { _repository.getLazyBookStatus(bid) }.getOrNull()
                val needsBootstrap = status?.ready != true
                if (needsBootstrap) {
                    Log.i(TAG, "startVBookGeneration: calling bootstrapBook")
                    _repository.bootstrapBook(bid)
                } else {
                    Log.i(TAG, "startVBookGeneration: calling bootstrapNextWindow")
                    _repository.bootstrapNextWindow(bid)
                }
            }.onSuccess {
                pollVBookProgress(bid)
            }.onFailure { e ->
                Log.w(TAG, "startVBookGeneration failed: ${e.message}")
                _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.IDLE)) }
                stopTimer()
            }
        }
    }

    /**
     * Poll /agent-status until the VBook agent completes.
     * Updates [vbookProgress] for the Generate screen progress display.
     * Exits early when SSE import_complete event arrives.
     */
    private suspend fun pollVBookProgress(bId: String) {
        var consecutiveInactive = 0
        val maxInactive = 2
        val maxPollTimeMs = 5 * 60 * 1000L
        val startTime = System.currentTimeMillis()

        while (consecutiveInactive < maxInactive) {
            if (_importCompleteReceived) {
                Log.i(TAG, "[VBookPoll] import_complete SSE received — marking completed")
                _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.COMPLETED)) }
                break
            }
            if (System.currentTimeMillis() - startTime > maxPollTimeMs) {
                Log.w(TAG, "[VBookPoll] safety timeout (${maxPollTimeMs}ms)")
                break
            }
            delay(2000)
            try {
                val status = _repository.getAgentStatus(bId)

                if (status.active && status.progress_msg != null) {
                    consecutiveInactive = 0
                    updateVBookProgress(status)
                } else if (!status.active) {
                    consecutiveInactive++
                    if (status.progress_msg != null) {
                        updateVBookProgress(status)
                    }
                    if (consecutiveInactive >= maxInactive) {
                        _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.COMPLETED)) }
                    }
                } else {
                    // active=true but no message — agent between steps
                    consecutiveInactive = 0
                }
            } catch (e: Exception) {
                consecutiveInactive++
                Log.w(TAG, "[VBookPoll] failed: ${e.message} (x$consecutiveInactive)")
                delay(3000)
            }
        }

        _generationStatus.value = GenerationStatus.SUCCESS
        stopTimer()
        Log.i(TAG, "[VBookPoll] done — refreshing player with new scenes")
        applyGenerationResults()
    }

    fun cancelGeneration() {
        Log.i(TAG, "cancelGeneration: $bookId")
        if (bookId.isBlank()) return
        _generationStatus.value = GenerationStatus.IDLE
        stopTimer()  // 🕐 отмена — останавливаем таймер
        stopProgressStream()  // ❄ закрываем SSE канал
        resetWorkerState()
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

            // Refresh player with whatever content was generated so far.
            // Even if some layers failed or the user cancelled mid-generation,
            // any successfully generated content should be playable immediately
            // instead of the player staying on stale cache.
            if (hasAnyProgress()) {
                Log.i(TAG, "cancelGeneration: content was generated — refreshing player")
                applyGenerationResults()
            } else {
                Log.i(TAG, "cancelGeneration: no content generated — skipping player refresh")
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  UNIFIED IMPORT (F14) — server-side format detection
    // ═══════════════════════════════════════════════════════════════

    fun importBookFromFile(file: File) {
        Log.i(TAG, "importBookFromFile: ${file.name}")
        // Сброс worker tracking и vbook прогресса от предыдущей сессии,
        // чтобы избежать двух прогресс-баров при повторном открытии.
        resetWorkerState()
        _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.IDLE)) }
        generationJob?.cancel()
        hasUnsavedChanges = false
        _activeGeneration.value = null
        _dirtySummary.value = null
        _dirtyScenes.value = emptyList()
        _isRegenerating.value = false
        _importCompleteReceived = false

        generationJob = viewModelScope.launch {
            try {
                _uiState.update { it.copy(phase = PlayerPhase.LOADING_BOOK, errorMessage = null) }

                val importRes = _repository.importBook(file)
                val bId = importRes.book_id
                persistBookId(bId)

                when (importRes.format) {
                    "vbook" -> {
                        // ── VBOOK path ──
                        persistBuildId(importRes.build_id ?: "")
                        runCatching { _repository.snapshotBook(bId) }

                        // Build scene list from book JSON
                        val bookData = runCatching { _repository.getBook(bId) }.getOrNull()
                        val scenes = mutableListOf<SceneRef>()
                        var coverScene: SceneRef? = null
                        if (bookData != null) {
                            for (ch in bookData.chapters.orEmpty()) {
                                for (sc in ch.scenes.orEmpty()) {
                                    val sr = SceneRef(ch.chapter, sc.scene_id, sc.type)
                                    if (sc.type == "cover") coverScene = sr
                                    scenes.add(sr)
                                }
                            }
                        }

                        val firstScene = coverScene ?: scenes.firstOrNull()
                        if (firstScene != null) {
                            SharedPositionManager.navigateTo(
                                chapterId = firstScene.chapterId,
                                sceneId = firstScene.sceneId,
                                unitIndex = 0
                            )
                        } else {
                            SharedPositionManager.navigateTo(chapterId = null, sceneId = null)
                        }

                        _uiState.update {
                            it.copy(
                                phase = PlayerPhase.DOWNLOADING,
                                previewImage = null,
                                coverImage = null,
                                errorMessage = null
                            )
                        }

                        val coverRef = coverScene ?: scenes.firstOrNull()
                        val cover = if (coverRef != null && imageEnabled) {
                            loadCoverBitmap(coverRef.chapterId, coverRef.sceneId)
                        } else null

                        _playbackPrepared.tryEmit(PlaybackPreparation(
                            bookId = bId,
                            buildId = buildId,
                            scenes = scenes,
                            coverImage = cover
                        ))

                        _uiState.update { it.copy(phase = if (scenes.isNotEmpty()) PlayerPhase.SCENE_READY else PlayerPhase.IDLE) }
                    }
                    "txt" -> {
                        // ── TXT path (SIMPLIFIED: import only, no auto-generation) ──
                        // build_id is owned by the backend (resolved from manifest.json).
                        // The thin client just stores whatever the import response carries.
                        persistBuildId(importRes.build_id ?: "")

                        _uiState.update { it.copy(
                            phase = PlayerPhase.IMPORTING_TXT,
                            importStage = ImportStage.VALIDATING,
                            importProgress = 0.1f,
                            importProgressMessages = listOf(
                                "✓ File selected",
                                "✓ TXT read",
                                "✓ Encoding detected",
                                "✓ VBook structure created"
                            )
                        )}

                        // Build scene list from book JSON for navigation
                        val bookForNav = runCatching { _repository.getBook(bId) }.getOrNull()
                        val scenesFromTxt = mutableListOf<SceneRef>()
                        if (bookForNav != null) {
                            for (ch in bookForNav.chapters.orEmpty()) {
                                for (sc in ch.scenes.orEmpty()) {
                                    scenesFromTxt.add(SceneRef(ch.chapter, sc.scene_id, sc.type))
                                }
                            }
                        }

                        // Navigate to first scene from book JSON
                        val firstChapter = bookForNav?.chapters?.firstOrNull()
                        val firstScene = firstChapter?.scenes?.firstOrNull()
                        if (firstChapter != null && firstScene != null) {
                            SharedPositionManager.navigateTo(
                                chapterId = firstChapter.chapter,
                                sceneId = firstScene.scene_id,
                                unitIndex = 0
                            )
                        } else {
                            SharedPositionManager.navigateTo(chapterId = null, sceneId = null)
                        }

                        _playbackPrepared.tryEmit(PlaybackPreparation(
                            bookId = bId,
                            buildId = buildId,
                            scenes = scenesFromTxt
                        ))

                        _uiState.update { it.copy(
                            importStage = ImportStage.DONE,
                            importProgress = 1f,
                            vbookProgress = VBookProgress(stage = VBookStage.IDLE),
                            phase = if (scenesFromTxt.isNotEmpty()) PlayerPhase.SCENE_READY else PlayerPhase.IDLE,
                        )}
                        Log.i(TAG, "importBookFromFile (txt): ready with ${scenesFromTxt.size} scenes")
                    }
                    else -> {
                        throw java.io.IOException("Unknown file format: ${importRes.format}")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "importBookFromFile failed: ${e.message}", e)
                val msg = if (e is java.io.IOException && e.message != null) e.message!! else "Import failed: ${e.message}"
                _uiState.update { it.copy(phase = PlayerPhase.IDLE, errorMessage = msg) }
                stopTimer()  // 🕐 ошибка импорта — останавливаем таймер
            }
        }
    }

    /**
     * Poll /agent-status until the agent session becomes inactive (completed/failed).
     * Updates [msgs] with progress messages. Updates [vbookProgress] for GPU panel.
     *
     * Exits early when [importCompleteReceived] is set by the SSE import_complete event (F10).
     * Primary completion signal is the SSE event — polling is a fallback.
     *
     * @return true if the session was still active, false if no session was found
     */
    private suspend fun pollAgentProgress(bId: String, msgs: MutableList<String>, initialLastMsg: String = ""): Boolean {
        var lastProgressMsg = initialLastMsg
        var consecutiveInactive = 0
        val maxInactive = 2
        val maxPollTimeMs = 5 * 60 * 1000L // 5 min safety timeout
        val startTime = System.currentTimeMillis()

        while (consecutiveInactive < maxInactive) {
            if (_importCompleteReceived) {
                Log.i(TAG, "[POLL] import_complete SSE received — exiting early")
                // Backend reported all windows done via SSE, but we still need
                // to mark VBook as completed since poller owns that transition.
                _uiState.update { it.copy(
                    vbookProgress = VBookProgress(stage = VBookStage.COMPLETED)
                )}
                break
            }
            if (System.currentTimeMillis() - startTime > maxPollTimeMs) {
                Log.w(TAG, "[POLL] safety timeout reached (${maxPollTimeMs}ms), exiting poll loop")
                break
            }
            delay(2000)
            try {
                val status = _repository.getAgentStatus(bId)
                if (status.active && status.progress_msg != null) {
                    // Agent actively running with a message — reset inactivity counter
                    consecutiveInactive = 0
                    val currentMsg = status.progress_msg
                    if (currentMsg != lastProgressMsg) {
                        _uiState.update { state ->
                            state.copy(importProgressMessages = state.importProgressMessages + currentMsg)
                        }
                        msgs.add(currentMsg)
                        lastProgressMsg = currentMsg
                    }
                    updateVBookProgress(status)
                } else if (!status.active) {
                    // Agent truly inactive — count consecutively, transition to COMPLETED
                    consecutiveInactive++
                    if (status.progress_msg != null && status.progress_msg != lastProgressMsg) {
                        val currentMsg = status.progress_msg
                        _uiState.update { state ->
                            state.copy(importProgressMessages = state.importProgressMessages + currentMsg)
                        }
                        msgs.add(currentMsg)
                        lastProgressMsg = currentMsg
                        updateVBookProgress(status)
                    }
                    if (consecutiveInactive >= maxInactive) {
                        _uiState.update { it.copy(
                            vbookProgress = VBookProgress(stage = VBookStage.COMPLETED)
                        )}
                    }
                } else {
                    // active=true but progress_msg=null — agent between steps, don't count as inactive
                    consecutiveInactive = 0
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
     * @return the current [VBookProgress] after the poll (may be IDLE if inactive).
     */
    suspend fun checkVBookAgentStatus(): VBookProgress {
        val bid = bookId.takeIf { it.isNotBlank() } ?: return VBookProgress(stage = VBookStage.IDLE)
        return try {
            val status = _repository.getAgentStatus(bid)
            if (status.active && status.progress_msg != null) {
                // ── Update the GPU-style progress panel (no chat messages for subsequent windows) ──
                updateVBookProgress(status)
            } else if (!status.active) {
                val current = _uiState.value.vbookProgress
                if (current != null) {
                    when (current.stage) {
                        VBookStage.ANALYZING, VBookStage.CREATING_SCENES -> {
                            // Agent just finished, transition to COMPLETED
                            _uiState.update { it.copy(
                                vbookProgress = VBookProgress(stage = VBookStage.COMPLETED)
                            )}
                        }
                        VBookStage.COMPLETED -> { /* keep */ }
                        VBookStage.IDLE -> { /* keep idle */ }
                    }
                }
            }
            // active=true but progress_msg=null → agent between steps, keep current VBookProgress
            _uiState.value.vbookProgress ?: VBookProgress(stage = VBookStage.IDLE)
        } catch (_: Exception) {
            _uiState.value.vbookProgress ?: VBookProgress(stage = VBookStage.IDLE)
        }
    }

    /**
     * Parse [AgentStatusResponse] into structured [VBookProgress] and store in [GenUiState].
     * Uses server-provided window counters directly — no regex-based Russian text parsing.
     *
     * Stage is determined by [status.step_type] — a language-independent machine label
     * from the backend (e.g. "create_scenes", "polish_storyboard").
     *
     * window_scene_index is always null from agent-status endpoint (set null by
     * buildWindowProgressMeta), so window-relative index is computed from
     * cumulative created_scenes and window_start_scene when both are available.
     * Early stages (extracting_chars, analyzing) have no counters → cyclic display.
     */
    private fun updateVBookProgress(status: com.example.animastor.repository.AgentStatusResponse) {
        val stage = when (status.step_type) {
            // Scene-unit steps — show scene counter (x/y).
            // "create_scenes" is excluded because AI hasn't determined
            // the exact scene count yet — the counter would be unreliable.
            "create_units", "create_visual_prompts" ->
                VBookStage.CREATING_SCENES
            // All other steps (analysis, enrichment, post-processing) — cyclic
            else ->
                VBookStage.ANALYZING
        }

        val windowTotal = (status.window_total_scenes ?: status.window_size ?: 1).coerceAtLeast(1)

        // Compute window-relative scene index from cumulative created_scenes and
        // window_start_scene. window_scene_index is always null from this endpoint.
        val windowSceneIndex = when {
            status.window_scene_index != null -> status.window_scene_index
            status.created_scenes != null && status.window_start_scene != null ->
                (status.created_scenes - status.window_start_scene + 1).coerceAtLeast(1)
            else -> null
        }

        // Preserve existing sceneIndex from SSE when agent-status can't provide one.
        // The agent-status endpoint always returns window_scene_index=null, so we
        // rely on the fallback computation. If that also fails (e.g. window_data
        // not yet saved), keep the SSE-set value rather than resetting to -1.
        val fallbackIdx = _uiState.value.vbookProgress?.sceneIndex ?: -1
        val sceneIndex = windowSceneIndex
            ?.let { (it - 1).coerceIn(0, windowTotal - 1) }
            ?: if (fallbackIdx >= 0) fallbackIdx else -1
        val total = status.created_scenes ?: status.total_scenes

        val messageText = status.progress_msg?.takeIf { it.isNotBlank() }

        _uiState.update { it.copy(
            vbookProgress = VBookProgress(
                stage = stage,
                sceneIndex = sceneIndex,
                scenesInWindow = windowTotal,
                totalScenes = total,
                windowIndex = status.window_index ?: 0,
                message = messageText
            )
        )}
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
        _generationStatus.value = GenerationStatus.IDLE
        stopTimer()  // 🕐 закрыли книгу — сбрасываем таймер
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

    private suspend fun loadCoverBitmap(chapterId: String?, sceneId: String?): Bitmap? {
        val chId = chapterId ?: return null
        val scId = sceneId ?: return null
        return runCatching {
            val sb = _repository.getSceneStoryboard(bookId, chId, scId, buildId)
            if (sb.ius.isNotEmpty()) {
                val iu = sb.ius.first()
                val imgBytes = _repository.getIuImage(
                    bookId,
                    chId,
                    scId,
                    iu.unit_id,
                    buildId
                )
                MediaDecoder.decodeBitmap(imgBytes)
            } else null
        }.getOrElse {
            Log.w(TAG, "loadCoverBitmap: failed for $chapterId/$sceneId")
            null
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  WORKER PROGRESS PANEL (moved from MainActivity in F2)
    // ═══════════════════════════════════════════════════════════════

    private val COMPLETED_WORKER_DISPLAY_MS = 10_000L

    /** Floor per worker type — prevents progress rollback. Thread-safe (ConcurrentHashMap). */
    private val workerReadyFloor = ConcurrentHashMap<String, Int>()

    /** Track when each worker type completed (to show green "Done" for 10s). */
    private val workerCompletedAt = mutableMapOf<String, Long>()

    /** Workers that have completed their 10s display cycle and must not reappear. */
    private val _workerPermanentlyDone = mutableSetOf<String>()

    private var _coverEverIncomplete = false

    /** Timestamp when the last worker completed and "Done" row started showing. */
    private var gpuProgressDoneAt = 0L

    /**
     * SSE push client for real-time GPU + VBook progress.
     * Started/stopped by [startProgressStream] / [stopProgressStream].
     */
    private val progressStream: ProgressStream by lazy {
        ProgressStream(viewModelScope).apply {
            onProgressEvent = { event ->
                if (event.type == "vbook" || event.isVBook()) {
                    // VBook progress via SSE — update VBookProgress directly
                    val stage = when (event.vbookStage) {
                        // Only show scene counter on unit-stage SSE events.
                        // "creating_scenes" has no window_scene_index yet.
                        "creating_units", "creating_visuals" -> VBookStage.CREATING_SCENES
                        else -> VBookStage.ANALYZING
                    }
                    // Use server-provided fields directly. The backend sends
                    // window_scene_index for scene-level progress and all window
                    // counters. Early stages (extracting_chars, analyzing) have
                    // null window_* fields → sceneIndex=-1 (cyclic/indeterminate).
                    val windowTotal = (event.vbookWindowTotalScenes ?: event.window_size ?: 1).coerceAtLeast(1)
                    val sceneIdx = event.vbookWindowSceneIndex
                        ?.let { (it - 1).coerceIn(0, windowTotal - 1) }
                        ?: -1
                    val totalScenes = (event.vbookTotalScenes ?: event.vbookSceneIndex ?: 1).coerceAtLeast(1)
                    val vbookMsg = event.vbookMessage?.takeIf { it.isNotBlank() }
                    _uiState.update { it.copy(
                        vbookProgress = VBookProgress(
                            stage = stage,
                            sceneIndex = sceneIdx,
                            scenesInWindow = windowTotal,
                            totalScenes = totalScenes,
                            windowIndex = 0,
                            message = vbookMsg
                        )
                    )}
                    // SSE only updates GPU panel. Chat messages come from pollAgentProgress
                    // using the same msgs.add + copy(toList) pattern as status messages.
                } else if (event.type == "generation_complete") {
                    // F11: Server-pushed terminal event — stop progress stream
                    // and trigger playback refresh immediately, replacing the
                    // 120s stuck heuristic that was on the client.
                    Log.i(TAG, "SSE generation_complete received — applying results")
                    _generationStatus.value = GenerationStatus.SUCCESS
                    stopProgressStream()
                    applyGenerationResults()
                } else if (event.type == "import_complete") {
                    // F10: Server-pushed terminal event — all agent windows
                    // processed. The pollAgentProgress loop will exit on next
                    // check when it sees consecutiveInactive >= maxInactive.
                    // Set a flag so the next poll iteration finishes quickly.
                    Log.i(TAG, "SSE import_complete received — stopping agent poll")
                    _importCompleteReceived = true
                } else if (event.layer == "image" && event.ready != null) {
                    val floor = maxOf(workerReadyFloor["image"] ?: 0, event.ready)
                    workerReadyFloor["image"] = floor
                }
            }
        }
    }

    /** Start the SSE push channel for the given [bookId]. Also starts VBook SSE. */
    fun startProgressStream(bookId: String) {
        progressStream.start(bookId)
    }

    /** Start SSE specifically for VBook progress (separate start to allow VBook-only SSE). */
    fun startVBookProgressStream(bookId: String) {
        progressStream.start(bookId)
    }

    /** Stop the SSE push channel and cancel reconnection. */
    fun stopProgressStream() {
        progressStream.cancel()
    }

    /**
     * Cancel a specific worker type via the backend cancel-worker API.
     * The backend handles per-type cancellation (leases, counters, GPU hub).
     * The frontend just tells the backend what to cancel.
     */
    fun cancelWorker(type: String) {
        Log.i(TAG, "cancelWorker: type=$type bookId=$bookId")
        if (bookId.isBlank()) return

        // If VBook was cancelled, clear its progress immediately
        if (type == "vbook") {
            _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.IDLE)) }
        }

        // Do NOT add non-vbook types to _workerPermanentlyDone here.
        // The backend will return cancelled:true on the next progress-panel poll,
        // and addFromServer + renderWorkersToSections will show the red "Stopped"
        // row until the cancellation propagates to GPU hub and the worker
        // disappears from subsequent panel responses.

        // Call backend per-worker cancel API — backend marks cancelled in Redis
        // and clears leases for that stage. GPU hub queue is NOT cleared for
        // per-worker cancel to avoid disrupting other workers (backend handles this).
        viewModelScope.launch {
            runCatching {
                _repository.cancelWorker(bookId, type)
            }.onSuccess {
                Log.i(TAG, "cancelWorker: backend cancelled type=$type successfully")
            }.onFailure { e ->
                Log.w(TAG, "cancelWorker: backend call failed: ${e.message}")
            }
        }
    }

    /**
     * Reset all worker tracking state for a new generation session.
     * Call when new GPU generation or VBook work is detected.
     */
    fun resetWorkerState() {
        // НЕ останавливаем таймер — он живёт от startGeneration до applyGenerationResults/cancel.
        // resetWorkerState вызывается poller'ом при детекте новой генерации,
        // и стоп таймера здесь убил бы только что запущенный startTimer().
        workerCompletedAt.clear()
        _workerPermanentlyDone.clear()
        _coverEverIncomplete = false
        gpuProgressDoneAt = 0L
        workerReadyFloor.clear()
    }

    /**
     * Check if any content was generated during the current generation session.
     * Used to decide whether to refresh the player after cancel or partial failure.
     * Returns true if any worker type has ever had non-zero progress.
     */
    private fun hasAnyProgress(): Boolean {
        return workerReadyFloor.values.any { it > 0 } ||
            workerCompletedAt.isNotEmpty() ||
            _workerPermanentlyDone.isNotEmpty()
    }

    /**
     * Build the progress panel state from server-computed worker list + local VBook.
     * Server provides ready/total/percent/done/visible for each GPU worker.
     * Client keeps: 10s "Done" row timing, monotonic floor, VBook progress rendering.
     */
    fun computeWorkers(
        panel: com.example.animastor.repository.ProgressPanelResponse?,
        vbookProgress: VBookProgress?,
        labels: WorkerLabels
    ): ProgressPanelState {
        val now = System.currentTimeMillis()
        val workers = mutableListOf<WorkerUi>()

        fun addFromServer(
            type: String,
            label: String,
            serverReady: Int,
            serverTotal: Int,
            serverDone: Boolean,
            serverPct: Int,
            serverIndeterminate: Boolean,
            countText: String? = null,
            cancelled: Boolean = false
        ) {
            if (serverTotal <= 0) return
            if (type in _workerPermanentlyDone) return
            // Monotonic floor (client UI policy)
            val r = maxOf(serverReady, workerReadyFloor[type] ?: 0)
            workerReadyFloor[type] = r
            val done = serverDone || (r >= serverTotal && r > 0)
            if (done && !cancelled) {
                if (!workerCompletedAt.containsKey(type)) {
                    workerCompletedAt[type] = now
                }
                val completedAt = workerCompletedAt[type] ?: now
                if (now - completedAt >= COMPLETED_WORKER_DISPLAY_MS) {
                    _workerPermanentlyDone.add(type)
                    workerCompletedAt.remove(type)
                    return
                }
            }
            val pct = if (done) 100 else serverPct.coerceIn(0, 99)
            workers.add(WorkerUi(type, label, r, serverTotal, pct, done, countText = countText, indeterminate = serverIndeterminate, cancelled = cancelled))
        }

        // ── GPU workers (from server progress-panel) ──
        if (panel != null) {
            for (sw in panel.workers) {
                if (!sw.visible) continue
                val label = when (sw.type) {
                    "cover" -> labels.cover
                    "audio" -> labels.audio
                    "image" -> labels.image
                    "video" -> labels.video
                    else -> sw.type
                }
                // Pass server cancelled flag — backend now owns cancellation state
                addFromServer(sw.type, label, sw.ready, sw.total, sw.done, sw.percent, sw.indeterminate, cancelled = sw.cancelled)
            }
        }

        // ── VBook worker (local state) ──
        if (vbookProgress != null && vbookProgress.stage != VBookStage.IDLE) {
            if (vbookProgress.stage == VBookStage.COMPLETED) {
                val completedAt = workerCompletedAt.getOrPut("vbook") { now }
                if (now - completedAt < COMPLETED_WORKER_DISPLAY_MS && "vbook" !in _workerPermanentlyDone) {
                    workers.add(WorkerUi("vbook", labels.vbookLabel, 1, 1, 100, done = true))
                } else {
                    _workerPermanentlyDone.add("vbook")
                    workerCompletedAt.remove("vbook")
                }
            } else {
                val stageMsg = vbookProgress.message?.takeIf { it.isNotBlank() }
                val label = stageMsg ?: labels.vbookLabel
                val ready: Int; val totalVBook: Int; val pctVBook: Int; val countText: String; val indeterminate: Boolean
                when (vbookProgress.stage) {
                    VBookStage.ANALYZING -> {
                        ready = 0; totalVBook = 1; pctVBook = 0
                        countText = ""; indeterminate = true
                    }
                    VBookStage.CREATING_SCENES -> {
                        totalVBook = vbookProgress.scenesInWindow.coerceAtLeast(1)
                        ready = (vbookProgress.sceneIndex + 1).coerceIn(0, totalVBook)
                        pctVBook = if (ready >= totalVBook) 100 else (ready * 100 / totalVBook).coerceIn(0, 99)
                        countText = labels.vbookScenesFormat(ready, totalVBook)
                        indeterminate = false
                    }
                    else -> {
                        ready = 0; totalVBook = 1; pctVBook = 0
                        countText = ""; indeterminate = true
                    }
                }
                workers.add(WorkerUi("vbook", label, ready, totalVBook, pctVBook, done = false, countText = countText, indeterminate = indeterminate))
            }
        }

        // ── Recently completed workers (still within 10s display window) ──
        val activeTypes = workers.map { it.type }.toSet()
        val staleTypes = mutableListOf<String>()
        for ((type, completedAt) in workerCompletedAt) {
            if (type in _workerPermanentlyDone) continue
            if (now - completedAt >= COMPLETED_WORKER_DISPLAY_MS) {
                staleTypes.add(type)
                _workerPermanentlyDone.add(type)
                continue
            }
            if (type in activeTypes) continue
            val label = when (type) {
                "cover" -> labels.cover; "audio" -> labels.audio
                "image" -> labels.image; "video" -> labels.video
                "vbook" -> labels.vbookLabel
                else -> labels.generationDone
            }
            workers.add(WorkerUi(type, label, 100, 100, 100, done = true))
        }
        staleTypes.forEach { workerCompletedAt.remove(it) }

        // ── Decide panel state ──
        if (workers.isEmpty()) {
            if (gpuProgressDoneAt == 0L && workerCompletedAt.isEmpty() && _workerPermanentlyDone.isEmpty()) {
                return ProgressPanelState.Hidden
            }
            if (gpuProgressDoneAt == 0L) gpuProgressDoneAt = now
            val elapsed = now - gpuProgressDoneAt
            if (elapsed < COMPLETED_WORKER_DISPLAY_MS) {
                return ProgressPanelState.DoneRow
            } else {
                stopProgressStream()
                workerCompletedAt.clear()
                _workerPermanentlyDone.clear()
                gpuProgressDoneAt = 0L
                val shouldRefresh = panel != null
                    if (vbookProgress?.stage == VBookStage.COMPLETED) {
                        _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.IDLE)) }
                    }
                if (shouldRefresh) {
                    applyGenerationResults()
                }
                return ProgressPanelState.Hidden
            }
        }

        gpuProgressDoneAt = 0L
        return ProgressPanelState.Workers(workers)
    }
}

// ── Worker Progress Panel types ──────────────────────────────────

/**
 * One row in the GPU progress panel.
 */
data class WorkerUi(
    val type: String,
    val label: String,
    val ready: Int,
    val total: Int,
    val percent: Int,
    val done: Boolean,
    val countText: String? = null,
    /** Show cyclic/indeterminate progress bar (spinner). Hides x/y count and z%. */
    val indeterminate: Boolean = false,
    /** Server-set — true when this worker type has been cancelled via cancel-worker API. */
    val cancelled: Boolean = false
)

/**
 * Encapsulates the display state of the GPU progress panel.
 * - [Workers]: one or more worker rows to render
 * - [DoneRow]: all workers complete — show the green "Done" row
 * - [Hidden]: no progress to display
 */
sealed class ProgressPanelState {
    data class Workers(val workers: List<WorkerUi>) : ProgressPanelState()
    object DoneRow : ProgressPanelState()
    object Hidden : ProgressPanelState()
}

/**
 * Localized label strings for the worker progress panel.
 * Provided by the Activity (which has access to Android string resources).
 */
data class WorkerLabels(
    val cover: String,
    val audio: String,
    val image: String,
    val video: String,
    val generationDone: String,
    val vbookLabel: String,
    val vbookAnalyzing: String,
    val vbookScenesFormat: (Int, Int) -> String
)

// ── UI State (generation only) ───────────────────────────────────

data class GenUiState(
    val phase: PlayerPhase = PlayerPhase.IDLE,
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
    /** 0-based scene index within the current generated block; -1 means no scene yet. */
    val sceneIndex: Int = 0,
    /** Backend-reported actual scene count for the current generated block. */
    val scenesInWindow: Int = 0,
    /** Total scenes known so far across generated blocks (can grow). */
    val totalScenes: Int? = null,
    /** Current window index (0-based) */
    val windowIndex: Int = 0,
    /** Human-readable PROGRESS_STAGES message from the backend, e.g. "⟳ Извлекаю персонажей..." */
    val message: String? = null
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

/**
 * Generation status for the bottom nav icon indicator.
 * Priority order for display: ERROR > RUNNING > SUCCESS > IDLE.
 */
enum class GenerationStatus { IDLE, RUNNING, ERROR, SUCCESS }

data class ActivePosition(
    val chapterId: String? = null,
    val sceneId: String? = null,
    val unitId: String? = null,
    val chunkId: String? = null,
    val unitIndex: Int = 0
) {
    fun formatUnitLabel(): String = unitId ?: String.format("iu%04d", unitIndex)
}
