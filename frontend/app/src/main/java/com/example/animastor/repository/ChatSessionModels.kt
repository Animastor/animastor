package com.example.animastor.repository

import com.google.gson.annotations.SerializedName

data class ChatSessionApi(
    @SerializedName("sessionId") val sessionId: String,
    @SerializedName("bookId") val bookId: String,
    @SerializedName("title") val title: String,
    @SerializedName("topicId") val topicId: String,
    @SerializedName("mode") val mode: String,
    @SerializedName("messageCount") val messageCount: Int = 0,
    @SerializedName("createdAt") val createdAt: Long = 0,
    @SerializedName("updatedAt") val updatedAt: Long = 0
)

data class SessionListResponse(
    val sessions: List<ChatSessionApi>
)

data class SessionResponse(
    val session: ChatSessionApi
)

data class CreateSessionRequest(
    val bookId: String,
    val title: String? = null,
    val topicId: String? = null,
    val mode: String? = null
)

data class SessionMessagesResponse(
    val messages: List<SessionMessageApi>
)

data class SessionMessageApi(
    val id: Long,
    @SerializedName("bookId") val bookId: String,
    @SerializedName("sessionId") val sessionId: String? = null,
    @SerializedName("sceneId") val sceneId: String? = null,
    val role: String,
    val message: String,
    @SerializedName("createdAt") val createdAt: Long = 0
)
