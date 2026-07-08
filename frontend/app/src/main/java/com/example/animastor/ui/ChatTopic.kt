package com.example.animastor.ui

import com.example.animastor.R

/**
 * AI chat topics.
 * systemPrompt removed in F6 — now assembled server-side by chatEngine.buildChatSystemPrompt().
 * The frontend only keeps display properties (titles) for the UI chips.
 */
data class ChatTopic(
    val id: String,
    val titleRes: Int,
    val englishTitle: String
) {
    companion object {
        val ALL = listOf(
            ChatTopic(
                id = "book",
                titleRes = R.string.ai_topic_book,
                englishTitle = "Book"
            ),
            ChatTopic(
                id = "scene",
                titleRes = R.string.ai_topic_scene,
                englishTitle = "Scene"
            ),
            ChatTopic(
                id = "characters",
                titleRes = R.string.ai_topic_characters,
                englishTitle = "Characters"
            ),
            ChatTopic(
                id = "script",
                titleRes = R.string.ai_topic_script,
                englishTitle = "Script"
            )
        )

        fun getById(id: String?): ChatTopic = ALL.firstOrNull { it.id == id } ?: ALL.first()
    }
}
