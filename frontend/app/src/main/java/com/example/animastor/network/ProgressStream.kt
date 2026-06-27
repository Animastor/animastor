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
 * @property type Always "progress" for progress events.
 * @property layer "image", "audio", or "video".
 * @property chapterId Chapter the event relates to (nullable).
 * @property sceneId Scene the event relates to (nullable).
 * @property ready New IU counter value for [layer]=="image". Absent for audio/video.
 */
data class ProgressEvent(
    val type: String = "",
    val layer: String = "",
    val chapterId: String? = null,
    val sceneId: String? = null,
    val ready: Int? = null
)

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
    private var isActive = false
    private var retryCount = 0
    private var reconnectJob: Job? = null
    private var currentBookId: String = ""

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

        val url = "${RetrofitClient.baseUrl.trimEnd('/')}/api/v1/book/$bookId/progress-stream"
        val request = Request.Builder()
            .url(url)
            .header("Accept", "text/event-stream")
            .build()

        val factory = EventSources.createFactory(RetrofitClient.httpClient)
        eventSource = factory.newEventSource(request, object : EventSourceListener() {

            override fun onOpen(eventSource: EventSource, response: Response) {
                Log.i("ProgressStream", "SSE connected for book $bookId")
                retryCount = 0
            }

            override fun onEvent(
                eventSource: EventSource,
                id: String?,
                type: String?,
                data: String
            ) {
                if (!isActive) return
                // Skip heartbeat comments (they are empty data lines)
                if (data.isBlank()) return

                try {
                    val event = gson.fromJson(data, ProgressEvent::class.java)
                    if (event.type == "progress") {
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
                if (!isActive) return
                Log.w("ProgressStream", "SSE disconnected for book $bookId (retry=$retryCount): ${t?.message}")

                // Exponential backoff: 1s → 2s → 4s → 8s → 15s cap
                val delayMs = (1_000L * (1L shl minOf(retryCount, 4))).coerceAtMost(15_000L)
                retryCount++

                reconnectJob = scope.launch {
                    delay(delayMs)
                    if (isActive) {
                        connect()
                    }
                }
            }

            override fun onClosed(eventSource: EventSource) {
                Log.i("ProgressStream", "SSE closed for book $bookId")
                if (isActive) {
                    // Server closed — reconnect with backoff
                    val delayMs = (1_000L * (1L shl minOf(retryCount, 4))).coerceAtMost(15_000L)
                    retryCount++
                    reconnectJob = scope.launch {
                        delay(delayMs)
                        if (isActive) {
                            connect()
                        }
                    }
                }
            }
        })
    }
}
