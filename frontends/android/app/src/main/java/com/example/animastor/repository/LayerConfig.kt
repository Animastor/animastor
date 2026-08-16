package com.example.animastor.repository

data class LayerConfigResponse(
    val book_id: String? = null,
    val audio_enabled: Boolean = true,
    val image_enabled: Boolean = true,
    val video_enabled: Boolean = true,
    val vbook_enabled: Boolean = true,
    // VBook chunk size: how many scenes the AI agent generates per pass (1-5, default 3)
    val chunk_size: Int = 3,
    // Per-worker generation timeouts (minutes)
    val audio_timeout_minutes: Int? = null,
    val image_timeout_minutes: Int? = null,
    val video_timeout_minutes: Int? = null
)

data class LayerConfigUpdate(
    val audio_enabled: Boolean? = null,
    val image_enabled: Boolean? = null,
    val video_enabled: Boolean? = null,
    val vbook_enabled: Boolean? = null,
    val chunk_size: Int? = null,
    val audio_timeout_minutes: Int? = null,
    val image_timeout_minutes: Int? = null,
    val video_timeout_minutes: Int? = null
)

/**
 * Scene readiness status — returns audio/video/image ready flags for a scene.
 */
data class SceneStatusResponse(
    val book_id: String? = null,
    val chapter_id: String? = null,
    val scene_id: String? = null,
    val build_id: String? = null,
    val scene_type: String? = null,
    val audio_ready: Boolean = false,
    val video_ready: Boolean = false,
    val image_ready: Boolean = false,
    // Content version of the scene video (file mtime on the backend). build_id
    // is immutable per book and regeneration replaces video in place (same URL,
    // new bytes) — this version goes into the video URL (?v=) so the disk cache
    // key changes exactly when the content changes. 0 = no video / legacy backend.
    val video_version: Long = 0
)

/**
 * Reference to a scene in the book — used by PlaybackViewModel for scene-based playback.
 */
data class SceneRef(
    val chapterId: String?,
    val sceneId: String?,
    val sceneType: String? = null
)

data class AssetsStateResponse(
    val book_id: String? = null,
    val scope: String? = null,
    val total_chunks: Int = 0,
    val audio_ready: Int = 0,
    val image_ready: Int = 0,
    val video_ready: Int = 0,
    val has_audio: Boolean = false,
    val has_image: Boolean = false,
    val has_video: Boolean = false,
    val all_audio_ready: Boolean = false,
    val all_image_ready: Boolean = false,
    val all_video_ready: Boolean = false,
    val has_assets: Boolean = false,
    val scope_total: Int = 0,
    val scope_audio_ready: Int = 0,
    val scope_audio_ready_real: Int = 0,
    val scope_image_ready: Int = 0,
    val scope_video_ready: Int = 0,
    val scope_all_audio_ready: Boolean = false,
    val scope_all_image_ready: Boolean = false,
    val scope_all_video_ready: Boolean = false,
    val scope_iu_total: Int = 0,
    val scope_iu_ready: Int = 0,
    val cover_iu_total: Int = 0,
    val cover_iu_ready: Int = 0,
    val audio_error: Int = 0,
    val image_error: Int = 0,
    val video_error: Int = 0,
    val cover_needs_generation: Boolean = false
)

// ======================================================
// TXT Import / Lazy Book Request Models
// ======================================================

data class LazyParseRequest(
    val windowSize: Int? = null
)

data class LazyParseToRequest(
    val chapterIndex: Int,
    val windowSize: Int? = null
)
