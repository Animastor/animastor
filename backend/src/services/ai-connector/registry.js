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

/**
 * Forcibly close the live session of ONE connector (management-route side
 * effect: revoke / rotate kills the credential, so the session authenticated
 * with it must die too — fail-closed, never left lingering until its next
 * heartbeat). The socket's own close handler performs the PG offline mark and
 * registry unregister — the map entry is left to that path.
 * @returns {boolean} true when a live session was closed.
 */
function evict(connectorId, code, reason) {
    const session = sessions.get(connectorId);
    if (!session) return false;
    try {
        session.ws.close(typeof code === 'number' ? code : 1000, String(reason || 'evicted').slice(0, 64));
    } catch (_) {}
    return true;
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
    evict,
    stats,
    CLOSE_REPLACED,
};