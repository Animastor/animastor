// ======================================================
// CHAT SESSION REPOSITORY — CONTRACT (Assistant-owned)
// ======================================================
// The port contract every chat-session persistence adapter must satisfy
// (the interface half of the A-1 repository seam). The concrete
// PostgreSQL implementation (the chat-sessions table) stays HOST-side
// (backend/src/storage/postgres/repositories/chat-session-repo.js) and is
// injected into the Assistant contour through the AssistantPorts
// sessionRepo field at the composition root — the package never knows the
// table, the SQL dialect or the driver.
// (docs/architecture/ai-assistant-extraction.md)

'use strict';

/**
 * Runtime contract check for a chat-session repository adapter.
 * Throws with a named message when a required method is missing — the
 * composition root fails fast on a bad adapter instead of at request time.
 *
 * Required surface (the exact historical usage of the contour):
 *   listSessionsForBook(bookId)            → Promise<rows>
 *   getSession(id)                          → Promise<row|null>
 *   getMessages(id)                         → Promise<Array>
 *   createSession(session)                  → Promise<void>
 *   setMessages(id, messages, updatedAt?)   → Promise<void>
 *   renameSession(id, title, updatedAt?)    → Promise<id|null>
 *   deleteSession(id)                       → Promise<id|null>
 *   getBookIdForSession(id)                 → Promise<bookId|null>
 *   purgeSessionsForBook(bookId)            → Promise<void>
 */
function assertSessionRepo(repo, label = 'sessionRepo') {
    const required = [
        'listSessionsForBook',
        'getSession',
        'getMessages',
        'createSession',
        'setMessages',
        'renameSession',
        'deleteSession',
        'getBookIdForSession',
        'purgeSessionsForBook',
    ];
    const missing = required.filter((m) => typeof repo?.[m] !== 'function');
    if (missing.length > 0) {
        throw new Error(`${label}: missing required method(s): ${missing.join(', ')}`);
    }
    return repo;
}

module.exports = { assertSessionRepo };
