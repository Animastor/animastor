package com.example.animastor.repository

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException

/**
 * Connectivity recovery signal abstraction. The Android implementation wraps
 * ConnectivityManager network callbacks (network/ConnectivityObserver); unit
 * tests substitute fakes. Shaped so the same contract maps onto the Web
 * frontend (navigator.onLine + the 'online' event).
 */
interface NetworkRecoverySignal {
    /** Best-effort current connectivity state. */
    val isOnline: Boolean

    /** Emits once on every offline → online transition (replay = 0). */
    val restored: Flow<Unit>
}

/**
 * Retry-with-recovery wrapper for resource reloads — the layer on top of the
 * ResourceInvalidations pipeline:
 *
 *     invalidation → reload → network failure → retry/recovery → reload → UI
 *
 * Contract:
 *  - Bounded backoff 1s → 2s → 5s → 10s (initial attempt + one retry per
 *    delay step, 4 retry steps by default). No infinite aggressive polling.
 *  - Fast path: a connectivity restore during a backoff wait short-circuits
 *    the remaining timer — the retry happens the moment the network returns,
 *    not on the next tick.
 *  - If the network is still DOWN when the bounded cycle exhausts, the reloader
 *    parks on the restore signal (event-driven, zero polling) and makes ONE
 *    final attempt — so an outage longer than the backoff window still
 *    self-heals when connectivity returns.
 *  - Transient vs permanent: only network-level failures (IOException —
 *    timeout, unreachable host, reset connection) are retried. An HTTP answer
 *    (HttpException, even 404/500) means the server IS reachable — the caller
 *    treats it as "the data is really unavailable/missing", never as a network
 *    blip.
 *
 * Pure JVM (no Android imports) so the state machine is unit-testable
 * (ResilientReloaderTest). Callers own the failure UI: stale content is never
 * replaced by an error state on a transient failure.
 */
class ResilientReloader(
    private val recovery: NetworkRecoverySignal,
    private val retryDelaysMs: List<Long> = listOf(1_000L, 2_000L, 5_000L, 10_000L)
) {

    sealed class Result<out T> {
        data class Success<T>(val value: T) : Result<T>()

        /** Network went away mid-reload and stayed down through the whole
         *  bounded cycle — the caller keeps the previously loaded content. */
        data class TransientFailure(val attempts: Int, val cause: Throwable) : Result<Nothing>()

        /** The server answered with an error — the data is really unavailable
         *  or missing; this is not a connectivity problem. */
        data class PermanentFailure(val cause: Throwable) : Result<Nothing>()
    }

    /** Total attempts phase 1 makes: the initial one plus one per delay step. */
    val phaseOneAttempts: Int get() = retryDelaysMs.size + 1

    /**
     * Run [attempt] with retry/recovery. [onRetry] fires right after a
     * transient failure, when the backoff wait starts — the hook for the
     * unobtrusive "retrying automatically…" notice.
     */
    suspend fun <T> reload(
        onRetry: (attempt: Int, cause: Throwable) -> Unit = { _, _ -> },
        attempt: suspend () -> T
    ): Result<T> {
        var attempts = 0
        var lastCause: Throwable? = null

        // Phase 1 — bounded backoff with connectivity fast-path.
        for (step in 0..retryDelaysMs.size) {
            attempts++
            try {
                return Result.Success(attempt())
            } catch (ce: CancellationException) {
                throw ce
            } catch (e: Throwable) {
                lastCause = e
                if (!isTransient(e)) return Result.PermanentFailure(e)
                if (step < retryDelaysMs.size) {
                    onRetry(attempts, e)
                    // Wait out the backoff, but if connectivity is restored
                    // earlier, retry immediately instead of on the next tick.
                    withTimeoutOrNull(retryDelaysMs[step]) { recovery.restored.first() }
                }
            }
        }

        // Phase 2 — still offline at exhaustion: park on the restore signal
        // (no timer, no polling) and make one final attempt when it returns.
        if (!recovery.isOnline) {
            recovery.restored.first()
            attempts++
            try {
                return Result.Success(attempt())
            } catch (ce: CancellationException) {
                throw ce
            } catch (e: Throwable) {
                lastCause = e
                if (!isTransient(e)) return Result.PermanentFailure(e)
            }
        }

        return Result.TransientFailure(attempts, lastCause ?: IOException("reload failed"))
    }

    companion object {
        /** Network-level failures are transient. Everything else (an HTTP
         *  status, a parse error) means the request reached its destination. */
        fun isTransient(e: Throwable): Boolean = e is IOException
    }
}
