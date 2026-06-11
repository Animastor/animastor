package com.example.animastor.repository

data class SceneTiming(
    val units: List<IuTimingBoundary>,
    val total_duration_ms: Long
)

data class IuTimingBoundary(
    val unit_id: String,
    val scene_order: Int,
    val start_ms: Long,
    val end_ms: Long,
    val estimated_duration_sec: Double,
    val text_proportion: Double
)

data class WaveformData(
    val peaks: List<WaveformPeak>,
    val duration_sec: Double,
    val peak_count: Int
)

data class WaveformPeak(
    val pos: Double,
    val neg: Double
)

data class TimingsUpdateRequest(
    val build_id: String,
    val units: List<TimingBoundary>
)

data class TimingBoundary(
    val unit_id: String,
    val start_ms: Long,
    val end_ms: Long
)

data class TimingsUpdateResponse(
    val units: List<TimingBoundary>,
    val recalculated: Boolean
)
