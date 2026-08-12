package com.example.animastor.repository

data class ReorderRequest(
    val chapters: List<ReorderChapter>
)

data class ReorderChapter(
    val chapter: String,
    val scenes: List<String>
)

data class ReorderResponse(
    val ok: Boolean = false,
    val book_id: String? = null,
    val chapter_count: Int = 0
)
