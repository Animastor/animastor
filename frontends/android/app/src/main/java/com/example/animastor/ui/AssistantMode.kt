package com.example.animastor.ui

import com.example.animastor.R

/**
 * AI assistant modes.
 * systemPrompt removed in F6 — now assembled server-side by chatEngine.buildChatSystemPrompt().
 * The frontend only keeps display properties (titles, descriptions, icons) for the UI.
 */
enum class AssistantMode(
    val id: String,
    val titleRes: Int,
    val descriptionRes: Int,
    val englishTitle: String
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
        englishTitle = "Import"
    ),
    DIRECTOR(
        id = "director",
        titleRes = R.string.ai_mode_director,
        descriptionRes = R.string.ai_mode_director_desc,
        englishTitle = "Director"
    ),
    EXTRACTION(
        id = "extraction",
        titleRes = R.string.ai_mode_extraction,
        descriptionRes = R.string.ai_mode_extraction_desc,
        englishTitle = "Extract"
    ),
    VALIDATION(
        id = "validation",
        titleRes = R.string.ai_mode_validation,
        descriptionRes = R.string.ai_mode_validation_desc,
        englishTitle = "Validate"
    );

    companion object {
        val ALL = entries.toList()

        fun getById(id: String): AssistantMode =
            ALL.firstOrNull { it.id == id } ?: CONVERSATION

        fun default(): AssistantMode = CONVERSATION
    }
}
