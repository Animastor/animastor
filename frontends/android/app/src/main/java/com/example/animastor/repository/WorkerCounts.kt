package com.example.animastor.repository

data class WorkerCounts(
    val audio: Int = 0,
    val image: Int = 0,
    val video: Int = 0,
    val vbook: Int = 0,
    val active_audio: Int = 0,
    val active_image: Int = 0,
    val active_video: Int = 0,
    val active_vbook: Int = 0,
    val active_scenes: Int = 0,
    // The caller's OWN private workers (visibility isolation — Experimental
    // Beta). The global audio/image/video fields carry the system/shared pool
    // ONLY; private workers are reported separately and never mixed in.
    val private_audio: Int = 0,
    val private_image: Int = 0,
    val private_video: Int = 0,
    val private_active_audio: Int = 0,
    val private_active_image: Int = 0,
    val private_active_video: Int = 0
)

