package com.example.animastor.repository

import com.google.gson.JsonDeserializationContext
import com.google.gson.JsonDeserializer
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.google.gson.annotations.JsonAdapter
import com.google.gson.annotations.SerializedName
import java.lang.reflect.Type

data class BookData(
    val manifest: Manifest? = null,
    val book: BookMeta? = null,
    val bible: Bible? = null,
    val characters: List<CharDef>? = null,
    val chapters: List<Chapter>? = null
)

data class Manifest(
    val vbook_version: String? = null,
    val book_id: String? = null,
    val locked: Boolean? = null,
    val build_id: String? = null,
    val created_at: String? = null,
    val seed: Int? = null,
    val mode: String? = null,
    val render: RenderConfig? = null
)

data class RenderConfig(
    val mode: String? = null,
    val pipeline: String? = null,
    val fps: Int? = null,
    val resolution: String? = null
)

@JsonAdapter(BookMetaAdapter::class)
data class BookMeta(
    val book_id: String? = null,
    val version: String? = null,
    val title: String? = null,
    val author: String? = null
)

class BookMetaAdapter : JsonDeserializer<BookMeta> {
    override fun deserialize(json: JsonElement, typeOfT: Type, context: JsonDeserializationContext): BookMeta {
        val obj = json.asJsonObject
        return BookMeta(
            book_id = obj.string("book_id"),
            version = obj.string("version"),
            title = obj.titleText(),
            author = obj.string("author")
        )
    }
    private fun JsonObject.string(key: String): String? =
        get(key)?.takeIf { it is JsonPrimitive }?.asString

    private fun JsonObject.titleText(): String? {
        val el = get("title") ?: return null
        if (el is JsonPrimitive) return el.asString
        if (el is JsonObject) {
            el.get("subtitle")?.let { if (it is JsonPrimitive) return it.asString }
            el.get("main")?.let { if (it is JsonPrimitive) return it.asString }
        }
        return null
    }
}

data class Bible(
    val version: String? = null,
    val narrator: Narrator? = null,
    val locations: Map<String, Location>? = null,
    val render_rules: RenderRules? = null
)

data class Narrator(
    val voice: VoiceConfig? = null
)

data class VoiceConfig(
    val instruction: String? = null
)

data class Location(
    val id: String? = null,
    val name: String? = null,
    val description: String? = null,
    val visual_style: String? = null,
    val cinematic_space: String? = null,
    val default_mood: String? = null
)

data class RenderRules(
    val style: String? = null,
    val lighting_default: String? = null,
    val character_consistency: Boolean? = null,
    val spatial_consistency: Boolean? = null
)

data class CharDef(
    val id: String? = null,
    val name: String? = null,
    val voice_id: String? = null
)

data class Chapter(
    val chapter: String? = null,
    val chapter_title: String? = null,
    val type: String? = null,
    val scenes: List<Scene>? = null,
    /** Programmatic chapter intro metadata (not a narrative scene) */
    val intro: ChapterIntro? = null,
    /** Server-computed display number (1-based, excludes cover/prologue). */
    val display_number: Int? = null
)

data class ChapterIntro(
    val text: String? = null,
    val scene_title: String? = null,
    val style: String? = null
)

data class Scene(
    val scene_id: String? = null,
    val scene_title: String? = null,
    val type: String? = null,
    val style: String? = null,
    val location: LocationData? = null,
    val participants: List<String>? = null,
    val audio: AudioConfig? = null,
    val units: List<SceneUnit>? = null,
    /** Server-computed display index (1-based within chapter). */
    val display_index: Int? = null
)



// ======================================================
// Lazy Book Models (TXT import)
// ======================================================

data class ImportTxtResponse(
    val book_id: String,
    val title: String? = null,
    val author: String? = null,
    val language: String? = null,
    val state: String? = null,
    val characters: Int = 0,
    val locations: Int = 0,
    val scenes: Int = 0,
    val dedup: Boolean = false,
    val message: String? = null
)

data class BookStatus(
    val bookId: String? = null,
    val state: String? = null,
    val source: String? = null,
    val title: String? = null,
    val author: String? = null,
    val language: String? = null,
    val hasSource: Boolean = false,
    val hasCharacters: Boolean = false,
    val hasBible: Boolean = false,
    val totalChapters: Int = 0,
    val parsedChapters: Int = 0,
    val totalScenes: Int = 0,
    val parsedScenes: Int = 0,
    val characterCount: Int = 0,
    val locationCount: Int = 0,
    val sourceSize: Int = 0,
    val updatedAt: String? = null
)

data class TextIndexChapter(
    val index: Int = 0,
    val title: String? = null,
    val startLine: Int = 0,
    val endLine: Int = 0,
    val startOffset: Int = 0,
    val endOffset: Int = 0,
    val length: Int = 0
)

data class TextIndexPart(
    val index: Int = 0,
    val title: String? = null,
    val startLine: Int = 0,
    val endLine: Int = 0
)

data class TextIndex(
    val totalLength: Int = 0,
    val totalLines: Int = 0,
    val lineCount: Int = 0,
    val chapters: List<TextIndexChapter> = emptyList(),
    val parts: List<TextIndexPart> = emptyList()
)

data class ChapterSummary(
    val index: Int = 0,
    val title: String? = null,
    val startLine: Int = 0,
    val endLine: Int = 0,
    val status: String? = null,
    val chapterId: String? = null,
    val sceneCount: Int? = null,
    val sceneTitles: List<String>? = null
)

data class SourceChapter(
    val index: Int = 0,
    val title: String? = null,
    val startLine: Int = 0,
    val endLine: Int = 0,
    val startOffset: Int = 0,
    val endOffset: Int = 0,
    val length: Int = 0
)

data class SourceChaptersResponse(
    val chapters: List<SourceChapter> = emptyList(),
    val total: Int = 0
)

data class ChaptersSummary(
    val bookId: String? = null,
    val state: String? = null,
    val totalChapters: Int = 0,
    val parsedChapters: Int = 0,
    val chapters: List<ChapterSummary> = emptyList()
)

data class BootstrapResponse(
    val book_id: String? = null,
    val title: String? = null,
    val author: String? = null,
    val language: String? = null,
    val state: String? = null,
    val characters: Int = 0,
    val locations: Int = 0,
    val scenes: Int = 0,
    val chapters: List<LazyParseChapterItem>? = null
)

data class LazyParseChapterItem(
    val chapter: String? = null,
    val chapter_title: String? = null,
    val chapter_index: Int = 0,
    val status: String? = null,
    val scene_count: Int = 0
)

data class LazyParseResponse(
    val parsed: Int = 0,
    val window_start: Int = -1,
    val window_end: Int = -1,
    val complete: Boolean = false,
    val chapters: List<LazyParseChapterItem> = emptyList()
)

data class LazyParseToResponse(
    val chapter: LazyBookChapter? = null,
    val was_existing: Boolean = false,
    val pre_parsed_ahead: Int = 0
)

data class AgentStatusResponse(
    val active: Boolean = false,
    val session_id: String? = null,
    val session_status: String? = null,
    val progress_msg: String? = null,
    val source_type: String? = null,
    val window_index: Int? = null,
    val created_scenes: Int? = null,
    val total_scenes: Int? = null,
    val remaining_cached: Int? = null,
    /** Backend scene cap; used only as fallback when exact block counters are absent. */
    val window_size: Int? = null,
    val window_start_scene: Int? = null,
    val window_total_scenes: Int? = null,
    val window_scene_index: Int? = null,
    /** Machine-readable step type from agent_steps (e.g. "create_scenes", "polish_storyboard").
     * Language-independent — used by the frontend to decide cyclic vs scene-counter progress. */
    val step_type: String? = null,
)

data class BootstrapNextWindowResponse(
    val book_id: String? = null,
    val title: String? = null,
    val state: String? = null,
    val characters: Int = 0,
    val locations: Int = 0,
    val scenes: Int = 0,
    val added_scenes: Int = 0,
    val remaining_cached: Int = 0,
    val all_done: Boolean = false,
    val cached: Boolean = false,
    val session_id: String? = null,
    val chapters: List<LazyParseChapterItem>? = null
)

data class ResumeBootstrapResponse(
    val book_id: String? = null,
    val state: String? = null,
    val title: String? = null,
    val author: String? = null,
    val characters: Int = 0,
    val locations: Int = 0,
    val scenes: Int = 0,
    val session_id: String? = null,
    val session_status: String? = null,
    val progress_msg: String? = null,
    val message: String? = null
)

data class LazyBookChapter(
    val chapter: String? = null,
    val chapter_title: String? = null,
    val type: String? = null,
    val chapter_index: Int = 0,
    val status: String? = null,
    val scenes: List<Scene>? = null
)

data class PreliminaryAnalysis(
    val title: String? = null,
    val author: String? = null,
    val description: String? = null,
    val language: String? = null,
    val genre: String? = null,
    val characters: List<PreliminaryCharacter>? = null,
    val locations: List<PreliminaryLocation>? = null,
    val worldObjects: List<PreliminaryObject>? = null,
    val worldDescription: String? = null,
    val estimatedChapterCount: Int = 0,
    val analysisTimestamp: String? = null
)

data class PreliminaryCharacter(
    val id: String? = null,
    val name: String? = null,
    val mentionCount: Int = 0,
    val role: String? = null,
    val description: String? = null
)

data class PreliminaryLocation(
    val id: String? = null,
    val name: String? = null,
    val type: String? = null,
    val description: String? = null
)

data class PreliminaryObject(
    val id: String? = null,
    val name: String? = null,
    val type: String? = null,
    val description: String? = null
)

// ======================================================
// Progress Panel Models (server-computed worker list, F2)
// ======================================================

data class ProgressPanelResponse(
    val book_id: String = "",
    val profile: String? = null,
    val workers: List<ProgressWorker> = emptyList(),
    val overall_percent: Int = 0,
    val any_incomplete: Boolean = false
)

data class ProgressWorker(
    val type: String = "",
    val ready: Int = 0,
    val total: Int = 0,
    val percent: Int = 0,
    val done: Boolean = false,
    val visible: Boolean = true,
    val indeterminate: Boolean = false
)

// ======================================================
// Window Generation Models
// ======================================================

data class TriggerNextWindowRequest(
    val chapter_id: String? = null,
    val scene_id: String? = null,
    val unit_id: String? = null,
    val register_for_gpu: Boolean? = null
)

data class TriggerNextWindowResponse(
    val triggered: Boolean = false,
    val queued: Boolean = false,
    val session_id: String? = null,
    val window_index: Int? = null,
    val all_done: Boolean = false,
    val error: String? = null
)

data class GenerationStateResponse(
    val book_id: String? = null,
    val last_window_index: Int = -1,
    val status: String? = null,
    val active_session_id: String? = null,
    val active_window_index: Int? = null,
    val active_status: String? = null,
    val error: String? = null,
    val has_more: Boolean = false,
    val total_chapters: Int = 0,
    val parsed_chapters: Int = 0,
    val remaining: Int = 0
)



data class LocationData(
    val id: String? = null,
    val environment: EnvironmentData? = null
)

data class EnvironmentData(
    val time: String? = null,
    val lighting: String? = null,
    val weather: String? = null,
    val mood: String? = null,
    val atmosphere: String? = null
)

data class AudioConfig(
    val voice: String? = null,
    val full_text: String? = null
)

data class SceneUnit(
    val id: String? = null,
    val type: String? = null,
    val text: String? = null,
    val participants: List<String>? = null,
    val visual: VisualConfig? = null
)

@JsonAdapter(VisualConfigAdapter::class)
data class VisualConfig(
    val prompt: String? = null,
    val negative: String? = null,
    val quality: String? = null,
    val shot: String? = null,
    val focus: String? = null,
    val lip_sync: Boolean? = null,
    val character_binding: Boolean? = null,
    val text_render: Boolean? = null,
    val style: String? = null,
    val lighting: String? = null,
    val variation: String? = null
)

// ======================================================
// Cover Data (from cover.json)
// ======================================================

data class CoverData(
    val scene_id: String? = null,
    val scene_title: String? = null,
    val type: String? = null,
    val style: String? = null,
    val title: String? = null,
    val author: String? = null,
    val participants: List<String>? = null,
    val audio: AudioConfig? = null,
    val units: List<SceneUnit>? = null
)

fun BookData.chapterIndex(chapterId: String?): Int {
    if (chapterId == null) return 0
    chapters?.forEachIndexed { i, ch ->
        if (ch.chapter == chapterId) return i + 1
    }
    return 0
}

fun BookData.sceneIndex(chapterId: String?, sceneId: String?): Int {
    if (chapterId == null || sceneId == null) return 0
    chapters?.forEach { ch ->
        if (ch.chapter == chapterId) {
            ch.scenes?.forEachIndexed { i, sc ->
                if (sc.scene_id == sceneId) return i + 1
            }
        }
    }
    return 0
}

fun BookData.unitIndex(chapterId: String?, sceneId: String?, unitOffset: Int): Int {
    if (chapterId == null || sceneId == null) return 0
    chapters?.forEach { ch ->
        if (ch.chapter == chapterId) {
            ch.scenes?.forEach { sc ->
                if (sc.scene_id == sceneId) return unitOffset + 1
            }
        }
    }
    return 0
}

class VisualConfigAdapter : JsonDeserializer<VisualConfig> {
    override fun deserialize(json: JsonElement, typeOfT: Type, context: JsonDeserializationContext): VisualConfig {
        val obj = json.asJsonObject
        return VisualConfig(
            prompt = obj.primitive("prompt"),
            negative = obj.primitive("negative"),
            quality = obj.primitive("quality"),
            shot = obj.primitive("shot"),
            focus = obj.primitive("focus"),
            lip_sync = obj.bool("lip_sync"),
            character_binding = obj.bool("character_binding"),
            text_render = obj.bool("text_render"),
            style = obj.primitive("style"),
            lighting = obj.primitive("lighting"),
            variation = obj.primitive("variation")
        )
    }
    private fun JsonObject.primitive(key: String): String? =
        get(key)?.takeIf { it is JsonPrimitive }?.asString
    private fun JsonObject.bool(key: String): Boolean? =
        get(key)?.takeIf { it is JsonPrimitive }?.asBoolean
}
