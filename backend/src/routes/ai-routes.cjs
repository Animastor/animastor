// ======================================================
// ANIMASTOR BACKEND — AI CHAT ROUTES
// ======================================================
// All /api/v1/ai/* endpoints.

const fs = require('fs');

module.exports = function(app, redis, deps) {
    const {
        config, state, audio, image, video, book, orchestrator, storage,
        layerConfig, genScope, activeScenes, placeholderAudio,
        utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
        detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
        cleanupService, bookDiff, taskHandler, chatEngine,
        iuRepo, genSessionRepo, lazyBook, txtImporter, bookSourceRepo,
    } = deps;
    const { log } = utils;

    // ── Session ID counter ───────────────────────────
    let sessionIdCounter = 0;

    // ======================================================
    // LIST SESSIONS
    // ======================================================
    app.get('/api/v1/ai/sessions', async (req, res) => {
        try {
            const { book_id } = req.query;
            const sessions = await storage.postgres.query(
                'SELECT * FROM ai_chat_sessions WHERE book_id = $1 ORDER BY created_at DESC',
                [book_id]
            );
            res.json({ sessions: sessions.rows });
        } catch (err) {
            console.error('[AI SESSIONS LIST] Error:', err.message);
            res.json({ sessions: [] });
        }
    });

    // ======================================================
    // GET SESSION
    // ======================================================
    app.get('/api/v1/ai/sessions/:id', async (req, res) => {
        try {
            const session = await storage.postgres.query(
                'SELECT * FROM ai_chat_sessions WHERE id = $1',
                [req.params.id]
            );
            if (!session.rows.length) return res.status(404).json({ error: 'Session not found' });
            res.json({ session: session.rows[0] });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CREATE SESSION
    // ======================================================
    app.post('/api/v1/ai/sessions', async (req, res) => {
        try {
            const { book_id, mode, topic_id } = req.body || {};
            if (!book_id) return res.status(400).json({ error: 'book_id required' });

            const id = `ai-session-${Date.now()}-${++sessionIdCounter}`;
            const session = {
                id, book_id, mode: mode || 'chat',
                topic_id: topic_id || 'book',
                messages: [], created_at: Date.now(), updated_at: Date.now(),
                context: null, locked: false,
            };

             await storage.postgres.query(
                `INSERT INTO ai_chat_sessions (id, book_id, mode, topic_id, messages, created_at, updated_at, context, locked)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [session.id, session.book_id, session.mode, session.topic_id,
                 JSON.stringify(session.messages),
                 session.created_at, session.updated_at,
                 session.context === null ? null : JSON.stringify(session.context), session.locked]
            );

            log('[AI] Created session:', id, 'for book:', book_id, 'mode:', session.mode);
            res.json({ session });
        } catch (err) {
            console.error('[AI CREATE SESSION] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CHAT (non-streaming)
    // ======================================================
    app.post('/api/v1/ai/chat', async (req, res) => {
        try {
            const { session_id, message, messages, book_id, system, mode, scene_id, topic_id } = req.body || {};

            // Accept either `messages` array (frontend format) or `message` string (legacy)
            const hasMessagesArray = Array.isArray(messages) && messages.length > 0;
            if (!hasMessagesArray && !message) {
                return res.status(400).json({ error: 'messages or message required' });
            }

            // Auto-create session if session_id not provided
            let activeSessionId = session_id;
            if (!activeSessionId) {
                if (!book_id) {
                    return res.status(400).json({ error: 'book_id required when no session_id' });
                }
                const id = `ai-session-${Date.now()}-${++sessionIdCounter}`;
                await storage.postgres.query(
                    `INSERT INTO ai_chat_sessions (id, book_id, mode, topic_id, messages, created_at, updated_at, context, locked)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [id, book_id, mode || 'chat', topic_id || 'book',
                     JSON.stringify([]), Date.now(), Date.now(), null, false]
                );
                activeSessionId = id;
                log('[AI] Auto-created session:', id, 'for book:', book_id);
            }

            const result = await storage.postgres.query(
                'SELECT * FROM ai_chat_sessions WHERE id = $1', [activeSessionId]
            );
            if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

            const session = result.rows[0];
            const storedMessages = typeof session.messages === 'string'
                ? JSON.parse(session.messages) : session.messages || [];
            const bookId = book_id || session.book_id;

            // Load book data for context
            let bookData = null;
            try { bookData = book.loadBook(bookId) || lazyBook.loadDraftBook(bookId); } catch (_) {}

            const isLocked = bookData?.manifest?.locked === true;
            const sessionMode = mode || session.mode || 'chat';
            const tools = chatEngine.getToolsForMode(sessionMode, bookId, isLocked);

            // Build system prompt:
            // - If `system` is explicitly provided (legacy clients), use it as base
            // - Otherwise, build from structured fields (mode, topic, lang, position)
            //   via chatEngine.buildChatSystemPrompt() — this replaces the client-side
            //   system prompt assembly in AiAssistantFragment.sendMessage().
            let systemPrompt;
            if (system) {
                // Legacy path: frontend sent fully assembled prompt
                systemPrompt = system;
            } else {
                // F6 path: assemble from structured fields on the server.
                // buildChatSystemPrompt resolves chapterId from sceneId internally.
                systemPrompt = chatEngine.buildChatSystemPrompt({
                    mode: mode || session.mode || 'conversation',
                    topic: topic_id || session.topic_id || 'book',
                    lang: req.body?.lang || 'auto',
                    bookData,
                    sceneId: req.body?.scene_id || null,
                    unitIndex: req.body?.unit_index ?? null,
                });
            }
            const bookContext = chatEngine.buildBookContext(bookData);
            if (bookContext) systemPrompt += '\n\n' + bookContext;

            // Build API messages for AI call
            let apiMessages;
            let userContent;

            if (hasMessagesArray) {
                // Frontend format: full history in `messages` array, `system` as system prompt
                apiMessages = [
                    { role: 'system', content: systemPrompt },
                    ...messages,
                ];
                const lastUser = messages.filter(m => m.role === 'user').pop();
                userContent = lastUser?.content || '';
            } else {
                // Legacy format: single `message` string, reconstruct from DB
                userContent = message;
                apiMessages = [
                    { role: 'system', content: systemPrompt },
                    ...(storedMessages.slice(-20).map(m => ({ role: m.role, content: m.content }))),
                    { role: 'user', content: message },
                ];
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000);
            const response = await fetch(`${chatEngine.AI_API_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.OPENROUTER_API_KEY || process.env.AI_API_KEY || ''}` },
                body: JSON.stringify({
                    model: process.env.AI_MODEL || 'meta/llama-3.1-8b-instruct',
                    messages: apiMessages,
                    tools: tools.length > 0 ? tools : undefined,
                    tool_choice: tools.length > 0 ? 'auto' : undefined,
                    max_tokens: 4096,
                }),
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!response.ok) {
                const errText = await response.text();
                console.error('[AI] API error:', response.status, errText);
                return res.status(502).json({ error: `AI API error: ${response.status}` });
            }

            const aiResponse = await response.json();
            const aiMessage = aiResponse.choices?.[0]?.message;
            let replyText = aiMessage?.content || '';
            // Strip AI chain-of-thought reasoning blocks — internal, not for the UI
            replyText = replyText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            // Strip tool_call & tool_call markers that some models leak into content
            replyText = replyText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
            replyText = replyText.replace(/<\/?tool_call[^>]*>/gi, '').trim();
            // If after stripping, the reply is just garbage remnants (e.g. 'ool_call>'), treat as empty
            // so the fallback message below kicks in
            if (replyText && replyText.length < 8 && !/[\w\u0400-\u04FF]{3,}/.test(replyText)) {
                replyText = '';
            }
            const toolCalls = aiMessage?.tool_calls || [];

            // Handle tool calls
            let patches = [];
            let toolResults = [];
            let lastEditError = null;

            if (toolCalls.length > 0) {
                for (const tc of toolCalls) {
                    if (tc.function.name === 'edit_book') {
                        try {
                            const args = JSON.parse(tc.function.arguments);
                            const patchResult = chatEngine.applyPatches(bookData, args.patches || []);
                            if (patchResult.errors.length > 0) {
                                const errMsg = patchResult.errors.join('; ');
                                toolResults.push({ tool: 'edit_book', error: errMsg });
                                lastEditError = errMsg;
                            } else {
                                patches = args.patches || [];
                                toolResults.push({ tool: 'edit_book', applied: patches.length, book_id: bookId });
                            }
                        } catch (parseErr) {
                            toolResults.push({ tool: 'edit_book', error: parseErr.message });
                            lastEditError = parseErr.message;
                        }
                    } else {
                        toolResults.push({ tool: tc.function.name, result: 'Tool executed (no handler)' });
                    }
                }
            }

            // Save patches if any were applied
            if (patches.length > 0 && bookData) {
                try {
                    const patchResult = chatEngine.applyPatches(bookData, patches);
                    if (patchResult.result) {
                        // Use saveBookBundle to persist all book files correctly:
                        // - bible -> bible.json
                        // - locations -> locations.json
                        // - voices -> voices.json
                        // - book -> book.json (metadata)
                        // - chapters -> chapters/*.json
                        book.saveBookBundle(patchResult.result);
                        log('[AI] Book updated via patches:', patches.length, 'patches applied to', bookId);
                    }
                    if (patchResult.errors.length > 0 && !lastEditError) {
                        lastEditError = patchResult.errors.join('; ');
                    }
                } catch (saveErr) {
                    console.error('[AI] Failed to save updated book:', saveErr.message);
                    lastEditError = saveErr.message;
                }
            }

            // Build a user-visible reply when the AI returned empty content but tool calls were processed
            if (!replyText && toolCalls.length > 0) {
                if (lastEditError) {
                    replyText = `⚠️ Edit error: ${lastEditError}`;
                } else if (patches.length > 0) {
                    replyText = `✅ Changes applied: ${patches.length} patch(es) to the book.`;
                } else {
                    replyText = `🤖 Processed ${toolCalls.length} tool call(s).`;
                }
            }

            // Update session messages: merge with stored history
            const updatedMessages = [
                ...storedMessages,
                { role: 'user', content: userContent, timestamp: Date.now() },
                { role: 'assistant', content: replyText, tool_calls: toolCalls, timestamp: Date.now() },
            ];

            await storage.postgres.query(
                'UPDATE ai_chat_sessions SET messages = $1, updated_at = $2 WHERE id = $3',
                [JSON.stringify(updatedMessages), Date.now(), activeSessionId]
            );

            res.json({
                reply: replyText,
                tool_calls: toolCalls,
                tool_results: toolResults,
                patches_applied: patches.length,
                session_id: activeSessionId,
            });
        } catch (err) {
            console.error('[AI CHAT] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // STREAMING CHAT
    // ======================================================
    app.post('/api/v1/ai/chat/stream', async (req, res) => {
        try {
            const { session_id, message, book_id } = req.body || {};
            if (!session_id || !message) return res.status(400).json({ error: 'session_id and message required' });

            const result = await storage.postgres.query(
                'SELECT * FROM ai_chat_sessions WHERE id = $1', [session_id]
            );
            if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

            const session = result.rows[0];
            const messages = typeof session.messages === 'string' ? JSON.parse(session.messages) : session.messages || [];
            const bookId = book_id || session.book_id;

            let bookData = null;
            try { bookData = book.loadBook(bookId) || lazyBook.loadDraftBook(bookId); } catch (_) {}

            const isLocked = bookData?.manifest?.locked === true;
            const mode = session.mode || 'chat';
            const tools = chatEngine.getToolsForMode(mode, bookId, isLocked);

            let systemPrompt = chatEngine.loadSystemPrompt();
            const bookContext = chatEngine.buildBookContext(bookData);
            if (bookContext) systemPrompt += '\n\n' + bookContext;

            const apiMessages = [
                { role: 'system', content: systemPrompt },
                ...(messages.slice(-20).map(m => ({ role: m.role, content: m.content }))),
                { role: 'user', content: message },
            ];

            // Set up SSE response
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000);
            const aiResponse = await fetch(`${chatEngine.AI_API_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.OPENROUTER_API_KEY || process.env.AI_API_KEY || ''}` },
                body: JSON.stringify({
                    model: process.env.AI_MODEL || 'meta/llama-3.1-8b-instruct',
                    messages: apiMessages,
                    tools: tools.length > 0 ? tools : undefined,
                    tool_choice: tools.length > 0 ? 'auto' : undefined,
                    max_tokens: 4096,
                    stream: true,
                }),
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!aiResponse.ok) {
                const errText = await aiResponse.text();
                console.error('[AI] Streaming API error:', aiResponse.status, errText);
                res.write(`data: ${JSON.stringify({ error: `AI API error: ${aiResponse.status}` })}\n\n`);
                res.end();
                return;
            }

            const reader = aiResponse.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let toolCallBuffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

                for (const line of lines) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta;
                        if (delta?.content) {
                            // Strip AI chain-of-thought reasoning blocks from streamed chunks
                            const cleaned = delta.content.replace(/<think>[\s\S]*?<\/think>/g, '');
                            if (cleaned) {
                                fullContent += cleaned;
                                res.write(`data: ${JSON.stringify({ type: 'content', content: cleaned })}\n\n`);
                            }
                        }
                        if (delta?.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                if (tc.function?.name) toolCallBuffer += JSON.stringify(tc) + '\n';
                                if (tc.function?.arguments) toolCallBuffer += tc.function.arguments;
                            }
                        }
                    } catch (e) {
                        // Skip non-JSON lines
                    }
                }
            }

            res.write(`data: ${JSON.stringify({ type: 'done', content: fullContent })}\n\n`);
            res.end();

            // Save to session
            const updatedMessages = [...messages,
                { role: 'user', content: message, timestamp: Date.now() },
                { role: 'assistant', content: fullContent, timestamp: Date.now() },
            ];

            await storage.postgres.query(
                'UPDATE ai_chat_sessions SET messages = $1, updated_at = $2 WHERE id = $3',
                [JSON.stringify(updatedMessages), Date.now(), session_id]
            );
        } catch (err) {
            console.error('[AI STREAM] Error:', err.message);
            if (!res.headersSent) return res.status(500).json({ error: err.message });
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        }
    });

    // ======================================================
    // MODE SWITCH
    // ======================================================
    app.post('/api/v1/ai/modeswitch', async (req, res) => {
        try {
            const { session_id, new_mode } = req.body || {};
            if (!session_id || !new_mode) return res.status(400).json({ error: 'session_id and new_mode required' });

            const validModes = ['chat', 'edit', 'director', 'import', 'analyze', 'validate'];
            if (!validModes.includes(new_mode)) {
                return res.status(400).json({ error: `Invalid mode: ${new_mode}. Valid: ${validModes.join(', ')}` });
            }

            await storage.postgres.query(
                'UPDATE ai_chat_sessions SET mode = $1, updated_at = $2 WHERE id = $3',
                [new_mode, Date.now(), session_id]
            );

            log('[AI] Mode switched:', session_id, '→', new_mode);
            res.json({ session_id, mode: new_mode, switched: true });
        } catch (err) {
            console.error('[AI MODE SWITCH] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // LOCK TOGGLE
    // ======================================================
    app.post('/api/v1/ai/lock', async (req, res) => {
        try {
            const { book_id, locked } = req.body || {};
            if (!book_id) return res.status(400).json({ error: 'book_id required' });

            const bookData = book.loadBook(book_id) || lazyBook.loadDraftBook(book_id);
            if (!bookData) return res.status(404).json({ error: 'Book not found' });

            if (locked !== undefined) bookData.manifest.locked = locked;
            else bookData.manifest.locked = !bookData.manifest.locked;

            const finalLocked = bookData.manifest.locked;
            const bookDir = lazyBook.getBookDir(book_id);
            const bookPath = require('path').join(bookDir, 'book.json');
            fs.writeFileSync(bookPath, JSON.stringify(bookData, null, 2));

            log(`[AI] Book ${book_id} ${finalLocked ? 'locked' : 'unlocked'}`);
            res.json({ book_id, locked: finalLocked });
        } catch (err) {
            console.error('[AI LOCK] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // MODE ROUTER (by session mode)
    // ======================================================
    app.post('/api/v1/ai/mode-router', async (req, res) => {
        try {
            const { session_id, message } = req.body || {};
            if (!session_id || !message) return res.status(400).json({ error: 'session_id and message required' });

            const result = await storage.postgres.query(
                'SELECT * FROM ai_chat_sessions WHERE id = $1', [session_id]
            );
            if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

            const session = result.rows[0];
            const mode = session.mode || 'chat';

            // Route to appropriate handler based on mode
            switch (mode) {
                case 'edit':
                case 'director':
                case 'import':
                case 'analyze':
                    return res.redirect(307, '/api/v1/ai/chat');

                case 'validate': {
                    const bookId = session.book_id;
                    const bookData = book.loadBook(bookId);
                    if (!bookData) return res.status(404).json({ error: 'Book not found' });

                    const validationResult = {
                        valid: true,
                        checks: {
                            has_manifest: !!bookData.manifest,
                            has_chapters: (bookData.chapters?.length || 0) > 0,
                            has_scenes: (bookData.chapters || []).some(ch => (ch.scenes?.length || 0) > 0),
                            has_characters: (bookData.characters?.length || 0) > 0,
                            has_locations: (bookData.locations?.length || 0) > 0,
                        },
                    };

                    const missingFields = Object.entries(validationResult.checks)
                        .filter(([, v]) => !v)
                        .map(([k]) => k.replace('has_', ''));

                    validationResult.valid = missingFields.length === 0;
                    validationResult.missing = missingFields;
                    validationResult.message = missingFields.length > 0
                        ? `Missing: ${missingFields.join(', ')}`
                        : 'All checks passed';

                    return res.json({ mode, result: validationResult });
                }

                default:
                    return res.redirect(307, '/api/v1/ai/chat');
            }
        } catch (err) {
            console.error('[AI MODE ROUTER] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // PROMPT ENDPOINT (direct chat by book)
    // ======================================================
    app.post('/api/v1/ai/prompt', async (req, res) => {
        try {
            const { book_id, prompt, image_base64 } = req.body || {};
            if (!book_id || !prompt) return res.status(400).json({ error: 'book_id and prompt required' });

            let bookData = null;
            try { bookData = book.loadBook(book_id) || lazyBook.loadDraftBook(book_id); } catch (_) {}

            const isLocked = bookData?.manifest?.locked === true;
            const tools = chatEngine.getToolsForMode(isLocked ? 'chat' : 'edit', book_id, isLocked);

            let systemPrompt = chatEngine.loadSystemPrompt();
            if (bookData) {
                systemPrompt += '\n\n' + chatEngine.buildBookContext(bookData);
            }

            const apiMessages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }];

            if (image_base64) {
                apiMessages.push({
                    role: 'user',
                    content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image_base64}` } }],
                });
            }

            const response = await fetch(`${chatEngine.AI_API_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.OPENROUTER_API_KEY || process.env.AI_API_KEY || ''}` },
                body: JSON.stringify({
                    model: process.env.AI_MODEL || 'meta/llama-3.1-8b-instruct',
                    messages: apiMessages,
                    tools: tools.length > 0 ? tools : undefined,
                    tool_choice: tools.length > 0 ? 'auto' : undefined,
                    max_tokens: 4096,
                }),
            });

            if (!response.ok) {
                const errText = await response.text();
                return res.status(502).json({ error: `AI API error: ${response.status}` });
            }

            const aiResponse = await response.json();
            const replyText = aiResponse.choices?.[0]?.message?.content || '';

            // Parse patches from response
            let patches = [];
            let patchedBook = null;
            if (bookData && !isLocked) {
                const parsed = chatEngine.parseAIResponse(replyText);
                patches = parsed.patches;
                if (patches.length > 0) {
                    const patchResult = chatEngine.applyPatches(bookData, patches);
                    patchedBook = patchResult.result;
                    if (patchedBook && patchedBook !== bookData) {
                        const bookDir = lazyBook.getBookDir(book_id);
                        const bookPath = require('path').join(bookDir, 'book.json');
                        fs.writeFileSync(bookPath, JSON.stringify(patchedBook, null, 2));
                        log(`[AI PROMPT] Applied ${patches.length} patches to ${book_id}`);
                    }
                }
            }

            res.json({ reply: parsed.reply, patches_applied: patches.length, book_updated: !!patchedBook });
        } catch (err) {
            console.error('[AI PROMPT] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] AI routes loaded');
};
