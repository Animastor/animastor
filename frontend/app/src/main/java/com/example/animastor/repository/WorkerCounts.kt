package com.example.animastor.repository

data class WorkerCounts(
    val audio: Int = 0,
    val image: Int = 0,
    val video: Int = 0,
    val active_audio: Int = 0,
    val active_image: Int = 0,
    val active_video: Int = 0
)
