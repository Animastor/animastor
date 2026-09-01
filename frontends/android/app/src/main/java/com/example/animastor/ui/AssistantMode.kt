package com.example.animastor.ui

import com.example.animastor.R

/**
 * AI assistant modes.
 * systemPrompt removed in F6 — now assembled server-side by chatEngine.buildChatSystemPrompt().
 * The frontend only keeps display properties (titles, descriptions, icons) for the UI.
 *
 * [soon] marks future-feature modes: their handler-less tools were removed from
 * the backend, so the chip stays visible but dimmed + disabled — selecting it
 * must never send a request. Parity: web MODES[].soon (AiAssistantPage).
 */
enum class AssistantMode(
    val id: String,
    val titleRes: Int,
    val descriptionRes: Int,
    val englishTitle: String,
    val soon: Boolean = false
) {
    CONVERSATION(
        id = "conversation",
        titleRes = R.string.ai_mode_conversation,
        descriptionRes = R.string.ai_mode_conversation_desc,
        englishTitle = "Chat"
    ),
    EDIT(
        id = "edit",
        titleRes = R.string.ai_mode_edit,
        descriptionRes = R.string.ai_mode_edit_desc,
        englishTitle = "Edit"
    ),
    IMPORT(
        id = "import",
        titleRes = R.string.ai_mode_import,
        descriptionRes = R.string.ai_mode_import_desc,
        englishTitle = "Import",
        soon = true
    ),
    DIRECTOR(
        id = "director",
        titleRes = R.string.ai_mode_director,
        descriptionRes = R.string.ai_mode_director_desc,
        englishTitle = "Director",
        soon = true
    ),
    EXTRACTION(
        id = "extraction",
        titleRes = R.string.ai_mode_extraction,
        descriptionRes = R.string.ai_mode_extraction_desc,
        englishTitle = "Extract",
        soon = true
    ),
    VALIDATION(
        id = "validation",
        titleRes = R.string.ai_mode_validation,
        descriptionRes = R.string.ai_mode_validation_desc,
        englishTitle = "Validate",
        soon = true
    );

    companion object {
        val ALL = entries.toList()

        fun getById(id: String): AssistantMode =
            // Soon-modes (future features) can never become the active mode —
            // a stored session carrying such a mode falls back to CONVERSATION.
            ALL.firstOrNull { it.id == id }?.takeUnless { it.soon } ?: CONVERSATION

        fun default(): AssistantMode = CONVERSATION
    }
}
