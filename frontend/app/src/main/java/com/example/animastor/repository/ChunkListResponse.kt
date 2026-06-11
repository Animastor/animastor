package com.example.animastor.repository

data class ChunkListResponse(
    val chunk_ids: List<String>,
    val total: Int = 0,
    val total_scenes: Int = 0,
    val started_scenes: Int = 0,
    val ready_scenes: Int = 0,
    val next_idx: Int = 0
)
