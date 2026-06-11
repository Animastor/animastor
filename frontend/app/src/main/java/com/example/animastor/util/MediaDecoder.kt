package com.example.animastor.util

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.IOException

object MediaDecoder {

    fun decodeBitmap(bytes: ByteArray): Bitmap {
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: throw IOException("Unable to decode image")
    }

}
