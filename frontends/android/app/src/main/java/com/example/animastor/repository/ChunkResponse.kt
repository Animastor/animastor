package com.example.animastor.repository

data class ChunkResponse(
    val status: String? = null,
    val image_ready: Boolean,
    val audio_ready: Boolean,
    val video_ready: Boolean,
    val audio_status: String? = null,
    val video_status: String?,
    val scene_type: String? = null,
    val scene_id: String? = null,
    val chapter_id: String? = null
)
