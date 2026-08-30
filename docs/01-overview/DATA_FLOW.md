# Data Flow: Animastor

## Scenario 1: TXT File Import

**Request:** `POST /api/v1/book/import-txt` (multipart file upload)

**Components involved:**
1. `routes/book/import-routes.cjs` → Route handler (book-routes decomposition)
2. `txt-importer.js:decodeTxtBuffer()` → Decoding (UTF-8/CP1251)
3. `lazy-book.js:createDraftBook()` → Draft book creation (RAW_IMPORTED)
4. `book-source-repo.js:registerSource()` → PG registration

**Data flow:**
```
Client → [HTTP POST multipart] → book-routes
  → Buffer (TXT) → txtImporter.decodeTxtBuffer()
    → Encoding detection (encoding-detect.js)
    → Returns UTF-8 text
  → lazyBook.createDraftBook(sourceText, SourceType.TXT, title)
    → Creates manifest.json with bookId
    → Creates directory data/books/<bookId>/
    → Saves sourceText to source.txt
    → Saves book.json (metadata)
    → Sets state to RAW_IMPORTED
  → bookSourceRepo.registerSource(hash, filename, size, bookId, 'txt')
    → INSERT INTO book_sources
  → Response: { book_id, title, state: RAW_IMPORTED }
```

---

## Scenario 2: Bootstrap (AI Text Analysis)

**Request:** `POST /api/v1/book/:bookId/bootstrap`

**Components involved:**
1. `routes/book/import-routes.cjs` → Route handler (bootstrap)
2. `txt-importer.js:bootstrapImportedText()` → AI pipeline entry
3. `agent-service.js:bootstrapWithAgent()` → AI analysis

**Step-by-step chain:**
```
book-routes → txtImporter.bootstrapImportedText(bookId)
  → Cleanup artifacts from previous failed bootstraps
  → agentService.bootstrapWithAgent(bookId, progress)
    → createSession(bookId, 'txt_import')
      → INSERT INTO agent_sessions (status: running)
    
    → getWindowText() — text buffer from currentOffset (~1500 characters)
    
    → Step 0: stepAnalyzeStructure(text, bookId)
      → aiService.callAI() → structure { author, title, chapters }
      → Updates book.json (author, title, structure)
    
    → runPipeline() — 5 steps:
      → Step 1: stepExtractCharacters() → characters[]
      → Step 2: stepExtractLocations() → locations[]
      → Step 3: stepCreateScenes() → scenes[] (up to 3 scenes from buffer start)
        + title, location.id, environment-override (global location template vs scene)
        → resolveSceneProgress() → nextOffset from last created scene
        → Coverage validation (gap/overlap) + duration → on failure repair retry → fallback
      → Step 4: stepCreateUnits() per scene (without unit.participants — removed)
      → Step 5: stepCreateVisuals() per scene (inferCharactersFromPrompt)
    
    → lazyBook.createFromAnalysis() — saves:
      → characters.json, bible.json, chapters/*.json
      → Cover chapter (createCoverChapter + saveCoverChapter)
    
    → window_data.currentOffset = nextOffset, not plannedEndOffset
    → If text remains after nextOffset → paused (waits for next window)
    → If all done → completed
    
  → book-routes receives result
    → Creates Redis chunks for each scene
    → Creates placeholder audio
    → Response with bootstrap data
```

---

## Scenario 3: Scene Generation (Per-Asset Parallel Dispatch)

**Trigger:** Scene added to active-scenes index

**Key change (v2.1.0):** Linear FSM removed. All callbacks check per-asset state. `transitionSceneState` — direct write without validation. `decideStage` removed — dispatch engine always passes `overrideStage`.

**Components involved:**

### 3a: Runtime Scheduler Tick

```
runtime-scheduler.tick() [every 5 seconds]
  → acquireSchedulerTickLock()
  → activeScenes.getAllActiveSceneKeys()
  → For each scene: attemptDispatch()
    → shouldScheduleAssets() — CHECK PER-ASSET STATES
      → assetStates = getAssetStates() (audio/image/video)
      → layer config (audio_enabled/image_enabled/video_enabled)
      → PG version-stale check (if asset_version < scene_version)
      → Decision: which stages are ready for dispatch
      → Audio: not ready and not generating → dispatch
      → Image: not ready and not generating → dispatch (independent of audio!)
      → Video: not ready, not generating, image=ready → dispatch
      → per-asset: NEW/DIRTY/PENDING → dispatch; GENERATING/READY → skip
    → For each eligible stage:
      → dispatchEngine.dispatchStage(stage)
```

### 3b: Dispatch Engine

```
dispatchEngine.dispatchStage(redis, bookId, chapterId, sceneId, stage, loadedBook, buildId, { force })
  → Check circuit breaker (LIVE — direct require)
  → Check duplicate/lease (force=true → clears existing lease)
  → Acquire quota (atomic via Lua EVAL — eliminates GET+INCR race)
  → Check retry budget (LIVE — direct require)
  → Check fairness (LIVE — direct require)
  → Acquire stage lease (NX, TTL: audio 15min, image 20min, video 30min)
  → Clear dispatch-completed marker (for idempotent completion)
  → orchestrator.dispatchStage() with overrideStage
```

### 3c: Audio Generation (via Orchestrator Facade)

> **UPD 2026-06-28 (M5):** All lifecycle transitions go through `orchestrator.completeStage`.
> GENERATING is set in beginStage via scene-orchestrator (gap §5.1 FIXED).
> PG `scene_assets.status='ready'` is written in callbacks (C2 FIXED).

```
orchestrator.beginStage() → dispatchEngine.dispatchStage()
  → scene-orchestrator.executeAudioDispatch()
    → per-asset GENERATING (set)
    → audio.generateSceneAudio() → segments → gpu.send()
  → callback → task-handler → orchestrator.completeStage('audio')
    → scene-callbacks.handleAudioCompleted()
      → Per-asset check: audio GENERATING/PENDING/DIRTY
      → File validation
      → PG markReady('audio') — C2 FIXED
      → Placeholder replacement
    → Version gate: checks asset_version < scene_version
      → stale → DIRTY (force-regen not cancelled)
      → OK → setAssetState(READY) (syncLinearState removed — T8)
    → finally: markDispatchCompleted (release lease + quota, exactly once — C1/C4)
```

### 3d: Image Generation (independent from audio!)

> **UPD 2026-06-28:** version-stale check — explicit pre-pass in attemptDispatch() (D.2).
> Dirty unit IDs from PG passed to executeImageDispatch for targeted IU regeneration.

```
orchestrator.beginStage() → dispatchEngine.dispatchStage()
  → scene-orchestrator.executeImageDispatch()
    → per-asset GENERATING (set)
    → Read dirtyUnitIds from PG (for targeted IU regeneration)
    → image.generateSceneIUImages() → build prompts → gpu.send()
  → callback → task-handler (IU completion check)
    → saveIURegistry → check all IUs for scene
    → orchestrator.completeStage('image')
      → scene-callbacks.handleImageCompleted()
        → Per-asset check: image GENERATING/PENDING/DIRTY
        → PG markReady('image') — C2 FIXED
        → Cleanup only completed dirty unit IDs
        → Reset IU counter to actual file count
        → Clear in-flight markers
      → Version gate → READY or DIRTY
      → finally: markDispatchCompleted (release lease + quota)
```

### 3e: Video Generation (depends on IMAGE_READY)

> **UPD 2026-06-28:** Video — final stage. After READY → remove from active index + auto-slide.

```
orchestrator.beginStage() → dispatchEngine.dispatchStage()
  → scene-orchestrator.executeVideoDispatch()
    → per-asset GENERATING (set)
    → Check: image=READY? (asset states + chunk fallback)
    → video.generateVideoAnimation() → jobSpecs
    → gpu.sendUnified() for each group
  → callback → orchestrator.completeStage('video')
    → scene-callbacks.handleVideoCompleted()
      → Per-asset check: video GENERATING/PENDING/DIRTY
      → .mp4 file validation
      → PG markReady('video') — C2 FIXED
      → updateSceneVideoStatus → updateSceneChunks
      → clearDirtyFlag in PG
      → publishProgress
      → removeSceneFromActiveIndex
      → trySlideWindowOnComplete() → auto-slide
    → Version gate → READY or DIRTY
    → finally: markDispatchCompleted (release lease + quota)
```

---

## Scenario 4: Book Loading and Viewing (Android)

**Request:** `GET /api/v1/book/:bookId`

```
Android → [HTTP GET] → book-routes
  → book.loadBook(bookId)
    → Multi-file format: manifest.json + book.json + chapters/*.json
  → placeholderAudio.recoverMissingPlaceholders()
    → Check for MP3 files
    → Create missing placeholders
  → recoverMissingRedisChunks()
    → Check for Redis chunks for each scene
    → Create missing ones
  → Response: JSON book
    → Android: UI fragments render structure
```

---

## Scenario 5: AI Chat Assistant (Tool-Based)

**Request:** `POST /api/v1/ai/chat`

```
Android → [HTTP POST] → ai-routes
  → chatEngine.sendMessage(bookId, message, history)
    → Context assembly (book data, rules)
    → Mode determination: chat/edit/director/import/analyze/validate
    → Tool selection for mode:
      - chat: edit_book, write_storyboard, extract_entities, validate_book
      - edit: edit_book (only if not locked)
      - director: write_storyboard
      - import: import_book
    → aiService.callAI() with tools
    → Response parsing: reply + patches
    → Apply JSON Patch (applyPatches) if present
    → Save to chat_messages
    → Response: reply text
```

---

## Scenario 6: Playback (Android)

```
PlayFragment → PlaybackViewModel.loadScene(bookId, chapterId, sceneId)
  → Repository → BackendApi.getChunk()
  → SceneAudioPlayer.play(audioUrl) → ExoPlayer (Media3)
  → PlaybackViewModel.pollForVideoReady()
  → If video ready → load video
  → preloadAhead() — preload 3 scenes ahead
  → Scene navigation
```

---

## Scenario 7: Graceful Shutdown (SIGTERM)

**Trigger:** Docker stop / kill signal

**Components involved:**
1. `backend.cjs` — process.on('SIGTERM')
2. `gpu-hub.js` — process.on('SIGTERM')

**Flow:**
```
docker stop → SIGTERM → backend.cjs / gpu-hub.js
  → log('[SHUTDOWN] Graceful shutdown initiated')
  → server.close(() => log('[SHUTDOWN] HTTP server closed'))
  → redis.quit()
  → storage.postgres.closePool() (backend only)
  → process.exit(0)
```

---

## Scenario 8: Startup Resume (Session Recovery)

**Trigger:** Backend startup

```
backend.cjs → startServer()
  → resumeIncompleteSessions(log, windowGenerator.runBackgroundWindowGeneration)
    → genSessionRepo.getActiveSessions() — PG query
    → For each generating/pending session:
      → update status → 'pending'
      → setImmediate(() → runBackgroundWindowGeneration())
```

---

## Scenario 9: Window Slide (Generation Advancement)

**Trigger:** Scene reaches VIDEO_READY or timeout

```
scene-window.js:trySlideWindowOnComplete()
  → isCancelled() check
  → reconcileWindowStatuses() — verify chunks match files on disk
  → isWindowComplete() — all scenes in window ready?
    → Check per-asset states + layer config
    → If yes → slideWindow()
      → sceneHasValidContent() — verify content on disk
      → For each new scene:
        → startScene() — create chunk metadata + placeholder audio
        → Register in active scenes
    → If no → wait for next tick
```

---

## Scenario 10: Book Sync (JSON ↔ DB Synchronization)

**Trigger:** Book change (editing/import)

```
book-sync.js:syncBook(bookId)
  → detectChangedScenes()
    → getBookFingerprint() — hashes of all scenes from JSON
    → SELECT scene_hash FROM scenes — hashes from DB
    → Comparison: added / changed / removed
  → updateSceneHashes() — INSERT/UPDATE scenes
  → markSceneAssetsStale() — upsert: UPDATE existing rows + INSERT synthetic 'audio' row if none exist
  → markGenerationTasksStale() — cancel for changed scenes
  → purgeRemovedSceneRows() — DELETE orphan rows
```

---

## Scenario 11: Book Session Recovery Across Clients

**Requests:** `GET /api/v1/books` (server book list), `GET /api/v1/book/:bookId/status` (validation)

**Problem it solves:** An open book was bound to one client — Android cleared `bookId` on every cold start, mobile web held it only in memory, and the server couldn't "serve" a book list. A book imported on web wouldn't appear on Android.

**Source of truth — server:** the SHA-256 TXT → `book_id` mapping lives in the PG `book_source` table (registered on import, used for deduplication). `GET /api/v1/books` (`recent-books-routes.cjs`) returns recent books: records from PG `book_source` (for each — status from `lazy-book` manifest: state/title/build_id) + directory scan of `data/books/` for vbook imports without PG records; sorted by `updated_at`, limit 20. Rows for books no longer on disk are discarded.

**Client recovery (mirrored on Android and web):**
```
Cold client start
  → 1. Saved book_id (Android: SharedPreferences / web: localStorage)
       → GET /book/:id/status — server validation
         → 200 → restore this book
         → 404/other error → step 2
  → 2. Fallback: GET /api/v1/books → first (most recent) book
       → book found → save book_id/build_id locally
  → 3. Player warmup: GET /book/:id → scenes + cover
       → emit playbackPrepared (no auto-tab navigation)
  → Server unavailable → hold saved id optimistically (prefs/localStorage
    not cleared, restored on next launch)
```

**Race protection:** if during recovery the user opened another book (deep-link `?book=…` on web, `.vbook` ACTION_VIEW on Android), the warm emit for the old book is discarded (guard after fetch). Explicit book close (`closeBook`/"Create new book", "Delete vBook") still clears the saved id.

**Components involved:**
1. `recent-books-routes.cjs` → `GET /api/v1/books`
2. `book-source-repo.js:listRecent()` → PG `book_source`
3. `GenerateViewModel.restoreBookSession()` (Android) / `generateStore.restoreBookSession()` (web)
4. `MainActivity` (Android) / `main.tsx` (web) — called on cold start
