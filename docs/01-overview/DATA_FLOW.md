# Data Flow: Animastor

## Сценарий 1: Импорт TXT-файла

**Запрос:** `POST /api/v1/book/import-txt` (multipart file upload)

**Участвующие компоненты:**
1. `book-routes.cjs:356` → Route handler
2. `txt-importer.js:decodeTxtBuffer()` → Декодирование (UTF-8/CP1251)
3. `lazy-book.js:createDraftBook()` → Создание draft-книги (RAW_IMPORTED)
4. `book-source-repo.js:registerSource()` → Регистрация в PG

**Поток данных:**
```
Client → [HTTP POST multipart] → book-routes
  → Buffer (TXT) → txtImporter.decodeTxtBuffer()
    → Определение кодировки (encoding-detect.js)
    → Возврат UTF-8 текста
  → lazyBook.createDraftBook(sourceText, SourceType.TXT, title)
    → Создание manifest.json с bookId
    → Создание директории data/books/<bookId>/
    → Сохранение sourceText в source.txt
    → Сохранение book.json (метаданные)
    → Установка состояния RAW_IMPORTED
  → bookSourceRepo.registerSource(hash, filename, size, bookId, 'txt')
    → INSERT INTO book_sources
  → Response: { book_id, title, state: RAW_IMPORTED }
```

---

## Сценарий 2: Bootstrap (AI-анализ текста)

**Запрос:** `POST /api/v1/book/:bookId/bootstrap`

**Участвующие компоненты:**
1. `book-routes.cjs:426` → Route handler
2. `txt-importer.js:bootstrapImportedText()` → Вход в AI-пайплайн
3. `agent-service.js:bootstrapWithAgent()` → AI-анализ

**Пошаговая цепочка:**
```
book-routes → txtImporter.bootstrapImportedText(bookId)
  → Очистка артефактов предыдущих failed bootstrap
  → agentService.bootstrapWithAgent(bookId, progress)
    → createSession(bookId, 'txt_import')
      → INSERT INTO agent_sessions (status: running)
    
    → getWindowText() — текстовый буфер от currentOffset (~1500 символов)
    
    → Шаг 0: stepAnalyzeStructure(text, bookId)
      → aiService.callAI() → structure { author, title, chapters }
      → Обновление book.json (author, title, structure)
    
    → runPipeline() — 5 шагов + enrichment:
      → Шаг 1: stepExtractCharacters() → characters[]
      → Шаг 2: stepExtractLocations() → locations[]
      → Шаг 3: stepCreateScenes() → scenes[] (до 3 сцен из начала буфера)
        → resolveSceneProgress() → nextOffset по последней созданной сцене
        → Валидация coverage (gap/overlap) + duration → при неудаче repair retry → fallback
      → stepEnrichScenes() — обогащение сцен (title, location.environment)
      → Шаг 4: stepCreateUnits() per scene (без unit.participants — удалён)
      → Шаг 5: stepCreateVisuals() per scene (inferCharactersFromPrompt)
    
    → lazyBook.createFromAnalysis() — сохранение:
      → characters.json, bible.json, chapters/*.json
      → Cover chapter (createCoverChapter + saveCoverChapter)
    
    → window_data.currentOffset = nextOffset, а не plannedEndOffset
    → Если после nextOffset остаётся текст → paused (ждут следующего окна)
    → Если всё → completed
    
  → book-routes получает результат
    → Создание Redis chunks для каждой сцены
    → Создание placeholder audio
    → Response с данными bootstrap
```

---

## Сценарий 3: Генерация сцены (Per-Asset Parallel Dispatch)

**Триггер:** Scene added to active-scenes index

**Ключевое изменение (v2.1.0):** Линейная FSM удалена. Все callback'и проверяют per-asset state. `transitionSceneState` — прямой write без валидации. `decideStage` удалён — dispatch-engine всегда передаёт `overrideStage`.

**Участвующие компоненты:**

### 3a: Runtime Scheduler Tick

```
runtime-scheduler.tick() [каждые 5 секунд]
  → acquireSchedulerTickLock()
  → activeScenes.getAllActiveSceneKeys()
  → Для каждой сцены: attemptDispatch()
    → shouldScheduleAssets() — ПРОВЕРКА PER-ASSET СОСТОЯНИЙ
      → assetStates = getAssetStates() (audio/image/video)
      → layer config (audio_enabled/image_enabled/video_enabled)
      → PG version-stale check (если asset_version < scene_version)
      → Решение: какие stage'ы готовы к диспетчеризации
      → Audio: не ready и не generating → dispatch
      → Image: не ready и не generating → dispatch (независимо от audio!)
      → Video: не ready, не generating, image=ready → dispatch
      → per-asset: NEW/DIRTY/PENDING → dispatch; GENERATING/READY → skip
    → Для каждого eligible stage:
      → dispatchEngine.dispatchStage(stage)
```

### 3b: Dispatch Engine

```
dispatchEngine.dispatchStage(redis, bookId, chapterId, sceneId, stage, loadedBook, buildId, { force })
  → Check circuit breaker (LIVE — прямой require)
  → Check duplicate/lease (force=true → очистка существующего lease)
  → Acquire quota (атомарно через Lua EVAL — устранён race GET+INCR)
  → Check retry budget (LIVE — прямой require)
  → Check fairness (LIVE — прямой require)
  → Acquire stage lease (NX, TTL: audio 15min, image 20min, video 30min)
  → Clear dispatch-completed marker (для idempotent completion)
  → orchestrator.dispatchStage() с overrideStage
```

### 3c: Audio Generation (через Orchestrator Facade)

> **UPD 2026-06-28 (M5):** Все lifecycle-переходы через `orchestrator.completeStage`.
> GENERATING выставляется в beginStage через scene-orchestrator (дыра §5.1 FIXED).
> PG `scene_assets.status='ready'` пишется в callback'ах (C2 FIXED).

```
orchestrator.beginStage() → dispatchEngine.dispatchStage()
  → scene-orchestrator.executeAudioDispatch()
    → per-asset GENERATING (выставляется)
    → audio.generateSceneAudio() → segments → gpu.send()
  → callback → task-handler → orchestrator.completeStage('audio')
    → scene-callbacks.handleAudioCompleted()
      → Per-asset check: audio GENERATING/PENDING/DIRTY
      → Валидация файла
      → PG markReady('audio') — C2 FIXED
      → placeholder replacement
    → Version gate: проверка asset_version < scene_version
      → stale → DIRTY (force-regen не отменяется)
      → OK → setAssetState(READY) + syncLinearState
    → finally: markDispatchCompleted (release lease + quota, РОВНО один раз — C1/C4)
```

### 3d: Image Generation (независим от audio!)

> **UPD 2026-06-28:** version-stale check — явный пред-проход в attemptDispatch() (Д.2).
> dirty unit IDs из PG передаются в executeImageDispatch для регенерации конкретных IU.

```
orchestrator.beginStage() → dispatchEngine.dispatchStage()
  → scene-orchestrator.executeImageDispatch()
    → per-asset GENERATING (выставляется)
    → Чтение dirtyUnitIds из PG (для точечной регенерации IU)
    → image.generateSceneIUImages() → build prompts → gpu.send()
  → callback → task-handler (проверка IU completion)
    → saveIURegistry → проверка всех IU для сцены
    → orchestrator.completeStage('image')
      → scene-callbacks.handleImageCompleted()
        → Per-asset check: image GENERATING/PENDING/DIRTY
        → PG markReady('image') — C2 FIXED
        → Очистка только завершённых dirty unit IDs
        → Сброс IU-счётчика на актуальное количество файлов
        → Очистка in-flight markers
      → Version gate → READY or DIRTY
      → finally: markDispatchCompleted (release lease + quota)
```

### 3e: Video Generation (зависит от IMAGE_READY)

> **UPD 2026-06-28:** Video — последняя стадия. После READY → remove from active index + auto-slide.

```
orchestrator.beginStage() → dispatchEngine.dispatchStage()
  → scene-orchestrator.executeVideoDispatch()
    → per-asset GENERATING (выставляется)
    → Проверка: image=READY? (asset states + chunk fallback)
    → video.generateVideoAnimation() → jobSpecs
    → gpu.sendUnified() для каждой группы
  → callback → orchestrator.completeStage('video')
    → scene-callbacks.handleVideoCompleted()
      → Per-asset check: video GENERATING/PENDING/DIRTY
      → Валидация .mp4 файла
      → PG markReady('video') — C2 FIXED
      → updateSceneVideoStatus → updateSceneChunks
      → clearDirtyFlag в PG
      → publishProgress
      → removeSceneFromActiveIndex
      → trySlideWindowOnComplete() → auto-slide
    → Version gate → READY or DIRTY
    → finally: markDispatchCompleted (release lease + quota)
```

---

## Сценарий 4: Загрузка и просмотр книги (Android)

**Запрос:** `GET /api/v1/book/:bookId`

```
Android → [HTTP GET] → book-routes
  → book.loadBook(bookId)
    → Многофайловый формат: manifest.json + book.json + chapters/*.json
  → placeholderAudio.recoverMissingPlaceholders()
    → Проверка наличия MP3-файлов
    → Создание отсутствующих заглушек
  → recoverMissingRedisChunks()
    → Проверка наличия Redis chunks для каждой сцены
    → Создание отсутствующих
  → Response: JSON книги
    → Android: UI fragments рендерят структуру
```

---

## Сценарий 5: AI-чат ассистент (tool-based)

**Запрос:** `POST /api/v1/ai/chat`

```
Android → [HTTP POST] → ai-routes
  → chatEngine.sendMessage(bookId, message, history)
    → Сборка контекста (book data, правила)
    → Определение режима: chat/edit/director/import/analyze/validate
    → Выбор tool'ов для режима:
      - chat: edit_book, write_storyboard, extract_entities, validate_book
      - edit: edit_book (только если не locked)
      - director: write_storyboard
      - import: import_book
    → aiService.callAI() с tools
    → Парсинг ответа: reply + patches
    → Применение JSON Patch (applyPatches) если есть
    → Сохранение в chat_messages
    → Response: текст ответа
```

---

## Сценарий 6: Воспроизведение (Android)

```
PlayFragment → PlaybackViewModel.loadScene(bookId, chapterId, sceneId)
  → Repository → BackendApi.getChunk()
  → SceneAudioPlayer.play(audioUrl) → ExoPlayer (Media3)
  → PlaybackViewModel.pollForVideoReady()
  → Если video ready → загрузка видео
  → preloadAhead() — предзагрузка 3 сцен вперёд
  → Навигация по сценам
```

---

## Сценарий 7: Graceful Shutdown (SIGTERM)

**Триггер:** Docker stop / kill сигнал

**Участвующие компоненты:**
1. `backend.cjs` — process.on('SIGTERM')
2. `gpu-hub.js` — process.on('SIGTERM')

**Поток:**
```
docker stop → SIGTERM → backend.cjs / gpu-hub.js
  → log('[SHUTDOWN] Graceful shutdown initiated')
  → server.close(() => log('[SHUTDOWN] HTTP server closed'))
  → redis.quit()
  → storage.postgres.closePool() (backend only)
  → process.exit(0)
```

---

## Сценарий 8: Startup Resume (восстановление сессий)

**Триггер:** Запуск backend

```
backend.cjs → startServer()
  → resumeIncompleteSessions(log, windowGenerator.runBackgroundWindowGeneration)
    → genSessionRepo.getActiveSessions() — PG запрос
    → Для каждой generating/pending сессии:
      → update status → 'pending'
      → setImmediate(() → runBackgroundWindowGeneration())
```

---

## Сценарий 9: Слайд окна (продвижение генерации)

**Триггер:** Сцена достигла VIDEO_READY или таймаут

```
scene-window.js:trySlideWindowOnComplete()
  → isCancelled() check
  → reconcileWindowStatuses() — сверка чанков с файлами на диске
  → isWindowComplete() — все сцены в окне ready?
    → Проверка per-asset состояний + layer config
    → Если да → slideWindow()
      → sceneHasValidContent() — проверка контента на диске
      → Для каждой новой сцены:
        → startScene() — создание chunk metadata + placeholder audio
        → Регистрация в active scenes
    → Если нет → ожидание следующего tick
```

---

## Сценарий 10: Book Sync (синхронизация JSON ↔ DB)

**Триггер:** Изменение книги (редактирование/импорт)

```
book-sync.js:syncBook(bookId)
  → detectChangedScenes()
    → getBookFingerprint() — хэши всех сцен из JSON
    → SELECT scene_hash FROM scenes — хэши из БД
    → Сравнение: added / changed / removed
  → updateSceneHashes() — INSERT/UPDATE scenes
  → markSceneAssetsStale() — upsert: UPDATE existing rows + INSERT synthetic 'audio' row if none exist
  → markGenerationTasksStale() — cancel для changed scenes
  → purgeRemovedSceneRows() — DELETE orphan rows
```
