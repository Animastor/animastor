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
    val private_active_video: Int = 0,
    // PHYSICAL union for UI counters (web parity 57b1e26c): system pool ∪
    // the caller's OWN private workers, each PHYSICAL worker counted ONCE
    // (deduplicated by worker_id server-side). Never sum audio+private_audio:
    // per D3 a policy-active private worker appears in BOTH the system and
    // private capacity buckets but is ONE physical unit. Sharing grants
    // access to an existing worker — it never creates a new one. Null when
    // the backend predates the field — the client falls back to the raw sum.
    val available_audio: Int? = null,
    val available_image: Int? = null,
    val available_video: Int? = null,
    val available_active_audio: Int? = null,
    val available_active_image: Int? = null,
    val available_active_video: Int? = null
)

