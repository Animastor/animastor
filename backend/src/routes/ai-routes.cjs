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
    const sharedPool = require('../services/ai-connector/shared-pool');
    async function resolveChatAI(bookId) {
        const provider = bookId
            ? await workspaceAi.resolveAIForBook(bookId, { purpose: 'chat' })
            : await workspaceAi.resolveSystemFallback();
        // Local AI Connector snapshot (LAC §9): no endpoint/key — the fetch
        // is replaced by the connector WS transport. Model may fall back to
        // the connector's first DISCOVERED model (discovered ≠ loaded, §7) so
        // a binding without an explicit model still gets an honest answer
        // from the runtime instead of a cloud default model id.
        // A SHARED snapshot (Phase 2) carries source:'shared' + the pool
        // selection (always with model + connectorId — the pool never
        // resolves without a usable model); `shared` rides through so the
        // fetch site reserves/releases the per-inference pool slot.
        if (provider && provider.transport === 'connector') {
            let model = provider.model || null;
            if (!model && provider.connectorId) {
                try {
                    const { getConnector } = require('../storage/postgres/repositories/ai-connector-repo');
                    const row = await getConnector(provider.connectorId);
                    const models = Array.isArray(row && row.models) ? row.models : [];
                    if (models.length > 0) model = String(models[0]);
                } catch (_) { /* transport reports the honest error below */ }
            }
            return {
                transport: 'connector',
                connectorId: provider.connectorId,
                baseUrl: null,
                apiKey: '',
                model: model || '',
                source: provider.source,
                shared: provider.shared || null,
                workspaceId: provider.workspaceId || null,
                validatePublic: false,
            };
        }
        return {
            baseUrl: provider.endpoint || chatEngine.AI_API_BASE_URL,
            apiKey: provider.apiKey || '',
            model: provider.model || process.env.AI_MODEL || 'qwen/qwen3-32b',
            source: provider.source,
            shared: null,
            workspaceId: null,
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

    // Local AI Connector per-message cap is 32 KB (lib/chat.cjs
    // maxMessageChars, mirrored by transport). The base system prompt plus
    // tool instructions must also fit, so the book context budget is kept
    // below it; anything larger rides as the compact structural summary.
    const CONNECTOR_BOOK_CONTEXT_BUDGET = 24 * 1024;

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
        // Consumer-side AI source provenance (Phase 2): 'private-local' |
        // 'shared' | 'cloud' | 'system' — a safe token for the UI badge,
        // never endpoint/owner detail.
        let aiSource = null;
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
            // Connector snapshots legitimately carry no apiKey (LAC §9) —
            // the connector path is guarded below at the fetch site.
            if (!ai.apiKey && ai.transport !== 'connector') return aiUnavailable(res);
            // A connector binding without a usable model id (no bound model,
            // no discovered models) must fail closed with a clear message.
            if (ai.transport === 'connector' && (!ai.connectorId || !ai.model)) {
                return res.status(503).json({
                    error: 'Local AI is not ready — select a connector and a model in Settings / AI',
                    code: 'local_ai_not_ready',
                });
            }

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
            if (bookContext) {
                // Connector per-message cap is 32 KB (local-ai-connector
                // lib/chat.cjs maxMessageChars, mirrored by the transport) —
                // the full book JSON for real books does not fit. Oversized
                // context falls back to the compact structural summary so a
                // private-local request fails closed on nothing else.
                const withinConnectorBudget = bookContext.length <= CONNECTOR_BOOK_CONTEXT_BUDGET;
                systemPrompt += '\n\n' + (ai.transport !== 'connector' || withinConnectorBudget
                    ? bookContext
                    : chatEngine.buildCompactBookContext(bookData));
            }

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

            let aiResponse;
            if (ai.transport === 'connector') {
                // Local AI Connector path (LAC §9): the completion rides the
                // connector's authenticated WS session — no server-side URL,
                // no Authorization header, no SSRF surface (AD-5). The cloud
                // timer is authoritative (§5); runSharedInference maps to the
                // sanitized code surface (§4) and, for SHARED snapshots
                // (Phase 2), owns the per-inference pool slot (reserved
                // before the call; released on success/error/timeout/cancel/
                // disconnect via its finally). Tool payloads are NOT
                // forwarded (Phase-4 contract: only max_tokens/temperature
                // survive) — content-embedded tool calls still go through
                // extractToolCallsFromContent below.
                const tokenBudget = tools.length > 0
                    ? Math.min(MAX_TOKENS_WITH_TOOLS, 8192) // connector LIMITS.maxMaxTokens
                    : MAX_TOKENS_PLAIN;
                // Shared capacity is borrowed: a consumer that walked away
                // must not keep burning the owner's slot — res 'close' before
                // the response completed aborts the request (the private
                // path keeps its existing no-abort semantics unchanged).
                let disconnectSignal = null;
                let onConnClosed = null;
                if (ai.source === 'shared') {
                    const abort = new AbortController();
                    disconnectSignal = abort.signal;
                    onConnClosed = () => { if (!res.writableEnded) abort.abort(); };
                    res.on('close', onConnClosed);
                }
                let cres;
                try {
                    cres = await sharedPool.runSharedInference(ai, {
                        model: ai.model,
                        messages: apiMessages,
                        params: { max_tokens: tokenBudget, temperature: 0.3 },
                    }, { timeoutMs: AI_FETCH_TIMEOUT_MS, signal: disconnectSignal });
                } finally {
                    if (onConnClosed) res.removeListener('close', onConnClosed);
                }
                if (!cres.ok) {
                    const code = cres.code || 'runtime_error';
                    const status = (code === 'connector_offline' || code === 'shared_unavailable' || code === 'busy')
                        ? 503 : (code === 'timeout' || code === 'cancelled' ? 504 : 502);
                    console.error(`[AI] connector chat error: ${code}`);
                    return res.status(status).json({
                        error: sharedPool.describeSharedError(code),
                        code,
                    });
                }
                aiResponse = {
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: cres.content },
                        finish_reason: cres.finishReason || 'stop',
                    }],
                    usage: cres.usage || undefined,
                };
                // Consumer-side source provenance (Phase 2, minimal):
                // 'private-local' | 'shared' — safe token only, no endpoint
                // or owner detail rides the API response.
                aiSource = ai.source === 'shared' ? 'shared' : 'private-local';
            } else {
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

                aiResponse = await response.json();
            }
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
                ai_source: aiSource || (ai.source === 'workspace' ? 'cloud' : (ai.source === 'system' ? 'system' : ai.source)),
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

    // ======================================================
    // CHAT STREAM (production SSE — Phase 3 LLM sharing)
    // ======================================================
    // The production streaming path:
    //
    //   Browser → THIS route → resolver (resolveChatAI — the SAME seam as
    //   the non-streaming chat route) → private connector OR shared pool
    //   endpoint → connector WS → local runtime SSE → connector chat.delta
    //   → here → HTTP SSE to the browser.
    //
    // ONE transport, ONE protocol: connector inference rides the existing
    // runSharedInference streaming branch (params.stream:true over the
    // connector WS — Phase 5 chat.delta machinery unchanged); shared slots
    // keep the exact Phase 2 lifecycle (reserved before the call, released
    // on success/error/timeout/cancel/disconnect via its finally). Cloud
    // providers keep their existing non-streaming upstream call (re-emitted
    // as ONE delta + terminal — no second upstream protocol is invented).
    //
    // SSE contract (one JSON object per `data:` frame):
    //   meta  { session_id, ai_source, model }   — once, after resolution
    //   delta { delta: "text" }                  — N× (connector streams;
    //                                              cloud = one full-text delta)
    //   done  { reply, tool_calls, tool_results, patches_applied,
    //           validation_errors, session_id, ai_source, usage,
    //           finish_reason }                  — terminal, exactly once
    //   error { error, code, partial? }          — terminal, exactly once
    //                                           (sanitized code + fixed
    //                                           message only)
    // Exactly ONE terminal event (done XOR error) is ever written. Raw
    // runtime errors, URLs, credentials and connector secrets never cross —
    // every failure degrades to the sanitized code surface (Phase 2 §5).
    //
    // Cancellation path (critical): HTTP client disconnect → res 'close' →
    // AbortSignal → connector transport chat.cancel → local runtime abort
    // → slot released by runSharedInference's finally. No pending request
    // and no shared slot survives any failure path.
    // ======================================================
    // <think>…</think> reasoning blocks are internal — they must not appear
    // in the user-visible stream (the non-streaming route strips them from
    // the final text). The stream filter suppresses them incrementally,
    // holding back a possible partial tag so a tag split across two deltas
    // is still caught. The terminal done event carries the SAME fully
    // stripped/processed reply as the non-streaming route, so the client
    // always converges to the canonical text.
    function makeThinkFilter() {
        let inside = false;
        let tail = '';
        const partialTagLen = (text, tag) => {
            const max = Math.min(tag.length - 1, text.length);
            for (let k = max; k > 0; k--) {
                if (text.endsWith(tag.slice(0, k))) return k;
            }
            return 0;
        };
        return (delta) => {
            let text = tail + delta;
            tail = '';
            let out = '';
            while (text) {
                if (!inside) {
                    const i = text.indexOf('<think>');
                    if (i === -1) {
                        const hold = partialTagLen(text, '<think>');
                        out += text.slice(0, text.length - hold);
                        tail = text.slice(text.length - hold);
                        break;
                    }
                    out += text.slice(0, i);
                    text = text.slice(i + 7);
                    inside = true;
                } else {
                    const j = text.indexOf('</think>');
                    if (j === -1) {
                        const hold = partialTagLen(text, '</think>');
                        tail = text.slice(text.length - hold);
                        break;
                    }
                    text = text.slice(j + 8);
                    inside = false;
                }
            }
            return out;
        };
    }

    // The bounded per-request inference window for the stream route: the
    // client may tighten it (its own request), the cloud timer stays
    // authoritative (transport clamps to the same 180 s ceiling).
    const STREAM_MIN_TIMEOUT_MS = 1_000;

    function clampStreamTimeoutMs(raw) {
        const n = Number(raw);
        if (!Number.isFinite(n)) return AI_FETCH_TIMEOUT_MS;
        return Math.max(STREAM_MIN_TIMEOUT_MS, Math.min(Math.floor(n), AI_FETCH_TIMEOUT_MS));
    }

    // Map a resolved chat provider to the SAFE consumer-facing source token
    // (Phase 2 §6 discipline: 'private-local' | 'shared' | 'cloud' | 'system'
    // — never endpoint/owner detail).
    function chatAiSourceToken(ai) {
        if (ai.transport === 'connector') return ai.source === 'shared' ? 'shared' : 'private-local';
        if (ai.source === 'workspace') return 'cloud';
        if (ai.source === 'system') return 'system';
        return ai.source || 'system';
    }

    app.post('/api/v1/ai/chat/stream', async (req, res) => {
        // Hoisted for the failure-persistence helpers (same rationale as the
        // non-streaming route: a failed turn must survive a reload).
        let activeSessionId = null;
        let userContent = '';
        let storedMessages = [];
        const aiSource = { value: null };
        // Terminal-event contract: exactly one terminal frame, ever.
        let terminalSent = false;
        let heartbeat = null;

        // Best-effort persistence of a FAILED turn (user message + sanitized
        // explanation / partial answer) — mirrors the non-streaming route's
        // catch-block discipline. Never masks the terminal event.
        const persistFailedTurn = async (assistantText) => {
            try {
                if (!activeSessionId) return;
                const stored = await storage.postgres.query(
                    'SELECT messages FROM ai_chat_sessions WHERE id = $1', [activeSessionId]
                );
                const msgs = typeof stored.rows[0]?.messages === 'string'
                    ? JSON.parse(stored.rows[0].messages) : stored.rows[0]?.messages || [];
                if (userContent) msgs.push({ role: 'user', content: userContent, timestamp: Date.now() });
                if (assistantText) {
                    msgs.push({ role: 'assistant', content: assistantText, error: true, timestamp: Date.now() });
                }
                await storage.postgres.query(
                    'UPDATE ai_chat_sessions SET messages = $1, updated_at = $2 WHERE id = $3',
                    [JSON.stringify(msgs), Date.now(), activeSessionId]
                );
            } catch (persistErr) {
                console.error('[AI STREAM] Failed to persist failed turn:', persistErr.message);
            }
        };

        try {
            const { session_id, message, messages, book_id, system, mode, scene_id, topic_id } = req.body || {};

            // Same input contract as the non-streaming route.
            const hasMessagesArray = Array.isArray(messages) && messages.length > 0;
            if (!hasMessagesArray && !message) {
                return res.status(400).json({ error: 'messages or message required' });
            }

            const scopedBookId = req.scopedBookId || book_id || null;

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
                log('[AI STREAM] Auto-created session:', id, 'for book:', scopedBookId);
            }

            const result = await storage.postgres.query(
                'SELECT * FROM ai_chat_sessions WHERE id = $1', [activeSessionId]
            );
            if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

            const session = result.rows[0];
            storedMessages = typeof session.messages === 'string'
                ? JSON.parse(session.messages) : session.messages || [];
            const bookId = req.scopedBookId || book_id || session.book_id;

            let bookData = null;
            try { bookData = book.loadBook(bookId) || lazyBook.loadDraftBook(bookId); } catch (_) {}

            const isLocked = bookData?.manifest?.locked === true;
            const sessionMode = mode || session.mode || 'chat';
            const tools = chatEngine.getToolsForMode(sessionMode, bookId, isLocked);

            // The SAME resolver seam as the non-streaming route — shared AI,
            // private Local AI and cloud providers all flow through here.
            const ai = await resolveChatAI(bookId);
            if (!ai.apiKey && ai.transport !== 'connector') return aiUnavailable(res);
            if (ai.transport === 'connector' && (!ai.connectorId || !ai.model)) {
                return res.status(503).json({
                    error: 'Local AI is not ready — select a connector and a model in Settings / AI',
                    code: 'local_ai_not_ready',
                });
            }
            aiSource.value = chatAiSourceToken(ai);

            let systemPrompt;
            if (system) {
                systemPrompt = system;
            } else {
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
            if (bookContext) {
                // Same connector per-message cap as the non-streaming route —
                // oversized book JSON falls back to the compact summary.
                const withinConnectorBudget = bookContext.length <= CONNECTOR_BOOK_CONTEXT_BUDGET;
                systemPrompt += '\n\n' + (ai.transport !== 'connector' || withinConnectorBudget
                    ? bookContext
                    : chatEngine.buildCompactBookContext(bookData));
            }

            let apiMessages;
            if (hasMessagesArray) {
                apiMessages = [
                    { role: 'system', content: systemPrompt },
                    ...messages,
                ];
                const lastUser = messages.filter(m => m.role === 'user').pop();
                userContent = lastUser?.content || '';
            } else {
                userContent = message;
                apiMessages = [
                    { role: 'system', content: systemPrompt },
                    ...(storedMessages.slice(-20).map(m => ({ role: m.role, content: m.content }))),
                    { role: 'user', content: message },
                ];
            }

            // ── Stream phase: headers go out; every failure from here on is
            // a terminal SSE error event (never a raw runtime detail). ──
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
            res.flushHeaders?.();

            const writeEvent = (event, data) => {
                try {
                    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                    return true;
                } catch (_) { return false; }
            };
            const sendTerminal = (event, data) => {
                if (terminalSent) return;
                terminalSent = true;
                writeEvent(event, data);
                try { res.end(); } catch (_) {}
            };

            // Heartbeat comment keeps proxies/clients alive during long
            // model cold-loads (30–60 s with no delta); SSE comments are
            // ignored by parsers.
            heartbeat = setInterval(() => {
                try { res.write(': ping\n\n'); } catch (_) {}
            }, 15_000);
            if (heartbeat.unref) heartbeat.unref();

            // Cancel path: HTTP disconnect → AbortSignal → connector
            // transport chat.cancel → runtime abort → slot freed. Applies to
            // EVERY source on this route (the client is gone — the inference
            // must stop; the non-streaming route keeps its own semantics).
            const abort = new AbortController();
            let clientGone = false;
            const onConnClosed = () => {
                clientGone = true;
                abort.abort();
            };
            res.on('close', onConnClosed);

            writeEvent('meta', {
                session_id: activeSessionId,
                ai_source: aiSource.value,
                model: ai.model || undefined,
            });

            let finalReply = '';
            let terminalPayload = null;
            try {
                if (ai.transport === 'connector') {
                    const tokenBudget = tools.length > 0
                        ? Math.min(MAX_TOKENS_WITH_TOOLS, 8192)
                        : MAX_TOKENS_PLAIN;
                    const filter = makeThinkFilter();
                    let streamedLen = 0;
                    const cres = await sharedPool.runSharedInference(ai, {
                        model: ai.model,
                        messages: apiMessages,
                        params: { max_tokens: tokenBudget, temperature: 0.3 },
                    }, {
                        timeoutMs: clampStreamTimeoutMs(req.body?.timeout_ms),
                        signal: abort.signal,
                        onDelta: (delta) => {
                            const visible = filter(delta);
                            if (!visible) return;
                            streamedLen += visible.length;
                            if (!writeEvent('delta', { delta: visible })) {
                                // The client is gone mid-stream — stop the
                                // inference the same way a disconnect does.
                                abort.abort();
                            }
                        },
                    });
                    if (!cres.ok) {
                        console.error(`[AI STREAM] connector stream error: ${cres.code}`);
                        // Partial output is never lost: the client already
                        // holds the deltas; the error frame re-states the
                        // visible partial for reconciliation.
                        const partial = (clientGone ? null : (cres.partial || (streamedLen > 0 ? null : null)));
                        const errorData = {
                            error: sharedPool.describeSharedError(cres.code),
                            code: cres.code || 'runtime_error',
                        };
                        if (cres.partial) errorData.partial = cres.partial;
                        else if (partial) errorData.partial = partial;
                        if (!clientGone) sendTerminal('error', errorData);
                        await persistFailedTurn(
                            cres.partial || (streamedLen > 0 ? null : `⚠️ ${errorData.error}`)
                        );
                        return;
                    }
                    // Terminal success → the SAME post-processing pipeline as
                    // the non-streaming route (strip, tool extraction, patch
                    // application, persistence) on the FULL content. The
                    // canonical text replaces any streamed approximation
                    // client-side (converge-on-terminal semantics — the same
                    // contract as OpenAI SSE clients).
                    const processed = processChatReply(cres.content || '', [], bookData, bookId);
                    finalReply = processed.replyText;
                    terminalPayload = {
                        reply: finalReply,
                        tool_calls: processed.toolCalls,
                        tool_results: processed.toolResults,
                        patches_applied: processed.patches.length,
                        validation_errors: processed.validationErrors,
                        session_id: activeSessionId,
                        ai_source: aiSource.value,
                        finish_reason: cres.finishReason || 'stop',
                        ...(cres.usage ? { usage: cres.usage } : {}),
                    };
                    await persistSuccessTurn(storedMessages, userContent, finalReply, processed.toolCalls);
                } else {
                    // Cloud provider branch: the existing non-streaming
                    // upstream call, re-emitted as ONE delta + terminal. No
                    // second upstream protocol; cloud behavior unchanged.
                    const controller = new AbortController();
                    const onOuterAbort = () => controller.abort();
                    abort.signal.addEventListener('abort', onOuterAbort, { once: true });
                    const timeout = setTimeout(() => controller.abort(), clampStreamTimeoutMs(req.body?.timeout_ms));
                    let response;
                    try {
                        response = await safeFetch(`${ai.baseUrl}/chat/completions`, {
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
                    } finally {
                        clearTimeout(timeout);
                        abort.signal.removeEventListener('abort', onOuterAbort);
                    }

                    if (!response.ok) {
                        const errText = await response.text().catch(() => '');
                        console.error('[AI STREAM] API error:', response.status, errText.substring(0, 200));
                        const errorData = { error: `AI API error: ${response.status}`, code: 'upstream_error' };
                        if (!clientGone) sendTerminal('error', errorData);
                        await persistFailedTurn(`⚠️ ${errorData.error}`);
                        return;
                    }
                    const aiResponse = await response.json();
                    const aiMessage = aiResponse.choices?.[0]?.message;
                    let replyText = aiMessage?.content || '';
                    const processed = processChatReply(replyText, aiMessage?.tool_calls || [], bookData, bookId);
                    finalReply = processed.replyText;
                    if (finalReply && !clientGone) writeEvent('delta', { delta: finalReply });
                    terminalPayload = {
                        reply: finalReply,
                        tool_calls: processed.toolCalls,
                        tool_results: processed.toolResults,
                        patches_applied: processed.patches.length,
                        validation_errors: processed.validationErrors,
                        session_id: activeSessionId,
                        ai_source: aiSource.value,
                        finish_reason: aiResponse.choices?.[0]?.finish_reason || 'stop',
                        ...(aiResponse.usage ? { usage: aiResponse.usage } : {}),
                    };
                    await persistSuccessTurn(storedMessages, userContent, finalReply, processed.toolCalls);
                }

                if (!clientGone) sendTerminal('done', terminalPayload);
                else persistFailedTurn(finalReply || '⚠️ Generation cancelled.').catch?.(() => {});
            } catch (err) {
                // Mid-stream failure → ONE safe terminal error. Client aborts
                // and dead sockets are not "errors" for the client (it is
                // gone) — the inference is already cancelled via the signal.
                const isAbort = err.name === 'AbortError' || err.code === 'ABORT_ERR';
                if (err.code === 'ENDPOINT_NOT_PUBLIC') {
                    const errorData = { error: err.message, code: 'endpoint_not_allowed' };
                    if (!clientGone) sendTerminal('error', errorData);
                    await persistFailedTurn(`⚠️ ${errorData.error}`);
                } else if (isAbort && !clientGone) {
                    const errorData = { error: 'AI не ответил за отведённое время. Попробуйте отправить более короткий запрос или повторить позже.', code: 'timeout' };
                    sendTerminal('error', errorData);
                    await persistFailedTurn(`⚠️ ${errorData.error}`);
                } else if (!clientGone) {
                    const errorData = { error: 'AI streaming request failed.', code: 'stream_error' };
                    sendTerminal('error', errorData);
                    await persistFailedTurn(`⚠️ ${errorData.error}`);
                } else if (isAbort) {
                    await persistFailedTurn(finalReply || '⚠️ Generation cancelled.');
                }
            } finally {
                if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
                res.removeListener('close', onConnClosed);
                streamFinished = true;
            }
            return;
        } catch (err) {
            // Pre-flight failure AFTER the SSE headers went out must still
            // honor the terminal contract; before that, plain JSON errors
            // apply (handled by the returns above).
            console.error('[AI STREAM] Error:', err.message);
            if (terminalSent || res.headersSent) {
                sendTerminal('error', { error: 'AI streaming request failed.', code: 'stream_error' });
                return;
            }
            if (err.code === 'ENDPOINT_NOT_PUBLIC') {
                return res.status(502).json({ error: err.message });
            }
            res.status(500).json({ error: err.message });
        }

        // ── local helpers (per-request) ──
        // Persist a successful turn: identical merge semantics to the
        // non-streaming route (full stored history + user + assistant).
        async function persistSuccessTurn(prevMessages, userText, replyText, toolCalls) {
            try {
                const updatedMessages = [
                    ...prevMessages,
                    ...(userText ? [{ role: 'user', content: userText, timestamp: Date.now() }] : []),
                    { role: 'assistant', content: replyText, tool_calls: toolCalls || [], timestamp: Date.now() },
                ];
                await storage.postgres.query(
                    'UPDATE ai_chat_sessions SET messages = $1, updated_at = $2 WHERE id = $3',
                    [JSON.stringify(updatedMessages), Date.now(), activeSessionId]
                );
            } catch (persistErr) {
                console.error('[AI STREAM] Failed to persist turn:', persistErr.message);
            }
        }
    });

    // Reply post-processing shared by both branches of the stream route:
    // the exact strip/extract/apply pipeline of the non-streaming chat route
    // (think blocks, tool_call remnants, content-embedded tool calls, patch
    // application with validation, and the honest no-result fallback).
    function processChatReply(rawContent, structuredToolCalls, bookData, bookId) {
        let replyText = rawContent || '';
        replyText = replyText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        replyText = replyText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
        replyText = replyText.replace(/<\/?tool_call[^>]*>/gi, '').trim();
        replyText = replyText.replace(/tool_call[^>]*>/gi, '').trim();
        replyText = replyText.replace(/\/?tool_call\b/gi, '').trim();
        replyText = replyText.replace(/[a-z]*_call[^>]*>/gi, '').trim();

        let contentToolCalls = [];
        if ((structuredToolCalls || []).length === 0) {
            const result = extractToolCallsFromContent(replyText);
            contentToolCalls = result.toolCalls;
            replyText = result.cleanedContent;
        }
        if (replyText && replyText.length < 30 && (!/[\w\u0400-\u04FF]{3,}/.test(replyText) || /_call/i.test(replyText))) {
            replyText = '';
        }
        const toolCalls = [...contentToolCalls, ...(structuredToolCalls || [])];

        let patches = [];
        const toolResults = [];
        let lastEditError = null;

        if (toolCalls.length > 0) {
            for (const tc of toolCalls) {
                if (tc.function.name === 'edit_book') {
                    try {
                        const args = JSON.parse(tc.function.arguments);
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

        if (patches.length > 0 && bookData) {
            try {
                const patchResult = chatEngine.applyPatchesValidated(bookData, patches);
                if (patchResult.errors.length > 0) {
                    if (!lastEditError) lastEditError = patchResult.errors.join('; ');
                    patches = [];
                    toolResults.push({ tool: 'edit_book', error: lastEditError, validation_errors: patchResult.validation_errors, rejected: true });
                } else if (patchResult.result) {
                    if (patchResult.result.chapters?.length > 0) {
                        book.saveBookBundle(patchResult.result);
                    } else {
                        // Targeted save without chapters (same gate as the
                        // non-streaming route — a corrupted load never wipes
                        // chapter files).
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
                        for (const [name, data] of targets) {
                            const fileCheck = validateFile(name, data);
                            if (!fileCheck.valid) {
                                throw new Error(`Bundle validation failed (${fileCheck.errors.join('; ')})`);
                            }
                        }
                        for (const [name, data] of targets) {
                            fs.writeFileSync(j(bookDir, name), JSON.stringify(data, null, 2));
                        }
                        log('[AI STREAM] Book updated (targeted save):', patches.length, 'patches applied to', bookId);
                    }
                }
            } catch (saveErr) {
                console.error('[AI STREAM] Failed to save updated book:', saveErr.message);
                if (!lastEditError) lastEditError = saveErr.message;
                patches = [];
            }
        }

        if (!replyText && toolCalls.length > 0) {
            if (lastEditError) {
                replyText = `⚠️ Edit error: ${lastEditError}`;
            } else if (patches.length > 0) {
                replyText = `✅ Changes applied: ${patches.length} patch(es) to the book.`;
            } else {
                replyText = `🤖 Processed ${toolCalls.length} tool call(s).`;
            }
        }
        if (!replyText && toolCalls.length === 0) {
            replyText = '⚠️ The assistant returned no result. Please try again.';
        }

        const validationErrors = toolResults.flatMap(tr => tr.validation_errors || []);
        return { replyText, toolCalls, toolResults, patches, validationErrors };
    }

    log('[ROUTES] AI routes loaded');
};
