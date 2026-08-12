package com.example.animastor.repository

import com.google.gson.annotations.SerializedName

data class ChatSessionApi(
    @SerializedName("id") val sessionId: String,
    @SerializedName("book_id") val bookId: String = "",
    val title: String = "",
    @SerializedName("mode") val mode: String = "chat",
    @SerializedName("topic_id") val topicId: String = "",
    @SerializedName("message_count") val messageCount: Int = 0,
    @SerializedName("created_at") val createdAt: Long = 0,
    @SerializedName("updated_at") val updatedAt: Long = 0
)

data class SessionListResponse(
    val sessions: List<ChatSessionApi>
)

data class SessionResponse(
    val session: ChatSessionApi
)

data class CreateSessionRequest(
    @SerializedName("book_id") val bookId: String,
    val title: String? = null,
    @SerializedName("topic_id") val topicId: String? = null,
    val mode: String? = null
)

data class SessionMessagesResponse(
    val messages: List<SessionMessageApi>
)

data class SessionMessageApi(
    val id: Long,
    @SerializedName("book_id") val bookId: String,
    @SerializedName("session_id") val sessionId: String? = null,
    @SerializedName("scene_id") val sceneId: String? = null,
    val role: String,
    val message: String,
    @SerializedName("created_at") val createdAt: Long = 0
)
