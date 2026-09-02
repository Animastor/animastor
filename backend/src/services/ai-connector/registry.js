const CLOSE_REPLACED = 4000;

const sessions = new Map();

function register(connectorId, session) {
    const existing = sessions.get(connectorId);
    if (existing && existing.ws.readyState === 1) {
        existing.ws.close(CLOSE_REPLACED, 'replaced');
    }
    sessions.set(connectorId, session);
    return { status: existing ? 'replaced' : 'registered', replaced: existing || null };
}

function unregister(connectorId, session) {
    if (sessions.get(connectorId) === session) {
        sessions.delete(connectorId);
        return true;
    }
    return false;
}

function getLive(connectorId) {
    return sessions.get(connectorId) || null;
}

function isLive(connectorId) {
    return sessions.has(connectorId);
}

function disconnectAll() {
    for (const [id, session] of sessions) {
        try {
            session.ws.close(1001, 'server_shutdown');
        } catch (_) {}
    }
    sessions.clear();
}

function stats() {
    return { count: sessions.size };
}

module.exports = {
    register,
    unregister,
    getLive,
    isLive,
    disconnectAll,
    stats,
    CLOSE_REPLACED,
};