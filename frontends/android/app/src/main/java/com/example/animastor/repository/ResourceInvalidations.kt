package com.example.animastor.repository

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

/**
 * Generic invalidation bus for book-scoped JSON resources.
 *
 * Contract (web-parity target for frontends/app — the same conceptual pipeline
 * applies there with a signal store):
 *
 *     external data mutation → invalidation event on this bus
 *     → resource caches evicted (data layer) → views re-fetch affected resource
 *     → reactive UI update.
 *
 * Two event kinds:
 *  - [ResourceEvent.Kind.EXTERNAL] — the JSON was changed OUTSIDE the current
 *    UI write path (AI Assistant patches are the motivating case; later:
 *    websocket/push from the backend). Every screen holding stale book data
 *    (Edit / Navigate / Generate / Assistant context bar) re-reads it.
 *  - [ResourceEvent.Kind.LOCAL] — this client itself just mutated the resource
 *    (Editor save, entity add/delete, AI Assistant direct create/delete calls).
 *    LOCAL does not force screen reloads (the initiating screen already
 *    re-fetched); it exists so the data layer can evict caches uniformly and
 *    future subscribers (e.g. a second surface showing the same entity) can
 *    opt in.
 *
 * No polling: events are emitted at the moment of mutation. Scope is a plain
 * resource key ("book:<id>"), so the mechanism is generic — a new JSON
 * resource only needs its own key + emit call, never a per-feature hack.
 *
 * The bus is pure JVM (no Android imports) so the dispatch semantics are
 * unit-testable (ResourceInvalidationsTest).
 */
object ResourceInvalidations {

    enum class Kind { EXTERNAL, LOCAL }

    data class ResourceEvent(
        val kind: Kind,
        /** Logical resource key, e.g. "book:<bookId>". Not a file path. */
        val resource: String,
        /** Id of the client that originated a LOCAL write (diagnostics). */
        val origin: String? = null
    )

    /** Well-known resource keys. */
    object Keys {
        /** The whole book bundle (book.json / characters.json / locations.json / voices.json / behavior.json / bible.json). */
        const val BOOK_PREFIX = "book:"
        fun book(bookId: String): String = "$BOOK_PREFIX$bookId"
    }

    private val seq = AtomicLong(0)

    private val _events = MutableSharedFlow<ResourceEvent>(
        replay = 0,
        extraBufferCapacity = 32
    )

    /** Hot stream of invalidation events. Collect where data lives / views refresh. */
    val events: Flow<ResourceEvent> = _events.asSharedFlow()

    /** Monotonic stamp — lets observers cheaply coalesce/dedupe bursts. */
    val stamp: Long get() = seq.get()

    /**
     * Emit an invalidation. Never throws, never blocks the caller: buffered
     * (extraBufferCapacity) with tryEmit; under burst pressure events may be
     * dropped, which is safe by design — subscribers re-fetch on next sight of
     * an event, and a missed event is recovered by the next save/navigation.
     */
    fun emit(kind: Kind, resource: String, origin: String? = null) {
        if (resource.isBlank()) return
        seq.incrementAndGet()
        _events.tryEmit(ResourceEvent(kind, resource, origin))
    }

    fun emitExternal(resource: String, origin: String? = null) = emit(Kind.EXTERNAL, resource, origin)
    fun emitLocal(resource: String, origin: String? = null) = emit(Kind.LOCAL, resource, origin)

    /** Test/debug helper: collect events into [scope]. */
    fun collectInto(scope: CoroutineScope, block: suspend (ResourceEvent) -> Unit): Job =
        scope.launch { events.collect { block(it) } }
}
