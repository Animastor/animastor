const { query } = require('../storage/postgres/database');
const config = require('../config/runtime-config');
const lazyBook = require('../book/lazy-book');
const aiService = require('./ai-service');
const {
    createSession, updateSession, getSession,
    createStep, completeStep, failStep,
} = require('./agent-session');
const {
    PROGRESS_STAGES, WINDOW_SIZE, MAX_WINDOW_CHARS, STEP_RETRIES, SYSTEM_PROMPTS,
} = require('./agent-prompts');

async function callAI(messages, options) {
    const model = options?.model || config.OPENROUTER_MODEL || 'qwen/qwen3.5-122b-a10b';

    let lastError = null;
    const attemptCount = options?.retries || STEP_RETRIES;
    for (let attempt = 1; attempt <= attemptCount; attempt++) {
        try {
            const response = await aiService.callAI(messages, {
                ...options,
                model,
                timeout: options?.timeout || 180000,
                maxTokens: options?.maxTokens || 2048,
            });
            const parsed = aiService.parseJsonResponse(response.content);
            return parsed;
        } catch (err) {
            lastError = err;
            console.warn(`[AGENT] AI call attempt ${attempt} failed: ${err.message}`);
            if (attempt < attemptCount) {
                const delay = 2000 * attempt;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw new Error(`AI call failed after ${attemptCount} attempts: ${lastError?.message || 'unknown error'}`);
}

async function logConversation(sessionId, stepId, messages, responseContent) {
    const result = await query(
        `INSERT INTO agent_conversations (session_id, step_id, attempt) VALUES ($1, $2, 1) RETURNING *`,
        [sessionId, stepId]
    );
    const convId = result.rows[0].conversation_id;
    for (const msg of messages) {
        await query(
            `INSERT INTO agent_messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
            [convId, msg.role, msg.content]
        );
    }
    if (responseContent) {
        await query(
            `INSERT INTO agent_messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
            [convId, responseContent]
        );
    }
}

async function stepAnalyzeStructure(sessionId, sourceText, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'analyzing_structure', message: PROGRESS_STAGES.analyzing_structure });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.analyzing_structure });

    const step = await createStep(sessionId, 'analyze_structure', stepIndex || 0);

    const lines = sourceText.split('\n');
    const sampleLines = lines.slice(0, 80).join('\n');

    const messages = [
        { role: 'system', content: SYSTEM_PROMPTS.structure },
        { role: 'user', content: `Analyze the structure of this literary text. Extract author, title, parts, and chapters.\n\n\`\`\`\n${sampleLines}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 2048 });
        const structure = {
            author: result.author || null,
            title: result.title || null,
            has_prologue: !!result.has_prologue,
            has_epilogue: !!result.has_epilogue,
            parts: Array.isArray(result.parts) ? result.parts : [],
            chapters: Array.isArray(result.chapters) ? result.chapters : [],
        };

        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, structure);
        console.log(`[AGENT] Step 0 (structure): author=${structure.author ? '✓' : '✗'}, title=${structure.title ? '✓' : '✗'}, ${structure.chapters.length} chapters, ${structure.parts.length} parts`);
        return structure;
    } catch (err) {
        await failStep(step.step_id, err.message);
        console.error(`[AGENT] Step 0 (structure) FAILED: ${err.message}`);
        return { author: null, title: null, has_prologue: false, has_epilogue: false, parts: [], chapters: [] };
    }
}

function stripStructureFromText(sourceText, structure) {
    const lines = sourceText.split('\n');
    const linesToRemove = new Set();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (structure.author && line === structure.author.trim()) {
            linesToRemove.add(i);
            continue;
        }

        if (structure.title && line === structure.title.trim()) {
            linesToRemove.add(i);
            continue;
        }

        for (const part of structure.parts || []) {
            if (line === (part.name || '').trim()) {
                linesToRemove.add(i);
                break;
            }
        }

        for (const ch of structure.chapters || []) {
            const hl = (ch.header_line || '').trim();
            if (!hl) continue;

            const headerParts = hl.split('\n').map(p => p.trim()).filter(Boolean);
            for (const part of headerParts) {
                if (line === part) {
                    linesToRemove.add(i);
                    break;
                }
            }

            const chTitle = (ch.title || '').trim();
            if (chTitle && chTitle.length > 2 && line === chTitle && !linesToRemove.has(i)) {
                linesToRemove.add(i);
            }
        }
    }

    const cleanLines = lines.filter((_, i) => !linesToRemove.has(i));
    return cleanLines.join('\n').trim();
}

async function stepExtractCharacters(sessionId, text, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'extracting_chars', message: PROGRESS_STAGES.extracting_chars });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.extracting_chars });

    const step = await createStep(sessionId, 'analyze_characters', stepIndex || 0);

    const messages = [
        { role: 'system', content: SYSTEM_PROMPTS.characters },
        { role: 'user', content: `Extract all characters from this text:\n\n\`\`\`\n${text}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 2048 });
        const characters = result.characters || [];
        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, characters);
        console.log(`[AGENT] Step 1 (characters): ${characters.length} extracted`);
        return characters;
    } catch (err) {
        await failStep(step.step_id, err.message);
        throw err;
    }
}

async function stepExtractLocations(sessionId, text, characters, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'extracting_locs', message: PROGRESS_STAGES.extracting_locs });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.extracting_locs });

    const step = await createStep(sessionId, 'analyze_locations', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name} (${c.role || 'unknown'})`).join('\n') || 'No characters yet';
    const prompt = SYSTEM_PROMPTS.locations.replace('%EXISTING_CHARACTERS%', charsContext);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Extract all locations from this text:\n\n\`\`\`\n${text}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 1024 });
        const locations = result.locations || [];
        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, locations);
        console.log(`[AGENT] Step 2 (locations): ${locations.length} extracted`);
        return locations;
    } catch (err) {
        await failStep(step.step_id, err.message);
        throw err;
    }
}

async function stepCreateScenes(sessionId, text, characters, locations, stepIndex, progress) {
    const _progress = progress || (() => {});
    _progress({ stage: 'creating_scenes', message: PROGRESS_STAGES.creating_scenes });
    await updateSession(sessionId, { progress_msg: PROGRESS_STAGES.creating_scenes });

    const step = await createStep(sessionId, 'create_scenes', stepIndex || 0);

    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || 'None';
    const locsContext = (locations || []).map(l => `- ${l.id}: ${l.name} (${l.type || 'unknown'})`).join('\n') || 'None';

    const prompt = SYSTEM_PROMPTS.scenes
        .replace('%EXISTING_CHARACTERS%', charsContext)
        .replace('%EXISTING_LOCATIONS%', locsContext);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Split this text into scenes:\n\n\`\`\`\n${text}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 6144 });
        const scenes = result.scenes || [];
        if (scenes.length === 0) throw new Error('AI returned no scenes');
        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, scenes);
        console.log(`[AGENT] Step 3 (scenes): ${scenes.length} created`);
        return scenes;
    } catch (err) {
        await failStep(step.step_id, err.message);
        throw err;
    }
}

async function stepCreateUnits(sessionId, scene, sceneIndex, characters, stepIndex, progress) {
    const _progress = progress || (() => {});
    const msg = PROGRESS_STAGES.creating_units(sceneIndex);
    _progress({ stage: 'creating_units', message: msg });
    await updateSession(sessionId, { progress_msg: msg });

    const step = await createStep(sessionId, 'create_units', stepIndex || 0, sceneIndex);

    const sceneText = (scene.text || '').trim();
    const truncatedText = sceneText.length > 3000 ? sceneText.substring(0, 3000) + '...' : sceneText;
    const charsContext = (characters || []).map(c => `- ${c.id}: ${c.name}`).join('\n') || 'None';

    const prompt = SYSTEM_PROMPTS.units
        .replace('%SCENE_TEXT%', truncatedText)
        .replace('%EXISTING_CHARACTERS%', charsContext);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Decompose this scene into visual units:\n\n\`\`\`\n${truncatedText}\n\`\`\`` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 2048 });
        const units = result.units || [];
        if (units.length === 0) {
            units.push({ text: sceneText, type: scene.type === 'dialogue' ? 'dialogue' : 'narration' });
        }
        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, units);
        console.log(`[AGENT] Step 4 (units scene ${sceneIndex}): ${units.length} units`);
        return units;
    } catch (err) {
        await failStep(step.step_id, `AI failed, using fallback: ${err.message}`);
        console.warn(`[AGENT] Step 4 (scene ${sceneIndex}) failed, using fallback: ${err.message}`);
        return [{ text: sceneText, type: scene.type === 'dialogue' ? 'dialogue' : 'perception' }];
    }
}

async function stepCreateVisuals(sessionId, scene, units, sceneIndex, characters, locations, stepIndex, progress) {
    const _progress = progress || (() => {});
    const msg = PROGRESS_STAGES.creating_visuals(sceneIndex);
    _progress({ stage: 'creating_visuals', message: msg });
    await updateSession(sessionId, { progress_msg: msg });

    const step = await createStep(sessionId, 'create_visual_prompts', stepIndex || 0, sceneIndex);

    const contextParts = [`Title: ${scene.title || 'Untitled'}`, `Type: ${scene.type || 'narration'}`, ''];
    contextParts.push('Characters in scene:');
    for (const pId of (scene.participants || [])) {
        const ch = (characters || []).find(c => c.id === pId);
        if (ch) contextParts.push(`- ${ch.id}: ${ch.name} — ${ch.description || ''}`);
    }
    if (scene.participants && scene.participants.length > 0 && contextParts.length <= 3) {
        contextParts.push('(unknown characters)');
    }
    const contextStr = contextParts.join('\n');

    const unitsStr = units.map((u, i) =>
        `Unit ${i + 1}: text="${(u.text || '').substring(0, 200)}", type="${u.type || 'perception'}"`
    ).join('\n');

    const prompt = SYSTEM_PROMPTS.visuals
        .replace('%CONTEXT%', contextStr)
        .replace('%UNITS%', unitsStr);

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: `Add visual prompts to each unit. Return the same units with visual fields added.\n\n${unitsStr}` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 2048 });
        const visualUnits = result.units || [];

        const merged = units.map((u, i) => {
            const vu = visualUnits[i];
            if (vu && vu.visual) {
                return { ...u, visual: vu.visual };
            }
            return {
                ...u,
                visual: {
                    shot: u.type === 'dialogue' ? 'medium' : (u.type === 'description' ? 'wide' : 'medium'),
                    prompt: getFallbackVisual(u.text, characters, scene),
                    character_binding: true,
                },
            };
        });

        await logConversation(sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, merged);
        console.log(`[AGENT] Step 5 (visuals scene ${sceneIndex}): ${merged.length} units with visuals`);
        return merged;
    } catch (err) {
        await failStep(step.step_id, `AI failed, using fallback: ${err.message}`);
        console.warn(`[AGENT] Step 5 (scene ${sceneIndex}) failed, using fallback: ${err.message}`);
        return units.map((u) => ({
            ...u,
            visual: {
                shot: u.type === 'dialogue' ? 'medium' : 'wide',
                prompt: getFallbackVisual(u.text, characters, scene),
                character_binding: true,
            },
        }));
    }
}

function getFallbackVisual(text, characters, scene) {
    const charNames = (characters || []).map(c => c.name).join(', ') || 'character';
    const locationHint = scene.title || 'scene';
    const preview = (text || '').substring(0, 60).replace(/\n/g, ' ');
    return `${charNames} in ${locationHint}: ${preview}... cinematic shot`;
}

function getWindowText(sourceText, existingChars, existingLocs, windowIndex, startOffset) {
    const chapters = lazyBook.splitIntoChapters(sourceText);

    if (startOffset === undefined || startOffset === null) {
        if (windowIndex === 0) {
            const firstChapter = lazyBook.firstMeaningfulChapter
                ? lazyBook.firstMeaningfulChapter(chapters, sourceText)
                : (chapters[0] || null);

            if (firstChapter) {
                const chStart = firstChapter.startOffset || 0;
                const chEnd = firstChapter.endOffset || sourceText.length;
                const chText = sourceText.substring(chStart, chEnd);
                const chLines = chText.split('\n');
                const chFirst = chLines[0]?.trim() || '';
                const headerLen = /^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(chFirst)
                    ? chLines[0].length + 1 : 0;
                startOffset = Math.min(chStart + headerLen, sourceText.length);
            } else {
                startOffset = 0;
            }
        } else {
            startOffset = 0;
        }
    }

    if (startOffset >= sourceText.length) {
        const lastIdx = chapters.length > 0 ? chapters.length - 1 : 0;
        return {
            text: '',
            chapterIndex: lastIdx,
            remainingText: '',
            fullChapter: '',
            chapterTitle: chapters[lastIdx]?.title || null,
            currentOffset: startOffset,
        };
    }

    let endPos = Math.min(startOffset + MAX_WINDOW_CHARS, sourceText.length);
    let windowText = sourceText.substring(startOffset, endPos);

    let skipLen = 0;
    const windowLines = windowText.split('\n');
    const firstLine = windowLines[0]?.trim() || '';
    if (/^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(firstLine)) {
        skipLen = windowLines[0].length + 1;
    }

    const actualStart = startOffset + skipLen;
    if (skipLen > 0 && actualStart < endPos) {
        windowText = sourceText.substring(actualStart, endPos);
    }

    if (endPos < sourceText.length && (endPos - actualStart) >= MAX_WINDOW_CHARS) {
        const lastPeriod = windowText.lastIndexOf('.');
        const lastNewline = windowText.lastIndexOf('\n\n');
        const breakAt = Math.max(lastPeriod, lastNewline);
        if (breakAt > MAX_WINDOW_CHARS / 2) {
            windowText = windowText.substring(0, breakAt + 1).trim();
            endPos = actualStart + breakAt + 1;
        }
    }

    const newOffset = endPos;
    const remaining = sourceText.substring(newOffset).trim();

    let chIdx = 0;
    for (let ci = 0; ci < chapters.length; ci++) {
        const chStart = chapters[ci].startOffset || 0;
        const chEnd = chapters[ci].endOffset || sourceText.length;
        if (actualStart >= chStart && actualStart < chEnd) {
            chIdx = ci;
            break;
        }
    }

    const chTitle = chapters[chIdx]?.title || null;

    console.log(`[WINDOW] getWindowText: startOffset=${startOffset}, skipLen=${skipLen}, actualStart=${actualStart}, endPos=${endPos}, newOffset=${newOffset}, chIdx=${chIdx}, chTitle="${chTitle}", textLen=${windowText.trim().length}, sourceLen=${sourceText.length}`);

    return {
        text: windowText.trim(),
        chapterIndex: chIdx,
        remainingText: remaining,
        fullChapter: windowText,
        chapterTitle: chTitle,
        currentOffset: newOffset,
    };
}

async function runPipeline(sessionId, text, existingChars, existingLocs, stepIndex, progress, baseSceneCount) {
    const _progress = progress || (() => {});
    const sceneOffset = baseSceneCount || 0;
    let characters = existingChars || [];
    let locations = existingLocs || [];

    if (!existingChars || existingChars.length === 0) {
        characters = await stepExtractCharacters(sessionId, text, stepIndex, _progress);
        if (!characters || characters.length === 0) {
            console.warn('[AGENT] No characters extracted, continuing with empty set');
            characters = [{ id: 'unknown', name: 'Unknown', role: 'minor', description: 'Unidentified character' }];
        }
    } else {
        console.log(`[AGENT] Skipping characters step: ${existingChars.length} already known`);
    }

    if (!existingLocs || existingLocs.length === 0) {
        locations = await stepExtractLocations(sessionId, text, characters, stepIndex, _progress);
        if (!locations || locations.length === 0) {
            console.warn('[AGENT] No locations extracted, continuing with empty set');
            locations = [{ id: 'unknown', name: 'Unknown', type: 'outdoor', description: 'Unspecified location' }];
        }
    } else {
        console.log(`[AGENT] Skipping locations step: ${existingLocs.length} already known`);
    }

    const scenes = await stepCreateScenes(sessionId, text, characters, locations, stepIndex, _progress);
    if (!scenes || scenes.length === 0) throw new Error('AI returned no scenes');

    const windowScenes = scenes.slice(0, WINDOW_SIZE);

    const enrichedScenes = [];
    for (let si = 0; si < windowScenes.length; si++) {
        const scene = windowScenes[si];
        const globalSceneIndex = sceneOffset + si;

        const units = await stepCreateUnits(sessionId, scene, globalSceneIndex, characters, stepIndex, _progress);

        const visualUnits = await stepCreateVisuals(sessionId, scene, units, globalSceneIndex, characters, locations, stepIndex, _progress);

        enrichedScenes.push({
            ...scene,
            units: visualUnits,
        });
    }

    return { characters, locations, scenes: enrichedScenes, allScenes: scenes };
}

async function bootstrapWithAgent(bookId, progress) {
    const _progress = progress || (() => {});
    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) throw new Error(`Book ${bookId} not found`);

    if (draft.manifest?.state === lazyBook.BookState.BOOTSTRAPPED) {
        console.log(`[AGENT] ${bookId} already BOOTSTRAPPED, skipping`);
        return { bookId, state: lazyBook.BookState.BOOTSTRAPPED };
    }

    if (!config.OPENROUTER_API_KEY) {
        throw new Error('AI assistant is not available — cannot import book');
    }

    const session = await createSession(bookId, 'txt_import');
    const sessionId = session.session_id;
    console.log(`[AGENT] Session ${sessionId} created for book ${bookId}`);

    try {
        const windowInfo = getWindowText(draft.sourceText, [], [], 0);
        console.log(`[FIRST-WINDOW] currentOffset=${windowInfo.currentOffset}, chapterIndex=${windowInfo.chapterIndex}, chapterTitle="${windowInfo.chapterTitle}", textLen=${windowInfo.text.length}`);

        _progress({ stage: 'analyzing_structure', message: PROGRESS_STAGES.analyzing_structure });
        const structure = await stepAnalyzeStructure(sessionId, windowInfo.text, 0, _progress);

        if (structure.author || structure.title) {
            _progress({ stage: 'saving', message: `⟳ Обновляю метаданные: ${structure.title ? `«${structure.title}»` : ''} ${structure.author ? `(${structure.author})` : ''}` });
            const bookDir = lazyBook.getBookDir(bookId);
            const bp = lazyBook.getBookMetaPath(bookDir);
            const fs_local = require('fs');
            if (fs_local.existsSync(bp)) {
                const bookMeta = JSON.parse(fs_local.readFileSync(bp, 'utf8'));
                if (structure.author) bookMeta.author = structure.author;
                if (structure.title) bookMeta.title = structure.title;
                if (structure.parts && structure.parts.length > 0) {
                    bookMeta.structure.has_prologue = !!structure.has_prologue;
                    bookMeta.structure.has_epilogue = !!structure.has_epilogue;
                    bookMeta.structure.parts = structure.parts;
                }
                fs_local.writeFileSync(bp, JSON.stringify(bookMeta, null, 2));
                console.log(`[AGENT] Book metadata updated: author=${structure.author}, title=${structure.title}`);
            }
        }
        if (!windowInfo.text || !windowInfo.text.trim()) {
            throw new Error('No text to analyze in first window');
        }

        _progress({ stage: 'extracting_chars', message: '⟳ Анализирую текст: извлекаю персонажей и локации...' });
        await updateSession(sessionId, {
            progress_msg: '⟳ Анализирую текст: извлекаю персонажей и локации...',
        });

        const result = await runPipeline(sessionId, windowInfo.text, [], [], 0, _progress, 0);

        if (result.scenes.length === 0) {
            throw new Error('AI returned no scenes — cannot create book');
        }

        const extraScenes = result.allScenes.slice(WINDOW_SIZE);

        const windowData = {
            window_index: 0,
            chapter_title: windowInfo.chapterTitle,
            chapter_index: windowInfo.chapterIndex,
            total_scenes: result.allScenes.length,
            created_scenes: result.scenes.length,
            remaining_scenes: extraScenes,
            remaining_text: windowInfo.remainingText,
            currentOffset: windowInfo.currentOffset,
            all_characters: result.characters,
            all_locations: result.locations,
            structure: structure,
        };

        await updateSession(sessionId, {
            window_data: JSON.stringify(windowData),
            progress_msg: `Создано ${result.scenes.length} сцен, ${result.characters.length} персонажей, ${result.locations.length} локаций`,
        });

        _progress({ stage: 'saving', message: '⟳ Сохраняю структуру книги...' });

        const chapterTitle = windowInfo.chapterTitle
            ? (/^(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(windowInfo.chapterTitle)
                ? windowInfo.chapterTitle
                : `Глава 1: ${windowInfo.chapterTitle}`)
            : 'Глава 1';

        const bookResult = lazyBook.createFromAnalysis(bookId, {
            characters: result.characters,
            locations: result.locations,
            scenes: result.scenes,
            chapterTitle: chapterTitle,
            maxScenes: WINDOW_SIZE,
            structure: structure,
        });

        const hasMoreText = !!windowInfo.remainingText;
        const allDone = extraScenes.length === 0 && !hasMoreText;

        _progress({ stage: 'done', message: `✓ Импорт завершён: ${result.scenes.length} сцен, ${result.characters.length} персонажей, ${result.locations.length} локаций` });

        await updateSession(sessionId, {
            status: allDone ? 'completed' : 'paused',
            progress_msg: allDone
                ? `Окно 1 готово: ${result.scenes.length} сцен. Всего найдено: ${result.allScenes.length}`
                : `⟳ Окно 1: ${result.scenes.length} сцен. Обрабатываю следующие окна...`,
        });

        return {
            ...bookResult,
            session_id: sessionId,
            total_scenes_found: result.allScenes.length,
            remaining_scenes: extraScenes.length,
            has_more: !allDone,
        };
    } catch (err) {
        console.error(`[AGENT] Bootstrap failed: ${err.message}`);
        await updateSession(sessionId, {
            status: 'failed',
            progress_msg: `Ошибка: ${err.message}`,
        }).catch(() => {});
        _progress({ stage: 'error', message: `✗ Ошибка: ${err.message}` });
        throw err;
    }
}

async function bootstrapNextWindow(bookId, progress) {
    const _progress = progress || (() => {});
    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) throw new Error(`Book ${bookId} not found`);

    // ── Dedup: check if the CURRENT offset has already been processed ──
    // If there's a recent 'paused' or 'completed' session whose window_data
    // has the same currentOffset as we'd compute, skip processing to avoid
    // re-processing the same text window (infinite loop).
    let windowData = null;
    try {
        const prevResult = await query(
            `SELECT status, window_data FROM agent_sessions WHERE book_id = $1 AND window_data IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
            [bookId]
        );
        if (prevResult?.rows?.[0]?.window_data) {
            const raw = prevResult.rows[0].window_data;
            windowData = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const prevStatus = prevResult.rows[0].status;
            console.log(`[AGENT] bootstrapNextWindow: prev session status=${prevStatus}, currentOffset=${windowData?.currentOffset}`);

            // If the previous session was 'completed' and had the same
            // currentOffset remaining_text is empty, then all windows are done.
            if (prevStatus === 'completed') {
                console.log(`[AGENT] bootstrapNextWindow: previous session completed, all done`);
                return { session_id: null, cached: false, added_scenes: 0, all_done: true };
            }

            // If previous session is 'paused' with no remaining text and no
            // remaining scenes, it's also done.
            if (prevStatus === 'paused' &&
                (!windowData.remaining_text || windowData.remaining_text.length === 0) &&
                (!windowData.remaining_scenes || windowData.remaining_scenes.length === 0)) {
                console.log(`[AGENT] bootstrapNextWindow: paused with no remaining text/scenes, all done`);
                return { session_id: null, cached: false, added_scenes: 0, all_done: true };
            }
        }
    } catch (lookupErr) {
        console.warn(`[AGENT] bootstrapNextWindow: failed to look up previous window_data: ${lookupErr.message}`);
    }

    const currentOffset = windowData?.currentOffset || 0;
    const existingChars = windowData?.all_characters || [];
    const existingLocs = windowData?.all_locations || [];

    // ── Final dedup: if we already have a session for THIS offset, skip ──
    try {
        const dupCheck = await query(
            `SELECT COUNT(*) as cnt FROM agent_sessions WHERE book_id = $1 AND window_data IS NOT NULL AND window_data->>'currentOffset' = $2 AND status IN ('paused','completed')`,
            [bookId, String(currentOffset)]
        );
        if (parseInt(dupCheck.rows[0]?.cnt || '0', 10) > 0) {
            console.log(`[AGENT] bootstrapNextWindow: offset ${currentOffset} already processed, skipping`);
            return { session_id: null, cached: true, added_scenes: 0, all_done: true };
        }
    } catch (dupErr) {
        console.warn(`[AGENT] bootstrapNextWindow: dedup check failed: ${dupErr.message}`);
    }

    const session = await createSession(bookId, 'txt_import');
    const sessionId = session.session_id;

    try {
        const bookDir = lazyBook.getBookDir(bookId);
        const bp = lazyBook.getBookMetaPath(bookDir);
        const fs_local = require('fs');
        if (!fs_local.existsSync(bp)) throw new Error(`Book metadata not found: ${bookId}`);
        const existingChars = windowData?.all_characters || [];
        const existingLocs = windowData?.all_locations || [];

        console.log(`[AGENT] bootstrapNextWindow: currentOffset=${currentOffset}, existingChars=${existingChars.length}, existingLocs=${existingLocs.length}`);

        const windowInfo = getWindowText(draft.sourceText, existingChars, existingLocs, 1, currentOffset);

        if (!windowInfo.text || !windowInfo.text.trim()) {
            await updateSession(sessionId, {
                status: 'completed',
                progress_msg: 'Нет текста для анализа — импорт завершён',
            });
            _progress({ stage: 'done', message: '✓ Нет текста для анализа — импорт завершён' });
            return { session_id: sessionId, cached: false, added_scenes: 0, all_done: true };
        }

        const nextWindowIndex = (windowData?.window_index || 0) + 1;
        const nextChapterIndex = windowInfo.chapterIndex;

        const structure = (windowData?.structure && windowData.structure.chapters) ? {
            chapters: windowData.structure.chapters,
            author: windowData.structure.author,
            title: windowData.structure.title,
            has_prologue: windowData.structure.has_prologue,
            has_epilogue: windowData.structure.has_epilogue,
            parts: windowData.structure.parts,
        } : null;

        const result = await runPipeline(sessionId, windowInfo.text, existingChars, existingLocs, nextWindowIndex, _progress, (windowData?.created_scenes || 0));

        const extraScenes = result.allScenes.slice(WINDOW_SIZE);

        const bookResult = lazyBook.appendToBook(bookId, {
            characters: result.characters,
            locations: result.locations,
            scenes: result.scenes,
            maxScenes: WINDOW_SIZE,
            chapterTitle: windowInfo.chapterTitle || `Глава ${nextChapterIndex + 1}`,
            chapterIndex: nextChapterIndex,
            structure: structure,
        });

        // Merge characters and locations
        const mergedChars = [...existingChars];
        const existingCharIds = new Set(existingChars.map(c => c.id));
        for (const ch of (result.characters || [])) {
            if (!existingCharIds.has(ch.id)) {
                mergedChars.push(ch);
                existingCharIds.add(ch.id);
            }
        }

        const mergedLocsMap = {};
        for (const loc of existingLocs) mergedLocsMap[loc.id] = loc;
        for (const loc of (result.locations || [])) mergedLocsMap[loc.id] = loc;
        const mergedLocs = Object.values(mergedLocsMap);

        const updatedWindowData = {
            window_index: nextWindowIndex,
            chapter_title: windowInfo.chapterTitle,
            chapter_index: nextChapterIndex,
            total_scenes: result.allScenes.length,
            created_scenes: (windowData?.created_scenes || 0) + result.scenes.length,
            remaining_scenes: extraScenes,
            remaining_text: windowInfo.remainingText,
            currentOffset: windowInfo.currentOffset,
            all_characters: mergedChars,
            all_locations: mergedLocs,
        };

        const allDone = extraScenes.length === 0 && !windowInfo.remainingText;
        await updateSession(sessionId, {
            window_data: JSON.stringify(updatedWindowData),
            progress_msg: `Окно ${nextWindowIndex + 1}: добавлено ${result.scenes.length} сцен. Осталось: ${extraScenes.length} кэшированных`,
            status: allDone ? 'completed' : 'paused',
        });

        if (allDone) {
            lazyBook.updateBookState(bookId, lazyBook.BookState.ACTIVE);
        }

        _progress({ stage: 'done', message: `✓ Окно ${nextWindowIndex + 1}: ${result.scenes.length} сцен. Всего: ${updatedWindowData.created_scenes}` });

        return {
            ...bookResult,
            session_id: sessionId,
            cached: false,
            added_scenes: result.scenes.length,
            remaining_cached: extraScenes.length,
            all_done: allDone,
        };
    } catch (err) {
        console.error(`[AGENT] bootstrapNextWindow failed: ${err.message}`);
        await updateSession(sessionId, {
            status: 'failed',
            progress_msg: `Ошибка: ${err.message}`,
        }).catch(() => {});
        _progress({ stage: 'error', message: `✗ Ошибка: ${err.message}` });
        throw err;
    }
}

module.exports = {
    createSession,
    updateSession,
    getSession,
    loadKnowledgeBase: require('./knowledge-base').loadKnowledgeBase,
    bootstrapWithAgent,
    bootstrapNextWindow,
    PROGRESS_STAGES,
    WINDOW_SIZE,
};
