package com.example.animastor.repository

data class StoryboardResponse(
    val chunk_id: String,
    val book_id: String?,
    val chapter_id: String?,
    val scene_id: String?,
    val build_id: String,
    val scene_type: String? = null,
    val ius: List<IuItem>
)

data class IuItem(
    val unit_id: String,
    val scene_id: String?,
    val text: String?,
    val text_proportion: Double?,
    val estimated_duration_sec: Double?,
    val audio_file: String?,
    val start_ms: Long? = null,
    val end_ms: Long? = null,
    // Server-computed playback duration (interval → estimate → 2000ms default).
    val duration_ms: Long? = null
)
