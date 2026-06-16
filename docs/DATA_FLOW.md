# Data Flow: Animastor

## Сценарий 1: Импорт TXT-файла

**Запрос:** `POST /api/v1/book/import-txt` (multipart file upload)

**Участвующие компоненты:**
1. `book-routes.cjs:356` → Route handler
2. `txt-importer.js:decodeTxtBuffer()` → Декодирование (UTF-8/CP1251)
3. `lazy-book.js:createDraftBook()` → Создание draft-книги
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
    → Сохранение sourceText в draft-файл
    → Установка состояния RAW_IMPORTED
  → bookSourceRepo.registerSource(hash, filename, size, bookId, 'txt')
    → INSERT INTO book_sources
  → Response: { book_id, title, state: RAW_IMPORTED }
```

**Где данные преобразуются:**
- Buffer → UTF-8 string (encoding-detection)
- Source text → Draft-книга с manifest

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
  → Загрузка draft-книги с sourceText
  → agentService.bootstrapWithAgent(bookId, progress)
    → createSession(bookId, 'txt_import')
      → INSERT INTO agent_sessions (status: running)
    
    → Step 0: stepAnalyzeStructure(text, bookId)
      → Сборка system_prompt (структура)
      → aiService.callAI(model, messages, options)
        → HTTP POST OpenRouter API
      → Парсинг JSON-ответа
      → Сохранение в книги (author, title, parts, chapters)
      → INSERT INTO agent_steps (step_type: analyze_structure)
    
    → Step 1: stepExtractCharacters(text, bookId, knownChars)
      → Сборка system_prompt (персонажи)
      → aiService.callAI() → OpenRouter
      → Парсинг JSON
      → Мерж с knownChars (по ID)
      → INSERT INTO agent_steps
    
    → Step 2: stepExtractLocations(text, bookId, knownLocs)
      → Аналогично
      → Мерж locations
    
    → Step 3: stepCreateScenes(text, bookId, knownChars, knownLocs)
      → WINDOW_SIZE=3 сцены за раз
      → MAX_WINDOW_CHARS=4000
      → aiService.callAI() → сцены с участниками и локациями
    
    → Step 4: stepCreateUnits(scenes, bookId)
      → Для каждой сцены: разбивка на IU (кадры)
      → aiService.callAI()
    
    → Step 5: stepCreateVisuals(scenes, bookId)
      → Для каждой сцены: визуальные промпты
      → aiService.callAI()
    
    → Сохранение сцен в книгу
    → Сохранение window_data в agent_sessions
    → UPDATE agent_sessions (status: running, window_data)
    → Если есть ещё текст → сохраняем remainingScenes/remainingText
    
  → book-routes получает результат
    → Создание Redis chunks для каждой сцены
    → Создание placeholder audio
    → Response с данными bootstrap
    → Если has_more → background window processing
```

**Где принимаются решения:**
- `stepAnalyzeStructure` → достаточно ли текста для извлечения структуры
- `stepCreateScenes` → сколько сцен влезает в WINDOW_SIZE
- `stepCreateVisuals` → какие визуальные промпты для каждого IU
- После Step 5 → есть ли remaining_text или remaining_scenes

**Где формируется итоговый результат:**
- Книга на диске (JSON) с главами, сценами, IU
- PostgreSQL: agent_sessions (status), agent_steps (результаты), agent_conversations, agent_messages
- Redis: chunks (metadata), scene counters

---

## Сценарий 3: Генерация сцены (Audio → Image → Video)

**Триггер:** Scene added to active-scenes index

**Участвующие компоненты:**

### 3a: Audio Generation

```
runtime-scheduler.tick() [каждые 5 секунд]
  → activeScenes.getAllActiveScenes()
  → Для каждой сцены: attemptDispatch()
    → dispatchEngine.shouldScheduleAssets()
      → Проверка: audio enabled? audio не ready?
      → Проверка: quota audio < max 3?
      → Проверка: circuit breaker не разомкнут?
      → Проверка: retry budget не исчерпан?
    → dispatchEngine.dispatchStage()
      → acquireStageLease() (TTL: 30min)
      → acquireQuota('audio')
    → orchestrator.dispatchStage()
      → executeAudioDispatch()
        → audio.generateSceneAudio(redis, sceneData, loadedBook, buildId, bookId)
          → buildSegments() → разбивка на narration/dialogue сегменты
          → Для narration: audioWorkflows.buildNarrationTTSWorkflow(text, voice)
          → Для dialogue: audioWorkflows.buildDialogueTTSWorkflow(script, voices)
          → gpu.send(jobId, workflow, 'audio', buildId)
            → HTTP POST /task { job_id, params: workflow, job_type: 'audio', build_id }
              → GPU Hub → Redis Queue animastor:queue:audio
                → Worker poll GET /task/next
                  → POST /prompt (ComfyUI)
                  → Poll /history
                  → POST /task/result { job_id, build_id, result_base64 }
                    → GPU Hub → POST callback на backend
                      → task-handler.cjs → orchestrator.handleAudioCompleted()
                        → Валидация: MP3 файл сохранён?
                        → assetRegistry: регистрация аудио
                        → eventJournal: AUDIO_COMPLETED
                        → sceneState: AUDIO_READY
                        → releaseQuota('audio')
```

### 3b: Image Generation (аналогично, независим от audio)

```
runtime-scheduler.tick()
  → dispatchEngine.dispatchStage('image')
    → quota image < max 2
    → lease TTL: 60min
  → orchestrator.executeImageDispatch()
    → image.generateSceneIUImages()
      → buildImagePrompt(iuPayload, scenePayload, chapterPayload, bookPayload)
      → imageWorkflows.buildImageWorkflow(prompt, negativePrompt)
      → gpu.send() → GPU Hub → Worker → ComfyUI
      → callback → orchestrator.handleImageCompleted()
        → IMAGE_READY
```

### 3c: Video Generation (зависит от IMAGE_READY)

```
runtime-scheduler.tick()
  → Проверка: scene.image === READY?
  → dispatchEngine.dispatchStage('video')
    → quota video < max 1
    → lease TTL: 120min
  → orchestrator.executeVideoDispatch()
    → video.generateVideoAnimation()
      → videoWorkflows.selectWorkflowGroups(unitCount)
        → video-ltx-1p / 2p / 3p / 4p
      → Для каждой группы:
        → readImagesBase64()
        → videoWorkflows.buildVideoWorkflows()
        → gpu.sendVideo() → GPU Hub → Worker → ComfyUI
      → callback → orchestrator.handleVideoCompleted()
        → video-merge.js: мерж групп → scene video
        → video-merge.js: mux с audio → scene video+audio
        → VIDEO_READY
```

---

## Сценарий 4: Загрузка и просмотр книги (Android)

**Запрос:** `GET /api/v1/book/:bookId`

```
Android → [HTTP GET] → book-routes
  → book.loadBook(bookId)
    → Чтение JSON книги с диска
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

## Сценарий 5: AI-чат ассистент

**Запрос:** `POST /api/v1/ai/chat`

```
Android → [HTTP POST] → ai-routes
  → chatEngine.sendMessage(bookId, message, history)
    → Сборка контекста (book data, правила)
    → aiService.callAI() → OpenRouter
    → Сохранение в chat_messages
    → Response: текст ответа
```

---

## Сценарий 6: Воспроизведение (Android)

```
PlayFragment → PlaybackViewModel.loadScene(bookId, chapterId, sceneId)
  → Repository → BackendApi.getChunk()
  → SceneAudioPlayer.play(audioUrl)
    → ExoPlayer (Media3)
  → PlaybackViewModel.pollForVideoReady()
    → Если video ready → загрузка видео
    → Навигация по сценам
```

---

## Сценарий 7: Слайд окна (продвижение генерации)

**Триггер:** Сцена достигла VIDEO_READY или таймаут

```
scene-window.js:trySlideWindowOnComplete()
  → Проверка: все сцены в текущем окне завершены?
  → Если да → slideWindow()
    → Снятие меток active scenes
    → Отправка следующей партии сцен
    → Если scope=whole_book → continue
    → Если scope=current_scene → stop
  → Если нет → ожидание следующего tick
```
