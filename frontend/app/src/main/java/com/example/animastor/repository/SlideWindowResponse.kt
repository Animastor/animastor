package com.example.animastor.repository

data class SlideWindowResponse(
    val ok: Boolean,
    val book_id: String,
    val started: Int,
    val remaining: Int,
    val reason: String? = null,
    val total_scenes: Int = 0,
    val started_scenes: Int = 0,
    val ready_scenes: Int = 0,
    val next_idx: Int = 0
)
