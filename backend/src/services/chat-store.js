// ======================================================
// Chat Store - persistent chat history for AI assistant
// ======================================================
// Stores every assistant / user exchange against a book,
// with optional scene / character / topic tags so that
// the assistant can later recall discussions about
// specific scenes, characters, or decisions.

const chatRepo = require('../storage/postgres/repositories/chat-repo');
const chatSessionRepo = require('../storage/postgres/repositories/chat-session-repo');
const bookEvents = require('./book-event-log');

const logPrefix = '[CHAT-STORE]';
function log(msg) { console.log(`${logPrefix} ${msg}`); }

// ======================================================
// APPEND
// ======================================================

async function appendUserMessage(bookId, message, context = {}) {
    const { sessionId = null, sceneId = null, characterId = null, topic = null, metadata = null } = context;
    const record = await chatRepo.appendMessage(bookId, {
        session_id: sessionId,
        scene_id: sceneId,
        character_id: characterId,
        topic, role: 'user', message,
        metadata,
    });
    if (sessionId) {
        await chatSessionRepo.incrementMessageCount(sessionId).catch(() => {});
    }
    return record;
}

async function appendAssistantMessage(bookId, message, context = {}) {
    const { sessionId = null, sceneId = null, characterId = null, topic = null, metadata = null } = context;
    const record = await chatRepo.appendMessage(bookId, {
        session_id: sessionId,
        scene_id: sceneId,
        character_id: characterId,
        topic, role: 'assistant', message,
        metadata,
    });

    if (sessionId) {
        await chatSessionRepo.incrementMessageCount(sessionId).catch(() => {});
    }
    if (sceneId || characterId || topic) {
        await bookEvents.chatDiscussion(bookId, sceneId, characterId, topic, {
            preview: String(message).slice(0, 200),
        });
    }
    return record;
}

async function appendSystemMessage(bookId, message, context = {}) {
    const { sessionId = null, sceneId = null, characterId = null, topic = null, metadata = null } = context;
    return chatRepo.appendMessage(bookId, {
        session_id: sessionId,
        scene_id: sceneId,
        character_id: characterId,
        topic, role: 'system', message,
        metadata,
    });
}

async function appendExchange(bookId, userMessage, assistantMessage, context = {}) {
    const [user, assistant] = await Promise.all([
        appendUserMessage(bookId, userMessage, context),
        appendAssistantMessage(bookId, assistantMessage, context),
    ]);
    return { user, assistant };
}

// Session management

async function createSession(bookId, { title, topicId, mode, userId } = {}) {
    return chatSessionRepo.createSession({ bookId, title, topicId, mode, userId });
}

async function listSessions(bookId) {
    return chatSessionRepo.listSessions(bookId);
}

async function getSession(sessionId) {
    return chatSessionRepo.getSession(sessionId);
}

async function updateSession(sessionId, updates) {
    return chatSessionRepo.updateSession(sessionId, updates);
}

async function deleteSession(sessionId) {
    return chatSessionRepo.deleteSession(sessionId);
}

async function getSessionMessages(sessionId) {
    const rows = await chatRepo.getSessionMessages(sessionId);
    return rows.map(toViewModel);
}

// ======================================================
// READ
// ======================================================

async function getBookHistory(bookId, options) {
    const rows = await chatRepo.getBookHistory(bookId, options);
    return rows.map(toViewModel);
}

async function getSceneHistory(bookId, sceneId, options) {
    const rows = await chatRepo.getSceneHistory(bookId, sceneId, options);
    return rows.map(toViewModel);
}

async function getCharacterHistory(bookId, characterId, options) {
    const rows = await chatRepo.getCharacterHistory(bookId, characterId, options);
    return rows.map(toViewModel);
}

async function getTopicDiscussions(bookId, topic, options) {
    const rows = await chatRepo.getDiscussionsByTopic(bookId, topic, options);
    return rows.map(toViewModel);
}

async function listTopics(bookId) {
    return chatRepo.listTopics(bookId);
}

async function searchMessages(bookId, queryText, options) {
    const rows = await chatRepo.searchMessages(bookId, queryText, options);
    return rows.map(toViewModel);
}

async function getMessageCount(bookId) {
    return chatRepo.getMessageCount(bookId);
}

function toViewModel(row) {
    return {
        id: row.id,
        bookId: row.book_id,
        sceneId: row.scene_id,
        characterId: row.character_id,
        topic: row.topic,
        role: row.role,
        message: row.message,
        metadata: row.metadata,
        createdAt: row.created_at,
    };
}

// ======================================================
// CLEANUP
// ======================================================

async function deleteBookHistory(bookId) {
    await chatRepo.deleteBookHistory(bookId);
    await bookEvents.append(bookId, bookEvents.EventType.SCENE_UPDATED, {
        details: { action: 'chat_history_cleared' },
    });
}

async function deleteSceneHistory(bookId, sceneId) {
    await chatRepo.deleteSceneHistory(bookId, sceneId);
}

module.exports = {
    appendUserMessage,
    appendAssistantMessage,
    appendSystemMessage,
    appendExchange,
    getBookHistory,
    getSceneHistory,
    getCharacterHistory,
    getTopicDiscussions,
    listTopics,
    searchMessages,
    getMessageCount,
    deleteBookHistory,
    deleteSceneHistory,
    createSession,
    listSessions,
    getSession,
    updateSession,
    deleteSession,
    getSessionMessages,
};
