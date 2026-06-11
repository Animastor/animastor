package com.example.animastor.repository

data class GenerateResponse(
    val book_id: String,
    val build_id: String? = null,
    val chunk_ids: List<String>,
    val mode: String? = null  // "audio" | "storyboard" | "full"
)
