package com.example.animastor.repository

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.first
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Generic resource invalidation bus — the Android half of the
 * "external data mutation → invalidation event → cache evict → re-fetch →
 * reactive UI update" pipeline shared conceptually with the web frontend.
 *
 * Pure JVM: verifies dispatch semantics (kinds delivered, resource key
 * contract, monotonic stamp, blank-key rejection) without Android or a device.
 */
class ResourceInvalidationsTest {

    /** Subscribe first, then emit after the subscription had time to attach. */
    private fun awaitNextEvent(): ResourceInvalidations.ResourceEvent = runBlocking {
        val waiter = async(Dispatchers.Default) {
            withTimeout(5000) { ResourceInvalidations.events.first() }
        }
        // Headroom for the subscriber to attach before emitting.
        delay(150)
        ResourceInvalidations.emitExternal(ResourceInvalidations.Keys.book("b1"))
        waiter.await()
    }

    @Test
    fun externalEvent_reachesSubscriber_withScopedResourceKey() {
        val event = awaitNextEvent()
        assertEquals(ResourceInvalidations.Kind.EXTERNAL, event.kind)
        assertEquals("book:b1", event.resource)
    }

    @Test
    fun localEvent_reachesSubscriber_kindIsPreserved() = runBlocking {
        val waiter = async(Dispatchers.Default) {
            withTimeout(5000) { ResourceInvalidations.events.first() }
        }
        delay(150)
        ResourceInvalidations.emitLocal(ResourceInvalidations.Keys.book("b2"))
        val event = waiter.await()
        assertEquals(ResourceInvalidations.Kind.LOCAL, event.kind)
        assertEquals("book:b2", event.resource)
    }

    @Test
    fun stampIsMonotonicAcrossEmissions() {
        val before = ResourceInvalidations.stamp
        ResourceInvalidations.emitExternal(ResourceInvalidations.Keys.book("x"))
        ResourceInvalidations.emitLocal(ResourceInvalidations.Keys.book("x"))
        val after = ResourceInvalidations.stamp
        assertTrue(after > before)
    }

    @Test
    fun blankResourceIsRejected() {
        val before = ResourceInvalidations.stamp
        ResourceInvalidations.emitExternal("")
        assertEquals(before, ResourceInvalidations.stamp)
    }

    @Test
    fun bookKeyFormatIsStable() {
        assertEquals("book:abc123", ResourceInvalidations.Keys.book("abc123"))
        assertTrue(ResourceInvalidations.Keys.book("abc123").startsWith(ResourceInvalidations.Keys.BOOK_PREFIX))
    }

    @Test
    fun localAndExternalAreDistinctKinds() {
        assertNotEquals(ResourceInvalidations.Kind.LOCAL, ResourceInvalidations.Kind.EXTERNAL)
    }
}
