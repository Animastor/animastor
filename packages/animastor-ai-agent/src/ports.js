// ======================================================
// AI Agent Core — shared host-port mechanism
// ======================================================
// The AI Agent Core execution boundary (the shared mechanism every AI
// analysis task follows):
//
//   task → prompt/rules/skills/examples → callAI → structured JSON → result
//
// All host capabilities (LLM transport, PG session/step bookkeeping,
// conversation log, prompt loading, user-facing progress text) enter a task
// ONLY through the injected `ports` object. This helper is the shared
// fail-closed validation each task performs before doing any work: a task
// refuses to run without its host ports instead of silently degrading
// (C19/C20 precedent, now one shared implementation).
//
// Zero requires — pure mechanism. No host, no I/O, no persistence.

/**
 * Validate that every required host port is present; fail closed otherwise.
 *
 * @param {object} ports - host-injected ports (callAI, session/step fns, …)
 * @param {string[]} required - port names this task consumes
 * @param {string} taskName - module-qualified task id for the error message
 * @returns {object} the ports object (for direct destructuring)
 * @throws {Error} listing every missing port
 */
function assertHostPorts(ports, required, taskName) {
    const _ports = ports || {};
    const missing = (required || []).filter((p) => !_ports[p]);
    if (missing.length) {
        throw new Error(`${taskName}: missing host port(s): ${missing.join(', ')} — persistence and the LLM seam are host-injected (ai-agent core, C21 §3)`);
    }
    return _ports;
}

module.exports = { assertHostPorts };
