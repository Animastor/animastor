package com.example.animastor.repository

/**
 * Per-chunk position within the book (chapter + scene).
 * Server-populated in the getAllChunks response so the client never needs
 * N individual getChunkStoryboard calls just to find the cover or build
 * the position map (F9 audit).
 */
data class ChunkPosition(
    val chapter_id: String? = null,
    val scene_id: String? = null
)

data class ChunkListResponse(
    val chunk_ids: List<String>,
    val total: Int = 0,
    val total_scenes: Int = 0,
    val started_scenes: Int = 0,
    val ready_scenes: Int = 0,
    val next_idx: Int = 0,
    /** ID of the cover chunk (chunk whose scene_type === "cover"), if any. */
    val cover_chunk_id: String? = null,
    /** Map of chunkId → {chapter_id, scene_id} — server-populated to avoid N requests. */
    val chunk_positions: Map<String, ChunkPosition?>? = null
)
