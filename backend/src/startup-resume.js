// ======================================================
// Startup Resume — resume incomplete generation sessions
// ======================================================
// PostgreSQL is the source of truth. On startup, find any
// sessions that were 'generating' or 'pending' when the
// server stopped, and resume them.
// ======================================================

const genSessionRepo = require('./storage/postgres/repositories/gen-session-repo');
const generationCancelRepo = require('./storage/postgres/repositories/generation-cancel-repo');

async function resumeIncompleteSessions(log, runBgGen) {
    try {
        const activeSessions = await genSessionRepo.getActiveSessions();
        if (activeSessions.length > 0) {
            log(`[STARTUP-RESUME] Found ${activeSessions.length} incomplete sessions, resuming...`);
            const resumed = [];
            for (const ses of activeSessions) {
                // Cathedral Recon #3 §5.4 option 1: never auto-resume a book the
                // user explicitly cancelled. The cancellation tombstone survives
                // Redis loss; without this guard a cancelled whole-book/VBook run
                // would be resurrected on the next backend restart.
                //
                // DELIBERATE FAIL-OPEN: if the tombstone check errors (e.g. PG
                // hiccup), we proceed with resume rather than blocking legitimate
                // generation. This is intentional: getActiveSessions() above already
                // succeeded, so PG is reachable — a tombstone-check error here is a
                // rare transient, and fail-open avoids silently stalling live books.
                try {
                    if (await generationCancelRepo.isCancelled(ses.book_id)) {
                        log(`[STARTUP-RESUME] Skipping ${ses.book_id} window ${ses.window_index} — generation explicitly cancelled (tombstone)`);
                        continue;
                    }
                } catch (tombErr) {
                    console.warn(`[STARTUP-RESUME] Tombstone check failed for ${ses.book_id}: ${tombErr.message}`);
                }
                log(`[STARTUP-RESUME] Resuming ${ses.book_id} window ${ses.window_index} (status=${ses.status})`);
                if (ses.status === 'generating') {
                    await genSessionRepo.updateSession(ses.id, { status: 'pending', error: null });
                }
                resumed.push(ses.id);
                setImmediate(() => {
                    runBgGen(ses.book_id, ses.id).catch(err => {
                        console.error(`[STARTUP-RESUME] BG gen for ${ses.book_id} failed: ${err.message}`);
                    });
                });
            }
            log(`[STARTUP-RESUME] Resumed ${resumed.length}/${activeSessions.length} generation sessions`);
        } else {
            log(`[STARTUP-RESUME] No incomplete generation sessions found`);
        }
    } catch (err) {
        console.error('[STARTUP-RESUME] Error:', err.message);
    }
}

module.exports = { resumeIncompleteSessions };
