package com.example.animastor.repository

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * Reload retry/recovery state machine (ResilientReloader) — the layer on top
 * of the ResourceInvalidations pipeline:
 *
 *     invalidation → reload → network failure → retry/recovery → reload
 *
 * Pure JVM with a fake [NetworkRecoverySignal]; zero-length backoff steps keep
 * the tests fast while preserving the attempt/phase logic.
 */
class ResilientReloaderTest {

    /** Fake connectivity signal: manual online/offline flips with a real
     *  SharedFlow for restore events. */
    private class FakeRecovery(startOnline: Boolean = true) : NetworkRecoverySignal {
        private val flow = MutableSharedFlow<Unit>(replay = 0, extraBufferCapacity = 8)
        override val restored = flow.asSharedFlow()
        @Volatile override var isOnline: Boolean = startOnline
        fun goOffline() { isOnline = false }
        fun goOnline() {
            isOnline = true
            flow.tryEmit(Unit)
        }
    }

    private val noBackoff = listOf(0L, 0L, 0L)

    @Test
    fun `success on first attempt - no retries`() = runBlocking {
        val recovery = FakeRecovery()
        val reloader = ResilientReloader(recovery, noBackoff)
        var calls = 0
        val result = reloader.reload {
            calls++
            "fresh"
        }
        assertTrue(result is ResilientReloader.Result.Success)
        assertEquals("fresh", (result as ResilientReloader.Result.Success).value)
        assertEquals(1, calls)
    }

    @Test
    fun `transient failure is retried until success`() = runBlocking {
        val recovery = FakeRecovery()
        val reloader = ResilientReloader(recovery, noBackoff)
        var calls = 0
        val result = reloader.reload {
            calls++
            if (calls == 1) throw IOException("offline blip")
            "fresh"
        }
        assertTrue(result is ResilientReloader.Result.Success)
        assertEquals("fresh", (result as ResilientReloader.Result.Success).value)
        assertEquals(2, calls)
    }

    @Test
    fun `gives up after the bounded cycle when network stays down (online)`() = runBlocking {
        val recovery = FakeRecovery() // online but every request fails (server-side timeouts)
        val reloader = ResilientReloader(recovery, noBackoff)
        var calls = 0
        val result = reloader.reload {
            calls++
            throw IOException("timeout")
        }
        assertTrue(result is ResilientReloader.Result.TransientFailure)
        assertEquals(reloader.phaseOneAttempts, calls)
        assertEquals(reloader.phaseOneAttempts, (result as ResilientReloader.Result.TransientFailure).attempts)
    }

    @Test
    fun `permanent failure (server answered) is never retried`() = runBlocking {
        val recovery = FakeRecovery()
        val reloader = ResilientReloader(recovery, noBackoff)
        var calls = 0
        val result = reloader.reload {
            calls++
            throw RuntimeException("HTTP 404") // non-IOException = server answered
        }
        assertTrue(result is ResilientReloader.Result.PermanentFailure)
        assertEquals(1, calls)
    }

    @Test
    fun `parks offline and makes the final attempt when connectivity returns`() = runBlocking {
        val recovery = FakeRecovery(startOnline = false)
        val reloader = ResilientReloader(recovery, noBackoff)
        var calls = 0
        val waiter = async {
            withTimeout(5000) {
                reloader.reload {
                    calls++
                    // Succeed only on the final post-restore attempt.
                    if (calls <= reloader.phaseOneAttempts) throw IOException("still offline")
                    "recovered"
                }
            }
        }
        // Let the bounded cycle exhaust while offline, then restore.
        delay(100)
        recovery.goOnline()
        val result = waiter.await()
        assertTrue(result is ResilientReloader.Result.Success)
        assertEquals("recovered", (result as ResilientReloader.Result.Success).value)
        assertEquals(reloader.phaseOneAttempts + 1, calls)
    }

    @Test
    fun `restore during backoff short-circuits the wait (fast path)`() = runBlocking {
        val recovery = FakeRecovery()
        val reloader = ResilientReloader(
            recovery,
            retryDelaysMs = listOf(60_000L, 60_000L, 60_000L, 60_000L) // would take minutes
        )
        var calls = 0
        val waiter = async {
            withTimeout(5000) {
                reloader.reload {
                    calls++
                    if (calls == 1) throw IOException("blip right before restore")
                    "fast"
                }
            }
        }
        // The restore event must release the 60s backoff wait almost immediately.
        delay(50)
        recovery.goOnline()
        val result = waiter.await()
        assertTrue(result is ResilientReloader.Result.Success)
        assertEquals(2, calls)
    }

    @Test
    fun `onRetry hook fires on every scheduled backoff`() = runBlocking {
        val recovery = FakeRecovery()
        val reloader = ResilientReloader(recovery, noBackoff)
        val retryAttempts = mutableListOf<Int>()
        var calls = 0
        reloader.reload(
            onRetry = { attempt, _ -> retryAttempts.add(attempt) }
        ) {
            calls++
            if (calls <= 2) throw IOException("flaky")
            Unit
        }
        assertEquals(listOf(1, 2), retryAttempts)
    }

    @Test
    fun `cancellation propagates - never swallowed as a failure`() = runBlocking {
        val recovery = FakeRecovery()
        val reloader = ResilientReloader(recovery, noBackoff)
        val gate = CompletableDeferred<Unit>()
        val job = launch {
            try {
                reloader.reload {
                    gate.await() // suspended "request"
                    throw IOException("never observed")
                }
            } catch (e: CancellationException) {
                gate.complete(Unit)
                throw e
            }
        }
        delay(50)
        job.cancel()
        job.join()
        assertTrue(job.isCancelled)
    }
}
