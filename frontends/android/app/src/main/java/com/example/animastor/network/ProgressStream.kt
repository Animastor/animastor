package com.example.animastor.network

import android.util.Log
import com.google.gson.Gson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

/**
 * SSE push event from the backend progress stream.
 *
 * For GPU progress:
 * @property type "progress" for GPU events.
 * @property layer "image", "audio", or "video".
 * @property chapterId Chapter the event relates to (nullable).
 * @property sceneId Scene the event relates to (nullable).
 * @property ready New IU counter value for [layer]=="image". Absent for audio/video.
 *
 * For VBook progress:
 * @property type "vbook" for VBook agent pipeline events.
 * @property vbookStage "analyzing", "creating_scenes", "creating_units", "creating_visuals".
 * @property vbookSceneIndex Current scene being processed (1-based, backend-owned).
 * @property vbookTotalScenes Backend-reported cumulative total after the current block.
 * @property vbookWindowSceneIndex Current scene inside the generated block (1-based).
 * @property vbookWindowTotalScenes Actual scene count in the generated block.
 */
data class ProgressEvent(
    val type: String = "",
    val layer: String = "",
    val chapterId: String? = null,
    val sceneId: String? = null,
    val ready: Int? = null,
    // VBook fields (present when type == "vbook")
    val stage: String? = null,
    val scene_index: Int? = null,
    val total_scenes: Int? = null,
    /** Backend scene cap for legacy/fallback progress display; not a source offset boundary. */
    val window_size: Int? = null,
    val window_scene_index: Int? = null,
    val window_total_scenes: Int? = null,
    val window_start_scene: Int? = null,
    /** Human-readable PROGRESS_STAGES text from backend (e.g. "⟳ Извлекаю персонажей...") */
    val message: String? = null
) {
    /** Convenience: true if this is a VBook pipeline event. */
    fun isVBook(): Boolean = type == "vbook"

    /** Convenience: VBook stage name (analyzing, creating_scenes, ...). */
    val vbookStage: String? get() = stage

    /** Convenience: current scene index for VBook progress. */
    val vbookSceneIndex: Int? get() = scene_index

    /** Convenience: total scenes for VBook progress. */
    val vbookTotalScenes: Int? get() = total_scenes

    /** Convenience: current scene number inside the generated VBook block. */
    val vbookWindowSceneIndex: Int? get() = window_scene_index

    /** Convenience: actual scene count in the generated VBook block. */
    val vbookWindowTotalScenes: Int? get() = window_total_scenes

    /** Convenience: global 1-based scene number where the generated block starts. */
    val vbookWindowStartScene: Int? get() = window_start_scene

    /** Convenience: human-readable PROGRESS_STAGES message text. */
    val vbookMessage: String? get() = message
}

/**
 * SSE client for the GPU progress push channel.
 *
 * Connects to `/api/v1/book/{bookId}/progress-stream` and emits parsed
 * [ProgressEvent] instances via [onProgressEvent].  Automatically reconnects
 * with exponential backoff (1s → 2s → 4s → 8s → 15s cap) as long as the
 * stream is active.  Call [cancel] to stop.
 *
 * The stream is **advisory** — polling `/assets-state` remains the source
 * of truth.  SSE events may be lost during connection drops; the poller
 * reconciles on the next cycle.
 */
class ProgressStream(
    private val scope: CoroutineScope
) {
    private var eventSource: EventSource? = null
    @Volatile private var isActive = false
    private var retryCount = 0
    private var reconnectJob: Job? = null
    private var currentBookId: String = ""

    /**
     * Incremented on every start()/cancel(). Callbacks capture the epoch at
     * connect time and become no-ops if a newer session has started — otherwise
     * a stale onFailure/onClosed from the previous book could schedule a
     * reconnect that clobbers [reconnectJob] and leaks.
     *
     * Volatile because it's written on the caller's thread (cancel/start)
     * and read on OkHttp's callback thread (onEvent/onFailure/onClosed).
     */
    @Volatile private var epoch = 0

    private val gson: Gson = RetrofitClient.gson

    /**
     * Callback invoked for each parsed [ProgressEvent].
     * Called on OkHttp's internal thread — dispatch to main if needed.
     */
    var onProgressEvent: (ProgressEvent) -> Unit = {}

    /**
     * Start streaming progress for [bookId].
     * Stops any previous stream first.
     */
    fun start(bookId: String) {
        if (bookId.isBlank()) return
        cancel()
        currentBookId = bookId
        isActive = true
        retryCount = 0
        connect()
    }

    /** Cancel the stream and release resources.  Safe to call multiple times. */
    fun cancel() {
        epoch++
        isActive = false
        reconnectJob?.cancel()
        eventSource?.cancel()
        eventSource = null
        currentBookId = ""
        retryCount = 0
    }

    private fun connect() {
        val bookId = currentBookId
        if (bookId.isBlank() || !isActive) return
        val myEpoch = epoch

        val url = "${RetrofitClient.baseUrl.trimEnd('/')}/api/v1/book/$bookId/progress-stream"
        val request = Request.Builder()
            .url(url)
            .header("Accept", "text/event-stream")
            .build()

        val factory = EventSources.createFactory(RetrofitClient.httpClient)
        eventSource = factory.newEventSource(request, object : EventSourceListener() {

            override fun onOpen(eventSource: EventSource, response: Response) {
                Log.i("ProgressStream", "SSE connected for book $bookId")
                // NOTE: retryCount is deliberately NOT reset here.  A server (or
                // proxy) that accepts the connection and immediately closes it
                // would otherwise loop connect→reset→close at the minimum delay
                // forever.  The counter resets on the first received event instead.
            }

            override fun onEvent(
                eventSource: EventSource,
                id: String?,
                type: String?,
                data: String
            ) {
                if (!isActive || epoch != myEpoch) return
                // The stream has proven useful — re-arm the backoff
                retryCount = 0
                // Skip heartbeat comments (they are empty data lines)
                if (data.isBlank()) return

                try {
                    val event = gson.fromJson(data, ProgressEvent::class.java)
                    if (event.type == "progress" || event.type == "vbook" || event.type == "generation_complete" || event.type == "import_complete") {
                        onProgressEvent(event)
                    }
                    // "open" events (type=open) are informational — ignore
                } catch (e: Exception) {
                    Log.w("ProgressStream", "Failed to parse SSE event: ${e.message}")
                }
            }

            override fun onFailure(
                eventSource: EventSource,
                t: Throwable?,
                response: Response?
            ) {
                if (!isActive || epoch != myEpoch) return
                Log.w("ProgressStream", "SSE disconnected for book $bookId (retry=$retryCount): ${t?.message}")
                scheduleReconnect(myEpoch)
            }

            override fun onClosed(eventSource: EventSource) {
                Log.i("ProgressStream", "SSE closed for book $bookId")
                if (isActive && epoch == myEpoch) {
                    // Server closed — reconnect with backoff
                    scheduleReconnect(myEpoch)
                }
            }
        })
    }

    /** Exponential backoff: 1s → 2s → 4s → 8s → 15s cap. */
    private fun scheduleReconnect(myEpoch: Int) {
        val delayMs = (1_000L * (1L shl minOf(retryCount, 4))).coerceAtMost(15_000L)
        retryCount++
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delayMs)
            if (isActive && epoch == myEpoch) {
                connect()
            }
        }
    }
}
