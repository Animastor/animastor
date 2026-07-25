// ======================================================
// Agent Bootstrap
// ======================================================
// Bootstraps a book from source text using the AI agent pipeline.
// Handles the first window (bootstrapWithAgent) and subsequent windows (bootstrapNextWindow).

const fs = require('fs');
const path = require('path');
const lazyBook = require('../../book/lazy-book');
const config = require('../../config/runtime-config');
const sourceCoverage = require('../source-coverage');
const { updateSession, createSession, isSessionCancelled } = require('../agent-session');
const { PROGRESS_STAGES, MAX_SCENES_PER_CHUNK } = require('../agent-prompts');
const pipelineSteps = require('./pipeline-steps');
const pipelineRunner = require('./pipeline-runner');
const textUtils = require('./text-utils');

async function bootstrapWithAgent(bookId, progress, publishProgress, redis) {
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

    // ── Clear old cancellation state from PREVIOUS sessions ──
    // isBookCancelled() checks ANY session with status='cancelled' for this book.
    // If a previous session was cancelled (e.g. user pressed Stop in an earlier
    // app session), LEVEL 2 of checkCancelled() would immediately kill the new
    // session — even though the user explicitly asked to start a new generation.
    // We only clear the DB status (not Redis) here, because:
    //   - Redis TTL is 1h — a stale key from hours ago won't affect us
    //   - A FRESH Redis cancellation (set milliseconds ago) IS intentional
    // DB sessions persist indefinitely, so old cancelled entries MUST be cleaned.
    try {
        const { query } = require('../../storage/postgres/database');
        await query(`UPDATE agent_sessions SET status = 'failed' WHERE book_id = $1 AND status = 'cancelled'`, [bookId]);
        console.log(`[CANCEL-DEBUG] bootstrapWithAgent: cleared stale cancelled sessions for book ${bookId}`);
    } catch (_) {
        // Best-effort — DB cleanup failure should not block generation
    }

    const session = await createSession(bookId, 'txt_import');
    const sessionId = session.session_id;
    console.log(`[AGENT] Session ${sessionId} created for book ${bookId}`);
    console.log(`[CANCEL-DEBUG] bootstrapWithAgent: session=${sessionId}, bookId=${bookId}, redis=${!!redis}`);

    try {
        const windowInfo = pipelineRunner.getWindowText(draft.sourceText, [], [], 0);
        console.log(`[FIRST-WINDOW] currentOffset=${windowInfo.currentOffset}, chapterIndex=${windowInfo.chapterIndex}, chapterTitle="${windowInfo.chapterTitle}", textLen=${windowInfo.text.length}`);

        _progress({ stage: 'analyzing_structure', message: PROGRESS_STAGES.analyzing_structure });
        const structure = await pipelineSteps.stepAnalyzeStructure(sessionId, windowInfo.text, 0, _progress);

        if (structure.author || structure.title) {
            _progress({ stage: 'saving', message: `⟳ Обновляю метаданные: ${structure.title ? `«${structure.title}»` : ''} ${structure.author ? `(${structure.author})` : ''}` });
            const bookDir = lazyBook.getBookDir(bookId);
            const bp = lazyBook.getBookMetaPath(bookDir);
            if (fs.existsSync(bp)) {
                const bookMeta = JSON.parse(fs.readFileSync(bp, 'utf8'));
                if (structure.author) bookMeta.author = structure.author;
                if (structure.title) bookMeta.title = structure.title;
                if (structure.parts && structure.parts.length > 0) {
                    bookMeta.structure.has_prologue = !!structure.has_prologue;
                    bookMeta.structure.has_epilogue = !!structure.has_epilogue;
                    bookMeta.structure.parts = structure.parts;
                }
                fs.writeFileSync(bp, JSON.stringify(bookMeta, null, 2));
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

        const result = await pipelineRunner.runPipeline(sessionId, windowInfo.text, [], [], 0, _progress, 0, {
            rawWindowText: windowInfo.fullChapter,
            sourceOffsetBase: windowInfo.windowStartOffset,
            publishProgress,
            bookId,
            redis,
        });

        if (result.scenes.length === 0) {
            throw new Error('AI returned no scenes — cannot create book');
        }

        const extraScenes = [];

        const sceneConsumedOffset = result.nextOffset ?? result.coverage?.next_offset;
        if (!Number.isFinite(sceneConsumedOffset) || sceneConsumedOffset <= windowInfo.windowStartOffset) {
            throw new Error('Scene progress did not advance from current source position');
        }
        const actualRemaining = draft.sourceText.substring(sceneConsumedOffset).trim();

        const windowData = {
            window_index: 0,
            chapter_title: windowInfo.chapterTitle,
            chapter_index: windowInfo.chapterIndex,
            total_scenes: result.allScenes.length,
            created_scenes: result.scenes.length,
            remaining_scenes: extraScenes,
            remaining_text: actualRemaining,
            currentOffset: sceneConsumedOffset,
            windowStartOffset: windowInfo.windowStartOffset,
            plannedEndOffset: windowInfo.currentOffset,
            coveredStartOffset: result.coverage?.covered_start_offset ?? null,
            coveredEndOffset: result.coverage?.covered_end_offset ?? null,
            lastSceneEndOffset: result.coverage?.last_scene_end_offset ?? null,
            progressMethod: result.coverage?.progress_method || null,
            coverageStatus: result.coverage?.ok ? 'ok' : 'failed',
            coverageGapChars: result.coverage?.gap_chars || 0,
            all_characters: result.characters,
            all_locations: result.locations,
            all_mentions: result.mentions,
            structure: structure,
        };

        await updateSession(sessionId, {
            window_data: JSON.stringify(windowData),
            progress_msg: `Создано ${result.scenes.length} сцен, ${result.characters.length} персонажей, ${result.locations.length} локаций`,
        });

        _progress({ stage: 'saving', message: '⟳ Сохраняю структуру книги...' });

        const chapterTitle = windowInfo.chapterTitle || null;

        const bookResult = lazyBook.createFromAnalysis(bookId, {
            characters: result.characters,
            locations: result.locations,
            mentions: result.mentions,
            scenes: result.scenes,
            chapterTitle: chapterTitle,
            maxScenes: MAX_SCENES_PER_CHUNK,
            structure: structure,
        });

        const hasMoreText = actualRemaining.length > 0;
        const allDone = extraScenes.length === 0 && !hasMoreText;

        _progress({ stage: 'done', message: `✓ Импорт завершён: ${result.scenes.length} сцен, ${result.characters.length} персонажей, ${result.locations.length} локаций` });

        await updateSession(sessionId, {
            status: allDone ? 'completed' : 'paused',
            progress_msg: allDone
                ? `Окно 1 готово: ${result.scenes.length} сцен. Всего найдено: ${result.allScenes.length}`
                : `⟳ Окно 1: ${result.scenes.length} сцен. Обрабатываю следующие окна...`,
        });

        if (allDone && publishProgress) {
            try { publishProgress(bookId, { type: 'import_complete' }); } catch (_) {}
        }

        return {
            ...bookResult,
            session_id: sessionId,
            total_scenes_found: result.allScenes.length,
            remaining_scenes: extraScenes.length,
            has_more: !allDone,
        };
    } catch (err) {
        console.error(`[AGENT] Bootstrap failed: ${err.message}`);
        // Don't overwrite 'cancelled' status — user requested cancellation
        const alreadyCancelled = err.code === 'SESSION_CANCELLED' || (await isSessionCancelled(sessionId).catch(() => false));
        console.log(`[CANCEL-DEBUG] bootstrapWithAgent CATCH: err.code=${err.code}, sessionId=${sessionId}, alreadyCancelled=${alreadyCancelled}`);
        if (!alreadyCancelled) {
            console.log(`[CANCEL-DEBUG] bootstrapWithAgent: НЕ cancelled → status=failed`);
            await updateSession(sessionId, {
                status: 'failed',
                progress_msg: `Ошибка: ${err.message}`,
            }).catch(() => {});
            _progress({ stage: 'error', message: `✗ Ошибка: ${err.message}` });
        } else {
            console.log(`[CANCEL-DEBUG] bootstrapWithAgent: cancelled → сохраняю status=cancelled, НЕ перезаписываю`);
            // Отправляем статус «Отменено» через publishProgress (progress-колбэк — no-op)
            try {
                if (publishProgress) {
                    publishProgress(bookId, {
                        type: 'vbook',
                        stage: 'cancelled',
                        message: '✗ Отменено',
                    });
                }
            } catch (_) {}
            // Сохраняем в PG chat_messages, чтобы сообщение было в истории чата
            try {
                const chatRepo = require('../../storage/postgres/repositories/chat-repo');
                await chatRepo.appendMessage(bookId, {
                    role: 'system',
                    topic: 'vbook',
                    message: '✗ Отменено',
                });
            } catch (_) {}
            _progress({ stage: 'done', message: '✗ Генерация VBook остановлена пользователем' });
        }
        throw err;
    }
}

// ======================================================
// LAST SOURCE END — строго из сохранённых файлов книги на диске
// ======================================================
// Единственный source of truth: последний source_end в файлах глав.
// Это страхует от потери windowData в БД между окнами.

function getLastSourceEnd(bookId) {
    const bookDir = lazyBook.getBookDir(bookId);
    const bookMetaPath = lazyBook.getBookMetaPath(bookDir);
    if (!fs.existsSync(bookMetaPath)) return null;

    let bookMeta;
    try {
        bookMeta = JSON.parse(fs.readFileSync(bookMetaPath, 'utf8'));
    } catch (e) {
        return null;
    }

    const chOrder = bookMeta.structure?.chapters_order || [];
    if (chOrder.length === 0) return null;

    const chDir = lazyBook.getChapterDir(bookDir);
    let lastSourceEnd = null;

    for (const chFile of chOrder) {
        const chPath = path.join(chDir, chFile.split('/').pop());
        if (!fs.existsSync(chPath)) continue;
        try {
            const chapter = JSON.parse(fs.readFileSync(chPath, 'utf8'));
            if (!chapter.scenes) continue;
            for (const scene of chapter.scenes) {
                if (typeof scene.source_end === 'number' && scene.source_end > 0) {
                    if (lastSourceEnd === null || scene.source_end > lastSourceEnd) {
                        lastSourceEnd = scene.source_end;
                    }
                }
            }
        } catch (_) { /* skip corrupted chapter */ }
    }

    return lastSourceEnd;
}

async function bootstrapNextWindow(bookId, progress, publishProgress, redis) {
    const _progress = progress || (() => {});
    const draft = lazyBook.loadDraftBook(bookId);
    if (!draft || !draft.sourceText) throw new Error(`Book ${bookId} not found`);

    let windowData = null;
    try {
        const { query } = require('../../storage/postgres/database');
        const prevResult = await query(
            `SELECT status, window_data FROM agent_sessions WHERE book_id = $1 AND window_data IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
            [bookId]
        );
        if (prevResult?.rows?.[0]?.window_data) {
            const raw = prevResult.rows[0].window_data;
            windowData = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const prevStatus = prevResult.rows[0].status;
            console.log(`[AGENT] bootstrapNextWindow: prev session status=${prevStatus}, currentOffset=${windowData?.currentOffset}`);

            if (prevStatus === 'completed') {
                console.log(`[AGENT] bootstrapNextWindow: previous session completed, all done`);
                console.log(`[CANCEL-DEBUG] bootstrapNextWindow: prevStatus=completed — all_done, return`);
                return { session_id: null, cached: false, added_scenes: 0, all_done: true };
            }

            if (prevStatus === 'cancelled') {
                console.log(`[CANCEL-DEBUG] bootstrapNextWindow: prevStatus=cancelled — aborting, all_done`);
                return { session_id: null, cached: false, added_scenes: 0, all_done: true };
            }

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

    // ── Check if book was cancelled (even if no window_data session found) ──
    // If cancel-worker set any session to 'cancelled', don't start a new window.
    // We do this before creating a new session because the cancelled status can
    // exist on a session that has no window_data (cancelled before saving results).
    // ── Check if book was cancelled (even if no window_data session found) ──
    if (redis && bookId) {
        try {
            const isCancelled = await redis.sismember(`animastor:cancelled-workers:${bookId}`, 'vbook');
            console.log(`[CANCEL-DEBUG] bootstrapNextWindow REDIS CHECK: bookId=${bookId}, redis.sismember(vbook)=${!!isCancelled}`);
            if (isCancelled) {
                console.log(`[CANCEL-DEBUG] bootstrapNextWindow: 🎯 REDIS cancelled-workers:${bookId} has vbook — aborting, all_done`);
                return { session_id: null, cached: false, added_scenes: 0, all_done: true };
            }
        } catch (redisErr) {
            console.warn(`[AGENT] bootstrapNextWindow: Redis cancelled check failed: ${redisErr.message}`);
        }
    }

    // ── Определяем offset из двух источников ──
    // 1. lastSourceEnd из файлов на диске (приоритет — истина)
    // 2. windowData.currentOffset из БД сессии (резерв)
    // Никогда не падаем в 0!
    const lastSourceEnd = getLastSourceEnd(bookId);
    const dbOffset = (typeof windowData?.currentOffset === 'number' && windowData.currentOffset > 0)
        ? windowData.currentOffset
        : null;

    // Если есть расхождение между диском и БД, выбираем БОЛЬШИЙ offset —
    // безопаснее перепрыгнуть вперёд, чем назад.
    let currentOffset;
    if (lastSourceEnd !== null && dbOffset !== null) {
        currentOffset = Math.max(lastSourceEnd, dbOffset);
        if (lastSourceEnd !== dbOffset) {
            console.warn(`[AGENT] bootstrapNextWindow: offset mismatch — disk=${lastSourceEnd}, db=${dbOffset}, using=${currentOffset}`);
        }
    } else if (lastSourceEnd !== null) {
        currentOffset = lastSourceEnd;
    } else if (dbOffset !== null) {
        currentOffset = dbOffset;
    } else {
        throw new Error(
            `bootstrapNextWindow: cannot determine next window offset for book ${bookId}. ` +
            `No scenes saved on disk and no window_data in DB. ` +
            `Was the first window bootstrap completed successfully?`
        );
    }

    if (currentOffset <= 0) {
        throw new Error(
            `bootstrapNextWindow: invalid currentOffset=${currentOffset} for book ${bookId}. ` +
            `Agent would start from the beginning of the book. Aborting to prevent duplicate scenes.`
        );
    }

    const existingChars = windowData?.all_characters || [];
    const existingLocs = windowData?.all_locations || [];

    const windowInfo = pipelineRunner.getWindowText(draft.sourceText, existingChars, existingLocs, 1, currentOffset);

    // Guard: windowStartOffset должен быть >= currentOffset (минимум)
    // Если он значительно меньше — агент пошёл назад, abort.
    if (windowInfo.windowStartOffset < currentOffset - 50) {
        throw new Error(
            `bootstrapNextWindow: windowStartOffset (${windowInfo.windowStartOffset}) << currentOffset (${currentOffset}). ` +
            `Pipeline would walk backwards. Aborting to prevent duplicate scenes.`
        );
    }

    const prevCoveredEnd = windowData?.coveredEndOffset;
    if (typeof prevCoveredEnd === 'number' && windowInfo.windowStartOffset > prevCoveredEnd) {
        const seam = draft.sourceText.substring(prevCoveredEnd, windowInfo.windowStartOffset);
        const seamHeaderStripped = seam
            .split('\n')
            .filter(line => !sourceCoverage.looksLikeChapterTitle(line) && !/^\s*(?:глава|chapter|часть|part|пролог|prologue|эпилог|epilogue)/i.test(line))
            .join('');
        const droppedVisible = seamHeaderStripped.replace(/\s+/g, '').length;
        if (droppedVisible > 0) {
            console.warn(JSON.stringify({
                event: 'window_seam_visible_text_dropped',
                book_id: bookId,
                prev_covered_end: prevCoveredEnd,
                next_window_start: windowInfo.windowStartOffset,
                dropped_visible_chars: droppedVisible,
                seam_preview: seam.slice(0, 200),
            }));
        }
    }

    const dedupKey = String(windowInfo.windowStartOffset);
    try {
        const { query } = require('../../storage/postgres/database');
        const dupCheck = await query(
            `SELECT COUNT(*) as cnt FROM agent_sessions WHERE book_id = $1 AND window_data IS NOT NULL AND window_data->>'windowStartOffset' = $2 AND status IN ('paused','completed')`,
            [bookId, dedupKey]
        );
        if (parseInt(dupCheck.rows[0]?.cnt || '0', 10) > 0) {
            console.log(`[AGENT] bootstrapNextWindow: offset ${dedupKey} already processed, skipping`);
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
        if (!fs.existsSync(bp)) throw new Error(`Book metadata not found: ${bookId}`);

        console.log(`[AGENT] bootstrapNextWindow: currentOffset=${currentOffset}, existingChars=${existingChars.length}, existingLocs=${existingLocs.length}`);

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
            country: windowData.structure.country || null,
            epoch: windowData.structure.epoch || null,
        } : null;

        const result = await pipelineRunner.runPipeline(sessionId, windowInfo.text, existingChars, existingLocs, nextWindowIndex, _progress, (windowData?.created_scenes || 0), {
            rawWindowText: windowInfo.fullChapter,
            sourceOffsetBase: windowInfo.windowStartOffset,
            publishProgress,
            bookId,
            redis,
            existingMentions: windowData?.all_mentions || {},
        });

        const extraScenes = [];

        const sceneConsumedOffset = result.nextOffset ?? result.coverage?.next_offset;
        if (!Number.isFinite(sceneConsumedOffset) || sceneConsumedOffset <= windowInfo.windowStartOffset) {
            throw new Error('Scene progress did not advance from current source position');
        }

        // Дополнительная проверка: sceneConsumedOffset должен быть >= lastSourceEnd
        // (строго не даёт пойти назад относительно сохранённых данных)
        const currentLastSourceEnd = getLastSourceEnd(bookId);
        if (currentLastSourceEnd !== null && sceneConsumedOffset < currentLastSourceEnd) {
            throw new Error(
                `Scene progress went backwards: nextOffset=${sceneConsumedOffset} < lastSourceEnd=${currentLastSourceEnd}. ` +
                `This would create duplicate scenes. Aborting.`
            );
        }

        const actualRemaining = draft.sourceText.substring(sceneConsumedOffset).trim();

        const bookResult = lazyBook.appendToBook(bookId, {
            characters: result.characters,
            locations: result.locations,
            mentions: result.mentions,
            scenes: result.scenes,
            maxScenes: MAX_SCENES_PER_CHUNK,
            chapterTitle: windowInfo.chapterTitle || null,
            chapterIndex: nextChapterIndex,
            structure: structure,
        });

        const updatedWindowData = {
            window_index: nextWindowIndex,
            chapter_title: windowInfo.chapterTitle,
            chapter_index: nextChapterIndex,
            total_scenes: result.allScenes.length,
            created_scenes: (windowData?.created_scenes || 0) + result.scenes.length,
            remaining_scenes: extraScenes,
            remaining_text: actualRemaining,
            currentOffset: sceneConsumedOffset,
            windowStartOffset: windowInfo.windowStartOffset,
            plannedEndOffset: windowInfo.currentOffset,
            coveredStartOffset: result.coverage?.covered_start_offset ?? null,
            coveredEndOffset: result.coverage?.covered_end_offset ?? null,
            lastSceneEndOffset: result.coverage?.last_scene_end_offset ?? null,
            progressMethod: result.coverage?.progress_method || null,
            coverageStatus: result.coverage?.ok ? 'ok' : 'failed',
            coverageGapChars: result.coverage?.gap_chars || 0,
            all_characters: result.characters,
            all_locations: result.locations,
            all_mentions: result.mentions,
        };

        const allDone = extraScenes.length === 0 && actualRemaining.length === 0;
        await updateSession(sessionId, {
            window_data: JSON.stringify(updatedWindowData),
            progress_msg: `Окно ${nextWindowIndex + 1}: добавлено ${result.scenes.length} сцен. Осталось: ${extraScenes.length} кэшированных`,
            status: allDone ? 'completed' : 'paused',
        });

        if (allDone) {
            lazyBook.updateBookState(bookId, lazyBook.BookState.ACTIVE);
            // F10: Push import_complete terminal event so the frontend can stop
            // polling immediately instead of waiting for 3 consecutive inactive polls.
            if (publishProgress) {
                try { publishProgress(bookId, { type: 'import_complete' }); } catch (_) {}
            }
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
        // Don't overwrite 'cancelled' status — user requested cancellation
        const alreadyCancelled = err.code === 'SESSION_CANCELLED' || (await isSessionCancelled(sessionId).catch(() => false));
        console.log(`[CANCEL-DEBUG] bootstrapNextWindow CATCH: err.code=${err.code}, sessionId=${sessionId}, alreadyCancelled=${alreadyCancelled}`);
        if (!alreadyCancelled) {
            console.log(`[CANCEL-DEBUG] bootstrapNextWindow: НЕ cancelled → status=failed`);
            await updateSession(sessionId, {
                status: 'failed',
                progress_msg: `Ошибка: ${err.message}`,
            }).catch(() => {});
            _progress({ stage: 'error', message: `✗ Ошибка: ${err.message}` });
        } else {
            console.log(`[CANCEL-DEBUG] bootstrapNextWindow: cancelled → сохраняю status=cancelled, НЕ перезаписываю`);
            // Отправляем статус «Отменено» через publishProgress (progress-колбэк — no-op)
            try {
                if (publishProgress) {
                    publishProgress(bookId, {
                        type: 'vbook',
                        stage: 'cancelled',
                        message: '✗ Отменено',
                    });
                }
            } catch (_) {}
            // Сохраняем в PG chat_messages, чтобы сообщение было в истории чата
            try {
                const chatRepo = require('../../storage/postgres/repositories/chat-repo');
                await chatRepo.appendMessage(bookId, {
                    role: 'system',
                    topic: 'vbook',
                    message: '✗ Отменено',
                });
            } catch (_) {}
            _progress({ stage: 'done', message: '✗ Генерация VBook остановлена пользователем' });
        }
        throw err;
    }
}

module.exports = {
    bootstrapWithAgent,
    bootstrapNextWindow,
};
