package com.example.animastor.util

import android.util.Log
import java.io.File

class SimpleDiskCache(
    private val cacheDir: File,
    private val maxSizeBytes: Long = 256 * 1024 * 1024,
    private val debug: Boolean = false
) {
    private val tag = "DiskCache"
    private val dirs = mapOf(
        "audio" to File(cacheDir, "audio").also { it.mkdirs() },
        "video" to File(cacheDir, "video").also { it.mkdirs() },
        "image" to File(cacheDir, "image").also { it.mkdirs() },
        "preview" to File(cacheDir, "preview").also { it.mkdirs() },
        "iu" to File(cacheDir, "iu").also { it.mkdirs() }
    )

    fun getFile(key: String, type: String): File? {
        val dir = dirs[type] ?: return null
        val file = File(dir, sanitize(key))
        return if (file.exists()) file else null
    }

    fun put(key: String, type: String, bytes: ByteArray, ext: String = "dat"): File {
        val dir = dirs[type] ?: File(cacheDir, type).also { it.mkdirs() }
        val file = File(dir, "${sanitize(key)}.$ext")
        if (file.exists()) file.delete()
        file.writeBytes(bytes)
        if (debug) Log.d(tag, "cached $type/$key (${bytes.size}B) -> ${file.name}")
        trim()
        return file
    }

    fun remove(key: String, type: String): Boolean {
        val dir = dirs[type] ?: File(cacheDir, type)
        val file = File(dir, sanitize(key))
        return if (file.exists()) file.delete() else false
    }

    fun evictAll() {
        for (dir in dirs.values) {
            dir.listFiles()?.forEach { it.delete() }
        }
    }

    fun cachedSize(): Long {
        var total = 0L
        for (dir in dirs.values) {
            dir.listFiles()?.forEach { total += it.length() }
        }
        return total
    }

    private fun trim() {
        var total = cachedSize()
        if (total <= maxSizeBytes) return
        val all = dirs.values.flatMap { dir -> dir.listFiles()?.toList() ?: emptyList() }
            .sortedBy { it.lastModified() }
        for (file in all) {
            if (total <= maxSizeBytes) break
            val len = file.length()
            if (file.delete()) {
                total -= len
                if (debug) Log.d(tag, "trimmed ${file.name}")
            }
        }
    }

    private fun sanitize(key: String): String {
        return key.replace(Regex("[^a-zA-Z0-9._-]"), "_")
    }

    companion object {}
}
