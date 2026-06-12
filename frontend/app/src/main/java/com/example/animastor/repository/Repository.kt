package com.example.animastor.repository

import android.util.Log
import android.util.LruCache
import com.example.animastor.util.SimpleDiskCache
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import retrofit2.HttpException
import java.io.File
import java.io.IOException

class Repository(
    private val api: BackendApi,
    diskCache: SimpleDiskCache? = null
) {
    private val cache = LruCache<String, ByteArray>(50 * 1024 * 1024)
    private val diskCache: SimpleDiskCache? = diskCache

    suspend fun generate(file: File, imageEnabled: Boolean = true): GenerateResponse {
        Log.i("Repo", "generate: ${file.name} img=$imageEnabled")
        val requestFile = file.asRequestBody()
        val multipart = MultipartBody.Part.createFormData("file", file.name, requestFile)
        return try {
            val response = api.generate(multipart, imageEnabled)
            if (response.chunk_ids.isEmpty()) {
                Log.w("Repo", "generate: empty chunk_ids")
                throw RuntimeException("No chunks returned")
            }
            Log.i("Repo", "generate OK: book=${response.book_id} build=${response.build_id} chunks=${response.chunk_ids.size}")
            response
        } catch (e: HttpException) {
            val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            val backendMsg = if (errorBody != null) {
                try { JSONObject(errorBody).optString("error", e.message()) } catch (_: Exception) { e.message() }
            } else {
                e.message()
            }
            Log.w("Repo", "generate FAILED (${e.code()}): $backendMsg")
            throw IOException(backendMsg ?: "Generate failed (${e.code()})")
        }
    }

    /**
     * Load a vbook file on the backend WITHOUT auto-starting the generation
     * pipeline. The endpoint parses the bundle, saves the book to disk (or
     * keeps the existing edited version), and returns metadata. The client
     * must explicitly call /regenerate later to start generation.
     */
    suspend fun loadVbook(file: File): LoadVbookResponse {
        Log.i("Repo", "loadVbook: ${file.name}")
        val requestFile = file.asRequestBody()
        val multipart = MultipartBody.Part.createFormData("file", file.name, requestFile)
        return try {
            val response = api.loadVbook(multipart)
            Log.i("Repo", "loadVbook OK: book=${response.book_id} build=${response.build_id} chapters=${response.chapter_count} scenes=${response.scene_count} existing=${response.was_existing}")
            response
        } catch (e: HttpException) {
            val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            val backendMsg = if (errorBody != null) {
                try { JSONObject(errorBody).optString("error", e.message()) } catch (_: Exception) { e.message() }
            } else {
                e.message()
            }
            Log.w("Repo", "loadVbook FAILED (${e.code()}): $backendMsg")
            throw IOException(backendMsg ?: "Load vbook failed (${e.code()})")
        }
    }

    suspend fun getChunk(id: String): ChunkResponse {
        val result = api.getChunk(id)
        Log.d("Repo", "getChunk $id: audio=${result.audio_ready} img=${result.image_ready} video=${result.video_ready}")
        return result
    }

    suspend fun getAllChunks(bookId: String): ChunkListResponse {
        Log.d("Repo", "getAllChunks: $bookId")
        return api.getAllChunks(bookId)
    }

    suspend fun getChunkAudio(id: String): ByteArray {
        val cacheKey = "audio_$id"
        cache.get(cacheKey)?.let { Log.d("Repo", "getChunkAudio $id: mem HIT"); return it }
        diskCache?.getFile(id, "audio")?.let { f ->
            val bytes = f.readBytes()
            cache.put(cacheKey, bytes)
            Log.d("Repo", "getChunkAudio $id: disk HIT")
            return bytes
        }
        Log.d("Repo", "getChunkAudio $id: fetching")
        return runCatching {
            val body = api.getChunkAudio(id)
            val bytes = body.bytes()
            cache.put(cacheKey, bytes)
            diskCache?.put(id, "audio", bytes, "mp3")
            Log.i("Repo", "getChunkAudio $id: ${bytes.size} bytes")
            bytes
        }.getOrElse {
            Log.e("Repo", "getChunkAudio $id FAILED: ${it.message}")
            throw IOException("Failed to fetch audio for chunk $id")
        }
    }

    suspend fun getChunkImage(id: String): ByteArray {
        val cacheKey = "image_$id"
        cache.get(cacheKey)?.let { Log.d("Repo", "getChunkImage $id: mem HIT"); return it }
        diskCache?.getFile(id, "image")?.let { f ->
            val bytes = f.readBytes()
            cache.put(cacheKey, bytes)
            Log.d("Repo", "getChunkImage $id: disk HIT")
            return bytes
        }
        Log.d("Repo", "getChunkImage $id: fetching")
        return runCatching {
            val body = api.getChunkImage(id)
            val bytes = body.bytes()
            cache.put(cacheKey, bytes)
            diskCache?.put(id, "image", bytes, "png")
            Log.i("Repo", "getChunkImage $id: ${bytes.size} bytes")
            bytes
        }.getOrElse {
            Log.e("Repo", "getChunkImage $id FAILED: ${it.message}")
            throw IOException("Failed to fetch image for chunk $id")
        }
    }

    suspend fun getChunkVideo(id: String): ByteArray {
        val cacheKey = "video_$id"
        cache.get(cacheKey)?.let { return it }
        diskCache?.getFile(id, "video")?.let { f ->
            val bytes = f.readBytes()
            cache.put(cacheKey, bytes)
            Log.d("Repo", "getChunkVideo $id: disk HIT")
            return bytes
        }
        return runCatching {
            val body = api.getChunkVideo(id)
            val bytes = body.bytes()
            cache.put(cacheKey, bytes)
            diskCache?.put(id, "video", bytes, "mp4")
            Log.i("Repo", "getChunkVideo $id: ${bytes.size} bytes")
            bytes
        }.getOrElse { throw IOException("Failed to fetch video for chunk $id") }
    }

    suspend fun getChunkStoryboard(id: String): StoryboardResponse {
        Log.d("Repo", "getChunkStoryboard: $id")
        return api.getChunkStoryboard(id)
    }

    suspend fun getIuImage(bookId: String, chapterId: String, sceneId: String, iuId: String, buildId: String): ByteArray {
        val cacheKey = "iu_${bookId}_${chapterId}_${sceneId}_${iuId}"
        cache.get(cacheKey)?.let { return it }
        val dk = "iu/${bookId}/${chapterId}/${sceneId}/${iuId}"
        diskCache?.getFile(dk, "iu")?.let { f ->
            val bytes = f.readBytes()
            cache.put(cacheKey, bytes)
            Log.d("Repo", "getIuImage $iuId: disk HIT")
            return bytes
        }
        return runCatching {
            val body = api.getIuImage(bookId, chapterId, sceneId, iuId, buildId)
            val bytes = body.bytes()
            cache.put(cacheKey, bytes)
            diskCache?.put(dk, "iu", bytes, "png")
            Log.i("Repo", "getIuImage $iuId: ${bytes.size} bytes")
            bytes
        }.getOrElse {
            Log.e("Repo", "getIuImage $iuId FAILED: ${it.message}")
            throw IOException("Failed to fetch IU image for $iuId")
        }
    }

    suspend fun getIuPreview(bookId: String, chapterId: String, sceneId: String, iuId: String, buildId: String): ByteArray? {
        val cacheKey = "pr_${bookId}_${chapterId}_${sceneId}_${iuId}"
        cache.get(cacheKey)?.let { return it }
        val dk = "preview/${bookId}/${chapterId}/${sceneId}/${iuId}"
        diskCache?.getFile(dk, "preview")?.let { f ->
            val bytes = f.readBytes()
            cache.put(cacheKey, bytes)
            Log.d("Repo", "getIuPreview $iuId: disk HIT")
            return bytes
        }
        return runCatching {
            val body = api.getIuPreview(bookId, chapterId, sceneId, iuId, buildId)
            val bytes = body.bytes()
            cache.put(cacheKey, bytes)
            diskCache?.put(dk, "preview", bytes, "png")
            Log.i("Repo", "getIuPreview $iuId: ${bytes.size} bytes")
            bytes
        }.getOrNull()
    }

    suspend fun getBook(bookId: String): BookData {
        Log.d("Repo", "getBook: $bookId")
        return api.getBook(bookId)
    }

    suspend fun updateBook(bookId: String, bookData: BookData) {
        Log.d("Repo", "updateBook: $bookId")
        api.updateBook(bookId, bookData)
    }

    suspend fun chatWithAiFull(request: AiChatRequest): AiChatResponse {
        Log.d("Repo", "chatWithAiFull: ${request.messages.size} messages")
        val response = api.chatWithAi(request)
        Log.i("Repo", "chatWithAiFull OK: ${response.reply.take(50)}...")
        return response
    }

    suspend fun listSessions(bookId: String): List<ChatSessionApi> {
        Log.d("Repo", "listSessions: $bookId")
        return runCatching {
            api.listSessions(bookId).sessions
        }.getOrDefault(emptyList())
    }

    suspend fun createSession(bookId: String, title: String? = null, topicId: String? = null, mode: String? = null): ChatSessionApi {
        Log.d("Repo", "createSession: $bookId")
        return api.createSession(CreateSessionRequest(bookId, title, topicId, mode)).session
    }

    suspend fun updateSessionTitle(sessionId: String, title: String) {
        Log.d("Repo", "updateSessionTitle: $sessionId → $title")
        api.updateSession(sessionId, mapOf("title" to title))
    }

    suspend fun deleteSession(sessionId: String) {
        Log.d("Repo", "deleteSession: $sessionId")
        api.deleteSession(sessionId)
    }

    suspend fun getSessionMessages(sessionId: String): List<SessionMessageApi> {
        Log.d("Repo", "getSessionMessages: $sessionId")
        return runCatching {
            api.getSessionMessages(sessionId).messages
        }.getOrDefault(emptyList())
    }

    suspend fun exportBookStream(bookId: String, buildId: String, destFile: File, onProgress: ((Float) -> Unit)? = null): File {
        Log.i("Repo", "exportBook: $bookId build=$buildId")
        try {
            val body = api.exportBook(bookId, buildId)
            val total = body.contentLength()
            val input = body.byteStream()
            val output = destFile.outputStream()
            var read = 0L
            val buffer = ByteArray(8192)
            var n: Int
            while (input.read(buffer).also { n = it } >= 0) {
                output.write(buffer, 0, n)
                read += n
                if (total > 0) onProgress?.invoke(read.toFloat() / total.toFloat())
            }
            output.close()
            Log.i("Repo", "exportBook done: ${destFile.length()} bytes")
            return destFile
        } catch (e: retrofit2.HttpException) {
            val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            throw IOException(errorBody ?: "Export failed (${e.code()})")
        }
    }

    suspend fun downloadStoryboardStream(bookId: String, buildId: String, destFile: File, onProgress: ((Float) -> Unit)? = null): File {
        Log.i("Repo", "downloadStoryboard: $bookId build=$buildId")
        try {
            val body = api.downloadStoryboard(bookId, buildId)
            val total = body.contentLength()
            val input = body.byteStream()
            val output = destFile.outputStream()
            var read = 0L
            val buffer = ByteArray(8192)
            var n: Int
            while (input.read(buffer).also { n = it } >= 0) {
                output.write(buffer, 0, n)
                read += n
                if (total > 0) onProgress?.invoke(read.toFloat() / total.toFloat())
            }
            output.close()
            Log.i("Repo", "downloadStoryboard done: ${destFile.length()} bytes")
            return destFile
        } catch (e: retrofit2.HttpException) {
            val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            throw IOException(errorBody ?: "Storyboard download failed (${e.code()})")
        }
    }

    suspend fun downloadAudioStream(bookId: String, buildId: String, destFile: File, onProgress: ((Float) -> Unit)? = null): File {
        Log.i("Repo", "downloadAudio: $bookId build=$buildId")
        try {
            val body = api.downloadAudio(bookId, buildId)
            val total = body.contentLength()
            val input = body.byteStream()
            val output = destFile.outputStream()
            var read = 0L
            val buffer = ByteArray(8192)
            var n: Int
            while (input.read(buffer).also { n = it } >= 0) {
                output.write(buffer, 0, n)
                read += n
                if (total > 0) onProgress?.invoke(read.toFloat() / total.toFloat())
            }
            output.close()
            Log.i("Repo", "downloadAudio done: ${destFile.length()} bytes")
            return destFile
        } catch (e: retrofit2.HttpException) {
            val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            throw IOException(errorBody ?: "Audio download failed (${e.code()})")
        }
    }

    suspend fun downloadBookStream(bookId: String, destFile: File, onProgress: ((Float) -> Unit)? = null): File {
        Log.i("Repo", "downloadBook: $bookId")
        try {
            val body = api.downloadBook(bookId)
            val total = body.contentLength()
            val input = body.byteStream()
            val output = destFile.outputStream()
            var read = 0L
            val buffer = ByteArray(8192)
            var n: Int
            while (input.read(buffer).also { n = it } >= 0) {
                output.write(buffer, 0, n)
                read += n
                if (total > 0) onProgress?.invoke(read.toFloat() / total.toFloat())
            }
            output.close()
            Log.i("Repo", "downloadBook done: ${destFile.length()} bytes")
            return destFile
        } catch (e: retrofit2.HttpException) {
            val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            throw IOException(errorBody ?: "Download failed (${e.code()})")
        }
    }

    suspend fun diffBook(bookId: String, newBook: BookData): DiffResponse {
        Log.d("Repo", "diffBook: $bookId")
        return api.diffBook(bookId, DiffRequest(new_book = newBook))
    }

    suspend fun regenerateBook(bookId: String, newBook: BookData? = null, rebuildAll: Boolean = false): RegenerateResponse {
        Log.i("Repo", "regenerateBook: $bookId rebuildAll=$rebuildAll hasNewBook=${newBook != null}")
        return api.regenerateBook(bookId, RegenerateRequest(new_book = newBook, rebuild_all = rebuildAll))
    }

    suspend fun regenerateBookScoped(
        bookId: String,
        newBook: BookData? = null,
        rebuildAll: Boolean = false,
        profile: String? = null,
        scope: String? = null,
        chapterId: String? = null,
        sceneId: String? = null
    ): RegenerateResponse {
        Log.i("Repo", "regenerateBookScoped: $bookId profile=$profile scope=$scope ch=$chapterId sc=$sceneId")
        return api.regenerateBookScoped(bookId, RegenerateScope(
            new_book = newBook,
            rebuild_all = rebuildAll,
            profile = profile,
            scope = scope,
            chapter_id = chapterId,
            scene_id = sceneId
        ))
    }

    suspend fun getLayerConfig(bookId: String): LayerConfigResponse {
        Log.d("Repo", "getLayerConfig: $bookId")
        return api.getLayerConfig(bookId)
    }

    suspend fun putLayerConfig(bookId: String, update: LayerConfigUpdate): LayerConfigResponse {
        Log.i("Repo", "putLayerConfig: $bookId update=$update")
        return api.putLayerConfig(bookId, update)
    }

    suspend fun getAssetsState(
        bookId: String,
        scope: String? = null,
        chapterId: String? = null,
        sceneId: String? = null
    ): AssetsStateResponse {
        Log.d("Repo", "getAssetsState: $bookId scope=$scope chapter=$chapterId scene=$sceneId")
        return api.getAssetsState(bookId, scope, chapterId, sceneId)
    }

    suspend fun snapshotBook(bookId: String) {
        Log.d("Repo", "snapshotBook: $bookId")
        api.snapshotBook(bookId)
    }

    suspend fun reorderBook(bookId: String, chapters: List<ReorderChapter>): ReorderResponse {
        Log.d("Repo", "reorderBook: $bookId chapters=${chapters.size}")
        return api.reorderBook(bookId, ReorderRequest(chapters))
    }

    fun cacheAudioFile(chunkId: String, bytes: ByteArray): File? {
        return diskCache?.put(chunkId, "audio", bytes, "mp3")
    }

    fun cacheVideoFile(chunkId: String, bytes: ByteArray): File? {
        return diskCache?.put(chunkId, "video", bytes, "mp4")
    }

    fun clearCache() {
        cache.evictAll()
        diskCache?.evictAll()
    }

    suspend fun getWorkerCounts(): WorkerCounts {
        Log.d("Repo", "getWorkerCounts")
        return api.getWorkerCounts()
    }

    suspend fun clearBookCache(bookId: String) {
        api.clearBookCache(bookId)
    }

    suspend fun slideWindow(bookId: String): SlideWindowResponse {
        Log.i("Repo", "slideWindow: $bookId")
        return api.slideWindow(bookId)
    }

    suspend fun cancelGeneration(bookId: String) {
        Log.i("Repo", "cancelGeneration: $bookId")
        api.cancelGeneration(bookId)
    }

    suspend fun getSceneAudio(bookId: String, chapterId: String, sceneId: String, buildId: String): ByteArray {
        val cacheKey = "sceneaudio_${bookId}_${chapterId}_${sceneId}"
        cache.get(cacheKey)?.let { return it }
        diskCache?.getFile("${bookId}_${chapterId}_${sceneId}", "sceneaudio")?.let { f ->
            val bytes = f.readBytes()
            cache.put(cacheKey, bytes)
            return bytes
        }
        val body = api.getSceneAudio(bookId, chapterId, sceneId, buildId)
        val bytes = body.bytes()
        cache.put(cacheKey, bytes)
        diskCache?.put("${bookId}_${chapterId}_${sceneId}", "sceneaudio", bytes, "mp3")
        return bytes
    }

    suspend fun getSceneWaveform(bookId: String, chapterId: String, sceneId: String, buildId: String): WaveformData {
        return api.getSceneWaveform(bookId, chapterId, sceneId, buildId)
    }

    suspend fun getSceneTimings(bookId: String, chapterId: String, sceneId: String, buildId: String): SceneTiming {
        return api.getSceneTimings(bookId, chapterId, sceneId, buildId)
    }

    suspend fun updateSceneTimings(
        bookId: String, chapterId: String, sceneId: String, buildId: String,
        unitBoundaries: List<TimingBoundary>
    ): TimingsUpdateResponse {
        return api.updateSceneTimings(bookId, chapterId, sceneId,
            TimingsUpdateRequest(buildId, unitBoundaries))
    }

    // ======================================================
    // TXT Import / Lazy Book Methods
    // ======================================================

    suspend fun importTxt(file: File): ImportTxtResponse {
        Log.i("Repo", "importTxt: ${file.name}")
        val requestFile = file.asRequestBody()
        val multipart = MultipartBody.Part.createFormData("file", file.name, requestFile)
        return try {
            val response = api.importTxt(multipart)
            Log.i("Repo", "importTxt OK: book=${response.book_id} state=${response.state}")
            response
        } catch (e: HttpException) {
            val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            val backendMsg = if (errorBody != null) {
                try { JSONObject(errorBody).optString("error", e.message()) } catch (_: Exception) { e.message() }
            } else {
                e.message()
            }
            Log.w("Repo", "importTxt FAILED (${e.code()}): $backendMsg")
            throw IOException(backendMsg ?: "Import TXT failed (${e.code()})")
        }
    }

    suspend fun bootstrapBook(bookId: String): BootstrapResponse {
        Log.i("Repo", "bootstrapBook: $bookId")
        return try {
            val response = api.bootstrapBook(bookId)
            Log.i("Repo", "bootstrapBook OK: ${response.characters} chars, ${response.locations} locs, ${response.scenes} scenes")
            response
        } catch (e: HttpException) {
            val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            val backendMsg = if (errorBody != null) {
                try { JSONObject(errorBody).optString("error", e.message()) } catch (_: Exception) { e.message() }
            } else {
                e.message()
            }
            Log.w("Repo", "bootstrapBook FAILED (${e.code()}): $backendMsg")
            throw IOException(backendMsg ?: "Bootstrap failed (${e.code()})")
        }
    }

    suspend fun getAgentStatus(bookId: String): AgentStatusResponse {
        return try {
            api.getAgentStatus(bookId)
        } catch (e: Exception) {
            Log.w("Repo", "getAgentStatus failed: ${e.message}")
            AgentStatusResponse(active = false)
        }
    }

    suspend fun bootstrapNextWindow(bookId: String): BootstrapNextWindowResponse {
        Log.i("Repo", "bootstrapNextWindow: $bookId")
        return try {
            val response = api.bootstrapNextWindow(bookId)
            Log.i("Repo", "bootstrapNextWindow OK: added=${response.added_scenes} cached=${response.cached} all_done=${response.all_done}")
            response
        } catch (e: HttpException) {
            val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            val backendMsg = if (errorBody != null) {
                try { JSONObject(errorBody).optString("error", e.message()) } catch (_: Exception) { e.message() }
            } else {
                e.message()
            }
            Log.w("Repo", "bootstrapNextWindow FAILED (${e.code()}): $backendMsg")
            throw IOException(backendMsg ?: "Bootstrap next window failed (${e.code()})")
        }
    }

    suspend fun importText(text: String, title: String? = null): ImportTxtResponse {
        Log.i("Repo", "importText: text=${text.length} chars title=$title")
        return try {
            val response = api.importText(ImportTextRequest(text = text, title = title))
            Log.i("Repo", "importText OK: book=${response.book_id}")
            response
        } catch (e: HttpException) {
            val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            val backendMsg = if (errorBody != null) {
                try { JSONObject(errorBody).optString("error", e.message()) } catch (_: Exception) { e.message() }
            } else {
                e.message()
            }
            Log.w("Repo", "importText FAILED (${e.code()}): $backendMsg")
            throw IOException(backendMsg ?: "Import text failed (${e.code()})")
        }
    }

    suspend fun resumeBootstrap(bookId: String): ResumeBootstrapResponse {
        Log.i("Repo", "resumeBootstrap: $bookId")
        return try {
            val response = api.resumeBootstrap(bookId)
            Log.i("Repo", "resumeBootstrap OK: state=${response.state} session=${response.session_id} msg=${response.progress_msg}")
            response
        } catch (e: HttpException) {
            val errorBody = try { e.response()?.errorBody()?.string() } catch (_: Exception) { null }
            val backendMsg = if (errorBody != null) {
                try { JSONObject(errorBody).optString("error", e.message()) } catch (_: Exception) { e.message() }
            } else {
                e.message()
            }
            Log.w("Repo", "resumeBootstrap FAILED (${e.code()}): $backendMsg")
            throw IOException(backendMsg ?: "Resume bootstrap failed (${e.code()})")
        }
    }

    suspend fun getLazyBookStatus(bookId: String): BookStatus {
        Log.d("Repo", "getLazyBookStatus: $bookId")
        return api.getBookStatus(bookId)
    }

    suspend fun getTextIndex(bookId: String): TextIndex {
        Log.d("Repo", "getTextIndex: $bookId")
        return api.getTextIndex(bookId)
    }

    suspend fun getPreliminary(bookId: String): PreliminaryAnalysis {
        Log.d("Repo", "getPreliminary: $bookId")
        return api.getPreliminary(bookId)
    }

    suspend fun getChaptersSummary(bookId: String): ChaptersSummary {
        Log.d("Repo", "getChaptersSummary: $bookId")
        return api.getChaptersSummary(bookId)
    }

    suspend fun lazyParse(bookId: String, windowSize: Int? = null): LazyParseResponse {
        Log.i("Repo", "lazyParse: $bookId windowSize=$windowSize")
        return api.lazyParse(bookId, if (windowSize != null) LazyParseRequest(windowSize) else null)
    }

    suspend fun lazyParseTo(bookId: String, chapterIndex: Int, windowSize: Int? = null): LazyParseToResponse {
        Log.i("Repo", "lazyParseTo: $bookId chapter=$chapterIndex windowSize=$windowSize")
        return api.lazyParseTo(bookId, LazyParseToRequest(chapterIndex = chapterIndex, windowSize = windowSize))
    }

    suspend fun getSourceText(bookId: String): String {
        Log.d("Repo", "getSourceText: $bookId")
        val body = api.getSourceText(bookId)
        return body.string()
    }

    // ======================================================
    // Window Generation (trigger + state)
    // ======================================================

    suspend fun triggerNextWindow(bookId: String, chapterId: String? = null, sceneId: String? = null, unitId: String? = null, registerForGpu: Boolean? = null): TriggerNextWindowResponse {
        Log.i("Repo", "triggerNextWindow: $bookId ch=$chapterId sc=$sceneId register_for_gpu=$registerForGpu")
        return try {
            val response = api.triggerNextWindow(bookId, TriggerNextWindowRequest(
                chapter_id = chapterId,
                scene_id = sceneId,
                unit_id = unitId,
                register_for_gpu = registerForGpu,
            ))
            Log.i("Repo", "triggerNextWindow: triggered=${response.triggered} queued=${response.queued} window=${response.window_index} all_done=${response.all_done}")
            response
        } catch (e: Exception) {
            Log.w("Repo", "triggerNextWindow failed: ${e.message}")
            TriggerNextWindowResponse(triggered = false, error = e.message)
        }
    }

    suspend fun getGenerationState(bookId: String): GenerationStateResponse {
        Log.d("Repo", "getGenerationState: $bookId")
        return try {
            api.getGenerationState(bookId)
        } catch (e: Exception) {
            Log.w("Repo", "getGenerationState failed: ${e.message}")
            GenerationStateResponse(book_id = bookId, status = "error", error = e.message)
        }
    }
}
