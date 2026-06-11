package com.example.animastor.ui

import android.media.MediaPlayer
import android.util.Log
import com.example.animastor.repository.Repository
import java.io.File

/**
 * Manages MediaPlayer lifecycle: creation, caching, chaining (current/next), volume.
 * Does NOT manage IU cycling or scene transitions — those remain in PlayFragment.
 */
class SceneAudioPlayer(
    private val cacheDir: File,
    private val getChunkId: () -> String?,
    private val repository: Repository
) {
    companion object {
        private const val TAG = "SceneAudioPlayer"
    }

    var currentPlayer: MediaPlayer? = null
    var nextPlayer: MediaPlayer? = null

    private var currentFile: File? = null
    private var nextFile: File? = null

    var currentVolume: Float = 1.0f

    /** Track the most recently created file so callers can store it. */
    var lastCreatedFile: File? = null
        private set

    /** Create a MediaPlayer from raw audio bytes. Returns null for empty (silent placeholder). */
    fun createPlayer(bytes: ByteArray): MediaPlayer? {
        val file = writeTemp(bytes)
        lastCreatedFile = file
        if (file.length() == 0L) {
            Log.w(TAG, "createPlayer: empty audio file, using silent placeholder")
            return null
        }
        return try {
            MediaPlayer().apply {
                setDataSource(file.absolutePath)
                prepare()
                setVolume(currentVolume, currentVolume)
            }
        } catch (e: Exception) {
            Log.w(TAG, "createPlayer failed: ${e.message}, using silent placeholder")
            null
        }
    }

    /** Preload the next track. Call [chainNext] to chain it to current player. */
    fun preloadNext(bytes: ByteArray) {
        nextFile?.delete()
        nextPlayer?.release()
        val file = writeTemp(bytes)
        nextFile = file
        if (file.length() == 0L) {
            nextPlayer = null
            Log.w(TAG, "preloadNext: empty audio, no MediaPlayer created")
        } else {
            try {
                nextPlayer = MediaPlayer().apply {
                    setDataSource(file.absolutePath)
                    prepare()
                    setVolume(currentVolume, currentVolume)
                }
            } catch (e: Exception) {
                Log.w(TAG, "preloadNext failed: ${e.message}")
                nextPlayer = null
            }
        }
    }

    /** Chain the next player to the current one, so it auto-starts when current ends. */
    fun chainNext() {
        currentPlayer?.setNextMediaPlayer(nextPlayer)
    }

    /** Set completion listener on the current player. */
    fun setOnCompletionListener(listener: () -> Unit) {
        currentPlayer?.setOnCompletionListener { listener() }
    }

    /** Set completion listener on the next player. */
    fun setNextOnCompletionListener(listener: () -> Unit) {
        nextPlayer?.setOnCompletionListener { listener() }
    }

    /** Swap next→current after a track ends. */
    fun swapToNext() {
        // Delete previous temp file
        if (currentFile?.name?.startsWith("chunk-") == true) currentFile?.delete()
        currentFile = nextFile
        currentPlayer = nextPlayer
        nextPlayer = null
        nextFile = null
    }

    /** Store the first player and its file reference. */
    fun storeFirstPlayer(player: MediaPlayer?, file: File) {
        currentPlayer = player
        currentFile = file
    }

    /** Write bytes to a temp file, using disk cache if available. */
    fun writeTemp(bytes: ByteArray): File {
        val chunkId = getChunkId()
        if (chunkId != null) {
            val cached = repository.cacheAudioFile(chunkId, bytes)
            if (cached != null) return cached
        }
        val file = File(cacheDir, "chunk-${System.currentTimeMillis()}.mp3")
        file.writeBytes(bytes)
        return file
    }

    fun start() {
        currentPlayer?.start()
    }

    fun pause() {
        currentPlayer?.pause()
    }

    fun stop() {
        currentPlayer?.stop()
    }

    fun seekTo(msec: Int) {
        currentPlayer?.seekTo(msec)
    }

    val currentPosition: Int
        get() = try { currentPlayer?.currentPosition ?: 0 } catch (_: Exception) { 0 }

    val duration: Int
        get() = try { currentPlayer?.duration ?: 0 } catch (_: Exception) { 0 }

    val isPlaying: Boolean
        get() = try { currentPlayer?.isPlaying ?: false } catch (_: Exception) { false }

    /** Release all players and delete temp files. */
    fun releaseAll() {
        currentPlayer?.release()
        nextPlayer?.release()
        currentPlayer = null
        nextPlayer = null
        if (currentFile?.name?.startsWith("chunk-") == true) currentFile?.delete()
        if (nextFile?.name?.startsWith("chunk-") == true) nextFile?.delete()
        currentFile = null
        nextFile = null
    }
}
