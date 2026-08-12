package com.example.animastor.repository

data class DiffRequest(
    val new_book: BookData
)

data class DiffResponse(
    val book_id: String? = null,
    val summary: DiffSummary? = null,
    val dirty_scenes: List<DirtyScene>? = null,
    val reindex_needed: Boolean = false
)

data class DiffSummary(
    val total_scenes_old: Int = 0,
    val total_scenes_new: Int = 0,
    val changed: Int = 0,
    val added: Int = 0,
    val removed: Int = 0
)

data class DirtyScene(
    val chapter_id: String? = null,
    val scene_id: String? = null,
    val dirty_layers: List<String>? = null,
    val changes: Map<String, Any>? = null
)

data class RegenerateRequest(
    val new_book: BookData? = null,
    val rebuild_all: Boolean = false,
    val worker_types: List<String>? = null,
    val scope: String? = null,
    val chapter_id: String? = null,
    val scene_id: String? = null
)

data class GenericResponse(
    val ok: Boolean = false,
    val book_id: String? = null
)

data class RegenerateResponse(
    val book_id: String? = null,
    val build_id: String? = null,
    val message: String? = null,
    val dirty_scenes: List<DirtyScene>? = null,
    val summary: DiffSummary? = null,
    val rebuild_all: Boolean = false,
    val scope: String? = null,
    val tasks: List<GenerationTaskRef> = emptyList()
)

data class GenerationTaskRef(
    val task_id: String = "",
    val type: String = "",
    val target_count: Int = 0
)
