package com.example.animastor.ui

import com.example.animastor.repository.AiMessage
import com.example.animastor.repository.ChatSessionApi

// Lightweight UI model for a chat session displayed in the session list.
// Backed by the server-side chat_sessions table; no local JSON storage.
data class UiChatSession(
    val id: String,
    val title: String,
    val topicId: String = "book",
    val mode: String = "conversation",
    val messageCount: Int = 0,
    val updatedAt: Long = 0,
    val messages: List<ChatMessage> = emptyList(),
    val apiMessages: List<AiMessage> = emptyList()
) {
    companion object {
        fun fromApi(s: ChatSessionApi): UiChatSession = UiChatSession(
            id = s.sessionId,
            title = s.title,
            topicId = s.topicId,
            mode = s.mode,
            messageCount = s.messageCount,
            updatedAt = s.updatedAt
        )
    }
}
