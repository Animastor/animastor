package com.example.animastor.repository

data class LoadVbookResponse(
    val book_id: String,
    val build_id: String? = null,
    val title: String? = null,
    val chapter_count: Int = 0,
    val scene_count: Int = 0,
    val was_existing: Boolean = false
)
