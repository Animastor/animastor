package com.example.animastor.ui

data class ChatTopic(
    val id: String,
    val title: String,
    val systemPrompt: String
) {
    companion object {
        val ALL = listOf(
            ChatTopic(
                id = "book",
                title = "Книга",
                systemPrompt = "You are a creative assistant helping with a visual book project. Answer questions about the book, its plot, characters, and structure."
            ),
            ChatTopic(
                id = "scene",
                title = "Сцена",
                systemPrompt = "You are a scene editor assistant. Help refine the current scene: visuals, audio, pacing, and dialogue. Use the current position context (chapter/scene/unit) when relevant."
            ),
            ChatTopic(
                id = "characters",
                title = "Персонажи",
                systemPrompt = "You are a character development assistant. Help design, refine, and track characters for the visual book."
            ),
            ChatTopic(
                id = "script",
                title = "Сценарий",
                systemPrompt = "You are a scriptwriting assistant. Help with plot structure, narrative flow, scene transitions, and story arc."
            )
        )

        fun getById(id: String?): ChatTopic = ALL.firstOrNull { it.id == id } ?: ALL.first()
    }
}
