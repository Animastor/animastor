package com.example.animastor.ui

import com.example.animastor.R

data class ChatTopic(
    val id: String,
    val titleRes: Int,
    val englishTitle: String,
    val systemPrompt: String
) {
    companion object {
        val ALL = listOf(
            ChatTopic(
                id = "book",
                titleRes = R.string.ai_topic_book,
                englishTitle = "Book",
                systemPrompt = "You are a creative assistant helping with a visual book project. Answer questions about the book, its plot, characters, and structure."
            ),
            ChatTopic(
                id = "scene",
                titleRes = R.string.ai_topic_scene,
                englishTitle = "Scene",
                systemPrompt = "You are a scene editor assistant. Help refine the current scene: visuals, audio, pacing, and dialogue. Use the current position context (chapter/scene/unit) when relevant."
            ),
            ChatTopic(
                id = "characters",
                titleRes = R.string.ai_topic_characters,
                englishTitle = "Characters",
                systemPrompt = "You are a character development assistant. Help design, refine, and track characters for the visual book."
            ),
            ChatTopic(
                id = "script",
                titleRes = R.string.ai_topic_script,
                englishTitle = "Script",
                systemPrompt = "You are a scriptwriting assistant. Help with plot structure, narrative flow, scene transitions, and story arc."
            )
        )

        fun getById(id: String?): ChatTopic = ALL.firstOrNull { it.id == id } ?: ALL.first()
    }
}
