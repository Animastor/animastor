package com.example.animastor.util

import java.io.File
import java.util.Locale
import java.util.zip.ZipFile

object VbookFileUtils {
    fun isVbookBundle(file: File): Boolean {
        if (!hasZipHeader(file)) return false

        return runCatching {
            ZipFile(file).use { zip ->
                var hasManifest = false
                var hasBook = false
                val entries = zip.entries()

                while (entries.hasMoreElements()) {
                    val name = entries.nextElement().name
                        .replace('\\', '/')
                        .lowercase(Locale.US)
                        .trimStart('/')

                    if (name.endsWith("manifest.json")) hasManifest = true
                    if (name.endsWith("book.json")) hasBook = true
                    if (hasManifest && hasBook) return@use true
                }

                false
            }
        }.getOrDefault(false)
    }

    private fun hasZipHeader(file: File): Boolean {
        return runCatching {
            file.inputStream().use { input ->
                input.read() == 0x50 && input.read() == 0x4B
            }
        }.getOrDefault(false)
    }
}
