package com.example.animastor.repository

import com.google.gson.annotations.SerializedName

data class AiChatRequest(
    val messages: List<AiMessage>,
    @SerializedName("book_id") val bookId: String? = null,
    val lang: String? = null,
    val system: String? = null,
    val mode: String? = null,
    @SerializedName("scene_id") val sceneId: String? = null,
    @SerializedName("character_id") val characterId: String? = null,
    @SerializedName("session_id") val sessionId: String? = null
)

data class AiMessage(
    val role: String,
    val content: String
) : java.io.Serializable

data class AiChatResponse(
    val reply: String,
    @SerializedName("book_edited") val bookEdited: Boolean = false,
    @SerializedName("book_id") val bookId: String? = null,
    @SerializedName("session_id") val sessionId: String? = null
)
