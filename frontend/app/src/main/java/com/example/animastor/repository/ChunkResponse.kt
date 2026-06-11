package com.example.animastor.repository

data class ChunkResponse(
    val status: String? = null,
    val image_ready: Boolean,
    val audio_ready: Boolean,
    val video_ready: Boolean,
    val video_status: String?
)
