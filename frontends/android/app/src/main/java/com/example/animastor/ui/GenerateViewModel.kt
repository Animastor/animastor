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
import com.example.animastor.repository.sceneRefs
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

    /**
     * True once a generation session has fully completed and the 10s
     * DoneRow display window has expired. Prevents the poll loop from
     * re-displaying stale completed workers from the server.
     * Reset to false when a new generation starts.
     */
    @Volatile
    private var _generationCompleted = false

    /**
     * True when a new generation has just been started but the server may still
     * return stale completed workers from a previous generation. Used to suppress
     * the false green 100% flash on screen.
     * Cleared in [computeProgressRows] when actual new progress is detected.
     */
    @Volatile
    private var _newGenerationPending = false

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

    /**
     * При входе на экран Generator — проверить, есть ли активная GPU-генерация
     * (унаследованная от предыдущей сессии, восстановленная после restart backend'а).
     *
     * WorkerCounts.active_audio/image/video > 0 означает, что scheduler уже
     * диспатчит задачи на GPU Hub. Восстанавливаем UI-состояние:
     *   - task-aware progress panel state
     *   - _generationStatus = RUNNING (чтобы nav-иконка пульсировала)
     *   - timer (чтобы показывать прошедшее время)
     *
     * Вызывается один раз при загрузке GenerateFragment.onViewCreated.
     */
    suspend fun checkAndRestoreGenerationState() {
        val currentBookId = bookId
        if (currentBookId.isBlank()) return

        if (_isRegenerating.value) {
            Log.d(TAG, "checkAndRestoreGenerationState: user generation already active — skipping restore")
            return
        }

        try {
            val panel = _repository.getProgressPanel(currentBookId)
            val counts = _repository.getWorkerCounts()
            val hasActiveGpuTasks = panel.any_incomplete
            val hasActiveWorkers = hasActiveGpuTasks || counts.active_vbook > 0

            if (hasActiveWorkers) {
                Log.i(TAG, "checkAndRestoreGenerationState: active workers found (a=${counts.active_audio} i=${counts.active_image} v=${counts.active_video} vb=${counts.active_vbook}) — restoring generation state")
                _isRegenerating.value = hasActiveGpuTasks
                _generationStatus.value = GenerationStatus.RUNNING
                if (timerStartedAt <= 0L) startTimer()  // Не сбрасываем таймер, если уже запущен
                startProgressStream(currentBookId)
                resetProgressState()
                _uiState.update { it.copy(phase = PlayerPhase.GENERATING) }
            } else {
                Log.d(TAG, "checkAndRestoreGenerationState: no active workers")
            }
        } catch (e: Exception) {
            Log.w(TAG, "checkAndRestoreGenerationState failed: ${e.message}")
        }
    }

    // ── Explicit navigation events (emitted by importBookFromFile) ─
    // FileFragment collects this and switches to the appropriate tab.
    // MainActivity does NOT collect this to avoid double switchToPlayTab().
    sealed class NavigationEvent {
        data class NavigateToGenerate(val reason: String = "") : NavigationEvent()
        data class NavigateToPlay(val reason: String = "") : NavigationEvent()
    }

    private val _navigationEvent = MutableSharedFlow<NavigationEvent>(extraBufferCapacity = 4)
    val navigationEvent: SharedFlow<NavigationEvent> = _navigationEvent.asSharedFlow()

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

    /**
     * Monotonic token for VBook poll generations: incremented on every
     * startVBookGeneration so a cancelled/superseded poll loop (or its failure
     * handler) can detect it is stale and never touch the UI or timer of a
     * newer session. Mirrors the mobile web's vbookPollToken.
     */
    private var vbookPollToken = 0

    // ── Layer defaults ────────────────────────────────────────────

    var imageEnabled: Boolean = true
        private set

    private val _audioEnabled = MutableStateFlow(true)
    val audioEnabledFlow: StateFlow<Boolean> = _audioEnabled.asStateFlow()

    private val _videoEnabled = MutableStateFlow(true)
    val videoEnabledFlow: StateFlow<Boolean> = _videoEnabled.asStateFlow()

    private val _vbookEnabled = MutableStateFlow(true)
    val vbookEnabledFlow: StateFlow<Boolean> = _vbookEnabled.asStateFlow()

    private val _hasAssets = MutableStateFlow(false)
    val hasAssetsFlow: StateFlow<Boolean> = _hasAssets.asStateFlow()

    private val _layerConfigLoaded = MutableStateFlow(false)
    val layerConfigLoadedFlow: StateFlow<Boolean> = _layerConfigLoaded.asStateFlow()

    fun audioEnabled(): Boolean = _audioEnabled.value
    fun videoEnabled(): Boolean = _videoEnabled.value
    fun vbookEnabled(): Boolean = _vbookEnabled.value
    fun hasAssets(): Boolean = _hasAssets.value

    fun setAudioEnabled(enabled: Boolean) {
        _audioEnabled.value = enabled
        viewModelScope.launch { persistLayerConfig() }
    }

    fun setImageEnabled(enabled: Boolean) {
        imageEnabled = enabled
        viewModelScope.launch { persistLayerConfig() }
    }

    fun setVideoEnabled(enabled: Boolean) {
        _videoEnabled.value = enabled
        viewModelScope.launch { persistLayerConfig() }
    }

    fun setVBookEnabled(enabled: Boolean) {
        _vbookEnabled.value = enabled
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
                _vbookEnabled.value = cfg.vbook_enabled
                _layerConfigLoaded.value = true
                Log.i(TAG, "loadLayerConfig: a=${cfg.audio_enabled} i=${cfg.image_enabled} v=${cfg.video_enabled} vb=${cfg.vbook_enabled}")
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
                video_enabled = _videoEnabled.value,
                vbook_enabled = _vbookEnabled.value
            ))
            Log.i(TAG, "persistLayerConfig: a=${cfg.audio_enabled} i=${cfg.image_enabled} v=${cfg.video_enabled} vb=${cfg.vbook_enabled}")
        }.onFailure { e ->
            Log.w(TAG, "persistLayerConfig failed: ${e.message}")
        }
    }

    // ── Generation ───────────────────────────────────────────────

    data class GenerationRequest(
        val workerTypes: List<String>,
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
        _isRegenerating.value = true

        // Don't reset _generationCompleted here — let _newGenerationPending
        // gate the UI until the server reports actual new workers, preventing
        // a brief flash of stale green 100% progress from the previous generation.
        _newGenerationPending = true
        if (timerStartedAt <= 0L) startTimer()
        startProgressStream(bookId)

        // 🔧 FIX: Don't cancel previous generationJob — parallel generations are
        // independent. The /regenerate API call is fire-and-forget; its response
        // handler only updates local state (buildId, cache). Cancelling would
        // prevent the new generation from updating buildId, but more importantly
        // it would break the pattern of independent parallel workers.
        viewModelScope.launch {
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
                val res = _repository.regenerateBookScoped(
                    bookId = bookId,
                    newBook = null,
                    rebuildAll = true,
                    workerTypes = req.workerTypes,
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
            }.onFailure { e ->
                if (e is CancellationException) {
                    Log.i(TAG, "startGeneration cancelled")
                    onResult(GenerationResult.Failed("cancelled"))
                } else {
                    Log.e(TAG, "startGeneration failed: ${e.message}", e)
                    onResult(GenerationResult.Failed(e.message ?: "unknown"))
                }
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
        if (!_isRegenerating.value) {
            stopTimer()
        }

        viewModelScope.launch {
            // Thin-client: server-computed flat scene list (with legacy fallback)
            val scenes = mutableListOf<SceneRef>()
            var coverChapterId: String? = null
            var coverSceneId: String? = null
            val bookData = runCatching { _repository.getBook(bookId) }.getOrNull()
            if (bookData != null) {
                scenes.addAll(bookData.sceneRefs())
                scenes.firstOrNull { it.sceneType == "cover" }?.let { cover ->
                    coverChapterId = cover.chapterId
                    coverSceneId = cover.sceneId
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
        // Mark the session regenerating (mirrors startGeneration) so the shared
        // wall-clock timer is NOT stopped when the VBook agent finishes — both
        // while audio/image/video stages are still running, and in the pure-VBook
        // flow at the end of each window. Without this, stopTimer() in
        // pollVBookProgress/applyGenerationResults ran BEFORE the frozen elapsed
        // of the green COMPLETED row was computed, so the 100% row showed
        // 00:00:00 instead of the real window time — the reported "timer shows
        // zeros at 100%" bug. (The timer is stopped later by the normal
        // finalise path ~10s after the completed row appears.)
        _isRegenerating.value = true

        // Don't reset _generationCompleted here — let _newGenerationPending
        // gate the UI until VBook progress or server workers appear.
        _newGenerationPending = true
        _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.ANALYZING)) }
        // Manual per-window mode: one click = one window = one generation. The
        // timer always starts fresh for the new window (no survival across
        // windows); the previous window's finalise already stopped it.
        startTimer()
        startProgressStream(bid)
        _importCompleteReceived = false

        generationJob?.cancel()
        val token = ++vbookPollToken
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
                pollVBookProgress(bid, token)
            }.onFailure { e ->
                // A superseded generation (new startVBookGeneration / import /
                // cancel) cancelled this job — its failure must not tear down
                // the UI or timer of the newer session.
                if (token != vbookPollToken) return@onFailure
                Log.w(TAG, "startVBookGeneration failed: ${e.message}")
                // A client-side abort (OkHttp timeout / network blip) does NOT
                // stop the backend agent — the bootstrap route keeps processing
                // the window. Reconcile with the real agent state before tearing
                // the UI down: if it is still running (or the window already
                // finished, paused), keep the progress block + timer alive and
                // let the poller track it to completion. Only tear down on a
                // genuine failure (no active session). Mirrors the mobile web.
                val agentStillAlive = runCatching {
                    val st = _repository.getAgentStatus(bid)
                    st.active || st.session_status == "paused"
                }.getOrDefault(false)
                if (agentStillAlive) {
                    Log.i(TAG, "startVBookGeneration: agent still active after client-side failure — keeping UI alive")
                    pollVBookProgress(bid, token)
                } else {
                    Log.w(TAG, "startVBookGeneration: no active agent session — tearing down")
                    _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.IDLE)) }
                    stopTimer()
                }
            }
        }
    }

    /**
     * Poll /agent-status until the VBook agent completes.
     * Updates [vbookProgress] for the Generate screen progress display.
     * Exits early when SSE import_complete event arrives.
     */
    private suspend fun pollVBookProgress(bId: String, token: Int) {
        var consecutiveInactive = 0
        val maxInactive = 2
        // Safety net against a stuck backend (agent-status reports active
        // forever). NOT a generation deadline: the loop terminates on its own
        // once the agent reports inactive twice. Long single-window runs (the
        // reported multi-minute stages) must never be cut short by this cap, so
        // it sits far above any realistic generation — matching the mobile web.
        val maxPollTimeMs = 60 * 60 * 1000L
        val startTime = System.currentTimeMillis()
        var safetyCapTripped = false

        while (consecutiveInactive < maxInactive) {
            // A newer generation superseded this poll — leave its UI alone.
            if (token != vbookPollToken) return
            if (_importCompleteReceived) {
                Log.i(TAG, "[VBookPoll] import_complete SSE received — marking completed")
                // Preserve the last-known window counters: the completed row
                // must show the real final counter (e.g. "3/3"), not "1/1".
                _uiState.update { state ->
                    state.copy(vbookProgress = state.vbookProgress?.copy(stage = VBookStage.COMPLETED))
                }
                break
            }
            if (System.currentTimeMillis() - startTime > maxPollTimeMs) {
                safetyCapTripped = true
                Log.w(TAG, "[VBookPoll] safety timeout (${maxPollTimeMs}ms)")
                break
            }
            delay(2000)
            try {
                val status = _repository.getAgentStatus(bId)

                // 'paused' = the current window is complete; the agent is idle,
                // waiting for the user to press "Генерировать далее" (manual
                // continuation — one window per click). Finalize this window
                // immediately with the real counter (e.g. "3/3") — never
                // auto-advance to the next window.
                if (status.session_status == "paused") {
                    if (status.progress_msg != null) {
                        updateVBookProgress(status)
                    }
                    _uiState.update { state ->
                        state.copy(vbookProgress = state.vbookProgress?.copy(stage = VBookStage.COMPLETED))
                    }
                    break
                }

                if (status.active && status.progress_msg != null) {
                    consecutiveInactive = 0
                    updateVBookProgress(status)
                } else if (!status.active) {
                    consecutiveInactive++
                    if (status.progress_msg != null) {
                        updateVBookProgress(status)
                    }
                    if (consecutiveInactive >= maxInactive) {
                        // Preserve the last-known window counters so the
                        // completed row shows the real final counter (e.g.
                        // "3/3"), not "1/1".
                        _uiState.update { state ->
                            state.copy(vbookProgress = state.vbookProgress?.copy(stage = VBookStage.COMPLETED))
                        }
                    }
                } else {
                    // active=true but no message — agent between steps
                    consecutiveInactive = 0
                }
            } catch (e: Exception) {
                // Never swallow cancellation — a cancelled poll must exit via the
                // token guard (or propagate), not continue to stopTimer() below.
                if (e is CancellationException) throw e
                consecutiveInactive++
                Log.w(TAG, "[VBookPoll] failed: ${e.message} (x$consecutiveInactive)")
                delay(3000)
            }
        }
        // A newer generation superseded this poll while it was running.
        if (token != vbookPollToken) return

        // If the safety cap tripped, probe the real agent state before deciding:
        // a still-working agent (running, or paused between windows) must NOT be
        // finalised — SUCCESS + stopTimer would freeze the timer mid-generation.
        // The 1.5s panel poll (checkVBookAgentStatus) keeps tracking it instead.
        if (safetyCapTripped) {
            Log.w(TAG, "[VBookPoll] safety cap reached — probing agent state")
            try {
                val status = _repository.getAgentStatus(bId)
                if (!status.active) {
                    _uiState.update { state ->
                        state.copy(vbookProgress = state.vbookProgress?.copy(stage = VBookStage.COMPLETED))
                    }
                    _generationStatus.value = GenerationStatus.SUCCESS
                    if (!_isRegenerating.value) stopTimer()
                    applyGenerationResults()
                } else {
                    Log.w(TAG, "[VBookPoll] agent still active after safety cap — leaving UI alive")
                }
                return
            } catch (e: Exception) {
                // Never swallow cancellation (same reason as the poll loop above).
                if (e is CancellationException) throw e
                Log.w(TAG, "[VBookPoll] safety-cap probe failed: ${e.message}")
            }
        }

        _generationStatus.value = GenerationStatus.SUCCESS
        if (!_isRegenerating.value) stopTimer()
        Log.i(TAG, "[VBookPoll] done — refreshing player with new scenes")
        applyGenerationResults()
    }

    fun cancelGeneration() {
        Log.i(TAG, "cancelGeneration: $bookId")
        if (bookId.isBlank()) return
        _generationStatus.value = GenerationStatus.IDLE
        _newGenerationPending = false
        stopTimer()  // 🕐 отмена — останавливаем таймер
        stopProgressStream()  // ❄ закрываем SSE канал
        resetProgressState()
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
        resetProgressState()
        _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.IDLE)) }
        // A new import starts a fresh session: invalidate any in-flight VBook
        // poll job (so its failure handler can never touch the new UI) and stop
        // the previous session's timer explicitly — the old implicit stop came
        // from the cancelled job's teardown, which the token guard now suppresses.
        vbookPollToken++
        generationJob?.cancel()
        generationJob = null
        stopTimer()
        hasUnsavedChanges = false
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

                        // Thin-client: server-computed flat scene list (with legacy fallback)
                        val bookData = runCatching { _repository.getBook(bId) }.getOrNull()
                        val scenes = mutableListOf<SceneRef>()
                        var coverScene: SceneRef? = null
                        if (bookData != null) {
                            scenes.addAll(bookData.sceneRefs())
                            coverScene = scenes.firstOrNull { it.sceneType == "cover" }
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

                        // VBook: если есть сцены → Play, иначе → Generate
                        if (scenes.isNotEmpty()) {
                            _navigationEvent.tryEmit(
                                NavigationEvent.NavigateToPlay("vbook_import_complete")
                            )
                        } else {
                            _navigationEvent.tryEmit(
                                NavigationEvent.NavigateToGenerate("vbook_no_scenes")
                            )
                        }
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

                        // Thin-client: server-computed flat scene list (with legacy fallback)
                        val bookForNav = runCatching { _repository.getBook(bId) }.getOrNull()
                        val scenesFromTxt = mutableListOf<SceneRef>()
                        if (bookForNav != null) {
                            scenesFromTxt.addAll(bookForNav.sceneRefs())
                        }

                        // Navigate to first scene from book JSON
                        val firstChapter = bookForNav?.chapters?.firstOrNull()
                        val firstScene = firstChapter?.scenes?.firstOrNull()
                        if (firstChapter != null && firstScene != null) {
                            SharedPositionManager.navigateTo(
                                chapterId = firstChapter.chapter_id,
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

                        _generationCompleted = true
                        _uiState.update { it.copy(
                            importStage = ImportStage.DONE,
                            importProgress = 1f,
                            vbookProgress = VBookProgress(stage = VBookStage.IDLE),
                            phase = if (scenesFromTxt.isNotEmpty()) PlayerPhase.SCENE_READY else PlayerPhase.IDLE,
                        )}

                        // TXT: если есть ассеты → Play (контент уже сгенерирован),
                        // иначе → Generate (нужно запустить VBook генерацию).
                        val txtAssets = runCatching { _repository.getAssetsState(bId) }.getOrNull()
                        val txtHasAssets = txtAssets?.has_assets == true
                        if (txtHasAssets) {
                            _navigationEvent.tryEmit(
                                NavigationEvent.NavigateToPlay("txt_reimport_has_assets")
                            )
                        } else {
                            _navigationEvent.tryEmit(
                                NavigationEvent.NavigateToGenerate("txt_import_complete")
                            )
                        }
                        Log.i(TAG, "importBookFromFile (txt): ready with ${scenesFromTxt.size} scenes has_assets=$txtHasAssets")
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
                // Preserve the last-known window counters so the completed row
                // shows the real final counter (e.g. "3/3"), not "1/1".
                _uiState.update { state ->
                    state.copy(vbookProgress = state.vbookProgress?.copy(stage = VBookStage.COMPLETED))
                }
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
                        // Preserve the last-known window counters so the
                        // completed row shows the real final counter (e.g.
                        // "3/3"), not "1/1".
                        _uiState.update { state ->
                            state.copy(vbookProgress = state.vbookProgress?.copy(stage = VBookStage.COMPLETED))
                        }
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
            // 'paused' = the current window finished and the agent is idle,
            // waiting for the user to press "Генерировать далее" (manual
            // continuation) — that is a terminal state for this window, so it
            // counts as inactive and finalizes COMPLETED with the real counter.
            if (status.active && status.progress_msg != null) {
                // ── Update the GPU-style progress panel (no chat messages for subsequent windows) ──
                updateVBookProgress(status)
            } else if (!status.active) {
                val current = _uiState.value.vbookProgress
                if (current != null) {
                    when (current.stage) {
                        VBookStage.ANALYZING, VBookStage.CREATING_SCENES -> {
                            // Agent just finished — re-read the now-saved window
                            // counters (window_total_scenes from window_data)
                            // before marking COMPLETED, so the final counter
                            // reflects the real window size (e.g. "3/3", or
                            // "2/2" for a partial final window), not the
                            // mid-pipeline estimate. Then preserve those
                            // counters through the COMPLETED transition instead
                            // of replacing VBookProgress with a fresh object
                            // (which would reset the counter to "1/1").
                            if (status.progress_msg != null) {
                                updateVBookProgress(status)
                            }
                            _uiState.update { state ->
                                state.copy(vbookProgress = state.vbookProgress?.copy(stage = VBookStage.COMPLETED))
                            }
                        }
                        VBookStage.COMPLETED -> { /* keep — the 10s display window finalises the session normally */ }
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

        _uiState.update { state ->
            val prevStepType = state.vbookProgress?.stepType
            state.copy(
                vbookProgress = VBookProgress(
                    stage = stage,
                    sceneIndex = sceneIndex,
                    scenesInWindow = windowTotal,
                    totalScenes = total,
                    windowIndex = status.window_index ?: 0,
                    message = messageText,
                    // Preserve the last known stage id when agent-status reports
                    // none (between steps / at window end the running-step lookup
                    // returns null) — otherwise every poll would fall back to the
                    // backend's Russian progress message in English UIs for a
                    // render cycle. startVBookGeneration resets VBookProgress, so
                    // it never leaks across runs.
                    stepType = status.step_type ?: prevStepType
                )
            )
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

    fun markUnsavedChanges() { hasUnsavedChanges = true }

    fun regenerateFromSnapshot() {
        startGeneration(
            req = GenerationRequest(
                workerTypes = buildList {
                    if (audioEnabled()) add("audio")
                    if (imageEnabled) add("image")
                    if (videoEnabled()) add("video")
                },
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

    /**
     * Restore the last-opened book session after a cold start.
     *
     * Previously MainActivity wiped the persisted bookId on every cold start
     * ("drop any persisted session"), so the app forgot the open book whenever
     * the process restarted. Now we keep it and validate it against the server:
     *   1. The persisted book_id (from SharedPreferences) — if it still exists
     *      on the server, restore it.
     *   2. Otherwise fall back to the most recent book known to the server
     *      (GET /api/v1/books) — this covers books imported/opened from the
     *      web app or another device, which this client has never seen.
     * The player is warmed with the book's scenes so Play/Navigate/Edit work
     * immediately (same payload as the vbook import path).
     *
     * @return true if a book was restored.
     */
    suspend fun restoreBookSession(): Boolean {
        val savedId = bookId.takeIf { it.isNotBlank() }
        val restoredBuildId = buildId.takeIf { it.isNotBlank() }
        var candidateId: String? = null
        var candidateBuildId: String? = null

        // 1. Validate the persisted book id against the server.
        if (savedId != null) {
            val status = try {
                _repository.getLazyBookStatus(savedId)
            } catch (e: java.io.IOException) {
                // Server unreachable — keep the persisted book optimistically
                // (a transient network blip must not hide the open book). The
                // prefs are never wiped, so this self-heals on the next launch.
                Log.w(TAG, "restoreBookSession: server unreachable, keeping $savedId optimistically")
                savedId
            } catch (e: Exception) {
                // 404 or other — the book is gone from the server.
                Log.w(TAG, "restoreBookSession: saved book $savedId no longer on server")
                null
            }
            if (status != null) {
                candidateId = savedId
                candidateBuildId = restoredBuildId
            }
        }

        // 2. Fallback: the most recent book known to the server.
        if (candidateId == null) {
            val recent = runCatching { _repository.getRecentBooks() }.getOrDefault(emptyList())
            recent.firstOrNull()?.let { r ->
                if (r.book_id.isNotBlank()) {
                    candidateId = r.book_id
                    candidateBuildId = r.build_id ?: restoredBuildId
                    Log.i(TAG, "restoreBookSession: picked most recent server book ${r.book_id} (${r.state ?: "?"})")
                }
            }
        }

        val bid = candidateId ?: return false
        persistBookId(bid)
        val restoreBuild = candidateBuildId?.takeIf { it.isNotBlank() } ?: restoredBuildId
        if (restoreBuild != null) persistBuildId(restoreBuild)

        // 3. Warm the player + position so Play/Navigate/Edit work immediately.
        viewModelScope.launch {
            val bookData = runCatching { _repository.getBook(bid) }.getOrNull()
            val bookBuild = bookData?.manifest?.build_id?.takeIf { it.isNotBlank() }
            if (bookBuild != null) persistBuildId(bookBuild)
            if (bookData != null) {
                // A user import / .vbook intent may have opened another book
                // while we were restoring — never clobber it with a stale
                // warmup payload for the old book.
                if (bookId != bid) return@launch
                val scenes = bookData.sceneRefs()
                val coverScene = scenes.firstOrNull { it.sceneType == "cover" }
                val first = coverScene ?: scenes.firstOrNull()
                if (first != null) {
                    SharedPositionManager.navigateTo(
                        chapterId = first.chapterId,
                        sceneId = first.sceneId,
                        unitIndex = 0
                    )
                }
                // Load the cover exactly like the import path, so a restored
                // book shows its art instead of the curtains.
                val cover = if (coverScene != null && imageEnabled) {
                    loadCoverBitmap(coverScene.chapterId, coverScene.sceneId)
                } else null
                _playbackPrepared.tryEmit(PlaybackPreparation(
                    bookId = bid,
                    buildId = buildId,
                    scenes = scenes,
                    coverImage = cover
                ))
                _uiState.update {
                    it.copy(
                        phase = if (scenes.isNotEmpty()) PlayerPhase.SCENE_READY else PlayerPhase.IDLE,
                        errorMessage = null
                    )
                }
                Log.i(TAG, "restoreBookSession: restored $bid with ${scenes.size} scenes cover=${cover != null}")
            } else {
                Log.w(TAG, "restoreBookSession: book $bid restored, but GET /book failed")
            }
        }
        return true
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
        // Invalidate any in-flight VBook poll job so its failure handler can
        // never touch the fresh state (mirrors the mobile web closeBook).
        vbookPollToken++
        generationJob?.cancel()
        _generationStatus.value = GenerationStatus.IDLE
        stopTimer()  // 🕐 закрыли книгу — сбрасываем таймер
        persistBookId("")
        persistBuildId("")
        hasUnsavedChanges = false
        _isRegenerating.value = false
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

    private val COMPLETED_TASK_DISPLAY_MS = 10_000L

    /**
     * Tolerance for comparing server task started_at against the client session
     * clock (System.currentTimeMillis()): absorbs small client/server clock skew
     * so a task that legitimately started right after the user started generation
     * is never wrongly classified as stale. Safe against the reported flash: the
     * no-session branch (timerStartedAt <= 0) still suppresses every done row on
     * fresh screen open.
     */
    private val STALE_DONE_TOLERANCE_MS = 3_000L

    /**
     * Row-unique tracking key for one progress row.
     *
     * A generation task can emit MULTIPLE rows: the backend's progress-panel
     * emits one row per target scene for `current_scene` tasks, and a task can
     * legitimately span several scenes. Keying the monotonic floor / completion
     * timestamp by task_id ALONE made sibling rows of the same task share one
     * record: when the first sibling finished (e.g. the cover's fast 1/1 row),
     * its `completedAt` was recorded under the shared key, and the 10s done-row
     * expiry then dropped the STILL-RUNNING sibling (the real scene) the moment
     * it reached 5/5 — so the final green "5/5 → 100%" row never rendered and
     * the panel finalised early (the reported "4/5 → drop, no final 100%" bug).
     * The shared floor also leaked ready counts across rows (e.g. a cover row
     * showing "4/1"). Mirrors rowTaskKey in the mobile web generateStore.
     */
    private fun rowTaskKey(taskId: String?, type: String, chapterId: String?, sceneId: String?): String =
        if (taskId != null) "$taskId:$type:${chapterId ?: ""}:${sceneId ?: ""}" else "legacy:$type"

    /** Floor per generation task — prevents progress rollback. */
    private val taskReadyFloor = ConcurrentHashMap<String, Int>()

    /** Track when each generation task completed. */
    private val taskCompletedAt = mutableMapOf<String, Long>()

    /**
     * Per-task frozen elapsed seconds at the moment that task reached 100%.
     * Once set for a taskKey, the timer display for that task stays frozen.
     * Cleared in [resetProgressState].
     */
    private val taskFrozenElapsed = mutableMapOf<String, Long>()

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
                            message = vbookMsg,
                            stepType = event.vbookStage
                        )
                    )}
                    // SSE only updates GPU panel. Chat messages come from pollAgentProgress
                    // using the same msgs.add + copy(toList) pattern as status messages.
                } else if (event.type == "generation_complete") {
                    // A completion event belongs to one server-side generation
                    // scope and is not proof that every parallel worker type is
                    // finished. The progress-panel poll remains authoritative
                    // and finalises only after all visible workers are done.
                    Log.i(TAG, "SSE generation_complete received — waiting for progress-panel reconciliation")
                } else if (event.type == "import_complete") {
                    // F10: Server-pushed terminal event — all agent windows
                    // processed. The pollAgentProgress loop will exit on next
                    // check when it sees consecutiveInactive >= maxInactive.
                    // Set a flag so the next poll iteration finishes quickly.
                    Log.i(TAG, "SSE import_complete received — stopping agent poll")
                    _importCompleteReceived = true
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
    fun cancelTask(type: String, taskId: String? = null) {
        Log.i(TAG, "cancelTask: type=$type taskId=$taskId bookId=$bookId")
        if (bookId.isBlank()) return

        // If VBook was cancelled, clear its progress immediately and stop the poller.
        // Also bump vbookPollToken so the cancelled poll job's failure handler
        // sees a stale token and returns early — it must NOT run stopTimer()
        // while parallel GPU stages are still generating (that would freeze the
        // session timer and freeze later GPU done rows at 00:00:00).
        if (type == "vbook") {
            _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.IDLE)) }
            vbookPollToken++
            generationJob?.cancel()
            generationJob = null
        }

        viewModelScope.launch {
            runCatching {
                _repository.cancelWorker(bookId, type, taskId)
            }.onSuccess {
                Log.i(TAG, "cancelTask: backend cancelled type=$type taskId=$taskId successfully")
            }.onFailure { e ->
                Log.w(TAG, "cancelTask: backend call failed: ${e.message}")
            }
        }
    }

    /**
     * Reset all worker tracking state for a new generation session.
     * Call when new GPU generation or VBook work is detected.
     */
    fun resetProgressState() {
        // НЕ останавливаем таймер — он живёт от startGeneration до applyGenerationResults/cancel.
        // resetWorkerState вызывается poller'ом при детекте новой генерации,
        // и стоп таймера здесь убил бы только что запущенный startTimer().
        taskCompletedAt.clear()
        taskReadyFloor.clear()
        taskFrozenElapsed.clear()
        _generationCompleted = false
    }

    /**
     * Check if any content was generated during the current generation session.
     * Used to decide whether to refresh the player after cancel or partial failure.
     * Returns true if any worker type has ever had non-zero progress.
     */
    private fun hasAnyProgress(): Boolean {
        return taskReadyFloor.values.any { it > 0 } ||
            taskCompletedAt.isNotEmpty()
    }

    /**
     * Build the progress panel state from server-computed worker list + local VBook.
     * Server provides ready/total/percent/done/visible for each GPU worker.
     * Client keeps: 10s "Done" row timing, monotonic floor, VBook progress rendering.
     *
     * Parallel-worker policy (F15 fix):
     * - Completed workers stay visible at 100% while ANY worker is still active.
     * - When ALL workers are done, they show completed for COMPLETED_TASK_DISPLAY_MS,
     *   then applyGenerationResults() is called and the panel hides.
     * - Workers NEVER disappear mid-generation just because 10s elapsed.
     */
    fun computeProgressRows(
        panel: com.example.animastor.repository.ProgressPanelResponse?,
        vbookProgress: VBookProgress?,
        labels: TaskLabels
    ): ProgressPanelState {
        // NEW-GEN GATE: If a new generation just started, wait until we see actual
        // new worker activity on the server before showing anything. The server may
        // still return stale completed workers from the previous generation for a
        // brief window after startGeneration() / startVBookGeneration() is called.
        // Without this gate, those stale 100%-done workers would flash green on screen.
        if (_newGenerationPending) {
            val hasVBook = vbookProgress != null &&
                (vbookProgress.stage == VBookStage.ANALYZING || vbookProgress.stage == VBookStage.CREATING_SCENES)
            val hasGpuActivity = panel?.tasks?.any { !it.done && !it.cancelled && it.visible } == true
            if (hasVBook || hasGpuActivity) {
                _generationCompleted = false
                _newGenerationPending = false
            } else {
                return ProgressPanelState.Hidden
            }
        }

        // Once generation has been finalised, never re-show stale workers
        // from a previous session until a new generation starts.
        if (_generationCompleted) return ProgressPanelState.Hidden

        val now = System.currentTimeMillis()
        val rows = mutableListOf<TaskRow>()

        fun addFromServer(
            sw: com.example.animastor.repository.ProgressTask,
            label: String
        ) {
            if (sw.total <= 0) return
            // Per-ROW key: sibling rows of one task (per-target rows) keep their
            // own floor and their own 10s done-window — a fast sibling can never
            // expire a still-running one, and ready counts never cross-pollute.
            val taskKey = rowTaskKey(sw.task_id, sw.type, sw.chapter_id, sw.scene_id)
            val ready = maxOf(sw.ready, taskReadyFloor[taskKey] ?: 0)
            val done = sw.done || (ready >= sw.total && ready > 0)
            // STALE-DONE GATE (identical to mobile web) — the backend keeps
            // recently-completed tasks in the panel for ~30s (TERMINAL_RETENTION_MS)
            // and can report a task whose assets are all ready as done. On screen
            // open these done rows from a PREVIOUS generation must NOT flash as
            // fresh green 100% bars: only work that started within the current
            // session (timerStartedAt) may render its "Done" state. Rows started
            // before the session (or with no session at all) are skipped before
            // they reach the ready-floor / completedAt maps.
            val sessionStarted = timerStartedAt > 0L
            val staleDone = done && !sw.cancelled &&
                (!sessionStarted ||
                    (sw.started_at != null && sw.started_at + STALE_DONE_TOLERANCE_MS < timerStartedAt))
            if (staleDone) return
            taskReadyFloor[taskKey] = ready
            if (done && !sw.cancelled && !taskCompletedAt.containsKey(taskKey)) {
                taskCompletedAt[taskKey] = now
            }
            // Per-worker elapsed: frozen at completion, live while active
            val elapsedSeconds: Long = if (done) {
                taskFrozenElapsed.getOrPut(taskKey) {
                    if (timerStartedAt > 0L) (now - timerStartedAt) / 1000L else 0L
                }
            } else {
                if (timerStartedAt > 0L) (now - timerStartedAt) / 1000L else 0L
            }
            rows.add(TaskRow(
                taskId = sw.task_id,
                type = sw.type,
                label = label,
                scope = sw.scope,
                chapterId = sw.chapter_id,
                sceneId = sw.scene_id,
                sceneLabel = sw.scene_label,
                chapterLabel = sw.chapter_label,
                endSceneLabel = sw.end_scene_label,
                endChapterLabel = sw.end_chapter_label,
                ready = ready,
                total = sw.total,
                percent = if (done) 100 else sw.percent.coerceIn(0, 99),
                done = done,
                indeterminate = sw.indeterminate,
                cancelled = sw.cancelled,
                elapsedSeconds = elapsedSeconds
            ))
        }

        // ── GPU tasks (from server progress-panel) ──
        if (panel != null) {
            for (sw in panel.tasks) {
                if (!sw.visible) continue
                val label = when (sw.type) {
                    "cover" -> labels.cover
                    "audio" -> labels.audio
                    "image" -> labels.image
                    "video" -> labels.video
                    else -> sw.type
                }
                addFromServer(sw, label)
            }
        }

        // ── VBook worker (local state) ──
        if (vbookProgress != null && vbookProgress.stage != VBookStage.IDLE) {
            if (vbookProgress.stage == VBookStage.COMPLETED) {
                val vbookKey = rowTaskKey("vbook", "vbook", null, null)
                // Record completion timestamp if not already set
                if (!taskCompletedAt.containsKey(vbookKey)) {
                    taskCompletedAt[vbookKey] = now
                }
                val vbookElapsed = taskFrozenElapsed.getOrPut(vbookKey) {
                    if (timerStartedAt > 0L) (now - timerStartedAt) / 1000L else 0L
                }
                // Preserve the final window counter (e.g. "3/3") instead of
                // resetting to "1/1": derive ready/total from the last known
                // window state. When no scene-level index was ever reported,
                // show the full window count (best available estimate).
                val finalTotal = vbookProgress.scenesInWindow.coerceAtLeast(1)
                val hasSceneProgress = vbookProgress.sceneIndex >= 0 && vbookProgress.scenesInWindow > 0
                val finalReady = if (hasSceneProgress) {
                    (vbookProgress.sceneIndex + 1).coerceAtMost(finalTotal)
                } else {
                    finalTotal
                }
                rows.add(TaskRow(
                    taskId = "vbook",
                    type = "vbook",
                    label = labels.vbookLabel,
                    ready = finalReady,
                    total = finalTotal,
                    percent = 100,
                    done = true,
                    countText = labels.vbookScenesFormat(finalReady, finalTotal),
                    elapsedSeconds = vbookElapsed
                ))
            } else {
                val stageMsg = vbookProgress.message?.takeIf { it.isNotBlank() }
                // Localize by machine stage id first (follows the UI language); fall
                // back to the backend's Russian progress message, then the generic label.
                val label = labels.vbookStageLabel(vbookProgress.stepType, vbookProgress.sceneIndex)
                    ?: stageMsg ?: labels.vbookLabel
                val ready: Int; val totalVBook: Int; val pctVBook: Int; val countText: String; val indeterminate: Boolean
                val vbookElapsed: Long = if (timerStartedAt > 0L) (now - timerStartedAt) / 1000L else 0L
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
                rows.add(TaskRow(
                    taskId = "vbook",
                    type = "vbook",
                    label = label,
                    ready = ready,
                    total = totalVBook,
                    percent = pctVBook,
                    done = false,
                    countText = countText,
                    indeterminate = indeterminate,
                    elapsedSeconds = vbookElapsed
                ))
            }
        }

        // ── All-cancelled guard: if every remaining worker is cancelled,
        // hide the panel immediately since there's nothing to show.
        val allCancelled = rows.isNotEmpty() && rows.all { it.cancelled }
        if (allCancelled) {
            taskCompletedAt.clear()
            _isRegenerating.value = false
            return ProgressPanelState.Hidden
        }

        // ── No workers at all → Hidden (no generation running) ──
        if (rows.isEmpty()) {
            taskCompletedAt.clear()
            _isRegenerating.value = false
            return ProgressPanelState.Hidden
        }

        // ── Per-worker expiry: filter out done workers whose 10s display window expired ──
        // Uses the ROW-unique key (task + type + target), so each sibling row of
        // a multi-target task expires by its OWN completion time — the real
        // scene's green 5/5 stays visible for its full 10s window and only then
        // finalises.
        rows.removeAll { row ->
            if (row.done && !row.cancelled) {
                val taskKey = rowTaskKey(row.taskId, row.type, row.chapterId, row.sceneId)
                val completedAt = taskCompletedAt[taskKey]
                completedAt != null && (now - completedAt) >= COMPLETED_TASK_DISPLAY_MS
            } else false
        }

        // ── All workers expired → finalise generation ──
        if (rows.isEmpty()) {
            _generationCompleted = true
            stopProgressStream()
            taskCompletedAt.clear()
            if (vbookProgress?.stage == VBookStage.COMPLETED) {
                _uiState.update { it.copy(vbookProgress = VBookProgress(stage = VBookStage.IDLE)) }
            }
            _generationStatus.value = GenerationStatus.SUCCESS
            _isRegenerating.value = false
            applyGenerationResults()
            return ProgressPanelState.Hidden
        }

        // Check if any worker is still active (non-done, non-cancelled)
        val anyActive = rows.any { !it.done && !it.cancelled }

        if (!anyActive) {
            // All remaining workers are done but still within 10s display window
            return ProgressPanelState.Rows(rows)
        }

        // ── Some workers still active — show ALL visible remaining workers ──
        _isRegenerating.value = true
        return ProgressPanelState.Rows(rows)
    }
}

// ── Worker Progress Panel types ──────────────────────────────────

/**
 * One row in the GPU progress panel.
 */
data class TaskRow(
    val taskId: String? = null,
    val type: String,
    val label: String,
    val scope: String = "whole_book",
    val chapterId: String? = null,
    val sceneId: String? = null,
    /** Human-readable scene label from backend (e.g. "Scene 3 — The Forest"). */
    val sceneLabel: String? = null,
    /** Human-readable chapter label from backend (e.g. "Chapter 2"). */
    val chapterLabel: String? = null,
    /** Human-readable end scene label for range scopes (e.g. "Scene 48"). */
    val endSceneLabel: String? = null,
    /** Human-readable end chapter label for range scopes. */
    val endChapterLabel: String? = null,
    val ready: Int,
    val total: Int,
    val percent: Int,
    val done: Boolean,
    val countText: String? = null,
    /** Show cyclic/indeterminate progress bar (spinner). Hides x/y count and z%. */
    val indeterminate: Boolean = false,
    /** Server-set — true when this worker type has been cancelled via cancel-worker API. */
    val cancelled: Boolean = false,
    /**
     * Elapsed seconds this worker should display.
     * Frozen at the moment this worker reached 100% (done=true), or live via
     * (now - timerStartedAt) while the worker is still active.
     * -1 means the timer is not running (should not happen for visible workers).
     */
    val elapsedSeconds: Long = -1L
)

/**
 * Encapsulates the display state of the GPU progress panel.
 * - [Workers]: one or more worker rows to render
 * - [DoneRow]: all workers complete — show the green "Done" row
 * - [Hidden]: no progress to display
 */
sealed class ProgressPanelState {
    data class Rows(val rows: List<TaskRow>) : ProgressPanelState()
    object DoneRow : ProgressPanelState()
    object Hidden : ProgressPanelState()
}

/**
 * Localized label strings for the worker progress panel.
 * Provided by the Activity (which has access to Android string resources).
 */
data class TaskLabels(
    val cover: String,
    val audio: String,
    val image: String,
    val video: String,
    val generationDone: String,
    val vbookLabel: String,
    val vbookAnalyzing: String,
    val vbookScenesFormat: (Int, Int) -> String,
    /**
     * Localized VBook agent stage status by machine stage id (SSE `stage` /
     * agent-status `step_type`). Returns null for unknown ids — the caller then
     * falls back to the backend progress message / generic vbookLabel.
     * @param stepType wire stage id (may be null)
     * @param sceneIndex 0-based window-relative scene index (VBookProgress.sceneIndex)
     */
    val vbookStageLabel: (stepType: String?, sceneIndex: Int) -> String?
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
    BUFFERING,
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
    /** Human-readable PROGRESS_STAGES message from the backend (Russian fallback), e.g. "⟳ Извлекаю персонажей..." */
    val message: String? = null,
    /** Machine stage id (SSE `stage` / agent-status `step_type`) — mapped to a
     *  localized status via TaskLabels.vbookStageLabel; null when the backend
     *  didn't report one. */
    val stepType: String? = null
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
    val status: IuStatus = IuStatus.READY,
    // Server-computed start offset (ms) of this unit inside the whole-scene
    // audio/video timeline (image_units.start_ms). Null when the backend
    // hasn't timed the scene yet — callers then fall back to cumulative
    // durationMs. This is the same anchor the Edit screen preview seeks to.
    val startMs: Long? = null
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
