package com.example.animastor.repository

import com.google.gson.annotations.SerializedName

data class AiChatRequest(
    val messages: List<AiMessage>,
    val bookId: String? = null,
    val lang: String? = null,
    val system: String? = null,
    val mode: String? = null,
    val sceneId: String? = null,
    val characterId: String? = null,
    val sessionId: String? = null
)

data class AiMessage(
    val role: String,
    val content: String
) : java.io.Serializable

data class AiChatResponse(
    val reply: String,
    @SerializedName("book_edited") val bookEdited: Boolean = false,
    @SerializedName("book_id") val bookId: String? = null
)
