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

    // ── Workspace AI provider (Experimental Beta) ──────────────────────
    // Resolve the provider for the book: its workspace's provider first,
    // then the GATED system fallback (admin kill switch enforced). Transport
    // separation: the routes only build endpoint/key/model — the fetch stays
    // local (safeFetch, which also enforces the SSRF guard on USER-controlled
    // endpoints). NO env re-fallback here: the resolver is the single source
    // of truth for the key, so the kill switch cannot be bypassed.
    const workspaceAi = require('../services/workspace-ai-provider');
    const { safeFetch } = require('../services/url-safety');
    async function resolveChatAI(bookId) {
        const provider = bookId
            ? await workspaceAi.resolveAIForBook(bookId)
            : await workspaceAi.resolveSystemFallback();
        return {
            baseUrl: provider.endpoint || chatEngine.AI_API_BASE_URL,
            apiKey: provider.apiKey || '',
            model: provider.model || process.env.AI_MODEL || 'qwen/qwen3-32b',
            source: provider.source,
            // Only the user-controlled workspace endpoint is an SSRF surface;
            // operator-controlled env config (system fallback) is trusted.
            validatePublic: provider.source === 'workspace' && !!provider.endpoint,
        };
    }

    /** 503 guard — no usable AI provider (kill switch OFF / unconfigured). */
    function aiUnavailable(res) {
        return res.status(503).json({
            error: 'AI is currently unavailable. No AI provider is configured or system AI is disabled.',
            code: 'ai_unavailable',
        });
    }

    const AI_FETCH_TIMEOUT_MS = 180_000; // 3 minutes — AI providers need time for large book contexts

    // ── Token budget & thinking policy ─────────────────
    // Tool-carrying requests use a HIGH max_tokens: reasoning models
    // (deepseek-v4-flash, qwen3) count reasoning tokens against max_tokens,
    // so a 4096 cap can be fully consumed by reasoning before any
    // content/tool_call is produced (observed: finish_reason=length,
    // reasoning_tokens=4096, empty content → "Tool executed" ghost reply).
    // Tool-less conversation gets a small budget and no thinking — faster,
    // cheaper replies.
    const MAX_TOKENS_WITH_TOOLS = 16384;
    const MAX_TOKENS_PLAIN = 4096;

    function aiRequestBodyExtras(tools) {
        const hasTools = Array.isArray(tools) && tools.length > 0;
        return {
            max_tokens: hasTools ? MAX_TOKENS_WITH_TOOLS : MAX_TOKENS_PLAIN,
            enable_thinking: hasTools, // reasoning only for tool/edit work
        };
    }

    // ── Hermesian tool call parser ──────────────────────
    // Qwen3-32B (reasoning model) sometimes outputs tool_call as text in content
    // instead of using the structured tool_calls field. This parser extracts those.
    function extractToolCallsFromContent(content) {
        if (!content) return { toolCalls: [], cleanedContent: content || '' };
        const extracted = [];
        let cleaned = content;
        let idx = 0;
        const now = Date.now();

        // Pattern 1: 〖tool_call〗...〖/tool_call〗 (Hermesian bracket format)
        cleaned = cleaned.replace(/[〖【]tool_call[〗】][\s\S]*?[〖【]\/tool_call[〗】]/g, (match) => {
            const inner = match.replace(/[〖【]\/?tool_call[〗】]/g, '').trim();
            const tc = _parseToolCallJson(inner, now, idx);
            if (tc) { extracted.push(tc); idx++; }
            return '';
        });

        // Pattern 2: Fallback — scan remaining content for any JSON object with balanced braces
        cleaned = _extractBalancedJsonToolCalls(cleaned, extracted, now);

        return { toolCalls: extracted, cleanedContent: cleaned.trim() };
    }

    function _extractBalancedJsonToolCalls(text, extracted, now) {
        let result = '';
        let i = 0;
        while (i < text.length) {
            if (text[i] === '{') {
                let depth = 1;
                let j = i + 1;
                while (j < text.length && depth > 0) {
                    if (text[j] === '{') depth++;
                    else if (text[j] === '}') depth--;
                    j++;
                }
                if (depth === 0) {
                    const candidate = text.slice(i, j);
                    try {
                        const parsed = JSON.parse(candidate);
                        const name = parsed.name || parsed.function?.name;
                        if (name) {
                            const args = parsed.arguments || parsed.function?.arguments || {};
                            extracted.push({
                                id: `call_content_${now}_${extracted.length}`,
                                type: 'function',
                                function: {
                                    name,
                                    arguments: typeof args === 'string' ? args : JSON.stringify(args)
                                }
                            });
                            i = j; // skip matched part
                            continue;
                        }
                    } catch (_) {}
                }
            }
            result += text[i];
            i++;
        }
        return result;
    }

    function _parseToolCallJson(text, now, idx) {
        try {
            const p = JSON.parse(text);
            const name = p.name || p.function?.name;
            if (name) {
                const args = p.arguments || p.function?.arguments || {};
                return {
                    id: `call_content_${now}_${idx}`,
                    type: 'function',
                    function: {
                        name,
                        arguments: typeof args === 'string' ? args : JSON.stringify(args)
                    }
                };
            }
        } catch (_) {
            // Try extracting JSON from arbitrary surrounding text
            const m = text.match(/\{[\s\S]*\}/);
            if (m) {
                try {
                    const p = JSON.parse(m[0]);
                    const name = p.name || p.function?.name;
                    if (name) {
                        const args = p.arguments || p.function?.arguments || {};
                        return {
                            id: `call_content_${now}_${idx}`,
                            type: 'function',
                            function: {
                                name,
                                arguments: typeof args === 'string' ? args : JSON.stringify(args)
                            }
                        };
                    }
                } catch (_2) {}
            }
        }
        return null;
    }

    // ======================================================
    // LIST SESSIONS (metadata only — messages live behind /messages)
    // ======================================================
    app.get('/api/v1/ai/sessions', async (req, res) => {
        try {
            const { book_id } = req.query;
            const sessions = await storage.postgres.query(
                `SELECT id, book_id, mode, topic_id, created_at, updated_at,
                        COALESCE(title, '') AS title,
                        jsonb_array_length(messages) AS message_count
                 FROM ai_chat_sessions WHERE book_id = $1 ORDER BY created_at DESC`,
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
    // RENAME SESSION (PATCH) — Android parity: BackendApi.kt PATCHes
    // { title } (BackendApi.kt:78). The route never existed → silent 404.
    // ======================================================
    app.patch('/api/v1/ai/sessions/:id', async (req, res) => {
        try {
            const { title } = req.body || {};
            if (typeof title !== 'string' || !title.trim()) {
                return res.status(400).json({ error: 'title required' });
            }
            const result = await storage.postgres.query(
                'UPDATE ai_chat_sessions SET title = $1, updated_at = $2 WHERE id = $3 RETURNING id',
                [title.trim().slice(0, 200), Date.now(), req.params.id]
            );
            if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });
            log('[AI] Session renamed:', req.params.id);
            res.json({ session_id: req.params.id, title: title.trim(), renamed: true });
        } catch (err) {
            console.error('[AI SESSION RENAME] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // DELETE SESSION — Android parity (BackendApi.kt:84) and web parity
    // (AiAssistantPage deleteSession). Both clients called this route when
    // it did not exist → silent 404, chats never deleted server-side.
    // ======================================================
    app.delete('/api/v1/ai/sessions/:id', async (req, res) => {
        try {
            const result = await storage.postgres.query(
                'DELETE FROM ai_chat_sessions WHERE id = $1 RETURNING id',
                [req.params.id]
            );
            if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });
            log('[AI] Session deleted:', req.params.id);
            res.json({ session_id: req.params.id, deleted: true });
        } catch (err) {
            console.error('[AI SESSION DELETE] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET SESSION MESSAGES (from ai_chat_sessions.messages JSON)
    // ======================================================
    app.get('/api/v1/ai/sessions/:id/messages', async (req, res) => {
        try {
            const result = await storage.postgres.query(
                'SELECT * FROM ai_chat_sessions WHERE id = $1',
                [req.params.id]
            );
            if (!result.rows.length) return res.json({ messages: [] });
            const session = result.rows[0];
            const msgs = typeof session.messages === 'string'
                ? JSON.parse(session.messages)
                : session.messages || [];
            const formatted = msgs.map((m, i) => ({
                id: i + 1,
                book_id: session.book_id,
                session_id: session.id,
                role: m.role || 'user',
                message: m.content || m.message || '',
                error: !!m.error,
                created_at: m.timestamp || Date.now(),
            }));
            res.json({ messages: formatted });
        } catch (err) {
            console.error('[AI SESSION MESSAGES] Error:', err.message);
            res.json({ messages: [] });
        }
    });

    // ======================================================
    // CREATE SESSION
    // ======================================================
    app.post('/api/v1/ai/sessions', async (req, res) => {
        try {
            const { book_id, title, mode, topic_id } = req.body || {};
            const scopedBookId = req.scopedBookId || book_id || null;
            if (!scopedBookId) return res.status(400).json({ error: 'book_id required' });

            const id = `ai-session-${Date.now()}-${++sessionIdCounter}`;
            const cleanTitle = (typeof title === 'string' && title.trim()) ? title.trim().slice(0, 200) : 'Chat';
            const session = {
                id, book_id: scopedBookId, title: cleanTitle, mode: mode || 'chat',
                topic_id: topic_id || 'book',
                messages: [], created_at: Date.now(), updated_at: Date.now(),
                context: null, locked: false,
            };

             await storage.postgres.query(
                `INSERT INTO ai_chat_sessions (id, book_id, title, mode, topic_id, messages, created_at, updated_at, context, locked)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [session.id, session.book_id, session.title, session.mode, session.topic_id,
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
        // Hoisted so the catch block can persist the failed turn (user
        // message + error explanation) into the session history — without
        // this the 504 explanation never reached the UI after a reload
        // (messages live in PG: ai_chat_sessions.messages).
        let activeSessionId = null;
        let userContent = '';
        try {
            const { session_id, message, messages, book_id, system, mode, scene_id, topic_id } = req.body || {};

            // Accept either `messages` array (frontend format) or `message` string (legacy)
            const hasMessagesArray = Array.isArray(messages) && messages.length > 0;
            if (!hasMessagesArray && !message) {
                return res.status(400).json({ error: 'messages or message required' });
            }

            // The AUTHORIZED book — set by aiBookGuard. Never re-derive a
            // different one from the body (cross-tenant provider/data/write).
            const scopedBookId = req.scopedBookId || book_id || null;

            // Auto-create session if session_id not provided
            activeSessionId = session_id;
            if (!activeSessionId) {
                if (!scopedBookId) {
                    return res.status(400).json({ error: 'book_id required when no session_id' });
                }
                const id = `ai-session-${Date.now()}-${++sessionIdCounter}`;
                await storage.postgres.query(
                    `INSERT INTO ai_chat_sessions (id, book_id, mode, topic_id, messages, created_at, updated_at, context, locked)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [id, scopedBookId, mode || 'chat', topic_id || 'book',
                     JSON.stringify([]), Date.now(), Date.now(), null, false]
                );
                activeSessionId = id;
                log('[AI] Auto-created session:', id, 'for book:', scopedBookId);
            }

            const result = await storage.postgres.query(
                'SELECT * FROM ai_chat_sessions WHERE id = $1', [activeSessionId]
            );
            if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

            const session = result.rows[0];
            const storedMessages = typeof session.messages === 'string'
                ? JSON.parse(session.messages) : session.messages || [];
            const bookId = req.scopedBookId || book_id || session.book_id;

            // Load book data for context
            let bookData = null;
            try { bookData = book.loadBook(bookId) || lazyBook.loadDraftBook(bookId); } catch (_) {}

            const isLocked = bookData?.manifest?.locked === true;
            const sessionMode = mode || session.mode || 'chat';
            const tools = chatEngine.getToolsForMode(sessionMode, bookId, isLocked);

            const ai = await resolveChatAI(bookId);
            if (!ai.apiKey) return aiUnavailable(res);

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
                systemPrompt = chatEngine.buildChatSystemPrompt({
                    mode: mode || session.mode || 'conversation',
                    topic: topic_id || session.topic_id || 'book',
                    lang: req.body?.lang || 'auto',
                    bookData,
                    sceneId: req.body?.scene_id || null,
                    unitIndex: req.body?.unit_index ?? null,
                    modelName: ai.model,
                });

            }

            const bookContext = chatEngine.buildBookContext(bookData);
            if (bookContext) systemPrompt += '\n\n' + bookContext;

            // Build API messages for AI call
            let apiMessages;

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
            const timeout = setTimeout(() => controller.abort(), AI_FETCH_TIMEOUT_MS);
            const response = await safeFetch(`${ai.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ai.apiKey}` },
                body: JSON.stringify({
                    model: ai.model,
                    messages: apiMessages,
                    tools: tools.length > 0 ? tools : undefined,
                    tool_choice: tools.length > 0 ? 'auto' : undefined,
                    ...aiRequestBodyExtras(tools),
                }),
                signal: controller.signal,
                validatePublic: ai.validatePublic,
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
            // Also strip partial tool_call remnants without the opening '<' (e.g. 'tool_call>')
            replyText = replyText.replace(/tool_call[^>]*>/gi, '').trim();
            replyText = replyText.replace(/\/?tool_call\b/gi, '').trim();
            // Catch any remaining tool_call-like fragments where leading chars may be missing
            // (e.g. 'ool_call>' — Qwen3 sometimes outputs partial tag remnants)
            replyText = replyText.replace(/[a-z]*_call[^>]*>/gi, '').trim();
            // Only extract tool calls from content if model didn't return structured tool_calls
            // (avoids duplicates — Qwen3 sometimes puts tool_call JSON in both places)
            const structuredToolCalls = aiMessage?.tool_calls || [];
            let contentToolCalls = [];
            if (structuredToolCalls.length === 0) {
                const result = extractToolCallsFromContent(replyText);
                contentToolCalls = result.toolCalls;
                replyText = result.cleanedContent;
            }
            // If after stripping, the reply is just garbage remnants (e.g. 'ool_call>', 'tool_call>'),
            // treat as empty so the fallback message below kicks in.
            // A remnant is considered garbage if:
            //   - it has no real word of 3+ letters, OR
            //   - it contains '_call' (a tool_call-like fragment)
            if (replyText && replyText.length < 30 && (!/[\w\u0400-\u04FF]{3,}/.test(replyText) || /_call/i.test(replyText))) {
                replyText = '';
            }
            const toolCalls = [...contentToolCalls, ...structuredToolCalls];

            // Handle tool calls
            let patches = [];
            let toolResults = [];
            let lastEditError = null;

            if (toolCalls.length > 0) {
                for (const tc of toolCalls) {
                    if (tc.function.name === 'edit_book') {
                        try {
                            const args = JSON.parse(tc.function.arguments);
                            // Validated application: patch → contract validation →
                            // result. A structurally broken result (e.g. voices.json
                            // becoming a string instead of an object) is rejected
                            // here and never reaches the save block below.
                            const patchResult = chatEngine.applyPatchesValidated(bookData, args.patches || []);
                            if (patchResult.errors.length > 0) {
                                const errMsg = patchResult.errors.join('; ');
                                toolResults.push({ tool: 'edit_book', error: errMsg, validation_errors: patchResult.validation_errors });
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
                    // Re-apply with validation (defense in depth): the save block
                    // is the last gate before disk — an invalid candidate state
                    // must never be written and must not be reported as applied.
                    const patchResult = chatEngine.applyPatchesValidated(bookData, patches);
                    if (patchResult.errors.length > 0) {
                        // Reject the whole mutation: keep previous canonical state,
                        // report the failure to the assistant/user, apply nothing.
                        if (!lastEditError) lastEditError = patchResult.errors.join('; ');
                        patches = [];
                        toolResults.push({ tool: 'edit_book', error: lastEditError, validation_errors: patchResult.validation_errors, rejected: true });
                    } else if (patchResult.result) {
                        if (patchResult.result.chapters?.length > 0) {
                            // Chapters are intact — use saveBookBundle for full multi-file save
                            // (bible → bible.json, locations → locations.json, etc.)
                            book.saveBookBundle(patchResult.result);
                        } else {
                            // ⚠️ Chapters array is empty — likely a corrupted load.
                            // Save all files EXCEPT chapters to avoid deleting orphaned
                            // chapter files via saveBookBundle's cleanup logic.
                            const bookDir = lazyBook.getBookDir(bookId);
                            const j = require('path').join;
                            const validateFile = require('../book/bundle-validator.cjs').validateBundleFile;
                            const targets = [
                                ['manifest.json', patchResult.result.manifest],
                                ['book.json', patchResult.result.book],
                                ['bible.json', patchResult.result.bible],
                                ['locations.json', patchResult.result.locations],
                                ['voices.json', patchResult.result.voices],
                                ['characters.json', patchResult.result.characters],
                            ].filter(([, data]) => data != null);
                            // Validate EVERY file BEFORE the first write — a failing
                            // file aborts the whole save, previous state stays intact.
                            for (const [name, data] of targets) {
                                const fileCheck = validateFile(name, data);
                                if (!fileCheck.valid) {
                                    throw new Error(`Bundle validation failed (${fileCheck.errors.join('; ')})`);
                                }
                            }
                            for (const [name, data] of targets) {
                                fs.writeFileSync(j(bookDir, name), JSON.stringify(data, null, 2));
                            }
                            log('[AI] Book updated (targeted save — chapters skipped):', patches.length, 'patches applied to', bookId);
                        }
                    }
                } catch (saveErr) {
                    console.error('[AI] Failed to save updated book:', saveErr.message);
                    if (!lastEditError) lastEditError = saveErr.message;
                    // Nothing was persisted — do not report success.
                    patches = [];
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

            // No content AND no tool calls — the model produced nothing usable
            // (e.g. a reasoning model burned the whole max_tokens budget on
            // reasoning). Report it honestly instead of returning an empty
            // reply that UIs render as a fake "tool executed" message.
            if (!replyText && toolCalls.length === 0) {
                replyText = '⚠️ The assistant returned no result. Please try again.';
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

            // Structured validation info for the assistant/API: names the exact
            // file/resource that failed the bundle contract, so a corrective
            // patch ("почини voices.json") lands in the very next turn —
            // the error reply is stored in session history for that purpose.
            const validationErrors = toolResults
                .flatMap(tr => tr.validation_errors || []);

            res.json({
                reply: replyText,
                tool_calls: toolCalls,
                tool_results: toolResults,
                patches_applied: patches.length,
                validation_errors: validationErrors,
                session_id: activeSessionId,
            });
        } catch (err) {
            console.error('[AI CHAT] Error:', err.message);
            if (err.code === 'ENDPOINT_NOT_PUBLIC') {
                return res.status(502).json({ error: err.message });
            }
            if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
                // Persist the failed turn (user message + explanation) so the
                // explanation survives a reload and is visible in session
                // history. Best-effort: a PG hiccup must not mask the 504.
                try {
                    if (activeSessionId) {
                        const stored = await storage.postgres.query(
                            'SELECT messages FROM ai_chat_sessions WHERE id = $1', [activeSessionId]
                        );
                        const msgs = typeof stored.rows[0]?.messages === 'string'
                            ? JSON.parse(stored.rows[0].messages) : stored.rows[0]?.messages || [];
                        msgs.push({ role: 'user', content: userContent, timestamp: Date.now() });
                        msgs.push({
                            role: 'assistant',
                            content: '⚠️ AI не ответил за отведённое время. Попробуйте отправить более короткий запрос или повторить позже.',
                            error: true, timestamp: Date.now(),
                        });
                        await storage.postgres.query(
                            'UPDATE ai_chat_sessions SET messages = $1, updated_at = $2 WHERE id = $3',
                            [JSON.stringify(msgs), Date.now(), activeSessionId]
                        );
                    }
                } catch (persistErr) {
                    console.error('[AI CHAT] Failed to persist timeout turn:', persistErr.message);
                }
                return res.status(504).json({ error: 'AI не ответил за отведённое время. Попробуйте отправить более короткий запрос или повторить позже.', code: 'ai_timeout' });
            }
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] AI routes loaded');
};
