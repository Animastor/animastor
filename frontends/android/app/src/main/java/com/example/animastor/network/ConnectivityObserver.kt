package com.example.animastor.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import com.example.animastor.repository.NetworkRecoverySignal
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * ConnectivityManager-backed [NetworkRecoverySignal] — the Android half of the
 * reload recovery layer (ResilientReloader). Tracks live networks matching the
 * INTERNET capability and emits `restored` exactly on offline → online
 * transitions, so a parked reload retries the moment connectivity returns
 * instead of waiting out the next backoff timer.
 *
 * Registration is app-session scoped (the observer lives as long as
 * GenerateViewModel); no unregister path is needed. Thread-safe: callbacks
 * arrive on a Connectivity thread while readers may be on any dispatcher.
 */
class ConnectivityObserver(context: Context) : NetworkRecoverySignal {

    private val connectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val _online = MutableStateFlow(false)
    override val isOnline: Boolean get() = _online.value

    private val _restored = MutableSharedFlow<Unit>(replay = 0, extraBufferCapacity = 4)
    override val restored: Flow<Unit> = _restored.asSharedFlow()

    /** Number of currently available INTERNET-capable networks. */
    private var availableCount = 0
    /** True between "last network lost" and the next "network available". */
    private var seenOffline = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            val emitRestore: Boolean
            synchronized(this@ConnectivityObserver) {
                availableCount++
                emitRestore = availableCount == 1 && seenOffline
                if (emitRestore) seenOffline = false
            }
            _online.value = true
            if (emitRestore) {
                Log.i(TAG, "connectivity restored — releasing parked reloads")
                _restored.tryEmit(Unit)
            }
        }

        override fun onLost(network: Network) {
            synchronized(this@ConnectivityObserver) {
                availableCount = (availableCount - 1).coerceAtLeast(0)
                if (availableCount == 0) seenOffline = true
            }
            _online.value = availableCount > 0
        }
    }

    init {
        // Best-effort initial state (the callback only reports transitions).
        val caps = connectivityManager.getNetworkCapabilities(connectivityManager.activeNetwork)
        _online.value = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        connectivityManager.registerNetworkCallback(request, callback)
        Log.i(TAG, "registered (initial online=$_online)")
    }

    companion object {
        private const val TAG = "ConnectivityObserver"
    }
}
