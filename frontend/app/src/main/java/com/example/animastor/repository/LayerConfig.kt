package com.example.animastor.repository

data class LayerConfig(
    val audio_enabled: Boolean = true,
    val image_enabled: Boolean = true,
    val video_enabled: Boolean = true
)

data class LayerConfigResponse(
    val book_id: String? = null,
    val audio_enabled: Boolean = true,
    val image_enabled: Boolean = true,
    val video_enabled: Boolean = true,
    val profile: String? = null
)

data class LayerConfigUpdate(
    val audio_enabled: Boolean? = null,
    val image_enabled: Boolean? = null,
    val video_enabled: Boolean? = null,
    val profile: String? = null
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
    val scope_image_ready: Int = 0,
    val scope_video_ready: Int = 0,
    val scope_all_audio_ready: Boolean = false,
    val scope_all_image_ready: Boolean = false,
    val scope_all_video_ready: Boolean = false,
    val scope_iu_total: Int = 0,
    val scope_iu_ready: Int = 0,
    val cover_iu_total: Int = 0,
    val cover_iu_ready: Int = 0,
    val cover_needs_generation: Boolean = false,
    val profile: String? = null
)

data class RegenerateScope(
    val new_book: BookData? = null,
    val rebuild_all: Boolean = false,
    val profile: String? = null,
    val scope: String? = null,
    val chapter_id: String? = null,
    val scene_id: String? = null
)

// ======================================================
// TXT Import / Lazy Book Request Models
// ======================================================

data class ImportTextRequest(
    val text: String,
    val title: String? = null
)

data class LazyParseRequest(
    val windowSize: Int? = null
)

data class LazyParseToRequest(
    val chapterIndex: Int,
    val windowSize: Int? = null
)
