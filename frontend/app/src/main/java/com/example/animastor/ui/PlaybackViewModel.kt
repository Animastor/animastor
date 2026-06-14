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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException

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
        private const val WINDOW_SIZE = 3
        private const val WINDOW_GEN_POLL_INTERVAL_MS = 2_000L
        private const val INITIAL_WAIT_COUNT = 3
        private const val WINDOW_RETRY_COUNT = 60
        private const val POLL_TIMEOUT_MS = 300_000L
        private const val IMAGE_POLL_TIMEOUT_MS = 1_800_000L
        private const val POLL_INTERVAL_MS = 300L
        private const val MAX_BACKOFF_MS = 5_000L
        private const val LAZY_WINDOW_DEFAULT = 3

        // Scene types that are structural and should be excluded from window counting
        private val STRUCTURAL_SCENE_TYPES = setOf("cover", "chapter_intro")

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
                onUnitChanged()
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

    // ── Window generation trigger ────────────────────────────────

    private val _chunkUnitCounts = mutableMapOf<String, Int>()
    private val _chunkSceneTypes = mutableMapOf<String, String>()
    private val _windowTriggeredSet = mutableSetOf<Int>()
    var windowGenInProgress: Boolean = false
        private set
    private var _windowGenPollingJob: Job? = null

    private val _windowGenStatus = MutableStateFlow(WindowGenStatus())
    val windowGenStatus: StateFlow<WindowGenStatus> = _windowGenStatus.asStateFlow()

    data class WindowGenStatus(
        val active: Boolean = false,
        val progressMsg: String = "",
        val windowIndex: Int = -1,
        val createdScenes: Int = 0,
        val totalScenes: Int = 0,
        val inProgress: Boolean = false,
        val completedLingerMs: Long = 0L,
    ) {
        /** Progress percentage 0..100 based on [createdScenes] / [totalScenes]. */
        val progressPercent: Int get() {
            if (totalScenes <= 0) return -1 // indeterminate
            return ((createdScenes.toFloat() / totalScenes.toFloat()) * 100).toInt().coerceIn(0, 100)
        }
    }

    /** Load already-triggered windows from persistent storage. */
    private fun loadTriggeredWindows() {
        val prefs = getApplication<Application>().getSharedPreferences("animastor_window_gen", 0)
        val raw = prefs.getStringSet("triggered_windows", emptySet()) ?: emptySet()
        _windowTriggeredSet.clear()
        _windowTriggeredSet.addAll(raw.mapNotNull { it.toIntOrNull() })
        if (_windowTriggeredSet.isNotEmpty()) {
            Log.i(TAG, "loadTriggeredWindows: restored ${_windowTriggeredSet.size} entries: $_windowTriggeredSet")
        }
    }

    /** Persist triggered windows set (max 50 entries to limit prefs size). */
    private fun persistTriggeredWindows() {
        val prefs = getApplication<Application>().getSharedPreferences("animastor_window_gen", 0)
        // Keep only the last 50 window indices so the set doesn't grow unbounded
        val trimmed = _windowTriggeredSet.sortedDescending().take(50).toSet()
        prefs.edit().putStringSet("triggered_windows", trimmed.map { it.toString() }.toSet()).apply()
    }

    /** Called whenever [currentUnitIndex] changes during playback. */
    private fun onUnitChanged() {
        if (bookId.isBlank()) return
        checkAndTriggerWindowGeneration()
    }

    /**
     * Check if we are in the trigger zone and fire [triggerNextWindow] if needed.
     *
     * Trigger condition:
     *   - user is in the last scene of the current CONTENT window
     *   - AND the current unit is one of the last 3 units of that scene
     *   - AND generation hasn't already been triggered for this window.
     *
     * Structural scenes (cover, chapter_intro) are excluded from window counting.
     * Only content scenes (narration, dialogue, dialectic) advance the window index.
     */
    private fun checkAndTriggerWindowGeneration() {
        if (bookId.isBlank()) return
        if (windowGenInProgress) {
            Log.d(TAG, "[WINDOW-TRIGGER] skipped — generation already in progress")
            return
        }

        val chunkId = chunkQueue.getOrNull(currentIndex) ?: return

        // On-demand storyboard fetch if prefetchUnitCounts hasn't completed yet
        var unitCount = _chunkUnitCounts[chunkId]
        var sceneType = _chunkSceneTypes[chunkId]
        if (unitCount == null || sceneType == null) {
            Log.d(TAG, "[WINDOW-TRIGGER] chunk #$currentIndex unitCount not yet prefetched — fetching on-demand")
            viewModelScope.launch {
                try {
                    val sb = _repository.getChunkStoryboard(chunkId)
                    _chunkUnitCounts[chunkId] = sb.ius.size
                    if (sb.scene_type != null) {
                        _chunkSceneTypes[chunkId] = sb.scene_type
                    }
                    Log.i(TAG, "[WINDOW-TRIGGER] on-demand fetch done for $chunkId (${sb.ius.size} units, type=${sb.scene_type})")
                    // Re-check now that we have the data
                    checkAndTriggerWindowGeneration()
                } catch (e: Exception) {
                    Log.w(TAG, "[WINDOW-TRIGGER] on-demand storyboard fetch failed: ${e.message}")
                }
            }
            return
        }

        // Skip structural scenes — they don't count toward the content window
        if (sceneType in STRUCTURAL_SCENE_TYPES) {
            Log.d(TAG, "[WINDOW-TRIGGER] chunk #$currentIndex type=$sceneType is structural — skip window calc")
            return
        }

        // Calculate content-only window index: count only non-structural chunks up to currentIndex
        var contentSceneCount = 0
        var contentWindowIndex = 0
        for (i in 0..currentIndex) {
            val cid = chunkQueue.getOrNull(i) ?: continue
            val st = _chunkSceneTypes[cid] ?: "narration"
            if (st !in STRUCTURAL_SCENE_TYPES) {
                val sceneInWindow = contentSceneCount % WINDOW_SIZE
                if (sceneInWindow == 0 && contentSceneCount > 0) contentWindowIndex++
                contentSceneCount++
            }
        }
        val posInContentWindow = (contentSceneCount - 1) % WINDOW_SIZE
        val isLastSceneInWindow = posInContentWindow == WINDOW_SIZE - 1

        if (!isLastSceneInWindow) {
            Log.d(TAG, "[WINDOW-TRIGGER] chunk #$currentIndex contentScene=$contentSceneCount posInWin=$posInContentWindow not last — skip")
            return
        }

        val triggerThreshold = unitCount - 3
        if (currentUnitIndex < triggerThreshold) {
            Log.d(TAG, "[WINDOW-TRIGGER] chunk=$chunkId unit=$currentUnitIndex/$unitCount threshold=$triggerThreshold — not yet in trigger zone")
            return
        }

        // Dedup: check if already triggered for this window
        if (_windowTriggeredSet.contains(contentWindowIndex)) {
            Log.i(TAG, "[WINDOW-TRIGGER] window=$contentWindowIndex already triggered — skipping (dedup)")
            return
        }

        // FIRE!
        _windowTriggeredSet.add(contentWindowIndex)
        persistTriggeredWindows()
        windowGenInProgress = true

        Log.i(TAG, "[WINDOW-TRIGGER] 🚀 FIRING! window=$contentWindowIndex chunk=$chunkId unit=$currentUnitIndex/$unitCount " +
            "(threshold=$triggerThreshold) contentScene=$contentSceneCount sceneType=$sceneType ch=$currentChapterId sc=$currentSceneId")

        _windowGenStatus.value = WindowGenStatus(
            active = true,
            progressMsg = "Запуск генерации следующего окна...",
            windowIndex = contentWindowIndex,
            inProgress = true,
        )

        viewModelScope.launch {
            Log.i(TAG, "[WINDOW-TRIGGER] 📡 calling triggerNextWindow for book=$bookId window=$contentWindowIndex")
            val response = runCatching {
                _repository.triggerNextWindow(bookId, currentChapterId, currentSceneId, null, registerForGpu = false)
            }.onFailure { e ->
                Log.e(TAG, "[WINDOW-TRIGGER] ❌ API call failed: ${e.message}")
                _windowGenStatus.value = WindowGenStatus(progressMsg = "Failed: ${e.message}")
                windowGenInProgress = false
            }.getOrNull()

            if (response != null) {
                Log.i(TAG, "[WINDOW-TRIGGER] ✅ response: triggered=${response.triggered} queued=${response.queued} " +
                    "window=${response.window_index} all_done=${response.all_done} error=${response.error}")
                if (response.triggered) {
                    Log.i(TAG, "[WINDOW-TRIGGER] ▶️ generation started — polling agent status")
                    startWindowGenProgressPolling(response.window_index ?: -1)
                } else if (response.queued) {
                    Log.i(TAG, "[WINDOW-TRIGGER] 📦 generation queued")
                    _windowGenStatus.value = WindowGenStatus(
                        active = true,
                        progressMsg = "В очереди — ожидание текущей генерации...",
                        windowIndex = response.window_index ?: -1,
                        inProgress = true,
                    )
                    startWindowGenProgressPolling(response.window_index ?: -1)
                } else if (response.all_done == true) {
                    Log.i(TAG, "[WINDOW-TRIGGER] 📗 all text processed — no more windows")
                    _windowGenStatus.value = WindowGenStatus(
                        active = false,
                        progressMsg = "✓ Весь текст обработан",
                        inProgress = false,
                        completedLingerMs = System.currentTimeMillis() + 10_000L,
                    )
                    windowGenInProgress = false
                } else {
                    Log.w(TAG, "[WINDOW-TRIGGER] ⚠️ unexpected response: $response")
                    _windowGenStatus.value = WindowGenStatus(progressMsg = "Неожиданный ответ: ${response.error}")
                    windowGenInProgress = false
                }
            }
        }
    }

    /** Poll agent-status endpoint to track window generation progress. */
    private fun startWindowGenProgressPolling(targetWindowIndex: Int) {
        _windowGenPollingJob?.cancel()
        _windowGenPollingJob = viewModelScope.launch {
            Log.i(TAG, "[WINDOW-POLL] 📊 started polling for window=$targetWindowIndex")
            var consecutiveInactive = 0
            while (true) {
                val agentStatus = runCatching { _repository.getAgentStatus(bookId) }.getOrNull()
                if (agentStatus == null) {
                    Log.d(TAG, "[WINDOW-POLL] agent-status returned null")
                } else if (agentStatus.active) {
                    consecutiveInactive = 0
                    val msg = agentStatus.progress_msg ?: "⟳ Обработка..."
                    val created = agentStatus.created_scenes ?: 0
                    val total = agentStatus.total_scenes ?: 0
                    Log.i(TAG, "[WINDOW-POLL] 📊 active: msg=\"$msg\" window=${agentStatus.window_index} created=$created total=$total")

                    _windowGenStatus.value = WindowGenStatus(
                        active = true,
                        progressMsg = msg,
                        windowIndex = agentStatus.window_index ?: targetWindowIndex,
                        createdScenes = created,
                        totalScenes = total,
                        inProgress = true,
                    )
                } else {
                    consecutiveInactive++
                    Log.d(TAG, "[WINDOW-POLL] not active (x$consecutiveInactive)")
                    if (consecutiveInactive >= 3) {
                        Log.i(TAG, "[WINDOW-POLL] ✅ agent session inactive for 3 checks — window gen done")
                        // Show 100% + "Готово" with linger period
                        val completedMsg = "✓ Окно ${targetWindowIndex + 1} готово"
                        _windowGenStatus.value = WindowGenStatus(
                            active = false,
                            progressMsg = completedMsg,
                            windowIndex = targetWindowIndex,
                            createdScenes = WINDOW_SIZE,
                            totalScenes = WINDOW_SIZE,
                            inProgress = false,
                            completedLingerMs = System.currentTimeMillis() + 10_000L,
                        )
                        windowGenInProgress = false
                        Log.i(TAG, "[WINDOW-POLL] ✅ set linger for 10s: $completedMsg")
                        break
                    }
                }
                delay(WINDOW_GEN_POLL_INTERVAL_MS)
            }
            Log.i(TAG, "[WINDOW-POLL] polling stopped")
        }
    }

    // ── Preload ──────────────────────────────────────────────────

    private val preloadCache = mutableMapOf<String, PreloadedScene>()
    private val preloadJobs = mutableMapOf<String, Job>()
    private var preloadJob: Job? = null
    private var backgroundWindowJob: Job? = null

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
        loadTriggeredWindows()

        if (chunkIds.isNotEmpty()) {
            Log.i(TAG, "preparePlayback → SCENE_READY (${chunkIds.size} chunks)")
            _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
            maybeStartNextWindowInBackground()
            // Pre-fetch unit counts for all chunks
            viewModelScope.launch { prefetchUnitCounts() }
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
                                _chunkUnitCounts[cid] = sb.ius.size
                                if (sb.scene_type != null) {
                                    _chunkSceneTypes[cid] = sb.scene_type
                                }
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
            for (cid in chunkIds) {
                runCatching {
                    _repository.getChunkStoryboard(cid).let { sb ->
                        positions[cid] = Pair(sb.chapter_id, sb.scene_id)
                    }
                }
            }
            Log.i(TAG, "ensureInitialized: fetched ${chunkIds.size} chunks, ${positions.size} positions")
            preparePlayback(targetBookId, targetBuildId, chunkIds, positions)
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
        backgroundWindowJob?.cancel()
        backgroundWindowJob = null
        _windowGenPollingJob?.cancel()
        _windowGenPollingJob = null
        windowGenInProgress = false
        _windowGenStatus.value = WindowGenStatus()
        _chunkUnitCounts.clear()
        _chunkSceneTypes.clear()
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

    /** Reset window gen status after linger period expires. */
    fun clearWindowGenStatus() {
        _windowGenStatus.value = WindowGenStatus()
    }

    fun closeBook() {
        clearPlaybackState()
        _windowTriggeredSet.clear()
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
            Log.i(TAG, "playNext: end of queue, waiting for next window")
            viewModelScope.launch {
                if (waitForNextWindow()) {
                    playNext()
                } else {
                    Log.w(TAG, "playNext: no more windows → SCENE_READY")
                    _uiState.update { it.copy(phase = PlayerPhase.SCENE_READY) }
                }
            }
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
            maybeStartNextWindowInBackground()
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
                maybeStartNextWindowInBackground()
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
            maybeStartNextWindowInBackground()
        }
    }

    private suspend fun prefetchUnitCounts() {
        for (id in chunkQueue) {
            if (_chunkUnitCounts.containsKey(id) && _chunkSceneTypes.containsKey(id)) continue
            try {
                val sb = _repository.getChunkStoryboard(id)
                _chunkUnitCounts[id] = sb.ius.size
                if (sb.scene_type != null) {
                    _chunkSceneTypes[id] = sb.scene_type
                }
                Log.d(TAG, "[UNITS] chunk=$id has ${sb.ius.size} units type=${sb.scene_type}")
            } catch (e: Exception) {
                Log.w(TAG, "[UNITS] failed to get storyboard for $id: ${e.message}")
                // Fallback: try chunk metadata
                try {
                    val chunk = _repository.getChunk(id)
                    if (chunk.scene_type != null) {
                        _chunkSceneTypes[id] = chunk.scene_type
                    }
                } catch (_: Exception) {}
            }
        }
        Log.i(TAG, "[UNITS] prefetched counts for ${_chunkUnitCounts.size}/${chunkQueue.size} chunks, " +
            "scene types for ${_chunkSceneTypes.size}/${chunkQueue.size}")
    }

    private fun emitChunk(audio: ByteArray, video: ByteArray?, iuSequence: List<IuImageItem>?) {
        val seq = ++chunkSeqCounter
        Log.i(TAG, "emitChunk #$seq: audio=${audio.size}B ius=${iuSequence?.size ?: 0} → PLAYING")
        // Record unit count when emitting a chunk
        val chunkId = chunkQueue.getOrNull(currentIndex)
        if (chunkId != null && iuSequence != null) {
            _chunkUnitCounts[chunkId] = iuSequence.size
            Log.i(TAG, "[UNITS] chunk=$chunkId recorded ${iuSequence.size} units from emit")
        }
        pendingChunkAudio = audio
        pendingChunkVideo = video
        pendingChunkIuSequence = iuSequence
        _uiState.update { it.copy(phase = PlayerPhase.PLAYING, chunkSequence = seq) }
    }

    private fun preloadAhead(includeCurrent: Boolean = false) {
        val start = if (includeCurrent) 0 else 1

        preloadJob?.cancel()

        val job = viewModelScope.launch {
            for (offset in start..PRELOAD_AHEAD) {
                val idx = currentIndex + offset
                if (idx >= chunkQueue.size) break
                val id = chunkQueue[idx]
                if (preloadCache.containsKey(id)) continue

                Log.i(TAG, "preloading scene $offset ahead: $id")
                val data = runCatching { fetchSceneData(id) }.getOrNull()
                if (data != null) {
                    preloadCache[id] = data
                    preloadCompleted.tryEmit(id)
                    Log.i(TAG, "preloaded scene: $id — ${data.iuSequence.size} IUs")
                } else {
                    Log.w(TAG, "preload failed for scene: $id — will load on demand")
                }
            }
        }

        preloadJob = job

        preloadJobs.clear()
        val firstId = chunkQueue.getOrNull(currentIndex + start)
        if (firstId != null && !preloadCache.containsKey(firstId)) {
            preloadJobs[firstId] = job
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

    private suspend fun fetchIuSequence(id: String): List<IuImageItem> {
        return runCatching {
            val storyboard = _repository.getChunkStoryboard(id)
            chunkPositions[id] = Pair(storyboard.chapter_id, storyboard.scene_id)
            _chunkUnitCounts[id] = storyboard.ius.size
            Log.i(TAG, "[UNITS] chunk=$id storyboard: ${storyboard.ius.size} IUs, build_id=${storyboard.build_id}")
            val chId = (storyboard.chapter_id?.takeIf { it.isNotBlank() } ?: currentChapterId) ?: ""
            val scId = (storyboard.scene_id?.takeIf { it.isNotBlank() } ?: currentSceneId) ?: ""
            val bkId = storyboard.book_id?.takeIf { it.isNotBlank() } ?: bookId
            val bldId = storyboard.build_id.ifBlank { buildId }
            if (storyboard.ius.isNotEmpty() && bldId.isNotBlank() && chId.isNotBlank()) {
                storyboard.ius.map { iu ->
                    val durationMs = when {
                        iu.start_ms != null && iu.end_ms != null -> {
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

    /** Fallback duration when backend provides 0 / null. */
    private fun fallbackDurationMs(estimatedSec: Double?): Long {
        if (estimatedSec != null && estimatedSec > 0) {
            return (estimatedSec * 1000).toLong()
        }
        return 2000L
    }

    // ── Window management (lazy parse / next window) ──────────────

    private fun maybeStartNextWindowInBackground() {
        if (bookId.isBlank()) return

        val remaining = chunkQueue.size - currentIndex - 1
        Log.d(TAG, "[WINDOW-BG] maybeStartNextWindowInBackground: remaining=$remaining queueSize=${chunkQueue.size} currentIndex=$currentIndex")
        if (remaining <= 2) {
            Log.i(TAG, "[WINDOW-BG] 🟢 low on chunks (remaining=$remaining) — firing lazy parse")
            backgroundWindowJob?.cancel()
            backgroundWindowJob = viewModelScope.launch {
                runCatching {
                    val status = _repository.getLazyBookStatus(bookId)
                    Log.i(TAG, "[WINDOW-BG] book status: state=${status.state} parsed=${status.parsedChapters}/${status.totalChapters}")
                    if (status.state == "INDEXED" && status.parsedChapters < status.totalChapters) {
                        val res = _repository.lazyParse(bookId, LAZY_WINDOW_DEFAULT)
                        Log.i(TAG, "[WINDOW-BG] lazy parsed ${res.parsed} chapters (complete=${res.complete})")
                        for (ch in res.chapters) {
                            ch.chapter?.let { cid ->
                                if (!chunkQueue.contains(cid)) {
                                    chunkQueue.add(cid)
                                    Log.d(TAG, "[WINDOW-BG] added chunk $cid to queue")
                                }
                            }
                        }
                    } else {
                        Log.d(TAG, "[WINDOW-BG] book not INDEXED or all parsed — skipping lazy parse")
                    }
                }.onFailure { e ->
                    Log.d(TAG, "[WINDOW-BG] not lazy, fallback: ${e.message}")
                }
            }
        } else {
            Log.d(TAG, "[WINDOW-BG] not triggering — remaining=$remaining > 2")
        }
    }

    private suspend fun waitForNextWindow(): Boolean {
        val currentBookId = bookId
        if (currentBookId.isBlank()) {
            Log.w(TAG, "waitForNextWindow: empty bookId")
            return false
        }

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
                Log.i(TAG, "waitForNextWindow: added=$added queue=${chunkQueue.size} totalScenes=${chunks.total_scenes}")

                if (currentIndex < chunkQueue.size) {
                    Log.i(TAG, "waitForNextWindow: next window ready")
                    _uiState.update { it.copy(phase = PlayerPhase.DOWNLOADING) }
                    return true
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
