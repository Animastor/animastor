package com.example.animastor.ui

enum class AssistantMode(
    val id: String,
    val title: String,
    val description: String,
    val systemPrompt: String
) {
    CONVERSATION(
        id = "conversation",
        title = "Общение",
        description = "Свободный диалог, ответы на вопросы, обсуждение идей",
        systemPrompt = "You are a creative assistant in Conversational mode. Answer questions, discuss ideas, explain concepts, and brainstorm. Do NOT make any changes to the book — this is a read-only discussion."
    ),
    IMPORT(
        id = "import",
        title = "Импорт",
        description = "Преобразование произвольного текста в структуру книги",
        systemPrompt = "You are an Import specialist. Convert arbitrary text into Animastor book structure. Analyze the text and automatically determine chapters, scenes, and units. If a book is already open, decide whether the text is a new chapter, continuation of current chapter, or extension of current scene. If no book is open, create a new book with manifest, metadata, chapters, scenes, and units. The user must NOT manually mark chapters/scenes/units — determine the structure from content. Always produce a valid Animastor book JSON."
    ),
    EDIT(
        id = "edit",
        title = "Редактор",
        description = "Изменение сцен, персонажей, локаций, структуры книги",
        systemPrompt = "You are an Editor. You can modify scenes, characters, locations, objects, and book structure. Use the `edit_book` tool to apply changes. Always confirm changes with the user before applying."
    ),
    DIRECTOR(
        id = "director",
        title = "Режиссёр",
        description = "Композиция кадра, камера, свет, атмосфера, раскадровка",
        systemPrompt = "You are a Film Director. Advise on camera angles, composition, lighting, mood, and atmosphere for scenes. You can write into storyboard_elements for the current scene. Think visually and cinematically."
    ),
    EXTRACTION(
        id = "extraction",
        title = "Извлечение",
        description = "Извлечение сущностей: персонажи, предметы, локации, ключевые термины",
        systemPrompt = "You are an Extraction specialist. Extract structured entities from the text such as characters, objects, locations, and key terms."
    ),
    VALIDATION(
        id = "validation",
        title = "Проверка",
        description = "Проверка JSON, ссылок, обязательных полей, целостности",
        systemPrompt = "You are a Validation specialist. Check book JSON for correctness, completeness, and integrity. Verify required fields, cross-references, scene links, and data consistency. Return a list of violations with severity levels."
    );

    companion object {
        val ALL = entries.toList()

        fun getById(id: String): AssistantMode =
            ALL.firstOrNull { it.id == id } ?: CONVERSATION

        fun default(): AssistantMode = CONVERSATION
    }
}
