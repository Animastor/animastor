// ======================================================
// Startup Resume — resume incomplete generation sessions
// ======================================================
// PostgreSQL is the source of truth. On startup, find any
// sessions that were 'generating' or 'pending' when the
// server stopped, and resume them.
// ======================================================

const genSessionRepo = require('./storage/postgres/repositories/gen-session-repo');

async function resumeIncompleteSessions(log, runBgGen) {
    try {
        const activeSessions = await genSessionRepo.getActiveSessions();
        if (activeSessions.length > 0) {
            log(`[STARTUP-RESUME] Found ${activeSessions.length} incomplete sessions, resuming...`);
            for (const ses of activeSessions) {
                log(`[STARTUP-RESUME] Resuming ${ses.book_id} window ${ses.window_index} (status=${ses.status})`);
                if (ses.status === 'generating') {
                    await genSessionRepo.updateSession(ses.id, { status: 'pending', error: null });
                }
                setImmediate(() => {
                    runBgGen(ses.book_id, ses.id).catch(err => {
                        console.error(`[STARTUP-RESUME] BG gen for ${ses.book_id} failed: ${err.message}`);
                    });
                });
            }
            log(`[STARTUP-RESUME] Resumed ${activeSessions.length} generation sessions`);
        } else {
            log(`[STARTUP-RESUME] No incomplete generation sessions found`);
        }
    } catch (err) {
        console.error('[STARTUP-RESUME] Error:', err.message);
    }
}

module.exports = { resumeIncompleteSessions };
