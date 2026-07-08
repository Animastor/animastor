package com.example.animastor.repository

import okhttp3.MultipartBody
import okhttp3.ResponseBody
import retrofit2.http.*

interface BackendApi {

    @Multipart
    @POST("/api/v1/book/import")
    suspend fun importBook(
        @Part file: MultipartBody.Part
    ): ImportResponse

    @GET("/api/v1/chunk/{id}")
    suspend fun getChunk(
        @Path("id") id: String
    ): ChunkResponse

    @GET("/api/v1/book/{bookId}/chunks")
    suspend fun getAllChunks(
        @Path("bookId") bookId: String
    ): ChunkListResponse

    @Streaming
    @GET("/api/v1/chunk/{id}/audio")
    suspend fun getChunkAudio(
        @Path("id") id: String
    ): ResponseBody

    @Streaming
    @GET("/api/v1/chunk/{id}/image")
    suspend fun getChunkImage(
        @Path("id") id: String
    ): ResponseBody

    @Streaming
    @GET("/api/v1/chunk/{id}/video")
    suspend fun getChunkVideo(
        @Path("id") id: String
    ): ResponseBody

    @GET("/api/v1/chunk/{id}/storyboard")
    suspend fun getChunkStoryboard(
        @Path("id") id: String
    ): StoryboardResponse

    @Streaming
    @GET("/api/v1/iu-image/{bookId}/{chapterId}/{sceneId}/{iuId}")
    suspend fun getIuImage(
        @Path("bookId") bookId: String,
        @Path("chapterId") chapterId: String,
        @Path("sceneId") sceneId: String,
        @Path("iuId") iuId: String,
        @Query("build_id") buildId: String
    ): ResponseBody

    @Streaming
    @GET("/api/v1/preview/{bookId}/{chapterId}/{sceneId}/{iuId}")
    suspend fun getIuPreview(
        @Path("bookId") bookId: String,
        @Path("chapterId") chapterId: String,
        @Path("sceneId") sceneId: String,
        @Path("iuId") iuId: String,
        @Query("build_id") buildId: String
    ): ResponseBody

    @POST("/api/v1/ai/chat")
    suspend fun chatWithAi(
        @Body request: AiChatRequest
    ): AiChatResponse

    @GET("/api/v1/ai/sessions")
    suspend fun listSessions(
        @Query("book_id") bookId: String
    ): SessionListResponse

    @POST("/api/v1/ai/sessions")
    suspend fun createSession(
        @Body request: CreateSessionRequest
    ): SessionResponse

    @PATCH("/api/v1/ai/sessions/{sessionId}")
    suspend fun updateSession(
        @Path("sessionId") sessionId: String,
        @Body body: Map<String, String>
    ): SessionResponse

    @DELETE("/api/v1/ai/sessions/{sessionId}")
    suspend fun deleteSession(
        @Path("sessionId") sessionId: String
    ): GenericResponse

    @GET("/api/v1/ai/sessions/{sessionId}/messages")
    suspend fun getSessionMessages(
        @Path("sessionId") sessionId: String
    ): SessionMessagesResponse

    @GET("/api/v1/worker/counts")
    suspend fun getWorkerCounts(): WorkerCounts

    @GET("/api/v1/book/{bookId}/cover")
    suspend fun getBookCover(
        @Path("bookId") bookId: String
    ): CoverData

    @GET("/api/v1/book/{bookId}")
    suspend fun getBook(
        @Path("bookId") bookId: String
    ): BookData

    @PUT("/api/v1/book/{bookId}")
    suspend fun updateBook(
        @Path("bookId") bookId: String,
        @Body bookData: BookData
    )

    @PATCH("/api/v1/book/{bookId}/scene/{chapterId}/{sceneId}")
    suspend fun patchScene(
        @Path("bookId") bookId: String,
        @Path("chapterId") chapterId: String,
        @Path("sceneId") sceneId: String,
        @Body body: Map<String, @JvmSuppressWildcards Any?>
    ): GenericResponse

    @Streaming
    @GET("/api/v1/book/{bookId}/export")
    suspend fun exportBook(
        @Path("bookId") bookId: String,
        @Query("build_id") buildId: String
    ): ResponseBody

    @Streaming
    @GET("/api/v1/book/{bookId}/download")
    suspend fun downloadBook(
        @Path("bookId") bookId: String
    ): ResponseBody

    @Streaming
    @GET("/api/v1/book/{bookId}/storyboard")
    suspend fun downloadStoryboard(
        @Path("bookId") bookId: String,
        @Query("build_id") buildId: String
    ): ResponseBody

    @Streaming
    @GET("/api/v1/book/{bookId}/audio")
    suspend fun downloadAudio(
        @Path("bookId") bookId: String,
        @Query("build_id") buildId: String
    ): ResponseBody

    @POST("/api/v1/book/{bookId}/diff")
    suspend fun diffBook(
        @Path("bookId") bookId: String,
        @Body request: DiffRequest
    ): DiffResponse

    @POST("/api/v1/book/{bookId}/regenerate")
    suspend fun regenerateBook(
        @Path("bookId") bookId: String,
        @Body request: RegenerateRequest
    ): RegenerateResponse

    @POST("/api/v1/book/{bookId}/regenerate")
    suspend fun regenerateBookScoped(
        @Path("bookId") bookId: String,
        @Body request: RegenerateScope
    ): RegenerateResponse

    @GET("/api/v1/book/{bookId}/layer-config")
    suspend fun getLayerConfig(
        @Path("bookId") bookId: String
    ): LayerConfigResponse

    @PUT("/api/v1/book/{bookId}/layer-config")
    suspend fun putLayerConfig(
        @Path("bookId") bookId: String,
        @Body update: LayerConfigUpdate
    ): LayerConfigResponse

    @GET("/api/v1/book/{bookId}/assets-state")
    suspend fun getAssetsState(
        @Path("bookId") bookId: String,
        @Query("scope") scope: String? = null,
        @Query("chapter_id") chapterId: String? = null,
        @Query("scene_id") sceneId: String? = null
    ): AssetsStateResponse

    @POST("/api/v1/book/{bookId}/snapshot")
    suspend fun snapshotBook(
        @Path("bookId") bookId: String
    ): GenericResponse

    @POST("/api/v1/book/{bookId}/reorder")
    suspend fun reorderBook(
        @Path("bookId") bookId: String,
        @Body request: ReorderRequest
    ): ReorderResponse

    @HTTP(method = "DELETE", path = "/api/v1/book/{bookId}/cache", hasBody = false)
    suspend fun clearBookCache(
        @Path("bookId") bookId: String
    ): GenericResponse

    @HTTP(method = "DELETE", path = "/api/v1/book/{bookId}", hasBody = false)
    suspend fun deleteBook(
        @Path("bookId") bookId: String
    ): GenericResponse

    @POST("/api/v1/book/{bookId}/slide-window")
    suspend fun slideWindow(
        @Path("bookId") bookId: String
    ): SlideWindowResponse

    @POST("/api/v1/book/{bookId}/cancel-generation")
    suspend fun cancelGeneration(
        @Path("bookId") bookId: String
    ): GenericResponse

    // Audio Timeline

    @Streaming
    @GET("/api/v1/scene/{bookId}/{chapterId}/{sceneId}/audio")
    suspend fun getSceneAudio(
        @Path("bookId") bookId: String,
        @Path("chapterId") chapterId: String,
        @Path("sceneId") sceneId: String,
        @Query("build_id") buildId: String
    ): ResponseBody

    @GET("/api/v1/scene/{bookId}/{chapterId}/{sceneId}/waveform")
    suspend fun getSceneWaveform(
        @Path("bookId") bookId: String,
        @Path("chapterId") chapterId: String,
        @Path("sceneId") sceneId: String,
        @Query("build_id") buildId: String
    ): WaveformData

    @GET("/api/v1/scene/{bookId}/{chapterId}/{sceneId}/timings")
    suspend fun getSceneTimings(
        @Path("bookId") bookId: String,
        @Path("chapterId") chapterId: String,
        @Path("sceneId") sceneId: String,
        @Query("build_id") buildId: String
    ): SceneTiming

    @PUT("/api/v1/scene/{bookId}/{chapterId}/{sceneId}/timings")
    suspend fun updateSceneTimings(
        @Path("bookId") bookId: String,
        @Path("chapterId") chapterId: String,
        @Path("sceneId") sceneId: String,
        @Body request: TimingsUpdateRequest
    ): TimingsUpdateResponse

    // ======================================================
    // TXT Import / Lazy Book Endpoints
    // ======================================================

    @POST("/api/v1/book/{bookId}/bootstrap")
    suspend fun bootstrapBook(
        @Path("bookId") bookId: String
    ): BootstrapResponse

    @GET("/api/v1/book/{bookId}/agent-status")
    suspend fun getAgentStatus(
        @Path("bookId") bookId: String
    ): AgentStatusResponse

    @POST("/api/v1/book/{bookId}/bootstrap-next-window")
    suspend fun bootstrapNextWindow(
        @Path("bookId") bookId: String
    ): BootstrapNextWindowResponse

    @POST("/api/v1/book/{bookId}/resume-bootstrap")
    suspend fun resumeBootstrap(
        @Path("bookId") bookId: String
    ): ResumeBootstrapResponse

    @GET("/api/v1/book/{bookId}/status")
    suspend fun getBookStatus(
        @Path("bookId") bookId: String
    ): BookStatus

    @POST("/api/v1/book/{bookId}/trigger-next-window")
    suspend fun triggerNextWindow(
        @Path("bookId") bookId: String,
        @Body request: TriggerNextWindowRequest
    ): TriggerNextWindowResponse

    @GET("/api/v1/book/{bookId}/progress-panel")
    suspend fun getProgressPanel(
        @Path("bookId") bookId: String,
        @Query("scope") scope: String? = null,
        @Query("chapter_id") chapterId: String? = null,
        @Query("scene_id") sceneId: String? = null
    ): ProgressPanelResponse

    @GET("/api/v1/book/{bookId}/generation-state")
    suspend fun getGenerationState(
        @Path("bookId") bookId: String
    ): GenerationStateResponse

    @GET("/api/v1/book/{bookId}/text-index")
    suspend fun getTextIndex(
        @Path("bookId") bookId: String
    ): TextIndex

    @GET("/api/v1/book/{bookId}/preliminary")
    suspend fun getPreliminary(
        @Path("bookId") bookId: String
    ): PreliminaryAnalysis

    @GET("/api/v1/book/{bookId}/chapters-summary")
    suspend fun getChaptersSummary(
        @Path("bookId") bookId: String
    ): ChaptersSummary

    @POST("/api/v1/book/{bookId}/lazy-parse")
    suspend fun lazyParse(
        @Path("bookId") bookId: String,
        @Body request: LazyParseRequest? = null
    ): LazyParseResponse

    @POST("/api/v1/book/{bookId}/lazy-parse-to")
    suspend fun lazyParseTo(
        @Path("bookId") bookId: String,
        @Body request: LazyParseToRequest
    ): LazyParseToResponse

    @Streaming
    @GET("/api/v1/book/{bookId}/source")
    suspend fun getSourceText(
        @Path("bookId") bookId: String
    ): ResponseBody

    // ======================================================
    // Connector Registry API (Stage 1)
    // ======================================================

    @GET("/api/v1/connectors")
    suspend fun getConnectors(): ConnectorListResponse

    @GET("/api/v1/connectors/{name}")
    suspend fun getConnectorDetail(
        @Path("name") name: String
    ): ConnectorDetail

    @GET("/api/v1/connectors/{name}/compatibility")
    suspend fun getConnectorCompatibility(
        @Path("name") name: String
    ): CompatibilityStatus

    @GET("/api/v1/connectors/{name}/raw")
    suspend fun getConnectorRaw(
        @Path("name") name: String
    ): Map<String, Any>

    @POST("/api/v1/connectors/validate")
    suspend fun validateConnector(
        @Body body: Map<String, Any>
    ): ConnectorValidationResult

    @POST("/api/v1/connectors/reload")
    suspend fun reloadConnectors(): ConnectorReloadResult

    @GET("/api/v1/connectors/entities")
    suspend fun getConnectorEntities(
        @Query("kind") kind: String? = null
    ): EntitySchemaResponse

    @GET("/api/v1/connectors/grouped")
    suspend fun getConnectorsGrouped(): ConnectorGroupedResponse

    @PUT("/api/v1/connectors/{name}/parameters")
    suspend fun putConnectorParameter(
        @Path("name") name: String,
        @Body body: UpdateParameterRequest
    ): UpdateParameterResponse

    @GET("/api/v1/connectors/{name}/parameters")
    suspend fun getConnectorParameterValues(
        @Path("name") name: String
    ): ConnectorParameterValues

    @PUT("/api/v1/connectors/{name}/status")
    suspend fun putConnectorStatus(
        @Path("name") name: String,
        @Body body: ConnectorStatusRequest
    ): ConnectorStatusResponse

    @PUT("/api/v1/connectors/{name}/bindings")
    suspend fun putConnectorBinding(
        @Path("name") name: String,
        @Body body: UpdateBindingRequest
    ): UpdateBindingResponse

    @POST("/api/v1/connectors")
    suspend fun addConnector(
        @Body body: AddConnectorRequest
    ): AddConnectorResponse

    // ======================================================
    // Workflow Status API (Stage 1)
    // ======================================================

    @GET("/api/v1/workflows")
    suspend fun getWorkflows(): WorkflowListResponse

    @GET("/api/v1/workflows/{name}")
    suspend fun getWorkflowDetail(
        @Path("name") name: String
    ): WorkflowDetail

    @GET("/api/v1/workflows/{name}/hash")
    suspend fun getWorkflowHash(
        @Path("name") name: String
    ): WorkflowHashResponse

    @GET("/api/v1/workflows/summary")
    suspend fun getWorkflowSummary(): WorkflowSummaryResponse
}
