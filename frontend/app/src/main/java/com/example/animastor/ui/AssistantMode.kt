package com.example.animastor.ui

import com.example.animastor.R

enum class AssistantMode(
    val id: String,
    val titleRes: Int,
    val descriptionRes: Int,
    val englishTitle: String,
    val systemPrompt: String
) {
    CONVERSATION(
        id = "conversation",
        titleRes = R.string.ai_mode_conversation,
        descriptionRes = R.string.ai_mode_conversation_desc,
        englishTitle = "Chat",
        systemPrompt = "You are a creative assistant in Conversational mode. Answer questions, discuss ideas, explain concepts, and brainstorm. Do NOT make any changes to the book — this is a read-only discussion."
    ),
    IMPORT(
        id = "import",
        titleRes = R.string.ai_mode_import,
        descriptionRes = R.string.ai_mode_import_desc,
        englishTitle = "Import",
        systemPrompt = "You are an Import specialist. Convert arbitrary text into Animastor book structure. Analyze the text and automatically determine chapters, scenes, and units. If a book is already open, decide whether the text is a new chapter, continuation of current chapter, or extension of current scene. If no book is open, create a new book with manifest, metadata, chapters, scenes, and units. The user must NOT manually mark chapters/scenes/units — determine the structure from content. Always produce a valid Animastor book JSON."
    ),
    EDIT(
        id = "edit",
        titleRes = R.string.ai_mode_edit,
        descriptionRes = R.string.ai_mode_edit_desc,
        englishTitle = "Edit",
        systemPrompt = "You are an Editor. You can modify scenes, characters, locations, objects, and book structure. Use the `edit_book` tool to apply changes. Always confirm changes with the user before applying."
    ),
    DIRECTOR(
        id = "director",
        titleRes = R.string.ai_mode_director,
        descriptionRes = R.string.ai_mode_director_desc,
        englishTitle = "Director",
        systemPrompt = "You are a Film Director. Advise on camera angles, composition, lighting, mood, and atmosphere for scenes. You can write into storyboard_elements for the current scene. Think visually and cinematically."
    ),
    EXTRACTION(
        id = "extraction",
        titleRes = R.string.ai_mode_extraction,
        descriptionRes = R.string.ai_mode_extraction_desc,
        englishTitle = "Extract",
        systemPrompt = "You are an Extraction specialist. Extract structured entities from the text such as characters, objects, locations, and key terms."
    ),
    VALIDATION(
        id = "validation",
        titleRes = R.string.ai_mode_validation,
        descriptionRes = R.string.ai_mode_validation_desc,
        englishTitle = "Validate",
        systemPrompt = "You are a Validation specialist. Check book JSON for correctness, completeness, and integrity. Verify required fields, cross-references, scene links, and data consistency. Return a list of violations with severity levels."
    );

    companion object {
        val ALL = entries.toList()

        fun getById(id: String): AssistantMode =
            ALL.firstOrNull { it.id == id } ?: CONVERSATION

        fun default(): AssistantMode = CONVERSATION
    }
}
