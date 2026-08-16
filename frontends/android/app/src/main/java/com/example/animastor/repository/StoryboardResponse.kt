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
    val duration_ms: Long? = null,
    // Server-computed position of this unit on the whole-scene VIDEO timeline
    // (the video drifts ahead of the audio/start_ms timeline on LTX builds —
    // players must seek the scene video by video_start_ms, not start_ms).
    // Absent when the backend couldn't measure the video files.
    val video_start_ms: Long? = null
)
