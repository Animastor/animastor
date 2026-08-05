package com.example.animastor.repository

/**
 * GET /api/v1/config — backend-served editor limits.
 *
 * The limit is served from the backend so the editor enforces the SAME value
 * the server validates on save (core-routes.cjs prompt guard). If it later
 * becomes a user-configurable setting (Settings screen), the endpoint can read
 * it from a settings store — this model stays unchanged.
 */
data class AppConfig(
    val limits: Limits? = null
)

data class Limits(
    // Max chars for a frame prompt (image.prompt / video.action).
    val image_prompt_max_chars: Int? = null
)
